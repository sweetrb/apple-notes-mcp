/**
 * Standalone HTML rendering of decoded notes. Fixtures are synthetic block
 * models; locator and writer are in-memory fakes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { emptyStats, type AttachmentPlan, type ExportContext } from "./exportRender.js";
import type { AssetLocator, AssetWriter } from "./exportAssets.js";
import {
  blockPlanHtml,
  escapeHtml,
  inlinePlanHtml,
  isHtmlBlockPlan,
  renderNoteHtml,
  renderNotesHtml,
  tableHtml,
} from "./htmlExport.js";
import { attachment, attachmentRun, block, exportNote } from "./fixtures/exportNote.js";

const tableHex = readFileSync(
  new URL("./fixtures/background-probe-table.gz", import.meta.url)
).toString("hex");
const ctx = (): ExportContext => ({ stats: emptyStats() });

/** Every opening tag of these names has a matching closing tag. */
function balanced(html: string): boolean {
  return [
    "ul",
    "ol",
    "li",
    "blockquote",
    "table",
    "tr",
    "figure",
    "p",
    "pre",
    "article",
    "a",
  ].every(
    (tag) =>
      (html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length ===
      (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length
  );
}

describe("escaping and tables", () => {
  it("escapes text and attribute characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("renders semantic tables with a header row", () => {
    expect(tableHtml([["h<1>", "h2"], ["a\nb"]])).toBe(
      "<table><thead><tr><th>h&lt;1&gt;</th><th>h2</th></tr></thead>" +
        "<tbody><tr><td>a<br>b</td><td></td></tr></tbody></table>"
    );
    expect(tableHtml([])).toBe("<table><thead><tr><th></th></tr></thead><tbody></tbody></table>");
  });
});

describe("attachment plans", () => {
  const image: AttachmentPlan = {
    type: "asset",
    label: "Image",
    name: 'a"b',
    display: "image",
    url: "data:image/png;base64,AA==",
    mime: "image/png",
  };

  it("separates block plans from inline plans", () => {
    expect(isHtmlBlockPlan({ type: "table", rows: [] })).toBe(true);
    expect(isHtmlBlockPlan({ type: "divider" })).toBe(true);
    expect(isHtmlBlockPlan({ type: "gallery", items: [] })).toBe(true);
    expect(isHtmlBlockPlan({ type: "card", title: "", displayUrl: "" })).toBe(true);
    expect(isHtmlBlockPlan(image)).toBe(true);
    expect(isHtmlBlockPlan({ ...image, display: "link" })).toBe(false);
    expect(isHtmlBlockPlan({ ...image, display: "link", previewUrl: "p.png" })).toBe(true);
    expect(isHtmlBlockPlan({ type: "inline", text: "" })).toBe(false);
  });

  it("renders inline plans", () => {
    expect(inlinePlanHtml({ type: "inline", text: "#t<" })).toBe("#t&lt;");
    expect(inlinePlanHtml({ type: "inline", text: "Other", link: "applenotes:note/1" })).toBe(
      '<a href="applenotes:note/1">Other</a>'
    );
    expect(inlinePlanHtml({ type: "placeholder", label: "Image", name: "x" })).toBe(
      '<span class="attachment-placeholder">[Image: x]</span>'
    );
    expect(inlinePlanHtml({ type: "unavailable", label: "PDF", reason: "too-large" })).toBe(
      '<span class="attachment-unavailable" role="note">[PDF unavailable (too large to embed; export with embedAssets false)]</span>'
    );
    expect(
      inlinePlanHtml({ type: "unavailable", label: "File", reason: "missing", name: "f" })
    ).toBe('<span class="attachment-unavailable" role="note">[File unavailable: f]</span>');
    expect(inlinePlanHtml({ ...image, display: "link", url: "a b.pdf" })).toBe(
      '<a class="attachment attachment-file" href="a b.pdf">a&quot;b</a>'
    );
    expect(inlinePlanHtml({ type: "divider" })).toBe("<hr>");
  });

  it("renders block plans", () => {
    expect(blockPlanHtml(image)).toBe(
      '<figure class="attachment attachment-image"><img src="data:image/png;base64,AA==" alt="a&quot;b" loading="lazy"></figure>'
    );
    expect(blockPlanHtml({ ...image, display: "audio", name: undefined })).toBe(
      '<figure class="attachment attachment-audio"><audio controls preload="metadata" src="data:image/png;base64,AA=="></audio></figure>'
    );
    expect(blockPlanHtml({ ...image, display: "video", name: "v" })).toContain(
      '<video controls preload="metadata" src="data:image/png;base64,AA=="></video><figcaption>v</figcaption>'
    );
    expect(
      blockPlanHtml({ ...image, display: "link", name: "s", url: "s.pdf", previewUrl: "s.png" })
    ).toBe(
      '<figure class="attachment attachment-document"><a href="s.pdf"><img src="s.png" alt="s" loading="lazy"></a><figcaption><a href="s.pdf">s</a></figcaption></figure>'
    );
    expect(
      blockPlanHtml({
        type: "card",
        title: "Example",
        url: "https://www.example.com/x",
        displayUrl: "https://www.example.com/x",
        previewUrl: "p.png",
      })
    ).toBe(
      '<a class="link-card" href="https://www.example.com/x"><img src="p.png" alt="" loading="lazy"><span class="link-card-text"><span class="link-card-title">Example</span><span class="link-card-domain">www.example.com</span></span></a>'
    );
    expect(blockPlanHtml({ type: "card", title: "Call", displayUrl: "not a url" })).toBe(
      '<div class="link-card"><span class="link-card-text"><span class="link-card-title">Call</span><span class="link-card-domain">not a url</span></span></div>'
    );
    expect(
      blockPlanHtml({ type: "gallery", items: [image, { type: "placeholder", label: "Image" }] })
    ).toBe(
      `<div class="attachment-gallery">${blockPlanHtml(image)}<span class="attachment-placeholder">[Image]</span></div>`
    );
    expect(blockPlanHtml({ type: "table", rows: [["a"]] })).toBe(tableHtml([["a"]]));
    expect(blockPlanHtml({ type: "placeholder", label: "PDF" })).toBe(
      '<p><span class="attachment-placeholder">[PDF]</span></p>'
    );
    // A file without a preview has no block form (#210): it used to throw.
    expect(blockPlanHtml({ ...image, display: "link", name: "s", url: "s.pdf" })).toBe(
      '<p><a class="attachment attachment-file" href="s.pdf">s</a></p>'
    );
  });
});

describe("renderNoteHtml", () => {
  it("renders styles, nested lists, checklists, quotes, code and inline formatting", () => {
    const note = exportNote([
      block("Title", "title"),
      block("Heading", "heading", { alignment: "center" }),
      block("Sub", "subheading"),
      block("Plain <b>"),
      block(""),
      block("one", "numbered"),
      block("nested", "bulleted", { indent: 1 }),
      block("deep", "bulleted", { indent: 3 }),
      block("two", "numbered"),
      block("dash", "dashed"),
      block("done", "checklist", { checklist: { id: "a", done: true } }),
      block("todo", "checklist", { checklist: { id: "b", done: false } }),
      block("quoted", "body", { blockQuote: true }),
      block("in quote", "bulleted", { blockQuote: true }),
      block("a < b", "monospaced"),
      block("c", "monospaced"),
      block("fmt", "body", {}, [
        { text: "b", bold: true },
        { text: "i", italic: true },
        { text: "u", underline: true },
        { text: "s", strikethrough: true },
        { text: "h", highlight: "mint" },
        { text: "x", highlight: "unknown" },
        { text: "up", superscript: true },
        { text: "dn", subscript: true },
        { text: "red", color: "#FF0000" },
        { text: "bad", color: "red;background:url(x)" },
        { text: "link", link: "https://x.test/?a=1&b=2", linkSafe: true },
        { text: "js", link: "javascript:alert(1)", linkSafe: false },
      ]),
      block("last", "bulleted"),
    ]);
    const html = renderNoteHtml(note, ctx());
    expect(html).toBe(
      [
        '<article class="note">',
        "<h1>Title</h1>",
        '<h2 style="text-align:center">Heading</h2>',
        "<h3>Sub</h3>",
        "<p>Plain &lt;b&gt;</p>",
        "<ol>",
        "<li>one",
        "<ul>",
        "<li>nested",
        '<ul><li class="nest">',
        "<ul>",
        "<li>deep",
        "</li></ul>",
        "</li></ul>",
        "</li></ul>",
        "</li>",
        "<li>two",
        "</li></ol>",
        '<ul class="dashed">',
        "<li>dash",
        "</li></ul>",
        '<ul class="checklist">',
        '<li class="done"><input type="checkbox" disabled checked> done',
        "</li>",
        '<li><input type="checkbox" disabled> todo',
        "</li></ul>",
        "<blockquote>",
        "<p>quoted</p>",
        "<ul>",
        "<li>in quote",
        "</li></ul>",
        "</blockquote>",
        "<pre><code>a &lt; b\nc</code></pre>",
        '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><mark class="hl-mint">h</mark><mark class="hl-other">x</mark><sup>up</sup><sub>dn</sub><span style="color:#FF0000">red</span>bad<a href="https://x.test/?a=1&amp;b=2">link</a>js</p>',
        "<ul>",
        "<li>last",
        "</li></ul>",
        "</article>",
      ].join("\n")
    );
    expect(balanced(html)).toBe(true);
  });

  it("places attachments in body order, adds a missing title and appends unreferenced ones", () => {
    const note = exportNote(
      [
        block("intro ￼ tag ￼ end", "body", {}, [
          { text: "intro " },
          attachmentRun("IMG"),
          { text: " tag " },
          attachmentRun("TAG", "com.apple.notes.inlinetextattachment.hashtag"),
          { text: " end" },
        ]),
        block("￼", "body", {}, [attachmentRun("TBL", "com.apple.notes.table")]),
        block("item ￼", "bulleted", {}, [{ text: "item " }, attachmentRun("URL", "public.url")]),
        block("￼", "body", {}, [attachmentRun("GONE")]),
      ],
      [
        attachment("IMG", "public.png", { title: "pic.png" }),
        attachment("TAG", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#t" }),
        attachment("TBL", "com.apple.notes.table", { tableData: tableHex }),
        attachment("URL", "public.url", { url: "https://e.test/p", title: "E" }),
        attachment("EXTRA", "public.data", { title: "x.bin" }),
      ],
      "Stored"
    );
    const writer: AssetWriter = {
      count: 0,
      place: (a) => ({ url: `data:image/png;base64,${a.name}`, mime: "image/png" }),
    };
    const locator = {
      locate: (a: { id: string }) =>
        a.id === "IMG" ? { primary: { path: "/x", name: "QQ==", role: "original" } } : {},
    } as unknown as AssetLocator;
    const c: ExportContext = { stats: emptyStats(), writer, locator };
    const html = renderNoteHtml(note, c);
    expect(html).toContain("<h1>Stored</h1>\n<p>intro</p>\n<figure");
    expect(html).toContain('alt="pic.png"');
    expect(html).toContain("<p>tag #t end</p>");
    expect(html).toContain("<table><thead><tr><th>Имя</th>");
    expect(html).toContain('<li>item<a class="link-card" href="https://e.test/p">');
    expect(html).toContain(
      '<p><span class="attachment-unavailable" role="note">[Attachment unavailable]</span></p>'
    );
    expect(html).toContain("[File unavailable: x.bin]");
    expect(html).not.toMatch(/file:|\/x"/);
    expect(balanced(html)).toBe(true);
    expect(c.stats).toMatchObject({ placed: 1, tables: 1, unavailable: 2, unreferenced: 1 });
  });
});

describe("unreferenced attachments (#210)", () => {
  it("renders an unreferenced file with no preview as a link instead of throwing", () => {
    const note = exportNote(
      [block("Stored", "title"), block("text")],
      [attachment("PDF", "com.adobe.pdf", { title: "report.pdf" })]
    );
    const writer: AssetWriter = {
      count: 0,
      place: (a) => ({ url: `assets/${a.name}`, mime: "application/pdf" }),
    };
    const locator = {
      locate: () => ({ primary: { path: "/r", name: "report.pdf", role: "original" } }),
    } as unknown as AssetLocator;
    const c: ExportContext = { stats: emptyStats(), writer, locator };
    const html = renderNoteHtml(note, c);
    expect(html).toContain(
      '<p><a class="attachment attachment-file" href="assets/report.pdf">report.pdf</a></p>'
    );
    expect(c.stats.unreferenced).toBe(1);
  });
});

describe("stale renderings", () => {
  it("counts a Notes rendering taken from an older generation in the export stats", () => {
    const note = exportNote(
      [
        block("Sketch", "title"),
        block("\ufffc", "body", {}, [attachmentRun("D", "com.apple.paper")]),
      ],
      [attachment("D", "com.apple.paper")]
    );
    const writer: AssetWriter = {
      count: 0,
      place: (a) => ({ url: `assets/${a.name}`, mime: "image/png" }),
    };
    const locator = (stale: boolean) =>
      ({
        locate: () => ({
          primary: {
            path: "/p",
            name: "paper.png",
            role: "fallback",
            ...(stale ? { stale: true } : {}),
          },
        }),
      }) as unknown as AssetLocator;
    const fresh: ExportContext = { stats: emptyStats(), writer, locator: locator(false) };
    renderNoteHtml(note, fresh);
    expect(fresh.stats).not.toHaveProperty("staleRenderings");
    const old: ExportContext = { stats: emptyStats(), writer, locator: locator(true) };
    renderNoteHtml(note, old);
    expect(old.stats.staleRenderings).toBe(1);
  });
});

describe("renderNotesHtml", () => {
  it("builds one standalone document with separators and no script", () => {
    const html = renderNotesHtml(
      [
        exportNote([block("A", "title")]),
        exportNote([block("B", "title"), block("x", "numbered")]),
      ],
      ctx(),
      { title: "Folder <1>" }
    );
    expect(html.startsWith('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">')).toBe(true);
    expect(html).toContain("<title>Folder &lt;1&gt;</title>");
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html.match(/<hr class="note-separator">/g)).toHaveLength(1);
    expect(html).not.toContain("<script");
    expect(html.endsWith("</html>\n")).toBe(true);
    expect(balanced(html)).toBe(true);
  });
});
