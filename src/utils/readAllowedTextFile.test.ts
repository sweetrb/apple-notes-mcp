import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_PRIVATE_CONTENT_ENV,
  allowedSaveRoots,
  cleanupTempDir,
  makeTempDir,
  privateContentReason,
  readAllowedTextFile,
} from "@/utils/attachmentFs.js";

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

  it("refuses hidden files and directories, which can hold credentials", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".ssh"));
    writeFileSync(join(dir, ".ssh", "id_ed25519"), "PRIVATE KEY");
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", ".env"), "TOKEN=x");
    expect(() => readAllowedTextFile(join(dir, ".ssh", "id_ed25519"), 1024)).toThrow(
      /hidden file or directory/
    );
    expect(() => readAllowedTextFile(join(dir, "project", ".env"), 1024)).toThrow(
      new RegExp(ALLOW_PRIVATE_CONTENT_ENV)
    );
    // A hidden directory reached through a visible symlinked directory is refused too.
    symlinkSync(join(dir, ".ssh"), join(dir, "keys"), "dir");
    expect(() => readAllowedTextFile(join(dir, "keys", "id_ed25519"), 1024)).toThrow(
      /hidden file or directory/
    );
  });

  it("reads hidden paths only when the server opts in", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".notes"));
    const file = join(dir, ".notes", "draft.md");
    writeFileSync(file, "draft");
    expect(readAllowedTextFile(file, 1024, allowedSaveRoots(), true)).toBe("draft");
    const previous = process.env[ALLOW_PRIVATE_CONTENT_ENV];
    process.env[ALLOW_PRIVATE_CONTENT_ENV] = "1";
    try {
      expect(readAllowedTextFile(file, 1024)).toBe("draft");
    } finally {
      if (previous === undefined) delete process.env[ALLOW_PRIVATE_CONTENT_ENV];
      else process.env[ALLOW_PRIVATE_CONTENT_ENV] = previous;
    }
  });

  it("treats ~/Library and hidden home paths as private, and documents as not", () => {
    const roots = allowedSaveRoots();
    expect(privateContentReason(join(homedir(), "Library", "Keychains", "x"), roots)).toBe(
      "~/Library"
    );
    expect(privateContentReason(join(homedir(), ".config", "gh", "hosts.yml"), roots)).toBe(
      "a hidden file or directory"
    );
    expect(privateContentReason(join(homedir(), ".aws", "credentials"), roots)).toBe(
      "a hidden file or directory"
    );
    expect(privateContentReason(join(homedir(), "Documents", "plan.md"), roots)).toBeNull();
    // iCloud Drive and File Provider folders hold documents, not app data.
    const icloud = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "a.md");
    expect(privateContentReason(icloud, roots)).toBeNull();
    const dropbox = join(homedir(), "Library", "CloudStorage", "Dropbox", "a.md");
    expect(privateContentReason(dropbox, roots)).toBeNull();
    expect(
      privateContentReason(join(homedir(), "Library", "CloudStorage", ".x", "a.md"), roots)
    ).toBe("a hidden file or directory");
    expect(privateContentReason(join(homedir(), "Library", "Mobile Documentsx", "a"), roots)).toBe(
      "~/Library"
    );
    expect(privateContentReason("/Volumes/Drive/notes/plan.md", roots)).toBeNull();
  });

  it("refuses a FIFO without blocking on open", () => {
    const fifo = join(tempDir(), "pipe.md");
    execFileSync("mkfifo", [fifo]);
    expect(() => readAllowedTextFile(fifo, 1024)).toThrow(/not a regular file/);
  });
});
