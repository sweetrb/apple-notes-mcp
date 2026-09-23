/**
 * Freeze the current pasteboard contents into a private temporary file.
 *
 * The pasteboard is read once through AppKit's public NSPasteboard API from
 * JXA (`osascript -l JavaScript`), so no native build is needed. Whatever it
 * holds at that instant is written to a fresh 0700 temporary directory:
 *
 * - a copied file (Finder "Copy"): the file's bytes are copied, read with
 *   O_NOFOLLOW so a symlink is refused rather than followed;
 * - image or PDF data (screenshots, "Copy Image"): the bytes of the best
 *   available type are written as-is.
 *
 * The pasteboard change count is checked before and after the read, so a copy
 * that lands mid-read is refused instead of mixing two clipboards. Nothing is
 * ever written to the pasteboard. The frozen file is then attached through the
 * same verified path as add-attachment.
 *
 * @module utils/pasteboardFreeze
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * Testing aid: read this named pasteboard (NSPasteboard(name:)) instead of the
 * general one, so a live test never reads or changes the user's clipboard.
 */
export const PASTEBOARD_NAME_ENV = "APPLE_NOTES_MCP_PASTEBOARD_NAME";

/** Same ceiling add-attachment enforces. */
export const MAX_PASTEBOARD_BYTES = 64 * 1024 * 1024;

/**
 * Pasteboard types taken as attachment data, in preference order. PNG before
 * TIFF because screenshots and most "Copy Image" commands offer both.
 */
export const PASTEBOARD_DATA_TYPES: ReadonlyArray<{ type: string; ext: string; label: string }> = [
  { type: "public.png", ext: "png", label: "image" },
  { type: "public.jpeg", ext: "jpg", label: "image" },
  { type: "public.heic", ext: "heic", label: "image" },
  { type: "com.compuserve.gif", ext: "gif", label: "image" },
  { type: "public.tiff", ext: "tiff", label: "image" },
  { type: "com.adobe.pdf", ext: "pdf", label: "document" },
];

/**
 * The JXA program. Constant text: every variable input arrives through argv
 * (`run(argv)`), never through string interpolation.
 *   argv[0] = output directory, argv[1] = pasteboard name ("" = general),
 *   argv[2] = byte limit, argv[3] = JSON array of [type, ext] preferences.
 */
export const PASTEBOARD_FREEZE_JXA = `
ObjC.import("AppKit");
function run(argv) {
  var dir = argv[0], name = argv[1], limit = Number(argv[2]), prefs = JSON.parse(argv[3]);
  var pb = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  if (!pb || pb.isNil()) return JSON.stringify({ status: "error", code: "pasteboard_unavailable" });
  var before = pb.changeCount;
  var types = ObjC.deepUnwrap(pb.types) || [];
  if (types.length === 0) return JSON.stringify({ status: "error", code: "pasteboard_empty" });
  var result = null;
  if (types.indexOf("public.file-url") >= 0) {
    var value = ObjC.unwrap(pb.stringForType("public.file-url"));
    var url = value ? $.NSURL.URLWithString(value) : null;
    if (url && !url.isNil() && url.isFileURL) {
      result = { status: "ok", kind: "file", type: "public.file-url", path: ObjC.unwrap(url.path) };
    }
  }
  if (!result) {
    for (var i = 0; i < prefs.length && !result; i++) {
      if (types.indexOf(prefs[i][0]) < 0) continue;
      var data = pb.dataForType(prefs[i][0]);
      if (!data || data.isNil() || data.length === 0) continue;
      if (data.length > limit) return JSON.stringify({ status: "error", code: "too_large", bytes: data.length });
      var path = dir + "/pasteboard." + prefs[i][1];
      if (!data.writeToFileAtomically(path, true))
        return JSON.stringify({ status: "error", code: "write_failed" });
      result = { status: "ok", kind: "data", type: prefs[i][0], path: path, bytes: data.length };
    }
  }
  if (pb.changeCount !== before) return JSON.stringify({ status: "error", code: "pasteboard_changed" });
  return JSON.stringify(result || { status: "error", code: "unsupported_content", types: types.slice(0, 20) });
}
`;

export type PasteboardErrorCode =
  | "pasteboard_unavailable"
  | "pasteboard_empty"
  | "pasteboard_changed"
  | "unsupported_content"
  | "too_large"
  | "write_failed"
  | "file_unreadable";

export class PasteboardError extends Error {
  constructor(
    readonly code: PasteboardErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PasteboardError";
  }
}

const MESSAGES: Record<PasteboardErrorCode, string> = {
  pasteboard_unavailable:
    "The pasteboard is not reachable from this process. The MCP host must run in your logged-in GUI session (not over SSH or as a background daemon).",
  pasteboard_empty: "The pasteboard is empty. Copy an image or a file first.",
  pasteboard_changed: "The pasteboard changed while it was being read. Try again.",
  unsupported_content:
    "The pasteboard holds no image, PDF, or file. Text belongs in append-to-note, not in an attachment.",
  too_large: "The pasteboard contents exceed the 64 MiB attachment limit.",
  write_failed: "Could not write the pasteboard contents to a temporary file.",
  file_unreadable: "The copied file could not be read as a regular file of at most 64 MiB.",
};

/** A frozen copy of the pasteboard, ready to attach. Call cleanup() when done. */
export interface FrozenPasteboard {
  /** "file" = a copied file; "data" = image or PDF bytes. */
  kind: "file" | "data";
  /** The pasteboard type that was read (UTI). */
  type: string;
  /** Private temporary copy to attach. */
  path: string;
  /** Default attachment name: the copied file's name, or "Pasted image.png" and the like. */
  filename: string;
  bytes: number;
  cleanup: () => void;
}

export interface FreezeOptions {
  /** Read a named pasteboard instead of the general one (tests). */
  pasteboardName?: string;
  /** Test seam for osascript. */
  runJxa?: (args: string[]) => string;
}

function defaultRunJxa(args: string[]): string {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", PASTEBOARD_FREEZE_JXA, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Completes a caller's attachment name with the frozen file's extension when
 * the caller gave none (they rarely know whether a screenshot is PNG or TIFF).
 * Everything else is left for add-attachment's own name validation.
 */
export function pasteboardFilename(
  requested: string | undefined,
  frozenFilename: string
): string | undefined {
  if (requested === undefined) return undefined;
  const ext = extname(frozenFilename);
  return ext && !extname(requested) ? requested + ext : requested;
}

/** Reads a copied file without following a final symlink. */
function readRegularFile(path: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new PasteboardError("file_unreadable", MESSAGES.file_unreadable);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PASTEBOARD_BYTES)
      throw new PasteboardError("file_unreadable", MESSAGES.file_unreadable);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Snapshot the pasteboard into a private temporary file. */
export function freezePasteboard(options: FreezeOptions = {}): FrozenPasteboard {
  const directory = mkdtempSync(join(tmpdir(), "notes-pasteboard-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const prefs = JSON.stringify(PASTEBOARD_DATA_TYPES.map((t) => [t.type, t.ext]));
    let raw: string;
    try {
      raw = (options.runJxa ?? defaultRunJxa)([
        directory,
        options.pasteboardName ?? "",
        String(MAX_PASTEBOARD_BYTES),
        prefs,
      ]);
    } catch {
      throw new PasteboardError("pasteboard_unavailable", MESSAGES.pasteboard_unavailable);
    }
    let reply: {
      status?: string;
      code?: PasteboardErrorCode;
      kind?: string;
      type?: string;
      path?: string;
    };
    try {
      reply = JSON.parse(raw.trim());
    } catch {
      throw new PasteboardError("pasteboard_unavailable", MESSAGES.pasteboard_unavailable);
    }
    if (reply.status !== "ok" || !reply.path || !reply.type) {
      const code = reply.code && reply.code in MESSAGES ? reply.code : "pasteboard_unavailable";
      throw new PasteboardError(code, MESSAGES[code]);
    }
    if (reply.kind === "file") {
      const bytes = readRegularFile(reply.path);
      const filename = basename(reply.path);
      const path = join(directory, filename);
      writeFileSync(path, bytes, { mode: 0o600 });
      return { kind: "file", type: reply.type, path, filename, bytes: bytes.length, cleanup };
    }
    // Data was written by the JXA; only accept a file inside our directory.
    if (join(directory, basename(reply.path)) !== reply.path)
      throw new PasteboardError("write_failed", MESSAGES.write_failed);
    const label = PASTEBOARD_DATA_TYPES.find((t) => t.type === reply.type)?.label ?? "item";
    const filename = `Pasted ${label}${extname(reply.path)}`;
    const path = join(directory, filename);
    writeFileSync(path, readFileSync(reply.path), { mode: 0o600 });
    rmSync(reply.path, { force: true });
    return { kind: "data", type: reply.type, path, filename, bytes: statSync(path).size, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
