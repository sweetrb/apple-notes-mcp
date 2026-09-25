/**
 * Structured compose through the opt-in private WRITER.
 *
 * Callers describe content as ordered blocks (headings, paragraphs with
 * inline runs, lists, checklists, quotes, monospaced text) or as Markdown.
 * This module validates that input, flattens it to the writer's wire format
 * (one entry per Notes paragraph: a style name, indent, block-quote flag,
 * checklist state, and inline runs), and sends the writer's `compose_note`
 * action (services/privateWriter.ts), which follows the writer's write
 * contract: both switches, the `ifRevision` compare-and-swap, a save with
 * optimistic locking, and a fresh read-only read-back.
 *
 * The writer inserts the whole unit through the note's CRDT in one save,
 * guarded by the `ifRevision` compare-and-swap token, and verifies every
 * paragraph's style, checklist state, and runs in a fresh Core Data stack.
 *
 * @module services/privateCompose
 */
import { basename, extname, isAbsolute } from "node:path";
import { z } from "zod";
import {
  COMPOSE_LIVE_VALIDATED,
  PrivateWriteError,
  assertNoteIdentifier,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  writeSyncFields,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { assertAllowedFile } from "../utils/attachmentFs.js";
import { readNoteBlocks, type NoteBlock, type NoteBlocksDocument } from "../utils/noteBlocks.js";
import { parseNotesShowUrl } from "../utils/noteLinks.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

export const HIGHLIGHTS = ["purple", "pink", "orange", "mint", "blue"] as const;
export const MAX_INDENT = 8;
export const MAX_PARAGRAPHS = 2000;
export const MAX_COMPOSE_UTF16 = 200_000;
/** The writer's run limit per request. */
export const MAX_COMPOSE_RUNS = 20_000;
/** The writer refuses a request larger than this (its stdin cap). */
export const MAX_WRITER_REQUEST_BYTES = 1024 * 1024;
export const MAX_TABLE_CELL_UTF16 = 10_000;
/** File and link-card blocks per request, and the writer's file size limits. */
export const MAX_COMPOSE_ATTACHMENTS = 20;
export const MAX_COMPOSE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_COMPOSE_FILE_TOTAL = 128 * 1024 * 1024;
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "notes:", "applenotes:"]);

/** Paragraph styles the writer writes. The title style is never written. */
export type WireStyle =
  | "heading"
  | "subheading"
  | "body"
  | "monospaced"
  | "bulleted"
  | "dashed"
  | "numbered"
  | "checklist";

export interface WireRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: string;
  highlight?: (typeof HIGHLIGHTS)[number];
  color?: string;
}

export interface WireParagraph {
  style: WireStyle;
  indent?: number;
  blockQuote?: boolean;
  checked?: boolean;
  /** Empty only for a blank line that is not the last paragraph. */
  runs: WireRun[];
}

/**
 * A block object: one attachment glyph on its own line. `file` names a local
 * file the writer reads and attaches; `url` is a link card.
 */
export type WireObject =
  | { kind: "divider" }
  | { kind: "table"; rows: string[][] }
  | { kind: "file"; path: string; filename?: string }
  | { kind: "url"; url: string };

/** One entry of the writer's `paragraphs` array. */
export type WireEntry = WireParagraph | WireObject;

export const isObject = (entry: WireEntry): entry is WireObject => "kind" in entry;

export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 100;
export const MAX_TABLE_CELLS = 10_000;
const NOTE_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// ---------------------------------------------------------------------------
// Block schema (the public input)
// ---------------------------------------------------------------------------

export const runSchema = z
  .object({
    text: z.string().min(1),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    link: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("http(s), mailto, tel, notes, applenotes"),
    highlight: z.enum(HIGHLIGHTS).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional()
      .describe("Text color as #RRGGBB"),
  })
  .strict();

const indentSchema = z.number().int().min(0).max(MAX_INDENT);
const inlineShape = {
  text: z.string().optional().describe("Plain text; each \\n starts a new paragraph"),
  runs: z.array(runSchema).min(1).optional().describe("Formatted runs forming one paragraph"),
};

const textBlock = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), ...inlineShape }).strict();

const listItem = z.union([
  z.string().min(1),
  z.object({ ...inlineShape, indent: indentSchema.optional() }).strict(),
]);
const checklistItem = z.union([
  z.string().min(1),
  z
    .object({ ...inlineShape, indent: indentSchema.optional(), checked: z.boolean().optional() })
    .strict(),
]);
const listBlock = <T extends string>(type: T) =>
  z
    .object({
      type: z.literal(type),
      items: z.array(listItem).min(1),
      indent: indentSchema.optional().describe("Base indent added to every item"),
    })
    .strict();

export const blockSchema = z.discriminatedUnion("type", [
  textBlock("heading"),
  textBlock("subheading"),
  textBlock("body"),
  textBlock("paragraph"),
  textBlock("quote"),
  textBlock("code"),
  textBlock("monospaced"),
  listBlock("bulleted"),
  listBlock("dashed"),
  listBlock("numbered"),
  z
    .object({
      type: z.literal("checklist"),
      items: z.array(checklistItem).min(1),
      checked: z.array(z.boolean()).optional().describe("Per-item state, same length as items"),
      indent: indentSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z
    .object({
      type: z.literal("table"),
      rows: z
        .array(z.array(z.string()).min(1).max(MAX_TABLE_COLUMNS))
        .min(1)
        .max(MAX_TABLE_ROWS)
        .describe("Rectangular rows of plain-text cells; the first row is not special"),
    })
    .strict(),
  z
    .object({
      type: z.literal("noteLink"),
      identifier: z.string().regex(NOTE_UUID).describe("Notes UUID of the note to link to"),
      text: z.string().min(1).describe("Link text"),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      path: z.string().min(1).max(4096).describe("Absolute path of a local file to attach"),
      filename: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe("Name the attachment gets in Notes; must keep the source file's extension"),
    })
    .strict(),
  z
    .object({
      type: z.literal("urlCard"),
      url: z.string().min(1).max(2048).describe("Absolute http(s) URL shown as a rich link card"),
    })
    .strict(),
]);
export type ComposeBlock = z.infer<typeof blockSchema>;

// ---------------------------------------------------------------------------
// Validation and flattening
// ---------------------------------------------------------------------------

function invalid(message: string): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, false);
}

/**
 * Control characters other than tab, the attachment glyph U+FFFC, and the
 * Unicode line and paragraph separators. Newlines are handled by the caller.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0A-\x1F\x7F-\x9F\uFFFC\u2028\u2029]/u;

function assertLine(text: string, where: string): void {
  if (FORBIDDEN.test(text))
    throw invalid(
      `${where}: text may contain only printable characters and tabs (no \\r, control ` +
        "characters, or attachment glyphs); a newline is allowed only in a block's `text`"
    );
}

/**
 * Characters a URL may hold unencoded (RFC 3986 reserved and unreserved, plus
 * `%`). The writer refuses a link that its URL parser would re-encode, since
 * the stored link would then differ from the request.
 */
const URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

function assertLink(link: string): void {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw invalid(`Run link is not an absolute URL: ${link}`);
  }
  if (!LINK_SCHEMES.has(url.protocol))
    throw invalid("Run link must use http, https, mailto, tel, notes, or applenotes");
  if (!URL_CHARACTERS.test(link))
    throw invalid(
      "Run link must already be a well-formed URL: percent-encode spaces, quotes, and non-ASCII characters"
    );
}

/** add_url_card's rules: absolute http(s) with a host, no characters to re-encode. */
function assertCardUrl(value: string, where: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`${where}: url is not an absolute URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname)
    throw invalid(`${where}: url must be an absolute http or https URL with a host`);
  if (!URL_CHARACTERS.test(value))
    throw invalid(
      `${where}: url must already be well-formed (percent-encode spaces, quotes, and non-ASCII characters)`
    );
}

/**
 * add-attachment's name rules: one path component of at most 255 UTF-8
 * bytes, no slash, colon, backslash, control character, leading dot, or
 * surrounding spaces, keeping the source file's extension.
 */
function assertAttachmentName(path: string, filename: string | undefined, where: string): void {
  if (filename === undefined) return;
  if (
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename !== filename.trim() ||
    filename.startsWith(".") ||
    /[/:\\\p{Cc}]/u.test(filename) ||
    FORBIDDEN.test(filename)
  )
    throw invalid(
      `${where}: filename must be one path component with no slash, colon, backslash, control character, leading dot, or surrounding spaces`
    );
  if (extname(filename).toLowerCase() !== extname(basename(path)).toLowerCase())
    throw invalid(`${where}: filename must keep the source file's extension`);
}

/**
 * The writer reads the file itself; this checks it first under the same policy
 * as add-attachment's path (see readAllowedFile: a nonempty regular file of at
 * most 64 MiB in home, temp or /Volumes, not a symbolic link or a FIFO, and
 * not a hidden path or ~/Library outside iCloud Drive and CloudStorage unless
 * APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1), so a prompt cannot put
 * ~/.ssh/id_ed25519 into a synced note and a bad path is refused before
 * anything is created. Returns its size.
 */
export function composeFileSize(path: string, where = "file", roots?: string[]): number {
  if (!isAbsolute(path) || FORBIDDEN.test(path))
    throw invalid(`${where}: path must be an absolute path`);
  try {
    return assertAllowedFile(path, MAX_COMPOSE_FILE_BYTES, {
      ...(roots ? { roots } : {}),
      label: "File",
    });
  } catch (error) {
    throw invalid(`${where}: ${(error as Error).message}`);
  }
}

function wireRun(run: z.infer<typeof runSchema>, where: string): WireRun {
  assertLine(run.text, where);
  if (run.link) assertLink(run.link);
  const out: WireRun = { text: run.text };
  for (const key of ["bold", "italic", "underline", "strikethrough"] as const)
    if (run[key]) out[key] = true;
  if (run.link) out.link = run.link;
  if (run.highlight) out.highlight = run.highlight;
  if (run.color) out.color = run.color.toUpperCase();
  return out;
}

/** `text` (split on \n) or `runs` (one paragraph), never both, never neither. */
function inlineLines(
  value: { text?: string; runs?: Array<z.infer<typeof runSchema>> },
  where: string,
  allowNewlines: boolean
): WireRun[][] {
  if ((value.text === undefined) === (value.runs === undefined))
    throw invalid(`${where}: give exactly one of text or runs`);
  if (value.runs) return [value.runs.map((run) => wireRun(run, where))];
  const text = value.text as string;
  if (!text.length) throw invalid(`${where}: text must not be empty`);
  const lines = text.split("\n");
  if (lines.length > 1 && !allowNewlines)
    throw invalid(`${where}: list and checklist items are one line each`);
  return lines.map((line) => {
    assertLine(line, where);
    return line ? [{ text: line }] : [];
  });
}

function itemFields(
  item: string | { text?: string; runs?: Array<z.infer<typeof runSchema>>; indent?: number },
  where: string
): { runs: WireRun[]; indent: number } {
  if (typeof item === "string")
    return { runs: inlineLines({ text: item }, where, false)[0], indent: 0 };
  return { runs: inlineLines(item, where, false)[0], indent: item.indent ?? 0 };
}

const TEXT_STYLES: Record<string, { style: WireStyle; blockQuote?: boolean }> = {
  heading: { style: "heading" },
  subheading: { style: "subheading" },
  body: { style: "body" },
  paragraph: { style: "body" },
  quote: { style: "body", blockQuote: true },
  code: { style: "monospaced" },
  monospaced: { style: "monospaced" },
};

/**
 * Validate blocks and flatten them to one wire paragraph per Notes paragraph.
 * Throws `invalid_request` (committed: false) before anything is sent.
 */
export function blocksToParagraphs(input: unknown): WireEntry[] {
  const parsed = z.array(blockSchema).min(1).safeParse(input);
  if (!parsed.success)
    throw invalid(
      "Invalid blocks: " +
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")
    );
  const out: WireEntry[] = [];
  parsed.data.forEach((block, index) => {
    const where = `blocks[${index}] (${block.type})`;
    if (block.type === "divider") {
      out.push({ kind: "divider" });
      return;
    }
    if (block.type === "table") {
      const columns = block.rows[0].length;
      if (block.rows.some((row) => row.length !== columns))
        throw invalid(`${where}: every row needs the same number of cells`);
      if (block.rows.length * columns > MAX_TABLE_CELLS)
        throw invalid(`${where}: a table may have at most ${MAX_TABLE_CELLS} cells`);
      block.rows.forEach((row, r) =>
        row.forEach((cell, c) => {
          if (cell.length > MAX_TABLE_CELL_UTF16)
            throw invalid(
              `${where}.rows[${r}][${c}]: a cell may hold at most ${MAX_TABLE_CELL_UTF16} UTF-16 code units`
            );
          if (cell) assertLine(cell, `${where}.rows[${r}][${c}]`);
        })
      );
      out.push({ kind: "table", rows: block.rows });
      return;
    }
    if (block.type === "file") {
      assertAttachmentName(block.path, block.filename, where);
      composeFileSize(block.path, where);
      out.push({
        kind: "file",
        path: block.path,
        ...(block.filename !== undefined ? { filename: block.filename } : {}),
      });
      return;
    }
    if (block.type === "urlCard") {
      assertCardUrl(block.url, where);
      out.push({ kind: "url", url: block.url });
      return;
    }
    if (block.type === "noteLink") {
      assertLine(block.text, where);
      out.push({
        style: "body",
        runs: [{ text: block.text, link: noteLinkUrl(block.identifier) }],
      });
      return;
    }
    if (block.type in TEXT_STYLES) {
      const { style, blockQuote } = TEXT_STYLES[block.type];
      const textBlock = block as { text?: string; runs?: Array<z.infer<typeof runSchema>> };
      for (const runs of inlineLines(textBlock, where, true))
        out.push({ style, ...(blockQuote ? { blockQuote } : {}), runs });
      return;
    }
    const list = block as Extract<ComposeBlock, { items: unknown }>;
    const base = list.indent ?? 0;
    if (list.type === "checklist") {
      const perItem = list.items.some((i) => typeof i !== "string" && i.checked !== undefined);
      if (list.checked && perItem)
        throw invalid(`${where}: give checked state per item or as a checked array, not both`);
      if (list.checked && list.checked.length !== list.items.length)
        throw invalid(`${where}: checked must have one boolean per item`);
      list.items.forEach((item, i) => {
        const { runs, indent } = itemFields(item, `${where}.items[${i}]`);
        const checked =
          typeof item !== "string" && item.checked !== undefined
            ? item.checked
            : (list.checked?.[i] ?? false);
        out.push(paragraph("checklist", runs, base + indent, where, checked));
      });
      return;
    }
    list.items.forEach((item, i) => {
      const { runs, indent } = itemFields(item, `${where}.items[${i}]`);
      out.push(paragraph(list.type as WireStyle, runs, base + indent, where));
    });
  });
  return finalizeParagraphs(out);
}

function paragraph(
  style: WireStyle,
  runs: WireRun[],
  indent: number,
  where: string,
  checked?: boolean
): WireParagraph {
  if (indent > MAX_INDENT) throw invalid(`${where}: indent exceeds ${MAX_INDENT}`);
  return {
    style,
    ...(indent ? { indent } : {}),
    ...(checked !== undefined ? { checked } : {}),
    runs,
  };
}

/** The notes:// deep link this server uses for note-to-note links. */
export function noteLinkUrl(identifier: string): string {
  return `notes://showNote?identifier=${identifier.toUpperCase()}`;
}

const isBlank = (entry: WireEntry | undefined) =>
  !!entry && !isObject(entry) && entry.runs.length === 0;

/** UTF-16 units an entry adds to the writer's budget: text, or table cell text. */
function entryUTF16(entry: WireEntry): number {
  if (!isObject(entry)) return entry.runs.reduce((n, r) => n + r.text.length, 0) + 1;
  if (entry.kind === "table")
    return 2 + entry.rows.reduce((n, row) => n + row.reduce((m, cell) => m + cell.length, 0), 0);
  return 2;
}

/**
 * Trim trailing blank paragraphs and enforce every writer size limit, so a
 * request the writer would refuse is refused here, before `create` makes a
 * note: paragraphs, UTF-16 units (table cell text included), runs, and the
 * number and total size of file and link-card blocks.
 */
function finalizeParagraphs(paragraphs: WireEntry[]): WireEntry[] {
  while (isBlank(paragraphs[paragraphs.length - 1])) paragraphs.pop();
  if (!paragraphs.length) throw invalid("The composed content is empty");
  if (paragraphs.length > MAX_PARAGRAPHS)
    throw invalid(`The composed content has more than ${MAX_PARAGRAPHS} paragraphs`);
  const length = paragraphs.reduce((sum, p) => sum + entryUTF16(p), 0);
  if (length > MAX_COMPOSE_UTF16)
    throw invalid(
      `The composed content (text and table cells) exceeds ${MAX_COMPOSE_UTF16} UTF-16 code units`
    );
  const runs = paragraphs.reduce((n, p) => n + (isObject(p) ? 0 : p.runs.length), 0);
  if (runs > MAX_COMPOSE_RUNS)
    throw invalid(`The composed content has more than ${MAX_COMPOSE_RUNS} runs`);
  const attachments = paragraphs.filter(
    (p) => isObject(p) && (p.kind === "file" || p.kind === "url")
  );
  if (attachments.length > MAX_COMPOSE_ATTACHMENTS)
    throw invalid(
      `A compose may hold at most ${MAX_COMPOSE_ATTACHMENTS} file and link-card blocks`
    );
  const bytes = attachments.reduce(
    (n, p) => n + (isObject(p) && p.kind === "file" ? composeFileSize(p.path) : 0),
    0
  );
  if (bytes > MAX_COMPOSE_FILE_TOTAL)
    throw invalid("The files in one compose may total at most 128 MiB");
  return paragraphs;
}

/**
 * Refuse a request the writer would refuse for size (its 1 MiB stdin cap)
 * before anything is sent or created. `fields` are the writer request fields;
 * pass placeholder identifier and revision values of the real length when the
 * real ones are not known yet.
 */
export function assertWriterRequestSize(fields: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(
    JSON.stringify({ protocol: 1, action: "compose_note", ...fields }),
    "utf8"
  );
  if (bytes > MAX_WRITER_REQUEST_BYTES)
    throw invalid(
      `The compose request is ${bytes} bytes; the writer accepts at most ${MAX_WRITER_REQUEST_BYTES}. Split it into several appends.`
    );
}

/**
 * Every Notes deep link (`notes:` or `applenotes:` scheme) in the wire
 * paragraphs, from noteLink blocks, runs, and Markdown links alike, with the
 * note UUID it targets (uppercased), or null when the link names no note.
 */
export function notesLinkTargets(
  paragraphs: WireEntry[]
): Array<{ link: string; target: string | null }> {
  const out: Array<{ link: string; target: string | null }> = [];
  for (const p of paragraphs) {
    if (isObject(p)) continue;
    for (const run of p.runs) {
      if (!run.link || !/^(?:apple)?notes:/i.test(run.link)) continue;
      out.push({ link: run.link, target: parseNotesShowUrl(run.link)?.targetNote ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown import
// ---------------------------------------------------------------------------

type RunStyle = Omit<WireRun, "text">;

const PAIRS: Array<{ open: string; close: string; style: RunStyle }> = [
  { open: "**", close: "**", style: { bold: true } },
  { open: "__", close: "__", style: { bold: true } },
  { open: "~~", close: "~~", style: { strikethrough: true } },
  { open: "<u>", close: "</u>", style: { underline: true } },
  { open: "*", close: "*", style: { italic: true } },
  { open: "_", close: "_", style: { italic: true } },
];

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|<]/;
const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Position of the closing delimiter for an emphasis span opened before `from`. */
function findClose(src: string, open: string, close: string, from: number): number {
  const single = open.length === 1;
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (single && src.startsWith(open + open, j)) {
      j++;
      continue;
    }
    if (!src.startsWith(close, j) || j === from || /\s/.test(src[j - 1])) continue;
    let end = j;
    // `***x***`: the bold span closes on the LAST two of the three stars.
    if (!single) while (src.startsWith(close, end + 1)) end++;
    if (open === "_" && isWord(src[end + 1])) continue;
    return end;
  }
  return -1;
}

/** Parse Markdown inline syntax into runs. Unmatched syntax stays literal. */
export function parseInline(src: string, base: RunStyle = {}): WireRun[] {
  const runs: WireRun[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...base });
    buffer = "";
  };
  let i = 0;
  outer: while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        buffer += src.slice(i + 1, end); // Notes has no inline code style
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m && safeLink(m[2])) {
        flush();
        runs.push(...parseInline(m[1], { ...base, link: m[2] }));
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?|mailto):[^\s>]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        runs.push({ text: m[1], ...base, link: m[1] });
        i += m[0].length;
        continue;
      }
    }
    for (const pair of PAIRS) {
      if (!src.startsWith(pair.open, i)) continue;
      const from = i + pair.open.length;
      if (/\s/.test(src[from] ?? " ")) continue;
      if (pair.open === "_" && isWord(src[i - 1])) continue;
      const end = findClose(src, pair.open, pair.close, from);
      if (end < 0) continue;
      flush();
      runs.push(...parseInline(src.slice(from, end), { ...base, ...pair.style }));
      i = end + pair.close.length;
      continue outer;
    }
    buffer += ch;
    i++;
  }
  flush();
  return mergeRuns(runs);
}

function safeLink(link: string): boolean {
  try {
    return LINK_SCHEMES.has(new URL(link).protocol);
  } catch {
    return false;
  }
}

const formatKey = (run: WireRun) => JSON.stringify({ ...run, text: undefined });

function mergeRuns(runs: WireRun[]): WireRun[] {
  const out: WireRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && formatKey(last) === formatKey(run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

export interface MarkdownImport {
  blocks: ComposeBlock[];
  warnings: string[];
}

const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;

/**
 * The column count of a GFM delimiter row (`| --- | :-: |`), or 0 when the
 * line is not one: it needs a pipe, and every cell is one or more dashes with
 * optional alignment colons.
 */
function separatorColumns(line: string): number {
  if (!line.includes("|")) return 0;
  const cells = rawCells(line);
  return cells.length && cells.every((cell) => /^:?-+:?$/.test(cell.trim())) ? cells.length : 0;
}

/** A GFM table row split on unescaped pipes, leading and trailing pipes dropped. */
function rawCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const body = line.trim().replace(/^\|/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cell);
      cell = "";
    } else cell += body[i];
  }
  if (cell.trim() || !body.endsWith("|")) cells.push(cell);
  return cells;
}

/** GFM table row cells as plain text (Notes table cells carry no runs here). */
function tableCells(line: string): string[] {
  return rawCells(line).map((c) =>
    parseInline(c.trim())
      .map((run) => run.text)
      .join("")
  );
}

/**
 * A line holding only a Markdown image. `![alt](/absolute/path)` becomes a
 * file block and `![alt](https://…)` a link card; the alt text is dropped,
 * since Notes attachments carry no caption. Anything else returns null.
 */
function imageBlock(line: string): ComposeBlock | null {
  const m = /^[ ]{0,3}!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)[ \t]*$/.exec(
    line
  );
  if (!m) return null;
  const target = m[1] ?? m[2];
  if (target.startsWith("/")) return { type: "file", path: target };
  if (/^https?:\/\//i.test(target)) return { type: "urlCard", url: target };
  return null;
}

function columns(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? 4 - (width % 4) : 1;
  return width;
}

/**
 * Convert Markdown to compose blocks: ATX headings (`#`/`##` to Heading,
 * `###`+ to Subheading), paragraphs (soft line breaks join with a space),
 * `>` quotes, fenced code, bulleted/numbered lists and `- [ ]`/`- [x]`
 * checklists with nesting, and inline bold, italic, strikethrough, `<u>`
 * underline, code spans (as plain text), and links. Horizontal rules become
 * native dividers and GFM pipe tables become native tables (cells as plain
 * text; the delimiter row's alignment is not kept). Raw HTML blocks are
 * skipped with a warning.
 *
 * @param dropTitle - drop a leading `# ` heading equal to this note title
 */
export function markdownToBlocks(markdown: string, dropTitle?: string): MarkdownImport {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ComposeBlock[] = [];
  const warnings: string[] = [];
  let prose: string[] = [];
  let quote: string[] = [];
  let listStack: number[] = [];

  const pushText = (type: "body" | "quote" | "heading" | "subheading", text: string) => {
    const runs = parseInline(text);
    if (runs.length) blocks.push({ type, runs });
  };
  const flushProse = () => {
    if (prose.length) pushText("body", prose.join(" "));
    prose = [];
  };
  const flushQuote = () => {
    if (quote.length) pushText("quote", quote.join(" "));
    quote = [];
  };
  const flushAll = () => {
    flushProse();
    flushQuote();
  };

  // Adjacent items of one kind share a block; the paragraphs are the same
  // either way, since each item is its own Notes paragraph.
  const addItem = (
    kind: "bulleted" | "numbered" | "checklist",
    level: number,
    text: string,
    checked: boolean
  ) => {
    const runs = parseInline(text);
    if (!runs.length) return;
    const item = kind === "checklist" ? { runs, indent: level, checked } : { runs, indent: level };
    const last = blocks[blocks.length - 1];
    if (last && last.type === kind) (last.items as unknown[]).push(item);
    else blocks.push({ type: kind, items: [item] } as ComposeBlock);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushAll();
      listStack = [];
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[1])) body.push(lines[j++]);
      i = j;
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (body.length) blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = /^[ ]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      flushAll();
      listStack = [];
      const text = heading[2];
      const isTitle = !blocks.length && heading[1] === "#" && text.trim() === dropTitle?.trim();
      if (!isTitle) pushText(heading[1].length <= 2 ? "heading" : "subheading", text);
      continue;
    }
    if (/^[ ]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) {
      flushAll();
      listStack = [];
      blocks.push({ type: "divider" });
      continue;
    }
    // A GFM table: a header row, then a delimiter row with the same number
    // of cells. Body rows are padded or cut to the header's width.
    if (line.includes("|") && separatorColumns(lines[i + 1] ?? "") === rawCells(line).length) {
      flushAll();
      listStack = [];
      const header = tableCells(line);
      const rows = [header];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) {
        const all = tableCells(lines[j]);
        if (all.length > header.length)
          warnings.push(
            `line ${j + 1}: table row has ${all.length} cells but the header has ${header.length}; the extra cells were dropped`
          );
        const cells = all.slice(0, header.length);
        rows.push([...cells, ...Array<string>(header.length - cells.length).fill("")]);
      }
      i = j - 1;
      blocks.push({ type: "table", rows });
      continue;
    }
    const image = imageBlock(line);
    if (image) {
      flushAll();
      listStack = [];
      blocks.push(image);
      continue;
    }
    const quoted = /^[ ]{0,3}>[ ]?(.*)$/.exec(line);
    if (quoted) {
      flushProse();
      listStack = [];
      if (quoted[1].trim()) quote.push(quoted[1].trim());
      else flushQuote();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushAll();
      const width = columns(item[1]);
      while (listStack.length && width < listStack[listStack.length - 1]) listStack.pop();
      if (!listStack.length || width > listStack[listStack.length - 1]) listStack.push(width);
      const level = Math.min(listStack.length - 1, MAX_INDENT);
      const task = item[2] ? TASK.exec(item[4]) : null;
      if (task) addItem("checklist", level, task[2], task[1] !== " ");
      else addItem(item[2] ? "bulleted" : "numbered", level, item[4], false);
      continue;
    }
    if (/^[ ]{0,3}<\/?[A-Za-z][^>]*>\s*$/.test(line)) {
      flushAll();
      warnings.push(`line ${i + 1}: raw HTML block skipped`);
      continue;
    }
    // A continuation line inside a list item joins that item.
    const last = blocks[blocks.length - 1];
    if (listStack.length && /^[ \t]+\S/.test(line) && last && "items" in last && !prose.length) {
      const items = last.items as Array<{ runs: WireRun[] }>;
      const target = items[items.length - 1];
      target.runs = mergeRuns([...target.runs, { text: " " }, ...parseInline(line.trim())]);
      continue;
    }
    flushQuote();
    listStack = [];
    prose.push(line.trim());
    if (/( {2}|\\)$/.test(line)) {
      prose[prose.length - 1] = prose[prose.length - 1].replace(/\\$/, "");
      flushProse();
    }
  }
  flushAll();
  return { blocks, warnings };
}

// ---------------------------------------------------------------------------
// Writer call
// ---------------------------------------------------------------------------

const summarySchema = z.array(
  z
    .object({
      style: z.string(),
      indent: z.number().int(),
      blockQuote: z.boolean(),
      checked: z.boolean().optional(),
      lengthUTF16: z.number().int(),
      runs: z.array(z.object({ length: z.number().int(), attributes: z.record(z.unknown()) })),
    })
    .passthrough()
);

const REVISION = /^r1:[a-f0-9]{64}$/;

export const composePlanSchema = z
  .object({
    status: z.literal("planned"),
    dryRun: z.literal(true),
    committed: z.literal(false),
    identifier: z.string(),
    mode: z.enum(["append", "prepend"]),
    paragraphs: z.number().int(),
    insertedUTF16: z.number().int(),
    insertAt: z.number().int(),
    unitStart: z.number().int(),
    revisionBefore: z.string().regex(REVISION),
    plan: summarySchema,
  })
  .passthrough();
export type ComposePlan = z.infer<typeof composePlanSchema>;

export const composeResultSchema = z
  .object({
    status: z.literal("updated"),
    committed: z.literal(true),
    verified: z.literal(true),
    placementVerified: z.literal(true),
    identifier: z.string(),
    mode: z.enum(["append", "prepend"]),
    paragraphs: z.number().int(),
    insertedUTF16: z.number().int(),
    revisionBefore: z.string().regex(REVISION),
    revisionAfter: z.string().regex(REVISION),
    unitStart: z.number().int(),
    objectURI: z.string(),
    readBack: summarySchema,
    objects: z
      .array(
        z
          .object({
            kind: z.enum(["divider", "table", "file", "url"]),
            identifier: z.string(),
            uti: z.string().nullable().optional(),
          })
          .passthrough()
      )
      .optional(),
    frozenAttachments: z
      .object({ attachments: z.number().int(), verified: z.literal(true) })
      .passthrough()
      .optional(),
    ...writeSyncFields,
  })
  .passthrough();
export type ComposeResult = z.infer<typeof composeResultSchema>;

export interface InsertBeforeHeading {
  text: string;
  occurrence?: number;
  expectedCount?: number;
}

export interface ComposeRequest {
  identifier: string;
  mode: "append" | "prepend";
  paragraphs: WireEntry[];
  ifRevision?: string;
  dryRun?: boolean;
  requireNonSystemPaper?: boolean;
  insertBeforeHeading?: InsertBeforeHeading;
  /** Folder preconditions, checked by the writer just before the save. */
  scope?: ScopeGuard;
}

// ---------------------------------------------------------------------------
// Independent read-back through the NoteStore decoder
// ---------------------------------------------------------------------------

const RUN_KEYS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "link",
  "highlight",
  "color",
] as const;

/** The object type identifier Notes records for each built-in block object. */
const OBJECT_UTIS: Partial<Record<WireObject["kind"], string>> = {
  divider: "com.apple.notes.inlinetextattachment.dividerline",
  table: "com.apple.notes.table",
  url: "public.url",
};

interface ValueRun {
  length: number;
  values: Record<string, unknown>;
}

/**
 * A run's inline attribute values in one comparable shape: the set keys of
 * RUN_KEYS in a fixed order, then the attachment it points at (identifier
 * uppercased, and its type).
 */
function runValues(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RUN_KEYS)
    if (attributes[key] !== undefined && attributes[key] !== false) out[key] = attributes[key];
  const attachment = attributes.attachment as
    { identifier?: unknown; id?: unknown; uti?: unknown } | undefined;
  if (attachment)
    out.attachment = {
      identifier: String(attachment.identifier ?? attachment.id ?? "").toUpperCase(),
      uti: attachment.uti ?? null,
    };
  return out;
}

/** Merge adjacent runs whose values are equal, so storage-level splits do not matter. */
function mergeValueRuns(runs: ValueRun[]): ValueRun[] {
  const out: ValueRun[] = [];
  for (const run of runs) {
    if (!run.length) continue;
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.values) === JSON.stringify(run.values))
      last.length += run.length;
    else out.push({ length: run.length, values: run.values });
  }
  return out;
}

/** The writer's persisted signature of one paragraph, normalized for comparison. */
function readBackShape(entry: ComposeResult["readBack"][number]) {
  return {
    style: entry.style,
    indent: entry.indent,
    blockQuote: entry.blockQuote,
    checked: entry.checked,
    lengthUTF16: entry.lengthUTF16,
    runs: mergeValueRuns(
      entry.runs.map((run) => ({ length: run.length, values: runValues(run.attributes) }))
    ),
  };
}

type Shape = ReturnType<typeof readBackShape>;

function compareShapes(where: string, actual: Shape, want: Shape, label: [string, string]) {
  const mismatches: string[] = [];
  for (const key of Object.keys(want) as Array<keyof Shape>)
    if (JSON.stringify(actual[key]) !== JSON.stringify(want[key]))
      mismatches.push(
        `${where} ${key}: ${label[0]} ${JSON.stringify(actual[key])}, ${label[1]} ${JSON.stringify(want[key])}`
      );
  return mismatches;
}

/** The text a wire entry puts in the note: its runs, or one attachment glyph. */
function entryText(entry: WireEntry): string {
  return isObject(entry) ? "\uFFFC" : entry.runs.map((run) => run.text).join("");
}

/**
 * Compare what the writer reports it stored with what was requested: each
 * paragraph's style, indent, block quote, checklist state, length, and every
 * run's attribute values (link URL, highlight, color, bold, italic,
 * underline, strikethrough), and for each object paragraph the created
 * object (kind, type, link-card URL, file name and size) whose glyph it holds.
 * The writer already proved the persisted note equals its own rendering of
 * the request; this proves that rendering is the request. Returns the
 * mismatches (empty when everything matches).
 */
export function verifyAgainstRequest(paragraphs: WireEntry[], result: ComposeResult): string[] {
  const mismatches: string[] = [];
  if (result.readBack.length !== paragraphs.length)
    return [
      `the writer read back ${result.readBack.length} paragraphs; ${paragraphs.length} were requested`,
    ];
  const objects = result.objects ?? [];
  let next = 0;
  paragraphs.forEach((entry, i) => {
    const where = `paragraph ${i}`;
    let want: Shape;
    if (isObject(entry)) {
      const object = objects[next++];
      if (!object || object.kind !== entry.kind) {
        mismatches.push(`${where}: no created ${entry.kind} object`);
        return;
      }
      const uti = OBJECT_UTIS[entry.kind];
      if (uti && object.uti !== uti)
        mismatches.push(`${where}: the ${entry.kind} has type ${String(object.uti)}, not ${uti}`);
      if (entry.kind === "url" && object.url !== entry.url)
        mismatches.push(`${where}: the link card URL is ${String(object.url)}`);
      if (entry.kind === "file") {
        const name = entry.filename ?? basename(entry.path);
        if (object.filename !== name)
          mismatches.push(`${where}: the file attachment is named ${String(object.filename)}`);
      }
      want = {
        style: "body",
        indent: 0,
        blockQuote: false,
        checked: undefined,
        lengthUTF16: 1,
        runs: [
          {
            length: 1,
            values: {
              attachment: { identifier: object.identifier.toUpperCase(), uti: object.uti ?? null },
            },
          },
        ],
      };
    } else {
      want = {
        style: entry.style,
        indent: entry.indent ?? 0,
        blockQuote: entry.blockQuote ?? false,
        checked: entry.checked,
        lengthUTF16: entryText(entry).length,
        runs: mergeValueRuns(
          entry.runs.map((run) => {
            const { text, ...attributes } = run;
            return { length: text.length, values: runValues(attributes) };
          })
        ),
      };
    }
    mismatches.push(
      ...compareShapes(where, readBackShape(result.readBack[i]), want, ["stored", "requested"])
    );
  });
  if (next !== objects.length)
    mismatches.push(`the writer created ${objects.length} objects; ${next} were requested`);
  return mismatches;
}

export interface DatabaseReadBack {
  /** False when the independent read could not run; `reason` says why. */
  checked: boolean;
  matches?: boolean;
  mismatches?: string[];
  reason?: string;
}

/** One decoded NoteStore run in the writer's attribute vocabulary. */
function databaseRunValues(run: NoteBlock["runs"][number]): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...run };
  if (run.highlight === "unknown") attributes.highlight = run.highlightValue;
  return runValues(attributes);
}

/**
 * Re-read the written paragraphs from NoteStore.sqlite with this server's own
 * protobuf decoder (utils/noteBlocks), independent of NotesShared, and compare
 * each paragraph's style, indent, block quote, checklist state, length, and
 * every run's attribute values (link URL, highlight, color, styles, attachment
 * identifier and type) with the writer's `readBack`. With `requested`, each
 * paragraph's decoded text is also compared with the requested text.
 * Never throws: the writer already verified the write, so this only reports.
 */
export function crossCheckWithDatabase(
  result: ComposeResult,
  read: (id: string) => NoteBlocksDocument = (id) => readNoteBlocks(id),
  requested?: WireEntry[]
): DatabaseReadBack {
  if (result.storeKind !== "live")
    return { checked: false, reason: "the writer wrote a store copy, not NoteStore.sqlite" };
  const { objectURI, unitStart } = result;
  let blocks: NoteBlock[];
  try {
    blocks = read(objectURI).blocks;
  } catch (error) {
    return { checked: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const first = blocks.findIndex((block) => block.start === unitStart);
  if (first < 0)
    return { checked: true, matches: false, mismatches: ["no paragraph starts at unitStart"] };
  const mismatches: string[] = [];
  result.readBack.forEach((expected, i) => {
    const block = blocks[first + i];
    const where = `paragraph ${i}`;
    if (!block) {
      mismatches.push(`${where}: missing`);
      return;
    }
    const actual: Shape = {
      style: block.style,
      indent: block.indent,
      blockQuote: block.blockQuote,
      checked: block.checklist?.done,
      lengthUTF16: block.length,
      runs: mergeValueRuns(
        block.runs.map((run) => ({ length: run.length, values: databaseRunValues(run) }))
      ),
    };
    mismatches.push(
      ...compareShapes(where, actual, readBackShape(expected), ["database", "writer"])
    );
    const entry = requested?.[i];
    if (entry && block.text !== entryText(entry))
      mismatches.push(`${where} text: the database text differs from the requested text`);
  });
  return {
    checked: true,
    matches: mismatches.length === 0,
    ...(mismatches.length ? { mismatches } : {}),
  };
}

/** Refuse an unvalidated compose write unless APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1. */
export function assertComposeWritesAllowed(env: NodeJS.ProcessEnv): void {
  requireLiveValidated(COMPOSE_LIVE_VALIDATED, "compose-note", env);
}

/**
 * Plan (dryRun) or apply one compose. Apply requires `ifRevision` from a
 * fresh plan or native-note-state; a stale token fails with nothing written.
 */
export function composeNote(
  request: ComposeRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): ComposePlan | ComposeResult {
  assertNoteIdentifier(request.identifier);
  const dryRun = request.dryRun === true;
  if (dryRun && request.ifRevision !== undefined)
    throw invalid("A dry run does not take ifRevision");
  if (!dryRun) {
    if (!request.ifRevision || !REVISION.test(request.ifRevision))
      throw invalid("ifRevision (the revisionBefore of a dry run) is required to apply");
    assertComposeWritesAllowed(deps.env);
  }
  if (request.insertBeforeHeading && request.mode !== "append")
    throw invalid("insertBeforeHeading is valid only in append mode");
  // The writer's line-break set (NSCharacterSet.newlineCharacterSet).
  if (
    request.insertBeforeHeading &&
    /[\n\v\f\r\u0085\u2028\u2029]/.test(request.insertBeforeHeading.text)
  )
    throw invalid("insertBeforeHeading.text must be one line");
  const fields: Record<string, unknown> = {
    identifier: request.identifier,
    mode: request.mode,
    paragraphs: request.paragraphs,
  };
  if (dryRun) fields.dryRun = true;
  else fields.ifRevision = request.ifRevision;
  if (request.requireNonSystemPaper) fields.requireNonSystemPaper = true;
  if (request.insertBeforeHeading) fields.insertBeforeHeading = request.insertBeforeHeading;
  Object.assign(fields, writerScopeFields(request.scope));

  assertWriterRequestSize(fields);

  try {
    const response = callPrivateWriter("compose_note", fields, deps);
    if (dryRun) return parseWriterResult(composePlanSchema, response, false);
    const result = parseWriterResult(composeResultSchema, response, true);
    const mismatches = verifyAgainstRequest(request.paragraphs, result);
    if (mismatches.length)
      throw new PrivateWriteError(
        "verification_failed",
        "The writer saved the note, but what it stored differs from the request",
        true,
        { ...result, indeterminate: true, requestMismatches: mismatches }
      );
    return result;
  } catch (error) {
    // A dry run opens the store read-only, so it can never have committed.
    if (dryRun && error instanceof PrivateWriteError && error.committed !== false)
      throw new PrivateWriteError(error.code, error.message, false, error.details);
    throw error;
  }
}
