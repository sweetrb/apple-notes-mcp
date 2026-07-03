export const NOTES_NORMALIZED_HTML_FIXTURES = [
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
