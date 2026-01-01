/**
 * JXA (JavaScript for Automation) Execution Utilities
 *
 * This module provides an alternative to AppleScript using JavaScript.
 * JXA was introduced in OS X Yosemite and uses the same OSA infrastructure
 * as AppleScript but with JavaScript syntax.
 *
 * Potential advantages over AppleScript:
 * - Standard JavaScript string escaping (simpler than AppleScript)
 * - Better Unicode handling
 * - Familiar syntax for developers
 * - Native JSON support
 *
 * @module utils/jxa
 */

import { execSync } from "child_process";

/**
 * Result from executing a JXA command.
 */
export interface JXAResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Options for JXA execution.
 */
export interface JXAOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Escapes a string for safe inclusion in a JXA script.
 *
 * JXA uses standard JavaScript string escaping, which is simpler
 * than AppleScript's escaping requirements.
 *
 * @param str - The string to escape
 * @returns Escaped string safe for JXA embedding
 */
export function escapeForJXA(str: string): string {
  if (!str) return "";

  // Standard JavaScript string escaping
  return str
    .replace(/\\/g, "\\\\") // Backslashes first
    .replace(/"/g, '\\"') // Double quotes
    .replace(/\n/g, "\\n") // Newlines
    .replace(/\r/g, "\\r") // Carriage returns
    .replace(/\t/g, "\\t"); // Tabs
}

/**
 * Checks if an error is a timeout error.
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const execError = error as Error & { killed?: boolean; signal?: string };
    return execError.killed === true || execError.signal === "SIGTERM";
  }
  return false;
}

/**
 * Executes a JXA (JavaScript for Automation) script.
 *
 * JXA scripts are executed via `osascript -l JavaScript`.
 *
 * @param script - The JavaScript code to execute
 * @param options - Execution options
 * @returns Result with success status and output or error
 *
 * @example
 * ```typescript
 * const result = executeJXA(`
 *   const Notes = Application("Notes");
 *   Notes.accounts().map(a => a.name());
 * `);
 * ```
 */
export function executeJXA(script: string, options: JXAOptions = {}): JXAResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!script || !script.trim()) {
    return {
      success: false,
      output: "",
      error: "Cannot execute empty JXA script",
    };
  }

  // Escape the script for shell embedding
  // We use single quotes to wrap, so escape single quotes within
  const escapedScript = script.trim().replace(/'/g, "'\\''");
  const command = `osascript -l JavaScript -e '${escapedScript}'`;

  try {
    const output = execSync(command, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      success: true,
      output: output.trim(),
    };
  } catch (error: unknown) {
    let errorMessage: string;

    if (isTimeoutError(error)) {
      const timeoutSecs = Math.round(timeoutMs / 1000);
      errorMessage = `Operation timed out after ${timeoutSecs} seconds`;
    } else if (error instanceof Error) {
      // Extract meaningful error from stderr
      const match = error.message.match(/Error: (.+)/);
      errorMessage = match ? match[1] : error.message;
    } else {
      errorMessage = "JXA execution failed with unknown error";
    }

    return {
      success: false,
      output: "",
      error: errorMessage,
    };
  }
}

/**
 * Builds a JXA script that interacts with Notes.app.
 *
 * @param code - JavaScript code to execute within Notes context
 * @returns Complete JXA script
 */
export function buildNotesJXA(code: string): string {
  return `
    const Notes = Application("Notes");
    Notes.includeStandardAdditions = true;
    ${code}
  `;
}
