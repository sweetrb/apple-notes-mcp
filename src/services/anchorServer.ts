/**
 * `apple-notes-mcp anchors serve`: an opt-in HTTP resolver for paragraph
 * anchors.
 *
 * `GET /a/<anchor-id>` resolves the anchor against the Notes database and
 * redirects (302) to the paragraph's current `applenotes://` link. Anything
 * short of a confident, linkable match is answered with a plain-text status
 * (409 for ambiguous or needs-reminting, 404 for gone) and no redirect.
 *
 * Safety:
 * - It only runs when started from the command line; the MCP server never
 *   starts it.
 * - It binds 127.0.0.1 by default. `--tailnet` binds this Mac's Tailscale
 *   address (the first IPv4 in 100.64.0.0/10, utun interfaces first) instead.
 *   It never runs the tailscale CLI and never changes Tailscale, firewall or
 *   system settings.
 * - Every request needs the token, as `?token=` (links opened from other apps
 *   cannot send headers) or `Authorization: Bearer`. Tokens are compared in
 *   constant time and never logged; request logs omit the query string.
 * - The Host header must name the bound address, which blocks DNS rebinding.
 * - Only GET and HEAD are served. Responses are `no-store` with
 *   `Referrer-Policy: no-referrer`, so the token does not leak onward.
 * - After 20 failed token checks in a minute, every request gets 429 until
 *   the minute passes.
 *
 * @module services/anchorServer
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { networkInterfaces } from "node:os";
import {
  bearerToken,
  findTailnetAddress,
  hostAuthority,
  newServerToken,
  tokenMatches,
} from "../utils/localServer.js";
import { ANCHOR_ID_PATTERN, type AnchorResolution } from "../utils/paragraphAnchors.js";

/** Resolve an anchor id; undefined means no such anchor is recorded. */
export type AnchorLookup = (anchorId: string) => AnchorResolution | undefined;

export interface AnchorServerOptions {
  host: string;
  port: number;
  token: string;
  resolve: AnchorLookup;
  /** One line per request, without query strings. Default: stderr. */
  log?: (line: string) => void;
  /** Failed token checks allowed per minute before 429 (default 20). */
  maxAuthFailures?: number;
}

/** Tokens shorter than this are refused. */
export const MIN_TOKEN_LENGTH = 32;

const STATUS_CODE: Record<AnchorResolution["status"], number> = {
  resolved: 302,
  "needs-reminting": 409,
  ambiguous: 409,
  "low-confidence": 409,
  "not-found": 404,
  "note-not-found": 404,
  "note-deleted": 404,
  "note-unreadable": 409,
};

/** Create the resolver's request handler (not yet listening). */
export function createAnchorServer(options: AnchorServerOptions): Server {
  if (options.token.length < MIN_TOKEN_LENGTH)
    throw new Error(`The resolver token must be at least ${MIN_TOKEN_LENGTH} characters`);
  const log = options.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const maxFailures = options.maxAuthFailures ?? 20;
  let failures: number[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body + "\n");
      const path = (req.url ?? "").split("?")[0].slice(0, 64);
      log(`${req.method} ${path} ${status}`);
    };

    const now = Date.now();
    failures = failures.filter((t) => now - t < 60000);
    if (failures.length >= maxFailures)
      return send(429, "Too many failed requests; wait a minute.");
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(405, "Method not allowed.", { Allow: "GET, HEAD" });

    const address = server.address();
    const port = address && typeof address === "object" ? address.port : options.port;
    const hosts = new Set([hostAuthority(options.host, port)]);
    if (options.host === "127.0.0.1") hosts.add(`localhost:${port}`);
    if (!hosts.has((req.headers.host ?? "").toLowerCase()))
      return send(403, "Unexpected Host header.");

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://resolver.invalid");
    } catch {
      return send(400, "Bad request.");
    }
    // `?token=` wins over the header: links opened from other apps carry it.
    if (!tokenMatches(url.searchParams.get("token") ?? bearerToken(req), options.token)) {
      failures.push(now);
      return send(401, "Missing or wrong token.");
    }

    const match = /^\/a\/([^/]+)$/.exec(url.pathname);
    if (!match || !ANCHOR_ID_PATTERN.test(match[1])) return send(404, "Not found.");
    let resolution: AnchorResolution | undefined;
    try {
      resolution = options.resolve(match[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(503, `Could not read the Notes database: ${message}`);
    }
    if (!resolution) return send(404, "No such anchor.");
    if (resolution.status === "resolved" && resolution.url)
      return send(302, `Redirecting to ${resolution.url}`, { Location: resolution.url });
    return send(STATUS_CODE[resolution.status], `${resolution.status}: ${resolution.message}`);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

/** Start listening; resolves with the bound base URL once listening. */
export function startAnchorServer(
  options: AnchorServerOptions
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createAnchorServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : options.port;
      resolve({
        server,
        baseUrl: `http://${hostAuthority(options.host, port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Parsed `anchors serve` arguments. */
export interface AnchorServeArgs {
  port: number;
  tailnet: boolean;
  help: boolean;
}

export const ANCHORS_USAGE = `Usage: apple-notes-mcp anchors serve [--port N] [--tailnet]

Serves GET /a/<anchor-id>?token=<token>, redirecting to the paragraph's
current applenotes:// link. Binds 127.0.0.1 unless --tailnet is given, in
which case it binds this Mac's Tailscale address (it never changes Tailscale
or firewall settings). The token is APPLE_NOTES_MCP_ANCHORS_TOKEN (at least
${MIN_TOKEN_LENGTH} characters) or a random one printed at startup. The process
that runs it needs Full Disk Access. Stop it with Ctrl-C.`;

/** Parse the arguments after `anchors`. Throws on anything unknown. */
export function parseAnchorsArgs(argv: string[]): AnchorServeArgs {
  const args: AnchorServeArgs = { port: 0, tailnet: false, help: false };
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return { ...args, help: true };
  if (argv[0] !== "serve") throw new Error(`Unknown anchors command "${argv[0]}"`);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tailnet") args.tailnet = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--port") {
      const value = argv[++i];
      if (!value || !/^\d{1,5}$/.test(value) || Number(value) > 65535)
        throw new Error("--port needs a number from 0 to 65535");
      args.port = Number(value);
    } else throw new Error(`Unknown option "${arg}"`);
  }
  return args;
}

/**
 * Run `apple-notes-mcp anchors ...`. Resolves with the exit code once the
 * server has stopped (on SIGINT or SIGTERM), or at once for help and errors.
 */
export async function runAnchorsCli(
  argv: string[],
  {
    env = process.env,
    resolve,
    out = (text: string) => process.stdout.write(text),
    interfaces,
    signals = process,
  }: {
    env?: NodeJS.ProcessEnv;
    resolve: AnchorLookup;
    out?: (text: string) => void;
    interfaces?: ReturnType<typeof networkInterfaces>;
    signals?: Pick<NodeJS.Process, "once">;
  }
): Promise<number> {
  let args: AnchorServeArgs;
  try {
    args = parseAnchorsArgs(argv);
  } catch (error) {
    out(`${(error as Error).message}\n\n${ANCHORS_USAGE}\n`);
    return 2;
  }
  if (args.help) {
    out(ANCHORS_USAGE + "\n");
    return 0;
  }
  const host = args.tailnet ? findTailnetAddress(interfaces)?.address : "127.0.0.1";
  if (!host) {
    out("No Tailscale address (100.64.0.0/10) found on this Mac; is Tailscale connected?\n");
    return 1;
  }
  const fromEnv = env.APPLE_NOTES_MCP_ANCHORS_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv.length < MIN_TOKEN_LENGTH) {
    out(`APPLE_NOTES_MCP_ANCHORS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.\n`);
    return 1;
  }
  const token = fromEnv || newServerToken();
  let started: Awaited<ReturnType<typeof startAnchorServer>>;
  try {
    started = await startAnchorServer({ host, port: args.port, token, resolve });
  } catch (error) {
    out(`Could not listen on ${host}:${args.port}: ${(error as Error).message}\n`);
    return 1;
  }
  out(
    `Paragraph anchor resolver listening on ${started.baseUrl}\n` +
      `Links: ${started.baseUrl}/a/<anchor-id>?token=<token>\n` +
      (fromEnv
        ? "Token: from APPLE_NOTES_MCP_ANCHORS_TOKEN\n"
        : `Token (this run only): ${token}\n`) +
      "Press Ctrl-C to stop.\n"
  );
  await new Promise<void>((done) => {
    signals.once("SIGINT", () => done());
    signals.once("SIGTERM", () => done());
  });
  await started.close();
  return 0;
}
