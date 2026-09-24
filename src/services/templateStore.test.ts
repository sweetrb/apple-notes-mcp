/**
 * The template library against a real temporary directory, and the library
 * tools through a captured registerTool. Notes is never touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateStore, TemplateStoreError, templateDir } from "./templateStore.js";
import { MAX_TEMPLATE_BYTES, TemplateValidationError } from "../utils/markdownTemplate.js";
import { registerMarkdownTemplates } from "../tools/markdownTemplates.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

let root: string;
const editorial = JSON.stringify({
  schemaVersion: 1,
  name: "Editorial",
  description: "House style",
  extends: "obsidian",
  rules: { "inline.bold": { mode: "wrap", before: "__", after: "__" } },
});
/** Mode and text of one file, both read through a single descriptor. */
const openedFile = (path: string) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return { mode: fstatSync(fd).mode, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TemplateStoreError || error instanceof TemplateValidationError)
      return error.code;
    return String(error);
  }
  return "no error";
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "template-store-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("templateDir", () => {
  it("defaults under Application Support and honors an absolute override", () => {
    expect(templateDir({})).toBe(
      join(homedir(), "Library/Application Support/apple-notes-mcp/templates")
    );
    expect(templateDir({ APPLE_NOTES_MCP_TEMPLATE_DIR: " /x/y/ " })).toBe("/x/y");
    expect(code(() => templateDir({ APPLE_NOTES_MCP_TEMPLATE_DIR: "rel" }))).toBe("unsafe-path");
  });
});

describe("TemplateStore", () => {
  it("lists nothing before the library exists, then saves create-only with private modes", () => {
    const store = new TemplateStore(join(root, "lib1", "templates"));
    expect(store.list()).toEqual({ templates: [], skipped: 0, dir: store.dir });
    expect(store.find("house")).toBeUndefined();
    const saved = store.save("house", editorial);
    expect(saved).toMatchObject({ replaced: false, path: join(store.dir, "house.json") });
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    const file = openedFile(saved.path);
    expect(file.mode & 0o777).toBe(0o600);
    expect(JSON.parse(file.text)).toEqual(JSON.parse(editorial));
    expect(code(() => store.save("house", editorial))).toBe("template-exists");
    const replaced = store.save("house", JSON.stringify({ schemaVersion: 1 }), { force: true });
    expect(replaced.replaced).toBe(true);
    expect(store.get("house")).toEqual({ schemaVersion: 1 });
    expect(readdirSync(store.dir)).toEqual(["house.json"]);
  });

  it("validates before saving and reserves built-in and malformed names", () => {
    const store = new TemplateStore(join(root, "lib2"));
    expect(code(() => store.save("bad", '{"schemaVersion":2}'))).toBe("invalid-template");
    expect(code(() => store.save("standard-markdown", editorial))).toBe("reserved-name");
    expect(code(() => store.delete("obsidian"))).toBe("reserved-name");
    for (const name of ["Upper", "-x", "a/b", "../x", "x".repeat(65), ""])
      expect(code(() => store.save(name, editorial))).toBe("invalid-name");
    expect(existsSync(store.dir)).toBe(false);
  });

  it("lists valid templates and skips corrupt, oversize, unsafe and stray entries", () => {
    const dir = join(root, "lib3");
    const store = new TemplateStore(dir);
    store.save("zeta", editorial);
    store.save("alpha", JSON.stringify({ schemaVersion: 1, name: "alpha" }));
    writeFileSync(join(dir, "corrupt.json"), "{");
    writeFileSync(join(dir, "invalid.json"), '{"schemaVersion":1,"x":1}');
    writeFileSync(join(dir, "big.json"), Buffer.alloc(MAX_TEMPLATE_BYTES + 1, 32));
    writeFileSync(join(dir, "Bad Name.json"), "{}");
    writeFileSync(join(dir, "obsidian.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, ".hidden.json"), "{}");
    symlinkSync(join(dir, "zeta.json"), join(dir, "linked.json"));
    mkdirSync(join(dir, "folder.json"));
    const listing = store.list();
    expect(listing.templates.map((t) => t.name)).toEqual(["alpha", "zeta"]);
    expect(listing.templates[1]).toMatchObject({
      displayName: "Editorial",
      description: "House style",
      extends: "obsidian",
    });
    expect(listing.templates[0].displayName).toBeUndefined();
    expect(listing.skipped).toBe(7);
    expect(code(() => store.find("corrupt"))).toBe("invalid-template");
    expect(code(() => store.find("big"))).toBe("invalid-template");
    expect(code(() => store.find("linked"))).toBe("unsafe-path");
    expect(code(() => store.find("folder"))).toBe("unsafe-path");
    expect(code(() => store.get("missing"))).toBe("template-not-found");
  });

  it("refuses a symlinked library root and never replaces a non-regular entry", () => {
    const real = join(root, "real-lib");
    mkdirSync(real);
    symlinkSync(real, join(root, "link-lib"));
    const linked = new TemplateStore(join(root, "link-lib"));
    expect(code(() => linked.list())).toBe("unsafe-path");
    expect(code(() => linked.save("x", editorial))).toBe("unsafe-path");
    const store = new TemplateStore(join(root, "lib4"));
    store.save("keep", editorial);
    symlinkSync(join(store.dir, "keep.json"), join(store.dir, "link.json"));
    expect(code(() => store.save("link", editorial, { force: true }))).toBe("unsafe-path");
    expect(code(() => store.delete("link"))).toBe("unsafe-path");
    mkdirSync(join(store.dir, "dir.json"));
    expect(code(() => store.save("dir", editorial, { force: true }))).toBe("unsafe-path");
  });

  it("deletes saved templates only", () => {
    const store = new TemplateStore(join(root, "lib5"));
    expect(code(() => store.delete("gone"))).toBe("template-not-found");
    store.save("temp", editorial);
    expect(store.delete("temp")).toEqual({ path: join(store.dir, "temp.json") });
    expect(code(() => store.delete("temp"))).toBe("template-not-found");
  });

  it("surfaces unexpected write errors", () => {
    const dir = join(root, "lib6");
    const store = new TemplateStore(dir);
    store.save("a", editorial);
    chmodSync(dir, 0o500);
    try {
      expect(code(() => store.save("b", editorial))).toMatch(/EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("TemplateStore file safety", () => {
  it("removes its temporary file when writing it fails", () => {
    const store = new TemplateStore(join(root, "lib7"));
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    expect(code(() => store.save("a", editorial))).toMatch(/ENOSPC/);
    expect(readdirSync(store.dir)).toEqual([]);
  });

  it("refuses a FIFO without blocking and reports only symlinks as unsafe paths", () => {
    const store = new TemplateStore(join(root, "lib8"));
    store.save("ok", editorial);
    execFileSync("mkfifo", [join(store.dir, "pipe.json")]);
    expect(code(() => store.find("pipe"))).toBe("unsafe-path");
    symlinkSync(join(store.dir, "ok.json"), join(store.dir, "link.json"));
    expect(code(() => store.find("link"))).toBe("unsafe-path");
    chmodSync(join(store.dir, "ok.json"), 0o000);
    try {
      expect(code(() => store.find("ok"))).toMatch(/EACCES/);
    } finally {
      chmodSync(join(store.dir, "ok.json"), 0o600);
    }
    expect(store.list()).toMatchObject({ templates: [{ name: "ok" }], skipped: 2 });
  });
});

describe("template library tools", () => {
  const tools = () => {
    const registerTool = vi.fn();
    const store = new TemplateStore(join(root, "tools-lib"));
    registerMarkdownTemplates({ registerTool } as unknown as McpServer, () => store);
    const byName = Object.fromEntries(
      registerTool.mock.calls.map(([name, config, handler]) => [name, { config, handler }])
    );
    return { byName, store };
  };

  it("registers five tools with descriptions and schemas", () => {
    const { byName } = tools();
    expect(Object.keys(byName).sort()).toEqual([
      "delete-markdown-template",
      "list-markdown-templates",
      "save-markdown-template",
      "show-markdown-template",
      "validate-markdown-template",
    ]);
    for (const { config } of Object.values(byName) as Array<{ config: { description: string } }>)
      expect(config.description).toMatch(
        /^Use when: .*\nReturns: .*\nDo not use when: .*\nSafety: /s
      );
  });

  it("saves, lists, shows, validates and deletes through the tools", async () => {
    const { byName } = tools();
    const call = (name: string, args: Record<string, unknown> = {}) => byName[name].handler(args);

    const saved = await call("save-markdown-template", {
      name: "house",
      template: JSON.parse(editorial),
    });
    expect(saved.structuredContent).toMatchObject({ name: "house", replaced: false });
    const again = await call("save-markdown-template", { name: "house", template: editorial });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("[template-exists]");
    const file = join(root, "tpl.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "from file" }));
    expect(
      (await call("save-markdown-template", { name: "house", templateFile: file, force: true }))
        .structuredContent
    ).toMatchObject({ replaced: true });
    const invalid = await call("save-markdown-template", {
      name: "bad",
      template: { schemaVersion: 1, rules: { "inline.bold": { mode: "wrap" } } },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toBe(
      'Error saving template [invalid-template]: the template is invalid:\n$.rules["inline.bold"].before: is required when mode is "wrap"\n$.rules["inline.bold"].after: is required when mode is "wrap"'
    );
    expect((await call("save-markdown-template", { name: "x" })).content[0].text).toContain(
      "exactly one of 'template' or 'templateFile'"
    );

    const listed = await call("list-markdown-templates");
    expect(listed.structuredContent.builtins.map((b: { name: string }) => b.name)).toEqual([
      "standard-markdown",
      "obsidian",
    ]);
    expect(listed.structuredContent.templates.map((t: { name: string }) => t.name)).toEqual([
      "house",
    ]);

    const shown = await call("show-markdown-template", { name: "house", expanded: true });
    expect(shown.structuredContent).toMatchObject({
      name: "house",
      source: "saved",
      template: { schemaVersion: 1, name: "from file" },
    });
    expect(Object.keys(shown.structuredContent.expanded.rules)).toHaveLength(43);
    const builtin = await call("show-markdown-template", { name: "obsidian" });
    expect(builtin.structuredContent.source).toBe("builtin");
    expect(builtin.structuredContent.expanded).toBeUndefined();
    expect((await call("show-markdown-template", { name: "nope" })).content[0].text).toContain(
      "[template-not-found]"
    );

    expect((await call("validate-markdown-template", { name: "house" })).structuredContent).toEqual(
      {
        valid: true,
        errors: [],
      }
    );
    expect(
      (await call("validate-markdown-template", { name: "standard-markdown" })).structuredContent
        .valid
    ).toBe(true);
    const bad = await call("validate-markdown-template", { template: '{"schemaVersion":1,"x":1}' });
    expect(bad.isError).toBeUndefined();
    expect(bad.structuredContent).toEqual({
      valid: false,
      errors: [{ path: "$.x", message: expect.stringContaining("unknown key") }],
    });
    expect(
      (await call("validate-markdown-template", { templateFile: file })).structuredContent.valid
    ).toBe(true);
    expect((await call("validate-markdown-template", {})).isError).toBe(true);
    expect(
      (await call("validate-markdown-template", { name: "missing" })).content[0].text
    ).toContain("[template-not-found]");

    expect(
      (await call("delete-markdown-template", { name: "house" })).structuredContent
    ).toMatchObject({
      name: "house",
      deleted: true,
    });
    expect(
      (await call("delete-markdown-template", { name: "standard-markdown" })).content[0].text
    ).toContain("[reserved-name]");
  });

  it("returns none of a file's contents when it is not a template", async () => {
    // templateFile can name any readable file under home, a temp dir or /Volumes.
    const { byName, store } = tools();
    const call = (name: string, args: Record<string, unknown> = {}) => byName[name].handler(args);
    const files = {
      "config.json": JSON.stringify({ apiKey: "SECRET-1", nested: { password: "SECRET-2" } }),
      "versioned.json": JSON.stringify({ schemaVersion: "SECRET-3", token: "SECRET-4" }),
      "broken.json": '{"token": SECRET-5',
      "words.json": "SECRET-6 hunter2",
      "notes.txt": JSON.stringify({ schemaVersion: 1, name: "SECRET-7" }),
    };
    for (const [name, text] of Object.entries(files)) {
      const templateFile = join(root, name);
      writeFileSync(templateFile, text);
      for (const result of [
        await call("validate-markdown-template", { templateFile }),
        await call("save-markdown-template", { name: "leak", templateFile }),
      ]) {
        const shown = JSON.stringify([result.content, result.structuredContent]);
        expect(shown, name).not.toMatch(/SECRET|hunter2|apiKey|password|token|nested/);
        expect(result.structuredContent?.valid, name).not.toBe(true);
      }
    }
    expect(store.list().templates).toEqual([]);
  });

  it("reports an unusable library as a listing error", async () => {
    const registerTool = vi.fn();
    writeFileSync(join(root, "not-a-dir"), "x");
    registerMarkdownTemplates(
      { registerTool } as unknown as McpServer,
      () => new TemplateStore(join(root, "not-a-dir"))
    );
    const list = registerTool.mock.calls.find(([name]) => name === "list-markdown-templates")![2];
    const result = await list({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[unsafe-path]");
  });

  it("uses the default store when none is injected", () => {
    const registerTool = vi.fn();
    registerMarkdownTemplates({ registerTool } as unknown as McpServer);
    expect(registerTool).toHaveBeenCalledTimes(5);
  });
});
