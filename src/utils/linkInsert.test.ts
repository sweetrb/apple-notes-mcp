import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  MAX_LINK_LABEL_LENGTH,
  MAX_LINK_URL_LENGTH,
  buildLinkInsertion,
  countLinksTo,
  countMatchingLinks,
  validateLinkLabel,
  validateLinkUrl,
  verifyLinkReadback,
} from "./linkInsert.js";
import { htmlLinks, linkSignature, type NoteLink } from "./noteRichText.js";
import { comparableVisibleText } from "./noteRevision.js";
import { validateAppendContent } from "../services/backgroundNotes.js";
import { escapeHtmlForAppleScript } from "../services/appleNotesManager.js";

const link = (text: string, url: string, start = 0): NoteLink => ({
  start,
  length: text.length,
  text,
  url,
});

describe("validateLinkUrl", () => {
  it.each([
    "https://example.com",
    "https://example.com/a/b?q=1&r=2#frag",
    "http://example.org/path",
    "mailto:someone@example.com",
    "notes://showNote?identifier=00000000-0000-0000-0000-000000000000",
    "applenotes:note/00000000-0000-0000-0000-000000000000",
  ])("accepts %s", (url) => {
    expect(validateLinkUrl(url)).toBe(url);
  });

  it.each([
    ["", "required"],
    ["https://exa mple.com", "spaces"],
    ["https://example.com/\n", "spaces"],
    ["https://example.com/\u007f", "control"],
    ['https://example.com/"x', "cannot contain"],
    ["https://example.com/<x>", "cannot contain"],
    ["javascript:alert(1)", "absolute"],
    ["file:///etc/passwd", "absolute"],
    ["data:text/html,hi", "absolute"],
    ["https://", "absolute"],
    ["https:///path-only", "absolute"],
    ["example.com", "absolute"],
    ["ftp://example.com", "absolute"],
  ])("rejects %j", (url, message) => {
    expect(() => validateLinkUrl(url)).toThrow(message);
  });

  it("rejects URLs over the length cap", () => {
    const url = "https://example.com/" + "a".repeat(MAX_LINK_URL_LENGTH);
    expect(() => validateLinkUrl(url)).toThrow("longer than");
  });
});

describe("validateLinkLabel", () => {
  it("accepts one line of text, including punctuation and non-ASCII", () => {
    expect(validateLinkLabel('Café & <Bistro> "menu"')).toBe('Café & <Bistro> "menu"');
  });
  it.each([
    ["", "visible text"],
    ["   ", "visible text"],
    ["two\nlines", "one line"],
    ["tab\there", "one line"],
    ["del\u007f", "one line"],
  ])("rejects %j", (label, message) => {
    expect(() => validateLinkLabel(label)).toThrow(message);
  });
  it("rejects labels over the length cap", () => {
    expect(() => validateLinkLabel("a".repeat(MAX_LINK_LABEL_LENGTH + 1))).toThrow("longer than");
  });
});

describe("buildLinkInsertion", () => {
  it("raw mode links the URL text to itself", () => {
    const result = buildLinkInsertion({ mode: "raw", url: "https://example.com/a?b=1&c=2" });
    expect(result).toEqual({
      html: '<div><a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a></div>',
      text: "https://example.com/a?b=1&c=2",
      link: { text: "https://example.com/a?b=1&c=2", url: "https://example.com/a?b=1&c=2" },
    });
  });

  it("raw mode with linked=false writes plain text only", () => {
    const result = buildLinkInsertion({ mode: "raw", url: "https://example.com/x", linked: false });
    expect(result).toEqual({
      html: "<div>https://example.com/x</div>",
      text: "https://example.com/x",
      link: null,
    });
  });

  it("hyperlink mode escapes the label and keeps the destination", () => {
    const result = buildLinkInsertion({
      mode: "hyperlink",
      url: "https://example.org/docs",
      label: "Docs <v2> & more",
    });
    expect(result.html).toBe(
      '<div><a href="https://example.org/docs">Docs &lt;v2&gt; &amp; more</a></div>'
    );
    expect(result.link).toEqual({ text: "Docs <v2> & more", url: "https://example.org/docs" });
  });

  it("hyperlink mode accepts linked=true", () => {
    expect(
      buildLinkInsertion({
        mode: "hyperlink",
        url: "mailto:a@example.com",
        label: "Mail",
        linked: true,
      }).link
    ).toEqual({ text: "Mail", url: "mailto:a@example.com" });
  });

  it("refuses mismatched options", () => {
    expect(() => buildLinkInsertion({ mode: "hyperlink", url: "https://example.com" })).toThrow(
      "requires a label"
    );
    expect(() =>
      buildLinkInsertion({
        mode: "hyperlink",
        url: "https://example.com",
        label: "x",
        linked: false,
      })
    ).toThrow("raw mode only");
    expect(() =>
      buildLinkInsertion({ mode: "raw", url: "https://example.com", label: "x" })
    ).toThrow("hyperlink mode only");
    expect(() => buildLinkInsertion({ mode: "raw", url: "javascript:x" })).toThrow("absolute");
  });

  // The paragraph is handed to real writers, not mocks: the AppleScript route
  // (escapeHtmlForAppleScript + htmlLinks readback) and the native route
  // (validateAppendContent's HTML subset). Each must accept it and agree on
  // the visible text and the link it carries.
  describe("generated HTML against the real write and readback helpers", () => {
    const cases = [
      buildLinkInsertion({ mode: "raw", url: "https://example.com/a?b=1&c=2" }),
      buildLinkInsertion({ mode: "raw", url: "https://example.com/plain", linked: false }),
      buildLinkInsertion({
        mode: "hyperlink",
        url: "https://example.org/q?x=\\y",
        label: 'He said "hi" & <left>',
      }),
      buildLinkInsertion({
        mode: "hyperlink",
        url: "notes://showNote?identifier=abc",
        label: "Note",
      }),
    ];

    it.each(cases)("htmlLinks reads back exactly the expected link ($text)", (insertion) => {
      const links = htmlLinks(insertion.html);
      expect(linkSignature(links)).toBe(linkSignature(insertion.link ? [insertion.link] : []));
    });

    it.each(cases)("visible text matches ($text)", (insertion) => {
      expect(comparableVisibleText(insertion.html)).toBe(insertion.text);
    });

    it.each(cases)("passes the native-append HTML subset ($text)", (insertion) => {
      expect(() => validateAppendContent(insertion.html, "html")).not.toThrow();
    });

    it("survives a real AppleScript string literal unchanged", () => {
      // osascript only evaluates a string literal here; no application is targeted.
      for (const insertion of cases) {
        const literal = escapeHtmlForAppleScript(insertion.html);
        const out = execFileSync("osascript", ["-e", `return "${literal}"`], {
          encoding: "utf8",
        });
        expect(out.replace(/\n$/, "")).toBe(insertion.html);
      }
    });
  });
});

describe("countMatchingLinks / countLinksTo", () => {
  const links = [
    link("Docs", "https://example.org/docs"),
    link("Docs", "https://example.org/docs", 10),
    link("Home", "https://example.com/"),
  ];
  it("counts label+destination matches", () => {
    expect(countMatchingLinks(links, { text: "Docs", url: "https://example.org/docs" })).toBe(2);
    expect(countMatchingLinks(links, { text: "Doc", url: "https://example.org/docs" })).toBe(0);
  });
  it("counts destinations and treats a bare origin with or without slash as equal", () => {
    expect(countLinksTo(links, "https://example.com")).toBe(1);
    expect(countLinksTo(links, "https://example.org/docs")).toBe(2);
    expect(countLinksTo(links, "https://example.net")).toBe(0);
  });
});

describe("verifyLinkReadback", () => {
  const existing = [link("Old", "https://example.net/old")];
  const hyper = buildLinkInsertion({ mode: "hyperlink", url: "https://example.org/x", label: "X" });
  const bare = buildLinkInsertion({ mode: "raw", url: "https://example.com" });
  const plain = buildLinkInsertion({ mode: "raw", url: "https://example.com/p", linked: false });

  it("accepts exactly one new matching run and reports the stored destination", () => {
    expect(
      verifyLinkReadback(
        existing,
        [...existing, link("X", "https://example.org/x", 5)],
        hyper,
        "https://example.org/x"
      )
    ).toEqual({ linkStored: true, storedUrl: "https://example.org/x" });
  });

  it("reports Notes' normalized bare origin as the stored URL", () => {
    expect(
      verifyLinkReadback(
        [],
        [link("https://example.com", "https://example.com/")],
        bare,
        "https://example.com"
      )
    ).toEqual({ linkStored: true, storedUrl: "https://example.com/" });
  });

  it("fails when the link is missing or duplicated", () => {
    expect(() => verifyLinkReadback(existing, existing, hyper, "https://example.org/x")).toThrow(
      "not found"
    );
    expect(() =>
      verifyLinkReadback(
        existing,
        [...existing, link("X", "https://example.org/x"), link("X", "https://example.org/x", 9)],
        hyper,
        "https://example.org/x"
      )
    ).toThrow("not found");
  });

  it("fails when an existing link disappeared", () => {
    expect(() =>
      verifyLinkReadback(
        existing,
        [link("X", "https://example.org/x")],
        hyper,
        "https://example.org/x"
      )
    ).toThrow("existing link changed");
  });

  it("reports an unlinked raw URL as plain text", () => {
    expect(verifyLinkReadback(existing, existing, plain, "https://example.com/p")).toEqual({
      linkStored: false,
    });
  });

  it("reports honestly when Notes stored a link for plain text anyway", () => {
    expect(
      verifyLinkReadback(
        existing,
        [...existing, link("https://example.com/p", "https://example.com/p")],
        plain,
        "https://example.com/p"
      )
    ).toEqual({ linkStored: true, storedUrl: "https://example.com/p" });
  });
});
