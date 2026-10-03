// Test fixture generator. Loads only the installed CoreData model, never NotesShared.
// Every object is a generic NSManagedObject, avoiding private awakeFromInsert hooks.
// Invoke only through the scratch-only sandbox in test-private-writer-synthetic-store.mjs.
#import <Foundation/Foundation.h>
#import <CoreData/CoreData.h>
#import <objc/runtime.h>
#include <unistd.h>
extern const int SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t, const char *, int, ...);

static NSManagedObject *Insert(NSManagedObjectContext *context, NSString *name) {
  NSEntityDescription *entity = context.persistentStoreCoordinator.managedObjectModel.entitiesByName[name];
  if (!entity || entity.isAbstract) @throw [NSException exceptionWithName:@"UnsupportedModel" reason:name userInfo:nil];
  return [[NSManagedObject alloc] initWithEntity:entity insertIntoManagedObjectContext:context];
}
static void Set(NSManagedObject *object, NSString *key, id value) {
  if (!object.entity.propertiesByName[key])
    @throw [NSException exceptionWithName:@"UnsupportedModel" reason:key userInfo:nil];
  [object setValue:value forKey:key];
}
static NSDate *FixtureDate(void) { return [NSDate dateWithTimeIntervalSince1970:1700000000]; }
static void CloudState(NSManagedObjectContext *context, NSManagedObject *object) {
  NSManagedObject *state = Insert(context, @"ICCloudState");
  Set(state, @"currentLocalVersion", @1);
  Set(state, @"latestVersionSyncedToCloud", @0);
  Set(state, @"inCloud", @NO);
  Set(state, @"localVersionDate", FixtureDate());
  Set(state, @"cloudSyncingObject", object);
  Set(object, @"needsInitialFetchFromCloud", @NO);
  Set(object, @"needsToBeFetchedFromCloud", @NO);
}
static BOOL IsUUID(NSString *value) {
  return [[NSUUID alloc] initWithUUIDString:value] != nil;
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    @try {
      if (argc != 5) { fputs("usage: synthetic-notes-store NEW_STORE PAYLOAD NOTE_UUID NOTES_REPLICA_UUID\n", stderr); return 2; }
      NSString *storePath = @(argv[1]), *payloadPath = @(argv[2]);
      NSString *noteIdentifier = @(argv[3]), *notesReplicaIdentifier = @(argv[4]);
      // Caller paths are confined by the mandatory surrounding sandbox. Refuse
      // replacing any existing database or consuming a non-UUID identity.
      if (!storePath.isAbsolutePath || !payloadPath.isAbsolutePath || !IsUUID(noteIdentifier) ||
          !IsUUID(notesReplicaIdentifier) || [NSFileManager.defaultManager fileExistsAtPath:storePath]) return 3;
      NSString *root = [[storePath stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath];
      NSString *payloadRoot = [[payloadPath stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath];
      const char *realHome = getenv("HOME");
      NSString *privateSentinel = realHome ? [@(realHome) stringByAppendingPathComponent:@"Library/Preferences/.GlobalPreferences.plist"] : nil;
      // Policy inspection only: these paths are never opened. The generator
      // must itself refuse accidental invocation outside the denying sandbox.
      if (!([root hasPrefix:@"/tmp/apple-notes-synthetic-fixture-"] ||
            [root hasPrefix:@"/private/tmp/apple-notes-synthetic-fixture-"]) ||
          ![root isEqualToString:payloadRoot] || !privateSentinel ||
          sandbox_check(getpid(), "file-read-data", 1 | SANDBOX_CHECK_NO_REPORT, privateSentinel.UTF8String) != 1 ||
          sandbox_check(getpid(), "network-outbound", SANDBOX_CHECK_NO_REPORT, NULL) != 1 ||
          sandbox_check(getpid(), "mach-lookup", 2 | SANDBOX_CHECK_NO_REPORT, "com.apple.cfprefsd.agent") != 1 ||
          objc_getClass("ICNote") != Nil) return 10;
      NSData *payload = [NSData dataWithContentsOfFile:payloadPath];
      if (!payload.length || payload.length > 1024 * 1024) return 4;
      NSManagedObjectModel *model = [[NSManagedObjectModel alloc] initWithContentsOfURL:
          [NSURL fileURLWithPath:@"/System/Library/PrivateFrameworks/NotesShared.framework/Resources/NoteData.mom"]];
      if (!model) return 5;
      NSPersistentStoreCoordinator *coordinator = [[NSPersistentStoreCoordinator alloc] initWithManagedObjectModel:model];
      NSDictionary *options = @{
        NSMigratePersistentStoresAutomaticallyOption: @NO,
        NSInferMappingModelAutomaticallyOption: @NO,
        NSPersistentHistoryTrackingKey: @YES,
        NSSQLitePragmasOption: @{ @"journal_mode": @"DELETE" },
      };
      NSError *error = nil;
      NSPersistentStore *store = [coordinator addPersistentStoreWithType:NSSQLiteStoreType configuration:nil
          URL:[NSURL fileURLWithPath:storePath] options:options error:&error];
      if (!store) { NSLog(@"Synthetic store creation failed: %@", error); return 6; }
      NSManagedObjectContext *context = [[NSManagedObjectContext alloc] initWithConcurrencyType:NSMainQueueConcurrencyType];
      context.persistentStoreCoordinator = coordinator;
      context.mergePolicy = NSErrorMergePolicy;
      context.undoManager = nil;
      context.transactionAuthor = @"synthetic-fixture-generator";
      NSManagedObject *account = Insert(context, @"ICAccount");
      NSManagedObject *folder = Insert(context, @"ICFolder");
      NSManagedObject *note = Insert(context, @"ICNote");
      NSManagedObject *data = Insert(context, @"ICNoteData");
      Set(account, @"identifier", @"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
      Set(account, @"name", @"Synthetic Account");
      Set(account, @"accountType", @0);
      Set(account, @"owner", account);
      // Despite the property's name, NotesShared initializes this dictionary
      // with bundle identifier keys and UUID string values. Preseed only test
      // identities so its lazy initialization does not change the account on
      // the first note-only write. No production account metadata is copied.
      Set(account, @"replicaIDToBundleIdentifier", @{
        @"com.apple.Notes": notesReplicaIdentifier,
        @"com.apple.Notes.IntentsExtension": @"44444444-4444-4444-8444-444444444444",
        @"com.apple.Notes.SharingExtension": @"55555555-5555-4555-8555-555555555555",
      });
      CloudState(context, account);
      Set(folder, @"identifier", @"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB");
      Set(folder, @"title", @"Synthetic Folder");
      Set(folder, @"account", account);
      Set(folder, @"owner", account);
      Set(folder, @"folderType", @0);
      CloudState(context, folder);
      Set(note, @"identifier", noteIdentifier);
      Set(note, @"title", @"Synthetic fixture");
      Set(note, @"account", account);
      Set(note, @"folder", folder);
      Set(note, @"creationDate", FixtureDate());
      Set(note, @"modificationDate", FixtureDate());
      Set(note, @"lastViewedModificationDate", FixtureDate());
      Set(note, @"noteData", data);
      Set(data, @"data", payload);
      CloudState(context, note);
      if (![context save:&error]) { NSLog(@"Synthetic graph save failed: %@", error); return 7; }
      [context reset];
      if (![coordinator removePersistentStore:store error:&error]) { NSLog(@"Synthetic store close failed: %@", error); return 8; }
      puts("{\"created\":true,\"frameworkLoaded\":false,\"notes\":1,\"accounts\":1,\"folders\":1}");
      return 0;
    } @catch (NSException *error) {
      NSLog(@"Synthetic generator failed: %@: %@", error.name, error.reason);
      return 9;
    }
  }
}
