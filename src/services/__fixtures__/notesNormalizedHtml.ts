/**
 * Golden fixtures: representative Apple Notes-normalized HTML and the Markdown
 * the server currently produces from it via `getNoteMarkdown` / Turndown.
 *
 * Apple Notes rewrites HTML on save: it wraps blocks in `<div>` instead of `<p>`,
 * inserts `<div><br></div>` spacer rows between sections, and emits its own tag
 * soup when a note is read back. These fixtures capture that normalized shape so
 * the Markdown conversion is regression-locked. If a change to the `notesDivs`
 * Turndown rule (or a dependency bump) alters the output, the snapshot test that
 * consumes these fixtures will fail loudly instead of silently shifting behavior.
 *
 * The `expectedMarkdown` values are the conversion's *current* output, including
 * two known quirks worth being explicit about:
 *   - A `<div><br></div>` spacer becomes a stray `  ` (two-space) line, the
 *     Markdown-side fingerprint of the whitespace-accumulation behavior the
 *     project's CLAUDE.md documents.
 *   - `<tt>` is dropped: its text survives but the code styling does not
 *     round-trip to Markdown.
 *
 * These are characterization tests. They document what the code does today; they
 * are not an assertion that the current output is ideal.
 */
export interface NotesHtmlFixture {
  /** Short identifier, also used as the test case name. */
  name: string;
  /** What normalized shape this case represents. */
  description: string;
  /** Notes-normalized HTML, as returned by AppleScript `body of note`. */
  html: string;
  /** Markdown currently produced by getNoteMarkdown for the HTML above. */
  expectedMarkdown: string;
}

export const NOTES_NORMALIZED_HTML_FIXTURES: NotesHtmlFixture[] = [
  {
    name: "headingAndParagraphs",
    description: "An <h1> title and two <div> paragraphs separated by a spacer row",
    html: "<div><h1>Meeting Notes</h1></div><div>First line.</div><div><br></div><div>Second line.</div>",
    expectedMarkdown: "# Meeting Notes\n\nFirst line.\n  \n\nSecond line.",
  },
  {
    name: "bulletList",
    description: "An <h2> section heading followed by a native <ul> bullet list",
    html: "<div><h2>Tasks</h2></div><ul><li>Buy milk</li><li>Walk dog</li></ul>",
    expectedMarkdown: "## Tasks\n\n-   Buy milk\n-   Walk dog",
  },
  {
    name: "inlineEmphasis",
    description: "Inline <b> and <i> emphasis inside a paragraph div",
    html: "<div>This is <b>bold</b> and <i>italic</i> text.</div>",
    expectedMarkdown: "This is **bold** and _italic_ text.",
  },
  {
    name: "codeSpan",
    description: "A <tt> code span — the tag is dropped, only its text survives",
    html: "<div>Run <tt>npm install</tt> first.</div>",
    expectedMarkdown: "Run npm install first.",
  },
  {
    name: "spacerRuns",
    description: "Consecutive <div><br></div> spacer rows between two paragraphs",
    html: "<div>A</div><div><br></div><div><br></div><div>B</div>",
    expectedMarkdown: "A\n  \n\n  \n\nB",
  },
];
