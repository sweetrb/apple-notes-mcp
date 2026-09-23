/**
 * Decoder-based Markdown rendering of notes for export.
 *
 * Headings map to `#`/`##`/`###`, lists keep their marker and indent (four
 * spaces per level), checklists render `- [x]`/`- [ ]`, block quotes use
 * `>`, monospaced paragraphs become fenced code, and inline runs render bold,
 * italic, strikethrough, underline (`<u>`), highlight (`==`), superscript and
 * subscript (`<sup>`/`<sub>`) and safe links. Tables render as GitHub tables;
 * other attachments become links to exported assets, or labeled placeholders
 * when no asset writer is given.
 *
 * A multi-note export is one presentation document with notes separated by
 * `---`. It is not a restore format.
 *
 * @module utils/markdownExport
 */
import type { NoteBlock } from "./noteBlocks.js";
import type { ExportNote } from "./noteExportData.js";
import {
  blockPieces,
  isBlockPlan,
  planAttachment,
  titleBlockIndex,
  unreferencedAttachments,
  type AttachmentPlan,
  type ExportContext,
  type Fmt,
  type Piece,
} from "./exportRender.js";

/** Separator between notes in a multi-note document. */
export const NOTE_SEPARATOR = "\n\n---\n\n";

/** Escape Markdown punctuation in plain text. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~|]/g, (char) => `\\${char}`)
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;")
    .replace(/==/g, "\\=\\=");
}

/**
 * Escape a line start that Markdown would read as a block marker: an ATX
 * heading (`#` to `######`), a quote, a bullet or ordered list item, or a
 * `---` thematic break. Fences, tables, `*`/`_` breaks and HTML blocks are
 * already neutralized by {@link escapeMarkdown}. Applied to body paragraphs
 * and to the text after a list item's own marker; Notes' headings and list
 * markers are emitted unescaped.
 */
export function escapeLineStart(line: string): string {
  if (/^\s*(?:-[ \t]*){3,}$/.test(line)) return line.replace("-", "\\-");
  return line.replace(
    /^(\s*)(#{1,6}|[>+-]|\d{1,9}[.)])(?=\s|$)/,
    (_, space: string, marker: string) =>
      /^\d/.test(marker)
        ? `${space}${marker.slice(0, -1)}\\${marker.slice(-1)}`
        : `${space}\\${marker}`
  );
}

/**
 * A word that would open a block if a hard wrap put it at the start of a
 * continuation line: a heading or list marker, or a setext underline.
 */
const BLOCK_START_WORD = /^(?:#{1,6}|[-+*]|-+|=+|\d{1,9}[.)])$/;

/** Percent-encode characters that would end or break a link destination. */
export function linkDestination(url: string): string {
  return url.replace(/[\s()<>]/g, (char) =>
    char === " " ? "%20" : `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

/** Wrap text in delimiters, keeping edge whitespace outside them. */
function delimit(text: string, open: string, close: string = open): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${open}${match[2]}${close}${match[3]}` : text;
}

/** Formatting layers, outermost first, with their Markdown delimiters. */
const LAYERS: Array<[keyof Fmt, string, string]> = [
  ["italic", "*", "*"],
  ["bold", "**", "**"],
  ["strikethrough", "~~", "~~"],
  ["underline", "<u>", "</u>"],
  ["highlight", "==", "=="],
  ["superscript", "<sup>", "</sup>"],
  ["subscript", "<sub>", "</sub>"],
];

type TextPiece = Extract<Piece, { type: "text" }>;

/** Concatenate, separating delimiter runs that would otherwise merge. */
function joinSafe(left: string, right: string): string {
  return left && right && /[*~=]$/.test(left) && left.at(-1) === right[0]
    ? `${left}<!-- -->${right}`
    : left + right;
}

/**
 * Render formatted text with each attribute spanning every adjacent piece
 * that shares it, so `*a**b***` nests instead of emitting touching runs.
 */
function layered(pieces: TextPiece[], depth = 0): string {
  if (depth === LAYERS.length)
    return pieces.map((piece) => escapeMarkdown(piece.text.replace(/\n/g, " "))).join("");
  const [key, open, close] = LAYERS[depth];
  let out = "";
  for (let i = 0; i < pieces.length;) {
    const on = !!pieces[i].fmt[key];
    let j = i;
    while (j < pieces.length && !!pieces[j].fmt[key] === on) j++;
    const inner = layered(pieces.slice(i, j), depth + 1);
    out = joinSafe(out, on ? delimit(inner, open, close) : inner);
    i = j;
  }
  return out;
}

const bracket = (label: string, name?: string) =>
  `\\[${escapeMarkdown(name ? `${label}: ${name}` : label)}\\]`;

/** Render an attachment plan as inline Markdown. */
export function planMarkdown(plan: AttachmentPlan): string {
  switch (plan.type) {
    case "inline":
      return plan.link
        ? `[${escapeMarkdown(plan.text)}](${linkDestination(plan.link)})`
        : escapeMarkdown(plan.text);
    case "divider":
      return "---";
    case "table":
      return tableMarkdown(plan.rows);
    case "placeholder":
      return bracket(plan.label, plan.name);
    case "unavailable":
      return bracket(`${plan.label} unavailable`, plan.name);
    case "asset": {
      const text = escapeMarkdown(plan.name ?? plan.label);
      if (plan.display === "image") return `![${text}](${linkDestination(plan.url)})`;
      const inner = plan.previewUrl ? `![${text}](${linkDestination(plan.previewUrl)})` : text;
      return `[${inner}](${linkDestination(plan.url)})`;
    }
    case "card":
      return plan.url
        ? `[${escapeMarkdown(plan.title)}](${linkDestination(plan.url)})`
        : `${escapeMarkdown(plan.title)} (${escapeMarkdown(plan.displayUrl)})`;
    case "gallery":
      return plan.items.map(planMarkdown).join("\n\n");
  }
}

/** A GitHub-flavored Markdown table; the first row is the header. */
export function tableMarkdown(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const cell = (value: string | undefined) =>
    escapeMarkdown(value ?? "")
      .replace(/\r?\n/g, "<br>")
      .trim() || " ";
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** Render pieces inline, grouping runs that share a link into one link. */
function inlineMarkdown(pieces: Piece[]): string {
  let out = "";
  for (let i = 0; i < pieces.length;) {
    const piece = pieces[i];
    if (piece.type === "attachment") {
      out = joinSafe(out, planMarkdown(piece.plan));
      i++;
      continue;
    }
    const link = piece.fmt.link;
    let j = i;
    while (
      j < pieces.length &&
      pieces[j].type === "text" &&
      (pieces[j] as TextPiece).fmt.link === link
    )
      j++;
    const inner = layered(pieces.slice(i, j) as TextPiece[]);
    out = joinSafe(out, link ? delimit(inner, "[", `](${linkDestination(link)})`) : inner);
    i = j;
  }
  return out;
}

type Group = "list" | "code" | "para" | "block";

interface Line {
  text: string;
  group: Group;
  quote: boolean;
}

const LIST_STYLES = new Set(["bulleted", "dashed", "numbered", "checklist"]);

/** Render one note's body as Markdown. */
export function renderNoteMarkdown(note: ExportNote, ctx: ExportContext): string {
  const plan = (id: string) => planAttachment(note.attachments.get(id), ctx);
  const titleIndex = titleBlockIndex(note);
  const lines: Line[] = [];
  const counters: number[] = [];
  let code: { lines: string[]; quote: boolean } | undefined;

  const flushCode = () => {
    if (!code) return;
    const longest = Math.max(
      2,
      ...code.lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length)))
    );
    const fence = "`".repeat(longest + 1);
    lines.push({
      text: [fence, ...code.lines, fence].join("\n"),
      group: "code",
      quote: code.quote,
    });
    code = undefined;
  };

  if (titleIndex === -1 && note.title.trim())
    lines.push({ text: `# ${escapeMarkdown(note.title.trim())}`, group: "para", quote: false });

  for (const block of note.doc.blocks) {
    if (block.style === "monospaced") {
      if (code && code.quote !== block.blockQuote) flushCode();
      code ??= { lines: [], quote: block.blockQuote };
      code.lines.push(block.text.replace(/\ufffc/g, ""));
      continue;
    }
    flushCode();
    if (!LIST_STYLES.has(block.style)) counters.length = 0;
    if (!block.text.trim()) continue;
    const pieces = blockPieces(block, plan);
    // Block-level attachments (tables, dividers, galleries) split the paragraph.
    let segment: Piece[] = [];
    const segments: Array<Piece[] | AttachmentPlan> = [];
    for (const piece of pieces) {
      if (piece.type === "attachment" && isBlockPlan(piece.plan)) {
        segments.push(segment, piece.plan);
        segment = [];
      } else segment.push(piece);
    }
    segments.push(segment);
    let first = true;
    for (const segment of segments) {
      if (!Array.isArray(segment)) {
        lines.push({ text: planMarkdown(segment), group: "block", quote: block.blockQuote });
        continue;
      }
      const body = inlineMarkdown(segment).trim();
      if (!body) continue;
      lines.push(renderLine(block, body, first, block.index === titleIndex, counters));
      first = false;
    }
  }
  flushCode();

  for (const attachment of unreferencedAttachments(note)) {
    ctx.stats.unreferenced++;
    lines.push({
      text: planMarkdown(planAttachment(attachment, ctx)),
      group: "block",
      quote: false,
    });
  }
  return joinLines(lines);
}

function renderLine(
  block: NoteBlock,
  body: string,
  first: boolean,
  isTitle: boolean,
  counters: number[]
): Line {
  const quote = block.blockQuote;
  if (isTitle || block.style === "title") return { text: `# ${body}`, group: "para", quote };
  if (block.style === "heading") return { text: `## ${body}`, group: "para", quote };
  if (block.style === "subheading") return { text: `### ${body}`, group: "para", quote };
  if (!LIST_STYLES.has(block.style) || !first)
    return { text: escapeLineStart(body), group: "para", quote };
  const level = Math.min(block.indent, 20);
  counters.length = Math.min(counters.length, level + 1);
  while (counters.length <= level) counters.push(0);
  const indent = "    ".repeat(level);
  let marker = "-";
  if (block.style === "numbered") marker = `${++counters[level]}.`;
  else {
    counters[level] = 0;
    if (block.style === "checklist") marker = block.checklist?.done ? "- [x]" : "- [ ]";
  }
  return { text: `${indent}${marker} ${escapeLineStart(body)}`, group: "list", quote };
}

/** Join rendered lines: tight within a list, blank lines elsewhere. */
function joinLines(lines: Line[]): string {
  let out = "";
  let previous: Line | undefined;
  for (const line of lines) {
    const text = line.quote
      ? line.text
          .split("\n")
          .map((l) => (l ? `> ${l}` : ">"))
          .join("\n")
      : line.text;
    if (previous) {
      const tight =
        previous.group === "list" && line.group === "list" && previous.quote === line.quote;
      out += tight ? "\n" : previous.quote && line.quote ? "\n>\n" : "\n\n";
    }
    out += text;
    previous = line;
  }
  return out;
}

/**
 * Hard-wrap prose lines at `width` columns. Headings, tables, fenced code,
 * image lines and words longer than the width are left intact; list and quote
 * continuation lines are indented to their content column. A line never breaks
 * before a word that would read as a block marker at the start of a line.
 */
export function wrapMarkdown(markdown: string, width: number): string {
  if (!width) return markdown;
  let fenced = false;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const bare = line.replace(/^(?:> ?)+/, "");
    if (/^\s*```/.test(bare)) fenced = !fenced;
    if (fenced || /^\s*```/.test(bare) || line.length <= width || /^\s*(#|\||!\[)/.test(bare)) {
      out.push(line);
      continue;
    }
    const prefix = /^((?:> ?)*\s*(?:(?:[-*+]|\d+\.)(?: \[[ x]\])? )?)/.exec(line)![1];
    const hang = prefix.replace(/[^>\s]/g, " ").replace(/>(?! )/g, "> ");
    const words = line.slice(prefix.length).split(" ");
    let current = prefix;
    let empty = true;
    for (const word of words) {
      if (!empty && current.length + 1 + word.length > width && !BLOCK_START_WORD.test(word)) {
        out.push(current);
        current = hang + word;
      } else current += (empty ? "" : " ") + word;
      empty = false;
    }
    out.push(current);
  }
  return out.join("\n");
}

/** Render several notes as one Markdown document separated by `---`. */
export function renderNotesMarkdown(
  notes: ExportNote[],
  ctx: ExportContext,
  { wrap = 0 }: { wrap?: number } = {}
): string {
  const body = notes.map((note) => renderNoteMarkdown(note, ctx)).join(NOTE_SEPARATOR);
  return (wrap ? wrapMarkdown(body, wrap) : body) + (notes.length ? "\n" : "");
}
