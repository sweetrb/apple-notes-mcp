/**
 * Markdown export templates: a portable, data-only JSON schema that controls
 * how `export-notes-markdown` renders each block type, inline style,
 * attachment, per-note header and footer (front matter), and note separator.
 *
 * A template has no expressions, conditionals, or code. Each rule picks one
 * of five modes and may use `{{placeholder}}` tokens that are replaced
 * literally. Validation is strict and reports every problem with a
 * deterministic JSON path such as `$.rules["inline.bold"].before`.
 *
 * A template may be compact: it names a built-in in `extends` (default
 * `standard-markdown`) and overrides only what differs. `assets` and
 * `options` merge field by field; each rule override replaces the whole rule;
 * `inlineOrder`, when present, must list every inline format exactly once.
 *
 * @module utils/markdownTemplate
 */

/** The only schema version this server reads and writes. */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Largest template, in UTF-8 bytes of JSON. */
export const MAX_TEMPLATE_BYTES = 256 * 1024;

const MAX_META_LENGTH = 512;
const MAX_RULE_TEXT = 4096;
const MAX_DIRECTORY_LENGTH = 1024;

/** Every rule a template can set, in documentation order. */
export const RULE_IDS = [
  "document.header",
  "document.footer",
  "document.separator",
  "block.title",
  "block.heading",
  "block.subheading",
  "block.body",
  "block.bulleted",
  "block.dashed",
  "block.numbered",
  "block.checklist.checked",
  "block.checklist.unchecked",
  "block.code",
  "paragraph.quote",
  "inline.bold",
  "inline.italic",
  "inline.underline",
  "inline.strikethrough",
  "inline.superscript",
  "inline.subscript",
  "inline.highlight.purple",
  "inline.highlight.pink",
  "inline.highlight.orange",
  "inline.highlight.mint",
  "inline.highlight.blue",
  "inline.highlight.other",
  "inline.color",
  "inline.link",
  "attachment.image",
  "attachment.drawing.classic",
  "attachment.drawing.paper",
  "attachment.scan",
  "attachment.pdf",
  "attachment.audio",
  "attachment.video",
  "attachment.other",
  "attachment.table",
  "attachment.divider",
  "attachment.gallery",
  "attachment.url",
  "attachment.url.image",
  "attachment.map",
  "attachment.placeholder",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const RULE_MODES = ["wrap", "linePrefix", "pattern", "plain", "omit"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

/** One rendering rule. Which text fields are required depends on `mode`. */
export interface TemplateRule {
  mode: RuleMode;
  before?: string;
  after?: string;
  value?: string;
  /** `line` keeps adjacent blocks of the same group on consecutive lines. */
  join?: "line" | "paragraph";
}

/** Inline formats, applied from the first (innermost) to the last (outermost). */
export const INLINE_FORMATS = [
  "subscript",
  "superscript",
  "highlight",
  "underline",
  "strikethrough",
  "bold",
  "italic",
  "color",
  "link",
] as const;
export type InlineFormat = (typeof INLINE_FORMATS)[number];

export interface TemplateAssets {
  /** copy files into an assets directory, reference the originals, or omit them. */
  mode: "copy" | "reference" | "omit";
  /** Markdown links relative to the output file's directory, or absolute paths. */
  pathStyle: "relative" | "absolute";
  /**
   * Assets directory beneath the output file's directory, with placeholders.
   * `null`: copy only when the caller passes `assetsDir`.
   */
  directory: string | null;
}

export interface TemplateOptions {
  /** Add a title line when the body does not start with the note's title. */
  titleFallback: boolean;
  /** Render http(s) link cards whose URL path is an image file as images. */
  richLinkImages: boolean;
  /** Use a following all-italic paragraph as the image's alt text. */
  richLinkImageCaption: "none" | "followingItalicParagraph";
  /** Prepended once per indent level to list items. */
  listIndent: string;
}

/** A template as written and stored. Only `schemaVersion` is required. */
export interface PortableTemplate {
  schemaVersion: 1;
  name?: string;
  description?: string;
  extends?: BuiltinTemplateName;
  assets?: Partial<TemplateAssets>;
  inlineOrder?: InlineFormat[];
  rules?: Partial<Record<RuleId, TemplateRule>>;
  options?: Partial<TemplateOptions>;
}

/** A template with every section filled in from its base. */
export interface ResolvedTemplate {
  name: string;
  description?: string;
  assets: TemplateAssets;
  inlineOrder: InlineFormat[];
  rules: Record<RuleId, TemplateRule>;
  options: TemplateOptions;
}

/** Placeholder names usable in rule text. */
export const PLACEHOLDERS = [
  "content",
  "title",
  "id",
  "uuid",
  "folder",
  "account",
  "created",
  "modified",
  "tags",
  "exportStem",
  "index",
  "checked",
  "url",
  "path",
  "alt",
  "caption",
  "linkText",
  "filename",
  "kind",
  "uti",
  "color",
  "highlight",
  "fence",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Placeholders that describe the note, usable in `assets.directory`. */
export const NOTE_PLACEHOLDERS: readonly Placeholder[] = [
  "title",
  "id",
  "uuid",
  "folder",
  "account",
  "created",
  "modified",
  "exportStem",
];

/** `{{name}}` Markdown-safe, `{{name:raw}}` as stored, `{{name:yaml}}` as a YAML scalar/list. */
export const PLACEHOLDER_MODIFIERS = ["raw", "yaml"] as const;

const wrap = (before: string, after = "", join?: "line" | "paragraph"): TemplateRule => ({
  mode: "wrap",
  before,
  after,
  ...(join ? { join } : {}),
});
const pattern = (value: string, join?: "line" | "paragraph"): TemplateRule => ({
  mode: "pattern",
  value,
  ...(join ? { join } : {}),
});

/** The template that reproduces the default `export-notes-markdown` output. */
const STANDARD: PortableTemplate = {
  schemaVersion: 1,
  name: "standard-markdown",
  description: "The default export-notes-markdown output",
  assets: { mode: "copy", pathStyle: "relative", directory: null },
  inlineOrder: [...INLINE_FORMATS],
  options: {
    titleFallback: true,
    richLinkImages: false,
    richLinkImageCaption: "none",
    listIndent: "    ",
  },
  rules: {
    "document.header": pattern(""),
    "document.footer": pattern(""),
    "document.separator": pattern("\n\n---\n\n"),
    "block.title": wrap("# ", "", "paragraph"),
    "block.heading": wrap("## ", "", "paragraph"),
    "block.subheading": wrap("### ", "", "paragraph"),
    "block.body": { mode: "plain", join: "paragraph" },
    "block.bulleted": wrap("- ", "", "line"),
    "block.dashed": wrap("- ", "", "line"),
    "block.numbered": pattern("{{index}}. {{content}}", "line"),
    "block.checklist.checked": wrap("- [x] ", "", "line"),
    "block.checklist.unchecked": wrap("- [ ] ", "", "line"),
    "block.code": wrap("{{fence}}\n", "\n{{fence}}", "paragraph"),
    "paragraph.quote": { mode: "linePrefix", value: "> " },
    "inline.bold": wrap("**", "**"),
    "inline.italic": wrap("*", "*"),
    "inline.underline": wrap("<u>", "</u>"),
    "inline.strikethrough": wrap("~~", "~~"),
    "inline.superscript": wrap("<sup>", "</sup>"),
    "inline.subscript": wrap("<sub>", "</sub>"),
    "inline.highlight.purple": wrap("==", "=="),
    "inline.highlight.pink": wrap("==", "=="),
    "inline.highlight.orange": wrap("==", "=="),
    "inline.highlight.mint": wrap("==", "=="),
    "inline.highlight.blue": wrap("==", "=="),
    "inline.highlight.other": wrap("==", "=="),
    "inline.color": { mode: "plain" },
    "inline.link": pattern("[{{content}}]({{url}})"),
    "attachment.image": pattern("![{{alt}}]({{path}})"),
    "attachment.drawing.classic": pattern("![{{alt}}]({{path}})"),
    "attachment.drawing.paper": pattern("![{{alt}}]({{path}})"),
    "attachment.scan": pattern("[{{linkText}}]({{path}})"),
    "attachment.pdf": pattern("[{{linkText}}]({{path}})"),
    "attachment.audio": pattern("[{{linkText}}]({{path}})"),
    "attachment.video": pattern("[{{linkText}}]({{path}})"),
    "attachment.other": pattern("[{{linkText}}]({{path}})"),
    "attachment.table": { mode: "plain" },
    "attachment.divider": pattern("---"),
    "attachment.gallery": { mode: "plain", join: "paragraph" },
    "attachment.url": pattern("[{{alt}}]({{url}})"),
    "attachment.url.image": pattern("![{{alt}}]({{url}})"),
    "attachment.map": pattern("[{{alt}}]({{url}})"),
    "attachment.placeholder": pattern("\\[{{content}}\\]"),
  },
};

/** Obsidian-flavored: YAML front matter per note and assets copied beside the file. */
const OBSIDIAN: PortableTemplate = {
  schemaVersion: 1,
  name: "obsidian",
  description:
    "Obsidian-style Markdown: YAML front matter (title, dates, folder, tags, id), image-URL link cards as images, attachments copied to <file>.assets",
  extends: "standard-markdown",
  assets: { directory: "{{exportStem}}.assets" },
  options: { richLinkImages: true, richLinkImageCaption: "followingItalicParagraph" },
  rules: {
    "document.header": pattern(
      "---\ntitle: {{title:yaml}}\ncreated: {{created:yaml}}\nmodified: {{modified:yaml}}\n" +
        "folder: {{folder:yaml}}\ntags: {{tags:yaml}}\nnote-id: {{uuid:yaml}}\n---\n\n"
    ),
  },
};

const BUILTINS = { "standard-markdown": STANDARD, obsidian: OBSIDIAN } as const;
export type BuiltinTemplateName = keyof typeof BUILTINS;
export const BUILTIN_TEMPLATE_NAMES = Object.keys(BUILTINS) as BuiltinTemplateName[];

export const isBuiltinTemplate = (name: string): name is BuiltinTemplateName =>
  Object.prototype.hasOwnProperty.call(BUILTINS, name);

/** A deep copy of a built-in template in its portable form. */
export function builtinTemplate(name: BuiltinTemplateName): PortableTemplate {
  return JSON.parse(JSON.stringify(BUILTINS[name])) as PortableTemplate;
}

/** One validation problem. `path` is a JSON path into the template. */
export interface TemplateError {
  path: string;
  message: string;
}

/** Thrown for an invalid template; carries every problem found. */
export class TemplateValidationError extends Error {
  readonly code = "invalid-template";
  constructor(readonly errors: TemplateError[]) {
    super(
      `Invalid template (${errors.length} problem${errors.length === 1 ? "" : "s"}): ` +
        errors.map((e) => `${e.path}: ${e.message}`).join("; ")
    );
    this.name = "TemplateValidationError";
  }
}

/** The longest key or placeholder quoted back whole in an error message. */
const MAX_QUOTED_TOKEN = 32;

/** `$.a`, `$.a[2]`, `$.rules["inline.bold"]`. */
function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  // No valid key is this long; an unknown one is shortened, not echoed whole.
  if (key.length > MAX_QUOTED_TOKEN) key = `${key.slice(0, MAX_QUOTED_TOKEN - 3)}...`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;

/** A wrong schemaVersion: a number is shown as is, anything else only by type. */
const describeVersion = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : describe(value);

const listed = (values: readonly string[]) => values.map((v) => JSON.stringify(v)).join(", ");

/** A placeholder token as quoted back in an error, capped so a long one is not echoed. */
const quoted = (token: string) =>
  token.length <= MAX_QUOTED_TOKEN ? token : `${token.slice(0, MAX_QUOTED_TOKEN - 3)}...}}`;

const TOKEN = /\{\{([^{}]*)\}\}/g;
const TOKEN_BODY = /^\s*([A-Za-z]+)(?::([A-Za-z]+))?\s*$/;

/** Placeholders whose values come from each note's metadata read. */
const META_PLACEHOLDERS: readonly string[] = ["uuid", "folder", "account", "created", "modified"];

/** Whether any rule, asset setting or option uses a metadata placeholder. */
export function usesNoteMeta(template: ResolvedTemplate): boolean {
  const uses = (value: unknown): boolean =>
    typeof value === "string"
      ? placeholderTokens(value).some(({ name }) => META_PLACEHOLDERS.includes(name))
      : typeof value === "object" && value !== null && Object.values(value).some(uses);
  return uses(template.rules) || uses(template.assets) || uses(template.options);
}

/** The placeholder names used in a string, for validation and rendering. */
export function placeholderTokens(
  text: string
): Array<{ token: string; name: string; modifier?: string }> {
  return [...text.matchAll(TOKEN)].map((match) => {
    const body = TOKEN_BODY.exec(match[1]);
    return {
      token: match[0],
      name: body?.[1] ?? match[1],
      ...(body?.[2] ? { modifier: body[2] } : {}),
    };
  });
}

class Collector {
  readonly errors: TemplateError[] = [];
  add(path: string, message: string) {
    this.errors.push({ path, message });
  }

  /** Report unknown keys; returns the known keys present, sorted. */
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): string[] {
    const present = Object.keys(value).sort();
    for (const key of present)
      if (!allowed.includes(key))
        this.add(child(path, key), `unknown key; allowed keys are ${listed(allowed)}`);
    return present.filter((key) => allowed.includes(key));
  }

  text(
    value: unknown,
    path: string,
    { max, allowed = PLACEHOLDERS }: { max: number; allowed?: readonly string[] }
  ): value is string {
    if (typeof value !== "string") {
      this.add(path, `must be a string, not ${describe(value)}`);
      return false;
    }
    if (value.length > max)
      this.add(path, `must be at most ${max} characters (is ${value.length})`);
    for (const { token: raw, name, modifier } of placeholderTokens(value)) {
      const token = quoted(raw);
      if (!(PLACEHOLDERS as readonly string[]).includes(name))
        this.add(path, `unknown placeholder ${token}; allowed: ${PLACEHOLDERS.join(", ")}`);
      else if (!allowed.includes(name))
        this.add(
          path,
          `placeholder ${token} is not available here; allowed: ${allowed.join(", ")}`
        );
      else if (modifier && !(PLACEHOLDER_MODIFIERS as readonly string[]).includes(modifier))
        this.add(
          path,
          `unknown modifier in ${token}; allowed modifiers are ${PLACEHOLDER_MODIFIERS.join(", ")}`
        );
    }
    return true;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): value is T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return true;
    this.add(
      path,
      typeof value === "string"
        ? `must be one of ${listed(allowed)}`
        : `must be one of ${listed(allowed)}, not ${describe(value)}`
    );
    return false;
  }

  boolean(value: unknown, path: string): value is boolean {
    if (typeof value === "boolean") return true;
    this.add(path, `must be true or false, not ${describe(value)}`);
    return false;
  }
}

const RULE_FIELDS: Record<RuleMode, Array<"before" | "after" | "value">> = {
  wrap: ["before", "after"],
  linePrefix: ["value"],
  pattern: ["value"],
  plain: [],
  omit: [],
};

function validateRule(c: Collector, rule: unknown, path: string): void {
  if (!isObject(rule)) {
    c.add(path, `must be an object, not ${describe(rule)}`);
    return;
  }
  const keys = c.keys(rule, path, ["mode", "before", "after", "value", "join"]);
  if (!("mode" in rule)) {
    c.add(child(path, "mode"), `is required; one of ${listed(RULE_MODES)}`);
    return;
  }
  if (!c.oneOf(rule.mode, child(path, "mode"), RULE_MODES)) return;
  const needed = RULE_FIELDS[rule.mode];
  for (const field of ["before", "after", "value"] as const) {
    const fieldPath = child(path, field);
    if (needed.includes(field)) {
      if (!(field in rule)) c.add(fieldPath, `is required when mode is "${rule.mode}"`);
      else c.text(rule[field], fieldPath, { max: MAX_RULE_TEXT });
    } else if (keys.includes(field)) c.add(fieldPath, `is not used when mode is "${rule.mode}"`);
  }
  if ("join" in rule) c.oneOf(rule.join, child(path, "join"), ["line", "paragraph"] as const);
}

function validateDirectory(c: Collector, value: unknown, path: string): void {
  if (value === null) return;
  if (!c.text(value, path, { max: MAX_DIRECTORY_LENGTH, allowed: NOTE_PLACEHOLDERS })) return;
  if (!value.trim()) c.add(path, "must not be empty; use null to copy only with assetsDir");
  else if (/^[/~]/.test(value)) c.add(path, "must be relative to the output file's directory");
  else if (/[\\\0]/.test(value)) c.add(path, "must not contain a backslash or NUL");
  else if (value.split("/").some((part) => part.trim() === ".."))
    c.add(path, 'must not contain a ".." component');
}

function validateInlineOrder(c: Collector, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    c.add(
      path,
      `must be an array of ${INLINE_FORMATS.length} inline formats, not ${describe(value)}`
    );
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (!c.oneOf(item, child(path, i), INLINE_FORMATS)) return;
    if (seen.has(item)) c.add(child(path, i), `duplicate format "${item}"`);
    seen.add(item);
  });
  const missing = INLINE_FORMATS.filter((format) => !seen.has(format));
  if (missing.length) c.add(path, `must list every inline format; missing ${listed(missing)}`);
}

function validateOptions(c: Collector, value: unknown, path: string): void {
  if (!isObject(value)) {
    c.add(path, `must be an object, not ${describe(value)}`);
    return;
  }
  for (const key of c.keys(value, path, [
    "titleFallback",
    "richLinkImages",
    "richLinkImageCaption",
    "listIndent",
  ])) {
    const at = child(path, key);
    if (key === "richLinkImageCaption")
      c.oneOf(value[key], at, ["none", "followingItalicParagraph"] as const);
    else if (key === "listIndent") {
      if (typeof value[key] !== "string" || !/^[ \t]{0,16}$/.test(value[key] as string))
        c.add(at, "must be a string of at most 16 spaces or tabs");
    } else c.boolean(value[key], at);
  }
}

/**
 * Check a parsed template. Returns the problems found, in a stable order
 * (sorted keys, array order); an empty list means the template is valid.
 */
export function templateErrors(input: unknown): TemplateError[] {
  const c = new Collector();
  if (!isObject(input)) {
    c.add("$", `a template must be a JSON object, not ${describe(input)}`);
    return c.errors;
  }
  // Anything without schemaVersion 1 is not treated as a template, so
  // nothing else about it (key names, placeholders) is reported back:
  // templateFile can name any readable JSON file.
  if (input.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    c.add(
      "$.schemaVersion",
      "schemaVersion" in input
        ? `must be ${TEMPLATE_SCHEMA_VERSION}, not ${describeVersion(input.schemaVersion)}`
        : `is required and must be ${TEMPLATE_SCHEMA_VERSION}`
    );
    return c.errors;
  }
  const keys = c.keys(input, "$", [
    "schemaVersion",
    "name",
    "description",
    "extends",
    "assets",
    "inlineOrder",
    "rules",
    "options",
  ]);
  for (const key of keys) {
    const path = child("$", key);
    const value = input[key];
    switch (key) {
      case "schemaVersion":
        break;
      case "name":
      case "description":
        c.text(value, path, { max: MAX_META_LENGTH, allowed: [] });
        break;
      case "extends":
        c.oneOf(value, path, BUILTIN_TEMPLATE_NAMES);
        break;
      case "assets":
        if (!isObject(value)) {
          c.add(path, `must be an object, not ${describe(value)}`);
          break;
        }
        for (const field of c.keys(value, path, ["mode", "pathStyle", "directory"])) {
          const at = child(path, field);
          if (field === "mode") c.oneOf(value.mode, at, ["copy", "reference", "omit"] as const);
          else if (field === "pathStyle")
            c.oneOf(value.pathStyle, at, ["relative", "absolute"] as const);
          else validateDirectory(c, value.directory, at);
        }
        break;
      case "inlineOrder":
        validateInlineOrder(c, value, path);
        break;
      case "rules":
        if (!isObject(value)) {
          c.add(path, `must be an object keyed by rule id, not ${describe(value)}`);
          break;
        }
        for (const id of Object.keys(value).sort()) {
          if (!(RULE_IDS as readonly string[]).includes(id))
            c.add(child(path, id), "unknown rule id; see the template reference for the list");
          else validateRule(c, value[id], child(path, id));
        }
        break;
      default:
        validateOptions(c, value, path);
    }
  }
  return c.errors;
}

/** Validate and return the template, or throw {@link TemplateValidationError}. */
export function validateTemplate(input: unknown): PortableTemplate {
  const errors = templateErrors(input);
  if (errors.length) throw new TemplateValidationError(errors);
  return input as PortableTemplate;
}

/**
 * The line and column of a JSON.parse failure, from the "(line L column C)"
 * or "at position N" in V8's message. Only the numbers are used.
 */
export function jsonErrorLocation(
  text: string,
  message: string
): { line: number; column: number } | undefined {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = /at position (\d+)/.exec(message);
  if (!position) return undefined;
  const offset = Math.min(Number(position[1]), text.length);
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

/** Parse template JSON text under the size cap, then validate it. */
export function parseTemplate(text: string): PortableTemplate {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEMPLATE_BYTES)
    throw new TemplateValidationError([
      { path: "$", message: `template is ${bytes} bytes; the limit is ${MAX_TEMPLATE_BYTES}` },
    ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // V8's message quotes the source text; report only where the error is.
    const at = jsonErrorLocation(text, (error as Error).message);
    throw new TemplateValidationError([
      {
        path: "$",
        message: at ? `not valid JSON at line ${at.line}, column ${at.column}` : "not valid JSON",
      },
    ]);
  }
  return validateTemplate(parsed);
}

/** Fill every section of a valid template from its base (default standard-markdown). */
export function resolveTemplate(template: PortableTemplate, name?: string): ResolvedTemplate {
  if (template === STANDARD) return merge(undefined, STANDARD, name);
  return merge(resolveTemplate(BUILTINS[template.extends ?? "standard-markdown"]), template, name);
}

function merge(
  base: ResolvedTemplate | undefined,
  template: PortableTemplate,
  name?: string
): ResolvedTemplate {
  return {
    name: name ?? template.name ?? base?.name ?? "template",
    ...(template.description !== undefined
      ? { description: template.description }
      : base?.description !== undefined
        ? { description: base.description }
        : {}),
    assets: { ...base?.assets, ...template.assets } as TemplateAssets,
    inlineOrder: [...(template.inlineOrder ?? base!.inlineOrder)],
    rules: { ...base?.rules, ...template.rules } as Record<RuleId, TemplateRule>,
    options: { ...base?.options, ...template.options } as TemplateOptions,
  };
}

/** A placeholder's value: Markdown-safe text, the raw value, and an optional list. */
export interface PlaceholderValue {
  md: string;
  raw: string;
  list?: string[];
}

export type PlaceholderValues = Partial<Record<Placeholder, PlaceholderValue | string>>;

/** A value whose Markdown and raw forms are the same. */
export const plainValue = (text: string): PlaceholderValue => ({ md: text, raw: text });

/**
 * Replace every `{{placeholder}}` in `text`. Missing values become empty.
 * `:raw` uses the stored value; `:yaml` emits a double-quoted YAML scalar
 * (a flow list for list values, `null` when absent).
 */
export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN, (token, body: string) => {
    const parsed = TOKEN_BODY.exec(body);
    const raw = parsed ? values[parsed[1] as Placeholder] : undefined;
    const value = typeof raw === "string" ? plainValue(raw) : raw;
    if (parsed?.[2] === "yaml") {
      if (!value) return "null";
      return JSON.stringify(value.list ?? value.raw);
    }
    if (!value) return "";
    return parsed?.[2] === "raw" ? value.raw : value.md;
  });
}

/** True when any text field of the rule uses the placeholder. */
export function ruleUses(rule: TemplateRule, name: Placeholder): boolean {
  return [rule.before, rule.after, rule.value].some(
    (text) => text !== undefined && placeholderTokens(text).some((token) => token.name === name)
  );
}
