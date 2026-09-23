/**
 * Graceful shutdown that lets pending stdout writes finish first.
 *
 * When the MCP client closes stdin right after sending a request, the response
 * can still be queued in the stdout stream. Exiting immediately truncates any
 * response larger than the OS pipe buffer (64 KiB on macOS), so the client sees
 * a partial JSON-RPC message. Waiting for the stream to drain, with a short
 * ceiling so a stalled client can't keep the server alive, avoids that.
 *
 * @module utils/shutdown
 */

/** The slice of a writable stream the shutdown needs. */
export interface DrainableStream {
  readonly writableLength: number;
  once(event: "drain", listener: () => void): unknown;
}

/** Longest the server waits for stdout to drain before exiting anyway. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 2000;

/**
 * Returns an idempotent shutdown function. On the first call it waits one turn
 * of the event loop (so a response already being written reaches the stream),
 * then exits once `stream` has no buffered bytes, or after `timeoutMs`.
 */
export function createShutdown(
  stream: DrainableStream,
  exit: () => void,
  timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS
): () => void {
  let shuttingDown = false;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    exit();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitWhenDrained = (): void => {
    if (stream.writableLength === 0) exitOnce();
    else stream.once("drain", exitWhenDrained);
  };
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    timer = setTimeout(exitOnce, timeoutMs);
    setImmediate(exitWhenDrained);
  };
}
