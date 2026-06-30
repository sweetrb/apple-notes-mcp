import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, existsSync, mkdtempSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  assertSafeSavePath,
  readFileBase64,
  readFileBase64Capped,
  maxAttachmentBytes,
  fileSize,
  makeTempDir,
  cleanupTempDir,
  allowedSaveRoots,
} from "@/utils/attachmentFs.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanupTempDir));

describe("assertSafeSavePath (#27)", () => {
  it("accepts absolute paths under the temp dir and home dir", () => {
    const p = join(tmpdir(), "x.png");
    expect(assertSafeSavePath(p)).toBe(p);
    const h = join(homedir(), "Downloads", "x.png");
    expect(assertSafeSavePath(h)).toBe(h);
  });

  it("rejects empty, relative, and out-of-root paths", () => {
    expect(() => assertSafeSavePath("")).toThrow(/required/);
    expect(() => assertSafeSavePath("relative/x.png")).toThrow(/absolute/);
    expect(() => assertSafeSavePath("/etc/passwd")).toThrow(/outside allowed/);
  });

  it("blocks traversal that escapes an allowed root", () => {
    expect(() => assertSafeSavePath(join(tmpdir(), "..", "..", "etc", "x"))).toThrow(
      /outside allowed/
    );
  });

  it("exposes the allowed roots", () => {
    expect(allowedSaveRoots()).toEqual(expect.arrayContaining(["/Volumes"]));
  });
});

describe("base64 / size / temp helpers (#27)", () => {
  it("reads a file as base64 and reports its size", () => {
    const dir = mkdtempSync(join(tmpdir(), "anatt-"));
    dirs.push(dir);
    const f = join(dir, "f.bin");
    writeFileSync(f, Buffer.from("hello"));
    expect(readFileBase64(f)).toBe(Buffer.from("hello").toString("base64"));
    expect(fileSize(f)).toBe(5);
  });

  it("fileSize returns 0 for a missing file", () => {
    expect(fileSize(join(tmpdir(), "definitely-missing-xyz.bin"))).toBe(0);
  });

  it("makeTempDir creates a dir and cleanupTempDir removes it (idempotent)", () => {
    const dir = makeTempDir();
    expect(existsSync(dir)).toBe(true);
    cleanupTempDir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => cleanupTempDir(dir)).not.toThrow();
  });
});

describe("readFileBase64Capped / maxAttachmentBytes (size guard)", () => {
  it("reads files at or under the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "anatt-"));
    dirs.push(dir);
    const f = join(dir, "ok.bin");
    writeFileSync(f, Buffer.from("hello"));
    expect(readFileBase64Capped(f, 1024)).toBe(Buffer.from("hello").toString("base64"));
  });

  it("throws (without reading) when the file exceeds the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "anatt-"));
    dirs.push(dir);
    const f = join(dir, "big.bin");
    writeFileSync(f, Buffer.alloc(2048));
    expect(() => readFileBase64Capped(f, 1024)).toThrow(/exceeding the 1024-byte fetch limit/);
  });

  it("maxAttachmentBytes honors APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES and falls back to a sane default", () => {
    expect(maxAttachmentBytes({ APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES: "12345" })).toBe(12345);
    // Invalid / non-positive values fall back to the default (25 MB).
    expect(maxAttachmentBytes({ APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES: "0" })).toBe(25 * 1024 * 1024);
    expect(maxAttachmentBytes({ APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES: "nope" })).toBe(
      25 * 1024 * 1024
    );
    expect(maxAttachmentBytes({})).toBe(25 * 1024 * 1024);
  });
});
