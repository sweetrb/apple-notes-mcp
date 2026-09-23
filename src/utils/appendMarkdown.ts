/** Deliberately bounded Markdown subset for Notes append. Reject richer syntax before writing. */
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Visible characters that stand in for Markdown task items on the HTML route. */
export const TASK_GLYPHS = { open: "☐", done: "☑" } as const;

/** A `- [ ] text` / `- [x] text` task item, as matched after the list marker. */
const TASK_ITEM = /^\[([ xX])\][ \t]+(\S.*)$/;

export interface MarkdownHtmlOptions {
  /**
   * Render bullet task items (`- [ ]`, `- [x]`) as ordinary list rows that
   * start with a visible ☐ / ☑ character. HTML cannot create native checklist
   * paragraphs, so without this the brackets are refused as unsupported syntax.
   */
  taskGlyphs?: boolean;
}

/**
 * Remove a leading `# <title>` line that duplicates a separately supplied note
 * title, plus one blank line after it. The match is exact (case and
 * whitespace) so a different first heading stays in the body.
 */
export function stripDuplicateTitleHeading(
  markdown: string,
  title: string
): { content: string; stripped: boolean } {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0] !== `# ${title}`) return { content: markdown, stripped: false };
  const rest = lines.slice(lines.length > 1 && lines[1] === "" ? 2 : 1);
  return { content: rest.join("\n"), stripped: true };
}

/** Count bullet task items the HTML route would render as glyph rows. */
export function countTaskItems(markdown: string): number {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const item = /^[-+*]\s+(.+)$/.exec(line);
      return item !== null && TASK_ITEM.test(item[1]);
    }).length;
}

/**
 * What Notes' own Markdown importer (the Create Note action with "Interpret as
 * Markdown") must produce for the block constructs it maps to native styles, so
 * a created note can be checked construct by construct after readback:
 *
 * - `> text` lines become Body paragraphs with a block-quote level of 1;
 * - a fenced ```` ``` ```` block becomes Monospaced paragraphs;
 * - `- [ ] item` / `- [x] item` become native checklist items with that done state;
 * - a `---` line becomes a native divider-line attachment;
 * - `` `inline code` `` becomes highlighted text, not monospace.
 */
export interface MarkdownBlockExpectations {
  quotes: string[];
  code: string[];
  checklist: Array<{ text: string; done: boolean }>;
  dividers: number;
  highlights: string[];
}

export interface RenderedMarkdown {
  html: string;
  expect: MarkdownBlockExpectations;
}

const FENCE = "```";
const CHECKLIST_ITEM = /^- \[( |x)\] (.+)$/;

/**
 * Blank out what CommonMark keeps literal (fenced code lines and inline code
 * spans) so the syntax checks never refuse, say, an underscore inside code.
 * Lines are preserved one for one, so line-anchored patterns still line up.
 */
export function withoutMarkdownCode(markdown: string): string {
  let inCode = false;
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (line === FENCE) {
        inCode = !inCode;
        return "";
      }
      return inCode ? "" : line.replace(/`[^`\n]+`/g, "x");
    })
    .join("\n");
}

/** True when Markdown uses a construct only the native-import path accepts. */
export function usesMarkdownBlocks(markdown: string): boolean {
  return (
    /`/.test(markdown) ||
    /^>/m.test(markdown) ||
    /^---[ \t]*$/m.test(markdown) ||
    /^- \[[ x]\] /m.test(markdown)
  );
}

/**
 * Convert the supported bounded Markdown subset to semantic Apple Notes HTML.
 *
 * With `blocks`, also accept the constructs Notes' own importer maps to native
 * styles (block quotes, fenced code, checklist items, dividers and inline
 * code); `expect` then describes the native result the importer must produce.
 * Without it, those constructs are refused, as the append path needs.
 */
export function renderMarkdown(
  markdown: string,
  options: MarkdownHtmlOptions & { blocks?: boolean } = {}
): RenderedMarkdown {
  const blocks = options.blocks === true;
  if (blocks ? /[-]/u.test(markdown) : /[]/u.test(markdown))
    throw new Error("Unsupported reserved characters");
  if (Array.from(markdown).some((c) => c.charCodeAt(0) < 32 && !["\n", "\r", "\t"].includes(c)))
    throw new Error("Unsupported control characters");
  const checked = blocks ? withoutMarkdownCode(markdown) : markdown;
  if (
    blocks
      ? /[`~|]|^#{4,}\s|^[ \t]+>|^>[ \t]*>|^\s*\[.+\]:|!\[|<\/?[a-z]/im.test(checked)
      : /[`~|]|^#{4,}\s|^\s*>|^\s*\[.+\]:|!\[|<\/?[a-z]/im.test(checked)
  )
    throw new Error(
      blocks
        ? "Markdown import supports paragraphs, headings, flat lists, checklist items, block quotes, fenced code, dividers, emphasis, inline code and inline links; use semantic HTML for other formatting"
        : "Markdown append supports paragraphs, headings, flat lists, emphasis and inline links; use semantic HTML for other formatting"
    );
  const expect: MarkdownBlockExpectations = {
    quotes: [],
    code: [],
    checklist: [],
    dividers: 0,
    highlights: [],
  };
  const inline = (text: string) => {
    const spans: string[] = [];
    let value = text;
    if (blocks)
      value = value.replace(/`([^`\n]+)`/g, (_s, code: string) => {
        // CommonMark trims one space from each side of a padded span; refuse
        // the ambiguity rather than guess what Notes keeps.
        if (/^\s|\s$/.test(code)) throw new Error("Inline code cannot start or end with a space");
        expect.highlights.push(code);
        spans.push(`<code>${escape(code)}</code>`);
        return `${spans.length - 1}`;
      });
    const links: string[] = [];
    value = value.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_s, label: string, url: string) => {
      if (!/^(https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url))
        throw new Error("Unsupported Markdown link URL");
      if (/[]/u.test(label)) throw new Error("Inline code inside a link is unsupported");
      links.push(`<a href="${escape(url)}">${escape(label)}</a>`);
      return `${links.length - 1}`;
    });
    value = escape(value)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
    if (value.includes("[") || value.includes("]") || value.includes("*"))
      throw new Error("Unsupported or unbalanced Markdown inline syntax");
    return value
      .replace(/(\d+)/g, (_s, i: string) => links[Number(i)])
      .replace(/(\d+)/g, (_s, i: string) => spans[Number(i)]);
  };
  // Visible text of the markup built above, for readback comparison only. A
  // character scan drops tags; the result is compared, never emitted as HTML.
  const withoutTags = (html: string) => {
    let text = "",
      inTag = false;
    for (const ch of html) {
      if (ch === "<") inTag = true;
      else if (ch === ">" && inTag) inTag = false;
      else if (!inTag) text += ch;
    }
    return text;
  };
  const visible = (html: string) =>
    withoutTags(html)
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  let html = "",
    list: "ul" | "ol" | "checklist" | undefined,
    quote = false,
    code: string[] | undefined,
    previousBlank = true;
  const close = () => {
    if (list) {
      html += list === "checklist" ? "</ul>" : `</${list}>`;
      list = undefined;
    }
    if (quote) {
      html += "</blockquote>";
      quote = false;
    }
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (code) {
      if (line === FENCE) {
        if (!code.length) throw new Error("Empty fenced code blocks are unsupported");
        html += `<pre>${escape(code.join("\n"))}</pre>`;
        expect.code.push(code.join("\n"));
        code = undefined;
        previousBlank = false;
      } else code.push(line);
      continue;
    }
    const blank = !line.trim();
    if (blocks) {
      if (quote && !blank && !line.startsWith(">"))
        // CommonMark would carry this line into the quote (lazy continuation).
        throw new Error("End a block quote with a blank line before other text");
      if (line.startsWith(FENCE)) {
        if (line !== FENCE)
          throw new Error("Fenced code must open and close with a bare ``` line (no language)");
        close();
        code = [];
        continue;
      }
      if (line.startsWith(">")) {
        const text = line.replace(/^> ?/, "");
        if (!text.trim()) throw new Error("Empty block quote lines are unsupported");
        if (/^(?:#|[-+*][ \t]|\d+[.)][ \t]|>|```)/.test(text))
          throw new Error("Block quotes support text and inline formatting only");
        if (!quote) {
          close();
          html += "<blockquote>";
          quote = true;
          expect.quotes.push("");
        }
        const rendered = inline(text);
        html += `<div>${rendered}</div>`;
        expect.quotes[expect.quotes.length - 1] += ` ${visible(rendered)}`;
        previousBlank = false;
        continue;
      }
      if (/^---[ \t]*$/.test(line)) {
        // After a text line, `---` would turn that line into a heading instead.
        if (!previousBlank) throw new Error("Put a blank line before a --- divider");
        close();
        html += "<hr>";
        expect.dividers++;
        previousBlank = false;
        continue;
      }
      const task = CHECKLIST_ITEM.exec(line);
      if (task) {
        if (list && list !== "checklist")
          throw new Error("Separate checklist items from other list items with a blank line");
        if (list !== "checklist") {
          close();
          list = "checklist";
          html += '<ul class="checklist">';
        }
        const rendered = inline(task[2]);
        html += `<li>${rendered}</li>`;
        expect.checklist.push({ text: visible(rendered).trim(), done: task[1] === "x" });
        previousBlank = false;
        continue;
      }
    }
    if (/^\s{2,}\S/.test(line)) throw new Error("Nested lists and indented code are unsupported");
    const heading = /^(#{1,3})\s+(.+)$/.exec(line),
      item = /^(?:([-+*])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (list === "checklist")
        throw new Error("Separate checklist items from other list items with a blank line");
      if (list !== kind) {
        close();
        list = kind;
        html += `<${kind}>`;
      }
      const task = options.taskGlyphs && item[1] ? TASK_ITEM.exec(item[2]) : null;
      html += task
        ? `<li>${task[1] === " " ? TASK_GLYPHS.open : TASK_GLYPHS.done} ${inline(task[2])}</li>`
        : `<li>${inline(item[2])}</li>`;
      previousBlank = false;
      continue;
    }
    close();
    html += heading
      ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`
      : !blank
        ? `<div>${inline(line)}</div>`
        : "<div><br></div>";
    previousBlank = blank;
  }
  if (code) throw new Error("Unclosed fenced code block");
  close();
  expect.quotes = expect.quotes.map((q) => q.trim());
  return { html, expect };
}

/**
 * Convert the bounded append subset of Markdown to semantic Apple Notes HTML.
 * Block quotes, fenced code, dividers and inline code are refused here; with
 * `taskGlyphs`, bullet task items become ☐ / ☑ glyph rows (the HTML route).
 */
export function appendMarkdownHtml(markdown: string, options: MarkdownHtmlOptions = {}): string {
  return renderMarkdown(markdown, { taskGlyphs: options.taskGlyphs }).html;
}
