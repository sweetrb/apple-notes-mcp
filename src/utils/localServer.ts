/**
 * Shared pieces of the two opt-in local HTTP servers, the template editor
 * (`templates edit`) and the paragraph anchor resolver (`anchors serve`).
 *
 * - Address: `findTailnetAddress` finds this Mac's Tailscale IPv4 address for
 *   `--tailnet`. Tailscale gives each device an address in the carrier-grade
 *   NAT range 100.64.0.0/10 on a `utun` interface. This scans the network
 *   interfaces only: it never runs the tailscale CLI and never reads or
 *   changes Tailscale settings, serve or funnel configuration, or the
 *   firewall.
 * - Token: `newServerToken` makes the per-run token, `bearerToken` reads an
 *   `Authorization: Bearer` header, and `tokenMatches` compares in constant
 *   time. Each server decides which of `?token=` and the header wins.
 * - Host: `hostAuthority` is the `host:port` a request's Host header must
 *   name, which blocks DNS rebinding (a hostile name resolving to this
 *   address).
 * - Origin: `crossOriginRefusal` refuses requests a browser marks as coming
 *   from another site. The template editor uses it; the anchor resolver does
 *   not, because its links are meant to be opened from other apps and pages.
 *
 * @module utils/localServer
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** True for an IPv4 address in 100.64.0.0/10. */
export function isTailnetIPv4(address: string): boolean {
  const match = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return false;
  const [second, third, fourth] = match.slice(1).map(Number);
  return second >= 64 && second <= 127 && third <= 255 && fourth <= 255;
}

/**
 * The first 100.64.0.0/10 IPv4 address on a non-internal interface, preferring
 * `utun*` interfaces, or undefined when there is none.
 */
export function findTailnetAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): { address: string; interface: string } | undefined {
  const candidates: Array<{ address: string; interface: string }> = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && isTailnetIPv4(info.address))
        candidates.push({ address: info.address, interface: name });
    }
  }
  return candidates.find((c) => c.interface.startsWith("utun")) ?? candidates[0];
}

/** A fresh per-run token: 32 random bytes as hex. */
export function newServerToken(): string {
  return randomBytes(32).toString("hex");
}

/** The value after `Bearer ` in the Authorization header, untrimmed. */
export function bearerToken(req: Pick<IncomingMessage, "headers">): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

/** Constant-time token comparison; a missing or empty token never matches. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `host:port`, with an IPv6 host in brackets, as a Host header names it. */
export function hostAuthority(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Why `crossOriginRefusal` refused a request. */
export type CrossOriginRefusal = "cross-site" | "foreign-origin" | "missing-origin";

/**
 * Why a request from another site must be refused, or undefined when it may
 * proceed. `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`
 * ("cross-site"); `Origin`, when sent, must be `origin` ("foreign-origin").
 * With `requireOrigin` (state-changing requests), `Origin` must be present
 * ("missing-origin"), which a cross-site HTML form cannot arrange.
 */
export function crossOriginRefusal(
  req: Pick<IncomingMessage, "headers">,
  origin: string,
  requireOrigin = false
): CrossOriginRefusal | undefined {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site";
  const requestOrigin = req.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) return "foreign-origin";
  if (requireOrigin && requestOrigin !== origin) return "missing-origin";
  return undefined;
}
