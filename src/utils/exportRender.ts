/**
 * Format-neutral pieces shared by the Markdown and HTML note exporters:
 * inline formatting pieces in body order, the note's title block, and a
 * render plan for each attachment (inline text, divider, table, asset,
 * link card, gallery, placeholder, or unavailable marker).
 *
 * Asset files are found with {@link AssetLocator} and placed with an
 * {@link AssetWriter}; a plan never carries a Notes library path.
 *
 * @module utils/exportRender
 */
import type { InlineRun, NoteBlock } from "./noteBlocks.js";
import type { ExportAttachment, ExportAttachmentKind, ExportNote } from "./noteExportData.js";
import { parseNoteTable } from "./noteTables.js";
import type { AssetLocator, AssetWriter, PlacedAsset, ResolvedAsset } from "./exportAssets.js";

/** Inline formatting of a text piece. Only set attributes are present. */
export interface Fmt {
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  superscript?: true;
  subscript?: true;
  highlight?: string;
  color?: string;
  /** Only links whose scheme passed the decoder's `linkSafe` check. */
  link?: string;
}

export type Piece =
  | { type: "text"; text: string; fmt: Fmt }
  | { type: "attachment"; id: string; plan: AttachmentPlan };

/** How to render one attachment, independent of the output format. */
export type AttachmentPlan =
  | { type: "inline"; text: string; link?: string }
  | { type: "divider" }
  | { type: "table"; rows: string[][] }
  | { type: "placeholder"; label: string; name?: string }
  | { type: "unavailable"; label: string; name?: string; reason: string }
  | {
      type: "asset";
      label: string;
      name?: string;
      display: "image" | "link" | "audio" | "video";
      url: string;
      mime: string;
      previewUrl?: string;
    }
  | { type: "card"; title: string; url?: string; displayUrl: string; previewUrl?: string }
  | { type: "gallery"; items: AttachmentPlan[] };

/** Counts reported in the export receipt. */
export interface ExportStats {
  attachments: number;
  placed: number;
  placeholders: number;
  unavailable: number;
  tables: number;
  unreadableTables: number;
  /** Attachments with no body marker, appended after the body. */
  unreferenced: number;
  /**
   * Notes renderings placed from an older generation than the one recorded
   * (that one is missing on disk); present only when there are any.
   */
  staleRenderings?: number;
}

export const emptyStats = (): ExportStats => ({
  attachments: 0,
  placed: 0,
  placeholders: 0,
  unavailable: 0,
  tables: 0,
  unreadableTables: 0,
  unreferenced: 0,
});

/** Where attachment files come from and where they go. */
export interface ExportContext {
  locator?: AssetLocator;
  /** Absent: attachments render as labeled placeholders. */
  writer?: AssetWriter;
  stats: ExportStats;
}

/** Same scheme allowlist the decoder uses for `linkSafe`. */
export const isSafeHref = (url: string) =>
  /^(?:https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url) &&
  !Array.from(url).some((char) => char.charCodeAt(0) < 32);

const LABELS: Record<ExportAttachmentKind, string> = {
  table: "Table",
  image: "Image",
  drawing: "Drawing",
  paper: "Drawing",
  scan: "Scanned document",
  pdf: "PDF",
  audio: "Audio",
  video: "Video",
  link: "Link",
  gallery: "Gallery",
  divider: "Divider",
  inline: "Inline attachment",
  file: "File",
};

export const attachmentLabel = (kind: ExportAttachmentKind) => LABELS[kind];

function fmtOf(run: InlineRun): Fmt {
  const fmt: Fmt = {};
  if (run.bold) fmt.bold = true;
  if (run.italic) fmt.italic = true;
  if (run.underline) fmt.underline = true;
  if (run.strikethrough) fmt.strikethrough = true;
  if (run.superscript) fmt.superscript = true;
  if (run.subscript) fmt.subscript = true;
  if (run.highlight) fmt.highlight = run.highlight;
  if (run.color) fmt.color = run.color;
  if (run.link && run.linkSafe) fmt.link = run.link;
  return fmt;
}

const sameFmt = (a: Fmt, b: Fmt) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Split a block into text and attachment pieces in body order. Adjacent text
 * with identical formatting is merged; stray U+FFFC characters without an
 * attachment run are dropped.
 */
export function blockPieces(block: NoteBlock, plan: (id: string) => AttachmentPlan): Piece[] {
  const pieces: Piece[] = [];
  const pushText = (text: string, fmt: Fmt) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last?.type === "text" && sameFmt(last.fmt, fmt)) last.text += text;
    else pieces.push({ type: "text", text, fmt });
  };
  for (const run of block.runs) {
    const fmt = fmtOf(run);
    const parts = run.text.split("\ufffc");
    parts.forEach((part, i) => {
      if (i > 0 && run.attachment)
        pieces.push({ type: "attachment", id: run.attachment.id, plan: plan(run.attachment.id) });
      pushText(part, fmt);
    });
  }
  return pieces;
}

/** Plans that must stand as their own block rather than inline. */
export const isBlockPlan = (plan: AttachmentPlan) =>
  plan.type === "table" || plan.type === "divider" || plan.type === "gallery";

/**
 * Index of the block to render as the note title: the first non-empty block
 * when it has the title style or its text is the note's stored title.
 */
export function titleBlockIndex(note: ExportNote): number {
  const first = note.doc.blocks.find((block) => block.text.trim());
  if (!first) return -1;
  if (first.style === "title") return first.index;
  return first.text.trim() === note.title.trim() && first.style !== "monospaced" ? first.index : -1;
}

function place(ctx: ExportContext, asset: ResolvedAsset | undefined): PlacedAsset | undefined {
  const placed = asset && ctx.writer ? ctx.writer.place(asset) : undefined;
  if (asset?.stale && placed && "url" in placed)
    ctx.stats.staleRenderings = (ctx.stats.staleRenderings ?? 0) + 1;
  return placed;
}

/** Decide how to render one attachment. Counts it in `ctx.stats`. */
export function planAttachment(
  attachment: ExportAttachment | undefined,
  ctx: ExportContext
): AttachmentPlan {
  ctx.stats.attachments++;
  const unavailable = (label: string, reason: string, name?: string): AttachmentPlan => {
    ctx.stats.unavailable++;
    return { type: "unavailable", label, reason, ...(name ? { name } : {}) };
  };
  if (!attachment) return unavailable("Attachment", "missing");
  const label = attachmentLabel(attachment.kind);
  const name = attachment.title;
  switch (attachment.kind) {
    case "inline": {
      const link =
        attachment.uti.endsWith(".link") && attachment.tokenId && isSafeHref(attachment.tokenId)
          ? attachment.tokenId
          : undefined;
      return { type: "inline", text: attachment.altText ?? "", ...(link ? { link } : {}) };
    }
    case "divider":
      return { type: "divider" };
    case "table": {
      ctx.stats.tables++;
      try {
        if (!attachment.tableData) throw new Error("no table data");
        return {
          type: "table",
          rows: parseNoteTable(Buffer.from(attachment.tableData, "hex")).rows,
        };
      } catch {
        ctx.stats.unreadableTables++;
        return unavailable(label, "undecodable");
      }
    }
    case "gallery": {
      ctx.stats.attachments--;
      return {
        type: "gallery",
        items: attachment.children.map((child) => planAttachment(child, ctx)),
      };
    }
    case "link": {
      const url = attachment.url ?? "";
      const preview = ctx.locator ? place(ctx, ctx.locator.locate(attachment).preview) : undefined;
      if (preview && "url" in preview) ctx.stats.placed++;
      return {
        type: "card",
        title: name ?? url,
        displayUrl: url,
        ...(isSafeHref(url) ? { url } : {}),
        ...(preview && "url" in preview ? { previewUrl: preview.url } : {}),
      };
    }
    default: {
      if (!ctx.writer) {
        ctx.stats.placeholders++;
        return { type: "placeholder", label, ...(name ? { name } : {}) };
      }
      const files = ctx.locator?.locate(attachment) ?? {};
      const primary = place(ctx, files.primary);
      const visual = ["image", "drawing", "paper"].includes(attachment.kind);
      const wantsPreview = attachment.kind === "scan" || attachment.kind === "pdf";
      const preview =
        files.preview && (wantsPreview || (visual && !(primary && "url" in primary)))
          ? place(ctx, files.preview)
          : undefined;
      const previewUrl = preview && "url" in preview ? preview.url : undefined;
      if (primary && "url" in primary) {
        ctx.stats.placed++;
        const display = visual
          ? "image"
          : attachment.kind === "audio"
            ? "audio"
            : attachment.kind === "video"
              ? "video"
              : "link";
        return {
          type: "asset",
          label,
          ...(name ? { name } : {}),
          display,
          url: primary.url,
          mime: primary.mime,
          ...(previewUrl ? { previewUrl } : {}),
        };
      }
      if (visual && previewUrl) {
        ctx.stats.placed++;
        return {
          type: "asset",
          label,
          ...(name ? { name } : {}),
          display: "image",
          url: previewUrl,
          mime: (preview as { mime: string }).mime,
        };
      }
      const reason = primary && "error" in primary ? primary.error : "missing";
      return unavailable(label, reason, name);
    }
  }
}

/**
 * Top-level attachments with no marker in the body, in creation order.
 * Tables are left out: an unreferenced table is an editing remnant, not
 * content, and is counted instead.
 */
export function unreferencedAttachments(note: ExportNote): ExportAttachment[] {
  const referenced = new Set(note.doc.attachments.map((marker) => marker.id));
  return note.ordered.filter(
    (attachment) =>
      !referenced.has(attachment.id) &&
      attachment.kind !== "table" &&
      attachment.kind !== "inline" &&
      attachment.kind !== "divider"
  );
}
