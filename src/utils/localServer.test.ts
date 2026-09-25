/**
 * Shared helpers of the template editor and the anchor resolver: tailnet
 * address detection, token handling, the Host authority and the cross-origin
 * check. Pure functions; nothing listens.
 */
import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import {
  bearerToken,
  crossOriginRefusal,
  findTailnetAddress,
  hostAuthority,
  isTailnetIPv4,
  newServerToken,
  tokenMatches,
} from "./localServer.js";

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.255",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/32`,
});

describe("isTailnetIPv4", () => {
  it("accepts 100.64.0.0/10 only", () => {
    expect(isTailnetIPv4("100.64.0.1")).toBe(true);
    expect(isTailnetIPv4("100.101.102.103")).toBe(true);
    expect(isTailnetIPv4("100.127.255.255")).toBe(true);
    expect(isTailnetIPv4("100.63.255.255")).toBe(false);
    expect(isTailnetIPv4("100.128.0.1")).toBe(false);
    expect(isTailnetIPv4("192.168.1.2")).toBe(false);
    expect(isTailnetIPv4("100.64.0.256")).toBe(false);
    expect(isTailnetIPv4("fd7a:115c:a1e0::1")).toBe(false);
  });
});

describe("findTailnetAddress", () => {
  it("returns undefined when no interface has a tailnet address", () => {
    expect(
      findTailnetAddress({ lo0: [v4("127.0.0.1", true)], en0: [v4("192.168.1.20")] })
    ).toBeUndefined();
  });

  it("prefers a utun interface", () => {
    expect(findTailnetAddress({ en5: [v4("100.70.0.9")], utun4: [v4("100.101.1.2")] })).toEqual({
      address: "100.101.1.2",
      interface: "utun4",
    });
  });

  it("falls back to any non-internal interface in range", () => {
    expect(findTailnetAddress({ en5: [v4("100.70.0.9")], lo0: [v4("100.64.0.1", true)] })).toEqual({
      address: "100.70.0.9",
      interface: "en5",
    });
  });
});

describe("findTailnetAddress with several addresses per interface", () => {
  it("skips out-of-range and internal addresses and still prefers utun", () => {
    const interfaces = {
      en0: [v4("192.168.1.2"), v4("100.64.0.9")],
      utun4: [v4("100.101.102.103")],
      lo0: [v4("127.0.0.1", true)],
    };
    expect(findTailnetAddress(interfaces)?.address).toBe("100.101.102.103");
    expect(findTailnetAddress({ en0: [v4("100.128.0.1"), v4("100.63.255.255")] })).toBeUndefined();
    expect(findTailnetAddress({})).toBeUndefined();
  });
});

describe("tokens", () => {
  it("makes a fresh 64-character hex token each time", () => {
    const a = newServerToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newServerToken()).not.toBe(a);
  });

  it("compares exactly and never matches a missing token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });

  it("reads the Bearer value untrimmed and ignores other schemes", () => {
    const req = (authorization?: string) => ({ headers: { authorization } });
    expect(bearerToken(req("Bearer abc"))).toBe("abc");
    expect(bearerToken(req("Bearer  abc "))).toBe(" abc ");
    expect(bearerToken(req("Basic abc"))).toBeUndefined();
    expect(bearerToken(req())).toBeUndefined();
  });
});

describe("hostAuthority", () => {
  it("brackets IPv6 hosts only", () => {
    expect(hostAuthority("127.0.0.1", 8123)).toBe("127.0.0.1:8123");
    expect(hostAuthority("100.101.1.2", 80)).toBe("100.101.1.2:80");
    expect(hostAuthority("::1", 8123)).toBe("[::1]:8123");
  });
});

describe("crossOriginRefusal", () => {
  const origin = "http://127.0.0.1:8123";
  const req = (headers: IncomingHttpHeaders) => ({ headers });

  it("allows same-origin, direct and header-less requests", () => {
    expect(crossOriginRefusal(req({}), origin)).toBeUndefined();
    expect(crossOriginRefusal(req({ "sec-fetch-site": "none" }), origin)).toBeUndefined();
    expect(
      crossOriginRefusal(req({ "sec-fetch-site": "same-origin", origin }), origin, true)
    ).toBeUndefined();
  });

  it("refuses other sites and foreign origins", () => {
    expect(crossOriginRefusal(req({ "sec-fetch-site": "cross-site" }), origin)).toBe("cross-site");
    expect(crossOriginRefusal(req({ "sec-fetch-site": "same-site" }), origin)).toBe("cross-site");
    expect(crossOriginRefusal(req({ origin: "http://evil.example" }), origin)).toBe(
      "foreign-origin"
    );
  });

  it("requires the own Origin when asked", () => {
    expect(crossOriginRefusal(req({}), origin, true)).toBe("missing-origin");
  });
});
