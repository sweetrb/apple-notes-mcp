/**
 * Graceful shutdown that lets pending stdout writes finish first.
 *
 * When the MCP client closes stdin right after sending a request, the response
 * can still be queued in the stdout stream. Exiting immediately truncates any
 * response larger than the OS pipe buffer (64 KiB on macOS), so the client sees
 * a partial JSON-RPC message. Waiting for the stream to drain, with a short
 * ceiling so a stalled client can't keep the server alive, avoids that.
 *
 * An asynchronous tool (transcribe-note-audio) can still be running when stdin
 * closes; its response is written only when it finishes. The shutdown
 * therefore also waits for requests that have not been answered yet, under a
 * longer ceiling, before it checks the stream.
 *
 * @module utils/shutdown
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The slice of a writable stream the shutdown needs. */
export interface DrainableStream {
  readonly writableLength: number;
  once(event: "drain", listener: () => void): unknown;
}

/** Longest the server waits for stdout to drain before exiting anyway. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 2000;

/** Longest the server waits when requests are still being handled at shutdown. */
export const SHUTDOWN_IN_FLIGHT_TIMEOUT_MS = 30_000;

/** What the shutdown needs to know about requests still being handled. */
export interface PendingRequests {
  readonly count: number;
  /** Calls `listener` once no request is pending (at once when none is). */
  onIdle(listener: () => void): void;
}

type RequestId = string | number;

/** JSON-RPC requests received on a transport and not answered yet. */
export class InFlightRequests implements PendingRequests {
  private readonly open = new Set<RequestId>();
  private waiters: Array<() => void> = [];

  get count(): number {
    return this.open.size;
  }

  received(id: RequestId): void {
    this.open.add(id);
  }

  /** A response was sent, or the client cancelled the request (no response follows). */
  settled(id: RequestId): void {
    if (!this.open.delete(id) || this.open.size > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  onIdle(listener: () => void): void {
    if (this.open.size === 0) listener();
    else this.waiters.push(listener);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isId = (value: unknown): value is RequestId =>
  typeof value === "string" || typeof value === "number";

/**
 * Wraps a transport so `requests` sees every incoming request and its
 * response. Call before `server.connect`, which installs `onmessage`.
 */
export function trackRequests<T extends Transport>(transport: T, requests: InFlightRequests): T {
  // A stand-in without send (a test double) has no traffic to track.
  if (typeof transport.send !== "function") return transport;
  let handler: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (next: Transport["onmessage"]) => {
      handler = next
        ? (message, extra) => {
            const m = message as unknown as Record<string, unknown>;
            if (typeof m.method === "string") {
              if (isId(m.id)) requests.received(m.id);
              else if (m.method === "notifications/cancelled" && isObject(m.params)) {
                const id = m.params.requestId;
                if (isId(id)) requests.settled(id);
              }
            }
            next(message, extra);
          }
        : next;
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      return await send(message, options);
    } finally {
      const m = message as unknown as Record<string, unknown>;
      if (typeof m.method !== "string" && isId(m.id)) requests.settled(m.id);
    }
  };
  return transport;
}

/**
 * Returns an idempotent shutdown function. On the first call it waits one turn
 * of the event loop (so a response already being written reaches the stream),
 * then for every pending request to be answered, then exits once `stream` has
 * no buffered bytes. It exits anyway after `timeoutMs`, or after
 * `inFlightTimeoutMs` when requests were still pending at shutdown.
 */
export function createShutdown(
  stream: DrainableStream,
  exit: () => void,
  timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS,
  pending?: PendingRequests,
  inFlightTimeoutMs: number = SHUTDOWN_IN_FLIGHT_TIMEOUT_MS
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
    const busy = (pending?.count ?? 0) > 0;
    timer = setTimeout(exitOnce, busy ? Math.max(timeoutMs, inFlightTimeoutMs) : timeoutMs);
    setImmediate(() =>
      pending ? pending.onIdle(() => setImmediate(exitWhenDrained)) : exitWhenDrained()
    );
  };
}
