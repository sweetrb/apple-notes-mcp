import { describe, it, expect } from "vitest";
import {
  appendMarkdownHtml,
  renderMarkdown,
  usesMarkdownBlocks,
  withoutMarkdownCode,
} from "./appendMarkdown.js";
describe("bounded Markdown for verified append", () => {
  it("renders paragraphs, visible blank lines, a heading, emphasis and flat lists", () =>
    expect(appendMarkdownHtml("# План\n\n**Далее**\n- один\n- два")).toBe(
      "<h1>План</h1><div><br></div><div><b>Далее</b></div><ul><li>один</li><li>два</li></ul>"
    ));
  it("preserves inline project tags with underscores", () =>
    expect(appendMarkdownHtml("#систематизация_заметок")).toContain("#систематизация_заметок"));
  it("preserves real link destinations and escapes labels", () =>
    expect(appendMarkdownHtml("[A & B](notes://showNote?identifier=ABC)")).toBe(
      '<div><a href="notes://showNote?identifier=ABC">A &amp; B</a></div>'
    ));
  it.each([
    "```code```",
    "  - nested",
    "| a | b |",
    "<script>x</script>",
    "[x](file:///tmp/x)",
    "bad\u00010\u0002",
  ])("rejects unsupported constructs before any mutation: %s", (text) =>
    expect(() => appendMarkdownHtml(text)).toThrow()
  );
});

describe("Markdown for Notes' own importer (create-note blocks)", () => {
  const blocks = { blocks: true };
  it("renders quotes, fenced code, checklist items, dividers and inline code with native expectations", () => {
    const rendered = renderMarkdown(
      "Intro with `inline_code` here\n\n> first *quoted* line\n> second line\n\n```\nconst a_b = 1;\n  indented <tag> **literal**\n```\n\n- [ ] open task\n- [x] done task\n\n---\n\nAfter",
      blocks
    );
    expect(rendered.html).toBe(
      "<div>Intro with <code>inline_code</code> here</div><div><br></div>" +
        "<blockquote><div>first <i>quoted</i> line</div><div>second line</div></blockquote><div><br></div>" +
        "<pre>const a_b = 1;\n  indented &lt;tag&gt; **literal**</pre><div><br></div>" +
        '<ul class="checklist"><li>open task</li><li>done task</li></ul><div><br></div>' +
        "<hr><div><br></div><div>After</div>"
    );
    expect(rendered.expect).toEqual({
      quotes: ["first quoted line second line"],
      code: ["const a_b = 1;\n  indented <tag> **literal**"],
      checklist: [
        { text: "open task", done: false },
        { text: "done task", done: true },
      ],
      dividers: 1,
      highlights: ["inline_code"],
    });
  });
  it("keeps separate quote blocks apart and allows a divider first", () => {
    expect(renderMarkdown("---\n\n> one\n\n> two", blocks).expect).toMatchObject({
      quotes: ["one", "two"],
      dividers: 1,
    });
  });
  it("renders the pre-existing subset exactly as the append path does", () => {
    const text = "# План\n\n**Далее**\n- один\n1. два\n[A & B](notes://showNote?identifier=ABC)";
    expect(renderMarkdown(text, blocks).html).toBe(appendMarkdownHtml(text));
  });
  it.each([
    ["> quote", /Markdown append supports/],
    ["```\ncode\n```", /Markdown append supports/],
    ["- [ ] task", /unbalanced/],
    ["text with `code`", /Markdown append supports/],
  ])("still refuses %s on the append path, whose converter flattens it", (text, error) =>
    expect(() => appendMarkdownHtml(text)).toThrow(error)
  );
  it.each([
    ["```js\ncode\n```", /Markdown import supports/],
    ["```\ncode", /Unclosed fenced code block/],
    ["```\n```", /Empty fenced code blocks/],
    [">> nested", /Markdown import supports/],
    ["  > indented", /Markdown import supports/],
    [">", /Empty block quote lines/],
    ["> - list in quote", /text and inline formatting only/],
    ["> # heading in quote", /text and inline formatting only/],
    ["> quoted\nlazy continuation", /End a block quote with a blank line/],
    ["Setext heading\n---", /blank line before a --- divider/],
    ["- [ ] task\n- bullet", /Separate checklist items/],
    ["- bullet\n- [x] task", /Separate checklist items/],
    ["- [X] upper", /unbalanced/],
    ["* [ ] star", /unbalanced/],
    ["pad ` code ` here", /start or end with a space/],
    ["[`label`](https://example.com)", /Inline code inside a link/],
    ["~~strike~~", /Markdown import supports/],
    ["| a | b |", /Markdown import supports/],
    ["unbalanced ` tick", /Markdown import supports/],
    ["reserved ", /reserved/],
  ])("refuses %s before anything is written", (text, error) =>
    expect(() => renderMarkdown(text, blocks)).toThrow(error)
  );
  it("detects which Markdown needs the native-import gate", () => {
    expect(usesMarkdownBlocks("## Heading\n\n- item\n**bold** [x](https://a.example)")).toBe(false);
    for (const text of ["> q", "`c`", "```\nc\n```", "---", "- [ ] t", "- [x] t"])
      expect(usesMarkdownBlocks(text)).toBe(true);
  });
  it("blanks only literal code before syntax checks, line for line", () =>
    expect(withoutMarkdownCode("a `_x_` b\n```\n\\* <div>\n```\nc")).toBe("a x b\n\n\n\nc"));
});
