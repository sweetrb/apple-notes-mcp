/**
 * Markdown rendering of decoded notes. Fixtures are synthetic block models.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { emptyStats, type ExportContext } from "./exportRender.js";
import type { AssetLocator, AssetWriter } from "./exportAssets.js";
import {
  escapeMarkdown,
  linkDestination,
  NOTE_SEPARATOR,
  planMarkdown,
  renderNoteMarkdown,
  renderNotesMarkdown,
  tableMarkdown,
  wrapMarkdown,
} from "./markdownExport.js";
import { attachment, attachmentRun, block, exportNote } from "./fixtures/exportNote.js";

const tableHex = readFileSync(
  new URL("./fixtures/background-probe-table.gz", import.meta.url)
).toString("hex");
const ctx = (): ExportContext => ({ stats: emptyStats() });

describe("escaping", () => {
  it("escapes Markdown punctuation, entities and highlight markers", () => {
    expect(escapeMarkdown("a*b_c`d[e]f<g>h~i|j\\k")).toBe(
      "a\\*b\\_c\\`d\\[e\\]f\\<g\\>h\\~i\\|j\\\\k"
    );
    expect(escapeMarkdown("AT&T &amp; ==x==")).toBe("AT&T &amp;amp; \\=\\=x\\=\\=");
    expect(linkDestination("https://x.test/a b(c)<d>")).toBe("https://x.test/a%20b%28c%29%3Cd%3E");
  });
});

describe("planMarkdown", () => {
  it("renders every plan type", () => {
    expect(planMarkdown({ type: "inline", text: "#tag" })).toBe("#tag");
    expect(planMarkdown({ type: "inline", text: "Other", link: "applenotes:note/1" })).toBe(
      "[Other](applenotes:note/1)"
    );
    expect(planMarkdown({ type: "divider" })).toBe("---");
    expect(planMarkdown({ type: "placeholder", label: "Image", name: "a_b.png" })).toBe(
      "\\[Image: a\\_b.png\\]"
    );
    expect(planMarkdown({ type: "placeholder", label: "PDF" })).toBe("\\[PDF\\]");
    expect(planMarkdown({ type: "unavailable", label: "File", reason: "missing" })).toBe(
      "\\[File unavailable\\]"
    );
    expect(
      planMarkdown({ type: "asset", label: "Image", display: "image", url: "a b.png", mime: "" })
    ).toBe("![Image](a%20b.png)");
    expect(
      planMarkdown({
        type: "asset",
        label: "PDF",
        name: "doc",
        display: "link",
        url: "d.pdf",
        mime: "",
      })
    ).toBe("[doc](d.pdf)");
    expect(
      planMarkdown({
        type: "asset",
        label: "Scanned document",
        display: "link",
        url: "s.pdf",
        previewUrl: "s.png",
        mime: "",
      })
    ).toBe("[![Scanned document](s.png)](s.pdf)");
    expect(
      planMarkdown({
        type: "card",
        title: "E",
        url: "https://e.test",
        displayUrl: "https://e.test",
      })
    ).toBe("[E](https://e.test)");
    expect(planMarkdown({ type: "card", title: "Call", displayUrl: "tel:1" })).toBe("Call (tel:1)");
    expect(
      planMarkdown({
        type: "gallery",
        items: [
          { type: "placeholder", label: "Image" },
          { type: "placeholder", label: "Image" },
        ],
      })
    ).toBe("\\[Image\\]\n\n\\[Image\\]");
    expect(planMarkdown({ type: "table", rows: [["a"]] })).toBe("| a |\n| --- |");
  });

  it("renders GitHub tables with ragged rows, pipes and line breaks", () => {
    expect(tableMarkdown([["h|1", "h2"], ["x\ny"], []])).toBe(
      "| h\\|1 | h2 |\n| --- | --- |\n| x<br>y |   |\n|   |   |"
    );
    expect(tableMarkdown([])).toBe("|   |\n| --- |");
  });
});

describe("renderNoteMarkdown", () => {
  it("renders styles, lists, checklists, quotes, code and inline formatting", () => {
    const note = exportNote([
      block("Title", "title"),
      block("Heading", "heading"),
      block("Sub", "subheading"),
      block("Plain *text*"),
      block(""),
      block("one", "numbered"),
      block("two", "numbered"),
      block("nested", "numbered", { indent: 1 }),
      block("three", "numbered"),
      block("dash", "dashed"),
      block("bullet", "bulleted", { indent: 1 }),
      block("done", "checklist", { checklist: { id: "a", done: true } }),
      block("todo", "checklist", { checklist: { id: "b", done: false } }),
      block("after list"),
      block("again", "numbered"),
      block("quoted one", "body", { blockQuote: true }),
      block("quoted two", "body", { blockQuote: true }),
      block("let x = ```y```;", "monospaced"),
      block("more();", "monospaced"),
      block("q();", "monospaced", { blockQuote: true }),
      block("# not heading"),
      block("1. not list"),
      block("fmt", "body", {}, [
        { text: " bold ", bold: true },
        { text: "it", italic: true },
        { text: "both", bold: true, italic: true },
        { text: "strike", strikethrough: true },
        { text: "under", underline: true },
        { text: "hi", highlight: "pink" },
        { text: "up", superscript: true },
        { text: "down", subscript: true },
        { text: "link ", link: "https://x.test/a b", linkSafe: true },
        { text: "bold", link: "https://x.test/a b", linkSafe: true, bold: true },
        { text: " unsafe", link: "tel:1", linkSafe: false },
      ]),
      block("   "),
    ]);
    expect(renderNoteMarkdown(note, ctx())).toBe(
      [
        "# Title",
        "",
        "## Heading",
        "",
        "### Sub",
        "",
        "Plain \\*text\\*",
        "",
        "1. one",
        "2. two",
        "    1. nested",
        "3. three",
        "- dash",
        "    - bullet",
        "- [x] done",
        "- [ ] todo",
        "",
        "after list",
        "",
        "1. again",
        "",
        "> quoted one",
        ">",
        "> quoted two",
        "",
        "````",
        "let x = ```y```;",
        "more();",
        "````",
        "",
        "> ```",
        "> q();",
        "> ```",
        "",
        "\\# not heading",
        "",
        "1\\. not list",
        "",
        "**bold** *it**both***~~strike~~<u>under</u>==hi==<sup>up</sup><sub>down</sub>[link **bold**](https://x.test/a%20b) unsafe",
      ].join("\n")
    );
  });

  it("keeps adjacent emphasis runs from merging", () => {
    const note = exportNote([
      block("T", "title"),
      block("ab", "body", {}, [
        { text: "a", bold: true },
        { text: "b", italic: true },
        { text: "c", strikethrough: true, highlight: "blue" },
        { text: "d", highlight: "blue" },
      ]),
    ]);
    expect(renderNoteMarkdown(note, ctx())).toBe("# T\n\n**a**<!-- -->*b*~~==c==~~==d==");
  });

  it("adds a title when the body has none and places attachments in body order", () => {
    const note = exportNote(
      [
        block("Intro \ufffc and \ufffc", "body", {}, [
          { text: "Intro " },
          attachmentRun("TAG", "com.apple.notes.inlinetextattachment.hashtag"),
          { text: " and " },
          attachmentRun("IMG"),
        ]),
        block("before\ufffcafter", "body", {}, [
          { text: "before" },
          attachmentRun("TBL", "com.apple.notes.table"),
          { text: "after" },
        ]),
        block("\ufffc", "body", {}, [
          attachmentRun("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
        ]),
        block("item \ufffc", "bulleted", {}, [{ text: "item " }, attachmentRun("MISSING")]),
      ],
      [
        attachment("TAG", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#tag" }),
        attachment("IMG", "public.jpeg", { title: "photo.jpg" }),
        attachment("TBL", "com.apple.notes.table", { tableData: tableHex }),
        attachment("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
        attachment("EXTRA", "com.adobe.pdf"),
      ],
      "Stored *title*"
    );
    const c = ctx();
    expect(renderNoteMarkdown(note, c)).toBe(
      [
        "# Stored \\*title\\*",
        "",
        "Intro #tag and \\[Image: photo.jpg\\]",
        "",
        "before",
        "",
        "| Имя | Статус |\n| --- | --- |\n| Проба 🧭 | Готово |",
        "",
        "after",
        "",
        "---",
        "",
        "- item \\[Attachment unavailable\\]",
        "",
        "\\[PDF\\]",
      ].join("\n")
    );
    expect(c.stats).toMatchObject({ tables: 1, placeholders: 2, unavailable: 1, unreferenced: 1 });
  });

  it("links exported assets through the writer", () => {
    const writer: AssetWriter = {
      count: 0,
      place: (a) => ({ url: `assets/${a.name}`, mime: "image/png" }),
    };
    const locator = {
      locate: () => ({ primary: { path: "/lib/x.png", name: "x y.png", role: "original" } }),
    } as unknown as AssetLocator;
    const note = exportNote(
      [block("\ufffc", "body", {}, [attachmentRun("IMG")])],
      [attachment("IMG", "public.png")],
      "T"
    );
    expect(renderNoteMarkdown(note, { stats: emptyStats(), writer, locator })).toBe(
      "# T\n\n![Image](assets/x%20y.png)"
    );
  });
});

describe("wrapMarkdown and multi-note documents", () => {
  it("wraps prose, list items and quotes but leaves code, tables and headings", () => {
    const md = [
      "# a heading that is long enough to wrap",
      "alpha beta gamma delta epsilon",
      "- [ ] one two three four five six",
      "> quoted words that go past",
      "```",
      "code line that is quite long indeed",
      "```",
      "| a | table row that is long |",
      "short",
      "superlongwordthatcannotbreak",
    ].join("\n");
    expect(wrapMarkdown(md, 20)).toBe(
      [
        "# a heading that is long enough to wrap",
        "alpha beta gamma",
        "delta epsilon",
        "- [ ] one two three",
        "      four five six",
        "> quoted words that",
        "> go past",
        "```",
        "code line that is quite long indeed",
        "```",
        "| a | table row that is long |",
        "short",
        "superlongwordthatcannotbreak",
      ].join("\n")
    );
    expect(wrapMarkdown(md, 0)).toBe(md);
  });

  it("joins notes with a separator and ends with a newline", () => {
    const notes = [exportNote([block("A", "title")]), exportNote([block("B", "title")])];
    expect(renderNotesMarkdown(notes, ctx())).toBe(`# A${NOTE_SEPARATOR}# B\n`);
    expect(renderNotesMarkdown(notes, ctx(), { wrap: 40 })).toBe(`# A${NOTE_SEPARATOR}# B\n`);
    expect(renderNotesMarkdown([], ctx())).toBe("");
  });
});
