import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown, InFlightRequests, trackRequests } from "./shutdown.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

class FakeStream extends EventEmitter {
  writableLength = 0;
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits on the next turn when nothing is buffered", async () => {
    const stream = new FakeStream();
    const exit = vi.fn();
    createShutdown(stream, exit)();
    expect(exit).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("waits for buffered output to drain before exiting", async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const exit = vi.fn();
    createShutdown(stream, exit, 2000)();
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).not.toHaveBeenCalled();
    stream.writableLength = 0;
    stream.emit("drain");
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits after the timeout when the stream never drains", async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const exit = vi.fn();
    createShutdown(stream, exit, 2000)();
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and exits once even if drain follows the timeout", async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const exit = vi.fn();
    const shutdown = createShutdown(stream, exit, 2000);
    shutdown();
    shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    stream.writableLength = 0;
    stream.emit("drain");
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("in-flight requests (#186)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a pending request to be answered before exiting", async () => {
    const stream = new FakeStream();
    const exit = vi.fn();
    const requests = new InFlightRequests();
    requests.received(7);
    createShutdown(stream, exit, 2000, requests, 30_000)();
    // Past the drain ceiling, the request is still running: no exit.
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    requests.settled(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still exits at the in-flight ceiling when a request never finishes", async () => {
    const stream = new FakeStream();
    const exit = vi.fn();
    const requests = new InFlightRequests();
    requests.received("slow");
    createShutdown(stream, exit, 2000, requests, 30_000)();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("keeps the short ceiling when nothing is pending", async () => {
    const stream = new FakeStream();
    stream.writableLength = 10;
    const exit = vi.fn();
    createShutdown(stream, exit, 2000, new InFlightRequests(), 30_000)();
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("counts requests from the transport, and settles them on response or cancellation", async () => {
    const sent: unknown[] = [];
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (message: unknown) => {
        sent.push(message);
      },
    } as unknown as Transport;
    const requests = new InFlightRequests();
    trackRequests(transport, requests);
    const seen: unknown[] = [];
    transport.onmessage = (message) => seen.push(message);
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    transport.onmessage!({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    transport.onmessage!({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(seen).toHaveLength(3);
    expect(requests.count).toBe(2);
    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(requests.count).toBe(1);
    transport.onmessage!({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2 },
    });
    expect(requests.count).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
