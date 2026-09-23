/**
 * Asset lookup and placement for note exports (read-only against Notes).
 *
 * Notes keeps attachment files under its group container, one directory per
 * account:
 *
 *   Accounts/<account>/Media/<media-id>/<generation>/<filename>
 *   Accounts/<account>/FallbackImages/<attachment-id>/<generation>/FallbackImage.png
 *   Accounts/<account>/FallbackPDFs/<attachment-id>/<generation>/FallbackPDF.pdf
 *   Accounts/<account>/Previews/<attachment-id>-<n>-<W>x<H>-<n>[.png]
 *
 * A preview entry is either a flat image file or a directory holding
 * `<n>_<uuid>/Preview.png`. Every path built here is confined to its account
 * directory after symlinks are resolved, and files are opened with O_NOFOLLOW
 * and checked through the descriptor.
 *
 * Writers place a resolved asset into an export: a sidecar directory (copied
 * create-only, collisions get a numeric suffix) or a data URL. Nothing here
 * writes inside the Notes container, and nothing a writer creates is deleted
 * on failure.
 *
 * @module utils/exportAssets
 */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { assertSafeSavePath } from "./attachmentFs.js";

/** The Notes group container. Exports refuse to write anywhere inside it. */
export const NOTES_CONTAINER = join(homedir(), "Library/Group Containers/group.com.apple.notes");

/** Largest asset embedded as a data URL (10 MiB). */
export const MAX_EMBED_BYTES = 10 * 1024 * 1024;

/** Total source bytes one document may embed (256 MiB), bounding memory. */
export const MAX_EMBED_TOTAL_BYTES = 256 * 1024 * 1024;

const MAX_DIRECTORY_ENTRIES = 20000;
const MAX_BUNDLE_ENTRIES = 64;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".gif", ".tiff", ".webp"]);

/** Attachment fields the resolver needs. */
export interface AssetSource {
  /** Attachment ZIDENTIFIER. */
  id: string;
  kind: string;
  mediaId?: string;
  mediaFilename?: string;
  mediaGeneration?: string;
  fallbackImageGeneration?: string;
  fallbackPdfGeneration?: string;
}

/** A file on disk that can be placed into an export. */
export interface ResolvedAsset {
  /** Canonical path inside the Notes container. Never emitted into output. */
  path: string;
  /** Suggested file name for a copy. */
  name: string;
  /** "original" is the attachment's own file; the others stand in for it. */
  role: "original" | "fallback" | "preview";
}

/** The files found for one attachment. */
export interface AttachmentFiles {
  primary?: ResolvedAsset;
  preview?: ResolvedAsset;
}

/** A safe single path component: no separators, NUL, or dot entries. */
export function safeComponent(value: string | undefined | null): string | undefined {
  if (!value || value.length > 255) return undefined;
  if (value === "." || value === ".." || /[/\\\0]/.test(value)) return undefined;
  return value;
}

/** Canonical path of `candidate` if it exists inside `root` (already canonical). */
export function confine(candidate: string, root: string): string | undefined {
  try {
    const real = realpathSync.native(candidate);
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Sorted directory names, or [] when unreadable or unbounded. */
function listDirectory(dir: string, limit: number): string[] {
  try {
    const names = readdirSync(dir);
    return names.length > limit ? [] : names.sort();
  } catch {
    return [];
  }
}

/** True when the canonical path is a regular file. */
function isFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return fstatSync(fd).isFile();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when the canonical path is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Pixel area from a preview name's last `-WxH-` token; 0 when absent. */
export function previewArea(name: string): number {
  const sizes = [...name.matchAll(/-(\d{1,5})x(\d{1,5})(?=-|\.|$)/g)];
  const last = sizes[sizes.length - 1];
  return last ? Number(last[1]) * Number(last[2]) : 0;
}

/**
 * Finds attachment files across the account directories of one Notes
 * container. Directory listings are read once and cached per instance.
 */
export class AssetLocator {
  private readonly accounts: string[];
  private readonly previewIndex = new Map<string, Map<string, string[]>>();

  constructor(container: string = NOTES_CONTAINER) {
    let accountsRoot = "";
    try {
      accountsRoot = realpathSync.native(join(container, "Accounts"));
    } catch {
      /* no readable container: nothing can be located */
    }
    this.accounts = accountsRoot
      ? listDirectory(accountsRoot, 1000).flatMap((name) => {
          const dir = safeComponent(name) && confine(join(accountsRoot, name), accountsRoot);
          return dir && isDirectory(dir) ? [dir] : [];
        })
      : [];
  }

  /** Canonical account directories found in the container. */
  get accountDirs(): string[] {
    return [...this.accounts];
  }

  /** The attachment's own file and its best preview, when present. */
  locate(source: AssetSource): AttachmentFiles {
    const id = safeComponent(source.id);
    if (!id) return {};
    for (const account of this.accounts) {
      const files = this.locateIn(account, id, source);
      if (files.primary || files.preview) return files;
    }
    return {};
  }

  private locateIn(account: string, id: string, source: AssetSource): AttachmentFiles {
    const preview = this.preview(account, id);
    const media = this.media(account, source);
    switch (source.kind) {
      case "drawing":
      case "paper": {
        const fallback = this.fallback(
          account,
          "FallbackImages",
          id,
          source.fallbackImageGeneration,
          ["FallbackImage.png", "FallbackImage.jpg"]
        );
        if (fallback)
          return { primary: { path: fallback, name: `${source.kind}.png`, role: "fallback" } };
        return preview ? { primary: preview } : {};
      }
      case "scan": {
        const pdf = this.fallback(account, "FallbackPDFs", id, source.fallbackPdfGeneration, [
          "FallbackPDF.pdf",
        ]);
        return {
          ...(pdf ? { primary: { path: pdf, name: "scan.pdf", role: "fallback" as const } } : {}),
          ...(preview ? { preview } : {}),
        };
      }
      case "link":
        return preview ? { preview } : {};
      default:
        return {
          ...(media ? { primary: media } : {}),
          ...(preview ? { preview } : {}),
        };
    }
  }

  /** Media/<media-id>/<generation>/<filename>, then without the generation. */
  private media(account: string, source: AssetSource): ResolvedAsset | undefined {
    const mediaId = safeComponent(source.mediaId);
    const filename = safeComponent(source.mediaFilename);
    if (!mediaId || !filename) return undefined;
    const generation = safeComponent(source.mediaGeneration);
    const candidates = [
      ...(generation ? [join(account, "Media", mediaId, generation, filename)] : []),
      join(account, "Media", mediaId, filename),
    ];
    for (const candidate of candidates) {
      const path = confine(candidate, account);
      if (path && isFile(path)) return { path, name: filename, role: "original" };
    }
    return undefined;
  }

  /** <dir>/<id>/<generation>/<name>, <dir>/<id>/<name>, then any generation. */
  private fallback(
    account: string,
    dir: string,
    id: string,
    generation: string | undefined,
    names: string[]
  ): string | undefined {
    const base = join(account, dir, id);
    const gen = safeComponent(generation);
    const generations = [
      ...(gen ? [gen] : []),
      "",
      ...listDirectory(base, MAX_BUNDLE_ENTRIES)
        .filter((name) => name !== gen && safeComponent(name))
        .reverse(),
    ];
    for (const g of generations)
      for (const name of names) {
        const path = confine(g ? join(base, g, name) : join(base, name), account);
        if (path && isFile(path)) return path;
      }
    return undefined;
  }

  /** The largest rendered preview image for an attachment. */
  private preview(account: string, id: string): ResolvedAsset | undefined {
    let index = this.previewIndex.get(account);
    if (!index) {
      index = new Map();
      for (const name of listDirectory(join(account, "Previews"), MAX_DIRECTORY_ENTRIES)) {
        const key = name.slice(0, 36).toUpperCase();
        const entries = index.get(key) ?? [];
        entries.push(name);
        index.set(key, entries);
      }
      this.previewIndex.set(account, index);
    }
    const entries = (index.get(id.toUpperCase()) ?? [])
      .filter((name) => name.slice(36, 37) === "-" || name.length === 36)
      .filter((name) => {
        const ext = extname(name).toLowerCase();
        return !ext || IMAGE_EXTENSIONS.has(ext) || /^\.\d+$/.test(ext);
      })
      .sort((a, b) => previewArea(b) - previewArea(a) || a.localeCompare(b));
    for (const name of entries) {
      const entry = confine(join(account, "Previews", name), account);
      if (!entry) continue;
      const file = isFile(entry) ? entry : this.bundleImage(entry, account);
      if (file) return { path: file, name: "preview", role: "preview" };
    }
    return undefined;
  }

  /** Preview.png (or another image) at most two levels inside a bundle. */
  private bundleImage(bundle: string, account: string): string | undefined {
    const found: string[] = [];
    for (const child of listDirectory(bundle, MAX_BUNDLE_ENTRIES)) {
      const path = confine(join(bundle, child), account);
      if (!path) continue;
      if (isFile(path)) found.push(path);
      else
        for (const grandchild of listDirectory(path, MAX_BUNDLE_ENTRIES)) {
          const inner = confine(join(path, grandchild), account);
          if (inner && isFile(inner)) found.push(inner);
        }
    }
    return (
      found.find((path) => basename(path) === "Preview.png") ??
      found.find((path) => IMAGE_EXTENSIONS.has(extname(path).toLowerCase()))
    );
  }
}

/** MIME type from magic bytes, falling back to the file extension. */
export function sniffMime(head: Uint8Array, name: string): string {
  const ascii = Buffer.from(head).toString("latin1");
  if (ascii.startsWith("\x89PNG")) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (ascii.startsWith("GIF8")) return "image/gif";
  if (ascii.startsWith("%PDF")) return "application/pdf";
  if (ascii.slice(4, 12) === "ftypheic" || ascii.slice(4, 12) === "ftypmif1") return "image/heic";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  const byExtension: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".txt": "text/plain",
  };
  return byExtension[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Extension for a sniffed MIME type, used when a source name has none. */
function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? "";
}

/** A file-system-safe copy name, keeping the extension. */
export function safeAssetName(name: string, mime: string): string {
  let clean = basename(name)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!clean) clean = "attachment";
  if (!extname(clean)) clean += extensionFor(mime);
  const ext = extname(clean);
  if (clean.length > 120) clean = clean.slice(0, 120 - ext.length) + ext;
  return clean;
}

/** Percent-encode each path segment for use as a URL. */
export function encodePathUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Canonical form of the deepest existing ancestor of `abs`, plus the rest. */
function canonicalForm(abs: string): string {
  let current = abs;
  let rest = "";
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest ? join(real, rest) : real;
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return abs;
      rest = rest ? join(basename(current), rest) : basename(current);
      current = parent;
    }
  }
}

/** Refuse destinations inside the Notes container, then apply the save allowlist. */
export function assertExportPath(p: string, container: string = NOTES_CONTAINER): string {
  const abs = assertSafeSavePath(p);
  const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
  const roots = [resolve(container), canonicalForm(resolve(container))];
  const forms = [abs, canonicalForm(abs)];
  if (forms.some((form) => roots.some((root) => within(form, root))))
    throw new Error("Refusing to write inside the Notes library container.");
  return abs;
}

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Thrown when a create-only destination already exists. */
export class OutputExistsError extends Error {
  readonly code = "output_exists";
  constructor(path: string) {
    super(`Output file already exists: ${path}. Choose a new path or remove the old file first.`);
    this.name = "OutputExistsError";
  }
}

/**
 * Create a new file for writing and return its descriptor. Never replaces an
 * existing file or follows a symlink: an existing path of any kind throws
 * {@link OutputExistsError}.
 */
export function openCreateOnly(path: string): number {
  try {
    return openSync(path, CREATE_FLAGS, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new OutputExistsError(path);
    throw error;
  }
}

/** Write UTF-8 text through a descriptor, then close it. Returns bytes written. */
export function writeAllAndClose(fd: number, content: string): number {
  try {
    const data = Buffer.from(content, "utf8");
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written);
    return data.length;
  } finally {
    closeSync(fd);
  }
}

/** Open a source file without following a final symlink; require a regular file. */
function openSource(path: string): { fd: number; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error("Asset is not a regular file");
  }
  return { fd, size: stat.size };
}

function readHead(fd: number): Buffer {
  const head = Buffer.alloc(16);
  const n = readSync(fd, head, 0, 16, 0);
  return head.subarray(0, n);
}

/** Result of placing one asset. `url` is relative or a data URL, never file:. */
export type PlacedAsset = { url: string; mime: string } | { error: string };

/** Places assets into an export. */
export interface AssetWriter {
  place(asset: ResolvedAsset): PlacedAsset;
  /** Files written (sidecar) or assets embedded (data URL). */
  readonly count: number;
}

/**
 * Copies assets into one directory, create-only. A name already taken gets a
 * `-2`, `-3`, ... suffix; the same source placed twice reuses its copy. URLs
 * are relative to `linkBase` when given, otherwise the absolute copy path.
 */
export class SidecarWriter implements AssetWriter {
  private readonly placed = new Map<string, { url: string; mime: string }>();
  private created = false;
  count = 0;

  constructor(
    readonly dir: string,
    private readonly linkBase?: string
  ) {}

  place(asset: ResolvedAsset): PlacedAsset {
    const done = this.placed.get(asset.path);
    if (done) return done;
    let source: { fd: number; size: number };
    try {
      source = openSource(asset.path);
    } catch {
      return { error: "unreadable" };
    }
    try {
      const mime = sniffMime(readHead(source.fd), asset.name);
      if (!this.created) {
        assertExportPath(this.dir);
        mkdirSync(this.dir, { recursive: true });
        this.created = true;
      }
      const name = safeAssetName(asset.name, mime);
      const ext = extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let target: string | undefined;
      let out: number | undefined;
      for (let n = 1; n <= 1000 && out === undefined; n++) {
        target = join(this.dir, n === 1 ? name : `${stem}-${n}${ext}`);
        try {
          out = openSync(target, CREATE_FLAGS, 0o644);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (out === undefined || !target) return { error: "no-free-name" };
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        for (let position = 0; ;) {
          const n = readSync(source.fd, chunk, 0, chunk.length, position);
          if (n <= 0) break;
          let written = 0;
          while (written < n) written += writeSync(out, chunk, written, n - written);
          position += n;
        }
      } finally {
        closeSync(out);
      }
      this.count++;
      const url = this.linkBase
        ? encodePathUrl(relative(this.linkBase, target).split(sep).join("/"))
        : target;
      const result = { url, mime };
      this.placed.set(asset.path, result);
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      closeSync(source.fd);
    }
  }
}

/**
 * Embeds assets as base64 data URLs. An asset over `maxBytes`, or one that
 * would take the document past `totalBytes`, is refused with `too-large`.
 */
export class DataUrlWriter implements AssetWriter {
  private readonly placed = new Map<string, { url: string; mime: string }>();
  private embeddedBytes = 0;
  count = 0;

  constructor(
    private readonly maxBytes: number = MAX_EMBED_BYTES,
    private readonly totalBytes: number = MAX_EMBED_TOTAL_BYTES
  ) {}

  place(asset: ResolvedAsset): PlacedAsset {
    const done = this.placed.get(asset.path);
    if (done) return done;
    let source: { fd: number; size: number };
    try {
      source = openSource(asset.path);
    } catch {
      return { error: "unreadable" };
    }
    try {
      if (source.size > this.maxBytes || this.embeddedBytes + source.size > this.totalBytes)
        return { error: "too-large" };
      const data = Buffer.alloc(source.size);
      let read = 0;
      while (read < source.size) {
        const n = readSync(source.fd, data, read, source.size - read, read);
        if (n <= 0) break;
        read += n;
      }
      const mime = sniffMime(data.subarray(0, 16), asset.name);
      const result = {
        url: `data:${mime};base64,${data.subarray(0, read).toString("base64")}`,
        mime,
      };
      this.count++;
      this.embeddedBytes += read;
      this.placed.set(asset.path, result);
      return result;
    } finally {
      closeSync(source.fd);
    }
  }
}
