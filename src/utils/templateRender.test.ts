/**
 * Template-driven Markdown rendering. Fixtures are synthetic block models.
 * The parity cases prove `standard-markdown` reproduces the fixed renderer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { emptyStats, type ExportContext } from "./exportRender.js";
import type { AssetLocator, AssetWriter } from "./exportAssets.js";
import { renderNotesMarkdown } from "./markdownExport.js";
import {
  builtinTemplate,
  resolveTemplate,
  type PortableTemplate,
  type ResolvedTemplate,
} from "./markdownTemplate.js";
import {
  applyRule,
  attachmentRuleId,
  isImageUrl,
  isMapUrl,
  noteTags,
  renderNotesWithTemplate,
  type TemplateRenderOptions,
} from "./templateRender.js";
import { attachment, attachmentRun, block, exportNote } from "./fixtures/exportNote.js";
import type { ExportNote } from "./noteExportData.js";

const tableHex = readFileSync(
  new URL("./fixtures/background-probe-table.gz", import.meta.url)
).toString("hex");
const ctx = (): ExportContext => ({ stats: emptyStats() });
const standard = () => resolveTemplate(builtinTemplate("standard-markdown"));
const custom = (overrides: Omit<PortableTemplate, "schemaVersion">): ResolvedTemplate =>
  resolveTemplate({ schemaVersion: 1, ...overrides });
const render = (
  notes: ExportNote[],
  template: ResolvedTemplate,
  extra: Partial<TemplateRenderOptions> = {},
  c: ExportContext = ctx()
) => renderNotesWithTemplate(notes, c, { template, ...extra });

const kitchenSink = () =>
  exportNote([
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
      { text: "hi2", highlight: "blue" },
      { text: "up", superscript: true },
      { text: "down", subscript: true },
      { text: "red", color: "#FF0000", bold: true },
      { text: "plain", bold: true },
      { text: "link ", link: "https://x.test/a b", linkSafe: true },
      { text: "bold", link: "https://x.test/a b", linkSafe: true, bold: true },
      { text: " unsafe", link: "tel:1", linkSafe: false },
      { text: "odd", highlight: "unknown" },
    ]),
    block("   "),
    block("a", "unknown"),
  ]);

const attachmentsNote = () =>
  exportNote(
    [
      block("Intro ￼ and ￼", "body", {}, [
        { text: "Intro " },
        attachmentRun("TAG", "com.apple.notes.inlinetextattachment.hashtag"),
        { text: " and " },
        attachmentRun("IMG"),
      ]),
      block("before￼after", "body", {}, [
        { text: "before" },
        attachmentRun("TBL", "com.apple.notes.table"),
        { text: "after" },
      ]),
      block("￼", "body", {}, [
        attachmentRun("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
      ]),
      block("item ￼", "bulleted", {}, [{ text: "item " }, attachmentRun("MISSING")]),
      block("see ￼", "body", { blockQuote: true }, [
        { text: "see " },
        attachmentRun("LINK", "com.apple.notes.inlinetextattachment.link"),
      ]),
      block("￼", "body", {}, [attachmentRun("GAL", "com.apple.notes.gallery")]),
      block("￼ ￼", "body", {}, [
        attachmentRun("CARD", "public.url"),
        { text: " " },
        attachmentRun("TEL", "public.url"),
      ]),
    ],
    [
      attachment("TAG", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#tag" }),
      attachment("IMG", "public.jpeg", { title: "photo.jpg" }),
      attachment("TBL", "com.apple.notes.table", { tableData: tableHex }),
      attachment("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
      attachment("LINK", "com.apple.notes.inlinetextattachment.link", {
        altText: "Other",
        tokenId: "applenotes:note/1",
      }),
      attachment("GAL", "com.apple.notes.gallery", {
        children: [
          attachment("G1", "public.png"),
          attachment("G2", "com.apple.paper.doc.scan", { title: "Scan" }),
        ],
      }),
      attachment("CARD", "public.url", { url: "https://e.test/x", title: "E" }),
      attachment("TEL", "public.url", { url: "tel:1", title: "Call" }),
      attachment("EXTRA", "com.adobe.pdf"),
      attachment("AUDIO", "com.apple.m4a-audio", { mediaFilename: "a.m4a" }),
    ],
    "Stored *title*"
  );

describe("standard-markdown parity with the fixed renderer", () => {
  const cases: Array<[string, () => ExportNote[]]> = [
    ["styles, lists, quotes, code and inline formats", () => [kitchenSink()]],
    ["attachments as placeholders", () => [attachmentsNote()]],
    ["several notes", () => [exportNote([block("A", "title")]), exportNote([block("B")], [], "B")]],
    ["no notes", () => []],
    [
      "body and list text that looks like block syntax",
      () => [
        exportNote([
          block("T", "title"),
          block("## not a heading"),
          block("---"),
          block("## q", "body", { blockQuote: true }),
          block("## item text", "dashed"),
          block("1. item text", "numbered"),
          block("## Notes", "bulleted"),
          block("1. x", "dashed"),
          block("---", "numbered"),
          block("- item text", "checklist", { checklist: { id: "a", done: false } }),
          block("alpha beta ## gamma delta"),
        ]),
      ],
    ],
    [
      "adjacent emphasis",
      () => [
        exportNote([
          block("T", "title"),
          block("ab", "body", {}, [
            { text: "a", bold: true },
            { text: "b", italic: true },
            { text: "c", strikethrough: true, highlight: "blue" },
            { text: "d", highlight: "blue" },
            { text: "e", highlight: "purple" },
          ]),
        ]),
      ],
    ],
  ];
  for (const [name, notes] of cases)
    it(name, () => {
      const fixed = ctx();
      const templated = ctx();
      const expected = renderNotesMarkdown(notes(), fixed);
      const actual = render(notes(), standard(), {}, templated);
      expect(actual.markdown).toBe(expected);
      expect(templated.stats).toEqual(fixed.stats);
      expect(render(notes(), standard(), { wrap: 12 }).markdown).toBe(
        renderNotesMarkdown(notes(), ctx(), { wrap: 12 })
      );
    });

  it("matches when assets are placed through a writer", () => {
    const writer = (): AssetWriter => ({
      count: 0,
      place: (a) => ({ url: `assets/${a.name}`, mime: "image/png" }),
    });
    const locator = {
      locate: (a: { id: string }) =>
        a.id === "EXTRA"
          ? {}
          : {
              primary: { path: `/lib/${a.id}`, name: `${a.id} y.bin`, role: "original" },
              preview: { path: `/lib/${a.id}.png`, name: "preview", role: "preview" },
            },
    } as unknown as AssetLocator;
    const fixed = { stats: emptyStats(), writer: writer(), locator };
    const expected = renderNotesMarkdown([attachmentsNote()], fixed);
    const templated = { stats: emptyStats(), locator };
    const actual = render(
      [attachmentsNote()],
      standard(),
      { assetsFor: () => ({ writer: writer() }) },
      templated
    );
    expect(actual.markdown).toBe(expected);
    expect(templated.stats).toEqual(fixed.stats);
    expect(actual.warnings).toEqual([
      {
        code: "attachment_not_found",
        noteId: "x-coredata://FIXTURE/ICNote/p1",
        attachmentId: "MISSING",
      },
      { code: "missing_asset", noteId: "x-coredata://FIXTURE/ICNote/p1", attachmentId: "EXTRA" },
    ]);
  });
});

describe("template rules", () => {
  it("nests inline wrappers in inlineOrder (editorial blue highlight outermost)", () => {
    const template = custom({
      inlineOrder: [
        // The order documented in docs/markdown-templates.md.
        "subscript",
        "superscript",
        "underline",
        "strikethrough",
        "bold",
        "italic",
        "color",
        "link",
        "highlight",
      ],
      rules: {
        "inline.highlight.blue": { mode: "wrap", before: "[callout]", after: "[/callout]" },
      },
    });
    const note = exportNote([
      block("T", "title"),
      block("x", "body", {}, [
        { text: "contents", bold: true, highlight: "blue" },
        { text: " and ", highlight: "blue" },
        { text: "pink", highlight: "pink" },
      ]),
    ]);
    expect(render([note], template).markdown).toBe(
      "# T\n\n[callout]**contents** and[/callout] ==pink==\n"
    );
  });

  it("applies color, highlight and link placeholders, and omit drops a run", () => {
    const template = custom({
      rules: {
        "inline.color": {
          mode: "wrap",
          before: '<span style="color:{{color}}">',
          after: "</span>",
        },
        "inline.highlight.mint": {
          mode: "pattern",
          value: "<mark class={{highlight}}>{{content}}</mark>",
        },
        "inline.link": { mode: "pattern", value: "<{{url}}|{{content}}>" },
        "inline.strikethrough": { mode: "omit" },
        "inline.underline": { mode: "plain" },
      },
    });
    const note = exportNote([
      block("T", "title"),
      block("x", "body", {}, [
        { text: "a", color: "#112233" },
        { text: "b", color: "#445566" },
        { text: "m", highlight: "mint" },
        { text: "gone", strikethrough: true },
        { text: "u", underline: true },
        { text: "go", link: "https://g.test/(x)", linkSafe: true },
      ]),
    ]);
    expect(render([note], template).markdown).toBe(
      '# T\n\n<span style="color:#112233">a</span><span style="color:#445566">b</span>' +
        "<mark class=mint>m</mark>u<https://g.test/%28x%29|go>\n"
    );
  });

  it("renders blocks, lists, quotes and code through custom rules", () => {
    const template = custom({
      options: { listIndent: "\t", titleFallback: false },
      rules: {
        "block.title": { mode: "omit" },
        "block.heading": { mode: "pattern", value: "== {{content}} ==" },
        "block.body": { mode: "plain", join: "line" },
        "block.bulleted": { mode: "wrap", before: "* ", after: "" },
        "block.numbered": { mode: "pattern", value: "{{index}}) {{content}}", join: "line" },
        "block.checklist.checked": { mode: "pattern", value: "[{{checked}}] {{content}}" },
        "block.code": { mode: "wrap", before: "<pre>\n", after: "\n</pre>" },
        "paragraph.quote": { mode: "wrap", before: "<q>", after: "</q>" },
      },
    });
    const note = exportNote(
      [
        block("Stored", "title"),
        block("H", "heading"),
        block("p1"),
        block("p2"),
        block("b", "bulleted"),
        block("n1", "numbered"),
        block("n2", "numbered", { indent: 2 }),
        block("c", "checklist", { checklist: { id: "c", done: true } }),
        block("code", "monospaced"),
        block("q1", "body", { blockQuote: true }),
        block("q2", "body", { blockQuote: true }),
      ],
      [],
      "Other"
    );
    expect(render([note], template).markdown).toBe(
      [
        "== H ==",
        "",
        "p1",
        "p2",
        "",
        "* b",
        "",
        "1) n1",
        "\t\t1) n2",
        "",
        "[true] c",
        "",
        "<pre>\ncode\n</pre>",
        "",
        "<q>q1</q>",
        "<q>q2</q>",
        "",
      ].join("\n")
    );
  });

  it("drops quoted blocks when paragraph.quote is omitted and skips empty output", () => {
    const template = custom({
      rules: { "paragraph.quote": { mode: "omit" }, "block.subheading": { mode: "plain" } },
    });
    const note = exportNote([
      block("T", "title"),
      block("q", "body", { blockQuote: true }),
      block("s", "subheading"),
    ]);
    expect(render([note], template).markdown).toBe("# T\n\ns\n");
  });

  it("uses the trimmed prefix between quoted paragraphs", () => {
    const template = custom({ rules: { "paragraph.quote": { mode: "linePrefix", value: "| " } } });
    const note = exportNote([
      block("T", "title"),
      block("a", "body", { blockQuote: true }),
      block("b", "body", { blockQuote: true }),
    ]);
    expect(render([note], template).markdown).toBe("# T\n\n| a\n|\n| b\n");
  });

  it("writes headers, footers and separators with note metadata", () => {
    const template = custom({
      rules: {
        "document.header": {
          mode: "pattern",
          value:
            "---\ntitle: {{title:yaml}}\ntags: {{tags:yaml}}\nfolder: {{folder:yaml}}\nmissing: {{account:yaml}}\n---\n",
        },
        "document.footer": {
          mode: "wrap",
          before: "\n<!-- {{id}} {{uuid}} {{created}} {{modified}} ",
          after: "-->",
        },
        "document.separator": {
          mode: "pattern",
          value: "\n\n<!-- next: {{title}} in {{exportStem}} -->\n\n",
        },
      },
    });
    const first = exportNote(
      [
        block("A: *b*", "title"),
        block("￼ ￼ ￼", "body", {}, [
          attachmentRun("T1", "com.apple.notes.inlinetextattachment.hashtag"),
          { text: " " },
          attachmentRun("T2", "com.apple.notes.inlinetextattachment.hashtag"),
          { text: " " },
          attachmentRun("T3", "com.apple.notes.inlinetextattachment.hashtag"),
        ]),
      ],
      [
        attachment("T1", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#work" }),
        attachment("T2", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#work" }),
        attachment("T3", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#a_b" }),
      ]
    );
    const second = {
      ...exportNote([block("Next *", "title")]),
      id: "x-coredata://FIXTURE/ICNote/p2",
    };
    const result = render([first, second], template, {
      exportStem: "out",
      metaFor: (note) =>
        note === first
          ? {
              folder: 'Q "1"',
              uuid: "U-1",
              created: "2026-01-02T03:04:05Z",
              modified: "2026-02-03T04:05:06Z",
            }
          : {},
    });
    expect(result.markdown).toBe(
      [
        "---",
        'title: "A: *b*"',
        'tags: ["work","a_b"]',
        'folder: "Q \\"1\\""',
        "missing: null",
        "---",
        "# A: \\*b\\*",
        "",
        "#work #work #a\\_b",
        "<!-- x-coredata://FIXTURE/ICNote/p1 U-1 2026-01-02T03:04:05Z 2026-02-03T04:05:06Z -->",
        "",
        "<!-- next: Next \\* in out -->",
        "",
        "---",
        'title: "Next *"',
        "tags: []",
        "folder: null",
        "missing: null",
        "---",
        "# Next \\*",
        "<!-- x-coredata://FIXTURE/ICNote/p2    -->",
        "",
      ].join("\n")
    );
    expect(noteTags(first)).toEqual(["work", "a_b"]);
  });

  it("leaves note boundaries empty when document rules omit", () => {
    const template = custom({
      rules: {
        "document.separator": { mode: "omit" },
        "document.header": { mode: "omit" },
        "document.footer": { mode: "omit" },
      },
    });
    const notes = [exportNote([block("A", "title")]), exportNote([block("B", "title")])];
    expect(render(notes, template).markdown).toBe("# A# B\n");
  });
});

describe("attachments through templates", () => {
  const writer = (): AssetWriter => ({
    count: 0,
    place: (a) => ({ url: `x/${a.name}`, mime: "" }),
  });
  const locator = {
    locate: () => ({ primary: { path: "/lib/f", name: "f.bin", role: "original" } }),
  } as unknown as AssetLocator;

  it("renders every attachment rule with its placeholders", () => {
    const template = custom({
      rules: {
        "attachment.image": {
          mode: "pattern",
          value: "{{kind}}|{{uti}}|{{filename}}|{{alt}}|{{path}}",
        },
        "attachment.audio": { mode: "pattern", value: "<audio src={{path:raw}}>" },
        "attachment.table": { mode: "wrap", before: "<!-- table -->\n", after: "" },
        "attachment.divider": { mode: "pattern", value: "***" },
        "attachment.gallery": {
          mode: "wrap",
          before: "<gallery>\n",
          after: "\n</gallery>",
          join: "line",
        },
        "attachment.url": { mode: "pattern", value: "<{{url}}> {{alt}}" },
        "attachment.placeholder": { mode: "pattern", value: "(missing: {{content}})" },
      },
    });
    const note = exportNote(
      [
        block("￼", "body", {}, [attachmentRun("IMG")]),
        block("￼", "body", {}, [attachmentRun("AUD", "com.apple.m4a-audio")]),
        block("￼", "body", {}, [attachmentRun("TBL", "com.apple.notes.table")]),
        block("￼", "body", {}, [
          attachmentRun("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
        ]),
        block("￼", "body", {}, [attachmentRun("GAL", "com.apple.notes.gallery")]),
        block("￼", "body", {}, [attachmentRun("URL", "public.url")]),
        block("￼", "body", {}, [attachmentRun("GONE")]),
      ],
      [
        attachment("IMG", "public.png", { mediaFilename: "a_b.png" }),
        attachment("AUD", "com.apple.m4a-audio"),
        attachment("TBL", "com.apple.notes.table", { tableData: tableHex }),
        attachment("DIV", "com.apple.notes.inlinetextattachment.dividerline"),
        attachment("GAL", "com.apple.notes.gallery", {
          children: [attachment("G1", "public.png"), attachment("G2", "public.png")],
        }),
        attachment("URL", "public.url", { url: "https://e.test/a", title: "E*" }),
      ],
      "T"
    );
    const out = render(
      [note],
      template,
      { assetsFor: () => ({ writer: writer() }) },
      {
        stats: emptyStats(),
        locator,
      }
    );
    expect(out.markdown).toBe(
      [
        "# T",
        "",
        "image|public.png|a\\_b.png|Image|x/f.bin",
        "",
        "<audio src=x/f.bin>",
        "",
        "<!-- table -->\n| Имя | Статус |\n| --- | --- |\n| Проба 🧭 | Готово |",
        "",
        "***",
        "",
        "<gallery>\nimage|public.png||Image|x/f.bin\nimage|public.png||Image|x/f.bin\n</gallery>",
        "",
        "<https://e.test/a> E\\*",
        "",
        "(missing: Attachment unavailable)",
        "",
      ].join("\n")
    );
  });

  it("omits attachments by rule or asset mode without placing files", () => {
    let placed = 0;
    const counting: AssetWriter = {
      count: 0,
      place: () => {
        placed++;
        return { url: "x", mime: "" };
      },
    };
    const note = exportNote(
      [
        block("keep ￼ ￼ ￼", "body", {}, [
          { text: "keep " },
          attachmentRun("IMG"),
          { text: " " },
          attachmentRun("TAG", "com.apple.notes.inlinetextattachment.hashtag"),
          { text: " " },
          attachmentRun("URL", "public.url"),
        ]),
        block("￼", "body", {}, [attachmentRun("GAL", "com.apple.notes.gallery")]),
      ],
      [
        attachment("IMG", "public.png"),
        attachment("TAG", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#t" }),
        attachment("URL", "public.url", { url: "https://e.test", title: "E" }),
        attachment("GAL", "com.apple.notes.gallery", { children: [attachment("G", "public.png")] }),
      ],
      "T"
    );
    const byRule = custom({
      rules: { "attachment.image": { mode: "omit" }, "attachment.gallery": { mode: "omit" } },
    });
    const byAssets = custom({ assets: { mode: "omit" } });
    for (const template of [byRule, byAssets]) {
      const out = render(
        [note],
        template,
        { assetsFor: () => ({ writer: counting }) },
        {
          stats: emptyStats(),
          locator,
        }
      );
      expect(out.markdown).toBe("# T\n\nkeep  #t [E](https://e.test)\n");
      expect(out.warnings).toEqual([]);
    }
    expect(placed).toBe(0);
  });

  it("renders image-URL cards as images with an italic caption, and map links", () => {
    const template = custom({
      options: { richLinkImages: true, richLinkImageCaption: "followingItalicParagraph" },
      rules: {
        "attachment.url.image": { mode: "pattern", value: "![{{alt}}]({{url}})<{{caption}}>" },
        "attachment.map": { mode: "pattern", value: "map:{{url}}" },
      },
    });
    const note = exportNote(
      [
        block("￼", "body", {}, [attachmentRun("PIC", "public.url")]),
        block("A *caption*", "body", {}, [{ text: "A *caption*", italic: true }]),
        block("￼", "body", {}, [attachmentRun("PIC2", "public.url")]),
        block("not italic"),
        block("￼", "body", {}, [attachmentRun("MAP", "public.url")]),
        block("￼", "body", {}, [attachmentRun("PIC3", "public.url")]),
        block("quoted", "body", { blockQuote: true }, [{ text: "quoted", italic: true }]),
      ],
      [
        attachment("PIC", "public.url", { url: "https://i.test/a%20b.PNG?x=1", title: "Pic" }),
        attachment("PIC2", "public.url", { url: "https://i.test/b.jpg", title: "Pic2" }),
        attachment("MAP", "public.url", { url: "https://maps.apple.com/?q=x", title: "Place" }),
        attachment("PIC3", "public.url", { url: "https://i.test/c.gif", title: "Pic3" }),
      ],
      "T"
    );
    expect(render([note], template).markdown).toBe(
      [
        "# T",
        "",
        "![A \\*caption\\*](https://i.test/a%20b.PNG?x=1)<A \\*caption\\*>",
        "",
        "![Pic2](https://i.test/b.jpg)<>",
        "",
        "not italic",
        "",
        "map:https://maps.apple.com/?q=x",
        "",
        "![Pic3](https://i.test/c.gif)<>",
        "",
        "> *quoted*",
        "",
      ].join("\n")
    );
  });

  it("does not take a caption when image links are off or the rule is omitted", () => {
    const note = exportNote(
      [
        block("￼", "body", {}, [attachmentRun("PIC", "public.url")]),
        block("cap", "body", {}, [{ text: "cap", italic: true }]),
      ],
      [attachment("PIC", "public.url", { url: "https://i.test/a.png", title: "Pic" })],
      "T"
    );
    const off = custom({ options: { richLinkImageCaption: "followingItalicParagraph" } });
    expect(render([note], off).markdown).toBe("# T\n\n[Pic](https://i.test/a.png)\n\n*cap*\n");
    const omitted = custom({
      options: { richLinkImages: true, richLinkImageCaption: "followingItalicParagraph" },
      rules: { "attachment.url.image": { mode: "omit" } },
    });
    expect(render([note], omitted).markdown).toBe("# T\n\n*cap*\n");
  });

  it("warns about missing tokens, bad tables, copy failures, empty galleries and missing asset dirs", () => {
    const failing: AssetWriter = { count: 0, place: () => ({ error: "unreadable" }) };
    const note = exportNote(
      [
        block("￼￼￼￼￼", "body", {}, [
          attachmentRun("TOK", "com.apple.notes.inlinetextattachment.mention"),
          attachmentRun("BAD", "com.apple.notes.table"),
          attachmentRun("IMG"),
          attachmentRun("GAL", "com.apple.notes.gallery"),
          attachmentRun("FILE", "public.data"),
        ]),
      ],
      [
        attachment("TOK", "com.apple.notes.inlinetextattachment.mention"),
        attachment("BAD", "com.apple.notes.table", { tableData: "00" }),
        attachment("IMG", "public.png"),
        attachment("GAL", "com.apple.notes.gallery"),
        attachment("FILE", "public.data"),
      ],
      "T"
    );
    const id = note.id;
    const copied = render(
      [note],
      standard(),
      { assetsFor: () => ({ writer: failing }) },
      {
        stats: emptyStats(),
        locator,
      }
    );
    expect(copied.warnings.map((w) => [w.code, w.attachmentId])).toEqual([
      ["inline_token_metadata_missing", "TOK"],
      ["table_decode_failed", "BAD"],
      ["asset_copy_failed", "IMG"],
      ["gallery_children_missing", "GAL"],
      ["asset_copy_failed", "FILE"],
    ]);
    expect(copied.warnings.every((w) => w.noteId === id)).toBe(true);
    const required = render([note], standard(), { assetsFor: () => ({ required: true }) });
    expect(
      required.warnings.filter((w) => w.code === "assets_dir_required").map((w) => w.attachmentId)
    ).toEqual(["IMG", "GAL", "FILE"]);
  });
});

describe("helpers", () => {
  it("applies each rule mode", () => {
    expect(applyRule({ mode: "omit" }, "x", {})).toBeUndefined();
    expect(applyRule({ mode: "plain" }, "x", {})).toBe("x");
    expect(applyRule({ mode: "wrap", before: "<{{content}}", after: ">" }, "x", {})).toBe("<xx>");
    expect(applyRule({ mode: "pattern", value: "{{content}}!" }, "x", {})).toBe("x!");
    expect(applyRule({ mode: "linePrefix", value: "> " }, "a\n\nb", {})).toBe("> a\n>\n> b");
  });

  it("classifies image and map URLs", () => {
    expect(isImageUrl("https://x.test/p/a.JPEG#f")).toBe(true);
    expect(isImageUrl("https://x.test/a%2Epng")).toBe(true);
    expect(isImageUrl("https://x.test/%E0%A4%A.png")).toBe(true);
    expect(isImageUrl("https://x.test/a.png.html")).toBe(false);
    expect(isImageUrl("ftp://x.test/a.png")).toBe(false);
    expect(isImageUrl("not a url")).toBe(false);
    expect(isMapUrl("https://beta.maps.apple.com/x")).toBe(true);
    expect(isMapUrl("https://example.com/maps")).toBe(false);
    expect(isMapUrl("::")).toBe(false);
  });

  it("maps kinds to rules; inline tokens have none", () => {
    const t = standard();
    expect(
      attachmentRuleId(attachment("A", "com.apple.notes.inlinetextattachment.hashtag"), t)
    ).toBeUndefined();
    expect(attachmentRuleId(attachment("A", "com.apple.drawing.2"), t)).toBe(
      "attachment.drawing.classic"
    );
    expect(attachmentRuleId(attachment("A", "com.apple.paper"), t)).toBe(
      "attachment.drawing.paper"
    );
    expect(
      attachmentRuleId(attachment("A", "public.url", { url: "https://i.test/a.png" }), t)
    ).toBe("attachment.url");
    expect(attachmentRuleId({ ...attachment("A", "x"), kind: "mystery" as never }, t)).toBe(
      "attachment.other"
    );
    expect(attachmentRuleId(attachment("A", "public.url"), t)).toBe("attachment.url");
  });

  it("uses the obsidian built-in's front matter and copies-beside-output directory", () => {
    const obsidian = resolveTemplate(builtinTemplate("obsidian"), "obsidian");
    expect(obsidian.assets).toEqual({
      mode: "copy",
      pathStyle: "relative",
      directory: "{{exportStem}}.assets",
    });
    const out = render([exportNote([block("N", "title")])], obsidian, {
      metaFor: () => ({ uuid: "U", created: "2026-01-01T00:00:00Z" }),
    }).markdown;
    expect(out).toBe(
      '---\ntitle: "N"\ncreated: "2026-01-01T00:00:00Z"\nmodified: null\nfolder: null\ntags: []\nnote-id: "U"\n---\n\n# N\n'
    );
  });
});
