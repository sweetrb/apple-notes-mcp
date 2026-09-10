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

/** Tags that produce no visible separation, so they collapse to nothing rather
 *  than to a space when reducing markup to comparable visible text (#145). */
const INLINE_TAG =
  /^<\/?(?:b|i|u|s|strike|em|strong|span|a|font|sub|sup|code|tt|small|big|mark)\b/i;

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
      // ONE tag-stripping pass, with the replacement chosen per tag.
      //
      // Inline tags carry NO visible separation and must vanish rather than
      // become a space: `<b>foo</b><b>bar</b>` renders as "foobar". Emitting
      // "foo bar" mis-described the written side and, worse, disagreed with the
      // readback — Notes.app MERGES adjacent same-style runs on save, rewriting
      // that markup to `<b>foobar</b>`. The two sides then normalised to
      // "foo bar" vs "foobar", and update-note/append-to-note failed a write
      // that had actually succeeded (#145). Verified against Notes.app
      // 2026-09-10: `<b>merge</b><b>me</b>` reads back as `<b>mergeme</b>`.
      //
      // Everything not on the inline list — div, p, li, headings, table cells,
      // and any unrecognised tag — still becomes a space, so block boundaries
      // keep separating words. `\b` stops the list eating <bdo>/<summary>.
      //
      // Deliberately a single `<[^>]*>` pass with a replacer rather than two
      // chained strip-regexes: a second tag-removing regex reads as an
      // incomplete HTML sanitizer (CodeQL js/incomplete-multi-character-
      // sanitization) even though nothing here sanitizes — this output is only
      // ever compared against another normalised string, never rendered, never
      // written back to a note. One pass keeps that unambiguous.
      .replace(/<[^>]*>/g, (tag) => (INLINE_TAG.test(tag) ? "" : " "))
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
