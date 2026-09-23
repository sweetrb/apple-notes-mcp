/**
 * The native helper is READ-ONLY by maintainer decision (#181, #204): write
 * support was deliberately deferred. These tests read the shipped Objective-C
 * source and fail if a save or write path reappears, so re-adding writes has
 * to be a deliberate, reviewed change to this file too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER_SOURCE_RELATIVE, READ_ONLY_ACTIONS, packageRoot } from "./privateHelper.js";

const SOURCE = readFileSync(join(packageRoot(__dirname), HELPER_SOURCE_RELATIVE), "utf8");
/** The source with comments and string literals removed, so only code is matched. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .replace(/@?"(?:[^"\\\n]|\\.)*"/g, '""');

describe("native helper source is read-only", () => {
  it.each([
    ["a managed object context save", /\bsave\s*:/],
    ["saveNoteData", /saveNoteData/],
    ["updateChangeCountWithReason", /updateChangeCountWithReason/],
    ["insertAttributedString", /insertAttributedString/],
    ["CRDT edit brackets", /\b(?:beginEditing|endEditing)\b/],
    ["edited:range:changeInLength:", /edited:range:changeInLength/],
    ["regenerateTitle", /regenerateTitle/],
    ["a merge policy for saves", /mergePolicy/],
    ["a transaction author for saves", /transactionAuthor/],
    ["setValue:forKey: on a managed object", /setValue\s*:/],
    ["insertNewObjectForEntityForName", /insertNewObjectForEntityForName/],
    ["deleteObject", /deleteObject/],
    ["a batch update or delete request", /NSBatch(?:Update|Delete|Insert)Request/],
    ["the removed append action", /append_plain_text|HandleAppend|ifRevision/],
    ["raw SQL", /sqlite3_(?:exec|prepare)/],
  ])("contains no %s", (_label, pattern) => {
    expect(CODE).not.toMatch(pattern);
    // The raw source too, so a selector cannot come back inside a string
    // passed to sel_registerName.
    expect(SOURCE).not.toMatch(pattern);
  });

  it("opens every store read-only with migration disabled, and verifies it", () => {
    expect(CODE).toMatch(/options\[NSReadOnlyPersistentStoreOption\]\s*=\s*@YES/);
    expect(CODE).toMatch(/options\[NSMigratePersistentStoresAutomaticallyOption\]\s*=\s*@NO/);
    expect(CODE).toMatch(/options\[NSInferMappingModelAutomaticallyOption\]\s*=\s*@NO/);
    expect(CODE).not.toMatch(/NSReadOnlyPersistentStoreOption\]\s*=\s*@NO/);
    // A post-open check refuses any store Core Data reports as writable.
    expect(CODE).toMatch(/!opened\.isReadOnly/);
    expect(SOURCE).toMatch(/read_only_violation/);
    // Exactly one place adds a persistent store: the read-only opener.
    expect(CODE.match(/addPersistentStoreWithType/g)).toHaveLength(1);
    expect(CODE).not.toMatch(/\bOpenContext\s*\(/);
  });

  it("whitelists only the read-only actions the client knows", () => {
    const table = SOURCE.slice(SOURCE.indexOf("kActions[] = {"));
    const rows = table.slice(0, table.indexOf("};"));
    const names = [...rows.matchAll(/\{"([a-z_]+)",/g)].map((m) => m[1]);
    expect(names).toEqual(["hello", "probe", "read_note_state"]);
    expect(new Set(names)).toEqual(new Set(READ_ONLY_ACTIONS));
  });

  it("advertises readOnly in hello and probe", () => {
    expect(SOURCE.match(/@"readOnly" : @YES/g)).toHaveLength(2);
  });
});
