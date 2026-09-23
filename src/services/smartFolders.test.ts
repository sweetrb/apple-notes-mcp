import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/utils/applescript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/applescript.js")>()),
  executeAppleScript: vi.fn(),
}));
vi.mock("@/utils/smartFolders.js", () => ({ readSmartFolders: vi.fn() }));
import { executeAppleScript } from "../utils/applescript.js";
import { readSmartFolders } from "../utils/smartFolders.js";
import { AppleNotesManager } from "./appleNotesManager.js";
import type { SmartFolder } from "../types.js";

const exec = vi.mocked(executeAppleScript);
const read = vi.mocked(readSmartFolders);
const manager = new AppleNotesManager();
const RS = "\u001e";
const FS = "\u001f";

const folder = (pk: number): SmartFolder => ({
  id: `x-coredata://ABC/ICFolder/p${pk}`,
  identifier: `SMART-${pk}`,
  name: `Smart ${pk}`,
  account: "Synthetic",
  accountId: "x-coredata://ABC/ICAccount/p1",
  accountIdentifier: "ACCT",
  parent: null,
  parentId: null,
  parentIdentifier: null,
  match: "all",
  filters: [{ type: "pinned", value: true, description: "is pinned" }],
  includesRecentlyDeleted: false,
  fullyDecoded: true,
  query: { and: [{ pinned: true }] },
  rawQuery: "{}",
});

beforeEach(() => vi.clearAllMocks());

describe("listSmartFolders", () => {
  it("reads the database only unless matching notes are requested", () => {
    read.mockReturnValue({ folders: [folder(4)] });
    expect(manager.listSmartFolders()).toEqual([folder(4)]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("surfaces the classified database error", () => {
    read.mockReturnValue({
      folders: null,
      error: "no_fda",
      message: "Full Disk Access is required",
    });
    expect(() => manager.listSmartFolders()).toThrow("Full Disk Access is required");
  });

  it("asks Notes.app for each folder's current notes by exact folder id", () => {
    read.mockReturnValue({ folders: [folder(4), folder(5)] });
    exec
      .mockReturnValueOnce({
        success: true,
        output: `3${RS}One${FS}x-coredata://ABC/ICNote/p10${RS}Two${FS}x-coredata://ABC/ICNote/p11`,
      })
      .mockReturnValueOnce({ success: false, output: "", error: "Notes got an error" });
    const [first, second] = manager.listSmartFolders({ includeMatchingNotes: true, limit: 2 });
    expect(first.matchingNotesError).toBeUndefined();
    expect(first.matchingNoteCount).toBe(3);
    expect(first.matchingNotes).toEqual([
      { title: "One", id: "x-coredata://ABC/ICNote/p10" },
      { title: "Two", id: "x-coredata://ABC/ICNote/p11" },
    ]);
    expect(second.matchingNoteCount).toBeUndefined();
    expect(second.matchingNotesError).toContain("Notes got an error");
    const script = exec.mock.calls[0][0];
    expect(script).toContain('notes of folder id "x-coredata://ABC/ICFolder/p4"');
    expect(script).toContain("set fetchCount to 2");
    expect(script).not.toMatch(/\b(make new|delete|move|set body|set name)\b/);
  });

  it("rejects a non-folder id before running AppleScript", () => {
    expect(() =>
      manager.listSmartFolderNoteRefs('x-coredata://ABC/ICNote/p1" & do shell script "x', 5)
    ).toThrow(/folder ID/);
    expect(exec).not.toHaveBeenCalled();
  });
});
