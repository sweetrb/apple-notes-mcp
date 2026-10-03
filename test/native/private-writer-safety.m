// Synthetic Core Data fixture. Never opens a Notes database or loads NotesShared.
#import <Foundation/Foundation.h>
#include <dlfcn.h>
static void *ForbiddenFrameworkLoad(const char *path, int flags) {
  (void)path; (void)flags;
  @throw [NSException exceptionWithName:@"fixture_framework_load" reason:@"No dynamic framework loads are allowed in this fixture" userInfo:nil];
}
#define dlopen ForbiddenFrameworkLoad
#define main private_writer_main
#include "../../native/private-helper/apple-notes-private-writer.m"
#undef main
#undef dlopen

static void Assert(BOOL condition, NSString *message) {
  if (!condition) @throw [NSException exceptionWithName:@"fixture_assertion" reason:message userInfo:nil];
}

static NSAttributeDescription *Attribute(NSString *name, NSAttributeType type) {
  NSAttributeDescription *attribute = [NSAttributeDescription new];
  attribute.name = name;
  attribute.attributeType = type;
  attribute.optional = YES;
  return attribute;
}

static NSManagedObjectContext *Fixture(void) {
  for (id observer in gSaveObservers) [NSNotificationCenter.defaultCenter removeObserver:observer];
  gSaveObservers = nil;
  gWriteRequest = YES;
  gSaveAttempted = NO;
  gSaveSucceeded = NO;
  gEarlySaves = 0;
  gStrictNotesClosed = NO;
  gScopeRequest = nil;
  NSEntityDescription *row = [NSEntityDescription new];
  row.name = @"FixtureRow";
  row.managedObjectClassName = @"NSManagedObject";
  NSRelationshipDescription *cloud = [NSRelationshipDescription new];
  cloud.name = @"cloudState";
  cloud.destinationEntity = row;
  cloud.optional = YES;
  cloud.minCount = 0;
  cloud.maxCount = 1;
  row.properties = @[ Attribute(@"text", NSStringAttributeType),
      Attribute(@"needsInitialFetchFromCloud", NSBooleanAttributeType),
      Attribute(@"needsToBeFetchedFromCloud", NSBooleanAttributeType),
      Attribute(@"serverRecordData", NSBinaryDataAttributeType),
      Attribute(@"userSpecificServerRecordData", NSBinaryDataAttributeType),
      Attribute(@"currentLocalVersion", NSInteger64AttributeType),
      Attribute(@"latestVersionSyncedToCloud", NSInteger64AttributeType), cloud ];
  NSManagedObjectModel *model = [NSManagedObjectModel new];
  model.entities = @[ row ];
  NSPersistentStoreCoordinator *coordinator = [[NSPersistentStoreCoordinator alloc] initWithManagedObjectModel:model];
  NSError *error = nil;
  Assert([coordinator addPersistentStoreWithType:NSInMemoryStoreType configuration:nil URL:nil options:nil error:&error] != nil,
         error.description);
  NSManagedObjectContext *context = [[NSManagedObjectContext alloc] initWithConcurrencyType:NSMainQueueConcurrencyType];
  context.persistentStoreCoordinator = coordinator;
  context.mergePolicy = NSErrorMergePolicy;
  context.transactionAuthor = kTransactionAuthor;
  context.userInfo[@"writerStoreIsCopy"] = @YES;
  return context;
}

static NSManagedObject *Row(NSManagedObjectContext *context, NSString *text) {
  NSManagedObject *row = [NSEntityDescription insertNewObjectForEntityForName:@"FixtureRow" inManagedObjectContext:context];
  [row setValue:text forKey:@"text"];
  return row;
}

static void Refuses(void (^action)(void), NSString *code) {
  BOOL refused = NO;
  @try { action(); }
  @catch (HelperError *error) {
    Assert([error.userInfo[@"code"] isEqual:code], [NSString stringWithFormat:@"Expected %@, got %@", code, error.userInfo]);
    refused = YES;
  }
  Assert(refused, [@"Expected refusal: " stringByAppendingString:code]);
}

static NSArray *RunFixture(void) {
  NSMutableArray *passed = [NSMutableArray array];
  Assert(!gFrameworkLoaded, @"NotesShared must remain unloaded");

  NSManagedObjectContext *context = Fixture();
  NSManagedObject *root = Row(context, @"reviewed");
  NSManagedObject *cloud = Row(context, @"owned cloud");
  [root setValue:cloud forKey:@"cloudState"];
  ObserveUnexpectedSaves(context);
  RequireExpectedChanges(context, @[ root ], [NSSet set]);
  SaveOrFailFor(context, @"fixture");
  Assert(gSaveSucceeded && !gEarlySaves, @"Guarded fixture save should succeed exactly once");
  NSManagedObjectContext *fresh = [[NSManagedObjectContext alloc] initWithConcurrencyType:NSMainQueueConcurrencyType];
  fresh.persistentStoreCoordinator = context.persistentStoreCoordinator;
  Assert([[[fresh existingObjectWithID:root.objectID error:NULL] valueForKey:@"text"] isEqual:@"reviewed"], @"Fresh read-back mismatch");
  Assert([context.transactionAuthor isEqual:@"apple-notes-mcp-private-writer"], @"Own transaction author");
  [passed addObject:@"owned fixture write and fresh read-back"];

  context = Fixture(); root = Row(context, @"reviewed");
  Row(context, @"unrelated insertion");
  Refuses(^{ RequireExpectedChanges(context, @[ root ], [NSSet setWithObject:@"FixtureRow"]); }, @"unexpected_changes");
  Assert(!gSaveAttempted, @"Unexpected insertion must fail before save");
  [passed addObject:@"unrelated insertion cannot use entity-wide exemption"];

  context = Fixture(); root = Row(context, @"reviewed");
  NSManagedObject *other = Row(context, @"unrelated");
  Assert([context save:NULL], @"Fixture setup save");
  [root setValue:@"changed" forKey:@"text"];
  [other setValue:@"unreviewed" forKey:@"text"];
  Refuses(^{ RequireExpectedChanges(context, @[ root ], [NSSet set]); }, @"unexpected_changes");
  [passed addObject:@"unrelated existing update refuses"];

  context = Fixture(); root = Row(context, @"reviewed");
  Assert([context save:NULL], @"Fixture setup save");
  [context deleteObject:root];
  Refuses(^{ RequireExpectedChanges(context, @[ root ], [NSSet set]); }, @"unexpected_changes");
  [passed addObject:@"deletion of allowed object refuses"];

  context = Fixture(); root = Row(context, @"reviewed");
  RequireExpectedChanges(context, @[ root ], [NSSet set]);
  other = Row(context, @"late unrelated cloud");
  [root setValue:other forKey:@"cloudState"];
  Refuses(^{ SaveOrFailFor(context, @"fixture"); }, @"unexpected_changes");
  Assert(!gSaveAttempted, @"Late side effect must fail before save");
  [passed addObject:@"save boundary cannot widen frozen ownership"];

  context = Fixture(); Row(context, @"undeclared write");
  Refuses(^{ SaveOrFailFor(context, @"fixture"); }, @"unexpected_changes");
  Assert(!gSaveAttempted, @"No manifest must fail before save");
  [passed addObject:@"every save requires expected objects"];

  context = Fixture(); root = Row(context, @"private API early save");
  ObserveUnexpectedSaves(context);
  Assert([context save:NULL], @"Simulated private API save");
  Assert(gEarlySaves == 1 && gSaveSucceeded, @"Early save must be recorded as committed");
  Refuses(^{ RequireExpectedChanges(context, @[ root ], [NSSet set]); }, @"unexpected_early_save");
  Refuses(^{ SaveOrFailFor(context, @"fixture"); }, @"unexpected_early_save");
  [passed addObject:@"early private API save stays committed and blocks continuation"];

  Fixture();
  for (NSUInteger mask = 0; mask < 16; mask++) {
    BOOL copy = !!(mask & 1), strict = !!(mask & 2), running = !!(mask & 4), optin = !!(mask & 8);
    BOOL blocked = RunningNotesBlocksWrite(copy, strict, running, optin);
    Assert(blocked == (running && (strict || (!copy && !optin))), @"Running Notes gate truth table");
  }
  [passed addObject:@"running Notes gate including non-overridable destructive actions"];

  context = Fixture(); root = Row(context, @"cloud-safe");
  Assert(CloudMutationBlockers(root).count == 0, @"Empty complete cloud fixture should pass");
  [root setValue:@YES forKey:@"needsToBeFetchedFromCloud"];
  Refuses(^{ RequireCloudMutationReady(root); }, @"cloud_state_unverified");
  [root setValue:@NO forKey:@"needsToBeFetchedFromCloud"];
  [root setValue:[@"server data" dataUsingEncoding:NSUTF8StringEncoding] forKey:@"serverRecordData"];
  Refuses(^{ RequireCloudMutationReady(root); }, @"cloud_state_unverified");
  [passed addObject:@"pending cloud fetch and unverified server record refuse"];
  context = Fixture(); cloud = Row(context, @"version counters");
  Assert([PurgeVersionBlocker(nil) isEqual:@"cloud_version_unverifiable"], @"Unknown cloud state refuses");
  [cloud setValue:@0 forKey:@"currentLocalVersion"];
  [cloud setValue:@0 forKey:@"latestVersionSyncedToCloud"];
  Assert([PurgeVersionBlocker(cloud) isEqual:@"cloud_version_unverifiable"], @"Unknown zero version refuses");
  [cloud setValue:@3 forKey:@"currentLocalVersion"];
  [cloud setValue:nil forKey:@"latestVersionSyncedToCloud"];
  Assert([PurgeVersionBlocker(cloud) isEqual:@"cloud_version_unverifiable"], @"Missing synced counter cannot mean never uploaded");
  [cloud setValue:@0 forKey:@"latestVersionSyncedToCloud"];
  Assert(PurgeVersionBlocker(cloud) == nil, @"Never uploaded positive version may pass this check");
  [cloud setValue:@3 forKey:@"latestVersionSyncedToCloud"];
  Assert([PurgeVersionBlocker(cloud) isEqual:@"flagged_version_already_synced"], @"Uploaded flag refuses");
  [cloud setValue:@4 forKey:@"currentLocalVersion"];
  Assert([PurgeVersionBlocker(cloud) isEqual:@"flag_introduction_version_unverifiable"],
         @"Newer local edits cannot prove old flag never uploaded");
  [passed addObject:@"synced purge flags and uncertain flag history refuse"];

  for (NSString *action in UnverifiedWriteFeatures()) {
    NSString *feature = UnverifiedWriteFeatures()[action];
    NSString *optIn = [@"APPLE_NOTES_MCP_ALLOW_UNVERIFIED_" stringByAppendingString:feature];
    Refuses(^{ RequireUnverifiedActionOptIn(action, @{}, @{@"APPLE_NOTES_MCP_ALLOW_UNVERIFIED" : @"1"}); },
            @"not_live_validated");
    Refuses(^{ RequireUnverifiedActionOptIn(action, @{}, @{optIn : @"true"}); }, @"not_live_validated");
    RequireUnverifiedActionOptIn(action, @{}, @{optIn : @"1"});
    RequireUnverifiedActionOptIn(action, @{@"dryRun" : @YES}, @{});
    Refuses(^{ RequireUnverifiedActionOptIn(action, @{@"dryRun" : @1}, @{}); }, @"not_live_validated");
  }
  [passed addObject:@"per-feature binary opt-ins ignore blanket flag and numeric dryRun"];
  Assert(!gFrameworkLoaded, @"NotesShared was loaded by the fixture");
  return passed;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    @try {
      if (argc == 2 && strcmp(argv[1], "digest") == 0) {
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:ReadStdin() options:0 error:NULL];
        EmitAndExit(@{@"digest" : ComposePlanDigest(request, request[@"ifRevision"]), @"frameworkLoaded" : @(gFrameworkLoaded)}, 0);
      }
      if (argc == 2 && strcmp(argv[1], "dispatch") == 0) {
        @try {
          NSDictionary *result = Dispatch();
          EmitAndExit(@{@"result" : result, @"frameworkLoaded" : @(gFrameworkLoaded)}, 0);
        } @catch (HelperError *error) {
          NSMutableDictionary *result = [error.userInfo mutableCopy];
          result[@"frameworkLoaded"] = @(gFrameworkLoaded);
          EmitAndExit(result, 0);
        }
      }
      EmitAndExit(@{@"passed" : RunFixture(), @"frameworkLoaded" : @(gFrameworkLoaded)}, 0);
    } @catch (NSException *error) {
      EmitAndExit(@{@"error" : error.reason ?: error.name, @"frameworkLoaded" : @(gFrameworkLoaded)}, 1);
    }
  }
}
