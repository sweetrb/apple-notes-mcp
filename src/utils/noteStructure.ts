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

import { dirname } from "node:path";
import { existsSync } from "node:fs";
import {
  decodeCompressedNoteBlocks,
  NoteBlocksError,
  type NoteBlocksDocument,
  type NoteBlocksSummary,
} from "./noteBlocks.js";
import {
  attachmentIdFor,
  cardLink,
  classifyAttachmentKind,
  HASHTAG_UTI,
  inlineLinks,
  isDrawingUti,
  markerPosition,
  nativeLink,
  NOTE_LINK_UTI,
  resolvePreviewPath,
  type AttachmentKind,
  type NoteLinkEntry,
  type PreviewRow,
} from "./noteLinks.js";
import {
  entity,
  NOTES_DB_PATH,
  NoteStoreError,
  notePrimaryKey,
  objectColumns,
  parseJsonLine,
  runStoreSql,
  schemaHelpers,
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

/** Whitespace-separated words of the visible text. */
export const wordCount = (text: string): number =>
  visible(text)
    .split(/\s+/u)
    .filter((word) => word !== "").length;

/** Unicode code points of the visible text, newlines included. */
export const charCount = (text: string): number => Array.from(visible(text)).length;

/** One attachment of the note. Children are nested under their parent. */
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
  /** Largest rendered preview on disk; absent when Notes stored none. */
  previewPath?: string | null;
  parentId?: string;
  children?: StructureAttachment[];
}

/** The lead visual of a note. */
export interface FirstImage {
  id: string;
  identifier: string;
  uti: string | null;
  kind: AttachmentKind;
  parentId?: string;
  previewPath?: string | null;
}

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
  firstImage: FirstImage | null;
  undecodedFields?: NoteBlocksDocument["undecodedFields"];
}

interface NoteRow {
  isNote: number | null;
  identifier: string | null;
  title: string | null;
  folder: string | null;
  folderType: number | null;
  account: string | null;
  accountIdentifier: string | null;
  locked: number | null;
  pinned: number | null;
  shared: number | null;
  lastViewed: unknown;
  data: string | null;
  encrypted: number | null;
}
interface AttachmentRow {
  pk: number;
  identifier: string | null;
  uti: string | null;
  parent: number | null;
  title: string | null;
  url: string | null;
  fileSize: number | null;
  filename: string | null;
  account: string | null;
}
interface InlineRow {
  identifier: string | null;
  uti: string | null;
  alt: string | null;
  token: string | null;
}

/** Build the read-only SQL for one note. Only `@pk` is bound. */
export function noteStructureSql(columns: Set<string>): string {
  const { col, accountOf, notDeleted } = schemaHelpers(columns);
  const sharedExpr = columns.has("ZSERVERSHAREDATA")
    ? `(n.ZSERVERSHAREDATA IS NOT NULL OR EXISTS (
         WITH RECURSIVE up(pk, depth) AS (
           SELECT n.ZFOLDER, 0 UNION ALL
           SELECT ${col("p", "ZPARENT")}, depth + 1 FROM up JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = up.pk
           WHERE depth < 64)
         SELECT 1 FROM up JOIN ZICCLOUDSYNCINGOBJECT s ON s.Z_PK = up.pk WHERE s.ZSERVERSHAREDATA IS NOT NULL))`
    : "NULL";
  const noteAttachments = `SELECT att.Z_PK FROM ZICCLOUDSYNCINGOBJECT att
    WHERE att.Z_ENT = ${entity("ICAttachment")} AND att.ZNOTE = @pk AND ${notDeleted("att")}`;
  return [
    `SELECT json_object(
      'isNote', n.Z_ENT = ${entity("ICNote")},
      'identifier', ${col("n", "ZIDENTIFIER")},
      'title', ${col("n", "ZTITLE1")},
      'folder', ${col("f", "ZTITLE2")},
      'folderType', ${col("f", "ZFOLDERTYPE")},
      'account', ${col("a", "ZNAME")},
      'accountIdentifier', ${col("a", "ZIDENTIFIER")},
      'locked', ${col("n", "ZISPASSWORDPROTECTED")},
      'pinned', ${col("n", "ZISPINNED")},
      'shared', ${sharedExpr},
      'lastViewed', ${col("n", "ZLASTVIEWEDMODIFICATIONDATE")},
      'data', (SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK),
      'encrypted', (SELECT d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK))
    FROM ZICCLOUDSYNCINGOBJECT n
    LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = ${col("n", "ZFOLDER")}
    LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = ${accountOf("n")}
    WHERE n.Z_PK = @pk;`,
    `SELECT json_group_array(json_object(
      'pk', att.Z_PK,
      'identifier', ${col("att", "ZIDENTIFIER")},
      'uti', ${col("att", "ZTYPEUTI")},
      'parent', ${col("att", "ZPARENTATTACHMENT")},
      'title', ${col("att", "ZTITLE")},
      'url', ${col("att", "ZURLSTRING")},
      'fileSize', ${col("att", "ZFILESIZE")},
      'filename', ${col("m", "ZFILENAME")},
      'account', ${col("acc", "ZIDENTIFIER")}))
    FROM ZICCLOUDSYNCINGOBJECT att
    LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = ${col("att", "ZMEDIA")}
    LEFT JOIN ZICCLOUDSYNCINGOBJECT acc ON acc.Z_PK = ${accountOf("att")}
    WHERE att.Z_PK IN (${noteAttachments});`,
    `SELECT json_group_array(json_object(
      'attachment', ${col("p", "ZATTACHMENT")},
      'identifier', ${col("p", "ZIDENTIFIER")},
      'width', ${col("p", "ZWIDTH")},
      'height', ${col("p", "ZHEIGHT")},
      'scale', ${col("p", "ZSCALE")},
      'appearance', ${col("p", "ZAPPEARANCETYPE")}))
    FROM ZICCLOUDSYNCINGOBJECT p
    WHERE p.Z_ENT = ${entity("ICAttachmentPreviewImage")} AND ${notDeleted("p")}
      AND ${col("p", "ZATTACHMENT")} IN (${noteAttachments});`,
    `SELECT json_group_array(json_object(
      'identifier', ${col("i", "ZIDENTIFIER")},
      'uti', ${col("i", "ZTYPEUTI1")},
      'alt', ${col("i", "ZALTTEXT")},
      'token', ${col("i", "ZTOKENCONTENTIDENTIFIER")}))
    FROM ZICCLOUDSYNCINGOBJECT i
    WHERE i.Z_ENT = ${entity("ICInlineAttachment")} AND ${col("i", "ZNOTE1")} = @pk
      AND ${notDeleted("i")} AND ${col("i", "ZTYPEUTI1")} IN ('${HASHTAG_UTI}', '${NOTE_LINK_UTI}');`,
  ].join("\n");
}

/** Body order of attachments: markers first, then unplaced rows by primary key. */
function bodyOrder(rows: StructureAttachment[]): StructureAttachment[] {
  return [...rows].sort(
    (a, b) =>
      (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER) ||
      Number(/\d+$/.exec(a.id)![0]) - Number(/\d+$/.exec(b.id)![0])
  );
}

/**
 * The note's lead visual: the first image in body order (a gallery's items
 * count right after the gallery), else the first scan or drawing.
 */
export function selectFirstImage(attachments: StructureAttachment[]): FirstImage | null {
  const ordered: StructureAttachment[] = [];
  for (const item of attachments) ordered.push(item, ...(item.children ?? []));
  for (const kinds of [["image"], ["image", "scan", "drawing"]]) {
    const hit = ordered.find((item) => kinds.includes(item.kind));
    if (hit)
      return {
        id: hit.id,
        identifier: hit.identifier,
        uti: hit.uti,
        kind: hit.kind,
        ...(hit.parentId ? { parentId: hit.parentId } : {}),
        ...(hit.previewPath !== undefined ? { previewPath: hit.previewPath } : {}),
      };
  }
  return null;
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
 * `dbPath` exists for tests against a fixture database; attachment previews
 * resolve under the database's directory.
 */
export function readNoteStructure(
  id: string,
  { dbPath = NOTES_DB_PATH, includeText = true, maxTextBytes = 4 * 1024 * 1024 } = {}
): NoteStructure {
  const pk = notePrimaryKey(id);
  if (!existsSync(dbPath))
    throw new NoteStoreError("no-full-disk-access", "The Notes database is not readable");
  const columns = objectColumns(dbPath);
  const lines = runStoreSql(dbPath, noteStructureSql(columns), { pk });
  const note = parseJsonLine<NoteRow | null>(lines[0], null);
  if (!note || !note.isNote) throw new NoteStoreError("not-found", `No note found for ID "${id}"`);
  const attachmentRows = parseJsonLine<AttachmentRow[]>(lines[1], []);
  const previewRows = parseJsonLine<PreviewRow[]>(lines[2], []);
  const inlineRows = parseJsonLine<InlineRow[]>(lines[3], []);

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

  const storeDir = dirname(dbPath);
  const previewsFor = (pkValue: number) => previewRows.filter((row) => row.attachment === pkValue);
  const all = new Map<number, StructureAttachment>();
  for (const row of attachmentRows) {
    const previews = previewsFor(row.pk);
    all.set(row.pk, {
      id: attachmentIdFor(id, row.pk),
      identifier: row.identifier ?? "",
      uti: row.uti,
      kind: classifyAttachmentKind(row.uti),
      ...(row.title ? { title: row.title } : {}),
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(typeof row.fileSize === "number" ? { fileSize: row.fileSize } : {}),
      ...(row.identifier ? markerPosition(doc, row.identifier) : {}),
      ...(previews.length
        ? {
            previewPath: resolvePreviewPath(
              storeDir,
              row.account ?? note.accountIdentifier,
              previews
            ),
          }
        : {}),
      ...(row.parent !== null && row.parent !== row.pk
        ? { parentId: attachmentIdFor(id, row.parent) }
        : {}),
    });
  }
  const roots: StructureAttachment[] = [];
  for (const row of attachmentRows) {
    const item = all.get(row.pk)!;
    const parent = row.parent !== null && row.parent !== row.pk ? all.get(row.parent) : undefined;
    // A child whose parent is itself a child is promoted, which also breaks cycles.
    if (parent && parent.parentId === undefined) (parent.children ||= []).push(item);
    else {
      delete item.parentId;
      roots.push(item);
    }
  }
  const attachments = bodyOrder(roots).map((item) =>
    item.children ? { ...item, children: bodyOrder(item.children) } : item
  );

  const links: NoteLinkEntry[] = doc ? inlineLinks(doc) : [];
  for (const row of attachmentRows) {
    const item = all.get(row.pk)!;
    if (item.kind !== "url" || !row.identifier) continue;
    const link = cardLink(
      { pk: row.pk, identifier: row.identifier, url: row.url, title: row.title },
      { doc, noteId: id, previewPath: item.previewPath ?? null }
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
  const flat = attachments.flatMap((item) => [item, ...(item.children ?? [])]);
  const linkCounts = { inline: 0, card: 0, note: 0, section: 0 };
  for (const link of links) linkCounts[link.kind]++;
  const lastViewed = lastViewedOf(note.lastViewed, columns.has("ZLASTVIEWEDMODIFICATIONDATE"));

  return {
    id,
    identifier: note.identifier,
    deepLink: note.identifier ? `notes://showNote?identifier=${note.identifier}` : null,
    title: note.title,
    folder: note.folder,
    account: note.account,
    inRecentlyDeleted: note.folderType === 1,
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
    hasDrawing: flat.some((item) => isDrawingUti(item.uti)),
    firstImage: selectFirstImage(attachments),
    ...(doc ? { undecodedFields: doc.undecodedFields } : {}),
  };
}
