import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerUnreachableError, pingBroker, requestBroker } from "@/services/brokerClient.js";

let dir: string;
let socketPath: string;
let server: Server | null = null;

function serve(onLine: (line: string, socket: Socket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline >= 0) onLine(buffer.slice(0, newline), socket);
      });
    });
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anm-bc-"));
  socketPath = join(dir, "b.sock");
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("requestBroker", () => {
  it("sends one line and returns the answer with any bytes after it", async () => {
    let received = "";
    await serve((line, socket) => {
      received = line;
      socket.write('{"type":"ready","pid":7}\n{"jsonrpc"');
    });
    const { answer, socket, leftover } = await requestBroker(socketPath, { type: "connect" }, 2000);
    expect(JSON.parse(received)).toEqual({ type: "connect" });
    expect(answer).toEqual({ type: "ready", pid: 7 });
    expect(leftover.toString()).toBe('{"jsonrpc"');
    socket.destroy();
  });

  it("assembles an answer split across chunks", async () => {
    await serve((_line, socket) => {
      socket.write('{"type":');
      setTimeout(() => socket.write('"pong"}\n'), 20);
    });
    const { answer, socket } = await requestBroker(socketPath, { type: "ping" }, 2000);
    expect(answer.type).toBe("pong");
    socket.destroy();
  });

  it("rejects when nothing listens", async () => {
    await expect(requestBroker(socketPath, { type: "ping" }, 2000)).rejects.toMatchObject({
      name: "BrokerUnreachableError",
      code: "ENOENT",
    });
  });

  it("rejects on a timeout", async () => {
    await serve(() => {});
    await expect(requestBroker(socketPath, { type: "ping" }, 50)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rejects when the broker closes without answering", async () => {
    await serve((_line, socket) => socket.end());
    await expect(requestBroker(socketPath, { type: "ping" }, 2000)).rejects.toMatchObject({
      code: "closed",
    });
  });

  it.each([
    ["not JSON", "nope\n"],
    ["not an object", "42\n"],
    ["an array", "[]\n"],
    ["null", "null\n"],
    ["too long", "x".repeat(70_000)],
  ])("rejects an answer that is %s", async (_label, reply) => {
    await serve((_line, socket) => {
      socket.write(reply);
    });
    const error = await requestBroker(socketPath, { type: "ping" }, 2000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerUnreachableError);
    expect((error as BrokerUnreachableError).code).toBe("bad_answer");
  });

  it("bounds an answer even when its newline arrives in the same chunk", async () => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const answer = requestBroker("unused", { type: "ping" }, 2000, () => socket as Socket);
    // An in-memory transport keeps the oversized JSON and newline in one event.
    socket.push(JSON.stringify({ message: "x".repeat(65_536) }) + "\n");
    await expect(answer).rejects.toMatchObject({ code: "bad_answer" });
  });

  it("retains binary frames following a bounded answer", async () => {
    const trailing = Buffer.alloc(65_540, 0xff);
    await serve((_line, socket) =>
      socket.end(Buffer.concat([Buffer.from('{"type":"ready"}\n'), trailing]))
    );
    const { answer, socket, leftover } = await requestBroker(socketPath, { type: "connect" }, 2000);
    expect(answer.type).toBe("ready");
    expect(leftover.equals(trailing.subarray(0, leftover.length))).toBe(true);
    expect(leftover.length).toBeGreaterThan(0);
    const remaining: Buffer[] = [];
    socket.on("data", (bytes: Buffer) => remaining.push(bytes));
    await new Promise<void>((resolve) => {
      socket.once("end", resolve);
      socket.resume();
    });
    expect(Buffer.concat([leftover, ...remaining]).equals(trailing)).toBe(true);
    socket.destroy();
  });
});

describe("pingBroker", () => {
  it("is true only for a pong", async () => {
    await serve((_line, socket) => socket.end('{"type":"pong"}\n'));
    expect(await pingBroker(socketPath)).toBe(true);
  });

  it("is false for anything else", async () => {
    expect(await pingBroker(socketPath, 100)).toBe(false);
    await serve((_line, socket) => socket.end('{"type":"error"}\n'));
    expect(await pingBroker(socketPath)).toBe(false);
  });
});
