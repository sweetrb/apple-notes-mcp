/**
 * The anchor resolver service on loopback: token checks, Host checks, the
 * redirect, fail-closed statuses, the failed-token limit, and the CLI wrapper.
 * Every server a test starts is closed before the test ends; the resolver is
 * a stub, so no Notes data is read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import {
  parseAnchorsArgs,
  runAnchorsCli,
  startAnchorServer,
  type AnchorLookup,
} from "./anchorServer.js";

const TOKEN = "t".repeat(40);
const RESOLVED = "pa_" + "1".repeat(24);
const AMBIGUOUS = "pa_" + "2".repeat(24);
const BROKEN = "pa_" + "3".repeat(24);
const URL_OK = "applenotes://showNote?identifier=N&paragraphID=P";

const lookup: AnchorLookup = (anchorId) => {
  const base = { anchorId, resolved: false, needsReminting: false, confidence: 0 };
  if (anchorId === RESOLVED)
    return { ...base, status: "resolved", resolved: true, url: URL_OK, message: "ok" };
  if (anchorId === AMBIGUOUS)
    return { ...base, status: "ambiguous", candidates: 2, message: "2 paragraphs match" };
  if (anchorId === BROKEN) throw new Error("Full Disk Access is required");
  return undefined;
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(options: Partial<Parameters<typeof startAnchorServer>[0]> = {}) {
  const logs: string[] = [];
  const started = await startAnchorServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    resolve: lookup,
    log: (line) => logs.push(line),
    ...options,
  });
  closers.push(started.close);
  return { ...started, logs };
}

/** A raw request, so the Host header can be set freely. */
function get(
  baseUrl: string,
  path: string,
  { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path, method, headers, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("anchor resolver server", () => {
  it("listens on loopback only and redirects a resolved anchor", async () => {
    const { baseUrl, server, logs } = await start();
    const address = server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
    const res = await get(baseUrl, `/a/${RESOLVED}?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(URL_OK);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    // Logs never carry the token or the query string.
    expect(logs).toEqual([`GET /a/${RESOLVED} 302`]);
    expect(logs.join()).not.toContain(TOKEN);
  });

  it("accepts a bearer token and serves HEAD", async () => {
    const { baseUrl } = await start();
    const res = await get(baseUrl, `/a/${RESOLVED}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(302);
    expect(res.body).toBe("");
  });

  it("refuses a missing, wrong or near-miss token", async () => {
    const { baseUrl, logs } = await start();
    for (const path of [
      `/a/${RESOLVED}`,
      `/a/${RESOLVED}?token=wrong`,
      `/a/${RESOLVED}?token=${TOKEN}x`,
      `/a/${RESOLVED}?token=${TOKEN.slice(1)}`,
    ]) {
      const res = await get(baseUrl, path);
      expect(res.status).toBe(401);
      expect(res.headers.location).toBeUndefined();
    }
    const bearer = await get(baseUrl, `/a/${RESOLVED}`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(bearer.status).toBe(401);
    expect(logs.join()).not.toContain("wrong");
  });

  it("refuses an unexpected Host header", async () => {
    const { baseUrl } = await start();
    const port = new URL(baseUrl).port;
    expect(
      (await get(baseUrl, `/a/${RESOLVED}?token=${TOKEN}`, { headers: { Host: "evil.example" } }))
        .status
    ).toBe(403);
    expect(
      (
        await get(baseUrl, `/a/${RESOLVED}?token=${TOKEN}`, {
          headers: { Host: `localhost:${port}` },
        })
      ).status
    ).toBe(302);
  });

  it("answers statuses other than resolved without redirecting", async () => {
    const { baseUrl } = await start();
    const ambiguous = await get(baseUrl, `/a/${AMBIGUOUS}?token=${TOKEN}`);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.headers.location).toBeUndefined();
    expect(ambiguous.body).toBe("ambiguous: 2 paragraphs match\n");
    expect((await get(baseUrl, `/a/pa_${"9".repeat(24)}?token=${TOKEN}`)).status).toBe(404);
    expect((await get(baseUrl, `/a/../../etc?token=${TOKEN}`)).status).toBe(404);
    expect((await get(baseUrl, `/other?token=${TOKEN}`)).status).toBe(404);
    const broken = await get(baseUrl, `/a/${BROKEN}?token=${TOKEN}`);
    expect(broken.status).toBe(503);
    expect(broken.body).toMatch(/Full Disk Access/);
    expect((await get(baseUrl, `/a/${RESOLVED}?token=${TOKEN}`, { method: "POST" })).status).toBe(
      405
    );
  });

  it("stops answering after too many failed token checks", async () => {
    const { baseUrl } = await start({ maxAuthFailures: 3 });
    for (let i = 0; i < 3; i++) expect((await get(baseUrl, "/a/x?token=bad")).status).toBe(401);
    expect((await get(baseUrl, `/a/${RESOLVED}?token=${TOKEN}`)).status).toBe(429);
  });

  it("refuses a short token", async () => {
    await expect(start({ token: "short" })).rejects.toThrow(/at least 32/);
  });
});

describe("arguments", () => {
  it("parses serve options and rejects anything else", () => {
    expect(parseAnchorsArgs([])).toMatchObject({ help: true });
    expect(parseAnchorsArgs(["serve"])).toEqual({ port: 0, tailnet: false, help: false });
    expect(parseAnchorsArgs(["serve", "--port", "8123", "--tailnet"])).toEqual({
      port: 8123,
      tailnet: true,
      help: false,
    });
    expect(() => parseAnchorsArgs(["serve", "--port", "70000"])).toThrow(/--port/);
    expect(() => parseAnchorsArgs(["serve", "--port"])).toThrow(/--port/);
    expect(() => parseAnchorsArgs(["serve", "--host", "0.0.0.0"])).toThrow(/Unknown option/);
    expect(() => parseAnchorsArgs(["start"])).toThrow(/Unknown anchors command/);
  });
});

describe("runAnchorsCli", () => {
  it("serves until a signal, printing a one-run token", async () => {
    const signals = new EventEmitter();
    let output = "";
    const running = runAnchorsCli(["serve"], {
      env: {},
      resolve: lookup,
      out: (text) => (output += text),
      signals: signals as unknown as NodeJS.Process,
    });
    for (let i = 0; i < 200 && !output.includes("Ctrl-C"); i++)
      await new Promise((r) => setTimeout(r, 10));
    const baseUrl = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)![1];
    const token = /Token \(this run only\): ([0-9a-f]{64})/.exec(output)![1];
    expect((await get(baseUrl, `/a/${RESOLVED}?token=${token}`)).status).toBe(302);
    signals.emit("SIGINT");
    expect(await running).toBe(0);
    await expect(get(baseUrl, `/a/${RESOLVED}?token=${token}`)).rejects.toThrow();
  });

  it("uses a token from the environment without printing it", async () => {
    const signals = new EventEmitter();
    let output = "";
    const running = runAnchorsCli(["serve"], {
      env: { APPLE_NOTES_MCP_ANCHORS_TOKEN: TOKEN },
      resolve: lookup,
      out: (text) => (output += text),
      signals: signals as unknown as NodeJS.Process,
    });
    for (let i = 0; i < 200 && !output.includes("Ctrl-C"); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(output).toContain("Token: from APPLE_NOTES_MCP_ANCHORS_TOKEN");
    expect(output).not.toContain(TOKEN);
    signals.emit("SIGTERM");
    expect(await running).toBe(0);
  });

  it("fails without listening on bad input", async () => {
    const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
      let output = "";
      const code = await runAnchorsCli(argv, {
        env,
        resolve: lookup,
        out: (text) => (output += text),
        interfaces: {},
        signals: new EventEmitter() as unknown as NodeJS.Process,
      });
      return { code, output };
    };
    expect(await run(["--help"])).toMatchObject({ code: 0 });
    expect((await run(["--help"])).output).toContain("anchors serve");
    expect((await run(["bogus"])).code).toBe(2);
    expect(await run(["serve", "--tailnet"])).toMatchObject({ code: 1 });
    expect((await run(["serve", "--tailnet"])).output).toMatch(/No Tailscale address/);
    expect((await run(["serve"], { APPLE_NOTES_MCP_ANCHORS_TOKEN: "short" })).output).toMatch(
      /at least 32/
    );
  });
});
