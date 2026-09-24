/**
 * Typed block model for Apple Notes bodies (read-only).
 *
 * Decodes the gzipped protobuf stored in `ZICNOTEDATA.ZDATA` into paragraphs
 * ("blocks") with their paragraph style, indent, alignment, block quote,
 * checklist state and paragraph UUID, plus the inline runs inside each block
 * (bold, italic, underline, strikethrough, superscript/subscript, color,
 * emphasis highlight, link) and attachment markers in body order.
 *
 * Wire layout (field numbers are documented with their evidence in
 * TECHNICAL_NOTES.md, "Note body block model"):
 *
 *   NoteStoreProto.2 Document .3 Note
 *     Note.2  note_text (UTF-8; run lengths count UTF-16 code units)
 *     Note.5  AttributeRun (repeated)
 *       1 length · 2 ParagraphStyle · 3 Font · 5 font weight · 6 underline
 *       7 strikethrough · 8 baseline (signed: >0 super, <0 sub) · 9 link
 *       10 Color (four fixed32 floats) · 12 AttachmentInfo · 14 emphasis style
 *     ParagraphStyle
 *       1 style type · 2 alignment · 4 indent · 5 Checklist {1 uuid, 2 done}
 *       8 block quote · 9 paragraph UUID (16 bytes)
 *
 * Fields present in real notes whose meaning is not confirmed (AttributeRun 13
 * and 15, ParagraphStyle 3 and 7, and any other number) are never interpreted.
 * Their field numbers are counted in `undecodedFields` so callers can see that
 * something was left out.
 *
 * This module never changes the legacy `parseRichNote` contract in
 * noteRichText.ts: its `revision` and `styleRuns` values feed write guards.
 *
 * @module utils/noteBlocks
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CodedError, type ErrorCode } from "./errorCodes.js";
import {
  decodeWireFields,
  fixed32Float,
  ProtobufDecodeError,
  signedVarint,
  type WireField,
} from "./protobuf.js";
import { checklistRunLineStart } from "./checklistRuns.js";

/** Paragraph style names. `unknown` carries the raw number in `styleType`. */
export type BlockStyle =
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "monospaced"
  | "bulleted"
  | "dashed"
  | "numbered"
  | "checklist"
  | "unknown";

/** Paragraph alignment. `unknown` carries the raw number in `alignmentValue`. */
export type BlockAlignment = "left" | "center" | "right" | "justify" | "unknown";

/** Emphasis highlight colors, by the value stored in AttributeRun field 14. */
export type HighlightName = "purple" | "pink" | "orange" | "mint" | "blue" | "unknown";

/** One inline run inside a block. Only attributes that are set are present. */
export interface InlineRun {
  /** Start offset in UTF-16 code units from the beginning of the note text. */
  start: number;
  /** Length in UTF-16 code units. Never includes the paragraph's newline. */
  length: number;
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  superscript?: true;
  subscript?: true;
  /** `#RRGGBB`, or `#RRGGBBAA` when the stored alpha is below 1. */
  color?: string;
  highlight?: HighlightName;
  /** Raw emphasis value, present only when `highlight` is `unknown`. */
  highlightValue?: number;
  /** Link destination exactly as stored. Not sanitized; check `linkSafe`. */
  link?: string;
  /**
   * True when `link` uses a scheme the rest of this server re-emits into HTML
   * (http, https, notes, applenotes, mailto). Anything else (tel:, sms:, a
   * javascript: URL) is reported as data only.
   */
  linkSafe?: boolean;
  font?: { name?: string; size?: number };
  attachment?: { id: string; uti: string };
}

/** An inline attachment (U+FFFC) in body order. */
export interface AttachmentMarker {
  /** ZIDENTIFIER of the attachment object. */
  id: string;
  /** Uniform type identifier stored in the run, or "unknown". */
  uti: string;
  /** UTF-16 offset of the attachment character in the note text. */
  start: number;
  /** Index of the block that contains it. */
  blockIndex: number;
}

/** One paragraph of the note. */
export interface NoteBlock {
  index: number;
  /** UTF-16 offset of the first character in the note text. */
  start: number;
  /** UTF-16 length, excluding the terminating newline. */
  length: number;
  text: string;
  style: BlockStyle;
  /** Raw ParagraphStyle field 1, or null when the paragraph has none (body). */
  styleType: number | null;
  indent: number;
  alignment: BlockAlignment;
  /** Raw alignment value, present only when `alignment` is `unknown`. */
  alignmentValue?: number;
  blockQuote: boolean;
  /** Checklist identity (hex, same format as get-native-objects) and state. */
  checklist?: { id: string; done: boolean };
  /**
   * UUID stored in the paragraph's style (ParagraphStyle field 9), formatted
   * as an uppercase canonical UUID. It is not guaranteed unique: Notes copies
   * it when a paragraph is split, so adjacent paragraphs often share one.
   */
  paragraphUuid?: string;
  runs: InlineRun[];
  attachments: AttachmentMarker[];
}

/** Aggregate counts, useful for summaries and verification. */
export interface NoteBlocksSummary {
  blocks: number;
  styles: Partial<Record<BlockStyle, number>>;
  alignments: Partial<Record<BlockAlignment, number>>;
  blockQuotes: number;
  indented: number;
  checklist: { total: number; done: number };
  inline: Record<
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "superscript"
    | "subscript"
    | "color"
    | "highlight"
    | "link"
    | "unsafeLink",
    number
  >;
  attachments: number;
}

/** The decoded body of one note. */
export interface NoteBlocksDocument {
  text: string;
  /** Note text length in UTF-16 code units. */
  textLength: number;
  blocks: NoteBlock[];
  attachments: AttachmentMarker[];
  /**
   * Field numbers seen in the note but deliberately not interpreted, with how
   * many attribute runs carried each. Keys are field numbers.
   */
  undecodedFields: {
    attributeRun: Record<string, number>;
    paragraphStyle: Record<string, number>;
  };
  summary: NoteBlocksSummary;
}

/** Stable error classes for decode and read failures. */
export type NoteBlocksErrorCode =
  | "invalid-id"
  | "no-full-disk-access"
  | "not-found"
  | "no-body"
  | "encrypted"
  | "decompress-failed"
  | "malformed-protobuf"
  | "unsupported-structure"
  | "invalid-runs"
  | "query-failed";

/**
 * The shared error code for each reader failure. Decoding failures are
 * `unsupported`: the stored body is in a form this reader cannot decode, and
 * retrying will not change that.
 */
export const NOTE_BLOCKS_ERROR_CODES: Record<NoteBlocksErrorCode, ErrorCode> = {
  "invalid-id": "validation_error",
  "no-full-disk-access": "full_disk_access_missing",
  "not-found": "not_found",
  "no-body": "operation_failed",
  encrypted: "unsupported",
  "decompress-failed": "unsupported",
  "malformed-protobuf": "unsupported",
  "unsupported-structure": "unsupported",
  "invalid-runs": "unsupported",
  "query-failed": "operation_failed",
};

/** A reader failure. Its envelope carries the shared code for its reader code. */
export class NoteBlocksError extends CodedError {
  readonly code: NoteBlocksErrorCode;
  constructor(code: NoteBlocksErrorCode, message: string) {
    super(message, { code: NOTE_BLOCKS_ERROR_CODES[code] });
    this.name = "NoteBlocksError";
    this.code = code;
  }
}

const STYLE_NAMES: Record<number, BlockStyle> = {
  0: "title",
  1: "heading",
  2: "subheading",
  4: "monospaced",
  100: "bulleted",
  101: "dashed",
  102: "numbered",
  103: "checklist",
};
const ALIGNMENTS: Record<number, BlockAlignment> = {
  0: "left",
  1: "center",
  2: "right",
  3: "justify",
};
const HIGHLIGHTS: Record<number, HighlightName> = {
  1: "purple",
  2: "pink",
  3: "orange",
  4: "mint",
  5: "blue",
};
/** AttributeRun / ParagraphStyle fields this module interprets. */
const KNOWN_RUN_FIELDS = new Set([1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 14]);
const KNOWN_PARAGRAPH_FIELDS = new Set([1, 2, 4, 5, 8, 9]);

/** Same allowlist noteRichText.ts uses before re-emitting a link into HTML. */
export const isSafeLink = (url: string): boolean =>
  /^(?:https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url) &&
  !Array.from(url).some((char) => char.charCodeAt(0) < 32);

// ignoreBOM keeps a leading U+FEFF in the text, so its length still matches
// the attribute runs (Notes counts it as a character).
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const first = (fields: WireField[], n: number) => fields.find((f) => f.fieldNumber === n);
const varintOf = (fields: WireField[], n: number): number | undefined => {
  const f = first(fields, n);
  return f?.wireType === 0 && f.varint !== undefined ? signedVarint(f.varint) : undefined;
};
const bytesOf = (fields: WireField[], n: number): Uint8Array | undefined => {
  const f = first(fields, n);
  return f?.wireType === 2 ? f.bytes : undefined;
};
const stringOf = (fields: WireField[], n: number): string | undefined => {
  const b = bytesOf(fields, n);
  return b ? utf8.decode(b) : undefined;
};
const sub = (fields: WireField[], n: number): WireField[] | undefined => {
  const b = bytesOf(fields, n);
  return b ? decodeWireFields(b) : undefined;
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const uuidString = (bytes: Uint8Array) => {
  const h = hex(bytes).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const channel = (value: number | undefined) =>
  Math.max(0, Math.min(255, Math.round((Number.isFinite(value) ? value! : 0) * 255)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");

function colorOf(fields: WireField[]): string | undefined {
  const [r, g, b, a] = [1, 2, 3, 4].map((n) => fixed32Float(first(fields, n)));
  if (r === undefined && g === undefined && b === undefined) return undefined;
  const rgb = `#${channel(r)}${channel(g)}${channel(b)}`;
  return a === undefined || a >= 0.999 ? rgb : `${rgb}${channel(a)}`;
}

interface ParagraphAttrs {
  styleType: number | null;
  alignmentValue: number;
  indent: number;
  blockQuote: boolean;
  checklist?: { id: string; done: boolean };
  paragraphUuid?: string;
}
type InlineAttrs = Omit<InlineRun, "start" | "length" | "text">;
interface DecodedRun {
  start: number;
  length: number;
  paragraph: ParagraphAttrs;
  inline: InlineAttrs;
}

const DEFAULT_PARAGRAPH: ParagraphAttrs = {
  styleType: null,
  alignmentValue: 0,
  indent: 0,
  blockQuote: false,
};

function decodeParagraph(fields: WireField[] | undefined, tally: Map<number, number>) {
  if (!fields) return DEFAULT_PARAGRAPH;
  for (const n of new Set(fields.map((f) => f.fieldNumber)))
    if (!KNOWN_PARAGRAPH_FIELDS.has(n)) tally.set(n, (tally.get(n) || 0) + 1);
  const attrs: ParagraphAttrs = {
    styleType: varintOf(fields, 1) ?? null,
    alignmentValue: varintOf(fields, 2) ?? 0,
    indent: Math.max(0, varintOf(fields, 4) ?? 0),
    blockQuote: (varintOf(fields, 8) ?? 0) !== 0,
  };
  // ParagraphStyle.style_type defaults to -1 in the public proto: same as absent.
  if (attrs.styleType === -1) attrs.styleType = null;
  const checklist = sub(fields, 5);
  const checklistId = checklist && bytesOf(checklist, 1);
  if (attrs.styleType === 103 && checklistId)
    attrs.checklist = { id: hex(checklistId), done: varintOf(checklist!, 2) === 1 };
  const uuid = bytesOf(fields, 9);
  if (uuid?.length === 16) attrs.paragraphUuid = uuidString(uuid);
  return attrs;
}

function decodeInline(fields: WireField[]): InlineAttrs {
  const inline: InlineAttrs = {};
  const font = sub(fields, 3);
  const hints = font ? (varintOf(font, 3) ?? 0) : 0;
  const weight = varintOf(fields, 5) ?? 0;
  if (weight === 1 || weight === 3 || hints & 1) inline.bold = true;
  if (weight === 2 || weight === 3 || hints & 2) inline.italic = true;
  if (varintOf(fields, 6)) inline.underline = true;
  if (varintOf(fields, 7)) inline.strikethrough = true;
  const baseline = varintOf(fields, 8) ?? 0;
  if (baseline > 0) inline.superscript = true;
  if (baseline < 0) inline.subscript = true;
  const color = sub(fields, 10);
  const colorValue = color && colorOf(color);
  if (colorValue) inline.color = colorValue;
  const emphasis = varintOf(fields, 14);
  if (emphasis !== undefined && emphasis !== 0) {
    inline.highlight = HIGHLIGHTS[emphasis] ?? "unknown";
    if (inline.highlight === "unknown") inline.highlightValue = emphasis;
  }
  const link = stringOf(fields, 9);
  if (link) {
    inline.link = link;
    inline.linkSafe = isSafeLink(link);
  }
  if (font) {
    const name = stringOf(font, 1);
    const size = fixed32Float(first(font, 2));
    if (name || size !== undefined)
      inline.font = {
        ...(name ? { name } : {}),
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
      };
  }
  const attachment = sub(fields, 12);
  const attachmentId = attachment && stringOf(attachment, 1);
  if (attachmentId)
    inline.attachment = { id: attachmentId, uti: stringOf(attachment!, 2) || "unknown" };
  return inline;
}

function wrap(error: unknown): never {
  if (error instanceof NoteBlocksError) throw error;
  if (error instanceof ProtobufDecodeError)
    throw new NoteBlocksError("malformed-protobuf", error.message);
  throw error;
}

/**
 * Decode an uncompressed Notes document protobuf into typed blocks.
 *
 * Throws {@link NoteBlocksError} with a stable `code` on malformed input.
 * Unlike `parseRichNote`, a link with an unexpected scheme is not an error.
 */
export function decodeNoteBlocks(data: Uint8Array): NoteBlocksDocument {
  let note: WireField[] | undefined;
  try {
    const document = sub(decodeWireFields(data), 2);
    note = document && sub(document, 3);
  } catch (error) {
    wrap(error);
  }
  const textBytes = note && bytesOf(note, 2);
  if (!note || !textBytes)
    throw new NoteBlocksError("unsupported-structure", "Unsupported Notes document structure");
  const text = utf8.decode(textBytes);

  const runTally = new Map<number, number>();
  const paragraphTally = new Map<number, number>();
  const runs: DecodedRun[] = [];
  let position = 0;
  try {
    for (const field of note.filter((f) => f.fieldNumber === 5)) {
      if (field.wireType !== 2 || !field.bytes)
        throw new NoteBlocksError("invalid-runs", "Invalid Notes attribute run");
      const fields = decodeWireFields(field.bytes);
      const length = varintOf(fields, 1);
      if (length === undefined || length < 0 || position + length > text.length)
        throw new NoteBlocksError("invalid-runs", "Invalid Notes run length");
      for (const n of new Set(fields.map((f) => f.fieldNumber)))
        if (!KNOWN_RUN_FIELDS.has(n)) runTally.set(n, (runTally.get(n) || 0) + 1);
      runs.push({
        start: position,
        length,
        paragraph: decodeParagraph(sub(fields, 2), paragraphTally),
        inline: decodeInline(fields),
      });
      position += length;
    }
  } catch (error) {
    wrap(error);
  }
  if (position !== text.length)
    throw new NoteBlocksError("invalid-runs", "Incomplete Notes attribute runs");

  const blocks: NoteBlock[] = [];
  const attachments: AttachmentMarker[] = [];
  let runIndex = 0;
  let paragraphStart = 0;
  while (paragraphStart < text.length) {
    const newline = text.indexOf("\n", paragraphStart);
    const end = newline === -1 ? text.length : newline;
    while (
      runIndex < runs.length - 1 &&
      runs[runIndex].start + runs[runIndex].length <= paragraphStart
    )
      runIndex++;
    // Paragraph attributes come from the run covering the paragraph's first
    // character (the newline itself for an empty paragraph). In the verified
    // library every run of a paragraph carried the same visual style. A
    // checklist run that starts on an empty paragraph's newline belongs to the
    // next line (the macOS 27.2 "\nItem" layout, see checklistRunLineStart);
    // Notes renders the empty paragraph as plain body text, so it must not
    // become a second block with the same checklist item.
    const covering = runs[runIndex];
    const attrs = !covering
      ? DEFAULT_PARAGRAPH
      : covering.paragraph.styleType === 103 &&
          checklistRunLineStart(text, covering.start, covering.length) > paragraphStart
        ? DEFAULT_PARAGRAPH
        : covering.paragraph;
    const style: BlockStyle =
      attrs.styleType === null ? "body" : (STYLE_NAMES[attrs.styleType] ?? "unknown");
    const alignment = ALIGNMENTS[attrs.alignmentValue] ?? "unknown";
    const block: NoteBlock = {
      index: blocks.length,
      start: paragraphStart,
      length: end - paragraphStart,
      text: text.slice(paragraphStart, end),
      style,
      styleType: attrs.styleType,
      indent: attrs.indent,
      alignment,
      ...(alignment === "unknown" ? { alignmentValue: attrs.alignmentValue } : {}),
      blockQuote: attrs.blockQuote,
      ...(attrs.checklist ? { checklist: attrs.checklist } : {}),
      ...(attrs.paragraphUuid ? { paragraphUuid: attrs.paragraphUuid } : {}),
      runs: [],
      attachments: [],
    };
    for (let i = runIndex; i < runs.length && runs[i].start < end; i++) {
      const run = runs[i];
      const start = Math.max(run.start, paragraphStart);
      const stop = Math.min(run.start + run.length, end);
      if (stop <= start) continue;
      block.runs.push({
        start,
        length: stop - start,
        text: text.slice(start, stop),
        ...run.inline,
      });
      if (run.inline.attachment)
        for (
          let at = text.indexOf("\ufffc", start);
          at !== -1 && at < stop;
          at = text.indexOf("\ufffc", at + 1)
        ) {
          const marker = { ...run.inline.attachment, start: at, blockIndex: block.index };
          block.attachments.push(marker);
          attachments.push(marker);
        }
    }
    blocks.push(block);
    paragraphStart = end + 1;
  }

  return {
    text,
    textLength: text.length,
    blocks,
    attachments,
    undecodedFields: {
      attributeRun: Object.fromEntries([...runTally].sort((a, b) => a[0] - b[0])),
      paragraphStyle: Object.fromEntries([...paragraphTally].sort((a, b) => a[0] - b[0])),
    },
    summary: summarize(blocks, attachments),
  };
}

/** Count blocks, styles and inline attributes. */
export function summarize(blocks: NoteBlock[], attachments: AttachmentMarker[]): NoteBlocksSummary {
  const summary: NoteBlocksSummary = {
    blocks: blocks.length,
    styles: {},
    alignments: {},
    blockQuotes: 0,
    indented: 0,
    checklist: { total: 0, done: 0 },
    inline: {
      bold: 0,
      italic: 0,
      underline: 0,
      strikethrough: 0,
      superscript: 0,
      subscript: 0,
      color: 0,
      highlight: 0,
      link: 0,
      unsafeLink: 0,
    },
    attachments: attachments.length,
  };
  for (const block of blocks) {
    summary.styles[block.style] = (summary.styles[block.style] || 0) + 1;
    summary.alignments[block.alignment] = (summary.alignments[block.alignment] || 0) + 1;
    if (block.blockQuote) summary.blockQuotes++;
    if (block.indent > 0) summary.indented++;
    if (block.checklist) {
      summary.checklist.total++;
      if (block.checklist.done) summary.checklist.done++;
    }
    for (const run of block.runs) {
      for (const key of [
        "bold",
        "italic",
        "underline",
        "strikethrough",
        "superscript",
        "subscript",
        "color",
        "highlight",
        "link",
      ] as const)
        if (run[key]) summary.inline[key]++;
      if (run.link && !run.linkSafe) summary.inline.unsafeLink++;
    }
  }
  return summary;
}

/** Decompress a `ZICNOTEDATA.ZDATA` blob and decode it into blocks. */
export function decodeCompressedNoteBlocks(compressed: Uint8Array): NoteBlocksDocument {
  let data: Uint8Array;
  try {
    data = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
  } catch (error) {
    throw new NoteBlocksError(
      "decompress-failed",
      `Failed to decompress note data: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return decodeNoteBlocks(data);
}

/**
 * Default ceiling on the serialized blocks in one get-note-blocks response:
 * 4 MiB, well under the 10 MiB per-message limit of the MCP SDK stdio reader.
 */
const DEFAULT_BLOCKS_MAX_BYTES = 4 * 1024 * 1024;

/** APPLE_NOTES_MCP_BLOCKS_MAX_BYTES when it is a positive number, else 4 MiB. */
export function blocksMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_NOTES_MCP_BLOCKS_MAX_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_BLOCKS_MAX_BYTES;
}

/** One page of a decoded note, bounded by block count and serialized size. */
export interface NoteBlocksPage {
  textLength: number;
  blocks: Array<NoteBlock & { textOmitted?: true }>;
  page: { offset: number; returned: number; total: number; hasMore: boolean; nextOffset?: number };
  /** Counts for the whole note, not only this page. */
  summary: NoteBlocksSummary;
  undecodedFields: NoteBlocksDocument["undecodedFields"];
}

/**
 * Slice a decoded note into a page of whole blocks. The page stops early once
 * adding a block would exceed `maxBytes` of JSON. A single block that is too
 * large on its own is returned with its text removed and `textOmitted: true`,
 * so paging always advances.
 */
export function pageNoteBlocks(
  doc: NoteBlocksDocument,
  { offset = 0, limit = 500, maxBytes = blocksMaxResponseBytes() } = {}
): NoteBlocksPage {
  const total = doc.blocks.length;
  const start = Math.min(Math.max(0, offset), total);
  const blocks: NoteBlocksPage["blocks"] = [];
  let bytes = 0;
  for (let i = start; i < total && blocks.length < limit; i++) {
    let block: NoteBlocksPage["blocks"][number] = doc.blocks[i];
    let size = Buffer.byteLength(JSON.stringify(block));
    if (bytes + size > maxBytes) {
      if (blocks.length) break;
      block = {
        ...block,
        text: "",
        textOmitted: true,
        runs: block.runs.map((run) => ({ ...run, text: "" })),
      };
      size = Buffer.byteLength(JSON.stringify(block));
    }
    blocks.push(block);
    bytes += size;
  }
  const next = start + blocks.length;
  return {
    textLength: doc.textLength,
    blocks,
    page: {
      offset: start,
      returned: blocks.length,
      total,
      hasMore: next < total,
      ...(next < total ? { nextOffset: next } : {}),
    },
    summary: doc.summary,
    undecodedFields: doc.undecodedFields,
  };
}

const NOTES_DB_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/**
 * Read one note's body from the NoteStore database (read-only) and decode it.
 *
 * The note's primary key is bound as a sqlite3 parameter, never spliced into
 * SQL text. Locked (encrypted) notes are refused with code `encrypted`.
 * `dbPath` exists for tests against a fixture database.
 */
export function readNoteBlocks(
  id: string,
  { dbPath = NOTES_DB_PATH }: { dbPath?: string } = {}
): NoteBlocksDocument {
  const pk = /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p([0-9]{1,18})$/i.exec(id)?.[1];
  if (!pk)
    throw new NoteBlocksError(
      "invalid-id",
      `Invalid note ID: expected x-coredata://<store>/ICNote/p<number>`
    );
  if (!existsSync(dbPath))
    throw new NoteBlocksError("no-full-disk-access", "The Notes database is not readable");
  const sql =
    "SELECT json_object(" +
    "'exists', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = @pk " +
    "AND Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')), " +
    "'data', (SELECT hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE = @pk), " +
    "'encrypted', (SELECT ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL FROM ZICNOTEDATA WHERE ZNOTE = @pk));";
  let output: string;
  try {
    output = execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-cmd", ".parameter init", "-cmd", `.parameter set @pk ${pk}`, dbPath, sql],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message))
      throw new NoteBlocksError("no-full-disk-access", "The Notes database is not readable");
    throw new NoteBlocksError("query-failed", "Failed to query the Notes database");
  }
  let row: { exists?: number; data?: string | null; encrypted?: number | null };
  try {
    row = JSON.parse(output);
  } catch {
    throw new NoteBlocksError("query-failed", "Unexpected Notes database response");
  }
  if (!row.exists) throw new NoteBlocksError("not-found", `No note found for ID "${id}"`);
  if (row.encrypted)
    throw new NoteBlocksError(
      "encrypted",
      "This note is password-protected; its body is encrypted and cannot be decoded"
    );
  if (!row.data || !/^[0-9a-f]+$/i.test(row.data))
    throw new NoteBlocksError("no-body", "No body data is stored for this note");
  return decodeCompressedNoteBlocks(Buffer.from(row.data, "hex"));
}
