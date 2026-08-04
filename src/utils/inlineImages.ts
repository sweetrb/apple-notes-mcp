/**
 * Inline-image capping for note content responses.
 *
 * Notes.app returns a note's `body` HTML with pasted images embedded as
 * base64 `data:` URIs. A note holding a few photos easily produces a body of
 * 10 MB or more, and an MCP response that large can exceed the client's
 * message limit and take the whole stdio connection down (observed as
 * "MCP error -32000: Connection closed" on a 10.5 MB note, while a 5 MB note
 * still went through). Stripping oversized inline images keeps get-note-content
 * responses bounded no matter how image-heavy the note is; the images
 * themselves remain reachable via list-attachments + save-attachment /
 * fetch-attachment.
 *
 * @module utils/inlineImages
 */

/**
 * Default per-image cap on the base64 payload (in bytes of the encoded
 * string) kept inline in a content response. Small pasted images (icons,
 * sketches, screenshots of a few hundred KB) survive; photos do not.
 * Overridable via APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES.
 */
const DEFAULT_MAX_INLINE_IMAGE_BYTES = 256 * 1024;

/** Resolve the configured per-image inline cap (bytes of base64 payload). */
export function maxInlineImageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_INLINE_IMAGE_BYTES;
}

/** Result of stripping oversized inline images from note HTML. */
export interface StrippedContent {
  /** The HTML with each oversized inline image replaced by a placeholder. */
  html: string;
  /** Number of images replaced. */
  strippedCount: number;
  /** Total decoded size (approximate bytes) of the replaced images. */
  strippedBytes: number;
}

/** Render a byte count as a short human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Matches an `<img>` tag whose src is a base64 `data:` URI, in either quoting
 * style. Capture groups: 1 = quote, 2 = media type, 3 = base64 payload.
 */
const INLINE_IMG_RE = /<img\b[^>]*\bsrc\s*=\s*(["'])data:([^;'"]+);base64,([^"']*)\1[^>]*\/?>/gi;

/**
 * Replaces every inline base64 image whose encoded payload exceeds `maxBytes`
 * with a plain-text placeholder that names the media type and decoded size
 * and points at the attachment tools. Images at or under the cap are kept.
 *
 * @param html - the note body HTML as returned by Notes.app
 * @param maxBytes - per-image cap on the base64 payload length; defaults to
 *   the APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES-configurable cap
 */
export function stripLargeInlineImages(
  html: string,
  maxBytes: number = maxInlineImageBytes()
): StrippedContent {
  let strippedCount = 0;
  let strippedBytes = 0;

  const result = html.replace(INLINE_IMG_RE, (tag, _quote, mediaType: string, b64: string) => {
    if (b64.length <= maxBytes) return tag;
    const decodedBytes = Math.floor((b64.length * 3) / 4);
    strippedCount += 1;
    strippedBytes += decodedBytes;
    return `<div>[inline image omitted: ${mediaType}, ~${formatBytes(
      decodedBytes
    )}; use list-attachments and save-attachment or fetch-attachment to export it]</div>`;
  });

  return { html: result, strippedCount, strippedBytes };
}

/**
 * Builds the warning appended to a get-note-content response when inline
 * images were stripped, or null when nothing was.
 */
export function strippedImagesWarning(stripped: StrippedContent): string | null {
  if (stripped.strippedCount === 0) return null;
  const plural = stripped.strippedCount === 1 ? "image" : "images";
  return (
    `\n\n⚠️ ${stripped.strippedCount} inline ${plural} (~${formatBytes(
      stripped.strippedBytes
    )} decoded) exceeded the per-image inline cap and ${
      stripped.strippedCount === 1 ? "was" : "were"
    } replaced with placeholders so the response stays within MCP message limits. ` +
    "This body is therefore lossy — do NOT write it back with update-note, or the real " +
    "images are replaced by the placeholder text; use append-to-note to add content. " +
    "The images are still in the note: use list-attachments with save-attachment or " +
    "fetch-attachment to export them, or raise APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES."
  );
}
