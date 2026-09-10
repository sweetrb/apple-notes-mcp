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
  return (
    html
      .replace(/<br\s*\/?\s*>/gi, " ")
      // Inline tags carry NO visible separation, so they must vanish rather than
      // become a space. `<b>foo</b><b>bar</b>` renders as "foobar"; emitting
      // "foo bar" misdescribed the written side and, worse, disagreed with the
      // readback: Notes.app MERGES adjacent same-style runs on save, rewriting
      // that markup to `<b>foobar</b>`. The two sides then normalised to
      // "foo bar" vs "foobar" and update-note/append-to-note reported a
      // readback mismatch for a write that had actually succeeded (#145).
      // Verified against Notes.app 2026-09-10: setting `<b>merge</b><b>me</b>`
      // reads back as `<b>mergeme</b>`.
      //
      // Deliberately an allow-list of tags that are non-separating BY
      // DEFINITION. Everything else — div, p, li, headings, table cells, and any
      // tag not named here — keeps falling through to a space below, so an
      // unknown or block-level tag still separates words as before.
      .replace(
        /<\/?(?:b|i|u|s|strike|em|strong|span|a|font|sub|sup|code|tt|small|big|mark)\b[^>]*>/gi,
        ""
      )
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
      .trim()
  );
}
