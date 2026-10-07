import { describe, expect, it } from "vitest";
import {
  NAMED_CHARACTER_REFERENCES,
  decodeHtmlEntities,
  namedReferenceText,
  numericReferenceText,
} from "./htmlEntities.js";

describe("decodeHtmlEntities (#283)", () => {
  it("decodes the HTML 4 names Notes' HTML importer decodes", () => {
    expect(
      decodeHtmlEntities(
        "a &mdash; b &ndash; c &rarr; d&hellip; it&rsquo;s &ldquo;q&rdquo; &copy; &trade; &bull; &middot; &times; &ne; &le; &euro; &deg;"
      )
    ).toBe("a — b – c → d… it’s “q” © ™ • · × ≠ ≤ € °");
    expect(decodeHtmlEntities("&eacute;&Eacute;&szlig;&alpha;&Omega;&hearts;")).toBe("éÉßαΩ♥");
  });

  it("keeps names case-sensitive", () => {
    expect(decodeHtmlEntities("&dagger;&Dagger;&rarr;&rArr;")).toBe("†‡→⇒");
    expect(decodeHtmlEntities("&DAGGER;&Mdash;")).toBe("&DAGGER;&Mdash;");
  });

  it("uses HTML5 code points where HTML 4 differed", () => {
    expect(decodeHtmlEntities("&lang;x&rang;")).toBe("⟨x⟩");
  });

  it("decodes legacy amp/lt/gt/quot/nbsp as a prefix with or without the semicolon (#166)", () => {
    expect(decodeHtmlEntities("a=1&ampb=2 &quothi&quot &ltx&gt &nbspy")).toBe(
      'a=1&b=2 "hi" <x> \u00a0y'
    );
    expect(decodeHtmlEntities("&AMP; &LT;")).toBe("& <");
    expect(decodeHtmlEntities("&ampfoo;")).toBe("&foo;");
  });

  it("leaves unknown names and semicolon-less non-legacy names literal (fails closed)", () => {
    expect(decodeHtmlEntities("&check; &copy &apos &notaname; & alone")).toBe(
      "&check; &copy &apos &notaname; & alone"
    );
  });

  it("decodes one level only", () => {
    expect(decodeHtmlEntities("&amp;mdash; &amp;#8212; &amp;amp;")).toBe("&mdash; &#8212; &amp;");
  });

  it("decodes numeric references as an HTML parser does", () => {
    expect(decodeHtmlEntities("&#8212;&#x2014;&#X2014;&#233")).toBe("———é");
    expect(decodeHtmlEntities("&#150;&#x93;q&#x94;&#128;")).toBe("–“q”€");
    expect(decodeHtmlEntities("&#0;&#xD800;&#x110000;&#99999999999999999999;")).toBe(
      "\ufffd".repeat(4)
    );
    expect(numericReferenceText(0x81)).toBe("\u0081");
  });

  it("covers the 252 HTML 4 names plus apos, each one character", () => {
    const names = Object.keys(NAMED_CHARACTER_REFERENCES);
    expect(names).toHaveLength(253);
    for (const name of names) expect([...namedReferenceText(name)!]).toHaveLength(1);
    expect(namedReferenceText("constructor")).toBeUndefined();
    expect(namedReferenceText("apos")).toBe("'");
  });
});
