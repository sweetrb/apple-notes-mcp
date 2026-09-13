import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeMessage,
  decodeVarint,
  embeddedMessage,
  getField,
  getFields,
  stringValue,
  varintValue,
} from "./protobuf.js";

export interface NoteLink {
  start: number;
  length: number;
  text: string;
  url: string;
}
export interface RichNote {
  text: string;
  links: NoteLink[];
  nativeTags: string[];
  nativeObjectIds: string[];
  hasNativeObjects: boolean;
  hasChecklist: boolean;
  revision: string;
  nativeTagObjectIds?: Record<string, string[]>;
  objects?: Array<{ id: string; type: string; start: number; length: number }>;
  checklistItems?: Array<{ id: string; text: string; done: boolean; start: number }>;
  styleRuns?: Array<{ start: number; length: number; signature: string }>;
  objectData?: Array<{
    id: string;
    pk: number;
    type: string;
    mergeable: string;
    view: number | null;
  }>;
}
export interface RichRead {
  content: string;
  links: NoteLink[];
  nativeTags: string[];
  complete: boolean;
  writable: boolean;
  revision: string;
  warning?: string;
}

const dbPath = join(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
const safeUrl = (url: string) =>
  /^(?:https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url) &&
  !Array.from(url).some((char) => char.charCodeAt(0) < 32);
const escapeAttribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const normalized = (text: string) => text.replace(/[\s\ufffc]/gu, "");

function styleValue(field: ReturnType<typeof decodeMessage>[number]): unknown {
  if (!(field.value instanceof Uint8Array)) return field.value;
  if (field.fieldNumber === 2) {
    // Notes regenerates paragraph IDs on the first native edit of imported HTML.
    // ParagraphStyle field 9 is a 16-byte paragraph UUID, not visual formatting:
    // https://github.com/shareup/nanotes/blob/main/notestore.proto
    // Keep every other field (including checklist identity/state and unknowns).
    // Keep raw bytes for all other fields, including fixed-width/unknown fields
    // that the general purpose decoder skips. Malformed input stays conservative.
    const data = field.value,
      kept: Uint8Array[] = [];
    let offset = 0;
    try {
      while (offset < data.length) {
        const start = offset;
        let tag: number,
          length = -1;
        [tag, offset] = decodeVarint(data, offset);
        const wire = tag & 7;
        if (wire === 0) [, offset] = decodeVarint(data, offset);
        else if (wire === 1) offset += 8;
        else if (wire === 5) offset += 4;
        else if (wire === 2) {
          [length, offset] = decodeVarint(data, offset);
          offset += length;
        } else return Buffer.from(data).toString("hex");
        if (offset > data.length) return Buffer.from(data).toString("hex");
        if (!(tag >>> 3 === 9 && wire === 2 && length === 16)) kept.push(data.slice(start, offset));
      }
      return Buffer.concat(kept).toString("hex");
    } catch {
      return Buffer.from(data).toString("hex");
    }
  }
  return Buffer.from(field.value).toString("hex");
}

/** Decode the rich-text metadata stored for one Apple Notes record. */
export function parseRichNote(data: Uint8Array, nativeTags: string[] = []): RichNote {
  const doc = decodeMessage(data);
  const wrapper = embeddedMessage(getField(doc, 2));
  const body = wrapper && embeddedMessage(getField(wrapper, 3));
  const text = body && stringValue(getField(body, 2));
  if (!body || text === undefined) throw new Error("Unsupported Notes document structure");
  const links: NoteLink[] = [];
  const nativeObjectIds: string[] = [];
  const objects: NonNullable<RichNote["objects"]> = [];
  const checklistItems: NonNullable<RichNote["checklistItems"]> = [];
  const styleRuns: NonNullable<RichNote["styleRuns"]> = [];
  let position = 0;
  let hasNativeObjects = false;
  let hasChecklist = false;
  for (const run of getFields(body, 5)) {
    const fields = embeddedMessage(run);
    if (!fields) throw new Error("Invalid Notes attribute run");
    const length = varintValue(getField(fields, 1));
    if (length === undefined || length < 0 || position + length > text.length)
      throw new Error("Invalid Notes run length");
    styleRuns.push({
      start: position,
      length,
      signature: JSON.stringify(
        fields
          .filter((f) => (f.fieldNumber >= 2 && f.fieldNumber <= 12) || f.fieldNumber === 14)
          .map((f) => [f.fieldNumber, styleValue(f)])
      ),
    });
    const url = stringValue(getField(fields, 9));
    if (url) {
      if (!safeUrl(url)) throw new Error("Unsupported link scheme in note");
      const previous = links.at(-1);
      if (previous?.url === url && previous.start + previous.length === position) {
        previous.length += length;
        previous.text += text.slice(position, position + length);
      } else
        links.push({ start: position, length, text: text.slice(position, position + length), url });
    }
    hasNativeObjects ||= Boolean(getField(fields, 12));
    const attachment = embeddedMessage(getField(fields, 12));
    const attachmentId = attachment && stringValue(getField(attachment, 1));
    if (attachmentId) nativeObjectIds.push(attachmentId);
    if (attachmentId)
      objects.push({
        id: attachmentId,
        type: stringValue(getField(attachment!, 2)) || "unknown",
        start: position,
        length,
      });
    const paragraph = embeddedMessage(getField(fields, 2));
    hasChecklist ||= Boolean(paragraph && varintValue(getField(paragraph, 1)) === 103);
    if (paragraph && varintValue(getField(paragraph, 1)) === 103) {
      const checklist = embeddedMessage(getField(paragraph, 5));
      const rawId = checklist && getField(checklist, 1)?.value;
      const itemId = rawId instanceof Uint8Array ? Buffer.from(rawId).toString("hex") : "";
      const start = text.lastIndexOf("\n", position - 1) + 1;
      if (itemId && !checklistItems.some((item) => item.id === itemId))
        checklistItems.push({
          id: itemId,
          start,
          text: text.slice(
            start,
            text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start)
          ),
          done: checklist ? varintValue(getField(checklist, 2)) === 1 : false,
        });
    }
    position += length;
  }
  if (position !== text.length) throw new Error("Incomplete Notes attribute runs");
  return {
    text,
    links,
    nativeTags: hasNativeObjects ? nativeTags : [],
    nativeObjectIds,
    hasNativeObjects,
    hasChecklist,
    revision: createHash("sha256").update(data).digest("hex"),
    objects,
    checklistItems,
    styleRuns,
  };
}

/** Read rich metadata for one canonical CoreData note ID without modifying Notes. */
export function readRichNote(id: string): RichNote {
  const pk = /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p([0-9]+)$/i.exec(id)?.[1];
  if (!pk) throw new Error("Invalid exact note ID");
  // One read-only transaction, scoped to the requested note; no library dump.
  const sql = `BEGIN; SELECT hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE=${pk}; SELECT json_group_object(ZIDENTIFIER,ZALTTEXT) FROM ZICCLOUDSYNCINGOBJECT WHERE ZNOTE1=${pk} AND ZTYPEUTI1='com.apple.notes.inlinetextattachment.hashtag'; SELECT json_group_array(json_object('id',ZIDENTIFIER,'pk',Z_PK,'type',COALESCE(ZTYPEUTI1,ZTYPEUTI),'mergeable',hex(COALESCE(ZMERGEABLEDATA1,ZMERGEABLEDATA)),'view',ZATTACHMENTVIEWTYPE)) FROM ZICCLOUDSYNCINGOBJECT WHERE ZNOTE1=${pk} OR ZNOTE=${pk}; COMMIT;`;
  const rows = execFileSync("/usr/bin/sqlite3", ["-readonly", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .trim()
    .split("\n");
  if (!rows[0] || !/^[0-9a-f]+$/i.test(rows[0])) throw new Error("No Notes document data");
  const tags: unknown = JSON.parse(rows[1] || "{}");
  if (
    !tags ||
    Array.isArray(tags) ||
    typeof tags !== "object" ||
    Object.values(tags).some((tag) => typeof tag !== "string")
  )
    throw new Error("Invalid native tags");
  const rich = parseRichNote(
    gunzipSync(Buffer.from(rows[0], "hex"), { maxOutputLength: 32 * 1024 * 1024 })
  );
  const tagMap = tags as Record<string, string>;
  const objectData: unknown = JSON.parse(rows[2] || "[]");
  if (
    !Array.isArray(objectData) ||
    objectData.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        !Number.isInteger(row.pk) ||
        typeof row.mergeable !== "string" ||
        !/^[0-9a-f]*$/i.test(row.mergeable)
    )
  )
    throw new Error("Invalid native object metadata");
  rich.objectData = objectData
    .filter((row) => rich.nativeObjectIds.includes(row.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  rich.revision = createHash("sha256")
    .update(rich.revision)
    .update(JSON.stringify(rich.objectData))
    .digest("hex");
  rich.nativeTagObjectIds = {};
  for (const id of rich.nativeObjectIds)
    if (tagMap[id]) {
      const tag = tagMap[id].replace(/^#/, "");
      (rich.nativeTagObjectIds[tag] ||= []).push(id);
    }
  rich.nativeTags = [
    ...new Set(
      rich.nativeObjectIds.flatMap((id) => (tagMap[id] ? [tagMap[id].replace(/^#/, "")] : []))
    ),
  ];
  return rich;
}

function decodeEntity(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  if (!value.startsWith("&") || value === "&") return value;
  const name = value.slice(1).replace(/;$/, "");
  if (name.startsWith("#")) {
    const cp =
      name[1]?.toLowerCase() === "x"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new Error("Invalid HTML entity");
    return String.fromCodePoint(cp);
  }
  if (!(name in named)) throw new Error("Unsupported HTML entity");
  return named[name];
}

interface Character {
  value: string;
  start: number;
  end: number;
  token: number;
}
function visibleCharacters(html: string): Character[] {
  const chars: Character[] = [];
  let token = 0;
  for (const part of html.matchAll(/<[^>]*>|[^<]+/g)) {
    token++;
    if (part[0].startsWith("<")) continue;
    for (const item of part[0].matchAll(
      /&(?:#[0-9]+;?|#x[0-9a-f]+;?|(?:amp|lt|gt|quot|apos|nbsp)(?:;|(?![a-z0-9=])))|[\s\S]/gi
    )) {
      const value = decodeEntity(item[0]);
      for (let i = 0; i < value.length; i++) {
        if (/\s/u.test(value[i])) continue;
        chars.push({
          value: value[i],
          start: part.index! + item.index!,
          end: part.index! + item.index! + item[0].length,
          token,
        });
      }
    }
  }
  return chars;
}

/** Reinsert URLs at their exact text positions, never by a global label match. */
export function restoreNoteLinks(html: string, rich: RichNote): string {
  // AppleScript sometimes preserves some anchors; remove wrappers first to
  // avoid nested links. The database remains the source of their destinations.
  const base = html.replace(/<\/?a\b[^>]*>/gi, "");
  const chars = visibleCharacters(base);
  if (chars.map((c) => c.value).join("") !== normalized(rich.text))
    throw new Error("Notes HTML and rich text do not match; retry after sync");
  const positions: number[] = [];
  for (let i = 0; i < rich.text.length; i++)
    if (!/[\s\ufffc]/u.test(rich.text[i])) positions.push(i);
  const inserts: Array<{ start: number; end: number; url: string }> = [];
  for (const link of rich.links) {
    if (!safeUrl(link.url)) throw new Error("Unsupported link scheme in note");
    let span: { start: number; end: number; url: string; token: number } | undefined;
    for (let i = 0; i < chars.length; i++) {
      if (positions[i] < link.start || positions[i] >= link.start + link.length) continue;
      const c = chars[i];
      if (span?.token === c.token) span.end = c.end;
      else {
        if (span) inserts.push(span);
        span = { start: c.start, end: c.end, token: c.token, url: link.url };
      }
    }
    if (span) inserts.push(span);
  }
  let result = base;
  for (const span of inserts.sort((a, b) => b.start - a.start))
    result =
      result.slice(0, span.start) +
      `<a href="${escapeAttribute(span.url)}">` +
      result.slice(span.start, span.end) +
      "</a>" +
      result.slice(span.end);
  return result;
}

/** Combine AppleScript HTML with database metadata and restore verifiable links. */
export function enrichNoteRead(id: string, rawBody: string): RichRead {
  let metadata: RichNote | undefined;
  try {
    const rich = readRichNote(id);
    metadata = rich;
    const content = restoreNoteLinks(rawBody, rich);
    const writable = !rich.hasNativeObjects && !rich.hasChecklist;
    return {
      content,
      links: rich.links,
      nativeTags: rich.nativeTags,
      complete: writable,
      writable,
      revision: rich.revision,
      ...(!writable
        ? {
            warning:
              "Native tags, inline objects or checklists are present. Their state is not writable through AppleScript; full-body edits are blocked to preserve them.",
          }
        : {}),
    };
  } catch {
    return {
      content: rawBody,
      links: metadata?.links ?? [],
      nativeTags: metadata?.nativeTags ?? [],
      complete: false,
      writable: false,
      revision: metadata?.revision ?? "unavailable",
      warning:
        "Rich Notes metadata could not be read or matched. Links/native tags may be missing from this view. Full-body edits are blocked; check Full Disk Access and retry after sync.",
    };
  }
}

/** Revision includes URLs and native attributes, even if the HTML stays equal. */
export function richContentHash(rawBody: string, rich: RichRead): string {
  return `sha256:${createHash("sha256").update(rawBody).update("\0").update(rich.revision).digest("hex")}`;
}

/** Extract visible link labels and safe destinations from an HTML fragment. */
export function htmlLinks(html: string): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const url = (match[1] ?? match[2]).replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, decodeEntity);
    if (!safeUrl(url)) throw new Error("Unsupported link scheme");
    links.push({
      text: visibleCharacters(match[3])
        .map((c) => c.value)
        .join(""),
      url,
    });
  }
  return links;
}
/** Produce a stable signature that preserves duplicate labels and destinations. */
export function linkSignature(links: Array<{ text: string; url: string }>): string {
  return JSON.stringify(
    links.flatMap((link) =>
      normalized(link.text)
        .split("")
        .map((char) => [char, link.url])
    )
  );
}

/** Reject a write that unexpectedly loses or changes existing links. */
export function assertLinkedWrite(
  rich: RichRead,
  content: string,
  format: string,
  allowLinkChanges = false
): void {
  if (!rich.writable) throw new Error(rich.warning || "Rich note cannot be safely rewritten");
  if (rich.links.length && format !== "html" && !allowLinkChanges)
    throw new Error(
      "This note has links. Use format=html and preserve the linked HTML returned by get-note-content."
    );
  const next = format === "html" ? htmlLinks(content) : [];
  if (allowLinkChanges) return;
  // Require each old link occurrence to survive. Explicit link removal can be
  // added as a separate operation; a generic text edit must not erase links.
  const needed = new Map<string, number>();
  for (const link of rich.links) {
    const key = linkSignature([link]);
    needed.set(key, (needed.get(key) || 0) + 1);
  }
  const incoming = linkSignature(next);
  for (const [key, count] of needed) {
    const sequence = key.slice(1, -1);
    if (incoming.split(sequence).length - 1 < count)
      throw new Error(
        "Update would remove or change an existing link. Preserve its label and URL from get-note-content."
      );
  }
}
