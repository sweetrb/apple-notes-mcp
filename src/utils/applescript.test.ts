/**
 * Tests for AppleScript execution utilities
 *
 * These tests mock the child_process.execFileSync function to avoid
 * requiring actual AppleScript execution during testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { executeAppleScript } from "./applescript.js";

// Mock the child_process module
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

/** The script passed to osascript over stdin on the given call. */
function scriptInput(call = 0): string {
  return (mockExecFileSync.mock.calls[call][2] as { input: string }).input;
}

/** The options object passed to execFileSync on the given call. */
function execOptions(call = 0): Record<string, unknown> {
  return mockExecFileSync.mock.calls[call][2] as Record<string, unknown>;
}

/**
 * Build an error shaped like a real sync-exec timeout: spawnSync surfaces
 * ETIMEDOUT with the configured killSignal (SIGKILL here), and there is no
 * `killed` flag on the sync API's error.
 */
function makeTimeoutError(): Error {
  const err = new Error("spawnSync osascript ETIMEDOUT") as Error & {
    code: string;
    signal: string;
  };
  err.code = "ETIMEDOUT";
  err.signal = "SIGKILL";
  return err;
}

describe("executeAppleScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful execution", () => {
    it("returns success result with trimmed output", () => {
      // Arrange: Mock a successful AppleScript execution
      mockExecFileSync.mockReturnValue("  Note Title  \n");

      // Act: Execute a simple script
      const result = executeAppleScript('tell app "Notes" to get name of note 1');

      // Assert: Output should be trimmed
      expect(result.success).toBe(true);
      expect(result.output).toBe("Note Title");
      expect(result.error).toBeUndefined();
    });

    it("preserves newlines within the script for AppleScript syntax", () => {
      mockExecFileSync.mockReturnValue("success");

      // Multi-line AppleScript with tell blocks
      const script = `
        tell application "Notes"
          tell account "iCloud"
            get notes
          end tell
        end tell
      `;

      executeAppleScript(script);

      // Verify the script was passed with newlines preserved
      expect(scriptInput()).toContain("tell application");
      expect(scriptInput()).toContain("end tell");
    });

    it("invokes osascript directly with the script on stdin (no shell)", () => {
      mockExecFileSync.mockReturnValue("content");

      // Script containing a single quote (e.g., in a note title)
      executeAppleScript('get note "Rob\'s Notes"');

      // osascript is called directly with "-" (read script from stdin)
      expect(mockExecFileSync.mock.calls[0][0]).toBe("osascript");
      expect(mockExecFileSync.mock.calls[0][1]).toEqual(["-"]);
      // The script goes over stdin verbatim: no shell, so no shell escaping
      expect(scriptInput()).toContain("Rob's Notes");
      expect(scriptInput()).not.toContain("'\\''");
    });
  });

  describe("hardened executor (#16/#17)", () => {
    afterEach(() => {
      delete process.env.APPLE_NOTES_MCP_MAX_BUFFER;
    });

    it("wraps the script in `with timeout` so Notes.app aborts cleanly", () => {
      mockExecFileSync.mockReturnValue("ok");
      executeAppleScript("get name of notes", { timeoutMs: 30000 });
      const script = scriptInput();
      expect(script).toContain("with timeout of");
      expect(script).toContain("end timeout");
      // 30s process timeout − 5s headroom = 25s script timeout
      expect(script).toContain("with timeout of 25 seconds");
    });

    it("passes SIGKILL and a large maxBuffer to execFileSync", () => {
      mockExecFileSync.mockReturnValue("ok");
      executeAppleScript("get name of notes");
      const opts = execOptions();
      expect(opts.killSignal).toBe("SIGKILL");
      expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
    });

    it("honors APPLE_NOTES_MCP_MAX_BUFFER override", () => {
      process.env.APPLE_NOTES_MCP_MAX_BUFFER = "1048576";
      mockExecFileSync.mockReturnValue("ok");
      executeAppleScript("get name of notes");
      expect(execOptions().maxBuffer).toBe(1048576);
    });
  });

  describe("error handling", () => {
    it("returns error result when execution fails", () => {
      // Arrange: Mock an AppleScript execution failure
      mockExecFileSync.mockImplementation(() => {
        throw new Error("execution error: Can't get note. (-1728)");
      });

      // Act: Try to execute a script that will fail
      const result = executeAppleScript('get note "Nonexistent"');

      // Assert: Should return structured error
      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toBeDefined();
    });

    it("parses execution error messages cleanly", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("execution error: Note not found (-1728)");
      });

      const result = executeAppleScript("get note 1");

      // Should extract the meaningful part of the error
      expect(result.error).toBe("Note not found");
    });

    it("handles 'not found' error patterns with user-friendly message", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Can\'t get note "Missing".');
      });

      const result = executeAppleScript('get note "Missing"');

      expect(result.error).toContain("not found");
      expect(result.error).toContain("Missing");
      expect(result.error).toContain("case-sensitive"); // Includes helpful hint
    });

    it("provides helpful message for permission errors", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("execution error: Not authorized to send Apple events (-1743)");
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Permission denied");
      expect(result.error).toContain("System Settings");
    });

    it("provides helpful message for folder not found", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Can\'t get folder "Work".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Work");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-folders");
    });

    it("provides helpful message for account not found", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Can\'t get account "Gmail".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Gmail");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-accounts");
    });

    it("handles non-Error exceptions gracefully", () => {
      mockExecFileSync.mockImplementation(() => {
        throw "string error"; // Some code throws strings
      });

      const result = executeAppleScript("some script");

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });

    it("handles unknown error types", () => {
      mockExecFileSync.mockImplementation(() => {
        throw { weird: "object" }; // Unusual but possible
      });

      const result = executeAppleScript("some script");

      expect(result.success).toBe(false);
      expect(result.error).toBe("AppleScript execution failed with unknown error");
    });
  });

  describe("input validation", () => {
    it("returns error for empty script", () => {
      const result = executeAppleScript("");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot execute empty AppleScript");
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it("returns error for whitespace-only script", () => {
      const result = executeAppleScript("   \n\t  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot execute empty AppleScript");
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe("execution options", () => {
    it("uses default 30 second timeout", () => {
      mockExecFileSync.mockReturnValue("ok");

      executeAppleScript("test");

      expect(execOptions().timeout).toBe(30000); // 30 second default timeout
    });

    it("allows custom timeout via options", () => {
      mockExecFileSync.mockReturnValue("ok");

      executeAppleScript("test", { timeoutMs: 60000 });

      expect(execOptions().timeout).toBe(60000); // Custom timeout
    });

    it("uses UTF-8 encoding for output", () => {
      mockExecFileSync.mockReturnValue("日本語テスト");

      const result = executeAppleScript("test");

      expect(result.output).toBe("日本語テスト");
      expect(execOptions().encoding).toBe("utf8");
    });
  });

  describe("timeout handling", () => {
    it("detects a real sync-exec timeout (ETIMEDOUT + SIGKILL, no killed flag)", () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeTimeoutError();
      });

      const result = executeAppleScript("test", { maxRetries: 1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out after 30 seconds");
      expect(result.error).toContain("Notes.app may be unresponsive");
    });

    it("still detects the async-exec timeout shape (killed=true, SIGTERM)", () => {
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecFileSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test", { maxRetries: 1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out after 30 seconds");
    });

    it("includes custom timeout value in error message", () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeTimeoutError();
      });

      const result = executeAppleScript("test", { timeoutMs: 60000, maxRetries: 1 });

      expect(result.error).toContain("timed out after 60 seconds");
    });

    it("honors APPLE_NOTES_MCP_TIMEOUT_MS when no per-call timeout is given", () => {
      vi.stubEnv("APPLE_NOTES_MCP_TIMEOUT_MS", "45000");
      mockExecFileSync.mockImplementation(() => {
        throw makeTimeoutError();
      });

      const result = executeAppleScript("test", { maxRetries: 1 });

      expect(result.error).toContain("timed out after 45 seconds");
      vi.unstubAllEnvs();
    });
  });

  describe("retry logic", () => {
    it("retries transient errors once by default (maxRetries=2)", () => {
      vi.stubEnv("APPLE_NOTES_MCP_RETRY_DELAY_MS", "1");
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      // Two attempts with default settings: the initial call plus one retry
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      vi.unstubAllEnvs();
    });

    it("APPLE_NOTES_MCP_MAX_RETRIES=1 restores fail-fast behavior", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "1");
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("per-call options override the env knobs", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "5");
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test", { maxRetries: 1 });

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("ignores an invalid APPLE_NOTES_MCP_MAX_RETRIES and uses the default", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "banana");
      vi.stubEnv("APPLE_NOTES_MCP_RETRY_DELAY_MS", "1");
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      vi.unstubAllEnvs();
    });

    it("retries on transient errors when maxRetries > 1", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Notes.app is not responding");
        }
        return "success";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success");
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    });

    it("does not retry on non-transient errors", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Can\'t get note "Missing"');
      });

      executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      // Should not retry for "note not found" errors
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("retries on timeout errors", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw makeTimeoutError();
        }
        return "success after retry";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success after retry");
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'connection invalid' errors", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("connection is invalid");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("returns last error after all retries exhausted", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not responding");
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    });

    it("retries on 'timed out' errors", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("operation timed out");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'lost connection' errors", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("lost connection to Notes.app");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'busy' errors", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Notes.app is busy");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff between retries", () => {
      let execCallCount = 0;

      // Fails first 3 times, succeeds on 4th attempt
      mockExecFileSync.mockImplementation(() => {
        execCallCount++;
        if (execCallCount <= 3) {
          throw new Error("Notes.app is not responding");
        }
        return "success";
      });

      // With retryDelayMs=1, delays should be: 1ms, 2ms, 4ms
      const result = executeAppleScript("test", { maxRetries: 4, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(4);
    });
  });
});
