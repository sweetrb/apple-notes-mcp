interface UpdatedNoteTitleInput {
  currentTitle: string;
  newTitle?: string;
  newContent: string;
  format: "plaintext" | "html";
}

function decodeNumericEntity(match: string, value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return match;
  }

  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, decimal: string) => decodeNumericEntity(match, decimal, 10))
    .replace(/&#x([\da-f]+);/gi, (match, hex: string) => decodeNumericEntity(match, hex, 16))
    .replace(/&amp;/gi, "&");
}

function firstRenderedHtmlLine(html: string): string | undefined {
  let text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:div|p|h[1-6]|li)>/gi, "\n");

  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);

  return decodeHtmlEntities(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * Resolves the visible title an update-note response should report.
 *
 * Apple Notes ignores newTitle for HTML updates and derives the display title
 * from the first rendered line of the replacement body.
 */
export function resolveUpdatedNoteTitle({
  currentTitle,
  newTitle,
  newContent,
  format,
}: UpdatedNoteTitleInput): string {
  if (format === "html") {
    return firstRenderedHtmlLine(newContent) ?? currentTitle;
  }

  return newTitle || currentTitle;
}
