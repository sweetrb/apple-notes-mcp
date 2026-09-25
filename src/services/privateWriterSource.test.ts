/**
 * Source contract for the opt-in private WRITER (apple-notes-private-writer.m).
 *
 * The writer is allowed to save, so the read-only source test does not apply
 * to it. These tests pin the safety contract every write must keep instead:
 * the action table matches the client's, write actions take an `ifRevision`
 * compare-and-swap token, the live store is opened read-write only behind the
 * writer's own switch, saves use NSErrorMergePolicy, reads stay read-only,
 * and a fresh read-back runs through a new coordinator.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./privateHelper.js";
import { WRITER_ACTIONS, WRITER_SOURCE_RELATIVE } from "./privateWriter.js";
import { SCOPE_GUARDED_ACTIONS } from "./privateWriterScope.js";

const SOURCE = readFileSync(join(packageRoot(__dirname), WRITER_SOURCE_RELATIVE), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .replace(/@?"(?:[^"\\\n]|\\.)*"/g, '""');

/**
 * Write actions that legitimately take no ifRevision. Each entry needs a
 * reason.
 */
const NO_REVISION_WRITES: Record<string, string> = {
  create_smart_folder:
    "creates a new folder, so there is no persisted revision; the guard is that no active " +
    "folder with that title exists in the destination, checked in the write context",
};

function actionRows(): Array<{ name: string; keys: string[]; handler: string }> {
  const table = SOURCE.slice(SOURCE.indexOf("kActions[] = {"));
  const rows = table.slice(0, table.indexOf("};"));
  return [...rows.matchAll(/\{"([a-z_]+)",\s*"([^"]*)",\s*(\w+)\}/g)].map((m) => ({
    name: m[1],
    keys: m[2] ? m[2].split(",") : [],
    handler: m[3],
  }));
}

/** The body of `static NSDictionary *<name>(NSDictionary *request) { ... }`. */
function handlerBody(name: string): string {
  const start = CODE.indexOf(`*${name}(NSDictionary *request) {`);
  expect(start, `handler ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CODE.indexOf("{", start); i < CODE.length; i++) {
    if (CODE[i] === "{") depth++;
    if (CODE[i] === "}" && --depth === 0) return CODE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("private writer source contract", () => {
  it("offers exactly the actions the client table lists", () => {
    const names = actionRows().map((row) => row.name);
    expect(new Set(names)).toEqual(new Set(Object.keys(WRITER_ACTIONS)));
    expect(names).toHaveLength(Object.keys(WRITER_ACTIONS).length);
  });

  it("takes an ifRevision compare-and-swap token on every write action", () => {
    for (const row of actionRows()) {
      if (WRITER_ACTIONS[row.name] !== "write" || row.name in NO_REVISION_WRITES) continue;
      expect(row.keys, row.name).toContain("ifRevision");
      expect(handlerBody(row.handler), row.name).toMatch(/ifRevision/);
    }
  });

  it("never opens a read-write context from a read action", () => {
    for (const row of actionRows()) {
      if (WRITER_ACTIONS[row.name] !== "read") continue;
      const body = handlerBody(row.handler);
      expect(body, row.name).not.toMatch(/OpenContext\([^)]*,\s*NO\)/);
      expect(body, row.name).not.toMatch(/\bsave\s*:/);
    }
  });

  it("opens the live store read-write only behind its own switch", () => {
    expect(SOURCE).toMatch(/kWritesEnv = @"APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"/);
    expect(CODE).toMatch(/if \(!readOnly && !store\.isCopy &&/);
    expect(SOURCE).toMatch(/Fail\(@"writes_disabled"/);
    // Exactly one opener adds a persistent store; reads pass YES.
    expect(CODE.match(/addPersistentStoreWithType/g)).toHaveLength(1);
    expect(CODE).toMatch(/if \(readOnly\) options\[NSReadOnlyPersistentStoreOption\] = @YES/);
    expect(CODE).toMatch(/options\[NSMigratePersistentStoresAutomaticallyOption\] = @NO/);
  });

  it("saves with optimistic locking and verifies through a fresh read-only stack", () => {
    expect(CODE).toMatch(/context\.mergePolicy = NSErrorMergePolicy/);
    expect(CODE).toMatch(/OpenContext\(store, YES\)/);
    expect(SOURCE).toMatch(/@"committed" : @YES/);
    expect(SOURCE).toMatch(/@"committed" : @NO/);
  });

  it("reports committed from where the failure happened, not from its type", () => {
    // Every write handler marks itself before anything can save, and the
    // save is bracketed so main() can tell before, during and after apart.
    const append = handlerBody("HandleAppendPlainText");
    expect(append).toMatch(/gWriteRequest = YES;[\s\S]*RequireFeature/);
    expect(append).toMatch(
      /gSaveAttempted = YES;\s*if \(!\[context save:&saveError\]\)[\s\S]*gSaveSucceeded = YES;/
    );
    // The read-back after a successful save catches every exception.
    expect(append).toMatch(/@catch \(NSException \*e\)/);
    expect(append).not.toMatch(/@catch \(HelperError \*e\)/);
    // Every other write action marks itself first, saves only through a
    // bracketed save, and catches every exception in its read-back.
    // A handler may save through a helper (for example CommitTableEdit) that
    // itself calls SaveOrFail; that helper then must not catch HelperError.
    const savingHelpers = [
      ...CODE.matchAll(/^static [^\n(]*?\*?(\w+)\([^;{]*\)\s*\{\n([\s\S]*?)\n\}\n/gm),
    ].filter((m) => !m[1].startsWith("Handle") && /\bSaveOrFail(?:For)?\(/.test(m[2]));
    const saves = new RegExp(
      `SaveOrFail(?:For)?\\(|gSaveAttempted = YES;|\\b(?:${savingHelpers.map((m) => m[1]).join("|")})\\(`
    );
    for (const helper of savingHelpers)
      expect(helper[2], helper[1]).not.toMatch(/@catch \(HelperError \*e\)/);
    for (const row of actionRows()) {
      if (WRITER_ACTIONS[row.name] !== "write") continue;
      const body = handlerBody(row.handler);
      expect(body, row.name).toMatch(/^\*\w+\(NSDictionary \*request\) \{\s*gWriteRequest = YES;/);
      expect(body, row.name).toMatch(saves);
      expect(body, row.name).not.toMatch(/@catch \(HelperError \*e\)/);
    }
    // Each -save: in the file is bracketed.
    for (const m of CODE.matchAll(/save:&(\w+)\]/g)) {
      const before = CODE.slice(Math.max(0, m.index - 120), m.index);
      expect(before).toMatch(/gSaveAttempted = YES;\s*if \(!?\[context $/);
    }
    expect(CODE).toMatch(
      /gSaveAttempted = YES;\s*if \(\[context save:&saveError\]\) \{\s*gSaveSucceeded = YES;/
    );
    // main(): refusals before the save are committed: false; an exception
    // after a successful save is a committed, unverified write.
    expect(SOURCE).toMatch(
      /if \(gWriteRequest && !gSaveAttempted && !out\[@"committed"\]\) out\[@"committed"\] = @NO;/
    );
    expect(SOURCE).toMatch(
      /if \(gSaveSucceeded\) \{\s*out\[@"code"\] = @"verification_failed";\s*out\[@"committed"\] = @YES;/
    );
  });

  it("forbids only C0/C1 control characters in written text", () => {
    // controlCharacterSet also covers Cf (ZWJ emoji, soft hyphen, BOM, bidi
    // marks), which ordinary text contains.
    expect(CODE).not.toMatch(/controlCharacterSet/);
    expect(CODE).toMatch(/addCharactersInRange:NSMakeRange\(0x00, 0x20\)/);
    expect(CODE).toMatch(/addCharactersInRange:NSMakeRange\(0x7F, 0x21\)/);
  });

  it("probes every folder property read_sync_state reads", () => {
    expect(SOURCE).toMatch(/\{"ICFolder", "identifier,markedForDeletion,cloudState"\}/);
  });

  it("requires the main switch even for a copy of the store", () => {
    expect(SOURCE).toMatch(
      /if \(!\[NSProcessInfo\.processInfo\.environment\[kEnableEnv\] isEqualToString:@"1"\]\)\s*Fail\(@"disabled"/
    );
  });

  it("never issues SQL or a batch request", () => {
    expect(CODE).not.toMatch(/sqlite3_(?:exec|prepare)/);
    expect(CODE).not.toMatch(/NSBatch(?:Update|Delete|Insert)Request/);
  });

  it("plans edits read-only and verifies an applied edit outside its ranges", () => {
    const plan = handlerBody("HandlePlanEdit");
    expect(plan).toMatch(/OpenContext\(store, YES\)/);
    expect(plan).toMatch(/\[context rollback\]/);
    const apply = handlerBody("HandleEditNote");
    expect(apply).toMatch(/RequireString\(request, ""\)/);
    expect(apply).toMatch(
      /OpenContext\(store, NO\)[\s\S]*SaveOrFail\(context\)[\s\S]*OpenContext\(store, YES\)/
    );
    expect(apply).toMatch(/VerifyAgainstPlan\(persisted, plan\)/);
    expect(apply).toMatch(/AttachmentRows\(reread\)/);
    expect(apply).toMatch(
      /VerifyAttachmentRows\(attachmentsBefore, AttachmentRowDigests\(rowsAfter\), plan\)/
    );
    // Formatting outside the edits is compared run by run, including
    // timestamps, and the glyph sequence against the planned text.
    expect(CODE).toMatch(/CanonicalRuns\(plan\.snapshot, oldRange, NO\)/);
    expect(CODE).toMatch(
      /AttachmentGlyphs\(persisted\) isEqual:AttachmentGlyphs\(plan\.expected\)/
    );
    // One entry per glyph character, so two adjacent glyphs of one attachment
    // (Notes stores AppleScript-added images that way) are not merged into one run.
    expect(CODE).toMatch(
      /for \(NSUInteger i = 0; i < range\.length; i\+\+\) \[glyphs addObject:canonical\]/
    );
    // Only an explicit attachment selector may put a glyph inside a target,
    // and then only the one glyph it named.
    expect(CODE).toMatch(
      /static BOOL TargetMayTouchAttachment\(NSString \*kind\) \{\s*return \[kind isEqualToString:""\];\s*\}/
    );
    expect(SOURCE).toMatch(
      /TargetMayTouchAttachment[\s\S]{0,200}return \[kind isEqualToString:@"attachment"\]/
    );
    expect(CODE).toMatch(
      /if \(!TargetMayTouchAttachment\(kind\)\) allowedGlyphs = NSMakeRange\(NSNotFound, 0\);[\s\S]{0,400}if \(!NSLocationInRange\(found\.location, allowedGlyphs\)\)/
    );
    // Every RequireNoAttachmentGlyph call passes the glyphs its selector named
    // (or none), never a free-form range.
    const calls = [...CODE.matchAll(/RequireNoAttachmentGlyph\(snapshot,[^;]*\);/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls)
      expect(call[0]).toMatch(/, (?:NSMakeRange\(NSNotFound, 0\)|glyphs|HitGlyphs\(hit\))\);$/);
    // An attachment selector counts and targets attachments, not glyphs:
    // adjacent glyphs naming one attachment are one span.
    expect(CODE).toMatch(/for \(NSDictionary \*entry in AttachmentSpans\(snapshot\)\)/);
    expect(CODE).toMatch(/: glyphs;\s*\} else \{\s*range = p\.content;/);
    // Deleting the last paragraph removes only its text, never the previous
    // paragraph's terminator, and touching deletions from one operation merge.
    expect(CODE).toMatch(/NSRange range = p\.terminated \? p\.full : p\.content;/);
    expect(CODE).toMatch(/created = MergeDeletions\(created\);/);
    // A removed attachment's row may be updated before the save, never deleted.
    expect(CODE).toMatch(
      /for \(NSString \*key in plan\.removedAttachments\)[\s\S]{0,200}\[allowed addObject:row\]/
    );
    expect(CODE).toMatch(
      /for \(NSManagedObject \*object in context\.deletedObjects\)\s*\[unexpected addObject/
    );
    // Only the note, its data, and its cloud state may be dirty before a save.
    expect(SOURCE).toMatch(
      /Fail\(@"unexpected_side_effect",[\s\S]{0,400}?@"objects" : unexpected\}/
    );
  });

  it("trims only whole empty text paragraphs, never the title or an attachment", () => {
    const trimmable = CODE.slice(CODE.indexOf("static BOOL IsTrimmableBlank("));
    const body = trimmable.slice(0, trimmable.indexOf("\n}\n"));
    expect(body).toMatch(/if \(p\.index == 0\) return NO;/);
    expect(SOURCE).toMatch(
      /IsTrimmableBlank[\s\S]{0,400}rangeOfString:@"\\uFFFC"\]\.location != NSNotFound\) return NO;/
    );
    expect(body).toMatch(/whitespaceCharacterSet\]\.length\) return NO;/);
    expect(body).toMatch(
      /return style == kStyleTitle \|\| style == 1 \|\| style == 2 \|\| style == kStyleBody;/
    );
    // Each removed paragraph goes with its own terminator and nothing else,
    // and the glyph guard still runs with a kind that may not touch one.
    expect(CODE).toMatch(
      /RequireNoAttachmentGlyph\(snapshot, p\.full, index, "", NSMakeRange\(NSNotFound, 0\)\);\s*NSMutableDictionary \*target = Target\(p\.full, \[NSAttributedString new\], index, p\);/
    );
  });

  it("compares stored runs field by field and refuses what it cannot compare", () => {
    const canonical = CODE.slice(CODE.indexOf("static NSString *CanonicalValue(id value) {"));
    const body = canonical.slice(0, canonical.indexOf("\n}\n"));
    // No description fallback: an unknown class is nil (unverifiable).
    expect(body).not.toMatch(/description/);
    expect(body).toMatch(/return nil;\s*$/);
    expect(body).toMatch(/CanonicalParagraphStyle\(value\)/);
    const style = SOURCE.slice(
      SOURCE.indexOf("static NSString *CanonicalParagraphStyle(id style) {")
    );
    const styleBody = style.slice(0, style.indexOf("\n}\n"));
    for (const field of ["startingItemNumber", "hints", "uuid", "todo", "done", "alignment"])
      expect(styleBody).toContain(field);
    // A plan refuses a note holding an unverifiable value; a read-back fails on one.
    expect(CODE).toMatch(
      /NSArray \*unverifiable = UnverifiableAttributeClasses\(snapshot\);\s*if \(unverifiable\.count\)\s*Fail\(""/
    );
    expect(CODE).toMatch(/if \(UnverifiableAttributeClasses\(persisted\)\.count\)/);
    // Every accessor it reads is probed with the edit feature.
    const editAPI = SOURCE.slice(SOURCE.indexOf("kEditAPI[] = {"));
    const table = editAPI.slice(0, editAPI.indexOf("};"));
    for (const sel of ["startingItemNumber", "writingDirection", "fontHints", "attachmentUTI"])
      expect(table).toContain(`"${sel}"`);
  });

  it("guards an apply with the dry run's plan digest", () => {
    const apply = handlerBody("HandleEditNote");
    expect(apply).toMatch(
      /if \(ifPlanDigest && !\[ifPlanDigest isEqualToString:response\[""\]\]\)\s*Fail\(""/
    );
    expect(SOURCE).toMatch(/\{"edit_note", "[^"]*ifPlanDigest[^"]*", HandleEditNote\}/);
    const digest = CODE.slice(CODE.indexOf("static NSString *PlanDigest("));
    expect(digest.slice(0, digest.indexOf("\n}\n"))).toMatch(/requireNonSystemPaper/);
  });

  it("creates a replacement file's attachment only on apply and removes it on failure", () => {
    const plan = handlerBody("HandlePlanEdit");
    expect(plan).not.toMatch(/MaterializeReplacementFiles/);
    const apply = handlerBody("HandleEditNote");
    // The copy-store sandbox is installed before the first file is written.
    expect(apply).toMatch(
      /if \(store\.isCopy\) InstallAccountSandbox\([^;]*\);\s*plan\.createdObjects = MaterializeReplacementFiles/
    );
    expect(apply).toMatch(
      /@catch \(NSException \*e\) \{[\s\S]{0,400}if \(nothingSaved\) \{\s*\[context rollback\];\s*for \(NSString \*container in mediaContainers\)/
    );
    expect(apply).toMatch(/verifyError = VerifyReplacementFiles\(fresh, reread, plan\.files\)/);
    // The file is read once, without following a final link.
    expect(CODE).toMatch(
      /open\(\[path fileSystemRepresentation\], O_RDONLY \| O_NOFOLLOW \| O_CLOEXEC\)/
    );
  });

  it("honours copy-store fault injection only on a copy", () => {
    const fault = CODE.slice(CODE.indexOf("static NSString *TestFault(StoreLocation store) {"));
    expect(fault.slice(0, fault.indexOf("\n}\n"))).toMatch(/if \(!store\.isCopy\) return nil;/);
  });

  it("limits set_highlight to the text and note scopes, keeping note scope off the title and attachments", () => {
    const parse = CODE.slice(CODE.indexOf("static HighlightTarget ParseHighlightTarget"));
    const parseBody = parse.slice(0, parse.indexOf("\n}\n"));
    expect(SOURCE).toMatch(/`match` and `expectedCount` apply only to scope \\"text\\"/);
    expect(parseBody).toMatch(/request\[""\] \|\| request\[""\]/);
    const scope = CODE.slice(CODE.indexOf("static NSArray<NSValue *> *NoteScopeRanges"));
    const scopeBody = scope.slice(0, scope.indexOf("\n}\n"));
    // Starts after the title paragraph's newline and splits at U+FFFC.
    expect(scopeBody).toMatch(/NSMaxRange\(firstBreak\)/);
    expect(scopeBody).toMatch(/characterAtIndex:i\] == 0xFFFC/);
    expect(SOURCE).toMatch(/Fail\(@"nothing_to_highlight"/);
    // The whole-note plan still verifies through hasEmphasis.
    expect(SOURCE).toMatch(/hasEmphasis flag does not match its stored highlights/);
  });

  it("sets a paragraph identifier through the mergeable string and verifies it afresh", () => {
    const body = handlerBody("HandleSetParagraphId");
    expect(body).toMatch(/ExpectedBlock\(blocks, index, expectedText\)/);
    expect(body).toMatch(/AssignParagraphUUID\(ms, body, owned, uuid\)/);
    expect(body).toMatch(/SaveOrFail\(context\)/);
    expect(body).toMatch(/OpenContext\(store, YES\)/);
    expect(body).toMatch(/OtherBlocksUnchanged/);
    expect(SOURCE).toMatch(/sel_registerName\("setAttributes:range:"\)/);
  });

  it("builds section-link chips through NotesShared and verifies both notes afresh", () => {
    const body = handlerBody("HandleAddSectionLink");
    expect(SOURCE).toMatch(
      /"newParagraphLinkAttachmentWithIdentifier:toNote:paragraphName:paragraphID:"/
    );
    expect(body).toMatch(/ifTargetRevision/);
    expect(body).toMatch(/RequireFeature\(FeatureSectionLinks\)/);
    expect(body).toMatch(/SaveOrFail\(context\)/);
    expect(body).toMatch(/OpenContext\(store, YES\)/);
    expect(body).toMatch(/UniqueBlockWithUUID/);
    // Only paragraph-link chips are cleared; note-link chips share the UTI.
    expect(CODE).toMatch(/IsSectionLinkAttachment\(inlineAttachment\)\) return;/);
  });

  it("opens a two-phase table write read-write only for the apply", () => {
    for (const name of ["HandleDeleteTableRow", "HandlePruneOrphanTable"]) {
      const body = handlerBody(name);
      expect(body, name).toMatch(
        /BOOL apply = RequireGuards\(request, dryRun, &ifRevision, &ifTableDigest\)/
      );
      expect(body, name).toMatch(/ResolveTableTarget\(request, !apply,/);
      expect(body, name).toMatch(
        /if \(apply\) CompareTableGuards\(target, ifRevision, ifTableDigest\)/
      );
    }
    for (const name of ["HandleInsertTableRow", "HandleSetTableCell"])
      expect(handlerBody(name), name).toMatch(
        /CompareTableGuards\(target, ifRevision, ifTableDigest\)/
      );
  });

  it("tombstones an attachment only in the orphan prune", () => {
    // Every -markForDeletion call: the orphan prune (an ICAttachment table),
    // add_section_link replacing its own earlier inline chips, and the
    // smart-folder delete (an empty smart folder).
    const calls = [...SOURCE.matchAll(/SendVoid\(([^,]+), "markForDeletion"\)/g)].map((m) => m[1]);
    expect(calls).toEqual(['entry[@"attachment"]', "target.attachment", "folder"]);
    expect(handlerBody("HandleDeleteSmartFolder")).toMatch(/SendVoid\(folder, ""\)/);
    expect(handlerBody("HandleAddSectionLink")).toMatch(
      /for \(NSDictionary \*entry in cleared\) SendVoid\(entry\[""\], ""\)/
    );
    expect(handlerBody("HandlePruneOrphanTable")).toMatch(/SendVoid\(target\.attachment, ""\)/);
    // The in-use flag is cleared only in the prune: once in the probe's
    // requirement table, once in the prune handler.
    const inUse = '"updateMarkedForDeletionStateAttachmentIsInUse:"';
    expect(SOURCE.split(inUse).length - 1).toBe(2);
    expect(
      SOURCE.slice(SOURCE.indexOf("*HandlePruneOrphanTable(NSDictionary *request) {"))
    ).toContain(inUse);
  });

  it("opens the smart-folder delete read-write only for the apply", () => {
    expect(handlerBody("HandleDeleteSmartFolder")).toMatch(/OpenContext\(store, dryRun\)/);
    expect(handlerBody("HandleCreateSmartFolder")).toMatch(
      /NSManagedObjectContext \*validation = OpenContext\(store, YES\)/
    );
  });

  it("never lets a smart folder be a parent", () => {
    const body = CODE.slice(
      CODE.indexOf("static void RequireSmartFolderParent("),
      CODE.indexOf("static void ResolveDestination(")
    );
    expect(body).toMatch(/if \(FolderKind\(parent\) == 2\)/);
    expect(SOURCE).toMatch(/@"reason" : @"smart_folder_destination"/);
  });

  it("checks folder scope guards on every write, in its own context just before the save", () => {
    const table = SOURCE.slice(SOURCE.indexOf("kScopeGuardedActions[] = {"));
    const guarded = [
      ...table
        .slice(0, table.indexOf("};"))
        .matchAll(/\{"([a-z_]+)", ScopeSubject(Note|Folder|NewFolder)\}/g),
    ].map((m) => m[1]);
    // Every write action takes the guard, and the client table matches.
    for (const [name, kind] of Object.entries(WRITER_ACTIONS))
      if (kind === "write") expect(guarded, name).toContain(name);
    expect(new Set(guarded)).toEqual(new Set(Object.keys(SCOPE_GUARDED_ACTIONS)));
    // Both save sites (the append's own and SaveOrFailFor) evaluate the guard
    // right before the save, and there is no other save.
    expect(CODE.match(/save:&\w+\]/g)).toHaveLength(2);
    expect(
      CODE.match(
        /EnforceScopeGuard\(context\);\s*NSError \*saveError = nil;\s*gSaveAttempted = YES;/g
      )
    ).toHaveLength(2);
    // Dispatch validates the fields first and re-checks a call that saved nothing.
    expect(CODE).toMatch(
      /ParseScopeGuard\(request, subject\);\s*NSDictionary \*result = kActions\[i\]\.handler\(request\);\s*CheckScopeGuardWithoutSave\(\);/
    );
    // Fail closed: an id that names no existing folder, or a forbidden id that
    // names a deleted one, refuses the call.
    const resolve = SOURCE.slice(
      SOURCE.indexOf("static NSManagedObjectID *ResolveScopeFolder("),
      SOURCE.indexOf("static NSManagedObjectID *PersistedParent(")
    );
    expect(resolve).toMatch(/if \(!folder\)\s*ScopeFail\(writing, @"scope_folder_not_found"/);
    expect(resolve).toMatch(/if \(forbidden && BoolAttr\(deleted, @"markedForDeletion"\)\)/);
    // Folders above the subject are re-read from the store, not the cache.
    expect(CODE).toMatch(/request\.includesPendingChanges = NO;/);
    // The note's folder is the one the write read (optimistic locking covers it).
    expect(SOURCE).toMatch(/committedValuesForKeys:@\[ @"folder" \]/);
    expect(SOURCE).toMatch(/\{"ICFolder", "identifier,parent,markedForDeletion"\}/);
  });

  it("repairs a purge flag with an ordinary move to Recently Deleted, never a purge", () => {
    const body = SOURCE.slice(
      SOURCE.indexOf("static NSDictionary *HandleRepairPurgeFlag(NSDictionary *request) {"),
      SOURCE.indexOf("#pragma mark - Sync state")
    );
    expect(body).toMatch(/OpenContext\(store, dryRun\)/);
    expect(body).toMatch(
      /if \(!IsJSONBool\(request\[@"confirm"\]\) \|\| !\[request\[@"confirm"\] boolValue\]\)/
    );
    expect(body).toMatch(/if \(!\[plan\[@"repairable"\] boolValue\]\)/);
    expect(body).toMatch(/SendVoid\(note, "unmarkForDeletion"\)/);
    expect(body).toMatch(/SendVoid1\(note, "setFolder:", trash\)/);
    expect(body).toMatch(/RequireExpectedChanges\(context, allowed/);
    expect(body).not.toMatch(/"markForDeletion"|deleteNote|deleteObject/);
    // Verification re-reads the flag, the folder, and the body afresh.
    expect(body).toMatch(/NSManagedObjectContext \*fresh = OpenContext\(store, YES\)/);
    expect(body).toMatch(/the note body changed/);
  });

  it("identifies itself as the writer in hello and probe", () => {
    expect(SOURCE.match(/@"role" : @"writer"/g)).toHaveLength(2);
    expect(SOURCE.match(/@"readOnly" : @NO/g)).toHaveLength(2);
  });
});
