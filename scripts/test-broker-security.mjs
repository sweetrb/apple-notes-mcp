#!/usr/bin/env node
/**
 * Isolated macOS security regression checks for the native permission broker.
 * Run: node scripts/test-broker-security.mjs
 *
 * Uses temporary, ad-hoc signed app bundles and a tiny C echo runtime. It does
 * not run the Notes server, install a LaunchAgent, inspect signing identities,
 * request TCC permissions, or access any installed broker or Notes data.
 * Requires macOS and the Xcode command-line tools. No npm dependencies needed.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readFixtureFile } from "./broker-fixture-files.mjs";
import {
  assessProbe,
  classifyHostCapability,
  finalizeNativeResult,
} from "./broker-host-capability.mjs";

const args = process.argv.slice(2);
let reportPath;
if (
  args.length !== 0 &&
  (args.length !== 2 ||
    args[0] !== "--report" ||
    !args[1] ||
    args[1].startsWith("--") ||
    args[1].includes("\0"))
) {
  console.error("usage: node scripts/test-broker-security.mjs [--report <path>]");
  process.exit(1);
}
if (args.length) reportPath = resolve(args[1]);
if (process.platform !== "darwin") {
  const report = {
    schemaVersion: 1,
    result: {
      state: "failure",
      exitCode: 1,
      reasons: ["NOT VERIFIED: native broker checks require macOS"],
    },
    checks: { passed: 0, completed: false },
  };
  console.error(report.result.reasons[0]);
  if (reportPath) {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    } catch (error) {
      console.error(`Could not write report: ${error.message}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// A short, canonical path also stays below Darwin's Unix socket path limit.
const temporary = realpathSync(mkdtempSync("/tmp/anmb-security-"));
const source = join(root, "native/broker/apple-notes-mcp-broker.swift");
const sourceSha256 = sha256(readFileSync(source));
const compiledBroker = join(temporary, "broker");
const compiledRuntime = join(temporary, "echo-runtime");
const injectionLibrary = join(temporary, "injection.dylib");
const injectionMarker = join(temporary, "dyld-loaded");
const injectionSource = join(temporary, "injection.c");
const diagnosticFixtures = [];
let positiveControlRecords;
let expectedInjectionSnapshot = null;
let hostEvidence;
let capability;
let checksCompleted = false;
let cleanupSucceeded = false;
let markersUnchanged = false;
const failures = [];
const brokers = new Set();
const connections = new Set();
const refusedExecutionCounts = new Map();
let fixtureNumber = 0;
let checks = 0;
let cleaningUp;

const numericKeys = [
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
];

mkdirSync(join(temporary, "home"));
mkdirSync(join(temporary, "tmp"));
const cleanEnvironment = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: join(temporary, "home"),
  TMPDIR: `${join(temporary, "tmp")}/`,
  LANG: "en_US.UTF-8",
};
const hostileEnvironment = {
  APPLE_NOTES_MCP_CONFIG_FILE: join(temporary, "untrusted-config.json"),
  APPLE_NOTES_MCP_PUBLIC_HELPER_DIR: join(temporary, "untrusted-public"),
  APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: join(temporary, "untrusted-private"),
  APPLE_NOTES_MCP_PERMISSIONS_WINDOW_DIR: join(temporary, "untrusted-window"),
  APPLE_NOTES_MCP_PRIVATE_STORE: join(temporary, "untrusted-store"),
  APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
  APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS: "1",
  APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1",
  APPLE_NOTES_MCP_BACKGROUND_SHORTCUT: "untrusted-shortcut",
  APPLE_NOTES_MCP_MARKDOWN_SHORTCUT: "untrusted-shortcut",
  APPLE_NOTES_MCP_TAGS_SHORTCUT: "untrusted-shortcut",
  APPLE_NOTES_MCP_DEFAULT_FOLDER: "untrusted-folder",
  APPLE_NOTES_MCP_TEMPLATE_DIR: join(temporary, "untrusted-templates"),
  APPLE_NOTES_MCP_ANCHOR_FILE: join(temporary, "untrusted-anchors.json"),
  APPLE_NOTES_MCP_PASTEBOARD_NAME: "untrusted-pasteboard",
  APPLE_NOTES_MCP_BROKER: "off",
  APPLE_NOTES_MCP_BROKERED: "untrusted",
  APPLE_NOTES_MCP_BROKER_APP: join(temporary, "Untrusted.app"),
  APPLE_NOTES_MCP_BROKER_DIR: join(temporary, "untrusted-state"),
  APPLE_NOTES_MCP_BROKER_SIGN_IDENTITY: "untrusted-identity",
  APPLE_NOTES_MCP_UNKNOWN_FUTURE_SETTING: "untrusted",
  NODE_OPTIONS: "--require=/nonexistent/broker-security-fixture.js",
  NODE_PATH: join(temporary, "untrusted-node-modules"),
  DYLD_INSERT_LIBRARIES: injectionLibrary,
  DYLD_LIBRARY_PATH: temporary,
  DYLD_FRAMEWORK_PATH: temporary,
  DYLD_FALLBACK_LIBRARY_PATH: temporary,
  LD_PRELOAD: injectionLibrary,
  HOME: cleanEnvironment.HOME,
  TMPDIR: cleanEnvironment.TMPDIR,
  USER: "untrusted-user",
  LOGNAME: "untrusted-user",
  PATH: join(temporary, "untrusted-bin"),
  SHELL: "/untrusted-shell",
  LANG: "untrusted-language",
  LC_ALL: "untrusted-locale",
  __CFBundleIdentifier: "untrusted.bundle",
};

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    env: cleanEnvironment,
    cwd: temporary,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${executable} failed (${result.status}, ${result.signal}):\n${result.stderr}\n${result.stdout}`
  );
  return result;
}

async function check(name, action) {
  await action();
  checks += 1;
  console.log(`ok ${checks}: ${name}`);
}

function compileFixtures() {
  console.log("Compiling isolated broker and harmless runtime fixtures...");
  const digestFile = join(temporary, "source-digest.swift");
  writeFileSync(digestFile, `let helperSourceSHA256 = ${JSON.stringify(sourceSha256)}\n`);
  command("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    "-parse-as-library",
    "-module-cache-path",
    join(temporary, "module-cache"),
    source,
    digestFile,
    "-o",
    compiledBroker,
  ]);
  // This runtime treats the sealed JavaScript path only as an argument. Its
  // only filesystem write is a launch marker beside its own temporary binary.
  const cSource = join(temporary, "runtime.c");
  writeFileSync(
    cSource,
    String.raw`
#include <limits.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
extern char **environ;
extern int csops(pid_t, unsigned int, void *, size_t);
static void json_string(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 0x20) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static int write_bytes(int fd, const unsigned char *bytes, size_t length) {
  while (length) {
    ssize_t count = write(fd, bytes, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    bytes += count; length -= count;
  }
  return 1;
}
int main(int argc, char **argv) {
  if (fcntl(STDIN_FILENO, F_GETFL) & O_NONBLOCK) return 6;
  char marker[PATH_MAX], cwd[PATH_MAX], line[1024];
  if (snprintf(marker, sizeof(marker), "%s.spawned", argv[0]) >= sizeof(marker)) return 2;
  FILE *f = fopen(marker, "a");
  if (!f) return 3;
  fputs("spawn\n", f); fclose(f);
  if (!fgets(line, sizeof(line), stdin)) return 0;
  if (strstr(line, "signal-exit")) { raise(SIGTERM); return 99; }
  if (strstr(line, "halfclose")) {
    while (getchar() != EOF) {}
    fputs("final stdout after stdin EOF\n", stdout);
    fputs("final stderr after stdin EOF\n", stderr);
    return 7;
  }
  if (strstr(line, "binary") || strstr(line, "stderr-only") || strstr(line, "flood")) {
    unsigned char out[4096], err[4096];
    for (int i = 0; i < 4096; ++i) { out[i] = i % 256; err[i] = 255 - (i % 256); }
    if (strstr(line, "stderr-only")) {
      close(STDOUT_FILENO);
      if (!write_bytes(STDERR_FILENO, err, sizeof(err))) return 4;
      return 17;
    }
    for (int i = 0; i < 64 || strstr(line, "flood"); ++i) {
      if (!write_bytes(STDOUT_FILENO, out, sizeof(out)) ||
          !write_bytes(STDERR_FILENO, err, sizeof(err))) return 4;
    }
    return 23;
  }
  if (strstr(line, "hold") || strstr(line, "orphan")) {
    pid_t descendant = fork();
    if (descendant < 0) return 5;
    if (descendant == 0) { for (;;) pause(); }
    printf("{\"child\":%d,\"grandchild\":%d}\n", getpid(), descendant); fflush(stdout);
    if (strstr(line, "orphan")) return 0;
    for (;;) pause();
  }
  fputs("{\"argv\":[", stdout);
  for (int i = 0; i < argc; i++) { if (i) putchar(','); json_string(argv[i]); }
  fputs("],\"cwd\":", stdout);
  json_string(getcwd(cwd, sizeof(cwd)) ? cwd : "");
  uint32_t flags = 0;
  errno = 0;
  int cs_status = csops(getpid(), 0 /* CS_OPS_STATUS */, &flags, sizeof(flags));
  int cs_errno = errno;
  printf(",\"codeSigning\":{\"pid\":%d,\"ppid\":%d,\"csopsStatus\":%d,\"csopsErrno\":%d,\"csopsFlags\":%u}",
         getpid(), getppid(), cs_status, cs_errno, flags);
  fputs(",\"env\":{", stdout);
  int first = 1;
  for (char **e = environ; *e; ++e) {
    char *copy = strdup(*e), *equals = strchr(copy, '=');
    if (equals) {
      *equals = 0;
      if (!first) putchar(','); first = 0;
      json_string(copy); putchar(':'); json_string(equals + 1);
    }
    free(copy);
  }
  fputs("}}\n", stdout); fflush(stdout);
  return 0;
}
`
  );
  command("/usr/bin/xcrun", ["clang", "-O2", cSource, "-o", compiledRuntime]);
  writeFileSync(
    injectionSource,
    `#define INJECTION_MARKER ${JSON.stringify(injectionMarker)}\n` +
      String.raw`
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/types.h>
#include <unistd.h>
extern int csops(pid_t, unsigned int, void *, size_t);
static void json_string(FILE *f, const char *s) {
  fputc('"', f);
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p == '"' || *p == '\\') { fputc('\\', f); fputc(*p, f); }
    else if (*p < 0x20) fprintf(f, "\\u%04x", *p);
    else fputc(*p, f);
  }
  fputc('"', f);
}
__attribute__((constructor)) static void injected(void) {
  char executable[PATH_MAX] = "";
  uint32_t size = sizeof(executable), flags = 0;
  int path_status = _NSGetExecutablePath(executable, &size);
  errno = 0;
  int cs_status = csops(getpid(), 0 /* CS_OPS_STATUS */, &flags, sizeof(flags));
  int cs_errno = errno;
  FILE *f = fopen(INJECTION_MARKER, "a");
  if (!f) return;
  flock(fileno(f), LOCK_EX);
  fprintf(f, "{\"pid\":%d,\"ppid\":%d,\"executable\":", getpid(), getppid());
  json_string(f, path_status == 0 ? executable : "<path unavailable>");
  fputs(",\"nonce\":", f);
  const char *nonce = getenv("BROKER_SECURITY_PROBE_NONCE");
  json_string(f, nonce ? nonce : "");
  fprintf(f, ",\"executablePathStatus\":%d,\"csopsStatus\":%d,\"csopsErrno\":%d,\"csopsFlags\":%u}\n",
          path_status, cs_status, cs_errno, flags);
  fflush(f);
  flock(fileno(f), LOCK_UN);
  fclose(f);
}
`
  );
  command("/usr/bin/xcrun", ["clang", "-dynamiclib", injectionSource, "-o", injectionLibrary]);
}

function fixture({ hardened = true, entitlement } = {}) {
  const directory = join(temporary, `case-${++fixtureNumber}`);
  const app = join(directory, "Broker.app");
  const resources = join(app, "Contents/Resources");
  const executable = join(app, "Contents/MacOS/apple-notes-mcp-broker");
  const runtime = join(directory, "runtime");
  const entry = join(resources, "server/build/index.js");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  copyFileSync(compiledBroker, executable);
  copyFileSync(compiledRuntime, runtime);
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.apple-notes-mcp.broker-security</string>
<key>CFBundleExecutable</key><string>apple-notes-mcp-broker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>\n`
  );
  writeFileSync(
    entry,
    `// Harmless sealed entry fixture; no Notes code is imported.
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).once("line", () => {
  console.log(JSON.stringify({ argv: process.argv, env: process.env }));
  process.exit(0);
});\n`
  );
  writeFileSync(
    join(resources, "server/package.json"),
    JSON.stringify({
      name: "apple-notes-mcp",
      version: "fixture",
      type: "module",
    })
  );
  writeFileSync(join(resources, "config.json"), "{}\n");
  const config = {
    schemaVersion: 1,
    nodePath: runtime,
    nodeSha256: sha256(readFileSync(runtime)),
    packageVersion: "fixture",
    entrySha256: sha256(readFileSync(entry)),
  };
  const configPath = join(resources, "broker-config.json");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const signArgs = ["--force", "--sign", "-"];
  if (hardened) signArgs.push("--options", "runtime");
  if (entitlement) {
    const entitlements = join(directory, "entitlements.plist");
    writeFileSync(
      entitlements,
      `<plist version="1.0"><dict><key>${entitlement}</key><true/></dict></plist>\n`
    );
    signArgs.push("--entitlements", entitlements);
  }
  command("/usr/bin/codesign", [...signArgs, app]);
  command("/usr/bin/codesign", ["--verify", "--strict", app]);
  diagnosticFixtures.push({ app, hardened, entitlement });
  return {
    directory,
    app,
    resources,
    executable,
    runtime,
    entry,
    configPath,
    config,
    socket: join(directory, "socket"),
    marker: `${runtime}.spawned`,
  };
}

function hello(fx, args = [], environment = cleanEnvironment) {
  return spawnSync(fx.executable, args, {
    env: environment,
    cwd: temporary,
    input: '{"type":"hello"}\n',
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function assertRefusedStartup(fx, label, args = []) {
  const invocations = args.length ? [args] : [[], ["serve", "--socket", fx.socket]];
  for (const invocation of invocations) {
    const result = hello(fx, invocation);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `${label} unexpectedly started`);
    assert.equal(result.signal, null, `${label} crashed instead of refusing: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", `${label} advertised a trusted hello`);
    assert.equal(existsSync(fx.socket), false, `${label} opened a listening socket`);
    assert.equal(existsSync(fx.marker), false, `${label} launched its runtime`);
  }
}

async function openConnection(path) {
  const socket = createConnection({ path, allowHalfOpen: true });
  connections.add(socket);
  let buffer = Buffer.alloc(0);
  let framed = false;
  let ended;
  const messages = [];
  const waiting = [];
  const finish = (error) => {
    ended ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(ended);
  };
  const deliver = (value) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else messages.push(value);
  };
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 1024 * 1024) {
      socket.destroy(new Error("fixture response exceeded 1 MiB"));
      return;
    }
    try {
      while (buffer.length) {
        if (!framed) {
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          const answer = JSON.parse(buffer.subarray(0, newline).toString());
          buffer = buffer.subarray(newline + 1);
          framed = answer.type === "ready";
          deliver(answer);
        } else {
          if (buffer.length < 5) return;
          const channel = buffer[0],
            length = buffer.readUInt32BE(1);
          assert.ok(channel >= 1 && channel <= 3, "unknown native output channel");
          assert.ok(length > 0 && length <= 65536, "unbounded native output frame");
          if (channel === 3) assert.equal(length, 4);
          if (buffer.length < 5 + length) return;
          const payload = Buffer.from(buffer.subarray(5, 5 + length));
          buffer = buffer.subarray(5 + length);
          deliver({ channel, payload });
        }
      }
    } catch (error) {
      socket.destroy(error);
    }
  });
  socket.on("error", finish);
  socket.on("end", () => finish(new Error("broker ended before the expected response")));
  socket.on("close", () => {
    connections.delete(socket);
    finish(new Error("broker closed the socket before the expected response"));
  });
  await once(socket, "connect");
  return {
    socket,
    write(value) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    async waitForEnd() {
      // The exit frame precedes native group cleanup and slot release. Only
      // peer EOF, after handle() closes its descriptor, is that barrier.
      if (socket.errored) throw socket.errored;
      if (!socket.readableEnded) {
        if (socket.destroyed) throw new Error("broker socket closed without peer EOF");
        await new Promise((resolve, reject) => {
          const complete = (error) => {
            clearTimeout(timer);
            socket.off("end", onEnd);
            socket.off("error", onError);
            socket.off("close", onClose);
            if (error) reject(error);
            else resolve();
          };
          const onEnd = () => complete();
          const onError = (error) => complete(error);
          const onClose = () => complete(new Error("broker socket closed without peer EOF"));
          const timer = setTimeout(() => {
            const error = new Error("timed out waiting for broker peer EOF after its response");
            complete(error);
            socket.destroy(error);
          }, 5000);
          socket.once("end", onEnd);
          socket.once("error", onError);
          socket.once("close", onClose);
        });
      }
      assert.equal(buffer.length, 0, "broker ended with a partial output frame");
      assert.equal(messages.length, 0, "broker sent output after its terminal response");
    },
    async read() {
      if (messages.length) return messages.shift();
      if (ended) throw ended;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => socket.destroy(new Error("timed out waiting for a broker response")),
          10_000
        );
        waiting.push({
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
  };
}

async function outputUntilExit(connection) {
  const stdout = [],
    stderr = [];
  while (true) {
    const frame = await connection.read();
    if (frame.channel === 3) {
      const status = frame.payload.readUInt32BE();
      assert.ok(status <= 255);
      await connection.waitForEnd();
      return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status };
    }
    (frame.channel === 1 ? stdout : stderr).push(frame.payload);
  }
}

async function readyConnection(fx) {
  const connection = await openConnection(fx.socket);
  connection.write(connectRequest(fx));
  const answer = await connection.read();
  assert.equal(answer.type, "ready", JSON.stringify(answer));
  assert.equal(answer.protocolVersion, 3);
  assert.equal(answer.packageVersion, "fixture");
  assert.equal(answer.entrySha256, fx.config.entrySha256);
  return { ...connection, pid: answer.pid };
}

async function request(fx, value, echo = false) {
  const connection = await openConnection(fx.socket);
  try {
    connection.write(value);
    const answer = await connection.read();
    if (!echo) {
      if (answer.type !== "ready") await connection.waitForEnd();
      return answer;
    }
    assert.equal(answer.type, "ready", JSON.stringify(answer));
    assert.equal(answer.protocolVersion, 3);
    assert.equal(answer.packageVersion, "fixture");
    assert.equal(answer.entrySha256, fx.config.entrySha256);
    connection.write({ echo: true });
    const output = await outputUntilExit(connection);
    assert.equal(output.status, 0);
    assert.equal(output.stderr.length, 0);
    return JSON.parse(output.stdout.toString());
  } finally {
    connection.socket.destroy();
  }
}

async function waitFor(condition, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(20);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function heldProcesses(connection, mode) {
  connection.write({ mode });
  let line = Buffer.alloc(0);
  while (!line.includes(10)) {
    const frame = await connection.read();
    assert.equal(frame.channel, 1);
    line = Buffer.concat([line, frame.payload]);
  }
  const pids = JSON.parse(line.toString());
  assert.equal(pids.child, connection.pid);
  assert.ok(pids.grandchild > 1);
  return pids;
}

async function assertProcessesGone(pids) {
  await waitFor(
    () => Object.values(pids).every((pid) => !processExists(pid)),
    "fixture children reaped",
    5000
  );
}

function connectRequest(fx, env = {}, overrides = {}) {
  return {
    type: "connect",
    protocolVersion: 3,
    packageVersion: "fixture",
    entrySha256: fx.config.entrySha256,
    env,
    ...overrides,
  };
}

async function start(fx, environment = cleanEnvironment) {
  const child = spawn(fx.executable, ["serve", "--socket", fx.socket], {
    env: environment,
    cwd: temporary,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const broker = { child, output: "", exited: false };
  brokers.add(broker);
  const capture = (data) => {
    broker.output = `${broker.output}${data}`.slice(-16_384);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  broker.done = new Promise((resolve) => {
    child.once("exit", () => {
      broker.exited = true;
      resolve();
    });
    child.once("error", (error) => {
      broker.exited = true;
      capture(error.message);
      resolve();
    });
  });
  const deadline = Date.now() + 10_000;
  let pong;
  while (!pong) {
    assert.equal(broker.exited, false, `broker exited during startup:\n${broker.output}`);
    assert.ok(Date.now() < deadline, `broker did not listen:\n${broker.output}`);
    if (existsSync(fx.socket)) {
      try {
        pong = await request(fx, { type: "ping" });
        break;
      } catch (error) {
        // bind() creates the path before listen() can accept a connection.
        if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
      }
    }
    await delay(25);
  }
  assert.equal(pong.type, "pong");
  assert.equal(pong.protocolVersion, 3);
  assert.equal(pong.sourceSha256, sourceSha256);
  assert.equal(pong.packageVersion, "fixture");
  assert.equal(pong.entrySha256, fx.config.entrySha256);
  return broker;
}

async function stop(broker) {
  // Ask the broker to cancel and reap its separate session process groups.
  // The outer process-group kill is only an emergency fixture cleanup.
  function signal(name) {
    if (!broker.child.pid) return;
    try {
      process.kill(-broker.child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  signal("SIGTERM");
  await Promise.race([broker.done, delay(1000)]);
  if (!broker.exited) {
    signal("SIGKILL");
    await broker.done;
  }
  brokers.delete(broker);
}

function launchCount(fx) {
  return readFixtureFile(fx.marker, { allowAppend: true })?.toString("utf8") ?? "";
}

async function assertNoSpawn(fx, value, code) {
  const before = launchCount(fx);
  const answer = await request(fx, value);
  assert.equal(answer.type, "error", JSON.stringify(answer));
  assert.equal(answer.code, code);
  // An incorrectly executed child may be scheduled after the error response.
  // These markers detect fixture execution; the error protocol assertion is
  // separate. Check cumulatively again before stopping each broker and at end.
  await delay(150);
  assert.equal(launchCount(fx), before, "refused request executed the runtime fixture");
  refusedExecutionCounts.set(fx, before);
}

function assertNoUnexpectedExecution() {
  for (const [fx, expected] of refusedExecutionCounts) {
    assert.equal(launchCount(fx), expected, "a refused request executed the runtime fixture later");
  }
}

function markerRecords() {
  return readFixtureFile(injectionMarker);
}

function assertInjectionUnchanged(stage) {
  assert.deepEqual(
    markerRecords(),
    expectedInjectionSnapshot,
    `constructor evidence changed ${stage}; an unexpected child, stale record, deletion or rewrite is fatal`
  );
}

function newMarkerRecords(before) {
  const snapshot = markerRecords();
  if (before !== null)
    assert.ok(
      snapshot !== null && snapshot.subarray(0, before.length).equals(before),
      "constructor evidence was deleted or rewritten"
    );
  const added = (snapshot ?? Buffer.alloc(0)).subarray(before?.length ?? 0);
  if (!added.length) return { records: [], snapshot };
  assert.equal(added.at(-1), 10, "constructor record was truncated");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(added);
  return {
    records: text
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line)),
    snapshot,
  };
}

function signatureEvidence(path) {
  command("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", path]);
  const display = command("/usr/bin/codesign", ["-d", "--verbose=4", "--entitlements", ":-", path]);
  const flags = [...display.stderr.matchAll(/CodeDirectory[^\n]* flags=0x([0-9a-f]+)/gi)];
  assert.equal(flags.length, 1, "signature runtime flags were ambiguous or missing");
  const rawEntitlements = display.stdout.trim();
  const entitlements = rawEntitlements
    ? JSON.parse(
        command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: rawEntitlements })
          .stdout
      )
    : {};
  return {
    verified: true,
    flags: Number.parseInt(flags[0][1], 16),
    entitlements,
    display: display.stderr,
  };
}

function signedControl(name, hardened) {
  const path = join(temporary, name);
  copyFileSync(compiledRuntime, path);
  command("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    ...(hardened ? ["--options", "runtime"] : []),
    path,
  ]);
  return { path, signature: signatureEvidence(path) };
}

async function controlProbe(control, mode, runtime) {
  assertInjectionUnchanged(`before ${mode} control`);
  const before = expectedInjectionSnapshot;
  const nonce = randomUUID();
  const env = {
    ...cleanEnvironment,
    DYLD_INSERT_LIBRARIES: injectionLibrary,
    BROKER_SECURITY_PROBE_NONCE: nonce,
  };
  const result =
    mode === "sync"
      ? diagnosticCommand(control.path, [], { env, input: "{}\n" })
      : await detachedDiagnostic(control.path, env);
  let main;
  try {
    main = JSON.parse(result.stdout).codeSigning;
  } catch {
    main = null;
  }
  const markerEvidence = newMarkerRecords(before);
  const probe = {
    mode,
    nonce,
    pid: result.pid,
    parentPid: process.pid,
    executable: control.path,
    signature: control.signature,
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    main,
    records: markerEvidence.records,
  };
  assert.deepEqual(
    assessProbe(probe, { runtime, positive: !runtime }).errors,
    [],
    `${mode} control evidence was invalid`
  );
  expectedInjectionSnapshot = markerEvidence.snapshot;
  return probe;
}

function diagnosticCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    env: cleanEnvironment,
    cwd: temporary,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    ...options,
  });
  return {
    command: [executable, ...args],
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout?.slice(-16_384),
    stderr: result.stderr?.slice(-16_384),
  };
}

async function detachedDiagnostic(executable, env) {
  const child = spawn(executable, [], {
    cwd: temporary,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processRecord = { child, exited: false };
  const result = { pid: child.pid, stdout: "", stderr: "" };
  brokers.add(processRecord);
  child.stdout.on("data", (data) => {
    result.stdout = `${result.stdout}${data}`.slice(-16_384);
  });
  child.stderr.on("data", (data) => {
    result.stderr = `${result.stderr}${data}`.slice(-16_384);
  });
  child.stdin.on("error", (error) => {
    result.stdinError = error.message;
  });
  processRecord.done = new Promise((resolve) => {
    child.once("error", (error) => {
      result.error = error.message;
      processRecord.exited = true;
      resolve();
    });
    child.once("close", (status, signal) => {
      result.status = status;
      result.signal = signal;
      processRecord.exited = true;
      resolve();
    });
  });
  child.stdin.end("{}\n");
  try {
    let timer;
    await Promise.race([
      processRecord.done,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          result.error = "control timed out after 10 seconds";
          resolve();
        }, 10_000);
      }),
    ]);
    clearTimeout(timer);
    return result;
  } finally {
    if (!processRecord.exited) await stop(processRecord);
    else brokers.delete(processRecord);
  }
}

async function reportFailureDiagnostics() {
  const report = {
    node: process.version,
    architecture: process.arch,
    positiveControlRecords,
    constructorSnapshotBase64: markerRecords()?.toString("base64") ?? null,
    hostEvidence,
    fixtures: diagnosticFixtures,
    system: [
      diagnosticCommand("/usr/bin/sw_vers", []),
      diagnosticCommand("/usr/bin/uname", ["-mrs"]),
      diagnosticCommand("/usr/sbin/sysctl", ["-n", "kern.bootargs"]),
      diagnosticCommand("/usr/bin/csrutil", ["status"]),
    ],
  };
  console.error(
    `Native broker failure diagnostics (read-only host queries):\n${JSON.stringify(report, null, 2)}`
  );
}

function assertEnvironment(fx, actual, expectedNumeric = {}) {
  assert.deepEqual(actual.argv, [fx.runtime, fx.entry]);
  assert.equal(actual.cwd, join(fx.resources, "server"));
  const controlled = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    HOME: userInfo().homedir,
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    APPLE_NOTES_MCP_BROKERED: "1",
    APPLE_NOTES_MCP_BROKER_APP: fx.app,
    APPLE_NOTES_MCP_CONFIG_FILE: join(fx.resources, "config.json"),
    APPLE_NOTES_MCP_PUBLIC_HELPER_DIR: "/dev/null",
    APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: "/dev/null",
    APPLE_NOTES_MCP_ENABLE_PRIVATE: "0",
    APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS: "0",
    APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "0",
  };
  for (const [key, value] of Object.entries(controlled)) {
    assert.equal(actual.env[key], value, `${key} did not use the broker's trusted value`);
  }
  assert.equal(
    actual.env.BROKER_SECURITY_PROBE_NONCE,
    undefined,
    "constructor nonce escaped into a child"
  );
  assert.ok(actual.env.TMPDIR?.startsWith("/"), "TMPDIR must be derived from the OS");
  assert.notEqual(actual.env.TMPDIR, hostileEnvironment.TMPDIR, "inherited TMPDIR escaped");
  for (const key of Object.keys(hostileEnvironment)) {
    if (key in controlled || key === "TMPDIR") continue;
    assert.equal(actual.env[key], undefined, `${key} escaped the environment boundary`);
  }
  for (const key of numericKeys) {
    assert.equal(actual.env[key], expectedNumeric[key], `${key} violated the numeric policy`);
  }
  assertInjectionUnchanged("while checking the runtime environment");
}

function cleanup() {
  cleaningUp ??= (async () => {
    for (const socket of connections) socket.destroy();
    for (const broker of [...brokers]) await stop(broker);
    let markerError;
    try {
      assertInjectionUnchanged("after all fixture processes stopped");
      markersUnchanged = true;
    } catch (error) {
      markerError = error;
    }
    rmSync(temporary, { recursive: true, force: true });
    if (markerError) throw markerError;
  })();
  return cleaningUp;
}

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(status));
  });
}

try {
  compileFixtures();
  const plain = signedControl("plain-control", false);
  const hardened = signedControl("hardened-control", true);
  const positives = {};
  const controls = {};
  await check(
    "the actual DYLD fixture loads in both signed plain control launch modes",
    async () => {
      for (const mode of ["sync", "detached"])
        positives[mode] = await controlProbe(plain, mode, false);
      positiveControlRecords = positives;
    }
  );
  for (const mode of ["sync", "detached"])
    controls[mode] = await controlProbe(hardened, mode, true);
  const sipCommand = diagnosticCommand("/usr/bin/csrutil", ["status"]);
  const sip =
    sipCommand.status === 0 && !sipCommand.error && sipCommand.signal === null
      ? ({
          "System Integrity Protection status: enabled.": "enabled",
          "System Integrity Protection status: disabled.": "disabled",
        }[sipCommand.stdout.trim()] ?? "unknown")
      : "unknown";

  const base = fixture();
  await check("sealed, hardened bundle returns a protocol 3 build fingerprint", () => {
    const result = hello(base);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      type: "hello",
      protocolVersion: 3,
      sourceSha256,
      packageVersion: "fixture",
      entrySha256: base.config.entrySha256,
    });
    assert.equal(existsSync(base.marker), false);
  });
  await check("LaunchAgent command-line code-path overrides are refused", () => {
    for (const flag of ["--node", "--entry", "--log"]) {
      assertRefusedStartup(base, flag, ["serve", "--socket", base.socket, flag, compiledRuntime]);
    }
  });
  await check("ad-hoc signatures without hardened runtime are refused", () => {
    assertRefusedStartup(fixture({ hardened: false }), "missing hardened runtime");
  });
  await check("loader and debugger escape entitlements are refused", () => {
    for (const entitlement of [
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.get-task-allow",
    ])
      assertRefusedStartup(fixture({ entitlement }), entitlement);
  });

  const brokerNonce = randomUUID();
  const inherited = {
    ...cleanEnvironment,
    ...hostileEnvironment,
    ...Object.fromEntries(numericKeys.map((key) => [key, "9999"])),
    BROKER_SECURITY_PROBE_NONCE: brokerNonce,
  };
  assertInjectionUnchanged("before launching the broker");
  const brokerSignature = signatureEvidence(base.app);
  const beforeBroker = expectedInjectionSnapshot;
  const running = await start(base, inherited);
  try {
    const brokerMarkerEvidence = newMarkerRecords(beforeBroker);
    hostEvidence = {
      platform: process.platform,
      sip,
      sipCommand,
      positives,
      controls,
      broker: {
        mode: "detached",
        nonce: brokerNonce,
        pid: running.child.pid,
        parentPid: process.pid,
        executable: base.executable,
        signature: brokerSignature,
        healthy: true,
        records: brokerMarkerEvidence.records,
      },
    };
    capability = classifyHostCapability(hostEvidence);
    assert.notEqual(capability.state, "failure", capability.reasons.join("; "));
    // Only records already bound to completed controls and this exact broker
    // startup may enter the baseline. Every later byte change remains fatal.
    expectedInjectionSnapshot = brokerMarkerEvidence.snapshot;
    if (capability.state === "host-gap")
      console.error(`COVERAGE GAP (exit 2 if other checks pass): ${capability.reasons.join("; ")}`);
    else console.log(`HOST VERIFIED: ${capability.reasons.join("; ")}`);
    await check("children discard all hostile inherited overrides, including DYLD", async () => {
      assertEnvironment(base, await request(base, connectRequest(base), true));
      assert.equal(statSync(base.socket).mode & 0o777, 0o600);
      assert.equal(statSync(base.directory).mode & 0o777, 0o700);
    });
    await check(
      "raw socket clients cannot select helpers, config, safety flags or loaders",
      async () => {
        assertEnvironment(
          base,
          await request(base, connectRequest(base, hostileEnvironment), true)
        );
      }
    );
    await check("all 10 approved numeric fields pass through raw socket requests", async () => {
      const values = Object.fromEntries(numericKeys.map((key, index) => [key, String(index + 1)]));
      assertEnvironment(base, await request(base, connectRequest(base, values), true), values);
    });
    await check(
      "numeric values reject non-integers, zero, overflow, NUL and oversized input",
      async () => {
        const invalid = [
          "",
          "0",
          "-1",
          "+1",
          "1.5",
          "1e3",
          " 1",
          "1\n",
          "１",
          "1\0",
          "2147483648",
          "9".repeat(8193),
          1,
          true,
          null,
          { value: "1" },
        ];
        for (const value of invalid) {
          const values = { APPLE_NOTES_MCP_TIMEOUT_MS: value };
          assertEnvironment(base, await request(base, connectRequest(base, values), true));
        }
      }
    );
    await check("numeric bounds and long leading-zero values match the proxy policy", async () => {
      for (const value of ["1", "2147483647", "0001", `${"0".repeat(8191)}1`]) {
        const values = { APPLE_NOTES_MCP_TIMEOUT_MS: value };
        assertEnvironment(base, await request(base, connectRequest(base, values), true), values);
      }
    });
    await check("stale protocols and mismatched server fingerprints do not spawn", async () => {
      await assertNoSpawn(
        base,
        connectRequest(base, {}, { protocolVersion: 1 }),
        "protocol_mismatch"
      );
      await assertNoSpawn(
        base,
        connectRequest(base, {}, { packageVersion: "stale" }),
        "version_mismatch"
      );
      await assertNoSpawn(
        base,
        connectRequest(base, {}, { entrySha256: "0".repeat(64) }),
        "version_mismatch"
      );
      await assertNoSpawn(base, { type: "connect", protocolVersion: 3 }, "version_mismatch");
    });
  } finally {
    assertNoUnexpectedExecution();
    await stop(running);
  }

  await check("the 16-client cap refuses a 17th spawn and recovers after peer EOF", async () => {
    const fx = fixture();
    const broker = await start(fx);
    const held = [];
    try {
      for (let index = 0; index < 16; index++) held.push(await readyConnection(fx));
      // ready is sent after posix_spawn, before every C main necessarily runs.
      // Wait for all intended launches before measuring a forbidden extra one.
      const expectedLaunches = "spawn\n".repeat(16);
      await waitFor(
        () => launchCount(fx) === expectedLaunches,
        "all 16 fixture runtimes started",
        5000
      );
      assert.equal((await request(fx, { type: "ping" })).activeChildren, 16);
      assert.ok(
        held.every(({ pid }) => processExists(pid)),
        "all capped sessions must be live"
      );

      const refused = await request(fx, connectRequest(fx));
      assert.equal(refused.type, "error", JSON.stringify(refused));
      assert.equal(refused.code, "busy");
      assert.equal(launchCount(fx), expectedLaunches, "the 17th request launched a child");
      assert.equal((await request(fx, { type: "ping" })).activeChildren, 16);

      for (const connection of held) connection.socket.end();
      for (const result of await Promise.all(held.map(outputUntilExit))) {
        assert.equal(result.status, 0);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.length, 0);
      }
      assert.ok(
        held.every(({ pid }) => !processExists(pid)),
        "peer EOF must follow child reaping"
      );
      assert.equal((await request(fx, { type: "ping" })).activeChildren, 0);
      assert.equal(launchCount(fx), expectedLaunches, "a refused child appeared during teardown");

      assertEnvironment(fx, await request(fx, connectRequest(fx), true));
      assert.equal(
        launchCount(fx),
        expectedLaunches + "spawn\n",
        "recovery must launch exactly one child"
      );
      assert.equal((await request(fx, { type: "ping" })).activeChildren, 0);
      // Continue detecting a delayed forbidden spawn after accounting for the
      // one explicitly authorized recovery request.
      refusedExecutionCounts.set(fx, launchCount(fx));
    } finally {
      for (const connection of held) connection.socket.destroy();
      await stop(broker);
    }
    assertNoUnexpectedExecution();
  });

  const streams = fixture();
  const streamBroker = await start(streams);
  try {
    await check(
      "binary stdout and stderr remain exact and isolated for concurrent clients",
      async () => {
        const binary = await readyConnection(streams);
        const errors = await readyConnection(streams);
        try {
          binary.write({ mode: "binary" });
          errors.write({ mode: "stderr-only" });
          const [first, second] = await Promise.all([
            outputUntilExit(binary),
            outputUntilExit(errors),
          ]);
          assert.deepEqual(
            first.stdout,
            Buffer.from(Array.from({ length: 64 * 4096 }, (_, i) => i % 256))
          );
          assert.deepEqual(
            first.stderr,
            Buffer.from(Array.from({ length: 64 * 4096 }, (_, i) => 255 - (i % 256)))
          );
          assert.equal(first.status, 23);
          assert.equal(second.stdout.length, 0);
          assert.deepEqual(
            second.stderr,
            Buffer.from(Array.from({ length: 4096 }, (_, i) => 255 - (i % 256)))
          );
          assert.equal(second.status, 17);
        } finally {
          binary.socket.destroy();
          errors.socket.destroy();
        }
      }
    );
    await check(
      "stdin half-close preserves final stdout, stderr and child exit status",
      async () => {
        const connection = await readyConnection(streams);
        try {
          connection.socket.end('{"mode":"halfclose"}\n');
          const result = await outputUntilExit(connection);
          assert.equal(result.stdout.toString(), "final stdout after stdin EOF\n");
          assert.equal(result.stderr.toString(), "final stderr after stdin EOF\n");
          assert.equal(result.status, 7);
          assert.equal(
            streamBroker.output.includes("final stderr"),
            false,
            "child stderr entered the broker diagnostic log"
          );
        } finally {
          connection.socket.destroy();
        }
      }
    );
    await check("signal exits are normalized without corrupting output frames", async () => {
      const connection = await readyConnection(streams);
      try {
        connection.write({ mode: "signal-exit" });
        const result = await outputUntilExit(connection);
        assert.equal(result.status, 143);
      } finally {
        connection.socket.destroy();
      }
    });
    await check("slow readers apply backpressure and resume with exact output", async () => {
      const connection = await readyConnection(streams);
      try {
        connection.socket.pause();
        connection.write({ mode: "binary" });
        await delay(300);
        connection.socket.resume();
        const result = await outputUntilExit(connection);
        assert.equal(result.stdout.length, 64 * 4096);
        assert.equal(result.stderr.length, 64 * 4096);
        assert.equal(result.status, 23);
      } finally {
        connection.socket.destroy();
      }
    });
    await check(
      "disconnect during an output flood releases the child and session slot",
      async () => {
        const connection = await readyConnection(streams);
        connection.socket.pause();
        connection.write({ mode: "flood" });
        await delay(300);
        connection.socket.destroy();
        await assertProcessesGone({ child: connection.pid });
        await waitFor(
          async () => (await request(streams, { type: "ping" })).activeChildren === 0,
          "session slot released"
        );
      }
    );
    await check("a client that never reads output reaches the bounded stall deadline", async () => {
      const connection = await readyConnection(streams);
      try {
        connection.socket.pause();
        connection.write({ mode: "flood" });
        await delay(300);
        assert.equal(processExists(connection.pid), true, "fixture must first block on output");
        await waitFor(
          () => !processExists(connection.pid),
          "stalled output child terminated",
          35_000
        );
        assert.equal((await request(streams, { type: "ping" })).activeChildren, 0);
      } finally {
        connection.socket.destroy();
      }
    });
    await check(
      "full disconnect terminates the owned child and grandchild process group",
      async () => {
        const connection = await readyConnection(streams);
        const pids = await heldProcesses(connection, "hold");
        connection.socket.destroy();
        await assertProcessesGone(pids);
      }
    );
    await check(
      "inherited pipe holders cannot keep a completed session alive indefinitely",
      async () => {
        const connection = await readyConnection(streams);
        const pids = await heldProcesses(connection, "orphan");
        try {
          await assert.rejects(outputUntilExit(connection), /ended|closed/);
          await assertProcessesGone(pids);
        } finally {
          connection.socket.destroy();
        }
      }
    );
  } finally {
    await stop(streamBroker);
  }

  await check("broker SIGTERM cancels sessions and reaps their owned process groups", async () => {
    const fx = fixture();
    const broker = await start(fx);
    const connection = await readyConnection(fx);
    const pids = await heldProcesses(connection, "hold");
    const partial = await openConnection(fx.socket);
    partial.socket.write('{"type":');
    broker.child.kill("SIGTERM");
    await waitFor(() => broker.exited, "broker stopped after cancelling sessions", 3000);
    await assertProcessesGone(pids);
    connection.socket.destroy();
    partial.socket.destroy();
    brokers.delete(broker);
  });

  await check("failed runtime spawn releases pipes and child capacity", async () => {
    const fx = fixture();
    chmodSync(fx.runtime, 0o600);
    const broker = await start(fx);
    try {
      for (let i = 0; i < 20; i++) {
        assert.equal((await request(fx, connectRequest(fx))).code, "spawn_failed");
      }
      assert.equal((await request(fx, { type: "ping" })).activeChildren, 0);
      assert.equal(existsSync(fx.marker), false);
    } finally {
      await stop(broker);
    }
  });

  const mutations = [
    ["sealed broker config", (fx) => appendFileSync(fx.configPath, " ")],
    ["sealed server JavaScript", (fx) => appendFileSync(fx.entry, "// tampered\n")],
    [
      "sealed server settings",
      (fx) =>
        writeFileSync(
          join(fx.resources, "config.json"),
          '{"APPLE_NOTES_MCP_ENABLE_PRIVATE":"1"}\n'
        ),
    ],
    [
      "pinned runtime bytes",
      (fx) => {
        const replacement = `${fx.runtime}.replacement`;
        // Atomic replacement avoids editing an image that may still be mapped.
        writeFileSync(
          replacement,
          Buffer.concat([readFileSync(fx.runtime), Buffer.from("tampered\n")]),
          { mode: 0o755 }
        );
        renameSync(replacement, fx.runtime);
      },
    ],
    [
      "pinned runtime symlink",
      (fx) => {
        rmSync(fx.runtime);
        symlinkSync(compiledRuntime, fx.runtime);
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await check(`${name} tampering is refused before startup`, () => {
      const fx = fixture();
      mutate(fx);
      assertRefusedStartup(fx, name);
    });
    await check(`${name} tampering is refused between live connections`, async () => {
      const fx = fixture();
      const broker = await start(fx);
      try {
        assertEnvironment(fx, await request(fx, connectRequest(fx), true));
        mutate(fx);
        await assertNoSpawn(fx, connectRequest(fx), "integrity_failed");
      } finally {
        assertNoUnexpectedExecution();
        await stop(broker);
      }
    });
  }
  assertNoUnexpectedExecution();
  assertInjectionUnchanged("after all regression checks");
  checksCompleted = true;
} catch (error) {
  console.error(error.stack ?? error);
  failures.push(error.stack ?? String(error));
  try {
    await reportFailureDiagnostics();
  } catch (diagnosticError) {
    console.error(
      `Failure diagnostics could not complete: ${diagnosticError.stack ?? diagnosticError}`
    );
  }
} finally {
  try {
    await cleanup();
    cleanupSucceeded = true;
  } catch (error) {
    failures.push(`Cleanup failed: ${error.stack ?? error}`);
  }
}

const finish = () =>
  finalizeNativeResult(capability, {
    failures,
    checksCompleted,
    cleanupSucceeded,
    markersUnchanged,
  });
const report = {
  schemaVersion: 1,
  sourceSha256,
  node: process.version,
  architecture: process.arch,
  result: finish(),
  checks: { passed: checks, completed: checksCompleted },
  cleanupSucceeded,
  markersUnchanged,
  hostEvidence,
  failures,
  reportPath: reportPath ?? null,
  reportWritten: reportPath ? true : null,
};
if (reportPath) {
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    failures.push(`Report write failed: ${error.message}`);
    report.reportWritten = false;
    report.result = finish();
  }
}
const label = {
  verified: "PASS",
  "host-gap": "COVERAGE GAP — NOT VERIFIED",
  failure: "FAIL — NOT VERIFIED",
}[report.result.state];
console.log(
  `${label}: ${checks} regression checks passed; host enforcement ${report.result.state}; exit ${report.result.exitCode}.`
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.result.exitCode;
