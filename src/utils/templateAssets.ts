/**
 * Files for templated Markdown exports: asset writers with stable
 * content-hashed names, a writer that links to the original files, the
 * per-note assets directory a template asks for, and reading a template file
 * from an allowed location.
 *
 * Nothing here replaces or deletes an existing file. A hashed asset whose
 * name is already taken is reused only when the existing regular file has the
 * same content; anything else is reported as an error for that asset.
 *
 * @module utils/templateAssets
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertExportPath,
  directoryFailure,
  encodePathUrl,
  safeAssetName,
  sniffMime,
  type AssetWriter,
  type PlacedAsset,
  type ResolvedAsset,
} from "./exportAssets.js";
import {
  fillPlaceholders,
  MAX_TEMPLATE_BYTES,
  type PlaceholderValues,
} from "./markdownTemplate.js";
import { readAllowedFile } from "./attachmentFs.js";

const CHUNK = 1024 * 1024;

/**
 * Open a regular file without following a final symlink. O_NONBLOCK keeps a
 * FIFO from blocking the event loop (it is then refused as not a regular
 * file); it does not affect reading a regular file.
 */
function openRegular(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("not a regular file");
  }
  return fd;
}

/** SHA-256 of a file's content and its first bytes. */
function digest(fd: number): { hash: string; head: Buffer } {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(CHUNK);
  let head = Buffer.alloc(0);
  for (let position = 0; ;) {
    const n = readSync(fd, chunk, 0, chunk.length, position);
    if (n <= 0) break;
    if (position === 0) head = Buffer.from(chunk.subarray(0, Math.min(n, 16)));
    hash.update(chunk.subarray(0, n));
    position += n;
  }
  return { hash: hash.digest("hex"), head };
}

/** Markdown URL for a file: relative to `linkBase` when given, else absolute. */
function urlFor(target: string, linkBase: string | undefined): string {
  return encodePathUrl(linkBase ? relative(linkBase, target).split(sep).join("/") : target);
}

/**
 * Copies assets into one directory under stable names: a sanitized stem plus
 * the first eight hex digits of the content's SHA-256 (`photo-1a2b3c4d.jpg`).
 * Re-exporting the same file reuses the existing copy; a different file under
 * that name is refused, never replaced. The directory must not be a symlink.
 */
export class HashedSidecarWriter implements AssetWriter {
  private readonly placed = new Map<string, { url: string; mime: string }>();
  private ready = false;
  /** Absolute paths of files written or reused. */
  readonly files: string[] = [];
  count = 0;
  /** Set when the directory could not be created; see SidecarWriter.directoryError. */
  directoryError?: string;

  constructor(
    readonly dir: string,
    private readonly linkBase?: string
  ) {}

  /** Creates the directory once; returns an error message when it cannot. */
  private prepare(): string | undefined {
    if (this.ready) return undefined;
    try {
      assertExportPath(this.dir);
      mkdirSync(this.dir, { recursive: true });
      if (!lstatSync(this.dir).isDirectory())
        throw new Error("assets directory is not a directory");
    } catch (error) {
      return (this.directoryError = directoryFailure(this.dir, error));
    }
    this.ready = true;
    return undefined;
  }

  place(asset: ResolvedAsset): PlacedAsset {
    const done = this.placed.get(asset.path);
    if (done) return done;
    if (this.directoryError) return { error: this.directoryError };
    let source: number;
    try {
      source = openRegular(asset.path);
    } catch {
      return { error: "unreadable" };
    }
    try {
      const { hash, head } = digest(source);
      const mime = sniffMime(head, asset.name);
      const directoryError = this.prepare();
      if (directoryError) return { error: directoryError };
      const name = safeAssetName(asset.name, mime);
      const ext = extname(name);
      const target = join(
        this.dir,
        `${name.slice(0, name.length - ext.length)}-${hash.slice(0, 8)}${ext}`
      );
      let existing: number | undefined;
      try {
        existing = openRegular(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") return { error: "destination-not-regular" };
      }
      if (existing !== undefined) {
        try {
          if (digest(existing).hash !== hash) return { error: "name-taken" };
        } finally {
          closeSync(existing);
        }
      } else this.copy(source, target);
      this.count++;
      this.files.push(target);
      const result = { url: urlFor(target, this.linkBase), mime };
      this.placed.set(asset.path, result);
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      closeSync(source);
    }
  }

  /**
   * Copy to a private temporary name, then hard-link it into place, so the
   * hashed name only ever holds complete content: an interrupted copy can't
   * leave a truncated file that later exports would report as name-taken.
   * Where the volume has no hard links, copy straight to the hashed name and
   * remove it if the copy fails.
   */
  private copy(source: number, target: string) {
    const temp = join(this.dir, `.asset-${randomBytes(6).toString("hex")}.tmp`);
    writeNew(source, temp);
    try {
      linkSync(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTSUP" && code !== "EPERM" && code !== "EXDEV") throw error;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* already gone */
      }
    }
    writeNew(source, target);
  }
}

/** Create `target` (never replacing anything) with `source`'s content; remove it on failure. */
function writeNew(source: number, target: string) {
  const out = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644
  );
  try {
    const chunk = Buffer.alloc(CHUNK);
    for (let position = 0; ;) {
      const n = readSync(source, chunk, 0, chunk.length, position);
      if (n <= 0) break;
      let written = 0;
      while (written < n) written += writeSync(out, chunk, written, n - written);
      position += n;
    }
  } catch (error) {
    closeSync(out);
    try {
      unlinkSync(target);
    } catch {
      /* already gone */
    }
    throw error;
  }
  closeSync(out);
}

/** Links to the original files in place. Copies nothing. */
export class ReferenceWriter implements AssetWriter {
  count = 0;

  constructor(private readonly linkBase?: string) {}

  place(asset: ResolvedAsset): PlacedAsset {
    let fd: number;
    try {
      fd = openRegular(asset.path);
    } catch {
      return { error: "unreadable" };
    }
    try {
      const head = Buffer.alloc(16);
      const n = readSync(fd, head, 0, 16, 0);
      this.count++;
      return {
        url: urlFor(asset.path, this.linkBase),
        mime: sniffMime(head.subarray(0, n), asset.name),
      };
    } finally {
      closeSync(fd);
    }
  }
}

/** A placeholder value safe to use as one path component. */
function pathComponent(value: string): string {
  const clean = Array.from(value.normalize("NFC"), (char) =>
    char.charCodeAt(0) < 32 || char === "\x7f" ? "_" : char
  )
    .join("")
    .replace(/[/\\:]+/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return clean || "untitled";
}

/**
 * The absolute assets directory for one note: the template's `directory`
 * with placeholders filled (each value made path-safe) beneath `outputDir`.
 * Throws when the result is absolute or escapes `outputDir`.
 */
export function templateAssetsDir(
  directory: string,
  outputDir: string,
  values: PlaceholderValues
): string {
  const safe: PlaceholderValues = {};
  for (const [key, value] of Object.entries(values)) {
    const raw = typeof value === "string" ? value : value?.raw;
    if (raw !== undefined) safe[key as keyof PlaceholderValues] = pathComponent(raw);
  }
  const filled = fillPlaceholders(directory, safe);
  const base = resolve(outputDir);
  const dir = resolve(base, filled);
  if (isAbsolute(filled) || filled.split("/").includes("..") || !dir.startsWith(base + sep))
    throw new Error(`assets.directory "${directory}" resolves outside the output directory`);
  return dir;
}

/**
 * Read a template file under the same policy as `create-note`'s `contentPath`
 * and `add-attachment`'s `path` ({@link readAllowedFile}): a regular file in
 * home, a temp directory, or /Volumes, with hidden paths (`~/.docker`,
 * `~/.config`, a project `.env`) and `~/Library` outside iCloud Drive and
 * `~/Library/CloudStorage` refused unless the server sets
 * `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`. The name must end in .json,
 * checked before anything is opened. Symlinks, non-regular files (a FIFO is
 * opened non-blocking and refused), empty files and files over the template
 * size limit are refused. Errors name the path, never the file's contents.
 */
export function readTemplateFile(path: string): string {
  if (extname(path).toLowerCase() !== ".json")
    throw new Error(`Template file must have a .json extension: ${path}`);
  return readAllowedFile(path, MAX_TEMPLATE_BYTES, { label: "Template file" }).toString("utf8");
}
