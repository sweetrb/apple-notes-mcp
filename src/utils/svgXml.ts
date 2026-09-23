/**
 * A small, strict XML reader for the SVG analyzer.
 *
 * It accepts the subset of XML 1.0 an inert SVG document needs: one optional
 * XML declaration, comments, elements with quoted attributes, character data,
 * CDATA sections, the five predefined entities and numeric character
 * references. It refuses, rather than skips, everything that could make a
 * document active or expand it: DOCTYPE and every other `<!` declaration,
 * processing instructions, and named entities beyond the predefined five.
 * Namespaces are resolved from `xmlns` declarations.
 *
 * No dependency is used because the job is narrow and a general XML parser
 * brings DTD and entity handling this analyzer must never run.
 *
 * @module utils/svgXml
 */

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** A parse failure with a stable code: `svg_invalid` (malformed) or `svg_unsafe`. */
export class SvgError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly location: string | null = null
  ) {
    super(message);
    this.name = "SvgError";
  }
}

export interface XmlAttribute {
  /** Qualified name as written, e.g. `xlink:href`. */
  name: string;
  /** Local part, e.g. `href`. */
  local: string;
  /** Resolved namespace URI, or null for an unprefixed attribute. */
  ns: string | null;
  value: string;
}

export interface XmlElement {
  name: string;
  local: string;
  ns: string | null;
  attributes: XmlAttribute[];
  children: XmlElement[];
  /** Concatenated character data directly inside this element. */
  text: string;
  line: number;
}

export interface XmlLimits {
  maxElements: number;
  maxDepth: number;
}

const NAME_START = /[A-Za-z_À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_.\-:·À-￿]/;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Replace predefined entities and character references; refuse anything else. */
export function decodeEntities(raw: string, line: number): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(";"))
      throw new SvgError("svg_invalid", `Unterminated character reference on line ${line}`);
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1);
      const valid = hex ? /^[0-9A-Fa-f]{1,6}$/.test(digits) : /^[0-9]{1,7}$/.test(digits);
      const code = valid ? Number.parseInt(digits, hex ? 16 : 10) : NaN;
      if (!valid || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new SvgError("svg_invalid", `Invalid character reference on line ${line}`);
      return String.fromCodePoint(code);
    }
    if (body in PREDEFINED) return PREDEFINED[body];
    throw new SvgError(
      "svg_unsafe",
      `Named entity "&${body.slice(0, 40)};" on line ${line}: only the five XML entities are allowed`
    );
  });
}

/** Parse a whole document and return its root element. */
export function parseXml(source: string, limits: XmlLimits): XmlElement {
  let pos = 0;
  let line = 1;
  let elementCount = 0;
  const stack: { element: XmlElement; scope: Map<string, string> }[] = [];
  let root: XmlElement | null = null;

  const fail = (message: string): never => {
    throw new SvgError("svg_invalid", `${message} on line ${line}`);
  };
  const advance = (to: number) => {
    for (let i = pos; i < to; i++) if (source.charCodeAt(i) === 10) line++;
    pos = to;
  };
  const indexOrFail = (needle: string, what: string): number => {
    const at = source.indexOf(needle, pos);
    if (at < 0) fail(`Unterminated ${what}`);
    return at;
  };

  if (source.startsWith("<?xml") && /^<\?xml[\s?]/.test(source)) {
    const end = indexOrFail("?>", "XML declaration");
    advance(end + 2);
  }

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > pos) {
      const raw = source.slice(pos, textEnd);
      if (stack.length) stack[stack.length - 1].element.text += decodeEntities(raw, line);
      else if (raw.trim()) fail("Text outside the root element");
      advance(textEnd);
      if (lt < 0) break;
    }
    if (source.startsWith("<!--", pos)) {
      const end = indexOrFail("-->", "comment");
      advance(end + 3);
      continue;
    }
    if (source.startsWith("<![CDATA[", pos)) {
      if (!stack.length) fail("CDATA outside the root element");
      const end = indexOrFail("]]>", "CDATA section");
      stack[stack.length - 1].element.text += source.slice(pos + 9, end);
      advance(end + 3);
      continue;
    }
    if (source.startsWith("<!", pos))
      throw new SvgError(
        "svg_unsafe",
        `DOCTYPE, ENTITY and other declarations are not allowed (line ${line})`
      );
    if (source.startsWith("<?", pos))
      throw new SvgError("svg_unsafe", `Processing instructions are not allowed (line ${line})`);
    if (source.startsWith("</", pos)) {
      const end = indexOrFail(">", "end tag");
      const name = source.slice(pos + 2, end).trim();
      const open = stack.pop();
      if (!open || open.element.name !== name) fail(`Mismatched end tag </${name.slice(0, 40)}>`);
      advance(end + 1);
      continue;
    }
    // Start tag.
    const tagLine = line;
    let i = pos + 1;
    if (!NAME_START.test(source[i] ?? "")) fail("Invalid tag");
    while (i < source.length && NAME_CHAR.test(source[i])) i++;
    const name = source.slice(pos + 1, i);
    const rawAttributes: { name: string; value: string }[] = [];
    let selfClosing = false;
    for (;;) {
      const ws = i;
      while (i < source.length && /\s/.test(source[i])) i++;
      if (i >= source.length) fail("Unterminated start tag");
      if (source[i] === ">") {
        i++;
        break;
      }
      if (source.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (i === ws) fail("Missing whitespace between attributes");
      const nameStart = i;
      if (!NAME_START.test(source[i])) fail("Invalid attribute name");
      while (i < source.length && NAME_CHAR.test(source[i])) i++;
      const attrName = source.slice(nameStart, i);
      while (/\s/.test(source[i] ?? "")) i++;
      if (source[i] !== "=") fail(`Attribute ${attrName.slice(0, 40)} has no value`);
      i++;
      while (/\s/.test(source[i] ?? "")) i++;
      const quote = source[i];
      if (quote !== '"' && quote !== "'") fail("Attribute values must be quoted");
      const close = source.indexOf(quote, i + 1);
      if (close < 0) fail("Unterminated attribute value");
      const rawValue = source.slice(i + 1, close);
      if (rawValue.includes("<")) fail("'<' in an attribute value");
      if (rawAttributes.some((a) => a.name === attrName))
        fail(`Duplicate attribute ${attrName.slice(0, 40)}`);
      // Attribute-value normalization: literal whitespace becomes a space.
      rawAttributes.push({
        name: attrName,
        value: decodeEntities(rawValue.replace(/[\t\n\r]/g, " "), line),
      });
      i = close + 1;
    }
    advance(i);

    if (!stack.length && root) fail("More than one root element");
    elementCount++;
    if (elementCount > limits.maxElements)
      throw new SvgError(
        "svg_complexity_limit",
        `The document has more than ${limits.maxElements} elements`
      );
    if (stack.length + 1 > limits.maxDepth)
      throw new SvgError("svg_complexity_limit", `Elements nest deeper than ${limits.maxDepth}`);

    const parentScope = stack.length ? stack[stack.length - 1].scope : new Map<string, string>();
    const scope = new Map(parentScope);
    for (const a of rawAttributes) {
      if (a.name === "xmlns") scope.set("", a.value);
      else if (a.name.startsWith("xmlns:")) scope.set(a.name.slice(6), a.value);
    }
    const resolve = (qualified: string, isAttribute: boolean) => {
      const colon = qualified.indexOf(":");
      if (colon < 0) return { local: qualified, ns: isAttribute ? null : (scope.get("") ?? null) };
      const prefix = qualified.slice(0, colon);
      const local = qualified.slice(colon + 1);
      if (prefix === "xml") return { local, ns: XML_NS };
      const ns = scope.get(prefix);
      if (ns === undefined) fail(`Undeclared namespace prefix "${prefix.slice(0, 40)}"`);
      return { local, ns: ns as string };
    };
    const resolved = resolve(name, false);
    const element: XmlElement = {
      name,
      local: resolved.local,
      ns: resolved.ns,
      attributes: rawAttributes
        .filter((a) => a.name !== "xmlns" && !a.name.startsWith("xmlns:"))
        .map((a) => ({ name: a.name, value: a.value, ...resolve(a.name, true) })),
      children: [],
      text: "",
      line: tagLine,
    };
    if (stack.length) stack[stack.length - 1].element.children.push(element);
    else root = element;
    if (!selfClosing) stack.push({ element, scope });
  }
  if (stack.length) fail(`Unclosed element <${stack[stack.length - 1].element.name}>`);
  if (!root) fail("No root element");
  return root as XmlElement;
}
