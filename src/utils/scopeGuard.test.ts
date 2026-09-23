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
