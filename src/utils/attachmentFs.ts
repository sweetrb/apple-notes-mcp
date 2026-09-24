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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
 * Locations no save may land in even though they sit inside an allowed root
 * (#208). The Notes group container holds Notes' own database and media;
 * writing an export there could confuse Notes or corrupt its storage.
 */
export function deniedSaveRoots(): string[] {
  return [join(homedir(), "Library/Group Containers/group.com.apple.notes")];
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
export function ensureParentDir(
  abs: string,
  roots: string[] = allowedSaveRoots(),
  denied: string[] = deniedSaveRoots()
): void {
  assertSafeSavePath(abs, roots, denied);
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
 * After the allowlist, the destination is checked against `denied` (by default
 * the Notes group container, #208): both the lexical and the canonical form of
 * the destination, compared case-insensitively against both the lexical and
 * canonical form of each denied root, so neither a symlink nor a respelled
 * segment can reach inside it.
 *
 * The returned path is the caller's own spelling (`resolve(p)`), not the
 * canonical one, so `/tmp/x` still writes to `/tmp/x` — validated to be the same
 * file as the canonical `/private/tmp/x`.
 */
export function assertSafeSavePath(
  p: string,
  roots: string[] = allowedSaveRoots(),
  denied: string[] = deniedSaveRoots()
): string {
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

  const deniedForms = [
    ...new Set([...denied.map((d) => resolve(d)), ...canonicalRoots(denied)]),
  ].map((d) => d.toLowerCase());
  if ([abs, canonicalDest].some((form) => isWithinRoots(form.toLowerCase(), deniedForms))) {
    throw new Error(`Refusing to write inside the Notes library container: "${abs}"`);
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

/**
 * Check that a path a tool will read is absolute and that both it and its
 * canonical form stay inside `roots` (home, temp, /Volumes by default).
 * Returns the resolved absolute path. The caller must still open it with
 * O_NOFOLLOW and check the descriptor.
 *
 * @throws when the path is empty, relative, missing, or outside the roots
 */
export function assertReadableInRoots(
  p: string,
  roots: string[] = allowedSaveRoots(),
  label = "Content file"
): string {
  if (!p || !p.trim()) throw new Error(`A ${label.toLowerCase()} path is required.`);
  if (!isAbsolute(p)) throw new Error(`${label} path must be absolute: "${p}"`);
  const abs = resolve(p);
  if (!isWithinRoots(abs, roots))
    throw new Error(`Refusing to read outside allowed locations (home, temp, /Volumes): "${abs}"`);
  let canonical: string;
  try {
    canonical = canonicalize(abs);
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved: "${abs}"`);
  }
  if (!isWithinRoots(canonical, canonicalRoots(roots)))
    throw new Error(
      `Refusing to read outside allowed locations (home, temp, /Volumes): "${abs}" resolves to "${canonical}".`
    );
  return abs;
}

/**
 * Setting this to `1` lets {@link readAllowedTextFile} read hidden paths and
 * `~/Library` too. Off by default: those hold credentials and app data.
 */
export const ALLOW_PRIVATE_CONTENT_ENV = "APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS";

/**
 * Why `p` is a private location a content read should not reach, or null.
 *
 * Private means a hidden component below the containing root (`~/.ssh`,
 * `~/.aws`, `~/.config/gh/hosts.yml`, a project's `.env`) or anything under
 * `~/Library` (keychains, cookies, app containers) except iCloud Drive
 * (`~/Library/Mobile Documents`) and cloud storage folders
 * (`~/Library/CloudStorage`). It narrows the
 * `save-attachment` roots (home, temp, /Volumes) to places a user keeps
 * documents. `roots` must be in the same spelling as `p` (both literal, or
 * both canonical).
 */
export function privateContentReason(p: string, roots: string[]): string | null {
  const containing = roots
    .map((r) => (r.endsWith(sep) ? r.slice(0, -1) : r))
    .filter((r) => isWithinRoots(p, [r]))
    .sort((a, b) => b.length - a.length)[0];
  const below = containing === undefined ? p : relative(containing, p);
  if (below.split(sep).some((part) => part.startsWith("."))) return "a hidden file or directory";
  const home = resolve(homedir());
  const libraries = [
    join(home, "Library"),
    ...canonicalRoots([home]).map((h) => join(h, "Library")),
  ];
  if (!isWithinRoots(p, libraries)) return null;
  // iCloud Drive and File Provider cloud folders (Dropbox, Google Drive,
  // OneDrive, ...) live under ~/Library but hold the user's documents.
  const cloudDocuments = libraries.flatMap((l) => CLOUD_DOCUMENT_DIRS.map((d) => join(l, d)));
  return isWithinRoots(p, cloudDocuments) ? null : "~/Library";
}

/** Folders under `~/Library` that hold user documents, not app data. */
const CLOUD_DOCUMENT_DIRS = ["Mobile Documents", "CloudStorage"];

/**
 * Read a local UTF-8 text file that a tool takes as a content source (for
 * example `create-note`'s `contentPath`).
 *
 * The same roots that bound `save-attachment` bound this read, so a caller can
 * source content only from home, temp, or /Volumes, never from system or other
 * users' locations. Within them, hidden paths and `~/Library` are refused (see
 * {@link privateContentReason}) unless `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`,
 * so a prompt cannot pull `~/.ssh/id_ed25519` into a synced note. The path must
 * be absolute and its canonical form must stay inside a root.
 *
 * The file is opened with O_NOFOLLOW, which refuses a symbolic link in the
 * final component only, and O_NONBLOCK, so a FIFO cannot block the event loop.
 * A directory component swapped for a symlink between the check and the open
 * is caught afterwards: the path is canonicalized again, checked again, and
 * must name the same file (device and inode) as the open descriptor. That
 * narrows the race to a writer who can swap directories several times within
 * one call; it cannot see through a hard link, which no path check can.
 * The size is checked before reading and the bytes must decode as strict UTF-8.
 *
 * @throws on any path, type, size, or encoding violation
 */
export function readAllowedTextFile(
  p: string,
  maxBytes: number,
  roots: string[] = allowedSaveRoots(),
  allowPrivate = process.env[ALLOW_PRIVATE_CONTENT_ENV] === "1"
): string {
  const abs = assertReadableInRoots(p, roots);
  const assertNotPrivate = (candidate: string, candidateRoots: string[]) => {
    if (allowPrivate) return;
    const reason = privateContentReason(candidate, candidateRoots);
    if (reason)
      throw new Error(
        `Refusing to read "${abs}": it is in ${reason}, which can hold credentials or app data. ` +
          `Move the file to a regular folder, or set ${ALLOW_PRIVATE_CONTENT_ENV}=1 for the server to allow it.`
      );
  };
  assertNotPrivate(abs, roots);
  assertNotPrivate(canonicalize(abs), canonicalRoots(roots));
  let descriptor: number;
  try {
    descriptor = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error(`Refusing to read the symbolic link "${abs}".`);
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Content file is not a regular file: "${abs}"`);
    // Re-resolve after the open: the descriptor must be the file the checked
    // path names now, and that path must still be allowed.
    let after: string;
    try {
      after = canonicalize(abs);
    } catch {
      throw new Error(`Content file changed while it was being opened; try again: "${abs}"`);
    }
    if (!isWithinRoots(after, canonicalRoots(roots)))
      throw new Error(
        `Refusing to read outside allowed locations (home, temp, /Volumes): "${abs}" resolves to "${after}".`
      );
    assertNotPrivate(after, canonicalRoots(roots));
    const named = statSync(after);
    if (named.dev !== stat.dev || named.ino !== stat.ino)
      throw new Error(`Content file changed while it was being opened; try again: "${abs}"`);
    if (stat.size === 0) throw new Error(`Content file is empty: "${abs}"`);
    if (stat.size > maxBytes)
      throw new Error(`Content file is ${stat.size} bytes, over the ${maxBytes}-byte limit.`);
    const bytes = readFileSync(descriptor);
    if (bytes.length !== stat.size)
      throw new Error("Content file changed while it was being read; try again");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      throw new Error(`Content file is not valid UTF-8 text: "${abs}"`);
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Remove a temp dir tree, ignoring errors. */
export function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
