/**
 * The native helper is READ-ONLY by maintainer decision (#181, #204): write
 * support was deliberately deferred. These tests read the shipped Objective-C
 * source and fail if a save or write path reappears, so re-adding writes has
 * to be a deliberate, reviewed change to this file too.
 *
 * An opt-in WRITER is added as a separate program
 * (apple-notes-private-writer.m, `setup --native-writer`). The read-only
 * guarantees below still apply, unchanged, to everything the read-only build
 * path touches: the helper source `setup --native-helper` compiles, the
 * client that dispatches to it, and the build module that installs it. The
 * last block checks that none of those can reach the writer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HELPER_BINARY_NAME,
  HELPER_SOURCE_RELATIVE,
  MANIFEST_NAME,
  READ_ONLY_ACTIONS,
  defaultDeps,
  packageRoot,
} from "./privateHelper.js";
import { compileArguments, defaultBuildDeps } from "./privateHelperBuild.js";
import {
  WRITER_ACTIONS,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  WRITER_SOURCE_RELATIVE,
} from "./privateWriter.js";

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

describe("the read-only build path cannot reach the writer", () => {
  const root = packageRoot(__dirname);
  const readOnlyModules = ["privateHelper.ts", "privateHelperBuild.ts"].map((file) =>
    readFileSync(join(root, "src", "services", file), "utf8")
  );

  it("compiles only the read-only helper source", () => {
    expect(defaultDeps().sourcePath).toBe(join(root, HELPER_SOURCE_RELATIVE));
    expect(defaultBuildDeps().sourcePath).toBe(join(root, HELPER_SOURCE_RELATIVE));
    expect(HELPER_SOURCE_RELATIVE).not.toBe(WRITER_SOURCE_RELATIVE);
    const args = compileArguments("/reader.m", "/out", "0".repeat(64));
    expect(args.filter((arg) => arg.endsWith(".m"))).toEqual(["/reader.m"]);
  });

  it("installs to a binary and manifest the writer never uses", () => {
    expect(HELPER_BINARY_NAME).not.toBe(WRITER_BINARY_NAME);
    expect(MANIFEST_NAME).not.toBe(WRITER_MANIFEST_NAME);
  });

  it("has no reference to the writer in the helper source or the read-only modules", () => {
    for (const text of [SOURCE, ...readOnlyModules]) {
      expect(text).not.toMatch(/private-writer|privateWriter|ENABLE_PRIVATE_WRITES/);
      expect(text).not.toMatch(/#(?:include|import)\s+"[^"]*writer/);
    }
  });

  it("whitelists no action the writer treats as a write", () => {
    const writes = Object.entries(WRITER_ACTIONS)
      .filter(([, kind]) => kind === "write")
      .map(([action]) => action);
    expect(writes.length).toBeGreaterThan(0);
    for (const action of writes) expect(READ_ONLY_ACTIONS.has(action)).toBe(false);
  });
});
