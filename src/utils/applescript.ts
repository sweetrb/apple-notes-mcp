/**
 * AppleScript Execution Utilities
 *
 * This module provides a safe interface for executing AppleScript commands
 * on macOS. It handles script execution, error capture, and result parsing.
 *
 * @module utils/applescript
 */

import { execSync, spawnSync } from "child_process";
import type { AppleScriptResult, AppleScriptOptions } from "@/types.js";

/**
 * Default execution timeout for AppleScript commands in milliseconds.
 * 30 seconds is sufficient for most operations, including complex
 * searches on large note collections. Can be overridden per-call, or
 * process-wide via APPLE_NOTES_MCP_TIMEOUT_MS for very large libraries
 * where full-library scans legitimately exceed 30s.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Output cap for osascript. Node's execSync defaults to 1 MB, which a large
 * Notes library (export-notes-json, full-library stat scans, long-note content)
 * can blow past — execSync then throws ENOBUFS and the failure surfaces as an
 * empty result. 64 MB headroom, overridable via APPLE_NOTES_MCP_MAX_BUFFER. (#16)
 */
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Read a positive number from an environment variable, or undefined when the
 * variable is unset or not a valid positive number. Shared by the reliability
 * knobs (max buffer, timeout, retries) so they all validate the same way.
 */
function envPositiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function getMaxBuffer(): number {
  return envPositiveNumber("APPLE_NOTES_MCP_MAX_BUFFER") ?? DEFAULT_MAX_BUFFER_BYTES;
}

/**
 * Headroom (ms) between the in-AppleScript `with timeout` and the outer
 * osascript process timeout. The script-level timeout must fire first so
 * Notes.app aborts from inside its own AppleScript dispatch — releasing the
 * event queue — before Node SIGKILLs osascript. Killing osascript alone does
 * not stop work already dispatched into Notes.app, which is what wedges it for
 * subsequent calls. (#17)
 */
const SCRIPT_TIMEOUT_HEADROOM_MS = 5000;

/**
 * Wrap a script body in an AppleScript `with timeout` block so an Apple Event
 * that honors timeouts aborts cleanly rather than holding Notes.app's
 * single-threaded dispatch open. Set below the process timeout so the in-app
 * abort wins the race against the outer SIGKILL. (#17)
 */
function wrapWithTimeout(script: string, processTimeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil((processTimeoutMs - SCRIPT_TIMEOUT_HEADROOM_MS) / 1000));
  return `with timeout of ${seconds} seconds\n${script}\nend timeout`;
}

/**
 * Default retry configuration.
 * - maxRetries is the TOTAL number of attempts; 1 means no retries.
 * - The default is 2 (one retry after a 1s delay), applied only to transient
 *   failures (Notes.app busy / not responding / lost connection / timeout) —
 *   non-transient errors like "note not found" never retry. Override per call
 *   via options, or process-wide via APPLE_NOTES_MCP_MAX_RETRIES and
 *   APPLE_NOTES_MCP_RETRY_DELAY_MS (set APPLE_NOTES_MCP_MAX_RETRIES=1 to
 *   restore the old fail-fast behavior). Delays back off exponentially
 *   (1s/2s/4s... by default).
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Check if debug/verbose logging is enabled.
 * Set DEBUG=1 or DEBUG=true or VERBOSE=1 to enable.
 */
const isDebugEnabled = (): boolean => {
  const debug = process.env.DEBUG;
  const verbose = process.env.VERBOSE;
  return debug === "1" || debug === "true" || verbose === "1" || verbose === "true";
};

/**
 * Log a debug message if debug mode is enabled.
 *
 * @param message - The message to log
 * @param data - Optional additional data to log
 */
function debugLog(message: string, data?: unknown): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[DEBUG ${timestamp}] ${message}`, data);
  } else {
    console.error(`[DEBUG ${timestamp}] ${message}`);
  }
}

/**
 * Escapes a string for safe inclusion in a shell command.
 *
 * When passing AppleScript to osascript via shell, we need to handle
 * the interaction between shell quoting and AppleScript string literals.
 * This function escapes single quotes since we wrap the script in single quotes.
 *
 * @param script - The raw AppleScript code
 * @returns Shell-safe version of the script
 *
 * @example
 * // Input: tell app "Notes" to get note "Rob's Note"
 * // Output: tell app "Notes" to get note "Rob'\''s Note"
 */
function escapeForShell(script: string): string {
  // Replace single quotes with: end quote, escaped quote, start quote
  // This is the standard shell escaping pattern for single-quoted strings
  return script.replace(/'/g, "'\\''");
}

/**
 * Checks if an error is a timeout error from execSync.
 *
 * Node.js throws errors with specific properties when a child process
 * is killed due to timeout.
 *
 * @param error - The caught error object
 * @returns True if this was a timeout error
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const execError = error as Error & { killed?: boolean; signal?: string };
    // execSync kills the process with SIGTERM on timeout
    return execError.killed === true || execError.signal === "SIGTERM";
  }
  return false;
}

/**
 * Error patterns that indicate transient failures worth retrying.
 * These typically occur when Notes.app is syncing or temporarily busy.
 */
const RETRYABLE_ERROR_PATTERNS = [
  /timed? out/i,
  /not responding/i,
  /connection.*invalid/i,
  /lost connection/i,
  /busy/i,
];

/**
 * Checks if an error message indicates a transient failure that should be retried.
 *
 * @param errorMessage - The error message to check
 * @returns True if this error is worth retrying
 */
function isRetryableError(errorMessage: string): boolean {
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Synchronous sleep using the system's sleep command.
 * Used between retry attempts for exponential backoff.
 *
 * This is more efficient than a busy-wait loop as it doesn't
 * consume CPU cycles during the delay.
 *
 * Uses spawnSync instead of execSync to avoid interference with
 * execSync mocks in tests.
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): void {
  // Use system sleep command with fractional seconds support
  // This avoids CPU-spinning busy wait while keeping the code synchronous
  const seconds = ms / 1000;
  const result = spawnSync("sleep", [seconds.toString()], { stdio: "ignore" });
  if (result.error) {
    // Fallback to busy-wait if sleep command fails (shouldn't happen on macOS)
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait fallback
    }
  }
}

/**
 * User-friendly error messages mapped from common AppleScript errors.
 * Each entry maps a pattern (regex or string) to a user-friendly message.
 */
const ERROR_MAPPINGS: Array<{ pattern: RegExp; message: string }> = [
  // Permission errors
  {
    pattern: /not authorized|not permitted|access.*denied/i,
    message:
      "Permission denied. Grant automation access in System Preferences > Privacy & Security > Automation.",
  },
  // Application not running
  {
    pattern: /application isn't running|not running/i,
    message: "Notes.app is not responding. Try opening Notes.app manually.",
  },
  // Connection errors
  {
    pattern: /connection is invalid|lost connection/i,
    message: "Lost connection to Notes.app. The app may have crashed or been restarted.",
  },
  // Note not found (general)
  {
    pattern: /can't get note "([^"]+)"/i,
    message: 'Note "$1" not found. Verify the title is exact (case-sensitive).',
  },
  // Note not found by ID
  {
    pattern: /can't get note id/i,
    message: "Note not found. The note may have been deleted or the ID is invalid.",
  },
  // Folder not found
  {
    pattern: /can't get folder "([^"]+)"/i,
    message: 'Folder "$1" not found. Use list-folders to see available folders.',
  },
  // Account not found
  {
    pattern: /can't get account "([^"]+)"/i,
    message: 'Account "$1" not found. Use list-accounts to see available accounts.',
  },
  // Folder already exists
  {
    pattern: /folder.*already exists/i,
    message: "A folder with that name already exists.",
  },
  // Cannot delete (various reasons)
  {
    pattern: /can't delete|cannot delete/i,
    message: "Cannot delete. The item may be locked or in use.",
  },
  // Password protected notes
  {
    pattern: /password protected|locked note/i,
    message: "Note is password-protected. Unlock it in Notes.app first.",
  },
  // Syntax/script errors (usually programming bugs)
  {
    pattern: /syntax error|expected/i,
    message: "Internal error. Please report this issue.",
  },
];

/**
 * Parses error output from osascript to extract meaningful error messages.
 *
 * osascript errors typically include execution error numbers and descriptions.
 * This function attempts to extract the human-readable portion and map it
 * to a user-friendly message with helpful suggestions.
 *
 * @param errorOutput - Raw error string from execSync
 * @returns User-friendly error message with suggested action
 */
function parseErrorMessage(errorOutput: string): string {
  // First, extract the core error message from AppleScript format
  let coreError = errorOutput;

  // Check for execution error format: "execution error: Message (-1234)"
  const executionError = errorOutput.match(/execution error: (.+?)(?:\s*\(-?\d+\))?$/m);
  if (executionError) {
    coreError = executionError[1].trim();
  }

  // Try to match against known error patterns for user-friendly messages
  for (const { pattern, message } of ERROR_MAPPINGS) {
    const match = coreError.match(pattern);
    if (match) {
      // Replace $1, $2, etc. with captured groups
      let result = message;
      for (let i = 1; i < match.length; i++) {
        result = result.replace(`$${i}`, match[i] || "");
      }
      return result;
    }
  }

  // Fall back to basic "Can't get X" parsing
  const notFoundError = coreError.match(/Can't get (.+?)\./);
  if (notFoundError) {
    return `Not found: ${notFoundError[1]}`;
  }

  // Return cleaned version of original error
  return coreError.trim() || "Unknown AppleScript error";
}

/**
 * Executes an AppleScript command and returns a structured result.
 *
 * This function serves as the bridge between TypeScript and macOS AppleScript.
 * It handles the complexity of shell escaping, execution, and error handling
 * so that calling code can work with clean TypeScript interfaces.
 *
 * The script is executed synchronously via the `osascript` command-line tool.
 * Multi-line scripts are supported and preserved (important for AppleScript
 * tell blocks and repeat loops).
 *
 * @param script - The AppleScript code to execute
 * @param options - Optional execution settings (timeout, etc.)
 * @returns A result object with success status and output or error message
 *
 * @example
 * ```typescript
 * // Basic usage with default timeout (30 seconds)
 * const result = executeAppleScript(`
 *   tell application "Notes"
 *     get name of every note
 *   end tell
 * `);
 *
 * // With custom timeout for complex operations
 * const result = executeAppleScript(complexScript, { timeoutMs: 60000 });
 *
 * if (result.success) {
 *   console.log("Notes:", result.output);
 * } else {
 *   console.error("Failed:", result.error);
 * }
 * ```
 */
export function executeAppleScript(
  script: string,
  options: AppleScriptOptions = {}
): AppleScriptResult {
  // Per-call options win; then process-wide env knobs; then built-in defaults.
  const timeoutMs =
    options.timeoutMs ?? envPositiveNumber("APPLE_NOTES_MCP_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS;
  const maxRetries =
    options.maxRetries ?? envPositiveNumber("APPLE_NOTES_MCP_MAX_RETRIES") ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs =
    options.retryDelayMs ??
    envPositiveNumber("APPLE_NOTES_MCP_RETRY_DELAY_MS") ??
    DEFAULT_RETRY_DELAY_MS;

  // Validate input - empty scripts are likely programmer errors
  if (!script || !script.trim()) {
    return {
      success: false,
      output: "",
      error: "Cannot execute empty AppleScript",
    };
  }

  // Prepare the script:
  // 1. Trim leading/trailing whitespace (cosmetic)
  // 2. Wrap in `with timeout` so Notes.app aborts cleanly from inside its own
  //    dispatch before the outer process SIGKILL (#17)
  // 3. Preserve internal newlines (required for AppleScript syntax)
  // 4. Escape for shell execution
  const preparedScript = escapeForShell(wrapWithTimeout(script.trim(), timeoutMs));

  // Build the osascript command
  // We use single quotes to wrap the script, which is why we escape
  // single quotes within the script itself
  const command = `osascript -e '${preparedScript}'`;

  // Debug: Log the script being executed
  debugLog("Executing AppleScript", {
    scriptPreview: script.trim().substring(0, 200) + (script.length > 200 ? "..." : ""),
    timeout: timeoutMs,
    maxRetries,
  });

  let lastError: AppleScriptResult | null = null;
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    try {
      // Execute synchronously - MCP tools are inherently synchronous
      // and Apple Notes operations are fast enough that async isn't needed
      const output = execSync(command, {
        encoding: "utf8",
        timeout: timeoutMs,
        // SIGKILL (not the default SIGTERM): a wedged osascript blocked on an
        // unresponsive Notes.app can ignore SIGTERM and leak, piling up and
        // worsening contention. SIGKILL guarantees reaping on timeout. (#17)
        killSignal: "SIGKILL",
        // Raise the output cap above Node's 1 MB default so large exports /
        // long notes aren't truncated into an ENOBUFS failure. (#16)
        maxBuffer: getMaxBuffer(),
        // Capture stderr separately to get error details
        stdio: ["pipe", "pipe", "pipe"],
      });

      const duration = Date.now() - attemptStart;
      debugLog("AppleScript succeeded", {
        attempt,
        duration: `${duration}ms`,
        outputLength: output.length,
        outputPreview: output.substring(0, 100) + (output.length > 100 ? "..." : ""),
      });

      return {
        success: true,
        output: output.trim(),
      };
    } catch (error: unknown) {
      // execSync throws on non-zero exit codes
      // The error object contains stderr output with AppleScript error details
      const attemptDuration = Date.now() - attemptStart;

      let errorMessage: string;
      let isTimeout = false;
      let rawError: string | undefined;

      // Check for timeout first - provide specific message
      if (isTimeoutError(error)) {
        isTimeout = true;
        const timeoutSecs = Math.round(timeoutMs / 1000);
        errorMessage = `Operation timed out after ${timeoutSecs} seconds. Notes.app may be unresponsive or the operation involves too many notes.`;
      } else if (error instanceof Error) {
        rawError = error.message;
        // Node's ExecException includes stderr in the message
        errorMessage = parseErrorMessage(error.message);
      } else if (typeof error === "string") {
        rawError = error;
        errorMessage = parseErrorMessage(error);
      } else {
        errorMessage = "AppleScript execution failed with unknown error";
      }

      // Debug: Log error details
      debugLog("AppleScript failed", {
        attempt,
        duration: `${attemptDuration}ms`,
        totalElapsed: `${Date.now() - startTime}ms`,
        isTimeout,
        errorMessage,
        rawError: rawError?.substring(0, 500),
      });

      lastError = {
        success: false,
        output: "",
        error: errorMessage,
      };

      // Check if we should retry
      const canRetry = isTimeout || isRetryableError(errorMessage);
      const hasAttemptsLeft = attempt < maxRetries;

      if (canRetry && hasAttemptsLeft) {
        const delayMs = retryDelayMs * Math.pow(2, attempt - 1);
        console.error(
          `AppleScript retry: Attempt ${attempt}/${maxRetries} failed with "${errorMessage}". Retrying in ${delayMs}ms...`
        );
        sleep(delayMs);
        // Continue to next attempt
      } else {
        // Log final error and return
        if (isTimeout) {
          console.error(`AppleScript timeout: ${errorMessage}`);
        } else {
          console.error(`AppleScript error: ${errorMessage}`);
        }
        return lastError!;
      }
    }
  }

  // Return the last error (all retries exhausted - shouldn't reach here normally)
  return lastError!;
}
