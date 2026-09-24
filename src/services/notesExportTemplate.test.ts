/**
 * Templated exportNotesMarkdown with injected note loading and metadata.
 * Files are written only to a temp directory; Notes and its database are
 * never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseTemplate,
  exportNotesMarkdown,
  MAX_EXPORT_WARNINGS,
  NotesExportError,
  type NotesExportDeps,
} from "./notesExport.js";
import { NoteBlocksError } from "../utils/noteBlocks.js";
import type { AssetLocator } from "../utils/exportAssets.js";
import { attachment, attachmentRun, block, exportNote } from "../utils/fixtures/exportNote.js";
import type { ExportNote } from "../utils/noteExportData.js";
import {
  builtinTemplate,
  resolveTemplate,
  TemplateValidationError,
  usesNoteMeta,
} from "../utils/markdownTemplate.js";

const ID = (n: number) => `x-coredata://FIXTURE/ICNote/p${n}`;
let dir: string;
let source: string;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
const hashed = `pic-${createHash("sha256").update(png).digest("hex").slice(0, 8)}.png`;

const notes: Record<string, ExportNote> = {};
const deps = (extra: Partial<NotesExportDeps> = {}): NotesExportDeps => ({
  listNoteRefs: () => [ID(1), ID(2), ID(3)].map((id) => ({ id, title: "t" })),
  readNote: (id) => {
    if (id === ID(2)) throw new NoteBlocksError("encrypted", "locked");
    return notes[id];
  },
  readMeta: (id) => {
    if (id === ID(1)) throw new NoteBlocksError("query-failed", "x");
    return { uuid: "UUID-3", folder: "Work/Plans", created: "2026-01-01T00:00:00Z" };
  },
  locator: {
    locate: () => ({ primary: { path: source, name: "pic.png", role: "original" } }),
  } as unknown as AssetLocator,
  maxInlineBytes: 1024 * 1024,
  ...extra,
});

const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof NotesExportError)
      return { code: error.code, message: error.message, details: error.details };
    return { code: String(error) };
  }
  return { code: "no error" };
};

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "notes-export-template-")));
  source = join(dir, "source.png");
  writeFileSync(source, png);
  notes[ID(1)] = { ...exportNote([block("One", "title"), block("text")]), id: ID(1) };
  notes[ID(3)] = {
    ...exportNote(
      [block("Three", "title"), block("￼", "body", {}, [attachmentRun("IMG", "public.png")])],
      [attachment("IMG", "public.png", { title: "pic.png" })]
    ),
    id: ID(3),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("chooseTemplate", () => {
  it("resolves built-ins, saved templates and files, and refuses both at once", () => {
    expect(chooseTemplate({}, {})).toBeUndefined();
    expect(chooseTemplate({ template: "obsidian" }, {})!.info).toEqual({
      name: "obsidian",
      source: "builtin",
    });
    const saved = chooseTemplate(
      { template: "mine" },
      { findTemplate: (name) => (name === "mine" ? { schemaVersion: 1 } : undefined) }
    )!;
    expect(saved.info).toEqual({ name: "mine", source: "saved" });
    expect(saved.template.name).toBe("mine");
    expect(failure(() => chooseTemplate({ template: "other" }, {}))).toMatchObject({
      code: "template-not-found",
      message: 'No template named "other".',
    });
    expect(
      failure(() =>
        chooseTemplate(
          { template: "bad" },
          {
            findTemplate: () => {
              throw new TemplateValidationError([{ path: "$.x", message: "unknown key" }]);
            },
          }
        )
      )
    ).toMatchObject({
      code: "invalid-template",
      details: [{ path: "$.x", message: "unknown key" }],
    });
    expect(
      failure(() =>
        chooseTemplate(
          { template: "boom" },
          {
            findTemplate: () => {
              throw new Error("disk");
            },
          }
        )
      ).code
    ).toBe("Error: disk");
    expect(failure(() => chooseTemplate({ template: "a", templateFile: "/b" }, {})).code).toBe(
      "invalid-request"
    );
  });

  it("reads a template file, naming it by its name field or file name", () => {
    const named = join(dir, "named.json");
    writeFileSync(named, JSON.stringify({ schemaVersion: 1, name: "Pretty" }));
    expect(chooseTemplate({ templateFile: named }, {})!.info).toEqual({
      name: "Pretty",
      source: "file",
    });
    const unnamed = join(dir, "house-style.json");
    writeFileSync(unnamed, JSON.stringify({ schemaVersion: 1 }));
    expect(chooseTemplate({ templateFile: unnamed }, {})!.info.name).toBe("house-style");
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({ schemaVersion: 1, rules: { "inline.bold": { mode: "wrap" } } })
    );
    const result = failure(() => chooseTemplate({ templateFile: bad }, {}));
    expect(result.code).toBe("invalid-template");
    expect(result.details).toEqual([
      { path: '$.rules["inline.bold"].before', message: 'is required when mode is "wrap"' },
      { path: '$.rules["inline.bold"].after', message: 'is required when mode is "wrap"' },
    ]);
    expect(
      failure(() => chooseTemplate({ templateFile: join(dir, "none.json") }, {}))
    ).toMatchObject({
      code: "invalid-path",
      message: expect.stringContaining("templateFile: Template file does not exist"),
    });
  });

  it("never quotes a templateFile's contents in a refusal or a parse error", () => {
    const secret = "hunter2-SECRET-VALUE";
    const bodies = [
      `{"auths":{"registry.example":{"auth":"${secret}"}}}`,
      `{"schemaVersion":"${secret}"}`,
      `{"token": ${secret}}`,
      `${secret}`,
    ];
    bodies.forEach((body, index) => {
      const file = join(dir, `leak-${index}.json`);
      writeFileSync(file, body);
      const result = failure(() => chooseTemplate({ templateFile: file }, {}));
      expect(result.code).toBe("invalid-template");
      expect(JSON.stringify(result)).not.toContain(secret);
    });
    mkdirSync(join(dir, ".docker"), { recursive: true });
    const hidden = join(dir, ".docker", "config.json");
    writeFileSync(hidden, bodies[0]);
    const refused = failure(() => chooseTemplate({ templateFile: hidden }, {}));
    expect(refused).toMatchObject({
      code: "invalid-path",
      message: expect.stringContaining("hidden file or directory"),
    });
    expect(JSON.stringify(refused)).not.toContain(secret);
  });
});

describe("exportNotesMarkdown with a template", () => {
  it("renders standard-markdown inline exactly like the default export, with warnings", () => {
    const plain = exportNotesMarkdown({ id: ID(3) }, deps());
    const templated = exportNotesMarkdown({ id: ID(3), template: "standard-markdown" }, deps());
    expect(templated.markdown).toBe(plain.markdown);
    expect(templated).toMatchObject({
      template: { name: "standard-markdown", source: "builtin" },
      warnings: [],
      count: 1,
    });
    expect(templated.assetFiles).toBeUndefined();
  });

  it("reads note metadata only when a placeholder uses it", () => {
    const reads: string[] = [];
    const counting = (id: string) => {
      reads.push(id);
      return {};
    };
    exportNotesMarkdown({ id: ID(3), template: "standard-markdown" }, deps({ readMeta: counting }));
    expect(reads).toEqual([]);
    exportNotesMarkdown({ id: ID(3), template: "obsidian" }, deps({ readMeta: counting }));
    expect(reads).toEqual([ID(3)]);
    expect(usesNoteMeta(resolveTemplate(builtinTemplate("standard-markdown")))).toBe(false);
    expect(usesNoteMeta(resolveTemplate(builtinTemplate("obsidian")))).toBe(true);
    const assetsOnly = resolveTemplate({
      schemaVersion: 1,
      assets: { mode: "copy", directory: "{{folder}}" },
    });
    expect(usesNoteMeta(assetsOnly)).toBe(true);
  });

  it("copies assets under hashed names into the obsidian directory beside outputPath", () => {
    const output = join(dir, "o1", "My Notes.md");
    const receipt = exportNotesMarkdown(
      { folder: "Notes", template: "obsidian", outputPath: output },
      deps()
    );
    const assets = join(dir, "o1", "My Notes.assets");
    expect(receipt).toMatchObject({
      count: 2,
      output,
      skipped: [{ id: ID(2), code: "encrypted" }],
      template: { name: "obsidian", source: "builtin" },
      assets: { dir: assets, files: 1 },
      assetFiles: [join(assets, hashed)],
      warnings: [],
    });
    expect(receipt.markdown).toBeUndefined();
    const text = readFileSync(output, "utf8");
    expect(text).toContain('---\ntitle: "One"\ncreated: null\n');
    expect(text).toContain(
      'title: "Three"\ncreated: "2026-01-01T00:00:00Z"\nmodified: null\nfolder: "Work/Plans"'
    );
    expect(text).toContain(`![pic.png](My%20Notes.assets/${hashed})`);
    expect(readFileSync(join(assets, hashed))).toEqual(png);

    // A second export into a new file reuses the identical asset.
    const again = exportNotesMarkdown(
      { id: ID(3), template: "obsidian", outputPath: join(dir, "o1", "My Notes-2.md") },
      deps()
    );
    expect(again.assetFiles).toEqual([join(dir, "o1", "My Notes-2.assets", hashed)]);
  });

  it("puts each note's assets in its own directory when the template asks", () => {
    const file = join(dir, "per-note.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        assets: { directory: "media/{{folder}}", pathStyle: "absolute" },
      })
    );
    const output = join(dir, "o2", "out.md");
    const receipt = exportNotesMarkdown(
      { id: ID(3), templateFile: file, outputPath: output },
      deps()
    );
    const target = join(dir, "o2", "media", "Work_Plans", hashed);
    expect(receipt.assetFiles).toEqual([target]);
    expect(readFileSync(output, "utf8")).toContain(`](${encodeURI(target)})`);
  });

  it("uses assetsDir when given, and warns when a template wants copies but has nowhere to put them", () => {
    const assetsDir = join(dir, "o3", "files");
    const withDir = exportNotesMarkdown({ id: ID(3), template: "obsidian", assetsDir }, deps());
    expect(withDir.assets).toEqual({ dir: assetsDir, files: 1 });
    expect(withDir.markdown).toContain(`](${encodeURI(join(assetsDir, hashed))})`);

    const nowhere = exportNotesMarkdown({ id: ID(3), template: "obsidian" }, deps());
    expect(nowhere.warnings).toEqual([
      { code: "assets_dir_required", noteId: ID(3), attachmentId: "IMG" },
    ]);
    expect(nowhere.markdown).toContain("\\[Image: pic.png\\]");
  });

  it("links originals in reference mode and refuses assetsDir outside copy mode", () => {
    const file = join(dir, "reference.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, assets: { mode: "reference" } }));
    const output = join(dir, "o4", "ref.md");
    const receipt = exportNotesMarkdown(
      { id: ID(3), templateFile: file, outputPath: output },
      deps()
    );
    expect(readFileSync(output, "utf8")).toContain("](../source.png)");
    expect(receipt.assetFiles).toBeUndefined();
    expect(existsSync(join(dir, "o4"))).toBe(true);
    expect(readdirSync(join(dir, "o4"))).toEqual(["ref.md"]);
    expect(
      failure(() =>
        exportNotesMarkdown({ id: ID(3), templateFile: file, assetsDir: join(dir, "x") }, deps())
      ).code
    ).toBe("invalid-request");
  });

  it("validates the template and asset directory before writing anything", () => {
    const escaping = join(dir, "escape.json");
    writeFileSync(
      escaping,
      JSON.stringify({ schemaVersion: 1, assets: { directory: "{{title}}" } })
    );
    notes[ID(4)] = { ...exportNote([block("..", "title")]), id: ID(4), title: "" };
    const output = join(dir, "o5", "out.md");
    const ok = exportNotesMarkdown(
      { id: ID(4), templateFile: escaping, outputPath: output },
      deps({ readMeta: () => ({}) })
    );
    expect(ok.count).toBe(1);

    const self = join(dir, "self.json");
    writeFileSync(
      self,
      JSON.stringify({ schemaVersion: 1, assets: { directory: "{{exportStem}}.md" } })
    );
    const selfOut = join(dir, "o6", "same.md");
    expect(
      failure(() =>
        exportNotesMarkdown({ id: ID(3), templateFile: self, outputPath: selfOut }, deps())
      )
    ).toMatchObject({ code: "invalid-path", message: "assets.directory resolves to outputPath." });
    expect(existsSync(selfOut)).toBe(false);

    const inContainer = join(dir, "container.json");
    writeFileSync(inContainer, JSON.stringify({ schemaVersion: 1, assets: { directory: "x" } }));
    const escapeOut = "/etc/out.md";
    expect(
      failure(() =>
        exportNotesMarkdown({ id: ID(3), templateFile: inContainer, outputPath: escapeOut }, deps())
      ).code
    ).toBe("invalid-path");

    expect(failure(() => exportNotesMarkdown({ id: ID(3), template: "nope" }, deps())).code).toBe(
      "template-not-found"
    );
  });

  it("refuses an existing output and caps listed warnings", () => {
    const output = join(dir, "o7", "taken.md");
    mkdirSync(join(dir, "o7"));
    writeFileSync(output, "keep");
    expect(
      failure(() =>
        exportNotesMarkdown({ id: ID(3), template: "obsidian", outputPath: output }, deps())
      ).code
    ).toBe("output_exists");
    expect(readFileSync(output, "utf8")).toBe("keep");

    const markers = Array.from({ length: MAX_EXPORT_WARNINGS + 5 }, (_, i) =>
      attachmentRun(`M${i}`)
    );
    notes[ID(5)] = {
      ...exportNote([block("T", "title"), block("￼".repeat(markers.length), "body", {}, markers)]),
      id: ID(5),
    };
    const receipt = exportNotesMarkdown({ id: ID(5), template: "standard-markdown" }, deps());
    expect(receipt.warnings).toHaveLength(MAX_EXPORT_WARNINGS);
    expect(receipt.warningsOmitted).toBe(5);
    expect(receipt.warnings![0]).toEqual({
      code: "attachment_not_found",
      noteId: ID(5),
      attachmentId: "M0",
    });
  });

  it("refuses an oversize inline document and closes a started file on render failure", () => {
    expect(
      failure(() =>
        exportNotesMarkdown(
          { id: ID(3), template: "standard-markdown" },
          deps({ maxInlineBytes: 5 })
        )
      ).code
    ).toBe("too-large");
    const output = join(dir, "o8", "broken.md");
    const broken = { ...notes[ID(3)], doc: null } as unknown as ExportNote;
    expect(
      failure(() =>
        exportNotesMarkdown(
          { id: ID(3), template: "standard-markdown", outputPath: output },
          deps({ readNote: () => broken })
        )
      ).code
    ).toMatch(/TypeError/);
    expect(readFileSync(output, "utf8")).toBe("");
  });
});
