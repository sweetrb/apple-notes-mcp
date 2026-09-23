import { describe, expect, it } from "vitest";
import { SVG_NS, SvgError, XLINK_NS, decodeEntities, parseXml } from "./svgXml.js";

const LIMITS = { maxElements: 100, maxDepth: 10 };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SvgError) return error.code;
    throw error;
  }
  throw new Error("expected an SvgError");
}

describe("decodeEntities", () => {
  it("decodes the five XML entities and numeric references", () => {
    expect(decodeEntities("a &lt;b&gt; &amp; &quot;&apos; &#65;&#x42;", 1)).toBe("a <b> & \"' AB");
    expect(decodeEntities("plain", 1)).toBe("plain");
  });
  it("refuses other named entities as unsafe and bad references as invalid", () => {
    expect(code(() => decodeEntities("&xxe;", 3))).toBe("svg_unsafe");
    expect(code(() => decodeEntities("&#0;", 1))).toBe("svg_invalid");
    expect(code(() => decodeEntities("&#xD800;", 1))).toBe("svg_invalid");
    expect(code(() => decodeEntities("&#x110000;", 1))).toBe("svg_invalid");
    expect(code(() => decodeEntities("&#zz;", 1))).toBe("svg_invalid");
    expect(code(() => decodeEntities("a & b", 1))).toBe("svg_invalid");
  });
});

describe("parseXml", () => {
  it("parses elements, attributes, namespaces, text, CDATA and comments", () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>
<!-- lead comment -->
<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:ink="urn:x" width='10'>
  <g id="a"><use xlink:href="#a" xml:space="preserve"/></g>
  <text>hi &amp; <![CDATA[<raw>]]></text>
  <ink:label ink:x="1">z</ink:label>
</svg>
`,
      LIMITS
    );
    expect(root.local).toBe("svg");
    expect(root.ns).toBe(SVG_NS);
    expect(root.attributes).toEqual([{ name: "width", local: "width", ns: null, value: "10" }]);
    const use = root.children[0].children[0];
    expect(use.attributes[0]).toMatchObject({ local: "href", ns: XLINK_NS, value: "#a" });
    expect(use.attributes[1].ns).toBe("http://www.w3.org/XML/1998/namespace");
    expect(root.children[1].text).toBe("hi & <raw>");
    expect(root.children[2]).toMatchObject({ local: "label", ns: "urn:x" });
    expect(root.children[1].line).toBe(5);
  });

  it("normalizes whitespace in attribute values", () => {
    const root = parseXml('<svg d="a\tb\nc"/>', LIMITS);
    expect(root.attributes[0].value).toBe("a b c");
    expect(root.ns).toBeNull();
  });

  it("refuses DOCTYPE, declarations and processing instructions as unsafe", () => {
    expect(code(() => parseXml('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', LIMITS))).toBe(
      "svg_unsafe"
    );
    expect(code(() => parseXml("<svg><!ENTITY x></svg>", LIMITS))).toBe("svg_unsafe");
    expect(code(() => parseXml('<?xml-stylesheet href="a.css"?><svg/>', LIMITS))).toBe(
      "svg_unsafe"
    );
    expect(code(() => parseXml("<svg><?php x ?></svg>", LIMITS))).toBe("svg_unsafe");
  });

  it.each([
    ["<svg>", "unclosed"],
    ["<svg></g>", "mismatched"],
    ["<svg/><svg/>", "two roots"],
    ["text<svg/>", "text outside"],
    ["<![CDATA[x]]><svg/>", "cdata outside"],
    ["<svg a=1/>", "unquoted"],
    ['<svg a="1"b="2"/>', "no whitespace"],
    ['<svg a="1" a="2"/>', "duplicate"],
    ['<svg a="<"/>', "lt in value"],
    ["<svg a/>", "no value"],
    ['<svg a="1', "unterminated value"],
    ["<svg", "unterminated tag"],
    ['<svg 1a="1"/>', "bad attribute name"],
    ["<1svg/>", "bad tag"],
    ["<svg><!-- x</svg>", "unterminated comment"],
    ['<svg x:a="1"/>', "undeclared prefix"],
    ["", "empty"],
    ["<?xml version='1.0'", "unterminated declaration"],
  ])("rejects %s (%s) as invalid", (source) => {
    expect(code(() => parseXml(source, LIMITS))).toBe("svg_invalid");
  });

  it("enforces element count and depth limits", () => {
    expect(code(() => parseXml("<svg><g/><g/><g/></svg>", { maxElements: 3, maxDepth: 5 }))).toBe(
      "svg_complexity_limit"
    );
    expect(code(() => parseXml("<svg><g><g/></g></svg>", { maxElements: 10, maxDepth: 2 }))).toBe(
      "svg_complexity_limit"
    );
  });

  it("gives SvgError a location", () => {
    const e = new SvgError("svg_unsafe", "m", "svg/g[1]");
    expect(e.location).toBe("svg/g[1]");
    expect(new SvgError("x", "y").location).toBeNull();
  });
});
