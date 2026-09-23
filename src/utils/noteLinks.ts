/**
 * Link and attachment classification shared by the read-only note tools.
 *
 * Apple Notes stores a note's links in three different places:
 *
 * - **inline**: a hyperlink on a text run (AttributeRun field 9), decoded by
 *   the block model in noteBlocks.ts.
 * - **card**: a rich link preview, stored as an ICAttachment row whose type
 *   is `public.url`, with the destination in `ZURLSTRING` and the card title
 *   in `ZTITLE`. Notes renders its thumbnail as an ICAttachmentPreviewImage
 *   row whose `ZIDENTIFIER` names a file or bundle under
 *   `Accounts/<account>/Previews/`.
 * - **note** / **section**: a native link chip to another note (macOS 26+
 *   "Add Link" to a note, or macOS 27 "Copy Link to Section"), stored as an
 *   ICInlineAttachment row of type `com.apple.notes.inlinetextattachment.link`
 *   whose `ZTOKENCONTENTIDENTIFIER` holds an
 *   `applenotes://showNote?identifier=<note>[&paragraphID=<paragraph>]` URL
 *   and whose `ZALTTEXT` holds the chip label.
 *
 * Everything here is pure except {@link resolvePreviewPath}, which only stats
 * files inside one account's Previews directory.
 *
 * @module utils/noteLinks
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { NoteBlocksDocument } from "./noteBlocks.js";

/** Inline-attachment UTI of a native note or section link chip. */
export const NOTE_LINK_UTI = "com.apple.notes.inlinetextattachment.link";
/** Inline-attachment UTI of a native tag. */
export const HASHTAG_UTI = "com.apple.notes.inlinetextattachment.hashtag";

/** Where a link came from. See the module comment. */
export type LinkKind = "inline" | "card" | "note" | "section";

/** One link found in a note. Optional fields appear only when known. */
export interface NoteLinkEntry {
  kind: LinkKind;
  /** Destination exactly as stored. Not sanitized; check `linkSafe`. */
  url: string;
  /** True for http(s), notes, applenotes and mailto destinations. */
  linkSafe: boolean;
  /** Visible label: run text, card title, or chip label. */
  text?: string;
  /** UTF-16 offset in the note text (inline span, or the chip/card character). */
  start?: number;
  /** UTF-16 length of an inline link span. */
  length?: number;
  /** Index of the block (paragraph) that holds the link. */
  blockIndex?: number;
  /** False when a card or chip row exists but no marker for it is in the body. */
  inBody?: boolean;
  /** Target note UUID, when the URL is a Notes showNote link. */
  targetNote?: string;
  /** Target paragraph UUID, when the URL carries `paragraphID`. */
  paragraphId?: string;
  /** Section label of a section chip. */
  section?: string;
  /** Card or chip object identifier (ZIDENTIFIER). */
  attachmentIdentifier?: string;
  /** Card attachment id in x-coredata form, when the note id is known. */
  attachmentId?: string;
  /** Largest rendered card thumbnail on disk, or null when none resolves. */
  previewPath?: string | null;
}

/** Attachment kinds, classified from the attachment's UTI. */
export type AttachmentKind =
  | "image"
  | "scan"
  | "drawing"
  | "pdf"
  | "audio"
  | "video"
  | "url"
  | "table"
  | "gallery"
  | "map"
  | "file";

const SAFE_LINK = /^(?:https?:\/\/|notes:\/\/|applenotes:|mailto:)/i;
/** Same scheme allowlist the write path uses before re-emitting a link. */
export const isSafeLink = (url: string): boolean =>
  SAFE_LINK.test(url) && !Array.from(url).some((char) => char.charCodeAt(0) < 32);

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Parse a Notes deep link (`notes://` or `applenotes://showNote?...`).
 * Returns the target note UUID and, when present, the `paragraphID` query
 * value, both uppercased. Anything else returns undefined.
 */
export function parseNotesShowUrl(
  url: string
): { targetNote?: string; paragraphId?: string } | undefined {
  const match = /^(?:apple)?notes:\/\/showNote\?(.*)$/i.exec(url);
  if (!match) return undefined;
  const query = new URLSearchParams(match[1]);
  const note = query.get("identifier") ?? "";
  const paragraph = query.get("paragraphID") ?? "";
  const result: { targetNote?: string; paragraphId?: string } = {};
  if (UUID.test(note)) result.targetNote = note.toUpperCase();
  if (UUID.test(paragraph)) result.paragraphId = paragraph.toUpperCase();
  return result;
}

/**
 * Classify an attachment by its UTI. Paper documents (`com.apple.paper.doc.*`)
 * are scans or PDFs, not drawings; `com.apple.paper` itself is a Paper
 * drawing and `com.apple.drawing*` a classic sketch.
 */
export function classifyAttachmentKind(uti: string | null | undefined): AttachmentKind {
  const u = (uti ?? "").toLowerCase();
  if (!u) return "file";
  if (u === "public.url" || u.startsWith("public.url")) return "url";
  if (u === "com.apple.notes.table") return "table";
  if (u === "com.apple.notes.gallery") return "gallery";
  if (u === "com.apple.paper.doc.scan" || u.endsWith(".scan")) return "scan";
  if (u === "com.apple.paper.doc.pdf" || u === "com.adobe.pdf" || u.endsWith(".pdf")) return "pdf";
  if (u === "com.apple.paper" || u.startsWith("com.apple.drawing")) return "drawing";
  if (u.includes("audio") || u === "public.mp3") return "audio";
  if (u.includes("movie") || u.includes("video") || u === "public.mpeg-4") return "video";
  if (u.startsWith("com.apple.map") || u.includes("mapkit")) return "map";
  if (
    u.includes("image") ||
    u.includes("photo") ||
    [
      "public.jpeg",
      "public.png",
      "public.heic",
      "public.heif",
      "public.tiff",
      "com.compuserve.gif",
    ].includes(u)
  )
    return "image";
  return "file";
}

/** True for a classic drawing or a Paper drawing UTI. */
export const isDrawingUti = (uti: string | null | undefined): boolean =>
  classifyAttachmentKind(uti) === "drawing";

/**
 * Collect the inline hyperlinks of a decoded note. Adjacent runs with the
 * same destination are merged into one link, as Notes shows them.
 */
export function inlineLinks(doc: NoteBlocksDocument): NoteLinkEntry[] {
  const links: NoteLinkEntry[] = [];
  let last: NoteLinkEntry | undefined;
  for (const block of doc.blocks)
    for (const run of block.runs) {
      if (!run.link) {
        last = undefined;
        continue;
      }
      if (last && last.url === run.link && last.start! + last.length! === run.start) {
        last.length! += run.length;
        last.text += run.text;
        continue;
      }
      last = {
        kind: "inline",
        url: run.link,
        linkSafe: run.linkSafe === true,
        text: run.text,
        start: run.start,
        length: run.length,
        blockIndex: block.index,
        ...parseNotesShowUrl(run.link),
      };
      links.push(last);
    }
  return links;
}

/** Body position of an attachment or chip marker, matched by identifier. */
export function markerPosition(
  doc: NoteBlocksDocument | undefined,
  identifier: string
): Pick<NoteLinkEntry, "start" | "blockIndex" | "inBody"> {
  if (!doc) return {};
  const wanted = identifier.toUpperCase();
  const marker = doc.attachments.find((item) => item.id.toUpperCase() === wanted);
  return marker
    ? { start: marker.start, blockIndex: marker.blockIndex, inBody: true }
    : { inBody: false };
}

/** A native link chip row (ICInlineAttachment of type {@link NOTE_LINK_UTI}). */
export interface NativeLinkRow {
  identifier: string;
  token: string | null;
  alt: string | null;
}

/** Turn a native link chip into a `note` or `section` link, or undefined without a URL. */
export function nativeLink(
  row: NativeLinkRow,
  doc?: NoteBlocksDocument
): NoteLinkEntry | undefined {
  if (!row.token) return undefined;
  const target = parseNotesShowUrl(row.token) ?? {};
  const kind: LinkKind = target.paragraphId ? "section" : "note";
  return {
    kind,
    url: row.token,
    linkSafe: isSafeLink(row.token),
    ...(row.alt ? { text: row.alt } : {}),
    ...markerPosition(doc, row.identifier),
    ...target,
    ...(kind === "section" && row.alt ? { section: row.alt } : {}),
    attachmentIdentifier: row.identifier,
  };
}

/** A rich link card row (ICAttachment with a URL). */
export interface CardLinkRow {
  pk: number;
  identifier: string;
  url: string | null;
  title: string | null;
}

/** Turn a link card attachment into a `card` link, or undefined without a URL. */
export function cardLink(
  row: CardLinkRow,
  {
    doc,
    noteId,
    previewPath,
  }: { doc?: NoteBlocksDocument; noteId?: string; previewPath?: string | null } = {}
): NoteLinkEntry | undefined {
  if (!row.url) return undefined;
  return {
    kind: "card",
    url: row.url,
    linkSafe: isSafeLink(row.url),
    ...(row.title ? { text: row.title } : {}),
    ...markerPosition(doc, row.identifier),
    ...parseNotesShowUrl(row.url),
    attachmentIdentifier: row.identifier,
    ...(noteId ? { attachmentId: attachmentIdFor(noteId, row.pk) } : {}),
    ...(previewPath !== undefined ? { previewPath } : {}),
  };
}

/** `x-coredata://<store>/ICAttachment/p<pk>` for an attachment of a note id. */
export const attachmentIdFor = (noteId: string, pk: number): string =>
  noteId.replace(/ICNote\/p\d+$/, `ICAttachment/p${pk}`);

/** One ICAttachmentPreviewImage row. */
export interface PreviewRow {
  attachment: number;
  identifier: string | null;
  width: number | null;
  height: number | null;
  scale: number | null;
  appearance: number | null;
}

/** Light-appearance renditions first, then the largest pixel area. */
export function rankPreviews(rows: PreviewRow[]): PreviewRow[] {
  const area = (row: PreviewRow) => (row.width ?? 0) * (row.height ?? 0) * (row.scale ?? 1) ** 2;
  return [...rows].sort((a, b) => (a.appearance ?? 0) - (b.appearance ?? 0) || area(b) - area(a));
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BUNDLE_ENTRIES = 64;

/** Resolve `path` and keep it only if it stays inside `root` (after symlinks). */
function confined(path: string, root: string): string | undefined {
  try {
    const real = realpathSync(path);
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the image file for one attachment's best preview rendition.
 *
 * Notes writes each rendition either as a flat file named after the preview
 * identifier (usually with `.png`) or as a bundle directory holding
 * `<n>_<uuid>/Preview.png`. Only the named entries are checked, never a scan
 * of the whole Previews directory, and every resolved path must stay inside
 * the account directory. Returns null when no rendition exists on disk.
 */
export function resolvePreviewPath(
  storeDir: string,
  accountIdentifier: string | null | undefined,
  previews: PreviewRow[]
): string | null {
  if (!accountIdentifier || !SAFE_COMPONENT.test(accountIdentifier)) return null;
  const accountDir = join(storeDir, "Accounts", accountIdentifier);
  if (!existsSync(accountDir)) return null;
  const root = realpathSync(accountDir);
  for (const preview of rankPreviews(previews)) {
    const id = preview.identifier;
    if (!id || !SAFE_COMPONENT.test(id)) continue;
    const base = join(accountDir, "Previews", id);
    for (const candidate of [`${base}.png`, base]) {
      const real = confined(candidate, root);
      if (!real) continue;
      const stat = statSync(real);
      if (stat.isFile()) return real;
      const inner = stat.isDirectory() ? previewInBundle(real, root) : undefined;
      if (inner) return inner;
    }
  }
  return null;
}

/** `Preview.png` inside a rendition bundle's single-level subdirectories. */
function previewInBundle(bundle: string, root: string): string | undefined {
  const children = readdirSync(bundle).sort();
  if (children.length > MAX_BUNDLE_ENTRIES) return undefined;
  for (const child of children) {
    const file = confined(join(bundle, child, "Preview.png"), root);
    if (file && statSync(file).isFile()) return file;
  }
  return undefined;
}
