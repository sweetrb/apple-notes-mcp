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
import {
  AppleNotesManager,
  escapeForAppleScript,
  escapeHtmlForAppleScript,
  buildAppleScriptDateVar,
  buildFolderReference,
  splitFolderPath,
  parseAppleScriptDate,
  sanitizeId,
} from "./appleNotesManager.js";

// Mock the AppleScript execution module
// This prevents actual osascript calls during testing
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

// Mock the checklist parser to avoid SQLite access during tests
vi.mock("@/utils/checklistParser.js", () => ({
  getChecklistItems: vi.fn().mockReturnValue({ items: null }),
}));

import { executeAppleScript } from "@/utils/applescript.js";
const mockExecuteAppleScript = vi.mocked(executeAppleScript);

import { getChecklistItems } from "@/utils/checklistParser.js";
const mockGetChecklistItems = vi.mocked(getChecklistItems);

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

  describe("listAttachments — security", () => {
    it("escapes the account name so it cannot break out of the AppleScript literal (injection regression)", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });
      manager.listAttachments("My Note", 'evil" injected');
      const script = String(mockExecuteAppleScript.mock.calls.at(-1)?.[0]);
      // The account's double-quote must be escaped (\\") — a raw quote would
      // terminate the tell-account string literal and allow `do shell script` injection.
      expect(script).toContain('tell account "evil\\" injected"');
      expect(script).not.toContain('tell account "evil" injected"');
    });
  });

  // ---------------------------------------------------------------------------
  // Note Creation
  // ---------------------------------------------------------------------------

  describe("createNote", () => {
    it("returns Note object on successful creation", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://12345/ICNote/p100",
      });

      const result = manager.createNote("Shopping List", "Eggs, Milk, Bread");

      expect(result).not.toBeNull();
      expect(result?.title).toBe("Shopping List");
      expect(result?.content).toBe("Eggs, Milk, Bread");
      expect(result?.account).toBe("iCloud"); // Default account
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
        output: "note id x-coredata://...",
      });

      const result = manager.createNote("Draft", "Email content", [], undefined, "Gmail");

      expect(result?.account).toBe("Gmail");
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('tell account "Gmail"')
      );
    });

    it("creates note in specified folder", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://...",
      });

      manager.createNote("Work Note", "Content", [], "Work Projects");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('at folder "Work Projects"')
      );
    });

    it("stores tags in returned Note object", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "note id x-coredata://...",
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
        expect.stringContaining("<h2>Heading</h2><div>Body text</div>")
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
        expect.stringContaining("Simple text with<br>newline")
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
        expect.stringContaining('<div class=\\"test\\">Content</div>')
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
        expect.stringContaining("<h1>Q&amp;A: &lt;Hello&gt; World</h1>")
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
        expect.stringContaining('tell account "Exchange"')
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
      expect(script).toContain('tell account "Exchange"');
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
      expect(script).not.toContain("modification date");
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
      expect(script).toContain('tell account "iCloud"');
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
        expect.stringContaining('tell account "Gmail"')
      );
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
        expect.stringContaining('tell account "Gmail"')
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
      expect(result?.account).toBe("iCloud");
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
        expect.stringContaining('tell account "Exchange"')
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

  // ---------------------------------------------------------------------------
  // Note Deletion
  // ---------------------------------------------------------------------------

  describe("deleteNote", () => {
    it("returns true on successful deletion", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const result = manager.deleteNote("Old Note");

      expect(result).toBe(true);
    });

    it("returns false when deletion fails", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Cannot delete protected note",
      });

      const result = manager.deleteNote("Protected Note");

      expect(result).toBe(false);
    });

    it("uses specified account", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.deleteNote("Draft", "Gmail");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('tell account "Gmail"')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Note Updates
  // ---------------------------------------------------------------------------

  describe("updateNote", () => {
    it("returns true on successful update", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const result = manager.updateNote("Old Title", "New Title", "Updated content");

      expect(result).toBe(true);
    });

    it("returns false when update fails", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Note not found",
      });

      const result = manager.updateNote("Missing", "New Title", "Content");

      expect(result).toBe(false);
    });

    it("preserves original title when newTitle is undefined", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.updateNote("Keep This Title", undefined, "New content only");

      // The generated body should use the original title
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("<div>Keep This Title</div>")
      );
    });

    it("uses new title when provided", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.updateNote("Old Title", "Brand New Title", "Content");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("<div>Brand New Title</div>")
      );
    });

    it("uses HTML content directly when format is html", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      // Use content with &amp; — if escapeForAppleScript were accidentally used,
      // the & in &amp; would become &amp;amp;, causing this assertion to fail.
      const htmlContent = "<h1>Title</h1><div>A &amp; B</div>";
      const result = manager.updateNote("Old Title", undefined, htmlContent, undefined, "html");

      expect(result).toBe(true);
      // In HTML mode: content is used as-is, no <div> wrapper added
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining(`to "${htmlContent}"`)
      );
    });

    it("does not wrap HTML content in div tags when format is html", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.updateNote(
        "Old Title",
        undefined,
        "<h1>My Title</h1><div>Content</div>",
        undefined,
        "html"
      );

      // Should NOT contain the <div>Old Title</div> wrapper
      expect(mockExecuteAppleScript).not.toHaveBeenCalledWith(
        expect.stringContaining("<div>Old Title</div>")
      );
    });

    it("still wraps in div tags when format is plaintext (default)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.updateNote("My Title", undefined, "Plain content");

      // Default behavior: should have <div> wrapper
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("<div>My Title</div><div>Plain content</div>")
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Note Update by ID
  // ---------------------------------------------------------------------------

  describe("updateNoteById", () => {
    it("uses HTML content directly without div wrapping in HTML mode", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const htmlContent = "<h1>My Title</h1><div>A &amp; B</div>";
      const result = manager.updateNoteById(
        "x-coredata://ABC00000-0000-0000-0000-000000000001/ICNote/p123",
        undefined,
        htmlContent,
        "html"
      );

      expect(result).toBe(true);
      // HTML mode: content passed directly, no <div> wrapper
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining(`to "${htmlContent}"`)
      );
      // Should NOT contain the div-wrapped title pattern
      expect(mockExecuteAppleScript).not.toHaveBeenCalledWith(
        expect.stringContaining("<div>My Title</div>")
      );
    });

    it("does not call getNoteById in HTML mode (skips lookup optimization)", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      const htmlContent = "<h1>Title</h1><div>Body</div>";
      manager.updateNoteById(
        "x-coredata://ABC00000-0000-0000-0000-000000000002/ICNote/p456",
        undefined,
        htmlContent,
        "html"
      );

      // In HTML mode, getNoteById should NOT be called (it would trigger
      // an additional executeAppleScript call). Only one call should happen:
      // the update itself.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
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

    it("uses whose clause when modifiedSince is provided", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Recent Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Recent Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, "2025-06-15T00:00:00");

      const script = mockExecuteAppleScript.mock.calls[0][0];
      // Locale-safe: uses variable setup + whose clause (no sort order assumption)
      expect(script).toContain("set thresholdDate to current date");
      expect(script).toContain("set year of thresholdDate to 2025");
      expect(script).toContain("set month of thresholdDate to 6");
      expect(script).toContain("set day of thresholdDate to 15");
      expect(script).toContain("whose modification date >= thresholdDate");
      expect(results).toEqual(["Recent Note 1", "Recent Note 2"]);
    });

    it("uses repeat loop when limit is provided", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: [
          ["Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
          ["Note 3", "x-coredata://ABC/ICNote/p3"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, undefined, 3);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).toContain("(count of resultList) >= 3");
      expect(results).toEqual(["Note 1", "Note 2", "Note 3"]);
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
      expect(script).toContain("whose modification date >= thresholdDate");
      expect(script).toContain('notes of folder "Work"');
      expect(script).toContain("(count of resultList) >= 10");
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
          ["Note 1", "x-coredata://ABC/ICNote/p1"].join(F),
          ["Note 2", "x-coredata://ABC/ICNote/p2"].join(F),
        ].join(R),
      });

      const results = manager.listNotes(undefined, undefined, "not-a-date", 5);

      const script = mockExecuteAppleScript.mock.calls[0][0];
      expect(script).not.toContain("thresholdDate");
      expect(script).toContain("(count of resultList) >= 5");
      expect(results).toEqual(["Note 1", "Note 2"]);
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
      expect(calls[3][0]).toContain(
        'make new folder at folder "Retro Tech" with properties {name:"PC"}'
      );
      expect(calls[5][0]).toContain(
        'make new folder at folder "PC" of folder "Retro Tech" with properties {name:"CPUs"}'
      );
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
  });

  // ---------------------------------------------------------------------------
  // Note Moving
  // ---------------------------------------------------------------------------

  describe("moveNote", () => {
    // The note-details lookup output reused by the title-based move tests.
    const detailsOutput = [
      "My Note",
      "x-coredata://ABC/ICNote/p123",
      "Monday, January 1, 2024 at 12:00:00 PM",
      "Monday, January 1, 2024 at 12:00:00 PM",
      "false",
      "false",
    ].join(F);

    it("returns true when the native move completes successfully", () => {
      // Mock sequence: getNoteDetails (resolve id) -> native move
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: detailsOutput })
        .mockReturnValueOnce({ success: true, output: "" });

      const result = manager.moveNote("My Note", "Archive");

      expect(result).toBe(true);
      // No copy-then-delete: just the details lookup + a single native `move`.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2);
    });

    it("uses the native AppleScript `move` command (preserves attachments/identity)", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: detailsOutput })
        .mockReturnValueOnce({ success: true, output: "" });

      manager.moveNote("My Note", "Archive");

      // The second call is the move; assert it issues a native `move ... to` and
      // does NOT rebuild the note via `make new note` (the old lossy path).
      const moveScript = mockExecuteAppleScript.mock.calls[1][0] as string;
      expect(moveScript).toContain("move noteRef to destFolder");
      expect(moveScript).not.toContain("make new note");
    });

    it("returns false when source note cannot be found", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Note not found",
      });

      const result = manager.moveNote("Missing Note", "Archive");

      expect(result).toBe(false);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1); // Only tried to get details
    });

    it("returns false when the move fails (e.g. destination folder missing)", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({ success: true, output: detailsOutput })
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "Folder not found",
        });

      const result = manager.moveNote("My Note", "Nonexistent Folder");

      expect(result).toBe(false);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(2); // Details + failed move
    });
  });

  describe("moveNoteById", () => {
    it("returns true when the native move succeeds", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      const result = manager.moveNoteById("x-coredata://ABC/ICNote/p123", "Archive");

      expect(result).toBe(true);
      // Single native `move` — no getNoteContentById/create/delete fan-out.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      const moveScript = mockExecuteAppleScript.mock.calls[0][0] as string;
      expect(moveScript).toContain("move noteRef to destFolder");
      expect(moveScript).not.toContain("make new note");
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
        expect.stringContaining('show note id "x-coredata://ABC/ICNote/p1"')
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "",
      });

      manager.showNoteById("x-coredata://ABC/ICNote/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true")
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
        expect.stringContaining('show folder id "x-coredata://ABC/ICFolder/p1"')
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.showFolderById("x-coredata://ABC/ICFolder/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true")
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
        expect.stringContaining('show account id "x-coredata://ABC/ICAccount/p1"')
      );
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "" });

      manager.showAccountById("x-coredata://ABC/ICAccount/p1", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true")
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
      expect(script).toContain('is "att-123"');
      expect(script).toContain("show theAttachment");
    });

    it("can request a separate window", () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: "OK" });

      manager.showAttachmentById("x-coredata://ABC/ICNote/p1", "att-123", true);
      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining("separately true")
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

    it("returns empty array when note has no attachments", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toEqual([]);
    });

    it("returns empty array on error", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Note not found",
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p999");

      expect(attachments).toEqual([]);
    });

    it("generates correct AppleScript for ID lookup", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('note id "x-coredata://ABC/ICNote/p123"')
      );
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
        expect.stringContaining('account "Gmail"')
      );
    });

    it("defaults to iCloud account", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "" });

      manager.listAttachments("My Note");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('account "iCloud"')
      );
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

  describe("batchDeleteNotes", () => {
    const ID1 = "x-coredata://ABC00000-0000-0000-0000-000000000011/ICNote/p1";
    const ID2 = "x-coredata://ABC00000-0000-0000-0000-000000000012/ICNote/p2";

    it("deletes the whole batch in a single osascript spawn (#26)", () => {
      // One script handles all ids; per-id status tokens joined by RECORD_SEP.
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: ["ok", "ok"].join(R) + R,
      });

      const results = manager.batchDeleteNotes([ID1, ID2]);

      // Exactly one spawn for N notes, not 3N.
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: ID1, success: true });
      expect(results[1]).toEqual({ id: ID2, success: true });
    });

    it("returns error for non-existent note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "missing" + R });

      const results = manager.batchDeleteNotes([
        "x-coredata://ABC00000-0000-0000-0000-000000000099/ICNote/p404",
      ]);

      expect(results[0]).toEqual({
        id: "x-coredata://ABC00000-0000-0000-0000-000000000099/ICNote/p404",
        success: false,
        error: "Note not found",
      });
    });

    it("returns error for password-protected note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "pw" + R });

      const results = manager.batchDeleteNotes([ID1]);

      expect(results[0]).toEqual({ id: ID1, success: false, error: "Note is password-protected" });
    });

    it("handles mixed success and failure, preserving order", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output: ["ok", "missing"].join(R) + R,
      });

      const results = manager.batchDeleteNotes([ID1, ID2]);

      expect(results[0]).toEqual({ id: ID1, success: true });
      expect(results[1]).toEqual({ id: ID2, success: false, error: "Note not found" });
    });

    it("fails an invalid id without spawning, isolating it from valid ids", () => {
      mockExecuteAppleScript.mockReturnValueOnce({ success: true, output: "ok" + R });

      const results = manager.batchDeleteNotes(["not-a-valid-id", ID1]);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/Invalid note ID/);
      expect(results[1]).toEqual({ id: ID1, success: true });
    });

    it("fails the whole batch when the single script errors", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: false,
        output: "",
        error: "Notes.app not responding",
      });

      const results = manager.batchDeleteNotes([ID1, ID2]);

      expect(results.every((r) => r.success === false)).toBe(true);
      expect(results[0].error).toContain("Notes.app not responding");
    });

    it("returns [] for an empty batch without spawning", () => {
      const results = manager.batchDeleteNotes([]);
      expect(results).toEqual([]);
      expect(mockExecuteAppleScript).not.toHaveBeenCalled();
    });
  });

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

    it("deleteNoteById rejects malformed IDs", () => {
      expect(() => {
        manager.deleteNoteById('x-coredata://test"; delete note 1 & "');
      }).toThrow("Invalid note ID format");
    });

    it("getNoteContentById rejects malformed IDs", () => {
      expect(() => {
        manager.getNoteContentById("arbitrary string");
      }).toThrow("Invalid note ID format");
    });

    it("updateNoteById rejects malformed IDs", () => {
      expect(() => {
        manager.updateNoteById("not-valid", undefined, "content");
      }).toThrow("Invalid note ID format");
    });
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
