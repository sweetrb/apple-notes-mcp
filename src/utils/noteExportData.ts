/**
 * Read-only loading of everything a note export needs: the decoded body
 * blocks, the note title, and the attachment rows behind each attachment
 * marker (type, names, link card URL, inline text, media file identity and
 * native table data).
 *
 * The NoteStore database is opened with `sqlite3 -readonly` through
 * execFileSync with an argument array. The note's primary key is bound as a
 * sqlite3 parameter; column names come from a fixed allowlist and are only
 * selected when PRAGMA table_info reports them, because the schema moves
 * between macOS releases.
 *
 * @module utils/noteExportData
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { NoteBlocksError, readNoteBlocks, type NoteBlocksDocument } from "./noteBlocks.js";

const NOTES_DB_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** How an attachment is rendered. */
export type ExportAttachmentKind =
  | "table"
  | "image"
  | "drawing"
  | "paper"
  | "scan"
  | "pdf"
  | "audio"
  | "video"
  | "link"
  | "gallery"
  | "divider"
  | "inline"
  | "file";

/** One attachment row, as far as an export needs it. */
export interface ExportAttachment {
  /** ZIDENTIFIER; matches `AttachmentMarker.id` from the decoder. */
  id: string;
  pk: number;
  uti: string;
  kind: ExportAttachmentKind;
  parentPk?: number;
  /** Display title (attachment title, user title, or media file name). */
  title?: string;
  /** Link card URL. */
  url?: string;
  /** Visible text of an inline text attachment (hashtag, mention, link). */
  altText?: string;
  /** Target of an inline note link. */
  tokenId?: string;
  mediaId?: string;
  mediaFilename?: string;
  mediaGeneration?: string;
  fallbackImageGeneration?: string;
  fallbackPdfGeneration?: string;
  /** Hex of the gzipped table document, for tables only. */
  tableData?: string;
  /** Child attachments (gallery items), in primary-key order. */
  children: ExportAttachment[];
}

/** A note loaded for export. */
export interface ExportNote {
  id: string;
  title: string;
  doc: NoteBlocksDocument;
  /** Every attachment (top-level and child) by identifier. */
  attachments: Map<string, ExportAttachment>;
  /** Top-level attachments in primary-key (creation) order. */
  ordered: ExportAttachment[];
}

const IMAGE_UTIS = new Set([
  "public.jpeg",
  "public.png",
  "public.heic",
  "public.heif",
  "public.image",
  "public.tiff",
  "public.webp",
  "org.webmproject.webp",
  "com.compuserve.gif",
  "com.microsoft.bmp",
  "com.adobe.raw-image",
  "public.camera-raw-image",
]);
const AUDIO_UTIS = new Set([
  "com.apple.m4a-audio",
  "public.mpeg-4-audio",
  "public.mp3",
  "public.audio",
  "public.aiff-audio",
  "com.microsoft.waveform-audio",
]);
const VIDEO_UTIS = new Set([
  "public.movie",
  "public.video",
  "public.mpeg-4",
  "com.apple.quicktime-movie",
]);

/** Map a uniform type identifier to its export kind. */
export function classifyUti(uti: string): ExportAttachmentKind {
  if (uti === "com.apple.notes.table") return "table";
  if (uti === "com.apple.notes.inlinetextattachment.dividerline") return "divider";
  if (uti.startsWith("com.apple.notes.inlinetextattachment.")) return "inline";
  if (uti === "com.apple.notes.gallery") return "gallery";
  if (uti === "com.apple.drawing" || uti === "com.apple.drawing.2") return "drawing";
  if (uti === "com.apple.paper.doc.scan") return "scan";
  if (uti === "com.apple.paper") return "paper";
  if (uti === "public.url") return "link";
  if (uti === "com.adobe.pdf") return "pdf";
  if (IMAGE_UTIS.has(uti)) return "image";
  if (AUDIO_UTIS.has(uti)) return "audio";
  if (VIDEO_UTIS.has(uti)) return "video";
  return "file";
}

/** Attachment columns read when present: [json key, table alias, column]. */
const ATTACHMENT_COLUMNS: Array<[string, "a" | "m", string]> = [
  ["uti0", "a", "ZTYPEUTI"],
  ["uti1", "a", "ZTYPEUTI1"],
  ["parent", "a", "ZPARENTATTACHMENT"],
  ["title", "a", "ZTITLE"],
  ["userTitle", "a", "ZUSERTITLE"],
  ["url", "a", "ZURLSTRING"],
  ["alt", "a", "ZALTTEXT"],
  ["token", "a", "ZTOKENCONTENTIDENTIFIER"],
  ["fbImageGen", "a", "ZFALLBACKIMAGEGENERATION"],
  ["fbPdfGen", "a", "ZFALLBACKPDFGENERATION"],
  ["mediaId", "m", "ZIDENTIFIER"],
  ["mediaFilename", "m", "ZFILENAME"],
  ["mediaGen", "m", "ZGENERATION1"],
];

const columnCache = new Map<string, Set<string>>();

function sqlite(dbPath: string, args: string[]): string {
  try {
    return execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", ...args.slice(0, -1), dbPath, args.at(-1)!],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message))
      throw new NoteBlocksError("no-full-disk-access", "The Notes database is not readable");
    throw new NoteBlocksError("query-failed", "Failed to query the Notes database");
  }
}

/** Column names of ZICCLOUDSYNCINGOBJECT, cached per database path. */
export function objectColumns(dbPath: string = NOTES_DB_PATH): Set<string> {
  let columns = columnCache.get(dbPath);
  if (!columns) {
    columns = new Set(
      sqlite(dbPath, ["SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');"])
        .split("\n")
        .filter(Boolean)
    );
    columnCache.set(dbPath, columns);
  }
  return columns;
}

/** The attachment query for one bound note key, built from present columns. */
export function attachmentQuery(columns: Set<string>): string {
  const col = (alias: string, name: string) => (columns.has(name) ? `${alias}.${name}` : "NULL");
  const fields = ATTACHMENT_COLUMNS.map(([key, alias, name]) => `'${key}', ${col(alias, name)}`);
  const uti = `COALESCE(${col("a", "ZTYPEUTI")}, ${col("a", "ZTYPEUTI1")})`;
  const mergeable = columns.has("ZMERGEABLEDATA1")
    ? columns.has("ZMERGEABLEDATA")
      ? "COALESCE(a.ZMERGEABLEDATA1, a.ZMERGEABLEDATA)"
      : "a.ZMERGEABLEDATA1"
    : col("a", "ZMERGEABLEDATA");
  const noteLinks = ["ZNOTE", "ZNOTE1"].filter((c) => columns.has(c)).map((c) => `a.${c} = @pk`);
  const owner = noteLinks.length ? `(${noteLinks.join(" OR ")})` : "0";
  const media = columns.has("ZMEDIA") ? "m.Z_PK = a.ZMEDIA" : "0";
  const live = columns.has("ZMARKEDFORDELETION") ? "AND COALESCE(a.ZMARKEDFORDELETION, 0) = 0" : "";
  return (
    "SELECT json_object(" +
    `'title', (SELECT ${col("n", "ZTITLE1")} FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = @pk), ` +
    "'attachments', (SELECT json_group_array(json_object(" +
    `'pk', a.Z_PK, 'id', a.ZIDENTIFIER, ${fields.join(", ")}, ` +
    `'table', CASE WHEN ${uti} = 'com.apple.notes.table' THEN hex(${mergeable}) END)) ` +
    `FROM ZICCLOUDSYNCINGOBJECT a LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON ${media} ` +
    `WHERE ${owner} AND a.ZIDENTIFIER IS NOT NULL ${live}));`
  );
}

type Row = Record<string, string | number | null>;
const text = (value: unknown) =>
  typeof value === "string" && value.length
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

/** Build the attachment tree from query rows. Children attach to parents. */
export function buildAttachments(rows: Row[]): {
  byId: Map<string, ExportAttachment>;
  ordered: ExportAttachment[];
} {
  const all = rows
    .filter((row) => typeof row.id === "string" && Number.isInteger(row.pk))
    .map((row): ExportAttachment => {
      const uti = text(row.uti0) ?? text(row.uti1) ?? "unknown";
      const attachment: ExportAttachment = {
        id: row.id as string,
        pk: row.pk as number,
        uti,
        kind: classifyUti(uti),
        children: [],
      };
      const set = <K extends keyof ExportAttachment>(
        key: K,
        value: ExportAttachment[K] | undefined
      ) => {
        if (value !== undefined) attachment[key] = value;
      };
      set("parentPk", Number.isInteger(row.parent) ? (row.parent as number) : undefined);
      set("title", text(row.title) ?? text(row.userTitle) ?? text(row.mediaFilename));
      set("url", text(row.url));
      set("altText", text(row.alt));
      set("tokenId", text(row.token));
      set("mediaId", text(row.mediaId));
      set("mediaFilename", text(row.mediaFilename));
      set("mediaGeneration", text(row.mediaGen));
      set("fallbackImageGeneration", text(row.fbImageGen));
      set("fallbackPdfGeneration", text(row.fbPdfGen));
      const table = text(row.table);
      set("tableData", table && /^[0-9a-f]+$/i.test(table) ? table : undefined);
      return attachment;
    })
    .sort((a, b) => a.pk - b.pk);
  const byPk = new Map(all.map((a) => [a.pk, a]));
  const ordered: ExportAttachment[] = [];
  for (const attachment of all) {
    const parent = attachment.parentPk !== undefined ? byPk.get(attachment.parentPk) : undefined;
    if (parent) parent.children.push(attachment);
    else ordered.push(attachment);
  }
  return { byId: new Map(all.map((a) => [a.id, a])), ordered };
}

/**
 * Load one note for export by exact `x-coredata` id: decoded blocks, title,
 * and attachment rows. Throws {@link NoteBlocksError} with a stable code.
 */
export function readExportNote(
  id: string,
  { dbPath = NOTES_DB_PATH }: { dbPath?: string } = {}
): ExportNote {
  const doc = readNoteBlocks(id, { dbPath });
  const pk = /\/ICNote\/p([0-9]{1,18})$/.exec(id)![1];
  const output = sqlite(dbPath, [
    "-cmd",
    ".parameter init",
    "-cmd",
    `.parameter set @pk ${pk}`,
    attachmentQuery(objectColumns(dbPath)),
  ]);
  let parsed: { title?: unknown; attachments?: unknown };
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new NoteBlocksError("query-failed", "Unexpected Notes database response");
  }
  const rows = Array.isArray(parsed.attachments) ? (parsed.attachments as Row[]) : [];
  const { byId, ordered } = buildAttachments(rows);
  const firstLine = doc.blocks.find((block) => block.text.trim())?.text.trim() ?? "";
  return {
    id,
    title: text(parsed.title) ?? firstLine,
    doc,
    attachments: byId,
    ordered,
  };
}
