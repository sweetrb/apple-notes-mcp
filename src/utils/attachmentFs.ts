/**
 * Filesystem helpers for saving / fetching note attachments (#27).
 *
 * Notes.app exports an attachment to a path via AppleScript `save`. These helpers
 * keep that safe (no writing outside sensible roots, no path traversal, no
 * escaping through a symlinked path component) and provide a base64 read for the
 * fetch-attachment tool.
 *
 * @module utils/attachmentFs
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir, tmpdir } from "os";

/**
 * Roots an attachment may be written to. `/private/tmp` is listed alongside
 * `/tmp` because macOS's `/tmp` is a symlink to it: a caller that passes the
 * resolved real path must not be rejected while the symlinked spelling of the
 * same directory is accepted (the same reason `/private/var/folders` is here).
 */
export function allowedSaveRoots(): string[] {
  return [
    resolve(homedir()),
    resolve(tmpdir()),
    "/Volumes",
    "/private/var/folders",
    "/tmp",
    "/private/tmp",
  ];
}

/**
 * Canonicalize with the platform call, not the JS emulation.
 *
 * `fs.realpathSync` resolves symlinks but preserves whatever casing the caller
 * supplied; only `fs.realpathSync.native` returns the true on-disk name. macOS
 * APFS is case-insensitive by default, so without the native call an exact-case
 * comparison is defeated by respelling one segment — the same directory reached
 * as `/Users/rob/…` and `/users/rob/…` would canonicalize to two different
 * strings and only one of them would match a root.
 *
 * Both the candidate and the roots go through this, which also keeps the
 * comparison correct on case-sensitive volumes, where the respelling simply does
 * not exist and canonicalization throws.
 */
function canonicalize(path: string): string {
  return realpathSync.native(path);
}

/**
 * True if `candidate` is one of `roots` or strictly inside one.
 *
 * The boundary is a path SEGMENT, not a string prefix: a bare `startsWith`
 * would admit a sibling whose name merely shares the prefix (`/Volumes-evil`
 * startsWith `/Volumes`; `/Users/robother` startsWith `/Users/rob`). Both
 * arguments must already be absolute.
 */
function isWithinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return candidate === base || candidate.startsWith(base + sep);
  });
}

/**
 * The allowed roots in their true on-disk spelling. A root that cannot be
 * resolved (it does not exist on this machine) keeps its literal form: it can
 * authorize nothing until it exists, and the candidate check fails on its own.
 */
function canonicalRoots(roots: string[]): string[] {
  const canonical: string[] = [];
  for (const root of roots) {
    const abs = resolve(root);
    let resolved: string;
    try {
      resolved = canonicalize(abs);
    } catch {
      resolved = abs;
    }
    if (!canonical.includes(resolved)) canonical.push(resolved);
  }
  return canonical;
}

/** True if the entry exists, symlinks NOT followed (a dangling link still counts). */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    // Only "genuinely absent" may report false. Any other failure — EACCES on a
    // non-traversable parent, ELOOP — means something IS there that we could not
    // inspect, and reporting it absent makes the ancestor walk step straight past
    // it and treat a real (possibly symlinked) component as an uncanonicalized
    // tail. Fail closed: treat it as present so the boundary check runs against
    // it rather than around it.
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ENOTDIR");
  }
}

/**
 * The deepest ancestor of `abs` (possibly `abs` itself) that exists on disk.
 *
 * The destination file normally does not exist yet, so the whole path cannot be
 * canonicalized directly — but every component that DOES exist can be, and that
 * is where a symlink escape has to live.
 */
function deepestExistingAncestor(abs: string): string {
  let current = abs;
  for (;;) {
    if (entryExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Ensure the parent directory of a save destination exists. Notes.app's
 * AppleScript `save` does not create intermediate directories; without this it
 * fails with an opaque "Failed saving an attachment to <path>" error.
 *
 * Validates first, and throws exactly as `assertSafeSavePath` does: `mkdir -p`
 * happily creates directories THROUGH a symlink, so creating the parent before
 * the boundary check would plant the escape it is meant to prevent. Re-checking
 * here (callers already validate) keeps that ordering true no matter who calls.
 */
export function ensureParentDir(abs: string, roots: string[] = allowedSaveRoots()): void {
  assertSafeSavePath(abs, roots);
  mkdirSync(dirname(abs), { recursive: true });
}

/**
 * Validate a user-supplied destination path. Returns the resolved absolute path,
 * or throws if it is relative, escapes the allowed roots lexically, or would
 * reach outside them through a symlinked path component.
 *
 * `resolve()` alone is not a boundary: it collapses `..` but knows nothing about
 * symlinks, so a link INSIDE an allowed root (`~/escape -> /etc`) passed the old
 * prefix check and the subsequent write followed it out. The destination file
 * usually does not exist yet, so this canonicalizes the deepest EXISTING
 * ancestor — where any symlink must be — checks that against the canonicalized
 * roots, then re-checks the fully reassembled destination. A destination that
 * already exists as a symlink is refused outright: following it is how a file
 * outside the roots gets clobbered.
 *
 * The returned path is the caller's own spelling (`resolve(p)`), not the
 * canonical one, so `/tmp/x` still writes to `/tmp/x` — validated to be the same
 * file as the canonical `/private/tmp/x`.
 */
export function assertSafeSavePath(p: string, roots: string[] = allowedSaveRoots()): string {
  if (!p || !p.trim()) throw new Error("A destination path is required.");
  if (!isAbsolute(p)) throw new Error(`Destination path must be absolute: "${p}"`);
  const abs = resolve(p);
  if (!isWithinRoots(abs, roots)) {
    throw new Error(`Refusing to write outside allowed locations (home, temp, /Volumes): "${abs}"`);
  }

  const ancestor = deepestExistingAncestor(abs);
  if (ancestor === abs && lstatSync(abs).isSymbolicLink()) {
    throw new Error(`Refusing to write to the symbolic link "${abs}".`);
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = canonicalize(ancestor);
  } catch {
    throw new Error(`Destination path cannot be resolved: "${abs}"`);
  }

  const suffix = relative(ancestor, abs);
  if (suffix.split(sep).includes("..")) {
    throw new Error(`Refusing to write outside allowed locations (home, temp, /Volumes): "${abs}"`);
  }
  const canonicalDest = suffix ? join(canonicalAncestor, suffix) : canonicalAncestor;

  const allowed = canonicalRoots(roots);
  if (!isWithinRoots(canonicalAncestor, allowed) || !isWithinRoots(canonicalDest, allowed)) {
    throw new Error(
      `Refusing to write outside allowed locations (home, temp, /Volumes): "${abs}" ` +
        `resolves to "${canonicalDest}" through a symbolic link.`
    );
  }

  return abs;
}

/**
 * Default upper bound on an attachment that `fetch-attachment` will base64-encode
 * into a single MCP response. `readFileSync` loads the whole file into memory and
 * base64 grows it ~33%, so an unbounded read of a multi-GB attachment (video,
 * disk image) could exhaust memory. 25 MB is generous for the inline-fetch use
 * case (docs, images, PDFs); larger attachments should be exported to disk with
 * `save-attachment` instead. Overridable via APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES.
 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Resolve the configured max attachment size (bytes) for inline base64 fetch. */
export function maxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_ATTACHMENT_BYTES;
}

/** Read a file as base64. */
export function readFileBase64(p: string): string {
  return readFileSync(p).toString("base64");
}

/**
 * Read a file as base64, refusing files larger than `maxBytes`.
 *
 * Guards `fetch-attachment` against unbounded in-memory reads: the size is
 * checked from filesystem metadata BEFORE the file is read, so an oversized
 * attachment is rejected with a clear error instead of loading it (and its
 * ~33%-larger base64) into memory. (`APPLE_NOTES_MCP_MAX_BUFFER` does not apply
 * to `readFileSync`.)
 *
 * @throws if the file exceeds `maxBytes`
 */
export function readFileBase64Capped(p: string, maxBytes: number = maxAttachmentBytes()): string {
  const size = fileSize(p);
  if (size > maxBytes) {
    throw new Error(
      `Attachment is ${size} bytes, exceeding the ${maxBytes}-byte fetch limit ` +
        `(APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES). Use save-attachment to export it to disk instead.`
    );
  }
  return readFileBase64(p);
}

/** Byte size of a file (0 if missing). */
export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Make a private temp dir for a one-shot attachment export; caller cleans up. */
export function makeTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), "apple-notes-att-"));
}

/** Remove a temp dir tree, ignoring errors. */
export function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
