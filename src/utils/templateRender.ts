/**
 * Template-driven Markdown rendering of decoded notes.
 *
 * Walks the same block model and attachment plans as the fixed renderer in
 * markdownExport.ts, but every block style, inline format, attachment, the
 * per-note header and footer, and the note separator come from a
 * {@link ResolvedTemplate}. With the built-in `standard-markdown` template the
 * output is identical to `renderNotesMarkdown`.
 *
 * Inline formats nest in the template's `inlineOrder`: each format spans every
 * adjacent run that shares it, outermost first. A format whose rule is
 * `plain` does not split runs; one whose rule is `omit` drops the run.
 *
 * Problems that do not stop the export (a missing attachment file, an
 * undecodable table) are collected as warnings with the note id and the
 * attachment id.
 *
 * @module utils/templateRender
 */
import type { NoteBlock } from "./noteBlocks.js";
import type { ExportAttachment, ExportNote } from "./noteExportData.js";
import type { AssetWriter } from "./exportAssets.js";
import {
  blockPieces,
  isBlockPlan,
  planAttachment,
  titleBlockIndex,
  unreferencedAttachments,
  type AttachmentPlan,
  type ExportContext,
  type Fmt,
  type Piece,
} from "./exportRender.js";
import {
  escapeLineStart,
  escapeMarkdown,
  joinSafe,
  linkDestination,
  tableMarkdown,
  wrapMarkdown,
} from "./markdownExport.js";
import {
  fillPlaceholders,
  plainValue,
  ruleUses,
  type InlineFormat,
  type PlaceholderValue,
  type PlaceholderValues,
  type ResolvedTemplate,
  type RuleId,
  type TemplateRule,
} from "./markdownTemplate.js";

/** Stable codes for problems that do not stop an export. */
export type TemplateWarningCode =
  | "attachment_not_found"
  | "inline_token_metadata_missing"
  | "table_decode_failed"
  | "missing_asset"
  | "asset_copy_failed"
  | "assets_dir_required"
  | "gallery_children_missing";

export interface TemplateWarning {
  code: TemplateWarningCode;
  noteId: string;
  attachmentId?: string;
}

/** Note metadata used by placeholders. Every field is optional. */
export interface NoteTemplateMeta {
  uuid?: string;
  created?: string;
  modified?: string;
  folder?: string;
  account?: string;
}

/** How one note's file-backed attachments are placed. */
export interface TemplateAssetBinding {
  /** Absent: file-backed attachments render through `attachment.placeholder`. */
  writer?: AssetWriter;
  /** True when the template wants copies but there is nowhere to put them. */
  required?: boolean;
}

export interface TemplateRenderOptions {
  template: ResolvedTemplate;
  /** Output file name without its extension, for `{{exportStem}}`. */
  exportStem?: string;
  /** Hard-wrap each note body at this many columns (0: off). */
  wrap?: number;
  /** Asset placement for each note (default: placeholders). */
  assetsFor?: (note: ExportNote) => TemplateAssetBinding;
  /** Metadata for each note (default: none). */
  metaFor?: (note: ExportNote) => NoteTemplateMeta;
}

export interface TemplateRenderResult {
  markdown: string;
  warnings: TemplateWarning[];
}

/** Attachment kinds whose content is a file; `assets.mode: "omit"` skips them. */
const FILE_BACKED = new Set([
  "image",
  "drawing",
  "paper",
  "scan",
  "pdf",
  "audio",
  "video",
  "file",
  "gallery",
]);

const KIND_RULES: Record<string, RuleId> = {
  image: "attachment.image",
  drawing: "attachment.drawing.classic",
  paper: "attachment.drawing.paper",
  scan: "attachment.scan",
  pdf: "attachment.pdf",
  audio: "attachment.audio",
  video: "attachment.video",
  file: "attachment.other",
  table: "attachment.table",
  divider: "attachment.divider",
  gallery: "attachment.gallery",
  link: "attachment.url",
};

const IMAGE_URL_EXTENSIONS =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jfif|jpe?g|jxl|png|svgz?|tiff?|webp)$/i;

/** True for an http(s) URL whose decoded path ends in an image file extension. */
export function isImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the encoded path */
    }
    return IMAGE_URL_EXTENSIONS.test(path);
  } catch {
    return false;
  }
}

/** True for an Apple Maps link. */
export function isMapUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "maps.apple.com" || host.endsWith(".maps.apple.com");
  } catch {
    return false;
  }
}

/**
 * Rule used for an attachment of this kind (link cards depend on the URL).
 * Inline tokens (hashtags, mentions, note links) have none: they render as
 * text or through `inline.link`.
 */
export function attachmentRuleId(
  attachment: ExportAttachment,
  template: ResolvedTemplate
): RuleId | undefined {
  if (attachment.kind === "inline") return undefined;
  if (attachment.kind === "link") {
    const url = attachment.url ?? "";
    if (template.options.richLinkImages && isImageUrl(url)) return "attachment.url.image";
    if (isMapUrl(url)) return "attachment.map";
  }
  return KIND_RULES[attachment.kind] ?? "attachment.other";
}

/**
 * Apply a rule to content. Returns undefined when the rule omits it.
 * `linePrefix` marks blank lines with the prefix's trimmed form.
 */
export function applyRule(
  rule: TemplateRule,
  content: string,
  values: PlaceholderValues
): string | undefined {
  const fill = (text = "") => fillPlaceholders(text, { ...values, content: plainValue(content) });
  switch (rule.mode) {
    case "omit":
      return undefined;
    case "plain":
      return content;
    case "wrap":
      return fill(rule.before) + content + fill(rule.after);
    case "pattern":
      return fill(rule.value);
    case "linePrefix": {
      const prefix = fill(rule.value);
      return content
        .split("\n")
        .map((line) => (line ? prefix + line : prefix.trimEnd()))
        .join("\n");
    }
  }
}

/** Apply an inline rule to the non-whitespace core, keeping edge whitespace outside. */
function applyInline(rule: TemplateRule, text: string, values: PlaceholderValues): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!match[2]) return text;
  const out = applyRule(rule, match[2], values);
  return out === undefined ? "" : `${match[1]}${out}${match[3]}`;
}

type TextPiece = Extract<Piece, { type: "text" }>;

interface Layer {
  /** Grouping key for a run; undefined when the format does not apply. */
  key(fmt: Fmt): string | undefined;
  rule(fmt: Fmt): TemplateRule;
  values(fmt: Fmt): PlaceholderValues;
}

const HIGHLIGHT_RULES = new Set(["purple", "pink", "orange", "mint", "blue"]);

function highlightRule(name: string): RuleId {
  return HIGHLIGHT_RULES.has(name)
    ? (`inline.highlight.${name}` as RuleId)
    : "inline.highlight.other";
}

/** Build the formatting layers, outermost first. */
function buildLayers(template: ResolvedTemplate): Layer[] {
  const { rules } = template;
  const active = (rule: TemplateRule) => rule.mode !== "plain";
  const flag = (format: Exclude<InlineFormat, "highlight" | "color" | "link">): Layer => {
    const rule = rules[`inline.${format}`];
    return {
      key: (fmt) => (fmt[format] && active(rule) ? "on" : undefined),
      rule: () => rule,
      values: () => ({}),
    };
  };
  const layers: Record<InlineFormat, Layer> = {
    bold: flag("bold"),
    italic: flag("italic"),
    underline: flag("underline"),
    strikethrough: flag("strikethrough"),
    superscript: flag("superscript"),
    subscript: flag("subscript"),
    highlight: {
      key: (fmt) => {
        if (!fmt.highlight) return undefined;
        const rule = rules[highlightRule(fmt.highlight)];
        if (!active(rule)) return undefined;
        return JSON.stringify(rule) + (ruleUses(rule, "highlight") ? fmt.highlight : "");
      },
      rule: (fmt) => rules[highlightRule(fmt.highlight!)],
      values: (fmt) => ({ highlight: fmt.highlight! }),
    },
    color: {
      key: (fmt) => {
        const rule = rules["inline.color"];
        if (!fmt.color || !active(rule)) return undefined;
        return ruleUses(rule, "color") ? fmt.color : "on";
      },
      rule: () => rules["inline.color"],
      values: (fmt) => ({ color: fmt.color! }),
    },
    link: {
      key: (fmt) => fmt.link,
      rule: () => rules["inline.link"],
      values: (fmt) => ({ url: { md: linkDestination(fmt.link!), raw: fmt.link! } }),
    },
  };
  return [...template.inlineOrder].reverse().map((format) => layers[format]);
}

/** A block-level output line. */
interface Line {
  text: string;
  /** Adjacent lines of the same group and quote state join with one newline. */
  group?: string;
  quote: boolean;
}

const LIST_STYLES = new Set(["bulleted", "dashed", "numbered", "checklist"]);

/** Renders notes through one template, collecting warnings. */
class TemplateRenderer {
  readonly warnings: TemplateWarning[] = [];
  private readonly layers: Layer[];
  private readonly rules: ResolvedTemplate["rules"];
  /** The attachment each plan was made from, for rule and placeholder lookup. */
  private readonly origins = new WeakMap<AttachmentPlan, ExportAttachment>();

  constructor(
    private readonly ctx: ExportContext,
    private readonly options: TemplateRenderOptions
  ) {
    this.layers = buildLayers(options.template);
    this.rules = options.template.rules;
  }

  private get template() {
    return this.options.template;
  }

  /** Placeholder values describing the note. */
  noteValues(note: ExportNote): PlaceholderValues {
    const meta = this.options.metaFor?.(note) ?? {};
    const text = (value: string | undefined): PlaceholderValue | undefined =>
      value === undefined ? undefined : { md: escapeMarkdown(value), raw: value };
    const tags = noteTags(note);
    const values: PlaceholderValues = {
      title: text(note.title.trim()),
      id: note.id,
      uuid: meta.uuid,
      folder: text(meta.folder),
      account: text(meta.account),
      created: meta.created,
      modified: meta.modified,
      tags: {
        md: tags.map((tag) => escapeMarkdown(tag)).join(", "),
        raw: tags.join(", "),
        list: tags,
      },
      exportStem: this.options.exportStem ?? "export",
    };
    return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
  }

  private warn(code: TemplateWarningCode, note: ExportNote, attachmentId?: string) {
    this.warnings.push({ code, noteId: note.id, ...(attachmentId ? { attachmentId } : {}) });
  }

  /** Plan one attachment, honoring omit rules before any file is placed. */
  private plan(
    note: ExportNote,
    id: string,
    attachment: ExportAttachment | undefined,
    binding: TemplateAssetBinding
  ): AttachmentPlan {
    const omitted: AttachmentPlan = { type: "inline", text: "" };
    if (!attachment) {
      this.warn("attachment_not_found", note, id);
      return planAttachment(undefined, this.ctx);
    }
    const ruleId = attachmentRuleId(attachment, this.template);
    if (ruleId && this.rules[ruleId].mode === "omit") return omitted;
    const fileBacked = FILE_BACKED.has(attachment.kind);
    if (fileBacked && this.template.assets.mode === "omit") return omitted;
    if (fileBacked && !binding.writer && binding.required)
      this.warn("assets_dir_required", note, attachment.id);
    const plan = planAttachment(attachment, {
      ...this.ctx,
      ...(binding.writer ? { writer: binding.writer } : { writer: undefined }),
    });
    this.inspect(note, plan, attachment);
    return plan;
  }

  /** Record origins and warnings for a plan and any gallery items. */
  private inspect(note: ExportNote, plan: AttachmentPlan, attachment: ExportAttachment) {
    this.origins.set(plan, attachment);
    switch (plan.type) {
      case "inline":
        if (!plan.text) this.warn("inline_token_metadata_missing", note, attachment.id);
        break;
      case "unavailable":
        this.warn(
          plan.reason === "undecodable"
            ? "table_decode_failed"
            : plan.reason === "missing"
              ? "missing_asset"
              : "asset_copy_failed",
          note,
          attachment.id
        );
        break;
      case "gallery":
        if (!plan.items.length) this.warn("gallery_children_missing", note, attachment.id);
        plan.items.forEach((item, i) => this.inspect(note, item, attachment.children[i]));
        break;
    }
  }

  /** Placeholder values for an attachment. */
  private attachmentValues(
    attachment: ExportAttachment | undefined,
    base: PlaceholderValues
  ): PlaceholderValues {
    if (!attachment) return base;
    const filename = attachment.mediaFilename ?? attachment.title;
    return {
      ...base,
      kind: attachment.kind,
      uti: attachment.uti,
      ...(filename ? { filename: { md: escapeMarkdown(filename), raw: filename } } : {}),
    };
  }

  /** Render a plan through its template rule; "" when omitted. */
  renderPlan(plan: AttachmentPlan, values: PlaceholderValues, caption?: string): string {
    const origin = this.origins.get(plan);
    const vars = this.attachmentValues(origin, values);
    const apply = (id: RuleId, content: string, extra: PlaceholderValues = {}) =>
      applyRule(this.rules[id], content, { ...vars, ...extra }) ?? "";
    switch (plan.type) {
      case "inline":
        return plan.link
          ? applyInline(this.rules["inline.link"], escapeMarkdown(plan.text), {
              ...vars,
              url: { md: linkDestination(plan.link), raw: plan.link },
            })
          : escapeMarkdown(plan.text);
      case "divider":
        return apply("attachment.divider", "");
      case "table":
        return apply("attachment.table", tableMarkdown(plan.rows));
      case "placeholder":
      case "unavailable": {
        const label = plan.type === "unavailable" ? `${plan.label} unavailable` : plan.label;
        return apply(
          "attachment.placeholder",
          escapeMarkdown(plan.name ? `${label}: ${plan.name}` : label)
        );
      }
      case "asset": {
        const alt = escapeMarkdown(plan.name ?? plan.label);
        const id = (origin && attachmentRuleId(origin, this.template)) || "attachment.other";
        return apply(id, "", {
          alt: { md: alt, raw: plan.name ?? plan.label },
          path: { md: linkDestination(plan.url), raw: plan.url },
          linkText: plan.previewUrl ? `![${alt}](${linkDestination(plan.previewUrl)})` : alt,
        });
      }
      case "card": {
        if (!plan.url) return `${escapeMarkdown(plan.title)} (${escapeMarkdown(plan.displayUrl)})`;
        const id = (origin && attachmentRuleId(origin, this.template)) || "attachment.url";
        const alt = caption ?? plan.title;
        return apply(id, "", {
          alt: { md: escapeMarkdown(alt), raw: alt },
          url: { md: linkDestination(plan.url), raw: plan.url },
          ...(caption !== undefined
            ? { caption: { md: escapeMarkdown(caption), raw: caption } }
            : {}),
        });
      }
      case "gallery": {
        const rule = this.rules["attachment.gallery"];
        const items = plan.items.map((item) => this.renderPlan(item, values)).filter(Boolean);
        if (!items.length) return "";
        return apply("attachment.gallery", items.join(rule.join === "line" ? "\n" : "\n\n"));
      }
    }
  }

  /** Format text runs through the inline layers. */
  private layered(pieces: TextPiece[], values: PlaceholderValues, depth = 0): string {
    if (depth === this.layers.length)
      return pieces.map((piece) => escapeMarkdown(piece.text.replace(/\n/g, " "))).join("");
    const layer = this.layers[depth];
    let out = "";
    for (let i = 0; i < pieces.length;) {
      const key = layer.key(pieces[i].fmt);
      let j = i;
      while (j < pieces.length && layer.key(pieces[j].fmt) === key) j++;
      const inner = this.layered(pieces.slice(i, j), values, depth + 1);
      const fmt = pieces[i].fmt;
      out = joinSafe(
        out,
        key === undefined
          ? inner
          : applyInline(layer.rule(fmt), inner, { ...values, ...layer.values(fmt) })
      );
      i = j;
    }
    return out;
  }

  private inline(pieces: Piece[], values: PlaceholderValues, caption?: string): string {
    let out = "";
    for (let i = 0; i < pieces.length;) {
      const piece = pieces[i];
      if (piece.type === "attachment") {
        out = joinSafe(out, this.renderPlan(piece.plan, values, caption));
        i++;
        continue;
      }
      let j = i;
      while (j < pieces.length && pieces[j].type === "text") j++;
      out = joinSafe(out, this.layered(pieces.slice(i, j) as TextPiece[], values));
      i = j;
    }
    return out;
  }

  /** The caption paragraph after a lone image-URL link card, if the template wants one. */
  private captionFor(note: ExportNote, index: number): string | undefined {
    const { options } = this.template;
    if (!options.richLinkImages || options.richLinkImageCaption !== "followingItalicParagraph")
      return undefined;
    const blocks = note.doc.blocks;
    const current = blocks[index];
    if (current.text.trim() !== "￼" || current.attachments.length !== 1) return undefined;
    const attachment = note.attachments.get(current.attachments[0].id);
    if (!attachment || attachmentRuleId(attachment, this.template) !== "attachment.url.image")
      return undefined;
    if (this.rules["attachment.url.image"].mode === "omit" || !isSafe(attachment.url))
      return undefined;
    const next = blocks[index + 1];
    if (
      !next ||
      next.style !== "body" ||
      next.blockQuote ||
      next.indent !== 0 ||
      next.attachments.length ||
      next.text.includes("￼") ||
      !next.text.trim() ||
      !next.runs.every((run) => !run.text.trim() || run.italic)
    )
      return undefined;
    return next.text.trim();
  }

  /** Render one note's body. */
  renderBody(note: ExportNote, values: PlaceholderValues): string {
    const binding = this.options.assetsFor?.(note) ?? {};
    const plan = (id: string) => this.plan(note, id, note.attachments.get(id), binding);
    const titleIndex = titleBlockIndex(note);
    const lines: Line[] = [];
    const counters: number[] = [];
    const skip = new Set<number>();
    let code: { lines: string[]; quote: boolean } | undefined;
    const push = (text: string | undefined, quote: boolean, group?: string) => {
      if (!text) return;
      if (quote) {
        const quoted = applyRule(this.rules["paragraph.quote"], text, values);
        if (!quoted) return;
        text = quoted;
      }
      lines.push({ text, quote, ...(group ? { group } : {}) });
    };
    const ruled = (id: RuleId, content: string, extra: PlaceholderValues = {}) =>
      applyRule(this.rules[id], content, { ...values, ...extra });
    const groupOf = (id: RuleId, list: boolean) =>
      this.rules[id].join === "line" ? (list ? "list" : id) : undefined;

    const flushCode = () => {
      if (!code) return;
      const longest = Math.max(
        2,
        ...code.lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length)))
      );
      push(
        ruled("block.code", code.lines.join("\n"), { fence: "`".repeat(longest + 1) }),
        code.quote,
        groupOf("block.code", false)
      );
      code = undefined;
    };

    if (this.template.options.titleFallback && titleIndex === -1 && note.title.trim())
      push(
        ruled("block.title", escapeMarkdown(note.title.trim())),
        false,
        groupOf("block.title", false)
      );

    for (const block of note.doc.blocks) {
      if (skip.has(block.index)) continue;
      if (block.style === "monospaced") {
        if (code && code.quote !== block.blockQuote) flushCode();
        code ??= { lines: [], quote: block.blockQuote };
        code.lines.push(block.text.replace(/￼/g, ""));
        continue;
      }
      flushCode();
      if (!LIST_STYLES.has(block.style)) counters.length = 0;
      if (!block.text.trim()) continue;
      const caption = this.captionFor(note, block.index);
      if (caption !== undefined) skip.add(block.index + 1);
      const pieces = blockPieces(block, plan);
      let segment: Piece[] = [];
      const segments: Array<Piece[] | AttachmentPlan> = [];
      for (const piece of pieces) {
        if (piece.type === "attachment" && isBlockPlan(piece.plan)) {
          segments.push(segment, piece.plan);
          segment = [];
        } else segment.push(piece);
      }
      segments.push(segment);
      let first = true;
      for (const segment of segments) {
        if (!Array.isArray(segment)) {
          push(this.renderPlan(segment, values), block.blockQuote);
          continue;
        }
        const body = this.inline(segment, values, caption).trim();
        if (!body) continue;
        const [text, group] = this.blockLine(
          block,
          body,
          first,
          block.index === titleIndex,
          counters,
          values
        );
        push(text, block.blockQuote, group);
        first = false;
      }
    }
    flushCode();

    for (const attachment of unreferencedAttachments(note)) {
      this.ctx.stats.unreferenced++;
      push(this.renderPlan(this.plan(note, attachment.id, attachment, binding), values), false);
    }
    return this.join(lines, values);
  }

  /** One paragraph through its block rule, with list indent and numbering. */
  private blockLine(
    block: NoteBlock,
    body: string,
    first: boolean,
    isTitle: boolean,
    counters: number[],
    values: PlaceholderValues
  ): [string | undefined, string | undefined] {
    const rule = (id: RuleId, content: string, extra: PlaceholderValues = {}, list = false) =>
      [
        applyRule(this.rules[id], content, { ...values, ...extra }),
        this.rules[id].join === "line" ? (list ? "list" : id) : undefined,
      ] as [string | undefined, string | undefined];
    if (isTitle || block.style === "title") return rule("block.title", body);
    if (block.style === "heading") return rule("block.heading", body);
    if (block.style === "subheading") return rule("block.subheading", body);
    if (!LIST_STYLES.has(block.style) || !first) return rule("block.body", escapeLineStart(body));
    // A list item's own text is escaped after its marker, as the fixed renderer does.
    const item = escapeLineStart(body);
    const level = Math.min(block.indent, 20);
    counters.length = Math.min(counters.length, level + 1);
    while (counters.length <= level) counters.push(0);
    let result: [string | undefined, string | undefined];
    if (block.style === "numbered")
      result = rule("block.numbered", item, { index: String(++counters[level]) }, true);
    else {
      counters[level] = 0;
      if (block.style === "checklist") {
        const done = !!block.checklist?.done;
        result = rule(
          done ? "block.checklist.checked" : "block.checklist.unchecked",
          item,
          { checked: String(done) },
          true
        );
      } else
        result = rule(block.style === "dashed" ? "block.dashed" : "block.bulleted", item, {}, true);
    }
    const indent = this.template.options.listIndent.repeat(level);
    if (result[0] && indent)
      result[0] = result[0]
        .split("\n")
        .map((line) => (line ? indent + line : line))
        .join("\n");
    return result;
  }

  /** Join lines: one newline within a `line`-join group, a blank line elsewhere. */
  private join(lines: Line[], values: PlaceholderValues): string {
    const quote = this.rules["paragraph.quote"];
    const quoteGap =
      quote.mode === "linePrefix"
        ? `\n${fillPlaceholders(quote.value ?? "", values).trimEnd()}\n`
        : "\n\n";
    let out = "";
    let previous: Line | undefined;
    for (const line of lines) {
      if (previous) {
        const tight =
          previous.group !== undefined &&
          previous.group === line.group &&
          previous.quote === line.quote;
        out += tight ? "\n" : previous.quote && line.quote ? quoteGap : "\n\n";
      }
      out += line.text;
      previous = line;
    }
    return out;
  }
}

const isSafe = (url: string | undefined) =>
  !!url && /^https?:\/\//i.test(url) && !Array.from(url).some((c) => c.charCodeAt(0) < 32);

/** Hashtags in the note (inline tag attachments), without `#`, in first-seen order. */
export function noteTags(note: ExportNote): string[] {
  const tags: string[] = [];
  for (const attachment of note.attachments.values()) {
    if (!attachment.uti.endsWith(".hashtag") || !attachment.altText) continue;
    const tag = attachment.altText.replace(/^#/, "").trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Render notes as one document: for each note the header, the body and the
 * footer, with the separator between notes (its placeholders describe the
 * note that follows it). Ends with a newline when there is any note.
 */
export function renderNotesWithTemplate(
  notes: ExportNote[],
  ctx: ExportContext,
  options: TemplateRenderOptions
): TemplateRenderResult {
  const renderer = new TemplateRenderer(ctx, options);
  const rules = options.template.rules;
  let markdown = "";
  notes.forEach((note, i) => {
    const values = renderer.noteValues(note);
    if (i > 0) markdown += applyRule(rules["document.separator"], "", values) ?? "";
    const body = renderer.renderBody(note, values);
    markdown +=
      (applyRule(rules["document.header"], "", values) ?? "") +
      (options.wrap ? wrapMarkdown(body, options.wrap) : body) +
      (applyRule(rules["document.footer"], "", values) ?? "");
  });
  return { markdown: markdown + (notes.length ? "\n" : ""), warnings: renderer.warnings };
}
