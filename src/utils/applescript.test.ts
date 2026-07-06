/**
 * Tests for AppleScript execution utilities
 *
 * These tests mock the child_process.execSync function to avoid
 * requiring actual AppleScript execution during testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { executeAppleScript } from "./applescript.js";

// Mock the child_process module
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null })), // Mock sleep to return immediately
}));

const mockExecSync = vi.mocked(execSync);

describe("executeAppleScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful execution", () => {
    it("returns success result with trimmed output", () => {
      // Arrange: Mock a successful AppleScript execution
      mockExecSync.mockReturnValue("  Note Title  \n");

      // Act: Execute a simple script
      const result = executeAppleScript('tell app "Notes" to get name of note 1');

      // Assert: Output should be trimmed
      expect(result.success).toBe(true);
      expect(result.output).toBe("Note Title");
      expect(result.error).toBeUndefined();
    });

    it("preserves newlines within the script for AppleScript syntax", () => {
      mockExecSync.mockReturnValue("success");

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
      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("tell application");
      expect(calledCommand).toContain("end tell");
    });

    it("escapes single quotes in the script for shell safety", () => {
      mockExecSync.mockReturnValue("content");

      // Script containing a single quote (e.g., in a note title)
      executeAppleScript('get note "Rob\'s Notes"');

      // Verify the quote was escaped for shell
      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("Rob'\\''s");
    });
  });

  describe("hardened executor (#16/#17)", () => {
    afterEach(() => {
      delete process.env.APPLE_NOTES_MCP_MAX_BUFFER;
    });

    it("wraps the script in `with timeout` so Notes.app aborts cleanly", () => {
      mockExecSync.mockReturnValue("ok");
      executeAppleScript("get name of notes", { timeoutMs: 30000 });
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain("with timeout of");
      expect(cmd).toContain("end timeout");
      // 30s process timeout − 5s headroom = 25s script timeout
      expect(cmd).toContain("with timeout of 25 seconds");
    });

    it("passes SIGKILL and a large maxBuffer to execSync", () => {
      mockExecSync.mockReturnValue("ok");
      executeAppleScript("get name of notes");
      const opts = mockExecSync.mock.calls[0][1] as { killSignal?: string; maxBuffer?: number };
      expect(opts.killSignal).toBe("SIGKILL");
      expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
    });

    it("honors APPLE_NOTES_MCP_MAX_BUFFER override", () => {
      process.env.APPLE_NOTES_MCP_MAX_BUFFER = "1048576";
      mockExecSync.mockReturnValue("ok");
      executeAppleScript("get name of notes");
      const opts = mockExecSync.mock.calls[0][1] as { maxBuffer?: number };
      expect(opts.maxBuffer).toBe(1048576);
    });
  });

  describe("error handling", () => {
    it("returns error result when execution fails", () => {
      // Arrange: Mock an AppleScript execution failure
      mockExecSync.mockImplementation(() => {
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
      mockExecSync.mockImplementation(() => {
        throw new Error("execution error: Note not found (-1728)");
      });

      const result = executeAppleScript("get note 1");

      // Should extract the meaningful part of the error
      expect(result.error).toBe("Note not found");
    });

    it("handles 'not found' error patterns with user-friendly message", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get note "Missing".');
      });

      const result = executeAppleScript('get note "Missing"');

      expect(result.error).toContain("not found");
      expect(result.error).toContain("Missing");
      expect(result.error).toContain("case-sensitive"); // Includes helpful hint
    });

    it("provides helpful message for permission errors", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("execution error: Not authorized to send Apple events (-1743)");
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Permission denied");
      expect(result.error).toContain("System Preferences");
    });

    it("provides helpful message for folder not found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get folder "Work".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Work");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-folders");
    });

    it("provides helpful message for account not found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get account "Gmail".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Gmail");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-accounts");
    });

    it("handles non-Error exceptions gracefully", () => {
      mockExecSync.mockImplementation(() => {
        throw "string error"; // Some code throws strings
      });

      const result = executeAppleScript("some script");

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });

    it("handles unknown error types", () => {
      mockExecSync.mockImplementation(() => {
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
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("returns error for whitespace-only script", () => {
      const result = executeAppleScript("   \n\t  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot execute empty AppleScript");
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("execution options", () => {
    it("uses default 30 second timeout", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test");

      const options = mockExecSync.mock.calls[0][1] as { timeout: number };
      expect(options.timeout).toBe(30000); // 30 second default timeout
    });

    it("allows custom timeout via options", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test", { timeoutMs: 60000 });

      const options = mockExecSync.mock.calls[0][1] as { timeout: number };
      expect(options.timeout).toBe(60000); // Custom timeout
    });

    it("uses UTF-8 encoding for output", () => {
      mockExecSync.mockReturnValue("日本語テスト");

      const result = executeAppleScript("test");

      expect(result.output).toBe("日本語テスト");
      const options = mockExecSync.mock.calls[0][1] as { encoding: string };
      expect(options.encoding).toBe("utf8");
    });
  });

  describe("timeout handling", () => {
    it("returns specific error message on timeout", () => {
      // Simulate a timeout error (Node.js sets killed=true and signal=SIGTERM)
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out after 30 seconds");
      expect(result.error).toContain("Notes.app may be unresponsive");
    });

    it("includes custom timeout value in error message", () => {
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test", { timeoutMs: 60000 });

      expect(result.error).toContain("timed out after 60 seconds");
    });

    it("honors APPLE_NOTES_MCP_TIMEOUT_MS when no per-call timeout is given", () => {
      vi.stubEnv("APPLE_NOTES_MCP_TIMEOUT_MS", "45000");
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("timed out after 45 seconds");
      vi.unstubAllEnvs();
    });
  });

  describe("retry logic", () => {
    it("retries transient errors once by default (maxRetries=2)", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      // Two attempts with default settings: the initial call plus one retry
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("APPLE_NOTES_MCP_MAX_RETRIES=1 restores fail-fast behavior", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "1");
      mockExecSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("per-call options override the env knobs", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "5");
      mockExecSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test", { maxRetries: 1 });

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("ignores an invalid APPLE_NOTES_MCP_MAX_RETRIES and uses the default", () => {
      vi.stubEnv("APPLE_NOTES_MCP_MAX_RETRIES", "banana");
      mockExecSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      executeAppleScript("test");

      expect(mockExecSync).toHaveBeenCalledTimes(2);
      vi.unstubAllEnvs();
    });

    it("retries on transient errors when maxRetries > 1", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Notes.app is not responding");
        }
        return "success";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success");
      expect(mockExecSync).toHaveBeenCalledTimes(3);
    });

    it("does not retry on non-transient errors", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get note "Missing"');
      });

      executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      // Should not retry for "note not found" errors
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it("retries on timeout errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          const timeoutError = new Error("SIGTERM") as Error & {
            killed: boolean;
            signal: string;
          };
          timeoutError.killed = true;
          timeoutError.signal = "SIGTERM";
          throw timeoutError;
        }
        return "success after retry";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success after retry");
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'connection invalid' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("connection is invalid");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("returns last error after all retries exhausted", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Notes.app is not responding");
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not responding");
      expect(mockExecSync).toHaveBeenCalledTimes(3);
    });

    it("retries on 'timed out' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("operation timed out");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'lost connection' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("lost connection to Notes.app");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'busy' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Notes.app is busy");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff between retries", () => {
      let execCallCount = 0;

      // Fails first 3 times, succeeds on 4th attempt
      mockExecSync.mockImplementation(() => {
        execCallCount++;
        if (execCallCount <= 3) {
          throw new Error("Notes.app is not responding");
        }
        return "success";
      });

      // With retryDelayMs=100, delays should be: 100ms, 200ms, 400ms
      const result = executeAppleScript("test", { maxRetries: 4, retryDelayMs: 100 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(4);
    });
  });
});
