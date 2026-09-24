/**
 * One-call structural read of a note (read-only), for `get-note-structure`.
 *
 * Combines the decoded body (noteBlocks.ts) with the note's database rows:
 * links of every kind, native tags, attachments with a kind classified from
 * their UTI (gallery and recording children nested under their parent),
 * sharing, lock and last-viewed state, word and character counts, checklist
 * counts, drawing presence and the lead image.
 *
 * A password-protected note still returns its metadata and attachment rows;
 * only the fields that need the encrypted body are null.
 *
 * @module utils/noteStructure
 */

import { countWords } from "./wordCount.js";
import { dirname } from "node:path";
import {
  assembleAttachmentAssets,
  attachmentCoreDataId,
  parseNoteId,
  readNoteAttachmentRows,
  selectFirstImage,
  type AttachmentKind,
  type FirstImage,
} from "./attachmentAssets.js";
import {
  decodeCompressedNoteBlocks,
  NoteBlocksError,
  type NoteBlocksDocument,
  type NoteBlocksSummary,
} from "./noteBlocks.js";
import {
  cardLink,
  HASHTAG_UTI,
  inlineLinks,
  markerPosition,
  nativeLink,
  NOTE_LINK_UTI,
  type NoteLinkEntry,
} from "./noteLinks.js";
import {
  accountRef,
  col,
  entity,
  NOTES_DB_PATH,
  NoteStoreError,
  notTombstonedSql,
  parseJsonLines,
  readColumns,
  runReadOnlySql,
  trashFolderSql,
} from "./noteStoreSql.js";

/** Seconds between the Unix epoch and Apple's reference date (2001-01-01). */
const APPLE_EPOCH_OFFSET = 978307200;
/**
 * Stored in ZLASTVIEWEDMODIFICATIONDATE for a note that has never been
 * opened: Notes' model makes the attribute non-optional and defaults it to
 * this 1983 date. Verified on a live library: 748 of 843 notes carried
 * exactly this value; every other value was a plausible recent date.
 */
export const LAST_VIEWED_NEVER = -541228980;

/** Why `lastViewed` is null, or `viewed` when it is a date. */
export type LastViewedStatus =
  "viewed" | "never-viewed" | "not-recorded" | "malformed" | "unsupported";

/** Interpret a raw ZLASTVIEWEDMODIFICATIONDATE value. */
export function lastViewedOf(
  raw: unknown,
  columnPresent = true,
  now = Date.now()
): { lastViewed: string | null; lastViewedStatus: LastViewedStatus } {
  if (!columnPresent) return { lastViewed: null, lastViewedStatus: "unsupported" };
  if (raw === null || raw === undefined)
    return { lastViewed: null, lastViewedStatus: "not-recorded" };
  const seconds = typeof raw === "number" ? raw : Number.NaN;
  if (seconds === LAST_VIEWED_NEVER) return { lastViewed: null, lastViewedStatus: "never-viewed" };
  const ms = (seconds + APPLE_EPOCH_OFFSET) * 1000;
  // Before the first Notes release or more than a day in the future: not a real view.
  if (!Number.isFinite(ms) || ms < Date.UTC(2007, 0, 1) || ms > now + 86_400_000)
    return { lastViewed: null, lastViewedStatus: "malformed" };
  return { lastViewed: new Date(ms).toISOString(), lastViewedStatus: "viewed" };
}

/** Visible text: the note text without attachment placeholder characters. */
const visible = (text: string) => text.replace(/\ufffc/g, "");

/**
 * Words of the visible text (attachment characters separate words), counted by utils/wordCount: the same count
 * query-notes filters on with words: and the other tools report.
 */
export const wordCount = (text: string): number => countWords(text);

/** Unicode code points of the visible text, newlines included. */
export const charCount = (text: string): number => Array.from(visible(text)).length;

/**
 * One attachment of the note, as list-attachments reports it (same kind,
 * body order and preview), plus card details and its body position.
 * Children are nested under their parent.
 */
export interface StructureAttachment {
  id: string;
  identifier: string;
  uti: string | null;
  kind: AttachmentKind;
  title?: string;
  filename?: string;
  url?: string;
  fileSize?: number;
  /** UTF-16 offset of the attachment character, when it is in the body. */
  start?: number;
  blockIndex?: number;
  /** False when the row exists but the body has no marker for it. */
  inBody?: boolean;
  /** Largest rendered preview image on disk, or null when Notes stored none. */
  previewPath: string | null;
  parentId?: string;
  children?: StructureAttachment[];
}

/** The note's lead visual (list-attachments' firstImage) with its attachment id. */
export type StructureFirstImage = FirstImage & { id: string };

/** Result of {@link readNoteStructure}. */
export interface NoteStructure {
  id: string;
  identifier: string | null;
  deepLink: string | null;
  title: string | null;
  folder: string | null;
  account: string | null;
  inRecentlyDeleted: boolean;
  isShared: boolean | null;
  isLocked: boolean;
  isPinned: boolean | null;
  lastViewed: string | null;
  lastViewedStatus: LastViewedStatus;
  /** True when the body was decoded; false for locked or unreadable bodies. */
  bodyDecoded: boolean;
  /** Why the body was not decoded (`encrypted`, `no-body`, a decode error code). */
  bodyError?: string;
  text?: string;
  textOmitted?: true;
  textLength: number | null;
  wordCount: number | null;
  charCount: number | null;
  blockSummary: NoteBlocksSummary | null;
  links: NoteLinkEntry[];
  linkCounts: Record<"inline" | "card" | "note" | "section", number>;
  /** False when inline links could not be read (body not decoded). */
  linksComplete: boolean;
  tags: string[];
  attachments: StructureAttachment[];
  /** Top-level attachments; gallery and recording children are not counted. */
  attachmentCount: number;
  checklistTotal: number | null;
  checklistDone: number | null;
  hasDrawing: boolean;
  firstImage: StructureFirstImage | null;
  undecodedFields?: NoteBlocksDocument["undecodedFields"];
}

interface NoteRow {
  k: "note";
  isNote: number | null;
  identifier: string | null;
  title: string | null;
  folder: string | null;
  inTrash: number | null;
  account: string | null;
  locked: number | null;
  pinned: number | null;
  shared: number | null;
  lastViewed: unknown;
  data: string | null;
  encrypted: number | null;
}
interface DetailRow {
  k: "attachment";
  pk: number;
  title: string | null;
  url: string | null;
  fileSize: number | null;
}
interface InlineRow {
  k: "inline";
  identifier: string | null;
  uti: string | null;
  alt: string | null;
  token: string | null;
}
type StructureRow = NoteRow | DetailRow | InlineRow;

/**
 * Build the read-only SQL for one note, one JSON object per line tagged with
 * `k`. Only `@pk` is bound. Attachment files, kinds and order come from
 * attachmentAssets.ts; this adds the card title, URL and size that list does
 * not read.
 */
export function noteStructureSql(columns: ReadonlySet<string>): string {
  const c = (alias: string, name: string) => col(columns, alias, name);
  const sharedExpr = columns.has("ZSERVERSHAREDATA")
    ? `(n.ZSERVERSHAREDATA IS NOT NULL OR EXISTS (
         WITH RECURSIVE up(pk, depth) AS (
           SELECT n.ZFOLDER, 0 UNION ALL
           SELECT ${c("p", "ZPARENT")}, depth + 1 FROM up JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = up.pk
           WHERE depth < 64)
         SELECT 1 FROM up JOIN ZICCLOUDSYNCINGOBJECT s ON s.Z_PK = up.pk WHERE s.ZSERVERSHAREDATA IS NOT NULL))`
    : "NULL";
  const children = columns.has("ZPARENTATTACHMENT")
    ? ` OR att.ZPARENTATTACHMENT IN (SELECT p.Z_PK FROM ZICCLOUDSYNCINGOBJECT p WHERE ${c("p", "ZNOTE")} = @pk)`
    : "";
  return [
    "BEGIN;",
    `SELECT json_object('k', 'note',
      'isNote', n.Z_ENT = ${entity("ICNote")},
      'identifier', ${c("n", "ZIDENTIFIER")},
      'title', ${c("n", "ZTITLE1")},
      'folder', ${c("f", "ZTITLE2")},
      'inTrash', CASE WHEN f.Z_PK IS NULL THEN 0 ELSE ${trashFolderSql(columns, "f")} END,
      'account', ${c("a", "ZNAME")},
      'locked', ${c("n", "ZISPASSWORDPROTECTED")},
      'pinned', ${c("n", "ZISPINNED")},
      'shared', ${sharedExpr},
      'lastViewed', ${c("n", "ZLASTVIEWEDMODIFICATIONDATE")},
      'data', (SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK),
      'encrypted', (SELECT d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK))
    FROM ZICCLOUDSYNCINGOBJECT n
    LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = ${c("n", "ZFOLDER")}
    LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = ${accountRef(columns, "n")} AND a.Z_ENT = ${entity("ICAccount")}
    WHERE n.Z_PK = @pk;`,
    `SELECT json_object('k', 'attachment',
      'pk', att.Z_PK,
      'title', ${c("att", "ZTITLE")},
      'url', ${c("att", "ZURLSTRING")},
      'fileSize', ${c("att", "ZFILESIZE")})
    FROM ZICCLOUDSYNCINGOBJECT att
    WHERE att.Z_ENT = ${entity("ICAttachment")} AND ${notTombstonedSql(columns, "att")}
      AND (${c("att", "ZNOTE")} = @pk${children});`,
    `SELECT json_object('k', 'inline',
      'identifier', ${c("i", "ZIDENTIFIER")},
      'uti', ${c("i", "ZTYPEUTI1")},
      'alt', ${c("i", "ZALTTEXT")},
      'token', ${c("i", "ZTOKENCONTENTIDENTIFIER")})
    FROM ZICCLOUDSYNCINGOBJECT i
    WHERE i.Z_ENT = ${entity("ICInlineAttachment")} AND ${c("i", "ZNOTE1")} = @pk
      AND ${notTombstonedSql(columns, "i")} AND ${c("i", "ZTYPEUTI1")} IN ('${HASHTAG_UTI}', '${NOTE_LINK_UTI}');`,
    "COMMIT;",
  ].join("\n");
}

/** One-line text summary of a structure read, for the tool's text content. */
export function describeNoteStructure(s: NoteStructure): string {
  const parts = [
    s.bodyDecoded
      ? `${s.blockSummary!.blocks} blocks, ${s.wordCount} words`
      : `body not decoded (${s.bodyError})`,
    `${s.links.length} links (inline ${s.linkCounts.inline}, card ${s.linkCounts.card}, note ${s.linkCounts.note}, section ${s.linkCounts.section})`,
    `${s.attachmentCount} attachments`,
    `${s.tags.length} tags`,
  ];
  if (s.checklistTotal) parts.push(`checklist ${s.checklistDone}/${s.checklistTotal} done`);
  if (s.hasDrawing) parts.push("has a drawing");
  if (s.isLocked) parts.push("locked");
  if (s.isShared) parts.push("shared");
  return `Note structure: ${parts.join("; ")}.`;
}

/**
 * Read one note's structure from the NoteStore database (read-only).
 * `id` must be the canonical x-coredata note id (the tool schema resolves a
 * UUID or numeric key to it). `dbPath` exists for tests against a fixture
 * database; attachment files resolve under the database's directory.
 */
export function readNoteStructure(
  id: string,
  { dbPath = NOTES_DB_PATH, includeText = true, maxTextBytes = 4 * 1024 * 1024 } = {}
): NoteStructure {
  const { pk } = parseNoteId(id);
  const columns = readColumns(dbPath);
  const rows = parseJsonLines<StructureRow>(
    runReadOnlySql(dbPath, noteStructureSql(columns), { pk: { int: pk } })
  );
  const note = rows.find((row): row is NoteRow => row.k === "note");
  if (!note?.isNote) throw new NoteStoreError(`No note found for ID "${id}".`, "invalid_input");
  const details = new Map(
    rows.filter((row): row is DetailRow => row.k === "attachment").map((row) => [row.pk, row])
  );
  const inlineRows = rows.filter((row): row is InlineRow => row.k === "inline");

  let doc: NoteBlocksDocument | undefined;
  let bodyError: string | undefined;
  if (note.encrypted || note.locked) bodyError = "encrypted";
  else if (!note.data || !/^[0-9a-f]+$/i.test(note.data)) bodyError = "no-body";
  else
    try {
      doc = decodeCompressedNoteBlocks(Buffer.from(note.data, "hex"));
    } catch (error) {
      if (!(error instanceof NoteBlocksError)) throw error;
      bodyError = error.code;
    }

  // The same rows, kinds, body order and previews list-attachments reports.
  const { rows: attachmentRows, bodyOrder } = readNoteAttachmentRows(id, dbPath);
  const assets = assembleAttachmentAssets(attachmentRows, bodyOrder, dirname(dbPath));
  const roots = new Map<string, StructureAttachment>();
  const attachments: StructureAttachment[] = [];
  const pks = new Map<StructureAttachment, number>();
  for (const record of assets.attachments) {
    const detail = details.get(record.pk);
    const parent =
      record.parentIdentifier !== null ? roots.get(record.parentIdentifier) : undefined;
    const item: StructureAttachment = {
      id: attachmentCoreDataId(id, record.pk),
      identifier: record.identifier,
      uti: record.uti,
      kind: record.kind,
      ...(detail?.title ? { title: detail.title } : {}),
      ...(record.filename ? { filename: record.filename } : {}),
      ...(detail?.url ? { url: detail.url } : {}),
      ...(typeof detail?.fileSize === "number" ? { fileSize: detail.fileSize } : {}),
      ...markerPosition(doc, record.identifier),
      previewPath: record.previewPath,
      ...(parent ? { parentId: parent.id } : {}),
    };
    pks.set(item, record.pk);
    if (parent) (parent.children ||= []).push(item);
    else {
      roots.set(record.identifier, item);
      attachments.push(item);
    }
  }
  const flat = attachments.flatMap((item) => [item, ...(item.children ?? [])]);

  const links: NoteLinkEntry[] = doc ? inlineLinks(doc) : [];
  for (const item of flat) {
    if (item.kind !== "url") continue;
    const link = cardLink(
      {
        pk: pks.get(item)!,
        identifier: item.identifier,
        url: item.url ?? null,
        title: item.title ?? null,
      },
      { doc, noteId: id, previewPath: item.previewPath }
    );
    if (link) links.push(link);
  }
  const tagOrder: Array<{ tag: string; start: number }> = [];
  for (const row of inlineRows) {
    if (!row.identifier) continue;
    if (row.uti === NOTE_LINK_UTI) {
      const link = nativeLink({ identifier: row.identifier, token: row.token, alt: row.alt }, doc);
      if (link) links.push(link);
    } else if (row.alt) {
      const position = markerPosition(doc, row.identifier);
      if (position.inBody !== false)
        tagOrder.push({ tag: row.alt.replace(/^#/, ""), start: position.start ?? 0 });
    }
  }
  links.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  const tags = [...new Set(tagOrder.sort((a, b) => a.start - b.start).map((entry) => entry.tag))];

  let text: string | undefined;
  let textOmitted: true | undefined;
  if (doc && includeText) {
    if (Buffer.byteLength(doc.text) <= maxTextBytes) text = doc.text;
    else textOmitted = true;
  }
  const linkCounts = { inline: 0, card: 0, note: 0, section: 0 };
  for (const link of links) linkCounts[link.kind]++;
  const lastViewed = lastViewedOf(note.lastViewed, columns.has("ZLASTVIEWEDMODIFICATIONDATE"));
  const first = selectFirstImage(assets);

  return {
    id,
    identifier: note.identifier,
    deepLink: note.identifier ? `notes://showNote?identifier=${note.identifier}` : null,
    title: note.title,
    folder: note.folder,
    account: note.account,
    inRecentlyDeleted: note.inTrash === 1,
    isShared: note.shared === null ? null : note.shared === 1,
    isLocked: note.locked === 1 || note.encrypted === 1,
    isPinned: note.pinned === null ? null : note.pinned === 1,
    ...lastViewed,
    bodyDecoded: doc !== undefined,
    ...(bodyError ? { bodyError } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(textOmitted ? { textOmitted } : {}),
    textLength: doc ? doc.textLength : null,
    wordCount: doc ? wordCount(doc.text) : null,
    charCount: doc ? charCount(doc.text) : null,
    blockSummary: doc ? doc.summary : null,
    links,
    linkCounts,
    linksComplete: doc !== undefined,
    tags,
    attachments,
    attachmentCount: attachments.length,
    checklistTotal: doc ? doc.summary.checklist.total : null,
    checklistDone: doc ? doc.summary.checklist.done : null,
    hasDrawing: flat.some((item) => item.kind === "drawing"),
    firstImage: first ? { ...first, id: attachmentCoreDataId(id, first.pk) } : null,
    ...(doc ? { undecodedFields: doc.undecodedFields } : {}),
  };
}
