/**
 * Inline hashtag extraction for Apple Notes.
 *
 * Apple Notes "tags" are not a first-class AppleScript property — they are
 * inline `#hashtag` tokens typed into the note body. Notes stores the tag
 * relationship in its private Core Data store, which AppleScript does not
 * expose, so the only way to surface a note's tags is to parse them back out
 * of the body text. This module does exactly that.
 *
 * See docs/APPLESCRIPT-LIMITATIONS.md and issue #29.
 */
/**
 * Strip HTML tags from a Notes body and neutralise numeric character
 * references so they can't masquerade as hashtags (e.g. `&#8217;`).
 */
function htmlToText(html) {
    return html
        .replace(/<[^>]*>/g, " ") // drop tags
        .replace(/&#x?[0-9a-f]+;/gi, " ") // neutralise numeric entities (&#8217;)
        .replace(/&[a-z]+;/gi, " "); // neutralise named entities (&amp; &nbsp;)
}
/**
 * A hashtag token: `#` followed by a run of letters/digits/underscores that
 * contains at least one letter. This matches Apple Notes' own rule — a purely
 * numeric token like `#123` is NOT treated as a tag. The token must not be
 * preceded by a word character, so `foo#bar` and URL fragments like
 * `page.html#section` (preceded by a letter) are ignored.
 */
const HASHTAG_RE = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu;
/**
 * Extract inline `#hashtag` tokens from a note body (HTML or plain text).
 *
 * - HTML is stripped first, so tags inside `<div>#work</div>` are found.
 * - Pure-number tokens (`#123`) are ignored, matching Notes' behaviour.
 * - Results are de-duplicated case-insensitively, preserving the first-seen
 *   casing and document order. The leading `#` is not included.
 *
 * @param body - The note body, as HTML or plain text.
 * @returns Ordered, de-duplicated tag names without the leading `#`.
 */
export function parseHashtags(body) {
    if (!body)
        return [];
    const text = htmlToText(body);
    const seen = new Set();
    const result = [];
    for (const match of text.matchAll(HASHTAG_RE)) {
        const tag = match[1];
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(tag);
        }
    }
    return result;
}
