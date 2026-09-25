// apple-notes-private-writer: opt-in native WRITE helper for apple-notes-mcp.
//
// This is a separate program from apple-notes-private-helper.m, which is
// read-only and stays that way. The read-only helper is what
// `setup --native-helper` builds; this writer is only built by
// `setup --native-writer`, into its own binary with its own checksum
// manifest, and the MCP server only dispatches to it when both
// APPLE_NOTES_MCP_ENABLE_PRIVATE=1 and APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1
// are set (src/services/privateWriter.ts). The writer checks the second
// switch itself before it opens the live store read-write.
//
// Speaks one JSON object in on stdin and one JSON object out on stdout. It
// loads Apple's private NotesShared framework at runtime, opens the Notes
// Core Data store through NotesShared's own managed object model and store
// options, and performs only the whitelisted actions in kActions below.
//
// Every write action follows one contract: an `ifRevision` compare-and-swap
// token checked against the persisted note before anything changes, an edit
// through NotesShared's own model (never SQL), a Core Data save with
// NSErrorMergePolicy so a concurrent Notes.app save wins, a fresh read-back
// through a brand-new coordinator, and an explicit `committed` flag on every
// failure that happens after the save.
//
// This is UNSUPPORTED PRIVATE API. Every class and selector is resolved at
// runtime and checked before use; a missing one fails closed with
// `private_api_unavailable` instead of crashing. The helper never issues SQL,
// never spawns a shell, and never dispatches a caller-supplied selector.
//
// Build (src/services/privateWriterBuild.ts; `apple-notes-mcp setup --native-writer`):
//   xcrun clang -fobjc-arc -O2 -Wall -framework Foundation -framework CoreData \
//     -framework AppKit -framework PencilKit -DHELPER_SOURCE_SHA256='"<sha256 of this file>"' \
//     -o apple-notes-private-writer apple-notes-private-writer.m
//
// Adding an action: write a `static NSDictionary *HandleX(NSDictionary *)`,
// list the NotesShared selectors it needs in an APIRequirement table (so
// `probe` can report it), and add one row to kActions with its name and
// allowed request keys. The dispatcher rejects any other key. Add the action
// to WRITER_ACTIONS in src/services/privateWriter.ts too, as "read" or
// "write"; setup refuses a writer whose action list differs.

#import <AppKit/AppKit.h>
#import <CoreData/CoreData.h>
#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <PencilKit/PencilKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROTOCOL_VERSION 1
#define MAX_INPUT_BYTES (1024 * 1024)
#define MAX_APPEND_UTF16 50000

#ifndef HELPER_SOURCE_SHA256
#define HELPER_SOURCE_SHA256 "unset"
#endif

// An embedded Info.plist gives the writer a bundle identifier. PencilKit
// needs one to build a PKDrawing (add_paper): it records its CRDT replica
// identity in the process's preferences domain and traps when there is none.
// The domain is ~/Library/Preferences/io.github.apple-notes-mcp.private-writer.plist.
__attribute__((used, section("__TEXT,__info_plist"))) static const char kInfoPlist[] =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
    "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
    "<plist version=\"1.0\"><dict>"
    "<key>CFBundleIdentifier</key><string>io.github.apple-notes-mcp.private-writer</string>"
    "<key>CFBundleName</key><string>apple-notes-private-writer</string>"
    "</dict></plist>\n";

static NSString *const kFrameworkPath =
    @"/System/Library/PrivateFrameworks/NotesShared.framework/NotesShared";
static NSString *const kTransactionAuthor = @"apple-notes-mcp-private-helper";
static NSString *const kChangeReason = @"apple-notes-mcp append_plain_text";
static NSString *const kEnableEnv = @"APPLE_NOTES_MCP_ENABLE_PRIVATE";
static NSString *const kWritesEnv = @"APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES";
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

// A write handler sets gWriteRequest before it can save; the save sets
// gSaveAttempted just before -save: and gSaveSucceeded after it returns YES.
// main() uses them so an error raised before the save reports committed:
// false, and an exception after a successful save still reports committed:
// true, instead of both reading as indeterminate.
static BOOL gWriteRequest = NO;
static BOOL gSaveAttempted = NO;
static BOOL gSaveSucceeded = NO;

static const ModelRequirement kModelProperties[] = {
    {"ICNote",
     "identifier,title,modificationDate,creationDate,folder,account,noteData,cloudState,"
     "isPasswordProtected,markedForDeletion,needsInitialFetchFromCloud"},
    {"ICNoteData", "data"},
    {"ICCloudState", "currentLocalVersion,latestVersionSyncedToCloud"},
    {"ICFolder", "identifier,markedForDeletion,cloudState"},
};

static const ModelRequirement kLinkCardModel[] = {
    {"ICAttachment", "identifier,typeUTI,urlString,note,cloudState"},
};

static const ModelRequirement kSectionLinkModelProperties[] = {
    {"ICNote", "inlineAttachments"},
    {"ICInlineAttachment", "identifier,tokenContentIdentifier,typeUTI,note,markedForDeletion"},
};

static const ModelRequirement kTableModelProperties[] = {
    {"ICNote", "attachments"},
    {"ICAttachment", "identifier,typeUTI,note,parentAttachment,markedForDeletion,mergeableData"},
};

static const ModelRequirement kSmartFolderModelProperties[] = {
    {"ICFolder",
     "identifier,title,folderType,smartFolderQueryJSON,markedForDeletion,account,parent,"
     "dateForLastTitleModification,parentModificationDate,cloudState"},
    {"ICAccount", "identifier,name,markedForDeletion"},
    {"ICHashtag", "identifier,standardizedContent,displayText,account,markedForDeletion"},
    {"ICNote", "folder"},
};

static const APIRequirement kAppendAPI[] = {
    {"ICTTMergeableString", "beginEditing", NO},
    {"ICTTMergeableString", "endEditing", NO},
    {"ICTTMergeableString", "insertAttributedString:atIndex:", NO},
    {"ICNote", "edited:range:changeInLength:", NO},
    {"ICNote", "saveNoteData", NO},
    {"ICNote", "updateChangeCountWithReason:", NO},
    {"ICNote", "regenerateTitle:snippet:", NO},
};

// In-place edits (plan_edit, edit_note) also use everything in kAppendAPI.
static const APIRequirement kEditAPI[] = {
    {"ICTTMergeableString", "replaceCharactersInRange:withAttributedString:", NO},
    {"ICTTParagraphStyle", "style", NO},
    {"ICTTMutableParagraphStyle", "setStyle:", NO},
    {"ICTTMutableParagraphStyle", "setTodo:", NO},
    {"ICTTTodo", "initWithIdentifier:done:", NO},
    // Everything CanonicalValue reads to compare stored runs field by field.
    {"ICTTParagraphStyle", "alignment", NO},
    {"ICTTParagraphStyle", "writingDirection", NO},
    {"ICTTParagraphStyle", "indent", NO},
    {"ICTTParagraphStyle", "blockQuoteLevel", NO},
    {"ICTTParagraphStyle", "startingItemNumber", NO},
    {"ICTTParagraphStyle", "hints", NO},
    {"ICTTParagraphStyle", "uuid", NO},
    {"ICTTParagraphStyle", "todo", NO},
    {"ICTTTodo", "uuid", NO},
    {"ICTTTodo", "done", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTAttachment", "attachmentUTI", NO},
    {"ICTTFont", "fontName", NO},
    {"ICTTFont", "pointSize", NO},
    {"ICTTFont", "fontHints", NO},
    // replace_checklist items and inline runs (links, highlights, colors).
    {"ICTTMutableParagraphStyle", "setIndent:", NO},
};

// Structured compose: paragraph styles, checklist todos, and inline runs.
// Paragraph-style accessors are inherited by the mutable subclass, which
// instancesRespondToSelector: sees.
static const APIRequirement kComposeAPI[] = {
    {"ICTTMutableParagraphStyle", "setStyle:", NO},
    {"ICTTMutableParagraphStyle", "setIndent:", NO},
    {"ICTTMutableParagraphStyle", "setBlockQuoteLevel:", NO},
    {"ICTTMutableParagraphStyle", "setTodo:", NO},
    {"ICTTParagraphStyle", "style", NO},
    {"ICTTParagraphStyle", "indent", NO},
    {"ICTTParagraphStyle", "blockQuoteLevel", NO},
    {"ICTTParagraphStyle", "todo", NO},
    {"ICTTTodo", "initWithIdentifier:done:", NO},
    {"ICTTTodo", "done", NO},
};

// Compose dividers and tables: new attachment objects plus their glyphs.
static const APIRequirement kComposeObjectAPI[] = {
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTAttachment", "attachmentUTI", NO},
    {"ICInlineAttachment", "newDividerLineAttachmentWithIdentifier:note:parentAttachment:", YES},
    {"ICTable", "registerWithICCRCoder", YES},
    {"ICNote", "addAttachmentWithUTI:", NO},
    {"ICAttachment", "tableModel", NO},
    {"ICAttachment", "saveMergeableDataIfNeeded", NO},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"ICAttachmentTableModel", "table", NO},
    {"ICAttachmentTableModel", "writeMergeableData", NO},
    {"ICAttachmentTableModel", "regenerateTextContentInNote", NO},
    {"ICTable", "setAttributedString:columnIndex:rowIndex:", NO},
    {"ICTable", "stringForColumnIndex:rowIndex:", NO},
    {"ICTable", "insertRowAtIndex:", NO},
    {"ICTable", "insertColumnAtIndex:", NO},
    {"ICTable", "removeRowAtIndex:", NO},
    {"ICTable", "removeColumnAtIndex:", NO},
    {"ICTable", "rowCount", NO},
    {"ICTable", "columnCount", NO},
};

// Compose file and link-card blocks: NotesShared creates the attachment row
// (and, for a file, its media row and media file); the compose unit places
// the glyph, as it does for tables. Reported by the probe as
// `composeAttachments`.
static const APIRequirement kComposeAttachmentAPI[] = {
    {"ICNote", "addAttachmentWithUTI:data:filename:", NO},
    {"ICNote", "addURLAttachmentWithURL:", NO},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"ICMedia", "mediaURL", NO},
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTAttachment", "attachmentUTI", NO},
};

static const ModelRequirement kComposeAttachmentModel[] = {
    {"ICNote", "attachments"},
    {"ICAttachment", "identifier,typeUTI,urlString,note,media"},
    {"ICMedia", "identifier,filename,attachment"},
};

// Checklist toggling rewrites the paragraph style of one existing checklist
// item. It needs the append editing surface above plus these.
static const APIRequirement kChecklistAPI[] = {
    {"ICTTParagraphStyle", "style", NO},
    {"ICTTParagraphStyle", "todo", NO},
    {"ICTTParagraphStyle", "mutableCopyWithZone:", NO},
    {"ICTTParagraphStyle", "setTodo:", NO},
    {"ICTTTodo", "uuid", NO},
    {"ICTTTodo", "done", NO},
    {"ICTTTodo", "initWithIdentifier:done:", NO},
    {"ICTTMergeableAttributedString", "setAttributes:range:", NO},
};

// Highlighting rewrites the TTEmphasis attribute of exact text ranges. It
// needs the append editing surface above plus this.
static const APIRequirement kHighlightAPI[] = {
    {"ICTTMergeableAttributedString", "setAttributes:range:", NO},
};

// URL link cards add an ICAttachment and its attachment glyph. They need the
// append editing surface above plus these, and the ICAttachment model
// properties in kLinkCardModel below.
static const APIRequirement kLinkCardAPI[] = {
    {"ICNote", "addURLAttachmentWithURL:", NO},
    {"ICNote", "rangeForAttachment:", NO},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTParagraphStyle", "defaultParagraphStyle", YES},
    {"ICTTParagraphStyle", "style", NO},
    {"ICTTParagraphStyle", "todo", NO},
};

// Paragraph identifiers: the UUID on a paragraph style (attribute key
// TTStyle), set through the mergeable string so the change merges like any
// other attribute edit.
static const APIRequirement kParagraphIdAPI[] = {
    {"ICTTParagraphStyle", "uuid", NO},
    {"ICTTParagraphStyle", "setUuid:", NO},
    {"ICTTParagraphStyle", "style", NO},
    {"ICTTParagraphStyle", "defaultParagraphStyle", YES},
    {"ICTTMergeableAttributedString", "setAttributes:range:", NO},
    {"ICTTMergeableString", "beginEditing", NO},
    {"ICTTMergeableString", "endEditing", NO},
    {"ICNote", "edited:range:changeInLength:", NO},
    {"ICNote", "saveNoteData", NO},
    {"ICNote", "updateChangeCountWithReason:", NO},
};

// Native section-link chips (macOS 27): NotesShared builds the paragraph-link
// inline attachment; the writer inserts its glyph through the mergeable string.
static const APIRequirement kSectionLinkAPI[] = {
    {"ICInlineAttachment",
     "newParagraphLinkAttachmentWithIdentifier:toNote:paragraphName:paragraphID:fromNote:"
     "parentAttachment:",
     YES},
    {"ICInlineAttachment", "isParagraphLinkAttachment", NO},
    {"ICInlineAttachment", "markForDeletion", NO},
    {"ICInlineAttachment", "updateChangeCountWithReason:", NO},
    {"ICNote", "addInlineAttachmentsObject:", NO},
    {"ICNote", "regenerateTitle:snippet:", NO},
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTMergeableString", "insertAttributedString:atIndex:", NO},
    {"ICTTMergeableString", "replaceCharactersInRange:withAttributedString:", NO},
};

// Native CRDT tables: row and cell edits go through ICTable (a CRTable) and
// are serialized back into the attachment by ICAttachmentTableModel.
static const APIRequirement kTableAPI[] = {
    {"ICTable", "registerWithICCRCoder", YES},
    {"ICAttachment", "tableModel", NO},
    {"ICAttachment", "saveMergeableDataIfNeeded", NO},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"ICAttachmentTableModel", "table", NO},
    {"ICAttachmentTableModel", "writeMergeableData", NO},
    {"ICAttachmentTableModel", "regenerateTextContentInNote", NO},
    {"ICTable", "rowCount", NO},
    {"ICTable", "columnCount", NO},
    {"ICTable", "identifierForRowAtIndex:", NO},
    {"ICTable", "identifierForColumnAtIndex:", NO},
    {"ICTable", "removeRowAtIndex:", NO},
    {"ICTable", "insertRowAtIndex:", NO},
    {"ICTable", "stringForColumnIndex:rowIndex:", NO},
    {"ICTable", "setAttributedString:columnIndex:rowIndex:", NO},
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICNote", "updateChangeCountWithReason:", NO},
};

// Tombstoning an attachment is the same call Notes makes when a user deletes
// one: CloudKit then deletes the record on other devices.
static const APIRequirement kPruneAPI[] = {
    {"ICAttachment", "markForDeletion", NO},
    {"ICAttachment", "updateMarkedForDeletionStateAttachmentIsInUse:", NO},
    {"ICNote", "rangeForAttachment:", NO},
};

// Smart folders (#181). A smart folder is an ordinary synced ICFolder row
// with folderType 2 and a stored query document; Notes' own query model
// (ICQueryObjC / ICFilterSelection) parses and regenerates it.
static const APIRequirement kSmartFolderAPI[] = {
    {"ICFolder", "newFolderInAccount:", YES},
    {"ICFolder", "newFolderInParentFolder:", YES},
    {"ICFolder", "isTitleValid:account:parentFolder:error:", YES},
    {"ICFolder", "setTitle:", NO},
    {"ICFolder", "setFolderType:", NO},
    {"ICFolder", "setSmartFolderQueryJSON:", NO},
    {"ICFolder", "setSmartFolderQueryObjC:", NO},
    {"ICFolder", "smartFolderQueryObjC", NO},
    {"ICFolder", "canAddSubfolder", NO},
    {"ICFolder", "markForDeletion", NO},
    {"ICFolder", "updateChangeCountWithReason:", NO},
    {"ICAccount", "defaultAccountInContext:", YES},
    {"ICHashtag", "standardizedHashtagRepresentationForDisplayText:", YES},
    {"ICQueryObjC", "objc_queryForNotesMatchingFilterSelection:", YES},
    {"ICQueryObjC", "canBeEdited", NO},
    {"ICQueryObjC", "predicate", NO},
    {"ICQueryObjC", "entityName", NO},
    {"ICQueryObjC", "minimumSupportedVersion", NO},
    {"ICQueryObjC", "filterSelectionWithManagedObjectContext:account:", NO},
    {"ICFilterSelection", "isValid", NO},
    {"ICFilterSelection", "isEmpty", NO},
    {"ICFilterSelection", "hasEmptySelection", NO},
    {"ICFilterSelection", "filterTypeSelections", NO},
    {"ICFilterSelection", "emptyFilterTypeSelections", NO},
    {"ICFilterSelection", "invalidFilterTypeSelectionCombinations", NO},
    {"ICFilterSelection", "incompatibleLockedNotesFilterTypeSelections", NO},
};

// Folder scope guards (#57): the subject's folder and each folder's parent,
// read in the write's own context just before the save.
static const ModelRequirement kScopeGuardModel[] = {
    {"ICNote", "identifier,folder"},
    {"ICFolder", "identifier,parent,markedForDeletion"},
};

// Purge-flag repair (#89): clears a stray permanent-deletion flag and
// finishes the move to Recently Deleted that Notes itself makes on delete.
static const APIRequirement kPurgeRepairAPI[] = {
    {"ICNote", "unmarkForDeletion", NO},
    {"ICNote", "setFolder:", NO},
    {"ICNote", "updateChangeCountWithReason:", NO},
    {"ICNote", "isDeletedOrInTrash", NO},
    {"ICAccount", "trashFolder", NO},
    {"ICFolder", "isTrashFolder", NO},
};

static const ModelRequirement kPurgeRepairModel[] = {
    {"ICNote", "identifier,title,folder,account,markedForDeletion,folderModificationDate,attachments,"
               "needsInitialFetchFromCloud,cloudState"},
    {"ICFolder", "identifier,folderType,markedForDeletion,account"},
    {"ICAttachment", "identifier,markedForDeletion"},
    {"ICAccount", "identifier,markedForDeletion"},
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

static NSArray<NSString *> *MissingModelProperties(const ModelRequirement *list, size_t count) {
  Class container = objc_getClass("ICPersistentContainer");
  SEL modelSel = sel_registerName("managedObjectModel");
  if (!container || ![container respondsToSelector:modelSel]) return @[ @"managed object model" ];
  NSManagedObjectModel *model = ((id(*)(id, SEL))objc_msgSend)(container, modelSel);
  if (![model isKindOfClass:[NSManagedObjectModel class]]) return @[ @"managed object model" ];
  NSMutableArray *missing = [NSMutableArray array];
  for (size_t i = 0; i < count; i++) {
    NSEntityDescription *entity = model.entitiesByName[@(list[i].entity)];
    if (!entity) {
      [missing addObject:[NSString stringWithFormat:@"entity %s", list[i].entity]];
      continue;
    }
    for (NSString *name in [@(list[i].properties) componentsSeparatedByString:@","])
      if (!entity.propertiesByName[name])
        [missing addObject:[NSString stringWithFormat:@"%s.%@", list[i].entity, name]];
  }
  return missing;
}

// Features after FeatureAppend need the append API plus their own table,
// matched with `==` in MissingForFeature.
typedef NS_ENUM(NSInteger, Feature) {
  FeatureModel,
  FeatureRead,
  FeatureAppend,
  FeatureEdit,
  FeatureCompose,
  FeatureChecklist,
  FeatureHighlight,
  FeatureLinkCard,
  FeatureParagraphIds,
  FeatureSectionLinks,
  FeatureTables,
  FeaturePruneTable,
  FeatureSmartFolders,
  FeatureComposeAttachments,
  FeatureScopeGuards,
  FeaturePurgeRepair,
};

// Features that edit the body text need the append editing surface.
// Paragraph ids, section links, and table edits touch only attributes or
// their own objects and list what they need in their own tables.
static BOOL NeedsAppendAPI(Feature feature) {
  switch (feature) {
    case FeatureAppend:
    case FeatureEdit:
    case FeatureCompose:
    case FeatureChecklist:
    case FeatureHighlight:
    case FeatureLinkCard:
      return YES;
    default:
      return NO;
  }
}

static NSArray<NSString *> *MissingForFeature(Feature feature) {
  LoadFramework();
  if (!gFrameworkLoaded) return @[ @"NotesShared.framework" ];
  NSMutableArray *missing = [NSMutableArray array];
  [missing addObjectsFromArray:MissingAPI(kModelAPI, COUNT(kModelAPI))];
  if (missing.count) return missing;
  if (feature >= FeatureRead) {
    [missing addObjectsFromArray:MissingModelProperties(kModelProperties, COUNT(kModelProperties))];
    [missing addObjectsFromArray:MissingAPI(kReadAPI, COUNT(kReadAPI))];
  }
  if (NeedsAppendAPI(feature))
    [missing addObjectsFromArray:MissingAPI(kAppendAPI, COUNT(kAppendAPI))];
  if (feature == FeatureEdit) [missing addObjectsFromArray:MissingAPI(kEditAPI, COUNT(kEditAPI))];
  if (feature == FeatureCompose)
    [missing addObjectsFromArray:MissingAPI(kComposeAPI, COUNT(kComposeAPI))];
  if (feature == FeatureChecklist)
    [missing addObjectsFromArray:MissingAPI(kChecklistAPI, COUNT(kChecklistAPI))];
  if (feature == FeatureHighlight)
    [missing addObjectsFromArray:MissingAPI(kHighlightAPI, COUNT(kHighlightAPI))];
  if (feature == FeatureLinkCard) {
    [missing addObjectsFromArray:MissingAPI(kLinkCardAPI, COUNT(kLinkCardAPI))];
    [missing addObjectsFromArray:MissingModelProperties(kLinkCardModel, COUNT(kLinkCardModel))];
  }
  if (feature == FeatureParagraphIds || feature == FeatureSectionLinks)
    [missing addObjectsFromArray:MissingAPI(kParagraphIdAPI, COUNT(kParagraphIdAPI))];
  if (feature == FeatureSectionLinks) {
    if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion < 27)
      [missing addObject:@"macOS 27 or later"];
    [missing addObjectsFromArray:MissingAPI(kSectionLinkAPI, COUNT(kSectionLinkAPI))];
    [missing addObjectsFromArray:MissingModelProperties(kSectionLinkModelProperties,
                                                        COUNT(kSectionLinkModelProperties))];
  }
  if (feature == FeatureTables || feature == FeaturePruneTable) {
    [missing addObjectsFromArray:MissingModelProperties(kTableModelProperties,
                                                        COUNT(kTableModelProperties))];
    [missing addObjectsFromArray:MissingAPI(kTableAPI, COUNT(kTableAPI))];
  }
  if (feature == FeaturePruneTable)
    [missing addObjectsFromArray:MissingAPI(kPruneAPI, COUNT(kPruneAPI))];
  if (feature == FeatureSmartFolders) {
    [missing addObjectsFromArray:MissingModelProperties(kSmartFolderModelProperties,
                                                          COUNT(kSmartFolderModelProperties))];
    [missing addObjectsFromArray:MissingAPI(kSmartFolderAPI, COUNT(kSmartFolderAPI))];
  }
  // File and link-card blocks in compose: the compose surface plus their own.
  if (feature == FeatureComposeAttachments) {
    [missing addObjectsFromArray:MissingAPI(kAppendAPI, COUNT(kAppendAPI))];
    [missing addObjectsFromArray:MissingAPI(kComposeAPI, COUNT(kComposeAPI))];
    [missing addObjectsFromArray:MissingAPI(kComposeAttachmentAPI, COUNT(kComposeAttachmentAPI))];
    [missing addObjectsFromArray:MissingModelProperties(kComposeAttachmentModel,
                                                        COUNT(kComposeAttachmentModel))];
  }
  if (feature == FeatureScopeGuards)
    [missing addObjectsFromArray:MissingModelProperties(kScopeGuardModel, COUNT(kScopeGuardModel))];
  if (feature == FeaturePurgeRepair) {
    [missing addObjectsFromArray:MissingModelProperties(kPurgeRepairModel, COUNT(kPurgeRepairModel))];
    [missing addObjectsFromArray:MissingAPI(kPurgeRepairAPI, COUNT(kPurgeRepairAPI))];
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
// Void methods must not go through Send(): ARC would retain whatever garbage
// sits in the return register.
static void SendVoid(id target, const char *sel) {
  ((void (*)(id, SEL))objc_msgSend)(target, sel_registerName(sel));
}
static NSUInteger SendUInt(id target, const char *sel) {
  return ((NSUInteger(*)(id, SEL))objc_msgSend)(target, sel_registerName(sel));
}
static id Send1(id target, const char *sel, id arg) {
  return ((id(*)(id, SEL, id))objc_msgSend)(target, sel_registerName(sel), arg);
}
static id Send2(id target, const char *sel, id a, id b) {
  return ((id(*)(id, SEL, id, id))objc_msgSend)(target, sel_registerName(sel), a, b);
}
static void SendVoid1(id target, const char *sel, id arg) {
  ((void (*)(id, SEL, id))objc_msgSend)(target, sel_registerName(sel), arg);
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

// The copy-store override exists for tests. It must never resolve to the
// live database, including through a symlink or hard link.
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

// Opens NotesShared's model over the store with Notes' own store options
// (persistent history tracking + remote change notifications), which is what
// lets a running Notes.app merge the helper's saves. Reads add
// NSReadOnlyPersistentStoreOption so a read can never write.
static NSManagedObjectContext *OpenContext(StoreLocation store, BOOL readOnly) {
  RequireFeature(FeatureModel);
  if (![NSProcessInfo.processInfo.environment[kEnableEnv] isEqualToString:@"1"])
    Fail(@"disabled", @"The private helper is disabled; set APPLE_NOTES_MCP_ENABLE_PRIVATE=1 to opt in",
         nil);
  // Second, independent switch for read-write opens of the live store. The
  // client checks it too; this keeps the binary safe when run by hand.
  if (!readOnly && !store.isCopy &&
      ![NSProcessInfo.processInfo.environment[kWritesEnv] isEqualToString:@"1"])
    Fail(@"writes_disabled",
         @"Private writes are disabled; set APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1 to opt in",
         @{@"committed" : @NO});
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
  if (readOnly) options[NSReadOnlyPersistentStoreOption] = @YES;
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
  NSManagedObjectContext *context =
      [[NSManagedObjectContext alloc] initWithConcurrencyType:NSMainQueueConcurrencyType];
  context.persistentStoreCoordinator = coordinator;
  context.transactionAuthor = kTransactionAuthor;
  // Optimistic locking: if Notes.app saves the same row between our fetch and
  // our save, the save fails instead of silently overwriting.
  context.mergePolicy = NSErrorMergePolicy;
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

// Opaque compare-and-swap token over the persisted native state an append
// depends on: identity, folder, deletion/lock flags, modification date, and
// a digest of the serialized CRDT body. Any persisted edit (text, style,
// attachment glyph) changes the body digest.
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
static NSDictionary *HandleAppendPlainText(NSDictionary *request);
static NSDictionary *HandleReadSyncState(NSDictionary *request);
static NSDictionary *HandlePlanEdit(NSDictionary *request);
static NSDictionary *HandleEditNote(NSDictionary *request);
static NSDictionary *HandleComposeNote(NSDictionary *request);
static NSDictionary *HandleReadChecklist(NSDictionary *request);
static NSDictionary *HandleSetChecklistItem(NSDictionary *request);
static NSDictionary *HandleSetHighlight(NSDictionary *request);
static NSDictionary *HandleAddURLCard(NSDictionary *request);
static NSDictionary *HandleSetParagraphId(NSDictionary *request);
static NSDictionary *HandleAddSectionLink(NSDictionary *request);
static NSDictionary *HandleReadTables(NSDictionary *request);
static NSDictionary *HandleDeleteTableRow(NSDictionary *request);
static NSDictionary *HandleInsertTableRow(NSDictionary *request);
static NSDictionary *HandleSetTableCell(NSDictionary *request);
static NSDictionary *HandlePruneOrphanTable(NSDictionary *request);
static NSDictionary *HandleReadSmartFolder(NSDictionary *request);
static NSDictionary *HandleCreateSmartFolder(NSDictionary *request);
static NSDictionary *HandleUpdateSmartFolder(NSDictionary *request);
static NSDictionary *HandleDeleteSmartFolder(NSDictionary *request);
static NSDictionary *HandleAddPaper(NSDictionary *request);
static NSDictionary *HandleReadPaper(NSDictionary *request);
static NSDictionary *PaperWriteFeatureReport(BOOL contextOK, NSString *contextReason);
static NSDictionary *EditFileFeatureReport(BOOL contextOK, NSString *contextReason);
static NSDictionary *HandleRepairPurgeFlag(NSDictionary *request);
// Folder scope guards; defined in "Scope guards" below. Every save calls it.
static void EnforceScopeGuard(NSManagedObjectContext *context);
static NSDictionary *PaperReadFeatureReport(BOOL contextOK, NSString *contextReason, BOOL shapes);

typedef struct {
  const char *name;
  const char *allowedKeys;  // comma-separated, beyond `protocol` and `action`
  NSDictionary *(*handler)(NSDictionary *);
} ActionSpec;

// The whitelist. Order is the order `hello` reports.
static const ActionSpec kActions[] = {
    {"hello", "", HandleHello},
    {"probe", "", HandleProbe},
    {"read_note_state", "identifier", HandleReadNoteState},
    {"append_plain_text", "identifier,text,ifRevision", HandleAppendPlainText},
    {"read_sync_state", "identifiers", HandleReadSyncState},
    {"plan_edit", "identifier,requireNonSystemPaper,operations", HandlePlanEdit},
    {"edit_note", "identifier,ifRevision,requireNonSystemPaper,operations,ifPlanDigest", HandleEditNote},
    {"compose_note",
     "identifier,mode,paragraphs,ifRevision,dryRun,requireNonSystemPaper,insertBeforeHeading",
     HandleComposeNote},
    {"read_checklist", "identifier", HandleReadChecklist},
    {"set_checklist_item", "identifier,todoIdentifier,done,ifRevision", HandleSetChecklistItem},
    {"set_highlight", "identifier,scope,match,expectedCount,color,ifRevision,dryRun", HandleSetHighlight},
    {"add_url_card", "identifier,url,afterParagraph,ifRevision,dryRun", HandleAddURLCard},
    {"set_paragraph_id", "identifier,blockIndex,expectedText,paragraphId,ifRevision",
     HandleSetParagraphId},
    {"add_section_link", "identifier,target,blockIndex,expectedText,paragraphId,heading,position,clearExistingSectionLinks,ifRevision,ifTargetRevision", HandleAddSectionLink},
    {"read_tables", "identifier", HandleReadTables},
    {"delete_table_row", "identifier,tableIdentifier,rowIdentifier,dryRun,ifRevision,ifTableDigest",
     HandleDeleteTableRow},
    {"insert_table_row", "identifier,tableIdentifier,afterRowIdentifier,cells,ifRevision,ifTableDigest",
     HandleInsertTableRow},
    {"set_table_cell",
     "identifier,tableIdentifier,rowIdentifier,columnIdentifier,text,ifRevision,ifTableDigest",
     HandleSetTableCell},
    {"prune_orphan_table", "identifier,tableIdentifier,dryRun,ifRevision,ifTableDigest",
     HandlePruneOrphanTable},
    {"read_smart_folder", "identifier", HandleReadSmartFolder},
    {"create_smart_folder", "title,queryJSON,account,parentIdentifier", HandleCreateSmartFolder},
    {"update_smart_folder", "identifier,queryJSON,ifRevision", HandleUpdateSmartFolder},
    {"delete_smart_folder", "identifier,dryRun,ifRevision", HandleDeleteSmartFolder},
    {"add_paper", "identifier,ifRevision,drawing,format,dryRun", HandleAddPaper},
    {"repair_purge_flag", "identifier,dryRun,ifRevision,confirm", HandleRepairPurgeFlag},
    {"read_paper", "identifier,attachmentIdentifier,includePoints,maxPoints,includeShapes", HandleReadPaper},
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
    @"role" : @"writer",
    @"readOnly" : @NO,
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

// Dividers and tables in compose: the compose feature plus the object API.
static NSDictionary *ObjectsReport(BOOL contextOK, NSString *contextReason) {
  NSDictionary *compose = FeatureReport(FeatureCompose, contextOK, contextReason);
  if (![compose[@"available"] boolValue]) return compose;
  NSArray *missing = MissingAPI(kComposeObjectAPI, COUNT(kComposeObjectAPI));
  if (missing.count)
    return @{@"available" : @NO, @"reason" : @"private_api_unavailable", @"missing" : missing};
  return compose;
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
    NSManagedObjectContext *context = OpenContext(store, YES);
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
    @"role" : @"writer",
    @"readOnly" : @NO,
    @"writesEnabled" : @([NSProcessInfo.processInfo.environment[kWritesEnv] isEqualToString:@"1"]),
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
      @"appendPlainText" : FeatureReport(FeatureAppend, contextOK, contextReason),
      @"planEdit" : FeatureReport(FeatureEdit, contextOK, contextReason),
      @"editNote" : FeatureReport(FeatureEdit, contextOK, contextReason),
      @"composeNote" : FeatureReport(FeatureCompose, contextOK, contextReason),
      @"composeObjects" : ObjectsReport(contextOK, contextReason),
      @"checklistToggle" : FeatureReport(FeatureChecklist, contextOK, contextReason),
      @"highlight" : FeatureReport(FeatureHighlight, contextOK, contextReason),
      @"linkCard" : FeatureReport(FeatureLinkCard, contextOK, contextReason),
      @"setParagraphId" : FeatureReport(FeatureParagraphIds, contextOK, contextReason),
      @"addSectionLink" : FeatureReport(FeatureSectionLinks, contextOK, contextReason),
      @"tables" : FeatureReport(FeatureTables, contextOK, contextReason),
      @"pruneOrphanTable" : FeatureReport(FeaturePruneTable, contextOK, contextReason),
      @"smartFolders" : FeatureReport(FeatureSmartFolders, contextOK, contextReason),
      @"addPaper" : PaperWriteFeatureReport(contextOK, contextReason),
      @"composeAttachments" : FeatureReport(FeatureComposeAttachments, contextOK, contextReason),
      @"editReplaceFile" : EditFileFeatureReport(contextOK, contextReason),
      @"scopeGuards" : FeatureReport(FeatureScopeGuards, contextOK, contextReason),
      @"purgeRepair" : FeatureReport(FeaturePurgeRepair, contextOK, contextReason),
      @"readPaper" : PaperReadFeatureReport(contextOK, contextReason, NO),
      @"readPaperShapes" : PaperReadFeatureReport(contextOK, contextReason, YES),
    },
  };
}

static NSDictionary *HandleReadNoteState(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  RequireFeature(FeatureRead);
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  NSManagedObject *note = FetchNote(context, identifier);
  NSMutableDictionary *result = [NoteState(note) mutableCopy];
  result[@"status"] = @"ok";
  result[@"syncHostRunning"] = @(NotesAppRunning());
  return result;
}

// Refuses every note shape this first write path does not model.
static void RequireAppendableNote(NSManagedObject *note) {
  if (SendBool(note, "isPasswordProtected"))
    Fail(@"unsupported_note", @"Locked notes are not supported", nil);
  if (SendBool(note, "isDeletedOrInTrash") || [[note valueForKey:@"markedForDeletion"] boolValue])
    Fail(@"unsupported_note", @"Deleted or trashed notes are not supported", nil);
  if (![note valueForKey:@"folder"]) Fail(@"unsupported_note", @"Folderless notes are not supported", nil);
  if (SendBool(note, "isSharedViaICloud"))
    Fail(@"unsupported_note", @"Collaborative (shared) notes are not supported", nil);
  if (!SendBool(note, "isEditable")) Fail(@"unsupported_note", @"Notes reports this note as not editable", nil);
  if ([[note valueForKey:@"needsInitialFetchFromCloud"] boolValue] || !NoteBodyData(note))
    Fail(@"unsupported_note", @"The note body has not finished downloading from iCloud", nil);
}

// Characters no written text may contain. Only category Cc (C0 and C1
// controls) is forbidden: controlCharacterSet also covers Cf, which would
// refuse ZWJ emoji, ZWNJ, soft hyphens, BOMs and bidi marks that appear in
// ordinary text. Tab is always allowed and \n only where the caller says;
// the attachment glyph and the Unicode line and paragraph separators never
// are. The client's checks in src/services/privateWriter.ts match this set.
static NSCharacterSet *ForbiddenTextCharacters(BOOL allowNewline) {
  NSMutableCharacterSet *forbidden = [NSMutableCharacterSet new];
  [forbidden addCharactersInRange:NSMakeRange(0x00, 0x20)];
  [forbidden addCharactersInRange:NSMakeRange(0x7F, 0x21)];
  [forbidden removeCharactersInString:allowNewline ? @"\n\t" : @"\t"];
  [forbidden addCharactersInString:@"\uFFFC\u2028\u2029"];
  return forbidden;
}

static void ValidateAppendText(NSString *text) {
  if (text.length > MAX_APPEND_UTF16)
    Fail(@"invalid_request", @"`text` exceeds 50000 UTF-16 code units", nil);
  if ([text rangeOfCharacterFromSet:ForbiddenTextCharacters(YES)].location != NSNotFound)
    Fail(@"invalid_request",
         @"`text` may contain only printable characters, tabs and \\n newlines (no \\r, "
         @"attachment glyphs, or other control characters)",
         nil);
}

// The paragraph style of a Notes paragraph rides on its terminating newline.
// When the body does not already end in a newline, the separator we insert
// becomes the terminator of the old last paragraph, so it carries that
// paragraph's style value (found by class, not by key name). The appended
// text itself carries no attributes and becomes plain body paragraphs.
static NSAttributedString *SeparatorFor(NSAttributedString *existing) {
  if (existing.length == 0) return nil;
  if ([existing.string hasSuffix:@"\n"]) return nil;
  NSDictionary *attrs = [existing attributesAtIndex:existing.length - 1 effectiveRange:NULL];
  NSMutableDictionary *kept = [NSMutableDictionary dictionary];
  for (NSString *key in attrs) {
    NSString *className = NSStringFromClass([attrs[key] class]);
    if ([className containsString:@"ParagraphStyle"]) kept[key] = attrs[key];
  }
  return [[NSAttributedString alloc] initWithString:@"\n" attributes:kept];
}

static NSDictionary *HandleAppendPlainText(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *text = RequireString(request, @"text");
  NSString *ifRevision = RequireString(request, @"ifRevision");
  ValidateAppendText(text);
  RequireFeature(FeatureAppend);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);

  NSString *revisionBefore = RevisionToken(note);
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  id ms = Send(note, "mergeableString");
  NSAttributedString *existing = ms ? Send(ms, "attributedString") : nil;
  if (![existing isKindOfClass:[NSAttributedString class]])
    Fail(@"unsupported_note", @"The note body could not be loaded as a mergeable string", nil);
  NSString *before = [existing.string copy];
  NSAttributedString *separator = SeparatorFor(existing);
  NSMutableAttributedString *insertion = [NSMutableAttributedString new];
  if (separator) [insertion appendAttributedString:separator];
  [insertion appendAttributedString:[[NSAttributedString alloc] initWithString:text]];
  NSUInteger at = existing.length;

  // Edit through the CRDT so the change merges with other devices' edits.
  SendVoid(ms, "beginEditing");
  ((void (*)(id, SEL, id, NSUInteger))objc_msgSend)(
      ms, sel_registerName("insertAttributedString:atIndex:"), insertion, at);
  SendVoid(ms, "endEditing");
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      note, sel_registerName("edited:range:changeInLength:"), NSTextStorageEditedCharacters,
      NSMakeRange(at, insertion.length), (NSInteger)insertion.length);
  ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(note, sel_registerName("regenerateTitle:snippet:"), YES,
                                                YES);
  if (!SendBool(note, "saveNoteData"))
    Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
  [note setValue:[NSDate date] forKey:@"modificationDate"];
  // Bumps the cloud state's local version so Notes treats the note as
  // needing upload.
  ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"),
                                        kChangeReason);

  EnforceScopeGuard(context);
  NSError *saveError = nil;
  gSaveAttempted = YES;
  if (![context save:&saveError]) {
    [context rollback];
    BOOL conflict = saveError.code == NSManagedObjectMergeError ||
                    saveError.code == NSPersistentStoreSaveConflictsError;
    Fail(conflict ? @"revision_conflict" : @"save_failed",
         conflict ? @"Notes changed the note during the write; nothing was saved"
                  : @"The Core Data save failed; nothing was saved",
         @{@"committed" : @NO, @"detail" : OrNull(saveError.localizedDescription)});
  }
  gSaveSucceeded = YES;

  // Fresh read-back through a brand-new coordinator so no in-memory state
  // from the write can satisfy the check.
  NSString *expected = [before stringByAppendingString:[insertion string]];
  NSDictionary *after = nil;
  BOOL verified = NO;
  NSString *verifyDetail = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    id freshString = Send(reread, "mergeableString");
    NSString *persisted = BodyText(freshString);
    verified = [persisted isEqualToString:expected];
    if (!verified) verifyDetail = @"The persisted body does not equal the previous body plus the appended text";
    after = NoteState(reread);
  } @catch (NSException *e) {
    // Any failure here happens after a successful save: report it as a
    // committed write that could not be verified, never as uncommitted.
    verifyDetail = e.reason ?: e.name;
  }
  if (!verified)
    Fail(@"verification_failed", verifyDetail ?: @"Read-back failed",
         @{@"committed" : @YES, @"revisionBefore" : revisionBefore});

  BOOL hostRunning = NotesAppRunning();
  return @{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"identifier" : identifier,
    @"appendedUTF16" : @(insertion.length),
    @"separatorInserted" : @((BOOL)(separator != nil)),
    @"revisionBefore" : revisionBefore,
    @"revisionAfter" : after[@"revision"],
    @"modificationDate" : after[@"modificationDate"],
    @"title" : after[@"title"],
    @"cloudSync" : after[@"cloudSync"],
    // The helper never uploads: CloudKit access needs Notes.app's private
    // entitlements. It only records upload eligibility. See TECHNICAL_NOTES.
    @"pushScheduled" : @NO,
    @"syncHostRunning" : @(hostRunning),
    @"pushState" : hostRunning ? @"awaiting_notes_app" : @"queued_for_next_launch",
    @"storeKind" : store.isCopy ? @"copy" : @"live",
  };
}

#pragma mark - Shared write plumbing

// Saves an edited note with the same optimistic-locking rules as the append
// path: a concurrent save by Notes becomes revision_conflict, anything else
// save_failed, and in both cases nothing is written. The save is bracketed
// with gSaveAttempted / gSaveSucceeded like the append path's, so main() can
// tell a failure before, during, and after it apart.
static void SaveOrFailFor(NSManagedObjectContext *context, NSString *what) {
  EnforceScopeGuard(context);
  NSError *saveError = nil;
  gSaveAttempted = YES;
  if ([context save:&saveError]) {
    gSaveSucceeded = YES;
    return;
  }
  [context rollback];
  BOOL conflict = saveError.code == NSManagedObjectMergeError ||
                  saveError.code == NSPersistentStoreSaveConflictsError;
  Fail(conflict ? @"revision_conflict" : @"save_failed",
       conflict ? [NSString stringWithFormat:@"Notes changed the %@ during the write; nothing was saved", what]
                : @"The Core Data save failed; nothing was saved",
       @{@"committed" : @NO, @"detail" : OrNull(saveError.localizedDescription)});
}

static void SaveOrFail(NSManagedObjectContext *context) { SaveOrFailFor(context, @"note"); }

// Serializes an attribute-only edit of `range` and marks the note for upload.
static void FinishAttributeEdit(NSManagedObject *note, NSRange range, NSString *reason) {
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      note, sel_registerName("edited:range:changeInLength:"), NSTextStorageEditedAttributes, range, 0);
  if (!SendBool(note, "saveNoteData"))
    Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
  [note setValue:[NSDate date] forKey:@"modificationDate"];
  ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"), reason);
}

// The writer never uploads (see HandleAppendPlainText).
static NSDictionary *PushFields(StoreLocation store) {
  BOOL hostRunning = NotesAppRunning();
  return @{
    @"pushScheduled" : @NO,
    @"syncHostRunning" : @(hostRunning),
    @"pushState" : hostRunning ? @"awaiting_notes_app" : @"queued_for_next_launch",
    @"storeKind" : store.isCopy ? @"copy" : @"live",
  };
}

// The sync fields every write result carries. The writer never uploads.
static NSDictionary *SyncFields(NSDictionary *after, StoreLocation store) {
  NSMutableDictionary *fields = [PushFields(store) mutableCopy];
  fields[@"modificationDate"] = after[@"modificationDate"];
  fields[@"cloudSync"] = after[@"cloudSync"];
  return fields;
}

// Applies `extra` on top of every existing attribute run in `range`.
// ICTTMergeableAttributedString's setAttributes:range: replaces a run's whole
// dictionary, so each run's own attributes (links, fonts, timestamps,
// attachments) are carried over explicitly. Callers bracket one or more calls
// with the mergeable string's beginEditing/endEditing.
static void MergeAttributes(id mergeable, NSAttributedString *snapshot, NSRange range,
                            NSDictionary *extra, NSArray<NSString *> *remove) {
  NSMutableArray *updates = [NSMutableArray array];
  [snapshot enumerateAttributesInRange:range
                               options:0
                            usingBlock:^(NSDictionary *attrs, NSRange run, BOOL *stop) {
                              (void)stop;
                              NSMutableDictionary *merged = [attrs mutableCopy];
                              if (remove) [merged removeObjectsForKeys:remove];
                              if (extra) [merged addEntriesFromDictionary:extra];
                              [updates addObject:@[ merged, [NSValue valueWithRange:run] ]];
                            }];
  for (NSArray *update in updates)
    ((void (*)(id, SEL, id, NSRange))objc_msgSend)(mergeable, sel_registerName("setAttributes:range:"),
                                                   update[0], [update[1] rangeValue]);
}

static NSAttributedString *LoadBody(NSManagedObject *note, id *mergeableOut) {
  id ms = Send(note, "mergeableString");
  NSAttributedString *body = ms ? Send(ms, "attributedString") : nil;
  if (![body isKindOfClass:[NSAttributedString class]])
    Fail(@"unsupported_note", @"The note body could not be loaded as a mergeable string", nil);
  if (mergeableOut) *mergeableOut = ms;
  return body;
}

#pragma mark - Structured compose

// Notes stores paragraph and inline formatting as attributes on the
// mergeable string: TTStyle holds an ICTTParagraphStyle (style number,
// indent, block-quote level, checklist todo); TTHints is a bold/italic
// bitmask; TTUnderline and TTStrikethrough are flags; TTEmphasis is the named
// highlight (1-5); TTColor is a text color; NSLink is a hyperlink.
static NSString *const kStyleKey = @"TTStyle";
static NSString *const kHintsKey = @"TTHints";
static NSString *const kUnderlineKey = @"TTUnderline";
static NSString *const kStrikethroughKey = @"TTStrikethrough";
static NSString *const kEmphasisKey = @"TTEmphasis";
static NSString *const kColorKey = @"TTColor";

#define MAX_COMPOSE_PARAGRAPHS 2000
#define MAX_COMPOSE_RUNS 20000
#define MAX_COMPOSE_UTF16 200000
#define MAX_INDENT 8
#define STYLE_HEADING 1

typedef struct {
  const char *name;
  unsigned int value;
  BOOL indentable;
} StyleSpec;

// The only paragraph styles compose writes. Title (0) is never written: a
// note's title is its first paragraph, which compose does not replace.
static const StyleSpec kStyles[] = {
    {"heading", 1, NO},   {"subheading", 2, NO}, {"body", 3, YES},      {"monospaced", 4, NO},
    {"bulleted", 100, YES}, {"dashed", 101, YES},  {"numbered", 102, YES}, {"checklist", 103, YES},
};

static const char *kHighlights[] = {"purple", "pink", "orange", "mint", "blue"};  // TTEmphasis 1-5

static NSString *StyleName(unsigned int value);

static const StyleSpec *StyleNamed(NSString *name) {
  for (size_t i = 0; i < COUNT(kStyles); i++)
    if ([name isEqualToString:@(kStyles[i].name)]) return &kStyles[i];
  return NULL;
}

// Serializes the edited body and marks the note for upload. Must run before
// SaveOrFail.
static void FinishNoteEdit(NSManagedObject *note, NSString *reason, NSDate *now) {
  if (!SendBool(note, "saveNoteData"))
    Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
  [note setValue:now forKey:@"modificationDate"];
  ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"), reason);
}

static BOOL IsJSONBool(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

#pragma mark - In-place edit

// plan_edit (read) and edit_note (write) resolve literal operations against
// ONE snapshot of the note's native attributed string, turn each into a
// (range, replacement) target, refuse overlapping targets, and apply them
// through the CRDT in descending order so no target shifts another. Nothing
// outside the targets is rewritten: untouched characters keep their CRDT
// identity, paragraph styles, checklist state, inline formatting, and
// attachment glyphs.
//
// - plan_edit opens the store read-only, rehearses the native edit in memory
//   (then rolls it back), and returns the plan plus `revisionBefore`.
// - edit_note requires `ifRevision`, which must equal the current revision.
//   Sending the same operations with the plan's revisionBefore reproduces
//   exactly the planned targets.
// - Matching is literal, case-sensitive, and confined to one paragraph, and a
//   match must start and end on whole characters. No selector, replacement,
//   or block text may contain a line break, the attachment glyph U+FFFC, or
//   an unpaired surrogate. A target range may contain an attachment glyph
//   only when an explicit attachment selector named that one attachment, and
//   then only that attachment's glyphs, so every other attachment, table, and
//   inline object is never inside an edited range.
// - edit_note takes an optional `ifPlanDigest` (the dry run's planDigest),
//   which also covers requireNonSystemPaper and each replacement file's bytes.
// - A note holding an attribute value whose class the writer cannot compare
//   field by field (CanonicalValue) is refused at the plan.
// - Before saving, only the note, its note data, its cloud state, and the row
//   of an attachment the plan removes from the body may be dirty; anything
//   else rolls back (unexpected_side_effect).
// - After saving, a brand-new read-only Core Data stack re-reads the note and
//   proves that the text equals the plan, that every character outside the
//   edited ranges has the same attribute runs it had before (paragraph style,
//   checklist state, fonts, inline formatting, attachment references), that
//   the attachment glyph sequence is the planned one, and that every
//   attachment row other than one the plan removed is still the note's and
//   has the same stored values.
//
// Line-break trimming is the trim_blank_lines operation (PlanTrim): it
// returns whole empty paragraphs, each removed with its own newline, as
// ordinary deletion targets, so the checks above apply unchanged.
//
// Extension points. Selectors resolve through ResolveSelector(), keyed by
// `kind` (`text`, `style`, `blank`, `attachment`), so a later kind is one
// more branch that returns ranges. A target may contain an attachment glyph
// only when its selector kind says so (TargetMayTouchAttachment), and
// verification compares the persisted glyph sequence with the planned text
// rather than with the old one.

#define MAX_EDIT_OPERATIONS 64
#define MAX_EDIT_TARGETS 1000
#define MAX_EDIT_TEXT_UTF16 10000
#define MAX_EDIT_BLOCKS 200
#define MAX_EDIT_RUNS 200

static NSString *const kTimestampKey = @"TTTimestamp";
static NSString *const kAttachmentKey = @"NSAttachment";
static NSString *const kEditChangeReason = @"apple-notes-mcp edit_note";

static const unsigned int kStyleTitle = 0;
static const unsigned int kStyleBody = 3;
static const unsigned int kStyleChecklist = 103;

// Native ICTTParagraphStyle.style values by public name.
static NSDictionary<NSString *, NSNumber *> *StyleValues(void) {
  return @{
    @"title" : @0,
    @"heading" : @1,
    @"subheading" : @2,
    @"body" : @3,
    @"monospaced" : @4,
    @"bulleted" : @100,
    @"dashed" : @101,
    @"numbered" : @102,
    @"checklist" : @103,
  };
}

static NSString *StyleName(unsigned int value) {
  NSDictionary *values = StyleValues();
  for (NSString *name in values)
    if ([values[name] unsignedIntValue] == value) return name;
  return [NSString stringWithFormat:@"style_%u", value];
}

@interface EditParagraph : NSObject
@property(nonatomic) NSUInteger index;
@property(nonatomic) NSRange content;  // text without the terminator
@property(nonatomic) NSRange full;     // text plus its "\n", when it has one
@property(nonatomic) BOOL terminated;
@end
@implementation EditParagraph
@end

// Paragraphs are split on "\n" only, which is how Notes stores them. A body
// that ends in "\n" has no trailing empty paragraph.
static NSArray<EditParagraph *> *Paragraphs(NSString *text) {
  NSMutableArray *out = [NSMutableArray array];
  NSUInteger start = 0, length = text.length;
  do {
    NSRange nl = [text rangeOfString:@"\n"
                             options:NSLiteralSearch
                               range:NSMakeRange(start, length - start)];
    EditParagraph *p = [EditParagraph new];
    p.index = out.count;
    if (nl.location == NSNotFound) {
      p.content = NSMakeRange(start, length - start);
      p.full = p.content;
      p.terminated = NO;
      [out addObject:p];
      break;
    }
    p.content = NSMakeRange(start, nl.location - start);
    p.full = NSMakeRange(start, nl.location + 1 - start);
    p.terminated = YES;
    [out addObject:p];
    start = nl.location + 1;
  } while (start < length);
  return out;
}

static unsigned int StyleValueOf(id paragraphStyle) {
  if (!paragraphStyle || ![paragraphStyle respondsToSelector:sel_registerName("style")]) return kStyleBody;
  return ((unsigned int (*)(id, SEL))objc_msgSend)(paragraphStyle, sel_registerName("style"));
}

static id ParagraphStyleAt(NSAttributedString *text, EditParagraph *p) {
  if (!p.full.length) return nil;
  return [text attribute:kStyleKey atIndex:p.full.location effectiveRange:NULL];
}

static NSString *ColorHex(id value);

// Every stored field of a native paragraph style, read through its own
// accessors: style, alignment, writing direction, indent, block quote level,
// list start number, hints, paragraph UUID, and the checklist todo (its UUID
// and done state). nil when an accessor is missing, which fails closed.
static NSString *CanonicalParagraphStyle(id style) {
  for (NSString *sel in @[
         @"style", @"alignment", @"writingDirection", @"indent", @"blockQuoteLevel", @"startingItemNumber", @"hints",
         @"uuid", @"todo"
       ])
    if (![style respondsToSelector:NSSelectorFromString(sel)]) return nil;
  unsigned int (*u32)(id, SEL) = (unsigned int (*)(id, SEL))objc_msgSend;
  long long (*i64)(id, SEL) = (long long (*)(id, SEL))objc_msgSend;
  id uuid = Send(style, "uuid");
  id todo = Send(style, "todo");
  NSString *todoText = @"none";
  if (todo) {
    if (![todo respondsToSelector:sel_registerName("uuid")] || ![todo respondsToSelector:sel_registerName("done")])
      return nil;
    todoText = [NSString stringWithFormat:@"%@/%d", [Send(todo, "uuid") UUIDString] ?: @"nil", SendBool(todo, "done")];
  }
  return [NSString stringWithFormat:@"p:%u|%lld|%lld|%lld|%lld|%lld|%u|%@|%@", u32(style, sel_registerName("style")),
                                    i64(style, sel_registerName("alignment")),
                                    i64(style, sel_registerName("writingDirection")),
                                    i64(style, sel_registerName("indent")),
                                    i64(style, sel_registerName("blockQuoteLevel")),
                                    i64(style, sel_registerName("startingItemNumber")),
                                    u32(style, sel_registerName("hints")),
                                    [uuid isKindOfClass:[NSUUID class]] ? [uuid UUIDString] : @"nil", todoText];
}

// Canonical, pointer-free text for an attribute value, built from the
// fields of each class Notes stores in a note body, so two reads of the same
// stored run compare equal and any change to a stored field compares
// unequal. A value of any other class returns nil: it cannot be verified, so
// a plan refuses the note (UnverifiableAttributeClasses) instead of relying
// on a description that might omit a field.
static NSString *CanonicalValue(id value) {
  if (!value) return @"nil";
  if ([value isKindOfClass:[NSNumber class]]) return [NSString stringWithFormat:@"n:%@", value];
  if ([value isKindOfClass:[NSString class]]) return [NSString stringWithFormat:@"s:%@", value];
  if ([value isKindOfClass:[NSURL class]])
    return [NSString stringWithFormat:@"u:%@", [value absoluteString]];
  if ([value isKindOfClass:[NSUUID class]]) return [@"id:" stringByAppendingString:[value UUIDString]];
  if ([value isKindOfClass:[NSDate class]])
    return [NSString stringWithFormat:@"t:%.6f", [value timeIntervalSinceReferenceDate]];
  Class paragraphStyle = objc_getClass("ICTTParagraphStyle");
  if (paragraphStyle && [value isKindOfClass:paragraphStyle]) return CanonicalParagraphStyle(value);
  Class attachment = objc_getClass("ICTTAttachment");
  if (attachment && [value isKindOfClass:attachment]) {
    if (![value respondsToSelector:sel_registerName("attachmentIdentifier")] ||
        ![value respondsToSelector:sel_registerName("attachmentUTI")])
      return nil;
    return [NSString stringWithFormat:@"a:%@|%@", Send(value, "attachmentUTI") ?: @"nil",
                                      Send(value, "attachmentIdentifier") ?: @"nil"];
  }
  Class font = objc_getClass("ICTTFont");
  if (font && [value isKindOfClass:font]) {
    for (NSString *sel in @[ @"fontName", @"pointSize", @"fontHints" ])
      if (![value respondsToSelector:NSSelectorFromString(sel)]) return nil;
    return [NSString stringWithFormat:@"f:%@|%.4f|%u", Send(value, "fontName") ?: @"nil",
                                      ((double (*)(id, SEL))objc_msgSend)(value, sel_registerName("pointSize")),
                                      ((unsigned int (*)(id, SEL))objc_msgSend)(value, sel_registerName("fontHints"))];
  }
  if (CFGetTypeID((__bridge CFTypeRef)value) == CGColorGetTypeID() || [value isKindOfClass:[NSColor class]]) {
    NSString *hex = ColorHex(value);
    return [hex hasPrefix:@"#"] ? [@"c:" stringByAppendingString:hex] : nil;
  }
  return nil;
}

static NSString *CanonicalAttributes(NSDictionary *attributes, BOOL ignoreTimestamp) {
  NSMutableArray *parts = [NSMutableArray array];
  for (NSString *key in [attributes.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    if (ignoreTimestamp && [key isEqualToString:kTimestampKey]) continue;
    // An unverifiable value never compares equal to anything, itself included.
    NSString *canonical = CanonicalValue(attributes[key]) ?: [NSString stringWithFormat:@"?%@", NSUUID.UUID];
    [parts addObject:[NSString stringWithFormat:@"%@=%@", key, canonical]];
  }
  return [parts componentsJoinedByString:@"\x1f"];
}

// Classes of attribute values in `text` that CanonicalValue cannot verify.
static NSArray<NSString *> *UnverifiableAttributeClasses(NSAttributedString *text) {
  NSMutableSet *classes = [NSMutableSet set];
  if (!text.length) return @[];
  [text enumerateAttributesInRange:NSMakeRange(0, text.length)
                           options:0
                        usingBlock:^(NSDictionary *attrs, NSRange range, BOOL *stop) {
                          (void)range;
                          (void)stop;
                          for (NSString *key in attrs)
                            if (!CanonicalValue(attrs[key]))
                              [classes addObject:[NSString stringWithFormat:@"%@ (%@)", key,
                                                                             NSStringFromClass([attrs[key] class])]];
                        }];
  return [classes.allObjects sortedArrayUsingSelector:@selector(compare:)];
}

// Runs of equal canonical attributes over `range`, as [relativeStart, length,
// canonical] triples, merged so that storage-level run splits do not matter.
static NSArray *CanonicalRuns(NSAttributedString *text, NSRange range, BOOL ignoreTimestamp) {
  NSMutableArray *runs = [NSMutableArray array];
  if (!range.length) return runs;
  [text enumerateAttributesInRange:range
                           options:0
                        usingBlock:^(NSDictionary *attrs, NSRange r, BOOL *stop) {
                          (void)stop;
                          NSString *canonical = CanonicalAttributes(attrs, ignoreTimestamp);
                          NSMutableArray *last = runs.lastObject;
                          if (last && [last[2] isEqualToString:canonical]) {
                            last[1] = @([last[1] unsignedIntegerValue] + r.length);
                          } else {
                            [runs addObject:[@[ @(r.location - range.location), @(r.length), canonical ]
                                                mutableCopy]];
                          }
                        }];
  return runs;
}

static NSArray<NSString *> *AttachmentGlyphs(NSAttributedString *text) {
  NSMutableArray *glyphs = [NSMutableArray array];
  if (!text.length) return glyphs;
  [text enumerateAttribute:kAttachmentKey
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  (void)stop;
                  if (!value) return;
                  // Adjacent glyphs for the same attachment form one attribute
                  // run; list each character so a duplicate glyph is counted
                  // and a removed one fails the sequence check.
                  NSString *canonical = CanonicalValue(value);
                  for (NSUInteger i = 0; i < range.length; i++) [glyphs addObject:canonical];
                }];
  return glyphs;
}

// The note's attachment rows (ICAttachment, not inline objects such as
// hashtags or note links), keyed by lowercased identifier. A row without an
// identifier is keyed by its object URI so it still takes part in the checks.
static NSDictionary<NSString *, NSManagedObject *> *AttachmentRows(NSManagedObject *note) {
  if (![note.entity.propertiesByName objectForKey:@"attachments"]) return @{};
  NSMutableDictionary *rows = [NSMutableDictionary dictionary];
  for (NSManagedObject *attachment in [note valueForKey:@"attachments"]) {
    id identifier = [attachment valueForKey:@"identifier"];
    NSString *key = [identifier isKindOfClass:[NSString class]]
                        ? [identifier lowercaseString]
                        : attachment.objectID.URIRepresentation.absoluteString;
    rows[key] = attachment;
  }
  return rows;
}

// A pointer-free digest of one attachment row's stored values. Data values
// are hashed; transient and transformed attributes (CloudKit system fields,
// wall-clock values) are skipped because their decoded objects have no stable
// canonical form. The note relationship is included, so a row that moved to
// another note does not match.
static NSString *AttachmentRowDigest(NSManagedObject *row) {
  NSMutableArray *parts = [NSMutableArray array];
  NSDictionary *attributes = row.entity.attributesByName;
  for (NSString *name in [attributes.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    NSAttributeDescription *attribute = attributes[name];
    if (attribute.isTransient || attribute.valueTransformerName ||
        attribute.attributeType == NSTransformableAttributeType)
      continue;
    id value = [row valueForKey:name];
    NSString *canonical;
    if (!value)
      canonical = @"nil";
    else if ([value isKindOfClass:[NSData class]])
      canonical = [@"d:" stringByAppendingString:SHA256Hex(value)];
    else
      canonical = CanonicalValue(value);
    [parts addObject:[NSString stringWithFormat:@"%@=%@", name, canonical]];
  }
  id owner = row.entity.relationshipsByName[@"note"] ? [row valueForKey:@"note"] : nil;
  id ownerIdentifier = owner ? ([owner valueForKey:@"identifier"] ?: @"?") : @"nil";
  [parts addObject:[NSString stringWithFormat:@"note=%@", ownerIdentifier]];
  return SHA256Hex([[parts componentsJoinedByString:@"\x1f"] dataUsingEncoding:NSUTF8StringEncoding]);
}

static NSDictionary<NSString *, NSString *> *AttachmentRowDigests(
    NSDictionary<NSString *, NSManagedObject *> *rows) {
  NSMutableDictionary *digests = [NSMutableDictionary dictionary];
  for (NSString *key in rows) digests[key] = AttachmentRowDigest(rows[key]);
  return digests;
}

// One entry per attachment glyph (U+FFFC carrying an attachment attribute)
// in body order: its location and the attachment's identifier and type as
// the native string records them.
static NSArray<NSDictionary *> *AttachmentGlyphEntries(NSAttributedString *text) {
  NSMutableArray *entries = [NSMutableArray array];
  NSString *string = text.string;
  SEL identifierSel = sel_registerName("attachmentIdentifier");
  SEL utiSel = sel_registerName("attachmentUTI");
  for (NSUInteger i = 0; i < string.length; i++) {
    if ([string characterAtIndex:i] != 0xFFFC) continue;
    id value = [text attribute:kAttachmentKey atIndex:i effectiveRange:NULL];
    if (!value) continue;
    id identifier = [value respondsToSelector:identifierSel] ? Send(value, "attachmentIdentifier") : nil;
    id uti = [value respondsToSelector:utiSel] ? Send(value, "attachmentUTI") : nil;
    [entries addObject:@{
      @"location" : @(i),
      @"identifier" : [identifier isKindOfClass:[NSString class]] ? identifier : @"",
      @"uti" : [uti isKindOfClass:[NSString class]] ? uti : [NSNull null],
    }];
  }
  return entries;
}

// One entry per attachment in body order. Notes stores some attachments (for
// example an image added through AppleScript) as two or more adjacent glyphs
// that name the same attachment; those glyphs form one span, so an ordinal
// counts attachments, not glyphs, and a selector targets the whole span.
// Each entry is an AttachmentGlyphEntries entry plus `length` (glyphs).
static NSArray<NSDictionary *> *AttachmentSpans(NSAttributedString *text) {
  NSMutableArray *spans = [NSMutableArray array];
  for (NSDictionary *entry in AttachmentGlyphEntries(text)) {
    NSMutableDictionary *last = spans.lastObject;
    NSString *identifier = [entry[@"identifier"] lowercaseString];
    NSUInteger location = [entry[@"location"] unsignedIntegerValue];
    if (last && identifier.length && [[last[@"identifier"] lowercaseString] isEqualToString:identifier] &&
        [last[@"location"] unsignedIntegerValue] + [last[@"length"] unsignedIntegerValue] == location) {
      last[@"length"] = @([last[@"length"] unsignedIntegerValue] + 1);
      continue;
    }
    NSMutableDictionary *span = [entry mutableCopy];
    span[@"length"] = @1;
    [spans addObject:span];
  }
  return spans;
}

#pragma mark Request parsing

static void RejectUnknownKeys(NSDictionary *object, NSArray *allowed, NSString *what) {
  NSSet *set = [NSSet setWithArray:allowed];
  for (NSString *key in object)
    if (![set containsObject:key])
      Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown field `%@` in %@", key, what], nil);
}

static BOOL OptionalBool(NSDictionary *object, NSString *key, BOOL fallback) {
  id value = object[key];
  if (!value) return fallback;
  if (!IsJSONBool(value))
    Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be a boolean", key], nil);
  return [value boolValue];
}

static NSUInteger OptionalCount(NSDictionary *object, NSString *key, NSUInteger fallback, NSUInteger max) {
  id value = object[key];
  if (!value) return fallback;
  if (![value isKindOfClass:[NSNumber class]] || IsJSONBool(value) ||
      [value doubleValue] != (double)[value longLongValue] || [value longLongValue] < 1 ||
      [value longLongValue] > (long long)max)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"`%@` must be an integer from 1 to %lu", key, (unsigned long)max],
         nil);
  return (NSUInteger)[value longLongValue];
}

static NSDictionary *RequireObject(NSDictionary *object, NSString *key) {
  id value = object[key];
  if (![value isKindOfClass:[NSDictionary class]])
    Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be an object", key], nil);
  return value;
}

static NSString *OptionalEnum(NSDictionary *object, NSString *key, NSArray *allowed, NSString *fallback) {
  id value = object[key];
  if (!value) return fallback;
  if (![value isKindOfClass:[NSString class]] || ![allowed containsObject:value])
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"`%@` must be one of %@", key, [allowed componentsJoinedByString:@", "]],
         nil);
  return value;
}

// Whether `text` holds a UTF-16 surrogate without its partner. JSON can carry
// one (\ud800), and neither a match nor a write may split a character.
static BOOL HasUnpairedSurrogate(NSString *text) {
  NSUInteger length = text.length;
  for (NSUInteger i = 0; i < length; i++) {
    unichar c = [text characterAtIndex:i];
    if (CFStringIsSurrogateHighCharacter(c)) {
      if (i + 1 < length && CFStringIsSurrogateLowCharacter([text characterAtIndex:i + 1])) {
        i++;
        continue;
      }
      return YES;
    }
    if (CFStringIsSurrogateLowCharacter(c)) return YES;
  }
  return NO;
}

// Text that must stay inside one paragraph: no line or paragraph breaks, no
// attachment glyph, no control characters other than tab, and no unpaired
// surrogate.
static NSString *EditText(id value, NSString *what, BOOL allowEmpty) {
  if (![value isKindOfClass:[NSString class]])
    Fail(@"invalid_request", [NSString stringWithFormat:@"%@ must be a string", what], nil);
  NSString *text = value;
  if (!allowEmpty && !text.length)
    Fail(@"invalid_request", [NSString stringWithFormat:@"%@ must not be empty", what], nil);
  if (text.length > MAX_EDIT_TEXT_UTF16)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ exceeds %d UTF-16 code units", what, MAX_EDIT_TEXT_UTF16], nil);
  if ([text rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ must stay inside one paragraph: no line breaks, attachment "
                                    @"glyphs, or control characters",
                                    what],
         nil);
  if (HasUnpairedSurrogate(text))
    Fail(@"invalid_request", [NSString stringWithFormat:@"%@ contains an unpaired UTF-16 surrogate", what], nil);
  return text;
}

static NSNumber *StyleFromName(id value, NSString *what) {
  NSNumber *style = [value isKindOfClass:[NSString class]] ? StyleValues()[value] : nil;
  if (!style)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ must be one of %@", what,
                                    [[StyleValues().allKeys sortedArrayUsingSelector:@selector(compare:)]
                                        componentsJoinedByString:@", "]],
         nil);
  return style;
}

static NSArray *EditOperations(NSDictionary *request) {
  NSArray *operations = request[@"operations"];
  if (![operations isKindOfClass:[NSArray class]] || !operations.count ||
      operations.count > MAX_EDIT_OPERATIONS)
    Fail(@"invalid_request", @"`operations` must be an array of 1 to 64 operations", nil);
  for (id operation in operations)
    if (![operation isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", @"Every operation must be an object", nil);
  return operations;
}

#pragma mark Replacement construction

// The replaced range's attributes without the inline formatting a run states
// (bold/italic, underline, strikethrough, link, highlight, color), the
// per-edit timestamp, and any attachment. A run's formatting is exactly what
// it says: a run with no `link` is not linked, even over linked text.
static NSMutableDictionary *InlineBase(NSDictionary *attributes) {
  NSMutableDictionary *base = [attributes mutableCopy] ?: [NSMutableDictionary dictionary];
  [base removeObjectsForKeys:@[
    kHintsKey, kUnderlineKey, kStrikethroughKey, kTimestampKey, kAttachmentKey, NSLinkAttributeName, kEmphasisKey,
    kColorKey
  ]];
  return base;
}

static NSDictionary *RunAttributes(NSDictionary *run);

// `runs` replacement: each run is plain text plus explicit inline formatting
// laid over `base` (the paragraph style and font of the replaced range). A
// run takes the same fields as a compose run and is built by compose's
// RunAttributes: bold, italic, underline, strikethrough, link (http, https,
// mailto, tel, notes, applenotes), highlight (purple, pink, orange, mint,
// blue), and color (#RRGGBB).
static NSAttributedString *AttributedRuns(id value, NSDictionary *base, NSString *what) {
  if (![value isKindOfClass:[NSArray class]] || ![value count] || [value count] > MAX_EDIT_RUNS)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ must be an array of 1 to %d runs", what, MAX_EDIT_RUNS], nil);
  NSMutableAttributedString *out = [NSMutableAttributedString new];
  for (id run in value) {
    if (![run isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", [NSString stringWithFormat:@"%@ entries must be objects", what], nil);
    RejectUnknownKeys(run,
                      @[ @"text", @"bold", @"italic", @"underline", @"strikethrough", @"link", @"highlight", @"color" ],
                      what);
    NSString *text = EditText(run[@"text"], [what stringByAppendingString:@" text"], NO);
    NSMutableDictionary *attrs = [base mutableCopy];
    [attrs addEntriesFromDictionary:RunAttributes(run)];
    [out appendAttributedString:[[NSAttributedString alloc] initWithString:text attributes:attrs]];
  }
  if (out.length > MAX_EDIT_TEXT_UTF16)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ exceed %d UTF-16 code units", what, MAX_EDIT_TEXT_UTF16], nil);
  return out;
}

static id NewParagraphStyle(unsigned int value, BOOL checked) {
  id style = [[objc_getClass("ICTTMutableParagraphStyle") alloc] init];
  if (!style) Fail(@"private_api_unavailable", @"Could not create a native paragraph style", nil);
  ((void (*)(id, SEL, unsigned int))objc_msgSend)(style, sel_registerName("setStyle:"), value);
  if (value == kStyleChecklist) {
    id todo = ((id(*)(id, SEL, id, BOOL))objc_msgSend)(
        [objc_getClass("ICTTTodo") alloc], sel_registerName("initWithIdentifier:done:"), [NSUUID UUID], checked);
    if (!todo) Fail(@"private_api_unavailable", @"Could not create a native checklist item", nil);
    ((void (*)(id, SEL, id))objc_msgSend)(style, sel_registerName("setTodo:"), todo);
  }
  return [style copy];
}

// Whole paragraphs for an insert. Each block gets a fresh native paragraph
// style (and, for checklist rows, a fresh todo with the requested state).
// With `separatorAttributes`, the blocks follow a newline that terminates the
// anchor paragraph and carries the anchor's own paragraph style; the last
// block then has no terminator, matching a note that did not end in "\n".
static NSAttributedString *AttributedBlocks(id value, NSDictionary *separatorAttributes, NSString *what) {
  if (![value isKindOfClass:[NSArray class]] || ![value count] || [value count] > MAX_EDIT_BLOCKS)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ must be an array of 1 to %d blocks", what, MAX_EDIT_BLOCKS], nil);
  NSMutableAttributedString *out = [NSMutableAttributedString new];
  if (separatorAttributes)
    [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"
                                                                attributes:separatorAttributes]];
  NSUInteger count = [value count], i = 0;
  for (id block in value) {
    if (![block isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", [NSString stringWithFormat:@"%@ entries must be objects", what], nil);
    RejectUnknownKeys(block, @[ @"type", @"text", @"runs", @"checked" ], what);
    NSNumber *style = StyleFromName(block[@"type"], @"block type");
    if (style.unsignedIntValue == kStyleTitle)
      Fail(@"title_invariant", @"Inserted blocks cannot be titles; use set_title", @{@"committed" : @NO});
    if (block[@"checked"] && style.unsignedIntValue != kStyleChecklist)
      Fail(@"invalid_request", @"`checked` is only valid on checklist blocks", nil);
    id paragraphStyle = NewParagraphStyle(style.unsignedIntValue, OptionalBool(block, @"checked", NO));
    NSDictionary *base = @{kStyleKey : paragraphStyle};
    if ((block[@"text"] != nil) == (block[@"runs"] != nil))
      Fail(@"invalid_request", @"Each block needs exactly one of `text` or `runs`", nil);
    NSAttributedString *content =
        block[@"runs"]
            ? AttributedRuns(block[@"runs"], base, @"block runs")
            : [[NSAttributedString alloc]
                  initWithString:EditText(block[@"text"], @"block text", style.unsignedIntValue == kStyleBody)
                      attributes:base];
    [out appendAttributedString:content];
    BOOL last = ++i == count;
    if (!(separatorAttributes && last))
      [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n" attributes:base]];
  }
  return out;
}

#pragma mark Selectors

static NSArray<EditParagraph *> *ScopeParagraphs(NSArray<EditParagraph *> *paragraphs, NSString *scope) {
  if ([scope isEqualToString:@"all"]) return paragraphs;
  if ([scope isEqualToString:@"title"]) return paragraphs.count ? @[ paragraphs.firstObject ] : @[];
  return paragraphs.count > 1 ? [paragraphs subarrayWithRange:NSMakeRange(1, paragraphs.count - 1)] : @[];
}

// A text selector resolves to ranges inside single paragraphs. `substring`
// finds every non-overlapping literal occurrence; `equals` matches a
// paragraph whose entire text is the literal.
static NSArray<NSDictionary *> *ResolveText(NSDictionary *selector, NSString *match,
                                            NSAttributedString *snapshot,
                                            NSArray<EditParagraph *> *paragraphs, NSString *defaultScope) {
  NSString *literal = EditText(selector[@"text"], @"selector text", NO);
  NSString *scope = OptionalEnum(selector, @"scope", @[ @"body", @"title", @"all" ], defaultScope);
  NSString *text = snapshot.string;
  NSMutableArray *hits = [NSMutableArray array];
  for (EditParagraph *p in ScopeParagraphs(paragraphs, scope)) {
    if ([match isEqualToString:@"equals"]) {
      if ([[text substringWithRange:p.content] isEqualToString:literal])
        [hits addObject:@{@"range" : [NSValue valueWithRange:p.content], @"paragraph" : p}];
      continue;
    }
    NSUInteger cursor = p.content.location, end = NSMaxRange(p.content);
    while (cursor < end) {
      NSRange found = [text rangeOfString:literal
                                  options:NSLiteralSearch
                                    range:NSMakeRange(cursor, end - cursor)];
      if (found.location == NSNotFound) break;
      // Matching is on UTF-16 units, so a literal can match inside one
      // character (half of an emoji's surrogate pair, a base letter without
      // its combining accent). Such a hit is refused rather than skipped, so
      // the match count never silently differs from what the caller sees.
      if (!NSEqualRanges([text rangeOfComposedCharacterSequencesForRange:found], found))
        Fail(@"unsupported_selection",
             @"The selector text matches part of a composed character (an emoji, or a letter with a combining "
             @"mark); widen the selector text to whole characters",
             @{@"committed" : @NO});
      [hits addObject:@{@"range" : [NSValue valueWithRange:found], @"paragraph" : p}];
      cursor = NSMaxRange(found);
    }
  }
  return hits;
}

static NSArray<NSDictionary *> *ResolveStyle(NSDictionary *selector, NSAttributedString *snapshot,
                                             NSArray<EditParagraph *> *paragraphs, BOOL blankOnly) {
  unsigned int wanted = StyleFromName(selector[@"style"], @"selector style").unsignedIntValue;
  NSMutableArray *hits = [NSMutableArray array];
  for (EditParagraph *p in paragraphs) {
    if (StyleValueOf(ParagraphStyleAt(snapshot, p)) != wanted) continue;
    if (blankOnly) {
      NSString *content = [snapshot.string substringWithRange:p.content];
      if ([content rangeOfString:@"\uFFFC"].location != NSNotFound) continue;
      if ([content stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length) continue;
    }
    [hits addObject:@{@"range" : [NSValue valueWithRange:p.content], @"paragraph" : p}];
  }
  return hits;
}

static const APIRequirement kAttachmentSelectorAPI[] = {
    {"ICTTAttachment", "attachmentIdentifier", NO},
    {"ICTTAttachment", "attachmentUTI", NO},
};

static EditParagraph *ParagraphAt(NSArray<EditParagraph *> *paragraphs, NSUInteger location) {
  for (EditParagraph *p in paragraphs)
    if (location >= p.full.location && location < NSMaxRange(p.full)) return p;
  return nil;
}

// An attachment selector names one of the note's attachment rows by
// `identifier` (its Notes UUID), `id` (its x-coredata ICAttachment URI, as
// list-attachments and get-note-structure return it), or `ordinal` (1-based
// position among the body's attachments that belong to the note's
// attachment rows; inline objects such as hashtags and note links are not
// counted and cannot be selected). An attachment is its span of glyphs
// (AttachmentSpans): adjacent glyphs naming the same attachment count once
// and are edited together. Per role:
//   replace  `position` self (default) targets the span itself, so the
//            replacement takes its place (empty text removes it; a file
//            replaces it with a new attachment); before/after target the
//            empty range at the span's first or last edge, so the
//            replacement text is inserted inline beside it.
//   delete   the paragraph holding the span, which must hold nothing else
//            but whitespace.
//   anchor   the paragraph holding the span.
// Each hit carries `glyphs` (the only glyph range its target may contain),
// `row` (the attachment row), and `attachment` (what the plan reports).
static NSArray<NSDictionary *> *ResolveAttachment(NSDictionary *selector, NSString *role,
                                                  NSAttributedString *snapshot,
                                                  NSArray<EditParagraph *> *paragraphs,
                                                  NSDictionary<NSString *, NSManagedObject *> *rows) {
  NSMutableArray *keys = [@[ @"kind", @"identifier", @"id", @"ordinal", @"occurrence" ] mutableCopy];
  BOOL replace = [role isEqualToString:@"replace"];
  if (replace) [keys addObject:@"position"];
  RejectUnknownKeys(selector, keys, @"attachment selector");
  NSUInteger given =
      (selector[@"identifier"] ? 1 : 0) + (selector[@"id"] ? 1 : 0) + (selector[@"ordinal"] ? 1 : 0);
  if (given != 1)
    Fail(@"invalid_request",
         @"An attachment selector needs exactly one of `identifier`, `id`, or `ordinal`", nil);
  NSArray *missing = MissingAPI(kAttachmentSelectorAPI, COUNT(kAttachmentSelectorAPI));
  if (missing.count)
    Fail(@"private_api_unavailable", @"Attachment selectors need NotesShared's attachment accessors",
         @{@"missing" : missing});
  NSString *position = replace ? OptionalEnum(selector, @"position", @[ @"self", @"before", @"after" ], @"self")
                               : @"self";

  NSString *wanted = nil;
  if (selector[@"identifier"]) {
    if (!IsUUID(selector[@"identifier"]))
      Fail(@"invalid_request", @"attachment selector `identifier` must be a Notes UUID", nil);
    wanted = [selector[@"identifier"] lowercaseString];
  } else if (selector[@"id"]) {
    id uri = selector[@"id"];
    if (![uri isKindOfClass:[NSString class]] || ![uri hasPrefix:@"x-coredata://"] ||
        [uri rangeOfString:@"/ICAttachment/p"].location == NSNotFound)
      Fail(@"invalid_request", @"attachment selector `id` must be an x-coredata ICAttachment id", nil);
    wanted = @"";  // an id that names none of this note's rows matches nothing
    for (NSString *key in rows)
      if ([rows[key].objectID.URIRepresentation.absoluteString caseInsensitiveCompare:uri] == NSOrderedSame)
        wanted = key;
  }
  NSUInteger ordinal = OptionalCount(selector, @"ordinal", 0, MAX_EDIT_TARGETS);

  NSMutableArray *hits = [NSMutableArray array];
  NSUInteger seen = 0;
  for (NSDictionary *entry in AttachmentSpans(snapshot)) {
    NSString *key = [entry[@"identifier"] lowercaseString];
    if (!rows[key]) continue;  // inline objects are never selectable
    seen++;
    if (ordinal ? seen != ordinal : ![key isEqualToString:wanted]) continue;
    // Every glyph of the attachment: one, or several adjacent ones.
    NSRange glyphs = NSMakeRange([entry[@"location"] unsignedIntegerValue], [entry[@"length"] unsignedIntegerValue]);
    EditParagraph *p = ParagraphAt(paragraphs, glyphs.location);
    if (!p) continue;
    NSRange range;
    if (replace) {
      range = [position isEqualToString:@"before"] ? NSMakeRange(glyphs.location, 0)
              : [position isEqualToString:@"after"] ? NSMakeRange(NSMaxRange(glyphs), 0)
                                                    : glyphs;
    } else {
      range = p.content;
    }
    if ([role isEqualToString:@"delete"]) {
      NSMutableString *rest = [[snapshot.string substringWithRange:p.content] mutableCopy];
      [rest deleteCharactersInRange:NSMakeRange(glyphs.location - p.content.location, glyphs.length)];
      if ([rest rangeOfString:@"￼"].location != NSNotFound ||
          [rest stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length)
        Fail(@"unsupported_selection",
             @"The attachment's paragraph holds other text or objects; remove just the attachment with "
             @"replace (position self, empty text) instead",
             @{@"committed" : @NO});
    }
    [hits addObject:@{
      @"range" : [NSValue valueWithRange:range],
      @"paragraph" : p,
      @"glyphs" : [NSValue valueWithRange:glyphs],
      @"position" : position,
      @"row" : rows[key],
      @"attachment" : @{
        @"identifier" : [rows[key] valueForKey:@"identifier"] ?: entry[@"identifier"],
        @"uti" : entry[@"uti"],
        @"ordinal" : @(seen),
        @"glyphCount" : @(glyphs.length),
      },
    }];
  }
  return hits;
}

// One entry point for every selector kind an operation role accepts. Roles:
// "replace" (text, substring or equals; or one attachment), "delete" (text
// equals, blank styled rows, or an attachment's own paragraph), "anchor"
// (text equals, style, or an attachment's paragraph). A new kind is one more
// branch here plus its entry in the role's allowed list.
static NSArray<NSDictionary *> *ResolveSelector(NSDictionary *selector, NSString *role,
                                                NSAttributedString *snapshot,
                                                NSArray<EditParagraph *> *paragraphs,
                                                NSDictionary<NSString *, NSManagedObject *> *rows,
                                                NSString **kindOut) {
  NSArray *kinds = [role isEqualToString:@"replace"]  ? @[ @"text", @"attachment" ]
                   : [role isEqualToString:@"delete"] ? @[ @"text", @"blank", @"attachment" ]
                                                      : @[ @"text", @"style", @"attachment" ];
  NSString *kind = OptionalEnum(selector, @"kind", kinds, @"text");
  if (kindOut) *kindOut = kind;
  if ([kind isEqualToString:@"attachment"]) return ResolveAttachment(selector, role, snapshot, paragraphs, rows);
  if ([kind isEqualToString:@"text"]) {
    if ([role isEqualToString:@"replace"]) {
      RejectUnknownKeys(selector, @[ @"kind", @"text", @"scope", @"match", @"occurrence" ], @"text selector");
      NSString *match = OptionalEnum(selector, @"match", @[ @"substring", @"equals" ], @"substring");
      return ResolveText(selector, match, snapshot, paragraphs, @"body");
    }
    RejectUnknownKeys(selector, @[ @"kind", @"text", @"scope", @"occurrence" ], @"text selector");
    return ResolveText(selector, @"equals", snapshot, paragraphs,
                       [role isEqualToString:@"anchor"] ? @"all" : @"body");
  }
  if ([kind isEqualToString:@"blank"]) {
    RejectUnknownKeys(selector, @[ @"kind", @"style", @"occurrence" ], @"blank selector");
    // Blank body paragraphs are ordinary spacing, and the title is never
    // deleted, so a blank selector names a list, checklist, or heading row.
    unsigned int blankStyle = StyleFromName(selector[@"style"], @"selector style").unsignedIntValue;
    if (blankStyle == kStyleTitle || blankStyle == kStyleBody)
      Fail(@"invalid_request", @"A blank selector needs a style other than title or body", nil);
    return ResolveStyle(selector, snapshot, paragraphs, YES);
  }
  RejectUnknownKeys(selector, @[ @"kind", @"style", @"occurrence" ], @"style anchor");
  return ResolveStyle(selector, snapshot, paragraphs, NO);
}

// Whether a target resolved by this selector kind may contain an attachment
// glyph. Only an explicit attachment selector may, and then only the glyph
// of the attachment it named (RequireNoAttachmentGlyph checks the location).
static BOOL TargetMayTouchAttachment(NSString *kind) {
  return [kind isEqualToString:@"attachment"];
}

// Applies expectedCount (must equal the full match count) and occurrence
// (1-based; picks one match without changing what must exist).
static NSArray<NSDictionary *> *CountAndPick(NSArray<NSDictionary *> *hits, NSDictionary *operation,
                                             NSDictionary *selector, NSUInteger index) {
  NSUInteger expected = OptionalCount(operation, @"expectedCount", 1, MAX_EDIT_TARGETS);
  NSUInteger occurrence = OptionalCount(selector, @"occurrence", 0, MAX_EDIT_TARGETS);
  if (hits.count != expected)
    Fail(@"match_count_mismatch",
         [NSString stringWithFormat:@"Operation %lu matched %lu time(s); expectedCount is %lu",
                                    (unsigned long)index, (unsigned long)hits.count, (unsigned long)expected],
         @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @(hits.count)});
  if (occurrence > hits.count)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"Operation %lu occurrence exceeds its matches", (unsigned long)index], nil);
  return occurrence ? @[ hits[occurrence - 1] ] : hits;
}

#pragma mark Planning

static NSMutableDictionary *Target(NSRange range, NSAttributedString *replacement, NSUInteger operation,
                                   EditParagraph *paragraph) {
  return [@{
    @"range" : [NSValue valueWithRange:range],
    @"replacement" : replacement,
    @"operation" : @(operation),
    @"paragraph" : @(paragraph.index),
  } mutableCopy];
}

// Refuses a target range that contains an attachment glyph, except the glyphs
// of the one attachment (`allowedGlyphs`, its span) an attachment selector
// named. Every other glyph, including a second attachment in the same
// paragraph, is refused.
static void RequireNoAttachmentGlyph(NSAttributedString *snapshot, NSRange range, NSUInteger index,
                                     NSString *kind, NSRange allowedGlyphs) {
  if (!TargetMayTouchAttachment(kind)) allowedGlyphs = NSMakeRange(NSNotFound, 0);
  NSString *text = snapshot.string;
  NSUInteger cursor = range.location, end = NSMaxRange(range);
  while (cursor < end) {
    NSRange found = [text rangeOfString:@"\uFFFC"
                                options:NSLiteralSearch
                                  range:NSMakeRange(cursor, end - cursor)];
    if (found.location == NSNotFound) return;
    if (!NSLocationInRange(found.location, allowedGlyphs))
      Fail(@"unsupported_selection",
           [NSString stringWithFormat:@"Operation %lu would touch an attachment, table, or inline object it "
                                      @"did not select; those are never edited",
                                      (unsigned long)index],
           @{@"committed" : @NO, @"operationIndex" : @(index)});
    cursor = NSMaxRange(found);
  }
}

static NSRange HitGlyphs(NSDictionary *hit) {
  return hit[@"glyphs"] ? [hit[@"glyphs"] rangeValue] : NSMakeRange(NSNotFound, 0);
}

// Plain replacement text inherits the replaced range's attributes, which is
// only meaningful when that range is uniformly formatted. `attributesAt`
// overrides where those attributes are read (an attachment glyph, for text
// inserted beside it); NSNotFound keeps the default.
static NSAttributedString *ReplacementFor(NSDictionary *replacement, NSAttributedString *snapshot,
                                          NSRange range, EditParagraph *paragraph, NSUInteger index,
                                          BOOL allowEmpty, NSUInteger attributesAt) {
  RejectUnknownKeys(replacement, @[ @"text", @"runs" ], @"replacement");
  if ((replacement[@"text"] != nil) == (replacement[@"runs"] != nil))
    Fail(@"invalid_request", @"replacement needs exactly one of `text` or `runs`", nil);
  NSUInteger at = attributesAt != NSNotFound ? attributesAt
                  : range.length             ? range.location
                                             : paragraph.full.location;
  NSDictionary *attributes = at < snapshot.length ? [snapshot attributesAtIndex:at effectiveRange:NULL] : @{};
  if (replacement[@"runs"])
    return AttributedRuns(replacement[@"runs"], InlineBase(attributes), @"replacement runs");
  NSString *text = EditText(replacement[@"text"], @"replacement text", allowEmpty);
  if (range.length && CanonicalRuns(snapshot, range, YES).count > 1)
    Fail(@"mixed_formatting",
         [NSString stringWithFormat:@"Operation %lu matches text with mixed formatting; pass "
                                    @"replacement.runs to say how the new text is formatted",
                                    (unsigned long)index],
         @{@"committed" : @NO, @"operationIndex" : @(index)});
  NSMutableDictionary *inherited = [attributes mutableCopy];
  [inherited removeObjectsForKeys:@[ kTimestampKey, kAttachmentKey ]];
  return [[NSAttributedString alloc] initWithString:text attributes:inherited];
}

#pragma mark Replacing an attachment with a file

// An attachment selector's replacement may be `{file, filename?}`: a local
// file that becomes a new attachment in the old one's place, in the same
// save. The writer reads the file itself, once per request, through a
// descriptor opened with O_NOFOLLOW; the plan reports its size and SHA-256
// and folds the digest into planDigest, so an apply with ifPlanDigest refuses
// a file that changed after the dry run. The attachment is created only on
// apply (MaterializeReplacementFiles); a dry run never writes a file.

#define MAX_REPLACEMENT_FILE_BYTES (64LL * 1024 * 1024)
#define MAX_REPLACEMENT_FILENAME 255

static NSString *const kPDFUTI = @"com.adobe.pdf";

static const APIRequirement kEditFileAPI[] = {
    {"ICNote", "addAttachmentWithUTI:data:filename:", NO},
    {"ICNote", "rangeForAttachment:", NO},
    {"ICAttachment", "typeUTIIsImage:", YES},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"ICMedia", "mediaURL", NO},
    {"ICMedia", "containerDirectoryURL", NO},
    {"ICMedia", "updateChangeCountWithReason:", NO},
    {"ICAccount", "mediaDirectoryURL", NO},
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"UTType", "typeWithFilenameExtension:", YES},
    {"UTType", "identifier", NO},
};

static const ModelRequirement kEditFileModel[] = {
    {"ICAttachment", "identifier,typeUTI,note,media"},
    {"ICMedia", "identifier,filename,attachment,cloudState"},
    {"ICAccount", "attachments,media"},
};

static NSArray<NSString *> *MissingForEditFile(void) {
  NSMutableArray *missing = [MissingForFeature(FeatureEdit) mutableCopy];
  if (!gFrameworkLoaded) return missing;
  [missing addObjectsFromArray:MissingAPI(kEditFileAPI, COUNT(kEditFileAPI))];
  [missing addObjectsFromArray:MissingModelProperties(kEditFileModel, COUNT(kEditFileModel))];
  return missing;
}

static NSDictionary *EditFileFeatureReport(BOOL contextOK, NSString *contextReason) {
  NSArray *missing = MissingForEditFile();
  if (missing.count) return @{@"available" : @NO, @"reason" : @"private_api_unavailable", @"missing" : missing};
  if (!contextOK)
    return @{@"available" : @NO, @"reason" : contextReason ?: @"store_unavailable", @"missing" : @[]};
  return @{@"available" : @YES, @"reason" : [NSNull null], @"missing" : @[]};
}

static void InstallAccountSandbox(NSString *root);

// The UTI Notes stores for a file name's extension, or nil.
static NSString *UTIForFilename(NSString *filename) {
  NSString *extension = filename.pathExtension;
  if (!extension.length) return nil;
  id type = ((id(*)(id, SEL, id))objc_msgSend)(objc_getClass("UTType"), sel_registerName("typeWithFilenameExtension:"),
                                               extension);
  id identifier = type ? Send(type, "identifier") : nil;
  return [identifier isKindOfClass:[NSString class]] ? identifier : nil;
}

// Reads and checks one replacement file: an absolute path to a non-empty
// regular file of at most 64 MiB (the final component may not be a link),
// named `filename` (default: the file's own name; it must keep the file's
// extension), whose type is an image or a PDF. Returns
// {data, sha256, sizeBytes, filename, uti, path}.
static NSMutableDictionary *ReadReplacementFile(NSDictionary *replacement) {
  RejectUnknownKeys(replacement, @[ @"file", @"filename" ], @"file replacement");
  NSArray *missing = MissingForEditFile();
  if (missing.count)
    Fail(@"private_api_unavailable", @"Replacing an attachment with a file needs NotesShared API missing on this macOS",
         @{@"missing" : missing, @"committed" : @NO});
  id path = replacement[@"file"];
  if (![path isKindOfClass:[NSString class]] || ![path isAbsolutePath] || [path length] > 4096 ||
      [path rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound)
    Fail(@"invalid_request", @"replacement `file` must be an absolute path", @{@"committed" : @NO});
  id filename = replacement[@"filename"] ?: [path lastPathComponent];
  if (![filename isKindOfClass:[NSString class]] || ![filename length] ||
      [filename length] > MAX_REPLACEMENT_FILENAME || [filename containsString:@"/"] ||
      [filename containsString:@":"] || [filename isEqualToString:@"."] || [filename isEqualToString:@".."] ||
      [filename rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound ||
      HasUnpairedSurrogate(filename))
    Fail(@"invalid_request", @"replacement `filename` must be one file name of at most 255 characters",
         @{@"committed" : @NO});
  if (![[filename pathExtension] length] ||
      [[filename pathExtension] caseInsensitiveCompare:[path pathExtension]] != NSOrderedSame)
    Fail(@"invalid_request", @"replacement `filename` must keep the file's extension", @{@"committed" : @NO});
  NSString *uti = UTIForFilename(filename);
  BOOL image = uti && ((BOOL(*)(id, SEL, id))objc_msgSend)(objc_getClass("ICAttachment"),
                                                           sel_registerName("typeUTIIsImage:"), uti);
  if (!image && ![uti isEqualToString:kPDFUTI])
    Fail(@"unsupported_attachment", @"A replacement file must be an image or a PDF",
         @{@"committed" : @NO, @"uti" : OrNull(uti)});

  int fd = open([path fileSystemRepresentation], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    Fail(@"invalid_request", @"The replacement file cannot be opened (missing, unreadable, or a symbolic link)",
         @{@"committed" : @NO});
  NSMutableData *data = nil;
  struct stat st;
  BOOL ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0 && st.st_size <= MAX_REPLACEMENT_FILE_BYTES;
  if (ok) {
    data = [NSMutableData dataWithCapacity:(NSUInteger)st.st_size];
    char buffer[65536];
    ssize_t n;
    while ((n = read(fd, buffer, sizeof buffer)) > 0) {
      [data appendBytes:buffer length:(NSUInteger)n];
      if ((long long)data.length > st.st_size) break;
    }
    ok = n == 0 && (long long)data.length == st.st_size;
  }
  close(fd);
  if (!ok)
    Fail(@"invalid_request",
         @"The replacement file must be a non-empty regular file of at most 64 MiB that does not change while "
         @"it is read",
         @{@"committed" : @NO});
  return [@{
    @"data" : data,
    @"sha256" : SHA256Hex(data),
    @"sizeBytes" : @(data.length),
    @"filename" : filename,
    @"uti" : uti,
    @"path" : path,
  } mutableCopy];
}

// The glyph that stands for the new attachment: the old glyph's attributes
// (paragraph style and so on) with a fresh ICTTAttachment. Its identifier is
// a placeholder until the apply creates the attachment and fills it in.
static NSAttributedString *FileGlyph(NSAttributedString *snapshot, NSRange glyphs, NSDictionary *file,
                                     id *placeholderOut) {
  NSMutableDictionary *attrs = [[snapshot attributesAtIndex:glyphs.location effectiveRange:NULL] mutableCopy];
  [attrs removeObjectsForKeys:@[ kTimestampKey, kAttachmentKey ]];
  id tt = [objc_getClass("ICTTAttachment") new];
  if (!tt) Fail(@"private_api_unavailable", @"Could not create an attachment glyph", @{@"committed" : @NO});
  SendVoid1(tt, "setAttachmentIdentifier:", NSUUID.UUID.UUIDString);
  SendVoid1(tt, "setAttachmentUTI:", file[@"uti"]);
  attrs[kAttachmentKey] = tt;
  *placeholderOut = tt;
  return [[NSAttributedString alloc] initWithString:@"￼" attributes:attrs];
}

// What a plan reports about a replacement file (never its bytes).
static NSDictionary *PublicFile(NSDictionary *file) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  for (NSString *key in @[ @"filename", @"uti", @"sizeBytes", @"sha256", @"attachmentIdentifier", @"mediaIdentifier" ])
    if (file[key]) out[key] = file[key];
  return out;
}

// The media container NotesShared wrote for a new attachment, but only when
// it sits exactly where the account keeps media (<mediaDirectory>/<media id>),
// so a cleanup can never remove anything else.
static NSString *OwnedMediaContainer(id media, NSManagedObject *note) {
  @try {
    id account = [note valueForKey:@"account"];
    NSURL *root = account ? Send(account, "mediaDirectoryURL") : nil;
    NSURL *container = media ? Send(media, "containerDirectoryURL") : nil;
    NSString *identifier = media ? [media valueForKey:@"identifier"] : nil;
    if (![root isKindOfClass:[NSURL class]] || ![container isKindOfClass:[NSURL class]] ||
        ![identifier isKindOfClass:[NSString class]] || !identifier.length || [identifier containsString:@"/"])
      return nil;
    NSString *expected = [root.path.stringByStandardizingPath stringByAppendingPathComponent:identifier];
    return [container.path.stringByStandardizingPath isEqualToString:expected] ? expected : nil;
  } @catch (NSException *e) {
    return nil;
  }
}

// Creates each replacement file's attachment on the note, checks it, and
// points its placeholder glyph at it. Runs only on apply, after the revision
// and plan checks, inside the caller's @try: a failure before the save rolls
// the context back and removes every media container recorded in
// `containers`. Returns the objects the apply may insert or update beyond the
// note (the attachments, their media, and their cloud states).
static NSSet *MaterializeReplacementFiles(NSArray<NSMutableDictionary *> *files, NSManagedObject *note,
                                          NSMutableArray<NSString *> *containers) {
  NSMutableSet *created = [NSMutableSet set];
  if ([note respondsToSelector:sel_registerName("canAddAttachment")] && !SendBool(note, "canAddAttachment"))
    Fail(@"unsupported_note", @"Notes does not allow attachments in this note", @{@"committed" : @NO});
  for (NSMutableDictionary *file in files) {
    NSManagedObject *attachment = ((id(*)(id, SEL, id, id, id))objc_msgSend)(
        note, sel_registerName("addAttachmentWithUTI:data:filename:"), file[@"uti"], file[@"data"], file[@"filename"]);
    id media = [attachment isKindOfClass:[NSManagedObject class]] ? [attachment valueForKey:@"media"] : nil;
    NSString *container = OwnedMediaContainer(media, note);
    if (container) [containers addObject:container];
    NSString *identifier = attachment ? [attachment valueForKey:@"identifier"] : nil;
    if (![identifier isKindOfClass:[NSString class]] || !identifier.length || !media ||
        ![[attachment valueForKey:@"typeUTI"] isEqual:file[@"uti"]])
      Fail(@"materialization_failed", @"NotesShared did not create the replacement attachment", @{@"committed" : @NO});
    if (!container)
      Fail(@"materialization_failed", @"The new attachment's file is not where Notes keeps media",
           @{@"committed" : @NO});
    NSRange placed = ((NSRange(*)(id, SEL, id))objc_msgSend)(note, sel_registerName("rangeForAttachment:"), attachment);
    if (placed.location != NSNotFound && placed.length > 0)
      Fail(@"materialization_failed", @"NotesShared placed the attachment glyph itself; refusing to guess",
           @{@"committed" : @NO});
    NSURL *mediaURL = Send(media, "mediaURL");
    NSData *written = [mediaURL isKindOfClass:[NSURL class]] ? [NSData dataWithContentsOfURL:mediaURL] : nil;
    if (!written || ![SHA256Hex(written) isEqualToString:file[@"sha256"]])
      Fail(@"materialization_failed", @"Notes did not store the replacement file's exact bytes", @{@"committed" : @NO});
    // Each is its own cloud object; without its own bump it would not be
    // eligible for upload even when the note is.
    SendVoid1(attachment, "updateChangeCountWithReason:", kEditChangeReason);
    SendVoid1(media, "updateChangeCountWithReason:", kEditChangeReason);
    SendVoid1(file[@"placeholder"], "setAttachmentIdentifier:", identifier);
    SendVoid1(file[@"placeholder"], "setAttachmentUTI:", file[@"uti"]);
    file[@"attachmentIdentifier"] = identifier;
    file[@"mediaIdentifier"] = OrNull([media valueForKey:@"identifier"]);
    file[@"attachment"] = attachment;
    [created addObject:attachment];
    [created addObject:media];
    for (id object in @[ attachment, media ]) {
      id cloudState = [object valueForKey:@"cloudState"];
      if (cloudState) [created addObject:cloudState];
    }
  }
  return created;
}

// Fresh-context proof for each replacement file: the new attachment row
// belongs to the note, has the planned type, and its media file holds the
// planned bytes under the planned name.
static NSString *VerifyReplacementFiles(NSManagedObjectContext *fresh, NSManagedObject *reread, NSArray *files) {
  for (NSDictionary *file in files) {
    NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:@"ICAttachment"];
    request.predicate = [NSPredicate predicateWithFormat:@"identifier == %@", file[@"attachmentIdentifier"]];
    NSArray *rows = [fresh executeFetchRequest:request error:nil];
    if (rows.count != 1) return @"The replacement attachment was not persisted";
    NSManagedObject *row = rows.firstObject;
    if (![row valueForKey:@"note"] || ![[[row valueForKey:@"note"] objectID] isEqual:reread.objectID])
      return @"The replacement attachment does not belong to the note";
    if (![[row valueForKey:@"typeUTI"] isEqual:file[@"uti"]]) return @"The replacement attachment has another type";
    id media = [row valueForKey:@"media"];
    if (!media || ![[media valueForKey:@"filename"] isEqual:file[@"filename"]])
      return @"The replacement attachment's media is missing or has another name";
    NSURL *url = Send(media, "mediaURL");
    NSData *bytes = [url isKindOfClass:[NSURL class]] ? [NSData dataWithContentsOfURL:url] : nil;
    if (!bytes || ![SHA256Hex(bytes) isEqualToString:file[@"sha256"]])
      return @"The replacement attachment's file does not hold the planned bytes";
  }
  return nil;
}

#pragma mark Checklist replacement

// replace_checklist swaps a note's checklist for new items in one edit. With
// `select` "block" (default) it replaces one contiguous run of checklist rows:
// the one holding a row whose whole text is `containing`, or the
// `occurrence`-th (1-based), or the only one. With "all" it replaces every
// checklist row: the first block becomes the new items and every other block
// is removed. Each replaced block goes with its rows' own terminators, so no
// other paragraph loses a character, its terminator, or its style; a block
// that ends the note without a terminator leaves the previous terminator in
// place. A block that holds the title or an attachment is refused.

#define MAX_CHECKLIST_ITEMS 200

static id ComposeParagraphStyle(const StyleSpec *spec, NSUInteger indent, BOOL blockQuote, id checked);
static NSUInteger ComposeCount(NSDictionary *object, NSString *key, NSUInteger min, NSUInteger max,
                                NSUInteger fallback, NSString *label);

static BOOL IsChecklistParagraph(NSAttributedString *snapshot, EditParagraph *p) {
  return StyleValueOf(ParagraphStyleAt(snapshot, p)) == kStyleChecklist;
}

// Maximal runs of consecutive checklist paragraphs.
static NSArray<NSArray<EditParagraph *> *> *ChecklistBlocks(NSAttributedString *snapshot,
                                                            NSArray<EditParagraph *> *paragraphs) {
  NSMutableArray *blocks = [NSMutableArray array];
  NSMutableArray *current = nil;
  for (EditParagraph *p in paragraphs) {
    if (IsChecklistParagraph(snapshot, p)) {
      if (!current) current = [NSMutableArray array];
      [current addObject:p];
    } else if (current) {
      [blocks addObject:current];
      current = nil;
    }
  }
  if (current) [blocks addObject:current];
  return blocks;
}

// The range a block occupies with its rows' terminators.
static NSRange ChecklistBlockRange(NSArray<EditParagraph *> *block) {
  EditParagraph *first = block.firstObject, *last = block.lastObject;
  NSUInteger end = last.terminated ? NSMaxRange(last.full) : NSMaxRange(last.content);
  return NSMakeRange(first.full.location, end - first.full.location);
}

static BOOL ChecklistRowDone(NSAttributedString *snapshot, EditParagraph *p) {
  id todo = Send(ParagraphStyleAt(snapshot, p), "todo");
  return todo ? SendBool(todo, "done") : NO;
}

// New checklist rows, each with a fresh todo in the requested state and its
// own terminator, except the last when `terminateLast` is NO.
static NSAttributedString *NewChecklistRows(id value, BOOL terminateLast) {
  if (![value isKindOfClass:[NSArray class]] || ![value count] || [value count] > MAX_CHECKLIST_ITEMS)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"`items` must be an array of 1 to %d items", MAX_CHECKLIST_ITEMS], nil);
  NSMutableAttributedString *out = [NSMutableAttributedString new];
  NSUInteger count = [value count], i = 0;
  for (id item in value) {
    if (![item isKindOfClass:[NSDictionary class]]) Fail(@"invalid_request", @"Every item must be an object", nil);
    RejectUnknownKeys(item, @[ @"text", @"runs", @"checked", @"indent" ], @"checklist item");
    if (!IsJSONBool(item[@"checked"])) Fail(@"invalid_request", @"Every item needs a boolean `checked`", nil);
    if ((item[@"text"] != nil) == (item[@"runs"] != nil))
      Fail(@"invalid_request", @"Each item needs exactly one of `text` or `runs`", nil);
    NSUInteger indent = ComposeCount(item, @"indent", 0, MAX_INDENT, 0, @"Item");
    id style = [ComposeParagraphStyle(StyleNamed(@"checklist"), indent, NO, item[@"checked"]) copy];
    NSDictionary *base = @{kStyleKey : style};
    NSAttributedString *content =
        item[@"runs"] ? AttributedRuns(item[@"runs"], base, @"item runs")
                      : [[NSAttributedString alloc] initWithString:EditText(item[@"text"], @"item text", NO)
                                                        attributes:base];
    [out appendAttributedString:content];
    if (++i < count || terminateLast)
      [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n" attributes:base]];
  }
  if (out.length > MAX_EDIT_TEXT_UTF16 * 2)
    Fail(@"invalid_request", @"The checklist items exceed 20000 UTF-16 code units", nil);
  return out;
}

// Resolves a replace_checklist operation into targets appended to `created`.
static void PlanChecklistReplace(NSDictionary *operation, NSUInteger index, NSAttributedString *snapshot,
                                 NSArray<EditParagraph *> *paragraphs, NSMutableArray *created,
                                 NSMutableDictionary *summary) {
  RejectUnknownKeys(operation, @[ @"op", @"id", @"select", @"containing", @"occurrence", @"items", @"expectedCount" ],
                    @"replace_checklist operation");
  NSString *select = OptionalEnum(operation, @"select", @[ @"block", @"all" ], @"block");
  BOOL all = [select isEqualToString:@"all"];
  if (all && (operation[@"containing"] || operation[@"occurrence"]))
    Fail(@"invalid_request", @"`containing` and `occurrence` are only valid with select block", nil);
  NSArray<NSArray<EditParagraph *> *> *blocks = ChecklistBlocks(snapshot, paragraphs);
  NSMutableArray<NSArray<EditParagraph *> *> *chosen = [NSMutableArray array];
  if (all) {
    [chosen addObjectsFromArray:blocks];
  } else {
    NSArray *candidates = blocks;
    if (operation[@"containing"]) {
      NSString *literal = EditText(operation[@"containing"], @"`containing`", NO);
      NSMutableArray *matching = [NSMutableArray array];
      for (NSArray<EditParagraph *> *block in blocks)
        for (EditParagraph *p in block)
          if ([[snapshot.string substringWithRange:p.content] isEqualToString:literal]) {
            [matching addObject:block];
            break;
          }
      candidates = matching;
    }
    NSUInteger occurrence = OptionalCount(operation, @"occurrence", 0, MAX_EDIT_TARGETS);
    if (occurrence ? occurrence > candidates.count : candidates.count != 1)
      Fail(@"match_count_mismatch",
           [NSString stringWithFormat:@"Operation %lu matched %lu checklist block(s); it must name exactly one "
                                      @"(use containing or occurrence)",
                                      (unsigned long)index, (unsigned long)candidates.count],
           @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @(candidates.count)});
    [chosen addObject:candidates[occurrence ? occurrence - 1 : 0]];
  }
  if (!chosen.count)
    Fail(@"match_count_mismatch",
         [NSString stringWithFormat:@"Operation %lu found no checklist; insert checklist blocks instead",
                                    (unsigned long)index],
         @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @0});

  NSMutableArray *removedItems = [NSMutableArray array];
  for (NSArray<EditParagraph *> *block in chosen)
    for (EditParagraph *p in block) {
      if (p.index == 0)
        Fail(@"title_invariant", @"The checklist includes the title paragraph", @{@"committed" : @NO});
      [removedItems addObject:@{
        @"paragraphIndex" : @(p.index),
        @"text" : [snapshot.string substringWithRange:p.content],
        @"checked" : @(ChecklistRowDone(snapshot, p)),
      }];
    }
  if (operation[@"expectedCount"]) {
    NSUInteger expected = OptionalCount(operation, @"expectedCount", 1, MAX_EDIT_TARGETS);
    if (removedItems.count != expected)
      Fail(@"match_count_mismatch",
           [NSString stringWithFormat:@"Operation %lu would replace %lu checklist row(s); expectedCount is %lu",
                                      (unsigned long)index, (unsigned long)removedItems.count,
                                      (unsigned long)expected],
           @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @(removedItems.count)});
  }
  for (NSUInteger i = 0; i < chosen.count; i++) {
    NSRange range = ChecklistBlockRange(chosen[i]);
    RequireNoAttachmentGlyph(snapshot, range, index, @"checklist", NSMakeRange(NSNotFound, 0));
    NSAttributedString *replacement =
        i == 0 ? NewChecklistRows(operation[@"items"], chosen[i].lastObject.terminated) : [NSAttributedString new];
    NSMutableDictionary *target = Target(range, replacement, index, chosen[i].firstObject);
    target[@"checklistRows"] = @(chosen[i].count);
    [created addObject:target];
  }
  summary[@"select"] = select;
  summary[@"checklistBlocks"] = @(blocks.count);
  summary[@"replacedBlocks"] = @(chosen.count);
  summary[@"removedItems"] = removedItems;
  summary[@"itemCount"] = @([operation[@"items"] count]);
}

#pragma mark Deletion ranges

// delete_paragraph targets from one operation that overlap or touch become
// one target, so deleting adjacent paragraphs is one removal rather than a
// conflict between the operation and itself.
static NSMutableArray *MergeDeletions(NSMutableArray *created) {
  NSArray *sorted = [created sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
    NSUInteger a = [x[@"range"] rangeValue].location, b = [y[@"range"] rangeValue].location;
    return a == b ? NSOrderedSame : (a < b ? NSOrderedAscending : NSOrderedDescending);
  }];
  NSMutableArray *merged = [NSMutableArray array];
  for (NSMutableDictionary *t in sorted) {
    NSMutableDictionary *last = merged.lastObject;
    NSRange r = [t[@"range"] rangeValue];
    NSRange l = last ? [last[@"range"] rangeValue] : NSMakeRange(NSNotFound, 0);
    if (last && r.location <= NSMaxRange(l)) {
      NSUInteger end = MAX(NSMaxRange(l), NSMaxRange(r));
      last[@"range"] = [NSValue valueWithRange:NSMakeRange(l.location, end - l.location)];
      NSMutableArray *paragraphs = [last[@"mergedParagraphs"] ?: @[ last[@"paragraph"] ] mutableCopy];
      [paragraphs addObject:t[@"paragraph"]];
      last[@"mergedParagraphs"] = paragraphs;
      if (!last[@"attachment"] && t[@"attachment"]) last[@"attachment"] = t[@"attachment"];
      continue;
    }
    [merged addObject:t];
  }
  return merged;
}

#pragma mark Line-break trimming

#define MAX_TRIM_KEEP 10

// A paragraph trim_blank_lines may remove: not the title, no attachment or
// inline object, nothing but whitespace, and a text style (title, heading,
// subheading, or body). Empty list and checklist rows are visible bullets
// (delete them with a blank selector), and empty monospaced lines belong to
// code blocks, so neither is trimmed.
static BOOL IsTrimmableBlank(NSAttributedString *snapshot, EditParagraph *p) {
  if (p.index == 0) return NO;
  NSString *content = [snapshot.string substringWithRange:p.content];
  if ([content rangeOfString:@"\uFFFC"].location != NSNotFound) return NO;
  if ([content stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length) return NO;
  unsigned int style = StyleValueOf(ParagraphStyleAt(snapshot, p));
  return style == kStyleTitle || style == 1 || style == 2 || style == kStyleBody;
}

// Maximal runs of consecutive trimmable paragraphs, as arrays of paragraphs.
static NSArray<NSArray<EditParagraph *> *> *BlankRuns(NSAttributedString *snapshot,
                                                     NSArray<EditParagraph *> *paragraphs) {
  NSMutableArray *runs = [NSMutableArray array];
  NSMutableArray *current = nil;
  for (EditParagraph *p in paragraphs) {
    if (IsTrimmableBlank(snapshot, p)) {
      if (!current) current = [NSMutableArray array];
      [current addObject:p];
    } else if (current) {
      [runs addObject:current];
      current = nil;
    }
  }
  if (current) [runs addObject:current];
  return runs;
}

// The run of trimmable paragraphs directly before (or after) the anchor
// paragraph, stopping at the first paragraph that is not trimmable.
static NSArray<EditParagraph *> *AdjacentBlankRun(NSAttributedString *snapshot,
                                                  NSArray<EditParagraph *> *paragraphs, EditParagraph *anchor,
                                                  BOOL before) {
  NSMutableArray *run = [NSMutableArray array];
  if (before) {
    for (NSInteger i = (NSInteger)anchor.index - 1; i >= 0 && IsTrimmableBlank(snapshot, paragraphs[i]); i--)
      [run insertObject:paragraphs[i] atIndex:0];
  } else {
    for (NSUInteger i = anchor.index + 1; i < paragraphs.count && IsTrimmableBlank(snapshot, paragraphs[i]); i++)
      [run addObject:paragraphs[i]];
  }
  return run;
}

// trim_blank_lines removes redundant empty paragraphs, each with its own
// terminating newline, so every non-empty paragraph keeps its characters,
// its terminator, and its paragraph style. mode:
//   runs    in every run of blank paragraphs, keep the first `keep`
//           (default 1) and remove the rest;
//   end     the run that ends the note: keep the first `keep` (default 0);
//   around  the runs directly before and/or after (`side`, default both) the
//           one paragraph `anchor` names: keep the first `keep` (default 0).
// Returns the paragraphs to remove, in document order.
static NSArray<EditParagraph *> *PlanTrim(NSDictionary *operation, NSUInteger index, NSAttributedString *snapshot,
                                          NSArray<EditParagraph *> *paragraphs,
                                          NSDictionary<NSString *, NSManagedObject *> *rows,
                                          NSMutableDictionary *summary) {
  NSString *mode = OptionalEnum(operation, @"mode", @[ @"runs", @"end", @"around" ], nil);
  if (!mode) Fail(@"invalid_request", @"trim_blank_lines needs `mode`", nil);
  BOOL around = [mode isEqualToString:@"around"];
  RejectUnknownKeys(operation,
                    around ? @[ @"op", @"id", @"mode", @"keep", @"anchor", @"side", @"expectedCount" ]
                           : @[ @"op", @"id", @"mode", @"keep", @"expectedCount" ],
                    @"trim_blank_lines operation");
  NSUInteger keep = [mode isEqualToString:@"runs"] ? 1 : 0;
  if (operation[@"keep"]) {
    id value = operation[@"keep"];
    if (![value isKindOfClass:[NSNumber class]] || IsJSONBool(value) ||
        [value doubleValue] != (double)[value longLongValue] || [value longLongValue] < 0 ||
        [value longLongValue] > MAX_TRIM_KEEP)
      Fail(@"invalid_request",
           [NSString stringWithFormat:@"`keep` must be an integer from 0 to %d", MAX_TRIM_KEEP], nil);
    keep = (NSUInteger)[value longLongValue];
  }
  summary[@"mode"] = mode;
  summary[@"keep"] = @(keep);

  NSMutableArray<NSArray<EditParagraph *> *> *runs = [NSMutableArray array];
  if ([mode isEqualToString:@"runs"]) {
    [runs addObjectsFromArray:BlankRuns(snapshot, paragraphs)];
  } else if ([mode isEqualToString:@"end"]) {
    NSArray *last = BlankRuns(snapshot, paragraphs).lastObject;
    if (last && [last lastObject] == paragraphs.lastObject) [runs addObject:last];
  } else {
    NSDictionary *anchor = RequireObject(operation, @"anchor");
    NSString *side = OptionalEnum(operation, @"side", @[ @"before", @"after", @"both" ], @"both");
    NSString *kind = nil;
    NSArray *hits = ResolveSelector(anchor, @"anchor", snapshot, paragraphs, rows, &kind);
    NSUInteger occurrence = OptionalCount(anchor, @"occurrence", 0, MAX_EDIT_TARGETS);
    if (occurrence ? occurrence > hits.count : hits.count != 1)
      Fail(@"match_count_mismatch",
           [NSString stringWithFormat:@"Operation %lu anchor matched %lu paragraph(s); it must name exactly one "
                                      @"(use occurrence)",
                                      (unsigned long)index, (unsigned long)hits.count],
           @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @(hits.count)});
    EditParagraph *anchorParagraph = hits[occurrence ? occurrence - 1 : 0][@"paragraph"];
    if (![side isEqualToString:@"after"])
      [runs addObject:AdjacentBlankRun(snapshot, paragraphs, anchorParagraph, YES)];
    if (![side isEqualToString:@"before"])
      [runs addObject:AdjacentBlankRun(snapshot, paragraphs, anchorParagraph, NO)];
    summary[@"anchorKind"] = kind;
    summary[@"anchorParagraphIndex"] = @(anchorParagraph.index);
    summary[@"side"] = side;
  }

  NSMutableArray *removed = [NSMutableArray array];
  NSUInteger blankParagraphs = 0;
  for (NSArray<EditParagraph *> *run in runs) {
    blankParagraphs += run.count;
    if (run.count > keep)
      [removed addObjectsFromArray:[run subarrayWithRange:NSMakeRange(keep, run.count - keep)]];
  }
  summary[@"blankRuns"] = @(runs.count);
  summary[@"blankParagraphs"] = @(blankParagraphs);
  if (operation[@"expectedCount"]) {
    NSUInteger expected = OptionalCount(operation, @"expectedCount", 1, MAX_EDIT_TARGETS);
    if (removed.count != expected)
      Fail(@"match_count_mismatch",
           [NSString stringWithFormat:@"Operation %lu would remove %lu empty paragraph(s); expectedCount is %lu",
                                      (unsigned long)index, (unsigned long)removed.count,
                                      (unsigned long)expected],
           @{@"committed" : @NO, @"operationIndex" : @(index), @"matchedCount" : @(removed.count)});
  }
  return removed;
}

static NSDictionary *PlanOperation(NSDictionary *operation, NSUInteger index, NSAttributedString *snapshot,
                                   NSArray<EditParagraph *> *paragraphs,
                                   NSDictionary<NSString *, NSManagedObject *> *rows, NSMutableArray *targets) {
  NSString *op = OptionalEnum(
      operation, @"op",
      @[
        @"replace", @"delete_paragraph", @"insert_after", @"insert_before", @"set_title", @"trim_blank_lines",
        @"append_to_paragraph", @"replace_checklist"
      ],
      nil);
  if (!op) Fail(@"invalid_request", @"Every operation needs `op`", nil);
  NSMutableDictionary *summary = [@{@"index" : @(index), @"op" : op} mutableCopy];
  if (operation[@"id"]) {
    id opId = operation[@"id"];
    if (![opId isKindOfClass:[NSString class]] || ![opId length] || [opId length] > 128)
      Fail(@"invalid_request", @"operation `id` must be a string of 1 to 128 characters", nil);
    summary[@"id"] = opId;
  }
  NSMutableArray *created = [NSMutableArray array];
  NSString *kind = nil;
  NSUInteger matched = NSNotFound;  // set when it differs from the target count

  if ([op isEqualToString:@"set_title"]) {
    RejectUnknownKeys(operation, @[ @"op", @"id", @"replacement" ], @"set_title operation");
    EditParagraph *title = paragraphs.firstObject;
    NSDictionary *replacement = RequireObject(operation, @"replacement");
    RequireNoAttachmentGlyph(snapshot, title.content, index, @"title", NSMakeRange(NSNotFound, 0));
    NSAttributedString *text =
        ReplacementFor(replacement, snapshot, title.content, title, index, NO, NSNotFound);
    [created addObject:Target(title.content, text, index, title)];
  } else if ([op isEqualToString:@"replace"]) {
    RejectUnknownKeys(operation, @[ @"op", @"id", @"selector", @"replacement", @"expectedCount" ],
                      @"replace operation");
    NSDictionary *selector = RequireObject(operation, @"selector");
    NSDictionary *replacement = RequireObject(operation, @"replacement");
    NSArray *hits = ResolveSelector(selector, @"replace", snapshot, paragraphs, rows, &kind);
    NSMutableDictionary *file = nil;
    for (NSDictionary *hit in CountAndPick(hits, operation, selector, index)) {
      NSRange range = [hit[@"range"] rangeValue];
      EditParagraph *p = hit[@"paragraph"];
      NSRange glyphs = HitGlyphs(hit);
      RequireNoAttachmentGlyph(snapshot, range, index, kind, glyphs);
      NSMutableDictionary *target;
      if (replacement[@"file"]) {
        // A file takes the place of the attachment's whole span.
        if (![kind isEqualToString:@"attachment"] || !range.length)
          Fail(@"invalid_request", @"A file replacement needs an attachment selector with position self", nil);
        if (![hit[@"row"] valueForKey:@"media"])
          Fail(@"unsupported_attachment", @"Only an image, PDF, or other file attachment can be replaced with a file",
               @{@"committed" : @NO, @"operationIndex" : @(index)});
        if (!file) file = ReadReplacementFile(replacement);
        NSMutableDictionary *copy = [file mutableCopy];
        id placeholder = nil;
        target = Target(range, FileGlyph(snapshot, glyphs, copy, &placeholder), index, p);
        copy[@"placeholder"] = placeholder;
        copy[@"operation"] = @(index);
        copy[@"replaces"] = hit[@"attachment"][@"identifier"];
        target[@"file"] = copy;
      } else {
        // Text beside an attachment must not be empty: an empty insertion is
        // no edit at all. Replacing the glyph itself may be empty (removal).
        BOOL allowEmpty = range.length > 0;
        target = Target(range, ReplacementFor(replacement, snapshot, range, p, index, allowEmpty, glyphs.location),
                        index, p);
      }
      if (hit[@"attachment"]) target[@"attachment"] = hit[@"attachment"];
      [created addObject:target];
    }
    summary[@"selectorKind"] = kind;
    if ([kind isEqualToString:@"text"]) summary[@"match"] = selector[@"match"] ?: @"substring";
    if ([kind isEqualToString:@"attachment"]) summary[@"position"] = selector[@"position"] ?: @"self";
  } else if ([op isEqualToString:@"delete_paragraph"]) {
    RejectUnknownKeys(operation, @[ @"op", @"id", @"selector", @"expectedCount" ],
                      @"delete_paragraph operation");
    NSDictionary *selector = RequireObject(operation, @"selector");
    NSArray *hits = ResolveSelector(selector, @"delete", snapshot, paragraphs, rows, &kind);
    for (NSDictionary *hit in CountAndPick(hits, operation, selector, index)) {
      EditParagraph *p = hit[@"paragraph"];
      if (p.index == 0)
        Fail(@"title_invariant", @"The title paragraph cannot be deleted", @{@"committed" : @NO});
      // A paragraph goes with its own terminator. The last paragraph has
      // none, so only its text goes and the previous terminator stays, as in
      // trim_blank_lines: no other paragraph loses its newline or its style.
      NSRange range = p.terminated ? p.full : p.content;
      RequireNoAttachmentGlyph(snapshot, range, index, kind, HitGlyphs(hit));
      NSMutableDictionary *target = Target(range, [NSAttributedString new], index, p);
      if (hit[@"attachment"]) target[@"attachment"] = hit[@"attachment"];
      [created addObject:target];
    }
    matched = created.count;
    created = MergeDeletions(created);
    summary[@"selectorKind"] = kind;
  } else if ([op isEqualToString:@"trim_blank_lines"]) {
    for (EditParagraph *p in PlanTrim(operation, index, snapshot, paragraphs, rows, summary)) {
      // Each paragraph goes with its own terminator; an unterminated last
      // paragraph (whitespace only) goes alone and leaves the previous
      // terminator in place, so no other paragraph loses its newline.
      RequireNoAttachmentGlyph(snapshot, p.full, index, @"trim", NSMakeRange(NSNotFound, 0));
      NSMutableDictionary *target = Target(p.full, [NSAttributedString new], index, p);
      target[@"blankUTF16"] = @(p.content.length);
      [created addObject:target];
    }
  } else if ([op isEqualToString:@"append_to_paragraph"]) {
    // Inline runs added at the end of one existing paragraph (for example a
    // link after a bullet's text), on the paragraph's own line. The runs lay
    // their stated formatting over the paragraph's style and font; nothing
    // is inherited from the inline formatting of the paragraph's last run.
    RejectUnknownKeys(operation, @[ @"op", @"id", @"anchor", @"runs", @"expectedCount" ],
                      @"append_to_paragraph operation");
    NSDictionary *anchor = RequireObject(operation, @"anchor");
    NSArray *hits = ResolveSelector(anchor, @"anchor", snapshot, paragraphs, rows, &kind);
    for (NSDictionary *hit in CountAndPick(hits, operation, anchor, index)) {
      EditParagraph *p = hit[@"paragraph"];
      NSUInteger at = NSMaxRange(p.content);
      NSUInteger source = p.content.length ? at - 1 : p.full.location;
      NSDictionary *attributes = source < snapshot.length ? [snapshot attributesAtIndex:source effectiveRange:NULL] : @{};
      NSMutableDictionary *target =
          Target(NSMakeRange(at, 0), AttributedRuns(operation[@"runs"], InlineBase(attributes), @"runs"), index, p);
      if (hit[@"attachment"]) target[@"attachment"] = hit[@"attachment"];
      [created addObject:target];
    }
    summary[@"anchorKind"] = kind;
  } else if ([op isEqualToString:@"replace_checklist"]) {
    PlanChecklistReplace(operation, index, snapshot, paragraphs, created, summary);
    matched = [summary[@"removedItems"] count];
  } else {
    BOOL after = [op isEqualToString:@"insert_after"];
    RejectUnknownKeys(operation, @[ @"op", @"id", @"anchor", @"blocks", @"expectedCount" ], @"insert operation");
    NSDictionary *anchor = RequireObject(operation, @"anchor");
    NSArray *hits = ResolveSelector(anchor, @"anchor", snapshot, paragraphs, rows, &kind);
    for (NSDictionary *hit in CountAndPick(hits, operation, anchor, index)) {
      EditParagraph *p = hit[@"paragraph"];
      NSAttributedString *blocks;
      NSUInteger at;
      if (!after) {
        if (p.index == 0)
          Fail(@"title_invariant", @"Nothing can be inserted before the title paragraph", @{@"committed" : @NO});
        at = p.full.location;
        blocks = AttributedBlocks(operation[@"blocks"], nil, @"blocks");
      } else if (p.terminated) {
        at = NSMaxRange(p.full);
        blocks = AttributedBlocks(operation[@"blocks"], nil, @"blocks");
      } else {
        // Anchor is the unterminated last paragraph: the inserted newline
        // becomes its terminator, so it carries the anchor's paragraph style.
        at = NSMaxRange(p.content);
        NSDictionary *anchorAttributes =
            p.content.length ? [snapshot attributesAtIndex:NSMaxRange(p.content) - 1 effectiveRange:NULL] : @{};
        NSMutableDictionary *separator = [NSMutableDictionary dictionary];
        if (anchorAttributes[kStyleKey]) separator[kStyleKey] = anchorAttributes[kStyleKey];
        blocks = AttributedBlocks(operation[@"blocks"], separator, @"blocks");
      }
      NSMutableDictionary *target = Target(NSMakeRange(at, 0), blocks, index, p);
      if (hit[@"attachment"]) target[@"attachment"] = hit[@"attachment"];
      [created addObject:target];
    }
    summary[@"anchorKind"] = kind;
  }
  if (targets.count + created.count > MAX_EDIT_TARGETS)
    Fail(@"invalid_request", @"The edit plan exceeds 1000 targets", nil);
  NSMutableArray *described = [NSMutableArray array];
  for (NSDictionary *t in created) {
    NSRange r = [t[@"range"] rangeValue];
    EditParagraph *p = paragraphs[[t[@"paragraph"] unsignedIntegerValue]];
    NSMutableDictionary *description = [@{
      @"paragraphIndex" : t[@"paragraph"],
      @"paragraphStyle" : StyleName(StyleValueOf(ParagraphStyleAt(snapshot, p))),
      @"location" : @(r.location),
      @"length" : @(r.length),
      @"newLength" : @([t[@"replacement"] length]),
    } mutableCopy];
    if (t[@"attachment"]) description[@"attachment"] = t[@"attachment"];
    // For a trimmed paragraph: how many whitespace characters it held.
    if (t[@"blankUTF16"]) description[@"blankUTF16"] = t[@"blankUTF16"];
    // Adjacent deleted paragraphs merged into this one target.
    if (t[@"mergedParagraphs"]) description[@"mergedParagraphs"] = t[@"mergedParagraphs"];
    if (t[@"checklistRows"]) description[@"checklistRows"] = t[@"checklistRows"];
    if (t[@"file"]) description[@"file"] = PublicFile(t[@"file"]);
    [described addObject:description];
  }
  [targets addObjectsFromArray:created];
  summary[@"matchedCount"] = @(matched != NSNotFound ? matched : created.count);
  summary[@"targets"] = described;
  return summary;
}

// Two targets conflict when their ranges overlap, when an insertion point
// sits on or inside another target's range, or when two insertions share a
// point (their relative order would be ambiguous).
static void RejectOverlaps(NSArray<NSDictionary *> *targets) {
  for (NSUInteger i = 0; i < targets.count; i++) {
    NSRange a = [targets[i][@"range"] rangeValue];
    for (NSUInteger j = i + 1; j < targets.count; j++) {
      NSRange b = [targets[j][@"range"] rangeValue];
      BOOL conflict;
      if (a.length && b.length)
        conflict = NSIntersectionRange(a, b).length > 0;
      else if (!a.length && !b.length)
        conflict = a.location == b.location;
      else {
        NSRange range = a.length ? a : b;
        NSUInteger point = a.length ? b.location : a.location;
        conflict = point >= range.location && point <= NSMaxRange(range);
      }
      if (conflict)
        Fail(@"conflicting_operations",
             [NSString stringWithFormat:@"Operations %@ and %@ touch the same text", targets[i][@"operation"],
                                        targets[j][@"operation"]],
             @{@"committed" : @NO});
    }
  }
}

static NSArray<NSDictionary *> *Descending(NSArray<NSDictionary *> *targets) {
  return [targets sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
    NSUInteger a = [x[@"range"] rangeValue].location, b = [y[@"range"] rangeValue].location;
    return a == b ? NSOrderedSame : (a > b ? NSOrderedAscending : NSOrderedDescending);
  }];
}

// Maps the unchanged stretches of the old text to their place in the new
// text, and records where each replacement landed.
static void Segments(NSArray<NSDictionary *> *targets, NSUInteger oldLength, NSMutableArray *unchanged,
                     NSMutableArray *replaced) {
  NSArray *ascending = [Descending(targets) reverseObjectEnumerator].allObjects;
  NSUInteger oldCursor = 0, newCursor = 0;
  for (NSDictionary *t in ascending) {
    NSRange r = [t[@"range"] rangeValue];
    NSUInteger keep = r.location - oldCursor;
    if (keep)
      [unchanged addObject:@[
        [NSValue valueWithRange:NSMakeRange(oldCursor, keep)], [NSValue valueWithRange:NSMakeRange(newCursor, keep)]
      ]];
    newCursor += keep;
    NSUInteger length = [t[@"replacement"] length];
    [replaced addObject:@[ [NSValue valueWithRange:NSMakeRange(newCursor, length)], t[@"replacement"] ]];
    newCursor += length;
    oldCursor = NSMaxRange(r);
  }
  if (oldCursor < oldLength)
    [unchanged addObject:@[
      [NSValue valueWithRange:NSMakeRange(oldCursor, oldLength - oldCursor)],
      [NSValue valueWithRange:NSMakeRange(newCursor, oldLength - oldCursor)]
    ]];
}

// A digest of everything the plan depends on besides the note: the note
// identifier, the operations, requireNonSystemPaper, and the SHA-256 of each
// replacement file in plan order. edit_note's `ifPlanDigest` refuses an apply
// whose request or files differ from the dry run's.
static NSString *PlanDigest(NSString *identifier, NSArray *operations, BOOL requireNonSystemPaper,
                            NSArray<NSDictionary *> *files) {
  NSMutableArray *fileDigests = [NSMutableArray array];
  for (NSDictionary *file in files) [fileDigests addObject:file[@"sha256"]];
  NSDictionary *document = @{
    @"identifier" : identifier,
    @"operations" : operations,
    @"requireNonSystemPaper" : @(requireNonSystemPaper),
    @"files" : fileDigests,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:document options:NSJSONWritingSortedKeys error:nil];
  if (!data) Fail(@"invalid_request", @"The operations cannot be serialized", nil);
  return [@"p2:" stringByAppendingString:SHA256Hex(data)];
}

@interface EditPlan : NSObject
@property(nonatomic, strong) NSManagedObject *note;
@property(nonatomic, strong) id mergeable;
@property(nonatomic, copy) NSAttributedString *snapshot;
@property(nonatomic, copy) NSAttributedString *expected;
@property(nonatomic, copy) NSArray *targets;
@property(nonatomic, strong) NSMutableArray *unchanged;
@property(nonatomic, strong) NSMutableArray *replaced;
@property(nonatomic) BOOL titleChanged;
@property(nonatomic) BOOL wouldChange;
@property(nonatomic, copy) NSString *revisionBefore;
@property(nonatomic, strong) NSMutableDictionary *response;
// The note's attachment rows by lowercased identifier, and the keys of those
// whose glyph the plan removes from the body.
@property(nonatomic, copy) NSDictionary<NSString *, NSManagedObject *> *attachmentRows;
@property(nonatomic, copy) NSArray<NSString *> *removedAttachments;
// Replacement files in plan order (ReadReplacementFile entries), and after
// materialization the objects the apply may insert for them.
@property(nonatomic, strong) NSMutableArray<NSMutableDictionary *> *files;
@property(nonatomic, strong) NSSet *createdObjects;
@end
@implementation EditPlan
@end

static BOOL IsSystemPaper(NSManagedObject *note, BOOL *known) {
  if (note.entity.attributesByName[@"isSystemPaper"]) {
    *known = YES;
    return [[note valueForKey:@"isSystemPaper"] boolValue];
  }
  if ([note respondsToSelector:sel_registerName("isSystemPaper")]) {
    *known = YES;
    return SendBool(note, "isSystemPaper");
  }
  *known = NO;
  return NO;
}

// Fetches the note in `context`, checks it is editable and (when
// `ifRevision` is given) unchanged, and resolves every operation against one
// snapshot. Shared by plan_edit and edit_note so both compute the same plan.
static EditPlan *PlanEdit(NSManagedObjectContext *context, StoreLocation store, NSString *identifier,
                          NSArray *operations, BOOL requireNonSystemPaper, NSString *ifRevision) {
  EditPlan *plan = [EditPlan new];
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);
  if (requireNonSystemPaper) {
    BOOL known = NO;
    BOOL systemPaper = IsSystemPaper(note, &known);
    if (!known || systemPaper)
      Fail(@"unsupported_note",
           known ? @"The note is a Quick Note" : @"Cannot tell whether the note is a Quick Note",
           @{@"committed" : @NO});
  }
  plan.note = note;
  plan.revisionBefore = RevisionToken(note);
  if (ifRevision && ![plan.revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : plan.revisionBefore});

  id ms = nil;
  NSAttributedString *snapshot = [LoadBody(note, &ms) copy];
  plan.mergeable = ms;
  plan.snapshot = snapshot;
  // Verification compares stored runs field by field; a value of a class it
  // cannot read field by field would make that comparison blind, so such a
  // note is refused before anything is planned or written.
  NSArray *unverifiable = UnverifiableAttributeClasses(snapshot);
  if (unverifiable.count)
    Fail(@"unsupported_note", @"The note holds formatting the writer cannot verify after an edit; nothing was changed",
         @{@"committed" : @NO, @"attributes" : unverifiable});
  plan.attachmentRows = AttachmentRows(note);
  NSArray<EditParagraph *> *paragraphs = Paragraphs(snapshot.string);

  NSMutableArray *targets = [NSMutableArray array];
  NSMutableArray *summaries = [NSMutableArray array];
  NSMutableSet *ids = [NSMutableSet set];
  for (NSUInteger i = 0; i < operations.count; i++) {
    NSDictionary *summary = PlanOperation(operations[i], i, snapshot, paragraphs, plan.attachmentRows, targets);
    if (summary[@"id"]) {
      if ([ids containsObject:summary[@"id"]]) Fail(@"invalid_request", @"Operation ids must be unique", nil);
      [ids addObject:summary[@"id"]];
    }
    [summaries addObject:summary];
  }
  RejectOverlaps(targets);
  plan.targets = targets;
  plan.files = [NSMutableArray array];
  for (NSDictionary *t in targets)
    if (t[@"file"]) [plan.files addObject:t[@"file"]];

  NSMutableAttributedString *expected = [snapshot mutableCopy];
  for (NSDictionary *t in Descending(targets))
    [expected replaceCharactersInRange:[t[@"range"] rangeValue] withAttributedString:t[@"replacement"]];
  plan.expected = expected;
  NSArray<EditParagraph *> *expectedParagraphs = Paragraphs(expected.string);
  NSString *expectedTitle = [expected.string substringWithRange:expectedParagraphs.firstObject.content];
  if (![expectedTitle stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length)
    Fail(@"title_invariant", @"The edit would leave the note without a title", @{@"committed" : @NO});
  plan.titleChanged =
      ![expectedTitle isEqualToString:[snapshot.string substringWithRange:paragraphs.firstObject.content]];
  // Attachments whose glyph is in the snapshot but not in the planned text.
  // Only an attachment selector can put a glyph inside a target, so these are
  // exactly the attachments the request named for replacement or deletion.
  NSMutableSet *kept = [NSMutableSet set];
  for (NSDictionary *entry in AttachmentGlyphEntries(expected))
    [kept addObject:[entry[@"identifier"] lowercaseString]];
  NSMutableArray *removed = [NSMutableArray array];
  NSMutableArray *removedReport = [NSMutableArray array];
  for (NSDictionary *entry in AttachmentGlyphEntries(snapshot)) {
    NSString *key = [entry[@"identifier"] lowercaseString];
    if ([kept containsObject:key] || [removed containsObject:key]) continue;
    [removed addObject:key];
    [removedReport addObject:entry[@"identifier"]];
  }
  plan.removedAttachments = removed;
  plan.unchanged = [NSMutableArray array];
  plan.replaced = [NSMutableArray array];
  Segments(targets, snapshot.length, plan.unchanged, plan.replaced);
  plan.wouldChange = ![expected.string isEqualToString:snapshot.string] ||
                     ![CanonicalRuns(expected, NSMakeRange(0, expected.length), YES)
                         isEqual:CanonicalRuns(snapshot, NSMakeRange(0, snapshot.length), YES)];
  NSUInteger unchangedUTF16 = 0;
  for (NSArray *segment in plan.unchanged) unchangedUTF16 += [segment[0] rangeValue].length;
  NSMutableArray *replacementFiles = [NSMutableArray array];
  for (NSDictionary *file in plan.files) {
    NSMutableDictionary *entry = [PublicFile(file) mutableCopy];
    entry[@"operationIndex"] = file[@"operation"];
    entry[@"replaces"] = file[@"replaces"];
    [replacementFiles addObject:entry];
  }

  plan.response = [@{
    @"identifier" : identifier,
    @"revisionBefore" : plan.revisionBefore,
    @"planDigest" : PlanDigest(identifier, operations, requireNonSystemPaper, plan.files),
    @"requireNonSystemPaper" : @(requireNonSystemPaper),
    // Attachments and inline objects in the body, adjacent glyphs of one
    // attachment counted once (attachmentGlyphs counts every glyph).
    @"attachmentSpans" : @(AttachmentSpans(snapshot).count),
    @"replacementFiles" : replacementFiles,
    @"operationCount" : @(operations.count),
    @"targetCount" : @(targets.count),
    @"operations" : summaries,
    @"lengthBefore" : @(snapshot.length),
    @"lengthAfter" : @(expected.length),
    @"unchangedUTF16" : @(unchangedUTF16),
    @"wouldChange" : @(plan.wouldChange),
    @"titleChanged" : @(plan.titleChanged),
    @"attachmentGlyphs" : @(AttachmentGlyphs(snapshot).count),
    @"attachmentGlyphsAfter" : @(AttachmentGlyphs(expected).count),
    @"removedAttachments" : removedReport,
    @"storeKind" : store.isCopy ? @"copy" : @"live",
  } mutableCopy];
  return plan;
}

// The proof that nothing else moved: same text as the plan, same attribute
// runs outside the edits, the requested formatting inside them (ignoring the
// per-edit timestamps Notes may stamp on new text), and the planned
// attachment glyph sequence.
static NSString *VerifyAgainstPlan(NSAttributedString *persisted, EditPlan *plan) {
  if (![persisted.string isEqualToString:plan.expected.string])
    return @"The persisted text does not equal the planned text";
  if (UnverifiableAttributeClasses(persisted).count)
    return @"The persisted note holds formatting the writer cannot verify";
  for (NSArray *segment in plan.unchanged) {
    NSRange oldRange = [segment[0] rangeValue], newRange = [segment[1] rangeValue];
    if (![CanonicalRuns(plan.snapshot, oldRange, NO) isEqual:CanonicalRuns(persisted, newRange, NO)])
      return [NSString stringWithFormat:@"Formatting changed outside the edited ranges (at %lu)",
                                        (unsigned long)newRange.location];
  }
  for (NSArray *segment in plan.replaced) {
    NSRange newRange = [segment[0] rangeValue];
    NSAttributedString *replacement = segment[1];
    if (![CanonicalRuns(replacement, NSMakeRange(0, replacement.length), YES)
            isEqual:CanonicalRuns(persisted, newRange, YES)])
      return [NSString stringWithFormat:@"The inserted text does not carry the planned formatting (at %lu)",
                                        (unsigned long)newRange.location];
  }
  if (![AttachmentGlyphs(persisted) isEqual:AttachmentGlyphs(plan.expected)])
    return @"The attachment glyph sequence changed";
  return nil;
}

// Every attachment row the note had, other than one whose glyph the plan
// removed, must still be the note's with the same stored values, and no row
// may appear except the one each replacement file created. A removed
// attachment's row may be gone or changed.
static NSString *VerifyAttachmentRows(NSDictionary<NSString *, NSString *> *before,
                                      NSDictionary<NSString *, NSString *> *after, EditPlan *plan) {
  NSSet *removed = [NSSet setWithArray:plan.removedAttachments];
  for (NSString *key in before) {
    if ([removed containsObject:key]) continue;
    if (!after[key]) return @"An attachment the edit did not target is no longer in the note";
    if (![after[key] isEqualToString:before[key]])
      return @"An attachment the edit did not target changed its stored values";
  }
  NSMutableSet *created = [NSMutableSet set];
  for (NSDictionary *file in plan.files)
    if (file[@"attachmentIdentifier"]) [created addObject:[file[@"attachmentIdentifier"] lowercaseString]];
  for (NSString *key in after)
    if (!before[key] && ![created containsObject:key]) return @"A new attachment row appeared in the note";
  for (NSString *key in created)
    if (!after[key]) return @"A replacement attachment is not in the note";
  return nil;
}

// Performs the planned edit on the note in `context` without saving, then
// refuses (after rolling back) if the native string did not take the plan or
// if any object other than the note, its body data, and its cloud state
// became dirty. plan_edit calls this on its read-only context with
// persist = NO, so the plan proves the same side-effect check the apply makes.
static void ApplyInContext(NSManagedObjectContext *context, EditPlan *plan, BOOL persist) {
  NSManagedObject *note = plan.note;
  id ms = plan.mergeable;
  // Edit through the CRDT, last target first, so earlier ranges stay valid.
  SendVoid(ms, "beginEditing");
  for (NSDictionary *t in Descending(plan.targets)) {
    NSRange range = [t[@"range"] rangeValue];
    NSAttributedString *replacement = t[@"replacement"];
    ((void (*)(id, SEL, NSRange, id))objc_msgSend)(
        ms, sel_registerName("replaceCharactersInRange:withAttributedString:"), range, replacement);
    ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
        note, sel_registerName("edited:range:changeInLength:"),
        NSTextStorageEditedCharacters | NSTextStorageEditedAttributes,
        NSMakeRange(range.location, replacement.length), (NSInteger)replacement.length - (NSInteger)range.length);
  }
  SendVoid(ms, "endEditing");

  NSAttributedString *inMemory = Send(ms, "attributedString");
  if (![inMemory.string isEqualToString:plan.expected.string]) {
    [context rollback];
    Fail(@"edit_failed", @"The native string did not take the planned edit; nothing was saved",
         @{@"committed" : @NO});
  }
  // Regenerate the title only when its text changed.
  ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(note, sel_registerName("regenerateTitle:snippet:"),
                                                plan.titleChanged, YES);
  if (persist) {
    if (!SendBool(note, "saveNoteData")) {
      [context rollback];
      Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
    }
    [note setValue:[NSDate date] forKey:@"modificationDate"];
    ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"),
                                          kEditChangeReason);
  }

  // Only the note, its body data, its cloud state, and the row of an
  // attachment the plan removes from the body may change. Notes can re-derive
  // a note's title from one of its attachments when the body is edited; that
  // re-points another attachment row, so it is refused here too. A removed
  // attachment's row may be updated (for example marked for deletion) but
  // never deleted outright; its changed keys are reported.
  NSMutableSet *allowed = [NSMutableSet setWithObject:note];
  id noteData = Send(note, "noteData");
  id cloudState = Send(note, "cloudState");
  if (noteData) [allowed addObject:noteData];
  if (cloudState) [allowed addObject:cloudState];
  NSMutableDictionary *removedRowChanges = [NSMutableDictionary dictionary];
  for (NSString *key in plan.removedAttachments) {
    NSManagedObject *row = plan.attachmentRows[key];
    if (!row) continue;
    [allowed addObject:row];
    if (row.hasChanges)
      removedRowChanges[[row valueForKey:@"identifier"] ?: key] =
          [row.changedValues.allKeys sortedArrayUsingSelector:@selector(compare:)];
  }
  plan.response[@"removedAttachmentRowChanges"] = removedRowChanges;
  // A replacement file's new attachment, its media, and their cloud states
  // may be inserted; creating them updates only the attachment and media
  // relationships of the note's account.
  id account = plan.createdObjects.count ? [note valueForKey:@"account"] : nil;
  NSSet *accountKeys = [NSSet setWithArray:@[ @"attachments", @"media" ]];
  if (account && [[NSSet setWithArray:[account changedValues].allKeys] isSubsetOfSet:accountKeys])
    [allowed addObject:account];
  NSMutableArray *unexpected = [NSMutableArray array];
  for (NSManagedObject *object in context.insertedObjects)
    if (![plan.createdObjects containsObject:object])
      [unexpected addObject:[@"inserted " stringByAppendingString:object.entity.name ?: @"?"]];
  for (NSManagedObject *object in context.deletedObjects)
    [unexpected addObject:[@"deleted " stringByAppendingString:object.entity.name ?: @"?"]];
  for (NSManagedObject *object in context.updatedObjects)
    if (![allowed containsObject:object])
      [unexpected
          addObject:[NSString stringWithFormat:@"updated %@ (%@)", object.entity.name ?: @"?",
                                               [[object.changedValues.allKeys
                                                   sortedArrayUsingSelector:@selector(compare:)]
                                                   componentsJoinedByString:@","]]];
  if (unexpected.count) {
    [context rollback];
    Fail(@"unexpected_side_effect",
         @"Editing this note would also change other objects (for example, Notes re-deriving the title "
         @"from an attachment); nothing was saved. Edit this note in Notes.app.",
         @{@"committed" : @NO, @"objects" : unexpected});
  }
}

// Copy-store fault injection for scripts/test-private-helper-copy-store.sh,
// which must prove that a failure before the save leaves nothing behind and
// that the read-back catches a changed stored field outside the edits.
// APPLE_NOTES_MCP_PRIVATE_TEST_FAULT is read only when the store is a copy
// (APPLE_NOTES_MCP_PRIVATE_STORE); on the live store it is ignored.
//   fail_before_save   fail after the edit and any new attachment, before the save
//   tamper_todo        verify a read-back with one checklist todo toggled
//   tamper_attachment  verify a read-back with one attachment glyph re-pointed
static NSString *const kTestFaultEnv = @"APPLE_NOTES_MCP_PRIVATE_TEST_FAULT";

static NSString *TestFault(StoreLocation store) {
  if (!store.isCopy) return nil;
  NSString *fault = NSProcessInfo.processInfo.environment[kTestFaultEnv];
  return fault.length ? fault : nil;
}

// The persisted text with one stored field changed at the first place in an
// unchanged segment that has one, or nil when there is none.
static NSAttributedString *TamperedReadBack(NSAttributedString *persisted, EditPlan *plan, NSString *fault) {
  NSMutableAttributedString *copy = [persisted mutableCopy];
  BOOL todo = [fault isEqualToString:@"tamper_todo"];
  if (!todo && ![fault isEqualToString:@"tamper_attachment"]) return nil;
  for (NSArray *segment in plan.unchanged) {
    NSRange range = [segment[1] rangeValue];
    for (NSUInteger i = range.location; i < NSMaxRange(range); i++) {
      if (todo) {
        id style = [copy attribute:kStyleKey atIndex:i effectiveRange:NULL];
        id item = style ? Send(style, "todo") : nil;
        if (!item) continue;
        id changed = [style mutableCopy];
        id toggled = ((id(*)(id, SEL, id, BOOL))objc_msgSend)([objc_getClass("ICTTTodo") alloc],
                                                              sel_registerName("initWithIdentifier:done:"),
                                                              Send(item, "uuid"), !SendBool(item, "done"));
        SendVoid1(changed, "setTodo:", toggled);
        [copy addAttribute:kStyleKey value:[changed copy] range:NSMakeRange(i, 1)];
        return copy;
      }
      id glyph = [copy attribute:kAttachmentKey atIndex:i effectiveRange:NULL];
      if (!glyph) continue;
      id swapped = [objc_getClass("ICTTAttachment") new];
      SendVoid1(swapped, "setAttachmentIdentifier:", NSUUID.UUID.UUIDString);
      SendVoid1(swapped, "setAttachmentUTI:", Send(glyph, "attachmentUTI"));
      [copy addAttribute:kAttachmentKey value:swapped range:NSMakeRange(i, 1)];
      return copy;
    }
  }
  return nil;
}

static NSDictionary *HandlePlanEdit(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  NSArray *operations = EditOperations(request);
  BOOL requireNonSystemPaper = OptionalBool(request, @"requireNonSystemPaper", NO);
  RequireFeature(FeatureEdit);
  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, YES);
  EditPlan *plan = PlanEdit(context, store, identifier, operations, requireNonSystemPaper, nil);
  // Rehearse the native edit in the read-only context, then discard it.
  if (plan.wouldChange) {
    ApplyInContext(context, plan, NO);
    [context rollback];
  }
  NSMutableDictionary *response = plan.response;
  response[@"status"] = @"planned";
  response[@"dryRun"] = @YES;
  response[@"committed"] = @NO;
  return response;
}

static NSDictionary *HandleEditNote(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *ifRevision = RequireString(request, @"ifRevision");
  NSArray *operations = EditOperations(request);
  BOOL requireNonSystemPaper = OptionalBool(request, @"requireNonSystemPaper", NO);
  NSString *ifPlanDigest = request[@"ifPlanDigest"] ? RequireString(request, @"ifPlanDigest") : nil;
  RequireFeature(FeatureEdit);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, NO);
  EditPlan *plan = PlanEdit(context, store, identifier, operations, requireNonSystemPaper, ifRevision);
  NSMutableDictionary *response = plan.response;
  response[@"dryRun"] = @NO;
  // The dry run's planDigest: the same identifier, operations,
  // requireNonSystemPaper, and replacement file bytes.
  if (ifPlanDigest && ![ifPlanDigest isEqualToString:response[@"planDigest"]])
    Fail(@"plan_mismatch",
         @"The request or a replacement file differs from the dry run that produced ifPlanDigest; nothing was saved",
         @{@"committed" : @NO, @"planDigest" : response[@"planDigest"]});
  if (!plan.wouldChange) {
    response[@"status"] = @"unchanged";
    response[@"committed"] = @NO;
    response[@"revisionAfter"] = plan.revisionBefore;
    return response;
  }

  NSDictionary *attachmentsBefore = AttachmentRowDigests(plan.attachmentRows);
  NSString *fault = TestFault(store);
  NSMutableArray<NSString *> *mediaContainers = [NSMutableArray array];
  @try {
    if (plan.files.count) {
      // On a copy store every file NotesShared writes goes beside the copy,
      // never into the live container; this must precede the first write.
      if (store.isCopy) InstallAccountSandbox([store.path stringByDeletingLastPathComponent]);
      plan.createdObjects = MaterializeReplacementFiles(plan.files, plan.note, mediaContainers);
    }
    ApplyInContext(context, plan, YES);
    if ([fault isEqualToString:@"fail_before_save"]) {
      [context rollback];
      Fail(@"test_fault", @"Copy-store fault injection: failed after the edit, before the save",
           @{@"committed" : @NO});
    }
    SaveOrFail(context);
  } @catch (NSException *e) {
    // Nothing reached the store (the save was never tried, or it failed and
    // rolled back): drop the new attachments and remove the media files
    // NotesShared already wrote for them.
    BOOL nothingSaved = !gSaveAttempted || ([e isKindOfClass:[HelperError class]] &&
                                            [e.userInfo[@"committed"] isEqual:@NO]);
    if (nothingSaved) {
      [context rollback];
      for (NSString *container in mediaContainers)
        [NSFileManager.defaultManager removeItemAtPath:container error:NULL];
    }
    @throw;
  }

  // Fresh read-back through a new coordinator opened read-only.
  NSString *verifyError = nil;
  NSDictionary *after = nil;
  NSUInteger attachmentRows = 0;
  NSMutableArray *removedReport = [NSMutableArray array];
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *persisted = LoadBody(reread, NULL);
    if ([fault hasPrefix:@"tamper_"])
      persisted = TamperedReadBack(persisted, plan, fault)
                      ?: [[NSAttributedString alloc] initWithString:@"test fault found nothing to change"];
    verifyError = VerifyAgainstPlan(persisted, plan);
    NSDictionary<NSString *, NSManagedObject *> *rowsAfter = AttachmentRows(reread);
    attachmentRows = rowsAfter.count;
    if (!verifyError)
      verifyError = VerifyAttachmentRows(attachmentsBefore, AttachmentRowDigests(rowsAfter), plan);
    if (!verifyError) verifyError = VerifyReplacementFiles(fresh, reread, plan.files);
    for (NSString *key in plan.removedAttachments) {
      NSManagedObject *row = rowsAfter[key];
      [removedReport addObject:@{
        @"identifier" : [plan.attachmentRows[key] valueForKey:@"identifier"] ?: key,
        @"rowStillInNote" : @((BOOL)(row != nil)),
        @"markedForDeletion" : row ? @([[row valueForKey:@"markedForDeletion"] boolValue]) : [NSNull null],
      }];
    }
    after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyError = e.reason ?: e.name;
  }
  if (verifyError)
    Fail(@"verification_failed", verifyError, @{@"committed" : @YES, @"revisionBefore" : plan.revisionBefore});
  NSUInteger otherRows = 0;
  for (NSString *key in attachmentsBefore)
    if (![plan.removedAttachments containsObject:key]) otherRows++;

  response[@"status"] = @"updated";
  response[@"committed"] = @YES;
  response[@"verified"] = @YES;
  response[@"revisionAfter"] = after[@"revision"];
  response[@"title"] = after[@"title"];
  // What the read-back proved, in counts only.
  response[@"preservation"] = @{
    @"unchangedUTF16" : response[@"unchangedUTF16"],
    @"formattingOutsideEditsVerified" : @YES,
    @"attachmentGlyphs" : @(AttachmentGlyphs(plan.expected).count),
    @"attachmentGlyphSequenceVerified" : @YES,
    @"attachmentRows" : @(attachmentRows),
    @"attachmentRowsVerified" : @YES,
    // Rows other than a removed attachment's, proven present with the same
    // stored values; and what became of each removed attachment's row.
    @"otherAttachmentRowsUnchanged" : @(otherRows),
    @"removedAttachments" : removedReport,
    // Each replacement file's new attachment, proven in the note with the
    // planned type, name, and bytes.
    @"replacementFilesVerified" : @(plan.files.count),
  };
  if (plan.files.count) {
    NSMutableArray *files = [NSMutableArray array];
    for (NSDictionary *file in plan.files) {
      NSMutableDictionary *entry = [PublicFile(file) mutableCopy];
      entry[@"operationIndex"] = file[@"operation"];
      entry[@"replaces"] = file[@"replaces"];
      [files addObject:entry];
    }
    response[@"replacementFiles"] = files;
  }
  [response addEntriesFromDictionary:SyncFields(after, store)];
  return response;
}

static void RequireOnlyKeys(NSDictionary *object, NSString *allowedCSV, NSString *label) {
  NSSet *allowed = [NSSet setWithArray:[allowedCSV componentsSeparatedByString:@","]];
  for (NSString *key in object)
    if (![allowed containsObject:key])
      Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown %@ field `%@`", label, key], nil);
}

static BOOL ComposeBool(NSDictionary *object, NSString *key, NSString *label) {
  id value = object[key];
  if (!value) return NO;
  if (!IsJSONBool(value))
    Fail(@"invalid_request", [NSString stringWithFormat:@"%@ `%@` must be a boolean", label, key], nil);
  return [value boolValue];
}

static NSUInteger ComposeCount(NSDictionary *object, NSString *key, NSUInteger min, NSUInteger max,
                                NSUInteger fallback, NSString *label) {
  id value = object[key];
  if (!value) return fallback;
  double number = [value isKindOfClass:[NSNumber class]] && !IsJSONBool(value) ? [value doubleValue] : -1;
  if (number != floor(number) || number < min || number > max)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"%@ `%@` must be an integer from %lu to %lu", label, key,
                                    (unsigned long)min, (unsigned long)max],
         nil);
  return (NSUInteger)number;
}

// Run text is one line of one paragraph: printable characters and tabs only.
static void ValidateRunText(NSString *text) {
  if ([text rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound)
    Fail(@"invalid_request",
         @"Run `text` may contain only printable characters and tabs (no newlines, attachment "
         @"glyphs, or other control characters); each paragraph is one line",
         nil);
}

static NSURL *ValidatedLink(NSString *value) {
  NSURL *url = [NSURL URLWithString:value];
  NSString *scheme = url.scheme.lowercaseString;
  NSSet *allowed = [NSSet setWithArray:@[ @"http", @"https", @"mailto", @"tel", @"notes", @"applenotes" ]];
  if (!url || value.length > 4096 || ![allowed containsObject:scheme])
    Fail(@"invalid_request",
         @"Run `link` must be an absolute http, https, mailto, tel, notes, or applenotes URL", nil);
  // The stored link must be the requested string: NSURL percent-encodes
  // spaces and non-ASCII characters, which would make the read-back differ.
  if (![url.absoluteString isEqualToString:value])
    Fail(@"invalid_request",
         @"Run `link` must already be a well-formed URL (percent-encode spaces and non-ASCII characters)",
         nil);
  return url;
}

static id ColorFromHex(NSString *hex) {
  NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"^#[0-9A-Fa-f]{6}$"
                                                                      options:0
                                                                        error:nil];
  if (![hex isKindOfClass:[NSString class]] ||
      [re numberOfMatchesInString:hex options:0 range:NSMakeRange(0, hex.length)] != 1)
    Fail(@"invalid_request", @"Run `color` must be #RRGGBB", nil);
  unsigned int rgb = 0;
  [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
  NSColor *color = [NSColor colorWithSRGBRed:((rgb >> 16) & 0xFF) / 255.0
                                       green:((rgb >> 8) & 0xFF) / 255.0
                                        blue:(rgb & 0xFF) / 255.0
                                       alpha:1.0];
  return (__bridge id)color.CGColor;
}

static NSDictionary *RunAttributes(NSDictionary *run) {
  NSMutableDictionary *attrs = [NSMutableDictionary dictionary];
  unsigned int hints = (ComposeBool(run, @"bold", @"Run") ? 1 : 0) |
                       (ComposeBool(run, @"italic", @"Run") ? 2 : 0);
  if (hints) attrs[kHintsKey] = @(hints);
  if (ComposeBool(run, @"underline", @"Run")) attrs[kUnderlineKey] = @1;
  if (ComposeBool(run, @"strikethrough", @"Run")) attrs[kStrikethroughKey] = @1;
  id link = run[@"link"];
  if (link) {
    if (![link isKindOfClass:[NSString class]]) Fail(@"invalid_request", @"Run `link` must be a string", nil);
    attrs[NSLinkAttributeName] = ValidatedLink(link);
  }
  id highlight = run[@"highlight"];
  if (highlight) {
    NSUInteger code = 0;
    for (size_t i = 0; i < COUNT(kHighlights); i++)
      if ([highlight isKindOfClass:[NSString class]] && [highlight isEqualToString:@(kHighlights[i])])
        code = i + 1;
    if (!code)
      Fail(@"invalid_request", @"Run `highlight` must be purple, pink, orange, mint, or blue", nil);
    attrs[kEmphasisKey] = @(code);
  }
  if (run[@"color"]) attrs[kColorKey] = ColorFromHex(run[@"color"]);
  return attrs;
}

static id ComposeParagraphStyle(const StyleSpec *spec, NSUInteger indent, BOOL blockQuote, id checked) {
  id style = [[objc_getClass("ICTTMutableParagraphStyle") alloc] init];
  if (!style) Fail(@"private_api_unavailable", @"Could not create a paragraph style", nil);
  ((void (*)(id, SEL, unsigned int))objc_msgSend)(style, sel_registerName("setStyle:"), spec->value);
  if (indent)
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(style, sel_registerName("setIndent:"), indent);
  if (blockQuote)
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(style, sel_registerName("setBlockQuoteLevel:"), 1);
  if (checked) {
    id todo = ((id(*)(id, SEL, id, BOOL))objc_msgSend)([objc_getClass("ICTTTodo") alloc],
                                                        sel_registerName("initWithIdentifier:done:"),
                                                        [NSUUID UUID], [checked boolValue]);
    if (!todo) Fail(@"private_api_unavailable", @"Could not create a checklist item", nil);
    ((void (*)(id, SEL, id))objc_msgSend)(style, sel_registerName("setTodo:"), todo);
  }
  return style;
}

// One composed unit: paragraphs joined by "\n". Every paragraph's TTStyle
// covers its text AND its own terminating newline, which is where Notes keeps
// a paragraph's style; the last paragraph's terminator is supplied by the
// placement (or is the end of the note).
typedef struct {
  NSMutableAttributedString *text;
  NSMutableArray<NSValue *> *ranges;  // content range of each paragraph within `text`
  NSMutableArray<NSDictionary *> *styles;  // validated paragraph-style parameters
} ComposedUnit;

#define MAX_TABLE_ROWS 1000
#define MAX_TABLE_COLUMNS 100
#define MAX_TABLE_CELLS 10000
#define MAX_TABLE_CELL_UTF16 10000
#define MAX_COMPOSE_ATTACHMENTS 20
#define MAX_COMPOSE_FILE_BYTES (64LL * 1024 * 1024)
#define MAX_COMPOSE_FILE_TOTAL (128LL * 1024 * 1024)

// A divider or table paragraph: one attachment glyph on its own line.
// Table rows must be rectangular arrays of one-line strings (empty allowed).
// Cell text counts toward the request's UTF-16 budget (`cellUTF16`).
static NSDictionary *ValidateObjectParagraph(NSDictionary *paragraph, NSString *kind) {
  if ([kind isEqualToString:@"divider"]) {
    RequireOnlyKeys(paragraph, @"kind", @"divider paragraph");
    return @{@"kind" : kind};
  }
  RequireOnlyKeys(paragraph, @"kind,rows", @"table paragraph");
  id rows = paragraph[@"rows"];
  if (![rows isKindOfClass:[NSArray class]] || [rows count] == 0 || [rows count] > MAX_TABLE_ROWS)
    Fail(@"invalid_request", @"Table `rows` must be an array of 1 to 1000 rows", nil);
  NSUInteger columns = 0, cellUTF16 = 0;
  for (id row in rows) {
    if (![row isKindOfClass:[NSArray class]] || [row count] == 0 || [row count] > MAX_TABLE_COLUMNS)
      Fail(@"invalid_request", @"Each table row must be an array of 1 to 100 cells", nil);
    if (!columns) columns = [row count];
    if ([row count] != columns) Fail(@"invalid_request", @"Table rows must all have the same number of cells", nil);
    for (id cell in row) {
      if (![cell isKindOfClass:[NSString class]]) Fail(@"invalid_request", @"Table cells must be strings", nil);
      if ([cell length] > MAX_TABLE_CELL_UTF16)
        Fail(@"invalid_request", @"A table cell may hold at most 10000 UTF-16 code units", nil);
      if ([cell length]) ValidateRunText(cell);
      cellUTF16 += [cell length];
    }
  }
  if ([rows count] * columns > MAX_TABLE_CELLS)
    Fail(@"invalid_request", @"A table may have at most 10000 cells", nil);
  return @{@"kind" : kind, @"rows" : rows, @"cellUTF16" : @(cellUTF16)};
}

static NSURL *CardURL(NSString *value);
static void InstallAccountSandbox(NSString *root);

// Fault injection for the copy-store tests (compose_before_save); honored only
// when APPLE_NOTES_MCP_PRIVATE_STORE names a store copy.
static NSString *const kFaultEnv = @"APPLE_NOTES_MCP_WRITER_FAULT";

// The name a file attachment gets, with add-attachment's rules: one path
// component of at most 255 UTF-8 bytes, no slash, colon, backslash, control
// character, leading dot, or surrounding spaces, and the source file's
// extension.
static NSString *ComposeFileName(NSString *source, id requested) {
  if (!requested) return source;
  if (![requested isKindOfClass:[NSString class]] || [requested length] == 0 ||
      [requested lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 255)
    Fail(@"invalid_request", @"File `filename` must be a string of 1 to 255 UTF-8 bytes", nil);
  NSString *name = requested;
  NSMutableCharacterSet *bad = [ForbiddenTextCharacters(NO) mutableCopy];
  [bad addCharactersInString:@"/:\\\t"];
  if ([name hasPrefix:@"."] || [name rangeOfCharacterFromSet:bad].location != NSNotFound ||
      ![name isEqualToString:[name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]])
    Fail(@"invalid_request",
         @"File `filename` must be one path component with no slash, colon, backslash, control character, "
         @"leading dot, or surrounding spaces",
         nil);
  if ([name.pathExtension caseInsensitiveCompare:source.pathExtension] != NSOrderedSame)
    Fail(@"invalid_request", @"File `filename` must keep the source file's extension", nil);
  return name;
}

// A file paragraph names one local file by absolute path. The writer reads it
// once, through a descriptor opened without following a final symbolic link,
// and keeps those bytes: the attachment is created from exactly the bytes it
// hashed, so a file that changes afterwards cannot slip in.
static NSDictionary *ValidateFileParagraph(NSDictionary *paragraph) {
  RequireOnlyKeys(paragraph, @"kind,path,filename", @"file paragraph");
  NSString *path = paragraph[@"path"];
  if (![path isKindOfClass:[NSString class]] || path.length == 0 || path.length > 4096 || ![path isAbsolutePath] ||
      [path rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound)
    Fail(@"invalid_request", @"File `path` must be an absolute path of at most 4096 characters", nil);
  NSString *filename = ComposeFileName(path.lastPathComponent, paragraph[@"filename"]);
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    Fail(@"invalid_request", @"File `path` cannot be opened (missing, unreadable, or a symbolic link)", nil);
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
      info.st_size > MAX_COMPOSE_FILE_BYTES) {
    close(fd);
    Fail(@"invalid_request", @"File `path` must be a nonempty regular file of at most 64 MiB", nil);
  }
  NSMutableData *data = [NSMutableData dataWithCapacity:(NSUInteger)info.st_size];
  char buffer[65536];
  ssize_t n;
  while ((n = read(fd, buffer, sizeof buffer)) > 0) {
    [data appendBytes:buffer length:(NSUInteger)n];
    if ((long long)data.length > info.st_size) break;
  }
  close(fd);
  if (n < 0 || (long long)data.length != info.st_size)
    Fail(@"invalid_request", @"The file changed while it was read; try again", nil);
  // The type Notes records, from Launch Services' reading of the source file;
  // `filename` keeps its extension. An unregistered type becomes generic data.
  NSString *uti = nil;
  [[NSURL fileURLWithPath:path] getResourceValue:&uti forKey:NSURLTypeIdentifierKey error:NULL];
  if (![uti isKindOfClass:[NSString class]] || !uti.length || [uti hasPrefix:@"dyn."]) uti = @"public.data";
  return @{
    @"kind" : @"file",
    @"path" : path,
    @"filename" : filename,
    @"data" : data,
    @"bytes" : @(data.length),
    @"sha256" : SHA256Hex(data),
    @"uti" : uti,
  };
}

// A link-card paragraph: the same URL rules as add_url_card.
static NSDictionary *ValidateCardParagraph(NSDictionary *paragraph) {
  RequireOnlyKeys(paragraph, @"kind,url", @"url paragraph");
  id value = paragraph[@"url"];
  if (![value isKindOfClass:[NSString class]]) Fail(@"invalid_request", @"Card `url` must be a string", nil);
  NSString *url = CardURL(value).absoluteString;
  if (![url isEqualToString:value])
    Fail(@"invalid_request", @"Card `url` must already be a well-formed URL (percent-encode spaces and non-ASCII)",
         nil);
  return @{@"kind" : @"url", @"url" : url};
}

static BOOL IsObjectKind(id kind) {
  return [kind isEqual:@"divider"] || [kind isEqual:@"table"] || [kind isEqual:@"file"] || [kind isEqual:@"url"];
}

// Validates the whole request and builds the text with its inline runs. Pure
// Foundation: nothing here needs NotesShared, so a malformed request fails the
// same way on every macOS. ApplyParagraphStyles adds the private styles.
static ComposedUnit BuildUnit(id paragraphsValue) {
  if (![paragraphsValue isKindOfClass:[NSArray class]] || [paragraphsValue count] == 0)
    Fail(@"invalid_request", @"`paragraphs` must be a non-empty array", nil);
  NSArray *paragraphs = paragraphsValue;
  if (paragraphs.count > MAX_COMPOSE_PARAGRAPHS)
    Fail(@"invalid_request", @"`paragraphs` exceeds 2000 entries", nil);
  ComposedUnit unit = {[NSMutableAttributedString new], [NSMutableArray array], [NSMutableArray array]};
  NSUInteger runCount = 0, cellUTF16 = 0, attachmentCount = 0;
  long long fileBytes = 0;
  for (NSUInteger index = 0; index < paragraphs.count; index++) {
    id value = paragraphs[index];
    if (![value isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", @"Each paragraph must be an object", nil);
    NSDictionary *paragraph = value;
    id kind = paragraph[@"kind"] ?: @"text";
    if (IsObjectKind(kind)) {
      NSDictionary *object;
      if ([kind isEqual:@"file"] || [kind isEqual:@"url"]) {
        if (++attachmentCount > MAX_COMPOSE_ATTACHMENTS)
          Fail(@"invalid_request", @"A compose may hold at most 20 file and link-card paragraphs", nil);
        object = [kind isEqual:@"file"] ? ValidateFileParagraph(paragraph) : ValidateCardParagraph(paragraph);
        fileBytes += [object[@"bytes"] longLongValue];
        if (fileBytes > MAX_COMPOSE_FILE_TOTAL)
          Fail(@"invalid_request", @"The files in one compose may total at most 128 MiB", nil);
      } else {
        object = ValidateObjectParagraph(paragraph, kind);
      }
      cellUTF16 += [object[@"cellUTF16"] unsignedIntegerValue];
      if (unit.text.length + cellUTF16 > MAX_COMPOSE_UTF16)
        Fail(@"invalid_request", @"Composed text and table cells exceed 200000 UTF-16 code units", nil);
      if (unit.text.length) [unit.text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
      [unit.ranges addObject:[NSValue valueWithRange:NSMakeRange(unit.text.length, 1)]];
      // A placeholder glyph; MaterializeObjects gives it a real attachment.
      [unit.text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\uFFFC"]];
      [unit.styles addObject:object];
      continue;
    }
    if (![kind isEqual:@"text"])
      Fail(@"invalid_request", @"Paragraph `kind` must be text, divider, table, file, or url", nil);
    RequireOnlyKeys(paragraph, @"kind,style,indent,blockQuote,checked,runs", @"paragraph");
    id styleName = paragraph[@"style"];
    const StyleSpec *spec = [styleName isKindOfClass:[NSString class]] ? StyleNamed(styleName) : NULL;
    if (!spec)
      Fail(@"invalid_request",
           @"Paragraph `style` must be heading, subheading, body, monospaced, bulleted, dashed, "
           @"numbered, or checklist",
           nil);
    NSUInteger indent = ComposeCount(paragraph, @"indent", 0, MAX_INDENT, 0, @"Paragraph");
    if (indent && !spec->indentable)
      Fail(@"invalid_request", @"Only body, list, and checklist paragraphs take `indent`", nil);
    BOOL blockQuote = ComposeBool(paragraph, @"blockQuote", @"Paragraph");
    id checked = paragraph[@"checked"];
    BOOL isChecklist = spec->value == 103;
    if (isChecklist ? !IsJSONBool(checked) : checked != nil)
      Fail(@"invalid_request", @"`checked` is a required boolean on checklist paragraphs and invalid elsewhere",
           nil);
    // An empty `runs` array is a blank line. The unit's last paragraph must
    // have text: with no terminator of its own, its style needs a character.
    id runs = paragraph[@"runs"];
    if (![runs isKindOfClass:[NSArray class]] || ([runs count] == 0 && index + 1 == paragraphs.count))
      Fail(@"invalid_request", @"Paragraph `runs` must be an array, non-empty on the last paragraph", nil);
    runCount += [runs count];
    if (runCount > MAX_COMPOSE_RUNS) Fail(@"invalid_request", @"Too many runs (max 20000)", nil);

    if (unit.text.length) [unit.text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
    NSUInteger start = unit.text.length;
    for (id runValue in runs) {
      if (![runValue isKindOfClass:[NSDictionary class]]) Fail(@"invalid_request", @"Each run must be an object", nil);
      NSDictionary *run = runValue;
      RequireOnlyKeys(run, @"text,bold,italic,underline,strikethrough,link,highlight,color", @"run");
      NSString *text = run[@"text"];
      if (![text isKindOfClass:[NSString class]] || text.length == 0)
        Fail(@"invalid_request", @"Run `text` must be a non-empty string", nil);
      ValidateRunText(text);
      [unit.text appendAttributedString:[[NSAttributedString alloc] initWithString:text
                                                                       attributes:RunAttributes(run)]];
      if (unit.text.length + cellUTF16 > MAX_COMPOSE_UTF16)
        Fail(@"invalid_request", @"Composed text and table cells exceed 200000 UTF-16 code units", nil);
    }
    [unit.ranges addObject:[NSValue valueWithRange:NSMakeRange(start, unit.text.length - start)]];
    [unit.styles addObject:@{
      @"spec" : [NSValue valueWithPointer:spec],
      @"indent" : @(indent),
      @"blockQuote" : @(blockQuote),
      @"checked" : isChecklist ? checked : [NSNull null],
    }];
  }
  return unit;
}

static void ApplyParagraphStyles(ComposedUnit unit) {
  for (NSUInteger i = 0; i < unit.ranges.count; i++) {
    NSDictionary *p = unit.styles[i];
    // An attachment glyph sits in a plain body paragraph, as Notes writes it.
    id style = p[@"kind"] ? ComposeParagraphStyle(StyleNamed(@"body"), 0, NO, nil)
                          : ComposeParagraphStyle([p[@"spec"] pointerValue], [p[@"indent"] unsignedIntegerValue],
                                              [p[@"blockQuote"] boolValue],
                                              p[@"checked"] == [NSNull null] ? nil : p[@"checked"]);
    NSRange range = unit.ranges[i].rangeValue;
    if (i + 1 < unit.ranges.count) range.length += 1;  // own terminator
    [unit.text addAttribute:kStyleKey value:style range:range];
  }
}

// The attachment glyph Notes uses for block objects: U+FFFC carrying an
// ICTTAttachment that names the attachment's identifier and type.
static void AttachGlyph(NSMutableAttributedString *text, NSRange glyph, id attachment) {
  id tt = [[objc_getClass("ICTTAttachment") alloc] init];
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentIdentifier:"),
                                        [attachment valueForKey:@"identifier"]);
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentUTI:"), Send(attachment, "typeUTI"));
  [text addAttribute:@"NSAttachment" value:tt range:glyph];
}

static id NewTable(NSManagedObject *note, NSArray<NSArray<NSString *> *> *rows) {
  // Notes.app registers the table CRDT type at launch; without it the
  // serialized table has no root type and renders empty.
  SendVoid(objc_getClass("ICTable"), "registerWithICCRCoder");
  // -addTableAttachment saves the note's whole context by itself
  // (-[NSManagedObjectContext ic_saveWithLogDescription:], observed on macOS
  // 27.2), which would commit the table, and every object created before it,
  // ahead of the compose's one guarded save. -addAttachmentWithUTI: creates
  // the same row without saving; the table model builds an empty table.
  id attachment = Send1(note, "addAttachmentWithUTI:", @"com.apple.notes.table");
  id table = Send(Send(attachment, "tableModel"), "table");
  if (!table) Fail(@"materialization_failed", @"NotesShared did not create a table", @{@"committed" : @NO});
  NSUInteger wantRows = rows.count, wantColumns = rows.firstObject.count;
  NSUInteger (*count)(id, SEL) = (NSUInteger(*)(id, SEL))objc_msgSend;
  while (count(table, sel_registerName("rowCount")) < wantRows)
    ((id(*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("insertRowAtIndex:"),
                                               count(table, sel_registerName("rowCount")));
  while (count(table, sel_registerName("rowCount")) > wantRows)
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("removeRowAtIndex:"),
                                                  count(table, sel_registerName("rowCount")) - 1);
  while (count(table, sel_registerName("columnCount")) < wantColumns)
    ((id(*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("insertColumnAtIndex:"),
                                               count(table, sel_registerName("columnCount")));
  while (count(table, sel_registerName("columnCount")) > wantColumns)
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("removeColumnAtIndex:"),
                                                  count(table, sel_registerName("columnCount")) - 1);
  // Every cell is written, empty ones too, so no default content survives.
  for (NSUInteger r = 0; r < wantRows; r++)
    for (NSUInteger c = 0; c < wantColumns; c++)
      ((void (*)(id, SEL, id, NSUInteger, NSUInteger))objc_msgSend)(
          table, sel_registerName("setAttributedString:columnIndex:rowIndex:"),
          [[NSAttributedString alloc] initWithString:rows[r][c]], c, r);
  id model = Send(attachment, "tableModel");
  SendVoid(model, "writeMergeableData");
  SendVoid(model, "regenerateTextContentInNote");
  SendVoid(attachment, "saveMergeableDataIfNeeded");
  return attachment;
}

static id NewDivider(NSManagedObject *note) {
  return ((id(*)(id, SEL, id, id, id))objc_msgSend)(
      objc_getClass("ICInlineAttachment"),
      sel_registerName("newDividerLineAttachmentWithIdentifier:note:parentAttachment:"), NSUUID.UUID.UUIDString, note,
      nil);
}

// Attachments a compose created in this process, in creation order, so a
// failure before the save can remove the media files NotesShared already
// wrote (DiscardComposeObjects).
static NSMutableArray *gComposeCreated = nil;

// A file attachment from the bytes the writer read. NotesShared creates the
// attachment row, its media row, and the media file under the account's
// Media directory; the glyph is placed by the unit.
static id NewComposeFile(NSManagedObject *note, NSDictionary *p) {
  id attachment = ((id(*)(id, SEL, id, id, id))objc_msgSend)(
      note, sel_registerName("addAttachmentWithUTI:data:filename:"), p[@"uti"], p[@"data"], p[@"filename"]);
  if (attachment) [gComposeCreated addObject:attachment];
  return attachment;
}

// A link card, as add_url_card makes it: a public.url attachment row with the
// URL and no glyph of its own. Notes fetches the title and preview later.
static id NewComposeCard(NSManagedObject *note, NSDictionary *p) {
  id attachment = ((id(*)(id, SEL, id))objc_msgSend)(note, sel_registerName("addURLAttachmentWithURL:"),
                                                     [NSURL URLWithString:p[@"url"]]);
  if (attachment) [gComposeCreated addObject:attachment];
  if (attachment && ![[attachment valueForKey:@"typeUTI"] isEqual:@"public.url"])
    Fail(@"materialization_failed", @"NotesShared did not create a public.url attachment", @{@"committed" : @NO});
  return attachment;
}

static id NewComposeObject(NSManagedObject *note, NSDictionary *p) {
  NSString *kind = p[@"kind"];
  if ([kind isEqualToString:@"table"]) return NewTable(note, p[@"rows"]);
  if ([kind isEqualToString:@"file"]) return NewComposeFile(note, p);
  if ([kind isEqualToString:@"url"]) return NewComposeCard(note, p);
  return NewDivider(note);
}

static BOOL UnitHasKind(ComposedUnit unit, NSArray<NSString *> *kinds) {
  for (NSDictionary *p in unit.styles)
    if (p[@"kind"] && [kinds containsObject:p[@"kind"]]) return YES;
  return NO;
}

// Where every attachment file of this store lives: `Accounts/` beside the
// store (the live Notes container, or the copy's directory, where the account
// sandbox points NotesShared on a copy).
static NSString *AttachmentFilesRoot(StoreLocation store) {
  return [[[store.path stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath]
      stringByAppendingPathComponent:@"Accounts"];
}

static BOOL PathIsInside(NSString *path, NSString *root) {
  NSString *resolved = [path stringByResolvingSymlinksInPath];
  return [resolved hasPrefix:[root stringByAppendingString:@"/"]];
}

// The media file of a file attachment, or nil. Never throws.
static NSString *MediaFilePath(NSManagedObject *attachment) {
  @try {
    if (!attachment.entity.relationshipsByName[@"media"]) return nil;
    id media = [attachment valueForKey:@"media"];
    if (!media || ![media respondsToSelector:sel_registerName("mediaURL")]) return nil;
    NSURL *url = Send(media, "mediaURL");
    return [url isKindOfClass:[NSURL class]] && url.isFileURL ? url.path : nil;
  } @catch (NSException *e) {
    return nil;
  }
}

// Size and SHA-256 of a regular file read without following a final link, or
// nil when it cannot be read.
static NSString *FileDigest(NSString *path, long long *sizeOut) {
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return nil;
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    close(fd);
    return nil;
  }
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  char buffer[65536];
  ssize_t n;
  long long total = 0;
  while ((n = read(fd, buffer, sizeof buffer)) > 0) {
    CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
    total += n;
  }
  close(fd);
  if (n < 0) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &ctx);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  if (sizeOut) *sizeOut = total;
  return hex;
}

// Before the save: each new file attachment's media file must sit under the
// store's Accounts directory and hold exactly the bytes the writer read.
static void VerifyNewFilesBeforeSave(ComposedUnit unit, NSArray<NSDictionary *> *created, NSString *filesRoot) {
  NSUInteger next = 0;
  for (NSDictionary *p in unit.styles) {
    if (!p[@"kind"]) continue;
    NSDictionary *object = created[next++];
    if (![p[@"kind"] isEqual:@"file"]) continue;
    NSString *path = MediaFilePath(object[@"attachment"]);
    long long size = -1;
    NSString *digest = path ? FileDigest(path, &size) : nil;
    if (!path || !PathIsInside(path, filesRoot))
      Fail(@"materialization_failed", @"NotesShared did not store the file under the Notes attachment directory",
           @{@"committed" : @NO});
    if (!digest || size != [p[@"bytes"] longLongValue] || ![digest isEqualToString:p[@"sha256"]])
      Fail(@"materialization_failed", @"The stored attachment file does not hold the bytes that were read",
           @{@"committed" : @NO});
  }
}

// Undoes a compose that never reached the store: removes the preview images
// and the media directory NotesShared wrote for each new file attachment
// (only a directory inside `filesRoot` named after the media row), then rolls
// the context back. Never throws.
static void DiscardComposeObjects(NSManagedObjectContext *context, NSString *filesRoot) {
  for (NSManagedObject *attachment in gComposeCreated) {
    @try {
      if ([attachment respondsToSelector:sel_registerName("deleteAttachmentPreviewImages")])
        SendVoid(attachment, "deleteAttachmentPreviewImages");
      NSString *path = MediaFilePath(attachment);
      id media = attachment.entity.relationshipsByName[@"media"] ? [attachment valueForKey:@"media"] : nil;
      NSString *mediaId = media ? [media valueForKey:@"identifier"] : nil;
      if (media && [media respondsToSelector:sel_registerName("deleteExportableMedia")])
        SendVoid(media, "deleteExportableMedia");
      if (!path || !IsUUID(mediaId)) continue;
      // The media directory is the ancestor named after the media row.
      NSString *dir = path;
      while (dir.length > filesRoot.length && ![dir.lastPathComponent isEqualToString:mediaId])
        dir = dir.stringByDeletingLastPathComponent;
      if ([dir.lastPathComponent isEqualToString:mediaId] && PathIsInside(dir, filesRoot))
        [NSFileManager.defaultManager removeItemAtPath:dir error:NULL];
    } @catch (NSException *e) {
      (void)e;
    }
  }
  [gComposeCreated removeAllObjects];
  @try {
    [context rollback];
  } @catch (NSException *e) {
    (void)e;
  }
}

static BOOL UnitHasObjects(ComposedUnit unit) {
  for (NSDictionary *p in unit.styles)
    if (p[@"kind"]) return YES;
  return NO;
}

// Creates each divider and table on the note and points its placeholder glyph
// at it. Runs only on apply, after the revision check; nothing is saved here,
// so a failure leaves the store untouched (the context is discarded).
static NSArray<NSDictionary *> *MaterializeObjects(ComposedUnit unit, NSManagedObject *note) {
  NSMutableArray *created = [NSMutableArray array];
  for (NSUInteger i = 0; i < unit.styles.count; i++) {
    NSDictionary *p = unit.styles[i];
    if (!p[@"kind"]) continue;
    NSUInteger lengthBefore = [BodyText(Send(note, "mergeableString")) length];
    id attachment = nil;
    @try {
      attachment = NewComposeObject(note, p);
    } @catch (HelperError *e) {
      @throw;
    } @catch (NSException *e) {
      Fail(@"materialization_failed", [NSString stringWithFormat:@"Could not create a %@: %@", p[@"kind"], e.reason],
           @{@"committed" : @NO});
    }
    if (!attachment || ![[attachment valueForKey:@"identifier"] isKindOfClass:[NSString class]])
      Fail(@"materialization_failed", [NSString stringWithFormat:@"NotesShared did not create a %@", p[@"kind"]],
           @{@"committed" : @NO});
    // The factories must not place glyphs themselves; the unit places them.
    if ([BodyText(Send(note, "mergeableString")) length] != lengthBefore)
      Fail(@"materialization_failed", @"Creating the object changed the note text", @{@"committed" : @NO});
    ((void (*)(id, SEL, id))objc_msgSend)(attachment, sel_registerName("updateChangeCountWithReason:"),
                                          @"apple-notes-mcp compose_note");
    AttachGlyph(unit.text, unit.ranges[i].rangeValue, attachment);
    NSMutableDictionary *entry = [@{
      @"kind" : p[@"kind"],
      @"identifier" : [attachment valueForKey:@"identifier"],
      @"uti" : OrNull(Send(attachment, "typeUTI")),
      @"attachment" : attachment,
    } mutableCopy];
    if ([p[@"kind"] isEqual:@"file"])
      [entry addEntriesFromDictionary:@{@"filename" : p[@"filename"], @"bytes" : p[@"bytes"], @"sha256" : p[@"sha256"]}];
    if ([p[@"kind"] isEqual:@"url"]) entry[@"url"] = p[@"url"];
    [created addObject:entry];
  }
  return created;
}

// The created objects as the result reports them (without the model objects).
static NSArray<NSDictionary *> *PublicObjects(NSArray<NSDictionary *> *created) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *object in created) {
    NSMutableDictionary *entry = [object mutableCopy];
    [entry removeObjectForKey:@"attachment"];
    [out addObject:entry];
  }
  return out;
}

// What a dry run would create, in body order. Files report the bytes the
// writer read (size and SHA-256), so a caller can check the plan.
static NSArray<NSDictionary *> *PlannedObjects(ComposedUnit unit) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *p in unit.styles) {
    NSString *kind = p[@"kind"];
    if (!kind) continue;
    if ([kind isEqualToString:@"file"])
      [out addObject:@{
        @"kind" : kind,
        @"filename" : p[@"filename"],
        @"bytes" : p[@"bytes"],
        @"sha256" : p[@"sha256"],
        @"uti" : p[@"uti"],
      }];
    else if ([kind isEqualToString:@"url"])
      [out addObject:@{@"kind" : kind, @"url" : p[@"url"]}];
    else if ([kind isEqualToString:@"table"])
      [out addObject:@{@"kind" : kind, @"rows" : @([p[@"rows"] count]), @"columns" : @([[p[@"rows"] firstObject] count])}];
    else
      [out addObject:@{@"kind" : kind}];
  }
  return out;
}

// A persisted file attachment: its media row names the requested file, and
// the media file holds exactly the bytes that were read.
static NSString *VerifyPersistedFile(NSManagedObject *row, NSDictionary *p) {
  id media = [row valueForKey:@"media"];
  if (!media) return @"The file attachment has no media row";
  if (![[media valueForKey:@"filename"] isEqual:p[@"filename"]])
    return @"The file attachment's media row names another file";
  NSString *path = MediaFilePath(row);
  long long size = -1;
  NSString *digest = path ? FileDigest(path, &size) : nil;
  if (!digest || size != [p[@"bytes"] longLongValue] || ![digest isEqualToString:p[@"sha256"]])
    return @"The persisted attachment file does not hold the bytes that were read";
  return nil;
}

// Fresh-context proof that each created object exists, belongs to the note,
// has the created type, and, for tables, holds exactly the requested cells,
// for link cards the URL, and for files the exact bytes.
static NSString *VerifyObjects(NSManagedObjectContext *fresh, ComposedUnit unit, NSArray *created,
                               NSString *noteIdentifier) {
  NSUInteger next = 0;
  for (NSDictionary *p in unit.styles) {
    if (!p[@"kind"]) continue;
    NSDictionary *object = created[next++];
    NSString *entity = [p[@"kind"] isEqual:@"divider"] ? @"ICInlineAttachment" : @"ICAttachment";
    NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:entity];
    request.predicate = [NSPredicate predicateWithFormat:@"identifier == %@", object[@"identifier"]];
    NSArray *rows = [fresh executeFetchRequest:request error:nil];
    if (rows.count != 1) return [NSString stringWithFormat:@"The %@ was not persisted", p[@"kind"]];
    id note = [rows.firstObject valueForKey:@"note"];
    if (![[note valueForKey:@"identifier"] isEqual:noteIdentifier])
      return [NSString stringWithFormat:@"The %@ does not belong to the note", p[@"kind"]];
    if (![[rows.firstObject valueForKey:@"typeUTI"] isEqual:object[@"uti"]])
      return [NSString stringWithFormat:@"The persisted %@ has another type", p[@"kind"]];
    if ([p[@"kind"] isEqual:@"url"] && ![[rows.firstObject valueForKey:@"urlString"] isEqual:p[@"url"]])
      return @"The persisted link card does not carry the requested URL";
    if ([p[@"kind"] isEqual:@"file"]) {
      NSString *detail = VerifyPersistedFile(rows.firstObject, p);
      if (detail) return detail;
    }
    if (![p[@"kind"] isEqual:@"table"]) continue;
    SendVoid(objc_getClass("ICTable"), "registerWithICCRCoder");
    id table = Send(Send(rows.firstObject, "tableModel"), "table");
    NSArray<NSArray<NSString *> *> *want = p[@"rows"];
    NSUInteger (*count)(id, SEL) = (NSUInteger(*)(id, SEL))objc_msgSend;
    if (!table || count(table, sel_registerName("rowCount")) != want.count ||
        count(table, sel_registerName("columnCount")) != want.firstObject.count)
      return @"The persisted table does not have the requested shape";
    for (NSUInteger r = 0; r < want.count; r++)
      for (NSUInteger c = 0; c < want[r].count; c++) {
        id cell = ((id(*)(id, SEL, NSUInteger, NSUInteger))objc_msgSend)(
            table, sel_registerName("stringForColumnIndex:rowIndex:"), c, r);
        NSString *text = [cell isKindOfClass:[NSAttributedString class]] ? [cell string] : cell;
        if (![(text ?: @"") isEqualToString:want[r][c]])
          return @"A persisted table cell differs from the request";
      }
  }
  return nil;
}

#pragma mark Frozen attachments

// Hashing budget for existing attachment files, per fingerprint. Files past
// it are fingerprinted by size and modification time instead.
#define MAX_FROZEN_HASH_BYTES (512LL * 1024 * 1024)

typedef struct {
  NSUInteger attachments, inlineAttachments, filesHashed, filesBySize, filesUnreachable;
} FrozenStats;

// Size and content (or size and modification time, past the budget) of one
// attachment's media file; "none" without media, "unreachable" when the file
// is not on this Mac.
static NSString *FrozenFile(NSManagedObject *attachment, long long *budget, FrozenStats *stats) {
  if (!attachment.entity.relationshipsByName[@"media"] || ![attachment valueForKey:@"media"]) return @"none";
  NSString *path = MediaFilePath(attachment);
  struct stat info;
  if (!path || lstat(path.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode)) {
    stats->filesUnreachable++;
    return @"unreachable";
  }
  if (info.st_size > *budget) {
    stats->filesBySize++;
    return [NSString stringWithFormat:@"size:%lld:mtime:%ld.%09ld", (long long)info.st_size,
                                      (long)info.st_mtimespec.tv_sec, (long)info.st_mtimespec.tv_nsec];
  }
  long long size = 0;
  NSString *digest = FileDigest(path, &size);
  if (!digest) {
    stats->filesUnreachable++;
    return @"unreadable";
  }
  *budget -= size;
  stats->filesHashed++;
  return [NSString stringWithFormat:@"%lld:%@", size, digest];
}

static NSString *const kVersionFloorKey = @"minimumSupportedNotesVersion";

// AttachmentRowDigest's canonical form without the version floor
// (minimumSupportedNotesVersion), which is recorded in `out` under
// "version:<key>" instead. Notes' model raises the floor of every attachment
// of a note, and of each attachment's media row, when new content needs a
// newer Notes: on a store copy (macOS 27.2, 2026-09-24) inserting a divider
// raised existing image rows from 0 or 2 to 6. FrozenDrift accepts a raised
// floor and refuses a lowered one.
static NSString *FrozenRowDigest(NSManagedObject *row, NSString *key, NSMutableDictionary *out) {
  NSMutableArray *parts = [NSMutableArray array];
  NSDictionary *attributes = row.entity.attributesByName;
  for (NSString *name in [attributes.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    NSAttributeDescription *attribute = attributes[name];
    if (attribute.isTransient || attribute.valueTransformerName ||
        attribute.attributeType == NSTransformableAttributeType)
      continue;
    id value = [row valueForKey:name];
    if ([name isEqualToString:kVersionFloorKey]) {
      out[[@"version:" stringByAppendingString:key]] = [value isKindOfClass:[NSNumber class]] ? value : @0;
      continue;
    }
    NSString *canonical;
    if (!value)
      canonical = @"nil";
    else if ([value isKindOfClass:[NSData class]])
      canonical = [@"d:" stringByAppendingString:SHA256Hex(value)];
    else
      canonical = CanonicalValue(value);
    [parts addObject:[NSString stringWithFormat:@"%@=%@", name, canonical]];
  }
  id owner = row.entity.relationshipsByName[@"note"] ? [row valueForKey:@"note"] : nil;
  id ownerIdentifier = owner ? ([owner valueForKey:@"identifier"] ?: @"?") : @"nil";
  [parts addObject:[NSString stringWithFormat:@"note=%@", ownerIdentifier]];
  return SHA256Hex([[parts componentsJoinedByString:@"\x1f"] dataUsingEncoding:NSUTF8StringEncoding]);
}

// One fingerprint per existing attachment of the note: every ICAttachment row
// (identifier, type, payload metadata, mergeable data such as a table's
// cells, owning note; see AttachmentRowDigest), its media row, and its file
// bytes where the file is on this Mac; every inline attachment row (tags,
// mentions, dividers, links); and the order of the attachment glyphs in the
// body. Objects this compose created (`exclude`, lowercased identifiers) are
// left out, so the same call proves before and after that nothing else moved.
static NSDictionary<NSString *, NSString *> *FrozenAttachments(NSManagedObject *note, NSAttributedString *body,
                                                               NSSet<NSString *> *exclude, FrozenStats *stats) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  FrozenStats local = {0, 0, 0, 0, 0};
  long long budget = MAX_FROZEN_HASH_BYTES;
  NSDictionary<NSString *, NSManagedObject *> *rows = AttachmentRows(note);
  for (NSString *key in [rows.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    if ([exclude containsObject:key]) continue;
    NSManagedObject *row = rows[key];
    id media = row.entity.relationshipsByName[@"media"] ? [row valueForKey:@"media"] : nil;
    NSString *rowKey = [@"attachment:" stringByAppendingString:key];
    out[rowKey] = [NSString
        stringWithFormat:@"%@|%@|%@", FrozenRowDigest(row, rowKey, out),
                         media ? FrozenRowDigest(media, [@"media:" stringByAppendingString:key], out) : @"-",
                         FrozenFile(row, &budget, &local)];
    local.attachments++;
  }
  if (note.entity.relationshipsByName[@"inlineAttachments"]) {
    for (NSManagedObject *inlineRow in [note valueForKey:@"inlineAttachments"]) {
      id identifier = [inlineRow valueForKey:@"identifier"];
      NSString *key = [identifier isKindOfClass:[NSString class]] ? [identifier lowercaseString]
                                                                   : inlineRow.objectID.URIRepresentation.absoluteString;
      if ([exclude containsObject:key]) continue;
      NSString *inlineKey = [@"inline:" stringByAppendingString:key];
      out[inlineKey] = FrozenRowDigest(inlineRow, inlineKey, out);
      local.inlineAttachments++;
    }
  }
  NSMutableArray *glyphs = [NSMutableArray array];
  for (NSDictionary *entry in AttachmentGlyphEntries(body)) {
    NSString *identifier = [entry[@"identifier"] lowercaseString];
    if (![exclude containsObject:identifier]) [glyphs addObject:identifier];
  }
  out[@"glyphs"] = [glyphs componentsJoinedByString:@","];
  if (stats) *stats = local;
  return out;
}

// Keys whose fingerprint differs between two FrozenAttachments results. A
// version floor may rise (added to `raised` when given) but not fall.
static NSArray<NSString *> *FrozenDrift(NSDictionary *before, NSDictionary *after, NSMutableArray *raised) {
  NSMutableSet *keys = [NSMutableSet setWithArray:before.allKeys];
  [keys addObjectsFromArray:after.allKeys];
  NSMutableArray *drift = [NSMutableArray array];
  for (NSString *key in keys) {
    if ([before[key] isEqual:after[key]]) continue;
    if ([key hasPrefix:@"version:"] && before[key] && after[key] &&
        [after[key] longLongValue] > [before[key] longLongValue]) {
      [raised addObject:[key substringFromIndex:8]];
      continue;
    }
    [drift addObject:key];
  }
  [raised sortUsingSelector:@selector(compare:)];
  return [drift sortedArrayUsingSelector:@selector(compare:)];
}

static NSDictionary *FrozenReport(FrozenStats stats) {
  return @{
    @"attachments" : @(stats.attachments),
    @"inlineAttachments" : @(stats.inlineAttachments),
    @"filesHashed" : @(stats.filesHashed),
    @"filesBySizeAndDate" : @(stats.filesBySize),
    @"filesNotOnThisMac" : @(stats.filesUnreachable),
  };
}

#pragma mark Read-back signatures

static NSString *ColorHex(id value) {
  NSColor *color = nil;
  if (CFGetTypeID((__bridge CFTypeRef)value) == CGColorGetTypeID())
    color = [NSColor colorWithCGColor:(__bridge CGColorRef)value];
  else if ([value isKindOfClass:[NSColor class]])
    color = value;
  NSColor *srgb = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
  if (!srgb) return [NSString stringWithFormat:@"<%@>", NSStringFromClass([value class])];
  return [NSString stringWithFormat:@"#%02lX%02lX%02lX", lround(srgb.redComponent * 255),
                                    lround(srgb.greenComponent * 255), lround(srgb.blueComponent * 255)];
}

static NSDictionary *RunSignature(NSDictionary *attrs) {
  NSMutableDictionary *sig = [NSMutableDictionary dictionary];
  unsigned int hints = [attrs[kHintsKey] unsignedIntValue];
  if (hints & 1) sig[@"bold"] = @YES;
  if (hints & 2) sig[@"italic"] = @YES;
  if ([attrs[kUnderlineKey] boolValue]) sig[@"underline"] = @YES;
  if ([attrs[kStrikethroughKey] boolValue]) sig[@"strikethrough"] = @YES;
  id link = attrs[NSLinkAttributeName];
  if (link) sig[@"link"] = [link isKindOfClass:[NSURL class]] ? [link absoluteString] : [link description];
  NSUInteger emphasis = [attrs[kEmphasisKey] unsignedIntegerValue];
  if (emphasis >= 1 && emphasis <= COUNT(kHighlights)) sig[@"highlight"] = @(kHighlights[emphasis - 1]);
  else if (emphasis) sig[@"highlight"] = @(emphasis);
  if (attrs[kColorKey]) sig[@"color"] = ColorHex(attrs[kColorKey]);
  id attachment = attrs[@"NSAttachment"];
  if (attachment) {
    BOOL known = [attachment respondsToSelector:sel_registerName("attachmentUTI")] &&
                 [attachment respondsToSelector:sel_registerName("attachmentIdentifier")];
    sig[@"attachment"] = known ? @{
      @"uti" : OrNull(Send(attachment, "attachmentUTI")),
      @"identifier" : OrNull(Send(attachment, "attachmentIdentifier")),
    }
                               : @{@"class" : NSStringFromClass([attachment class])};
  }
  return sig;
}

static NSDictionary *StyleSignature(id style) {
  if (!style) return @{@"style" : @"none"};
  unsigned int value = ((unsigned int (*)(id, SEL))objc_msgSend)(style, sel_registerName("style"));
  NSUInteger indent = ((NSUInteger(*)(id, SEL))objc_msgSend)(style, sel_registerName("indent"));
  NSUInteger quote = ((NSUInteger(*)(id, SEL))objc_msgSend)(style, sel_registerName("blockQuoteLevel"));
  id todo = Send(style, "todo");
  NSMutableDictionary *sig = [@{
    @"style" : StyleName(value),
    @"indent" : @(indent),
    @"blockQuote" : @((BOOL)(quote > 0)),
  } mutableCopy];
  if (todo) sig[@"checked"] = @(SendBool(todo, "done"));
  return sig;
}

// What a paragraph looks like to Notes: its paragraph style (read at its
// first character and, when it has one, at its terminator) and its inline
// runs as {length, attributes}, adjacent equal runs merged.
static NSDictionary *ParagraphSignature(NSAttributedString *string, NSRange content, BOOL hasTerminator) {
  NSMutableDictionary *sig = [StyleSignature([string attribute:kStyleKey
                                                       atIndex:content.location
                                                effectiveRange:NULL]) mutableCopy];
  if (hasTerminator)
    sig[@"terminator"] = StyleSignature([string attribute:kStyleKey
                                                  atIndex:NSMaxRange(content)
                                           effectiveRange:NULL]);
  NSMutableArray *runs = [NSMutableArray array];
  [string enumerateAttributesInRange:content
                             options:0
                          usingBlock:^(NSDictionary *attrs, NSRange range, BOOL *stop) {
                            (void)stop;
                            NSDictionary *run = RunSignature(attrs);
                            NSMutableDictionary *last = runs.lastObject;
                            if (last && [last[@"attributes"] isEqual:run])
                              last[@"length"] = @([last[@"length"] unsignedIntegerValue] + range.length);
                            else
                              [runs addObject:[@{@"length" : @(range.length), @"attributes" : run} mutableCopy]];
                          }];
  sig[@"runs"] = runs;
  sig[@"lengthUTF16"] = @(content.length);
  return sig;
}

static NSArray *UnitSignatures(NSAttributedString *string, NSUInteger offset, NSArray<NSValue *> *ranges,
                               BOOL lastHasTerminator) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSUInteger i = 0; i < ranges.count; i++) {
    NSRange range = ranges[i].rangeValue;
    range.location += offset;
    [out addObject:ParagraphSignature(string, range, i + 1 < ranges.count || lastHasTerminator)];
  }
  return out;
}

#pragma mark Placement

typedef struct {
  NSUInteger index;          // insertion point in the existing body
  NSAttributedString *prefix;  // closes the paragraph before the unit, or nil
  BOOL trailingTerminator;   // the unit needs its own closing newline
  NSUInteger headingIndex;   // for insertBeforeHeading: start of the matched heading
} Placement;

static NSUInteger StyleValueAt(NSAttributedString *string, NSUInteger index) {
  id style = [string attribute:kStyleKey atIndex:index effectiveRange:NULL];
  if (!style || ![style respondsToSelector:sel_registerName("style")]) return 3;
  return ((unsigned int (*)(id, SEL))objc_msgSend)(style, sel_registerName("style"));
}

// A newline carrying the paragraph style found at `index`, which becomes that
// paragraph's terminator.
static NSAttributedString *TerminatorFor(NSAttributedString *string, NSUInteger index) {
  id style = [string attribute:kStyleKey atIndex:index effectiveRange:NULL];
  return [[NSAttributedString alloc] initWithString:@"\n" attributes:style ? @{kStyleKey : style} : @{}];
}

static Placement ResolvePlacement(NSAttributedString *existing, NSString *mode, NSDictionary *beforeHeading) {
  NSString *body = existing.string;
  Placement p = {body.length, nil, NO, NSNotFound};
  if (beforeHeading) {
    NSString *text = beforeHeading[@"text"];
    NSUInteger occurrence = ComposeCount(beforeHeading, @"occurrence", 1, 100000, 1, @"insertBeforeHeading");
    NSUInteger expected = ComposeCount(beforeHeading, @"expectedCount", 1, 100000, 1, @"insertBeforeHeading");
    NSMutableArray<NSNumber *> *matches = [NSMutableArray array];
    [body enumerateSubstringsInRange:NSMakeRange(0, body.length)
                             options:NSStringEnumerationByParagraphs
                          usingBlock:^(NSString *line, NSRange range, NSRange enclosing, BOOL *stop) {
                            (void)enclosing;
                            (void)stop;
                            if (range.length && [line isEqualToString:text] &&
                                StyleValueAt(existing, range.location) == STYLE_HEADING)
                              [matches addObject:@(range.location)];
                          }];
    if (matches.count != expected || occurrence > matches.count)
      Fail(@"selector_conflict",
           [NSString stringWithFormat:@"Found %lu Heading paragraphs equal to the text; expected %lu",
                                      (unsigned long)matches.count, (unsigned long)expected],
           @{@"committed" : @NO, @"matchCount" : @(matches.count)});
    NSUInteger at = matches[occurrence - 1].unsignedIntegerValue;
    if (at == 0)
      Fail(@"selector_conflict", @"Cannot insert above the note's first paragraph (its title)",
           @{@"committed" : @NO});
    p.index = at;
    p.headingIndex = at;
    p.trailingTerminator = YES;
    return p;
  }
  if ([mode isEqualToString:@"prepend"]) {
    NSRange newline = [body rangeOfString:@"\n"];
    if (newline.location != NSNotFound) {
      p.index = newline.location + 1;
      p.trailingTerminator = p.index < body.length;
      return p;
    }
  }
  // Append, or prepend to a title-only note: close the last paragraph first.
  if (body.length && ![body hasSuffix:@"\n"]) p.prefix = TerminatorFor(existing, body.length - 1);
  return p;
}

static NSMutableAttributedString *Insertion(ComposedUnit unit, Placement p) {
  NSMutableAttributedString *insertion = [NSMutableAttributedString new];
  if (p.prefix) [insertion appendAttributedString:p.prefix];
  [insertion appendAttributedString:unit.text];
  if (p.trailingTerminator) [insertion appendAttributedString:TerminatorFor(unit.text, unit.text.length - 1)];
  return insertion;
}

static void RequireNonSystemPaper(NSManagedObject *note) {
  if (!note.entity.propertiesByName[@"isSystemPaper"])
    Fail(@"unsupported_note", @"Cannot determine whether this note is a Quick Note on this macOS",
         @{@"committed" : @NO});
  if ([[note valueForKey:@"isSystemPaper"] boolValue])
    Fail(@"unsupported_note", @"The note is a Quick Note and requireNonSystemPaper is set",
         @{@"committed" : @NO});
}

static NSArray *ReadBackSummary(NSArray *signatures) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *sig in signatures) {
    NSMutableDictionary *entry = [NSMutableDictionary dictionary];
    for (NSString *key in @[ @"style", @"indent", @"blockQuote", @"checked", @"lengthUTF16" ])
      if (sig[key]) entry[key] = sig[key];
    NSMutableArray *runs = [NSMutableArray array];
    for (NSDictionary *run in sig[@"runs"])
      [runs addObject:@{@"length" : run[@"length"], @"attributes" : run[@"attributes"]}];
    entry[@"runs"] = runs;
    [out addObject:entry];
  }
  return out;
}

// Every failure raised before the save reports committed: NO (main() sees
// gWriteRequest without gSaveAttempted), so the client never reports a
// refused compose as indeterminate. Failures from the save on set committed
// themselves.
static NSDictionary *HandleComposeNote(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *mode = RequireString(request, @"mode");
  if (![mode isEqualToString:@"append"] && ![mode isEqualToString:@"prepend"])
    Fail(@"invalid_request", @"`mode` must be append or prepend", nil);
  BOOL dryRun = ComposeBool(request, @"dryRun", @"Request");
  BOOL requireNonSystemPaper = ComposeBool(request, @"requireNonSystemPaper", @"Request");
  NSString *ifRevision = nil;
  if (dryRun) {
    if (request[@"ifRevision"]) Fail(@"invalid_request", @"`dryRun` does not take `ifRevision`", nil);
  } else {
    ifRevision = RequireString(request, @"ifRevision");
  }
  NSDictionary *beforeHeading = request[@"insertBeforeHeading"];
  if (beforeHeading) {
    if (![beforeHeading isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", @"`insertBeforeHeading` must be an object", nil);
    if (![mode isEqualToString:@"append"])
      Fail(@"invalid_request", @"`insertBeforeHeading` is valid only in append mode", nil);
    RequireOnlyKeys(beforeHeading, @"text,occurrence,expectedCount", @"insertBeforeHeading");
    NSString *text = RequireString(beforeHeading, @"text");
    if ([text rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound)
      Fail(@"invalid_request", @"`insertBeforeHeading.text` must be one line", nil);
    ComposeCount(beforeHeading, @"occurrence", 1, 100000, 1, @"insertBeforeHeading");
    ComposeCount(beforeHeading, @"expectedCount", 1, 100000, 1, @"insertBeforeHeading");
  }
  ComposedUnit unit = BuildUnit(request[@"paragraphs"]);
  RequireFeature(FeatureCompose);
  BOOL hasCards = UnitHasKind(unit, @[ @"file", @"url" ]);
  if (hasCards) RequireFeature(FeatureComposeAttachments);
  ApplyParagraphStyles(unit);

  StoreLocation store = ResolveStore();
  // On a copy store every file NotesShared writes (media, previews) goes
  // beside the copy, never into the live container.
  if (store.isCopy && UnitHasKind(unit, @[ @"file" ]))
    InstallAccountSandbox([store.path stringByDeletingLastPathComponent]);
  NSString *filesRoot = AttachmentFilesRoot(store);
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);
  if (requireNonSystemPaper) RequireNonSystemPaper(note);

  NSString *revisionBefore = RevisionToken(note);
  if (!dryRun && ![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  id ms = Send(note, "mergeableString");
  NSAttributedString *existing = ms ? Send(ms, "attributedString") : nil;
  if (![existing isKindOfClass:[NSAttributedString class]])
    Fail(@"unsupported_note", @"The note body could not be loaded as a mergeable string", nil);
  existing = [existing copy];
  // A note's first paragraph is its title. With no body at all, the composed
  // unit would become the title paragraph, so compose refuses instead.
  if (existing.length == 0)
    Fail(@"unsupported_note", @"The note has no title paragraph; compose writes only below the title",
         @{@"committed" : @NO});
  Placement placement = ResolvePlacement(existing, mode, beforeHeading);
  BOOL hasObjects = UnitHasObjects(unit);
  if (hasObjects) {
    NSArray *missing = UnitHasKind(unit, @[ @"divider", @"table" ])
                           ? MissingAPI(kComposeObjectAPI, COUNT(kComposeObjectAPI))
                           : @[];
    if (missing.count)
      Fail(@"private_api_unavailable", @"Dividers and tables need NotesShared API missing on this macOS",
           @{@"missing" : missing, @"committed" : @NO});
    if ([note respondsToSelector:sel_registerName("canAddAttachment")] && !SendBool(note, "canAddAttachment"))
      Fail(@"unsupported_note", @"Notes does not allow attachments in this note", @{@"committed" : @NO});
  }
  // Every attachment the note already has, fingerprinted before anything
  // changes; the same fingerprint is taken again before and after the save.
  FrozenStats frozenStats;
  NSDictionary *frozenBefore = FrozenAttachments(note, existing, [NSSet set], &frozenStats);

  NSArray *created = @[];
  NSMutableAttributedString *insertion = nil;
  NSUInteger unitOffset = placement.prefix ? placement.prefix.length : 0;
  NSArray *expected = nil;
  NSMutableSet *createdKeys = [NSMutableSet set];
  NSMutableDictionary *result = nil;
  gComposeCreated = [NSMutableArray array];
  // Every save of this context before the compose's own one. NotesShared can
  // save by itself (-addTableAttachment did; see NewTable), and anything it
  // saved is committed whatever happens next.
  __block NSUInteger earlySaves = 0;
  id saveObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:NSManagedObjectContextDidSaveNotification
                  object:context
                   queue:nil
              usingBlock:^(NSNotification *note) {
                (void)note;
                if (!gSaveAttempted) earlySaves++;
              }];
  @try {
    // Objects are created only on apply, after the revision check.
    created = (!dryRun && hasObjects) ? MaterializeObjects(unit, note) : @[];
    for (NSDictionary *object in created) [createdKeys addObject:[object[@"identifier"] lowercaseString]];
    insertion = Insertion(unit, placement);
    expected = UnitSignatures(insertion, unitOffset, unit.ranges, placement.trailingTerminator);

    result = [@{
      @"identifier" : identifier,
      @"mode" : mode,
      @"paragraphs" : @(unit.ranges.count),
      @"insertedUTF16" : @(insertion.length),
      @"insertAt" : @(placement.index),
      // UTF-16 offset of the first composed paragraph in the new body (after
      // any separator), so a caller can locate the unit in an independent read.
      @"unitStart" : @(placement.index + unitOffset),
      @"objectURI" : note.objectID.URIRepresentation.absoluteString,
      @"revisionBefore" : revisionBefore,
      @"requiredNonSystemPaper" : @(requireNonSystemPaper),
      @"storeKind" : store.isCopy ? @"copy" : @"live",
      @"frozenAttachments" : FrozenReport(frozenStats),
    } mutableCopy];
    if (beforeHeading) result[@"insertBeforeHeading"] = beforeHeading;
    if (dryRun) {
      [result addEntriesFromDictionary:@{
        @"status" : @"planned",
        @"dryRun" : @YES,
        @"committed" : @NO,
        @"plan" : ReadBackSummary(expected),
        @"objects" : PlannedObjects(unit),
      }];
      [NSNotificationCenter.defaultCenter removeObserver:saveObserver];
      return result;
    }

    SendVoid(ms, "beginEditing");
    ((void (*)(id, SEL, id, NSUInteger))objc_msgSend)(ms, sel_registerName("insertAttributedString:atIndex:"),
                                                      insertion, placement.index);
    SendVoid(ms, "endEditing");
    ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
        note, sel_registerName("edited:range:changeInLength:"),
        NSTextStorageEditedCharacters | NSTextStorageEditedAttributes,
        NSMakeRange(placement.index, insertion.length), (NSInteger)insertion.length);
    ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(note, sel_registerName("regenerateTitle:snippet:"), YES, YES);
    if (!SendBool(note, "saveNoteData"))
      Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
    [note setValue:[NSDate date] forKey:@"modificationDate"];
    ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"),
                                          @"apple-notes-mcp compose_note");

    // Before the save: the new files hold exactly the bytes read, nothing is
    // being deleted, and every existing attachment keeps its fingerprint.
    VerifyNewFilesBeforeSave(unit, created, filesRoot);
    NSArray *drift = context.deletedObjects.count ? @[ @"deleted objects" ] : @[];
    if (!drift.count)
      drift = FrozenDrift(frozenBefore, FrozenAttachments(note, LoadBody(note, NULL), createdKeys, NULL), nil);
    if (drift.count)
      Fail(@"attachment_drift", @"An existing attachment would change; nothing was saved",
           @{@"committed" : @NO, @"attachmentDrift" : drift});
    // Test hook, honored only on a store copy: fail as late as possible
    // before the save, to prove the rollback removes every created file.
    if (store.isCopy &&
        [NSProcessInfo.processInfo.environment[kFaultEnv] isEqualToString:@"compose_before_save"])
      Fail(@"injected_fault", @"Injected failure before the save (copy store only)", @{@"committed" : @NO});

    SaveOrFail(context);
  } @catch (NSException *e) {
    // Nothing reached the store (the save was never tried, or it failed and
    // rolled back): remove the files NotesShared already wrote.
    [NSNotificationCenter.defaultCenter removeObserver:saveObserver];
    BOOL nothingSaved = !gSaveAttempted || ([e isKindOfClass:[HelperError class]] &&
                                            [e.userInfo[@"committed"] isEqual:@NO]);
    // Part of the change was saved before the failure: report it as a
    // committed, indeterminate write and keep every file a saved row names.
    if (earlySaves)
      Fail([e isKindOfClass:[HelperError class]] ? e.userInfo[@"code"] : @"internal_error",
           [NSString stringWithFormat:@"%@ (NotesShared saved part of the change before the failure; read the "
                                      @"note before any retry)",
                                      e.reason ?: e.name],
           @{@"committed" : @YES, @"indeterminate" : @YES, @"earlySaves" : @(earlySaves)});
    if (nothingSaved) DiscardComposeObjects(context, filesRoot);
    @throw;
  }
  [NSNotificationCenter.defaultCenter removeObserver:saveObserver];
  [gComposeCreated removeAllObjects];

  // Fresh read-back through a new coordinator: the full text must equal the
  // old body with the insertion spliced in, every composed paragraph must
  // carry the expected style, checklist state, and inline runs, each created
  // object must be the requested one, and every attachment the note already
  // had must keep its fingerprint.
  NSMutableString *expectedText = [existing.string mutableCopy];
  [expectedText insertString:insertion.string atIndex:placement.index];
  NSDictionary *after = nil;
  NSArray *persisted = nil;
  NSArray *drift = nil;
  NSMutableArray *versionRaised = [NSMutableArray array];
  NSString *verifyDetail = nil;
  BOOL placementVerified = !beforeHeading;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *body = Send(Send(reread, "mergeableString"), "attributedString");
    after = NoteState(reread);
    if (![body isKindOfClass:[NSAttributedString class]] || ![body.string isEqualToString:expectedText]) {
      verifyDetail = @"The persisted body does not equal the previous body with the composed text inserted";
    } else {
      persisted = UnitSignatures(body, placement.index + unitOffset, unit.ranges, placement.trailingTerminator);
      if (![persisted isEqualToArray:expected])
        verifyDetail = @"A composed paragraph's persisted style, checklist state, or runs differ from the request";
      else if (hasObjects)
        verifyDetail = VerifyObjects(fresh, unit, created, identifier);
      if (!verifyDetail) {
        drift = FrozenDrift(frozenBefore, FrozenAttachments(reread, body, createdKeys, NULL), versionRaised);
        if (drift.count) verifyDetail = @"An existing attachment changed during the write";
      }
      if (beforeHeading) {
        NSUInteger headingAt = placement.index + insertion.length;
        NSString *line = nil;
        if (headingAt < body.length) {
          NSRange range = [body.string paragraphRangeForRange:NSMakeRange(headingAt, 0)];
          line = [[body.string substringWithRange:range]
              stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
        }
        placementVerified = line && StyleValueAt(body, headingAt) == STYLE_HEADING &&
                            [line isEqualToString:beforeHeading[@"text"]];
        if (!placementVerified) verifyDetail = @"The heading no longer follows the composed text";
      }
    }
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail) {
    NSMutableDictionary *extra = [@{
      @"committed" : @YES,
      @"indeterminate" : @YES,
      @"revisionBefore" : revisionBefore,
      @"objects" : PublicObjects(created),
    } mutableCopy];
    if (persisted) {
      extra[@"expected"] = ReadBackSummary(expected);
      extra[@"persisted"] = ReadBackSummary(persisted);
    }
    if (drift.count) extra[@"attachmentDrift"] = drift;
    Fail(@"verification_failed", verifyDetail, extra);
  }

  NSMutableDictionary *frozen = [FrozenReport(frozenStats) mutableCopy];
  frozen[@"verified"] = @YES;
  // Rows whose version floor Notes' model raised (see FrozenRowDigest).
  frozen[@"versionFloorRaised"] = versionRaised;
  BOOL hostRunning = NotesAppRunning();
  [result addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"placementVerified" : @(placementVerified),
    @"revisionAfter" : after[@"revision"],
    @"modificationDate" : after[@"modificationDate"],
    @"title" : after[@"title"],
    @"cloudSync" : after[@"cloudSync"],
    @"readBack" : ReadBackSummary(persisted),
    @"objects" : PublicObjects(created),
    @"frozenAttachments" : frozen,
    @"pushScheduled" : @NO,
    @"syncHostRunning" : @(hostRunning),
    @"pushState" : hostRunning ? @"awaiting_notes_app" : @"queued_for_next_launch",
  }];
  return result;
}

#pragma mark - Checklist items


// Checklist identities are the 16 raw bytes of the item's ICTTTodo UUID.
// get-native-objects reports them as 32 lowercase hex digits; the canonical
// dashed UUID spelling is accepted too.
static NSUUID *ParseTodoIdentifier(NSString *value) {
  NSString *hex = [[value stringByReplacingOccurrencesOfString:@"-" withString:@""] lowercaseString];
  if (hex.length != 32 ||
      [hex rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"]
                                       invertedSet]]
              .location != NSNotFound)
    return nil;
  if ([value containsString:@"-"] && !IsUUID(value)) return nil;
  NSString *dashed =
      [NSString stringWithFormat:@"%@-%@-%@-%@-%@", [hex substringWithRange:NSMakeRange(0, 8)],
                                 [hex substringWithRange:NSMakeRange(8, 4)],
                                 [hex substringWithRange:NSMakeRange(12, 4)],
                                 [hex substringWithRange:NSMakeRange(16, 4)],
                                 [hex substringWithRange:NSMakeRange(20, 12)]];
  return [[NSUUID alloc] initWithUUIDString:dashed];
}

static NSString *TodoHex(NSUUID *uuid) {
  uuid_t bytes;
  [uuid getUUIDBytes:bytes];
  NSMutableString *hex = [NSMutableString stringWithCapacity:32];
  for (int i = 0; i < 16; i++) [hex appendFormat:@"%02x", bytes[i]];
  return hex;
}

static NSRange LineAt(NSString *text, NSUInteger index) {
  NSUInteger start = index, end = index;
  while (start > 0 && [text characterAtIndex:start - 1] != '\n') start--;
  while (end < text.length && [text characterAtIndex:end] != '\n') end++;
  return NSMakeRange(start, end - start);
}

static BOOL OnlyNewlines(NSString *text, NSRange range) {
  for (NSUInteger i = range.location; i < NSMaxRange(range); i++)
    if ([text characterAtIndex:i] != '\n') return NO;
  return YES;
}

// Notes stores a checklist item's ICTTTodo (identity and done bit) in the
// TTStyle of the item's characters. Style runs are NOT aligned to lines:
// Notes and the Shortcuts append path can store the newline that ends the
// previous line inside the next item's run. So an item is never inferred from
// line boundaries. It is the exact set of characters whose style carries its
// todo UUID; edits touch only those characters. Its `text` is the line holding
// its first non-newline character, and its `done` comes from that character.
// One entry per todo UUID, in body order. `contiguous` is NO when the UUID
// appears in more than one place; `consistent` is NO when its runs disagree
// on the done bit.
static NSArray<NSDictionary *> *ChecklistItems(NSAttributedString *body) {
  NSString *text = body.string;
  NSMutableArray<NSString *> *order = [NSMutableArray array];
  NSMutableDictionary<NSString *, NSMutableDictionary *> *byHex = [NSMutableDictionary dictionary];
  [body enumerateAttribute:kStyleKey
                   inRange:NSMakeRange(0, body.length)
                   options:0
                usingBlock:^(id style, NSRange run, BOOL *stop) {
                  (void)stop;
                  if (![NSStringFromClass([style class]) containsString:@"ParagraphStyle"]) return;
                  unsigned int value =
                      ((unsigned int (*)(id, SEL))objc_msgSend)(style, sel_registerName("style"));
                  id todo = value == kStyleChecklist ? Send(style, "todo") : nil;
                  NSUUID *uuid = todo ? Send(todo, "uuid") : nil;
                  if (![uuid isKindOfClass:[NSUUID class]]) return;
                  NSString *hex = TodoHex(uuid);
                  NSMutableDictionary *entry = byHex[hex];
                  if (!entry) {
                    entry = [@{@"uuid" : uuid,
                               @"runs" : [NSMutableArray array],
                               @"doneValues" : [NSMutableSet set]} mutableCopy];
                    byHex[hex] = entry;
                    [order addObject:hex];
                  }
                  BOOL done = SendBool(todo, "done");
                  [entry[@"runs"] addObject:@[ [NSValue valueWithRange:run], style ]];
                  [entry[@"doneValues"] addObject:@(done)];
                  if (!entry[@"fallbackDone"]) entry[@"fallbackDone"] = @(done);
                  if (!entry[@"done"] && !OnlyNewlines(text, run)) entry[@"done"] = @(done);
                }];
  NSMutableArray *items = [NSMutableArray array];
  for (NSString *hex in order) {
    NSDictionary *entry = byHex[hex];
    NSArray *runs = entry[@"runs"];
    NSRange first = [runs.firstObject[0] rangeValue], last = [runs.lastObject[0] rangeValue];
    NSRange span = NSMakeRange(first.location, NSMaxRange(last) - first.location);
    NSUInteger covered = 0;
    for (NSArray *run in runs) covered += [run[0] rangeValue].length;
    NSUInteger anchor = span.location;
    while (anchor < NSMaxRange(span) && [text characterAtIndex:anchor] == '\n') anchor++;
    if (anchor == NSMaxRange(span)) anchor = span.location;
    NSRange line = LineAt(text, anchor);
    [items addObject:@{
      @"todoIdentifier" : hex,
      @"uuid" : [entry[@"uuid"] UUIDString],
      @"index" : @(items.count),
      @"done" : entry[@"done"] ?: entry[@"fallbackDone"],
      @"consistent" : @((BOOL)([entry[@"doneValues"] count] == 1)),
      @"contiguous" : @((BOOL)(covered == span.length)),
      @"text" : [text substringWithRange:line],
      @"line" : [NSValue valueWithRange:line],
      @"span" : [NSValue valueWithRange:span],
      @"runs" : runs,
    }];
  }
  return items;
}

// JSON-safe copy of an item (drops the range and style objects).
static NSDictionary *PublicItem(NSDictionary *item) {
  NSRange line = [item[@"line"] rangeValue], span = [item[@"span"] rangeValue];
  return @{
    @"todoIdentifier" : item[@"todoIdentifier"],
    @"uuid" : item[@"uuid"],
    @"index" : item[@"index"],
    @"done" : item[@"done"],
    @"text" : item[@"text"],
    @"lineStart" : @(line.location),
    @"lineLengthUTF16" : @(line.length),
    @"styledStart" : @(span.location),
    @"styledLengthUTF16" : @(span.length),
    @"contiguous" : item[@"contiguous"],
    @"consistent" : item[@"consistent"],
  };
}

// YES when the item's characters, ignoring newlines at either end (a run may
// hold the newline that ends the previous line, and the item's own
// terminator), still contain a line break: two or more lines share one todo
// identity, so a toggle cannot name just one of them.
static BOOL ItemSpansLines(NSString *text, NSDictionary *item) {
  NSRange span = [item[@"span"] rangeValue];
  NSUInteger start = span.location, end = NSMaxRange(span);
  while (start < end && [text characterAtIndex:start] == '\n') start++;
  while (end > start && [text characterAtIndex:end - 1] == '\n') end--;
  return [text rangeOfString:@"\n" options:NSLiteralSearch range:NSMakeRange(start, end - start)].location !=
         NSNotFound;
}

static NSDictionary *ItemWithTodo(NSArray<NSDictionary *> *items, NSString *hex) {
  for (NSDictionary *item in items)
    if ([item[@"todoIdentifier"] isEqualToString:hex]) return item;
  return nil;
}

static NSDictionary *HandleReadChecklist(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  RequireFeature(FeatureChecklist);
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  NSManagedObject *note = FetchNote(context, identifier);
  if (SendBool(note, "isPasswordProtected"))
    Fail(@"unsupported_note", @"Locked notes are not supported", nil);
  NSArray *items = ChecklistItems(LoadBody(note, NULL));
  NSMutableArray *out = [NSMutableArray array];
  NSUInteger checked = 0;
  for (NSDictionary *item in items) {
    [out addObject:PublicItem(item)];
    if ([item[@"done"] boolValue]) checked++;
  }
  return @{
    @"status" : @"ok",
    @"identifier" : identifier,
    @"revision" : RevisionToken(note),
    @"items" : out,
    @"total" : @(items.count),
    @"checked" : @(checked),
    @"syncHostRunning" : @(NotesAppRunning()),
  };
}

static NSDictionary *HandleSetChecklistItem(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *todoValue = RequireString(request, @"todoIdentifier");
  NSUUID *todoUUID = ParseTodoIdentifier(todoValue);
  if (!todoUUID) Fail(@"invalid_request", @"`todoIdentifier` must be 32 hex digits or a UUID", nil);
  NSString *todoHex = TodoHex(todoUUID);
  id doneValue = request[@"done"];
  if (!IsJSONBool(doneValue)) Fail(@"invalid_request", @"`done` must be true or false", nil);
  BOOL done = [doneValue boolValue];
  NSString *ifRevision = RequireString(request, @"ifRevision");
  RequireFeature(FeatureChecklist);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);

  NSString *revisionBefore = RevisionToken(note);
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  id ms = nil;
  NSAttributedString *body = LoadBody(note, &ms);
  if (![ms respondsToSelector:sel_registerName("setAttributes:range:")])
    Fail(@"private_api_unavailable", @"The note body does not support attribute edits",
         @{@"committed" : @NO, @"missing" : @[ @"-[mergeable string setAttributes:range:]" ]});
  NSArray *items = ChecklistItems(body);
  NSDictionary *item = ItemWithTodo(items, todoHex);
  if (!item)
    Fail(@"not_found", @"No checklist item in this note has that todoIdentifier", @{@"committed" : @NO});
  if (![item[@"contiguous"] boolValue])
    Fail(@"ambiguous_target", @"That todoIdentifier appears in more than one place in the note",
         @{@"committed" : @NO});
  if (ItemSpansLines(body.string, item))
    Fail(@"ambiguous_target", @"That todoIdentifier is shared by more than one checklist line",
         @{@"committed" : @NO});
  BOOL previousDone = [item[@"done"] boolValue];

  NSMutableDictionary *result = [@{
    @"identifier" : identifier,
    @"todoIdentifier" : todoHex,
    @"index" : item[@"index"],
    @"done" : @(done),
    @"previousDone" : @(previousDone),
    @"revisionBefore" : revisionBefore,
  } mutableCopy];

  // Already in the requested state on every run: an idempotent no-op that
  // writes nothing.
  if (previousDone == done && [item[@"consistent"] boolValue]) {
    [result addEntriesFromDictionary:@{
      @"status" : @"unchanged",
      @"committed" : @NO,
      @"verified" : @YES,
      @"persistedDone" : @(previousDone),
      @"revisionAfter" : revisionBefore,
    }];
    [result addEntriesFromDictionary:SyncFields(NoteState(note), store)];
    return result;
  }

  // Each run keeps its own paragraph style (indent, alignment, paragraph
  // identity) and gets a todo with the item's identity and the new done bit.
  Class todoClass = objc_getClass("ICTTTodo");
  id todo = ((id(*)(id, SEL, id, BOOL))objc_msgSend)(
      [todoClass alloc], sel_registerName("initWithIdentifier:done:"), todoUUID, done);
  if (!todo) Fail(@"private_api_unavailable", @"Could not build the checklist todo", @{@"committed" : @NO});
  NSMutableArray *edits = [NSMutableArray array];
  for (NSArray *run in item[@"runs"]) {
    id style = [run[1] mutableCopy];
    if (!style)
      Fail(@"private_api_unavailable", @"Could not copy the checklist paragraph style",
           @{@"committed" : @NO});
    ((void (*)(id, SEL, id))objc_msgSend)(style, sel_registerName("setTodo:"), todo);
    [edits addObject:@[ run[0], style ]];
  }

  NSRange span = [item[@"span"] rangeValue];
  NSString *before = [body.string copy];
  SendVoid(ms, "beginEditing");
  for (NSArray *edit in edits)
    MergeAttributes(ms, body, [edit[0] rangeValue], @{kStyleKey : edit[1]}, nil);
  SendVoid(ms, "endEditing");
  FinishAttributeEdit(note, span, @"apple-notes-mcp set_checklist_item");
  SaveOrFail(context);

  // Fresh read-back through a new coordinator: the text is unchanged, the item
  // covers the same characters with the requested done bit everywhere, and
  // every other item kept its identity, position, and state.
  NSDictionary *after = nil;
  NSNumber *persistedDone = nil;
  NSString *verifyDetail = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *persisted = LoadBody(reread, NULL);
    NSArray *freshItems = ChecklistItems(persisted);
    NSDictionary *freshItem = ItemWithTodo(freshItems, todoHex);
    persistedDone = freshItem[@"done"];
    BOOL othersKept = freshItems.count == items.count;
    for (NSUInteger i = 0; othersKept && i < items.count; i++) {
      NSDictionary *a = items[i], *b = freshItems[i];
      othersKept = [a[@"todoIdentifier"] isEqualToString:b[@"todoIdentifier"]] &&
                   NSEqualRanges([a[@"span"] rangeValue], [b[@"span"] rangeValue]) &&
                   ([a[@"todoIdentifier"] isEqualToString:todoHex] || [a[@"done"] isEqual:b[@"done"]]);
    }
    if (![persisted.string isEqualToString:before])
      verifyDetail = @"The persisted note text changed";
    else if (!freshItem || !NSEqualRanges([freshItem[@"span"] rangeValue], span))
      verifyDetail = @"The checklist item no longer covers the same characters";
    else if (![freshItem[@"consistent"] boolValue] || [persistedDone boolValue] != done)
      verifyDetail = @"The persisted done state is not the requested one";
    else if (!othersKept)
      verifyDetail = @"Another checklist item changed";
    after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail || !after)
    Fail(@"verification_failed", verifyDetail ?: @"Read-back failed",
         @{@"committed" : @YES,
           @"revisionBefore" : revisionBefore,
           @"persistedDone" : OrNull(persistedDone)});

  [result addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"persistedDone" : persistedDone,
    @"revisionAfter" : after[@"revision"],
  }];
  [result addEntriesFromDictionary:SyncFields(after, store)];
  return result;
}

#pragma mark - Highlight

// Notes' highlight is the `TTEmphasis` attribute (an NSNumber) on the
// highlighted characters, serialized as AttributeRun field 14. Values follow
// Notes' color order: 1 purple, 2 pink, 3 orange, 4 mint, 5 blue.
#define MAX_MATCH_UTF16 1000
#define MAX_HIGHLIGHT_RANGES 100

// For a dry run that only needed read access: whether the write it plans
// could run here, from the same feature probe `probe` reports.
static NSDictionary *WriteAvailability(Feature feature) {
  NSArray *missing = MissingForFeature(feature);
  return @{@"writeAvailable" : @((BOOL)(missing.count == 0)), @"writeMissing" : missing};
}

static NSNumber *EmphasisForColor(NSString *color) {
  NSDictionary *codes = @{@"purple" : @1, @"pink" : @2, @"orange" : @3, @"mint" : @4, @"blue" : @5};
  return codes[color];
}

static NSString *ColorForEmphasis(id value) {
  if (![value isKindOfClass:[NSNumber class]]) return nil;
  NSArray *names = @[ @"purple", @"pink", @"orange", @"mint", @"blue" ];
  NSInteger code = [value integerValue];
  return code >= 1 && code <= 5 ? names[code - 1]
                                : [NSString stringWithFormat:@"unknown-%ld", (long)code];
}

static void ValidateMatchText(NSString *match) {
  if (match.length > MAX_MATCH_UTF16)
    Fail(@"invalid_request", @"`match` exceeds 1000 UTF-16 code units", nil);
  if ([match rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound)
    Fail(@"invalid_request",
         @"`match` must be text within one paragraph (no newlines, attachment glyphs, or control "
         @"characters)",
         nil);
}

// Every non-overlapping, case-sensitive, literal occurrence of `match`.
static NSArray<NSValue *> *Occurrences(NSString *text, NSString *match) {
  NSMutableArray *found = [NSMutableArray array];
  NSRange search = NSMakeRange(0, text.length);
  while (search.length >= match.length) {
    NSRange hit = [text rangeOfString:match options:NSLiteralSearch range:search];
    if (hit.location == NSNotFound) break;
    [found addObject:[NSValue valueWithRange:hit]];
    NSUInteger next = NSMaxRange(hit);
    search = NSMakeRange(next, text.length - next);
  }
  return found;
}

// The stored emphasis runs inside `range`: [{start, lengthUTF16, color|null}].
static NSArray *EmphasisRuns(NSAttributedString *body, NSRange range) {
  NSMutableArray *runs = [NSMutableArray array];
  [body enumerateAttribute:kEmphasisKey
                   inRange:range
                   options:0
                usingBlock:^(id value, NSRange run, BOOL *stop) {
                  (void)stop;
                  [runs addObject:@{
                    @"start" : @(run.location),
                    @"lengthUTF16" : @(run.length),
                    @"color" : OrNull(ColorForEmphasis(value)),
                  }];
                }];
  return runs;
}

static BOOL RangeHasEmphasis(NSAttributedString *body, NSRange range, NSNumber *code) {
  __block BOOL all = YES;
  [body enumerateAttribute:kEmphasisKey
                   inRange:range
                   options:0
                usingBlock:^(id value, NSRange run, BOOL *stop) {
                  (void)run;
                  if (!(code ? [value isEqual:code] : value == nil)) {
                    all = NO;
                    *stop = YES;
                  }
                }];
  return all;
}

// Emphasis over the whole body as comparable (start, length, value) triples.
static NSArray *EmphasisMap(NSAttributedString *body) {
  NSMutableArray *map = [NSMutableArray array];
  [body enumerateAttribute:kEmphasisKey
                   inRange:NSMakeRange(0, body.length)
                   options:0
                usingBlock:^(id value, NSRange run, BOOL *stop) {
                  (void)stop;
                  [map addObject:@[ @(run.location), @(run.length), value ?: [NSNull null] ]];
                }];
  return map;
}

// The note's derived "has a highlight" flag (ZHASEMPHASIS), when this macOS
// models it. nil when the entity has no such property.
static NSNumber *HasEmphasisFlag(NSManagedObject *note) {
  if (!note.entity.propertiesByName[@"hasEmphasis"]) return nil;
  return @([[note valueForKey:@"hasEmphasis"] boolValue]);
}

// A highlight request names a scope and the ranges it covers:
//   "text"  every exact occurrence of `match`, which must occur exactly
//           `expectedCount` times.
//   "note"  the whole body after the title paragraph, split around
//           attachment glyphs (see NoteScopeRanges). Takes no `match` or
//           `expectedCount`.
// Everything after target selection (plan, no-op check, edit, whole-note
// verification) works on any list of ranges.
typedef struct {
  NSString *scope;
  NSString *match;
  NSUInteger expectedCount;
} HighlightTarget;

static HighlightTarget ParseHighlightTarget(NSDictionary *request) {
  id scope = request[@"scope"] ?: @"text";
  if (![scope isEqual:@"text"] && ![scope isEqual:@"note"])
    Fail(@"invalid_request", @"`scope` must be \"text\" or \"note\"", nil);
  if ([scope isEqual:@"note"]) {
    if (request[@"match"] || request[@"expectedCount"])
      Fail(@"invalid_request", @"`match` and `expectedCount` apply only to scope \"text\"", nil);
    return (HighlightTarget){scope, nil, 0};
  }
  NSString *match = RequireString(request, @"match");
  ValidateMatchText(match);
  id expected = request[@"expectedCount"] ?: @1;
  if (![expected isKindOfClass:[NSNumber class]] || IsJSONBool(expected) ||
      [expected doubleValue] != (double)[expected integerValue] || [expected integerValue] < 1 ||
      [expected integerValue] > MAX_HIGHLIGHT_RANGES)
    Fail(@"invalid_request", @"`expectedCount` must be an integer from 1 to 100", nil);
  return (HighlightTarget){scope, match, [expected unsignedIntegerValue]};
}

// The "note" scope: every character after the title paragraph except
// attachment glyphs (U+FFFC). The title paragraph runs through its first
// newline, so the title's own paragraph mark is untouched too. An attachment
// glyph stands for an object Notes draws itself (image, file, table, drawing,
// or an inline hashtag or mention), and its text, such as table cells, lives
// in the attachment's own model, which this action never opens; highlighting
// the glyph would only rewrite the attachment's run. Paragraph separators
// inside the body are included, the way a select-all highlight in Notes
// applies the attribute across the whole selection. `skipped` reports what was
// left out, including glyphs that already carry a highlight, since those keep
// Notes' hasEmphasis flag set after a removal.
static NSArray<NSValue *> *NoteScopeRanges(NSAttributedString *body, NSDictionary **skipped) {
  NSString *text = body.string;
  NSRange firstBreak = [text rangeOfString:@"\n"];
  NSUInteger start = firstBreak.location == NSNotFound ? text.length : NSMaxRange(firstBreak);
  NSMutableArray<NSValue *> *ranges = [NSMutableArray array];
  NSUInteger glyphs = 0, highlightedGlyphs = 0, runStart = start;
  for (NSUInteger i = start; i <= text.length; i++) {
    BOOL glyph = i < text.length && [text characterAtIndex:i] == 0xFFFC;
    if (i < text.length && !glyph) continue;
    if (i > runStart) [ranges addObject:[NSValue valueWithRange:NSMakeRange(runStart, i - runStart)]];
    runStart = i + 1;
    if (glyph) {
      glyphs++;
      if ([body attribute:kEmphasisKey atIndex:i effectiveRange:NULL]) highlightedGlyphs++;
    }
  }
  *skipped = @{
    @"titleUTF16" : @(start),
    @"attachmentGlyphs" : @(glyphs),
    @"highlightedAttachmentGlyphs" : @(highlightedGlyphs),
  };
  return ranges;
}

static NSArray<NSValue *> *HighlightTargets(HighlightTarget target, NSAttributedString *body,
                                            NSString *revision, NSDictionary **skipped) {
  *skipped = nil;
  if ([target.scope isEqualToString:@"note"]) {
    NSArray<NSValue *> *ranges = NoteScopeRanges(body, skipped);
    if (!ranges.count)
      Fail(@"nothing_to_highlight", @"The note has no text after its title outside attachments",
           @{@"committed" : @NO, @"revision" : revision, @"skipped" : *skipped});
    return ranges;
  }
  NSArray<NSValue *> *ranges = Occurrences(body.string, target.match);
  // A literal hit can start or end inside a composed character (a base letter
  // and its combining mark, an emoji sequence); highlighting it would split
  // what the reader sees as one character.
  NSUInteger splitting = 0;
  for (NSValue *value in ranges)
    if (!NSEqualRanges([body.string rangeOfComposedCharacterSequencesForRange:value.rangeValue], value.rangeValue))
      splitting++;
  if (splitting)
    Fail(@"invalid_request",
         @"`match` starts or ends inside a composed character (such as a letter and its accent); include the "
         @"whole character",
         @{@"committed" : @NO, @"splittingMatches" : @(splitting), @"revision" : revision});
  if (ranges.count != target.expectedCount)
    Fail(@"match_count_mismatch",
         [NSString stringWithFormat:@"`match` occurs %lu times, not the expected %lu",
                                    (unsigned long)ranges.count, (unsigned long)target.expectedCount],
         @{@"committed" : @NO, @"found" : @(ranges.count), @"revision" : revision});
  return ranges;
}

static NSDictionary *HandleSetHighlight(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  HighlightTarget target = ParseHighlightTarget(request);
  NSString *color = RequireString(request, @"color");
  NSNumber *code = nil;
  if (![color isEqualToString:@"none"]) {
    code = EmphasisForColor(color);
    if (!code) Fail(@"invalid_request", @"`color` must be purple, pink, orange, mint, blue, or none", nil);
  }
  id dryRunValue = request[@"dryRun"];
  if (dryRunValue && !IsJSONBool(dryRunValue))
    Fail(@"invalid_request", @"`dryRun` must be true or false", nil);
  BOOL dryRun = [dryRunValue boolValue];
  NSString *ifRevision = nil;
  if (!dryRun || request[@"ifRevision"]) ifRevision = RequireString(request, @"ifRevision");
  RequireFeature(dryRun ? FeatureRead : FeatureHighlight);

  // A dry run opens the store read-only and can never write.
  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);

  NSString *revisionBefore = RevisionToken(note);
  if (ifRevision && ![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  id ms = nil;
  NSAttributedString *body = LoadBody(note, &ms);
  NSDictionary *skipped = nil;
  NSArray<NSValue *> *ranges = HighlightTargets(target, body, revisionBefore, &skipped);

  NSMutableArray *plan = [NSMutableArray array];
  BOOL changes = NO;
  NSUInteger characterCount = 0;
  for (NSValue *value in ranges) {
    NSRange range = value.rangeValue;
    characterCount += range.length;
    BOOL satisfied = RangeHasEmphasis(body, range, code);
    if (!satisfied) changes = YES;
    [plan addObject:@{
      @"start" : @(range.location),
      @"lengthUTF16" : @(range.length),
      @"currentRuns" : EmphasisRuns(body, range),
      @"changes" : @((BOOL)!satisfied),
    }];
  }
  NSMutableDictionary *result = [@{
    @"identifier" : identifier,
    @"scope" : target.scope,
    @"color" : color,
    @"rangeCount" : @(ranges.count),
    @"characterCount" : @(characterCount),
    @"revisionBefore" : revisionBefore,
  } mutableCopy];
  if (skipped) result[@"skipped"] = skipped;

  if (dryRun || !changes) {
    [result addEntriesFromDictionary:@{
      @"status" : dryRun ? @"planned" : @"unchanged",
      @"committed" : @NO,
      @"dryRun" : @(dryRun),
      @"wouldChange" : @(changes),
      @"plan" : plan,
      @"revisionAfter" : revisionBefore,
      @"hasEmphasis" : OrNull(HasEmphasisFlag(note)),
    }];
    if (!dryRun) result[@"verified"] = @YES;
    if (dryRun) [result addEntriesFromDictionary:WriteAvailability(FeatureHighlight)];
    [result addEntriesFromDictionary:SyncFields(NoteState(note), store)];
    return result;
  }

  if (![ms respondsToSelector:sel_registerName("setAttributes:range:")])
    Fail(@"private_api_unavailable", @"The note body does not support attribute edits",
         @{@"committed" : @NO, @"missing" : @[ @"-[mergeable string setAttributes:range:]" ]});

  // The expected result, computed on a detached copy, is what the fresh
  // read-back must match everywhere, not only inside the targeted ranges.
  NSMutableAttributedString *expected = [body mutableCopy];
  NSRange edited = [ranges.firstObject rangeValue];
  SendVoid(ms, "beginEditing");
  for (NSValue *value in ranges) {
    NSRange range = value.rangeValue;
    MergeAttributes(ms, body, range, code ? @{kEmphasisKey : code} : nil,
                    code ? nil : @[ kEmphasisKey ]);
    if (code)
      [expected addAttribute:kEmphasisKey value:code range:range];
    else
      [expected removeAttribute:kEmphasisKey range:range];
    edited = NSUnionRange(edited, range);
  }
  SendVoid(ms, "endEditing");
  FinishAttributeEdit(note, edited, @"apple-notes-mcp set_highlight");
  NSArray *expectedMap = EmphasisMap(expected);
  // saveNoteData refreshes the derived hasEmphasis flag from the body
  // (observed on a store copy, macOS 27.2); the read-back checks it.
  BOOL anyEmphasis = NO;
  for (NSArray *run in expectedMap)
    if (![run[2] isKindOfClass:[NSNull class]]) anyEmphasis = YES;
  NSNumber *expectedFlag = HasEmphasisFlag(note) ? @(anyEmphasis) : nil;
  SaveOrFail(context);

  NSDictionary *after = nil;
  NSMutableArray *stored = [NSMutableArray array];
  NSNumber *persistedFlag = nil;
  NSString *verifyDetail = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *persisted = LoadBody(reread, NULL);
    persistedFlag = HasEmphasisFlag(reread);
    if (![persisted.string isEqualToString:body.string])
      verifyDetail = @"The persisted note text changed";
    else if (![EmphasisMap(persisted) isEqualToArray:expectedMap])
      verifyDetail = @"The persisted highlight runs differ from the requested change";
    else if (expectedFlag && ![persistedFlag isEqual:expectedFlag])
      verifyDetail = @"The note's hasEmphasis flag does not match its stored highlights";
    else
      for (NSValue *value in ranges)
        [stored addObject:@{
          @"start" : @(value.rangeValue.location),
          @"lengthUTF16" : @(value.rangeValue.length),
          @"storedRuns" : EmphasisRuns(persisted, value.rangeValue),
        }];
    after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail || !after)
    Fail(@"verification_failed", verifyDetail ?: @"Read-back failed",
         @{@"committed" : @YES, @"revisionBefore" : revisionBefore});

  [result addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"dryRun" : @NO,
    @"ranges" : stored,
    @"revisionAfter" : after[@"revision"],
    @"hasEmphasis" : OrNull(persistedFlag),
  }];
  [result addEntriesFromDictionary:SyncFields(after, store)];
  return result;
}

#pragma mark - URL link card

#define MAX_URL_UTF16 2048
#define MAX_ANCHOR_UTF16 2000
static const unichar kAttachmentGlyph = 0xFFFC;
static NSString *const kURLCardUTI = @"public.url";

// Only absolute http(s) URLs with a host become cards. Everything else (file,
// data, javascript, notes deep links) is refused.
static NSURL *CardURL(NSString *value) {
  if (value.length > MAX_URL_UTF16)
    Fail(@"invalid_request", @"`url` exceeds 2048 UTF-16 code units", nil);
  if ([value rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound ||
      [value rangeOfCharacterFromSet:[NSCharacterSet whitespaceCharacterSet]].location != NSNotFound)
    Fail(@"invalid_request", @"`url` must not contain whitespace or control characters", nil);
  NSURLComponents *parts = [NSURLComponents componentsWithString:value];
  NSString *scheme = parts.scheme.lowercaseString;
  if (!parts.URL || !([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) ||
      !parts.host.length)
    Fail(@"invalid_request", @"`url` must be an absolute http or https URL with a host", nil);
  return parts.URL;
}

// Where the card goes: its own paragraph right after one paragraph. With no
// anchor that is the end of the note. Returns the insertion index and fills
// `styleSource` with the index whose paragraph style a separating newline
// copies (NSNotFound for none) and `found` with how many paragraphs matched
// the anchor. When the anchor paragraph ends in a newline, the card goes
// after that newline, so the anchor keeps its own terminator and the card
// never inherits its paragraph style (a checklist anchor's todo, for one).
// When the anchor is the last paragraph and has no newline, the index is the
// end of its text and a separator carrying its style is needed, as at the end
// of a note.
static NSUInteger CardInsertionIndex(NSString *text, NSString *anchor, NSUInteger *styleSource,
                                     NSUInteger *found) {
  *styleSource = NSNotFound;
  if (!anchor) {
    *found = 1;
    // A body that already ends in a newline gets the card as its own last
    // paragraph without a separator.
    if (text.length == 0 || [text hasSuffix:@"\n"]) return text.length;
    *styleSource = text.length - 1;
    return text.length;
  }
  NSUInteger start = 0, hits = 0, end = NSNotFound;
  while (start <= text.length) {
    NSRange newline = [text rangeOfString:@"\n"
                                  options:NSLiteralSearch
                                    range:NSMakeRange(start, text.length - start)];
    NSUInteger lineEnd = newline.location == NSNotFound ? text.length : newline.location;
    if ([[text substringWithRange:NSMakeRange(start, lineEnd - start)] isEqualToString:anchor]) {
      hits++;
      end = lineEnd;
    }
    if (newline.location == NSNotFound) break;
    start = lineEnd + 1;
  }
  *found = hits;
  if (hits != 1) return NSNotFound;
  if (end < text.length) return end + 1;  // after the anchor's own newline
  *styleSource = end > 0 && [text characterAtIndex:end - 1] != '\n' ? end - 1 : NSNotFound;
  return end;
}

// The inserted text: an optional newline that carries the previous
// paragraph's style, the card glyph, and an optional terminating newline in
// body style (when text follows the card). A Notes-made card is one U+FFFC
// whose only attribute is the NSAttachment (an ICTTAttachment naming the
// ICAttachment); its paragraph is body text.
static NSAttributedString *CardInsertion(NSAttributedString *body, NSUInteger styleSource,
                                         BOOL separator, BOOL terminator, id ttAttachment) {
  NSMutableAttributedString *insertion = [NSMutableAttributedString new];
  if (separator) {
    NSMutableDictionary *attrs = [NSMutableDictionary dictionary];
    if (styleSource != NSNotFound) {
      id style = [body attribute:@"TTStyle" atIndex:styleSource effectiveRange:NULL];
      if ([NSStringFromClass([style class]) containsString:@"ParagraphStyle"]) attrs[@"TTStyle"] = style;
    }
    [insertion appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"
                                                                      attributes:attrs]];
  }
  NSString *glyph = [NSString stringWithCharacters:&kAttachmentGlyph length:1];
  [insertion appendAttributedString:[[NSAttributedString alloc]
                                        initWithString:glyph
                                            attributes:@{NSAttachmentAttributeName : ttAttachment}]];
  if (terminator) {
    id bodyStyle = [Send(objc_getClass("ICTTParagraphStyle"), "defaultParagraphStyle") mutableCopy];
    [insertion appendAttributedString:[[NSAttributedString alloc]
                                          initWithString:@"\n"
                                              attributes:bodyStyle ? @{@"TTStyle" : bodyStyle} : @{}]];
  }
  return insertion;
}

// The card's line must be plain body text: the glyph and its terminating
// newline (if any) carry no paragraph style, or a body style with no todo.
static BOOL CardLineIsBody(NSAttributedString *text, NSUInteger glyphIndex) {
  NSUInteger last = glyphIndex + 1 < text.length && [text.string characterAtIndex:glyphIndex + 1] == '\n'
                        ? glyphIndex + 1
                        : glyphIndex;
  for (NSUInteger i = glyphIndex; i <= last; i++) {
    id style = [text attribute:@"TTStyle" atIndex:i effectiveRange:NULL];
    if (!style) continue;
    if (StyleValueOf(style) != kStyleBody) return NO;
    if ([style respondsToSelector:sel_registerName("todo")] && Send(style, "todo")) return NO;
  }
  return YES;
}

static NSManagedObject *FetchAttachment(NSManagedObjectContext *context, NSString *identifier) {
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:@"ICAttachment"];
  request.predicate = [NSPredicate predicateWithFormat:@"identifier == %@", identifier];
  request.fetchLimit = 2;
  NSArray *rows = [context executeFetchRequest:request error:nil];
  return rows.count == 1 ? rows.firstObject : nil;
}

static NSDictionary *HandleAddURLCard(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSURL *url = CardURL(RequireString(request, @"url"));
  NSString *anchor = nil;
  if (request[@"afterParagraph"]) {
    anchor = RequireString(request, @"afterParagraph");
    if (anchor.length > MAX_ANCHOR_UTF16 || [anchor containsString:@"\n"])
      Fail(@"invalid_request", @"`afterParagraph` must be one paragraph of at most 2000 UTF-16 units",
           nil);
  }
  id dryRunValue = request[@"dryRun"];
  if (dryRunValue && !IsJSONBool(dryRunValue))
    Fail(@"invalid_request", @"`dryRun` must be true or false", nil);
  BOOL dryRun = [dryRunValue boolValue];
  NSString *ifRevision = nil;
  if (!dryRun || request[@"ifRevision"]) ifRevision = RequireString(request, @"ifRevision");
  RequireFeature(dryRun ? FeatureRead : FeatureLinkCard);

  // A dry run opens the store read-only and can never write.
  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);
  NSString *revisionBefore = RevisionToken(note);
  if (ifRevision && ![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  id ms = nil;
  NSAttributedString *body = LoadBody(note, &ms);
  NSUInteger styleSource = NSNotFound, found = 0;
  NSUInteger at = CardInsertionIndex(body.string, anchor, &styleSource, &found);
  if (at == NSNotFound)
    Fail(@"match_count_mismatch",
         [NSString stringWithFormat:@"`afterParagraph` matches %lu paragraphs, not exactly one",
                                    (unsigned long)found],
         @{@"committed" : @NO, @"found" : @(found), @"revision" : revisionBefore});
  // A separator ends the previous paragraph when the card goes right after
  // its text. After an anchor's own newline none is needed, and the card gets
  // its own body-style terminator when text follows it.
  BOOL separator = at > 0 && [body.string characterAtIndex:at - 1] != '\n';
  BOOL terminator = at < body.length;
  NSUInteger glyphIndex = at + (separator ? 1 : 0);

  NSMutableDictionary *result = [@{
    @"identifier" : identifier,
    @"url" : url.absoluteString,
    @"placement" : anchor ? @"afterParagraph" : @"end",
    @"insertedAtUTF16" : @(at),
    @"glyphIndexUTF16" : @(glyphIndex),
    @"separatorInserted" : @(separator),
    @"terminatorInserted" : @(terminator),
    @"revisionBefore" : revisionBefore,
  } mutableCopy];
  if (dryRun) {
    [result addEntriesFromDictionary:@{
      @"status" : @"planned",
      @"committed" : @NO,
      @"dryRun" : @YES,
      @"revisionAfter" : revisionBefore,
    }];
    [result addEntriesFromDictionary:WriteAvailability(FeatureLinkCard)];
    [result addEntriesFromDictionary:SyncFields(NoteState(note), store)];
    return result;
  }

  // The attachment row. NotesShared creates it with the URL and the
  // public.url type; the card's title and preview image are left for Notes to
  // fetch, so the writer makes no network request.
  id attachment =
      ((id(*)(id, SEL, id))objc_msgSend)(note, sel_registerName("addURLAttachmentWithURL:"), url);
  NSString *attachmentID = [attachment isKindOfClass:[NSManagedObject class]]
                               ? [attachment valueForKey:@"identifier"]
                               : nil;
  NSString *uti = attachmentID ? [attachment valueForKey:@"typeUTI"] : nil;
  if (!attachmentID.length || ![uti isEqualToString:kURLCardUTI]) {
    [context rollback];
    Fail(@"private_api_unavailable", @"NotesShared did not create a public.url attachment",
         @{@"committed" : @NO, @"typeUTI" : OrNull(uti)});
  }
  NSRange placed = ((NSRange(*)(id, SEL, id))objc_msgSend)(
      note, sel_registerName("rangeForAttachment:"), attachment);
  if (placed.location != NSNotFound && placed.length > 0) {
    [context rollback];
    Fail(@"private_api_unavailable", @"NotesShared placed the attachment glyph itself; refusing to guess",
         @{@"committed" : @NO});
  }

  id tt = [objc_getClass("ICTTAttachment") new];
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentIdentifier:"), attachmentID);
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentUTI:"), kURLCardUTI);
  NSAttributedString *insertion = CardInsertion(body, styleSource, separator, terminator, tt);
  NSString *before = [body.string copy];

  SendVoid(ms, "beginEditing");
  ((void (*)(id, SEL, id, NSUInteger))objc_msgSend)(
      ms, sel_registerName("insertAttributedString:atIndex:"), insertion, at);
  SendVoid(ms, "endEditing");
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      note, sel_registerName("edited:range:changeInLength:"), NSTextStorageEditedCharacters,
      NSMakeRange(at, insertion.length), (NSInteger)insertion.length);
  ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(note, sel_registerName("regenerateTitle:snippet:"), YES,
                                                YES);
  if (!SendBool(note, "saveNoteData")) {
    [context rollback];
    Fail(@"save_failed", @"NotesShared did not serialize the edited body", @{@"committed" : @NO});
  }
  [note setValue:[NSDate date] forKey:@"modificationDate"];
  ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"),
                                        @"apple-notes-mcp add_url_card");
  // The attachment is its own cloud object; without its own bump it would not
  // be eligible for upload even when the note is.
  ((void (*)(id, SEL, id))objc_msgSend)(attachment, sel_registerName("updateChangeCountWithReason:"),
                                        @"apple-notes-mcp add_url_card");
  SaveOrFail(context);

  // Fresh read-back: the text is the old text plus the insertion at the
  // expected index, the glyph there names the new attachment, no other glyph
  // does, and the attachment row is a public.url card for this URL on this
  // note.
  NSDictionary *after = nil;
  NSString *verifyDetail = nil;
  NSMutableDictionary *stored = [NSMutableDictionary dictionaryWithObject:attachmentID
                                                                   forKey:@"attachmentIdentifier"];
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *persisted = LoadBody(reread, NULL);
    NSMutableString *expected = [before mutableCopy];
    [expected insertString:insertion.string atIndex:at];
    __block NSUInteger glyphsForAttachment = 0;
    __block NSUInteger glyphAt = NSNotFound;
    [persisted enumerateAttribute:NSAttachmentAttributeName
                          inRange:NSMakeRange(0, persisted.length)
                          options:0
                       usingBlock:^(id value, NSRange run, BOOL *stop) {
                         (void)stop;
                         if (!value || ![value respondsToSelector:sel_registerName("attachmentIdentifier")])
                           return;
                         if ([Send(value, "attachmentIdentifier") isEqual:attachmentID]) {
                           glyphsForAttachment += run.length;
                           glyphAt = run.location;
                         }
                       }];
    NSManagedObject *row = FetchAttachment(fresh, attachmentID);
    stored[@"typeUTI"] = OrNull(row ? [row valueForKey:@"typeUTI"] : nil);
    stored[@"urlString"] = OrNull(row ? [row valueForKey:@"urlString"] : nil);
    stored[@"glyphIndexUTF16"] = glyphAt == NSNotFound ? [NSNull null] : @(glyphAt);
    if (row) stored[@"cloudSync"] = CloudSyncState(row);
    if (![persisted.string isEqualToString:expected])
      verifyDetail = @"The persisted text is not the previous text plus the card glyph";
    else if (glyphsForAttachment != 1 || glyphAt != glyphIndex)
      verifyDetail = @"The card glyph is not present exactly once at the expected position";
    else if (!CardLineIsBody(persisted, glyphAt))
      verifyDetail = @"The card's line does not have the body paragraph style";
    else if (!row || ![[row valueForKey:@"typeUTI"] isEqual:kURLCardUTI])
      verifyDetail = @"The attachment row is missing or is not a public.url attachment";
    else if (![[row valueForKey:@"note"] isEqual:reread])
      verifyDetail = @"The attachment row does not belong to this note";
    else if (![[row valueForKey:@"urlString"] isEqual:url.absoluteString])
      verifyDetail = @"The attachment row does not carry the requested URL";
    after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail || !after)
    Fail(@"verification_failed", verifyDetail ?: @"Read-back failed",
         @{@"committed" : @YES, @"revisionBefore" : revisionBefore, @"attachment" : stored});

  [result addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"dryRun" : @NO,
    @"attachment" : stored,
    @"previewFetched" : @NO,
    @"revisionAfter" : after[@"revision"],
  }];
  [result addEntriesFromDictionary:SyncFields(after, store)];
  return result;
}

#pragma mark - Paragraph identifiers

// Every Notes paragraph style (ICTTParagraphStyle, attribute key TTStyle) can
// carry a UUID, and Notes opens applenotes://showNote?identifier=<note>&
// paragraphID=<uuid> at the paragraph carrying it. Notes copies the UUID when
// a paragraph is split, so body paragraphs often share one. The read-only
// list-note-paragraphs tool (src/utils/noteParagraphs.ts) classifies each
// block's UUID as unique, shared or missing; these functions apply the same
// rules to the live attributed string so a write can mint a UUID of its own
// for one block:
//   - blocks split on "\n" only; a trailing newline adds no empty block;
//   - a block owns its text plus its terminating newline;
//   - its UUID is the one on its first character (the newline when empty);
//   - that UUID is unique when no character of another block carries it.

static NSString *const kParagraphStyleKey = @"TTStyle";
#define EDITED_ATTRIBUTES 1  // NSTextStorageEditedAttributes

static NSUUID *StyleUUID(id style) {
  if (!style || ![style respondsToSelector:sel_registerName("uuid")]) return nil;
  id uuid = Send(style, "uuid");
  return [uuid isKindOfClass:[NSUUID class]] ? uuid : nil;
}

// The paragraph style value (0 title, 1 heading, 2 subheading, 3 body, ...).
// A run without a paragraph style renders as body text, so it counts as 3.
static NSInteger StyleValue(id style) {
  if (!style || ![style respondsToSelector:sel_registerName("style")]) return 3;
  return (NSInteger)((unsigned int (*)(id, SEL))objc_msgSend)(style, sel_registerName("style"));
}

// Text used to compare a caller's expectedText: attachment glyphs removed,
// surrounding whitespace trimmed.
static NSString *ComparableText(NSString *text) {
  NSString *stripped = [text stringByReplacingOccurrencesOfString:@"\uFFFC" withString:@""];
  return [stripped stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

// Blocks in list-note-paragraphs' order and with its ranges, each with its first
// UUID, every UUID any of its characters carries (NSNull for none), and its
// paragraph style value.
static NSArray<NSDictionary *> *NoteBlocks(NSAttributedString *body) {
  NSMutableArray *blocks = [NSMutableArray array];
  NSString *text = body.string;
  NSUInteger length = text.length;
  NSUInteger start = 0;
  while (start < length) {
    NSRange newline = [text rangeOfString:@"\n" options:NSLiteralSearch
                                    range:NSMakeRange(start, length - start)];
    NSUInteger end = newline.location == NSNotFound ? length : newline.location;
    NSRange owned = NSMakeRange(start, MIN(end + 1, length) - start);
    NSMutableSet *uuids = [NSMutableSet set];
    [body enumerateAttribute:kParagraphStyleKey
                     inRange:owned
                     options:0
                  usingBlock:^(id value, NSRange range, BOOL *stop) {
                    (void)range;
                    (void)stop;
                    [uuids addObject:StyleUUID(value) ?: (id)[NSNull null]];
                  }];
    id style = [body attribute:kParagraphStyleKey atIndex:start effectiveRange:NULL];
    NSMutableDictionary *block = [@{
      @"index" : @(blocks.count),
      @"text" : [text substringWithRange:NSMakeRange(start, end - start)],
      @"owned" : [NSValue valueWithRange:owned],
      @"style" : @(StyleValue(style)),
      @"uuids" : uuids,
    } mutableCopy];
    NSUUID *first = StyleUUID(style);
    if (first) block[@"uuid"] = first;
    [blocks addObject:block];
    start = end + 1;
  }
  return blocks;
}

// For each UUID, the indexes of the blocks that carry it anywhere.
static NSDictionary<NSUUID *, NSIndexSet *> *BlocksByUUID(NSArray<NSDictionary *> *blocks) {
  NSMutableDictionary *owners = [NSMutableDictionary dictionary];
  for (NSDictionary *block in blocks)
    for (id uuid in block[@"uuids"]) {
      if (![uuid isKindOfClass:[NSUUID class]]) continue;
      NSMutableIndexSet *set = owners[uuid] ?: [NSMutableIndexSet indexSet];
      [set addIndex:[block[@"index"] unsignedIntegerValue]];
      owners[uuid] = set;
    }
  return owners;
}

// "unique", "shared" or "missing", as list-note-paragraphs reports it.
static NSString *ParagraphIdStatus(NSDictionary *block, NSDictionary *owners) {
  NSUUID *uuid = block[@"uuid"];
  if (!uuid) return @"missing";
  return [owners[uuid] count] == 1 ? @"unique" : @"shared";
}

static NSString *ParagraphLink(NSString *noteIdentifier, NSUUID *uuid) {
  return [NSString stringWithFormat:@"applenotes://showNote?identifier=%@&paragraphID=%@",
                                    noteIdentifier.uppercaseString, uuid.UUIDString];
}

// Gives every run of `owned` a copy of its own paragraph style carrying
// `uuid`. -[ICTTMergeableAttributedString setAttributes:range:] replaces a
// run's whole dictionary, so each run keeps its other attributes (links,
// fonts, attachments) and only TTStyle changes.
static void AssignParagraphUUID(id ms, NSAttributedString *body, NSRange owned, NSUUID *uuid) {
  NSMutableArray *updates = [NSMutableArray array];
  [body enumerateAttributesInRange:owned
                           options:0
                        usingBlock:^(NSDictionary *attrs, NSRange range, BOOL *stop) {
                          (void)stop;
                          id style = attrs[kParagraphStyleKey]
                                         ?: Send(objc_getClass("ICTTParagraphStyle"),
                                                 "defaultParagraphStyle");
                          id copy = [style mutableCopy];
                          ((void (*)(id, SEL, id))objc_msgSend)(copy, sel_registerName("setUuid:"),
                                                                uuid);
                          NSMutableDictionary *merged = [attrs mutableCopy];
                          merged[kParagraphStyleKey] = copy;
                          [updates addObject:@[ merged, [NSValue valueWithRange:range] ]];
                        }];
  SendVoid(ms, "beginEditing");
  for (NSArray *update in updates)
    ((void (*)(id, SEL, id, NSRange))objc_msgSend)(ms, sel_registerName("setAttributes:range:"),
                                                   update[0], [update[1] rangeValue]);
  SendVoid(ms, "endEditing");
}

// True when, at every index of `range`, every attribute other than TTStyle is
// equal in both strings and the paragraph style value is unchanged.
static BOOL SameAttributesExceptParagraphUUID(NSAttributedString *a, NSAttributedString *b,
                                              NSRange range) {
  if (NSMaxRange(range) > a.length || NSMaxRange(range) > b.length) return NO;
  for (NSUInteger i = range.location; i < NSMaxRange(range); i++) {
    NSMutableDictionary *left = [[a attributesAtIndex:i effectiveRange:NULL] mutableCopy];
    NSMutableDictionary *right = [[b attributesAtIndex:i effectiveRange:NULL] mutableCopy];
    if (StyleValue(left[kParagraphStyleKey]) != StyleValue(right[kParagraphStyleKey])) return NO;
    [left removeObjectForKey:kParagraphStyleKey];
    [right removeObjectForKey:kParagraphStyleKey];
    if (![left isEqualToDictionary:right]) return NO;
  }
  return YES;
}

// Every block other than `except` keeps its text and first UUID.
static BOOL OtherBlocksUnchanged(NSArray *before, NSArray *after, NSSet<NSNumber *> *except) {
  if (before.count != after.count) return NO;
  for (NSUInteger i = 0; i < before.count; i++) {
    if ([except containsObject:@(i)]) continue;
    NSDictionary *x = before[i], *y = after[i];
    if (![x[@"text"] isEqualToString:y[@"text"]]) return NO;
    if (!(x[@"uuid"] == y[@"uuid"] || [x[@"uuid"] isEqual:y[@"uuid"]])) return NO;
  }
  return YES;
}

static NSUInteger RequireBlockIndex(NSDictionary *request) {
  id value = request[@"blockIndex"];
  // NSJSONSerialization decodes true/false as the CFBoolean singletons.
  if (![value isKindOfClass:[NSNumber class]] || value == (id)kCFBooleanTrue ||
      value == (id)kCFBooleanFalse || [value doubleValue] < 0 ||
      [value doubleValue] != floor([value doubleValue]) || [value doubleValue] > 1e9)
    Fail(@"invalid_request", @"`blockIndex` must be a non-negative integer", nil);
  return [value unsignedIntegerValue];
}

static NSUUID *OptionalParagraphId(NSDictionary *request) {
  if (!request[@"paragraphId"]) return nil;
  NSString *text = RequireString(request, @"paragraphId");
  if (!IsUUID(text)) Fail(@"invalid_request", @"`paragraphId` must be a UUID", nil);
  return [[NSUUID alloc] initWithUUIDString:text];
}

// The block at `index`, refused unless it is a non-empty paragraph whose text
// still equals `expectedText` (attachment glyphs and outer whitespace aside).
static NSDictionary *ExpectedBlock(NSArray *blocks, NSUInteger index, NSString *expectedText) {
  if (index >= blocks.count)
    Fail(@"paragraph_changed", @"No block has that blockIndex any more", @{@"committed" : @NO});
  NSDictionary *block = blocks[index];
  NSString *text = ComparableText(block[@"text"]);
  if (!text.length)
    Fail(@"invalid_request", @"That block is an empty paragraph; choose one list-note-paragraphs lists",
         @{@"committed" : @NO});
  if (![text isEqualToString:ComparableText(expectedText)])
    Fail(@"paragraph_changed", @"The block at that index no longer has the expected text",
         @{@"committed" : @NO});
  return block;
}

static NSDictionary *HandleSetParagraphId(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *ifRevision = RequireString(request, @"ifRevision");
  NSString *expectedText = RequireString(request, @"expectedText");
  NSUInteger index = RequireBlockIndex(request);
  NSUUID *requested = OptionalParagraphId(request);
  RequireFeature(FeatureParagraphIds);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);
  NSString *revisionBefore = RevisionToken(note);
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  NSAttributedString *body = [LoadBody(note, NULL) copy];
  NSArray *blocks = NoteBlocks(body);
  NSDictionary *owners = BlocksByUUID(blocks);
  NSDictionary *target = ExpectedBlock(blocks, index, expectedText);
  NSString *noteIdentifier = [note valueForKey:@"identifier"];
  NSUUID *previous = target[@"uuid"];
  NSString *previousStatus = ParagraphIdStatus(target, owners);
  NSMutableDictionary *result = [@{
    @"identifier" : noteIdentifier,
    @"blockIndex" : @(index),
    @"text" : target[@"text"],
    @"styleType" : target[@"style"],
    @"previousParagraphId" : previous ? previous.UUIDString : [NSNull null],
    @"previousParagraphIdStatus" : previousStatus,
    @"revisionBefore" : revisionBefore,
  } mutableCopy];

  if ([previousStatus isEqualToString:@"unique"] && (!requested || [requested isEqual:previous])) {
    [result addEntriesFromDictionary:@{
      @"status" : @"unchanged",
      @"changed" : @NO,
      @"committed" : @NO,
      @"paragraphId" : previous.UUIDString,
      @"url" : ParagraphLink(noteIdentifier, previous),
      @"revisionAfter" : revisionBefore,
    }];
    return result;
  }
  if (requested && owners[requested])
    Fail(@"invalid_request", @"`paragraphId` is already used by a paragraph of this note",
         @{@"committed" : @NO});
  NSUUID *uuid = requested ?: [NSUUID UUID];
  NSRange owned = [target[@"owned"] rangeValue];

  id ms = Send(note, "mergeableString");
  AssignParagraphUUID(ms, body, owned, uuid);
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      note, sel_registerName("edited:range:changeInLength:"), EDITED_ATTRIBUTES, owned, 0);
  FinishNoteEdit(note, @"apple-notes-mcp set_paragraph_id", [NSDate date]);
  SaveOrFail(context);

  // Fresh read-back: same text, the block carries the new UUID on every
  // character and no other block carries it, nothing but TTStyle's UUID
  // changed in the block, and every other block kept its first UUID.
  NSString *verifyDetail = nil;
  NSDictionary *after = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSAttributedString *persisted = [LoadBody(reread, NULL) copy];
    NSArray *blocksAfter = NoteBlocks(persisted);
    NSDictionary *ownersAfter = BlocksByUUID(blocksAfter);
    NSDictionary *block = index < blocksAfter.count ? blocksAfter[index] : nil;
    if (![persisted.string isEqualToString:body.string])
      verifyDetail = @"The note text changed";
    else if (![block[@"uuid"] isEqual:uuid] || [block[@"uuids"] count] != 1 ||
             ![ParagraphIdStatus(block, ownersAfter) isEqualToString:@"unique"])
      verifyDetail = @"The paragraph does not carry the new identifier uniquely";
    else if (!SameAttributesExceptParagraphUUID(body, persisted, owned))
      verifyDetail = @"Attributes other than the paragraph identifier changed";
    else if (!OtherBlocksUnchanged(blocks, blocksAfter, [NSSet setWithObject:@(index)]))
      verifyDetail = @"Another paragraph changed";
    else
      after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail)
    Fail(@"verification_failed", verifyDetail, @{@"committed" : @YES, @"revisionBefore" : revisionBefore});
  [result addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"changed" : @YES,
    @"committed" : @YES,
    @"verified" : @YES,
    @"paragraphId" : uuid.UUIDString,
    @"url" : ParagraphLink(noteIdentifier, uuid),
    @"revisionAfter" : after[@"revision"],
    @"modificationDate" : after[@"modificationDate"],
  }];
  [result addEntriesFromDictionary:SyncFields(after, store)];
  return result;
}

#pragma mark - Section-link chips (macOS 27)

// A section link is the chip Notes pastes for "Copy Link to Section": an
// inline attachment (ICInlineAttachment, type
// com.apple.notes.inlinetextattachment.link) whose token is an
// applenotes://showNote?identifier=<note>&paragraphID=<uuid> link, shown in
// the body as one U+FFFC glyph. NotesShared builds the attachment through
// +newParagraphLinkAttachmentWithIdentifier:toNote:paragraphName:paragraphID:
// fromNote:parentAttachment:, which exists from macOS 27. The target
// paragraph must carry a unique paragraph UUID (the rules in
// "Paragraph identifiers"); the writer mints one when it does not.

static BOOL SectionLinkOSSupported(void) {
  return NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27;
}

static NSString *OptionalString(NSDictionary *request, NSString *key) {
  return request[key] ? RequireString(request, key) : nil;
}

static NSString *GlyphAttachmentIdentifier(id value) {
  if (!value || ![value respondsToSelector:sel_registerName("attachmentIdentifier")]) return nil;
  id named = Send(value, "attachmentIdentifier");
  return [named isKindOfClass:[NSString class]] ? named : nil;
}

static NSManagedObject *InlineAttachmentNamed(NSManagedObject *note, NSString *identifier) {
  if (!identifier) return nil;
  for (NSManagedObject *inlineAttachment in [note valueForKey:@"inlineAttachments"]) {
    // A row without a string identifier never matches (messaging nil would
    // compare as NSOrderedSame).
    NSString *candidate = [inlineAttachment valueForKey:@"identifier"];
    if ([candidate isKindOfClass:[NSString class]] &&
        [candidate caseInsensitiveCompare:identifier] == NSOrderedSame)
      return inlineAttachment;
  }
  return nil;
}

static BOOL IsSectionLinkAttachment(id inlineAttachment) {
  return inlineAttachment && ![[inlineAttachment valueForKey:@"markedForDeletion"] boolValue] &&
         SendBool(inlineAttachment, "isParagraphLinkAttachment");
}

// Number of U+FFFC glyphs in the body that name this attachment.
static NSUInteger GlyphCount(NSAttributedString *body, NSString *attachmentIdentifier) {
  __block NSUInteger count = 0;
  if (!body.length) return 0;
  [body enumerateAttribute:kAttachmentKey
                   inRange:NSMakeRange(0, body.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  (void)stop;
                  NSString *named = GlyphAttachmentIdentifier(value);
                  if (!named || [named caseInsensitiveCompare:attachmentIdentifier] != NSOrderedSame)
                    return;
                  for (NSUInteger i = range.location; i < NSMaxRange(range); i++)
                    if ([body.string characterAtIndex:i] == 0xFFFC) count++;
                }];
  return count;
}

// Merges the widened removal ranges of SectionLinkGlyphs into disjoint
// ranges in body order. Two chip lines at the end of a note widen into
// overlapping ranges (the second takes the newline before it), and deleting
// both one after the other would run past the end of the text. A merged
// range that reaches the end and starts a line also takes the newline before
// it, as a single chip there would.
static NSArray<NSValue *> *MergedRemovalRanges(NSArray<NSDictionary *> *entries, NSString *text) {
  NSMutableArray<NSValue *> *sorted = [NSMutableArray array];
  for (NSDictionary *entry in entries) [sorted addObject:entry[@"range"]];
  [sorted sortUsingComparator:^NSComparisonResult(NSValue *a, NSValue *b) {
    return a.rangeValue.location < b.rangeValue.location   ? NSOrderedAscending
           : a.rangeValue.location > b.rangeValue.location ? NSOrderedDescending
                                                           : NSOrderedSame;
  }];
  NSMutableArray<NSValue *> *merged = [NSMutableArray array];
  for (NSValue *value in sorted) {
    NSRange range = value.rangeValue;
    NSRange last = merged.count ? merged.lastObject.rangeValue : NSMakeRange(NSNotFound, 0);
    if (merged.count && range.location <= NSMaxRange(last))
      merged[merged.count - 1] = [NSValue valueWithRange:NSUnionRange(last, range)];
    else
      [merged addObject:value];
  }
  if (merged.count) {
    NSRange tail = merged.lastObject.rangeValue;
    if (NSMaxRange(tail) == text.length && tail.location > 0 && tail.length &&
        [text characterAtIndex:tail.location] != '\n' && [text characterAtIndex:tail.location - 1] == '\n') {
      NSRange widened = NSMakeRange(tail.location - 1, tail.length + 1);
      NSRange before = merged.count > 1 ? merged[merged.count - 2].rangeValue : NSMakeRange(NSNotFound, 0);
      if (merged.count > 1 && widened.location <= NSMaxRange(before)) {
        [merged removeLastObject];
        merged[merged.count - 1] = [NSValue valueWithRange:NSUnionRange(before, widened)];
      } else {
        merged[merged.count - 1] = [NSValue valueWithRange:widened];
      }
    }
  }
  return merged;
}

// Glyphs whose inline attachment is a section link, each widened to its whole
// line when it is alone on that line. Note-link chips share the UTI but are
// not paragraph links, so they are never included.
static NSArray<NSDictionary *> *SectionLinkGlyphs(NSAttributedString *body, NSManagedObject *note) {
  NSMutableArray *found = [NSMutableArray array];
  if (!body.length) return found;
  NSString *text = body.string;
  [body enumerateAttribute:kAttachmentKey
                   inRange:NSMakeRange(0, body.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  (void)stop;
                  NSManagedObject *inlineAttachment =
                      InlineAttachmentNamed(note, GlyphAttachmentIdentifier(value));
                  if (!IsSectionLinkAttachment(inlineAttachment)) return;
                  NSRange remove = range;
                  BOOL startsLine =
                      range.location == 0 || [text characterAtIndex:range.location - 1] == '\n';
                  BOOL endsLine = NSMaxRange(range) == text.length ||
                                  [text characterAtIndex:NSMaxRange(range)] == '\n';
                  if (startsLine && endsLine) {
                    if (NSMaxRange(range) < text.length) {
                      remove.length += 1;
                    } else if (range.location > 0) {
                      remove.location -= 1;
                      remove.length += 1;
                    }
                  }
                  [found addObject:@{
                    @"range" : [NSValue valueWithRange:remove],
                    @"attachment" : inlineAttachment,
                  }];
                }];
  return found;
}

// Index just after the title line and any section chips that directly follow
// it, one per line.
static NSUInteger IndexAfterTitleAndSectionChips(NSAttributedString *body, NSManagedObject *note) {
  NSString *text = body.string;
  NSRange newline = [text rangeOfString:@"\n"];
  NSUInteger index = newline.location == NSNotFound ? text.length : NSMaxRange(newline);
  while (index < text.length && [text characterAtIndex:index] == 0xFFFC) {
    id value = [body attribute:kAttachmentKey atIndex:index effectiveRange:NULL];
    if (!IsSectionLinkAttachment(InlineAttachmentNamed(note, GlyphAttachmentIdentifier(value))))
      break;
    index += 1;
    if (index < text.length && [text characterAtIndex:index] == '\n') index += 1;
  }
  return index;
}

// The target block: by blockIndex (+ expectedText), by a paragraphId that
// is unique in the note, by heading text (title, heading or subheading;
// exact after trimming, case-insensitive), or the first heading or
// subheading.
static NSDictionary *ChooseSectionBlock(NSArray *blocks, NSDictionary *owners,
                                        NSDictionary *request) {
  NSString *paragraphId = OptionalString(request, @"paragraphId");
  NSString *heading = OptionalString(request, @"heading");
  BOOL byIndex = request[@"blockIndex"] != nil;
  if ((paragraphId != nil) + (heading != nil) + byIndex > 1)
    Fail(@"invalid_request", @"Pass at most one of blockIndex, paragraphId, heading", nil);
  if (byIndex) {
    NSString *expectedText = RequireString(request, @"expectedText");
    return ExpectedBlock(blocks, RequireBlockIndex(request), expectedText);
  }
  if (request[@"expectedText"])
    Fail(@"invalid_request", @"`expectedText` goes with blockIndex", nil);
  if (paragraphId) {
    if (!IsUUID(paragraphId)) Fail(@"invalid_request", @"`paragraphId` must be a UUID", nil);
    NSUUID *wanted = [[NSUUID alloc] initWithUUIDString:paragraphId];
    NSIndexSet *holders = owners[wanted];
    if (!holders.count) Fail(@"not_found", @"No paragraph of the target note has that paragraphId", nil);
    NSDictionary *block = blocks[holders.firstIndex];
    if (holders.count > 1 || ![block[@"uuid"] isEqual:wanted])
      Fail(@"ambiguous_paragraph",
           @"That paragraphId is not unique to one paragraph; select the paragraph by blockIndex "
           @"or heading and the writer mints one",
           nil);
    return block;
  }
  NSString *wantedHeading = heading ? ComparableText(heading) : nil;
  NSMutableArray *matches = [NSMutableArray array];
  for (NSDictionary *block in blocks) {
    NSInteger style = [block[@"style"] integerValue];
    NSString *text = ComparableText(block[@"text"]);
    if (!text.length) continue;
    if (!wantedHeading) {
      if (style == 1 || style == 2) return block;
    } else if (style <= 2 && [text caseInsensitiveCompare:wantedHeading] == NSOrderedSame) {
      [matches addObject:block];
    }
  }
  if (!wantedHeading) Fail(@"not_found", @"The target note has no heading or subheading", nil);
  if (!matches.count) Fail(@"not_found", @"No heading of the target note has that text", nil);
  if (matches.count > 1)
    Fail(@"ambiguous_paragraph", @"More than one heading of the target note has that text", nil);
  return matches.firstObject;
}

// The single block whose first UUID is `uuid`, when no other block carries it.
static NSDictionary *UniqueBlockWithUUID(NSArray *blocks, NSUUID *uuid) {
  NSDictionary *owners = BlocksByUUID(blocks);
  NSIndexSet *holders = owners[uuid];
  if (holders.count != 1) return nil;
  NSDictionary *block = blocks[holders.firstIndex];
  return [block[@"uuid"] isEqual:uuid] ? block : nil;
}

static NSDictionary *HandleAddSectionLink(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *targetIdentifier = OptionalString(request, @"target") ?: identifier;
  if (!IsUUID(targetIdentifier)) Fail(@"invalid_request", @"`target` must be a Notes UUID", nil);
  BOOL selfLink = [targetIdentifier caseInsensitiveCompare:identifier] == NSOrderedSame;
  NSString *ifRevision = RequireString(request, @"ifRevision");
  NSString *ifTargetRevision = OptionalString(request, @"ifTargetRevision");
  if (selfLink && ifTargetRevision)
    Fail(@"invalid_request", @"`ifTargetRevision` is only for a link to another note", nil);
  if (!selfLink && !ifTargetRevision)
    Fail(@"invalid_request", @"`ifTargetRevision` is required for a link to another note", nil);
  NSString *position = OptionalString(request, @"position") ?: @"end";
  if (![position isEqualToString:@"end"] && ![position isEqualToString:@"belowTitle"])
    Fail(@"invalid_request", @"`position` must be end or belowTitle", nil);
  BOOL clearExisting = OptionalBool(request, @"clearExistingSectionLinks", NO);
  if (!SectionLinkOSSupported())
    Fail(@"private_api_unavailable", @"Native section-link chips need macOS 27 or later",
         @{@"committed" : @NO});
  RequireFeature(FeatureSectionLinks);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *source = FetchNote(context, identifier);
  RequireAppendableNote(source);
  NSManagedObject *target = selfLink ? source : FetchNote(context, targetIdentifier);
  RequireAppendableNote(target);
  NSString *sourceRevision = RevisionToken(source);
  if (![sourceRevision isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : sourceRevision});
  NSString *targetRevision = selfLink ? sourceRevision : RevisionToken(target);
  if (!selfLink && ![targetRevision isEqualToString:ifTargetRevision])
    Fail(@"revision_conflict", @"The target note changed since ifTargetRevision was read",
         @{@"committed" : @NO, @"currentTargetRevision" : targetRevision});
  NSString *canonicalTarget = [target valueForKey:@"identifier"];

  // 1. The target paragraph, with a unique UUID (minted when needed).
  NSAttributedString *targetBody = [LoadBody(target, NULL) copy];
  NSArray *targetBlocks = NoteBlocks(targetBody);
  NSDictionary *owners = BlocksByUUID(targetBlocks);
  NSDictionary *block = ChooseSectionBlock(targetBlocks, owners, request);
  NSString *previousStatus = ParagraphIdStatus(block, owners);
  BOOL minted = ![previousStatus isEqualToString:@"unique"];
  NSUUID *uuid = minted ? [NSUUID UUID] : block[@"uuid"];
  NSRange targetRange = [block[@"owned"] rangeValue];
  NSString *sectionName = ComparableText(block[@"text"]);
  id targetMs = Send(target, "mergeableString");
  if (minted) {
    AssignParagraphUUID(targetMs, targetBody, targetRange, uuid);
    ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
        target, sel_registerName("edited:range:changeInLength:"), EDITED_ATTRIBUTES, targetRange, 0);
  }

  // 2. The inline attachment, built by NotesShared.
  NSString *inlineId = [NSUUID UUID].UUIDString;
  id inlineAttachment = ((id(*)(id, SEL, id, id, id, id, id, id))objc_msgSend)(
      objc_getClass("ICInlineAttachment"),
      sel_registerName("newParagraphLinkAttachmentWithIdentifier:toNote:paragraphName:paragraphID:"
                       "fromNote:parentAttachment:"),
      inlineId, target, sectionName, uuid, source, nil);
  if (!IsSectionLinkAttachment(inlineAttachment)) {
    [context rollback];
    Fail(@"save_failed", @"NotesShared did not create a paragraph-link attachment; nothing was saved",
         @{@"committed" : @NO});
  }
  if (![[inlineAttachment valueForKey:@"note"] isEqual:source])
    ((void (*)(id, SEL, id))objc_msgSend)(source, sel_registerName("addInlineAttachmentsObject:"),
                                          inlineAttachment);
  NSString *token = [inlineAttachment valueForKey:@"tokenContentIdentifier"];
  NSString *typeUTI = [inlineAttachment valueForKey:@"typeUTI"];

  // 3. The source body: optionally drop existing section chips, then insert
  //    the new glyph at the end or below the title. Loaded after step 1, so a
  //    link within the note sees the minted identifier.
  id sourceMs = Send(source, "mergeableString");
  NSAttributedString *sourceBefore = [LoadBody(source, NULL) copy];
  NSMutableAttributedString *expected = [sourceBefore mutableCopy];
  NSArray *cleared = clearExisting ? SectionLinkGlyphs(sourceBefore, source) : @[];
  NSArray<NSValue *> *removals = MergedRemovalRanges(cleared, sourceBefore.string);
  SendVoid(sourceMs, "beginEditing");
  for (NSValue *value in removals.reverseObjectEnumerator) {
    NSRange range = value.rangeValue;
    ((void (*)(id, SEL, NSRange, id))objc_msgSend)(
        sourceMs, sel_registerName("replaceCharactersInRange:withAttributedString:"), range,
        [[NSAttributedString alloc] initWithString:@""]);
    [expected deleteCharactersInRange:range];
  }
  for (NSDictionary *entry in cleared) SendVoid(entry[@"attachment"], "markForDeletion");

  id glyphAttachment = [[objc_getClass("ICTTAttachment") alloc] init];
  ((void (*)(id, SEL, id))objc_msgSend)(glyphAttachment, sel_registerName("setAttachmentIdentifier:"),
                                        inlineId);
  ((void (*)(id, SEL, id))objc_msgSend)(glyphAttachment, sel_registerName("setAttachmentUTI:"),
                                        typeUTI);
  id bodyStyle = [Send(objc_getClass("ICTTParagraphStyle"), "defaultParagraphStyle") mutableCopy];
  NSDictionary *bodyAttrs = @{kParagraphStyleKey : bodyStyle};
  NSMutableDictionary *glyphAttrs = [bodyAttrs mutableCopy];
  glyphAttrs[kAttachmentKey] = glyphAttachment;
  NSAttributedString *glyph = [[NSAttributedString alloc] initWithString:@"\uFFFC"
                                                              attributes:glyphAttrs];
  NSMutableAttributedString *insertion = [NSMutableAttributedString new];
  NSUInteger at;
  if ([position isEqualToString:@"belowTitle"]) {
    at = IndexAfterTitleAndSectionChips(expected, source);
    if (at == expected.length && expected.length && ![expected.string hasSuffix:@"\n"]) {
      // The separator ends the old last paragraph, so it keeps only that
      // paragraph's style: never the last character's other attributes,
      // which on a chip line include its NSAttachment.
      id lastStyle = [expected attribute:kParagraphStyleKey
                                 atIndex:expected.length - 1
                          effectiveRange:NULL];
      [insertion
          appendAttributedString:[[NSAttributedString alloc]
                                     initWithString:@"\n"
                                         attributes:lastStyle ? @{kParagraphStyleKey : lastStyle}
                                                              : @{}]];
    }
    [insertion appendAttributedString:glyph];
    [insertion appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"
                                                                      attributes:bodyAttrs]];
  } else {
    at = expected.length;
    if (expected.length && ![expected.string hasSuffix:@"\n"]) {
      // The separator ends the old last paragraph, so it keeps that style.
      id lastStyle = [expected attribute:kParagraphStyleKey
                                 atIndex:expected.length - 1
                          effectiveRange:NULL];
      [insertion
          appendAttributedString:[[NSAttributedString alloc]
                                     initWithString:@"\n"
                                         attributes:lastStyle ? @{kParagraphStyleKey : lastStyle}
                                                              : @{}]];
    }
    [insertion appendAttributedString:glyph];
  }
  ((void (*)(id, SEL, id, NSUInteger))objc_msgSend)(
      sourceMs, sel_registerName("insertAttributedString:atIndex:"), insertion, at);
  [expected insertAttributedString:insertion atIndex:at];
  SendVoid(sourceMs, "endEditing");
  NSInteger delta = (NSInteger)expected.length - (NSInteger)sourceBefore.length;
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      source, sel_registerName("edited:range:changeInLength:"),
      EDITED_ATTRIBUTES | NSTextStorageEditedCharacters, NSMakeRange(0, expected.length), delta);
  ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(source, sel_registerName("regenerateTitle:snippet:"),
                                                YES, YES);

  // 4. Serialize, mark for upload, and save once.
  NSDate *now = [NSDate date];
  @try {
    FinishNoteEdit(source, @"apple-notes-mcp add_section_link", now);
    if (!selfLink && minted) FinishNoteEdit(target, @"apple-notes-mcp add_section_link", now);
  } @catch (NSException *e) {
    // Nothing is saved yet: undo the in-memory edit and report the refusal.
    [context rollback];
    @throw;
  }
  ((void (*)(id, SEL, id))objc_msgSend)(
      inlineAttachment, sel_registerName("updateChangeCountWithReason:"),
      @"apple-notes-mcp add_section_link");
  SaveOrFail(context);

  // 5. Fresh read-back of both notes and the attachment.
  NSString *link = ParagraphLink(canonicalTarget, uuid);
  NSString *verifyDetail = nil;
  NSDictionary *sourceAfter = nil;
  NSDictionary *targetAfter = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *freshSource = FetchNote(fresh, identifier);
    NSManagedObject *freshTarget = selfLink ? freshSource : FetchNote(fresh, targetIdentifier);
    NSAttributedString *sourceText = [LoadBody(freshSource, NULL) copy];
    NSAttributedString *targetText = selfLink ? sourceText : [LoadBody(freshTarget, NULL) copy];
    NSArray *targetBlocksAfter = NoteBlocks(targetText);
    NSDictionary *blockAfter = UniqueBlockWithUUID(targetBlocksAfter, uuid);
    NSManagedObject *inlineAfter = InlineAttachmentNamed(freshSource, inlineId);
    NSString *tokenAfter = [inlineAfter valueForKey:@"tokenContentIdentifier"];
    BOOL clearedGone = YES;
    for (NSDictionary *entry in cleared) {
      NSManagedObject *old =
          InlineAttachmentNamed(freshSource, [entry[@"attachment"] valueForKey:@"identifier"]);
      if (old && ![[old valueForKey:@"markedForDeletion"] boolValue]) clearedGone = NO;
    }
    if (![sourceText.string isEqualToString:expected.string])
      verifyDetail = @"The source note text is not the planned text";
    else if (GlyphCount(sourceText, inlineId) != 1)
      verifyDetail = @"The section-link glyph is not present exactly once";
    else if (!IsSectionLinkAttachment(inlineAfter))
      verifyDetail = @"The section-link attachment was not persisted";
    else if (![tokenAfter isKindOfClass:[NSString class]] ||
             [tokenAfter rangeOfString:uuid.UUIDString options:NSCaseInsensitiveSearch].location ==
                 NSNotFound ||
             [tokenAfter rangeOfString:canonicalTarget options:NSCaseInsensitiveSearch].location ==
                 NSNotFound)
      verifyDetail = @"The section link does not point at the target paragraph";
    else if (!blockAfter || ![ComparableText(blockAfter[@"text"]) isEqualToString:sectionName])
      verifyDetail = @"The target paragraph does not carry the link's identifier uniquely";
    else if (!selfLink && ![targetText.string isEqualToString:targetBody.string])
      verifyDetail = @"The target note text changed";
    else if (!selfLink && minted &&
             !OtherBlocksUnchanged(targetBlocks, targetBlocksAfter,
                                   [NSSet setWithObject:block[@"index"]]))
      verifyDetail = @"Another paragraph of the target note changed";
    else if (!clearedGone)
      verifyDetail = @"A cleared section link is still active";
    else {
      sourceAfter = NoteState(freshSource);
      targetAfter = selfLink ? sourceAfter : NoteState(freshTarget);
    }
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail)
    Fail(@"verification_failed", verifyDetail,
         @{@"committed" : @YES, @"revisionBefore" : sourceRevision});
  NSMutableDictionary *result = [@{
    @"status" : @"updated",
    @"committed" : @YES,
    @"verified" : @YES,
    @"identifier" : [source valueForKey:@"identifier"],
    @"target" : canonicalTarget,
    @"selfLink" : @(selfLink),
    @"section" : sectionName,
    @"targetStyleType" : block[@"style"],
    @"paragraphId" : uuid.UUIDString,
    @"previousParagraphIdStatus" : previousStatus,
    @"paragraphIdMinted" : @(minted),
    @"url" : link,
    @"token" : OrNull(token),
    @"inlineAttachmentIdentifier" : inlineId,
    @"position" : position,
    @"clearedSectionLinks" : @(cleared.count),
    @"revisionBefore" : sourceRevision,
    @"revisionAfter" : sourceAfter[@"revision"],
    @"modificationDate" : sourceAfter[@"modificationDate"],
  } mutableCopy];
  [result addEntriesFromDictionary:SyncFields(sourceAfter, store)];
  if (!selfLink) {
    result[@"targetRevisionBefore"] = targetRevision;
    result[@"targetRevisionAfter"] = targetAfter[@"revision"];
    result[@"targetCloudSync"] = targetAfter[@"cloudSync"];
  }
  return result;
}

#pragma mark - Tables

// Notes tables are attachments (UTI com.apple.notes.table) whose content is a
// CRDT document in ICAttachment.mergeableData. The body holds one U+FFFC glyph
// per visible table, carrying an ICTTAttachment that names the attachment.
// Rows and columns have stable native identifiers, so every row and cell
// action selects by identifier, never by position alone.
//
// Table writes carry two compare-and-swap tokens: `ifRevision` (the note's
// r1: revision, which covers the body) and `ifTableDigest` (a t1: digest of
// the table attachment's serialized CRDT document). Row deletion and orphan
// pruning are two-phase: a dry run opens the store read-only and returns the
// plan with both tokens; the apply must present them unchanged.

static NSString *const kTableUTI = @"com.apple.notes.table";
#define MAX_TABLE_DIMENSION 1000
#define MAX_TABLE_CELLS 10000
#define MAX_CELL_UTF16 10000

static void RegisterTableCoder(void) {
  // A headless process must register ICTable with the CRDT coder before it
  // opens a table document; Notes.app does this during its own launch.
  static BOOL registered = NO;
  if (registered) return;
  registered = YES;
  SendVoid(objc_getClass("ICTable"), "registerWithICCRCoder");
}

// Row and column identities are CRDT objects; their UUID is the stable,
// serializable part.
static NSString *IdentityText(id value) {
  if ([value isKindOfClass:[NSString class]] && [value length]) return [value uppercaseString];
  if ([value isKindOfClass:[NSUUID class]]) return [value UUIDString];
  return nil;
}

// Always an immutable copy: `-[NSAttributedString string]` on a mutable
// backing store is a live view, and a snapshot must not change when the table
// is edited afterwards.
static NSString *TextOf(id value) {
  if ([value isKindOfClass:[NSAttributedString class]]) return [[value string] copy];
  if ([value isKindOfClass:[NSString class]]) return [value copy];
  if (value && [value respondsToSelector:sel_registerName("attributedString")]) {
    id attributed = Send(value, "attributedString");
    if ([attributed isKindOfClass:[NSAttributedString class]]) return [[attributed string] copy];
  }
  return @"";
}

static NSAttributedString *BodyAttributedString(NSManagedObject *note) {
  id ms = Send(note, "mergeableString");
  id attributed = ms ? Send(ms, "attributedString") : nil;
  return [attributed isKindOfClass:[NSAttributedString class]] ? attributed : nil;
}

// Number of U+FFFC glyphs in the body that name this attachment.
static NSUInteger GlyphCountFor(NSAttributedString *body, NSString *attachmentIdentifier) {
  __block NSUInteger count = 0;
  if (!body.length) return 0;
  SEL identifierSel = sel_registerName("attachmentIdentifier");
  [body enumerateAttribute:@"NSAttachment"
                   inRange:NSMakeRange(0, body.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  (void)stop;
                  if (!value || ![value respondsToSelector:identifierSel]) return;
                  id named = Send(value, "attachmentIdentifier");
                  if (![named isKindOfClass:[NSString class]] ||
                      [named caseInsensitiveCompare:attachmentIdentifier] != NSOrderedSame)
                    return;
                  NSString *slice = [body.string substringWithRange:range];
                  for (NSUInteger i = 0; i < slice.length; i++)
                    if ([slice characterAtIndex:i] == 0xFFFC) count++;
                }];
  return count;
}

static BOOL IsActiveTopLevelTable(NSManagedObject *attachment) {
  return [[attachment valueForKey:@"typeUTI"] isEqual:kTableUTI] &&
         ![attachment valueForKey:@"parentAttachment"] &&
         ![[attachment valueForKey:@"markedForDeletion"] boolValue];
}

static NSArray<NSManagedObject *> *ActiveTables(NSManagedObject *note) {
  NSMutableArray *tables = [NSMutableArray array];
  for (NSManagedObject *attachment in [note valueForKey:@"attachments"])
    if (IsActiveTopLevelTable(attachment)) [tables addObject:attachment];
  [tables sortUsingComparator:^NSComparisonResult(id a, id b) {
    return [[a valueForKey:@"identifier"] compare:[b valueForKey:@"identifier"]];
  }];
  return tables;
}

// Compare-and-swap token over one table attachment: identity, deletion state,
// and the exact serialized CRDT document. Any persisted cell, row, or column
// change alters it. The note revision separately covers the body.
static NSString *TableDigest(NSManagedObject *attachment) {
  NSData *data = [attachment valueForKey:@"mergeableData"];
  NSString *canonical =
      [NSString stringWithFormat:@"t1\x1f%@\x1f%d\x1f%@", [attachment valueForKey:@"identifier"] ?: @"",
                                 [[attachment valueForKey:@"markedForDeletion"] boolValue],
                                 [data isKindOfClass:[NSData class]] ? SHA256Hex(data) : @"none"];
  return [@"t1:" stringByAppendingString:SHA256Hex([canonical dataUsingEncoding:NSUTF8StringEncoding])];
}

static id TableOf(NSManagedObject *attachment, id *modelOut) {
  RegisterTableCoder();
  id model = Send(attachment, "tableModel");
  id table = model ? Send(model, "table") : nil;
  if (modelOut) *modelOut = model;
  return table;
}

static id RowIdentityAt(id table, NSUInteger index) {
  return ((id(*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("identifierForRowAtIndex:"),
                                                     index);
}
static id ColumnIdentityAt(id table, NSUInteger index) {
  return ((id(*)(id, SEL, NSUInteger))objc_msgSend)(
      table, sel_registerName("identifierForColumnAtIndex:"), index);
}
static NSString *CellText(id table, NSUInteger column, NSUInteger row) {
  return TextOf(((id(*)(id, SEL, NSUInteger, NSUInteger))objc_msgSend)(
      table, sel_registerName("stringForColumnIndex:rowIndex:"), column, row));
}

// The semantic table: column identifiers and, per row, its identifier and the
// plain text of each cell. Returns nil with *reason set when the table is too
// large or its identities are missing or duplicated.
static NSDictionary *TableSnapshot(id table, NSString **reason) {
  if (!table) {
    if (reason) *reason = @"The table document could not be loaded";
    return nil;
  }
  NSUInteger rows = SendUInt(table, "rowCount");
  NSUInteger columns = SendUInt(table, "columnCount");
  if (rows > MAX_TABLE_DIMENSION || columns > MAX_TABLE_DIMENSION ||
      (columns && rows > MAX_TABLE_CELLS / columns)) {
    if (reason) *reason = @"The table exceeds 1000 rows or columns or 10000 cells";
    return nil;
  }
  NSMutableArray *columnIds = [NSMutableArray array];
  for (NSUInteger c = 0; c < columns; c++) {
    NSString *identity = IdentityText(ColumnIdentityAt(table, c));
    if (!identity || [columnIds containsObject:identity]) {
      if (reason) *reason = @"A table column has no unique native identifier";
      return nil;
    }
    [columnIds addObject:identity];
  }
  NSMutableArray *rowList = [NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  for (NSUInteger r = 0; r < rows; r++) {
    NSString *identity = IdentityText(RowIdentityAt(table, r));
    if (!identity || [seen containsObject:identity]) {
      if (reason) *reason = @"A table row has no unique native identifier";
      return nil;
    }
    [seen addObject:identity];
    NSMutableArray *cells = [NSMutableArray array];
    for (NSUInteger c = 0; c < columns; c++) [cells addObject:CellText(table, c, r)];
    [rowList addObject:@{@"identifier" : identity, @"cells" : cells}];
  }
  return @{@"columnIdentifiers" : columnIds, @"rows" : rowList};
}

static NSUInteger IndexOfRow(NSDictionary *snapshot, NSString *rowIdentifier) {
  NSArray *rows = snapshot[@"rows"];
  for (NSUInteger i = 0; i < rows.count; i++)
    if ([rows[i][@"identifier"] caseInsensitiveCompare:rowIdentifier] == NSOrderedSame) return i;
  return NSNotFound;
}

static NSDictionary *TableSummary(NSManagedObject *attachment, NSAttributedString *body) {
  NSString *identifier = [attachment valueForKey:@"identifier"];
  NSUInteger glyphs = GlyphCountFor(body, identifier);
  NSMutableDictionary *summary = [@{
    @"identifier" : identifier ?: @"",
    @"glyphCount" : @(glyphs),
    @"orphan" : @((BOOL)(glyphs == 0)),
    @"digest" : TableDigest(attachment),
  } mutableCopy];
  NSString *reason = nil;
  NSDictionary *snapshot = TableSnapshot(TableOf(attachment, NULL), &reason);
  if (snapshot) {
    summary[@"readable"] = @YES;
    summary[@"rowCount"] = @([snapshot[@"rows"] count]);
    summary[@"columnCount"] = @([snapshot[@"columnIdentifiers"] count]);
    summary[@"columnIdentifiers"] = snapshot[@"columnIdentifiers"];
    summary[@"rows"] = snapshot[@"rows"];
  } else {
    summary[@"readable"] = @NO;
    summary[@"unreadableReason"] = reason ?: @"unknown";
  }
  return summary;
}

static NSDictionary *HandleReadTables(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  RequireFeature(FeatureTables);
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  NSManagedObject *note = FetchNote(context, identifier);
  if (SendBool(note, "isPasswordProtected"))
    Fail(@"unsupported_note", @"Locked notes are not supported", nil);
  NSAttributedString *body = BodyAttributedString(note);
  NSMutableArray *tables = [NSMutableArray array];
  for (NSManagedObject *attachment in ActiveTables(note))
    [tables addObject:TableSummary(attachment, body)];
  return @{
    @"status" : @"ok",
    @"identifier" : identifier,
    @"revision" : RevisionToken(note),
    @"deletedOrInTrash" : @(SendBool(note, "isDeletedOrInTrash")),
    @"sharedViaICloud" : @(SendBool(note, "isSharedViaICloud")),
    @"tableCount" : @(tables.count),
    @"tables" : tables,
    @"syncHostRunning" : @(NotesAppRunning()),
  };
}

// Request helpers shared by the table actions.

static BOOL RequireBool(NSDictionary *request, NSString *key) {
  id value = request[key];
  // NSJSONSerialization decodes true/false as the __NSCFBoolean singletons.
  if (value != (id)kCFBooleanTrue && value != (id)kCFBooleanFalse)
    Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be true or false", key], nil);
  return [value boolValue];
}

static NSString *RequireUUIDField(NSDictionary *request, NSString *key) {
  NSString *value = RequireString(request, key);
  if (!IsUUID(value)) Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be a UUID", key], nil);
  return value;
}

static NSString *RequireToken(NSDictionary *request, NSString *key, NSString *prefix) {
  NSString *value = RequireString(request, key);
  if (![value hasPrefix:prefix] || value.length != prefix.length + 64)
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"`%@` must be a token from a fresh read or dry run", key], nil);
  return value;
}

// Dry runs take no guards; applies need both. Mixing them is refused so a
// caller cannot mistake one for the other. Returns YES for an apply.
static BOOL RequireGuards(NSDictionary *request, BOOL dryRun, NSString **ifRevision,
                          NSString **ifTableDigest) {
  if (dryRun) {
    if (request[@"ifRevision"] || request[@"ifTableDigest"])
      Fail(@"invalid_request", @"`ifRevision` and `ifTableDigest` are only accepted with dryRun false",
           nil);
    return NO;
  }
  *ifRevision = RequireToken(request, @"ifRevision", @"r1:");
  *ifTableDigest = RequireToken(request, @"ifTableDigest", @"t1:");
  return YES;
}

static void ValidateCellText(NSString *text) {
  if (text.length > MAX_CELL_UTF16)
    Fail(@"invalid_request", @"Cell text exceeds 10000 UTF-16 code units", nil);
  if ([text rangeOfCharacterFromSet:ForbiddenTextCharacters(YES)].location != NSNotFound)
    Fail(@"invalid_request",
         @"Cell text may contain only printable characters, tabs and \\n newlines", nil);
}

typedef struct {
  StoreLocation store;
  NSManagedObjectContext *context;
  NSManagedObject *note;
  NSManagedObject *attachment;
  NSString *revision;
  NSString *tableDigest;
  NSString *bodyText;
} TableTarget;

// Resolves the note and one of its table attachments, applying the same note
// refusals as every other write. `visible` requires exactly one body glyph;
// otherwise the table must have none (an orphan). A dry run opens the store
// read-only.
static TableTarget ResolveTableTarget(NSDictionary *request, BOOL readOnly, BOOL visible,
                                      Feature feature) {
  NSString *identifier = RequireIdentifier(request);
  NSString *tableIdentifier = RequireUUIDField(request, @"tableIdentifier");
  RequireFeature(feature);
  TableTarget target;
  target.store = ResolveStore();
  target.context = OpenContext(target.store, readOnly);
  target.note = FetchNote(target.context, identifier);
  RequireAppendableNote(target.note);
  NSAttributedString *body = BodyAttributedString(target.note);
  if (!body) Fail(@"unsupported_note", @"The note body could not be loaded as a mergeable string", nil);
  target.bodyText = [body.string copy];
  target.attachment = nil;
  for (NSManagedObject *attachment in [target.note valueForKey:@"attachments"]) {
    NSString *candidate = [attachment valueForKey:@"identifier"];
    if ([candidate isKindOfClass:[NSString class]] &&
        [candidate caseInsensitiveCompare:tableIdentifier] == NSOrderedSame)
      target.attachment = attachment;
  }
  if (!target.attachment) Fail(@"not_found", @"The note has no attachment with that tableIdentifier", nil);
  if (![[target.attachment valueForKey:@"typeUTI"] isEqual:kTableUTI])
    Fail(@"invalid_request", @"That attachment is not a table", nil);
  if (!IsActiveTopLevelTable(target.attachment))
    Fail(@"unsupported_attachment", @"The table is nested or already marked for deletion", nil);
  NSUInteger glyphs = GlyphCountFor(body, tableIdentifier);
  if (visible && glyphs != 1)
    Fail(@"unsupported_attachment",
         glyphs ? @"The table appears more than once in the body"
                : @"The table has no glyph in the body (an orphan); use prune_orphan_table",
         @{@"glyphCount" : @(glyphs)});
  if (!visible && glyphs != 0)
    Fail(@"unsupported_attachment", @"The table is visible in the body, so it is not an orphan",
         @{@"glyphCount" : @(glyphs)});
  target.revision = RevisionToken(target.note);
  target.tableDigest = TableDigest(target.attachment);
  return target;
}

// The compare-and-swap step: the persisted note revision and table digest
// must equal the caller's tokens before anything changes.
static void CompareTableGuards(TableTarget target, NSString *ifRevision, NSString *ifTableDigest) {
  if (![ifRevision isEqualToString:target.revision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : target.revision});
  if (![ifTableDigest isEqualToString:target.tableDigest])
    Fail(@"attachment_conflict", @"The table changed since ifTableDigest was read",
         @{@"committed" : @NO, @"currentTableDigest" : target.tableDigest});
}

static NSManagedObject *AttachmentNamed(NSManagedObject *note, NSString *identifier) {
  for (NSManagedObject *candidate in [note valueForKey:@"attachments"])
    if ([[candidate valueForKey:@"identifier"] isEqualToString:identifier]) return candidate;
  return nil;
}

// Serializes an edited table, marks it and the note changed, saves once, and
// proves through a brand-new Core Data stack that the body is untouched and
// the table now equals `expected` exactly.
static NSDictionary *CommitTableEdit(TableTarget target, id model, NSString *reason,
                                     NSDictionary *expected) {
  NSString *tableIdentifier = [target.attachment valueForKey:@"identifier"];
  NSString *noteIdentifier = [target.note valueForKey:@"identifier"];
  SendVoid(model, "writeMergeableData");
  SendVoid(model, "regenerateTextContentInNote");
  SendVoid(target.attachment, "saveMergeableDataIfNeeded");
  NSDate *now = [NSDate date];
  if (target.attachment.entity.propertiesByName[@"modificationDate"])
    [target.attachment setValue:now forKey:@"modificationDate"];
  ((void (*)(id, SEL, id))objc_msgSend)(target.attachment,
                                        sel_registerName("updateChangeCountWithReason:"), reason);
  [target.note setValue:now forKey:@"modificationDate"];
  ((void (*)(id, SEL, id))objc_msgSend)(target.note, sel_registerName("updateChangeCountWithReason:"),
                                        reason);
  SaveOrFail(target.context);

  NSString *verifyDetail = nil;
  NSDictionary *after = nil;
  NSString *digestAfter = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(target.store, YES);
    NSManagedObject *note = FetchNote(fresh, noteIdentifier);
    NSAttributedString *body = BodyAttributedString(note);
    NSManagedObject *attachment = AttachmentNamed(note, tableIdentifier);
    NSString *reasonText = nil;
    NSDictionary *snapshot = attachment ? TableSnapshot(TableOf(attachment, NULL), &reasonText) : nil;
    if (![body.string isEqualToString:target.bodyText])
      verifyDetail = @"The note body changed during a table-only edit";
    else if (GlyphCountFor(body, tableIdentifier) != 1)
      verifyDetail = @"The table glyph is no longer present exactly once";
    else if (!snapshot)
      verifyDetail = reasonText ?: @"The table could not be re-read";
    else if (![snapshot isEqual:expected])
      verifyDetail = @"The persisted table does not equal the planned result";
    if (!verifyDetail) {
      digestAfter = TableDigest(attachment);
      after = NoteState(note);
    }
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail)
    Fail(@"verification_failed", verifyDetail,
         @{@"committed" : @YES, @"revisionBefore" : target.revision});
  NSMutableDictionary *result = [@{
    @"status" : @"updated",
    @"dryRun" : @NO,
    @"committed" : @YES,
    @"verified" : @YES,
    @"identifier" : noteIdentifier,
    @"tableIdentifier" : tableIdentifier,
    @"revisionBefore" : target.revision,
    @"revisionAfter" : after[@"revision"],
    @"tableDigestBefore" : target.tableDigest,
    @"tableDigestAfter" : digestAfter,
    @"rowCount" : @([expected[@"rows"] count]),
    @"columnCount" : @([expected[@"columnIdentifiers"] count]),
    @"modificationDate" : after[@"modificationDate"],
    @"cloudSync" : after[@"cloudSync"],
  } mutableCopy];
  [result addEntriesFromDictionary:PushFields(target.store)];
  return result;
}

static NSDictionary *LoadedSnapshot(TableTarget target, id *tableOut, id *modelOut) {
  id model = nil;
  id table = TableOf(target.attachment, &model);
  NSString *reason = nil;
  NSDictionary *snapshot = TableSnapshot(table, &reason);
  if (!snapshot || !model) Fail(@"unsupported_attachment", reason ?: @"The table could not be loaded", nil);
  if (tableOut) *tableOut = table;
  if (modelOut) *modelOut = model;
  return snapshot;
}

static NSDictionary *HandleDeleteTableRow(NSDictionary *request) {
  gWriteRequest = YES;
  BOOL dryRun = RequireBool(request, @"dryRun");
  NSString *rowIdentifier = RequireUUIDField(request, @"rowIdentifier");
  NSString *ifRevision = nil, *ifTableDigest = nil;
  BOOL apply = RequireGuards(request, dryRun, &ifRevision, &ifTableDigest);
  TableTarget target = ResolveTableTarget(request, !apply, YES, FeatureTables);
  // Guards first, so a stale plan reports a conflict rather than a missing row.
  if (apply) CompareTableGuards(target, ifRevision, ifTableDigest);
  id table = nil, model = nil;
  NSDictionary *snapshot = LoadedSnapshot(target, &table, &model);
  NSUInteger index = IndexOfRow(snapshot, rowIdentifier);
  if (index == NSNotFound) Fail(@"not_found", @"The table has no row with that rowIdentifier", nil);
  NSArray *rows = snapshot[@"rows"];
  if (rows.count < 2) Fail(@"unsupported_attachment", @"A table's only row cannot be deleted", nil);
  NSMutableArray *remaining = [rows mutableCopy];
  [remaining removeObjectAtIndex:index];
  NSDictionary *expected = @{@"columnIdentifiers" : snapshot[@"columnIdentifiers"], @"rows" : remaining};

  NSDictionary *plan = @{
    @"identifier" : [target.note valueForKey:@"identifier"],
    @"tableIdentifier" : [target.attachment valueForKey:@"identifier"],
    @"rowIdentifier" : rows[index][@"identifier"],
    @"rowIndex" : @(index),
    @"rowCells" : rows[index][@"cells"],
    @"rowCountBefore" : @(rows.count),
    @"columnCount" : @([snapshot[@"columnIdentifiers"] count]),
  };
  if (!apply) {
    NSMutableDictionary *result = [plan mutableCopy];
    [result addEntriesFromDictionary:@{
      @"status" : @"planned",
      @"dryRun" : @YES,
      @"committed" : @NO,
      @"revision" : target.revision,
      @"tableDigest" : target.tableDigest,
    }];
    return result;
  }
  ((void (*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("removeRowAtIndex:"), index);
  NSMutableDictionary *result =
      [CommitTableEdit(target, model, @"apple-notes-mcp delete_table_row", expected) mutableCopy];
  [result addEntriesFromDictionary:plan];
  return result;
}

static NSDictionary *HandleInsertTableRow(NSDictionary *request) {
  gWriteRequest = YES;
  id cellsValue = request[@"cells"];
  NSArray *cells = cellsValue ?: @[];
  if (![cells isKindOfClass:[NSArray class]])
    Fail(@"invalid_request", @"`cells` must be an array of strings", nil);
  for (id cell in cells) {
    if (![cell isKindOfClass:[NSString class]])
      Fail(@"invalid_request", @"`cells` must be an array of strings", nil);
    ValidateCellText(cell);
  }
  NSString *after = request[@"afterRowIdentifier"] ? RequireUUIDField(request, @"afterRowIdentifier") : nil;
  NSString *ifRevision = nil, *ifTableDigest = nil;
  RequireGuards(request, NO, &ifRevision, &ifTableDigest);
  TableTarget target = ResolveTableTarget(request, NO, YES, FeatureTables);
  CompareTableGuards(target, ifRevision, ifTableDigest);
  id table = nil, model = nil;
  NSDictionary *snapshot = LoadedSnapshot(target, &table, &model);
  NSArray *columns = snapshot[@"columnIdentifiers"];
  NSArray *rows = snapshot[@"rows"];
  if (cells.count > columns.count)
    Fail(@"invalid_request", @"`cells` has more entries than the table has columns", nil);
  if (rows.count >= MAX_TABLE_DIMENSION || (rows.count + 1) * columns.count > MAX_TABLE_CELLS)
    Fail(@"unsupported_attachment", @"The table is already at the row or cell limit", nil);
  NSUInteger index = rows.count;
  if (after) {
    NSUInteger found = IndexOfRow(snapshot, after);
    if (found == NSNotFound) Fail(@"not_found", @"The table has no row with that afterRowIdentifier", nil);
    index = found + 1;
  }

  ((id(*)(id, SEL, NSUInteger))objc_msgSend)(table, sel_registerName("insertRowAtIndex:"), index);
  NSString *newRow = IdentityText(RowIdentityAt(table, index));
  if (!newRow || IndexOfRow(snapshot, newRow) != NSNotFound) {
    [target.context rollback];
    Fail(@"internal_error", @"The inserted row has no new native identifier", @{@"committed" : @NO});
  }
  NSMutableArray *newCells = [NSMutableArray array];
  for (NSUInteger c = 0; c < columns.count; c++) {
    NSString *text = c < cells.count ? cells[c] : @"";
    [newCells addObject:text];
    if (!text.length) continue;
    ((void (*)(id, SEL, id, NSUInteger, NSUInteger))objc_msgSend)(
        table, sel_registerName("setAttributedString:columnIndex:rowIndex:"),
        [[NSAttributedString alloc] initWithString:text], c, index);
  }
  NSMutableArray *expectedRows = [rows mutableCopy];
  [expectedRows insertObject:@{@"identifier" : newRow, @"cells" : newCells} atIndex:index];
  NSMutableDictionary *result =
      [CommitTableEdit(target, model, @"apple-notes-mcp insert_table_row",
                       @{@"columnIdentifiers" : columns, @"rows" : expectedRows}) mutableCopy];
  result[@"rowIdentifier"] = newRow;
  result[@"rowIndex"] = @(index);
  return result;
}

static NSDictionary *HandleSetTableCell(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *rowIdentifier = RequireUUIDField(request, @"rowIdentifier");
  NSString *columnIdentifier = RequireUUIDField(request, @"columnIdentifier");
  id textValue = request[@"text"];
  if (![textValue isKindOfClass:[NSString class]])
    Fail(@"invalid_request", @"`text` must be a string (it may be empty)", nil);
  NSString *text = textValue;
  ValidateCellText(text);
  NSString *ifRevision = nil, *ifTableDigest = nil;
  RequireGuards(request, NO, &ifRevision, &ifTableDigest);
  TableTarget target = ResolveTableTarget(request, NO, YES, FeatureTables);
  CompareTableGuards(target, ifRevision, ifTableDigest);
  id table = nil, model = nil;
  NSDictionary *snapshot = LoadedSnapshot(target, &table, &model);
  NSUInteger row = IndexOfRow(snapshot, rowIdentifier);
  if (row == NSNotFound) Fail(@"not_found", @"The table has no row with that rowIdentifier", nil);
  NSArray *columns = snapshot[@"columnIdentifiers"];
  NSUInteger column = NSNotFound;
  for (NSUInteger c = 0; c < columns.count; c++)
    if ([columns[c] caseInsensitiveCompare:columnIdentifier] == NSOrderedSame) column = c;
  if (column == NSNotFound) Fail(@"not_found", @"The table has no column with that columnIdentifier", nil);

  NSString *previous = snapshot[@"rows"][row][@"cells"][column];
  ((void (*)(id, SEL, id, NSUInteger, NSUInteger))objc_msgSend)(
      table, sel_registerName("setAttributedString:columnIndex:rowIndex:"),
      [[NSAttributedString alloc] initWithString:text], column, row);
  NSMutableArray *rows = [snapshot[@"rows"] mutableCopy];
  NSMutableArray *cells = [rows[row][@"cells"] mutableCopy];
  cells[column] = text;
  rows[row] = @{@"identifier" : rows[row][@"identifier"], @"cells" : cells};
  NSMutableDictionary *result =
      [CommitTableEdit(target, model, @"apple-notes-mcp set_table_cell",
                       @{@"columnIdentifiers" : columns, @"rows" : rows}) mutableCopy];
  result[@"rowIdentifier"] = rows[row][@"identifier"];
  result[@"columnIdentifier"] = columns[column];
  result[@"previousText"] = previous;
  return result;
}

// An orphan is an active top-level table attachment of this note that no body
// glyph names: invisible in Notes, but still synced and still counted.
// Tombstoning it is Notes' own deletion path, so CloudKit removes it on other
// devices. The body is never edited.
static void RequireExpectedChanges(NSManagedObjectContext *context, NSArray<NSManagedObject *> *allowed,
                                   NSSet<NSString *> *allowedInsertedEntities);

// Attachment glyphs (U+FFFC) whose attachment cannot be identified: no
// attachment attribute, or one without a string identifier. Any such glyph
// could be the table's, so an orphan decision cannot rest on the rest.
static NSUInteger UnidentifiedAttachmentGlyphs(NSAttributedString *body) {
  NSUInteger count = 0;
  NSString *text = body.string;
  for (NSUInteger i = 0; i < text.length; i++) {
    if ([text characterAtIndex:i] != 0xFFFC) continue;
    id value = [body attribute:@"NSAttachment" atIndex:i effectiveRange:NULL];
    id named = value && [value respondsToSelector:sel_registerName("attachmentIdentifier")]
                   ? Send(value, "attachmentIdentifier")
                   : nil;
    if (![named isKindOfClass:[NSString class]] || ![named length]) count++;
  }
  return count;
}

static NSDictionary *HandlePruneOrphanTable(NSDictionary *request) {
  gWriteRequest = YES;
  BOOL dryRun = RequireBool(request, @"dryRun");
  NSString *ifRevision = nil, *ifTableDigest = nil;
  BOOL apply = RequireGuards(request, dryRun, &ifRevision, &ifTableDigest);
  TableTarget target = ResolveTableTarget(request, !apply, NO, FeaturePruneTable);
  if (apply) CompareTableGuards(target, ifRevision, ifTableDigest);
  NSUInteger unidentified = UnidentifiedAttachmentGlyphs(BodyAttributedString(target.note));
  if (unidentified)
    Fail(@"unsupported_attachment",
         @"The body has attachment glyphs whose attachment cannot be identified, so the table cannot be "
         @"shown to be an orphan",
         @{@"committed" : @NO, @"unidentifiedGlyphs" : @(unidentified)});
  NSRange range = ((NSRange(*)(id, SEL, id))objc_msgSend)(
      target.note, sel_registerName("rangeForAttachment:"), target.attachment);
  if (range.location != NSNotFound && range.length != 0)
    Fail(@"unsupported_attachment", @"Notes still reports a body range for this table", nil);
  NSString *tableIdentifier = [target.attachment valueForKey:@"identifier"];
  NSString *reason = nil;
  NSDictionary *snapshot = TableSnapshot(TableOf(target.attachment, NULL), &reason);
  NSUInteger activeBefore = ActiveTables(target.note).count;
  NSMutableDictionary *plan = [@{
    @"identifier" : [target.note valueForKey:@"identifier"],
    @"tableIdentifier" : tableIdentifier,
    @"glyphCount" : @0,
    @"activeTableCountBefore" : @(activeBefore),
    @"readable" : @((BOOL)(snapshot != nil)),
  } mutableCopy];
  if (snapshot) {
    plan[@"rowCount"] = @([snapshot[@"rows"] count]);
    plan[@"columnCount"] = @([snapshot[@"columnIdentifiers"] count]);
    // The first row lets a person recognise the table before approving.
    if ([snapshot[@"rows"] count]) plan[@"firstRowCells"] = snapshot[@"rows"][0][@"cells"];
  }
  if (!apply) {
    [plan addEntriesFromDictionary:@{
      @"status" : @"planned",
      @"dryRun" : @YES,
      @"committed" : @NO,
      @"revision" : target.revision,
      @"tableDigest" : target.tableDigest,
    }];
    return plan;
  }

  ((void (*)(id, SEL, BOOL))objc_msgSend)(
      target.attachment, sel_registerName("updateMarkedForDeletionStateAttachmentIsInUse:"), NO);
  SendVoid(target.attachment, "markForDeletion");
  if (![[target.attachment valueForKey:@"markedForDeletion"] boolValue]) {
    [target.context rollback];
    Fail(@"save_failed", @"The table did not enter the deleted state; nothing was saved",
         @{@"committed" : @NO});
  }
  // A note-level change count bump makes Notes treat the note as changed and
  // puts the note row in the save, so a concurrent Notes save conflicts.
  ((void (*)(id, SEL, id))objc_msgSend)(target.note, sel_registerName("updateChangeCountWithReason:"),
                                        @"apple-notes-mcp prune_orphan_table");
  // Only the note and the table row may change; anything else NotesShared
  // staged is refused before the save.
  RequireExpectedChanges(target.context, @[ target.note, target.attachment ], [NSSet set]);
  SaveOrFail(target.context);

  NSString *verifyDetail = nil;
  NSDictionary *after = nil;
  NSUInteger activeAfter = 0;
  @try {
    NSManagedObjectContext *fresh = OpenContext(target.store, YES);
    NSManagedObject *note = FetchNote(fresh, plan[@"identifier"]);
    NSManagedObject *attachment = AttachmentNamed(note, tableIdentifier);
    activeAfter = ActiveTables(note).count;
    if (![BodyAttributedString(note).string isEqualToString:target.bodyText])
      verifyDetail = @"The note body changed during the prune";
    else if (!attachment)
      verifyDetail = @"The pruned table's attachment row is missing after the save";
    else if (![[attachment valueForKey:@"markedForDeletion"] boolValue])
      verifyDetail = @"The table is not marked for deletion after the save";
    else if (activeAfter + 1 != activeBefore)
      verifyDetail = @"The active table count did not drop by exactly one";
    else
      after = NoteState(note);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail)
    Fail(@"verification_failed", verifyDetail,
         @{@"committed" : @YES, @"revisionBefore" : target.revision});
  [plan addEntriesFromDictionary:@{
    @"status" : @"updated",
    @"dryRun" : @NO,
    @"committed" : @YES,
    @"verified" : @YES,
    @"removedTableIdentifier" : tableIdentifier,
    @"activeTableCountAfter" : @(activeAfter),
    @"revisionBefore" : target.revision,
    @"revisionAfter" : after[@"revision"],
    @"cloudSync" : after[@"cloudSync"],
  }];
  [plan addEntriesFromDictionary:PushFields(target.store)];
  return plan;
}

#pragma mark - Smart folders

// A smart folder is an ordinary synced ICFolder row with folderType 2 and a
// stored query document instead of notes. There is no AppleScript or
// Shortcuts interface for creating or editing one. Every query goes through
// Notes' own query model (ICQueryObjC / ICFilterSelection), and a query Notes
// cannot store without changing its meaning is refused.
//
// Folders have no note revision, so the smart-folder writes compare an `f1:`
// folder revision (FolderRevision below) as their ifRevision token. Creating
// a folder has nothing to compare: its guard is that no active folder with
// that title exists in the destination.

// Limits keep a hostile query from exhausting the writer before Notes' own
// parser sees it. Real smart folders are a handful of clauses.
#define SMART_MAX_QUERY_BYTES (64 * 1024)
#define SMART_MAX_DEPTH 32
#define SMART_MAX_NODES 256
#define SMART_MAX_TITLE_UTF16 256
#define SMART_MAX_STRING_UTF16 1024

static NSString *const kSmartCreateReason = @"apple-notes-mcp create_smart_folder";
static NSString *const kSmartUpdateReason = @"apple-notes-mcp update_smart_folder";
static NSString *const kSmartDeleteReason = @"apple-notes-mcp delete_smart_folder";

static BOOL IsJSONInteger(id value, double minimum, double maximum) {
  if (![value isKindOfClass:[NSNumber class]] || IsJSONBool(value)) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= minimum && number <= maximum;
}

static BOOL IsJSONFiniteNumber(id value) {
  return [value isKindOfClass:[NSNumber class]] && !IsJSONBool(value) && isfinite([value doubleValue]);
}

static BOOL HasExactlyKeys(id object, NSArray<NSString *> *keys) {
  return [object isKindOfClass:[NSDictionary class]] && [object count] == keys.count &&
         [[NSSet setWithArray:[object allKeys]] isEqualToSet:[NSSet setWithArray:keys]];
}

// Compact JSON with sorted keys: the one form every query comparison uses, so
// key order and whitespace never decide equality.
static NSString *CanonicalJSON(id object) {
  if (![NSJSONSerialization isValidJSONObject:object]) return nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

static NSDictionary *ParseJSONDictionary(NSString *text) {
  if (![text isKindOfClass:[NSString class]] || !text.length) return nil;
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

static NSString *CanonicalQueryText(NSString *text) {
  NSDictionary *parsed = ParseJSONDictionary(text);
  return parsed ? CanonicalJSON(parsed) : nil;
}

// Titles and query strings are one line: the shared Cc set, and no tab.
static BOOL HasControlCharacters(NSString *text) {
  return [text rangeOfCharacterFromSet:ForbiddenTextCharacters(NO)].location != NSNotFound ||
         [text rangeOfString:@"\t"].location != NSNotFound;
}

static BOOL IsTrimmedPlainString(id value, NSUInteger maxLength) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  NSString *text = value;
  return text.length > 0 && text.length <= maxLength && !HasControlCharacters(text) &&
         [text isEqualToString:[text stringByTrimmingCharactersInSet:NSCharacterSet
                                                                         .whitespaceAndNewlineCharacterSet]];
}

static NSString *StringAttr(id object, NSString *key) {
  id value = object ? [object valueForKey:key] : nil;
  return [value isKindOfClass:[NSString class]] ? value : nil;
}

static BOOL BoolAttr(id object, NSString *key) {
  id value = object ? [object valueForKey:key] : nil;
  return [value respondsToSelector:@selector(boolValue)] && [value boolValue];
}

static NSInteger FolderKind(id folder) {
  id value = folder ? [folder valueForKey:@"folderType"] : nil;
  return [value respondsToSelector:@selector(integerValue)] ? [value integerValue] : NSIntegerMin;
}

static NSArray *FetchRows(NSManagedObjectContext *context, NSString *entity, NSPredicate *predicate) {
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:entity];
  request.predicate = predicate;
  request.returnsObjectsAsFaults = NO;
  NSError *error = nil;
  NSArray *rows = [context executeFetchRequest:request error:&error];
  if (!rows)
    Fail(@"store_unavailable", [NSString stringWithFormat:@"%@ fetch failed", entity],
         @{@"detail" : OrNull(error.localizedDescription)});
  return rows;
}

static NSUInteger CountRows(NSManagedObjectContext *context, NSString *entity, NSPredicate *predicate) {
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:entity];
  request.predicate = predicate;
  NSError *error = nil;
  NSUInteger count = [context countForFetchRequest:request error:&error];
  if (count == NSNotFound)
    Fail(@"store_unavailable", [NSString stringWithFormat:@"%@ count failed", entity],
         @{@"detail" : OrNull(error.localizedDescription)});
  return count;
}

// Folder identifiers are UUIDs for CloudKit folders and short tokens such as
// DefaultFolder-CloudKit for system folders.
static BOOL IsFolderIdentifier(id value) {
  if (![value isKindOfClass:[NSString class]] || [value length] == 0 || [value length] > 128) return NO;
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"];
  return [[value stringByTrimmingCharactersInSet:allowed] length] == 0;
}

// Resolves a folder by stable identifier or by the server's x-coredata folder
// id. Refuses a reference that matches more than one row.
static NSManagedObject *FetchFolderRef(NSManagedObjectContext *context, NSString *ref, NSString *field) {
  if ([ref hasPrefix:@"x-coredata://"]) {
    NSURL *url = [NSURL URLWithString:ref];
    NSManagedObjectID *objectID =
        url ? [context.persistentStoreCoordinator managedObjectIDForURIRepresentation:url] : nil;
    if (!objectID || ![objectID.entity.name isEqualToString:@"ICFolder"])
      Fail(@"not_found", [NSString stringWithFormat:@"`%@` does not name a folder in this store", field], nil);
    NSManagedObject *folder = [context existingObjectWithID:objectID error:nil];
    if (!folder)
      Fail(@"not_found", [NSString stringWithFormat:@"`%@` does not name an existing folder", field], nil);
    return folder;
  }
  if (!IsFolderIdentifier(ref))
    Fail(@"invalid_request",
         [NSString stringWithFormat:@"`%@` must be a folder identifier or x-coredata folder id", field], nil);
  NSArray *rows =
      FetchRows(context, @"ICFolder", [NSPredicate predicateWithFormat:@"identifier ==[c] %@", ref]);
  if (rows.count == 0) Fail(@"not_found", [NSString stringWithFormat:@"No folder matches `%@`", field], nil);
  if (rows.count > 1)
    Fail(@"ambiguous", [NSString stringWithFormat:@"`%@` matches more than one folder row", field], nil);
  return rows.firstObject;
}

static NSManagedObject *FetchByIdentifier(NSManagedObjectContext *context, NSString *entity,
                                          NSString *identifier) {
  NSArray *rows =
      FetchRows(context, entity, [NSPredicate predicateWithFormat:@"identifier == %@", identifier]);
  if (rows.count == 0)
    Fail(@"not_found", [NSString stringWithFormat:@"%@ %@ no longer exists", entity, identifier], nil);
  if (rows.count > 1)
    Fail(@"ambiguous", [NSString stringWithFormat:@"More than one %@ row has that identifier", entity], nil);
  return rows.firstObject;
}

static NSManagedObject *ResolveAccount(NSManagedObjectContext *context, NSString *ref) {
  if (!IsTrimmedPlainString(ref, SMART_MAX_STRING_UTF16))
    Fail(@"invalid_request", @"`account` must be an account identifier or name", nil);
  NSArray *accounts = FetchRows(context, @"ICAccount", nil);
  NSMutableArray *byIdentifier = [NSMutableArray array];
  NSMutableArray *byName = [NSMutableArray array];
  for (NSManagedObject *account in accounts) {
    if (BoolAttr(account, @"markedForDeletion")) continue;
    if ([StringAttr(account, @"identifier") isEqualToString:ref]) [byIdentifier addObject:account];
    if ([StringAttr(account, @"name") isEqualToString:ref]) [byName addObject:account];
  }
  NSArray *matches = byIdentifier.count ? byIdentifier : byName;
  if (matches.count == 0) Fail(@"not_found", @"No active Notes account has that identifier or name", nil);
  if (matches.count > 1)
    Fail(@"ambiguous", @"More than one Notes account has that name; pass its identifier", nil);
  return matches.firstObject;
}

static BOOL IsTrashFolder(NSManagedObject *folder) {
  NSString *identifier = StringAttr(folder, @"identifier");
  if ([identifier hasPrefix:@"TrashFolder-"]) return YES;
  id account = [folder valueForKey:@"account"];
  if (account && [account respondsToSelector:sel_registerName("trashFolder")]) {
    id trash = Send(account, "trashFolder");
    if (trash && [[trash objectID] isEqual:folder.objectID]) return YES;
  }
  return NO;
}

// A smart folder may live at an account root or inside an ordinary folder.
// A smart folder is never a destination (the same rule as the server's
// smart-folder destination guard), nor the trash, a shared folder, or a
// folder being deleted.
static void RequireSmartFolderParent(NSManagedObject *parent) {
  if (BoolAttr(parent, @"markedForDeletion"))
    Fail(@"unsupported_folder", @"The parent folder is deleted", nil);
  if (FolderKind(parent) == 2)
    Fail(@"unsupported_folder",
         @"The parent is a smart folder; smart folders cannot hold notes or folders",
         @{@"reason" : @"smart_folder_destination"});
  if (FolderKind(parent) != 0)
    Fail(@"unsupported_folder", @"The parent must be an ordinary folder, not a system folder", nil);
  if (IsTrashFolder(parent)) Fail(@"unsupported_folder", @"The parent cannot be Recently Deleted", nil);
  if ([parent respondsToSelector:sel_registerName("isSharedViaICloud")] &&
      SendBool(parent, "isSharedViaICloud"))
    Fail(@"unsupported_folder", @"The parent folder is shared", nil);
  if (!SendBool(parent, "canAddSubfolder"))
    Fail(@"unsupported_folder", @"Notes reports that this folder cannot hold a subfolder", nil);
}

// Resolves where a smart folder goes. Sets *account always and *parent only
// for a nested destination.
static void ResolveDestination(NSManagedObjectContext *context, NSString *accountRef, NSString *parentRef,
                               NSManagedObject *__strong *account, NSManagedObject *__strong *parent) {
  *parent = nil;
  if (parentRef) {
    *parent = FetchFolderRef(context, parentRef, @"parentIdentifier");
    RequireSmartFolderParent(*parent);
    *account = [*parent valueForKey:@"account"];
  } else if (accountRef) {
    *account = ResolveAccount(context, accountRef);
  } else {
    id fallback = Send1(objc_getClass("ICAccount"), "defaultAccountInContext:", context);
    *account = [fallback isKindOfClass:[NSManagedObject class]] ? fallback : nil;
    if (!*account)
      Fail(@"invalid_request", @"Notes has no default account here; pass account or parentIdentifier", nil);
  }
  if (!*account || !StringAttr(*account, @"identifier"))
    Fail(@"unsupported_folder", @"The destination has no account with a stable identifier", nil);
}

#pragma mark Query normalization

typedef struct {
  NSUInteger nodes;
  NSUInteger filters;
} QueryBudget;

static NSSet<NSString *> *BooleanFilters(void) {
  static NSSet *set;
  if (!set)
    set = [NSSet setWithArray:@[
      @"checklist", @"checklistInProgress", @"checklistCompleted", @"attachment", @"pinned", @"systemPaper",
      @"passwordProtected", @"shared", @"mention", @"tagged"
    ]];
  return set;
}

// A tag clause names a tag by its display text. Notes stores the
// standardized form, which only Notes' own standardizer produces, and the tag
// must exist exactly once in the destination account.
static NSString *ResolveTag(id requested, NSManagedObject *account, NSManagedObjectContext *context,
                            NSMutableDictionary<NSString *, NSDictionary *> *resolved) {
  if (!IsTrimmedPlainString(requested, SMART_MAX_STRING_UTF16))
    Fail(@"invalid_query", @"A tag filter needs a non-empty tag name", nil);
  NSString *name = requested;
  while ([name hasPrefix:@"#"]) name = [name substringFromIndex:1];
  if (!name.length) Fail(@"invalid_query", @"A tag filter needs a non-empty tag name", nil);
  id standardized = Send1(objc_getClass("ICHashtag"), "standardizedHashtagRepresentationForDisplayText:", name);
  if (![standardized isKindOfClass:[NSString class]] || ![standardized length])
    Fail(@"invalid_query", [NSString stringWithFormat:@"Notes cannot standardize the tag #%@", name], nil);
  NSArray *tags =
      FetchRows(context, @"ICHashtag", [NSPredicate predicateWithFormat:@"standardizedContent == %@", standardized]);
  NSMutableArray *here = [NSMutableArray array];
  NSUInteger elsewhere = 0;
  for (NSManagedObject *tag in tags) {
    if (BoolAttr(tag, @"markedForDeletion")) continue;
    if ([[[tag valueForKey:@"account"] objectID] isEqual:account.objectID])
      [here addObject:tag];
    else
      elsewhere++;
  }
  if (here.count > 1)
    Fail(@"ambiguous", [NSString stringWithFormat:@"Tag #%@ is ambiguous in the destination account", name], nil);
  if (here.count == 0)
    Fail(@"tag_not_found",
         elsewhere ? [NSString stringWithFormat:@"Tag #%@ exists only in another account", name]
                   : [NSString stringWithFormat:@"Tag #%@ does not exist in the destination account", name],
         nil);
  NSManagedObject *tag = here.firstObject;
  if (!resolved[standardized])
    resolved[standardized] = @{
      @"requested" : requested,
      @"standardizedContent" : standardized,
      @"displayText" : OrNull(StringAttr(tag, @"displayText")),
      @"identifier" : OrNull(StringAttr(tag, @"identifier")),
    };
  return standardized;
}

static NSString *ResolveFilterFolder(id requested, NSManagedObject *account, NSManagedObjectContext *context) {
  if (![requested isKindOfClass:[NSString class]])
    Fail(@"invalid_query", @"A folder filter needs a folder identifier", nil);
  NSManagedObject *folder = FetchFolderRef(context, requested, @"folder filter");
  if (![[[folder valueForKey:@"account"] objectID] isEqual:account.objectID])
    Fail(@"invalid_query", @"A folder filter names a folder in another account", nil);
  if (BoolAttr(folder, @"markedForDeletion") || FolderKind(folder) != 0 || IsTrashFolder(folder))
    Fail(@"invalid_query", @"Folder filters may name only active ordinary folders", nil);
  return StringAttr(folder, @"identifier");
}

static BOOL IsRelativeRange(id value) {
  if (HasExactlyKeys(value, @[ @"type" ])) return IsJSONInteger(value[@"type"], 0, 5);
  return HasExactlyKeys(value, @[ @"type", @"customAmount", @"customUnit" ]) &&
         IsJSONInteger(value[@"type"], 6, 6) && IsJSONInteger(value[@"customAmount"], 1, 100000) &&
         IsJSONInteger(value[@"customUnit"], 0, 4);
}

static id NormalizeClause(id node, NSUInteger depth, QueryBudget *budget, NSManagedObject *account,
                          NSManagedObjectContext *context,
                          NSMutableDictionary<NSString *, NSDictionary *> *resolvedTags) {
  if (depth > SMART_MAX_DEPTH || ++budget->nodes > SMART_MAX_NODES)
    Fail(@"invalid_query", @"The query is nested too deeply or has too many clauses", nil);
  if (![node isKindOfClass:[NSDictionary class]] || [node count] != 1)
    Fail(@"invalid_query", @"Every query clause must be an object with exactly one key", nil);
  NSString *key = [node allKeys].firstObject;
  id value = node[key];
  if ([key isEqualToString:@"and"] || [key isEqualToString:@"or"]) {
    if (![value isKindOfClass:[NSArray class]] || [value count] == 0)
      Fail(@"invalid_query", [NSString stringWithFormat:@"`%@` needs a non-empty array of clauses", key], nil);
    NSMutableArray *children = [NSMutableArray array];
    for (id child in value)
      [children addObject:NormalizeClause(child, depth + 1, budget, account, context, resolvedTags)];
    return @{key : children};
  }
  if ([key isEqualToString:@"not"])
    return @{key : NormalizeClause(value, depth + 1, budget, account, context, resolvedTags)};
  budget->filters++;
  if ([BooleanFilters() containsObject:key]) {
    if (!IsJSONBool(value))
      Fail(@"invalid_query", [NSString stringWithFormat:@"`%@` must be true or false", key], nil);
    return node;
  }
  if ([key isEqualToString:@"attachmentSection"]) {
    if (!IsJSONInteger(value, 1, 7))
      Fail(@"invalid_query", @"`attachmentSection` must be an integer from 1 to 7", nil);
    return node;
  }
  if ([key isEqualToString:@"tag"]) return @{key : ResolveTag(value, account, context, resolvedTags)};
  if ([key isEqualToString:@"folder"]) return @{key : ResolveFilterFolder(value, account, context)};
  if ([key isEqualToString:@"creationDateRelativeRange"] ||
      [key isEqualToString:@"modificationDateRelativeRange"]) {
    if (!IsRelativeRange(value))
      Fail(@"invalid_query",
           [NSString stringWithFormat:@"`%@` needs {type: 0-5} or {type: 6, customAmount >= 1, customUnit: 0-4}",
                                      key],
           nil);
    return node;
  }
  if ([key isEqualToString:@"creationDateRange"] || [key isEqualToString:@"modificationDateRange"]) {
    if (!HasExactlyKeys(value, @[ @"fromDate", @"toDate" ]) || !IsJSONFiniteNumber(value[@"fromDate"]) ||
        !IsJSONFiniteNumber(value[@"toDate"]) ||
        [value[@"fromDate"] doubleValue] > [value[@"toDate"] doubleValue])
      Fail(@"invalid_query",
           [NSString stringWithFormat:@"`%@` needs finite fromDate <= toDate (seconds since 2001-01-01 UTC)",
                                      key],
           nil);
    return node;
  }
  if ([key isEqualToString:@"sharedParticipant"] || [key isEqualToString:@"mentionParticipant"]) {
    if (!IsTrimmedPlainString(value, SMART_MAX_STRING_UTF16))
      Fail(@"invalid_query", [NSString stringWithFormat:@"`%@` needs a participant identifier", key], nil);
    return node;
  }
  Fail(@"invalid_query", [NSString stringWithFormat:@"Unsupported query clause `%@`", key], nil);
  return nil;
}

// Notes resolves a folder filter only inside an `or` group (the shape its
// editor writes). A folder clause anywhere else gets a one-item `or` around
// it, which does not change what it matches.
static id WrapFolderLeaves(id node, BOOL parentIsOr) {
  if (![node isKindOfClass:[NSDictionary class]] || [node count] != 1) return node;
  NSString *key = [node allKeys].firstObject;
  id value = node[key];
  if ([key isEqualToString:@"folder"]) return parentIsOr ? node : @{@"or" : @[ node ]};
  if ([key isEqualToString:@"not"]) return @{key : WrapFolderLeaves(value, NO)};
  if (([key isEqualToString:@"and"] || [key isEqualToString:@"or"]) && [value isKindOfClass:[NSArray class]]) {
    NSMutableArray *children = [NSMutableArray array];
    for (id child in value) [children addObject:WrapFolderLeaves(child, [key isEqualToString:@"or"])];
    return @{key : children};
  }
  return node;
}

// Peels Notes' outer {"and":[{"deleted":bool}, X]} wrapper (and any
// single-child "and" around it) so the caller may send either the bare filter
// tree or a document copied from an existing smart folder.
static id StripDeletedWrapper(id body, BOOL *hasWrapper, BOOL *includeDeleted) {
  for (NSUInteger depth = 0; depth < SMART_MAX_DEPTH; depth++) {
    if (![body isKindOfClass:[NSDictionary class]] || [body count] != 1 ||
        ![body[@"and"] isKindOfClass:[NSArray class]])
      return body;
    NSArray *items = body[@"and"];
    if (items.count == 1 && [items[0] isKindOfClass:[NSDictionary class]]) {
      body = items[0];
      continue;
    }
    if (items.count != 2 || !HasExactlyKeys(items[0], @[ @"deleted" ])) return body;
    if (!IsJSONBool(items[0][@"deleted"])) Fail(@"invalid_query", @"`deleted` must be true or false", nil);
    BOOL value = [items[0][@"deleted"] boolValue];
    if (*hasWrapper && value != *includeDeleted)
      Fail(@"invalid_query", @"The query has conflicting `deleted` wrappers", nil);
    *hasWrapper = YES;
    *includeDeleted = value;
    body = items[1];
  }
  Fail(@"invalid_query", @"The query is nested too deeply", nil);
  return nil;
}

// A comparison form for query meaning: single-child groups unwrapped, nested
// groups of the same operator flattened, a redundant {"deleted": <outer>}
// inside an `and` dropped (Notes repeats it next to some filters), and
// children sorted. Two documents with equal forms match the same notes.
static id SemanticNode(id node, BOOL includeDeleted, NSUInteger depth) {
  if (depth > SMART_MAX_DEPTH * 2 || ![node isKindOfClass:[NSDictionary class]] || [node count] != 1)
    return node;
  NSString *key = [node allKeys].firstObject;
  id value = node[key];
  if ([key isEqualToString:@"not"]) return @{key : SemanticNode(value, includeDeleted, depth + 1)};
  if (!([key isEqualToString:@"and"] || [key isEqualToString:@"or"]) || ![value isKindOfClass:[NSArray class]])
    return node;
  NSMutableArray *children = [NSMutableArray array];
  NSDictionary *redundant = @{@"deleted" : @(includeDeleted)};
  for (id child in value) {
    id form = SemanticNode(child, includeDeleted, depth + 1);
    if ([key isEqualToString:@"and"] && [form isEqual:redundant]) continue;
    if ([form isKindOfClass:[NSDictionary class]] && [form count] == 1 && [form[key] isKindOfClass:[NSArray class]])
      [children addObjectsFromArray:form[key]];
    else
      [children addObject:form];
  }
  if (children.count == 1) return children.firstObject;
  [children sortUsingComparator:^NSComparisonResult(id a, id b) {
    return [CanonicalJSON(a) ?: @"" compare:CanonicalJSON(b) ?: @""];
  }];
  return @{key : children};
}

static NSString *SemanticQueryJSON(NSDictionary *document) {
  BOOL hasWrapper = NO, includeDeleted = NO;
  id body = nil;
  @try {
    body = StripDeletedWrapper(document[@"type"], &hasWrapper, &includeDeleted);
  } @catch (HelperError *e) {
    return nil;
  }
  return CanonicalJSON(
      @{@"includeDeleted" : @(includeDeleted), @"filter" : SemanticNode(body, includeDeleted, 0)});
}

static void SetFolderType(id folder, short type) {
  ((void (*)(id, SEL, short))objc_msgSend)(folder, sel_registerName("setFolderType:"), type);
}

static BOOL IsEmptyCollection(id value) {
  return !value || ([value respondsToSelector:@selector(count)] && [value count] == 0);
}

// Hands the normalized document to Notes' own query model on a scratch
// folder in a READ-ONLY stack (nothing there can ever be saved), then asks
// Notes to regenerate the document from the parsed filter selection. The
// regenerated form is what gets stored, so Notes' editor can open it.
static NSDictionary *NativeValidateQuery(NSDictionary *document, NSManagedObject *account,
                                         NSManagedObjectContext *readOnlyContext) {
  NSString *json = CanonicalJSON(document);
  id scratch = Send1(objc_getClass("ICFolder"), "newFolderInAccount:", account);
  if (!scratch) Fail(@"private_api_unavailable", @"Notes did not create a scratch folder for validation", nil);
  @try {
    SendVoid1(scratch, "setSmartFolderQueryJSON:", json);
    SetFolderType(scratch, 2);
    id query = Send(scratch, "smartFolderQueryObjC");
    if (!query || !SendBool(query, "canBeEdited") || !Send(query, "predicate"))
      Fail(@"invalid_query", @"Notes' query parser rejected the query", nil);
    if (![Send(query, "entityName") isEqual:@"ICNote"])
      Fail(@"invalid_query", @"Notes parsed the query for the wrong entity", nil);
    id selection =
        Send2(query, "filterSelectionWithManagedObjectContext:account:", readOnlyContext, account.objectID);
    if (!selection || !SendBool(selection, "isValid") || SendBool(selection, "isEmpty") ||
        SendBool(selection, "hasEmptySelection"))
      Fail(@"invalid_query", @"Notes could not resolve every filter in the query", nil);
    for (NSString *problem in @[
           @"emptyFilterTypeSelections", @"invalidFilterTypeSelectionCombinations",
           @"incompatibleLockedNotesFilterTypeSelections"
         ])
      if (!IsEmptyCollection(Send(selection, problem.UTF8String)))
        Fail(@"invalid_query", @"Notes reports incompatible or empty filters in the query",
             @{@"nativeProblem" : problem});
    NSArray *filterTypes = Send(selection, "filterTypeSelections");
    if (![filterTypes isKindOfClass:[NSArray class]] || filterTypes.count == 0)
      Fail(@"invalid_query", @"Notes found no filters in the query", nil);
    for (id filter in filterTypes) {
      if ([filter respondsToSelector:sel_registerName("isEmpty")] && SendBool(filter, "isEmpty"))
        Fail(@"invalid_query", @"Notes left a filter in the query unresolved", nil);
      if ([filter respondsToSelector:sel_registerName("unresolvedParticipants")] &&
          !IsEmptyCollection(Send(filter, "unresolvedParticipants")))
        Fail(@"invalid_query", @"A shared or mention participant does not resolve in the destination account",
             nil);
    }

    id regenerated = Send1(objc_getClass("ICQueryObjC"), "objc_queryForNotesMatchingFilterSelection:", selection);
    if (!regenerated || !SendBool(regenerated, "canBeEdited") || !Send(regenerated, "predicate"))
      Fail(@"invalid_query", @"Notes could not regenerate the query", nil);
    SendVoid1(scratch, "setSmartFolderQueryObjC:", regenerated);
    NSDictionary *nativeDocument = ParseJSONDictionary(StringAttr(scratch, @"smartFolderQueryJSON"));
    NSString *nativeJSON = nativeDocument ? CanonicalJSON(nativeDocument) : nil;
    if (!nativeJSON) Fail(@"invalid_query", @"Notes regenerated an unreadable query document", nil);
    // Notes' filter model cannot represent every boolean tree: observed on
    // macOS 27.2, it drops a `not` and collapses some `and` groups. Storing
    // its regeneration is only safe when it means exactly what was asked.
    NSString *requestedMeaning = SemanticQueryJSON(document);
    NSString *nativeMeaning = SemanticQueryJSON(nativeDocument);
    if (!requestedMeaning || ![requestedMeaning isEqualToString:nativeMeaning])
      Fail(@"query_not_representable",
           @"Notes' smart-folder model cannot store this query without changing its meaning", @{
             @"requestedMeaning" : OrNull(requestedMeaning),
             @"nativeMeaning" : OrNull(nativeMeaning),
             @"nativeQueryJSON" : nativeJSON
           });

    // Round trip: the stored form must parse back to the same filter count.
    SendVoid1(scratch, "setSmartFolderQueryJSON:", nativeJSON);
    id reparsed = Send(scratch, "smartFolderQueryObjC");
    id reselection = reparsed ? Send2(reparsed, "filterSelectionWithManagedObjectContext:account:",
                                      readOnlyContext, account.objectID)
                              : nil;
    NSArray *refilterTypes = reselection ? Send(reselection, "filterTypeSelections") : nil;
    if (!reselection || !SendBool(reselection, "isValid") || ![refilterTypes isKindOfClass:[NSArray class]] ||
        refilterTypes.count != filterTypes.count)
      Fail(@"invalid_query", @"Notes' regenerated query does not parse back to the same filters", nil);
    return @{
      @"queryJSON" : nativeJSON,
      @"filterCount" : @(filterTypes.count),
      @"nativeMinimumSupportedVersion" :
          @(((long long (*)(id, SEL))objc_msgSend)(reparsed, sel_registerName("minimumSupportedVersion"))),
    };
  } @finally {
    [readOnlyContext deleteObject:scratch];
    [readOnlyContext processPendingChanges];
  }
}

// Full pipeline for a requested query in a destination account: parse,
// structural checks, tag and folder resolution, then Notes' own validation.
static NSDictionary *ResolveSmartFolderQuery(NSString *queryText, NSManagedObject *account,
                                             NSManagedObjectContext *readOnlyContext) {
  if ([queryText lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > SMART_MAX_QUERY_BYTES)
    Fail(@"invalid_query", @"`queryJSON` exceeds 64 KiB", nil);
  NSDictionary *document = ParseJSONDictionary(queryText);
  if (!document) Fail(@"invalid_query", @"`queryJSON` must be one JSON object", nil);
  if (!HasExactlyKeys(document, @[ @"entity", @"type" ]) || ![document[@"entity"] isEqual:@"note"] ||
      ![document[@"type"] isKindOfClass:[NSDictionary class]])
    Fail(@"invalid_query", @"The query must be {\"entity\":\"note\",\"type\":{...}}", nil);
  BOOL hasWrapper = NO, includeDeleted = NO;
  id body = StripDeletedWrapper(document[@"type"], &hasWrapper, &includeDeleted);
  QueryBudget budget = {0, 0};
  NSMutableDictionary *resolvedTags = [NSMutableDictionary dictionary];
  id normalized = NormalizeClause(body, 0, &budget, account, readOnlyContext, resolvedTags);
  if (budget.filters == 0) Fail(@"invalid_query", @"The query needs at least one filter", nil);
  if (!normalized[@"and"] && !normalized[@"or"]) normalized = @{@"and" : @[ normalized ]};
  normalized = WrapFolderLeaves(normalized, NO);
  NSDictionary *normalizedDocument =
      @{@"entity" : @"note", @"type" : @{@"and" : @[ @{@"deleted" : @(includeDeleted)}, normalized ]}};
  NSDictionary *native = NativeValidateQuery(normalizedDocument, account, readOnlyContext);
  NSString *requested = CanonicalJSON(document);
  NSArray *tags = [resolvedTags.allValues sortedArrayUsingDescriptors:@[
    [NSSortDescriptor sortDescriptorWithKey:@"standardizedContent" ascending:YES]
  ]];
  return @{
    @"requestedQueryJSON" : requested,
    @"queryJSON" : native[@"queryJSON"],
    @"queryNormalized" : @((BOOL)![requested isEqualToString:native[@"queryJSON"]]),
    @"deletedWrapperAdded" : @((BOOL)!hasWrapper),
    @"resolvedTags" : tags,
    @"filterCount" : native[@"filterCount"],
    @"nativeQueryValidated" : @YES,
    @"nativeMinimumSupportedVersion" : native[@"nativeMinimumSupportedVersion"],
  };
}

#pragma mark Folder state

static NSDictionary *FolderCloudSyncState(NSManagedObject *folder) {
  id cloud = [folder valueForKey:@"cloudState"];
  BOOL inICloud = [folder respondsToSelector:sel_registerName("isInICloudAccount")] &&
                  SendBool(folder, "isInICloudAccount");
  if (!cloud) return @{@"available" : @NO, @"inICloudAccount" : @(inICloud)};
  long long current = [[cloud valueForKey:@"currentLocalVersion"] longLongValue];
  long long synced = [[cloud valueForKey:@"latestVersionSyncedToCloud"] longLongValue];
  return @{
    @"available" : @YES,
    @"inICloudAccount" : @(inICloud),
    @"currentLocalVersion" : @(current),
    @"latestVersionSyncedToCloud" : @(synced),
    @"uploadPending" : @((BOOL)(current > synced)),
  };
}

static NSString *StoredCanonicalQuery(NSManagedObject *folder) {
  return CanonicalQueryText(StringAttr(folder, @"smartFolderQueryJSON"));
}

// Opaque compare-and-swap token over every fact a smart-folder update or
// delete depends on: identity, title, type, stored query, account, parent,
// deletion flag, child and note counts, the title timestamp, and the cloud
// state's local version.
static NSString *FolderRevision(NSManagedObject *folder, NSUInteger children, NSUInteger notes) {
  id parent = [folder valueForKey:@"parent"];
  id account = [folder valueForKey:@"account"];
  NSDate *titleDate = [folder valueForKey:@"dateForLastTitleModification"];
  NSDictionary *cloud = FolderCloudSyncState(folder);
  NSString *canonical = [NSString
      stringWithFormat:@"f1\x1f%@\x1f%@\x1f%ld\x1f%@\x1f%@\x1f%@\x1f%d\x1f%lu\x1f%lu\x1f%.6f\x1f%@",
                       StringAttr(folder, @"identifier") ?: @"", StringAttr(folder, @"title") ?: @"",
                       (long)FolderKind(folder),
                       StoredCanonicalQuery(folder) ?: (StringAttr(folder, @"smartFolderQueryJSON") ?: @""),
                       account ? (StringAttr(account, @"identifier") ?: @"") : @"",
                       parent ? (StringAttr(parent, @"identifier") ?: @"") : @"",
                       BoolAttr(folder, @"markedForDeletion"), (unsigned long)children, (unsigned long)notes,
                       [titleDate isKindOfClass:[NSDate class]] ? titleDate.timeIntervalSinceReferenceDate : 0.0,
                       cloud[@"currentLocalVersion"] ?: @"none"];
  return [@"f1:" stringByAppendingString:SHA256Hex([canonical dataUsingEncoding:NSUTF8StringEncoding])];
}

static NSDictionary *FolderState(NSManagedObject *folder, NSManagedObjectContext *context) {
  NSUInteger children =
      CountRows(context, @"ICFolder", [NSPredicate predicateWithFormat:@"parent == %@", folder]);
  NSUInteger notes = CountRows(context, @"ICNote", [NSPredicate predicateWithFormat:@"folder == %@", folder]);
  id parent = [folder valueForKey:@"parent"];
  id account = [folder valueForKey:@"account"];
  NSString *raw = StringAttr(folder, @"smartFolderQueryJSON");
  return @{
    @"identifier" : OrNull(StringAttr(folder, @"identifier")),
    @"objectURI" : folder.objectID.URIRepresentation.absoluteString,
    @"title" : OrNull(StringAttr(folder, @"title")),
    @"folderType" : @(FolderKind(folder)),
    @"accountIdentifier" : OrNull(account ? StringAttr(account, @"identifier") : nil),
    @"parentIdentifier" : OrNull(parent ? StringAttr(parent, @"identifier") : nil),
    @"queryJSON" : OrNull(CanonicalQueryText(raw) ?: raw),
    @"markedForDeletion" : @(BoolAttr(folder, @"markedForDeletion")),
    @"childFolderCount" : @(children),
    @"physicalNoteCount" : @(notes),
    @"titleDurability" : [[folder valueForKey:@"dateForLastTitleModification"] isKindOfClass:[NSDate class]]
        ? @"stamped"
        : @"missing",
    @"parentDurability" : parent ? ([[folder valueForKey:@"parentModificationDate"] isKindOfClass:[NSDate class]]
                                        ? @"stamped"
                                        : @"missing")
                                 : [NSNull null],
    @"revision" : FolderRevision(folder, children, notes),
    @"cloudSync" : FolderCloudSyncState(folder),
  };
}

static NSArray<NSManagedObject *> *ActiveFoldersTitled(NSManagedObjectContext *context, NSString *title,
                                                       NSManagedObject *account, NSManagedObject *parent) {
  NSMutableArray *matches = [NSMutableArray array];
  for (NSManagedObject *folder in
       FetchRows(context, @"ICFolder",
                 [NSPredicate predicateWithFormat:@"account == %@ AND title == %@", account, title])) {
    if (BoolAttr(folder, @"markedForDeletion")) continue;
    id folderParent = [folder valueForKey:@"parent"];
    BOOL sameParent = parent ? [[folderParent objectID] isEqual:parent.objectID] : folderParent == nil;
    if (sameParent) [matches addObject:folder];
  }
  return matches;
}

// Before any save, the context may hold only the changes this action means
// to make. A NotesShared factory or setter that touches anything else makes
// the write refuse instead of saving side effects nobody reviewed.
static void RequireExpectedChanges(NSManagedObjectContext *context, NSArray<NSManagedObject *> *allowed,
                                   NSSet<NSString *> *allowedInsertedEntities) {
  [context processPendingChanges];
  NSMutableSet *allowedIDs = [NSMutableSet set];
  for (NSManagedObject *object in allowed)
    if (object) [allowedIDs addObject:object.objectID];
  NSMutableArray *unexpected = [NSMutableArray array];
  for (NSManagedObject *object in context.deletedObjects)
    [unexpected addObject:[@"deleted " stringByAppendingString:object.entity.name]];
  for (NSManagedObject *object in context.insertedObjects)
    if (![allowedIDs containsObject:object.objectID] &&
        ![allowedInsertedEntities containsObject:object.entity.name])
      [unexpected addObject:[@"inserted " stringByAppendingString:object.entity.name]];
  for (NSManagedObject *object in context.updatedObjects) {
    if ([allowedIDs containsObject:object.objectID]) continue;
    // Cloud-state rows belong to the object whose change count moved.
    if ([object.entity.name isEqualToString:@"ICCloudState"]) continue;
    [unexpected addObject:[@"updated " stringByAppendingString:object.entity.name]];
  }
  if (unexpected.count) {
    [context rollback];
    Fail(@"unexpected_changes", @"NotesShared staged changes beyond the requested write; nothing was saved",
         @{@"committed" : @NO, @"unexpected" : unexpected});
  }
}

// The writer never uploads (see HandleAppendPlainText). `saved` NO means the
// call wrote nothing, so there is nothing for Notes.app to push.
static NSDictionary *FolderPushFields(StoreLocation store, BOOL saved) {
  if (saved) return PushFields(store);
  NSMutableDictionary *fields = [PushFields(store) mutableCopy];
  fields[@"pushState"] = @"not_applicable";
  return fields;
}

// Re-reads the folder through a brand-new read-only stack and checks every
// persisted fact the write promised. Returns the fresh state or sets
// *errorOut; never trusts the writing context.
static NSDictionary *VerifySmartFolder(StoreLocation store, NSString *identifier, NSString *title,
                                       NSString *queryJSON, NSString *accountIdentifier,
                                       NSString *parentIdentifier, NSString **errorOut) {
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *folder = FetchByIdentifier(fresh, @"ICFolder", identifier);
    NSDictionary *state = FolderState(folder, fresh);
    NSString *problem = nil;
    if (![state[@"title"] isEqual:title])
      problem = @"title";
    else if ([state[@"folderType"] integerValue] != 2)
      problem = @"folderType";
    else if (![state[@"queryJSON"] isEqual:queryJSON])
      problem = @"query";
    else if (![state[@"accountIdentifier"] isEqual:accountIdentifier])
      problem = @"account";
    else if (![state[@"parentIdentifier"] isEqual:OrNull(parentIdentifier)])
      problem = @"parent";
    else if ([state[@"markedForDeletion"] boolValue])
      problem = @"deletion flag";
    else if (![state[@"titleDurability"] isEqual:@"stamped"])
      problem = @"title timestamp";
    else if (parentIdentifier && ![state[@"parentDurability"] isEqual:@"stamped"])
      problem = @"parent timestamp";
    if (!problem) {
      id query = Send(folder, "smartFolderQueryObjC");
      if (!query || !Send(query, "predicate")) problem = @"native parse of the stored query";
    }
    if (problem) {
      *errorOut = [NSString stringWithFormat:@"The persisted smart folder does not match the request (%@)", problem];
      return nil;
    }
    return state;
  } @catch (NSException *e) {
    // Runs after a successful save: any failure is a committed, unverified write.
    *errorOut = e.reason ?: e.name;
    return nil;
  }
}

// The update read-back for a folder whose title or parent timestamp was
// already missing: every VerifySmartFolder fact except those stamps, which
// must be exactly as they were before.
static NSDictionary *VerifySmartFolderUnstamped(StoreLocation store, NSString *identifier, NSDictionary *before,
                                                NSString *queryJSON, NSString **errorOut) {
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *folder = FetchByIdentifier(fresh, @"ICFolder", identifier);
    NSDictionary *state = FolderState(folder, fresh);
    NSString *problem = nil;
    if (![state[@"title"] isEqual:before[@"title"]])
      problem = @"title";
    else if ([state[@"folderType"] integerValue] != 2)
      problem = @"folderType";
    else if (![state[@"queryJSON"] isEqual:queryJSON])
      problem = @"query";
    else if (![state[@"accountIdentifier"] isEqual:before[@"accountIdentifier"]])
      problem = @"account";
    else if (![state[@"parentIdentifier"] isEqual:before[@"parentIdentifier"]])
      problem = @"parent";
    else if ([state[@"markedForDeletion"] boolValue])
      problem = @"deletion flag";
    else if (![state[@"titleDurability"] isEqual:before[@"titleDurability"]] ||
             ![state[@"parentDurability"] isEqual:before[@"parentDurability"]])
      problem = @"timestamps";
    if (!problem) {
      id query = Send(folder, "smartFolderQueryObjC");
      if (!query || !Send(query, "predicate")) problem = @"native parse of the stored query";
    }
    if (problem) {
      *errorOut = [NSString stringWithFormat:@"The persisted smart folder does not match the request (%@)", problem];
      return nil;
    }
    return state;
  } @catch (NSException *e) {
    // Runs after a successful save: any failure is a committed, unverified write.
    *errorOut = e.reason ?: e.name;
    return nil;
  }
}

static void FailFolderVerification(NSString *message, NSString *identifier, NSString *revisionBefore) {
  Fail(@"verification_failed", message ?: @"Read-back failed", @{
    @"committed" : @YES,
    @"identifier" : OrNull(identifier),
    @"revisionBefore" : OrNull(revisionBefore)
  });
}

static NSString *RequireFolderRevision(NSDictionary *request) {
  NSString *value = RequireString(request, @"ifRevision");
  if (![value hasPrefix:@"f1:"] || value.length != 67)
    Fail(@"invalid_request", @"`ifRevision` must be a folder revision from native-read-smart-folder", nil);
  return value;
}

// The smart folder a read, update, or delete names: a UUID, exactly one row,
// folder type 2.
static NSManagedObject *FetchSmartFolder(NSManagedObjectContext *context, NSString *identifier) {
  NSManagedObject *folder = FetchByIdentifier(context, @"ICFolder", identifier);
  if (FolderKind(folder) != 2)
    Fail(@"unsupported_folder", @"That folder is not a smart folder", @{@"folderType" : @(FolderKind(folder))});
  return folder;
}

#pragma mark Smart folder actions

static NSDictionary *HandleReadSmartFolder(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  RequireFeature(FeatureSmartFolders);
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  NSMutableDictionary *result = [FolderState(FetchSmartFolder(context, identifier), context) mutableCopy];
  result[@"status"] = @"ok";
  result[@"syncHostRunning"] = @(NotesAppRunning());
  return result;
}

// Creates a smart folder. Idempotent: an existing smart folder with the same
// title, destination, and stored query is reported without a write. There is
// no revision to compare, since the folder does not exist yet; the guard is
// the title check in the write context itself, right before the save.
static NSDictionary *HandleCreateSmartFolder(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *title = RequireString(request, @"title");
  if (!IsTrimmedPlainString(title, SMART_MAX_TITLE_UTF16))
    Fail(@"invalid_request", @"`title` must be 1-256 characters with no control characters or edge whitespace",
         nil);
  NSString *queryText = RequireString(request, @"queryJSON");
  NSString *accountRef = OptionalString(request, @"account");
  NSString *parentRef = OptionalString(request, @"parentIdentifier");
  if (accountRef && parentRef) Fail(@"invalid_request", @"Pass account or parentIdentifier, not both", nil);
  RequireFeature(FeatureSmartFolders);

  StoreLocation store = ResolveStore();
  // Destination and query are resolved and validated in a read-only stack.
  NSManagedObjectContext *validation = OpenContext(store, YES);
  NSManagedObject *destinationAccount = nil, *destinationParent = nil;
  ResolveDestination(validation, accountRef, parentRef, &destinationAccount, &destinationParent);
  NSString *accountIdentifier = StringAttr(destinationAccount, @"identifier");
  NSString *parentIdentifier = destinationParent ? StringAttr(destinationParent, @"identifier") : nil;
  NSDictionary *resolution = ResolveSmartFolderQuery(queryText, destinationAccount, validation);
  NSString *queryJSON = resolution[@"queryJSON"];

  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *account = FetchByIdentifier(context, @"ICAccount", accountIdentifier);
  NSManagedObject *parent = parentIdentifier ? FetchByIdentifier(context, @"ICFolder", parentIdentifier) : nil;
  if (parent) RequireSmartFolderParent(parent);
  NSArray *existing = ActiveFoldersTitled(context, title, account, parent);
  if (existing.count > 1)
    Fail(@"ambiguous", @"More than one active folder has this exact title in the destination",
         @{@"committed" : @NO});

  NSMutableDictionary *response = [resolution mutableCopy];
  if (existing.count == 1) {
    NSManagedObject *folder = existing.firstObject;
    NSString *identifier = StringAttr(folder, @"identifier");
    if (FolderKind(folder) != 2)
      Fail(@"folder_exists", @"An ordinary folder with this title already exists in the destination",
           @{@"committed" : @NO, @"identifier" : OrNull(identifier)});
    NSString *current = StoredCanonicalQuery(folder);
    if (![current isEqualToString:queryJSON])
      Fail(@"folder_exists",
           @"A smart folder with this title has a different query; change it with native-update-smart-folder",
           @{@"committed" : @NO, @"identifier" : OrNull(identifier), @"currentQueryJSON" : OrNull(current)});
    [response addEntriesFromDictionary:FolderState(folder, context)];
    response[@"status"] = @"ok";
    response[@"changed"] = @NO;
    response[@"existing"] = @YES;
    response[@"committed"] = @NO;
    [response addEntriesFromDictionary:FolderPushFields(store, NO)];
    return response;
  }

  NSError *titleError = nil;
  BOOL titleValid = ((BOOL(*)(id, SEL, id, id, id, NSError **))objc_msgSend)(
      objc_getClass("ICFolder"), sel_registerName("isTitleValid:account:parentFolder:error:"), title, account,
      parent, &titleError);
  if (!titleValid)
    Fail(@"invalid_request", @"Notes rejects this folder title in the destination",
         @{@"committed" : @NO, @"detail" : OrNull(titleError.localizedDescription)});

  NSManagedObject *folder = parent ? Send1(objc_getClass("ICFolder"), "newFolderInParentFolder:", parent)
                                   : Send1(objc_getClass("ICFolder"), "newFolderInAccount:", account);
  if (![folder isKindOfClass:[NSManagedObject class]])
    Fail(@"private_api_unavailable", @"Notes' folder factory returned nothing", @{@"committed" : @NO});
  SendVoid1(folder, "setTitle:", title);
  SendVoid1(folder, "setSmartFolderQueryJSON:", queryJSON);
  SetFolderType(folder, 2);
  // -setTitle: and the factories leave the CloudKit last-writer-wins stamps
  // nil, which lets the first server echo revert the title or drop the
  // parent. Stamp them so the new values win.
  NSDate *now = [NSDate date];
  [folder setValue:now forKey:@"dateForLastTitleModification"];
  if (parent) [folder setValue:now forKey:@"parentModificationDate"];
  SendVoid1(folder, "updateChangeCountWithReason:", kSmartCreateReason);
  NSMutableArray *allowed = [NSMutableArray arrayWithObjects:folder, account, nil];
  if (parent) [allowed addObject:parent];
  RequireExpectedChanges(context, allowed, [NSSet setWithObject:@"ICCloudState"]);
  NSString *identifier = StringAttr(folder, @"identifier");
  SaveOrFailFor(context, @"folder");

  NSString *error = nil;
  NSDictionary *state =
      VerifySmartFolder(store, identifier, title, queryJSON, accountIdentifier, parentIdentifier, &error);
  if (!state) FailFolderVerification(error, identifier, nil);
  [response addEntriesFromDictionary:state];
  response[@"status"] = @"created";
  response[@"changed"] = @YES;
  response[@"existing"] = @NO;
  response[@"committed"] = @YES;
  response[@"verified"] = @YES;
  [response addEntriesFromDictionary:FolderPushFields(store, YES)];
  return response;
}

// Replaces one smart folder's query, guarded by its folder revision.
static NSDictionary *HandleUpdateSmartFolder(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  NSString *queryText = RequireString(request, @"queryJSON");
  NSString *ifRevision = RequireFolderRevision(request);
  RequireFeature(FeatureSmartFolders);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *validation = OpenContext(store, YES);
  NSManagedObject *current = FetchSmartFolder(validation, identifier);
  NSManagedObject *currentAccount = [current valueForKey:@"account"];
  if (!currentAccount) Fail(@"unsupported_folder", @"The smart folder has no account", nil);
  NSDictionary *resolution = ResolveSmartFolderQuery(queryText, currentAccount, validation);
  NSString *queryJSON = resolution[@"queryJSON"];

  NSManagedObjectContext *context = OpenContext(store, NO);
  NSManagedObject *folder = FetchSmartFolder(context, identifier);
  NSDictionary *before = FolderState(folder, context);
  NSString *revisionBefore = before[@"revision"];
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The smart folder changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});
  if ([before[@"markedForDeletion"] boolValue])
    Fail(@"unsupported_folder", @"The smart folder is deleted", @{@"committed" : @NO});

  NSMutableDictionary *response = [resolution mutableCopy];
  NSString *previous = StoredCanonicalQuery(folder);
  if ([previous isEqualToString:queryJSON]) {
    [response addEntriesFromDictionary:before];
    response[@"status"] = @"ok";
    response[@"changed"] = @NO;
    response[@"committed"] = @NO;
    response[@"revisionBefore"] = revisionBefore;
    response[@"revisionAfter"] = revisionBefore;
    [response addEntriesFromDictionary:FolderPushFields(store, NO)];
    return response;
  }
  SendVoid1(folder, "setSmartFolderQueryJSON:", queryJSON);
  // A query update changes only the query. A missing title or parent
  // timestamp belongs to whoever wrote the folder; stamping it here would
  // claim a title or parent change that did not happen, so it is reported
  // (titleDurability / parentDurability, timestampsMissing) instead.
  id parent = [folder valueForKey:@"parent"];
  NSMutableArray *timestampsMissing = [NSMutableArray array];
  if (![before[@"titleDurability"] isEqual:@"stamped"]) [timestampsMissing addObject:@"dateForLastTitleModification"];
  if (parent && ![before[@"parentDurability"] isEqual:@"stamped"]) [timestampsMissing addObject:@"parentModificationDate"];
  SendVoid1(folder, "updateChangeCountWithReason:", kSmartUpdateReason);
  RequireExpectedChanges(context, @[ folder ], [NSSet set]);
  SaveOrFailFor(context, @"folder");

  NSString *error = nil;
  // VerifySmartFolder requires both stamps, which this update never writes; a
  // folder that lacked one is checked with the same facts, and its stamps
  // must be exactly as they were.
  NSDictionary *state = timestampsMissing.count
                            ? VerifySmartFolderUnstamped(store, identifier, before, queryJSON, &error)
                            : VerifySmartFolder(store, identifier, before[@"title"], queryJSON,
                                                before[@"accountIdentifier"],
                                                parent ? before[@"parentIdentifier"] : nil, &error);
  if (!state) FailFolderVerification(error, identifier, revisionBefore);
  [response addEntriesFromDictionary:state];
  response[@"timestampsMissing"] = timestampsMissing;
  response[@"status"] = @"updated";
  response[@"changed"] = @YES;
  response[@"committed"] = @YES;
  response[@"verified"] = @YES;
  response[@"previousQueryJSON"] = OrNull(previous);
  response[@"revisionBefore"] = revisionBefore;
  response[@"revisionAfter"] = state[@"revision"];
  [response addEntriesFromDictionary:FolderPushFields(store, YES)];
  return response;
}

// Deletes one empty smart folder. Two phases: the dry run opens the store
// read-only and returns the plan with the folder revision; the apply must
// present it as ifRevision.
static NSDictionary *HandleDeleteSmartFolder(NSDictionary *request) {
  gWriteRequest = YES;
  NSString *identifier = RequireIdentifier(request);
  id dryRunValue = request[@"dryRun"];
  if (!IsJSONBool(dryRunValue)) Fail(@"invalid_request", @"`dryRun` must be true or false", nil);
  BOOL dryRun = [dryRunValue boolValue];
  NSString *ifRevision = nil;
  if (dryRun && request[@"ifRevision"])
    Fail(@"invalid_request", @"`ifRevision` is only accepted with dryRun false", nil);
  if (!dryRun) ifRevision = RequireFolderRevision(request);
  RequireFeature(FeatureSmartFolders);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  NSManagedObject *folder = FetchSmartFolder(context, identifier);
  NSDictionary *plan = FolderState(folder, context);
  if ([plan[@"markedForDeletion"] boolValue])
    Fail(@"unsupported_folder", @"The smart folder is already deleted", nil);
  if ([plan[@"childFolderCount"] integerValue] != 0)
    Fail(@"unsupported_folder", @"The smart folder has child folders", nil);
  if ([plan[@"physicalNoteCount"] integerValue] != 0)
    Fail(@"unsupported_folder", @"Notes are physically stored in this folder; it is not an empty smart folder",
         nil);
  NSString *revisionBefore = plan[@"revision"];
  if (dryRun) {
    NSMutableDictionary *response = [plan mutableCopy];
    response[@"status"] = @"planned";
    response[@"dryRun"] = @YES;
    response[@"committed"] = @NO;
    return response;
  }
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The smart folder changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});

  SendVoid(folder, "markForDeletion");
  if (!BoolAttr(folder, @"markedForDeletion")) {
    [context rollback];
    Fail(@"save_failed", @"Notes did not mark the folder for deletion; nothing was saved", @{@"committed" : @NO});
  }
  SendVoid1(folder, "updateChangeCountWithReason:", kSmartDeleteReason);
  id account = [folder valueForKey:@"account"];
  id parent = [folder valueForKey:@"parent"];
  NSMutableArray *allowed = [NSMutableArray arrayWithObject:folder];
  if (account) [allowed addObject:account];
  if (parent) [allowed addObject:parent];
  RequireExpectedChanges(context, allowed, [NSSet set]);
  SaveOrFailFor(context, @"folder");

  // Tombstone proof through a new stack: same row, same identity and
  // destination, now marked for deletion, and still empty.
  NSString *problem = nil;
  NSDictionary *after = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    after = FolderState(FetchByIdentifier(fresh, @"ICFolder", identifier), fresh);
    if (![after[@"markedForDeletion"] boolValue])
      problem = @"not marked for deletion";
    else if (![after[@"title"] isEqual:plan[@"title"]] ||
             ![after[@"accountIdentifier"] isEqual:plan[@"accountIdentifier"]] ||
             ![after[@"parentIdentifier"] isEqual:plan[@"parentIdentifier"]])
      problem = @"identity or destination changed";
    else if ([after[@"childFolderCount"] integerValue] || [after[@"physicalNoteCount"] integerValue])
      problem = @"gained contents";
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    problem = e.reason ?: e.name;
  }
  if (problem)
    FailFolderVerification([NSString stringWithFormat:@"Tombstone read-back failed: %@", problem], identifier,
                           revisionBefore);
  NSMutableDictionary *response = [after mutableCopy];
  response[@"status"] = @"deleted";
  response[@"dryRun"] = @NO;
  response[@"committed"] = @YES;
  response[@"verified"] = @YES;
  response[@"revisionBefore"] = revisionBefore;
  response[@"revisionAfter"] = after[@"revision"];
  [response addEntriesFromDictionary:FolderPushFields(store, YES)];
  return response;
}

#pragma mark - Paper authoring

// add_paper appends one drawing to the end of a note as a new attachment:
// a Paper drawing (com.apple.paper), or a classic drawing (com.apple.drawing.2)
// when Paper cannot be created or the caller asks for one. The drawing is built
// from caller strokes as a public PKDrawing and handed to NotesShared, which
// creates the attachment through its own model. Nothing here writes SQL or
// Paper bundle bytes itself.
//
// Paper keeps its drawing in a bundle on disk,
// `Accounts/<account>/Paper/Bundles/<attachment>.bundle`, beside the store.
// Two rules keep the live container safe:
// - On a copy store every ICAccount directory method is redirected beside the
//   copy for the life of the process, so the bundle and any preview land
//   there, never in the live container.
// - Verification of a live Paper write decodes a private temporary copy of the
//   new bundle, so the read-back never opens or checkpoints the live bundle.

#define MAX_AUTHOR_STROKES 4096
#define MAX_AUTHOR_POINTS 100000
#define MAX_AUTHOR_COORDINATE 1000000.0
#define MAX_AUTHOR_WIDTH 8192.0
#define MAX_PAPER_BUNDLE_FILES 2048
#define MAX_PAPER_BUNDLE_BYTES (512LL * 1024 * 1024)

static NSString *const kPaperChangeReason = @"apple-notes-mcp add_paper";
static NSString *const kPaperUTI = @"com.apple.paper";
static NSString *const kInlineDrawingUTI = @"com.apple.drawing.2";
static NSString *const kLegacyDrawingUTI = @"com.apple.drawing";

// Inks whose identifier survives PencilKit's serialization on macOS 27. The
// monoline ink is stored as pen there and the reed ink is not recognized, so
// neither is offered: a stroke must come back as the ink that was asked for.
static const char *const kAuthorInks[] = {"pen", "pencil", "marker", "fountainpen", "watercolor", "crayon"};

// What the read-back needs to decode the saved drawing.
static const APIRequirement kPaperDecodeAPI[] = {
    {"ICSystemPaperDrawingsHelper", "drawingsForAttachment:", YES},
    {"ICAttachment", "typeUTIIsSystemPaper:", YES},
    {"PKDrawing", "strokes", NO},
    {"PKStroke", "path", NO},
};

static const ModelRequirement kPaperModelProperties[] = {
    {"ICAttachment", "identifier,typeUTI,note"},
};

// Every ICAccount method that yields a directory Notes reads or writes
// attachment files under, with the subdirectory it maps to inside a sandbox
// root. All of them are redirected together or not at all.
typedef struct {
  const char *sel;
  const char *suffix;
} AccountDirectory;

static const AccountDirectory kAccountDirectories[] = {
    {"accountFilesDirectoryURL", ""},
    {"accountFilesDirectoryURLInApplicationDataContainer", ""},
    {"systemPaperDirectoryURL", "Paper"},
    {"systemPaperBundlesDirectoryURL", "Paper/Bundles"},
    {"systemPaperTemporaryDirectoryURL", "Paper/Temporary"},
    {"fallbackImageDirectoryURL", "FallbackImages"},
    {"fallbackPDFDirectoryURL", "FallbackPDFs"},
    {"previewImageDirectoryURL", "Previews"},
    {"mediaDirectoryURL", "Media"},
    {"exportableMediaDirectoryURL", "ExportableMedia"},
    {"temporaryDirectoryURL", "Temporary"},
};

// Common to both attachment formats.
static const APIRequirement kPaperWriteAPI[] = {
    {"ICNote", "rangeForAttachment:", NO},
    {"ICNote", "beginEditing", NO},
    {"ICNote", "endEditing", NO},
    {"ICTTAttachment", "setAttachmentIdentifier:", NO},
    {"ICTTAttachment", "setAttachmentUTI:", NO},
    {"ICAttachment", "updateChangeCountWithReason:", NO},
    {"PKDrawing", "initWithStrokes:", NO},
    {"PKStroke", "initWithInk:strokePath:transform:mask:", NO},
    {"PKStrokePath", "initWithControlPoints:creationDate:", NO},
    {"PKStrokePoint", "initWithLocation:timeOffset:size:opacity:force:azimuth:altitude:", NO},
    {"PKInk", "initWithInkType:color:", NO},
};

static const APIRequirement kPaperFormatAPI[] = {
    {"ICPaperAttachmentCreationHelper", "createSystemPaperAttachmentWithPKDrawing:inNote:", YES},
    {"ICAttachment", "paperBundleURL", NO},
};

static const APIRequirement kInlineDrawingFormatAPI[] = {
    {"ICNote", "addInlineDrawingAttachmentWithAnalytics:", NO},
    {"ICAttachment", "setMergeableData:", NO},
    {"ICAttachment", "inlineDrawingModel", NO},
    {"ICAttachmentInlineDrawingModel", "newDrawingFromMergeableData", NO},
};

// Everything add_paper needs except the attachment format itself.
static NSArray<NSString *> *MissingForPaperWrite(void) {
  NSMutableArray *missing = [MissingForFeature(FeatureAppend) mutableCopy];
  if (!gFrameworkLoaded) return missing;
  [missing addObjectsFromArray:MissingAPI(kPaperDecodeAPI, COUNT(kPaperDecodeAPI))];
  [missing addObjectsFromArray:MissingAPI(kPaperWriteAPI, COUNT(kPaperWriteAPI))];
  [missing addObjectsFromArray:MissingModelProperties(kPaperModelProperties, COUNT(kPaperModelProperties))];
  Class account = objc_getClass("ICAccount");
  for (size_t i = 0; i < COUNT(kAccountDirectories); i++)
    if (!account || ![account instancesRespondToSelector:sel_registerName(kAccountDirectories[i].sel)])
      [missing addObject:[NSString stringWithFormat:@"-[ICAccount %s]", kAccountDirectories[i].sel]];
  return [[NSOrderedSet orderedSetWithArray:missing] array];
}

static NSArray<NSString *> *AvailablePaperFormats(void) {
  NSMutableArray *formats = [NSMutableArray array];
  if (!gFrameworkLoaded) return formats;
  if (!MissingAPI(kPaperFormatAPI, COUNT(kPaperFormatAPI)).count) [formats addObject:@"paper"];
  if (!MissingAPI(kInlineDrawingFormatAPI, COUNT(kInlineDrawingFormatAPI)).count) [formats addObject:@"drawing"];
  return formats;
}

static NSDictionary *PaperWriteFeatureReport(BOOL contextOK, NSString *contextReason) {
  NSMutableArray *missing = [MissingForPaperWrite() mutableCopy];
  NSArray *formats = AvailablePaperFormats();
  if (!formats.count && gFrameworkLoaded) {
    [missing addObjectsFromArray:MissingAPI(kPaperFormatAPI, COUNT(kPaperFormatAPI))];
    [missing addObjectsFromArray:MissingAPI(kInlineDrawingFormatAPI, COUNT(kInlineDrawingFormatAPI))];
  }
  if (missing.count)
    return @{@"available" : @NO, @"reason" : @"private_api_unavailable", @"missing" : missing, @"formats" : formats};
  if (!contextOK)
    return @{
      @"available" : @NO,
      @"reason" : contextReason ?: @"store_unavailable",
      @"missing" : @[],
      @"formats" : formats
    };
  return @{@"available" : @YES, @"reason" : [NSNull null], @"missing" : @[], @"formats" : formats};
}

static BOOL IsSafePathComponent(NSString *value) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0 || value.length > 128) return NO;
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_."];
  if ([value rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  return ![value isEqualToString:@"."] && ![value isEqualToString:@".."];
}

static NSString *gSandboxRoot = nil;

static NSURL *SandboxedAccountDirectory(id self, SEL _cmd) {
  NSString *account = nil;
  @try {
    account = [self valueForKey:@"identifier"];
  } @catch (NSException *e) {
    account = nil;
  }
  // Called from inside NotesShared, so this cannot throw a HelperError. An
  // unsafe identifier maps to a directory that cannot collide with a real
  // account, which makes the caller fail rather than escape the sandbox.
  NSString *component = IsSafePathComponent(account) ? account : @"invalid-account";
  NSString *suffix = @"";
  for (size_t i = 0; i < COUNT(kAccountDirectories); i++)
    if (sel_isEqual(_cmd, sel_registerName(kAccountDirectories[i].sel))) suffix = @(kAccountDirectories[i].suffix);
  NSString *path = [[[gSandboxRoot stringByAppendingPathComponent:@"Accounts"] stringByAppendingPathComponent:component]
      stringByAppendingPathComponent:suffix];
  [NSFileManager.defaultManager createDirectoryAtPath:path
                          withIntermediateDirectories:YES
                                           attributes:@{NSFilePosixPermissions : @0700}
                                                error:NULL];
  return [NSURL fileURLWithPath:path isDirectory:YES];
}

// Points every ICAccount directory at `root` for the rest of this process.
// Resolves every method before replacing the first: a partial redirect could
// leave one path pointing into the live Notes container.
static void InstallAccountSandbox(NSString *root) {
  if (gSandboxRoot) {
    if (![gSandboxRoot isEqualToString:root])
      Fail(@"internal_error", @"The account sandbox is already installed elsewhere", @{@"committed" : @NO});
    return;
  }
  Class account = objc_getClass("ICAccount");
  Method methods[COUNT(kAccountDirectories)];
  for (size_t i = 0; i < COUNT(kAccountDirectories); i++) {
    methods[i] = account ? class_getInstanceMethod(account, sel_registerName(kAccountDirectories[i].sel)) : NULL;
    if (!methods[i])
      Fail(@"private_api_unavailable", @"An ICAccount directory method is missing; refusing to run unsandboxed",
           @{@"missing" : @[ @(kAccountDirectories[i].sel) ], @"committed" : @NO});
  }
  gSandboxRoot = [root copy];
  for (size_t i = 0; i < COUNT(kAccountDirectories); i++)
    method_setImplementation(methods[i], (IMP)SandboxedAccountDirectory);
}

// A private 0700 temporary directory, removed by the caller.
static NSString *MakePrivateTempDir(NSString *prefix) {
  NSString *template =
      [NSTemporaryDirectory() stringByAppendingPathComponent:[prefix stringByAppendingString:@".XXXXXX"]];
  char *buffer = strdup(template.fileSystemRepresentation);
  char *made = mkdtemp(buffer);
  NSString *path =
      made ? [NSFileManager.defaultManager stringWithFileSystemRepresentation:made length:strlen(made)] : nil;
  free(buffer);
  if (!path) Fail(@"internal_error", @"Could not create a private temporary directory", nil);
  chmod(path.fileSystemRepresentation, 0700);
  return path;
}

// Size and modification time of every regular file in a bundle, refusing
// links and anything that is not a regular file or directory.
static NSDictionary *BundleSignature(NSString *bundle) {
  NSMutableDictionary *signature = [NSMutableDictionary dictionary];
  long long total = 0;
  NSDirectoryEnumerator *walker = [NSFileManager.defaultManager enumeratorAtPath:bundle];
  for (NSString *relative in walker) {
    NSDictionary *attrs = walker.fileAttributes;
    NSString *type = attrs.fileType;
    if ([type isEqualToString:NSFileTypeDirectory]) continue;
    if (![type isEqualToString:NSFileTypeRegular])
      Fail(@"unsupported_attachment", @"The Paper bundle contains a link or special file", nil);
    total += (long long)attrs.fileSize;
    if (signature.count >= MAX_PAPER_BUNDLE_FILES || total > MAX_PAPER_BUNDLE_BYTES)
      Fail(@"unsupported_attachment", @"The Paper bundle exceeds the writer's size limits", nil);
    signature[relative] =
        [NSString stringWithFormat:@"%llu:%.6f", attrs.fileSize, attrs.fileModificationDate.timeIntervalSince1970];
  }
  return signature;
}

// Copies one Paper bundle from the store's container into the sandbox. The
// bundle directory must sit exactly at Accounts/<account>/Paper/Bundles/ under
// the store's directory with no link on the way, and must be unchanged across
// the copy (Notes may be writing it); a moving bundle is retried, then refused.
static void SnapshotPaperBundle(NSString *storePath, NSString *account, NSString *attachment, NSString *sandbox) {
  if (!IsSafePathComponent(account) || !IsSafePathComponent(attachment))
    Fail(@"unsupported_attachment", @"The attachment's account or identifier is not a safe path component", nil);
  NSString *relative = [NSString stringWithFormat:@"Accounts/%@/Paper/Bundles/%@.bundle", account, attachment];
  NSString *containerDir = [[storePath stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath];
  NSString *source = [containerDir stringByAppendingPathComponent:relative];
  if (![[source stringByResolvingSymlinksInPath] isEqualToString:source])
    Fail(@"unsupported_attachment", @"The Paper bundle path contains a link", nil);
  BOOL isDir = NO;
  if (![NSFileManager.defaultManager fileExistsAtPath:source isDirectory:&isDir] || !isDir)
    Fail(@"bundle_unavailable", @"The new Paper bundle is not where NotesShared keeps it", nil);
  NSString *destination = [sandbox stringByAppendingPathComponent:relative];
  [NSFileManager.defaultManager createDirectoryAtPath:[destination stringByDeletingLastPathComponent]
                          withIntermediateDirectories:YES
                                           attributes:@{NSFilePosixPermissions : @0700}
                                                error:NULL];
  for (int attempt = 0; attempt < 3; attempt++) {
    NSDictionary *before = BundleSignature(source);
    [NSFileManager.defaultManager removeItemAtPath:destination error:NULL];
    NSError *error = nil;
    if (![NSFileManager.defaultManager copyItemAtPath:source toPath:destination error:&error])
      Fail(@"bundle_unavailable", @"Could not copy the Paper bundle", @{@"detail" : OrNull(error.localizedDescription)});
    if ([before isEqualToDictionary:BundleSignature(source)]) return;
    usleep(200000);
  }
  Fail(@"store_busy", @"The Paper bundle kept changing while it was copied", nil);
}

static BOOL IsPaperAttachment(NSManagedObject *attachment) {
  NSString *uti = [attachment valueForKey:@"typeUTI"];
  return [uti isKindOfClass:[NSString class]] && [uti isEqualToString:kPaperUTI] &&
         ((BOOL(*)(id, SEL, id))objc_msgSend)(objc_getClass("ICAttachment"), sel_registerName("typeUTIIsSystemPaper:"),
                                              uti);
}

static BOOL IsInlineDrawingAttachment(NSManagedObject *attachment) {
  NSString *uti = [attachment valueForKey:@"typeUTI"];
  return [uti isKindOfClass:[NSString class]] &&
         ([uti isEqualToString:kInlineDrawingUTI] || [uti isEqualToString:kLegacyDrawingUTI]);
}

// A classic drawing keeps its PKDrawing in the attachment's mergeable data in
// the store; its inline drawing model deserializes it.
static PKDrawing *InlineDrawingForAttachment(NSManagedObject *attachment) {
  SEL drawingSel = sel_registerName("newDrawingFromMergeableData");
  id model = [attachment respondsToSelector:sel_registerName("inlineDrawingModel")]
                 ? Send(attachment, "inlineDrawingModel")
                 : nil;
  if (!model || ![model respondsToSelector:drawingSel])
    Fail(@"private_api_unavailable", @"The inline drawing model cannot deserialize its drawing",
         @{@"missing" : @[ @"-[ICAttachmentInlineDrawingModel newDrawingFromMergeableData]" ]});
  id drawing = ((id(*)(id, SEL))objc_msgSend)(model, drawingSel);
  return [drawing isKindOfClass:[PKDrawing class]] ? drawing : nil;
}

static NSArray<PKDrawing *> *DrawingsForAttachment(NSManagedObject *attachment) {
  if (IsInlineDrawingAttachment(attachment)) {
    PKDrawing *drawing = InlineDrawingForAttachment(attachment);
    return drawing ? @[ drawing ] : @[];
  }
  if (!IsPaperAttachment(attachment)) return @[];
  id value = ((id(*)(id, SEL, id))objc_msgSend)(objc_getClass("ICSystemPaperDrawingsHelper"),
                                                sel_registerName("drawingsForAttachment:"), attachment);
  if ([value isKindOfClass:[PKDrawing class]]) return @[ value ];
  if (![value isKindOfClass:[NSArray class]]) return @[];
  NSMutableArray *drawings = [NSMutableArray array];
  for (id item in value)
    if ([item isKindOfClass:[PKDrawing class]]) [drawings addObject:item];
  return drawings;
}

static double Round4(double value) { return round(value * 10000.0) / 10000.0; }

static NSArray *RectArray(CGRect rect) {
  if (CGRectIsNull(rect) || CGRectIsInfinite(rect)) return @[ @0, @0, @0, @0 ];
  return @[ @(Round4(rect.origin.x)), @(Round4(rect.origin.y)), @(Round4(rect.size.width)), @(Round4(rect.size.height)) ];
}

static BOOL IsJSONNumber(id value) {
  return [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
         isfinite([value doubleValue]);
}

static double NumberIn(id value, double lo, double hi, NSString *what) {
  if (!IsJSONNumber(value) || [value doubleValue] < lo || [value doubleValue] > hi)
    Fail(@"invalid_request", [NSString stringWithFormat:@"%@ must be a finite number from %g to %g", what, lo, hi],
         @{@"committed" : @NO});
  return [value doubleValue];
}

static PKStrokePoint *AuthorPoint(CGPoint location, NSUInteger index, double width) {
  return [[PKStrokePoint alloc] initWithLocation:location
                                      timeOffset:0.01 * (double)index
                                            size:CGSizeMake(width, width)
                                         opacity:1
                                           force:1
                                         azimuth:0
                                        altitude:M_PI_2];
}

// Validates the normalized drawing and builds the PKDrawing. Every stroke is
// {ink, color: [r,g,b,a] 0..1, width, points: [[x,y] or [x,y,width], ...]}.
// Nothing is inferred: a missing or malformed field is an error. Runs before
// the store is opened, so every refusal here has committed: false.
static PKDrawing *DrawingFromSpec(id spec, NSUInteger *pointsOut, NSMutableSet *inksOut) {
  NSDictionary *notCommitted = @{@"committed" : @NO};
  if (![spec isKindOfClass:[NSDictionary class]]) Fail(@"invalid_request", @"`drawing` must be an object", notCommitted);
  for (NSString *key in spec)
    if (![key isEqualToString:@"strokes"])
      Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown drawing field `%@`", key], notCommitted);
  NSArray *strokes = spec[@"strokes"];
  if (![strokes isKindOfClass:[NSArray class]] || strokes.count == 0 || strokes.count > MAX_AUTHOR_STROKES)
    Fail(@"invalid_request", @"`drawing.strokes` must hold 1 to 4096 strokes", notCommitted);
  NSMutableArray<PKStroke *> *pkStrokes = [NSMutableArray array];
  NSUInteger totalPoints = 0;
  NSDate *created = [NSDate date];
  for (id stroke in strokes) {
    if (![stroke isKindOfClass:[NSDictionary class]])
      Fail(@"invalid_request", @"Each stroke must be an object", notCommitted);
    for (NSString *key in stroke)
      if (![@[ @"ink", @"color", @"width", @"points" ] containsObject:key])
        Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown stroke field `%@`", key], notCommitted);
    NSString *ink = stroke[@"ink"];
    BOOL knownInk = NO;
    for (size_t i = 0; i < COUNT(kAuthorInks); i++)
      if ([ink isKindOfClass:[NSString class]] && [ink isEqualToString:@(kAuthorInks[i])]) knownInk = YES;
    if (!knownInk) Fail(@"invalid_request", @"Stroke `ink` is not a supported ink name", notCommitted);
    NSArray *color = stroke[@"color"];
    if (![color isKindOfClass:[NSArray class]] || color.count != 4)
      Fail(@"invalid_request", @"Stroke `color` must be [r, g, b, a] from 0 to 1", notCommitted);
    double rgba[4];
    for (int i = 0; i < 4; i++) rgba[i] = NumberIn(color[i], 0, 1, @"A color channel");
    double width = NumberIn(stroke[@"width"], 0.01, MAX_AUTHOR_WIDTH, @"Stroke `width`");
    NSArray *points = stroke[@"points"];
    if (![points isKindOfClass:[NSArray class]] || points.count == 0)
      Fail(@"invalid_request", @"Stroke `points` must be a non-empty array", notCommitted);
    totalPoints += points.count;
    if (totalPoints > MAX_AUTHOR_POINTS)
      Fail(@"invalid_request", @"The drawing has more than 100000 points", notCommitted);
    NSMutableArray<PKStrokePoint *> *pkPoints = [NSMutableArray arrayWithCapacity:points.count + 1];
    for (id point in points) {
      if (![point isKindOfClass:[NSArray class]] || ([point count] != 2 && [point count] != 3))
        Fail(@"invalid_request", @"Each point must be [x, y] or [x, y, width]", notCommitted);
      double x = NumberIn(point[0], -MAX_AUTHOR_COORDINATE, MAX_AUTHOR_COORDINATE, @"A point coordinate");
      double y = NumberIn(point[1], -MAX_AUTHOR_COORDINATE, MAX_AUTHOR_COORDINATE, @"A point coordinate");
      double w = [point count] == 3 ? NumberIn(point[2], 0.01, MAX_AUTHOR_WIDTH, @"A point width") : width;
      [pkPoints addObject:AuthorPoint(CGPointMake(x, y), pkPoints.count, w)];
    }
    // A single point becomes a dot: PencilKit needs two samples to draw it.
    if (pkPoints.count == 1) [pkPoints addObject:AuthorPoint(pkPoints[0].location, 1, pkPoints[0].size.width)];
    NSColor *nsColor = [NSColor colorWithSRGBRed:rgba[0] green:rgba[1] blue:rgba[2] alpha:rgba[3]];
    PKInk *pkInk = [[PKInk alloc] initWithInkType:[@"com.apple.ink." stringByAppendingString:ink] color:nsColor];
    PKStrokePath *path = [[PKStrokePath alloc] initWithControlPoints:pkPoints creationDate:created];
    [pkStrokes addObject:[[PKStroke alloc] initWithInk:pkInk
                                            strokePath:path
                                             transform:CGAffineTransformIdentity
                                                  mask:nil]];
    [inksOut addObject:ink];
  }
  PKDrawing *drawing = [[PKDrawing alloc] initWithStrokes:pkStrokes];
  if (drawing.strokes.count != pkStrokes.count)
    Fail(@"invalid_request", @"PencilKit did not accept every stroke", notCommitted);
  // What Notes stores is the serialized drawing: every ink must survive it.
  PKDrawing *roundTrip = [[PKDrawing alloc] initWithData:drawing.dataRepresentation error:NULL];
  if (roundTrip.strokes.count != pkStrokes.count)
    Fail(@"invalid_request", @"The drawing did not survive PencilKit serialization", notCommitted);
  for (NSUInteger i = 0; i < pkStrokes.count; i++)
    if (![roundTrip.strokes[i].ink.inkType isEqualToString:pkStrokes[i].ink.inkType])
      Fail(@"invalid_request",
           [NSString stringWithFormat:@"PencilKit on this macOS stores the %@ ink as %@", pkStrokes[i].ink.inkType,
                                      roundTrip.strokes[i].ink.inkType],
           notCommitted);
  NSUInteger built = 0;
  for (PKStroke *s in drawing.strokes) built += s.path.count;
  *pointsOut = built;
  return drawing;
}

static NSUInteger PointTotal(NSArray<PKDrawing *> *drawings, NSUInteger *strokesOut) {
  NSUInteger points = 0, strokes = 0;
  for (PKDrawing *d in drawings)
    for (PKStroke *s in d.strokes) {
      strokes++;
      points += s.path.count;
    }
  *strokesOut = strokes;
  return points;
}

// Older Notes clients read these flags to know a drawing uses newer inks.
static void SetInkFlags(id attachment, NSSet *inks) {
  id model =
      [attachment respondsToSelector:sel_registerName("paperBundleModel")] ? Send(attachment, "paperBundleModel") : nil;
  if (!model) return;
  void (^flag)(const char *) = ^(const char *sel) {
    if ([model respondsToSelector:sel_registerName(sel)])
      ((void (*)(id, SEL, BOOL))objc_msgSend)(model, sel_registerName(sel), YES);
  };
  if ([inks containsObject:@"fountainpen"]) flag("setPaperHasNewInks2022:");
  if ([inks containsObject:@"watercolor"] || [inks containsObject:@"crayon"]) flag("setPaperHasNewInks2023:");
}

// Best effort: Notes regenerates previews itself, so a failure here is only
// reported, never fatal.
static BOOL UpdatePreview(id attachment, PKDrawing *drawing) {
  SEL sel = sel_registerName(
      "updateAttachmentPreviewImageWithImageData:size:scale:appearanceType:scaleWhenDrawing:metadata:"
      "sendNotification:");
  if (![attachment respondsToSelector:sel]) return NO;
  CGRect bounds = CGRectInset(drawing.bounds, -4, -4);
  if (CGRectIsEmpty(bounds) || bounds.size.width > 8192 || bounds.size.height > 8192) return NO;
  NSImage *image = [drawing imageFromRect:bounds scale:2.0];
  CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
  if (!cg) return NO;
  NSData *png = [[[NSBitmapImageRep alloc] initWithCGImage:cg] representationUsingType:NSBitmapImageFileTypePNG
                                                                             properties:@{}];
  if (!png.length) return NO;
  @try {
    id preview = ((id(*)(id, SEL, id, CGSize, double, unsigned long long, BOOL, id, BOOL))objc_msgSend)(
        attachment, sel, png, bounds.size, 2.0, 0ULL, YES, nil, NO);
    if (preview && [preview respondsToSelector:sel_registerName("updateChangeCountWithReason:")])
      ((void (*)(id, SEL, id))objc_msgSend)(preview, sel_registerName("updateChangeCountWithReason:"),
                                            kPaperChangeReason);
    return preview != nil;
  } @catch (NSException *e) {
    return NO;
  }
}

static NSRange AttachmentRange(id note, id attachment) {
  return ((NSRange(*)(id, SEL, id))objc_msgSend)(note, sel_registerName("rangeForAttachment:"), attachment);
}

// Appends the attachment's U+FFFC glyph as the note's last paragraph. A new
// attachment is invisible in Notes until its glyph is in the note text.
// Returns the UTF-16 length inserted (0 when NotesShared already placed it).
static NSUInteger PlaceGlyph(id note, id attachment) {
  NSRange existing = AttachmentRange(note, attachment);
  if (existing.location != NSNotFound && existing.length) return 0;
  id ms = Send(note, "mergeableString");
  NSAttributedString *text = ms ? Send(ms, "attributedString") : nil;
  if (![text isKindOfClass:[NSAttributedString class]])
    Fail(@"unsupported_note", @"The note body could not be loaded as a mergeable string", @{@"committed" : @NO});
  id tt = [objc_getClass("ICTTAttachment") new];
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentIdentifier:"),
                                        [attachment valueForKey:@"identifier"]);
  ((void (*)(id, SEL, id))objc_msgSend)(tt, sel_registerName("setAttachmentUTI:"), [attachment valueForKey:@"typeUTI"]);
  NSMutableAttributedString *insertion = [NSMutableAttributedString new];
  NSAttributedString *separator = SeparatorFor(text);
  if (separator) [insertion appendAttributedString:separator];
  [insertion appendAttributedString:[[NSAttributedString alloc] initWithString:@"￼"
                                                                    attributes:@{@"NSAttachment" : tt}]];
  NSUInteger at = text.length;
  SendVoid(ms, "beginEditing");
  ((void (*)(id, SEL, id, NSUInteger))objc_msgSend)(ms, sel_registerName("insertAttributedString:atIndex:"), insertion,
                                                    at);
  SendVoid(ms, "endEditing");
  ((void (*)(id, SEL, NSUInteger, NSRange, NSInteger))objc_msgSend)(
      note, sel_registerName("edited:range:changeInLength:"), NSTextStorageEditedCharacters,
      NSMakeRange(at, insertion.length), (NSInteger)insertion.length);
  return insertion.length;
}

// The saved text is the previous text plus exactly the new glyph: appended
// with its separator when the writer placed it (`inserted` UTF-16 units), or,
// when NotesShared placed it, with that one glyph (and at most one newline
// beside it) removed, nothing else differs.
static BOOL PaperBodyKeptExceptGlyph(NSString *after, NSString *before, NSUInteger glyph, NSUInteger inserted) {
  if (!before || glyph >= after.length) return NO;
  if (inserted) {
    NSString *added = inserted == 2 ? @"\n\uFFFC" : @"\uFFFC";
    return inserted <= 2 && glyph == after.length - 1 &&
           [after isEqualToString:[before stringByAppendingString:added]];
  }
  NSMutableString *without = [after mutableCopy];
  [without deleteCharactersInRange:NSMakeRange(glyph, 1)];
  if ([without isEqualToString:before]) return YES;
  for (NSInteger offset = -1; offset <= 0; offset++) {
    NSInteger at = (NSInteger)glyph + offset;
    if (at < 0 || (NSUInteger)at >= without.length || [without characterAtIndex:(NSUInteger)at] != '\n') continue;
    NSMutableString *trimmed = [without mutableCopy];
    [trimmed deleteCharactersInRange:NSMakeRange((NSUInteger)at, 1)];
    if ([trimmed isEqualToString:before]) return YES;
  }
  return NO;
}

// Decode the persisted drawing for verification. A live Paper bundle is read
// from a private copy; on a copy store the sandbox already points beside it.
static NSArray<PKDrawing *> *VerifiedDrawings(NSManagedObject *attachment, StoreLocation store, NSString *accountId) {
  if (!IsPaperAttachment(attachment) || store.isCopy) return DrawingsForAttachment(attachment);
  NSString *sandbox = MakePrivateTempDir(@"apple-notes-paper-verify");
  @try {
    SnapshotPaperBundle(store.path, accountId, [attachment valueForKey:@"identifier"], sandbox);
    InstallAccountSandbox(sandbox);
    return DrawingsForAttachment(attachment);
  } @finally {
    [NSFileManager.defaultManager removeItemAtPath:sandbox error:NULL];
  }
}

static NSDictionary *HandleAddPaper(NSDictionary *request) {
  gWriteRequest = YES;
  NSDictionary *notCommitted = @{@"committed" : @NO};
  NSString *identifier = RequireIdentifier(request);
  NSString *ifRevision = RequireString(request, @"ifRevision");
  id dryValue = request[@"dryRun"];
  if (dryValue && CFGetTypeID((__bridge CFTypeRef)dryValue) != CFBooleanGetTypeID())
    Fail(@"invalid_request", @"`dryRun` must be a boolean", notCommitted);
  BOOL dryRun = [dryValue boolValue];
  NSString *format = request[@"format"] ?: @"auto";
  if (![format isKindOfClass:[NSString class]] || ![@[ @"auto", @"paper", @"drawing" ] containsObject:format])
    Fail(@"invalid_request", @"`format` must be auto, paper, or drawing", notCommitted);
  LoadFramework();
  NSArray *missing = MissingForPaperWrite();
  if (missing.count)
    Fail(@"private_api_unavailable", @"Required NotesShared or PencilKit API is not available on this macOS",
         @{@"missing" : missing, @"committed" : @NO});
  NSArray *formats = AvailablePaperFormats();
  NSString *chosen = [format isEqualToString:@"auto"] ? formats.firstObject : format;
  if (!chosen || ![formats containsObject:chosen])
    Fail(@"private_api_unavailable", @"That attachment format cannot be created on this macOS",
         @{@"availableFormats" : formats, @"committed" : @NO});

  NSUInteger inputPoints = 0;
  NSMutableSet *inks = [NSMutableSet set];
  PKDrawing *drawing = DrawingFromSpec(request[@"drawing"], &inputPoints, inks);

  StoreLocation store = ResolveStore();
  // On a copy store every file NotesShared writes (bundle, previews) goes
  // beside the copy, never into the live container.
  if (store.isCopy) InstallAccountSandbox([store.path stringByDeletingLastPathComponent]);
  // A dry run opens read-only. A write opens read-write, which OpenContext
  // allows on the live store only with APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1.
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  NSManagedObject *note = FetchNote(context, identifier);
  RequireAppendableNote(note);
  NSString *revisionBefore = RevisionToken(note);
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});
  id account = [note valueForKey:@"account"];
  NSString *accountId = account ? [account valueForKey:@"identifier"] : nil;
  NSString *bodyBefore = [BodyText(Send(note, "mergeableString")) copy];
  NSDictionary *plan = @{
    @"format" : chosen,
    @"availableFormats" : formats,
    @"strokeCount" : @(drawing.strokes.count),
    @"pointCount" : @(inputPoints),
    @"inks" : [[inks allObjects] sortedArrayUsingSelector:@selector(compare:)],
    @"bounds" : RectArray(drawing.bounds),
    @"revisionBefore" : revisionBefore,
    @"storeKind" : store.isCopy ? @"copy" : @"live",
  };
  if (dryRun) {
    NSMutableDictionary *out = [plan mutableCopy];
    out[@"status"] = @"planned";
    out[@"committed"] = @NO;
    return out;
  }

  id attachment = nil;
  NSString *bundlePath = nil;
  BOOL previewUpdated = NO;
  NSUInteger glyphLength = 0;
  @try {
    SendVoid(note, "beginEditing");
    if ([chosen isEqualToString:@"paper"]) {
      attachment = ((id(*)(id, SEL, id, id))objc_msgSend)(
          objc_getClass("ICPaperAttachmentCreationHelper"),
          sel_registerName("createSystemPaperAttachmentWithPKDrawing:inNote:"), drawing, note);
      NSURL *url = attachment ? Send(attachment, "paperBundleURL") : nil;
      bundlePath = [url isKindOfClass:[NSURL class]] ? url.path : nil;
      SetInkFlags(attachment, inks);
    } else {
      attachment =
          ((id(*)(id, SEL, BOOL))objc_msgSend)(note, sel_registerName("addInlineDrawingAttachmentWithAnalytics:"), NO);
      if (attachment)
        ((void (*)(id, SEL, id))objc_msgSend)(attachment, sel_registerName("setMergeableData:"),
                                              drawing.dataRepresentation);
    }
    if (!attachment) Fail(@"save_failed", @"NotesShared did not create the attachment", notCommitted);
    glyphLength = PlaceGlyph(note, attachment);
    SendVoid(note, "endEditing");
    previewUpdated = UpdatePreview(attachment, drawing);
    ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(note, sel_registerName("regenerateTitle:snippet:"), YES, YES);
    if (!SendBool(note, "saveNoteData"))
      Fail(@"save_failed", @"NotesShared did not serialize the edited body", notCommitted);
    [note setValue:[NSDate date] forKey:@"modificationDate"];
    // Bumps both cloud states so Notes treats the note and the new attachment
    // as needing upload.
    ((void (*)(id, SEL, id))objc_msgSend)(attachment, sel_registerName("updateChangeCountWithReason:"),
                                          kPaperChangeReason);
    ((void (*)(id, SEL, id))objc_msgSend)(note, sel_registerName("updateChangeCountWithReason:"), kPaperChangeReason);
    SaveOrFail(context);
  } @catch (NSException *e) {
    // Nothing reached the store (the save was never tried, or it failed and
    // rolled back): remove the bundle NotesShared already wrote, and only when
    // it sits exactly where a Paper bundle belongs.
    BOOL nothingSaved = !gSaveAttempted || ([e isKindOfClass:[HelperError class]] &&
                                            [e.userInfo[@"committed"] isEqual:@NO]);
    if (nothingSaved && bundlePath && [bundlePath hasSuffix:@".bundle"] &&
        [[bundlePath stringByDeletingLastPathComponent] hasSuffix:@"/Paper/Bundles"])
      [NSFileManager.defaultManager removeItemAtPath:bundlePath error:NULL];
    @throw;
  }

  // Fresh read-back through a brand-new read-only coordinator: the note owns
  // the attachment, its glyph is in the saved text, and the drawing decodes
  // to the same number of strokes and points.
  NSString *attachmentId = [attachment valueForKey:@"identifier"];
  NSString *typeUTI = [attachment valueForKey:@"typeUTI"];
  NSDictionary *after = nil;
  NSUInteger decodedStrokes = 0, decodedPoints = 0;
  NSString *verifyDetail = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSFetchRequest *fetch = [NSFetchRequest fetchRequestWithEntityName:@"ICAttachment"];
    fetch.predicate = [NSPredicate predicateWithFormat:@"identifier == %@", attachmentId];
    NSManagedObject *freshAttachment = [[fresh executeFetchRequest:fetch error:NULL] firstObject];
    NSAttributedString *persisted = BodyAttributedString(reread);
    if (!freshAttachment || [freshAttachment valueForKey:@"note"] != reread)
      verifyDetail = @"The new attachment is not attached to the note after saving";
    else if (AttachmentRange(reread, freshAttachment).location == NSNotFound)
      verifyDetail = @"The attachment glyph is not in the saved note text";
    else if (!persisted || GlyphCountFor(persisted, attachmentId) != 1)
      verifyDetail = @"The attachment glyph is not in the saved note text exactly once";
    else if (!PaperBodyKeptExceptGlyph(persisted.string, bodyBefore, AttachmentRange(reread, freshAttachment).location,
                                       glyphLength))
      verifyDetail = @"The saved note text differs from the previous text by more than the new glyph";
    else {
      decodedPoints = PointTotal(VerifiedDrawings(freshAttachment, store, accountId), &decodedStrokes);
      if (decodedStrokes != drawing.strokes.count || decodedPoints != inputPoints)
        verifyDetail = [NSString
            stringWithFormat:@"Decoded %lu strokes / %lu points, expected %lu / %lu", (unsigned long)decodedStrokes,
                             (unsigned long)decodedPoints, (unsigned long)drawing.strokes.count,
                             (unsigned long)inputPoints];
    }
    after = NoteState(reread);
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    verifyDetail = e.reason ?: e.name;
  }
  if (verifyDetail)
    Fail(@"verification_failed", verifyDetail,
         @{@"committed" : @YES, @"attachmentIdentifier" : OrNull(attachmentId), @"revisionBefore" : revisionBefore});

  BOOL hostRunning = NotesAppRunning();
  NSMutableDictionary *out = [plan mutableCopy];
  [out addEntriesFromDictionary:@{
    @"status" : @"created",
    @"committed" : @YES,
    @"verified" : @YES,
    @"identifier" : identifier,
    @"attachmentIdentifier" : attachmentId,
    @"typeUTI" : OrNull(typeUTI),
    @"decodedStrokeCount" : @(decodedStrokes),
    @"decodedPointCount" : @(decodedPoints),
    @"glyphInserted" : @((BOOL)(glyphLength > 0)),
    @"previewUpdated" : @(previewUpdated),
    @"revisionAfter" : after[@"revision"],
    @"modificationDate" : after[@"modificationDate"],
    @"cloudSync" : after[@"cloudSync"],
    // The writer never uploads; see HandleAppendPlainText.
    @"pushScheduled" : @NO,
    @"syncHostRunning" : @(hostRunning),
    @"pushState" : hostRunning ? @"awaiting_notes_app" : @"queued_for_next_launch",
  }];
  return out;
}

#pragma mark - Scope guards

// Folder preconditions on a write (#57), with the same shapes and meaning as
// the server's AppleScript scope guards (src/utils/scopeGuard.ts):
//
// - ifFolderId: the subject's folder is exactly this folder;
// - ifAncestorFolderId: this folder is the subject's folder or an ancestor;
// - forbiddenAncestorFolderIds: none of these is the subject's folder or an
//   ancestor, and none is on the destination's chain when the write moves the
//   note (repair_purge_flag moves it to Recently Deleted).
//
// The subject is the note a write changes, or for smart folders the folder
// itself (its folder is its parent; a forbidden id may also name the smart
// folder), or for create_smart_folder the destination parent.
//
// Every id must resolve to an existing folder in this store, and a forbidden
// folder must not be deleted: an id that does not resolve refuses the write
// (scope_folder_not_found) instead of silently matching nothing.
//
// A write evaluates the guard in its own context right before the save
// (EnforceScopeGuard, called by every save). The note's folder is the value
// the write read, which the save's optimistic locking protects; every folder
// above it is re-read from the store at that moment. A call that ends without
// saving (a dry run, a no-op, a plan) evaluates it in a fresh read-only
// context before it answers, so a plan reports a scope failure too.

#define MAX_FORBIDDEN_FOLDERS 50
#define MAX_SCOPE_DEPTH 64

typedef NS_ENUM(NSInteger, ScopeSubject) {
  ScopeSubjectNone,
  ScopeSubjectNote,
  ScopeSubjectFolder,
  ScopeSubjectNewFolder,
};

typedef struct {
  const char *action;
  ScopeSubject subject;
} ScopeGuardedAction;

// Every action that writes (or plans a write to) a note or folder. The
// source test requires every write action to be listed here.
static const ScopeGuardedAction kScopeGuardedActions[] = {
    {"append_plain_text", ScopeSubjectNote},
    {"plan_edit", ScopeSubjectNote},
    {"edit_note", ScopeSubjectNote},
    {"compose_note", ScopeSubjectNote},
    {"set_checklist_item", ScopeSubjectNote},
    {"set_highlight", ScopeSubjectNote},
    {"add_url_card", ScopeSubjectNote},
    {"set_paragraph_id", ScopeSubjectNote},
    {"add_section_link", ScopeSubjectNote},
    {"delete_table_row", ScopeSubjectNote},
    {"insert_table_row", ScopeSubjectNote},
    {"set_table_cell", ScopeSubjectNote},
    {"prune_orphan_table", ScopeSubjectNote},
    {"add_paper", ScopeSubjectNote},
    {"repair_purge_flag", ScopeSubjectNote},
    {"create_smart_folder", ScopeSubjectNewFolder},
    {"update_smart_folder", ScopeSubjectFolder},
    {"delete_smart_folder", ScopeSubjectFolder},
};

static NSDictionary *gScopeRequest = nil;  // the request, when it carries a guard
static ScopeSubject gScopeSubject = ScopeSubjectNone;
static BOOL gScopeEnforced = NO;  // a save already evaluated the guard

static ScopeSubject ScopeSubjectForAction(NSString *action) {
  for (size_t i = 0; i < COUNT(kScopeGuardedActions); i++)
    if ([action isEqualToString:@(kScopeGuardedActions[i].action)]) return kScopeGuardedActions[i].subject;
  return ScopeSubjectNone;
}

static NSArray<NSString *> *ScopeGuardKeys(void) {
  return @[ @"ifFolderId", @"ifAncestorFolderId", @"forbiddenAncestorFolderIds" ];
}

static BOOL IsFolderURI(id value) {
  static NSRegularExpression *re;
  if (!re)
    re = [NSRegularExpression regularExpressionWithPattern:@"^x-coredata://[0-9A-Fa-f-]+/ICFolder/p[0-9]+$"
                                                   options:0
                                                     error:nil];
  return [value isKindOfClass:[NSString class]] && [value length] <= 256 &&
         [re numberOfMatchesInString:value options:0 range:NSMakeRange(0, [value length])] == 1;
}

// Validates the guard fields and remembers them for EnforceScopeGuard. A
// request without any guard leaves nothing to check.
static void ParseScopeGuard(NSDictionary *request, ScopeSubject subject) {
  BOOL any = NO;
  for (NSString *key in @[ @"ifFolderId", @"ifAncestorFolderId" ]) {
    if (!request[key]) continue;
    if (!IsFolderURI(request[key]))
      Fail(@"invalid_request", [NSString stringWithFormat:@"`%@` must be an x-coredata folder id", key],
           @{@"committed" : @NO});
    any = YES;
  }
  id forbidden = request[@"forbiddenAncestorFolderIds"];
  if (forbidden) {
    if (![forbidden isKindOfClass:[NSArray class]] || [forbidden count] > MAX_FORBIDDEN_FOLDERS)
      Fail(@"invalid_request", @"`forbiddenAncestorFolderIds` must be an array of at most 50 folder ids",
           @{@"committed" : @NO});
    for (id value in forbidden)
      if (!IsFolderURI(value))
        Fail(@"invalid_request", @"Every forbiddenAncestorFolderIds entry must be an x-coredata folder id",
             @{@"committed" : @NO});
    if ([forbidden count]) any = YES;
  }
  if (!any) return;
  NSArray *missing = MissingForFeature(FeatureScopeGuards);
  if (missing.count)
    Fail(@"private_api_unavailable", @"Scope guards need NotesShared model properties missing on this macOS",
         @{@"missing" : missing, @"committed" : @NO});
  gScopeRequest = request;
  gScopeSubject = subject;
}

static NSString *ScopeNoun(void) { return gScopeSubject == ScopeSubjectNote ? @"note" : @"smart folder"; }

static void ScopeFail(NSManagedObjectContext *writing, NSString *code, NSString *scopeReason, NSString *reason) {
  if (writing) [writing rollback];
  Fail(code,
       [NSString stringWithFormat:@"Scope guard failed: %@. Nothing was changed; read the %@'s current folder "
                                  @"and review before retrying.",
                                  reason, ScopeNoun()],
       @{@"committed" : @NO, @"scopeReason" : scopeReason});
}

// An existing folder for a guard id, or a refusal. A forbidden folder must
// also not be deleted: guarding against a folder that is gone is a stale id.
static NSManagedObjectID *ResolveScopeFolder(NSManagedObjectContext *context, NSManagedObjectContext *writing,
                                             NSString *uri, NSString *field, BOOL forbidden) {
  NSManagedObjectID *objectID = nil;
  @try {
    NSURL *url = [NSURL URLWithString:uri];
    objectID = url ? [context.persistentStoreCoordinator managedObjectIDForURIRepresentation:url] : nil;
  } @catch (NSException *e) {
    objectID = nil;
  }
  NSManagedObject *folder = nil;
  if (objectID && [objectID.entity.name isEqualToString:@"ICFolder"])
    folder = [context existingObjectWithID:objectID error:nil];
  if (!folder)
    ScopeFail(writing, @"scope_folder_not_found", @"folder_not_found",
              [NSString stringWithFormat:@"%@ %@ does not name an existing folder in this store", field, uri]);
  // A folder this write itself deletes (a smart-folder delete) counts as it
  // was when the write read it.
  id deleted = writing && folder.hasChanges ? [folder committedValuesForKeys:@[ @"markedForDeletion" ]]
                                            : [folder dictionaryWithValuesForKeys:@[ @"markedForDeletion" ]];
  if (forbidden && BoolAttr(deleted, @"markedForDeletion"))
    ScopeFail(writing, @"scope_folder_not_found", @"folder_deleted",
              [NSString stringWithFormat:@"%@ %@ names a deleted folder", field, uri]);
  return objectID;
}

// The parent of one folder: from the context for a folder this write changed
// or created, otherwise re-read from the store (not from the context's cache).
static NSManagedObjectID *PersistedParent(NSManagedObjectContext *context, NSManagedObjectContext *writing,
                                          NSManagedObjectID *folderID) {
  NSManagedObject *registered = [context objectRegisteredForID:folderID];
  if (folderID.isTemporaryID || registered.hasChanges) return [[registered valueForKey:@"parent"] objectID];
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:@"ICFolder"];
  request.predicate = [NSPredicate predicateWithFormat:@"self == %@", folderID];
  request.resultType = NSDictionaryResultType;
  request.propertiesToFetch = @[ @"parent" ];
  request.includesPendingChanges = NO;
  NSError *error = nil;
  NSArray *rows = [context executeFetchRequest:request error:&error];
  if (!rows)
    Fail(@"store_unavailable", @"Folder fetch failed during the scope check",
         @{@"committed" : @NO, @"detail" : OrNull(error.localizedDescription)});
  if (rows.count != 1)
    ScopeFail(writing, @"scope_conflict", @"folder_vanished", @"a folder above the target no longer exists");
  id parent = [rows.firstObject objectForKey:@"parent"];
  return [parent isKindOfClass:[NSManagedObjectID class]] ? parent : nil;
}

static NSArray<NSManagedObjectID *> *ScopeChain(NSManagedObjectContext *context, NSManagedObjectContext *writing,
                                                NSManagedObjectID *start) {
  NSMutableArray *chain = [NSMutableArray array];
  for (NSManagedObjectID *cursor = start; cursor; cursor = PersistedParent(context, writing, cursor)) {
    if (chain.count >= MAX_SCOPE_DEPTH || [chain containsObject:cursor])
      ScopeFail(writing, @"scope_conflict", @"folder_chain_invalid", @"the folder chain is cyclic or too deep");
    [chain addObject:cursor];
  }
  return chain;
}

static NSManagedObjectID *ObjectIDOf(id object) {
  return [object isKindOfClass:[NSManagedObject class]] ? [object objectID] : nil;
}

// Evaluates the guard. `writing` is the write's own context (right before its
// save) or nil for the read-only check of a call that saved nothing.
static void EvaluateScopeGuard(NSManagedObjectContext *context, NSManagedObjectContext *writing) {
  NSDictionary *request = gScopeRequest;
  NSManagedObjectID *home = nil, *subjectFolder = nil, *destination = nil;
  if (gScopeSubject == ScopeSubjectNote) {
    if (!IsUUID(request[@"identifier"]))
      Fail(@"invalid_request", @"Scope guards need the note `identifier`", @{@"committed" : @NO});
    NSManagedObject *note = FetchNote(context, request[@"identifier"]);
    // The folder the write read (the save's optimistic locking protects it),
    // and where the write puts the note if it moves it.
    id read = writing ? [note committedValuesForKeys:@[ @"folder" ]][@"folder"] : [note valueForKey:@"folder"];
    home = ObjectIDOf(read);
    NSManagedObjectID *now = ObjectIDOf([note valueForKey:@"folder"]);
    if (now && ![now isEqual:home]) destination = now;
  } else if (gScopeSubject == ScopeSubjectFolder) {
    if (!IsUUID(request[@"identifier"]))
      Fail(@"invalid_request", @"Scope guards need the folder `identifier`", @{@"committed" : @NO});
    NSManagedObject *folder = FetchByIdentifier(context, @"ICFolder", request[@"identifier"]);
    subjectFolder = folder.objectID;
    id read = writing ? [folder committedValuesForKeys:@[ @"parent" ]][@"parent"] : [folder valueForKey:@"parent"];
    home = ObjectIDOf(read);
  } else {
    NSManagedObject *created = nil;
    if (writing)
      for (NSManagedObject *object in context.insertedObjects)
        if ([object.entity.name isEqualToString:@"ICFolder"]) {
          if (created) ScopeFail(writing, @"scope_conflict", @"ambiguous_subject", @"the write creates more than one folder");
          created = object;
        }
    if (created) {
      home = ObjectIDOf([created valueForKey:@"parent"]);
    } else if ([request[@"parentIdentifier"] isKindOfClass:[NSString class]]) {
      home = FetchFolderRef(context, request[@"parentIdentifier"], @"parentIdentifier").objectID;
    }
  }

  NSMutableArray<NSManagedObjectID *> *forbidden = [NSMutableArray array];
  for (NSString *uri in request[@"forbiddenAncestorFolderIds"] ?: @[])
    [forbidden addObject:ResolveScopeFolder(context, writing, uri, @"forbiddenAncestorFolderIds entry", YES)];
  NSManagedObjectID *exact = request[@"ifFolderId"]
                                 ? ResolveScopeFolder(context, writing, request[@"ifFolderId"], @"ifFolderId", NO)
                                 : nil;
  NSManagedObjectID *ancestor =
      request[@"ifAncestorFolderId"]
          ? ResolveScopeFolder(context, writing, request[@"ifAncestorFolderId"], @"ifAncestorFolderId", NO)
          : nil;

  NSString *noun = ScopeNoun();
  if ((exact || ancestor) && !home)
    ScopeFail(writing, @"scope_conflict", @"not_in_folder",
              [NSString stringWithFormat:@"the %@ is not in a folder", noun]);
  if (exact && ![exact isEqual:home])
    ScopeFail(writing, @"scope_conflict", @"not_in_expected_folder",
              [NSString stringWithFormat:@"the %@ is not in the expected folder", noun]);
  NSArray *chain = home ? ScopeChain(context, writing, home) : @[];
  if (ancestor && ![chain containsObject:ancestor])
    ScopeFail(writing, @"scope_conflict", @"not_inside_expected_ancestor",
              [NSString stringWithFormat:@"the %@ is not inside the expected ancestor folder", noun]);
  if (forbidden.count) {
    for (NSManagedObjectID *id_ in forbidden)
      if ([chain containsObject:id_] || [id_ isEqual:subjectFolder])
        ScopeFail(writing, @"scope_conflict", @"inside_forbidden_folder",
                  [NSString stringWithFormat:@"the %@ is inside a forbidden folder", noun]);
    NSArray *destinationChain = destination ? ScopeChain(context, writing, destination) : @[];
    for (NSManagedObjectID *id_ in forbidden)
      if ([destinationChain containsObject:id_])
        ScopeFail(writing, @"scope_conflict", @"destination_inside_forbidden_folder",
                  @"the destination is inside a forbidden folder");
  }
}

static void EnforceScopeGuard(NSManagedObjectContext *context) {
  if (!gScopeRequest) return;
  [context processPendingChanges];
  EvaluateScopeGuard(context, context);
  gScopeEnforced = YES;
}

// For a guarded call that returned without saving: the same check in a fresh
// read-only context, before the answer goes out.
static void CheckScopeGuardWithoutSave(void) {
  if (!gScopeRequest || gScopeEnforced) return;
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  EvaluateScopeGuard(context, nil);
}

#pragma mark - Purge-flag repair

// A note is deleted in Notes by moving it to its account's Recently Deleted
// folder; its markedForDeletion flag stays clear until the 30-day lifetime
// ends (or the user deletes it there), when Notes sets the flag and purges
// it. A note with the flag set while still in an ordinary folder is in
// neither state: Notes hides it and will purge it, but it never passed
// through Recently Deleted, so the user cannot recover it (observed when a
// tool set the flag instead of moving the note). repair_purge_flag detects
// that state and, with confirm and ifRevision, finishes an ordinary delete:
// clear the flag and move the note to Recently Deleted. It never purges.

static NSString *const kPurgeRepairReason = @"apple-notes-mcp repair_purge_flag";
#define MAX_PURGE_CANDIDATES 50

static BOOL IsRecentlyDeleted(NSManagedObject *folder) {
  if (!folder) return NO;
  if ([folder respondsToSelector:sel_registerName("isTrashFolder")] && SendBool(folder, "isTrashFolder")) return YES;
  return IsTrashFolder(folder);
}

static NSString *DeletionState(NSManagedObject *note) {
  BOOL marked = BoolAttr(note, @"markedForDeletion");
  NSManagedObject *folder = [note valueForKey:@"folder"];
  if (!folder) return marked ? @"purge_flag_without_folder" : @"folderless";
  if (IsRecentlyDeleted(folder)) return marked ? @"purging_from_recently_deleted" : @"in_recently_deleted";
  return marked ? @"purge_flag_outside_recently_deleted" : @"active";
}

// The note's state and everything that blocks a repair.
static NSDictionary *PurgePlan(NSManagedObject *note) {
  NSString *state = DeletionState(note);
  NSManagedObject *folder = [note valueForKey:@"folder"];
  NSManagedObject *account = [note valueForKey:@"account"];
  NSManagedObject *trash = account ? Send(account, "trashFolder") : nil;
  NSUInteger attachments = 0, markedAttachments = 0;
  for (NSManagedObject *attachment in [note valueForKey:@"attachments"] ?: @[]) {
    attachments++;
    if (BoolAttr(attachment, @"markedForDeletion")) markedAttachments++;
  }
  NSMutableArray *blockers = [NSMutableArray array];
  if (![state isEqualToString:@"purge_flag_outside_recently_deleted"]) [blockers addObject:@"not_in_purge_flag_state"];
  if (SendBool(note, "isPasswordProtected")) [blockers addObject:@"locked"];
  if (SendBool(note, "isSharedViaICloud")) [blockers addObject:@"shared"];
  if (BoolAttr(note, @"needsInitialFetchFromCloud")) [blockers addObject:@"downloading"];
  if (!account || BoolAttr(account, @"markedForDeletion")) [blockers addObject:@"account_unavailable"];
  if (![trash isKindOfClass:[NSManagedObject class]] || !IsRecentlyDeleted(trash) ||
      BoolAttr(trash, @"markedForDeletion"))
    [blockers addObject:@"no_recently_deleted_folder"];
  if (markedAttachments) [blockers addObject:@"attachments_marked_for_deletion"];
  return @{
    @"identifier" : OrNull(StringAttr(note, @"identifier")),
    @"objectURI" : note.objectID.URIRepresentation.absoluteString,
    @"title" : OrNull(StringAttr(note, @"title")),
    @"state" : state,
    @"repairable" : @((BOOL)(blockers.count == 0)),
    @"blockers" : blockers,
    @"folderIdentifier" : OrNull(StringAttr(folder, @"identifier")),
    @"folderObjectURI" : OrNull(folder ? folder.objectID.URIRepresentation.absoluteString : nil),
    @"folderMarkedForDeletion" : @(BoolAttr(folder, @"markedForDeletion")),
    @"recentlyDeletedFolderIdentifier" :
        OrNull([trash isKindOfClass:[NSManagedObject class]] ? StringAttr(trash, @"identifier") : nil),
    @"attachmentCount" : @(attachments),
    @"attachmentsMarkedForDeletion" : @(markedAttachments),
    @"revision" : RevisionToken(note),
    @"cloudSync" : CloudSyncState(note),
  };
}

// Dry run without an identifier: every note in the purge-flag state (or with
// the flag and no folder), up to MAX_PURGE_CANDIDATES.
static NSDictionary *ScanPurgeFlags(NSManagedObjectContext *context) {
  NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:@"ICNote"];
  request.predicate = [NSPredicate predicateWithFormat:@"markedForDeletion == YES"];
  NSError *error = nil;
  NSArray *rows = [context executeFetchRequest:request error:&error];
  if (!rows) Fail(@"store_unavailable", @"Note fetch failed", @{@"detail" : OrNull(error.localizedDescription)});
  NSMutableArray *candidates = [NSMutableArray array];
  NSUInteger found = 0;
  for (NSManagedObject *note in rows) {
    NSString *state = DeletionState(note);
    if (![state isEqualToString:@"purge_flag_outside_recently_deleted"] &&
        ![state isEqualToString:@"purge_flag_without_folder"])
      continue;
    found++;
    if (candidates.count < MAX_PURGE_CANDIDATES) [candidates addObject:PurgePlan(note)];
  }
  return @{
    @"status" : @"scanned",
    @"dryRun" : @YES,
    @"committed" : @NO,
    @"markedForDeletionCount" : @(rows.count),
    @"candidateCount" : @(found),
    @"truncated" : @((BOOL)(found > candidates.count)),
    @"candidates" : candidates,
  };
}

static NSDictionary *HandleRepairPurgeFlag(NSDictionary *request) {
  gWriteRequest = YES;
  id dryRunValue = request[@"dryRun"];
  if (!IsJSONBool(dryRunValue)) Fail(@"invalid_request", @"`dryRun` must be true or false", nil);
  BOOL dryRun = [dryRunValue boolValue];
  NSString *identifier = nil;
  if (request[@"identifier"] || !dryRun) identifier = RequireIdentifier(request);
  NSString *ifRevision = nil;
  if (dryRun) {
    if (request[@"ifRevision"] || request[@"confirm"])
      Fail(@"invalid_request", @"`ifRevision` and `confirm` are only accepted with dryRun false", nil);
  } else {
    ifRevision = RequireString(request, @"ifRevision");
    if (!IsJSONBool(request[@"confirm"]) || ![request[@"confirm"] boolValue])
      Fail(@"confirmation_required", @"Repairing a purge flag moves the note to Recently Deleted; pass confirm: true",
           nil);
  }
  RequireFeature(FeaturePurgeRepair);

  StoreLocation store = ResolveStore();
  NSManagedObjectContext *context = OpenContext(store, dryRun);
  if (!identifier) return ScanPurgeFlags(context);
  NSManagedObject *note = FetchNote(context, identifier);
  NSDictionary *plan = PurgePlan(note);
  NSString *revisionBefore = plan[@"revision"];
  if (dryRun) {
    NSMutableDictionary *response = [plan mutableCopy];
    response[@"status"] = @"planned";
    response[@"dryRun"] = @YES;
    response[@"committed"] = @NO;
    return response;
  }
  if (![revisionBefore isEqualToString:ifRevision])
    Fail(@"revision_conflict", @"The note changed since ifRevision was read",
         @{@"committed" : @NO, @"currentRevision" : revisionBefore});
  if (![plan[@"repairable"] boolValue])
    Fail(@"unsupported_note", @"This note cannot be repaired this way",
         @{@"committed" : @NO, @"state" : plan[@"state"], @"blockers" : plan[@"blockers"]});

  NSManagedObject *from = [note valueForKey:@"folder"];
  NSManagedObject *account = [note valueForKey:@"account"];
  NSManagedObject *trash = Send(account, "trashFolder");
  NSString *bodyBefore = NoteBodyData(note) ? SHA256Hex(NoteBodyData(note)) : @"none";
  NSMutableArray *allowed = [NSMutableArray arrayWithObjects:note, from, trash, account, nil];
  for (NSManagedObject *attachment in [note valueForKey:@"attachments"] ?: @[]) [allowed addObject:attachment];

  SendVoid(note, "unmarkForDeletion");
  if (BoolAttr(note, @"markedForDeletion")) {
    [context rollback];
    Fail(@"save_failed", @"Notes did not clear the deletion flag; nothing was saved", @{@"committed" : @NO});
  }
  // What Notes does before it moves a note to Recently Deleted.
  if ([note respondsToSelector:sel_registerName("notifyAttachmentsNoteWillMoveToRecentlyDeletedFolder")])
    SendVoid(note, "notifyAttachmentsNoteWillMoveToRecentlyDeletedFolder");
  SendVoid1(note, "setFolder:", trash);
  // -setFolder: leaves the folder timestamp alone. It is both CloudKit's
  // last-writer-wins stamp for the folder reference and the start of the
  // 30-day Recently Deleted clock, so it is set here.
  NSDate *now = [NSDate date];
  [note setValue:now forKey:@"folderModificationDate"];
  SendVoid1(note, "updateChangeCountWithReason:", kPurgeRepairReason);
  RequireExpectedChanges(context, allowed, [NSSet setWithObject:@"ICCloudState"]);
  SaveOrFail(context);

  NSString *problem = nil;
  NSDictionary *after = nil;
  @try {
    NSManagedObjectContext *fresh = OpenContext(store, YES);
    NSManagedObject *reread = FetchNote(fresh, identifier);
    NSManagedObject *folder = [reread valueForKey:@"folder"];
    NSDate *stamped = [reread valueForKey:@"folderModificationDate"];
    NSData *body = NoteBodyData(reread);
    if (BoolAttr(reread, @"markedForDeletion"))
      problem = @"the deletion flag is still set";
    else if (!IsRecentlyDeleted(folder) || ![StringAttr(folder, @"identifier") isEqual:StringAttr(trash, @"identifier")])
      problem = @"the note is not in its account's Recently Deleted folder";
    else if (!SendBool(reread, "isDeletedOrInTrash"))
      problem = @"Notes does not report the note as in Recently Deleted";
    else if (![stamped isKindOfClass:[NSDate class]] || fabs(stamped.timeIntervalSinceReferenceDate -
                                                             now.timeIntervalSinceReferenceDate) > 1.0)
      problem = @"the folder timestamp was not stored";
    else if (![(body ? SHA256Hex(body) : @"none") isEqualToString:bodyBefore])
      problem = @"the note body changed";
    NSMutableDictionary *state = [NoteState(reread) mutableCopy];
    state[@"state"] = DeletionState(reread);
    after = state;
  } @catch (NSException *e) {
    // After a successful save: a committed write that could not be verified.
    problem = e.reason ?: e.name;
  }
  if (problem)
    Fail(@"verification_failed", [NSString stringWithFormat:@"Repair read-back failed: %@", problem],
         @{@"committed" : @YES, @"revisionBefore" : revisionBefore});

  NSMutableDictionary *response = [@{
    @"status" : @"repaired",
    @"dryRun" : @NO,
    @"committed" : @YES,
    @"verified" : @YES,
    @"repairedPurgeFlag" : @YES,
    @"identifier" : identifier,
    @"previousState" : plan[@"state"],
    @"state" : after[@"state"],
    @"fromFolderIdentifier" : plan[@"folderIdentifier"],
    @"recentlyDeletedFolderIdentifier" : plan[@"recentlyDeletedFolderIdentifier"],
    @"folderIdentifier" : after[@"folderIdentifier"],
    @"revisionBefore" : revisionBefore,
    @"revisionAfter" : after[@"revision"],
  } mutableCopy];
  [response addEntriesFromDictionary:SyncFields(after, store)];
  return response;
}

#pragma mark - Paper reading

// read_paper decodes one Paper drawing (com.apple.paper) read-only, in three
// layers, each reported with its own availability:
//
// 1. Strokes, from NotesShared's ICSystemPaperDrawingsHelper, which returns
//    the drawing as public PKDrawing objects (ink, color, width, transform,
//    points).
// 2. Typed shapes (rectangles, ellipses, lines, arrows, stars, polygons,
//    speech bubbles, text boxes), from PaperKit's own model. macOS 27's
//    PaperKit describes them publicly (ShapeMarkup), but only for a
//    PaperMarkup value, and the only way from a Notes bundle to a PaperMarkup
//    is two internal Swift entry points: Coherence's
//    CRDataStoreBundle<Paper>.readPaper(_:url:) and PaperMarkup(model:).
//    PaperDecodeShapes below calls them, and then only public PaperKit
//    accessors, through the Swift calling convention (clang's swiftcall).
//    Every symbol is resolved with dlsym at run time and every type's size
//    comes from its runtime metadata, so a missing symbol or type is reported
//    as unavailable instead of failing the load; the layer is only offered on
//    macOS 27 or later, the release it was written against.
// 3. Painted geometry from Notes' fallback PDF, the vector rendering Notes
//    stores beside the drawing for clients that cannot read the bundle
//    (FallbackPDFs/<attachment>/<generation>/FallbackPDF.pdf). Present only
//    when the attachment records a fallback PDF generation. It is parsed with
//    CGPDFScanner; nothing is drawn or rasterized.
//
// Like add_paper's verification, the bundle is copied into a private
// temporary directory and every ICAccount directory method is redirected
// there first, so neither NotesShared nor Coherence opens the live bundle.
// The store is opened read-only. Swift values this action creates are not
// released: the writer handles one request and exits.

#define DEFAULT_READ_PAPER_POINTS 20000
#define MAX_READ_PAPER_POINTS 40000
#define MAX_READ_PAPER_STROKES 4096
#define MAX_PAPER_SHAPES 10000
#define MAX_PAPER_PATH_ELEMENTS 200000
#define MAX_SHAPE_TEXT_UTF16 10000
#define MAX_FALLBACK_PDF_BYTES (16LL * 1024 * 1024)
#define MAX_FALLBACK_PDF_PAGES 16
#define MAX_FALLBACK_PATHS 10000

static const APIRequirement kPaperReadAPI[] = {
    {"ICSystemPaperDrawingsHelper", "drawingsForAttachment:", YES},
    {"ICAttachment", "typeUTIIsSystemPaper:", YES},
    {"PKDrawing", "strokes", NO},
    {"PKStroke", "path", NO},
    {"PKStroke", "ink", NO},
    {"PKStroke", "renderBounds", NO},
    {"PKStrokePath", "pointAtIndex:", NO},
    {"PKInk", "inkType", NO},
    {"CRContext", "newTransientContextObjC", YES},
};

static const ModelRequirement kPaperReadModelProperties[] = {
    {"ICNote", "attachments,account"},
    {"ICAttachment", "identifier,typeUTI,note,markedForDeletion,needsInitialFetchFromCloud"},
    {"ICAccount", "identifier"},
};

static NSArray<NSString *> *MissingForPaperRead(void) {
  NSMutableArray *missing = [MissingForFeature(FeatureRead) mutableCopy];
  if (!gFrameworkLoaded) return missing;
  // Coherence is where CRContext lives; NotesShared links it, so this only
  // makes the class resolvable before the first NotesShared call.
  dlopen("/System/Library/PrivateFrameworks/Coherence.framework/Coherence", RTLD_NOW | RTLD_LOCAL);
  [missing addObjectsFromArray:MissingAPI(kPaperReadAPI, COUNT(kPaperReadAPI))];
  [missing addObjectsFromArray:MissingModelProperties(kPaperReadModelProperties, COUNT(kPaperReadModelProperties))];
  Class account = objc_getClass("ICAccount");
  for (size_t i = 0; i < COUNT(kAccountDirectories); i++)
    if (!account || ![account instancesRespondToSelector:sel_registerName(kAccountDirectories[i].sel)])
      [missing addObject:[NSString stringWithFormat:@"-[ICAccount %s]", kAccountDirectories[i].sel]];
  return [[NSOrderedSet orderedSetWithArray:missing] array];
}

#pragma mark Paper shapes through PaperKit

#define SWIFTCALL __attribute__((swiftcall))
#define SWIFT_INDIRECT __attribute__((swift_indirect_result))
#define SWIFT_SELF __attribute__((swift_context))
#define SWIFT_ERROR __attribute__((swift_error_result))

// Every Swift symbol the shape layer calls. Order matters: PaperKitSymbol()
// indexes this table with the PKSym values below.
static const char *const kPaperKitSymbols[] = {
    "swift_getTypeByMangledNameInContext",
    "swift_projectBox",
    "swift_getTypeName",
    "swift_getObjCClassMetadata",
    // Foundation.URL(_unconditionallyBridgeFromObjectiveC:)
    "$s10Foundation3URLV36_unconditionallyBridgeFromObjectiveCyACSo5NSURLCSgFZ",
    // Coherence.CRDataStoreBundle<PaperKit.Paper>.readPaper(_:url:) (internal)
    "$s9Coherence17CRDataStoreBundleC8PaperKitAD0E0VRszrlE04readE0_3urlAA7CapsuleVyAFGAA9CRContextC_10Foundation3URLVtKFZ",
    // PaperKit.PaperMarkup.init(model:) (internal)
    "$s8PaperKit0A6MarkupV5modelAC9Coherence7CapsuleVyAA0A0VG_tcfC",
    // The rest is public PaperKit API (macOS 27).
    "$s8PaperKit0A6MarkupV11subelementsAA0C10OrderedSetVvg",
    "$s8PaperKit16MarkupOrderedSetV5countSivg",
    "$s8PaperKit16MarkupOrderedSetVyAA0C0_pSicig",
    "$s8PaperKit11ShapeMarkupV5frameSo6CGRectVvg",
    "$s8PaperKit11ShapeMarkupV11renderFrameSo6CGRectVvg",
    "$s8PaperKit11ShapeMarkupV8rotation12CoreGraphics7CGFloatVvg",
    "$s8PaperKit11ShapeMarkupV9lineWidth12CoreGraphics7CGFloatVvg",
    "$s8PaperKit11ShapeMarkupV7opacity12CoreGraphics7CGFloatVvg",
    "$s8PaperKit11ShapeMarkupV9fillColorSo10CGColorRefaSgvg",
    "$s8PaperKit11ShapeMarkupV11strokeColorSo10CGColorRefaSgvg",
    "$s8PaperKit11ShapeMarkupV5shapeAC0C0Ovg",
    "$s8PaperKit11ShapeMarkupV0C0O4pathSo9CGPathRefavg",
    "$s8PaperKit11ShapeMarkupV0C0O17configurationTypeAA0C13ConfigurationVADOvg",
    "$s8PaperKit11ShapeMarkupV15startLineMarkerAC0fG0Ovg",
    "$s8PaperKit11ShapeMarkupV13endLineMarkerAC0fG0Ovg",
    "$s8PaperKit11ShapeMarkupV14attributedText10Foundation16AttributedStringVvg",
    // NSAttributedString.init(_: AttributedString)
    "$sSo18NSAttributedStringC10FoundationEyAbC010AttributedB0VcfC",
};

typedef NS_ENUM(NSUInteger, PKSym) {
  PKSymTypeByName,
  PKSymProjectBox,
  PKSymTypeName,
  PKSymObjCClassMetadata,
  PKSymURLBridge,
  PKSymReadPaper,
  PKSymMarkupFromModel,
  PKSymSubelements,
  PKSymCount,
  PKSymElement,
  PKSymFrame,
  PKSymRenderFrame,
  PKSymRotation,
  PKSymLineWidth,
  PKSymOpacity,
  PKSymFillColor,
  PKSymStrokeColor,
  PKSymShape,
  PKSymShapePath,
  PKSymShapeKind,
  PKSymStartMarker,
  PKSymEndMarker,
  PKSymText,
  PKSymNSAttributed,
};

// Runtime type names (swift_getTypeByMangledNameInContext form) for every
// value the shape layer holds, so buffers are sized from metadata.
static const char *const kPaperKitTypes[] = {
    "10Foundation3URLV",
    "9Coherence7CapsuleVy8PaperKit5PaperVG",
    "9Coherence17CRDataStoreBundleCy8PaperKit5PaperVG",
    "8PaperKit11PaperMarkupV",
    "8PaperKit16MarkupOrderedSetV",
    "8PaperKit11ShapeMarkupV",
    "8PaperKit11ShapeMarkupV5ShapeO",
    "8PaperKit18ShapeConfigurationV5ShapeO",
    "8PaperKit11ShapeMarkupV10LineMarkerO",
    "10Foundation16AttributedStringV",
};

typedef NS_ENUM(NSUInteger, PKType) {
  PKTypeURL,
  PKTypeCapsule,
  PKTypeBundle,
  PKTypePaperMarkup,
  PKTypeOrderedSet,
  PKTypeShapeMarkup,
  PKTypeShape,
  PKTypeShapeKind,
  PKTypeLineMarker,
  PKTypeAttributedString,
};

// ShapeConfiguration.Shape and ShapeMarkup.LineMarker cases, in declaration
// order, which is their enum tag order (both are payload-free).
static const char *const kPaperShapeKinds[] = {"rectangle",        "ellipse",        "line", "chatBubble",
                                               "roundedRectangle", "regularPolygon", "star", "arrowShape"};
static const char *const kPaperLineMarkers[] = {"none", "arrow"};

typedef SWIFTCALL const void *(*SwiftTypeByNameFn)(const char *, size_t, const void *, const void *const *);
typedef void *(*SwiftProjectBoxFn)(void *);
typedef struct {
  const char *data;
  uintptr_t length;
} SwiftTypeNamePair;
typedef SWIFTCALL SwiftTypeNamePair (*SwiftTypeNameFn)(const void *, bool);
typedef const void *(*SwiftObjCClassMetadataFn)(const void *);
typedef SWIFTCALL void (*SwiftURLBridgeFn)(SWIFT_INDIRECT void *, id);
typedef SWIFTCALL void (*SwiftReadPaperFn)(SWIFT_INDIRECT void *, id, const void *, SWIFT_SELF const void *,
                                           SWIFT_ERROR void **);
typedef SWIFTCALL void (*SwiftFromModelFn)(SWIFT_INDIRECT void *, void *);
typedef SWIFTCALL void (*SwiftIndirectGetterFn)(SWIFT_INDIRECT void *, SWIFT_SELF const void *);
typedef SWIFTCALL intptr_t (*SwiftIntGetterFn)(SWIFT_SELF const void *);
typedef SWIFTCALL void (*SwiftElementFn)(SWIFT_INDIRECT void *, intptr_t, SWIFT_SELF const void *);
typedef SWIFTCALL CGRect (*SwiftRectGetterFn)(SWIFT_SELF const void *);
typedef SWIFTCALL double (*SwiftFloatGetterFn)(SWIFT_SELF const void *);
typedef SWIFTCALL CFTypeRef (*SwiftCFGetterFn)(SWIFT_SELF const void *);
typedef SWIFTCALL id (*SwiftNSAttributedFn)(void *, SWIFT_SELF const void *);
typedef SWIFTCALL unsigned (*SwiftEnumTagFn)(const void *, const void *);

// A Swift existential `any Markup`: three words of inline storage, the
// dynamic type's metadata, and its protocol witness table.
typedef struct {
  void *buffer[3];
  const void *type;
  const void *witnesses;
} SwiftExistential;

// Value witness table layout (Swift ABI): eight functions, then size,
// stride, flags, and extra inhabitants; an enum's table continues with
// getEnumTag.
#define VWT_SIZE_OFFSET 64
#define VWT_FLAGS_OFFSET 80
#define VWT_ENUM_TAG_OFFSET 88
#define VWT_FLAG_NON_INLINE 0x00020000u
#define VWT_FLAG_HAS_ENUM_WITNESSES 0x00200000u

static void *gPaperKitSymbols[COUNT(kPaperKitSymbols)];
static const void *gPaperKitTypes[COUNT(kPaperKitTypes)];

static BOOL PaperShapesOSSupported(void) {
  return NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27;
}

// Resolves every symbol and type; returns what is missing (empty = ready).
static NSArray<NSString *> *MissingForPaperShapes(void) {
  static NSArray *cached = nil;
  if (cached) return cached;
  NSMutableArray *missing = [NSMutableArray array];
  if (!PaperShapesOSSupported()) return (cached = @[ @"macOS 27 or later" ]);
  dlopen("/System/Library/Frameworks/PaperKit.framework/PaperKit", RTLD_NOW | RTLD_LOCAL);
  dlopen("/System/Library/PrivateFrameworks/Coherence.framework/Coherence", RTLD_NOW | RTLD_LOCAL);
  for (size_t i = 0; i < COUNT(kPaperKitSymbols); i++) {
    gPaperKitSymbols[i] = dlsym(RTLD_DEFAULT, kPaperKitSymbols[i]);
    if (!gPaperKitSymbols[i]) [missing addObject:[NSString stringWithFormat:@"symbol %s", kPaperKitSymbols[i]]];
  }
  if (!missing.count) {
    SwiftTypeByNameFn byName = (SwiftTypeByNameFn)gPaperKitSymbols[PKSymTypeByName];
    for (size_t i = 0; i < COUNT(kPaperKitTypes); i++) {
      gPaperKitTypes[i] = byName(kPaperKitTypes[i], strlen(kPaperKitTypes[i]), NULL, NULL);
      if (!gPaperKitTypes[i]) [missing addObject:[NSString stringWithFormat:@"type %s", kPaperKitTypes[i]]];
    }
  }
  return (cached = [missing copy]);
}

static const uint8_t *ValueWitnesses(const void *type) { return *(const uint8_t *const *)((const uint8_t *)type - 8); }
static size_t SwiftSize(const void *type) { return *(const size_t *)(ValueWitnesses(type) + VWT_SIZE_OFFSET); }
static uint32_t SwiftFlags(const void *type) { return *(const uint32_t *)(ValueWitnesses(type) + VWT_FLAGS_OFFSET); }

// A zeroed, 16-byte aligned buffer for one value of `type`. Never freed (see
// the section comment).
static void *SwiftBuffer(PKType type) {
  size_t size = SwiftSize(gPaperKitTypes[type]);
  return calloc(1, size > 16 ? size : 16);
}

// The case index of a payload-free enum value, or -1.
static NSInteger SwiftEnumTag(const void *value, PKType type) {
  const void *metadata = gPaperKitTypes[type];
  if (!(SwiftFlags(metadata) & VWT_FLAG_HAS_ENUM_WITNESSES)) return -1;
  SwiftEnumTagFn tag = *(SwiftEnumTagFn const *)(ValueWitnesses(metadata) + VWT_ENUM_TAG_OFFSET);
  return (NSInteger)tag(value, metadata);
}

static NSString *SwiftTypeNameOf(const void *type) {
  SwiftTypeNamePair name = ((SwiftTypeNameFn)gPaperKitSymbols[PKSymTypeName])(type, true);
  if (!name.data) return @"unknown";
  return [[NSString alloc] initWithBytes:name.data length:name.length encoding:NSUTF8StringEncoding] ?: @"unknown";
}

static id FiniteNumber(double value) { return isfinite(value) ? @(Round4(value)) : [NSNull null]; }

static id PaperRectJSON(CGRect rect) {
  if (CGRectIsNull(rect) || CGRectIsInfinite(rect)) return [NSNull null];
  double v[4] = {rect.origin.x, rect.origin.y, rect.size.width, rect.size.height};
  for (int i = 0; i < 4; i++)
    if (!isfinite(v[i])) return [NSNull null];
  return RectArray(rect);
}

static id ColorJSON(CGColorRef color) {
  if (!color) return [NSNull null];
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGColorRef converted = CGColorCreateCopyByMatchingToColorSpace(srgb, kCGRenderingIntentDefault, color, NULL);
  CGColorSpaceRelease(srgb);
  if (!converted) return [NSNull null];
  id out = [NSNull null];
  if (CGColorGetNumberOfComponents(converted) == 4) {
    const CGFloat *c = CGColorGetComponents(converted);
    if (isfinite(c[0]) && isfinite(c[1]) && isfinite(c[2]) && isfinite(c[3]))
      out = @[ @(Round4(c[0])), @(Round4(c[1])), @(Round4(c[2])), @(Round4(c[3])) ];
  }
  CGColorRelease(converted);
  return out;
}

static NSString *SVGNumber(double value) {
  double rounded = Round4(value);
  if (rounded == 0) rounded = 0;  // no "-0"
  return [NSString stringWithFormat:@"%.10g", rounded];
}

// A CGPath as SVG path data, after `transform`, counting elements against
// `*budget`. Returns nil when the budget runs out or a coordinate is not
// finite.
static NSString *SVGPathData(CGPathRef path, CGAffineTransform transform, NSUInteger *budget) {
  NSMutableString *d = [NSMutableString string];
  __block BOOL ok = YES;
  __block NSUInteger used = 0;
  CGPathApplyWithBlock(path, ^(const CGPathElement *element) {
    if (!ok) return;
    if (++used > *budget) {
      ok = NO;
      return;
    }
    int n = 0;
    const char *op = "";
    switch (element->type) {
      case kCGPathElementMoveToPoint: op = "M", n = 1; break;
      case kCGPathElementAddLineToPoint: op = "L", n = 1; break;
      case kCGPathElementAddQuadCurveToPoint: op = "Q", n = 2; break;
      case kCGPathElementAddCurveToPoint: op = "C", n = 3; break;
      case kCGPathElementCloseSubpath: op = "Z", n = 0; break;
    }
    [d appendFormat:@"%s%s", d.length ? " " : "", op];
    for (int i = 0; i < n; i++) {
      CGPoint p = CGPointApplyAffineTransform(element->points[i], transform);
      if (!isfinite(p.x) || !isfinite(p.y)) {
        ok = NO;
        return;
      }
      [d appendFormat:@" %@ %@", SVGNumber(p.x), SVGNumber(p.y)];
    }
  });
  if (!ok) return nil;
  *budget -= used;
  return d;
}

// Everything the shape layer reports: {available, reason, missing, shapes,
// elementCounts, markupStrokeCount, truncated}. Never throws for a decode
// problem; it reports it.
static NSDictionary *PaperDecodeShapes(NSURL *bundleURL, NSMutableArray *warnings) {
  NSArray *missing = MissingForPaperShapes();
  if (missing.count)
    return @{
      @"available" : @NO,
      @"reason" : PaperShapesOSSupported() ? @"private_api_unavailable" : @"requires_macos_27",
      @"missing" : missing,
      @"shapes" : @[],
    };
  void **sym = gPaperKitSymbols;
  id context = Send(objc_getClass("CRContext"), "newTransientContextObjC");
  if (!context)
    return @{@"available" : @NO, @"reason" : @"private_api_unavailable", @"missing" : @[], @"shapes" : @[]};

  void *url = SwiftBuffer(PKTypeURL);
  ((SwiftURLBridgeFn)sym[PKSymURLBridge])(url, bundleURL);
  void *capsule = SwiftBuffer(PKTypeCapsule);
  void *error = NULL;
  ((SwiftReadPaperFn)sym[PKSymReadPaper])(capsule, context, url, gPaperKitTypes[PKTypeBundle], &error);
  if (error)
    return @{@"available" : @NO, @"reason" : @"bundle_unreadable", @"missing" : @[], @"shapes" : @[]};
  void *markup = SwiftBuffer(PKTypePaperMarkup);
  ((SwiftFromModelFn)sym[PKSymMarkupFromModel])(markup, capsule);  // consumes the capsule
  void *elements = SwiftBuffer(PKTypeOrderedSet);
  ((SwiftIndirectGetterFn)sym[PKSymSubelements])(elements, markup);
  intptr_t count = ((SwiftIntGetterFn)sym[PKSymCount])(elements);
  if (count < 0)
    return @{@"available" : @NO, @"reason" : @"bundle_unreadable", @"missing" : @[], @"shapes" : @[]};

  const void *shapeType = gPaperKitTypes[PKTypeShapeMarkup];
  BOOL shapeInline = !(SwiftFlags(shapeType) & VWT_FLAG_NON_INLINE);
  const void *attributedClass =
      ((SwiftObjCClassMetadataFn)sym[PKSymObjCClassMetadata])((__bridge const void *)[NSAttributedString class]);
  NSMutableArray *shapes = [NSMutableArray array];
  NSMutableDictionary<NSString *, NSNumber *> *kinds = [NSMutableDictionary dictionary];
  NSUInteger pathBudget = MAX_PAPER_PATH_ELEMENTS, markupStrokes = 0;
  BOOL truncated = NO;
  for (intptr_t i = 0; i < count; i++) {
    SwiftExistential element = {{0}, NULL, NULL};
    ((SwiftElementFn)sym[PKSymElement])(&element, i, elements);
    if (!element.type) continue;
    if (element.type != shapeType) {
      NSString *name = SwiftTypeNameOf(element.type);
      NSString *kind = [name isEqualToString:@"__C.PKStroke"] || [name hasSuffix:@".PKStroke"]
                           ? @"stroke"
                           : [name isEqualToString:@"PaperKit.ImageMarkup"]  ? @"image"
                           : [name isEqualToString:@"PaperKit.LinkMarkup"]   ? @"link"
                           : [name isEqualToString:@"PaperKit.LoupeMarkup"]  ? @"loupe"
                                                                            : name;
      if ([kind isEqualToString:@"stroke"]) markupStrokes++;
      kinds[kind] = @(kinds[kind].unsignedIntegerValue + 1);
      continue;
    }
    kinds[@"shape"] = @(kinds[@"shape"].unsignedIntegerValue + 1);
    if (shapes.count >= MAX_PAPER_SHAPES) {
      truncated = YES;
      continue;
    }
    const void *value =
        shapeInline ? (const void *)element.buffer : ((SwiftProjectBoxFn)sym[PKSymProjectBox])(element.buffer[0]);
    CGRect frame = ((SwiftRectGetterFn)sym[PKSymFrame])(value);
    CGRect renderFrame = ((SwiftRectGetterFn)sym[PKSymRenderFrame])(value);
    double rotation = ((SwiftFloatGetterFn)sym[PKSymRotation])(value);
    CGColorRef fill = (CGColorRef)((SwiftCFGetterFn)sym[PKSymFillColor])(value);
    CGColorRef stroke = (CGColorRef)((SwiftCFGetterFn)sym[PKSymStrokeColor])(value);
    void *shape = SwiftBuffer(PKTypeShape);
    ((SwiftIndirectGetterFn)sym[PKSymShape])(shape, value);
    void *kindValue = SwiftBuffer(PKTypeShapeKind);
    ((SwiftIndirectGetterFn)sym[PKSymShapeKind])(kindValue, shape);
    NSInteger kindTag = SwiftEnumTag(kindValue, PKTypeShapeKind);
    void *startMarker = SwiftBuffer(PKTypeLineMarker);
    void *endMarker = SwiftBuffer(PKTypeLineMarker);
    ((SwiftIndirectGetterFn)sym[PKSymStartMarker])(startMarker, value);
    ((SwiftIndirectGetterFn)sym[PKSymEndMarker])(endMarker, value);
    NSInteger startTag = SwiftEnumTag(startMarker, PKTypeLineMarker);
    NSInteger endTag = SwiftEnumTag(endMarker, PKTypeLineMarker);
    CGPathRef path = (CGPathRef)((SwiftCFGetterFn)sym[PKSymShapePath])(shape);
    // The shape's path is in unit space: (0,0)-(1,1) maps onto the frame,
    // which is then rotated about its center.
    CGAffineTransform placement = CGAffineTransformIdentity;
    placement = CGAffineTransformTranslate(placement, CGRectGetMidX(frame), CGRectGetMidY(frame));
    placement = CGAffineTransformRotate(placement, isfinite(rotation) ? rotation : 0);
    placement = CGAffineTransformTranslate(placement, -frame.size.width / 2, -frame.size.height / 2);
    placement = CGAffineTransformScale(placement, frame.size.width, frame.size.height);
    CGPathRef placed = path ? CGPathCreateCopyByTransformingPath(path, &placement) : NULL;
    NSString *d = placed ? SVGPathData(placed, CGAffineTransformIdentity, &pathBudget) : nil;
    if (placed && !d) truncated = YES;
    void *attributed = SwiftBuffer(PKTypeAttributedString);
    ((SwiftIndirectGetterFn)sym[PKSymText])(attributed, value);
    NSAttributedString *text = ((SwiftNSAttributedFn)sym[PKSymNSAttributed])(attributed, attributedClass);
    NSString *plain = [text isKindOfClass:[NSAttributedString class]] ? text.string : nil;
    if (plain.length > MAX_SHAPE_TEXT_UTF16) {
      plain = [plain substringToIndex:MAX_SHAPE_TEXT_UTF16];
      truncated = YES;
    }
    [shapes addObject:@{
      @"index" : @(i),
      @"kind" : kindTag >= 0 && (NSUInteger)kindTag < COUNT(kPaperShapeKinds) ? @(kPaperShapeKinds[kindTag])
                                                                             : @"unknown",
      @"frame" : PaperRectJSON(frame),
      @"renderFrame" : PaperRectJSON(renderFrame),
      @"rotation" : FiniteNumber(rotation),
      @"lineWidth" : FiniteNumber(((SwiftFloatGetterFn)sym[PKSymLineWidth])(value)),
      @"opacity" : FiniteNumber(((SwiftFloatGetterFn)sym[PKSymOpacity])(value)),
      @"fillColor" : ColorJSON(fill),
      @"strokeColor" : ColorJSON(stroke),
      @"startLineMarker" : startTag >= 0 && (NSUInteger)startTag < COUNT(kPaperLineMarkers)
                               ? @(kPaperLineMarkers[startTag])
                               : [NSNull null],
      @"endLineMarker" : endTag >= 0 && (NSUInteger)endTag < COUNT(kPaperLineMarkers) ? @(kPaperLineMarkers[endTag])
                                                                                     : [NSNull null],
      @"path" : OrNull(d),
      @"pathBounds" : placed ? PaperRectJSON(CGPathGetPathBoundingBox(placed)) : [NSNull null],
      @"text" : plain.length ? plain : [NSNull null],
    }];
    if (fill) CGColorRelease(fill);
    if (stroke) CGColorRelease(stroke);
    if (path) CGPathRelease(path);
    if (placed) CGPathRelease(placed);
  }
  if (truncated) [warnings addObject:@"Some shapes, paths, or shape text exceeded the reader's limits and were cut"];
  return @{
    @"available" : @YES,
    @"reason" : [NSNull null],
    @"missing" : @[],
    @"elementCount" : @(count),
    @"elementKinds" : kinds,
    @"markupStrokeCount" : @(markupStrokes),
    @"shapes" : shapes,
    @"truncated" : @(truncated),
  };
}

#pragma mark Paper fallback PDF geometry

// Painted geometry from a PDF content stream: every path that is stroked or
// filled, in PDF page space (points, origin at the bottom left), after the
// current transformation matrix. Text, images, shadings, and form XObjects
// are counted, not decoded.
typedef struct {
  CGAffineTransform ctm;
  double lineWidth;
  double stroke[4];
  double fill[4];
} PDFGraphicsState;

@interface ANMPDFGeometry : NSObject {
 @public
  PDFGraphicsState state;
  NSMutableArray<NSValue *> *stack;
  CGMutablePathRef path;
  BOOL pathIsSingleRect;
  NSUInteger subpaths;
  NSMutableArray *paths;
  NSMutableDictionary<NSString *, NSNumber *> *skipped;
  NSUInteger pageIndex;
  NSUInteger budget;
  BOOL truncated;
}
@end
@implementation ANMPDFGeometry
@end

static ANMPDFGeometry *PDFInfo(void *info) { return (__bridge ANMPDFGeometry *)info; }

static BOOL PopNumbers(CGPDFScannerRef scanner, double *out, int count) {
  for (int i = count - 1; i >= 0; i--) {
    CGPDFReal value = 0;
    if (!CGPDFScannerPopNumber(scanner, &value)) return NO;
    out[i] = value;
  }
  return YES;
}

static void PDFResetPath(ANMPDFGeometry *g) {
  if (g->path) CGPathRelease(g->path);
  g->path = CGPathCreateMutable();
  g->pathIsSingleRect = NO;
  g->subpaths = 0;
}

static void PDFMoveTo(CGPDFScannerRef s, void *info) {
  double v[2];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 2)) return;
  CGPathMoveToPoint(g->path, &g->state.ctm, v[0], v[1]);
  g->subpaths++;
  g->pathIsSingleRect = NO;
}
static void PDFLineTo(CGPDFScannerRef s, void *info) {
  double v[2];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 2) || CGPathIsEmpty(g->path)) return;
  CGPathAddLineToPoint(g->path, &g->state.ctm, v[0], v[1]);
  g->pathIsSingleRect = NO;
}
static void PDFCurveTo(CGPDFScannerRef s, void *info) {
  double v[6];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 6) || CGPathIsEmpty(g->path)) return;
  CGPathAddCurveToPoint(g->path, &g->state.ctm, v[0], v[1], v[2], v[3], v[4], v[5]);
  g->pathIsSingleRect = NO;
}
static void PDFCurveV(CGPDFScannerRef s, void *info) {  // first control point = current point
  double v[4];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 4) || CGPathIsEmpty(g->path)) return;
  CGAffineTransform inverse = CGAffineTransformInvert(g->state.ctm);
  CGPoint current = CGPointApplyAffineTransform(CGPathGetCurrentPoint(g->path), inverse);
  CGPathAddCurveToPoint(g->path, &g->state.ctm, current.x, current.y, v[0], v[1], v[2], v[3]);
  g->pathIsSingleRect = NO;
}
static void PDFCurveY(CGPDFScannerRef s, void *info) {  // second control point = end point
  double v[4];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 4) || CGPathIsEmpty(g->path)) return;
  CGPathAddCurveToPoint(g->path, &g->state.ctm, v[0], v[1], v[2], v[3], v[2], v[3]);
  g->pathIsSingleRect = NO;
}
static void PDFClose(CGPDFScannerRef s, void *info) {
  (void)s;
  ANMPDFGeometry *g = PDFInfo(info);
  if (!CGPathIsEmpty(g->path)) CGPathCloseSubpath(g->path);
}
static void PDFRect(CGPDFScannerRef s, void *info) {
  double v[4];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 4)) return;
  BOOL first = CGPathIsEmpty(g->path);
  CGPathAddRect(g->path, &g->state.ctm, CGRectMake(v[0], v[1], v[2], v[3]));
  g->subpaths++;
  g->pathIsSingleRect = first;
}

static void PDFPaint(ANMPDFGeometry *g, BOOL fill, BOOL stroke, BOOL evenOdd, BOOL close) {
  if (close && !CGPathIsEmpty(g->path)) CGPathCloseSubpath(g->path);
  if (CGPathIsEmpty(g->path)) return;
  if (g->paths.count >= MAX_FALLBACK_PATHS) {
    g->truncated = YES;
    PDFResetPath(g);
    return;
  }
  NSString *d = SVGPathData(g->path, CGAffineTransformIdentity, &g->budget);
  if (!d) {
    g->truncated = YES;
    PDFResetPath(g);
    return;
  }
  CGAffineTransform m = g->state.ctm;
  double scale = sqrt(fabs(m.a * m.d - m.b * m.c));
  NSMutableDictionary *entry = [@{
    @"page" : @(g->pageIndex),
    @"paint" : fill && stroke ? @"fillStroke" : fill ? @"fill" : @"stroke",
    @"kind" : g->pathIsSingleRect ? @"rectangle" : @"path",
    @"d" : d,
    @"bounds" : PaperRectJSON(CGPathGetPathBoundingBox(g->path)),
  } mutableCopy];
  if (fill) {
    entry[@"fillRule"] = evenOdd ? @"evenodd" : @"nonzero";
    entry[@"fillColor"] = @[ FiniteNumber(g->state.fill[0]), FiniteNumber(g->state.fill[1]),
                             FiniteNumber(g->state.fill[2]), FiniteNumber(g->state.fill[3]) ];
  }
  if (stroke) {
    entry[@"lineWidth"] = FiniteNumber(g->state.lineWidth * scale);
    entry[@"strokeColor"] = @[ FiniteNumber(g->state.stroke[0]), FiniteNumber(g->state.stroke[1]),
                               FiniteNumber(g->state.stroke[2]), FiniteNumber(g->state.stroke[3]) ];
  }
  [g->paths addObject:entry];
  PDFResetPath(g);
}
static void PDFStroke(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), NO, YES, NO, NO); }
static void PDFCloseStroke(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), NO, YES, NO, YES); }
static void PDFFill(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), YES, NO, NO, NO); }
static void PDFFillEO(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), YES, NO, YES, NO); }
static void PDFFillStroke(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), YES, YES, NO, NO); }
static void PDFFillStrokeEO(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), YES, YES, YES, NO); }
static void PDFCloseFillStroke(CGPDFScannerRef s, void *info) { (void)s, PDFPaint(PDFInfo(info), YES, YES, NO, YES); }
static void PDFCloseFillStrokeEO(CGPDFScannerRef s, void *info) {
  (void)s, PDFPaint(PDFInfo(info), YES, YES, YES, YES);
}
static void PDFEndPath(CGPDFScannerRef s, void *info) {  // `n`: a clip or no-op path, never painted
  (void)s;
  PDFResetPath(PDFInfo(info));
}
static void PDFSave(CGPDFScannerRef s, void *info) {
  (void)s;
  ANMPDFGeometry *g = PDFInfo(info);
  if (g->stack.count < 256) [g->stack addObject:[NSValue valueWithBytes:&g->state objCType:@encode(PDFGraphicsState)]];
}
static void PDFRestore(CGPDFScannerRef s, void *info) {
  (void)s;
  ANMPDFGeometry *g = PDFInfo(info);
  if (!g->stack.count) return;
  [g->stack.lastObject getValue:&g->state];
  [g->stack removeLastObject];
}
static void PDFConcat(CGPDFScannerRef s, void *info) {
  double v[6];
  ANMPDFGeometry *g = PDFInfo(info);
  if (!PopNumbers(s, v, 6)) return;
  g->state.ctm = CGAffineTransformConcat(CGAffineTransformMake(v[0], v[1], v[2], v[3], v[4], v[5]), g->state.ctm);
}
static void PDFLineWidth(CGPDFScannerRef s, void *info) {
  double v[1];
  if (PopNumbers(s, v, 1)) PDFInfo(info)->state.lineWidth = v[0];
}
static void PDFSetColor(double *target, const double *v, int n) {
  if (n == 1) target[0] = target[1] = target[2] = v[0];
  if (n == 3) target[0] = v[0], target[1] = v[1], target[2] = v[2];
  if (n == 4) {  // CMYK, naive conversion
    target[0] = (1 - v[0]) * (1 - v[3]);
    target[1] = (1 - v[1]) * (1 - v[3]);
    target[2] = (1 - v[2]) * (1 - v[3]);
  }
}
static void PDFColorOp(CGPDFScannerRef s, void *info, BOOL fill, int n) {
  double v[4];
  ANMPDFGeometry *g = PDFInfo(info);
  if (PopNumbers(s, v, n)) PDFSetColor(fill ? g->state.fill : g->state.stroke, v, n);
}
static void PDFStrokeGray(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, NO, 1); }
static void PDFFillGray(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, YES, 1); }
static void PDFStrokeRGB(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, NO, 3); }
static void PDFFillRGB(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, YES, 3); }
static void PDFStrokeCMYK(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, NO, 4); }
static void PDFFillCMYK(CGPDFScannerRef s, void *info) { PDFColorOp(s, info, YES, 4); }
static void PDFSkip(ANMPDFGeometry *g, NSString *what) { g->skipped[what] = @(g->skipped[what].unsignedIntegerValue + 1); }
static void PDFText(CGPDFScannerRef s, void *info) { (void)s, PDFSkip(PDFInfo(info), @"textObjects"); }
static void PDFXObject(CGPDFScannerRef s, void *info) { (void)s, PDFSkip(PDFInfo(info), @"xObjects"); }
static void PDFShading(CGPDFScannerRef s, void *info) { (void)s, PDFSkip(PDFInfo(info), @"shadings"); }
static void PDFInlineImage(CGPDFScannerRef s, void *info) { (void)s, PDFSkip(PDFInfo(info), @"inlineImages"); }

static NSDictionary *PDFGeometry(NSData *data) {
  CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
  CGPDFDocumentRef document = provider ? CGPDFDocumentCreateWithProvider(provider) : NULL;
  CGDataProviderRelease(provider);
  if (!document) return @{@"available" : @NO, @"reason" : @"fallback_pdf_unreadable"};
  if (CGPDFDocumentIsEncrypted(document)) {
    CGPDFDocumentRelease(document);
    return @{@"available" : @NO, @"reason" : @"fallback_pdf_unreadable"};
  }
  size_t pageCount = CGPDFDocumentGetNumberOfPages(document);
  CGPDFOperatorTableRef table = CGPDFOperatorTableCreate();
  struct {
    const char *op;
    CGPDFOperatorCallback callback;
  } ops[] = {
      {"m", PDFMoveTo},      {"l", PDFLineTo},        {"c", PDFCurveTo},         {"v", PDFCurveV},
      {"y", PDFCurveY},      {"h", PDFClose},         {"re", PDFRect},           {"S", PDFStroke},
      {"s", PDFCloseStroke}, {"f", PDFFill},          {"F", PDFFill},            {"f*", PDFFillEO},
      {"B", PDFFillStroke},  {"B*", PDFFillStrokeEO}, {"b", PDFCloseFillStroke}, {"b*", PDFCloseFillStrokeEO},
      {"n", PDFEndPath},     {"q", PDFSave},          {"Q", PDFRestore},         {"cm", PDFConcat},
      {"w", PDFLineWidth},   {"G", PDFStrokeGray},    {"g", PDFFillGray},        {"RG", PDFStrokeRGB},
      {"rg", PDFFillRGB},    {"K", PDFStrokeCMYK},    {"k", PDFFillCMYK},        {"BT", PDFText},
      {"Do", PDFXObject},    {"sh", PDFShading},      {"BI", PDFInlineImage},
  };
  for (size_t i = 0; i < COUNT(ops); i++) CGPDFOperatorTableSetCallback(table, ops[i].op, ops[i].callback);
  ANMPDFGeometry *g = [ANMPDFGeometry new];
  g->paths = [NSMutableArray array];
  g->skipped = [NSMutableDictionary dictionary];
  g->budget = MAX_PAPER_PATH_ELEMENTS;
  NSMutableArray *pages = [NSMutableArray array];
  for (size_t p = 1; p <= pageCount && p <= MAX_FALLBACK_PDF_PAGES; p++) {
    CGPDFPageRef page = CGPDFDocumentGetPage(document, p);
    if (!page) continue;
    g->state = (PDFGraphicsState){CGAffineTransformIdentity, 1, {0, 0, 0, 1}, {0, 0, 0, 1}};
    g->stack = [NSMutableArray array];
    g->pageIndex = p - 1;
    PDFResetPath(g);
    [pages addObject:@{@"index" : @(p - 1), @"mediaBox" : PaperRectJSON(CGPDFPageGetBoxRect(page, kCGPDFMediaBox))}];
    CGPDFContentStreamRef stream = CGPDFContentStreamCreateWithPage(page);
    CGPDFScannerRef scanner = CGPDFScannerCreate(stream, table, (__bridge void *)g);
    CGPDFScannerScan(scanner);
    CGPDFScannerRelease(scanner);
    CGPDFContentStreamRelease(stream);
  }
  if (g->path) CGPathRelease(g->path);
  CGPDFOperatorTableRelease(table);
  CGPDFDocumentRelease(document);
  return @{
    @"available" : @YES,
    @"reason" : [NSNull null],
    @"pageCount" : @(pageCount),
    @"pages" : pages,
    @"coordinateSpace" : @"pdf-page",
    @"paths" : g->paths,
    @"skipped" : g->skipped,
    @"truncated" : @((BOOL)(g->truncated || pageCount > MAX_FALLBACK_PDF_PAGES)),
  };
}

// Reads Notes' stored fallback PDF for the attachment, when it records one,
// without following links: Accounts/<account>/FallbackPDFs/<attachment>/
// <generation>/FallbackPDF.pdf beside the store.
static NSDictionary *PaperFallbackGeometry(NSManagedObject *attachment, StoreLocation store, NSString *accountId) {
  if (!attachment.entity.propertiesByName[@"fallbackPDFGeneration"])
    return @{@"available" : @NO, @"reason" : @"not_modeled"};
  NSString *generation = [attachment valueForKey:@"fallbackPDFGeneration"];
  if (![generation isKindOfClass:[NSString class]] || !generation.length)
    return @{@"available" : @NO, @"reason" : @"no_fallback_pdf"};
  NSString *attachmentId = [attachment valueForKey:@"identifier"];
  if (!IsSafePathComponent(accountId) || !IsSafePathComponent(attachmentId) || !IsSafePathComponent(generation))
    return @{@"available" : @NO, @"reason" : @"fallback_pdf_unreadable"};
  NSString *container = [[store.path stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath];
  NSString *file = [container
      stringByAppendingPathComponent:[NSString stringWithFormat:@"Accounts/%@/FallbackPDFs/%@/%@/FallbackPDF.pdf",
                                                                accountId, attachmentId, generation]];
  if (![[[file stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath]
          isEqualToString:[file stringByDeletingLastPathComponent]])
    return @{@"available" : @NO, @"reason" : @"fallback_pdf_unreadable"};
  int fd = open(file.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return @{@"available" : @NO, @"reason" : @"fallback_pdf_missing", @"generation" : generation};
  struct stat info;
  NSMutableData *data = nil;
  if (fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_size > 0 && info.st_size <= MAX_FALLBACK_PDF_BYTES) {
    data = [NSMutableData dataWithLength:(NSUInteger)info.st_size];
    ssize_t total = 0;
    while (total < info.st_size) {
      ssize_t n = read(fd, (uint8_t *)data.mutableBytes + total, (size_t)(info.st_size - total));
      if (n <= 0) break;
      total += n;
    }
    if (total != info.st_size) data = nil;
  }
  close(fd);
  if (!data) return @{@"available" : @NO, @"reason" : @"fallback_pdf_unreadable", @"generation" : generation};
  NSMutableDictionary *out = [PDFGeometry(data) mutableCopy];
  out[@"generation"] = generation;
  out[@"bytes"] = @(data.length);
  return out;
}

#pragma mark Paper read action

// One stroke as JSON; points are compact arrays in `pointFields` order.
// `budget` is the number of points still allowed. The strokes that carry
// points are always a prefix of the drawing's stroke order.
static NSDictionary *PaperStrokeJSON(PKStroke *stroke, BOOL includePoints, NSUInteger *budget,
                                     NSMutableArray *warnings) {
  PKInk *ink = stroke.ink;
  NSString *inkType = ink.inkType ?: @"";
  NSString *prefix = @"com.apple.ink.";
  id color = ColorJSON(ink.color.CGColor);
  if (color == [NSNull null]) [warnings addObject:@"A stroke color could not be converted to sRGB"];
  CGAffineTransform t = stroke.transform;
  double tv[6] = {t.a, t.b, t.c, t.d, t.tx, t.ty};
  BOOL transformFinite = YES;
  for (int k = 0; k < 6; k++)
    if (!isfinite(tv[k])) transformFinite = NO;
  PKStrokePath *path = stroke.path;
  NSUInteger count = path.count;
  double widthSum = 0;
  BOOL emit = includePoints && count <= *budget;
  NSMutableArray *points = [NSMutableArray array];
  for (NSUInteger i = 0; i < count; i++) {
    PKStrokePoint *p = [path pointAtIndex:i];
    double v[9] = {p.location.x, p.location.y, p.size.width, p.size.height, p.opacity,
                   p.force,      p.azimuth,    p.altitude,   p.timeOffset};
    for (int k = 0; k < 9; k++)
      if (!isfinite(v[k])) {
        [warnings addObject:@"A stroke with a non-finite point was skipped"];
        return nil;
      }
    widthSum += v[2];
    if (emit) {
      NSMutableArray *row = [NSMutableArray arrayWithCapacity:9];
      for (int k = 0; k < 9; k++) [row addObject:@(Round4(v[k]))];
      [points addObject:row];
    }
  }
  *budget = emit ? *budget - count : 0;
  NSMutableDictionary *out = [@{
    @"ink" : [inkType hasPrefix:prefix] ? [inkType substringFromIndex:prefix.length] : inkType,
    @"inkIdentifier" : inkType,
    @"color" : color,
    @"width" : @(Round4(count ? widthSum / count : 0)),
    @"transform" : transformFinite ? @[ @(tv[0]), @(tv[1]), @(tv[2]), @(tv[3]), @(Round4(tv[4])), @(Round4(tv[5])) ]
                                   : [NSNull null],
    @"pointCount" : @(count),
    @"renderBounds" : PaperRectJSON(stroke.renderBounds),
    @"masked" : @((BOOL)(stroke.mask != nil)),
  } mutableCopy];
  if (emit)
    out[@"points"] = points;
  else if (includePoints)
    out[@"pointsOmitted"] = @YES;
  return out;
}

// The one Paper attachment the request names: `attachmentIdentifier`, or the
// note's only Paper drawing.
static NSManagedObject *PaperAttachmentFor(NSManagedObject *note, NSString *attachmentId) {
  NSMutableArray *papers = [NSMutableArray array];
  NSManagedObject *named = nil;
  for (NSManagedObject *candidate in [note valueForKey:@"attachments"]) {
    NSString *identifier = [candidate valueForKey:@"identifier"];
    if (![identifier isKindOfClass:[NSString class]]) continue;
    if (attachmentId && [identifier caseInsensitiveCompare:attachmentId] == NSOrderedSame) named = candidate;
    if (IsPaperAttachment(candidate) && ![[candidate valueForKey:@"markedForDeletion"] boolValue])
      [papers addObject:candidate];
  }
  if (attachmentId) {
    if (!named) Fail(@"not_found", @"The note has no attachment with that attachmentIdentifier", nil);
    if (!IsPaperAttachment(named))
      Fail(@"unsupported_attachment", @"That attachment is not a Paper drawing (com.apple.paper)",
           @{@"typeUTI" : OrNull([named valueForKey:@"typeUTI"])});
    if ([[named valueForKey:@"markedForDeletion"] boolValue])
      Fail(@"unsupported_attachment", @"That Paper drawing is deleted", nil);
    return named;
  }
  if (!papers.count) Fail(@"not_found", @"The note has no Paper drawing", nil);
  if (papers.count > 1) {
    NSMutableArray *ids = [NSMutableArray array];
    for (NSManagedObject *paper in papers) [ids addObject:[paper valueForKey:@"identifier"]];
    [ids sortUsingSelector:@selector(compare:)];
    Fail(@"ambiguous_attachment", @"The note has more than one Paper drawing; pass attachmentIdentifier",
         @{@"attachmentIdentifiers" : ids});
  }
  return papers.firstObject;
}

// `probe` rows: readPaper (strokes and fallback geometry) and
// readPaperShapes (the PaperKit layer, which also needs readPaper).
static NSDictionary *PaperReadFeatureReport(BOOL contextOK, NSString *contextReason, BOOL shapes) {
  NSMutableArray *missing = [MissingForPaperRead() mutableCopy];
  NSString *reason = @"private_api_unavailable";
  if (shapes && gFrameworkLoaded) {
    NSArray *shapeMissing = MissingForPaperShapes();
    if (shapeMissing.count && !PaperShapesOSSupported()) reason = @"requires_macos_27";
    [missing addObjectsFromArray:shapeMissing];
  }
  if (missing.count) return @{@"available" : @NO, @"reason" : reason, @"missing" : missing};
  if (!contextOK)
    return @{@"available" : @NO, @"reason" : contextReason ?: @"store_unavailable", @"missing" : @[]};
  return @{@"available" : @YES, @"reason" : [NSNull null], @"missing" : @[]};
}

static NSDictionary *HandleReadPaper(NSDictionary *request) {
  NSString *identifier = RequireIdentifier(request);
  NSString *attachmentId = nil;
  if (request[@"attachmentIdentifier"]) {
    attachmentId = RequireString(request, @"attachmentIdentifier");
    if (!IsUUID(attachmentId)) Fail(@"invalid_request", @"`attachmentIdentifier` must be a UUID", nil);
  }
  id includeValue = request[@"includePoints"];
  if (includeValue && !IsJSONBool(includeValue)) Fail(@"invalid_request", @"`includePoints` must be a boolean", nil);
  BOOL includePoints = includeValue ? [includeValue boolValue] : YES;
  id maxValue = request[@"maxPoints"];
  if (maxValue && (!IsJSONNumber(maxValue) || [maxValue doubleValue] != floor([maxValue doubleValue]) ||
                   [maxValue doubleValue] < 1 || [maxValue doubleValue] > MAX_READ_PAPER_POINTS))
    Fail(@"invalid_request", @"`maxPoints` must be an integer from 1 to 40000", nil);
  NSUInteger budget = maxValue ? (NSUInteger)[maxValue integerValue] : DEFAULT_READ_PAPER_POINTS;
  id shapesValue = request[@"includeShapes"];
  if (shapesValue && !IsJSONBool(shapesValue)) Fail(@"invalid_request", @"`includeShapes` must be a boolean", nil);
  BOOL includeShapes = shapesValue ? [shapesValue boolValue] : YES;
  LoadFramework();
  NSArray *missing = MissingForPaperRead();
  if (missing.count)
    Fail(@"private_api_unavailable", @"Required NotesShared or PencilKit API is not available on this macOS",
         @{@"missing" : missing});

  StoreLocation store = ResolveStore();
  NSString *sandbox = MakePrivateTempDir(@"apple-notes-paper-read");
  @try {
    // Before the store opens: from here on no ICAccount directory method can
    // point into the live container.
    InstallAccountSandbox(sandbox);
    NSManagedObjectContext *context = OpenContext(store, YES);
    NSManagedObject *note = FetchNote(context, identifier);
    if (SendBool(note, "isPasswordProtected"))
      Fail(@"unsupported_note", @"Drawings in locked notes are encrypted and are not supported", nil);
    NSManagedObject *attachment = PaperAttachmentFor(note, attachmentId);
    if ([[attachment valueForKey:@"needsInitialFetchFromCloud"] boolValue])
      Fail(@"bundle_unavailable", @"The drawing has not finished downloading from iCloud", nil);
    id account = [note valueForKey:@"account"];
    NSString *accountId = account ? [account valueForKey:@"identifier"] : nil;
    NSString *paperId = [attachment valueForKey:@"identifier"];
    SnapshotPaperBundle(store.path, accountId, paperId, sandbox);

    NSMutableArray *warnings = [NSMutableArray array];
    NSArray<PKDrawing *> *drawings = DrawingsForAttachment(attachment);
    NSMutableArray *strokes = [NSMutableArray array];
    NSMutableSet *inks = [NSMutableSet set];
    NSUInteger totalPoints = 0, strokeTotal = 0;
    CGRect bounds = CGRectNull;
    BOOL truncated = NO;
    for (PKDrawing *drawing in drawings) {
      if (!CGRectIsEmpty(drawing.bounds)) bounds = CGRectUnion(bounds, drawing.bounds);
      for (PKStroke *stroke in drawing.strokes) {
        strokeTotal++;
        if (strokes.count >= MAX_READ_PAPER_STROKES) {
          truncated = YES;
          continue;
        }
        NSDictionary *json = PaperStrokeJSON(stroke, includePoints, &budget, warnings);
        if (!json) continue;
        if (json[@"pointsOmitted"]) truncated = YES;
        totalPoints += [json[@"pointCount"] unsignedIntegerValue];
        [inks addObject:json[@"ink"]];
        [strokes addObject:json];
      }
    }

    NSDictionary *shapes = @{@"available" : @NO, @"reason" : @"not_requested", @"missing" : @[], @"shapes" : @[]};
    if (includeShapes) {
      NSString *bundle = [sandbox
          stringByAppendingPathComponent:[NSString stringWithFormat:@"Accounts/%@/Paper/Bundles/%@.bundle", accountId,
                                                                    paperId]];
      shapes = PaperDecodeShapes([NSURL fileURLWithPath:bundle isDirectory:YES], warnings);
      if ([shapes[@"truncated"] boolValue]) truncated = YES;
      if ([shapes[@"available"] boolValue] && [shapes[@"markupStrokeCount"] unsignedIntegerValue] != strokeTotal)
        [warnings addObject:@"PaperKit and NotesShared report different stroke counts for this drawing"];
    }
    NSDictionary *fallback = PaperFallbackGeometry(attachment, store, accountId);
    if ([fallback[@"truncated"] boolValue]) truncated = YES;

    return @{
      @"status" : @"ok",
      @"storeKind" : store.isCopy ? @"copy" : @"live",
      @"identifier" : [note valueForKey:@"identifier"],
      @"revision" : RevisionToken(note),
      @"attachmentIdentifier" : paperId,
      @"typeUTI" : [attachment valueForKey:@"typeUTI"],
      @"drawingCount" : @(drawings.count),
      @"strokeCount" : @(strokeTotal),
      @"returnedStrokeCount" : @(strokes.count),
      @"pointCount" : @(totalPoints),
      @"bounds" : CGRectIsNull(bounds) ? [NSNull null] : PaperRectJSON(bounds),
      @"inks" : [[inks allObjects] sortedArrayUsingSelector:@selector(compare:)],
      @"pointFields" :
          @[ @"x", @"y", @"width", @"height", @"opacity", @"force", @"azimuth", @"altitude", @"timeOffset" ],
      @"strokes" : strokes,
      @"shapeDecode" : @{
        @"available" : shapes[@"available"],
        @"reason" : shapes[@"reason"],
        @"missing" : shapes[@"missing"],
        @"elementCount" : OrNull(shapes[@"elementCount"]),
        @"elementKinds" : OrNull(shapes[@"elementKinds"]),
      },
      @"shapes" : shapes[@"shapes"],
      @"fallbackGeometry" : fallback,
      @"truncated" : @(truncated),
      @"warnings" : warnings,
    };
  } @finally {
    [NSFileManager.defaultManager removeItemAtPath:sandbox error:NULL];
  }
}

#pragma mark - Sync state

#define MAX_SYNC_IDENTIFIERS 50

// Read-only upload bookkeeping for notes and folders. The helper saves
// through its own Core Data stack and only Notes.app can upload, so after a
// write the server reads these counters (and can nudge Notes.app, see
// src/services/privateSyncNudge.ts). Reports Notes' own counters; it never
// infers an upload the counters do not record.
static NSDictionary *SyncStateFor(NSManagedObjectContext *context, NSString *identifier) {
  for (NSString *entity in @[ @"ICNote", @"ICFolder" ]) {
    NSFetchRequest *request = [NSFetchRequest fetchRequestWithEntityName:entity];
    request.predicate = [NSPredicate predicateWithFormat:@"identifier ==[c] %@", identifier];
    request.fetchLimit = 2;
    NSError *error = nil;
    NSArray *rows = [context executeFetchRequest:request error:&error];
    if (!rows)
      Fail(@"store_unavailable", @"Sync state fetch failed",
           @{@"detail" : OrNull(error.localizedDescription)});
    if (rows.count > 1) return @{@"identifier" : identifier, @"found" : @NO, @"reason" : @"ambiguous"};
    if (rows.count == 0) continue;
    NSManagedObject *object = rows.firstObject;
    BOOL isNote = [entity isEqualToString:@"ICNote"];
    id folder = isNote ? [object valueForKey:@"folder"] : nil;
    id cloud = [object valueForKey:@"cloudState"];
    NSMutableDictionary *state = [@{
      @"identifier" : identifier,
      @"found" : @YES,
      @"kind" : isNote ? @"note" : @"folder",
      @"objectURI" : object.objectID.URIRepresentation.absoluteString,
      @"markedForDeletion" : @([[object valueForKey:@"markedForDeletion"] boolValue]),
      @"inICloudAccount" : @((BOOL)([object respondsToSelector:sel_registerName("isInICloudAccount")] &&
                                    SendBool(object, "isInICloudAccount"))),
      @"cloudStateAvailable" : @((BOOL)(cloud != nil)),
    } mutableCopy];
    if (cloud) {
      long long current = [[cloud valueForKey:@"currentLocalVersion"] longLongValue];
      long long synced = [[cloud valueForKey:@"latestVersionSyncedToCloud"] longLongValue];
      state[@"currentLocalVersion"] = @(current);
      state[@"latestVersionSyncedToCloud"] = @(synced);
      state[@"uploadPending"] = @((BOOL)(current > synced));
    }
    if (isNote) {
      state[@"folderIdentifier"] = OrNull(folder ? [folder valueForKey:@"identifier"] : nil);
      state[@"folderObjectURI"] =
          OrNull(folder ? [folder objectID].URIRepresentation.absoluteString : nil);
      state[@"passwordProtected"] = @(SendBool(object, "isPasswordProtected"));
      state[@"deletedOrInTrash"] = @(SendBool(object, "isDeletedOrInTrash"));
      state[@"sharedViaICloud"] = @(SendBool(object, "isSharedViaICloud"));
      state[@"revision"] = RevisionToken(object);
    }
    return state;
  }
  return @{@"identifier" : identifier, @"found" : @NO, @"reason" : @"not_found"};
}

static NSDictionary *HandleReadSyncState(NSDictionary *request) {
  id identifiers = request[@"identifiers"];
  if (![identifiers isKindOfClass:[NSArray class]] || [identifiers count] == 0 ||
      [identifiers count] > MAX_SYNC_IDENTIFIERS)
    Fail(@"invalid_request", @"`identifiers` must be an array of 1-50 note or folder identifiers", nil);
  for (id identifier in identifiers)
    if (!IsUUID(identifier)) Fail(@"invalid_request", @"Every identifier must be a Notes UUID", nil);
  RequireFeature(FeatureRead);
  NSManagedObjectContext *context = OpenContext(ResolveStore(), YES);
  NSMutableArray *objects = [NSMutableArray array];
  for (NSString *identifier in identifiers) [objects addObject:SyncStateFor(context, identifier)];
  // Library-wide backlog with Notes' own upload-eligibility test.
  NSFetchRequest *pending = [NSFetchRequest fetchRequestWithEntityName:@"ICCloudState"];
  pending.predicate =
      [NSPredicate predicateWithFormat:@"currentLocalVersion > latestVersionSyncedToCloud"];
  NSError *error = nil;
  NSUInteger backlog = [context countForFetchRequest:pending error:&error];
  return @{
    @"status" : @"ok",
    @"objects" : objects,
    @"pendingUploadCount" : backlog == NSNotFound ? [NSNull null] : @(backlog),
    @"syncHostRunning" : @(NotesAppRunning()),
  };
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
    ScopeSubject subject = ScopeSubjectForAction(action);
    if (subject != ScopeSubjectNone) [allowed addObjectsFromArray:ScopeGuardKeys()];
    for (NSString *key in request)
      if (![allowed containsObject:key])
        Fail(@"invalid_request", [NSString stringWithFormat:@"Unknown request field `%@`", key], nil);
    if (subject == ScopeSubjectNone) return kActions[i].handler(request);
    ParseScopeGuard(request, subject);
    NSDictionary *result = kActions[i].handler(request);
    CheckScopeGuardWithoutSave();
    return result;
  }
  Fail(@"unknown_action", @"Action is not in the whitelist", @{@"actions" : ActionNames()});
  return nil;
}

int main(void) {
  @autoreleasepool {
    @try {
      EmitAndExit(Dispatch(), 0);
    } @catch (HelperError *e) {
      NSMutableDictionary *out = [e.userInfo mutableCopy] ?: [NSMutableDictionary dictionary];
      if (gWriteRequest && !gSaveAttempted && !out[@"committed"]) out[@"committed"] = @NO;
      out[@"status"] = @"error";
      out[@"message"] = e.reason ?: @"error";
      EmitAndExit(out, 1);
    } @catch (NSException *e) {
      NSMutableDictionary *out = [@{
        @"status" : @"error",
        @"code" : @"internal_error",
        @"message" : [NSString stringWithFormat:@"%@: %@", e.name, e.reason ?: @""],
      } mutableCopy];
      // Before the save nothing was written; after a successful save the
      // write is committed even though the rest of the handler failed.
      // Between the two (the save itself threw) the outcome stays unknown.
      if (gWriteRequest && !gSaveAttempted) out[@"committed"] = @NO;
      if (gSaveSucceeded) {
        out[@"code"] = @"verification_failed";
        out[@"committed"] = @YES;
      }
      EmitAndExit(out, 1);
    }
  }
  return 1;
}
