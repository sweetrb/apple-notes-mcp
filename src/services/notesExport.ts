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
import type {
  NotesExportReceipt,
  NotesExportRequest,
  NotesExportSkip,
  NotesExportTemplateInfo,
} from "../types.js";
import {
  AssetLocator,
  assertExportPath,
  DataUrlWriter,
  openCreateOnly,
  OutputExistsError,
  SidecarWriter,
  writeAllAndClose,
} from "../utils/exportAssets.js";
import { emptyStats, type ExportContext } from "../utils/exportRender.js";
import { renderNotesHtml } from "../utils/htmlExport.js";
import { prepareVectorDrawings, type ReadNoteDrawings } from "./exportVectorDrawings.js";
import { renderNotesMarkdown } from "../utils/markdownExport.js";
import { NoteBlocksError } from "../utils/noteBlocks.js";
import {
  readExportNote,
  readExportNoteMeta,
  type ExportNote,
  type ExportNoteMeta,
} from "../utils/noteExportData.js";
import {
  builtinTemplate,
  isBuiltinTemplate,
  parseTemplate,
  resolveTemplate,
  TemplateValidationError,
  usesNoteMeta,
  type PortableTemplate,
  type ResolvedTemplate,
  type TemplateError,
} from "../utils/markdownTemplate.js";
import {
  renderNotesWithTemplate,
  type TemplateAssetBinding,
  type TemplateWarning,
} from "../utils/templateRender.js";
import {
  HashedSidecarWriter,
  readTemplateFile,
  ReferenceWriter,
  templateAssetsDir,
} from "../utils/templateAssets.js";

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
  | "invalid-template"
  | "template-not-found"
  | NoteBlocksError["code"];

export class NotesExportError extends Error {
  constructor(
    readonly code: NotesExportErrorCode,
    message: string,
    /** Every problem found, for `invalid-template`. */
    readonly details?: TemplateError[]
  ) {
    super(message);
    this.name = "NotesExportError";
  }
}

/** Most warnings listed in a receipt; the rest are counted. */
export const MAX_EXPORT_WARNINGS = 200;
/** Most asset paths listed in a receipt. */
const MAX_LISTED_ASSETS = 1000;

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
  /** Defaults to reading the NoteStore database; failures leave fields empty. */
  readMeta?: (id: string) => ExportNoteMeta;
  /** Looks up a saved (non-built-in) template by name. */
  findTemplate?: (name: string) => PortableTemplate | undefined;
  /** HTML only. Defaults to get-note-drawings' SVG decode through the public helper. */
  readDrawings?: ReadNoteDrawings;
}

/** A template chosen for an export, with where it came from. */
export interface ChosenTemplate {
  info: NotesExportTemplateInfo;
  template: ResolvedTemplate;
}

/**
 * Resolve `template` (a built-in or saved name) or `templateFile` (a JSON
 * file in an allowed location). Validates before any note is read.
 */
export function chooseTemplate(
  request: Pick<NotesExportRequest, "template" | "templateFile">,
  deps: Pick<NotesExportDeps, "findTemplate">
): ChosenTemplate | undefined {
  if (request.template !== undefined && request.templateFile !== undefined)
    throw new NotesExportError(
      "invalid-request",
      "Provide at most one of 'template' or 'templateFile'."
    );
  const invalid = (error: TemplateValidationError, where: string) =>
    new NotesExportError("invalid-template", `${where}: ${error.message}`, error.errors);
  if (request.template !== undefined) {
    const name = request.template;
    if (isBuiltinTemplate(name))
      return {
        info: { name, source: "builtin" },
        template: resolveTemplate(builtinTemplate(name), name),
      };
    let portable: PortableTemplate | undefined;
    try {
      portable = deps.findTemplate?.(name);
    } catch (error) {
      if (error instanceof TemplateValidationError)
        throw invalid(error, `Saved template "${name}"`);
      throw error;
    }
    if (!portable) throw new NotesExportError("template-not-found", `No template named "${name}".`);
    return { info: { name, source: "saved" }, template: resolveTemplate(portable, name) };
  }
  if (request.templateFile === undefined) return undefined;
  let text: string;
  try {
    text = readTemplateFile(request.templateFile);
  } catch (error) {
    throw new NotesExportError(
      "invalid-path",
      `templateFile: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let portable: PortableTemplate;
  try {
    portable = parseTemplate(text);
  } catch (error) {
    throw invalid(error as TemplateValidationError, "templateFile");
  }
  const name = portable.name ?? basename(request.templateFile, extname(request.templateFile));
  return { info: { name, source: "file" }, template: resolveTemplate(portable, name) };
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

/**
 * Resolve the request to note ids. A folder is read one note past the limit,
 * so `truncated` says whether the folder holds more notes than were exported.
 */
function selectNotes(
  request: NotesExportRequest,
  deps: NotesExportDeps
): { ids: string[]; truncated: boolean } {
  if (!!request.id === !!request.folder)
    throw new NotesExportError("invalid-request", "Provide exactly one of 'id' or 'folder'.");
  if (request.id) return { ids: [request.id], truncated: false };
  const limit = Math.min(request.limit ?? DEFAULT_FOLDER_EXPORT_LIMIT, MAX_FOLDER_EXPORT_LIMIT);
  try {
    const ids = deps
      .listNoteRefs(request.account, request.folder, undefined, limit + 1)
      .map((ref) => ref.id);
    return { ids: ids.slice(0, limit), truncated: ids.length > limit };
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

/**
 * Render into an open output file; on failure close it and leave it in place.
 * An assets directory that could not be created fails the export here, before
 * the document is written, instead of leaving every asset marked unavailable.
 */
function renderInto(
  fd: number | undefined,
  render: () => string,
  writers: ReadonlyArray<{ directoryError?: string }> = []
): string {
  try {
    const document = render();
    const directoryError = writers.find((writer) => writer.directoryError)?.directoryError;
    if (directoryError)
      throw new NotesExportError("invalid-path", `${directoryError}. Nothing was exported.`);
    return document;
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

  const chosen = chooseTemplate(request, deps);
  if (chosen && assetsDir && chosen.template.assets.mode !== "copy")
    throw new NotesExportError(
      "invalid-request",
      `assetsDir has no effect: template "${chosen.info.name}" sets assets.mode to "${chosen.template.assets.mode}".`
    );

  const { ids, truncated } = selectNotes(request, deps);
  const { notes, skipped } = loadNotes(ids, !!request.id, deps.readNote);
  if (chosen) {
    const receipt = exportWithTemplate(request, deps, chosen, notes, skipped, {
      output,
      assetsDir,
    });
    return truncated ? { ...receipt, truncated } : receipt;
  }
  const fd = output ? openOutput(output) : undefined;

  const writer: SidecarWriter | undefined = assetsDir
    ? new SidecarWriter(assetsDir, output ? dirname(output) : undefined)
    : undefined;
  const ctx: ExportContext = {
    stats: emptyStats(),
    ...(writer ? { writer, locator: deps.locator ?? new AssetLocator() } : {}),
  };
  const markdown = renderInto(
    fd,
    () => renderNotesMarkdown(notes, ctx, { wrap: request.wrap ?? 0 }),
    writer ? [writer] : []
  );
  const bytes = Buffer.byteLength(markdown);
  const receipt: NotesExportReceipt = {
    format: "markdown",
    count: notes.length,
    ...(truncated ? { truncated } : {}),
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
 *
 * Classic PencilKit drawings are placed as SVG, decoded through the public
 * native helper, unless `vectorDrawings` is false. Any drawing that cannot be
 * decoded or placed falls back to Notes' raster rendering; it never fails the
 * export.
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

  const { ids, truncated } = selectNotes(request, deps);
  const { notes, skipped } = loadNotes(ids, !!request.id, deps.readNote);
  const fd = openOutput(output);
  const writer: SidecarWriter | DataUrlWriter = assetsDir
    ? new SidecarWriter(assetsDir, dirname(output))
    : new DataUrlWriter();
  const vector =
    request.vectorDrawings === false
      ? undefined
      : prepareVectorDrawings(notes, writer, deps.readDrawings);
  const ctx: ExportContext = {
    stats: emptyStats(),
    writer,
    locator: deps.locator ?? new AssetLocator(),
    ...(vector ? { vectorDrawing: vector.vectorDrawing } : {}),
  };
  const title = request.id ? notes[0]?.title || "Note" : request.folder!;
  const html = renderInto(
    fd,
    () => renderNotesHtml(notes, ctx, { title }),
    writer instanceof SidecarWriter ? [writer] : []
  );
  const bytes = writeAllAndClose(fd, html);
  return {
    format: "html",
    count: notes.length,
    ...(truncated ? { truncated } : {}),
    bytes,
    output,
    stats: ctx.stats,
    skipped,
    ...(assetsDir
      ? { assets: { dir: assetsDir, files: writer.count } }
      : { embedded: writer.count }),
    ...(vector && vector.stats.rendered + vector.stats.fallback > 0
      ? { vectorDrawings: vector.stats }
      : {}),
  };
}

function readMetaSafely(read: (id: string) => ExportNoteMeta, id: string): ExportNoteMeta {
  try {
    return read(id);
  } catch {
    return {};
  }
}

/** Raw note values used to build an assets directory path. */
function pathValues(note: ExportNote, meta: ExportNoteMeta, exportStem: string) {
  const values: Record<string, string> = { title: note.title.trim(), id: note.id, exportStem };
  for (const [key, value] of Object.entries(meta)) if (value) values[key] = value;
  return values;
}

/** Where each note's file-backed attachments go. Throws before anything is written. */
function assetBindings(
  template: ResolvedTemplate,
  notes: ExportNote[],
  meta: Map<ExportNote, ExportNoteMeta>,
  { output, assetsDir, exportStem }: { output?: string; assetsDir?: string; exportStem: string }
): { bindings: Map<ExportNote, TemplateAssetBinding>; writers: Map<string, HashedSidecarWriter> } {
  const linkBase = template.assets.pathStyle === "relative" && output ? dirname(output) : undefined;
  const writers = new Map<string, HashedSidecarWriter>();
  const writerFor = (dir: string) => {
    let writer = writers.get(dir);
    if (!writer) writers.set(dir, (writer = new HashedSidecarWriter(dir, linkBase)));
    return writer;
  };
  const reference =
    template.assets.mode === "reference" ? new ReferenceWriter(linkBase) : undefined;
  const bindings = new Map<ExportNote, TemplateAssetBinding>();
  for (const note of notes) {
    let binding: TemplateAssetBinding = {};
    if (reference) binding = { writer: reference };
    else if (template.assets.mode === "copy") {
      if (assetsDir) binding = { writer: writerFor(assetsDir) };
      else if (template.assets.directory !== null && output) {
        let dir: string;
        try {
          dir = templateAssetsDir(
            template.assets.directory,
            dirname(output),
            pathValues(note, meta.get(note) ?? {}, exportStem)
          );
        } catch (error) {
          throw new NotesExportError("invalid-path", (error as Error).message);
        }
        dir = validPath(dir, "assets.directory");
        if (dir === output)
          throw new NotesExportError("invalid-path", "assets.directory resolves to outputPath.");
        binding = { writer: writerFor(dir) };
      } else if (template.assets.directory !== null) binding = { required: true };
    }
    bindings.set(note, binding);
  }
  return { bindings, writers };
}

/** Export through a template: per-note metadata, template asset rules, warnings. */
function exportWithTemplate(
  request: NotesExportRequest,
  deps: NotesExportDeps,
  chosen: ChosenTemplate,
  notes: ExportNote[],
  skipped: NotesExportSkip[],
  { output, assetsDir }: { output?: string; assetsDir?: string }
): NotesExportReceipt {
  const { template } = chosen;
  const readMeta = deps.readMeta ?? ((id: string) => readExportNoteMeta(id));
  // One sqlite3 read per note, so only when a placeholder needs it.
  const needsMeta = usesNoteMeta(template);
  const meta = new Map(
    notes.map((note) => [note, needsMeta ? readMetaSafely(readMeta, note.id) : {}])
  );
  const exportStem = output ? basename(output, extname(output)) : "export";
  const { bindings, writers } = assetBindings(template, notes, meta, {
    output,
    assetsDir,
    exportStem,
  });

  const fd = output ? openOutput(output) : undefined;
  const ctx: ExportContext = { stats: emptyStats(), locator: deps.locator ?? new AssetLocator() };
  let warnings: TemplateWarning[] = [];
  const markdown = renderInto(fd, () => {
    const result = renderNotesWithTemplate(notes, ctx, {
      template,
      exportStem,
      wrap: request.wrap ?? 0,
      assetsFor: (note) => bindings.get(note) ?? {},
      metaFor: (note) => meta.get(note) ?? {},
    });
    warnings = result.warnings;
    return result.markdown;
  }, [...writers.values()]);
  const bytes = Buffer.byteLength(markdown);
  const used = [...writers.values()].filter((writer) => writer.count > 0);
  const files = used.flatMap((writer) => writer.files);
  const receipt: NotesExportReceipt = {
    format: "markdown",
    count: notes.length,
    bytes,
    stats: ctx.stats,
    skipped,
    template: chosen.info,
    warnings: warnings.slice(0, MAX_EXPORT_WARNINGS),
    ...(warnings.length > MAX_EXPORT_WARNINGS
      ? { warningsOmitted: warnings.length - MAX_EXPORT_WARNINGS }
      : {}),
    ...(used.length
      ? {
          assets: {
            dir: used.length === 1 ? used[0].dir : dirname(output!),
            files: files.length,
          },
          assetFiles: files.slice(0, MAX_LISTED_ASSETS),
        }
      : {}),
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
