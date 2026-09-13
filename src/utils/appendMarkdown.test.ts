import { describe, it, expect } from "vitest";
import { appendMarkdownHtml } from "./appendMarkdown.js";
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
