/** Deliberately bounded Markdown subset for Notes append. Reject richer syntax before writing. */
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  options: { blocks?: boolean } = {}
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
  const visible = (html: string) =>
    html
      .replace(/<[^>]*>/g, "")
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
      html += `<li>${inline(item[2])}</li>`;
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

/** Convert the bounded append subset of Markdown to semantic Apple Notes HTML. */
export function appendMarkdownHtml(markdown: string): string {
  return renderMarkdown(markdown).html;
}
