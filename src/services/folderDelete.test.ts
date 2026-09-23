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
const id = "x-coredata://ABC/ICFolder/p12";
const parent = "x-coredata://ABC/ICFolder/p2";
const account = "x-coredata://ABC/ICAccount/p1";
const US = "\u001f";

beforeEach(() => vi.clearAllMocks());

/** Compiles an AppleScript with osacompile (no execution, Notes is not launched). */
function compiles(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "folder-delete-osa-"));
  try {
    const source = join(dir, "script.applescript");
    writeFileSync(source, script);
    execFileSync("osacompile", ["-o", join(dir, "script.scpt"), source], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("getFolderById account fields", () => {
  it("adds accountId and isRoot when Notes reports the account", () => {
    exec.mockReturnValue({ success: true, output: `Top${US}${account}${US}${account}\n` });
    expect(manager.getFolderById(id)).toEqual({
      id,
      name: "Top",
      parentId: account,
      accountId: account,
      isRoot: true,
    });
    exec.mockReturnValue({ success: true, output: `Child${US}${parent}${US}${account}\n` });
    expect(manager.getFolderById(id)).toMatchObject({ isRoot: false });
    compiles(exec.mock.calls[0][0]);
  });
});

describe("readFolderForDelete", () => {
  it("parses one read of name, parent, account, default folder, sharing, and counts", () => {
    exec.mockReturnValue({
      success: true,
      output: ["Old", parent, account, "x-coredata://ABC/ICFolder/p3", "false", "0", "0"].join(US),
    });
    expect(manager.readFolderForDelete(id)).toEqual({
      id,
      name: "Old",
      parentId: parent,
      accountId: account,
      defaultFolderId: "x-coredata://ABC/ICFolder/p3",
      shared: false,
      childFolderCount: 0,
      noteCount: 0,
    });
    const script = exec.mock.calls[0][0];
    expect(script).toContain(`folder id "${id}"`);
    expect(script).toContain("default folder of acct");
    // Stale child relationships: only children that still exist are counted.
    expect(script).toContain("if exists folder id (id of childRef)");
    expect(script).not.toMatch(/\bdelete\b/);
    compiles(script);
  });

  it("reports a root folder with a null parent and inherited sharing", () => {
    exec.mockReturnValue({
      success: true,
      output: ["Top", "", account, "", "true", "2", "5"].join(US),
    });
    expect(manager.readFolderForDelete(id)).toMatchObject({
      parentId: null,
      defaultFolderId: null,
      shared: true,
      childFolderCount: 2,
      noteCount: 5,
    });
  });

  it("rejects bad ids, failures, and incomplete output", () => {
    expect(() => manager.readFolderForDelete(id.replace("ICFolder", "ICNote"))).toThrow(
      /folder ID/
    );
    exec.mockReturnValue({ success: false, output: "", error: "Folder not found" });
    expect(() => manager.readFolderForDelete(id)).toThrow(/not found/);
    exec.mockReturnValue({ success: false, output: "" });
    expect(() => manager.readFolderForDelete(id)).toThrow(/not found/);
    exec.mockReturnValue({ success: true, output: "Old" });
    expect(() => manager.readFolderForDelete(id)).toThrow(/Incomplete/);
    exec.mockReturnValue({
      success: true,
      output: ["Old", parent, account, "", "false", "x", "0"].join(US),
    });
    expect(() => manager.readFolderForDelete(id)).toThrow(/Incomplete/);
  });
});

describe("deleteEmptyFolderIfUnchanged", () => {
  const expected = { name: 'R&D "old"', parentId: parent, accountId: account };

  it("repeats every guard inside the delete script, before the delete, once", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED\n" });
    expect(manager.deleteEmptyFolderIfUnchanged(id, expected)).toEqual({ status: "deleted" });
    const script = exec.mock.calls[0][0];
    const deleteAt = script.indexOf("delete f");
    for (const guard of [
      "SAFETY_CONFLICT:name",
      "SAFETY_CONFLICT:parent",
      "SAFETY_CONFLICT:account",
      "SAFETY_REFUSED:default folder",
      "SAFETY_REFUSED:shared folder",
      "SAFETY_REFUSED:folder has child folders",
      "SAFETY_REFUSED:folder has notes",
    ]) {
      expect(script.indexOf(guard)).toBeGreaterThan(0);
      expect(script.indexOf(guard)).toBeLessThan(deleteAt);
    }
    expect(script).toContain('R&D \\"old\\"');
    expect(script).toContain("considering case");
    expect(exec.mock.calls[0][1]).toMatchObject({ maxRetries: 1 });
    compiles(script);
  });

  it("guards a root folder with an empty parent id", () => {
    exec.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
    manager.deleteEmptyFolderIfUnchanged(id, { ...expected, parentId: null });
    expect(exec.mock.calls[0][0]).toContain('if parentId is not "" then');
  });

  it.each([
    ["SAFETY_CONFLICT:parent", { status: "conflict", reason: "parent" }],
    ["SAFETY_REFUSED:folder has notes", { status: "refused", reason: "folder has notes" }],
    ["something else", { status: "failed", reason: "Unexpected AppleScript result" }],
  ])("maps %s", (output, result) => {
    exec.mockReturnValue({ success: true, output });
    expect(manager.deleteEmptyFolderIfUnchanged(id, expected)).toEqual(result);
  });

  it("reports failure without retrying", () => {
    exec.mockReturnValue({ success: false, output: "", error: "timeout" });
    expect(manager.deleteEmptyFolderIfUnchanged(id, expected)).toEqual({
      status: "failed",
      reason: "timeout",
    });
    exec.mockReturnValue({ success: false, output: "" });
    expect(manager.deleteEmptyFolderIfUnchanged(id, expected)).toMatchObject({
      reason: "AppleScript failed",
    });
    expect(() => manager.deleteEmptyFolderIfUnchanged("bad", expected)).toThrow(/folder ID/);
  });
});

describe("countNotesOutsideFolder", () => {
  const notes = ["x-coredata://ABC/ICNote/p44", "x-coredata://ABC/ICNote/p45"];

  it("asks Notes.app where each note is now and parses the count", () => {
    exec.mockReturnValue({ success: true, output: "1\n" });
    expect(manager.countNotesOutsideFolder(id, notes)).toBe(1);
    const script = exec.mock.calls[0][0];
    expect(script).toContain('{"x-coredata://ABC/ICNote/p44", "x-coredata://ABC/ICNote/p45"}');
    expect(script).toContain("if class of c is not folder then");
    expect(script).toContain(`is not "${id}"`);
    compiles(script);
  });

  it("counts nothing on failure, bad output, or an empty list", () => {
    expect(manager.countNotesOutsideFolder(id, [])).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    exec.mockReturnValue({ success: false, output: "", error: "boom" });
    expect(manager.countNotesOutsideFolder(id, notes)).toBe(0);
    exec.mockReturnValue({ success: true, output: "7" });
    expect(manager.countNotesOutsideFolder(id, notes)).toBe(0);
    exec.mockReturnValue({ success: true, output: "x" });
    expect(manager.countNotesOutsideFolder(id, notes)).toBe(0);
    expect(() => manager.countNotesOutsideFolder("bad", notes)).toThrow(/folder ID/);
    expect(() => manager.countNotesOutsideFolder(id, ["bad"])).toThrow(/Invalid note ID/);
  });
});

describe("folderExistsById", () => {
  it("reads existence and propagates failures", () => {
    exec.mockReturnValue({ success: true, output: "false\n" });
    expect(manager.folderExistsById(id)).toBe(false);
    compiles(exec.mock.calls[0][0]);
    exec.mockReturnValue({ success: true, output: "true" });
    expect(manager.folderExistsById(id)).toBe(true);
    exec.mockReturnValue({ success: false, output: "", error: "Notes not running" });
    expect(() => manager.folderExistsById(id)).toThrow(/not running/);
    exec.mockReturnValue({ success: false, output: "" });
    expect(() => manager.folderExistsById(id)).toThrow(/existence/);
    expect(() => manager.folderExistsById("bad")).toThrow(/folder ID/);
  });
});
