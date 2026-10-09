/**
 * The stdio proxy side of the permission broker.
 *
 * When `setup --broker` has installed a broker and it answers, the process an
 * MCP host launches does not run the server itself. It forwards its stdin and
 * stdout and stderr to a server the broker starts, so macOS attributes that server's
 * Notes database reads and Apple events to the broker app instead of the host
 * or this Node binary. The proxy never parses MCP traffic; it moves bytes.
 *
 * If no broker is installed, nothing happens here and the server runs
 * in-process as always. If one is installed but cannot be reached, the server
 * also runs in-process, and doctor reports why.
 *
 * @module services/brokerProxy
 */
import type { Socket } from "node:net";
import {
  BROKER_MODE_ENV,
  BROKER_PROTOCOL,
  BROKERED_ENV,
  inspectBroker,
  recordBrokerFallback,
  type BrokerInstallation,
} from "@/services/broker.js";
import { BrokerUnreachableError, requestBroker } from "@/services/brokerClient.js";

/** How long the proxy waits for the broker before running in-process. */
export const BROKER_CONNECT_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 65_536;
const OUTPUT_FLUSH_TIMEOUT_MS = 2000;
const OUTPUT_STALL_TIMEOUT_MS = 30_000;

/**
 * Only numeric resource and timing limits may cross the socket. Keep this
 * list in sync with `passedEnvironmentKeys` in the native broker, which must
 * enforce the same policy even for clients that bypass this proxy.
 */
export const BROKER_PASSED_ENV_KEYS = [
  "APPLE_NOTES_MCP_BLOCKS_MAX_BYTES",
  "APPLE_NOTES_MCP_EXPORT_MAX_BYTES",
  "APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES",
  "APPLE_NOTES_MCP_MAX_BUFFER",
  "APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES",
  "APPLE_NOTES_MCP_MAX_RETRIES",
  "APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS",
  "APPLE_NOTES_MCP_PUBLIC_HELPER_TIMEOUT_MS",
  "APPLE_NOTES_MCP_RETRY_DELAY_MS",
  "APPLE_NOTES_MCP_TIMEOUT_MS",
] as const;

const passedEnvironmentKeys: ReadonlySet<string> = new Set(BROKER_PASSED_ENV_KEYS);
const MAX_PASSED_VALUE = 2_147_483_647;
const MAX_VARIABLE_BYTES = 8192;

export interface BrokerProxyDeps {
  env: NodeJS.ProcessEnv;
  inspect: () => BrokerInstallation;
  request: typeof requestBroker;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream & { writableLength?: number };
  stderr: NodeJS.WritableStream & { writableLength?: number };
  exit: (code: number) => void;
  log: (message: string) => void;
}

export function defaultBrokerProxyDeps(overrides: Partial<BrokerProxyDeps> = {}): BrokerProxyDeps {
  return {
    env: process.env,
    inspect: () => inspectBroker(),
    request: requestBroker,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
    log: (message) => process.stderr.write(`[apple-notes-mcp] ${message}\n`),
    ...overrides,
  };
}

/**
 * The client's harmless numeric settings that travel to the brokered server.
 * Paths, executable/helper choices, safety overrides and unknown future
 * settings never travel over the socket. The native broker repeats this
 * allowlist check; a same-user client must not choose privileged server code.
 */
export function passedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !passedEnvironmentKeys.has(key) ||
      typeof value !== "string" ||
      value.length > MAX_VARIABLE_BYTES ||
      !/^[0-9]+$/.test(value)
    )
      continue;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_PASSED_VALUE) continue;
    passed[key] = value;
  }
  return passed;
}

/**
 * Hand this process's stdio to the broker when one is installed and answers.
 * Resolves true once the proxy is running (the process then lives until
 * the brokered session ends), or false to run the server in-process.
 */
export async function startBrokerProxy(
  deps: BrokerProxyDeps = defaultBrokerProxyDeps()
): Promise<boolean> {
  if (deps.env[BROKERED_ENV] === "1" || deps.env[BROKER_MODE_ENV] === "off") return false;
  let installation: BrokerInstallation;
  try {
    installation = deps.inspect();
  } catch {
    return false;
  }
  if (!installation.installed) return false;
  const fallBack = (reason: string): false => {
    recordBrokerFallback(reason);
    deps.log(`Permission broker not used, running in-process: ${reason}`);
    return false;
  };
  if (!installation.ready) return fallBack(installation.detail ?? "the broker is not ready.");
  const manifest = installation.manifest;
  if (!manifest) return fallBack("the broker has no verified runtime manifest.");

  let socket: Socket;
  let leftover: Buffer;
  try {
    const result = await deps.request(
      installation.paths.socketPath,
      {
        type: "connect",
        protocolVersion: BROKER_PROTOCOL,
        packageVersion: manifest.packageVersion,
        entrySha256: manifest.entrySha256,
        env: passedEnvironment(deps.env),
      },
      BROKER_CONNECT_TIMEOUT_MS
    );
    if (result.answer.type !== "ready") {
      result.socket.destroy();
      const message =
        typeof result.answer.message === "string" ? result.answer.message : "no reason given";
      return fallBack(`the broker refused the connection (${message})`);
    }
    if (
      result.answer.protocolVersion !== BROKER_PROTOCOL ||
      result.answer.packageVersion !== manifest.packageVersion ||
      result.answer.entrySha256 !== manifest.entrySha256
    ) {
      result.socket.destroy();
      return fallBack(
        "the running broker serves a different server version. Run `apple-notes-mcp setup --broker` again."
      );
    }
    socket = result.socket;
    leftover = result.leftover;
  } catch (error) {
    return fallBack(
      error instanceof BrokerUnreachableError ? error.message : `unexpected error: ${String(error)}`
    );
  }

  relayBroker(socket, leftover, deps);
  return true;
}

/** Protocol 3: a channel byte, uint32 BE length, then a bounded binary payload. */
function relayBroker(socket: Socket, leftover: Buffer, deps: BrokerProxyDeps): void {
  const header = Buffer.allocUnsafe(5);
  let headerBytes = 0;
  let payload: Buffer | null = null;
  let payloadBytes = 0;
  let channel = 0;
  let initialBytes = leftover;
  let initialOffset = 0;
  let pendingWrites = 0;
  let exitCode: number | null = null;
  let finishingCode: number | null = null;
  let exited = false;
  let failing = false;
  let pumping = false;
  let remoteEnded = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stallDeadline: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Set<NodeJS.WritableStream>();
  const log = (message: string) => {
    try {
      deps.log(message);
    } catch {
      // A broken stderr must not prevent transport cleanup and a failure exit.
    }
  };

  const stopInput = () => {
    deps.stdin.unpipe(socket);
    deps.stdin.pause();
  };
  const exit = () => {
    if (exited || finishingCode === null || pendingWrites > 0) return;
    exited = true;
    clearTimeout(deadline);
    clearTimeout(stallDeadline);
    socket.off("readable", pump);
    deps.stdout.off("drain", stdoutDrained);
    deps.stderr.off("drain", stderrDrained);
    deps.exit(finishingCode);
  };
  const startDeadline = () => {
    if (deadline) return;
    deadline = setTimeout(() => {
      if (exited) return;
      log("Broker output did not finish within 2000 ms.");
      finishingCode = 1;
      pendingWrites = 0;
      stopInput();
      socket.destroy();
      exit();
    }, OUTPUT_FLUSH_TIMEOUT_MS);
  };
  const finish = (code: number) => {
    if (exited) return;
    // A later stream error must still turn an otherwise successful exit into failure.
    if (finishingCode === null || code !== 0) finishingCode = code;
    stopInput();
    socket.destroy();
    startDeadline();
    exit();
  };
  const fail = (message: string) => {
    if (exited || failing) return;
    failing = true;
    log(message);
    finish(1);
  };
  const updateStallDeadline = (progress = false) => {
    if (progress || (pendingWrites === 0 && blocked.size === 0)) {
      clearTimeout(stallDeadline);
      stallDeadline = undefined;
    }
    if (exited || stallDeadline || (pendingWrites === 0 && blocked.size === 0)) return;
    stallDeadline = setTimeout(() => {
      if (exited) return;
      log("Broker output stalled for 30000 ms.");
      pendingWrites = 0;
      finish(1);
    }, OUTPUT_STALL_TIMEOUT_MS);
  };
  const writeOutput = (stream: NodeJS.WritableStream, bytes: Buffer) => {
    pendingWrites++;
    try {
      const accepted = stream.write(bytes, (error?: Error | null) => {
        if (exited) return;
        pendingWrites--;
        updateStallDeadline(true);
        if (error) fail(`Broker output error: ${error.message}`);
        else exit();
      });
      if (!accepted) blocked.add(stream);
      updateStallDeadline();
    } catch (error) {
      pendingWrites--;
      fail(`Broker output error: ${String(error)}`);
    }
  };
  const read = (length: number): Buffer | null => {
    if (initialOffset < initialBytes.length) {
      const end = Math.min(initialBytes.length, initialOffset + length);
      const bytes = initialBytes.subarray(initialOffset, end);
      initialOffset = end;
      if (initialOffset === initialBytes.length) initialBytes = Buffer.alloc(0);
      return bytes;
    }
    const available = socket.readableLength;
    return socket.read(Math.min(length, available)) as Buffer | null;
  };
  function pump() {
    if (pumping || finishingCode !== null || exited) return;
    pumping = true;
    try {
      // Read explicitly instead of using flowing mode, so a blocked output never
      // accumulates frames in an application queue. Only one payload is allocated.
      while (blocked.size === 0 && finishingCode === null) {
        if (exitCode !== null) {
          if (read(1)) fail("The broker sent bytes after its exit frame.");
          break;
        }
        if (payload === null) {
          const bytes = read(header.length - headerBytes);
          if (!bytes) break;
          headerBytes += bytes.copy(header, headerBytes);
          if (headerBytes !== header.length) continue;
          channel = header[0];
          const length = header.readUInt32BE(1);
          if (
            (channel !== 1 && channel !== 2 && channel !== 3) ||
            length === 0 ||
            length > MAX_FRAME_BYTES ||
            (channel === 3 && length !== 4)
          ) {
            fail("The broker sent an invalid output frame.");
            break;
          }
          payload = Buffer.allocUnsafe(length);
          payloadBytes = 0;
        }
        const bytes = read(payload.length - payloadBytes);
        if (!bytes) break;
        payloadBytes += bytes.copy(payload, payloadBytes);
        if (payloadBytes !== payload.length) continue;
        const complete = payload;
        payload = null;
        headerBytes = 0;
        if (channel === 3) {
          const code = complete.readUInt32BE(0);
          if (code > 255) {
            fail("The broker sent an invalid exit status.");
            break;
          }
          exitCode = code;
          stopInput();
          // Require EOF as well, so a duplicate exit or trailing bytes cannot be
          // mistaken for a successful session. A peer cannot hold this open forever.
          startDeadline();
        } else {
          writeOutput(channel === 1 ? deps.stdout : deps.stderr, complete);
        }
      }
      if (remoteEnded && blocked.size === 0 && finishingCode === null) {
        if (exitCode === null || headerBytes !== 0 || payload !== null)
          fail("The broker closed without a complete exit frame.");
        else finish(exitCode);
      }
    } finally {
      pumping = false;
    }
  }
  const drained = (stream: NodeJS.WritableStream) => {
    blocked.delete(stream);
    updateStallDeadline(true);
    pump();
  };
  const stdoutDrained = () => drained(deps.stdout);
  const stderrDrained = () => drained(deps.stderr);
  deps.stdout.on("drain", stdoutDrained);
  deps.stderr.on("drain", stderrDrained);
  // Keep error listeners through exit: a failed write can invoke its callback
  // before emitting error, including after an injected test exit returns.
  deps.stdout.on("error", (error: Error) => fail(`Broker stdout error: ${error.message}`));
  deps.stderr.on("error", (error: Error) => fail(`Broker stderr error: ${error.message}`));
  deps.stdout.on("close", () => fail("Broker stdout closed before the session finished."));
  deps.stderr.on("close", () => fail("Broker stderr closed before the session finished."));
  deps.stdin.on("error", (error: Error) => fail(`Broker stdin error: ${error.message}`));
  socket.on("error", (error: Error) => fail(`Broker connection error: ${error.message}`));
  socket.on("readable", pump);
  socket.on("end", () => {
    remoteEnded = true;
    pump();
  });
  socket.on("close", () => {
    if (finishingCode === null && !remoteEnded)
      fail("The broker connection closed before the session finished.");
  });
  deps.stdin.pipe(socket);
  pump();
}
