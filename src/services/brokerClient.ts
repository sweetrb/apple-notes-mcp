/**
 * Socket client for the permission broker (see {@link module:services/broker}).
 *
 * The broker reads exactly one JSON request line per connection and answers
 * with one JSON line. After a `ready` answer to `connect`, the same connection
 * carries raw stdin to the server and framed stdout, stderr, and exit status
 * back from the server the broker started.
 *
 * @module services/brokerClient
 */
import { connect as netConnect, type Socket } from "node:net";

export interface BrokerAnswer {
  /** The parsed first line from the broker. */
  answer: Record<string, unknown>;
  socket: Socket;
  /** Bytes that arrived after the answer line; they belong to the stream. */
  leftover: Buffer;
}

export class BrokerUnreachableError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "BrokerUnreachableError";
  }
}

const MAX_ANSWER_BYTES = 65_536;

/**
 * Connect, send one request line, and wait for the answer line. The socket is
 * left open and paused for the caller; it is destroyed on any failure.
 */
export function requestBroker(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  connect: (path: string) => Socket = (path) => netConnect({ path, allowHalfOpen: true })
): Promise<BrokerAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const buffered = Buffer.allocUnsafe(MAX_ANSWER_BYTES);
    let bufferedBytes = 0;
    let settled = false;
    const fail = (message: string, code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new BrokerUnreachableError(message, code));
    };
    const timer = setTimeout(
      () => fail(`The broker did not answer within ${timeoutMs} ms.`, "timeout"),
      timeoutMs
    );
    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    const onError = (error: NodeJS.ErrnoException) =>
      fail(`Could not reach the broker at ${socketPath}: ${error.message}`, error.code ?? "error");
    const onClose = () => fail("The broker closed the connection without answering.", "closed");
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("end", onClose);
    const onData = (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const answerBytes = newline < 0 ? chunk.length : newline;
      if (bufferedBytes + answerBytes > MAX_ANSWER_BYTES) {
        fail("The broker's answer was too long.", "bad_answer");
        return;
      }
      chunk.copy(buffered, bufferedBytes, 0, answerBytes);
      bufferedBytes += answerBytes;
      if (newline < 0) return;
      let answer: unknown;
      try {
        answer = JSON.parse(buffered.subarray(0, bufferedBytes).toString("utf8"));
      } catch {
        fail("The broker's answer was not JSON.", "bad_answer");
        return;
      }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
        fail("The broker's answer was not a JSON object.", "bad_answer");
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("end", onClose);
      socket.off("error", onError);
      socket.pause();
      resolve({
        answer: answer as Record<string, unknown>,
        socket,
        leftover: chunk.subarray(newline + 1),
      });
    };
    socket.on("data", onData);
  });
}

/** True when a broker answers `ping` on this socket with a pong. */
export async function pingBroker(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const { answer, socket } = await requestBroker(socketPath, { type: "ping" }, timeoutMs);
    socket.destroy();
    return answer.type === "pong";
  } catch {
    return false;
  }
}
