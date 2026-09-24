/**
 * Template schema: validation paths and messages, built-ins, expansion and
 * placeholder substitution.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BUILTIN_TEMPLATE_NAMES,
  builtinTemplate,
  fillPlaceholders,
  INLINE_FORMATS,
  isBuiltinTemplate,
  MAX_TEMPLATE_BYTES,
  jsonErrorLocation,
  parseTemplate,
  placeholderTokens,
  resolveTemplate,
  RULE_IDS,
  ruleUses,
  templateErrors,
  TemplateValidationError,
  validateTemplate,
} from "./markdownTemplate.js";

const paths = (input: unknown) => templateErrors(input).map((e) => e.path);

describe("built-in templates", () => {
  it("are valid and standard-markdown sets every rule", () => {
    for (const name of BUILTIN_TEMPLATE_NAMES)
      expect(templateErrors(builtinTemplate(name))).toEqual([]);
    const standard = builtinTemplate("standard-markdown");
    expect(Object.keys(standard.rules!).sort()).toEqual([...RULE_IDS].sort());
    expect(standard.inlineOrder).toEqual([...INLINE_FORMATS]);
    expect(isBuiltinTemplate("obsidian")).toBe(true);
    expect(isBuiltinTemplate("toString")).toBe(false);
  });

  it("returns copies that callers cannot corrupt", () => {
    const copy = builtinTemplate("standard-markdown");
    copy.rules!["block.title"] = { mode: "omit" };
    expect(builtinTemplate("standard-markdown").rules!["block.title"]!.mode).toBe("wrap");
  });

  it("expands a compact template against its base", () => {
    const resolved = resolveTemplate(
      {
        schemaVersion: 1,
        extends: "obsidian",
        assets: { pathStyle: "absolute" },
        options: { listIndent: "  " },
        rules: { "inline.bold": { mode: "wrap", before: "__", after: "__" } },
      },
      "mine"
    );
    expect(resolved.name).toBe("mine");
    expect(resolved.description).toMatch(/^Obsidian-style/);
    expect(resolved.assets).toEqual({
      mode: "copy",
      pathStyle: "absolute",
      directory: "{{exportStem}}.assets",
    });
    expect(resolved.options).toMatchObject({
      listIndent: "  ",
      richLinkImages: true,
      titleFallback: true,
    });
    expect(resolved.rules["inline.bold"]).toEqual({ mode: "wrap", before: "__", after: "__" });
    expect(resolved.rules["document.header"].value).toContain("{{title:yaml}}");
    expect(resolved.rules["inline.italic"]).toEqual({ mode: "wrap", before: "*", after: "*" });
    expect(resolveTemplate({ schemaVersion: 1, description: "d" }).name).toBe("standard-markdown");
    expect(resolveTemplate({ schemaVersion: 1, name: "n" }).description).toBe(
      "The default export-notes-markdown output"
    );
  });
});

describe("validation", () => {
  it("accepts the smallest template", () => {
    expect(validateTemplate({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
  });

  it("rejects non-objects and a missing or wrong version", () => {
    expect(templateErrors([])).toEqual([
      { path: "$", message: "a template must be a JSON object, not an array" },
    ]);
    expect(templateErrors(null)[0].message).toContain("not null");
    expect(templateErrors({})).toEqual([
      { path: "$.schemaVersion", message: "is required and must be 1" },
    ]);
    expect(templateErrors({ schemaVersion: "1" })).toEqual([
      { path: "$.schemaVersion", message: "must be 1, not a string" },
    ]);
    expect(templateErrors({ schemaVersion: 2 })).toEqual([
      { path: "$.schemaVersion", message: "must be 1, not 2" },
    ]);
  });

  it("reports nothing else about a file that is not a template", () => {
    // templateFile can name any JSON file; only the missing version comes back.
    const secret = { apiKey: "sk-live-SECRET", nested: { password: "hunter2" } };
    for (const input of [secret, { ...secret, schemaVersion: "SECRET" }]) {
      const errors = templateErrors(input);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe("$.schemaVersion");
      expect(JSON.stringify(errors)).not.toMatch(/SECRET|hunter2|apiKey|password|nested/);
    }
  });

  it("does not echo values, and caps long keys and placeholders", () => {
    const errors = templateErrors({
      schemaVersion: 1,
      extends: "SECRET-VALUE",
      ["k".repeat(40) + "SECRET"]: 1,
      name: `{{${"p".repeat(40)}SECRET}}`,
      assets: { mode: "SECRET-MODE" },
    });
    expect(JSON.stringify(errors)).not.toContain("SECRET");
    expect(errors.map((e) => e.path)).toContain(`$["${"k".repeat(29)}..."]`);
  });

  it("reports unknown keys at every level with a JSON path", () => {
    expect(
      paths({
        schemaVersion: 1,
        extra: 1,
        assets: { size: 1 },
        options: { theme: "x" },
        rules: { "inline.blink": { mode: "plain" }, "inline.bold": { mode: "plain", color: "x" } },
      })
    ).toEqual([
      "$.extra",
      "$.assets.size",
      "$.options.theme",
      '$.rules["inline.blink"]',
      '$.rules["inline.bold"].color',
    ]);
  });

  it("checks metadata, extends, assets and options values", () => {
    expect(
      templateErrors({
        schemaVersion: 1,
        name: 7,
        description: "x".repeat(513),
        extends: "fancy",
        assets: { mode: "link", pathStyle: "rel", directory: "../up" },
        options: {
          titleFallback: "yes",
          richLinkImages: 1,
          richLinkImageCaption: "above",
          listIndent: "--",
        },
      })
    ).toEqual([
      { path: "$.assets.directory", message: 'must not contain a ".." component' },
      { path: "$.assets.mode", message: 'must be one of "copy", "reference", "omit"' },
      { path: "$.assets.pathStyle", message: 'must be one of "relative", "absolute"' },
      { path: "$.description", message: "must be at most 512 characters (is 513)" },
      {
        path: "$.extends",
        message: 'must be one of "standard-markdown", "obsidian"',
      },
      { path: "$.name", message: "must be a string, not a number" },
      { path: "$.options.listIndent", message: "must be a string of at most 16 spaces or tabs" },
      {
        path: "$.options.richLinkImageCaption",
        message: expect.stringMatching(/^must be one of /),
      },
      { path: "$.options.richLinkImages", message: "must be true or false, not a number" },
      { path: "$.options.titleFallback", message: "must be true or false, not a string" },
    ]);
    expect(paths({ schemaVersion: 1, assets: [], options: 3, rules: "x" })).toEqual([
      "$.assets",
      "$.options",
      "$.rules",
    ]);
    expect(paths({ schemaVersion: 1, name: "{{title}}" })).toEqual(["$.name"]);
  });

  it("checks the assets directory shape and placeholders", () => {
    const dir = (directory: unknown) =>
      templateErrors({ schemaVersion: 1, assets: { directory } }).map((e) => e.message);
    expect(dir(null)).toEqual([]);
    expect(dir("{{exportStem}}/{{folder}}")).toEqual([]);
    expect(dir(" ")).toEqual(["must not be empty; use null to copy only with assetsDir"]);
    expect(dir("/abs")).toEqual(["must be relative to the output file's directory"]);
    expect(dir("~/x")).toEqual(["must be relative to the output file's directory"]);
    expect(dir("a\\b")).toEqual(["must not contain a backslash or NUL"]);
    expect(dir("{{content}}")).toEqual([
      expect.stringContaining("placeholder {{content}} is not available here"),
    ]);
    expect(dir(4)).toEqual(["must be a string, not a number"]);
  });

  it("checks inlineOrder completeness, unknown values and duplicates", () => {
    const order = [...INLINE_FORMATS];
    expect(templateErrors({ schemaVersion: 1, inlineOrder: order })).toEqual([]);
    expect(
      templateErrors({ schemaVersion: 1, inlineOrder: [...order.slice(0, 7), "bold", "blink"] })
    ).toEqual([
      { path: "$.inlineOrder[7]", message: 'duplicate format "bold"' },
      {
        path: "$.inlineOrder[8]",
        message: expect.stringMatching(/^must be one of .*"link"$/),
      },
      { path: "$.inlineOrder", message: 'must list every inline format; missing "color", "link"' },
    ]);
    expect(paths({ schemaVersion: 1, inlineOrder: "bold" })).toEqual(["$.inlineOrder"]);
  });

  it("checks each rule's mode and the fields that mode needs", () => {
    expect(
      templateErrors({
        schemaVersion: 1,
        rules: {
          "block.title": { before: "# " },
          "block.body": { mode: "shout" },
          "inline.bold": { mode: "wrap", before: "**" },
          "inline.italic": { mode: "pattern", value: "{{content}}", before: "x", join: "tight" },
          "inline.link": { mode: "plain", value: "x" },
          "document.header": { mode: "pattern", value: "{{nope}} {{title:upper}} {{ title }}" },
          "block.code": "wrap",
          "attachment.image": { mode: "linePrefix", value: "x".repeat(4097) },
        },
      })
    ).toEqual([
      {
        path: '$.rules["attachment.image"].value',
        message: "must be at most 4096 characters (is 4097)",
      },
      {
        path: '$.rules["block.body"].mode',
        message: 'must be one of "wrap", "linePrefix", "pattern", "plain", "omit"',
      },
      { path: '$.rules["block.code"]', message: "must be an object, not a string" },
      {
        path: '$.rules["block.title"].mode',
        message: 'is required; one of "wrap", "linePrefix", "pattern", "plain", "omit"',
      },
      {
        path: '$.rules["document.header"].value',
        message: expect.stringContaining("unknown placeholder {{nope}}"),
      },
      {
        path: '$.rules["document.header"].value',
        message: "unknown modifier in {{title:upper}}; allowed modifiers are raw, yaml",
      },
      { path: '$.rules["inline.bold"].after', message: 'is required when mode is "wrap"' },
      { path: '$.rules["inline.italic"].before', message: 'is not used when mode is "pattern"' },
      {
        path: '$.rules["inline.italic"].join',
        message: 'must be one of "line", "paragraph"',
      },
      { path: '$.rules["inline.link"].value', message: 'is not used when mode is "plain"' },
    ]);
  });

  it("throws every error at once", () => {
    try {
      validateTemplate({ schemaVersion: 1, bad: true, extends: 3 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      const e = error as TemplateValidationError;
      expect(e.code).toBe("invalid-template");
      expect(e.errors).toHaveLength(2);
      expect(e.message).toBe(
        'Invalid template (2 problems): $.bad: unknown key; allowed keys are "schemaVersion", "name", "description", "extends", "assets", "inlineOrder", "rules", "options"; $.extends: must be one of "standard-markdown", "obsidian", not a number'
      );
    }
    expect(() => validateTemplate({})).toThrow("Invalid template (1 problem)");
  });

  it("parses JSON text under the size cap", () => {
    expect(parseTemplate('{"schemaVersion":1,"name":"x"}')).toEqual({
      schemaVersion: 1,
      name: "x",
    });
    expect(() => parseTemplate("{")).toThrow("$: not valid JSON at line 1, column 2");
    expect(() => parseTemplate('{\n  "a": 1,\n}')).toThrow("not valid JSON at line 3, column 1");
  });

  it("reports only where JSON is invalid, never the text", () => {
    for (const text of ["SECRET=hunter2", '{"token": SECRET}', '{"a": "SECRET"', ""]) {
      const error = (() => {
        try {
          parseTemplate(text);
        } catch (e) {
          return e as TemplateValidationError;
        }
      })();
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect(error?.message).toMatch(/^Invalid template \(1 problem\): \$: not valid JSON/);
      expect(error?.message).not.toMatch(/SECRET|hunter2|token/);
    }
    expect(jsonErrorLocation("ab\ncd", "Unexpected token in JSON at position 4")).toEqual({
      line: 2,
      column: 2,
    });
    expect(jsonErrorLocation("x", "Unexpected token 'x', \"x\" is not valid JSON")).toBeUndefined();
    expect(() => parseTemplate(" ".repeat(MAX_TEMPLATE_BYTES + 1))).toThrow(
      `the limit is ${MAX_TEMPLATE_BYTES}`
    );
  });
});

describe("placeholders", () => {
  it("finds tokens with modifiers", () => {
    expect(placeholderTokens("a {{title}} {{ tags:yaml }} {{a b}}")).toEqual([
      { token: "{{title}}", name: "title" },
      { token: "{{ tags:yaml }}", name: "tags", modifier: "yaml" },
      { token: "{{a b}}", name: "a b" },
    ]);
  });

  it("fills Markdown, raw and YAML forms; missing values are empty or null", () => {
    const values = {
      title: { md: "a\\*b", raw: "a*b" },
      tags: { md: "x, y", raw: "x, y", list: ["x", "y"] },
      id: "p1",
    };
    expect(
      fillPlaceholders(
        "{{title}}|{{title:raw}}|{{title:yaml}}|{{tags:yaml}}|{{id}}|{{folder}}|{{folder:yaml}}|{{folder:raw}}|{{x y}}",
        values
      )
    ).toBe('a\\*b|a*b|"a*b"|["x","y"]|p1||null||');
  });

  it("detects which rules use a placeholder", () => {
    expect(ruleUses({ mode: "wrap", before: "<{{color}}>", after: "" }, "color")).toBe(true);
    expect(ruleUses({ mode: "plain" }, "color")).toBe(false);
  });
});

describe("documented examples", () => {
  const doc = readFileSync(new URL("../../docs/markdown-templates.md", import.meta.url), "utf8");
  const templates = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]) as unknown)
    .filter((value) => !Array.isArray(value));

  it("are valid templates", () => {
    expect(templates.length).toBeGreaterThanOrEqual(2);
    for (const template of templates) expect(templateErrors(template)).toEqual([]);
  });

  it("documents the standard inline order and every rule id", () => {
    expect(doc).toContain(JSON.stringify(INLINE_FORMATS).replace(/,/g, ", "));
    for (const id of RULE_IDS)
      expect(doc.includes(`\`${id}\``) || doc.includes(`.${id.split(".").at(-1)}\``), id).toBe(
        true
      );
  });
});
