const BLOCK_END_RE = /<\/(?:div|h[1-6]|p|li)>/gi;
const BREAK_RE = /<br\s*\/?\s*>/gi;
const TAG_RE = /<[^>]*>/g;
// The `(?:<\/\1>|$)` alternative is load-bearing for performance, not just
// tidiness. Without the `$` branch an *unclosed* `<script`/`<style>` makes the
// lazy quantifier scan to end-of-input, fail, and backtrack — repeated for
// every such tag, and then repeated again by the fixpoint loop below. Measured
// on inputs made of many unclosed blocks: 211 KB 63 ms, 422 KB 247 ms, 844 KB
// 1039 ms (quadratic), against a MAX.CONTENT ceiling of 5 MiB. With the `$`
// branch the same inputs take 0–2 ms. Consuming an unclosed block to
// end-of-input also matches how browsers treat one, and stops a truncated
// leading `<style>` from donating its CSS to the derived title.
const NON_RENDERED_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

function decodeHtmlEntities(text: string): string {
  const decodeCodePoint = (match: string, value: string, radix: number): string => {
    const codePoint = Number.parseInt(value, radix);
    if (
      !Number.isInteger(codePoint) ||
      codePoint < 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return match;
    }
    return String.fromCodePoint(codePoint);
  };

  return text
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex: string) => decodeCodePoint(match, hex, 16))
    .replace(/&#([0-9]+);?/g, (match, decimal: string) => decodeCodePoint(match, decimal, 10))
    .replace(/&nbsp(?:;|(?![0-9a-z]))/gi, " ")
    .replace(/&quot(?:;|(?![0-9a-z]))/gi, '"')
    .replace(/&apos(?:;|(?![0-9a-z]))/gi, "'")
    .replace(/&lt(?:;|(?![0-9a-z]))/gi, "<")
    .replace(/&gt(?:;|(?![0-9a-z]))/gi, ">")
    .replace(/&amp(?:;|(?![0-9a-z]))/gi, "&");
}

function firstVisibleHtmlLine(html: string): string | undefined {
  let text = html;

  // Repeat until stable so removing one non-rendered block cannot expose another.
  let previous: string;
  do {
    previous = text;
    text = text.replace(NON_RENDERED_BLOCK_RE, "");
  } while (text !== previous);

  text = text.replace(BREAK_RE, "\n").replace(BLOCK_END_RE, "\n");

  // Repeat until stable so malformed nested markup cannot leave tag residue.
  do {
    previous = text;
    text = text.replace(TAG_RE, "");
  } while (text !== previous);

  return decodeHtmlEntities(text)
    .split(/[\r\n\u2028\u2029]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean);
}

/** Resolve the title that `update-note` should report after a successful write. */
export function resolveUpdateResponseTitle(
  currentTitle: string,
  newTitle: string | undefined,
  format: "plaintext" | "html",
  newContent: string
): string {
  if (format === "html") return firstVisibleHtmlLine(newContent) ?? currentTitle;
  return newTitle || currentTitle;
}
