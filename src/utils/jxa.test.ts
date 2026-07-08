/**
 * Tests for JXA Execution Utilities
 *
 * These tests verify the JXA executor and compare behavior with AppleScript.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeJXA, escapeForJXA, buildNotesJXA } from "./jxa.js";

// Mock execFileSync to avoid actual osascript calls
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
const mockExecFileSync = vi.mocked(execFileSync);

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
    mockExecFileSync.mockReturnValue("test output\n");

    const result = executeJXA("JSON.stringify({test: true})");

    expect(result.success).toBe(true);
    expect(result.output).toBe("test output");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-"],
      expect.objectContaining({ input: "JSON.stringify({test: true})" })
    );
  });

  it("handles execution errors", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Error: Cannot find note");
    });

    const result = executeJXA("Notes.notes()");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot find note");
  });

  describe("hardened executor (#16/#17)", () => {
    afterEach(() => {
      delete process.env.APPLE_NOTES_MCP_MAX_BUFFER;
    });

    it("passes SIGKILL and a large maxBuffer to execFileSync", () => {
      mockExecFileSync.mockReturnValue("ok");
      executeJXA("JSON.stringify({})");
      const opts = mockExecFileSync.mock.calls[0][2] as { killSignal?: string; maxBuffer?: number };
      expect(opts.killSignal).toBe("SIGKILL");
      expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
    });

    it("honors APPLE_NOTES_MCP_MAX_BUFFER override", () => {
      process.env.APPLE_NOTES_MCP_MAX_BUFFER = "2097152";
      mockExecFileSync.mockReturnValue("ok");
      executeJXA("JSON.stringify({})");
      const opts = mockExecFileSync.mock.calls[0][2] as { maxBuffer?: number };
      expect(opts.maxBuffer).toBe(2097152);
    });
  });

  it("handles timeout errors (ETIMEDOUT + SIGKILL, the real sync-exec shape)", () => {
    const error = new Error("spawnSync osascript ETIMEDOUT") as Error & {
      code: string;
      signal: string;
    };
    error.code = "ETIMEDOUT";
    error.signal = "SIGKILL";
    mockExecFileSync.mockImplementation(() => {
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
