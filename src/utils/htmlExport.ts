/**
 * Standalone HTML rendering of notes for export.
 *
 * Built from the same decoded blocks and attachment plans as the Markdown
 * export. Headings become `h1`-`h3`, lists nest by indent as `ul`/`ol`,
 * checklists render disabled checkboxes, block quotes and monospaced runs
 * become `blockquote` and `pre`, and inline runs keep bold, italic,
 * underline, strikethrough, highlight, superscript, subscript, color and
 * safe links. Tables are semantic `<table>` elements. Images, drawings
 * (through Notes' fallback image or preview), scans, audio, video, files and
 * link cards appear in body order; anything without a usable source renders
 * a visible "unavailable" marker.
 *
 * Every text and attribute value is HTML-escaped, links are limited to the
 * decoder's safe schemes, and asset URLs are data URLs or relative sidecar
 * paths, never `file:` URLs or Notes library paths. No script is emitted.
 *
 * @module utils/htmlExport
 */
import type { NoteBlock } from "./noteBlocks.js";
import type { ExportNote } from "./noteExportData.js";
import {
  blockPieces,
  planAttachment,
  titleBlockIndex,
  unreferencedAttachments,
  type AttachmentPlan,
  type ExportContext,
  type Fmt,
  type Piece,
} from "./exportRender.js";

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
}

const HIGHLIGHT_CLASSES = new Set(["purple", "pink", "orange", "mint", "blue"]);
const ALIGN = new Set(["center", "right", "justify"]);
const REASONS: Record<string, string> = {
  "too-large": " (too large to embed; export with embedAssets false)",
  unreadable: " (unreadable)",
  undecodable: " (could not be decoded)",
};

function wrapText(text: string, fmt: Fmt): string {
  let out = escapeHtml(text).replace(/\n/g, "<br>");
  if (fmt.subscript) out = `<sub>${out}</sub>`;
  if (fmt.superscript) out = `<sup>${out}</sup>`;
  if (fmt.highlight)
    out = `<mark class="hl-${HIGHLIGHT_CLASSES.has(fmt.highlight) ? fmt.highlight : "other"}">${out}</mark>`;
  if (fmt.strikethrough) out = `<s>${out}</s>`;
  if (fmt.underline) out = `<u>${out}</u>`;
  if (fmt.italic) out = `<em>${out}</em>`;
  if (fmt.bold) out = `<strong>${out}</strong>`;
  if (fmt.color && /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i.test(fmt.color))
    out = `<span style="color:${fmt.color}">${out}</span>`;
  return out;
}

const bracket = (label: string, name?: string) =>
  escapeHtml(`[${name ? `${label}: ${name}` : label}]`);

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Plans rendered as block elements (figures, tables, cards, rules). */
export function isHtmlBlockPlan(plan: AttachmentPlan): boolean {
  switch (plan.type) {
    case "table":
    case "divider":
    case "gallery":
    case "card":
      return true;
    case "asset":
      return plan.display !== "link" || !!plan.previewUrl;
    default:
      return false;
  }
}

/** Render a plan that sits inside running text. */
export function inlinePlanHtml(plan: AttachmentPlan): string {
  switch (plan.type) {
    case "inline":
      return plan.link
        ? `<a href="${escapeHtml(plan.link)}">${escapeHtml(plan.text)}</a>`
        : escapeHtml(plan.text);
    case "placeholder":
      return `<span class="attachment-placeholder">${bracket(plan.label, plan.name)}</span>`;
    case "unavailable":
      return `<span class="attachment-unavailable" role="note">${bracket(
        `${plan.label} unavailable${REASONS[plan.reason] ?? ""}`,
        plan.name
      )}</span>`;
    case "asset":
      return `<a class="attachment attachment-file" href="${escapeHtml(plan.url)}">${escapeHtml(
        plan.name ?? plan.label
      )}</a>`;
    default:
      return blockPlanHtml(plan);
  }
}

/** Render a plan as a block element. */
export function blockPlanHtml(plan: AttachmentPlan): string {
  // A file without a preview image (and every other inline plan) has no
  // block form; wrap its inline rendering in a paragraph.
  if (!isHtmlBlockPlan(plan)) return `<p>${inlinePlanHtml(plan)}</p>`;
  switch (plan.type) {
    case "table":
      return tableHtml(plan.rows);
    case "divider":
      return "<hr>";
    case "gallery":
      return `<div class="attachment-gallery">${plan.items
        .map((item) => (isHtmlBlockPlan(item) ? blockPlanHtml(item) : inlinePlanHtml(item)))
        .join("")}</div>`;
    case "card": {
      const image = plan.previewUrl
        ? `<img src="${escapeHtml(plan.previewUrl)}" alt="" loading="lazy">`
        : "";
      const text =
        `<span class="link-card-text"><span class="link-card-title">${escapeHtml(plan.title)}</span>` +
        `<span class="link-card-domain">${escapeHtml(domainOf(plan.displayUrl))}</span></span>`;
      return plan.url
        ? `<a class="link-card" href="${escapeHtml(plan.url)}">${image}${text}</a>`
        : `<div class="link-card">${image}${text}</div>`;
    }
    case "asset": {
      const name = escapeHtml(plan.name ?? plan.label);
      const src = escapeHtml(plan.url);
      const caption = plan.name ? `<figcaption>${name}</figcaption>` : "";
      if (plan.display === "image") {
        const vector = plan.mime === "image/svg+xml" ? " attachment-vector" : "";
        return `<figure class="attachment attachment-image${vector}"><img src="${src}" alt="${name}" loading="lazy"></figure>`;
      }
      if (plan.display === "audio" || plan.display === "video")
        return `<figure class="attachment attachment-${plan.display}"><${plan.display} controls preload="metadata" src="${src}"></${plan.display}>${caption}</figure>`;
      return (
        `<figure class="attachment attachment-document"><a href="${src}">` +
        `<img src="${escapeHtml(plan.previewUrl!)}" alt="${name}" loading="lazy"></a>` +
        `<figcaption><a href="${src}">${name}</a></figcaption></figure>`
      );
    }
    default:
      return `<p>${inlinePlanHtml(plan)}</p>`;
  }
}

/** A semantic table; the first row is the header. */
export function tableHtml(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const cells = (row: string[], tag: "th" | "td") =>
    Array.from(
      { length: width },
      (_, i) => `<${tag}>${escapeHtml(row[i] ?? "").replace(/\r?\n/g, "<br>")}</${tag}>`
    ).join("");
  const [head = [], ...body] = rows;
  return (
    `<table><thead><tr>${cells(head, "th")}</tr></thead>` +
    `<tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table>`
  );
}

/** Render pieces inline, grouping runs that share a link into one link. */
function inlineHtml(pieces: Piece[]): string {
  let out = "";
  for (let i = 0; i < pieces.length;) {
    const piece = pieces[i];
    if (piece.type === "attachment") {
      out += inlinePlanHtml(piece.plan);
      i++;
      continue;
    }
    const link = piece.fmt.link;
    let inner = "";
    let j = i;
    for (; j < pieces.length; j++) {
      const next = pieces[j];
      if (next.type !== "text" || next.fmt.link !== link) break;
      inner += wrapText(next.text, next.fmt);
    }
    out += link ? `<a href="${escapeHtml(link)}">${inner}</a>` : inner;
    i = j;
  }
  return out;
}

/** Split a block into inline HTML runs and block-level attachment HTML. */
function blockParts(pieces: Piece[]): Array<{ inline: string } | { block: string }> {
  const parts: Array<{ inline: string } | { block: string }> = [];
  let segment: Piece[] = [];
  const flush = () => {
    const html = inlineHtml(segment).trim();
    if (html) parts.push({ inline: html });
    segment = [];
  };
  for (const piece of pieces) {
    if (piece.type === "attachment" && isHtmlBlockPlan(piece.plan)) {
      flush();
      parts.push({ block: blockPlanHtml(piece.plan) });
    } else segment.push(piece);
  }
  flush();
  return parts;
}

const LIST_TAGS: Record<string, "ul" | "ol"> = {
  bulleted: "ul",
  dashed: "ul",
  checklist: "ul",
  numbered: "ol",
};

const alignAttr = (block: NoteBlock) =>
  ALIGN.has(block.alignment) ? ` style="text-align:${block.alignment}"` : "";

/** Render one note as an `<article>`. */
export function renderNoteHtml(note: ExportNote, ctx: ExportContext): string {
  const plan = (id: string) => planAttachment(note.attachments.get(id), ctx);
  const titleIndex = titleBlockIndex(note);
  const out: string[] = [];
  const lists: Array<{ tag: "ul" | "ol"; cls: string; open: boolean }> = [];
  let quote = false;
  let code: string[] | undefined;

  const closeLists = (depth = 0) => {
    while (lists.length > depth) {
      const list = lists.pop()!;
      out.push(`${list.open ? "</li>" : ""}</${list.tag}>`);
    }
  };
  const flushCode = () => {
    if (code) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = undefined;
  };
  const setQuote = (on: boolean) => {
    if (on === quote) return;
    flushCode();
    closeLists();
    out.push(on ? "<blockquote>" : "</blockquote>");
    quote = on;
  };

  if (titleIndex === -1 && note.title.trim()) out.push(`<h1>${escapeHtml(note.title.trim())}</h1>`);

  for (const block of note.doc.blocks) {
    setQuote(block.blockQuote);
    if (block.style === "monospaced") {
      closeLists();
      (code ??= []).push(block.text.replace(/￼/g, ""));
      continue;
    }
    flushCode();
    const listTag = LIST_TAGS[block.style];
    if (!listTag) closeLists();
    if (!block.text.trim()) continue;
    const parts = blockParts(blockPieces(block, plan));
    if (!parts.length) continue;

    if (listTag) {
      const level = Math.min(block.indent, 20);
      const cls = block.style === "checklist" || block.style === "dashed" ? block.style : "";
      closeLists(level + 1);
      const top = lists[level];
      if (top && (top.tag !== listTag || top.cls !== cls)) closeLists(level);
      if (lists[level]?.open) out.push("</li>");
      // Missing levels (an indent jump) get a bare item to hold the deeper list.
      while (lists.length < level) {
        out.push(`<${listTag}><li class="nest">`);
        lists.push({ tag: listTag, cls: "", open: true });
      }
      if (lists.length === level) {
        out.push(`<${listTag}${cls ? ` class="${cls}"` : ""}>`);
        lists.push({ tag: listTag, cls, open: false });
      }
      lists[level].open = true;
      const box =
        block.style === "checklist"
          ? `<input type="checkbox" disabled${block.checklist?.done ? " checked" : ""}> `
          : "";
      const done = block.style === "checklist" && block.checklist?.done ? ` class="done"` : "";
      const body = parts.map((part) => ("inline" in part ? part.inline : part.block)).join("");
      out.push(`<li${done}${alignAttr(block)}>${box}${body}`);
      continue;
    }

    const tag =
      block.index === titleIndex || block.style === "title"
        ? "h1"
        : block.style === "heading"
          ? "h2"
          : block.style === "subheading"
            ? "h3"
            : "p";
    for (const part of parts)
      out.push(
        "inline" in part ? `<${tag}${alignAttr(block)}>${part.inline}</${tag}>` : part.block
      );
  }
  flushCode();
  closeLists();
  setQuote(false);

  for (const attachment of unreferencedAttachments(note)) {
    ctx.stats.unreferenced++;
    out.push(blockPlanHtml(planAttachment(attachment, ctx)));
  }
  return `<article class="note">\n${out.filter(Boolean).join("\n")}\n</article>`;
}

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --line: #d2d2d7; --card: #f5f5f7; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #1d1d1f; --muted: #a1a1a6; --line: #424245; --card: #2c2c2e; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem; }
h1, h2, h3 { line-height: 1.25; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
pre { background: var(--card); padding: .75rem 1rem; overflow-x: auto; border-radius: 6px; }
code { font: 14px/1.4 ui-monospace, Menlo, monospace; }
ul.dashed { list-style-type: "– "; }
ul.checklist { list-style: none; padding-left: 1.25rem; }
ul.checklist li.done { color: var(--muted); text-decoration: line-through; }
li.nest { list-style: none; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid var(--line); padding: .35rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--card); }
figure { margin: 1rem 0; }
figure img, figure video { max-width: 100%; height: auto; border-radius: 6px; }
figcaption { color: var(--muted); font-size: .875rem; }
.attachment-vector img { background: #fff; }
.attachment-gallery { display: flex; flex-wrap: wrap; gap: .5rem; }
.attachment-gallery figure { margin: 0; flex: 1 1 12rem; }
.link-card { display: flex; gap: .75rem; align-items: center; margin: 1rem 0; padding: .5rem; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: inherit; text-decoration: none; }
.link-card img { width: 4rem; height: 4rem; object-fit: cover; border-radius: 4px; }
.link-card-text { display: flex; flex-direction: column; min-width: 0; }
.link-card-title { font-weight: 600; }
.link-card-domain { color: var(--muted); font-size: .875rem; }
.attachment-unavailable, .attachment-placeholder { display: inline-block; padding: 0 .35rem; border: 1px dashed var(--muted); border-radius: 4px; color: var(--muted); font-size: .875rem; }
mark { border-radius: 2px; padding: 0 .1em; }
mark.hl-purple { background: #e5d4ff; } mark.hl-pink { background: #ffd1e3; } mark.hl-orange { background: #ffe0b8; }
mark.hl-mint { background: #c8f2de; } mark.hl-blue { background: #cfe3ff; } mark.hl-other { background: #fff3a8; }
hr.note-separator { margin: 3rem 0; border: 0; border-top: 2px solid var(--line); }
`.trim();

/**
 * Render notes as one standalone HTML document. A multi-note document
 * separates notes with `<hr class="note-separator">`; it is a presentation
 * format, not a restore format.
 */
export function renderNotesHtml(
  notes: ExportNote[],
  ctx: ExportContext,
  { title }: { title: string }
): string {
  const body = notes
    .map((note) => renderNoteHtml(note, ctx))
    .join('\n<hr class="note-separator">\n');
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="apple-notes-mcp">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
