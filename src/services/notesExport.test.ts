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
  exportNotesMarkdown,
  MAX_FOLDER_EXPORT_LIMIT,
  NotesExportError,
  type NotesExportDeps,
} from "./notesExport.js";
import { NoteBlocksError } from "../utils/noteBlocks.js";
import { NOTES_CONTAINER, type AssetLocator } from "../utils/exportAssets.js";
import { attachment, attachmentRun, block, exportNote } from "../utils/fixtures/exportNote.js";
import type { ExportNote } from "../utils/noteExportData.js";

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
    expect(listNoteRefs).toHaveBeenCalledWith("A", "F", undefined, DEFAULT_FOLDER_EXPORT_LIMIT);
    expect(receipt.count).toBe(2);
    expect(receipt.skipped).toEqual([{ id: ID(2), code: "encrypted" }]);
    expect(receipt.markdown).toContain("\n\n---\n\n# Three");
    exportNotesMarkdown({ folder: "F", limit: 5000 }, deps({ listNoteRefs }));
    expect(listNoteRefs).toHaveBeenLastCalledWith(
      undefined,
      "F",
      undefined,
      MAX_FOLDER_EXPORT_LIMIT
    );
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
