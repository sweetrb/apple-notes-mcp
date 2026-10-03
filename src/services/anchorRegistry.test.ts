/**
 * The anchor registry file: location, permissions, atomic replacement, the
 * lock, refusal of symlinks and corrupt files, and de-duplication. Every test
 * works in a throwaway directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResult } from "../utils/errorCodes.js";
import type { ParagraphAnchor } from "../utils/paragraphAnchors.js";
import { AnchorRegistry, AnchorRegistryError, anchorRegistryPath } from "./anchorRegistry.js";

const candidate = (over: Partial<ParagraphAnchor> = {}): ParagraphAnchor => ({
  anchorId: "",
  noteIdentifier: "0A1B2C3D-0000-4000-8000-00000000000A",
  noteId: "x-coredata://S/ICNote/p1",
  paragraphId: "C3C3C3C3-C3C3-C3C3-C3C3-C3C3C3C3C3C3",
  paragraphIdStatus: "unique",
  text: "charlie",
  fingerprint: "f".repeat(32),
  prevFingerprint: null,
  nextFingerprint: "e".repeat(32),
  blockIndex: 3,
  style: "body",
  createdAt: "2026-09-24T12:00:00.000Z",
  ...over,
});

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof AnchorRegistryError ? error.reason : String(error);
  }
  return "no error";
};

describe("anchorRegistryPath", () => {
  it("defaults under Application Support and honours an absolute override", () => {
    expect(anchorRegistryPath({})).toMatch(
      /Library\/Application Support\/apple-notes-mcp\/paragraph-anchors\.json$/
    );
    expect(anchorRegistryPath({ APPLE_NOTES_MCP_ANCHOR_FILE: "/tmp/x/../a.json" })).toBe(
      "/tmp/a.json"
    );
    expect(reason(() => anchorRegistryPath({ APPLE_NOTES_MCP_ANCHOR_FILE: "rel.json" }))).toBe(
      "unsafe-path"
    );
  });
});

describe("AnchorRegistry", () => {
  let dir: string;
  let path: string;
  let registry: AnchorRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-registry-"));
    path = join(dir, "support", "paragraph-anchors.json");
    registry = new AnchorRegistry(path, 100);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("treats a missing file as empty and creates 0700/0600 on first write", () => {
    expect(registry.load()).toEqual([]);
    // Loading must not create the file. A failed read checks that without a separate exists-check.
    expect(() => readFileSync(path)).toThrow(/ENOENT/);
    const [{ anchor, created }] = registry.record([candidate()]);
    expect(created).toBe(true);
    expect(anchor.anchorId).toMatch(/^pa_[0-9a-f]{24}$/);
    expect(statSync(join(dir, "support")).mode & 0o777).toBe(0o700);
    // One descriptor for the mode check and the read, so both see the same file.
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(fd, "utf8"))).toEqual({ version: 1, anchors: [anchor] });
    } finally {
      closeSync(fd);
    }
    // No temporary or lock file is left behind.
    expect(readdirSync(join(dir, "support"))).toEqual(["paragraph-anchors.json"]);
  });

  it("reuses the anchor for the same paragraph and keeps distinct ones", () => {
    const [first] = registry.record([candidate()]);
    const again = registry.record([
      candidate({ createdAt: "later" }),
      candidate({ blockIndex: 4 }),
    ]);
    expect(again[0]).toEqual({ anchor: first.anchor, created: false });
    expect(again[1].created).toBe(true);
    expect(again[1].anchor.anchorId).not.toBe(first.anchor.anchorId);
    expect(registry.load()).toHaveLength(2);
  });

  it("gets, replaces and removes anchors", () => {
    const [{ anchor }] = registry.record([candidate()]);
    expect(registry.get(anchor.anchorId)).toEqual(anchor);
    const replaced = registry.replace({ ...anchor, blockIndex: 9, createdAt: "ignored" });
    expect(replaced).toMatchObject({ blockIndex: 9, createdAt: anchor.createdAt });
    expect(registry.remove([anchor.anchorId, "pa_ffffffffffffffffffffffff"])).toEqual([
      anchor.anchorId,
    ]);
    expect(reason(() => registry.get(anchor.anchorId))).toBe("anchor-not-found");
    expect(reason(() => registry.get("../etc/passwd"))).toBe("invalid-anchor-id");
    expect(reason(() => registry.replace(anchor))).toBe("anchor-not-found");
    expect(new AnchorRegistryError("anchor-not-found", "x").envelope).toEqual({
      code: "not_found",
      reason: "anchor-not-found",
    });
    expect(errorResult("No anchor", new AnchorRegistryError("registry-busy", "x"))).toMatchObject({
      structuredContent: { code: "operation_failed", reason: "registry-busy" },
    });
  });

  it("refuses a symlinked registry file or directory", () => {
    mkdirSync(join(dir, "support"));
    writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ version: 1, anchors: [] }));
    symlinkSync(join(dir, "elsewhere.json"), path);
    expect(reason(() => registry.load())).toBe("unsafe-path");
    expect(reason(() => registry.record([candidate()]))).toBe("unsafe-path");
    expect(readFileSync(join(dir, "elsewhere.json"), "utf8")).toBe('{"version":1,"anchors":[]}');

    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    const viaLink = new AnchorRegistry(join(dir, "linked", "a.json"), 100);
    expect(reason(() => viaLink.record([candidate()]))).toBe("unsafe-path");
    expect(readdirSync(join(dir, "real"))).toEqual([]);
  });

  it("reports a corrupt or foreign file and never overwrites it", () => {
    mkdirSync(join(dir, "support"));
    for (const body of [
      "{not json",
      JSON.stringify({ version: 2, anchors: [] }),
      JSON.stringify({ version: 1, anchors: [{ anchorId: "pa_1" }] }),
      JSON.stringify({
        version: 1,
        anchors: [candidate({ anchorId: "pa_" + "a".repeat(24), blockIndex: 1.5 })],
      }),
    ]) {
      writeFileSync(path, body);
      expect(reason(() => registry.load())).toBe("corrupt-registry");
      expect(reason(() => registry.record([candidate()]))).toBe("corrupt-registry");
      expect(readFileSync(path, "utf8")).toBe(body);
    }
  });

  it("treats an empty file as an empty registry and replaces it on the next write", () => {
    mkdirSync(join(dir, "support"));
    for (const body of ["", "  \n"]) {
      writeFileSync(path, body);
      expect(registry.load()).toEqual([]);
      registry.record([candidate()]);
      expect(registry.load()).toHaveLength(1);
      writeFileSync(path, body);
    }
  });

  it("waits for the lock, reports a busy registry, and clears a stale lock", () => {
    registry.record([candidate()]);
    const lock = `${path}.lock`;
    writeFileSync(lock, "12345");
    const started = Date.now();
    expect(reason(() => registry.record([candidate({ blockIndex: 5 })]))).toBe("registry-busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(registry.load()).toHaveLength(1);
    // A lock older than 30 seconds belongs to a process that died.
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    expect(registry.record([candidate({ blockIndex: 5 })])[0].created).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps both writers' anchors when two registries share a file", () => {
    const other = new AnchorRegistry(path, 100);
    registry.record([candidate({ blockIndex: 1 })]);
    other.record([candidate({ blockIndex: 2 })]);
    registry.record([candidate({ blockIndex: 3 })]);
    expect(
      registry
        .load()
        .map((a) => a.blockIndex)
        .sort()
    ).toEqual([1, 2, 3]);
  });

  it("does not leave the lock behind when a change throws", () => {
    registry.record([candidate()]);
    expect(() =>
      registry.update(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(registry.load()).toHaveLength(1);
  });
});
