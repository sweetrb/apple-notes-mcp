// Synthetic attributed-string tests. No NotesShared loading or store access.
#define main AppleNotesPrivateHelperMain
#include "../../native/private-helper/apple-notes-private-helper.m"
#undef main

@interface ICTTTodo : NSObject
- (instancetype)initWithUUID:(NSUUID *)uuid done:(BOOL)done;
- (NSUUID *)uuid;
- (BOOL)done;
@end
@implementation ICTTTodo {
  NSUUID *_uuid;
  BOOL _done;
}
- (instancetype)initWithUUID:(NSUUID *)uuid done:(BOOL)done {
  if ((self = [super init])) { _uuid = uuid; _done = done; }
  return self;
}
- (NSUUID *)uuid { return _uuid; }
- (BOOL)done { return _done; }
@end

@interface ICTTParagraphStyle : NSObject
- (instancetype)initWithKind:(unsigned int)kind todo:(ICTTTodo *)todo;
- (unsigned int)style;
- (ICTTTodo *)todo;
@end
@implementation ICTTParagraphStyle {
  unsigned int _kind;
  ICTTTodo *_todo;
}
- (instancetype)initWithKind:(unsigned int)kind todo:(ICTTTodo *)todo {
  if ((self = [super init])) { _kind = kind; _todo = todo; }
  return self;
}
- (unsigned int)style { return _kind; }
- (ICTTTodo *)todo { return _todo; }
@end

static NSUInteger tests = 0;
static void Check(BOOL condition, NSString *label) {
  tests++;
  if (!condition) { fprintf(stderr, "FAIL: %s\n", label.UTF8String); exit(1); }
}
static ICTTParagraphStyle *SyntheticStyle(NSString *uuid, BOOL done) {
  ICTTTodo *todo = [[ICTTTodo alloc] initWithUUID:[[NSUUID alloc] initWithUUIDString:uuid] done:done];
  return [[ICTTParagraphStyle alloc] initWithKind:103 todo:todo];
}
static void Add(NSMutableAttributedString *body, id style, NSUInteger start, NSUInteger length) {
  [body addAttribute:@"TTStyle" value:style range:NSMakeRange(start, length)];
}

int main(int argc, const char *argv[]) {
  if (argc == 2 && strcmp(argv[1], "--dispatch") == 0) return AppleNotesPrivateHelperMain();
  @autoreleasepool {
    NSString *a = @"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    NSString *b = @"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    Check(MissingAPI(kChecklistReadAPI, COUNT(kChecklistReadAPI)).count == 0, @"read getter probe");
    NSAttributedString *ordinary = [[NSAttributedString alloc] initWithString:@"Title\n☐ text\n- [x] text"];
    Check(ChecklistItems(ordinary).count == 0, @"text glyphs are not native todos");
    Check(ChecklistItems([[NSAttributedString alloc] initWithString:@""]).count == 0, @"empty body");

    NSMutableAttributedString *body = [[NSMutableAttributedString alloc] initWithString:@"Title\nMilk\nEggs\n"];
    Add(body, SyntheticStyle(a, NO), 5, 5); // previous line's newline belongs to Milk
    Add(body, SyntheticStyle(b, YES), 10, 6);
    NSArray *items = ChecklistItems(body);
    Check(items.count == 2, @"one entry per native identity");
    Check([items[0][@"todoIdentifier"] isEqual:@"aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa"], @"exact hex UUID");
    Check([items[0][@"text"] isEqual:@"Milk"] && [items[0][@"lineStart"] unsignedIntegerValue] == 6,
          @"leading terminator does not select previous line");
    Check([items[0][@"styledStart"] unsignedIntegerValue] == 5 &&
          [items[0][@"styledLengthUTF16"] unsignedIntegerValue] == 5, @"native style envelope");
    Check(![items[0][@"done"] boolValue] && [items[1][@"done"] boolValue], @"native done state");
    Check([items[0][@"contiguous"] boolValue] && [items[0][@"consistent"] boolValue] &&
          ![items[0][@"spansLines"] boolValue], @"ordinary identity flags");

    body = [[NSMutableAttributedString alloc] initWithString:@"\nMilk\n"];
    Add(body, SyntheticStyle(a, YES), 0, 1);
    Add(body, SyntheticStyle(a, NO), 1, 5);
    NSDictionary *item = ChecklistItems(body).firstObject;
    Check(![item[@"done"] boolValue] && ![item[@"consistent"] boolValue], @"visible done wins over terminator");
    Check([item[@"contiguous"] boolValue] && ![item[@"spansLines"] boolValue], @"adjacent split style runs");

    body = [[NSMutableAttributedString alloc] initWithString:@"One\nGap\nTwo"];
    Add(body, SyntheticStyle(a, NO), 0, 3);
    Add(body, SyntheticStyle(b, YES), 4, 3);
    Add(body, SyntheticStyle(a, YES), 8, 3);
    items = ChecklistItems(body);
    item = items.firstObject;
    Check(items.count == 2 && [items[1][@"index"] unsignedIntegerValue] == 1, @"first-occurrence order");
    Check(![item[@"contiguous"] boolValue] && ![item[@"consistent"] boolValue] &&
          [item[@"spansLines"] boolValue], @"separated conflicting identity is explicit");
    Check([item[@"styledLengthUTF16"] unsignedIntegerValue] == 11 && [item[@"text"] isEqual:@"One"],
          @"ambiguous envelope includes the gap");

    body = [[NSMutableAttributedString alloc] initWithString:@"One\nTwo\n"];
    Add(body, SyntheticStyle(a, NO), 0, body.length);
    item = ChecklistItems(body).firstObject;
    Check([item[@"contiguous"] boolValue] && [item[@"consistent"] boolValue] &&
          [item[@"spansLines"] boolValue], @"one identity shared by consecutive lines");

    body = [[NSMutableAttributedString alloc] initWithString:@"T\r\n🥛Milk\r\n"];
    Add(body, SyntheticStyle(a, YES), 1, body.length - 1);
    item = ChecklistItems(body).firstObject;
    Check([item[@"text"] isEqual:@"🥛Milk"] && [item[@"lineLengthUTF16"] unsignedIntegerValue] == 6 &&
          [item[@"lineStart"] unsignedIntegerValue] == 3 && ![item[@"spansLines"] boolValue], @"CRLF and UTF-16 offsets");

    body = [[NSMutableAttributedString alloc] initWithString:@"\n"];
    Add(body, SyntheticStyle(a, NO), 0, 1);
    item = ChecklistItems(body).firstObject;
    Check([item[@"text"] isEqual:@""] && ![item[@"done"] boolValue], @"newline-only native row");

    body = [[NSMutableAttributedString alloc] initWithString:@"Missing API"];
    Add(body, [NSObject new], 0, body.length);
    @try { ChecklistItems(body); Check(NO, @"missing instance getter refusal"); }
    @catch (HelperError *error) { Check([error.name isEqual:@"private_api_unavailable"], @"missing instance getter refusal"); }
    body = [[NSMutableAttributedString alloc] initWithString:@"Malformed todo"];
    ICTTTodo *invalid = [[ICTTTodo alloc] initWithUUID:nil done:NO];
    Add(body, [[ICTTParagraphStyle alloc] initWithKind:103 todo:invalid], 0, body.length);
    @try { ChecklistItems(body); Check(NO, @"missing todo UUID refusal"); }
    @catch (HelperError *error) { Check([error.name isEqual:@"unsupported_note"], @"missing todo UUID refusal"); }
    Check(!gFrameworkLoaded, @"framework was never loaded");
    printf("{\"tests\":%lu,\"frameworkLoaded\":false}\n", (unsigned long)tests);
  }
  return 0;
}
