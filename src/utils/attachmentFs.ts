/**
 * Filesystem helpers for saving / fetching note attachments (#27).
 *
 * Notes.app exports an attachment to a path via AppleScript `save`. These helpers
 * keep that safe (no writing outside sensible roots, no path traversal) and
 * provide a base64 read for the fetch-attachment tool.
 *
 * @module utils/attachmentFs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { isAbsolute, resolve, sep } from "path";
import { homedir, tmpdir } from "os";

/** Roots an attachment may be written to. */
export function allowedSaveRoots(): string[] {
  return [resolve(homedir()), resolve(tmpdir()), "/Volumes", "/private/var/folders", "/tmp"];
}

/**
 * Validate a user-supplied destination path. Returns the resolved absolute path,
 * or throws if it is relative or escapes the allowed roots.
 */
export function assertSafeSavePath(p: string, roots: string[] = allowedSaveRoots()): string {
  if (!p || !p.trim()) throw new Error("A destination path is required.");
  if (!isAbsolute(p)) throw new Error(`Destination path must be absolute: "${p}"`);
  const abs = resolve(p);
  const ok = roots.some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep));
  if (!ok) {
    throw new Error(`Refusing to write outside allowed locations (home, temp, /Volumes): "${abs}"`);
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
