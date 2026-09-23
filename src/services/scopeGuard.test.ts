import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
// Keep the live NoteStore out of this test: no smart folders.
vi.mock("@/utils/smartFolders.js", () => ({ readSmartFolders: vi.fn(() => ({ folders: [] })) }));
vi.mock("@/utils/noteRichText.js", async (original) => ({
  ...(await original<typeof import("@/utils/noteRichText.js")>()),
  readRichNote: vi.fn(),
}));
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeAppleScript } from "../utils/applescript.js";
import { AppleNotesManager } from "./appleNotesManager.js";

const exec = vi.mocked(executeAppleScript);
const manager = new AppleNotesManager();
const S = "x-coredata://ABC00000-0000-0000-0000-000000000004";
const id = `${S}/ICNote/p790`;
const F1 = `${S}/ICFolder/p1`;
const F2 = `${S}/ICFolder/p2`;

beforeEach(() => vi.clearAllMocks());

function compiles(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "scope-write-osa-"));
  try {
    const source = join(dir, "script.applescript");
    writeFileSync(source, script);
    execFileSync("osacompile", ["-o", join(dir, "script.scpt"), source], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scope guards inside write scripts", () => {
  it("update: checks scope before the attachment check and the body write", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_UPDATED" });
    manager.updateNoteByIdIfUnchanged(
      id,
      "T",
      "<div>T</div>",
      undefined,
      "x",
      "plaintext",
      undefined,
      {
        ifFolderId: F1,
      }
    );
    const script = exec.mock.calls[0][0];
    expect(script.indexOf(`is not "${F1}"`)).toBeGreaterThan(0);
    expect(script.indexOf(`is not "${F1}"`)).toBeLessThan(script.indexOf("set body of noteRef"));
    compiles(script);

    exec.mockReturnValue({
      success: true,
      output: "SAFETY_SCOPE:the note is not in the expected folder",
    });
    expect(
      manager.updateNoteByIdIfUnchanged(id, "T", "b", undefined, "x", "plaintext", undefined, {
        ifFolderId: F1,
      })
    ).toEqual({ status: "scope_conflict", reason: "the note is not in the expected folder" });
  });

  it("update without a guard emits no scope checks", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_UPDATED" });
    manager.updateNoteByIdIfUnchanged(id, "T", "b", undefined, "x");
    expect(exec.mock.calls[0][0]).not.toContain("scopeFolder");
  });

  it("delete: checks scope before the delete", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
    expect(manager.deleteNoteByIdIfUnchanged(id, "b", { ifAncestorFolderId: F1 })).toEqual({
      status: "deleted",
    });
    const script = exec.mock.calls[0][0];
    expect(script.indexOf("scopeChain does not contain")).toBeLessThan(
      script.indexOf("delete noteRef")
    );
    compiles(script);
    exec.mockReturnValue({
      success: true,
      output: "SAFETY_SCOPE:the note is inside a forbidden folder",
    });
    expect(
      manager.deleteNoteByIdIfUnchanged(id, "b", { forbiddenAncestorFolderIds: [F2] })
    ).toEqual({ status: "scope_conflict", reason: "the note is inside a forbidden folder" });
  });

  it("move: checks the note and destination before moving, and throws on failure", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_MOVED" });
    expect(
      manager.moveNoteById(id, "Archive", "iCloud", { forbiddenAncestorFolderIds: [F2] })
    ).toBe(true);
    const script = exec.mock.calls[0][0];
    expect(script.indexOf("scopeDestChain")).toBeGreaterThan(0);
    expect(script.indexOf("scopeDestChain")).toBeLessThan(script.indexOf("move noteRef"));
    exec.mockReturnValue({
      success: true,
      output: "SAFETY_SCOPE:the destination is inside a forbidden folder",
    });
    expect(() =>
      manager.moveNoteById(id, "Archive", "iCloud", { forbiddenAncestorFolderIds: [F2] })
    ).toThrow(/Scope guard failed: the destination is inside a forbidden folder/);
  });

  it("checkNoteScope: read-only pre-check for native writes", () => {
    exec.mockReturnValue({ success: true, output: "SCOPE_OK" });
    expect(manager.checkNoteScope(id, { ifFolderId: F1 })).toBeNull();
    const script = exec.mock.calls[0][0];
    expect(script).not.toMatch(/\b(delete|move|set body)\b/);
    compiles(script);
    exec.mockReturnValue({ success: true, output: "SAFETY_SCOPE:the note is not in a folder" });
    expect(manager.checkNoteScope(id, { ifFolderId: F1 })).toBe("the note is not in a folder");
    exec.mockReturnValue({ success: false, output: "", error: "Notes not running" });
    expect(manager.checkNoteScope(id, { ifFolderId: F1 })).toBe("Notes not running");
    exec.mockReturnValue({ success: false, output: "" });
    expect(manager.checkNoteScope(id, { ifFolderId: F1 })).toMatch(/could not be read/);
  });
});
