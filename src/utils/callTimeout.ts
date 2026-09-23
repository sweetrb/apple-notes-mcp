/**
 * Per-call timeout override for Notes.app automation.
 *
 * The AppleScript, JXA, and Shortcuts runners each take a process timeout that
 * is otherwise fixed per process (APPLE_NOTES_MCP_TIMEOUT_MS or a built-in
 * default). A write tool that accepts `timeoutSeconds` runs its handler inside
 * `runWithCallTimeout`, and every automation step it starts reads the override
 * through `callTimeoutMs()` instead of threading an option through each
 * manager method. AsyncLocalStorage keeps concurrent tool calls from seeing one
 * another's override.
 *
 * The override applies to each automation step, not to the tool call as a
 * whole: a write that reads, mutates, and reads back runs several steps.
 *
 * @module utils/callTimeout
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Accepted range for a per-call `timeoutSeconds` override. */
export const CALL_TIMEOUT_SECONDS = { min: 1, max: 120 } as const;

const scope = new AsyncLocalStorage<number>();

/**
 * Run `fn` with a per-call automation timeout. Passing `undefined` runs `fn`
 * unchanged, so callers can forward an optional tool argument directly.
 */
export function runWithCallTimeout<T>(seconds: number | undefined, fn: () => T): T {
  if (seconds === undefined) return fn();
  if (
    !Number.isInteger(seconds) ||
    seconds < CALL_TIMEOUT_SECONDS.min ||
    seconds > CALL_TIMEOUT_SECONDS.max
  )
    throw new Error(
      `timeoutSeconds must be a whole number from ${CALL_TIMEOUT_SECONDS.min} to ${CALL_TIMEOUT_SECONDS.max}`
    );
  return scope.run(seconds * 1000, fn);
}

/** The active per-call timeout in milliseconds, or undefined outside an override. */
export function callTimeoutMs(): number | undefined {
  return scope.getStore();
}
