/**
 * Note exports as presentation documents (export-notes-markdown and
 * export-notes-html).
 *
 * Selects one note by exact id or the notes of one folder, loads each body
 * read-only from the NoteStore database, renders it, and either returns the
 * document inline (size-capped) or writes it to a new file. Attachment files
 * are copied into an optional sidecar directory.
 *
 * Output is create-only: the document file is opened with O_EXCL before any
 * asset is copied, so an existing file is refused without side effects.
 * Nothing written is removed on a later failure.
 *
 * @module services/notesExport
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { NotesExportReceipt, NotesExportRequest, NotesExportSkip } from "../types.js";
import {
  AssetLocator,
  assertExportPath,
  DataUrlWriter,
  openCreateOnly,
  OutputExistsError,
  SidecarWriter,
  writeAllAndClose,
  type AssetWriter,
} from "../utils/exportAssets.js";
import { emptyStats, type ExportContext } from "../utils/exportRender.js";
import { renderNotesHtml } from "../utils/htmlExport.js";
import { renderNotesMarkdown } from "../utils/markdownExport.js";
import { NoteBlocksError } from "../utils/noteBlocks.js";
import { readExportNote, type ExportNote } from "../utils/noteExportData.js";

/** Default and maximum notes read from one folder. */
export const DEFAULT_FOLDER_EXPORT_LIMIT = 100;
export const MAX_FOLDER_EXPORT_LIMIT = 1000;

/** Stable failure codes. */
export type NotesExportErrorCode =
  | "invalid-request"
  | "invalid-path"
  | "output_exists"
  | "folder-unavailable"
  | "too-large"
  | NoteBlocksError["code"];

export class NotesExportError extends Error {
  constructor(
    readonly code: NotesExportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "NotesExportError";
  }
}

/** Collaborators, injectable for tests. */
export interface NotesExportDeps {
  listNoteRefs(
    account?: string,
    folder?: string,
    modifiedSince?: string,
    limit?: number
  ): { title: string; id: string }[];
  /** Defaults to reading the NoteStore database. */
  readNote?: (id: string) => ExportNote;
  /** Defaults to the Notes container of the current user. */
  locator?: AssetLocator;
  /** Largest inline document, in bytes. */
  maxInlineBytes: number;
}

function validPath(path: string, what: string): string {
  try {
    return assertExportPath(path);
  } catch (error) {
    throw new NotesExportError(
      "invalid-path",
      `${what}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Resolve the request to note ids. */
function selectNotes(request: NotesExportRequest, deps: NotesExportDeps): string[] {
  if (!!request.id === !!request.folder)
    throw new NotesExportError("invalid-request", "Provide exactly one of 'id' or 'folder'.");
  if (request.id) return [request.id];
  const limit = Math.min(request.limit ?? DEFAULT_FOLDER_EXPORT_LIMIT, MAX_FOLDER_EXPORT_LIMIT);
  try {
    return deps
      .listNoteRefs(request.account, request.folder, undefined, limit)
      .map((ref) => ref.id);
  } catch (error) {
    throw new NotesExportError(
      "folder-unavailable",
      `Could not list folder "${request.folder}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Load each selected note; per-note failures are skipped in folder mode. */
function loadNotes(
  ids: string[],
  single: boolean,
  read: ((id: string) => ExportNote) | undefined
): { notes: ExportNote[]; skipped: NotesExportSkip[] } {
  const notes: ExportNote[] = [];
  const skipped: NotesExportSkip[] = [];
  for (const id of ids) {
    try {
      notes.push(read ? read(id) : readExportNote(id));
    } catch (error) {
      if (!(error instanceof NoteBlocksError)) throw error;
      if (single) throw new NotesExportError(error.code, error.message);
      skipped.push({ id, code: error.code });
    }
  }
  return { notes, skipped };
}

/** Create the output file (and its parent) before any asset is written. */
function openOutput(output: string): number {
  mkdirSync(dirname(output), { recursive: true });
  try {
    return openCreateOnly(output);
  } catch (error) {
    if (error instanceof OutputExistsError)
      throw new NotesExportError("output_exists", error.message);
    throw error;
  }
}

/** Render into an open output file; on failure close it and leave it in place. */
function renderInto(fd: number | undefined, render: () => string): string {
  try {
    return render();
  } catch (error) {
    if (fd !== undefined) writeAllAndClose(fd, "");
    throw error;
  }
}

/** Export notes as one Markdown document. */
export function exportNotesMarkdown(
  request: NotesExportRequest,
  deps: NotesExportDeps
): NotesExportReceipt {
  const output = request.outputPath ? validPath(request.outputPath, "outputPath") : undefined;
  const assetsDir = request.assetsDir ? validPath(request.assetsDir, "assetsDir") : undefined;
  if (output && assetsDir && output === assetsDir)
    throw new NotesExportError("invalid-path", "outputPath and assetsDir must differ.");

  const ids = selectNotes(request, deps);
  const { notes, skipped } = loadNotes(ids, !!request.id, deps.readNote);
  const fd = output ? openOutput(output) : undefined;

  const writer: AssetWriter | undefined = assetsDir
    ? new SidecarWriter(assetsDir, output ? dirname(output) : undefined)
    : undefined;
  const ctx: ExportContext = {
    stats: emptyStats(),
    ...(writer ? { writer, locator: deps.locator ?? new AssetLocator() } : {}),
  };
  const markdown = renderInto(fd, () =>
    renderNotesMarkdown(notes, ctx, { wrap: request.wrap ?? 0 })
  );
  const bytes = Buffer.byteLength(markdown);
  const receipt: NotesExportReceipt = {
    format: "markdown",
    count: notes.length,
    bytes,
    stats: ctx.stats,
    skipped,
    ...(assetsDir ? { assets: { dir: assetsDir, files: writer!.count } } : {}),
  };
  if (fd !== undefined) {
    writeAllAndClose(fd, markdown);
    return { ...receipt, output };
  }
  if (bytes > deps.maxInlineBytes)
    throw new NotesExportError(
      "too-large",
      `The Markdown is ${bytes} bytes, over the ${deps.maxInlineBytes}-byte inline limit. Pass outputPath to write it to a file, or export fewer notes.`
    );
  return { ...receipt, markdown };
}

/** `<dir>/<stem>.assets` beside an output file. */
export function defaultSidecarDir(output: string): string {
  return join(dirname(output), `${basename(output, extname(output))}.assets`);
}

/**
 * Export notes as one standalone HTML document written to `outputPath`
 * (required: an embedded document is too large for an MCP message). Assets
 * are embedded as data URLs by default (each up to 10 MiB) or, with
 * `embedAssets: false`, copied to a sidecar directory (`assetsDir`, default
 * `<stem>.assets`) and linked by relative URL.
 */
export function exportNotesHtml(
  request: NotesExportRequest,
  deps: NotesExportDeps
): NotesExportReceipt {
  if (!request.outputPath)
    throw new NotesExportError(
      "invalid-request",
      "outputPath is required for HTML export; the document is written to a file."
    );
  const embed = request.embedAssets ?? !request.assetsDir;
  if (embed && request.assetsDir)
    throw new NotesExportError(
      "invalid-request",
      "assetsDir applies only with embedAssets false (sidecar assets)."
    );
  const output = validPath(request.outputPath, "outputPath");
  const assetsDir = embed
    ? undefined
    : validPath(request.assetsDir ?? defaultSidecarDir(output), "assetsDir");
  if (assetsDir === output)
    throw new NotesExportError("invalid-path", "outputPath and assetsDir must differ.");

  const ids = selectNotes(request, deps);
  const { notes, skipped } = loadNotes(ids, !!request.id, deps.readNote);
  const fd = openOutput(output);
  const writer: AssetWriter = assetsDir
    ? new SidecarWriter(assetsDir, dirname(output))
    : new DataUrlWriter();
  const ctx: ExportContext = {
    stats: emptyStats(),
    writer,
    locator: deps.locator ?? new AssetLocator(),
  };
  const title = request.id ? notes[0]?.title || "Note" : request.folder!;
  const html = renderInto(fd, () => renderNotesHtml(notes, ctx, { title }));
  const bytes = writeAllAndClose(fd, html);
  return {
    format: "html",
    count: notes.length,
    bytes,
    output,
    stats: ctx.stats,
    skipped,
    ...(assetsDir
      ? { assets: { dir: assetsDir, files: writer.count } }
      : { embedded: writer.count }),
  };
}
