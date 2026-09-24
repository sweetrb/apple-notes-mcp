import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_FORBIDDEN_FOLDERS,
  buildScopeGuardScript,
  hasScopeGuard,
  parseScopeFailure,
  scopeConflictMessage,
  validateScopeGuard,
} from "./scopeGuard.js";

const S = "x-coredata://ABC";
const F1 = `${S}/ICFolder/p1`;
const F2 = `${S}/ICFolder/p2`;
const F3 = `${S}/ICFolder/p3`;

/** Compiles the snippet inside a Notes tell block with osacompile (not executed). */
function compiles(snippet: string): void {
  const dir = mkdtempSync(join(tmpdir(), "scope-guard-osa-"));
  try {
    const source = join(dir, "script.applescript");
    writeFileSync(
      source,
      `tell application "Notes"
      set noteRef to note id "${S}/ICNote/p9"
      set destFolder to folder id "${F3}"${snippet}
      return "OK"
    end tell`
    );
    execFileSync("osacompile", ["-o", join(dir, "script.scpt"), source], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scope guard", () => {
  it("detects whether any precondition was given", () => {
    expect(hasScopeGuard(undefined)).toBe(false);
    expect(hasScopeGuard({})).toBe(false);
    expect(hasScopeGuard({ forbiddenAncestorFolderIds: [] })).toBe(false);
    expect(hasScopeGuard({ ifFolderId: F1 })).toBe(true);
    expect(hasScopeGuard({ ifAncestorFolderId: F1 })).toBe(true);
    expect(hasScopeGuard({ forbiddenAncestorFolderIds: [F1] })).toBe(true);
  });

  it("emits nothing without a guard", () => {
    expect(buildScopeGuardScript("noteRef", undefined)).toBe("");
    expect(buildScopeGuardScript("noteRef", { ifFolderId: undefined })).toBe("");
  });

  it("checks the exact folder without walking ancestors", () => {
    const script = buildScopeGuardScript("noteRef", { ifFolderId: F1 });
    expect(script).toContain("set scopeFolder to container of noteRef");
    expect(script).toContain("SAFETY_SCOPE:the note is not in a folder");
    expect(script).toContain(`if (id of scopeFolder) is not "${F1}"`);
    expect(script).not.toContain("scopeChain");
    compiles(script);
  });

  it("walks the ancestor chain for ancestor and forbidden guards, including a destination", () => {
    const script = buildScopeGuardScript(
      "noteRef",
      { ifAncestorFolderId: F1, forbiddenAncestorFolderIds: [F2, F3] },
      "destFolder"
    );
    expect(script).toContain("repeat while class of scopeChainCursor is folder");
    expect(script).toContain(`scopeChain does not contain "${F1}"`);
    expect(script).toContain(`repeat with forbiddenId in {"${F2}", "${F3}"}`);
    expect(script).toContain("set scopeDestChainCursor to destFolder");
    expect(script).toContain("SAFETY_SCOPE:the destination is inside a forbidden folder");
    compiles(script);
  });

  it("refuses a forbidden id that names no folder instead of passing (#215)", () => {
    const script = buildScopeGuardScript("noteRef", { forbiddenAncestorFolderIds: [F2, F3] });
    const exists = script.indexOf(
      'if not (exists folder id (contents of forbiddenId)) then return "SAFETY_SCOPE:a forbidden folder id does not match any folder"'
    );
    expect(exists).toBeGreaterThan(-1);
    expect(exists).toBeLessThan(script.indexOf("the note is inside a forbidden folder"));
    expect(buildScopeGuardScript("noteRef", { ifFolderId: F1 })).not.toContain("exists folder id");
    compiles(script);
  });

  it("compares folder ids in the spelling Notes returns (#215)", () => {
    // Notes does not resolve a zero-padded key, and returns the store UUID in upper case.
    const script = buildScopeGuardScript("noteRef", {
      ifFolderId: "x-coredata://abc/ICFolder/p001",
      ifAncestorFolderId: "x-coredata://abc/ICFolder/p02",
      forbiddenAncestorFolderIds: ["x-coredata://abc/ICFolder/p03", F3],
    });
    expect(script).toContain(`if (id of scopeFolder) is not "${F1}"`);
    expect(script).toContain(`scopeChain does not contain "${F2}"`);
    expect(script).toContain(`repeat with forbiddenId in {"${F3}"}`);
    expect(script).not.toMatch(/p0\d/);
  });

  it("skips the destination chain without forbidden folders or a destination", () => {
    expect(
      buildScopeGuardScript("noteRef", { ifAncestorFolderId: F1 }, "destFolder")
    ).not.toContain("scopeDestChain");
    expect(buildScopeGuardScript("noteRef", { forbiddenAncestorFolderIds: [F2] })).not.toContain(
      "scopeDestChain"
    );
  });

  it("rejects ids that are not exact folder ids, and too many forbidden ids", () => {
    expect(() => validateScopeGuard({ ifFolderId: `${S}/ICNote/p1` })).toThrow(/exact folder ids/);
    expect(() => buildScopeGuardScript("n", { ifAncestorFolderId: 'x" & quit & "' })).toThrow(
      /exact folder ids/
    );
    expect(() =>
      validateScopeGuard({
        forbiddenAncestorFolderIds: Array.from(
          { length: MAX_FORBIDDEN_FOLDERS + 1 },
          (_, i) => `${S}/ICFolder/p${i + 1}`
        ),
      })
    ).toThrow(/At most/);
    expect(() =>
      validateScopeGuard({ ifFolderId: F1, forbiddenAncestorFolderIds: [F2] })
    ).not.toThrow();
  });

  it("parses scope failures and formats the message", () => {
    expect(parseScopeFailure("SAFETY_SCOPE:the note is not in the expected folder\n")).toBe(
      "the note is not in the expected folder"
    );
    expect(parseScopeFailure("SAFETY_UPDATED")).toBeNull();
    expect(scopeConflictMessage("x")).toMatch(/^Scope guard failed: x\. Nothing was changed/);
  });
});
