// apple-notes-private-helper: opt-in native helper for apple-notes-mcp.
//
// Speaks one JSON object in on stdin and one JSON object out on stdout. It
// loads Apple's private NotesShared framework at runtime, opens the Notes
// Core Data store through NotesShared's own managed object model and store
// options, and performs only the whitelisted actions in kActions below.
//
// READ-ONLY. This helper never writes. Every store it opens is opened with
// NSReadOnlyPersistentStoreOption and migration disabled,
// OpenReadOnlyContext() refuses to hand out a context whose store is not
// read-only, and no code path saves a managed object context. Write support
// (an earlier plain-text append action) was deliberately deferred by the
// maintainer until a second writer beside a running Notes.app, CRDT replica
// identity, and the iCloud upload lag are understood.
// src/services/privateHelperReadOnly.test.ts fails the build if a save or
// write path reappears here.
//
// This is UNSUPPORTED PRIVATE API. Every class and selector is resolved at
// runtime and checked before use; a missing one fails closed with
// `private_api_unavailable` instead of crashing. The helper never issues SQL,
// never spawns a shell, and never dispatches a caller-supplied selector.
//
// Build (src/services/privateHelperBuild.ts; `apple-notes-mcp setup --native-helper`):
//   xcrun clang -fobjc-arc -O2 -Wall -framework Foundation -framework CoreData \
//     -framework AppKit -DHELPER_SOURCE_SHA256='"<sha256 of this file>"' \
//     -o apple-notes-private-helper apple-notes-private-helper.m
//
// Adding an action: write a `static NSDictionary *HandleX(NSDictionary *)`,
// list the NotesShared selectors it needs in an APIRequirement table (so
// `probe` can report it), and add one row to kActions with its name and
// allowed request keys. The dispatcher rejects any other key. Actions must
// be read-only (see above).

#import <AppKit/AppKit.h>
#import <CoreData/CoreData.h>
#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROTOCOL_VERSION 1
#define MAX_INPUT_BYTES (1024 * 1024)

#ifndef HELPER_SOURCE_SHA256
#define HELPER_SOURCE_SHA256 "unset"
#endif

static NSString *const kFrameworkPath =
    @"/System/Library/PrivateFrameworks/NotesShared.framework/NotesShared";
static NSString *const kEnableEnv = @"APPLE_NOTES_MCP_ENABLE_PRIVATE";
static NSString *const kCopyStoreEnv = @"APPLE_NOTES_MCP_PRIVATE_STORE";

#pragma mark - Errors

@interface HelperError : NSException
@end
@implementation HelperError
@end

// Throwing keeps every handler linear: validation failures unwind to main(),
// which renders exactly one JSON error object.
static void Fail(NSString *code, NSString *message, NSDictionary *extra) {
  NSMutableDictionary *info = [NSMutableDictionary dictionaryWithObject:code forKey:@"code"];
  if (extra) [info addEntriesFromDictionary:extra];
  @throw [HelperError exceptionWithName:code reason:message userInfo:info];
}

#pragma mark - Output

static void EmitAndExit(NSDictionary *object, int status) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (!data) {
    data = [@"{\"code\":\"internal_error\",\"message\":\"response serialization failed\","
            @"\"status\":\"error\"}" dataUsingEncoding:NSUTF8StringEncoding];
    status = 1;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  exit(status);
}

static NSString *ISODate(NSDate *date) {
  if (![date isKindOfClass:[NSDate class]]) return nil;
  static NSISO8601DateFormatter *formatter;
  if (!formatter) {
    formatter = [NSISO8601DateFormatter new];
    formatter.formatOptions =
        NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  }
  return [formatter stringFromDate:date];
}

static id OrNull(id value) { return value ?: [NSNull null]; }

static NSString *SHA256Hex(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

#pragma mark - Runtime API surface

// Everything the helper calls on NotesShared, grouped by the feature that
// needs it. `probe` reports each feature's missing entries; handlers call
// RequireFeature() before touching the framework.
typedef struct {
  const char *cls;
  const char *sel;  // NULL = class only
  BOOL classMethod;
} APIRequirement;

static const APIRequirement kModelAPI[] = {
    {"ICPersistentContainer", "managedObjectModel", YES},
    {"ICPersistentContainer", "standardStoreOptions", YES},
    {"ICNote", NULL, NO},
    {"ICNoteData", NULL, NO},
    {"ICCloudState", NULL, NO},
};

static const APIRequirement kReadAPI[] = {
    {"ICNote", "mergeableString", NO},
    {"ICNote", "isDeletedOrInTrash", NO},
    {"ICNote", "isSharedViaICloud", NO},
    {"ICNote", "isEditable", NO},
    {"ICTTMergeableString", "attributedString", NO},
};

// Core Data properties are @dynamic: their accessors do not exist until Core
// Data generates them, so they are checked against the managed object model
// (entity name, then property names) rather than with respondsToSelector:.
typedef struct {
  const char *entity;
  const char *properties;  // comma-separated
} ModelRequirement;

static const ModelRequirement kModelProperties[] = {
    {"ICNote",
     "identifier,title,modificationDate,creationDate,folder,account,noteData,cloudState,"
     "isPasswordProtected,markedForDeletion,needsInitialFetchFromCloud"},
    {"ICNoteData", "data"},
    {"ICCloudState", "currentLocalVersion,latestVersionSyncedToCloud"},
    {"ICFolder", "identifier"},
};

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static BOOL gFrameworkLoaded = NO;
static NSString *gFrameworkError = nil;

static void LoadFramework(void) {
  static BOOL attempted = NO;
  if (attempted) return;
  attempted = YES;
  if (dlopen(kFrameworkPath.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL)) {
    gFrameworkLoaded = YES;
  } else {
    const char *reason = dlerror();
    gFrameworkError = reason ? @(reason) : @"dlopen failed";
  }
}

static NSArray<NSString *> *MissingAPI(const APIRequirement *list, size_t count) {
  NSMutableArray *missing = [NSMutableArray array];
  for (size_t i = 0; i < count; i++) {
    Class cls = objc_getClass(list[i].cls);
    if (!cls) {
      [missing addObject:@(list[i].cls)];
      continue;
    }
    if (!list[i].sel) continue;
    SEL sel = sel_registerName(list[i].sel);
    BOOL ok = list[i].classMethod ? [cls respondsToSelector:sel]
                                  : [cls instancesRespondToSelector:sel];
    if (!ok)
      [missing addObject:[NSString stringWithFormat:@"%s[%s %s]", list[i].classMethod ? "+" : "-",
                                                     list[i].cls, list[i].sel]];
  }
  return missing;
}

static NSArray<NSString *> *MissingModelProperties(void) {
  Class container = objc_getClass("ICPersistentContainer");
  SEL modelSel = sel_registerName("managedObjectModel");
  if (!container || ![container respondsToSelector:modelSel]) return @[ @"managed object model" ];
  NSManagedObjectModel *model = ((id(*)(id, SEL))objc_msgSend)(container, modelSel);
  if (![model isKindOfClass:[NSManagedObjectModel class]]) return @[ @"managed object model" ];
  NSMutableArray *missing = [NSMutableArray array];
  for (size_t i = 0; i < COUNT(kModelProperties); i++) {
    NSEntityDescription *entity = model.entitiesByName[@(kModelProperties[i].entity)];
    if (!entity) {
      [missing addObject:[NSString stringWithFormat:@"entity %s", kModelProperties[i].entity]];
      continue;
    }
    for (NSString *name in [@(kModelProperties[i].properties) componentsSeparatedByString:@","])
      if (!entity.propertiesByName[name])
        [missing addObject:[NSString stringWithFormat:@"%s.%@", kModelProperties[i].entity, name]];
  }
  return missing;
}

typedef NS_ENUM(NSInteger, Feature) { FeatureModel, FeatureRead };

static NSArray<NSString *> *MissingForFeature(Feature feature) {
  LoadFramework();
  if (!gFrameworkLoaded) return @[ @"NotesShared.framework" ];
  NSMutableArray *missing = [NSMutableArray array];
  [missing addObjectsFromArray:MissingAPI(kModelAPI, COUNT(kModelAPI))];
  if (missing.count) return missing;
  if (feature >= FeatureRead) {
    [missing addObjectsFromArray:MissingModelProperties()];
    [missing addObjectsFromArray:MissingAPI(kReadAPI, COUNT(kReadAPI))];
  }
  return missing;
}

static void RequireFeature(Feature feature) {
  NSArray *missing = MissingForFeature(feature);
  if (missing.count)
    Fail(@"private_api_unavailable",
         @"Required NotesShared classes or selectors are not available on this macOS",
         @{@"missing" : missing});
}

// Typed wrappers around objc_msgSend. Selectors are compile-time constants.
static id Send(id target, const char *sel) {
  return ((id(*)(id, SEL))objc_msgSend)(target, sel_registerName(sel));
}
static BOOL SendBool(id target, const char *sel) {
  return ((BOOL(*)(id, SEL))objc_msgSend)(target, sel_registerName(sel));
}

#pragma mark - Store

typedef struct {
  NSString *path;
  BOOL isCopy;
} StoreLocation;

static NSString *LiveStorePath(void) {
  return [NSHomeDirectory()
      stringByAppendingPathComponent:
          @"Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"];
}

static BOOL SameFile(NSString *a, NSString *b) {
  struct stat sa, sb;
  if (stat(a.fileSystemRepresentation, &sa) != 0) return NO;
  if (stat(b.fileSystemRepresentation, &sb) != 0) return NO;
  return sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

// The copy-store override exists so tests can read a copy. It must never
// resolve to the live database, including through a symlink or hard link.
static StoreLocation ResolveStore(void) {
  NSString *override = NSProcessInfo.processInfo.environment[kCopyStoreEnv];
  NSString *live = LiveStorePath();
  if (override.length) {
    NSString *resolved = [override stringByResolvingSymlinksInPath];
    NSString *liveResolved = [live stringByResolvingSymlinksInPath];
    NSString *liveDir = [liveResolved stringByDeletingLastPathComponent];
    if ([resolved isEqualToString:liveResolved] || SameFile(resolved, live) ||
        [resolved hasPrefix:[liveDir stringByAppendingString:@"/"]])
      Fail(@"invalid_request", @"APPLE_NOTES_MCP_PRIVATE_STORE must point at a copy, not the live store",
           nil);
    if (![NSFileManager.defaultManager fileExistsAtPath:resolved])
      Fail(@"store_unavailable", @"APPLE_NOTES_MCP_PRIVATE_STORE does not exist", nil);
    return (StoreLocation){resolved, YES};
  }
  return (StoreLocation){live, NO};
}

// Opens NotesShared's model over the store with Notes' own store options,
// ALWAYS read-only. There is deliberately no read-write variant: the options
// force NSReadOnlyPersistentStoreOption and disable migration, and the store
// Core Data hands back is checked again before any context is returned.
static NSManagedObjectContext *OpenReadOnlyContext(StoreLocation store) {
  RequireFeature(FeatureModel);
  if (!store.isCopy && ![NSProcessInfo.processInfo.environment[kEnableEnv] isEqualToString:@"1"])
    Fail(@"disabled", @"The private helper is disabled; set APPLE_NOTES_MCP_ENABLE_PRIVATE=1 to opt in",
         nil);
  if (![NSFileManager.defaultManager isReadableFileAtPath:store.path])
    Fail(@"store_unavailable",
         @"NoteStore.sqlite is not readable. Grant Full Disk Access to the app that launches the MCP "
         @"server, then relaunch it.",
         nil);
  Class container = objc_getClass("ICPersistentContainer");
  NSManagedObjectModel *model = Send(container, "managedObjectModel");
  NSDictionary *standard = Send(container, "standardStoreOptions");
  if (![model isKindOfClass:[NSManagedObjectModel class]] ||
      ![standard isKindOfClass:[NSDictionary class]])
    Fail(@"private_api_unavailable", @"NotesShared did not return a model and store options", nil);
  NSMutableDictionary *options = [standard mutableCopy];
  // Never migrate: a model/store mismatch means this helper is out of date.
  options[NSMigratePersistentStoresAutomaticallyOption] = @NO;
  options[NSInferMappingModelAutomaticallyOption] = @NO;
  options[NSReadOnlyPersistentStoreOption] = @YES;
  if (![options[NSReadOnlyPersistentStoreOption] boolValue] ||
      [options[NSMigratePersistentStoresAutomaticallyOption] boolValue] ||
      [options[NSInferMappingModelAutomaticallyOption] boolValue])
    Fail(@"read_only_violation", @"Refusing to open the Notes store without read-only options", nil);
  NSPersistentStoreCoordinator *coordinator =
      [[NSPersistentStoreCoordinator alloc] initWithManagedObjectModel:model];
  NSError *error = nil;
  NSPersistentStore *persistent =
      [coordinator addPersistentStoreWithType:NSSQLiteStoreType
                                configuration:nil
                                          URL:[NSURL fileURLWithPath:store.path]
                                      options:options
                                        error:&error];
  if (!persistent)
    Fail(@"store_unavailable", @"Could not open the Notes store with the NotesShared model",
         @{@"detail" : error.localizedDescription ?: @"unknown"});
  // Belt and braces: refuse to continue if Core Data opened any store
  // read-write, whatever the options said.
  for (NSPersistentStore *opened in coordinator.persistentStores) {
    if (!opened.isReadOnly || ![opened.options[NSReadOnlyPersistentStoreOption] boolValue]) {
      [coordinator removePersistentStore:opened error:nil];
      Fail(@"read_only_violation", @"The Notes store was opened read-write; refusing to continue", nil);
    }
  }
  NSManagedObjectContext *context =
      [[NSManagedObjectContext alloc] initWithConcurrencyType:NSMainQueueConcurrencyType];
  context.persistentStoreCoordinator = coordinator;
  context.undoManager = nil;
  return context;
}

#pragma mark - Note lookup and state

static NSRegularExpression *UUIDPattern(void) {
  static NSRegularExpression *re;
  if (!re)
    re = [NSRegularExpression
        regularExpressionWithPattern:@"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
                                     @"[0-9A-Fa-f]{12}$"
                             options:0
                               error:nil];
  return re;
}

static BOOL IsUUID(id value) {
  return [value isKindOfClass:[NSString class]] &&
         [UUIDPattern() numberOfMatchesInString:value options:0 range:NSMakeRange(0, [value length])] ==
             1;
}

static NSManagedObject *FetchNote(NSManagedObjectContext *context, NSString *identifier) {
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:@"ICNote"];
  request.predicate = [NSPredicate predicateWithFormat:@"identifier ==[c] %@", identifier];
  request.fetchLimit = 2;
  request.returnsObjectsAsFaults = NO;
  NSError *error = nil;
  NSArray *rows = [context executeFetchRequest:request error:&error];
  if (!rows) Fail(@"store_unavailable", @"Note fetch failed", @{@"detail" : OrNull(error.localizedDescription)});
  if (rows.count == 0) Fail(@"not_found", @"No note has that identifier", nil);
  if (rows.count > 1) Fail(@"unsupported_note", @"More than one note row has that identifier", nil);
  return rows.firstObject;
}

static NSData *NoteBodyData(NSManagedObject *note) {
  id noteData = Send(note, "noteData");
  if (!noteData) return nil;
  id data = [noteData valueForKey:@"data"];
  return [data isKindOfClass:[NSData class]] ? data : nil;
}

// Opaque change-detection token over the persisted native state: identity,
// folder, deletion/lock flags, modification date, and a digest of the
// serialized CRDT body. Any persisted edit (text, style, attachment glyph)
// changes it. It is informational only; no action accepts it back.
static NSString *RevisionToken(NSManagedObject *note) {
  id folder = [note valueForKey:@"folder"];
  NSData *body = NoteBodyData(note);
  NSDate *modified = [note valueForKey:@"modificationDate"];
  NSString *canonical = [NSString
      stringWithFormat:@"r1\x1f%@\x1f%@\x1f%d\x1f%d\x1f%.6f\x1f%@",
                       [note valueForKey:@"identifier"] ?: @"",
                       folder ? ([folder valueForKey:@"identifier"] ?: @"") : @"",
                       [[note valueForKey:@"markedForDeletion"] boolValue],
                       SendBool(note, "isPasswordProtected"),
                       modified ? modified.timeIntervalSinceReferenceDate : 0.0,
                       body ? SHA256Hex(body) : @"none"];
  return [@"r1:" stringByAppendingString:SHA256Hex([canonical dataUsingEncoding:NSUTF8StringEncoding])];
}

// The note's visible text. On macOS 27 the mergeable string is an
// ICTTMergeableAttributedString whose `-string` returns an attributed string,
// so the plain text comes from `-attributedString`.
static NSString *BodyText(id mergeableString) {
  if (!mergeableString) return nil;
  id attributed = Send(mergeableString, "attributedString");
  return [attributed isKindOfClass:[NSAttributedString class]] ? [attributed string] : nil;
}

static BOOL NotesAppRunning(void) {
  return [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.Notes"].count > 0;
}

static NSDictionary *CloudSyncState(NSManagedObject *note) {
  id cloud = Send(note, "cloudState");
  BOOL inICloud = [note respondsToSelector:sel_registerName("isInICloudAccount")]
                      ? SendBool(note, "isInICloudAccount")
                      : NO;
  if (!cloud) return @{@"inICloudAccount" : @(inICloud), @"available" : @NO};
  long long current = [[cloud valueForKey:@"currentLocalVersion"] longLongValue];
  long long synced = [[cloud valueForKey:@"latestVersionSyncedToCloud"] longLongValue];
  return @{
    @"available" : @YES,
    @"inICloudAccount" : @(inICloud),
    @"currentLocalVersion" : @(current),
    @"latestVersionSyncedToCloud" : @(synced),
    // Notes' own upload eligibility test: a local version newer than the
    // last version it recorded as synced.
    @"uploadPending" : @((BOOL)(current > synced)),
  };
}

static NSDictionary *NoteState(NSManagedObject *note) {
  id folder = [note valueForKey:@"folder"];
  id account = [note valueForKey:@"account"];
  BOOL locked = SendBool(note, "isPasswordProtected");
  NSMutableDictionary *state = [@{
    @"identifier" : OrNull([note valueForKey:@"identifier"]),
    @"objectURI" : note.objectID.URIRepresentation.absoluteString,
    @"title" : OrNull([note valueForKey:@"title"]),
    @"modificationDate" : OrNull(ISODate([note valueForKey:@"modificationDate"])),
    @"creationDate" : OrNull(ISODate([note valueForKey:@"creationDate"])),
    @"folderIdentifier" : OrNull(folder ? [folder valueForKey:@"identifier"] : nil),
    @"accountIdentifier" : OrNull(account ? [account valueForKey:@"identifier"] : nil),
    @"passwordProtected" : @(locked),
    @"deletedOrInTrash" : @(SendBool(note, "isDeletedOrInTrash")),
    @"sharedViaICloud" : @(SendBool(note, "isSharedViaICloud")),
    @"editable" : @(SendBool(note, "isEditable")),
    @"bodyAvailable" : @((BOOL)(NoteBodyData(note) != nil)),
    @"revision" : RevisionToken(note),
    @"cloudSync" : CloudSyncState(note),
  } mutableCopy];
  if (!locked) {
    id ms = Send(note, "mergeableString");
    NSString *text = BodyText(ms);
    if ([text isKindOfClass:[NSString class]]) state[@"bodyLengthUTF16"] = @(text.length);
  }
  return state;
}

#pragma mark - Request validation

static NSString *RequireString(NSDictionary *request, NSString *key) {
  id value = request[key];
  if (![value isKindOfClass:[NSString class]] || [value length] == 0)
    Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be a non-empty string", key], nil);
  return value;
}

static NSString *RequireIdentifier(NSDictionary *request) {
  NSString *identifier = RequireString(request, @"identifier");
  if (!IsUUID(identifier)) Fail(@"invalid_request", @"`identifier` must be a Notes UUID", nil);
  return identifier;
}

#pragma mark - Actions

static NSDictionary *HandleHello(NSDictionary *request);
static NSDictionary *HandleProbe(NSDictionary *request);
static NSDictionary *HandleReadNoteState(NSDictionary *request);

typedef struct {
  const char *name;
  const char *allowedKeys;  // comma-separated, beyond `protocol` and `action`
  NSDictionary *(*handler)(NSDictionary *);
} ActionSpec;

// The whitelist. Order is the order `hello` reports. Every action is
// read-only; there is no write action in this protocol version.
static const ActionSpec kActions[] = {
    {"hello", "", HandleHello},
    {"probe", "", HandleProbe},
    {"read_note_state", "identifier", HandleReadNoteState},
};

static NSArray<NSString *> *ActionNames(void) {
  NSMutableArray *names = [NSMutableArray array];
  for (size_t i = 0; i < COUNT(kActions); i++) [names addObject:@(kActions[i].name)];
  return names;
}

static NSDictionary *HandleHello(NSDictionary *request) {
  (void)request;
  return @{
    @"status" : @"ok",
    @"protocolVersion" : @(PROTOCOL_VERSION),
    @"sourceSha256" : @HELPER_SOURCE_SHA256,
    @"readOnly" : @YES,
    @"actions" : ActionNames(),
  };
}

static NSDictionary *FeatureReport(Feature feature, BOOL contextOK, NSString *contextReason) {
  NSArray *missing = MissingForFeature(feature);
  if (missing.count)
    return @{@"available" : @NO, @"reason" : @"private_api_unavailable", @"missing" : missing};
  if (!contextOK)
    return @{@"available" : @NO, @"reason" : contextReason ?: @"store_unavailable", @"missing" : @[]};
  return @{@"available" : @YES, @"reason" : [NSNull null], @"missing" : @[]};
}

static NSDictionary *HandleProbe(NSDictionary *request) {
  (void)request;
  LoadFramework();
  NSOperatingSystemVersion v = NSProcessInfo.processInfo.operatingSystemVersion;
  NSString *osVersion = [NSString
      stringWithFormat:@"%ld.%ld.%ld", (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion];
  NSString *notesVersion = [NSBundle bundleWithPath:@"/System/Applications/Notes.app"]
                               .infoDictionary[@"CFBundleShortVersionString"];

  BOOL contextOK = NO;
  NSString *contextReason = nil;
  NSString *contextDetail = nil;
  NSNumber *noteCount = nil;
  StoreLocation store = {nil, NO};
  @try {
    store = ResolveStore();
    NSManagedObjectContext *context = OpenReadOnlyContext(store);
    NSFetchRequest *count = [NSFetchRequest fetchRequestWithEntityName:@"ICNote"];
    NSError *error = nil;
    NSUInteger n = [context countForFetchRequest:count error:&error];
    if (n == NSNotFound) {
      contextReason = @"store_unavailable";
      contextDetail = error.localizedDescription;
    } else {
      contextOK = YES;
      noteCount = @(n);
    }
  } @catch (HelperError *e) {
    contextReason = e.userInfo[@"code"];
    contextDetail = e.reason;
  }

  return @{
    @"status" : @"ok",
    @"protocolVersion" : @(PROTOCOL_VERSION),
    @"sourceSha256" : @HELPER_SOURCE_SHA256,
    @"readOnly" : @YES,
    @"os" : @{@"version" : osVersion, @"notesAppVersion" : OrNull(notesVersion)},
    @"framework" : @{@"loaded" : @(gFrameworkLoaded), @"error" : OrNull(gFrameworkError)},
    @"store" : @{
      @"kind" : store.path ? (store.isCopy ? @"copy" : @"live") : [NSNull null],
      @"opened" : @(contextOK),
      @"reason" : OrNull(contextReason),
      @"detail" : OrNull(contextDetail),
      @"noteRows" : OrNull(noteCount),
    },
    @"syncHostRunning" : @(NotesAppRunning()),
    @"features" : @{
      @"readNoteState" : FeatureReport(FeatureRead, contextOK, contextReason),
    },
  };
}

static NSDictionary *HandleReadNoteState(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  RequireFeature(FeatureRead);
  NSManagedObjectContext *context = OpenReadOnlyContext(ResolveStore());
  NSManagedObject *note = FetchNote(context, identifier);
  NSMutableDictionary *result = [NoteState(note) mutableCopy];
  result[@"status"] = @"ok";
  result[@"syncHostRunning"] = @(NotesAppRunning());
  return result;
}

#pragma mark - Main

static NSData *ReadStdin(void) {
  NSMutableData *data = [NSMutableData data];
  char buffer[65536];
  size_t n;
  while ((n = fread(buffer, 1, sizeof buffer, stdin)) > 0) {
    [data appendBytes:buffer length:n];
    if (data.length > MAX_INPUT_BYTES) Fail(@"input_too_large", @"Request exceeds 1 MiB", nil);
  }
  return data;
}

static NSDictionary *Dispatch(void) {
  NSData *input = ReadStdin();
  if (input.length == 0) Fail(@"invalid_json", @"Empty request", nil);
  NSError *error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:input options:0 error:&error];
  if (![parsed isKindOfClass:[NSDictionary class]])
    Fail(@"invalid_json", @"Request must be one JSON object", nil);
  NSDictionary *request = parsed;
  id protocol = request[@"protocol"];
  if (![protocol isKindOfClass:[NSNumber class]] || [protocol integerValue] != PROTOCOL_VERSION)
    Fail(@"protocol_mismatch",
         [NSString stringWithFormat:@"This helper speaks protocol %d", PROTOCOL_VERSION],
         @{@"protocolVersion" : @(PROTOCOL_VERSION)});
  id action = request[@"action"];
  if (![action isKindOfClass:[NSString class]]) Fail(@"invalid_request", @"`action` is required", nil);
  for (size_t i = 0; i < COUNT(kActions); i++) {
    if (![action isEqualToString:@(kActions[i].name)]) continue;
    NSMutableSet *allowed = [NSMutableSet setWithArray:@[ @"protocol", @"action" ]];
    NSString *extra = @(kActions[i].allowedKeys);
    if (extra.length) [allowed addObjectsFromArray:[extra componentsSeparatedByString:@","]];
    for (NSString *key in request)
      if (![allowed containsObject:key])
        Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown request field `%@`", key], nil);
    return kActions[i].handler(request);
  }
  Fail(@"unknown_action", @"Action is not in the whitelist", @{@"actions" : ActionNames()});
  return nil;
}

int main(void) {
  @autoreleasepool {
    @try {
      EmitAndExit(Dispatch(), 0);
    } @catch (HelperError *e) {
      NSMutableDictionary *out = [e.userInfo mutableCopy];
      out[@"status"] = @"error";
      out[@"message"] = e.reason ?: @"error";
      EmitAndExit(out, 1);
    } @catch (NSException *e) {
      EmitAndExit(@{
        @"status" : @"error",
        @"code" : @"internal_error",
        @"message" : [NSString stringWithFormat:@"%@: %@", e.name, e.reason ?: @""],
      },
                  1);
    }
  }
  return 1;
}
