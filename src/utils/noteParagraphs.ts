/**
 * Paragraph listing and direct paragraph links (read-only), for
 * `list-note-paragraphs` and `get-paragraph-link`.
 *
 * Notes opens a paragraph from
 * `applenotes://showNote?identifier=<NOTE-UUID>&paragraphID=<PARAGRAPH-UUID>`,
 * where the paragraph UUID is ParagraphStyle field 9 of the paragraph's text
 * runs. That UUID is not unique: Notes copies it when a paragraph is split,
 * so neighbouring paragraphs often share one, and a link to a shared UUID can
 * open the wrong paragraph. A link is therefore returned only when the UUID
 * on the paragraph's first run is present and appears on no run of any other
 * paragraph in the note (runs crossing a paragraph break count for both
 * paragraphs). Otherwise the request is refused with a reason; this module
 * never mints or repairs a UUID.
 *
 * @module utils/noteParagraphs
 */

import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  decodeCompressedNoteBlocks,
  NoteBlocksError,
  type BlockStyle,
  type NoteBlocksDocument,
} from "./noteBlocks.js";
import { decodeWireFields, type WireField } from "./protobuf.js";
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

/** Why a paragraph can or cannot be linked. */
export type ParagraphIdStatus = "unique" | "shared" | "missing";

/** One non-empty paragraph of a note. */
export interface NoteParagraph {
  /** Index of the block in get-note-blocks (empty paragraphs included). */
  blockIndex: number;
  text: string;
  style: BlockStyle;
  styleType: number | null;
  /** The UUID on the paragraph's first run, uppercase, or null. */
  paragraphId: string | null;
  paragraphIdStatus: ParagraphIdStatus;
  /** How many other paragraphs carry the same UUID (status `shared`). */
  sharedWith?: number;
  /** The paragraph's runs carry more than one UUID; only the first is used. */
  mixedParagraphIds?: true;
  /** Direct Notes link, present only when `paragraphIdStatus` is `unique`. */
  url?: string;
}

/** Stable refusal codes for paragraph selection and linking. */
export type ParagraphLinkErrorCode =
  | "encrypted"
  | "no-body"
  | "ambiguous-note"
  | "no-match"
  | "ambiguous-paragraph"
  | "occurrence-out-of-range"
  | "paragraph-id-missing"
  | "paragraph-id-shared";

export class ParagraphLinkError extends Error {
  readonly code: ParagraphLinkErrorCode;
  constructor(code: ParagraphLinkErrorCode, message: string) {
    super(message);
    this.name = "ParagraphLinkError";
    this.code = code;
  }
}

/** Build the direct Notes link for a paragraph. */
export const paragraphUrl = (noteIdentifier: string, paragraphId: string): string =>
  `applenotes://showNote?identifier=${noteIdentifier.toUpperCase()}&paragraphID=${paragraphId.toUpperCase()}`;

/**
 * Text used for matching: Unicode NFKC, attachment characters removed,
 * whitespace collapsed, case folded.
 */
export const normalizeParagraphText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/\ufffc/g, "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const bytesField = (fields: WireField[], n: number) =>
  fields.find((f) => f.fieldNumber === n && f.wireType === 2)?.bytes;
const uuidOf = (bytes: Uint8Array | undefined) => {
  if (bytes?.length !== 16) return undefined;
  const h = Buffer.from(bytes).toString("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * The paragraph UUID stored on every attribute run, in order, with each run's
 * UTF-16 start and length. Call only after the block decoder accepted the same
 * data, which has already validated the structure and run lengths.
 */
export function runParagraphIds(
  data: Uint8Array
): Array<{ start: number; length: number; paragraphId?: string }> {
  const document = decodeWireFields(bytesField(decodeWireFields(data), 2)!);
  const note = decodeWireFields(bytesField(document, 3)!);
  const runs: Array<{ start: number; length: number; paragraphId?: string }> = [];
  let start = 0;
  for (const field of note.filter((f) => f.fieldNumber === 5)) {
    const run = decodeWireFields(field.bytes!);
    const length = Number(run.find((f) => f.fieldNumber === 1)!.varint);
    const style = bytesField(run, 2);
    const paragraphId = style ? uuidOf(bytesField(decodeWireFields(style), 9)) : undefined;
    runs.push({ start, length, ...(paragraphId ? { paragraphId } : {}) });
    start += length;
  }
  return runs;
}

/**
 * Classify every block's paragraph UUID (the one on its first run). A block
 * owns the UTF-16 range from its start through its terminating newline. The
 * UUID is `unique` when no run outside that range carries it, so a link to it
 * cannot land in another paragraph. `mixed` reports a paragraph whose runs
 * carry more than one UUID (common, and harmless for a unique first UUID).
 */
export function classifyParagraphIds(
  doc: NoteBlocksDocument,
  runs: ReturnType<typeof runParagraphIds>
): Array<{
  status: ParagraphIdStatus;
  paragraphId: string | null;
  sharedWith?: number;
  mixed: boolean;
}> {
  const ranges = doc.blocks.map((block) => [block.start, block.start + block.length + 1]);
  const blocksOfId = new Map<string, Set<number>>();
  const idsOfBlock = doc.blocks.map(() => new Set<string | undefined>());
  let b = 0;
  for (const run of runs) {
    const end = run.start + run.length;
    while (b < ranges.length && ranges[b][1] <= run.start) b++;
    for (let i = b; i < ranges.length && ranges[i][0] < end; i++) {
      idsOfBlock[i].add(run.paragraphId);
      if (run.paragraphId) {
        const owners = blocksOfId.get(run.paragraphId) ?? new Set<number>();
        owners.add(i);
        blocksOfId.set(run.paragraphId, owners);
      }
    }
  }
  return doc.blocks.map((block, i) => {
    const paragraphId = block.paragraphUuid ?? null;
    const mixed = idsOfBlock[i].size > 1;
    if (!paragraphId) return { status: "missing", paragraphId, mixed };
    const owners = blocksOfId.get(paragraphId)!.size;
    return owners === 1
      ? { status: "unique", paragraphId, mixed }
      : { status: "shared", paragraphId, sharedWith: owners - 1, mixed };
  });
}

/** List a decoded note's non-empty paragraphs with their link status. */
export function paragraphsOf(
  doc: NoteBlocksDocument,
  runs: ReturnType<typeof runParagraphIds>,
  noteIdentifier: string | null
): NoteParagraph[] {
  const ids = classifyParagraphIds(doc, runs);
  const out: NoteParagraph[] = [];
  doc.blocks.forEach((block, i) => {
    if (!normalizeParagraphText(block.text)) return;
    const { status, paragraphId, sharedWith, mixed } = ids[i];
    out.push({
      blockIndex: block.index,
      text: block.text,
      style: block.style,
      styleType: block.styleType,
      paragraphId,
      paragraphIdStatus: status,
      ...(sharedWith !== undefined ? { sharedWith } : {}),
      ...(mixed ? { mixedParagraphIds: true as const } : {}),
      ...(status === "unique" && noteIdentifier
        ? { url: paragraphUrl(noteIdentifier, paragraphId!) }
        : {}),
    });
  });
  return out;
}

/** Selects one paragraph. Give exactly one of `contains`, `match`, `blockIndex`. */
export interface ParagraphSelector {
  /** Normalized substring of the paragraph. */
  contains?: string;
  /** The whole paragraph, normalized. */
  match?: string;
  /** The paragraph's block index (from list-note-paragraphs or get-note-blocks). */
  blockIndex?: number;
  /** 1-based occurrence among text matches. Required when a snippet matches several. */
  occurrence?: number;
}

/** Pick one paragraph, refusing ambiguous or missing matches. */
export function selectParagraph(
  paragraphs: NoteParagraph[],
  selector: ParagraphSelector
): NoteParagraph {
  const given = [selector.contains, selector.match, selector.blockIndex].filter(
    (value) => value !== undefined
  ).length;
  if (given !== 1)
    throw new NoteStoreError(
      "invalid-argument",
      "Choose exactly one paragraph selector: contains, match, or blockIndex"
    );
  if (selector.blockIndex !== undefined) {
    const hit = paragraphs.find((p) => p.blockIndex === selector.blockIndex);
    if (!hit)
      throw new ParagraphLinkError(
        "no-match",
        `Block ${selector.blockIndex} is not a non-empty paragraph of this note`
      );
    return hit;
  }
  const wanted = normalizeParagraphText((selector.contains ?? selector.match)!);
  if (!wanted)
    throw new NoteStoreError("invalid-argument", "The paragraph selector has no visible text");
  const matches = paragraphs.filter((p) =>
    selector.match !== undefined
      ? normalizeParagraphText(p.text) === wanted
      : normalizeParagraphText(p.text).includes(wanted)
  );
  if (!matches.length)
    throw new ParagraphLinkError("no-match", "No paragraph matches the selector");
  if (selector.occurrence === undefined && matches.length > 1)
    throw new ParagraphLinkError(
      "ambiguous-paragraph",
      `The selector matches ${matches.length} paragraphs; use a longer snippet or pass occurrence (1-${matches.length})`
    );
  const occurrence = selector.occurrence ?? 1;
  if (occurrence > matches.length)
    throw new ParagraphLinkError(
      "occurrence-out-of-range",
      `Occurrence ${occurrence} requested but only ${matches.length} paragraphs match`
    );
  return matches[occurrence - 1];
}

/** Selects one note. Give exactly one of `id`, `identifier`, `title`. */
export interface NoteSelector {
  id?: string;
  /** The note's UUID (ZIDENTIFIER). */
  identifier?: string;
  /** Exact title; with `folder` (name or path) to disambiguate duplicates. */
  title?: string;
  folder?: string;
}

interface NoteListRow {
  pk: number;
  identifier: string | null;
  title: string | null;
  folder: number | null;
  active: number;
}
interface FolderRow {
  pk: number;
  title: string | null;
  parent: number | null;
}

/** `/`-joined folder path, with a literal `/` in a name escaped as `\/`. */
function folderPath(folders: Map<number, FolderRow>, pk: number | null): string | null {
  const parts: string[] = [];
  const seen = new Set<number>();
  for (let f = folders.get(pk ?? -1); f && !seen.has(f.pk); f = folders.get(f.parent ?? -1)) {
    seen.add(f.pk);
    parts.unshift((f.title ?? "").replace(/\//g, "\\/"));
  }
  return parts.length ? parts.join("/") : null;
}

/** SQL for the note list used by identifier and title selection. */
export function noteListSql(columns: Set<string>): string {
  const { col, notDeleted } = schemaHelpers(columns);
  return `SELECT json_group_array(json_object('pk', n.Z_PK, 'identifier', ${col("n", "ZIDENTIFIER")},
      'title', ${col("n", "ZTITLE1")}, 'folder', ${col("n", "ZFOLDER")},
      'active', ${notDeleted("n")} AND ${col("n", "ZFOLDER")} IS NOT NULL
        AND COALESCE(${col("f", "ZFOLDERTYPE")}, 0) <> 1))
    FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = ${col("n", "ZFOLDER")}
    WHERE n.Z_ENT = ${entity("ICNote")};
    SELECT json_group_array(json_object('pk', x.Z_PK, 'title', ${col("x", "ZTITLE2")}, 'parent', ${col("x", "ZPARENT")}))
    FROM ZICCLOUDSYNCINGOBJECT x WHERE x.Z_ENT = ${entity("ICFolder")};
    SELECT json_object('uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1));`;
}

/** Resolve a note selector to a primary key and canonical id. */
export function resolveNote(
  dbPath: string,
  columns: Set<string>,
  selector: NoteSelector
): { pk: number; id: string | null } {
  const given = [selector.id, selector.identifier, selector.title].filter(
    (value) => value !== undefined
  ).length;
  if (given !== 1)
    throw new NoteStoreError("invalid-argument", "Choose exactly one of id, identifier, or title");
  if (selector.folder !== undefined && selector.title === undefined)
    throw new NoteStoreError("invalid-argument", "folder only narrows a title lookup");
  if (selector.id) return { pk: notePrimaryKey(selector.id), id: selector.id };
  const [noteLine, folderLine, storeLine] = runStoreSql(dbPath, noteListSql(columns));
  const notes = parseJsonLine<NoteListRow[]>(noteLine, []);
  const folders = new Map(parseJsonLine<FolderRow[]>(folderLine, []).map((f) => [f.pk, f]));
  const store = parseJsonLine<{ uuid: string | null }>(storeLine, { uuid: null }).uuid;
  let matches: NoteListRow[];
  if (selector.identifier !== undefined) {
    const wanted = selector.identifier.toUpperCase();
    matches = notes.filter((n) => (n.identifier ?? "").toUpperCase() === wanted);
  } else {
    matches = notes.filter((n) => n.active && n.title === selector.title);
    if (selector.folder !== undefined) {
      const wanted = selector.folder;
      matches = matches.filter((n) => {
        const path = folderPath(folders, n.folder);
        return path === wanted || folders.get(n.folder ?? -1)?.title === wanted;
      });
    }
  }
  if (!matches.length) throw new NoteStoreError("not-found", "No note matches the selector");
  if (matches.length > 1)
    throw new ParagraphLinkError(
      "ambiguous-note",
      `${matches.length} notes match; pass folder (name or path) or use the note id. Folders: ${matches
        .map((n) => folderPath(folders, n.folder) ?? "(none)")
        .join(", ")}`
    );
  const pk = matches[0].pk;
  return { pk, id: store ? `x-coredata://${store}/ICNote/p${pk}` : null };
}

/** Everything the paragraph tools need about one note. */
export interface NoteParagraphs {
  id: string | null;
  identifier: string | null;
  paragraphs: NoteParagraph[];
  counts: Record<ParagraphIdStatus, number>;
}

/** Read and classify one note's paragraphs (read-only). */
export function readNoteParagraphs(
  selector: NoteSelector,
  { dbPath = NOTES_DB_PATH }: { dbPath?: string } = {}
): NoteParagraphs {
  if (!existsSync(dbPath))
    throw new NoteStoreError("no-full-disk-access", "The Notes database is not readable");
  const columns = objectColumns(dbPath);
  const { pk, id } = resolveNote(dbPath, columns, selector);
  const { col } = schemaHelpers(columns);
  const [line] = runStoreSql(
    dbPath,
    `SELECT json_object('isNote', n.Z_ENT = ${entity("ICNote")},
        'identifier', ${col("n", "ZIDENTIFIER")},
        'data', (SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK),
        'encrypted', (SELECT d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK),
        'locked', ${col("n", "ZISPASSWORDPROTECTED")})
      FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = @pk;`,
    { pk }
  );
  const row = parseJsonLine<{
    isNote: number;
    identifier: string | null;
    data: string | null;
    encrypted: number | null;
    locked: number | null;
  } | null>(line, null);
  if (!row || !row.isNote) throw new NoteStoreError("not-found", "No note found for the selector");
  if (row.encrypted || row.locked)
    throw new ParagraphLinkError(
      "encrypted",
      "This note is password-protected; its body is encrypted"
    );
  if (!row.data || !/^[0-9a-f]+$/i.test(row.data))
    throw new ParagraphLinkError("no-body", "No body data is stored for this note");
  const compressed = Buffer.from(row.data, "hex");
  let doc: NoteBlocksDocument;
  try {
    doc = decodeCompressedNoteBlocks(compressed);
  } catch (error) {
    const message = error instanceof NoteBlocksError ? error.message : String(error);
    throw new ParagraphLinkError("no-body", `The note body could not be decoded: ${message}`);
  }
  const runs = runParagraphIds(gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }));
  const paragraphs = paragraphsOf(doc, runs, row.identifier);
  const counts: Record<ParagraphIdStatus, number> = { unique: 0, shared: 0, missing: 0 };
  for (const p of paragraphs) counts[p.paragraphIdStatus]++;
  return { id, identifier: row.identifier, paragraphs, counts };
}

/** One page of paragraphs, bounded by count and serialized size. */
export function pageParagraphs(
  paragraphs: NoteParagraph[],
  { offset = 0, limit = 500, maxBytes = 4 * 1024 * 1024, linkableOnly = false } = {}
): {
  paragraphs: NoteParagraph[];
  page: { offset: number; returned: number; total: number; hasMore: boolean; nextOffset?: number };
} {
  const list = linkableOnly ? paragraphs.filter((p) => p.url) : paragraphs;
  const start = Math.min(Math.max(0, offset), list.length);
  const out: NoteParagraph[] = [];
  let bytes = 0;
  for (let i = start; i < list.length && out.length < limit; i++) {
    const size = Buffer.byteLength(JSON.stringify(list[i]));
    if (out.length && bytes + size > maxBytes) break;
    out.push(list[i]);
    bytes += size;
  }
  const next = start + out.length;
  return {
    paragraphs: out,
    page: {
      offset: start,
      returned: out.length,
      total: list.length,
      hasMore: next < list.length,
      ...(next < list.length ? { nextOffset: next } : {}),
    },
  };
}

/**
 * Select one paragraph and return its direct link, or throw a
 * {@link ParagraphLinkError} explaining why no safe link exists.
 */
export function paragraphLink(
  note: NoteParagraphs,
  selector: ParagraphSelector
): { url: string; paragraph: NoteParagraph } {
  const paragraph = selectParagraph(note.paragraphs, selector);
  if (paragraph.paragraphIdStatus === "shared")
    throw new ParagraphLinkError(
      "paragraph-id-shared",
      `This paragraph's ID is shared with ${paragraph.sharedWith} other paragraph(s) in the note, so a link could open the wrong one`
    );
  if (!paragraph.url)
    throw new ParagraphLinkError(
      "paragraph-id-missing",
      paragraph.paragraphId
        ? "The note has no stored identifier, so no link can be built"
        : "This paragraph has no stored paragraph ID, so Notes cannot open it directly"
    );
  return { url: paragraph.url, paragraph };
}
