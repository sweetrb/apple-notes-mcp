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
  parseAppleScriptDate,
} from "./appleNotesManager.js";

// Mock the AppleScript execution module
// This prevents actual osascript calls during testing
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

import { executeAppleScript } from "@/utils/applescript.js";
const mockExecuteAppleScript = vi.mocked(executeAppleScript);

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
// AppleNotesManager Tests
// =============================================================================

describe("AppleNotesManager", () => {
  let manager: AppleNotesManager;

  beforeEach(() => {
    manager = new AppleNotesManager();
    vi.clearAllMocks();
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
  });

  // ---------------------------------------------------------------------------
  // Note Search
  // ---------------------------------------------------------------------------

  describe("searchNotes", () => {
    it("returns array of matching notes with folder info", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          "Meeting Notes|||x-coredata://ABC/ICNote/p1|||Work|||ITEM|||Project Plan|||x-coredata://ABC/ICNote/p2|||Notes|||ITEM|||Weekly Review|||x-coredata://ABC/ICNote/p3|||Archive",
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

    it("returns empty array on AppleScript error", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Search failed",
      });

      const results = manager.searchNotes("test");

      expect(results).toHaveLength(0);
    });

    it("searches content when searchContent is true", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Note with keyword|||x-coredata://ABC/ICNote/p1|||Notes",
      });

      manager.searchNotes("project alpha", true);

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('body contains "project alpha"')
      );
    });

    it("searches titles when searchContent is false", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Project Alpha Notes|||x-coredata://ABC/ICNote/p1|||Notes",
      });

      manager.searchNotes("Project Alpha", false);

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('name contains "Project Alpha"')
      );
    });

    it("identifies notes in Recently Deleted folder", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          "Old Note|||x-coredata://ABC/ICNote/p1|||Recently Deleted|||ITEM|||Active Note|||x-coredata://ABC/ICNote/p2|||Notes",
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
        output: "Work Note|||x-coredata://ABC/ICNote/p1|||Work",
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

  // ---------------------------------------------------------------------------
  // Password Protection Helpers
  // ---------------------------------------------------------------------------

  describe("isNotePasswordProtected", () => {
    it("returns true when note is password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          "Locked Note, x-coredata://ABC/ICNote/p1, date Monday, January 1, 2024 at 12:00:00 PM, date Monday, January 1, 2024 at 12:00:00 PM, false, true",
      });

      const result = manager.isNotePasswordProtected("Locked Note");

      expect(result).toBe(true);
    });

    it("returns false when note is not password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          "Open Note, x-coredata://ABC/ICNote/p2, date Monday, January 1, 2024 at 12:00:00 PM, date Monday, January 1, 2024 at 12:00:00 PM, false, false",
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
        output:
          "Locked Note, x-coredata://ABC/ICNote/p1, date Monday, January 1, 2024 at 12:00:00 PM, date Monday, January 1, 2024 at 12:00:00 PM, false, true",
      });

      const result = manager.isNotePasswordProtectedById("x-coredata://ABC/ICNote/p1");

      expect(result).toBe(true);
    });

    it("returns false when note is not password-protected", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output:
          "Open Note, x-coredata://ABC/ICNote/p2, date Monday, January 1, 2024 at 12:00:00 PM, date Monday, January 1, 2024 at 12:00:00 PM, false, false",
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

      const result = manager.isNotePasswordProtectedById("x-coredata://invalid");

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
        output:
          "My Note, x-coredata://ABC123/ICNote/p100, date Saturday, December 27, 2025 at 3:00:00 PM, date Saturday, December 27, 2025 at 4:00:00 PM, false, false",
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

      const result = manager.getNoteById("x-coredata://invalid");

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
        output:
          "Shared Note, x-coredata://ABC/ICNote/p1, date Monday, January 1, 2025 at 12:00:00 PM, date Monday, January 1, 2025 at 12:00:00 PM, true, true",
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
        output:
          "Project Notes, x-coredata://ABC123/ICNote/p200, date Friday, December 20, 2025 at 10:00:00 AM, date Saturday, December 27, 2025 at 2:30:00 PM, false, false",
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
        output:
          "Note, id123, date Monday, January 1, 2025 at 12:00:00 PM, date Monday, January 1, 2025 at 12:00:00 PM, false, false",
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
        output:
          "Shared Doc, id456, date Monday, January 1, 2025 at 12:00:00 PM, date Monday, January 1, 2025 at 12:00:00 PM, true, false",
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
  });

  // ---------------------------------------------------------------------------
  // Note Listing
  // ---------------------------------------------------------------------------

  describe("listNotes", () => {
    it("returns array of note titles", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Note A, Note B, Note C",
      });

      const titles = manager.listNotes();

      expect(titles).toEqual(["Note A", "Note B", "Note C"]);
    });

    it("filters out empty entries", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Note A, , Note B, , ",
      });

      const titles = manager.listNotes();

      expect(titles).toEqual(["Note A", "Note B"]);
    });

    it("returns empty array on failure", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Account not found",
      });

      const titles = manager.listNotes();

      expect(titles).toEqual([]);
    });

    it("filters by folder when specified", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Work Note 1, Work Note 2",
      });

      manager.listNotes("iCloud", "Work");

      expect(mockExecuteAppleScript).toHaveBeenCalledWith(
        expect.stringContaining('notes of folder "Work"')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Folder Operations
  // ---------------------------------------------------------------------------

  describe("listFolders", () => {
    it("returns array of Folder objects", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Notes, Archive, Work",
      });

      const folders = manager.listFolders();

      expect(folders).toHaveLength(3);
      expect(folders[0].name).toBe("Notes");
      expect(folders[1].name).toBe("Archive");
      expect(folders[2].name).toBe("Work");
    });

    it("includes account in Folder objects", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "Notes",
      });

      const folders = manager.listFolders("Gmail");

      expect(folders[0].account).toBe("Gmail");
    });
  });

  describe("createFolder", () => {
    it("returns Folder object on success", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "folder id x-coredata://ABC123/ICFolder/p456",
      });

      const result = manager.createFolder("New Project");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("New Project");
      expect(result?.id).toBe("x-coredata://ABC123/ICFolder/p456");
    });

    it("returns null on failure", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Folder already exists",
      });

      const result = manager.createFolder("Existing Folder");

      expect(result).toBeNull();
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
    it("returns true when move completes successfully", () => {
      // Mock sequence: getNoteDetails -> getNoteContent -> createNote -> deleteNote
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output:
            "My Note, x-coredata://ABC/ICNote/p123, date Monday January 1 2024, date Monday January 1 2024, false, false",
        })
        .mockReturnValueOnce({
          success: true,
          output: "<div>Note Title</div><div>Content</div>",
        })
        .mockReturnValueOnce({
          success: true,
          output: "note id x-coredata://...",
        })
        .mockReturnValueOnce({
          success: true,
          output: "",
        });

      const result = manager.moveNote("My Note", "Archive");

      expect(result).toBe(true);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(4);
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

    it("returns false when copy to destination fails", () => {
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output:
            "My Note, x-coredata://ABC/ICNote/p123, date Monday January 1 2024, date Monday January 1 2024, false, false",
        })
        .mockReturnValueOnce({
          success: true,
          output: "<div>Content</div>",
        })
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "Folder not found",
        });

      const result = manager.moveNote("My Note", "Nonexistent Folder");

      expect(result).toBe(false);
      expect(mockExecuteAppleScript).toHaveBeenCalledTimes(3); // Details + Read + failed create
    });

    it("returns true even if delete fails (note exists in new location)", () => {
      // This is partial success - note was copied but original couldn't be deleted
      mockExecuteAppleScript
        .mockReturnValueOnce({
          success: true,
          output:
            "My Note, x-coredata://ABC/ICNote/p123, date Monday January 1 2024, date Monday January 1 2024, false, false",
        })
        .mockReturnValueOnce({
          success: true,
          output: "<div>Content</div>",
        })
        .mockReturnValueOnce({
          success: true,
          output: "note id x-coredata://...",
        })
        .mockReturnValueOnce({
          success: false,
          output: "",
          error: "Cannot delete original",
        });

      const result = manager.moveNote("My Note", "Archive");

      // Should still return true because the note exists in the destination
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Account Operations
  // ---------------------------------------------------------------------------

  describe("listAccounts", () => {
    it("returns array of Account objects", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: true,
        output: "iCloud, Gmail, Exchange",
      });

      const accounts = manager.listAccounts();

      expect(accounts).toHaveLength(3);
      expect(accounts[0].name).toBe("iCloud");
      expect(accounts[1].name).toBe("Gmail");
      expect(accounts[2].name).toBe("Exchange");
    });

    it("returns empty array on failure", () => {
      mockExecuteAppleScript.mockReturnValue({
        success: false,
        output: "",
        error: "Notes.app not available",
      });

      const accounts = manager.listAccounts();

      expect(accounts).toEqual([]);
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
        .mockReturnValueOnce({ success: true, output: "Note 1, Note 2" });

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
        .mockReturnValueOnce({ success: true, output: "iCloud, Gmail" })
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
        // listFolders for iCloud
        .mockReturnValueOnce({ success: true, output: "Notes, Work" })
        // listNotes for Notes folder
        .mockReturnValueOnce({ success: true, output: "Note 1, Note 2, Note 3" })
        // listNotes for Work folder
        .mockReturnValueOnce({ success: true, output: "Task 1, Task 2" })
        // getRecentlyModifiedCounts
        .mockReturnValueOnce({ success: true, output: "" });

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
        .mockReturnValueOnce({ success: true, output: "Notes" })
        .mockReturnValueOnce({ success: true, output: "" })
        .mockReturnValueOnce({ success: true, output: "" });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(0);
      expect(stats.recentlyModified.last24h).toBe(0);
      expect(stats.recentlyModified.last7d).toBe(0);
      expect(stats.recentlyModified.last30d).toBe(0);
    });

    it("handles multiple accounts", () => {
      mockExecuteAppleScript
        // listAccounts
        .mockReturnValueOnce({ success: true, output: "iCloud, Gmail" })
        // listFolders for iCloud
        .mockReturnValueOnce({ success: true, output: "Notes" })
        // listNotes for iCloud/Notes
        .mockReturnValueOnce({ success: true, output: "Note 1" })
        // listFolders for Gmail
        .mockReturnValueOnce({ success: true, output: "Notes" })
        // listNotes for Gmail/Notes
        .mockReturnValueOnce({ success: true, output: "Email Note" })
        // getRecentlyModifiedCounts
        .mockReturnValueOnce({ success: true, output: "" });

      const stats = manager.getNotesStats();

      expect(stats.totalNotes).toBe(2);
      expect(stats.accounts).toHaveLength(2);
      expect(stats.accounts[0].name).toBe("iCloud");
      expect(stats.accounts[1].name).toBe("Gmail");
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment Listing
  // ---------------------------------------------------------------------------

  describe("listAttachmentsById", () => {
    it("returns attachments for a note", () => {
      mockExecuteAppleScript.mockReturnValueOnce({
        success: true,
        output:
          "x-coredata://ABC/ICAttachment/p1|||photo.jpg|||public.jpegITEMx-coredata://ABC/ICAttachment/p2|||document.pdf|||com.adobe.pdfITEM",
      });

      const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");

      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toEqual({
        id: "x-coredata://ABC/ICAttachment/p1",
        name: "photo.jpg",
        contentType: "public.jpeg",
      });
      expect(attachments[1]).toEqual({
        id: "x-coredata://ABC/ICAttachment/p2",
        name: "document.pdf",
        contentType: "com.adobe.pdf",
      });
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
        output: "attach-id|||image.png|||public.pngITEM",
      });

      const attachments = manager.listAttachments("My Note");

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        id: "attach-id",
        name: "image.png",
        contentType: "public.png",
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
});
