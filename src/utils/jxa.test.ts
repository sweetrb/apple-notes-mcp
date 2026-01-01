/**
 * Tests for JXA Execution Utilities
 *
 * These tests verify the JXA executor and compare behavior with AppleScript.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeJXA, escapeForJXA, buildNotesJXA } from "./jxa.js";

// Mock execSync to avoid actual osascript calls
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
const mockExecSync = vi.mocked(execSync);

describe("escapeForJXA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeForJXA("")).toBe("");
    expect(escapeForJXA(null as unknown as string)).toBe("");
    expect(escapeForJXA(undefined as unknown as string)).toBe("");
  });

  it("escapes backslashes", () => {
    expect(escapeForJXA("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes double quotes", () => {
    expect(escapeForJXA('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes newlines", () => {
    expect(escapeForJXA("line1\nline2")).toBe("line1\\nline2");
  });

  it("escapes tabs", () => {
    expect(escapeForJXA("col1\tcol2")).toBe("col1\\tcol2");
  });

  it("handles complex content", () => {
    const input = 'John said "Hello\\World"\nNew line';
    const expected = 'John said \\"Hello\\\\World\\"\\nNew line';
    expect(escapeForJXA(input)).toBe(expected);
  });

  it("preserves single quotes (no escaping needed in double-quoted JS strings)", () => {
    expect(escapeForJXA("it's working")).toBe("it's working");
  });

  it("preserves unicode characters", () => {
    expect(escapeForJXA("日本語 🎉")).toBe("日本語 🎉");
  });
});

describe("executeJXA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for empty script", () => {
    const result = executeJXA("");
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("executes JXA script via osascript", () => {
    mockExecSync.mockReturnValue("test output\n");

    const result = executeJXA("JSON.stringify({test: true})");

    expect(result.success).toBe(true);
    expect(result.output).toBe("test output");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("-l JavaScript"),
      expect.any(Object)
    );
  });

  it("handles execution errors", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("Error: Cannot find note");
    });

    const result = executeJXA("Notes.notes()");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot find note");
  });

  it("handles timeout errors", () => {
    const error = new Error("Command failed") as Error & { killed: boolean };
    error.killed = true;
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const result = executeJXA("longRunningScript()", { timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("buildNotesJXA", () => {
  it("wraps code with Notes application context", () => {
    const code = "Notes.accounts().map(a => a.name())";
    const script = buildNotesJXA(code);

    expect(script).toContain('Application("Notes")');
    expect(script).toContain(code);
  });
});

// =============================================================================
// Comparison Tests: JXA vs AppleScript Escaping
// =============================================================================

describe("JXA vs AppleScript escaping comparison", () => {
  it("JXA handles single quotes without special escaping", () => {
    // In AppleScript, single quotes need shell escaping: '\''
    // In JXA, single quotes are fine in double-quoted strings
    const input = "it's Rob's note";
    const escaped = escapeForJXA(input);
    expect(escaped).toBe("it's Rob's note"); // No change needed
  });

  it("JXA uses standard escape sequences for control chars", () => {
    // AppleScript converts to HTML (<br>) for Notes.app
    // JXA uses standard \n which may need conversion for Notes
    const input = "line1\nline2";
    const escaped = escapeForJXA(input);
    expect(escaped).toBe("line1\\nline2");
  });

  it("JXA handles backslashes with standard escaping", () => {
    // AppleScript needs HTML entity encoding (&#92;) for Notes.app
    // JXA uses standard \\ escaping
    const input = "path\\to\\file";
    const escaped = escapeForJXA(input);
    expect(escaped).toBe("path\\\\to\\\\file");
  });
});
