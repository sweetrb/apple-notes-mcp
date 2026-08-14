import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  ensureParentDir,
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

  it("accepts /private/tmp, the real path behind the /tmp symlink", () => {
    // macOS's /tmp is a symlink to /private/tmp. A caller passing the resolved
    // real path must not be rejected while the symlinked spelling is accepted.
    expect(assertSafeSavePath("/private/tmp/x.png")).toBe("/private/tmp/x.png");
    expect(assertSafeSavePath("/tmp/x.png")).toBe("/tmp/x.png");
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

/**
 * Symlink escape: `resolve()` collapses `..` but knows nothing about symlinks,
 * so a link INSIDE an allowed root used to pass the prefix check and the write
 * followed it straight out. Every fixture below is built inside `makeTempDir()`
 * — an allowed root — so the assertions reach the symlink logic instead of
 * dying on the lexical check that already existed.
 *
 * `/private/var/tmp` is the escape target: it is writable and is deliberately
 * NOT under any allowed root (the roots cover `/private/var/folders`, not
 * `/private/var/tmp`), which lets the mkdir test prove nothing was created.
 */
describe("assertSafeSavePath — symlink escape", () => {
  const outsideRoots = () => {
    const dir = mkdtempSync("/private/var/tmp/anatt-outside-");
    dirs.push(dir);
    return dir;
  };

  it("refuses a destination reached through a symlinked directory component", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    symlinkSync("/etc", join(dir, "escape"), "dir");
    expect(() => assertSafeSavePath(join(dir, "escape", "hosts"))).toThrow(/outside allowed/);
  });

  it("refuses a not-yet-existing destination several levels below the symlink", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    symlinkSync(outsideRoots(), join(dir, "escape"), "dir");
    expect(() => assertSafeSavePath(join(dir, "escape", "deep", "nested", "x.png"))).toThrow(
      /outside allowed/
    );
  });

  it("refuses a destination that already exists as a symlink", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    // Points outside the roots: following it is how a file elsewhere gets clobbered.
    symlinkSync("/etc/hosts", join(dir, "clobber-outside"));
    expect(() => assertSafeSavePath(join(dir, "clobber-outside"))).toThrow(/symbolic link/);

    // Refused even when the link target is itself inside an allowed root: the
    // caller asked for this path, not for whatever it currently points at.
    const real = join(dir, "real.png");
    writeFileSync(real, "x");
    symlinkSync(real, join(dir, "clobber-inside"));
    expect(() => assertSafeSavePath(join(dir, "clobber-inside"))).toThrow(/symbolic link/);
  });

  it("still accepts a symlink that stays inside the allowed roots", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const target = makeTempDir();
    dirs.push(target);
    symlinkSync(target, join(dir, "inside"), "dir");
    const dest = join(dir, "inside", "x.png");
    expect(assertSafeSavePath(dest)).toBe(dest);
  });

  it("accepts the real path behind the /tmp and /var/folders symlinks", () => {
    // macOS's /tmp and /var are symlinks into /private. A caller that passes the
    // already-resolved real path must not be refused by the canonicalization.
    const dir = makeTempDir();
    dirs.push(dir);
    const realDir = realpathSync.native(dir);
    expect(realDir.startsWith("/private/")).toBe(true);
    expect(() => assertSafeSavePath(join(realDir, "x.png"))).not.toThrow();
    expect(() => assertSafeSavePath("/private/tmp/x.png")).not.toThrow();
    expect(() => assertSafeSavePath("/tmp/x.png")).not.toThrow();
  });

  it("ensureParentDir validates BEFORE mkdir, so mkdir -p cannot build a path through the symlink", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const outside = outsideRoots();
    symlinkSync(outside, join(dir, "escape"), "dir");

    // The side effect is asserted BEFORE the throw, so a validation-after-mkdir
    // implementation fails on the directory it created rather than on the
    // missing error — which is the behaviour actually being guarded.
    let threw = false;
    try {
      ensureParentDir(join(dir, "escape", "deep", "nested", "x.png"));
    } catch {
      threw = true;
    }
    expect(existsSync(join(outside, "deep"))).toBe(false);
    expect(threw).toBe(true);
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
    expect(maxAttachmentBytes({ APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES: "0" })).toBe(
      25 * 1024 * 1024
    );
    expect(maxAttachmentBytes({ APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES: "nope" })).toBe(
      25 * 1024 * 1024
    );
    expect(maxAttachmentBytes({})).toBe(25 * 1024 * 1024);
  });
});

describe("ensureParentDir", () => {
  it("creates missing intermediate directories for a save destination", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dest = join(dir, "deep", "nested", "photo.png");
    expect(existsSync(join(dir, "deep", "nested"))).toBe(false);
    ensureParentDir(dest);
    expect(existsSync(join(dir, "deep", "nested"))).toBe(true);
    writeFileSync(dest, "x");
    expect(existsSync(dest)).toBe(true);
  });

  it("is a no-op when the parent already exists", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    expect(() => ensureParentDir(join(dir, "photo.png"))).not.toThrow();
  });
});

describe("the boundary compares path segments, not string prefixes", () => {
  it("refuses a REAL sibling dir whose name merely shares an allowed root's prefix", () => {
    // This has to use an existing sibling and an injected root set. A
    // non-existent path like /Volumes-evil is already refused for an unrelated
    // reason (its deepest existing ancestor is "/", which is in no root), so it
    // would pass even with the boundary broken — proving nothing.
    const box = mkdtempSync(join(homedir(), ".anatt-seg-"));
    try {
      const root = join(box, "allowed");
      const sibling = join(box, "allowedevil"); // shares the "allowed" prefix
      mkdirSync(root);
      mkdirSync(sibling);

      // Inside the root: fine.
      expect(() => assertSafeSavePath(join(root, "ok.png"), [root])).not.toThrow();
      // Prefix-sharing sibling: must be refused. A bare startsWith admits it.
      expect(() => assertSafeSavePath(join(sibling, "pwned.png"), [root])).toThrow(
        /Refusing to write outside/
      );
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  it("still accepts ordinary paths inside the real allowed roots", () => {
    expect(() => assertSafeSavePath(join(homedir(), "Downloads", "x.png"))).not.toThrow();
    expect(() => assertSafeSavePath("/private/tmp/x.png")).not.toThrow();
  });
});
