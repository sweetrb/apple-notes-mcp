/**
 * Link classification shared by the read-only note tools.
 *
 * Apple Notes stores a note's links in three different places:
 *
 * - **inline**: a hyperlink on a text run (AttributeRun field 9), decoded by
 *   the block model in noteBlocks.ts.
 * - **card**: a rich link preview, stored as an ICAttachment row whose type
 *   is `public.url`, with the destination in `ZURLSTRING` and the card title
 *   in `ZTITLE`. Its thumbnail is a rendition under
 *   `Accounts/<account>/Previews/`, found by attachmentAssets.ts.
 * - **note** / **section**: a native link chip to another note (macOS 26+
 *   "Add Link" to a note, or macOS 27 "Copy Link to Section"), stored as an
 *   ICInlineAttachment row of type `com.apple.notes.inlinetextattachment.link`
 *   whose `ZTOKENCONTENTIDENTIFIER` holds an
 *   `applenotes://showNote?identifier=<note>[&paragraphID=<paragraph>]` URL
 *   and whose `ZALTTEXT` holds the chip label.
 *
 * Everything here is pure. Attachment kinds, preview files and ids come from
 * attachmentAssets.ts, which list-attachments uses too.
 *
 * @module utils/noteLinks
 */

import { attachmentCoreDataId } from "./attachmentAssets.js";
import { isSafeLink, type NoteBlocksDocument } from "./noteBlocks.js";

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
    ...(noteId ? { attachmentId: attachmentCoreDataId(noteId, row.pk) } : {}),
    ...(previewPath !== undefined ? { previewPath } : {}),
  };
}
