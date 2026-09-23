import { describe, it, expect } from "vitest";
import {
  appendMarkdownHtml,
  countTaskItems,
  stripDuplicateTitleHeading,
  TASK_GLYPHS,
} from "./appendMarkdown.js";

describe("task glyph rendering for the HTML Markdown route", () => {
  it("renders bullet task items as list rows that start with a visible glyph", () => {
    expect(
      appendMarkdownHtml("- [ ] draft\n* [x] ship\n+ [X] [link](https://x.test)", {
        taskGlyphs: true,
      })
    ).toBe(
      `<ul><li>${TASK_GLYPHS.open} draft</li><li>${TASK_GLYPHS.done} ship</li><li>${TASK_GLYPHS.done} <a href="https://x.test">link</a></li></ul>`
    );
  });

  it("keeps refusing task items without the option", () => {
    expect(() => appendMarkdownHtml("- [ ] draft")).toThrow(/unbalanced Markdown inline syntax/);
  });

  it("does not treat ordered items or an empty task as tasks", () => {
    expect(() => appendMarkdownHtml("1. [ ] draft", { taskGlyphs: true })).toThrow();
    expect(() => appendMarkdownHtml("- [ ]", { taskGlyphs: true })).toThrow();
  });

  it.each(["> quote", "```\ncode\n```", "run `ls`"])(
    "still refuses the Shortcut-only block construct %j with task glyphs on",
    (text) => expect(() => appendMarkdownHtml(text, { taskGlyphs: true })).toThrow()
  );

  it("keeps a --- line as literal text, not a divider, with task glyphs on", () =>
    expect(appendMarkdownHtml("a\n\n---", { taskGlyphs: true })).toBe(
      "<div>a</div><div><br></div><div>---</div>"
    ));

  it("counts only bullet task items", () => {
    expect(countTaskItems("- [ ] a\r\n- [x] b\n- c\n1. [ ] d\ntext [ ] e")).toBe(2);
  });
});

describe("stripDuplicateTitleHeading", () => {
  it("removes an exact `# <title>` line and one blank line", () => {
    expect(stripDuplicateTitleHeading("# Plan\n\n\nBody", "Plan")).toEqual({
      content: "\nBody",
      stripped: true,
    });
    expect(stripDuplicateTitleHeading("\uFEFF# Plan\r\nBody", "Plan")).toEqual({
      content: "Body",
      stripped: true,
    });
  });

  it("keeps headings that differ in case, spacing, or level", () => {
    for (const source of [
      "# plan\nBody",
      "#  Plan\nBody",
      "## Plan\nBody",
      "# Plan \nBody",
      "Body\n# Plan",
    ])
      expect(stripDuplicateTitleHeading(source, "Plan")).toEqual({
        content: source,
        stripped: false,
      });
  });
});
