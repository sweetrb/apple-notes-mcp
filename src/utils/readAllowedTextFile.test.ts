import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, readAllowedTextFile } from "@/utils/attachmentFs.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanupTempDir));
const tempDir = () => {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
};

describe("readAllowedTextFile", () => {
  it("reads UTF-8 text inside an allowed root and drops a byte-order mark", () => {
    const file = join(tempDir(), "note.md");
    writeFileSync(file, "\uFEFF# Plan\n\nCafé ☐");
    expect(readAllowedTextFile(file, 1024)).toBe("# Plan\n\nCafé ☐");
  });

  it("requires an absolute path", () => {
    expect(() => readAllowedTextFile("note.md", 1024)).toThrow(/must be absolute/);
  });

  it("refuses a file outside the allowed roots", () => {
    expect(() => readAllowedTextFile("/etc/hosts", 1024)).toThrow(/outside allowed locations/);
  });

  it("refuses a symbolic link, even one pointing inside the roots", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "real.md"), "text");
    symlinkSync(join(dir, "real.md"), join(dir, "link.md"));
    expect(() => readAllowedTextFile(join(dir, "link.md"), 1024)).toThrow(/symbolic link/);
  });

  it("refuses a path that escapes through a symlinked directory", () => {
    const dir = tempDir();
    symlinkSync("/etc", join(dir, "escape"), "dir");
    expect(() => readAllowedTextFile(join(dir, "escape", "hosts"), 1 << 20)).toThrow(
      /outside allowed locations/
    );
  });

  it("refuses a missing file, a directory, an empty file, and an oversized file", () => {
    const dir = tempDir();
    expect(() => readAllowedTextFile(join(dir, "missing.md"), 1024)).toThrow(/does not exist/);
    mkdirSync(join(dir, "sub"));
    expect(() => readAllowedTextFile(join(dir, "sub"), 1024)).toThrow(/not a regular file/);
    writeFileSync(join(dir, "empty.md"), "");
    expect(() => readAllowedTextFile(join(dir, "empty.md"), 1024)).toThrow(/is empty/);
    writeFileSync(join(dir, "big.md"), "x".repeat(11));
    expect(() => readAllowedTextFile(join(dir, "big.md"), 10)).toThrow(/over the 10-byte limit/);
  });

  it("refuses bytes that are not valid UTF-8", () => {
    const file = join(tempDir(), "latin1.md");
    writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(() => readAllowedTextFile(file, 1024)).toThrow(/not valid UTF-8/);
  });

  it("refuses a file in a directory outside the roots even under /private", () => {
    const outside = mkdtempSync("/private/var/tmp/anmcp-read-");
    dirs.push(outside);
    writeFileSync(join(outside, "x.md"), "x");
    expect(() => readAllowedTextFile(join(outside, "x.md"), 1024)).toThrow(/outside allowed/);
  });
});
