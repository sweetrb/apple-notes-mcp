/**
 * Mirror every tool result's `structuredContent` into its text content (#264).
 *
 * Some MCP clients (Claude Desktop among them) hand the model only a result's
 * text content and drop `structuredContent`. Every guarded write needs a
 * revision token (`expectedContentHash`) that the reads carried only in
 * `structuredContent`, so in those clients no guarded write could ever
 * succeed. The same held for new ids, the error `code`/`committed`/
 * `indeterminate` envelope, `writable`, native tags, and paging offsets.
 *
 * The MCP spec says a tool that returns structured content SHOULD also return
 * it serialized in a text block, for exactly this backward-compatibility case.
 * So every result that carries `structuredContent` gets one more text block,
 * appended after the tool's own content (which is left byte-for-byte as is):
 *
 *     structuredContent: {"id":"x-coredata://…","contentHash":"sha256:…",…}
 *
 * One JSON line rather than hand-picked `key: value` lines, because it covers
 * every tool and every future field without a per-tool list that would drift,
 * and because it keeps nested data (page info, envelopes) unambiguous.
 *
 * Size is bounded two ways, so a large body is never sent twice:
 * - a long string that already appears verbatim in the tool's own text (the
 *   note body of get-note-content, a Markdown export) is replaced by
 *   {@link SHOWN_ABOVE};
 * - if the line would still exceed {@link MAX_MIRROR_CHARS}, each top-level
 *   field larger than {@link MAX_FIELD_CHARS} is left out and named in
 *   `_omitted`. Scalars (hashes, ids, codes, flags, counts) are always far
 *   below that, so they are never the ones dropped.
 *
 * No block is added when the tool's text already is that JSON document.
 * `structuredContent` itself is never modified.
 *
 * @module utils/structuredText
 */
import { isDeepStrictEqual } from "node:util";

/** Prefix of the appended text block. */
export const STRUCTURED_TEXT_PREFIX = "structuredContent: ";

/** Stands in for a long string value the tool's own text already contains. */
export const SHOWN_ABOVE = "[shown in full above]";

/** A string at least this long is elided when the text already contains it. */
export const MIN_ELIDED_CHARS = 64;

/** Target upper bound for the appended block. */
export const MAX_MIRROR_CHARS = 16_384;

/** Over budget, top-level fields whose JSON is longer than this are omitted. */
export const MAX_FIELD_CHARS = 1_024;

interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  [key: string]: unknown;
}

function textOf(content: unknown[]): string {
  return content
    .map((item) =>
      item && typeof item === "object" && (item as { type?: unknown }).type === "text"
        ? String((item as { text?: unknown }).text ?? "")
        : ""
    )
    .join("\n");
}

/** Replaces long strings the text already holds; drops undefined values. */
function elide(value: unknown, text: string): unknown {
  if (typeof value === "string") {
    return value.length >= MIN_ELIDED_CHARS && text.includes(value) ? SHOWN_ABOVE : value;
  }
  if (Array.isArray(value)) return value.map((item) => elide(item, text));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = elide(item, text);
    }
    return out;
  }
  return value;
}

/** True when some text block already is the structured JSON document. */
function textIsTheJson(content: unknown[], structured: unknown): boolean {
  const plain = JSON.parse(JSON.stringify(structured)) as unknown;
  return content.some((item) => {
    const text = (item as { type?: unknown; text?: unknown })?.text;
    if ((item as { type?: unknown })?.type !== "text" || typeof text !== "string") return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return false;
    try {
      return isDeepStrictEqual(JSON.parse(trimmed), plain);
    } catch {
      return false;
    }
  });
}

/**
 * The text block that mirrors `structured`, given the tool's own text. Exported
 * for tests; tools never call it directly.
 */
export function structuredTextLine(structured: Record<string, unknown>, text: string): string {
  const elided = elide(structured, text) as Record<string, unknown>;
  let json = JSON.stringify(elided);
  if (json.length > MAX_MIRROR_CHARS) {
    const kept: Record<string, unknown> = {};
    const omitted: string[] = [];
    for (const [key, value] of Object.entries(elided)) {
      if (JSON.stringify(value).length > MAX_FIELD_CHARS) omitted.push(key);
      else kept[key] = value;
    }
    json = JSON.stringify({ ...kept, _omitted: omitted });
  }
  return STRUCTURED_TEXT_PREFIX + json;
}

/**
 * Returns `result` with its structuredContent mirrored into a trailing text
 * block. Results without structuredContent, or whose text already is the JSON,
 * are returned unchanged.
 */
export function withStructuredText<T>(result: T): T {
  const r = result as ToolResultLike | undefined;
  if (!r || typeof r !== "object") return result;
  const structured = r.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return result;
  const content = Array.isArray(r.content) ? r.content : [];
  if (textIsTheJson(content, structured)) return result;
  const line = structuredTextLine(structured as Record<string, unknown>, textOf(content));
  return { ...r, content: [...content, { type: "text", text: line }] } as T;
}

/**
 * Makes every tool registered on `server` from now on, and the SDK's own
 * error results, carry the mirrored text block. Call once, right after the
 * server is constructed and after installSdkErrorCodes, before any tool is
 * registered.
 */
export function installStructuredText(server: object): void {
  const target = server as {
    registerTool?: (name: string, config: unknown, cb: unknown) => unknown;
    createToolError?: (message: string) => unknown;
  };
  const register = target.registerTool;
  if (typeof register === "function") {
    target.registerTool = function (name: string, config: unknown, cb: unknown) {
      const wrapped =
        typeof cb === "function"
          ? async (...args: unknown[]) =>
              withStructuredText(await (cb as (...a: unknown[]) => unknown)(...args))
          : cb;
      return register.call(this, name, config, wrapped);
    };
  }
  const createError = target.createToolError;
  if (typeof createError === "function") {
    target.createToolError = (message: string) =>
      withStructuredText(createError.call(target, message));
  }
}
