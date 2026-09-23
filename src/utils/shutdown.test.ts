import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown.js";

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
