/**
 * Smart folders refused as destinations for create-note, move-note,
 * batch-move-notes, create-note-with-attachment, and create-folder.
 *
 * Detection is not mocked: the smart folder ids come from the real
 * list-smart-folders SQL, run read-only with the sqlite3 CLI against a
 * throwaway fixture NoteStore. Only Notes.app itself (executeAppleScript) is
 * mocked; every generated script is also compiled with osacompile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ db: "" }));
vi.mock("@/utils/applescript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/applescript.js")>()),
  executeAppleScript: vi.fn(),
}));
vi.mock("@/utils/smartFolders.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/smartFolders.js")>();
  return { ...actual, readSmartFolders: vi.fn(() => actual.readSmartFolders(fixture.db)) };
});

import { executeAppleScript } from "@/utils/applescript.js";
import { readSmartFolders } from "@/utils/smartFolders.js";
import { errorResult } from "@/utils/errorCodes.js";
import {
  AppleNotesManager,
  buildLiveFolderResolution,
  readSmartFolderIds,
  SMART_FOLDER_DESTINATION,
  smartFolderDestinationError,
  throwIfSmartFolderDestination,
} from "./appleNotesManager.js";

const exec = vi.mocked(executeAppleScript);
const manager = new AppleNotesManager();
const STORE = "AAAA-2222";
const SMART_ROOT = `x-coredata://${STORE}/ICFolder/p4`;
const SMART_NESTED = `x-coredata://${STORE}/ICFolder/p5`;
const NOTE = `x-coredata://${STORE}/ICNote/p40`;
const refusal = `execution error: ${SMART_FOLDER_DESTINATION}: Receipts (-1728)`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "smart-destination-"));
  fixture.db = join(dir, "NoteStore.sqlite");
  const query = '{"entity":"note","type":{"and":[{"deleted":false},{"or":[{"pinned":true}]}]}}';
  execFileSync("sqlite3", [
    fixture.db,
    `CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID VARCHAR, Z_PLIST BLOB);
     CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
     CREATE TABLE ZICCLOUDSYNCINGOBJECT (
       Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR, ZTITLE2 VARCHAR,
       ZFOLDERTYPE INTEGER, ZSMARTFOLDERQUERYJSON VARCHAR, ZPARENT INTEGER, ZOWNER INTEGER,
       ZNAME VARCHAR, ZMARKEDFORDELETION INTEGER, ZSTANDARDIZEDCONTENT VARCHAR, ZDISPLAYTEXT VARCHAR);
     INSERT INTO Z_METADATA VALUES (1, '${STORE}', NULL);
     INSERT INTO Z_PRIMARYKEY VALUES (14, 'ICAccount', 0, 0), (15, 'ICFolder', 0, 0), (8, 'ICHashtag', 0, 0);
     INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME) VALUES (1, 14, 'ACCT', 'Synthetic');
     INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZOWNER) VALUES
       (2, 15, 'ORDINARY', 'Receipts', 0, 1),
       (3, 15, 'TRASH', 'Recently Deleted', 1, 1);
     INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZSMARTFOLDERQUERYJSON, ZPARENT, ZOWNER, ZMARKEDFORDELETION) VALUES
       (4, 15, 'SMART-ROOT', 'Receipts', 2, '${query}', NULL, 1, 0),
       (5, 15, 'SMART-NESTED', 'Pinned', NULL, '${query}', 2, 1, NULL),
       (6, 15, 'SMART-GONE', 'Old', 2, '${query}', NULL, 1, 1);`,
  ]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  exec.mockReset();
  vi.mocked(readSmartFolders).mockClear();
});

/** Compiles a script against Notes' dictionary without running it. */
function compiles(script: string): void {
  const work = mkdtempSync(join(tmpdir(), "smart-destination-osa-"));
  try {
    const source = join(work, "script.applescript");
    writeFileSync(source, script);
    execFileSync("osacompile", ["-o", join(work, "script.scpt"), source], { stdio: "pipe" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("smart folder detection (real SQL against a fixture NoteStore)", () => {
  it("returns live smart folders only, found by folder type or stored query", () => {
    // p4 has folder type 2; p5 only a stored query; p6 is tombstoned; p2 and
    // p3 are an ordinary folder and Recently Deleted.
    expect(readSmartFolderIds()).toEqual([SMART_NESTED, SMART_ROOT]);
  });

  it("is empty when the store cannot be read, so resolution behaves as before", () => {
    expect(readSmartFolderIds(() => ({ folders: null }))).toEqual([]);
  });

  it("drops anything that is not an exact folder id before it can reach a script", () => {
    expect(
      readSmartFolderIds(() => ({
        folders: [
          { id: SMART_ROOT },
          { id: 'x" & (do shell script "id") & "' },
          { id: `x-coredata://${STORE}/ICNote/p4` },
        ],
      }))
    ).toEqual([SMART_ROOT]);
  });
});

describe("buildLiveFolderResolution with excludeFolderIds", () => {
  const account = `tell application "Notes"\nset __acctRef to default account\n`;

  it("passes over excluded candidates and raises the refusal only when nothing else matched", () => {
    const script = buildLiveFolderResolution("Receipts/Pinned", "dest", {
      excludeFolderIds: [SMART_ROOT, SMART_NESTED],
    });
    expect(script).toContain(`set dest_sx to {"${SMART_ROOT}", "${SMART_NESTED}"}`);
    expect(script).toContain("if dest_sx contains dest_cid then");
    expect(script).toContain("else if exists folder id dest_cid then");
    expect(script).toContain(
      `if dest_sh then error "${SMART_FOLDER_DESTINATION}: Receipts/Pinned" number -1728`
    );
    // Each segment resets the flag, so a smart namesake at one level does not
    // turn a genuinely missing folder at the next into a smart-folder refusal.
    expect(script.match(/set dest_sh to false/g)).toHaveLength(2);
    compiles(`${account}${script}\nend tell`);
  });

  it("generates exactly the previous script without exclusions", () => {
    const before = buildLiveFolderResolution("Work/Clients", "f", { rootOnly: true });
    expect(
      buildLiveFolderResolution("Work/Clients", "f", { rootOnly: true, excludeFolderIds: [] })
    ).toBe(before);
    expect(before).not.toContain(SMART_FOLDER_DESTINATION);
    expect(
      buildLiveFolderResolution("Work", "f", { excludeFolderIds: ['"; do shell script "x'] })
    ).toBe(buildLiveFolderResolution("Work", "f"));
  });
});

describe("the refusal", () => {
  it("is an unsupported, uncommitted error that names the folder", () => {
    const error = smartFolderDestinationError("Receipts");
    expect(error.message).toMatch(/^Refused: "Receipts" is a smart folder\..*Nothing was changed$/);
    expect(errorResult(`Error moving note: ${error.message}`, error).structuredContent).toEqual({
      code: "unsupported",
      committed: false,
      indeterminate: false,
      reason: "smart_folder_destination",
    });
  });

  it("is raised only for the smart-folder sentinel", () => {
    expect(() => throwIfSmartFolderDestination(refusal, "Receipts")).toThrow(/smart folder/);
    expect(() => throwIfSmartFolderDestination("Folder not found: X", "X")).not.toThrow();
    expect(() => throwIfSmartFolderDestination(undefined, "X")).not.toThrow();
  });
});

describe("write paths refuse a smart-folder destination", () => {
  it("create-note: the refusal precedes `make`, in the same script", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.createNote("T", "Body", [], "Receipts")).toThrow(
      /^Refused: "Receipts" is a smart folder/
    );
    expect(exec).toHaveBeenCalledTimes(1);
    const script = exec.mock.calls[0][0];
    expect(script).toContain(`{"${SMART_NESTED}", "${SMART_ROOT}"}`);
    expect(script.indexOf(SMART_FOLDER_DESTINATION)).toBeLessThan(script.indexOf("make new note"));
    compiles(script);
  });

  it("create-note: any other failure is reported as before", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: "Folder not found: Nope" });
    expect(manager.createNote("T", "Body", [], "Nope")).toBeNull();
  });

  it("create-note without a folder does not read the store", () => {
    exec
      .mockReturnValueOnce({ success: true, output: NOTE })
      .mockReturnValueOnce({ success: true, output: "iCloud" });
    expect(manager.createNote("T", "Body")?.id).toBe(NOTE);
    expect(readSmartFolders).not.toHaveBeenCalled();
  });

  it("move-note: the refusal precedes `move`", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.moveNoteById(NOTE, "Receipts")).toThrow(/is a smart folder/);
    const script = exec.mock.calls[0][0];
    expect(script.indexOf(SMART_FOLDER_DESTINATION)).toBeLessThan(
      script.indexOf("move noteRef to destFolder")
    );
    compiles(script);
  });

  it("batch-move-notes: refuses the whole call instead of reporting per-note failures", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.batchMoveNotes([NOTE], "Receipts")).toThrow(/is a smart folder/);
    const script = exec.mock.calls[0][0];
    expect(script.indexOf(SMART_FOLDER_DESTINATION)).toBeLessThan(
      script.indexOf("move noteRef to destFolder")
    );
    compiles(script);
  });

  it("create-folder: a smart segment is refused before anything is created", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.createFolder("Receipts/2026")).toThrow(/^Refused: "Receipts"/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).not.toContain("make new folder");
    compiles(exec.mock.calls[0][0]);
  });

  it("create-folder: a missing segment is still created, with smart folders excluded", () => {
    exec
      .mockReturnValueOnce({ success: false, output: "", error: "Folder not found: New" })
      .mockReturnValueOnce({ success: true, output: "" })
      .mockReturnValueOnce({
        success: true,
        output: `x-coredata://${STORE}/ICFolder/p9\x1fiCloud`,
      });
    expect(manager.createFolder("New")).toMatchObject({ id: `x-coredata://${STORE}/ICFolder/p9` });
    expect(exec.mock.calls[2][0]).toContain(`{"${SMART_NESTED}", "${SMART_ROOT}"}`);
  });

  it("create-folder: a refusal from the create script itself is surfaced", () => {
    exec
      .mockReturnValueOnce({ success: true, output: "x" })
      .mockReturnValueOnce({ success: false, output: "", error: "Folder not found: A/B" })
      .mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.createFolder("A/B")).toThrow(/^Refused: "A\/B"/);
  });
});

describe("assertNotSmartFolderDestination (read-only preflight)", () => {
  it("throws the refusal when the path resolves only to a smart folder", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: refusal });
    expect(() => manager.assertNotSmartFolderDestination("Receipts", "iCloud")).toThrow(
      /is a smart folder/
    );
    const script = exec.mock.calls[0][0];
    expect(script).not.toMatch(/\b(make|move|delete)\b/);
    compiles(script);
  });

  it("leaves other outcomes to the write", () => {
    exec.mockReturnValueOnce({ success: false, output: "", error: "Folder not found: X" });
    expect(() => manager.assertNotSmartFolderDestination("X")).not.toThrow();
    exec.mockReturnValueOnce({ success: true, output: `x-coredata://${STORE}/ICFolder/p2` });
    expect(() => manager.assertNotSmartFolderDestination("Receipts")).not.toThrow();
  });

  it("does not ask Notes.app anything when there are no smart folders", () => {
    vi.mocked(readSmartFolders).mockReturnValueOnce({ folders: [] });
    manager.assertNotSmartFolderDestination("Receipts");
    expect(exec).not.toHaveBeenCalled();
  });
});
