/** Batch scope tests use the public manager and never execute Notes AppleScript. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
vi.mock("@/utils/smartFolders.js", () => ({
  readSmartFolders: vi.fn(() => ({ folders: [] })),
}));

import { executeAppleScript } from "@/utils/applescript.js";
import {
  buildScopeGuardScript,
  scopeConflictMessage,
  type ScopeGuard,
} from "@/utils/scopeGuard.js";
import { AppleNotesManager } from "./appleNotesManager.js";

const exec = vi.mocked(executeAppleScript);
const STORE = "x-coredata://ABC00000-0000-0000-0000-000000000004";
const ID1 = `${STORE}/ICNote/p1`;
const ID2 = `${STORE}/ICNote/p2`;
const ID3 = `${STORE}/ICNote/p3`;
const F1 = `${STORE}/ICFolder/p10`;
const F2 = `${STORE}/ICFolder/p20`;
const R = "\x1e";
let manager: AppleNotesManager;

beforeEach(() => {
  vi.clearAllMocks();
  manager = new AppleNotesManager();
});

function capture(guard?: ScopeGuard, statuses = ["ok", "ok"]): string {
  exec.mockReturnValue({ success: true, output: statuses.join(R) + R });
  manager.batchMoveNotes([ID1, ID2], "Archive", "iCloud", guard);
  expect(exec).toHaveBeenCalledTimes(1);
  return exec.mock.calls[0][0];
}

function compiles(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "batch-scope-compile-"));
  try {
    const source = join(dir, "script.applescript");
    writeFileSync(source, script);
    execFileSync("/usr/bin/osacompile", ["-o", join(dir, "script.scpt"), source], {
      stdio: "pipe",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("batch moves check each note's live scope in its own handler", () => {
  it.each<ScopeGuard>([
    { ifFolderId: F1 },
    { ifAncestorFolderId: F1 },
    { forbiddenAncestorFolderIds: [F2] },
    { ifFolderId: F1, ifAncestorFolderId: F1, forbiddenAncestorFolderIds: [F2] },
  ])("embeds the unchanged public guard before the move and compiles: %j", (guard) => {
    const script = capture(guard);
    const handlerEnd = script.indexOf("end moveBatchNote");
    const handler = script.slice(0, handlerEnd);
    const loop = script.slice(handlerEnd);
    const checks = buildScopeGuardScript("noteRef", guard, "destFolder");
    expect(handler).toContain(checks);
    expect(handler.indexOf(checks)).toBeLessThan(handler.indexOf("move noteRef to destFolder"));
    expect(handler).toContain("set movedNoteRef to note id theId");
    expect(handler).toContain("id of actualFolder) is (id of destFolder");
    expect(loop).toContain("repeat with rawId");
    expect(loop).toContain("set itemStatus to my moveBatchNote(noteRef, destFolder, theId)");
    expect(loop).toContain("set out to out & itemStatus & (character id 30)");
    expect(loop).not.toContain("SAFETY_SCOPE");
    expect(loop).toContain('set out to out & "fail"');
    compiles(script);
  });

  it.each([
    "the note is not in the expected folder",
    "the note is not inside the expected ancestor folder",
    "the note is inside a forbidden folder",
    "the destination is inside a forbidden folder",
    "a forbidden folder id does not match any folder",
    "the note is not in a folder",
  ])("maps a per-note refusal and preserves the following successful item: %s", (reason) => {
    exec.mockReturnValue({ success: true, output: `SAFETY_SCOPE:${reason}${R}ok${R}` });
    expect(manager.batchMoveNotes([ID1, ID2], "Archive", undefined, { ifFolderId: F1 })).toEqual([
      {
        id: ID1,
        success: false,
        error: scopeConflictMessage(reason, "batch-move"),
        committed: false,
        indeterminate: false,
      },
      { id: ID2, success: true },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("keeps destination ancestry checks inside each guarded handler", () => {
    const script = capture({ forbiddenAncestorFolderIds: [F2] });
    expect(script.indexOf("scopeDestChainCursor to destFolder")).toBeLessThan(
      script.indexOf("move noteRef to destFolder")
    );
    expect(script).toContain('return "SAFETY_SCOPE:the destination is inside a forbidden folder"');
    expect(script).toContain(
      'return "SAFETY_SCOPE:a forbidden folder id does not match any folder"'
    );
  });

  it("canonicalizes and deduplicates folder IDs with the public builder", () => {
    const lowerStore = STORE.toLowerCase();
    const script = capture({
      ifFolderId: `${lowerStore}/ICFolder/p0010`,
      ifAncestorFolderId: `${lowerStore}/ICFolder/p0010`,
      forbiddenAncestorFolderIds: [`${lowerStore}/ICFolder/p0020`, F2],
    });
    expect(script).toContain(`if (id of scopeFolder) is not "${F1}"`);
    expect(script).toContain(`scopeChain does not contain "${F1}"`);
    expect(script).toContain(`repeat with forbiddenId in {"${F2}"}`);
    expect(script).not.toContain("p0010");
  });

  it.each([undefined, {}, { forbiddenAncestorFolderIds: [] }])(
    "preserves unguarded moves with no emitted scope checks: %j",
    (guard) => {
      const script = capture(guard);
      expect(script).not.toContain("scopeFolder");
      expect(script).not.toContain("SAFETY_SCOPE");
      expect(script).toContain("move noteRef to destFolder");
      compiles(script);
    }
  );

  it("preserves mixed original IDs and order across invalid, refused and moved rows", () => {
    const paddedId = `${STORE.toLowerCase()}/ICNote/p0002`;
    const invalidId = `${STORE}/ICFolder/p8`;
    const reason = "the note is not in the expected folder";
    exec.mockReturnValue({
      success: true,
      output: `SAFETY_SCOPE:${reason}${R}ok${R}wrongfolder${R}`,
    });
    const results = manager.batchMoveNotes([ID1, invalidId, paddedId, ID3], "Archive", undefined, {
      ifFolderId: F1,
    });
    expect(results.map((r) => r.id)).toEqual([ID1, invalidId, paddedId, ID3]);
    expect(results.map((r) => r.success)).toEqual([false, false, true, false]);
    expect(results[0].error).toBe(scopeConflictMessage(reason, "batch-move"));
    expect(results[0]).toMatchObject({ committed: false, indeterminate: false });
    expect(results[1].error).toMatch(/ICNote/);
    expect(results[3].error).toBe("Destination folder verification failed");
    expect(exec.mock.calls[0][0]).not.toContain(invalidId);
    expect(exec.mock.calls[0][0]).toContain(`"${paddedId}"`);
  });

  it("preserves all unguarded status mappings, including repeated exact IDs", () => {
    const ids = [ID1, ID1, ID2, ID3, ID1, ID2, ID3];
    exec.mockReturnValue({
      success: true,
      output: ["ok", "missing", "pw", "fail", "wrongfolder", "other", "ok"].join(R) + R,
    });
    expect(manager.batchMoveNotes(ids, "Archive")).toEqual([
      { id: ID1, success: true },
      { id: ID1, success: false, error: "Note not found", committed: false, indeterminate: false },
      {
        id: ID2,
        success: false,
        error: "Note is password-protected",
        committed: false,
        indeterminate: false,
      },
      { id: ID3, success: false, error: "Move failed", indeterminate: true },
      {
        id: ID1,
        success: false,
        error: "Destination folder verification failed",
        indeterminate: true,
      },
      { id: ID2, success: false, error: "Unknown error", indeterminate: true },
      { id: ID3, success: true },
    ]);
  });

  it.each<ScopeGuard>([
    { ifFolderId: ID1 },
    { ifAncestorFolderId: 'x" & quit & "' },
    { forbiddenAncestorFolderIds: [ID1] },
    { forbiddenAncestorFolderIds: Array.from({ length: 51 }, () => F1) },
  ])("refuses invalid guard inputs before the mutation executor: %j", (guard) => {
    expect(() => manager.batchMoveNotes([ID1], "Archive", undefined, guard)).toThrow(
      /exact folder ids|At most/
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not spawn for an empty batch or a batch with no valid IDs", () => {
    expect(manager.batchMoveNotes([], "Archive", undefined, { ifFolderId: F1 })).toEqual([]);
    expect(
      manager.batchMoveNotes([`${STORE}/ICFolder/p1`], "Archive", undefined, { ifFolderId: F1 })[0]
        .success
    ).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("preserves whole-script failures for every runnable note", () => {
    exec.mockReturnValue({ success: false, output: "", error: "Destination unavailable" });
    expect(manager.batchMoveNotes([ID1, ID2], "Archive", undefined, { ifFolderId: F1 })).toEqual([
      { id: ID1, success: false, error: "Destination unavailable", indeterminate: true },
      { id: ID2, success: false, error: "Destination unavailable", indeterminate: true },
    ]);
  });

  it("does not infer prewrite certainty from whole-script scope error prose", () => {
    const error = scopeConflictMessage("the note is not in the expected folder");
    exec.mockReturnValue({ success: false, output: "", error });
    const results = manager.batchMoveNotes([ID1, ID2], "Archive", undefined, { ifFolderId: F1 });
    for (const result of results) {
      expect(result).toMatchObject({ success: false, error, indeterminate: true });
      expect(result).not.toHaveProperty("committed");
    }
  });

  it("keeps missing status rows uncertain rather than claiming no move", () => {
    exec.mockReturnValue({ success: true, output: "missing" + R });
    const results = manager.batchMoveNotes([ID1, ID2], "Archive");
    expect(results[0]).toMatchObject({ committed: false, indeterminate: false });
    expect(results[1]).toEqual({
      id: ID2,
      success: false,
      error: "Unknown error",
      indeterminate: true,
    });
  });
});
