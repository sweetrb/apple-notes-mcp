/** Deliberately bounded Markdown subset for Notes append. Reject richer syntax before writing. */
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Convert the supported bounded Markdown subset to semantic Apple Notes HTML. */
export function appendMarkdownHtml(markdown: string): string {
  if (markdown.includes("\uE000") || markdown.includes("\uE001"))
    throw new Error("Unsupported reserved characters");
  if (Array.from(markdown).some((c) => c.charCodeAt(0) < 32 && !["\n", "\r", "\t"].includes(c)))
    throw new Error("Unsupported control characters");
  if (/[`~|]|^#{4,}\s|^\s*>|^\s*\[.+\]:|!\[|<\/?[a-z]/im.test(markdown))
    throw new Error(
      "Markdown append supports paragraphs, headings, flat lists, emphasis and inline links; use semantic HTML for other formatting"
    );
  const inline = (text: string) => {
    const links: string[] = [];
    let value = text.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_s, label: string, url: string) => {
      if (!/^(https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url))
        throw new Error("Unsupported Markdown link URL");
      links.push(`<a href="${escape(url)}">${escape(label)}</a>`);
      return `\uE000${links.length - 1}\uE001`;
    });
    value = escape(value)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
    if (value.includes("[") || value.includes("]") || value.includes("*"))
      throw new Error("Unsupported or unbalanced Markdown inline syntax");
    return value.replace(/\uE000(\d+)\uE001/g, (_s, i: string) => links[Number(i)]);
  };
  let html = "",
    list: "ul" | "ol" | undefined;
  const close = () => {
    if (list) {
      html += `</${list}>`;
      list = undefined;
    }
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s{2,}\S/.test(line)) throw new Error("Nested lists and indented code are unsupported");
    const heading = /^(#{1,3})\s+(.+)$/.exec(line),
      item = /^(?:([-+*])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) {
        close();
        list = kind;
        html += `<${kind}>`;
      }
      html += `<li>${inline(item[2])}</li>`;
      continue;
    }
    close();
    html += heading
      ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`
      : line.trim()
        ? `<div>${inline(line)}</div>`
        : "<div><br></div>";
  }
  close();
  return html;
}
