import { createHash } from "node:crypto";

/**
 * Produces the opaque revision token exposed by exact-ID note reads.
 *
 * The token is derived from the complete HTML body returned by Notes.app. A
 * caller sends it back with a later mutation so the server can reject a stale
 * edit instead of silently overwriting newer content.
 */
export function hashNoteContent(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Reduce Notes HTML to the visible text that a person sees.
 *
 * Notes.app may rewrite equivalent HTML during a save. Comparing raw markup
 * would therefore report a false failure even when every requested word was
 * saved. This intentionally ignores formatting while preserving visible text.
 */
export function comparableVisibleText(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, codePoint: string) => String.fromCodePoint(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16))
    )
    .replace(/\s+/g, " ")
    .trim();
}
