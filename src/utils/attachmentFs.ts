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

/** Read a file as base64. */
export function readFileBase64(p: string): string {
  return readFileSync(p).toString("base64");
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
