import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
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
const guardId = `${S}/ICNote/p791`;
const activeId = `${S}/ICNote/p792`;
const trash = `${S}/ICFolder/p5`;

beforeEach(() => vi.clearAllMocks());

/** Compiles an AppleScript with osacompile (no execution; Notes is not launched). */
function compiles(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "guarded-delete-osa-"));
  try {
    const source = join(dir, "script.applescript");
    writeFileSync(source, script);
    execFileSync("osacompile", ["-o", join(dir, "script.scpt"), source], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deleteNoteByIdIfUnchanged guards", () => {
  it("refuses a note in Recently Deleted by default, checked before the delete", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
    manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", { trashFolderIds: [trash] });
    const script = exec.mock.calls[0][0];
    expect(script).toContain("set srcContainer to container of noteRef");
    expect(script).toContain("(class of srcContainer is not folder)");
    expect(script).toContain(`(id of srcContainer) is in {"${trash}"}`);
    expect(script).toContain('(name of srcContainer) is "Recently Deleted"');
    expect(script.indexOf('return "SAFETY_IN_TRASH"')).toBeLessThan(
      script.indexOf("delete noteRef")
    );
    compiles(script);
  });

  it("maps an in-trash refusal", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_IN_TRASH\n" });
    expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>")).toEqual({
      status: "in_trash",
    });
    expect(exec.mock.calls[0][0]).toContain("is in {}");
  });

  it("allows a permanent delete only when asked and reports it", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED:permanent" });
    expect(
      manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", { allowPermanent: true })
    ).toEqual({ status: "deleted", permanent: true });
    const script = exec.mock.calls[0][0];
    expect(script).not.toContain('return "SAFETY_IN_TRASH"');
    expect(script).toContain('set deletedResult to "SAFETY_DELETED:permanent"');
    compiles(script);

    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
    expect(
      manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", { allowPermanent: true })
    ).toEqual({ status: "deleted" });
  });

  it("re-checks the guard note's state and body inside the delete script", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
    manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", {
      trashFolderIds: [trash],
      activeNotes: [{ id: guardId, expectedBody: '<div>Copy "q"</div>' }, { id: activeId }],
    });
    const script = exec.mock.calls[0][0];
    const deleteAt = script.indexOf("delete noteRef");
    for (const marker of [
      `exists note id "${guardId}"`,
      "SAFETY_GUARD_INACTIVE:0:missing",
      "SAFETY_GUARD_INACTIVE:0:locked",
      "SAFETY_GUARD_INACTIVE:0:in Recently Deleted",
      "SAFETY_GUARD_CONFLICT:0",
      `exists note id "${activeId}"`,
      "SAFETY_GUARD_INACTIVE:1:locked",
    ]) {
      expect(script.indexOf(marker)).toBeGreaterThan(0);
      expect(script.indexOf(marker)).toBeLessThan(deleteAt);
    }
    expect(script).not.toContain("SAFETY_GUARD_CONFLICT:1");
    expect(script).toContain('Copy \\"q\\"');
    compiles(script);
  });

  it.each([
    ["SAFETY_GUARD_CONFLICT:0", { status: "guard_conflict", index: 0 }],
    [
      "SAFETY_GUARD_INACTIVE:1:in Recently Deleted",
      { status: "guard_inactive", index: 1, reason: "in Recently Deleted" },
    ],
    ["SAFETY_GUARD_INACTIVE:0", { status: "guard_inactive", index: 0, reason: "inactive" }],
    ["garbage", { status: "failed" }],
  ])("maps %s", (output, outcome) => {
    exec.mockReturnValue({ success: true, output });
    expect(
      manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", {
        activeNotes: [{ id: guardId, expectedBody: "x" }, { id: activeId }],
      })
    ).toEqual(outcome);
  });

  it("rejects malformed trash folder and guard ids before running", () => {
    expect(() =>
      manager.deleteNoteByIdIfUnchanged(id, "b", { trashFolderIds: ['x" & do shell script "'] })
    ).toThrow(/trash folder id/);
    expect(() =>
      manager.deleteNoteByIdIfUnchanged(id, "b", { activeNotes: [{ id: "bad" }] })
    ).toThrow(/Invalid note ID/);
    expect(exec).not.toHaveBeenCalled();
  });
});
