/**
 * exportNotesMarkdown with injected note loading. Files are written only to a
 * temp directory; Notes and its database are never touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FOLDER_EXPORT_LIMIT,
  defaultSidecarDir,
  exportNotesHtml,
  exportNotesMarkdown,
  MAX_FOLDER_EXPORT_LIMIT,
  NotesExportError,
  type NotesExportDeps,
} from "./notesExport.js";
import { NoteBlocksError } from "../utils/noteBlocks.js";
import { NOTES_CONTAINER, type AssetLocator } from "../utils/exportAssets.js";
import { attachment, attachmentRun, block, exportNote } from "../utils/fixtures/exportNote.js";
import type { ExportNote } from "../utils/noteExportData.js";
import type { NoteDrawing, NoteDrawingsResult } from "../types.js";
import { PublicHelperError } from "./publicHelper.js";

const ID = (n: number) => `x-coredata://FIXTURE/ICNote/p${n}`;
let dir: string;
let source: string;

const notes: Record<string, ExportNote> = {};
const deps = (extra: Partial<NotesExportDeps> = {}): NotesExportDeps => ({
  listNoteRefs: () => [ID(1), ID(2), ID(3)].map((id) => ({ id, title: "t" })),
  readNote: (id) => {
    if (id === ID(2)) throw new NoteBlocksError("encrypted", "locked");
    if (!notes[id]) throw new NoteBlocksError("not-found", "gone");
    return notes[id];
  },
  locator: {
    locate: () => ({ primary: { path: source, name: "pic.png", role: "original" } }),
  } as unknown as AssetLocator,
  maxInlineBytes: 1024 * 1024,
  ...extra,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NotesExportError ? error.code : String(error);
  }
  return "no error";
};

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "notes-export-")));
  source = join(dir, "source.png");
  writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  notes[ID(1)] = exportNote([block("One", "title"), block("text")]);
  notes[ID(3)] = exportNote(
    [block("Three", "title"), block("\ufffc", "body", {}, [attachmentRun("IMG", "public.png")])],
    [attachment("IMG", "public.png", { title: "pic.png" })]
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A note with one classic drawing (DRW<n>) and one Paper drawing (PAP<n>). */
function drawingNote(n: number): ExportNote {
  return {
    ...exportNote(
      [
        block(`Sketch ${n}`, "title"),
        block("\ufffc\ufffc", "body", {}, [
          attachmentRun(`DRW${n}`, "com.apple.drawing.2"),
          attachmentRun(`PAP${n}`, "com.apple.paper"),
        ]),
      ],
      [attachment(`DRW${n}`, "com.apple.drawing.2"), attachment(`PAP${n}`, "com.apple.paper")]
    ),
    id: ID(n),
  };
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';

const drawings = (noteId: string, ...list: Partial<NoteDrawing>[]): NoteDrawingsResult => ({
  id: noteId,
  drawingCount: list.length,
  status: "ok",
  drawings: list.map((d) => ({
    attachmentId: "x-coredata://FIXTURE/ICAttachment/p9",
    identifier: `DRW${noteId.split("/p")[1]}`,
    typeUti: "com.apple.drawing.2",
    status: "ok",
    svg: SVG,
    truncated: false,
    ...d,
  })),
});

const drawingDeps = (readDrawings: NotesExportDeps["readDrawings"]) =>
  deps({
    listNoteRefs: () => [ID(4), ID(5)].map((id) => ({ id, title: "t" })),
    readNote: (id) => drawingNote(Number(id.split("/p")[1])),
    readDrawings,
  });

describe("exportNotesMarkdown", () => {
  it("returns one note inline with placeholders when no assetsDir is given", () => {
    const receipt = exportNotesMarkdown({ id: ID(3) }, deps());
    expect(receipt).toMatchObject({
      format: "markdown",
      count: 1,
      markdown: "# Three\n\n\\[Image: pic.png\\]\n",
      skipped: [],
    });
    expect(receipt.bytes).toBe(Buffer.byteLength(receipt.markdown!));
    expect(receipt.stats.placeholders).toBe(1);
    expect(receipt.output).toBeUndefined();
  });

  it("exports a folder, skipping unreadable notes, and passes the limit", () => {
    const listNoteRefs = vi.fn(deps().listNoteRefs);
    const receipt = exportNotesMarkdown({ folder: "F", account: "A" }, deps({ listNoteRefs }));
    // One past the limit, to tell whether the folder holds more (#209).
    expect(listNoteRefs).toHaveBeenCalledWith("A", "F", undefined, DEFAULT_FOLDER_EXPORT_LIMIT + 1);
    expect(receipt.count).toBe(2);
    expect(receipt.truncated).toBeUndefined();
    expect(receipt.skipped).toEqual([{ id: ID(2), code: "encrypted" }]);
    expect(receipt.markdown).toContain("\n\n---\n\n# Three");
    exportNotesMarkdown({ folder: "F", limit: 5000 }, deps({ listNoteRefs }));
    expect(listNoteRefs).toHaveBeenLastCalledWith(
      undefined,
      "F",
      undefined,
      MAX_FOLDER_EXPORT_LIMIT + 1
    );
  });

  it("reports truncated when the folder holds more notes than the limit (#209)", () => {
    const listNoteRefs = vi.fn((_a?: string, _f?: string, _s?: string, limit?: number) =>
      [ID(1), ID(3), ID(1)].slice(0, limit).map((id) => ({ id, title: "t" }))
    );
    const cut = exportNotesMarkdown({ folder: "F", limit: 2 }, deps({ listNoteRefs }));
    expect(listNoteRefs).toHaveBeenCalledWith(undefined, "F", undefined, 3);
    expect(cut).toMatchObject({ count: 2, truncated: true });
    const whole = exportNotesMarkdown({ folder: "F", limit: 3 }, deps({ listNoteRefs }));
    expect(whole.count).toBe(3);
    expect(whole.truncated).toBeUndefined();
    const html = exportNotesHtml(
      { folder: "F", limit: 1, outputPath: join(dir, "cut.html") },
      deps({ listNoteRefs })
    );
    expect(html).toMatchObject({ count: 1, truncated: true });
  });

  it("fails when the assets directory cannot be created instead of marking every asset unavailable (#209)", () => {
    const blocker = join(dir, "assets-blocker");
    writeFileSync(blocker, "");
    const output = join(dir, "no-assets.md");
    const error = (() => {
      try {
        exportNotesMarkdown(
          { id: ID(3), outputPath: output, assetsDir: join(blocker, "assets") },
          deps()
        );
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NotesExportError);
    expect((error as NotesExportError).code).toBe("invalid-path");
    expect((error as NotesExportError).message).toMatch(/Could not create the assets directory/);
    expect(readFileSync(output, "utf8")).toBe("");
    expect(
      code(() =>
        exportNotesHtml(
          {
            id: ID(3),
            outputPath: join(dir, "no-assets.html"),
            embedAssets: false,
            assetsDir: join(blocker, "html-assets"),
          },
          deps()
        )
      )
    ).toBe("invalid-path");
  });

  it("writes create-only output with sidecar assets and relative links", () => {
    const output = join(dir, "out", "doc.md");
    const assetsDir = join(dir, "out", "doc.assets");
    const receipt = exportNotesMarkdown(
      { id: ID(3), outputPath: output, assetsDir, wrap: 80 },
      deps()
    );
    expect(receipt).toMatchObject({ output, count: 1, assets: { dir: assetsDir, files: 1 } });
    expect(receipt.markdown).toBeUndefined();
    expect(readFileSync(output, "utf8")).toBe("# Three\n\n![pic.png](doc.assets/pic.png)\n");
    expect(existsSync(join(assetsDir, "pic.png"))).toBe(true);
    expect(
      code(() => exportNotesMarkdown({ id: ID(3), outputPath: output, assetsDir }, deps()))
    ).toBe("output_exists");
    expect(existsSync(join(assetsDir, "pic-2.png"))).toBe(false);
  });

  it("links assets by absolute path when there is no output file", () => {
    const assetsDir = join(dir, "inline-assets");
    const receipt = exportNotesMarkdown({ id: ID(3), assetsDir }, deps());
    expect(receipt.markdown).toContain(`](${join(assetsDir, "pic.png")})`);
  });

  it("validates the request and paths", () => {
    expect(code(() => exportNotesMarkdown({}, deps()))).toBe("invalid-request");
    expect(code(() => exportNotesMarkdown({ id: ID(1), folder: "F" }, deps()))).toBe(
      "invalid-request"
    );
    expect(code(() => exportNotesMarkdown({ id: ID(1), outputPath: "rel.md" }, deps()))).toBe(
      "invalid-path"
    );
    expect(
      code(() => exportNotesMarkdown({ id: ID(1), assetsDir: join(NOTES_CONTAINER, "x") }, deps()))
    ).toBe("invalid-path");
    const same = join(dir, "same");
    expect(
      code(() => exportNotesMarkdown({ id: ID(1), outputPath: same, assetsDir: same }, deps()))
    ).toBe("invalid-path");
  });

  it("reads the database by default and rejects a non-canonical id before querying", () => {
    expect(code(() => exportNotesMarkdown({ id: ID(1) }, { ...deps(), readNote: undefined }))).toBe(
      "invalid-id"
    );
  });

  it("reports single-note failures, folder failures and oversized inline documents", () => {
    expect(code(() => exportNotesMarkdown({ id: ID(2) }, deps()))).toBe("encrypted");
    expect(
      code(() =>
        exportNotesMarkdown(
          { folder: "F" },
          deps({
            listNoteRefs: () => {
              throw new Error("no folder");
            },
          })
        )
      )
    ).toBe("folder-unavailable");
    expect(
      code(() =>
        exportNotesMarkdown(
          { folder: "F" },
          deps({
            listNoteRefs: () => {
              throw "plain";
            },
          })
        )
      )
    ).toBe("folder-unavailable");
    expect(code(() => exportNotesMarkdown({ id: ID(1) }, deps({ maxInlineBytes: 3 })))).toBe(
      "too-large"
    );
    expect(
      code(() =>
        exportNotesMarkdown(
          { id: ID(1) },
          deps({
            readNote: () => {
              throw new Error("boom");
            },
          })
        )
      )
    ).toBe("Error: boom");
  });

  it("leaves a created output file in place when rendering fails", () => {
    const output = join(dir, "fail.md");
    const broken = { ...notes[ID(1)], doc: null } as unknown as ExportNote;
    expect(
      code(() =>
        exportNotesMarkdown({ id: ID(1), outputPath: output }, deps({ readNote: () => broken }))
      )
    ).toMatch(/TypeError/);
    expect(readFileSync(output, "utf8")).toBe("");
  });

  it("propagates unexpected output errors", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    expect(
      code(() => exportNotesMarkdown({ id: ID(1), outputPath: join(blocker, "x.md") }, deps()))
    ).toMatch(/ENOTDIR|EEXIST/);
  });
});

describe("exportNotesHtml", () => {
  it("requires an output file and consistent asset options", () => {
    expect(code(() => exportNotesHtml({ id: ID(1) }, deps()))).toBe("invalid-request");
    expect(
      code(() =>
        exportNotesHtml(
          {
            id: ID(1),
            outputPath: join(dir, "h0.html"),
            embedAssets: true,
            assetsDir: join(dir, "a"),
          },
          deps()
        )
      )
    ).toBe("invalid-request");
    const same = join(dir, "same.html");
    expect(
      code(() =>
        exportNotesHtml(
          { id: ID(1), outputPath: same, embedAssets: false, assetsDir: same },
          deps()
        )
      )
    ).toBe("invalid-path");
    expect(existsSync(join(dir, "h0.html"))).toBe(false);
  });

  it("embeds assets as data URLs by default", () => {
    const output = join(dir, "html", "one.html");
    const receipt = exportNotesHtml({ id: ID(3), outputPath: output }, deps());
    expect(receipt).toMatchObject({ format: "html", count: 1, output, embedded: 1 });
    expect(receipt.assets).toBeUndefined();
    const html = readFileSync(output, "utf8");
    expect(receipt.bytes).toBe(Buffer.byteLength(html));
    expect(html).toContain("<title>Three</title>");
    expect(html).toContain('src="data:image/png;base64,');
    expect(code(() => exportNotesHtml({ id: ID(3), outputPath: output }, deps()))).toBe(
      "output_exists"
    );
  });

  it("copies assets to a default sidecar directory with relative URLs", () => {
    const output = join(dir, "html", "side.html");
    const receipt = exportNotesHtml({ id: ID(3), outputPath: output, embedAssets: false }, deps());
    const sidecar = defaultSidecarDir(output);
    expect(sidecar).toBe(join(dir, "html", "side.assets"));
    expect(receipt).toMatchObject({ assets: { dir: sidecar, files: 1 } });
    expect(readFileSync(output, "utf8")).toContain('src="side.assets/pic.png"');
    const custom = join(dir, "html", "custom-assets");
    const second = exportNotesHtml(
      { id: ID(3), outputPath: join(dir, "html", "side2.html"), assetsDir: custom },
      deps()
    );
    expect(second.assets).toEqual({ dir: custom, files: 1 });
  });

  it("titles a folder document with the folder path and skips unreadable notes", () => {
    const output = join(dir, "html", "folder.html");
    const receipt = exportNotesHtml({ folder: "Work/Plans", outputPath: output }, deps());
    expect(receipt.count).toBe(2);
    expect(receipt.skipped).toEqual([{ id: ID(2), code: "encrypted" }]);
    const html = readFileSync(output, "utf8");
    expect(html).toContain("<title>Work/Plans</title>");
    expect(html.match(/<hr class="note-separator">/g)).toHaveLength(1);
  });

  it("embeds classic drawings as SVG and keeps Notes' PNG for Paper", () => {
    const output = join(dir, "html", "vector.html");
    const read = vi.fn((id: string) => drawings(id, {}));
    const receipt = exportNotesHtml({ id: ID(4), outputPath: output }, drawingDeps(read));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ID(4));
    expect(receipt).toMatchObject({ embedded: 2, vectorDrawings: { rendered: 1, fallback: 0 } });
    expect(receipt.stats).toMatchObject({ attachments: 2, placed: 2 });
    const html = readFileSync(output, "utf8");
    expect(html).toContain(
      `<figure class="attachment attachment-image attachment-vector"><img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}"`
    );
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(1);
  });

  it("writes drawing SVG files to the sidecar directory", () => {
    const output = join(dir, "html", "vector-side.html");
    const receipt = exportNotesHtml(
      { id: ID(4), outputPath: output, embedAssets: false },
      drawingDeps((id) => drawings(id, {}))
    );
    expect(receipt).toMatchObject({ assets: { files: 2 }, vectorDrawings: { rendered: 1 } });
    expect(readFileSync(join(dir, "html", "vector-side.assets", "Drawing.svg"), "utf8")).toBe(SVG);
    expect(readFileSync(output, "utf8")).toContain('src="vector-side.assets/Drawing.svg"');
  });

  it("keeps every PNG when vectorDrawings is false", () => {
    const output = join(dir, "html", "raster.html");
    const read = vi.fn((id: string) => drawings(id, {}));
    const receipt = exportNotesHtml(
      { id: ID(4), outputPath: output, vectorDrawings: false },
      drawingDeps(read)
    );
    expect(read).not.toHaveBeenCalled();
    expect(receipt.vectorDrawings).toBeUndefined();
    expect(readFileSync(output, "utf8")).not.toContain("image/svg+xml");
  });

  it("omits the vector summary when no note has a classic drawing", () => {
    const read = vi.fn((id: string) => drawings(id, {}));
    const receipt = exportNotesHtml(
      { id: ID(3), outputPath: join(dir, "html", "no-drawing.html") },
      deps({ readDrawings: read })
    );
    expect(read).not.toHaveBeenCalled();
    expect(receipt.vectorDrawings).toBeUndefined();
  });

  it("falls back to the PNG, and stops decoding, when the helper is unavailable", () => {
    const output = join(dir, "html", "no-helper.html");
    const read = vi.fn((): NoteDrawingsResult => {
      throw new PublicHelperError("helper_not_installed", "not built");
    });
    const receipt = exportNotesHtml({ folder: "Sketches", outputPath: output }, drawingDeps(read));
    expect(read).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      count: 2,
      embedded: 1,
      vectorDrawings: { rendered: 0, fallback: 2, fallbackReasons: { helper_not_installed: 2 } },
    });
    expect(receipt.stats).toMatchObject({ placed: 4, unavailable: 0 });
    expect(readFileSync(output, "utf8")).not.toContain("image/svg+xml");
  });

  it("falls back per drawing on decode errors, truncation and note-level failures", () => {
    const output = join(dir, "html", "partial.html");
    const read = vi.fn((id: string) => {
      if (id === ID(4))
        return drawings(id, { status: "error", code: "undecodable", svg: undefined });
      throw Object.assign(new Error("schema"), { kind: "schema" });
    });
    const receipt = exportNotesHtml({ folder: "Sketches", outputPath: output }, drawingDeps(read));
    expect(read).toHaveBeenCalledTimes(2);
    expect(receipt.vectorDrawings).toEqual({
      rendered: 0,
      fallback: 2,
      fallbackReasons: { undecodable: 1, schema: 1 },
    });
    const truncated = exportNotesHtml(
      { id: ID(4), outputPath: join(dir, "html", "truncated.html") },
      drawingDeps((id) => drawings(id, { truncated: true }))
    );
    expect(truncated.vectorDrawings).toEqual({
      rendered: 0,
      fallback: 1,
      fallbackReasons: { truncated: 1 },
    });
    const missing = exportNotesHtml(
      { id: ID(4), outputPath: join(dir, "html", "missing.html") },
      drawingDeps((id) => ({ id, drawingCount: 0, status: "none", drawings: [] }))
    );
    expect(missing.vectorDrawings?.fallbackReasons).toEqual({ not_decoded: 1 });
  });

  it("stops decoding after a helper timeout", () => {
    const read = vi.fn((id: string) =>
      drawings(id, { status: "error", code: "timeout", svg: undefined })
    );
    const receipt = exportNotesHtml(
      { folder: "Sketches", outputPath: join(dir, "html", "timeout.html") },
      drawingDeps(read)
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(receipt.vectorDrawings?.fallbackReasons).toEqual({ timeout: 2 });
  });

  it("falls back when the SVG is over the embedded-asset limit", () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(10 * 1024 * 1024)}</svg>`;
    const receipt = exportNotesHtml(
      { id: ID(4), outputPath: join(dir, "html", "huge.html") },
      drawingDeps((id) => drawings(id, { svg: huge }))
    );
    expect(receipt.vectorDrawings?.fallbackReasons).toEqual({ "too-large": 1 });
  });

  it("never decodes drawings for a Markdown export", () => {
    const read = vi.fn((id: string) => drawings(id, {}));
    exportNotesMarkdown({ id: ID(4) }, drawingDeps(read));
    expect(read).not.toHaveBeenCalled();
  });

  it("uses a generic title when a single note cannot be named", () => {
    const output = join(dir, "html", "untitled.html");
    const empty = exportNote([]);
    exportNotesHtml({ id: ID(1), outputPath: output }, deps({ readNote: () => empty }));
    expect(readFileSync(output, "utf8")).toContain("<title>Note</title>");
  });
});
