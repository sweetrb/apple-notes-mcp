/**
 * Unit Tests for Apple Notes Manager
 *
 * These tests verify the AppleNotesManager class and its helper functions.
 * The AppleScript execution is mocked to allow testing without macOS.
 *
 * Test Strategy:
 * - Helper functions (escapeForAppleScript, parseAppleScriptDate) are tested
 *   with various inputs to ensure correct escaping and parsing
 * - Manager methods are tested for success/failure paths
 * - Script generation is verified by checking for expected AppleScript patterns
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppleNotesManager,
  ExpectedBodies,
  escapeForAppleScript,
  escapeHtmlForAppleScript,
  buildAppleScriptDateVar,
  buildFolderReference,
  buildLiveFolderResolution,
  LIVE_FOLDER_NOT_FOUND,
  splitFolderPath,
  parseAppleScriptDate,
  sanitizeId,
  sanitizeNoteId,
  DEFAULT_EXPORT_PAGE_SIZE,
  estimateExportNoteBytes,
  exportMaxResponseBytes,
} from "./appleNotesManager.js";

// Mock the AppleScript execution module
// This prevents actual osascript calls during testing
// Only the executor is stubbed. `isPermissionDenied` is deliberately the REAL
// implementation: the whole point of the shared classifier is that the health
// check and the error mapping run the same code, so a mock here would test a
// copy instead of the thing that ships.
vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: vi.fn(),
    BULK_LIST_MUTATION_ERROR: "Notes changed during listing",
  };
});

// Mock the checklist parser to avoid SQLite access during tests
vi.mock("@/utils/checklistParser.js", () => ({
  getChecklistItems: vi.fn().mockReturnValue({ items: null }),
}));

import { executeAppleScript, noteBodyMaxBuffer } from "@/utils/applescript.js";
const mockExecuteAppleScript = vi.mocked(executeAppleScript);
const NO_RETRY_OPTIONS = { maxRetries: 1 };

import { getChecklistItems } from "@/utils/checklistParser.js";
const mockGetChecklistItems = vi.mocked(getChecklistItems);

// Mock the transcript reader so the delegation test never touches SQLite.
vi.mock("@/utils/audioTranscripts.js", () => ({
  readAudioTranscripts: vi.fn(),
}));
import { readAudioTranscripts } from "@/utils/audioTranscripts.js";
const mockReadAudioTranscripts = vi.mocked(readAudioTranscripts);

// Recently Deleted folder ids come from the database; keep tests off it.
vi.mock("@/utils/trashFolders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/trashFolders.js")>()),
  readTrashFolderIds: vi.fn(() => []),
}));
import { readTrashFolderIds } from "@/utils/trashFolders.js";
const mockReadTrashFolderIds = vi.mocked(readTrashFolderIds);
const G = "\x1d";
const TRASH_FOLDER = "x-coredata://ABC-123/ICFolder/p9";

function compilesAsAppleScript(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "trash-script-"));
  try {
    writeFileSync(join(dir, "s.applescript"), script);
    execFileSync("/usr/bin/osacompile", ["-o", join(dir, "s.scpt"), join(dir, "s.applescript")], {
      stdio: "pipe",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Result delimiters (#18) — must match appleNotesManager.ts.
// FIELD_SEP (US, \x1f) separates fields within a record;
// RECORD_SEP (RS, \x1e) separates records within a list.
const F = "\x1f";
const R = "\x1e";

// =============================================================================
// Text Escaping Tests
// =============================================================================

describe("escapeForAppleScript", () => {
  describe("empty and null handling", () => {
    it("returns empty string for empty input", () => {
      expect(escapeForAppleScript("")).toBe("");
    });

    it("returns empty string for null-like input", () => {
      // TypeScript prevents actual null, but runtime might have undefined
      expect(escapeForAppleScript(undefined as unknown as string)).toBe("");
    });
  });

  describe("single quote handling", () => {
    it("preserves single quotes (no escaping needed in AppleScript double-quoted strings)", () => {
      // Single quotes don't need escaping inside AppleScript double-quoted strings
      const result = escapeForAppleScript("it's working");
      expect(result).toBe("it's working");
    });

    it("handles multiple single quotes", () => {
      const result = escapeForAppleScript("Rob's mom's note");
      expect(result).toBe("Rob's mom's note");
    });
  });

  describe("double quote escaping (AppleScript strings)", () => {
    it("escapes double quotes for AppleScript", () => {
      // AppleScript strings: "hello \"quoted\" world"
      const result = escapeForAppleScript('say "hello"');
      expect(result).toBe('say \\"hello\\"');
    });

    it("handles mixed quotes", () => {
      const result = escapeForAppleScript('He said "it\'s fine"');
      expect(result).toBe('He said \\"it\'s fine\\"');
    });
  });

  describe("control character conversion (HTML for Notes.app)", () => {
    it("converts newlines to <br> tags", () => {
      const result = escapeForAppleScript("line 1\nline 2\nline 3");
      expect(result).toBe("line 1<br>line 2<br>line 3");
    });

    it("converts tabs to <br> tags", () => {
      const result = escapeForAppleScript("col1\tcol2\tcol3");
      expect(result).toBe("col1<br>col2<br>col3");
    });

    it("handles mixed control characters", () => {
      const result = escapeForAppleScript("row1\tcol2\nrow2\tcol2");
      expect(result).toBe("row1<br>col2<br>row2<br>col2");
    });
  });

  describe("complex content", () => {
    it("handles real-world note content", () => {
      const content = 'John\'s "Meeting Notes"\n- Item 1\n- Item 2';
      const result = escapeForAppleScript(content);
      expect(result).toBe('John\'s \\"Meeting Notes\\"<br>- Item 1<br>- Item 2');
    });
  });

  describe("unicode and special characters", () => {
    it("preserves unicode characters", () => {
      const result = escapeForAppleScript("日本語テスト 🎉");
      expect(result).toBe("日本語テスト 🎉");
    });

    it("preserves emoji in content", () => {
      const result = escapeForAppleScript("Shopping 🛒\n- Eggs 🥚\n- Milk 🥛");
      expect(result).toBe("Shopping 🛒<br>- Eggs 🥚<br>- Milk 🥛");
    });

    it("handles accented characters", () => {
      const result = escapeForAppleScript("Café résumé naïve");
      expect(result).toBe("Café résumé naïve");
    });

    it("handles backslashes", () => {
      // Backslashes are HTML-encoded to avoid AppleScript escaping issues
      const result = escapeForAppleScript("path\\to\\file");
      expect(result).toBe("path&#92;to&#92;file");
    });

    it("handles ampersands", () => {
      // Ampersands are HTML-encoded for Notes.app (& becomes &amp;)
      const result = escapeForAppleScript("A && B & C");
      expect(result).toBe("A &amp;&amp; B &amp; C");
    });

    it("handles angle brackets (HTML-like content)", () => {
      // Single quotes pass through unchanged
      const result = escapeForAppleScript("<script>alert('xss')</script>");
      expect(result).toBe("<script>alert('xss')</script>");
    });
  });

  describe("boundary conditions", () => {
    it("handles very short strings", () => {
      expect(escapeForAppleScript("a")).toBe("a");
      expect(escapeForAppleScript("'")).toBe("'");
      expect(escapeForAppleScript('"')).toBe('\\"');
    });

    it("handles string with only whitespace", () => {
      expect(escapeForAppleScript("   ")).toBe("   ");
    });

    it("handles multiple consecutive special characters", () => {
      // Single quotes pass through, double quotes are escaped
      const result = escapeForAppleScript("'''\"\"\"");
      expect(result).toBe("'''\\\"\\\"\\\"");
    });
  });
});

// =============================================================================
// HTML Content Escaping Tests (for already-HTML content)
// =============================================================================

describe("escapeHtmlForAppleScript", () => {
  describe("basic escaping", () => {
    it("returns empty string for null/undefined", () => {
      expect(escapeHtmlForAppleScript("")).toBe("");
      expect(escapeHtmlForAppleScript(null as unknown as string)).toBe("");
      expect(escapeHtmlForAppleScript(undefined as unknown as string)).toBe("");
    });

    it("escapes double quotes for AppleScript", () => {
      const result = escapeHtmlForAppleScript('<div>Hello "World"</div>');
      expect(result).toBe('<div>Hello \\"World\\"</div>');
    });

    it("escapes backslashes for AppleScript", () => {
      const result = escapeHtmlForAppleScript("<div>Path: C:\\Users\\test</div>");
      expect(result).toBe("<div>Path: C:\\\\Users\\\\test</div>");
    });

    it("handles both backslashes and quotes", () => {
      const result = escapeHtmlForAppleScript('<div>Path: "C:\\test"</div>');
      expect(result).toBe('<div>Path: \\"C:\\\\test\\"</div>');
    });
  });

  describe("preserves HTML content", () => {
    it("does not re-encode existing HTML entities", () => {
      const result = escapeHtmlForAppleScript("<div>&amp; &lt; &gt;</div>");
      expect(result).toBe("<div>&amp; &lt; &gt;</div>");
    });

    it("preserves HTML tags", () => {
      const result = escapeHtmlForAppleScript("<div><b>Bold</b><br><i>Italic</i></div>");
      expect(result).toBe("<div><b>Bold</b><br><i>Italic</i></div>");
    });

    it("preserves numeric HTML entities", () => {
      const result = escapeHtmlForAppleScript("<div>&#92; &#60; &#62;</div>");
      expect(result).toBe("<div>&#92; &#60; &#62;</div>");
    });
  });
});

// =============================================================================
// Date Parsing Tests
// =============================================================================

describe("parseAppleScriptDate", () => {
  describe("standard format parsing", () => {
    it("parses AppleScript date with 'date' prefix", () => {
      const dateStr = "date Saturday, December 27, 2025 at 3:44:02 PM";
      const result = parseAppleScriptDate(dateStr);

      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(11); // December is month 11 (0-indexed)
      expect(result.getDate()).toBe(27);
    });

    it("parses date without 'date' prefix", () => {
      const dateStr = "Saturday, December 27, 2025 at 3:44:02 PM";
      const result = parseAppleScriptDate(dateStr);

      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(11);
    });

    it("correctly handles AM/PM times", () => {
      const morningDate = "date Monday, January 1, 2025 at 9:30:00 AM";
      const eveningDate = "date Monday, January 1, 2025 at 9:30:00 PM";

      const morning = parseAppleScriptDate(morningDate);
      const evening = parseAppleScriptDate(eveningDate);

      expect(morning.getHours()).toBe(9);
      expect(evening.getHours()).toBe(21);
    });
  });

  describe("locale-independent numeric format (#25)", () => {
    it("parses the Y-M-D-H-m-s form emitted by our producers", () => {
      const result = parseAppleScriptDate("2025-12-27-15-44-2");
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(11);
      expect(result.getDate()).toBe(27);
      expect(result.getHours()).toBe(15);
      expect(result.getMinutes()).toBe(44);
      expect(result.getSeconds()).toBe(2);
    });

    it("handles single-digit components and midnight", () => {
      const result = parseAppleScriptDate("2025-1-5-0-0-0");
      expect(result.getMonth()).toBe(0);
      expect(result.getDate()).toBe(5);
      expect(result.getHours()).toBe(0);
    });
  });

  describe("fallback behavior", () => {
    it("returns current date for invalid input", () => {
      const before = new Date();
      const result = parseAppleScriptDate("not a valid date");
      const after = new Date();

      // Result should be between before and after (i.e., "now")
      expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("returns current date for empty string", () => {
      const before = new Date();
      const result = parseAppleScriptDate("");
      const after = new Date();

      expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});

// =============================================================================
// buildFolderReference Tests
// =============================================================================

describe("splitFolderPath", () => {
  it("splits simple path on /", () => {
    expect(splitFolderPath("Work/Clients")).toEqual(["Work", "Clients"]);
  });

  it("returns single segment for a name without /", () => {
    expect(splitFolderPath("Work")).toEqual(["Work"]);
  });

  it("preserves escaped slashes in folder names", () => {
    expect(splitFolderPath("Travel/Spain\\/Portugal 2023")).toEqual([
      "Travel",
      "Spain/Portugal 2023",
    ]);
  });

  it("handles multiple escaped slashes", () => {
    expect(splitFolderPath("A\\/B/C\\/D")).toEqual(["A/B", "C/D"]);
  });
});

describe("buildFolderReference", () => {
  it("returns simple folder reference for a single name", () => {
    expect(buildFolderReference("Work")).toBe('folder "Work"');
  });

  it("returns nested folder reference for a path", () => {
    expect(buildFolderReference("Work/Clients")).toBe('folder "Clients" of folder "Work"');
  });

  it("handles deeply nested paths", () => {
    expect(buildFolderReference("Work/Clients/Omnia")).toBe(
      'folder "Omnia" of folder "Clients" of folder "Work"'
    );
  });

  it("handles special characters in folder names", () => {
    const result = buildFolderReference("Food & Drink/🥘 Recipes");
    expect(result).toContain('folder "🥘 Recipes"');
    expect(result).toContain('folder "Food & Drink"');
  });

  it("handles escaped slashes in folder names", () => {
    const result = buildFolderReference("Travel/Spain\\/Portugal 2023");
    expect(result).toBe('folder "Spain/Portugal 2023" of folder "Travel"');
  });
});

// #213: name references keep resolving folders deleted earlier in the Notes
// session, so folder writes resolve each path segment to a live id.
describe("buildLiveFolderResolution", () => {
  it("accepts a root segment only when it still exists by id", () => {
    const script = buildLiveFolderResolution("Work", "f");
    expect(script).toContain('repeat with f_c in (folders of __acctRef whose name is "Work")');
    expect(script).toContain("set f_cid to id of f_c");
    expect(script).toContain("if exists folder id f_cid then");
    expect(script).toContain("if class of (container of f_c) is not folder then");
    expect(script).toContain("set f to folder id f_cid");
    expect(script).toContain(
      `if f is missing value then error "${LIVE_FOLDER_NOT_FOUND}: Work" number -1728`
    );
    expect(script).not.toContain('folder "Work"');
  });

  it("falls back to a live nested namesake unless rootOnly", () => {
    expect(buildLiveFolderResolution("Work", "f")).toContain(
      "if f is missing value then set f to f_any"
    );
    expect(buildLiveFolderResolution("Work", "f", { rootOnly: true })).not.toContain(
      "set f to f_any"
    );
  });

  it("walks nested segments under the resolved parent", () => {
    const script = buildLiveFolderResolution("Work/Clients/Omnia", "f");
    const clients = script.indexOf('repeat with f_c in (folders of f_p whose name is "Clients")');
    const omnia = script.indexOf('repeat with f_c in (folders of f_p whose name is "Omnia")');
    expect(script.indexOf('whose name is "Work"')).toBeLessThan(clients);
    expect(clients).toBeGreaterThan(0);
    expect(omnia).toBeGreaterThan(clients);
    expect(script.match(/if exists folder id f_cid then/g)).toHaveLength(3);
    expect(script.match(/if f is missing value then error/g)).toHaveLength(3);
  });

  it("escapes names and honours escaped slashes", () => {
    const script = buildLiveFolderResolution('Travel/Spain\\/Portugal "23"', "f");
    expect(script).toContain('whose name is "Spain/Portugal \\"23\\""');
  });

  it("rejects invalid variables and paths", () => {
    expect(() => buildLiveFolderResolution("Work", "bad name")).toThrow(/variable/);
    expect(() => buildLiveFolderResolution("", "f")).toThrow();
  });
});

// =============================================================================
// buildAppleScriptDateVar Tests
// =============================================================================

describe("buildAppleScriptDateVar", () => {
  it("generates locale-safe AppleScript date setup code", () => {
    const date = new Date(2025, 5, 15, 14, 30, 0); // June 15, 2025 2:30 PM
    const result = buildAppleScriptDateVar(date);
    expect(result).toContain("set thresholdDate to current date");
    expect(result).toContain("set year of thresholdDate to 2025");
    expect(result).toContain("set month of thresholdDate to 6");
    expect(result).toContain("set day of thresholdDate to 15");
    // 14*3600 + 30*60 = 52200
    expect(result).toContain("set time of thresholdDate to 52200");
  });

  it("handles midnight (time = 0)", () => {
    const date = new Date(2025, 0, 1, 0, 0, 0); // Jan 1, 2025 midnight
    const result = buildAppleScriptDateVar(date);
    expect(result).toContain("set month of thresholdDate to 1");
    expect(result).toContain("set day of thresholdDate to 1");
    expect(result).toContain("set time of thresholdDate to 0");
  });

  it("uses custom variable name", () => {
    const date = new Date(2025, 0, 1, 0, 0, 0);
    const result = buildAppleScriptDateVar(date, "myDate");
    expect(result).toContain("set myDate to current date");
    expect(result).toContain("set year of myDate to 2025");
    expect(result).toContain("set month of myDate to 1");
  });

  it("calculates time in seconds correctly", () => {
    const date = new Date(2025, 11, 25, 9, 5, 3); // 9:05:03 AM
    const result = buildAppleScriptDateVar(date);
    // 9*3600 + 5*60 + 3 = 32703
    expect(result).toContain("set time of thresholdDate to 32703");
  });

  it("resets day to 1 before month to prevent month rollover (#86)", () => {
    // AppleScript rolls invalid intermediate dates: with `current date` on the
    // 31st, setting month to June yields July 1 before day is ever assigned.
    // Day must be pinned to 1 before the year/month assignments.
    const date = new Date(2025, 5, 15, 0, 0, 0); // June 15, 2025
    const result = buildAppleScriptDateVar(date);
    const lines = result.split("\n");
    const dayResetIdx = lines.indexOf("set day of thresholdDate to 1");
    const yearIdx = lines.indexOf("set year of thresholdDate to 2025");
    const monthIdx = lines.indexOf("set month of thresholdDate to 6");
    const dayIdx = lines.indexOf("set day of thresholdDate to 15");
    expect(dayResetIdx).toBeGreaterThan(-1);
    expect(dayResetIdx).toBeLessThan(yearIdx);
    expect(yearIdx).toBeLessThan(monthIdx);
    expect(monthIdx).toBeLessThan(dayIdx);
  });
});

// =============================================================================
// AppleNotesManager Tests
// =============================================================================

describe("AppleNotesManager", () => {
  let manager: AppleNotesManager;

  beforeEach(() => {
    manager = new AppleNotesManager();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Account Resolution (#128)
  // ---------------------------------------------------------------------------

  describe("account resolution", () => {
    it("targets Notes.app's own default account when none is given", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.searchNotes("anything");

      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      // A hardcoded "iCloud" is wrong whenever the real default account differs
      // — a non-iCloud default, a localized name, or a U+F8FF suffix (#128).
      expect(script).toContain("set __acctRef to default account");
      expect(script).not.toContain('tell account "iCloud"');
    });

    it("prefers an exact name match over a prefix match", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.searchNotes("anything", false, "Work");

      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      const exactAt = script.indexOf('every account whose name is "Work"');
      const prefixAt = script.indexOf('every account whose name starts with "Work"');
      expect(exactAt).toBeGreaterThan(-1);
      expect(prefixAt).toBeGreaterThan(-1);
      // Exact is tested first, and prefix is only consulted in the else branch.
      expect(exactAt).toBeLessThan(prefixAt);
    });

    it("refuses an ambiguous prefix match instead of silently picking the first", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.searchNotes("anything", false, "rob");

      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      // `first account whose name starts with ...` would resolve "rob" to
      // whichever of rob@… / robert@… Notes lists first and report success —
      // on the delete/move paths that is a destructive wrong-account write.
      expect(script).not.toContain("first account whose name starts with");
      expect(script).toContain("is ambiguous");
      expect(script).toContain("(count of _prefixMatches) > 1");
    });

    it("errors rather than proceeding when the named account does not exist", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.searchNotes("anything", false, "Nope");

      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      expect(script).toContain('Account \\"Nope\\" not found"');
      // Tagged so the swallow-into-false callers can tell a precondition error
      // from a genuine "note not found" outcome.
      expect(script).toContain("AccountResolutionError:");
    });

    it("reports an unresolvable account as such instead of 'note not found' on destructive paths", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error:
          'AccountResolutionError: Account "rob" is ambiguous - it matches 2 accounts: rob@a, rob@b. Use the full account name.',
      });

      // deleteFolder normally swallows failures into `false`; an unresolvable
      // account must surface instead, or the caller goes hunting for a missing
      // folder that was never the problem. (Same resolveAccount() path every
      // account-scoped destructive method uses.)
      expect(() => manager.deleteFolder("Doomed", "rob")).toThrow(/is ambiguous/);
      expect(() => manager.deleteFolder("Doomed", "rob")).not.toThrow(/AccountResolutionError/);
    });

    it("still swallows a genuine operation failure into false", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: 'Can\'t get folder "Doomed".',
      });

      expect(manager.deleteFolder("Doomed", "iCloud")).toBe(false);
    });

    it("resolves the account for destructive paths too (deleteFolder, batch move)", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.deleteFolder("Doomed", "rob");
      const deleteScript = String(mockExecuteAppleScript.mock.calls.at(-1)?.[0]);
      expect(deleteScript).toContain("is ambiguous");
      expect(deleteScript).not.toContain("first account whose name starts with");

      manager.batchMoveNotes(["x-coredata://ABC/ICNote/p1"], "Archive", "rob");
      const moveScript = String(mockExecuteAppleScript.mock.calls.at(-1)?.[0]);
      expect(moveScript).toContain("is ambiguous");
      expect(moveScript).toContain("of __acctRef");
    });

    it("treats a blank account string as 'use the default'", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.searchNotes("anything", false, "   ");

      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      expect(script).toContain("set __acctRef to default account");
    });
  });

  describe("listAttachments — security", () => {
    it("escapes the account name so it cannot break out of the AppleScript literal (injection regression)", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });
      manager.listAttachments("My Note", 'evil" injected');
      const script = String(mockExecuteAppleScript.mock.calls.at(-1)?.[0]);
      // The account's double-quote must be escaped (\\") — a raw quote would
      // terminate the account-name string literal and allow `do shell script` injection.
      expect(script).toContain('every account whose name is "evil\\" injected"');
      expect(script).not.toContain('every account whose name is "evil" injected"');
    });
  });

  // ---------------------------------------------------------------------------
  // Note Creation
  // ---------------------------------------------------------------------------

  describe("createNote", () => {
    it("does not retry creation after an ambiguous timeout", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Operation timed out after 30 seconds",
      });

      manager.createNote("One copy", "Body");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(expect.any(String), { maxRetries: 1 });
    });

    it("returns Note object on successful creation", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output: "note id x-coredata://12345/ICNote/p100",
        })
        // The reported account comes from Notes.app's own default account (#128),
        // not a hardcoded "iCloud".
        .mockReturnValueOnce({ success: true, output: "Personal" });

      const result = manager.createNote("Shopping List", "Eggs, Milk, Bread");

      expect(result).not.toBeNull();
      expect(result?.title).toBe("Shopping List");
      expect(result?.content).toBe("Eggs, Milk, Bread");
      expect(result?.account).toBe("Personal");
    });

    it("strips the 'note id ' prefix from the returned id (#create-note-id)", () => {
      // AppleScript's `id of newNote` yields an object specifier with a literal
      // "note id " prefix. The returned id must be the bare x-coredata:// URL so
      // downstream tools (get-note-content, update-note) accept it.
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://ABC-DEF/ICNote/p42",
      });

      const result = manager.createNote("Prefixed", "Body");

      expect(result?.id).toBe("x-coredata://ABC-DEF/ICNote/p42");
      expect(result?.id).not.toMatch(/^note id /);
    });

    it("accepts the bare canonical ID form returned by some Notes accounts", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "x-coredata://ABC-DEF/ICNote/p43",
      });

      expect(manager.createNote("Bare ID", "Body")?.id).toBe("x-coredata://ABC-DEF/ICNote/p43");
    });

    it("fails closed when Notes does not return a real CoreData note ID", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "note 1 of folder Notes" });

      const result = manager.createNote("No writable identity", "Body");

      expect(result).toBeNull();
    });

    it("returned id round-trips through get-note-content and update-note (#create-note-id)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://ABC-DEF/ICNote/p99",
      });
      const created = manager.createNote("Roundtrip", "Body");
      const id = created?.id as string;
      expect(id).toBe("x-coredata://ABC-DEF/ICNote/p99");

      // Reading back by the returned id must not throw "Invalid note ID format".
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "Body text" });
      expect(() => manager.getNoteContentById(id)).not.toThrow();

      // Updating by the returned id must not throw either.
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_UPDATED" });
      expect(() =>
        manager.updateNoteByIdIfUnchanged(id, "Roundtrip", "<div>Body</div>", undefined, "New body")
      ).not.toThrow();
    });

    it("returns null when AppleScript fails", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Notes.app not responding",
      });

      const result = manager.createNote("Test", "Content");

      expect(result).toBeNull();
    });

    it("uses specified account instead of default", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://ABC/ICNote/p201",
      });

      const result = manager.createNote("Draft", "Email content", [], undefined, "Gmail");

      expect(result?.account).toBe("Gmail");
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Gmail"'),
        NO_RETRY_OPTIONS
      );
    });

    it("creates note in specified folder", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://ABC/ICNote/p202",
      });

      manager.createNote("Work Note", "Content", [], "Work Projects");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain('whose name is "Work Projects"');
      expect(script).toContain("exists folder id __folder_cid");
      expect(script).toContain("make new note at __folder with properties");
      expect(script).not.toContain('at folder "Work Projects"');
      expect(mockExecuteAppleScript.mock.calls[0][1]).toEqual(NO_RETRY_OPTIONS);
    });

    it("stores tags in returned Note object", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://ABC/ICNote/p203",
      });

      const result = manager.createNote("Tagged Note", "Content", ["work", "urgent"]);

      expect(result?.tags).toEqual(["work", "urgent"]);
    });

    it("uses escapeHtmlForAppleScript when format is html", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p200",
      });

      const htmlContent = "<h2>Heading</h2><div>Body text</div>";
      const result = manager.createNote("HTML Note", htmlContent, [], undefined, undefined, "html");

      expect(result).not.toBeNull();
      // HTML tags should NOT be entity-encoded — they should pass through to AppleScript
      // escapeHtmlForAppleScript only escapes \ and ", not HTML tags
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("<h2>Heading</h2><div>Body text</div>"),
        NO_RETRY_OPTIONS
      );
    });

    it("uses escapeForAppleScript when format is plaintext (default)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p201",
      });

      const result = manager.createNote("Plain Note", "Simple text with\nnewline");

      expect(result).not.toBeNull();
      // Default plaintext: newlines become <br>
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("Simple text with<br>newline"),
        NO_RETRY_OPTIONS
      );
    });

    it("escapes double quotes in html format for AppleScript safety", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p202",
      });

      manager.createNote(
        "Quote Test",
        '<div class="test">Content</div>',
        [],
        undefined,
        undefined,
        "html"
      );

      // Double quotes must be escaped for AppleScript string embedding
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('<div class=\\"test\\">Content</div>'),
        NO_RETRY_OPTIONS
      );
    });

    it("sets title as h1 in body, not as name property", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p203",
      });

      manager.createNote("My Title", "Body content");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      // Title must appear as h1 in body
      expect(script).toContain("<h1>My Title</h1>");
      // name property must NOT be set (causes title duplication in Notes.app)
      expect(script).not.toContain('name:"My Title"');
    });

    it("HTML-encodes special chars in title for h1 tag", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p204",
      });

      manager.createNote("Q&A: <Hello> World", "Content");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("<h1>Q&amp;A: &lt;Hello&gt; World</h1>"),
        NO_RETRY_OPTIONS
      );
    });

    it("HTML-encodes special chars in plaintext content", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p205",
      });

      manager.createNote("Title", "Price: <10 & >5\nNext line");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain("Price: &lt;10 &amp; &gt;5<br>Next line");
    });

    it("prepends h1 title before html content", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p206",
      });

      manager.createNote(
        "Report",
        "<h2>Section</h2><div>Details</div>",
        [],
        undefined,
        undefined,
        "html"
      );

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain("<h1>Report</h1><h2>Section</h2><div>Details</div>");
    });

    it("encodes backslashes as HTML entities in plaintext content", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p207",
      });

      manager.createNote("Title", "path\\to\\file");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain("path&#92;to&#92;file");
    });

    it("converts tabs to br in plaintext content", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p208",
      });

      manager.createNote("Title", "col1\tcol2\tcol3");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain("col1<br>col2<br>col3");
    });
  });

  // ---------------------------------------------------------------------------
  // Note Search
  // ---------------------------------------------------------------------------

  describe("searchNotes", () => {
    it("returns array of matching notes with folder info", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Meeting Notes", "x-coredata://ABC/ICNote/p1", "Work"].join(F),
          ["Project Plan", "x-coredata://ABC/ICNote/p2", "Notes"].join(F),
          ["Weekly Review", "x-coredata://ABC/ICNote/p3", "Archive"].join(F),
        ].join(R),
      });

      const results = manager.searchNotes("notes");

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe("Meeting Notes");
      expect(results[0].id).toBe("x-coredata://ABC/ICNote/p1");
      expect(results[0].folder).toBe("Work");
      expect(results[1].title).toBe("Project Plan");
      expect(results[1].id).toBe("x-coredata://ABC/ICNote/p2");
      expect(results[1].folder).toBe("Notes");
      expect(results[2].title).toBe("Weekly Review");
      expect(results[2].id).toBe("x-coredata://ABC/ICNote/p3");
      expect(results[2].folder).toBe("Archive");
    });

    it("dereferences the note container before reading its folder name", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Meeting Notes", "x-coredata://ABC/ICNote/p1", "Work"].join(F),
      });

      manager.searchNotes("meeting");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain("set noteContainer to container of n");
      expect(script).toContain("set noteFolder to name of noteContainer");
      expect(script).not.toContain("set noteFolder to name of container of n");
    });

    it("returns actual creation and modification timestamps", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Meeting Notes",
          "x-coredata://ABC/ICNote/p1",
          "Work",
          "2024-2-3-10-11-12",
          "2025-6-7-13-14-15",
        ].join(F),
      });

      const [result] = manager.searchNotes("meeting");

      expect(result.created).toEqual(new Date(2024, 1, 3, 10, 11, 12));
      expect(result.modified).toEqual(new Date(2025, 5, 7, 13, 14, 15));
      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("set noteCreated to creation date of n");
      expect(script).toContain("set noteModified to modification date of n");
      expect(script).toContain("year of noteCreated");
      expect(script).toContain("year of noteModified");
    });

    it("returns empty array when no matches found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const results = manager.searchNotes("nonexistent");

      expect(results).toHaveLength(0);
    });

    it("throws on AppleScript error rather than returning empty (#19)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Search failed",
      });

      expect(() => manager.searchNotes("test")).toThrow(/Search failed/);
    });

    it("searches content when searchContent is true", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Note with keyword", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("project alpha", true);

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('body contains "project alpha"')
      );
    });

    it("searches titles when searchContent is false", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Project Alpha Notes", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("Project Alpha", false);

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('name contains "Project Alpha"')
      );
    });

    it("identifies notes in Recently Deleted folder", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Old Note", "x-coredata://ABC/ICNote/p1", "Recently Deleted"].join(F),
          ["Active Note", "x-coredata://ABC/ICNote/p2", "Notes"].join(F),
        ].join(R),
      });

      const results = manager.searchNotes("note");

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe("Old Note");
      expect(results[0].id).toBe("x-coredata://ABC/ICNote/p1");
      expect(results[0].folder).toBe("Recently Deleted");
      expect(results[1].title).toBe("Active Note");
      expect(results[1].id).toBe("x-coredata://ABC/ICNote/p2");
      expect(results[1].folder).toBe("Notes");
    });

    it("deduplicates duplicate note IDs returned by Notes.app", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Not uploaded", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
          ["Not uploaded", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
        ].join(R),
      });

      const results = manager.searchNotes("Not uploaded");

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Not uploaded");
      expect(results[0].id).toBe("x-coredata://ABC/ICNote/p1");
    });

    it("scopes search to specified account", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.searchNotes("work", false, "Exchange");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Exchange"')
      );
    });

    it("limits search to specified folder", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Work Note", "x-coredata://ABC/ICNote/p1", "Work"].join(F),
      });

      manager.searchNotes("note", false, undefined, "Work");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('notes of folder "Work"')
      );
    });

    it("combines folder and account filters", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.searchNotes("task", false, "Exchange", "Projects");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain('every account whose name is "Exchange"');
      expect(script).toContain('notes of folder "Projects"');
    });

    it("adds date filter when modifiedSince is provided", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Recent Note", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("note", false, undefined, undefined, "2025-06-15T00:00:00");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      // Locale-safe: uses variable setup instead of date "string"
      expect(script).toContain("set thresholdDate to current date");
      expect(script).toContain("set year of thresholdDate to 2025");
      expect(script).toContain("set month of thresholdDate to 6");
      expect(script).toContain("set day of thresholdDate to 15");
      expect(script).toContain("modification date >= thresholdDate");
      expect(script).toContain('name contains "note"');
    });

    it("combines date filter with content search", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Note", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("keyword", true, undefined, undefined, "2025-01-01");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain('body contains "keyword"');
      expect(script).toContain("set thresholdDate to current date");
      expect(script).toContain("modification date >= thresholdDate");
    });

    it("ignores invalid modifiedSince date", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Note", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("note", false, undefined, undefined, "not-a-date");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).not.toContain("modification date >= thresholdDate");
    });

    it("applies limit to search results", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Note 1", "x-coredata://ABC/ICNote/p1", "Notes"].join(F),
      });

      manager.searchNotes("note", false, undefined, undefined, undefined, 5);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("(count of resultList) >= 5");
      expect(script).toContain("exit repeat");
    });

    it("combines modifiedSince, limit, folder, and content search", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Note", "x-coredata://ABC/ICNote/p1", "Work"].join(F),
      });

      manager.searchNotes("project", true, "iCloud", "Work", "2025-03-01", 10);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain('body contains "project"');
      expect(script).toContain("set thresholdDate to current date");
      expect(script).toContain("modification date >= thresholdDate");
      expect(script).toContain('notes of folder "Work"');
      expect(script).toContain("(count of resultList) >= 10");
      expect(script).toContain('every account whose name is "iCloud"');
    });
  });

  // ---------------------------------------------------------------------------
  // Note Content Retrieval
  // ---------------------------------------------------------------------------

  describe("getNoteContent", () => {
    it("returns HTML content of note", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "<div>Shopping List</div><div>- Eggs<br>- Milk</div>",
      });

      const content = manager.getNoteContent("Shopping List");

      expect(content).toBe("<div>Shopping List</div><div>- Eggs<br>- Milk</div>");
    });

    it("returns empty string when note not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: 'Can\'t get note "Missing"',
      });

      const content = manager.getNoteContent("Missing Note");

      expect(content).toBe("");
    });

    it("looks up titles containing & literally, not HTML-escaped (regression)", () => {
      // Bug found in live testing: titles with "&" were HTML-escaped to "&amp;"
      // in the `note "..."` lookup, so the note could never be found.
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "<div>x</div>" });
      manager.getNoteContent("Tom & Jerry", "iCloud");
      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("Tom & Jerry");
      expect(script).not.toContain("Tom &amp; Jerry");
    });

    it("uses specified account", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "<div>Content</div>",
      });

      manager.getNoteContent("My Note", "Gmail");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Gmail"'),
        { maxBufferBytes: noteBodyMaxBuffer() }
      );
    });

    it("reads bodies with the note-body output cap, by title and by id (#237)", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "<div>x</div>" });
      manager.getNoteContent("Photo note", "iCloud");
      manager.getNoteContentById("x-coredata://ABC/ICNote/p1");
      const bodyReads = mockExecuteAppleScript.mock.calls.filter(([script]) =>
        String(script).includes("get body of note")
      );
      expect(bodyReads).toHaveLength(2);
      for (const [, options] of bodyReads) {
        expect(options).toEqual({ maxBufferBytes: noteBodyMaxBuffer() });
      }
    });
  });

  describe("getNotePlaintext", () => {
    it("reads the note's plaintext property by title", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Shopping List\n- Eggs\n- Milk",
      });

      const text = manager.getNotePlaintext("Shopping List");

      expect(text).toBe("Shopping List\n- Eggs\n- Milk");
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('get plaintext of note "Shopping List"')
      );
    });

    it("returns empty string when the note is not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: 'Can\'t get note "Missing"',
      });

      expect(manager.getNotePlaintext("Missing Note")).toBe("");
    });

    it("uses the specified account", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "Content" });

      manager.getNotePlaintext("My Note", "Gmail");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Gmail"')
      );
    });
  });

  describe("getNotePlaintextById", () => {
    it("reads the note's plaintext property by id at the application level", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "Just the text" });

      const text = manager.getNotePlaintextById("x-coredata://ABC/ICNote/p1");

      expect(text).toBe("Just the text");
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('get plaintext of note id "x-coredata://ABC/ICNote/p1"')
      );
    });

    it("returns empty string when Notes.app rejects the read", () => {
      mockExecuteAppleScript.mockReturnValue({ success: false, output: "", error: "no such note" });

      expect(manager.getNotePlaintextById("x-coredata://ABC/ICNote/p1")).toBe("");
    });

    it("rejects malformed IDs", () => {
      expect(() => manager.getNotePlaintextById("arbitrary string")).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Password Protection Helpers
  // ---------------------------------------------------------------------------

  describe("isNotePasswordProtected", () => {
    it("returns true when note is password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Locked Note",
          "x-coredata://ABC/ICNote/p1",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "false",
          "true",
        ].join(F),
      });

      const result = manager.isNotePasswordProtected("Locked Note");

      expect(result).toBe(true);
    });

    it("returns false when note is not password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Open Note",
          "x-coredata://ABC/ICNote/p2",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "false",
          "false",
        ].join(F),
      });

      const result = manager.isNotePasswordProtected("Open Note");

      expect(result).toBe(false);
    });

    it("returns false when note is not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Note not found",
      });

      const result = manager.isNotePasswordProtected("Missing Note");

      expect(result).toBe(false);
    });
  });

  describe("isNotePasswordProtectedById", () => {
    it("returns true when note is password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Locked Note",
          "x-coredata://ABC/ICNote/p1",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "false",
          "true",
        ].join(F),
      });

      const result = manager.isNotePasswordProtectedById("x-coredata://ABC/ICNote/p1");

      expect(result).toBe(true);
    });

    it("returns false when note is not password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Open Note",
          "x-coredata://ABC/ICNote/p2",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "Monday, January 1, 2024 at 12:00:00 PM",
          "false",
          "false",
        ].join(F),
      });

      const result = manager.isNotePasswordProtectedById("x-coredata://ABC/ICNote/p2");

      expect(result).toBe(false);
    });

    it("returns false when note is not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Note not found",
      });

      const result = manager.isNotePasswordProtectedById(
        "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p999"
      );

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Get Note By ID
  // ---------------------------------------------------------------------------

  describe("getNoteById", () => {
    it("returns Note object with metadata for valid ID", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "My Note",
          "x-coredata://ABC123/ICNote/p100",
          "Saturday, December 27, 2025 at 3:00:00 PM",
          "Saturday, December 27, 2025 at 4:00:00 PM",
          "false",
          "false",
        ].join(F),
      });

      const result = manager.getNoteById("x-coredata://ABC123/ICNote/p100");

      expect(result).not.toBeNull();
      expect(result?.title).toBe("My Note");
      expect(result?.id).toBe("x-coredata://ABC123/ICNote/p100");
      expect(result?.shared).toBe(false);
      expect(result?.passwordProtected).toBe(false);
    });

    it("returns null when note ID not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Can't get note id",
      });

      const result = manager.getNoteById(
        "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p999"
      );

      expect(result).toBeNull();
    });

    it("returns null when response format is unexpected (no commas)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "incomplete data with no commas",
      });

      const result = manager.getNoteById("x-coredata://ABC123/ICNote/p100");

      expect(result).toBeNull();
    });

    it("returns null when response format is missing second comma", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "title only, no more data",
      });

      const result = manager.getNoteById("x-coredata://ABC123/ICNote/p100");

      // The new parsing requires at least title and ID separated by commas
      expect(result).toBeNull();
    });

    it("correctly parses shared and passwordProtected as true", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Shared Note",
          "x-coredata://ABC/ICNote/p1",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "true",
          "true",
        ].join(F),
      });

      const result = manager.getNoteById("x-coredata://ABC/ICNote/p1");

      expect(result?.shared).toBe(true);
      expect(result?.passwordProtected).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Get Note Details
  // ---------------------------------------------------------------------------

  describe("getNoteDetails", () => {
    it("returns Note object with full metadata", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Project Notes",
          "x-coredata://ABC123/ICNote/p200",
          "Friday, December 20, 2025 at 10:00:00 AM",
          "Saturday, December 27, 2025 at 2:30:00 PM",
          "false",
          "false",
        ].join(F),
      });

      const result = manager.getNoteDetails("Project Notes");

      expect(result).not.toBeNull();
      expect(result?.title).toBe("Project Notes");
      expect(result?.id).toBe("x-coredata://ABC123/ICNote/p200");
    });

    it("returns null when note not found", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Can't get note",
      });

      const result = manager.getNoteDetails("Nonexistent");

      expect(result).toBeNull();
    });

    it("uses specified account", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Note",
          "id123",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "false",
          "false",
        ].join(F),
      });

      const result = manager.getNoteDetails("My Note", "Exchange");

      expect(result?.account).toBe("Exchange");
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Exchange"')
      );
    });

    it("handles shared notes correctly", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "Shared Doc",
          "id456",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "Monday, January 1, 2025 at 12:00:00 PM",
          "true",
          "false",
        ].join(F),
      });

      const result = manager.getNoteDetails("Shared Doc");

      expect(result?.shared).toBe(true);
    });
  });

  describe("updateNoteByIdIfUnchanged", () => {
    const id = "x-coredata://ABC00000-0000-0000-0000-000000000003/ICNote/p789";
    const oldBody = "<div>Title</div><div>Old body</div>";

    it("checks body identity and attachments in the same AppleScript before writing", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_UPDATED" });

      const result = manager.updateNoteByIdIfUnchanged(id, "Title", oldBody, undefined, "New body");

      expect(result.status).toBe("updated");
      expect(result.writtenBody).toBe("<div>Title</div><div>New body</div>");
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(script).toContain("count of attachments of noteRef");
      expect(script).toContain("currentBody is not");
      expect(script).toContain(
        'currentBody is not "<div>Title</div><div>Old body</div>" & linefeed'
      );
      expect(script.indexOf("count of attachments of noteRef")).toBeLessThan(
        script.indexOf("set body of noteRef")
      );
      expect(script.indexOf("currentBody is not")).toBeLessThan(
        script.indexOf("set body of noteRef")
      );
      // AppleScript's `is`/`is not` is case-insensitive by default, so a
      // case-only concurrent edit would otherwise slip past the conflict
      // guard. `considering case` must wrap the comparison (and the write,
      // so a false-equal never reaches `set body of noteRef`).
      expect(script.indexOf("considering case")).toBeLessThan(script.indexOf("currentBody is not"));
      expect(script.indexOf("set body of noteRef")).toBeLessThan(script.indexOf("end considering"));
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(expect.any(String), NO_RETRY_OPTIONS);
    });

    it("reports a conflict without claiming an update", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_CONFLICT" });

      const result = manager.updateNoteByIdIfUnchanged(
        id,
        "Title",
        oldBody,
        undefined,
        "Stale body"
      );

      expect(result).toEqual({ status: "conflict" });
    });

    it("reports attachments without claiming an update", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_ATTACHMENTS" });

      const result = manager.updateNoteByIdIfUnchanged(
        id,
        "Title",
        oldBody,
        undefined,
        "Replacement"
      );

      expect(result).toEqual({ status: "attachments" });
    });
  });

  describe("deleteNoteByIdIfUnchanged", () => {
    const id = "x-coredata://ABC00000-0000-0000-0000-000000000004/ICNote/p790";

    it("compares the exact body in the same AppleScript before deleting", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_DELETED" });

      const result = manager.deleteNoteByIdIfUnchanged(id, "<div>Reviewed body</div>");

      expect(result.status).toBe("deleted");
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(script).toContain("currentBody is not");
      expect(script.indexOf("currentBody is not")).toBeLessThan(script.indexOf("delete noteRef"));
      expect(script.indexOf("considering case")).toBeLessThan(script.indexOf("currentBody is not"));
      expect(script.indexOf("delete noteRef")).toBeLessThan(script.indexOf("end considering"));
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(expect.any(String), NO_RETRY_OPTIONS);
    });

    it("rejects deletion when the reviewed body is stale", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_CONFLICT" });

      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Old body</div>")).toEqual({
        status: "conflict",
      });
    });

    it("reports a delete that left the note in its original folder", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_NOT_DELETED" });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Reviewed body</div>")).toEqual({
        status: "not-deleted",
      });
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      // The folder is captured before the delete and re-read after it.
      expect(script.indexOf("container of noteRef")).toBeLessThan(script.indexOf("delete noteRef"));
      expect(script.indexOf("delete noteRef")).toBeLessThan(
        script.indexOf("id of notes of originalFolder")
      );
    });

    it("generates a delete script that AppleScript compiles", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
      manager.deleteNoteByIdIfUnchanged(id, '<div>Body with "quotes" and \\ slash</div>');
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      const dir = mkdtempSync(join(tmpdir(), "delete-script-"));
      try {
        writeFileSync(join(dir, "delete.applescript"), script);
        expect(() =>
          execFileSync(
            "/usr/bin/osacompile",
            ["-o", join(dir, "delete.scpt"), join(dir, "delete.applescript")],
            { stdio: "pipe" }
          )
        ).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Note Listing
  // ---------------------------------------------------------------------------

  describe("listNotes", () => {
    it("returns array of note titles", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Note A", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note B", "x-coredata://ABC/ICNote/p2"].join(F),
          ["Note C", "x-coredata://ABC/ICNote/p3"].join(F),
        ].join(R),
      });

      const titles = manager.listNotes();

      expect(titles).toEqual(["Note A", "Note B", "Note C"]);
    });

    it("filters out empty entries", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Note A", "x-coredata://ABC/ICNote/p1"].join(F),
          "",
          ["Note B", "x-coredata://ABC/ICNote/p2"].join(F),
          "",
          "",
        ].join(R),
      });

      const titles = manager.listNotes();

      expect(titles).toEqual(["Note A", "Note B"]);
    });

    it("deduplicates duplicate note IDs while preserving separate notes with the same title", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Same Title", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Same Title", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Same Title", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const titles = manager.listNotes();

      expect(titles).toEqual(["Same Title", "Same Title"]);
    });

    it("throws on failure rather than returning empty (#19)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Account not found",
      });

      expect(() => manager.listNotes()).toThrow(/Account not found/);
    });

    it("filters by folder when specified", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Work Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Work Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      manager.listNotes("iCloud", "Work");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('notes of folder "Work"')
      );
    });

    it("filters by bulk-fetched modification dates when modifiedSince is provided", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Recent Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Recent Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, "2025-06-15T00:00:00");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      // Locale-safe: variable setup + local comparison over bulk-fetched
      // dates (whose clauses evaluate per-note server-side and are slow)
      expect(script).toContain("set thresholdDate to current date");
      expect(script).toContain("set year of thresholdDate to 2025");
      expect(script).toContain("set month of thresholdDate to 6");
      expect(script).toContain("set day of thresholdDate to 15");
      expect(script).toContain("set noteDates to modification date of notes");
      expect(script).toContain("if (item i of noteDates) >= thresholdDate then");
      expect(results).toEqual(["Recent Note 1", "Recent Note 2"]);
    });

    it("slices the AppleScript fetch to the limit and returns a totalCount header", () => {
      // Sliced response: totalCount header record, then limit records.
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "10",
          ["Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
          ["Note 3", "x-coredata://ABC/ICNote/p3"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, undefined, 3);

      // One sliced call satisfies the limit — no full-fetch fallback.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("set totalCount to count of notes");
      expect(script).toContain("set fetchCount to 3");
      expect(script).toContain("set noteNames to name of (notes 1 thru fetchCount)");
      expect(script).toContain("set noteIds to id of (notes 1 thru fetchCount)");
      expect(results).toEqual(["Note 1", "Note 2", "Note 3"]);
    });

    it("returns short slice without fallback when the library is smaller than the limit", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["2", ["Note 1", "p1"].join(F), ["Note 2", "p2"].join(F)].join(R),
      });

      const results = manager.listNotes(undefined, undefined, undefined, 5);

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      expect(results).toEqual(["Note 1", "Note 2"]);
    });

    it("falls back to a full fetch when dedup leaves the slice short of the limit", () => {
      // Slice of 3 contains a duplicated id -> only 2 uniques, but 10 total
      // notes exist, so later uniques may have been hidden by the duplicate.
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output: [
            "10",
            ["Note 1", "p1"].join(F),
            ["Note 1 dup", "p1"].join(F),
            ["Note 2", "p2"].join(F),
          ].join(R),
        })
        .mockReturnValueOnce({
          success: true,
          output: [
            ["Note 1", "p1"].join(F),
            ["Note 2", "p2"].join(F),
            ["Note 3", "p3"].join(F),
            ["Note 4", "p4"].join(F),
          ].join(R),
        });

      const results = manager.listNotes(undefined, undefined, undefined, 3);

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2);
      // Fallback is the unsliced full fetch.
      const fallbackScript = mockExecuteAppleScript.mock.calls[1][0];
      expect(fallbackScript).not.toContain("thru fetchCount");
      expect(fallbackScript).toContain("set noteNames to name of notes");
      expect(results).toEqual(["Note 1", "Note 2", "Note 3"]);
    });

    it("falls back to a full fetch when the slice header is malformed", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          // No totalCount header — should not be trusted as a sliced response.
          output: [["Note 1", "p1"].join(F), ["Note 2", "p2"].join(F)].join(R),
        })
        .mockReturnValueOnce({
          success: true,
          output: [["Note 1", "p1"].join(F), ["Note 2", "p2"].join(F)].join(R),
        });

      const results = manager.listNotes(undefined, undefined, undefined, 5);

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2);
      expect(results).toEqual(["Note 1", "Note 2"]);
    });

    it("returns empty from an empty sliced library without fallback", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: `0${R}` });

      const results = manager.listNotes(undefined, undefined, undefined, 3);

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);
    });

    it("guards every bulk list against mid-listing library mutation", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      // Unfiltered full fetch: names/ids count guard.
      manager.listNotes();
      const fullScript = mockExecuteAppleScript.mock.calls[0][0];
      expect(fullScript).toContain(
        'if (count of noteIds) is not (count of noteNames) then error "Notes changed during listing"'
      );

      // Date-filtered fetch adds the dates count guard.
      manager.listNotes(undefined, undefined, "2025-06-15T00:00:00");
      const dateScript = mockExecuteAppleScript.mock.calls[1][0];
      expect(dateScript).toContain(
        'if (count of noteDates) is not (count of noteNames) then error "Notes changed during listing"'
      );

      // Sliced fetch guards and remaps a shrink between count and fetch —
      // but ONLY the out-of-range error numbers. Timeouts (-1712), lost
      // connection, and permission errors must be rethrown unchanged so
      // their honest messages and remedies survive.
      manager.listNotes(undefined, undefined, undefined, 3);
      const sliceScript = mockExecuteAppleScript.mock.calls[2][0];
      expect(sliceScript).toContain(
        'if (count of noteIds) is not (count of noteNames) then error "Notes changed during listing"'
      );
      expect(sliceScript).toContain("on error errMsg number errNum");
      expect(sliceScript).toContain("if errNum is -1719 or errNum is -1728 then");
      expect(sliceScript).toContain('error "Notes changed during listing"');
      expect(sliceScript).toContain("error errMsg number errNum");
    });

    it("combines folder, modifiedSince, and limit", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Work Note", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Another Work Note", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      manager.listNotes("iCloud", "Work", "2025-01-01", 10);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain('notes of folder "Work"');
      expect(script).toContain('set noteDates to modification date of notes of folder "Work"');
      expect(script).toContain('set noteNames to name of notes of folder "Work"');
    });

    it("returns empty array when modifiedSince yields no results", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const results = manager.listNotes(undefined, undefined, "2099-01-01");

      expect(results).toEqual([]);
    });

    it("ignores invalid modifiedSince date and falls back to limit-only", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          "2",
          ["Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, "not-a-date", 5);

      // Invalid date means no date filter, so the limit-only slice path runs.
      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).not.toContain("thresholdDate");
      expect(script).toContain("set noteNames to name of (notes 1 thru fetchCount)");
      expect(results).toEqual(["Note 1", "Note 2"]);
    });
  });

  describe("large-library listing (#162)", () => {
    // `ASCII character` is a Standard Additions command: inside a Notes tell
    // block each evaluation is its own Apple Event (~8.5 ms measured), so a
    // per-record separator cost two round trips per note.
    it("builds every per-note record with local separators, never an Apple Event per record", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.listNotes();
      manager.listNotes(undefined, undefined, "2025-06-15T00:00:00");
      manager.listNotes(undefined, undefined, undefined, 3);

      expect(mockExecuteAppleScript.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const [script] of mockExecuteAppleScript.mock.calls) {
        expect(script).not.toContain("ASCII character");
        expect(script).toContain("(character id 31)");
        expect(script).toContain("(character id 30)");
      }
    });

    it("reads the whole collection, not a range, when the limit covers the library", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["2", ["Note 1", "p1"].join(F), ["Note 2", "p2"].join(F)].join(R),
      });

      const results = manager.listNotes("iCloud", undefined, undefined, 700);

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toMatch(
        /if fetchCount is totalCount then\s+set noteNames to name of notes\s+set noteIds to id of notes\s+else\s+set noteNames to name of \(notes 1 thru fetchCount\)/
      );
      expect(results).toEqual(["Note 1", "Note 2"]);
    });
  });

  describe("separators in every generated script (#162)", () => {
    // Every script below runs inside a `tell application "Notes"` block, where
    // each `ASCII character` evaluation is dispatched to Notes.app as its own
    // Apple Event. Search, folder, account and stats scripts build one record
    // per item, so the separators must be `character id`, evaluated locally.
    const NOTE_ID = "x-coredata://ABC00000-0000-0000-0000-000000000011/ICNote/p1";
    const FOLDER_ID = "x-coredata://ABC00000-0000-0000-0000-000000000011/ICFolder/p2";

    const scriptsFor = (call: () => unknown): string[] => {
      mockExecuteAppleScript.mockReset();
      mockExecuteAppleScript.mockImplementation((script: string) => ({
        success: true,
        // listAccounts feeds the per-account stats and shared-notes scripts.
        output: script.includes("repeat with a in accounts") ? "iCloud" : "",
      }));
      try {
        call();
      } catch {
        // Empty output makes some parsers throw; only the scripts matter here.
      }
      return mockExecuteAppleScript.mock.calls.map(([script]) => String(script));
    };

    it.each<[string, () => unknown, string[]]>([
      ["searchNotes (title)", () => manager.searchNotes("the"), ["31", "30"]],
      ["searchNotes (content)", () => manager.searchNotes("the", true), ["31", "30"]],
      ["listFolders", () => manager.listFolders(), ["31", "30"]],
      ["listAccounts", () => manager.listAccounts(), ["31", "30"]],
      ["getNotesStats", () => manager.getNotesStats(), ["31", "30"]],
      ["getSelectedNotes", () => manager.getSelectedNotes(), ["31", "30"]],
      ["getDefaultLocation", () => manager.getDefaultLocation(), ["31"]],
      ["getNoteById", () => manager.getNoteById(NOTE_ID), ["31"]],
      ["getNoteDetails", () => manager.getNoteDetails("Groceries"), ["31"]],
      ["getFolderById", () => manager.getFolderById(FOLDER_ID), ["31"]],
      ["createFolder", () => manager.createFolder("Archive"), ["31"]],
      ["listAttachmentsById", () => manager.listAttachmentsById(NOTE_ID), ["31", "30"]],
      ["listAttachments", () => manager.listAttachments("Groceries"), ["31", "30"]],
      ["showAttachmentById", () => manager.showAttachmentById(NOTE_ID, "att-1"), ["31"]],
      [
        "saveAttachmentById",
        () => manager.saveAttachmentById(NOTE_ID, "att-1", join(tmpdir(), "x.png")),
        ["31"],
      ],
      ["batchMoveNotes", () => manager.batchMoveNotes([NOTE_ID], "Archive"), ["30"]],
      ["listNotes", () => manager.listNotes(), ["31", "30"]],
      ["listSharedNotes", () => manager.listSharedNotes(), ["31", "30"]],
    ])("%s never emits ASCII character", (_name, call, codes) => {
      const scripts = scriptsFor(call);
      const all = scripts.join("\n");

      expect(scripts.length).toBeGreaterThan(0);
      expect(all).not.toContain("ASCII character");
      for (const code of codes) {
        expect(all).toContain(`(character id ${code})`);
      }
    });
  });

  describe("listSharedNotes", () => {
    it("reads sharing state in one bulk read and stops there when nothing is shared", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" }) // listAccounts
        .mockReturnValueOnce({ success: true, output: "" });

      expect(manager.listSharedNotes()).toEqual([]);

      const script = mockExecuteAppleScript.mock.calls[1][0];
      expect(script).toContain("set noteShared to shared of notes");
      expect(script).toContain("if noteShared contains true then");
      expect(script).not.toContain("repeat with n in notes");
      expect(script).not.toContain("ASCII character");
    });

    it("parses shared notes built from bulk-read properties", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({
          success: true,
          output: [
            "Team plan",
            "x-coredata://ABC/ICNote/p7",
            "2025-1-2-3-4-5",
            "2025-6-7-8-9-10",
            "true",
            "false",
          ].join(F),
        });

      const notes = manager.listSharedNotes();

      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id: "x-coredata://ABC/ICNote/p7",
        title: "Team plan",
        account: "iCloud",
        shared: true,
        passwordProtected: false,
      });
      expect(notes[0].modified.getMonth()).toBe(5);
      const script = mockExecuteAppleScript.mock.calls[1][0];
      expect(script).toContain(
        'if (count of noteIds) is not (count of noteShared) then error "Notes changed during listing"'
      );
    });

    it("reports a note Notes enumerates twice only once, in first-seen order (#183)", () => {
      const row = (title: string, id: string) =>
        [title, id, "2025-1-2-3-4-5", "2025-6-7-8-9-10", "true", "false"].join(F);
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({
          success: true,
          output: [
            row("Team plan", "x-coredata://ABC/ICNote/p7"),
            row("Budget", "x-coredata://ABC/ICNote/p8"),
            row("Team plan", "x-coredata://ABC/ICNote/p7"),
          ].join(R),
        });

      expect(manager.listSharedNotes().map((note) => note.id)).toEqual([
        "x-coredata://ABC/ICNote/p7",
        "x-coredata://ABC/ICNote/p8",
      ]);
    });
  });

  describe("deleteNoteByIdIfUnchanged guard notes (copy-then-retire)", () => {
    const id = "x-coredata://ABC/ICNote/p1";
    const copy = "x-coredata://ABC/ICNote/p2";
    const other = "x-coredata://ABC/ICNote/p3";
    const guards = [{ id: copy, expectedBody: '<div>Copy with "quotes"</div>' }, { id: other }];

    it("checks every guard live, after the source trash check and before the delete", () => {
      mockReadTrashFolderIds.mockReturnValue([TRASH_FOLDER]);
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", undefined, guards)).toEqual({
        status: "deleted",
      });
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      const sourceTrash = script.indexOf('return "SAFETY_IN_RECENTLY_DELETED"');
      const guardStart = script.indexOf(`exists note id "${copy}"`);
      expect(guardStart).toBeGreaterThan(sourceTrash);
      for (const needle of [
        'return "SAFETY_GUARD_INACTIVE:0:missing"',
        "if password protected of __guardRef0",
        'return "SAFETY_GUARD_INACTIVE:0:locked"',
        'return "SAFETY_GUARD_INACTIVE:0:folder unknown"',
        "if (class of __guardFolder0) is folder then set __guardInTrash to false",
        `{"${TRASH_FOLDER}"} contains (id of __guardFolder0)`,
        '(name of __guardFolder0) is "Recently Deleted"',
        'return "SAFETY_GUARD_INACTIVE:0:in Recently Deleted"',
        'return "SAFETY_GUARD_CONFLICT:0"',
        `exists note id "${other}"`,
        'return "SAFETY_GUARD_INACTIVE:1:in Recently Deleted"',
      ]) {
        const at = script.indexOf(needle);
        expect(at, needle).toBeGreaterThan(sourceTrash);
        expect(at, needle).toBeLessThan(script.indexOf("delete noteRef"));
      }
      // Only the fingerprinted guard compares its body.
      expect(script).not.toContain("SAFETY_GUARD_CONFLICT:1");
      expect(script).toContain('__guardBody is not "<div>Copy with \\"quotes\\"</div>"');
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("maps guard outcomes to their index", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "SAFETY_GUARD_CONFLICT:0",
      });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", undefined, guards)).toEqual({
        status: "guard-conflict",
        index: 0,
      });
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "SAFETY_GUARD_INACTIVE:1:in Recently Deleted",
      });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", undefined, guards)).toEqual({
        status: "guard-inactive",
        index: 1,
        reason: "in Recently Deleted",
      });
    });

    it("treats a guard outcome for an unknown index as failed", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "SAFETY_GUARD_INACTIVE:5:missing",
      });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>")).toEqual({
        status: "failed",
      });
    });

    it("rejects an invalid guard id before running anything", () => {
      expect(() =>
        manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>", undefined, [
          { id: 'x" & do shell script "id' },
        ])
      ).toThrow();
      expect(mockExecuteAppleScript).not.toHaveBeenCalled();
    });
  });

  // A note's body carries its inline images as base64, so one large image makes
  // a body far longer than a script literal should be (#237).
  describe("deleteNoteByIdIfUnchanged with a body too long for a literal (#237)", () => {
    const id = "x-coredata://ABC/ICNote/p1";
    const copy = "x-coredata://ABC/ICNote/p2";
    const largeBody = (marker: string) =>
      `<div>${marker} "quoted" \\ slash é 😀</div><img src="data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}">`;
    const filePaths = (script: string) =>
      [...script.matchAll(/POSIX file "([^"]+)"/g)].map((match) => match[1]);

    it("compares the whole body against a private temporary file, then removes it", () => {
      const body = largeBody("Photo");
      let seen: { script: string; contents: string[]; modes: number[] } | undefined;
      mockExecuteAppleScript.mockImplementation((script: string) => {
        const paths = filePaths(script);
        seen = {
          script,
          contents: paths.map((path) => readFileSync(path, "utf8")),
          modes: paths.map((path) => statSync(path).mode & 0o777),
        };
        return { success: true, output: "SAFETY_DELETED" };
      });

      expect(manager.deleteNoteByIdIfUnchanged(id, body)).toEqual({ status: "deleted" });

      expect(seen!.contents).toEqual([body]);
      expect(seen!.modes).toEqual([0o600]);
      // The script stays small: the body is read from the file, not embedded.
      expect(seen!.script.length).toBeLessThan(10_000);
      expect(seen!.script).toContain(
        'if currentBody is not __expectedBody and currentBody is not __expectedBody & linefeed then return "SAFETY_CONFLICT"'
      );
      expect(seen!.script.indexOf("set __expectedBody to read")).toBeLessThan(
        seen!.script.indexOf("set currentBody to body of noteRef")
      );
      expect(existsSync(filePaths(seen!.script)[0])).toBe(false);
    });

    it("reads a large guard body from its own file", () => {
      const body = largeBody("Original");
      const guardBody = largeBody("Copy");
      let contents: string[] = [];
      let script = "";
      mockExecuteAppleScript.mockImplementation((text: string) => {
        script = text;
        contents = filePaths(text).map((path) => readFileSync(path, "utf8"));
        return { success: true, output: "SAFETY_GUARD_CONFLICT:0" };
      });

      expect(
        manager.deleteNoteByIdIfUnchanged(id, body, undefined, [
          { id: copy, expectedBody: guardBody },
        ])
      ).toEqual({ status: "guard-conflict", index: 0 });

      expect(contents).toEqual([guardBody, body]);
      expect(script).toContain(
        'if __guardBody is not __expectedGuardBody0 and __guardBody is not __expectedGuardBody0 & linefeed then return "SAFETY_GUARD_CONFLICT:0"'
      );
      for (const path of filePaths(script)) expect(existsSync(path)).toBe(false);
    });

    it("removes the temporary file when the script run throws", () => {
      let paths: string[] = [];
      mockExecuteAppleScript.mockImplementation((script: string) => {
        paths = filePaths(script);
        throw new Error("osascript failed");
      });

      expect(() => manager.deleteNoteByIdIfUnchanged(id, largeBody("Photo"))).toThrow(
        "osascript failed"
      );
      expect(paths).toHaveLength(1);
      expect(existsSync(paths[0])).toBe(false);
    });

    it("generates a file-backed delete script that AppleScript compiles", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
      manager.deleteNoteByIdIfUnchanged(id, largeBody("Photo"), undefined, [
        { id: copy, expectedBody: largeBody("Copy") },
      ]);
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      const dir = mkdtempSync(join(tmpdir(), "delete-script-"));
      try {
        writeFileSync(join(dir, "delete.applescript"), script);
        expect(() =>
          execFileSync(
            "/usr/bin/osacompile",
            ["-o", join(dir, "delete.scpt"), join(dir, "delete.applescript")],
            { stdio: "pipe" }
          )
        ).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("ExpectedBodies", () => {
    it("embeds a short body as an escaped literal and writes no file", () => {
      const bodies = new ExpectedBodies();
      expect(bodies.bind('<div>Say "hi" \\ there</div>', "__x")).toEqual({
        setup: "",
        operand: '"<div>Say \\"hi\\" \\\\ there</div>"',
      });
      bodies.cleanup();
      bodies.cleanup();
    });

    it("reads a long body back through real osascript byte for byte", () => {
      const body = `<div>Line one "q" \\ é 😀\ttab</div>\n<div>${"B".repeat(5 * 1024 * 1024)}</div>`;
      const bodies = new ExpectedBodies();
      try {
        const { setup, operand } = bodies.bind(body, "__roundTrip");
        expect(operand).toBe("__roundTrip");
        // Inside a Notes tell block, as in the delete script, but without
        // sending Notes anything: the read runs in osascript itself.
        const output = execFileSync("osascript", ["-"], {
          input: `${setup}\nreturn __roundTrip`,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(output).toBe(`${body}\n`);
      } finally {
        bodies.cleanup();
      }
    });
  });

  describe("Recently Deleted (#198, #207)", () => {
    const id = "x-coredata://ABC/ICNote/p1";

    it("delete refuses a note whose folder is Recently Deleted, before deleting", () => {
      mockReadTrashFolderIds.mockReturnValue([TRASH_FOLDER, "not-a-folder-id"]);
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "SAFETY_IN_RECENTLY_DELETED",
      });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>")).toEqual({
        status: "in-recently-deleted",
      });
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      // Checked live against Notes.app's container, by database id and by name.
      expect(script).toContain(`{"${TRASH_FOLDER}"} contains (id of originalFolder)`);
      expect(script).not.toContain("not-a-folder-id");
      expect(script).toContain('(name of originalFolder) is "Recently Deleted"');
      expect(script.indexOf("SAFETY_IN_RECENTLY_DELETED")).toBeLessThan(
        script.indexOf("delete noteRef")
      );
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("delete refuses a note whose container is not a folder, failing closed (#214)", () => {
      mockReadTrashFolderIds.mockReturnValue([TRASH_FOLDER]);
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "SAFETY_IN_RECENTLY_DELETED",
      });
      // Shared by delete-note and batch-delete-notes.
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>")).toEqual({
        status: "in-recently-deleted",
      });
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      // In-trash is the default; only a readable folder class clears it, so a
      // non-folder container or an unreadable class both refuse.
      const defaultTrue = script.indexOf("set __inTrash to true");
      const classCheck = script.indexOf(
        "if (class of originalFolder) is folder then set __inTrash to false"
      );
      expect(defaultTrue).toBeGreaterThan(-1);
      expect(classCheck).toBeGreaterThan(defaultTrue);
      // The id and name checks can only set it true afterwards, never clear it.
      expect(script.indexOf("contains (id of originalFolder)")).toBeGreaterThan(classCheck);
      expect(script.slice(script.indexOf("\n", classCheck))).not.toMatch(/set __inTrash to false/);
      expect(classCheck).toBeLessThan(script.indexOf('return "SAFETY_IN_RECENTLY_DELETED"'));
      expect(script.indexOf('return "SAFETY_IN_RECENTLY_DELETED"')).toBeLessThan(
        script.indexOf("delete noteRef")
      );
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("delete refuses a note whose container cannot be read, failing closed", () => {
      mockReadTrashFolderIds.mockReturnValue([TRASH_FOLDER]);
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "SAFETY_CONTAINER_UNKNOWN",
      });
      // Shared by delete-note and batch-delete-notes.
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>")).toEqual({
        status: "container-unknown",
      });
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      const refusal = script.indexOf(
        'if originalFolder is missing value then return "SAFETY_CONTAINER_UNKNOWN"'
      );
      expect(refusal).toBeGreaterThan(script.indexOf("set originalFolder to container of noteRef"));
      expect(refusal).toBeLessThan(script.indexOf("set __inTrash to true"));
      expect(refusal).toBeLessThan(script.indexOf("delete noteRef"));
      // No path reaches the delete with an unread container any more.
      expect(script).not.toContain("originalFolder is not missing value");
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("delete still checks the folder name without database access", () => {
      mockReadTrashFolderIds.mockReturnValue([]);
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "SAFETY_DELETED" });
      expect(manager.deleteNoteByIdIfUnchanged(id, "<div>Body</div>").status).toBe("deleted");
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(script).toContain("{} contains (id of originalFolder)");
      expect(script).toContain('(name of originalFolder) is "Recently Deleted"');
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("list excludes notes Notes.app reports in Recently Deleted", () => {
      mockReadTrashFolderIds.mockReturnValue([TRASH_FOLDER]);
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          [["Live", id].join(F), ["Gone", "x-coredata://ABC/ICNote/p2"].join(F)].join(R) +
          G +
          ["x-coredata://ABC/ICNote/p2", "x-coredata://ABC/ICNote/p3"].join(R),
      });
      expect(manager.listNoteRefsDetailed()).toEqual({
        refs: [{ title: "Live", id }],
        excludedRecentlyDeleted: 1,
      });
      expect(manager.listNoteRefs()).toEqual([{ title: "Live", id }]);
      expect(manager.listNotes()).toEqual(["Live"]);
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(script).toContain(`repeat with __trashFolderId in {"${TRASH_FOLDER}"}`);
      expect(script).toContain('every folder whose name is "Recently Deleted"');
      expect(script).toContain("(character id 29) & (__trashNoteIds as text)");
      expect(() => compilesAsAppleScript(script)).not.toThrow();
    });

    it("list includes and flags Recently Deleted notes on request", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          [["Live", id].join(F), ["Gone", "x-coredata://ABC/ICNote/p2"].join(F)].join(R) +
          G +
          "x-coredata://ABC/ICNote/p2",
      });
      expect(
        manager.listNoteRefsDetailed(undefined, undefined, undefined, undefined, true)
      ).toEqual({
        refs: [
          { title: "Live", id },
          { title: "Gone", id: "x-coredata://ABC/ICNote/p2", inRecentlyDeleted: true },
        ],
        excludedRecentlyDeleted: 0,
      });
    });

    it("an empty trash list excludes nothing", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["Live", id].join(F) + G,
      });
      expect(manager.listNoteRefsDetailed()).toEqual({
        refs: [{ title: "Live", id }],
        excludedRecentlyDeleted: 0,
      });
    });

    it("a bounded slice thinned by exclusion falls back to the full listing", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output:
            "3" +
            R +
            [["Gone", "x-coredata://ABC/ICNote/p2"].join(F), ["Live", id].join(F)].join(R) +
            G +
            "x-coredata://ABC/ICNote/p2",
        })
        .mockReturnValueOnce({
          success: true,
          output:
            [
              ["Gone", "x-coredata://ABC/ICNote/p2"].join(F),
              ["Live", id].join(F),
              ["Also", "x-coredata://ABC/ICNote/p3"].join(F),
            ].join(R) +
            G +
            "x-coredata://ABC/ICNote/p2",
        });
      expect(manager.listNoteRefsDetailed(undefined, undefined, undefined, 2)).toEqual({
        refs: [
          { title: "Live", id },
          { title: "Also", id: "x-coredata://ABC/ICNote/p3" },
        ],
        excludedRecentlyDeleted: 1,
      });
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2);
      const sliceScript = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(sliceScript).toContain("(character id 29) & (__trashNoteIds as text)");
      expect(() => compilesAsAppleScript(sliceScript)).not.toThrow();
    });

    it("a bounded slice that stays full after exclusion is returned as is", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "5" + R + ["Live", id].join(F) + G,
      });
      expect(manager.listNoteRefsDetailed(undefined, undefined, undefined, 1)).toEqual({
        refs: [{ title: "Live", id }],
        excludedRecentlyDeleted: 0,
      });
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
    });

    it("smart folder listings carry no trash check", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "0" + R });
      manager.listSmartFolderNoteRefs("x-coredata://ABC/ICFolder/p4", 5);
      const script = String(mockExecuteAppleScript.mock.calls[0]?.[0]);
      expect(script).not.toContain("__trashNoteIds");
    });
  });

  describe("listNoteRefs", () => {
    it("returns title/id pairs, not just titles", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Note A", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note B", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const refs = manager.listNoteRefs();

      expect(refs).toEqual([
        { title: "Note A", id: "x-coredata://ABC/ICNote/p1" },
        { title: "Note B", id: "x-coredata://ABC/ICNote/p2" },
      ]);
    });

    it("keeps two distinct notes with the same title distinguishable by id", () => {
      // This is the exact shape of bug #115 (see exportNotesAsJson's fix):
      // listNotes() alone collapses these to two identical-looking "Same
      // Title" strings, which a caller can't use to fetch the second note
      // without AppleScript's ambiguous by-name resolution returning the
      // first one twice. listNoteRefs() must expose the distinguishing id.
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Same Title", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Same Title", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const refs = manager.listNoteRefs();

      expect(refs).toEqual([
        { title: "Same Title", id: "x-coredata://ABC/ICNote/p1" },
        { title: "Same Title", id: "x-coredata://ABC/ICNote/p2" },
      ]);
      expect(refs[0].id).not.toEqual(refs[1].id);
    });

    it("supports the same folder/modifiedSince/limit filtering as listNotes", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [["Note 1", "x-coredata://ABC/ICNote/p1"].join(F)].join(R),
      });

      manager.listNoteRefs("iCloud", "Work", "2025-01-01", 10);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("Work");
      expect(script).toContain("thresholdDate");
    });

    it("throws on failure rather than returning empty", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Account not found",
      });

      expect(() => manager.listNoteRefs()).toThrow(/Account not found/);
    });
  });

  // ---------------------------------------------------------------------------
  // Folder Operations
  // ---------------------------------------------------------------------------

  describe("listFolders", () => {
    it("returns array of Folder objects with paths", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["id1", "Notes", "", "false"].join(F),
          ["id2", "Archive", "", "false"].join(F),
          ["id3", "Work", "", "true"].join(F),
        ].join(R),
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(3);
      expect(folders[0].name).toBe("Notes");
      expect(folders[1].name).toBe("Archive");
      expect(folders[2].name).toBe("Work");
      expect(folders[0].id).toBe("id1");
      expect(folders[2].shared).toBe(true);
    });

    it("includes parent folder in path", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["id1", "Dev", "", "false"].join(F),
          ["id2", "Accessibility", "id1", "false"].join(F),
          ["id3", "Work", "", "false"].join(F),
          ["id4", "Clients", "id3", "false"].join(F),
        ].join(R),
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(4);
      expect(folders[0].name).toBe("Dev");
      expect(folders[1].name).toBe("Dev/Accessibility");
      expect(folders[2].name).toBe("Work");
      expect(folders[3].name).toBe("Work/Clients");
    });

    it("disambiguates duplicate folder names using IDs", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["id1", "Finance", "", "false"].join(F),
          ["id2", "Archive", "id1", "false"].join(F),
          ["id3", "Travel", "", "false"].join(F),
          ["id4", "Trips", "id3", "false"].join(F),
          ["id5", "Archive", "id4", "false"].join(F),
        ].join(R),
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(5);
      expect(folders[1].name).toBe("Finance/Archive");
      expect(folders[4].name).toBe("Travel/Trips/Archive");
    });

    it("escapes slashes in folder names", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["id1", "Travel", "", "false"].join(F),
          ["id2", "Spain/Portugal 2023", "id1", "false"].join(F),
        ].join(R),
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(2);
      expect(folders[0].name).toBe("Travel");
      expect(folders[1].name).toBe("Travel/Spain\\/Portugal 2023");
    });

    it("parses legacy tab/newline output (backward compat)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "id1\tNotes\nid2\tArchive\tid1",
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(2);
      expect(folders[0].name).toBe("Notes");
      expect(folders[1].name).toBe("Notes/Archive");
      expect(folders[1].shared).toBe(false);
    });

    it("includes account in Folder objects", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["id1", "Notes", "", "false"].join(F),
      });

      const folders = manager.listFolders("Gmail");

      expect(folders[0].account).toBe("Gmail");
    });
  });

  describe("createFolder", () => {
    it("returns Folder object on success", () => {
      mockExecuteAppleScript
        // Check existence — folder doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create the folder
        .mockReturnValueOnce({
          success: true,
          output: "folder id x-coredata://ABC123/ICFolder/p456",
        })
        // Get ID of created folder
        .mockReturnValueOnce({
          success: true,
          output: "folder id x-coredata://ABC123/ICFolder/p456",
        });

      const result = manager.createFolder("New Project");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("New Project");
      expect(result?.id).toBe("x-coredata://ABC123/ICFolder/p456");
    });

    it("returns existing folder without creating duplicate", () => {
      mockExecuteAppleScript
        // Check existence — folder already exists
        .mockReturnValueOnce({
          success: true,
          output: "x-coredata://ABC123/ICFolder/p789",
        })
        // Get ID of existing folder
        .mockReturnValueOnce({
          success: true,
          output: "folder id x-coredata://ABC123/ICFolder/p789",
        });

      const result = manager.createFolder("Existing Folder");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("Existing Folder");
      expect(result?.id).toBe("x-coredata://ABC123/ICFolder/p789");
      // Should only have 2 calls (check + get ID), no create call
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2);
    });

    it("returns null on genuine failure", () => {
      mockExecuteAppleScript
        // Check existence — doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create fails
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "Permission denied",
        });

      const result = manager.createFolder("Restricted Folder");

      expect(result).toBeNull();
    });

    it("creates nested folder path", () => {
      mockExecuteAppleScript
        // Check "Retro Tech" — doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create "Retro Tech"
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p1" })
        // Check "Retro Tech/PC" — doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create "PC" inside "Retro Tech"
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p2" })
        // Check "Retro Tech/PC/CPUs" — doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create "CPUs" inside "Retro Tech/PC"
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p3" })
        // Get ID of final folder
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p3" });

      const result = manager.createFolder("Retro Tech/PC/CPUs");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("Retro Tech/PC/CPUs");
      expect(result?.id).toBe("x-coredata://A/ICFolder/p3");

      // Verify the create commands (calls at index 1, 3, 5)
      const calls = mockExecuteAppleScript.mock.calls;
      expect(calls[1][0]).toContain('make new folder with properties {name:"Retro Tech"}');
      expect(calls[3][0]).toContain('whose name is "Retro Tech"');
      expect(calls[3][0]).toContain('make new folder at __parent with properties {name:"PC"}');
      expect(calls[5][0]).toContain('whose name is "Retro Tech"');
      expect(calls[5][0]).toContain('whose name is "PC"');
      expect(calls[5][0]).toContain('make new folder at __parent with properties {name:"CPUs"}');
    });

    // #213: a folder deleted earlier in the Notes session still answers a
    // name reference, so existence must be decided by id.
    it("checks existence by id, not by a name reference", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: false, output: "", error: "Folder not found: Gone" })
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p9" })
        .mockReturnValueOnce({ success: true, output: "x-coredata://A/ICFolder/p9" });

      const result = manager.createFolder("Gone");

      const check = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(check).toContain('whose name is "Gone"');
      expect(check).toContain("if exists folder id __folder_cid then");
      expect(check).toContain("return id of __folder");
      expect(check).not.toMatch(/return id of folder "/);
      // rootOnly: a same-named nested folder is not a fallback for "Gone"
      expect(check).not.toContain("set __folder to __folder_any");
      expect(mockExecuteAppleScript.mock.calls[1][0]).toContain(
        'make new folder with properties {name:"Gone"}'
      );
      expect(result?.id).toBe("x-coredata://A/ICFolder/p9");
    });

    it("reports failure when the created folder cannot be confirmed by id", () => {
      mockExecuteAppleScript
        // Check — not found
        .mockReturnValueOnce({ success: false, output: "", error: "Folder not found: Gone" })
        // Create reports success but did nothing
        .mockReturnValueOnce({ success: true, output: "" })
        // Post-check — still no live folder
        .mockReturnValueOnce({ success: false, output: "", error: "Folder not found: Gone" });

      const result = manager.createFolder("Gone");

      expect(result).toBeNull();
      expect(mockExecuteAppleScript.mock.calls[2][0]).toContain("exists folder id __folder_cid");
    });

    it("reports failure when the post-check returns no folder id", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "x-coredata://A/ICFolder/p1" })
        .mockReturnValueOnce({ success: true, output: "" });

      expect(manager.createFolder("Existing")).toBeNull();
    });

    it("skips existing intermediate folders in nested path", () => {
      mockExecuteAppleScript
        // Check "Retro Tech" — exists
        .mockReturnValueOnce({ success: true, output: "x-coredata://A/ICFolder/p1" })
        // Check "Retro Tech/PC" — doesn't exist
        .mockReturnValueOnce({ success: false, output: "", error: "Can't get folder" })
        // Create "PC" inside "Retro Tech"
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p2" })
        // Get ID of final folder
        .mockReturnValueOnce({ success: true, output: "folder id x-coredata://A/ICFolder/p2" });

      const result = manager.createFolder("Retro Tech/PC");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("Retro Tech/PC");
      // No create call for "Retro Tech" — only for "PC"
      const createCalls = mockExecuteAppleScript.mock.calls.filter((c) =>
        c[0].includes("make new folder")
      );
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0][0]).toContain('name:"PC"');
    });
  });

  describe("deleteFolder", () => {
    it("returns true on successful deletion", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const result = manager.deleteFolder("Empty Folder");

      expect(result).toBe(true);
    });

    it("returns false when deletion fails", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Folder contains notes",
      });

      const result = manager.deleteFolder("Non-Empty Folder");

      expect(result).toBe(false);
    });

    it("deletes the live folder resolved by id, not a name reference (#213)", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.deleteFolder("Work/Old");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain('whose name is "Work"');
      expect(script).toContain('whose name is "Old"');
      expect(script).toContain("delete __folder");
      expect(script).not.toContain('delete folder "Old"');
    });

    it("returns false when the folder was already deleted this session (#213)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Folder not found: Doomed",
      });

      expect(manager.deleteFolder("Doomed")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Note Moving
  // ---------------------------------------------------------------------------

  describe("moveNoteById", () => {
    it("returns true when the native move succeeds", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "SAFETY_MOVED" });

      const result = manager.moveNoteById("x-coredata://ABC/ICNote/p123", "Archive");

      expect(result).toBe(true);
      // Single native `move` — no getNoteContentById/create/delete fan-out.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      const moveScript = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(moveScript).toContain("move noteRef to destFolder");
      expect(moveScript).toContain("id of actualFolder");
      expect(moveScript).toContain('return "SAFETY_MOVED"');
      expect(moveScript).not.toContain("make new note");
    });

    it("resolves the destination to a live folder id (#213)", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "SAFETY_MOVED" });

      manager.moveNoteById("x-coredata://ABC/ICNote/p123", "Work/Archive");

      const moveScript = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(moveScript).toContain('whose name is "Archive"');
      expect(moveScript).toContain("if exists folder id destFolder_cid then");
      expect(moveScript).not.toContain('folder "Archive" of folder "Work"');
      expect(moveScript.indexOf("destFolder_cid")).toBeLessThan(
        moveScript.indexOf("move noteRef to destFolder")
      );
    });

    it("returns false when Notes cannot verify the destination folder", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "SAFETY_WRONG_FOLDER",
      });

      const result = manager.moveNoteById("x-coredata://ABC/ICNote/p123", "Archive");

      expect(result).toBe(false);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
    });

    it("returns false when the move fails", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Folder not found",
      });

      const result = manager.moveNoteById("x-coredata://ABC/ICNote/p123", "Nonexistent");

      expect(result).toBe(false);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Account Operations
  // ---------------------------------------------------------------------------

  describe("listAccounts", () => {
    it("returns array of Account objects", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["acc1", "iCloud", "true", "folder1", "Notes"].join(F),
          ["acc2", "Gmail", "false", "folder2", "Inbox"].join(F),
          ["acc3", "Exchange", "false", "", ""].join(F),
        ].join(R),
      });

      const accounts = manager.listAccounts();

      expect(accounts).toHaveLength(3);
      expect(accounts[0].name).toBe("iCloud");
      expect(accounts[1].name).toBe("Gmail");
      expect(accounts[2].name).toBe("Exchange");
      expect(accounts[0].id).toBe("acc1");
      expect(accounts[0].upgraded).toBe(true);
      expect(accounts[0].defaultFolder).toBe("Notes");
    });

    it("parses legacy plain-name output (backward compat)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["iCloud", "Gmail"].join(R),
      });

      const accounts = manager.listAccounts();

      expect(accounts).toHaveLength(2);
      expect(accounts[0]).toEqual({ name: "iCloud" });
      expect(accounts[1]).toEqual({ name: "Gmail" });
    });

    it("handles account records with empty fields", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["", "", "", "", ""].join(F),
      });

      const accounts = manager.listAccounts();

      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe("");
      expect(accounts[0].upgraded).toBe(false);
      expect(accounts[0].defaultFolderId).toBeUndefined();
    });

    it("throws on failure rather than returning empty (#19)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Notes.app not available",
      });

      expect(() => manager.listAccounts()).toThrow(/Notes.app not available/);
    });
  });

  describe("getDefaultLocation", () => {
    it("returns default account and folder metadata", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["acc1", "iCloud", "true", "folder1", "Notes", "false"].join(F),
      });

      const location = manager.getDefaultLocation();

      expect(location.account).toMatchObject({
        id: "acc1",
        name: "iCloud",
        upgraded: true,
        defaultFolderId: "folder1",
        defaultFolder: "Notes",
      });
      expect(location.folder).toMatchObject({
        id: "folder1",
        name: "Notes",
        account: "iCloud",
        shared: false,
      });
    });

    it("throws when default location output cannot be parsed", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "bad-output",
      });

      expect(() => manager.getDefaultLocation()).toThrow(/parse default Notes location/);
    });

    it("throws when AppleScript fails", () => {
      mockExecuteAppleScript.mockReturnValue({ success: false, output: "", error: "boom" });

      expect(() => manager.getDefaultLocation()).toThrow(/Failed to get default Notes location/);
    });

    it("handles empty fields in default location output", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["", "", "", "", "", ""].join(F),
      });

      const location = manager.getDefaultLocation();

      expect(location.account.name).toBe("");
      expect(location.account.upgraded).toBe(false);
      expect(location.folder.id).toBe("");
      expect(location.folder.shared).toBe(false);
    });
  });

  describe("getSelectedNotes", () => {
    it("returns selected note metadata", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          [
            "x-coredata://ABC/ICNote/p1",
            "Selected Note",
            "2026-6-22-14-30-0",
            "2026-6-22-14-35-0",
            "false",
            "false",
            "Notes",
            "iCloud",
          ].join(F),
        ].join(R),
      });

      const notes = manager.getSelectedNotes();

      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id: "x-coredata://ABC/ICNote/p1",
        title: "Selected Note",
        shared: false,
        passwordProtected: false,
        folder: "Notes",
        account: "iCloud",
      });
      expect(notes[0].created.getFullYear()).toBe(2026);
    });

    it("returns an empty array when no note is selected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      expect(manager.getSelectedNotes()).toEqual([]);
    });

    it("throws when AppleScript fails", () => {
      mockExecuteAppleScript.mockReturnValue({ success: false, output: "", error: "boom" });

      expect(() => manager.getSelectedNotes()).toThrow(/Failed to get selected notes/);
    });

    it("handles selected notes with empty optional fields", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: ["", "", "", "", "", "", "", ""].join(F),
      });

      const notes = manager.getSelectedNotes();

      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe("");
      expect(notes[0].shared).toBe(false);
      expect(notes[0].passwordProtected).toBe(false);
      expect(notes[0].folder).toBeUndefined();
      expect(notes[0].account).toBeUndefined();
    });
  });

  describe("showNoteById", () => {
    it("shows a note by id", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      expect(manager.showNoteById("x-coredata://ABC/ICNote/p1")).toBe(true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('show note id "x-coredata://ABC/ICNote/p1"'),
        NO_RETRY_OPTIONS
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.showNoteById("x-coredata://ABC/ICNote/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true"),
        NO_RETRY_OPTIONS
      );
    });

    it("returns false when Notes.app rejects the show command", () => {
      mockExecuteAppleScript.mockReturnValue({ success: false, output: "", error: "no such note" });

      expect(manager.showNoteById("x-coredata://ABC/ICNote/p1")).toBe(false);
    });
  });

  describe("showFolderById", () => {
    it("shows a folder by id", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      expect(manager.showFolderById("x-coredata://ABC/ICFolder/p1")).toBe(true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('show folder id "x-coredata://ABC/ICFolder/p1"'),
        NO_RETRY_OPTIONS
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.showFolderById("x-coredata://ABC/ICFolder/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true"),
        NO_RETRY_OPTIONS
      );
    });

    it("returns false when Notes.app rejects the show command", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "no such folder",
      });

      expect(manager.showFolderById("x-coredata://ABC/ICFolder/p1")).toBe(false);
    });
  });

  describe("showAccountById", () => {
    it("shows an account by id", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      expect(manager.showAccountById("x-coredata://ABC/ICAccount/p1")).toBe(true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('show account id "x-coredata://ABC/ICAccount/p1"'),
        NO_RETRY_OPTIONS
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.showAccountById("x-coredata://ABC/ICAccount/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true"),
        NO_RETRY_OPTIONS
      );
    });

    it("returns false when Notes.app rejects the show command", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "no such account",
      });

      expect(manager.showAccountById("x-coredata://ABC/ICAccount/p1")).toBe(false);
    });
  });

  describe("showAttachmentById", () => {
    it("resolves the attachment within its note and shows it", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "OK" });

      expect(manager.showAttachmentById("x-coredata://ABC/ICNote/p1", "att-123")).toBe(true);
      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).toContain('set theNote to note id "x-coredata://ABC/ICNote/p1"');
      // Addressed directly rather than scanned for: one Apple Event instead of up
      // to N, and still scoped to theNote (a foreign id resolves to missing value).
      expect(script).toContain('set theAttachment to attachment id "att-123" of theNote');
      expect(script).not.toContain("repeat with a in attachments of theNote");
      expect(script).toContain("show theAttachment");
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "OK" });

      manager.showAttachmentById("x-coredata://ABC/ICNote/p1", "att-123", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true"),
        NO_RETRY_OPTIONS
      );
    });

    it("returns false when the attachment is not found on the note", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: `ERR${F}attachment not found`,
      });

      expect(manager.showAttachmentById("x-coredata://ABC/ICNote/p1", "missing")).toBe(false);
    });

    it("returns false when Notes.app rejects the show command", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "no such note",
      });

      expect(manager.showAttachmentById("x-coredata://ABC/ICNote/p1", "att-123")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  describe("healthCheck", () => {
    it("returns healthy when all checks pass", () => {
      mockExecuteAppleScript
        // Check 1: Notes.app accessible
        .mockReturnValueOnce({ success: true, output: "ok" })
        // Check 2: Permissions (get account name)
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // Check 3: listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // Check 4: listNotes
        .mockReturnValueOnce({
          success: true,
          output: [
            ["Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
            ["Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
          ].join(R),
        });

      const result = manager.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    });

    it("returns unhealthy when Notes.app is not accessible", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Application not found",
      });

      const result = manager.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe("notes_app");
      expect(result.checks[0].passed).toBe(false);
    });

    it("returns unhealthy with permission hint when not authorized", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "not authorized to send Apple events",
      });

      const result = manager.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.checks[0].message).toContain("Automation permissions");
    });

    it('classifies an en-GB "Not authorised" refusal as a permission failure', () => {
      // The regression this guards: on an en_GB / en_AU / en_IE Mac the
      // refusal reads "Not authorised", the American-only substring check
      // missed it, and a genuine TCC denial reported `passed: true` and then
      // misdirected the user to check their accounts.
      mockExecuteAppleScript
        // Check 1: Notes.app accessible
        .mockReturnValueOnce({ success: true, output: "ok" })
        // Check 2: permission probe refused, British spelling
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "27:44: execution error: Not authorised to send Apple events to Notes. (-1743)",
        });

      const result = manager.healthCheck();

      const permCheck = result.checks.find((c) => c.name === "permissions");
      expect(permCheck?.passed).toBe(false);
      expect(permCheck?.message).toContain("AppleScript permissions denied");
      // The early return fires: no account/note checks ran.
      expect(result.healthy).toBe(false);
      expect(result.checks).toHaveLength(2);
    });

    it("classifies a fully localised refusal by its -1743 OSStatus alone", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "ok" })
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "27:44: execution error: Non autorisé à envoyer des événements Apple (-1743)",
        });

      const result = manager.healthCheck();

      expect(result.checks.find((c) => c.name === "permissions")?.passed).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.checks).toHaveLength(2);
    });

    it("returns unhealthy with permission hint when the refusal is British-spelled", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Not authorised to send Apple events to Notes. (-1743)",
      });

      const result = manager.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.checks[0].message).toContain("Automation permissions");
    });

    it("returns unhealthy when no accounts found", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "ok" })
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({ success: true, output: "" }); // No accounts

      const result = manager.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.checks.find((c) => c.name === "accounts")?.passed).toBe(false);
    });

    it("includes account names in successful account check", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "ok" })
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({ success: true, output: ["iCloud", "Gmail"].join(R) })
        .mockReturnValueOnce({ success: true, output: "" });

      const result = manager.healthCheck();

      const accountCheck = result.checks.find((c) => c.name === "accounts");
      expect(accountCheck?.message).toContain("iCloud");
      expect(accountCheck?.message).toContain("Gmail");
    });
  });

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  describe("getNotesStats", () => {
    it("returns statistics for all accounts and folders", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // per-account folder counts: name<F>count, records joined by R
        .mockReturnValueOnce({
          success: true,
          output: ["Notes", "3"].join(F) + R + ["Work", "2"].join(F) + R,
        })
        // getRecentlyModifiedCounts: c1<F>c7<F>c30
        .mockReturnValueOnce({ success: true, output: ["0", "0", "0"].join(F) });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(5);
      expect(stats.accounts).toHaveLength(1);
      expect(stats.accounts[0].name).toBe("iCloud");
      expect(stats.accounts[0].totalNotes).toBe(5);
      expect(stats.accounts[0].folderCount).toBe(2);
      expect(stats.accounts[0].folders).toHaveLength(2);
    });

    it("returns zero counts when no notes exist", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({ success: true, output: ["Notes", "0"].join(F) + R })
        .mockReturnValueOnce({ success: true, output: ["0", "0", "0"].join(F) });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(0);
      expect(stats.recentlyModified.last24h).toBe(0);
      expect(stats.recentlyModified.last7d).toBe(0);
      expect(stats.recentlyModified.last30d).toBe(0);
    });

    it("handles multiple accounts", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: ["iCloud", "Gmail"].join(R) })
        // iCloud folder counts
        .mockReturnValueOnce({ success: true, output: ["Notes", "1"].join(F) + R })
        // Gmail folder counts
        .mockReturnValueOnce({ success: true, output: ["Notes", "1"].join(F) + R })
        // getRecentlyModifiedCounts
        .mockReturnValueOnce({ success: true, output: ["0", "0", "0"].join(F) });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(2);
      expect(stats.accounts).toHaveLength(2);
      expect(stats.accounts[0].name).toBe("iCloud");
      expect(stats.accounts[1].name).toBe("Gmail");
    });

    it("reports complete coverage when every scope succeeds (#19)", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({ success: true, output: ["Notes", "3"].join(F) + R })
        .mockReturnValueOnce({ success: true, output: ["1", "2", "3"].join(F) });

      const stats = manager.getNotesStats();

      expect(stats.coverage.complete).toBe(true);
      expect(stats.coverage.warnings).toEqual([]);
      expect(stats.coverage.covered).toBe(stats.coverage.scanned);
    });

    it("degrades gracefully when one account fails, with a coverage warning (#19)", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: ["iCloud", "Gmail"].join(R) })
        // iCloud folder counts succeed
        .mockReturnValueOnce({ success: true, output: ["Notes", "4"].join(F) + R })
        // Gmail folder counts FAIL
        .mockReturnValueOnce({ success: false, output: "", error: "Gmail account is locked" })
        // getRecentlyModifiedCounts succeed
        .mockReturnValueOnce({ success: true, output: ["0", "0", "0"].join(F) });

      const stats = manager.getNotesStats();

      // Healthy account's data is preserved, not discarded
      expect(stats.totalNotes).toBe(4);
      expect(stats.accounts).toHaveLength(1);
      expect(stats.accounts[0].name).toBe("iCloud");
      // Failure surfaced as a coverage warning
      expect(stats.coverage.complete).toBe(false);
      expect(stats.coverage.warnings).toHaveLength(1);
      expect(stats.coverage.warnings[0].scope).toBe("Gmail");
      expect(stats.coverage.warnings[0].reason).toContain("locked");
    });

    it("flags recent-activity failure as a coverage warning, not fake zeros (#19)", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        .mockReturnValueOnce({ success: true, output: ["Notes", "5"].join(F) + R })
        // getRecentlyModifiedCounts FAILS
        .mockReturnValueOnce({ success: false, output: "", error: "timed out" });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(5);
      expect(stats.recentlyModified.last24h).toBe(0);
      expect(stats.coverage.complete).toBe(false);
      expect(stats.coverage.warnings.some((w) => w.scope === "recent-activity")).toBe(true);
    });

    it("throws when no account can be read at all (#19)", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: ["iCloud", "Gmail"].join(R) })
        .mockReturnValueOnce({ success: false, output: "", error: "iCloud unreachable" })
        .mockReturnValueOnce({ success: false, output: "", error: "Gmail unreachable" });

      expect(() => manager.getNotesStats()).toThrow(/Failed to read folder stats for any/);
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment Listing
  // ---------------------------------------------------------------------------

  describe("listAttachmentsById", () => {
    it("returns attachments for a note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          ["x-coredata://ABC/ICAttachment/p1", "photo.jpg", "public.jpeg"].join(F),
          ["x-coredata://ABC/ICAttachment/p2", "document.pdf", "com.adobe.pdf"].join(F),
        ].join(R),
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toMatchObject({
        id: "x-coredata://ABC/ICAttachment/p1",
        name: "photo.jpg",
        contentType: "public.jpeg",
        contentId: "public.jpeg",
      });
      expect(attachments[1]).toMatchObject({
        id: "x-coredata://ABC/ICAttachment/p2",
        name: "document.pdf",
        contentType: "com.adobe.pdf",
        contentId: "com.adobe.pdf",
      });
    });

    it("parses richer attachment metadata when present", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          [
            "x-coredata://ABC/ICAttachment/p1",
            "site.webloc",
            "cid:123",
            "https://example.com",
            "2026-6-22-10-0-0",
            "2026-6-22-11-0-0",
            "true",
          ].join(F),
        ].join(R),
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments[0]).toMatchObject({
        id: "x-coredata://ABC/ICAttachment/p1",
        name: "site.webloc",
        contentType: "cid:123",
        contentId: "cid:123",
        url: "https://example.com",
        shared: true,
      });
      expect(attachments[0].created?.getFullYear()).toBe(2026);
      expect(attachments[0].modified?.getHours()).toBe(11);
    });

    it("reports an attachment enumerated twice only once, in first-seen order (#197)", () => {
      const output = [
        ["x-coredata://ABC/ICAttachment/p2", "new.png", "public.png"].join(F),
        ["x-coredata://ABC/ICAttachment/p1", "photo.jpg", "public.jpeg"].join(F),
        ["x-coredata://ABC/ICAttachment/p2", "new.png", "public.png"].join(F),
      ].join(R);
      mockExecuteAppleScript.mockReturnValue({ success: true, output });
      const expected = ["x-coredata://ABC/ICAttachment/p2", "x-coredata://ABC/ICAttachment/p1"];

      expect(manager.listAttachmentsById("x-coredata://ABC/ICNote/p123").map((a) => a.id)).toEqual(
        expected
      );
      expect(manager.listAttachments("My Note", "iCloud").map((a) => a.id)).toEqual(expected);
    });

    it("returns empty array when note has no attachments", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toEqual([]);
    });

    it("surfaces an error rather than an empty array when the lookup fails", () => {
      // Previously this returned [], which the tool layer rendered as the cheerful
      // "has no attachments" -- indistinguishable from a genuinely empty note.
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Note not found",
      });

      expect(() => manager.listAttachmentsById("x-coredata://ABC/ICNote/p999")).toThrow(
        /Note not found/
      );
    });

    it("generates correct AppleScript for ID lookup", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('note id "x-coredata://ABC/ICNote/p123"')
      );
    });

    it("bulk-fetches properties instead of sending Apple Events per attachment", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");
      manager.listAttachments("My Note", "iCloud");

      for (const [script] of mockExecuteAppleScript.mock.calls) {
        expect(script).toContain("set attachmentIds to id of every attachment of theNote");
        expect(script).toContain("set attachmentNames to name of every attachment of theNote");
        expect(script).toContain(
          'if (count of attachmentNames) is not (count of attachmentIds) then error "Notes changed during listing"'
        );
        expect(script).toContain("repeat with i from 1 to count of attachmentIds");
        expect(script).not.toContain("repeat with a in attachments of theNote");
      }
    });

    it("does not use the reserved word `item` as a repeat loop variable", () => {
      // Regression: `repeat with item in ...` fails to COMPILE ("Expected
      // variable name or property but found class name", -2741), so every
      // list-attachments call errored and surfaced as an empty array.
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      const script = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(script).not.toMatch(/repeat with item\b/);
      expect(script).toContain("repeat with recordItem in attachmentList");
    });

    it("normalizes a 'missing value' URL to undefined", () => {
      // `URL of a as text` renders as the literal string "missing value" for
      // attachments without a URL (most images); that sentinel must not leak
      // into the parsed url field.
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          "x-coredata://ABC/ICAttachment/p1",
          "photo.png",
          "cid:abc",
          "missing value",
          "2026-7-5-22-7-39",
          "2026-7-5-22-7-39",
          "false",
        ].join(F),
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toHaveLength(1);
      expect(attachments[0].url).toBeUndefined();
    });

    it("keeps every field aligned with its own attachment across records", () => {
      // The bulk fetch zips seven independently-fetched lists. If the zip ever
      // slipped, a record would carry one attachment's id with another's name --
      // and save-attachment/fetch-attachment resolve bytes from that id, so the
      // wrong file would be written under the wrong name.
      const record = (n: number) =>
        [
          `x-coredata://ABC/ICAttachment/p${n}`,
          `file${n}.png`,
          `cid:${n}`,
          "missing value",
          "2026-7-5-22-7-39",
          "2026-7-5-22-7-39",
          n === 2 ? "true" : "false",
        ].join(F);

      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [record(1), record(2), record(3)].join(R),
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toHaveLength(3);
      attachments.forEach((a, i) => {
        const n = i + 1;
        expect(a.id).toBe(`x-coredata://ABC/ICAttachment/p${n}`);
        expect(a.name).toBe(`file${n}.png`);
        expect(a.contentId).toBe(`cid:${n}`);
        expect(a.shared).toBe(n === 2);
      });
    });

    it("guards the zip against a concurrent mutation that preserves the count", () => {
      // Count guards alone cannot see a same-length reorder or delete+add, so the
      // script re-reads the ids after the other six fetches and compares them
      // element-wise. Without this, a swap between Apple Events passes every check.
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");
      manager.listAttachments("My Note", "iCloud");

      for (const [script] of mockExecuteAppleScript.mock.calls) {
        expect(script).toContain("set attachmentIdsAfter to id of every attachment of theNote");
        expect(script).toContain(
          'if (item i of attachmentIdsAfter) is not (item i of attachmentIds) then error "Notes changed during listing"'
        );
      }
    });

    it("throws instead of reporting an empty note when the AppleScript call fails", () => {
      // A false empty is the exact hazard this tool exists to prevent: callers gate
      // destructive full-body updates on it. Exhausted retries must surface as an error.
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        error: "Notes changed during listing",
      });

      expect(() => manager.listAttachmentsById("x-coredata://ABC/ICNote/p123")).toThrow(
        /Notes changed during listing/
      );
    });

    it("still returns an empty array when the note genuinely has no attachments", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      expect(manager.listAttachmentsById("x-coredata://ABC/ICNote/p123")).toEqual([]);
    });

    it("does not surface the literal 'missing value' as an attachment name", () => {
      // Notes leaves `name` unset on some attachments; `name of a as text` then
      // renders the AppleScript sentinel, which previously reached callers as a
      // filename (`- missing value (cid:abc)`).
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          "x-coredata://ABC/ICAttachment/p1",
          "missing value",
          "cid:abc",
          "missing value",
          "2026-7-5-22-7-39",
          "2026-7-5-22-7-39",
          "false",
        ].join(F),
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments[0].name).not.toBe("missing value");
      expect(attachments[0].name).toBe("cid:abc");
    });

    it("leaves an unnamed saved attachment's name undefined rather than the sentinel", () => {
      // save-attachment/fetch-attachment render `r.name ?? "attachment"`, and `??`
      // does not catch the literal string -- so this must be undefined, not passed
      // through, or the response reads `Saved "missing value" to ...`.
      // AppleScript is mocked, so stand in for the file Notes would have written
      // (the manager verifies a non-empty file landed before reporting success).
      // mkdtemp, not a predictable name in the shared temp dir: a guessable path
      // there is a symlink-race vector (CodeQL js/insecure-temporary-file).
      const dir = mkdtempSync(join(tmpdir(), "apple-notes-mcp-test-"));
      const dest = join(dir, "attachment.bin");
      writeFileSync(dest, "x");
      try {
        mockExecuteAppleScript.mockReturnValueOnce({
          success: true,
          output: `OK${F}missing value${F}missing value`,
        });

        const saved = manager.saveAttachmentById("x-coredata://ABC/ICNote/p1", "att-1", dest);

        expect(saved.success).toBe(true);
        expect(saved.name).toBeUndefined();
        expect(saved.contentType).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("listAttachments", () => {
    it("returns attachments for a note by title", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: ["attach-id", "image.png", "public.png"].join(F),
      });

      const attachments = manager.listAttachments("My Note");

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        id: "attach-id",
        name: "image.png",
        contentType: "public.png",
        contentId: "public.png",
      });
    });

    it("uses specified account", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachments("My Note", "Gmail");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('every account whose name is "Gmail"')
      );
    });

    it("defaults to Notes.app's own default account, not a hardcoded iCloud", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachments("My Note");

      const script = String(mockExecuteAppleScript.mock.calls.at(-1)?.[0]);
      expect(script).toContain("set __acctRef to default account");
      expect(script).not.toContain('"iCloud"');
    });

    it("returns empty array when note has no attachments", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      const attachments = manager.listAttachments("Empty Note");

      expect(attachments).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Batch Operations
  // ---------------------------------------------------------------------------

  describe("batchMoveNotes", () => {
    const ID1 = "x-coredata://ABC00000-0000-0000-0000-000000000011/ICNote/p1";
    const ID2 = "x-coredata://ABC00000-0000-0000-0000-000000000012/ICNote/p2";

    it("moves the whole batch in a single osascript spawn (#26)", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: ["ok", "ok"].join(R) + R,
      });

      const results = manager.batchMoveNotes([ID1, ID2], "Archive");

      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: ID1, success: true });
      expect(results[1]).toEqual({ id: ID2, success: true });
      const script = String(mockExecuteAppleScript.mock.calls[0][0]);
      expect(script).toContain("id of actualFolder");
      expect(script).toContain('"wrongfolder"');
      // #213: the destination is a live folder id, not a name reference.
      expect(script).toContain('whose name is "Archive"');
      expect(script).toContain("if exists folder id destFolder_cid then");
      expect(script).not.toContain('folder "Archive" of __acctRef');
    });

    it("returns error for non-existent note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "missing" + R });

      const results = manager.batchMoveNotes(
        ["x-coredata://ABC00000-0000-0000-0000-000000000099/ICNote/p404"],
        "Archive"
      );

      expect(results[0]).toEqual({
        id: "x-coredata://ABC00000-0000-0000-0000-000000000099/ICNote/p404",
        success: false,
        error: "Note not found",
      });
    });

    it("returns error for password-protected note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "pw" + R });

      const results = manager.batchMoveNotes([ID1], "Archive");

      expect(results[0]).toEqual({ id: ID1, success: false, error: "Note is password-protected" });
    });

    it("maps a per-item move failure to 'Move failed'", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: ["ok", "fail"].join(R) + R,
      });

      const results = manager.batchMoveNotes([ID1, ID2], "Archive");

      expect(results[0]).toEqual({ id: ID1, success: true });
      expect(results[1]).toEqual({ id: ID2, success: false, error: "Move failed" });
    });

    it("reports a move whose destination folder cannot be verified", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "wrongfolder" + R,
      });

      const results = manager.batchMoveNotes([ID1], "Archive");

      expect(results[0]).toEqual({
        id: ID1,
        success: false,
        error: "Destination folder verification failed",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Export Operations
  // ---------------------------------------------------------------------------

  describe("exportNotesAsJson", () => {
    // Note details output helper - format: title, id, date, date, shared, passwordProtected
    const noteDetailsOutput = (title: string, passwordProtected = false) =>
      [
        title,
        "x-coredata://ABC/ICNote/p1",
        "Sunday, January 1, 2025 at 1:00:00 PM",
        "Sunday, January 1, 2025 at 1:00:00 PM",
        "false",
        String(passwordProtected),
      ].join(F);

    it("exports notes with metadata and content", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // listFolders for iCloud
        .mockReturnValueOnce({ success: true, output: "id1\tNotes" })
        // listNotes for Notes folder
        .mockReturnValueOnce({
          success: true,
          output: ["Test Note", "x-coredata://ABC/ICNote/p1"].join(F),
        })
        // getNoteDetails
        .mockReturnValueOnce({ success: true, output: noteDetailsOutput("Test Note", false) })
        // getNoteContent
        .mockReturnValueOnce({
          success: true,
          output: "<div>Test Note</div><div>Content here</div>",
        });

      const result = manager.exportNotesAsJson() as {
        exportDate: string;
        version: string;
        accounts: { name: string; folders: { name: string; notes: object[] }[] }[];
        summary: { totalNotes: number; totalFolders: number; totalAccounts: number };
      };

      expect(result.version).toBe("1.0");
      expect(result.exportDate).toBeDefined();
      expect(result.summary.totalNotes).toBe(1);
      expect(result.summary.totalFolders).toBe(1);
      expect(result.summary.totalAccounts).toBe(1);
      expect(result.accounts[0].name).toBe("iCloud");
      expect(result.accounts[0].folders[0].name).toBe("Notes");
      expect(result.accounts[0].folders[0].notes).toHaveLength(1);
    });

    it("skips content for password-protected notes", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // listFolders for iCloud
        .mockReturnValueOnce({ success: true, output: "id1\tNotes" })
        // listNotes for Notes folder
        .mockReturnValueOnce({
          success: true,
          output: ["Locked Note", "x-coredata://ABC/ICNote/p1"].join(F),
        })
        // getNoteDetails (passwordProtected = true)
        .mockReturnValueOnce({ success: true, output: noteDetailsOutput("Locked Note", true) });
      // No getNoteContent call because note is password-protected

      const result = manager.exportNotesAsJson() as {
        accounts: { folders: { notes: { content: string; passwordProtected: boolean }[] }[] }[];
      };

      const note = result.accounts[0].folders[0].notes[0];
      expect(note.passwordProtected).toBe(true);
      expect(note.content).toBe("");
    });

    it("handles empty accounts", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud" })
        // listFolders for iCloud
        .mockReturnValueOnce({ success: true, output: "id1\tNotes" })
        // listNotes returns empty
        .mockReturnValueOnce({ success: true, output: "" });

      const result = manager.exportNotesAsJson() as {
        summary: { totalNotes: number };
      };

      expect(result.summary.totalNotes).toBe(0);
    });

    it("exports both notes when two notes share an exact title", () => {
      const idA = "x-coredata://ABC/ICNote/p1";
      const idB = "x-coredata://ABC/ICNote/p2";
      const title = "Duplicate Title";

      const detailsFor = (id: string) =>
        [
          title,
          id,
          "Sunday, January 1, 2025 at 1:00:00 PM",
          "Sunday, January 1, 2025 at 1:00:00 PM",
          "false",
          "false",
        ].join(F);
      const contentFor = (id: string) =>
        id === idA ? "<div>Content A</div>" : "<div>Content B</div>";

      let callIndex = 0;
      mockExecuteAppleScript.mockImplementation((script: string) => {
        callIndex++;
        if (callIndex === 1) return { success: true, output: "iCloud" }; // listAccounts
        if (callIndex === 2) return { success: true, output: "id1\tNotes" }; // listFolders
        if (callIndex === 3) {
          // Bulk listNotes fetch: two distinct notes, same title, different ids.
          return { success: true, output: [title + F + idA, title + F + idB].join(R) };
        }
        // Any later lookup keyed by id resolves to the real, distinct note.
        // A lookup keyed only by (ambiguous, duplicated) title mirrors real
        // AppleScript's `note "<name>"` behavior: it deterministically
        // resolves to the same one note every time, regardless of which
        // iteration is asking.
        const idMatch = script.match(/note id "([^"]+)"/);
        const targetId = idMatch ? idMatch[1] : idA;
        if (script.includes("get body of note")) {
          return { success: true, output: contentFor(targetId) };
        }
        return { success: true, output: detailsFor(targetId) };
      });

      const result = manager.exportNotesAsJson() as {
        summary: { totalNotes: number };
        accounts: { folders: { notes: { id: string; content: string }[] }[] }[];
      };

      const notes = result.accounts[0].folders[0].notes;
      expect(result.summary.totalNotes).toBe(2);
      expect(notes.map((n) => n.id).sort()).toEqual([idA, idB].sort());
      expect(notes.find((n) => n.id === idA)?.content).toBe(contentFor(idA));
      expect(notes.find((n) => n.id === idB)?.content).toBe(contentFor(idB));
    });
  });

  describe("exportNotesAsJson paging and response size budget (#162)", () => {
    type Page = {
      offset: number;
      limit: number;
      totalAvailable: number;
      returned: number;
      nextOffset?: number;
      hasMore: boolean;
      stoppedAtSizeLimit: boolean;
    };
    type ExportedPage = {
      summary: { totalNotes: number; totalFolders: number };
      page: Page;
      accounts: {
        folders: {
          name: string;
          notes: {
            id: string;
            content: string;
            plaintext: string;
            strippedImages?: number;
            contentOmitted?: boolean;
          }[];
        }[];
      }[];
    };
    const noteIds = (n: number) =>
      Array.from({ length: n }, (_, i) => `x-coredata://ABC/ICNote/p${i + 1}`);
    const exportedIds = (page: ExportedPage) =>
      page.accounts.flatMap((a) => a.folders.flatMap((f) => f.notes.map((n) => n.id)));

    /**
     * One iCloud account whose folders hold the given [id, body] notes. Each
     * script is answered by what it asks for; body reads are recorded.
     */
    const mockLibrary = (folders: Record<string, [string, string][]>) => {
      const bodyReads: string[] = [];
      mockExecuteAppleScript.mockImplementation((script: string) => {
        if (script.includes("repeat with a in accounts"))
          return { success: true, output: "iCloud" };
        if (script.includes("set allFolders to every folder")) {
          return {
            success: true,
            output: Object.keys(folders)
              .map((name, i) => [`f${i}`, name, "", "false", "iCloud"].join(F))
              .join(R),
          };
        }
        if (script.includes("set noteNames to name of")) {
          const folder = Object.keys(folders).find((name) => script.includes(`folder "${name}"`));
          const notes = folder ? folders[folder] : [];
          return {
            success: true,
            output: notes.map(([id]) => [`Title ${id}`, id].join(F)).join(R),
          };
        }
        const id = script.match(/note id "([^"]+)"/)?.[1] ?? "";
        const body =
          Object.values(folders)
            .flat()
            .find(([noteId]) => noteId === id)?.[1] ?? "";
        if (script.includes("get body of note id")) {
          bodyReads.push(id);
          return { success: true, output: body };
        }
        return {
          success: true,
          output: [`Title ${id}`, id, "2025-1-1-0-0-0", "2025-1-1-0-0-0", "false", "false"].join(F),
        };
      });
      return bodyReads;
    };

    it("returns the requested window across folders and reads bodies only for it", () => {
      const [a, b, c, d, e] = noteIds(5);
      const bodyReads = mockLibrary({
        Notes: [
          [a, "<div>a</div>"],
          [b, "<div>b</div>"],
          [c, "<div>c</div>"],
        ],
        Work: [
          [d, "<div>d</div>"],
          [e, "<div>e</div>"],
        ],
      });

      const result = manager.exportNotesAsJson({ offset: 2, limit: 2 }) as unknown as ExportedPage;

      expect(exportedIds(result)).toEqual([c, d]);
      expect(bodyReads).toEqual([c, d]);
      expect(result.summary.totalNotes).toBe(2);
      expect(result.summary.totalFolders).toBe(2);
      expect(result.page).toEqual({
        offset: 2,
        limit: 2,
        totalAvailable: 5,
        returned: 2,
        nextOffset: 4,
        hasMore: true,
        stoppedAtSizeLimit: false,
      });
    });

    it("reports the final page without a nextOffset", () => {
      const [a, b] = noteIds(2);
      mockLibrary({
        Notes: [
          [a, "<div>a</div>"],
          [b, "<div>b</div>"],
        ],
      });

      const result = manager.exportNotesAsJson({ offset: 1 }) as unknown as ExportedPage;

      expect(exportedIds(result)).toEqual([b]);
      expect(result.page.hasMore).toBe(false);
      expect(result.page.nextOffset).toBeUndefined();
      expect(result.page.totalAvailable).toBe(2);
    });

    it("bounds a no-argument export to the default page size", () => {
      const all = noteIds(DEFAULT_EXPORT_PAGE_SIZE + 10);
      const bodyReads = mockLibrary({
        Notes: all.map((id) => [id, "<div>x</div>"] as [string, string]),
      });

      const result = manager.exportNotesAsJson() as unknown as ExportedPage;

      expect(result.summary.totalNotes).toBe(DEFAULT_EXPORT_PAGE_SIZE);
      expect(bodyReads).toHaveLength(DEFAULT_EXPORT_PAGE_SIZE);
      expect(result.page.nextOffset).toBe(DEFAULT_EXPORT_PAGE_SIZE);
      expect(result.page.hasMore).toBe(true);
    });

    it("stops a page before it outgrows the response budget, then resumes at the next note", () => {
      const body = `<div>${"x".repeat(10_000)}</div>`;
      const all = noteIds(4);
      mockLibrary({ Notes: all.map((id) => [id, body] as [string, string]) });

      const first = manager.exportNotesAsJson({
        maxResponseBytes: 100_000,
      }) as unknown as ExportedPage;
      expect(exportedIds(first)).toEqual(all.slice(0, 2));
      expect(first.page).toMatchObject({ nextOffset: 2, hasMore: true, stoppedAtSizeLimit: true });

      const second = manager.exportNotesAsJson({
        offset: 2,
        maxResponseBytes: 100_000,
      }) as unknown as ExportedPage;
      expect(exportedIds(second)).toEqual(all.slice(2));
      expect(second.page).toMatchObject({ hasMore: false, stoppedAtSizeLimit: false });
      for (const note of [...first.accounts, ...second.accounts].flatMap((a) =>
        a.folders.flatMap((f) => f.notes)
      )) {
        expect(note.content).toBe(body);
        expect(note.contentOmitted).toBeUndefined();
      }
    });

    it("degrades a single note that alone exceeds the budget instead of failing", () => {
      const [img, markup, text] = noteIds(3);
      mockLibrary({
        Notes: [
          [img, `<div>caption</div><img src="data:image/png;base64,${"A".repeat(300_000)}">`],
          [markup, `<div>${"<b>z</b>".repeat(20_000)}</div>`],
          [text, `<div>${"y".repeat(200_000)}</div>`],
        ],
      });
      const onlyNote = (offset: number) =>
        (
          manager.exportNotesAsJson({
            offset,
            limit: 1,
            maxResponseBytes: 100_000,
          }) as unknown as ExportedPage
        ).accounts[0].folders[0].notes[0];

      // 1. Oversized inline images are replaced with placeholders first.
      const imgNote = onlyNote(0);
      expect(imgNote.id).toBe(img);
      expect(imgNote.strippedImages).toBe(1);
      expect(imgNote.content).toContain("caption");
      expect(imgNote.content).not.toContain("A".repeat(1000));
      expect(imgNote.contentOmitted).toBeUndefined();

      // 2. Otherwise the HTML body is omitted but the plaintext is kept.
      const markupNote = onlyNote(1);
      expect(markupNote.contentOmitted).toBe(true);
      expect(markupNote.content).toBe("");
      expect(markupNote.plaintext).toBe("z".repeat(20_000));

      // 3. And if even the plaintext cannot fit, both are omitted.
      const textNote = onlyNote(2);
      expect(textNote.contentOmitted).toBe(true);
      expect(textNote.content).toBe("");
      expect(textNote.plaintext).toBe("");
    });

    it("applies modifiedSince to the listing before paging", () => {
      const [a] = noteIds(1);
      mockLibrary({ Notes: [[a, "<div>a</div>"]] });

      manager.exportNotesAsJson({ modifiedSince: "2025-06-15" });

      const listScript = mockExecuteAppleScript.mock.calls
        .map(([script]) => script)
        .find((script) => script.includes("set noteNames to name of"));
      expect(listScript).toContain("thresholdDate");
    });

    it("reads the response budget from APPLE_NOTES_MCP_EXPORT_MAX_BYTES", () => {
      expect(exportMaxResponseBytes({})).toBe(8 * 1024 * 1024);
      expect(exportMaxResponseBytes({ APPLE_NOTES_MCP_EXPORT_MAX_BYTES: "2048" })).toBe(2048);
      expect(exportMaxResponseBytes({ APPLE_NOTES_MCP_EXPORT_MAX_BYTES: "nope" })).toBe(
        8 * 1024 * 1024
      );
    });

    it("estimates both copies of a note that a tool response carries", () => {
      const note = {
        id: "x-coredata://ABC/ICNote/p1",
        title: 'A "quoted" title',
        content: '<div class="a">b\\c</div>',
        plaintext: "b\\c",
        folder: "Notes",
        account: "iCloud",
        created: "2025-01-01T00:00:00.000Z",
        modified: "2025-01-01T00:00:00.000Z",
        shared: false,
        passwordProtected: false,
      };
      const structuredCopy = Buffer.byteLength(JSON.stringify(note));
      const escapedTextCopy = Buffer.byteLength(JSON.stringify(JSON.stringify(note, null, 2)));

      expect(estimateExportNoteBytes(note)).toBeGreaterThan(structuredCopy + escapedTextCopy);
    });
  });

  // ---------------------------------------------------------------------------
  // Markdown Conversion
  // ---------------------------------------------------------------------------

  describe("getNoteMarkdown", () => {
    it("converts HTML to Markdown", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "<div>My Title</div><div>This is a paragraph.</div><div><b>Bold text</b></div>",
      });

      const markdown = manager.getNoteMarkdown("My Note");

      expect(markdown).toContain("My Title");
      expect(markdown).toContain("This is a paragraph.");
      expect(markdown).toContain("**Bold text**");
    });

    it("returns empty string when note not found", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Note not found",
      });

      const markdown = manager.getNoteMarkdown("Missing Note");

      expect(markdown).toBe("");
    });

    it("handles lists correctly", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "<ul><li>Item 1</li><li>Item 2</li></ul>",
      });

      const markdown = manager.getNoteMarkdown("List Note");

      // Turndown may add extra whitespace after the bullet
      expect(markdown).toMatch(/-\s+Item 1/);
      expect(markdown).toMatch(/-\s+Item 2/);
    });
  });

  describe("getNoteMarkdownById", () => {
    it("converts HTML to Markdown using ID", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "<div>Note Title</div><div>Content here</div>",
      });

      const markdown = manager.getNoteMarkdownById("x-coredata://ABC/ICNote/p123");

      expect(markdown).toContain("Note Title");
      expect(markdown).toContain("Content here");
    });

    it("returns empty string when note ID not found", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Note not found",
      });

      const markdown = manager.getNoteMarkdownById(
        "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p999"
      );

      expect(markdown).toBe("");
    });

    it("enriches markdown with checklist state when available", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "<ul><li>Buy milk</li><li>Walk dog</li><li>Send email</li></ul>",
      });
      mockGetChecklistItems.mockReturnValueOnce({
        items: [
          { text: "Buy milk", done: true },
          { text: "Walk dog", done: false },
          { text: "Send email", done: true },
        ],
      });

      const markdown = manager.getNoteMarkdownById("x-coredata://ABC/ICNote/p123");

      expect(markdown).toMatch(/-\s+\[x\] Buy milk/);
      expect(markdown).toMatch(/-\s+\[ \] Walk dog/);
      expect(markdown).toMatch(/-\s+\[x\] Send email/);
    });

    it("returns plain markdown when checklist state is unavailable", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "<ul><li>Item 1</li><li>Item 2</li></ul>",
      });
      mockGetChecklistItems.mockReturnValueOnce({
        items: null,
        error: "no_fda",
        message: "Full Disk Access required",
      });

      const markdown = manager.getNoteMarkdownById("x-coredata://ABC/ICNote/p456");

      expect(markdown).toMatch(/-\s+Item 1/);
      expect(markdown).toMatch(/-\s+Item 2/);
      expect(markdown).not.toContain("[x]");
      expect(markdown).not.toContain("[ ]");
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================

  describe("sanitizeId", () => {
    it("accepts valid CoreData IDs", () => {
      const id = "x-coredata://12345ABC-DEF0-1234-5678-9ABCDEF01234/ICNote/p100";
      expect(sanitizeId(id)).toBe(id);
    });

    it("accepts temp IDs from generateFallbackId", () => {
      expect(sanitizeId("temp-1704067200000-0")).toBe("temp-1704067200000-0");
      expect(sanitizeId("temp-1704067200000-42")).toBe("temp-1704067200000-42");
    });

    it("rejects IDs with AppleScript injection", () => {
      expect(() => sanitizeId('x-coredata://test" & do shell script "rm -rf ~" & "')).toThrow(
        "Invalid note ID format"
      );
    });

    it("rejects IDs with double-quote breakout", () => {
      expect(() => sanitizeId('x-coredata://test"; delete note id "dummy" & "')).toThrow(
        "Invalid note ID format"
      );
    });

    it("rejects arbitrary strings", () => {
      expect(() => sanitizeId("not-a-valid-id")).toThrow("Invalid note ID format");
    });

    it("rejects empty string", () => {
      expect(() => sanitizeId("")).toThrow("Invalid note ID format");
    });

    it("accepts various ICEntity types", () => {
      expect(sanitizeId("x-coredata://ABC123/ICFolder/p50")).toBe(
        "x-coredata://ABC123/ICFolder/p50"
      );
      expect(sanitizeId("x-coredata://ABC123/ICAttachment/p1")).toBe(
        "x-coredata://ABC123/ICAttachment/p1"
      );
    });
  });

  describe("sanitizeNoteId", () => {
    it("accepts only canonical Apple Note IDs", () => {
      const id = "x-coredata://12345ABC-DEF0-1234-5678-9ABCDEF01234/ICNote/p100";
      expect(sanitizeNoteId(id)).toBe(id);
    });

    it("rejects synthetic IDs and IDs for other CoreData entities", () => {
      expect(() => sanitizeNoteId("temp-1704067200000-0")).toThrow("Invalid note ID format");
      expect(() => sanitizeNoteId("x-coredata://ABC123/ICFolder/p50")).toThrow(
        "Invalid note ID format"
      );
    });
  });

  describe("escapeForAppleScript - injection prevention", () => {
    it("escapes double quotes to prevent AppleScript string breakout", () => {
      const malicious = 'Hello "World" end tell';
      const escaped = escapeForAppleScript(malicious);
      expect(escaped).toContain('\\"');
      expect(escaped).not.toContain('"World"');
    });

    it("escapes backslashes to prevent escape sequence injection", () => {
      const malicious = "path\\to\\file";
      const escaped = escapeForAppleScript(malicious);
      // Backslashes should be encoded as HTML entities (&#92;)
      expect(escaped).toContain("&#92;");
    });

    it("handles combined injection payload", () => {
      const payload = '" & do shell script "echo pwned" & "';
      const escaped = escapeForAppleScript(payload);
      // All double quotes must be escaped with backslash
      // Count unescaped double quotes — there should be none
      const unescapedQuotes = escaped.replace(/\\"/g, "").match(/"/g);
      expect(unescapedQuotes).toBeNull();
    });
  });

  describe("buildFolderReference - input validation", () => {
    it("rejects empty folder paths", () => {
      expect(() => buildFolderReference("")).toThrow("Folder path is empty");
    });

    it("rejects paths that are only slashes", () => {
      expect(() => buildFolderReference("///")).toThrow("Folder path is empty");
    });

    it("rejects excessively deep folder nesting", () => {
      const deepPath = Array(25).fill("folder").join("/");
      expect(() => buildFolderReference(deepPath)).toThrow("maximum nesting depth");
    });

    it("rejects excessively long folder paths", () => {
      const longPath = "a".repeat(1001);
      expect(() => buildFolderReference(longPath)).toThrow("maximum length");
    });

    it("escapes folder names with double quotes", () => {
      const result = buildFolderReference('My "Special" Folder');
      expect(result).toContain('\\"');
      expect(result).not.toContain('"Special"');
    });

    it("handles folder names with emoji", () => {
      const result = buildFolderReference("Food & Drink/\uD83C\uDF72 Recipes");
      expect(result).toContain("folder");
      expect(result).toContain("of");
    });
  });

  describe("ID-based operations sanitize input", () => {
    it("getNoteById rejects malformed IDs", () => {
      expect(() => {
        manager.getNoteById('malicious" & do shell script "echo pwned');
      }).toThrow("Invalid note ID format");
    });

    it("getNoteContentById rejects malformed IDs", () => {
      expect(() => {
        manager.getNoteContentById("arbitrary string");
      }).toThrow("Invalid note ID format");
    });

    it("updateNoteByIdIfUnchanged rejects malformed IDs", () => {
      expect(() => {
        manager.updateNoteByIdIfUnchanged(
          "not-valid",
          "Title",
          "<div>Body</div>",
          undefined,
          "content"
        );
      }).toThrow("Invalid note ID format");
    });

    it("deleteNoteByIdIfUnchanged rejects malformed IDs", () => {
      expect(() => {
        manager.deleteNoteByIdIfUnchanged(
          'x-coredata://test"; delete note 1 & "',
          "<div>Body</div>"
        );
      }).toThrow("Invalid note ID format");
    });

    it("moveNoteById rejects malformed IDs", () => {
      expect(() => {
        manager.moveNoteById("not-valid", "Archive");
      }).toThrow("Invalid note ID format");
    });

    // #146: batchMoveNotes validated with the looser sanitizeId (accepts any
    // ICEntity, plus legacy temp-* ids), unlike every other #144-hardened
    // mutation — bring it in line with moveNoteById's sanitizeNoteId.
    it("batchMoveNotes rejects a non-ICNote CoreData ID as a per-item failure, without spawning osascript", () => {
      const results = manager.batchMoveNotes(
        ["x-coredata://ABC123/ICFolder/p50", "temp-1704067200000-0"],
        "Archive"
      );
      expect(mockExecuteAppleScript).not.toHaveBeenCalled();
      expect(results[0]).toEqual({
        id: "x-coredata://ABC123/ICFolder/p50",
        success: false,
        error: expect.stringContaining("Invalid note ID format"),
      });
      expect(results[1]).toEqual({
        id: "temp-1704067200000-0",
        success: false,
        error: expect.stringContaining("Invalid note ID format"),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getNoteLinkById
  // ---------------------------------------------------------------------------

  describe("getNoteLinkById", () => {
    const VALID_ID = "x-coredata://ABC123/ICNote/p50338";

    it("returns null immediately for a password-protected note without calling executeAppleScript for the link", () => {
      // First call: getNoteById (returns a protected note)
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          "Locked Note",
          VALID_ID,
          "2025-12-27-15-0-0",
          "2025-12-27-15-0-0",
          "false",
          "true", // passwordProtected = true
        ].join(F),
      });

      const result = manager.getNoteLinkById(VALID_ID);

      expect(result).toBeNull();
      // The link-fetching AppleScript (note link property) must NOT be called
      // — the function should bail out after the password check.
      const calls = mockExecuteAppleScript.mock.calls;
      // Only one call: getNoteById
      expect(calls).toHaveLength(1);
    });

    it("returns null when the note is not found", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Can't get note id",
      });

      const result = manager.getNoteLinkById(VALID_ID);

      expect(result).toBeNull();
    });

    it("returns a notes:// URL for a valid, non-protected note", () => {
      // getNoteById returns a non-protected note
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: [
          "My Note",
          VALID_ID,
          "2025-12-27-15-0-0",
          "2025-12-27-15-0-0",
          "false",
          "false",
        ].join(F),
      });
      // SQLite path (getNoteLinkFromDB) may succeed (if the Notes DB is
      // accessible on the test machine) or fail and fall through to the
      // AppleScript fallback.  Mock the AppleScript fallback so it can
      // return a URL in the fallback-path case.
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: "notes://showNote?identifier=ABCD-1234-5678",
      });

      const result = manager.getNoteLinkById(VALID_ID);

      // Either the SQLite path or the AppleScript fallback should return
      // a notes:// URL — either form is acceptable.
      expect(result).not.toBeNull();
      expect(result).toMatch(/^notes:\/\/showNote\?identifier=/);
    });
  });
});

describe("getNoteLinkFromDB — CoreData PK parsing", () => {
  // getNoteLinkFromDB is module-private, but we can verify the PK extraction
  // logic indirectly by checking that getNoteLinkById passes the right primary
  // key to the database query.  We test the regex rule by covering the
  // CoreData ID formats the function must handle.

  it("sanitizeId accepts the x-coredata URL used by getNoteLinkById", () => {
    // If sanitizeId throws, getNoteLinkById would not even reach the DB call.
    // This assertion confirms the ID format is considered valid.
    expect(() => sanitizeId("x-coredata://ABC123/ICNote/p50338")).not.toThrow();
  });

  it("sanitizeId rejects IDs without a /p<digits> suffix", () => {
    expect(() => sanitizeId("x-coredata://ABC123/ICNote/pXXX")).toThrow("Invalid note ID format");
  });
});

describe("htmlToPlaintext (export helper)", () => {
  // htmlToPlaintext is a private, pure string transform used by exportNote; it
  // touches no AppleScript, so we exercise it directly through a cast.
  const toPlaintext = (html: string): string =>
    (
      new AppleNotesManager() as unknown as {
        htmlToPlaintext(h: string): string;
      }
    ).htmlToPlaintext(html);

  it("decodes the basic HTML entities", () => {
    expect(toPlaintext("a &amp; b")).toBe("a & b");
    expect(toPlaintext("&lt;tag&gt;")).toBe("<tag>");
    expect(toPlaintext("say &quot;hi&quot;")).toBe('say "hi"');
    expect(toPlaintext("path&#92;file")).toBe("path\\file");
    expect(toPlaintext("a&nbsp;b")).toBe("a b");
  });

  it("decodes &amp; last so encoded entities round-trip (no double-unescape)", () => {
    // The literal text "&lt;" is stored in HTML as "&amp;lt;" and must decode
    // back to "&lt;", NOT be double-unescaped to "<".
    expect(toPlaintext("&amp;lt;")).toBe("&lt;");
    expect(toPlaintext("&amp;gt;")).toBe("&gt;");
    expect(toPlaintext("&amp;amp;")).toBe("&amp;");
    expect(toPlaintext("&amp;nbsp;")).toBe("&nbsp;");
  });

  it("converts block/line tags to newlines and strips other tags", () => {
    expect(toPlaintext("one<br>two")).toBe("one\ntwo");
    expect(toPlaintext("<div>a</div><div>b</div>")).toBe("a\nb");
    expect(toPlaintext("<p>x</p><p>y</p>")).toBe("x\ny");
    expect(toPlaintext("<b>bold</b>")).toBe("bold");
  });

  it("collapses 3+ newlines and trims surrounding whitespace", () => {
    expect(toPlaintext("a<br><br><br><br>b")).toBe("a\n\nb");
    expect(toPlaintext("  <div>x</div>  ")).toBe("x");
  });

  it("strips nested/overlapping tags without leaving a tag (iterated strip)", () => {
    // A single pass can leave residue when removing one tag re-forms another;
    // the loop keeps stripping until no <...> remains.
    expect(toPlaintext("a<<i>>b")).not.toMatch(/<[^>]*>/);
    expect(toPlaintext("<x<y>z>")).not.toMatch(/<[^>]*>/);
    expect(toPlaintext("plain <b>text</b> here")).toBe("plain text here");
  });
});

describe("getAudioTranscripts", () => {
  it("delegates to the read-only transcript reader with the caller's options", () => {
    const result = {
      id: "x-coredata://S/ICNote/p1",
      attachments: [],
      bodyOrder: true,
      truncated: false,
    };
    mockReadAudioTranscripts.mockReturnValueOnce(result);
    const manager = new AppleNotesManager();
    expect(
      manager.getAudioTranscripts("x-coredata://S/ICNote/p1", {
        includeSegments: true,
        maxSegments: 5,
      })
    ).toBe(result);
    expect(mockReadAudioTranscripts).toHaveBeenCalledWith("x-coredata://S/ICNote/p1", {
      includeSegments: true,
      maxSegments: 5,
    });
  });
});
