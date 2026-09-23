import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  collectNoteTables,
  escapeMarkdownTableCell,
  renderMarkdownTable,
  UNDECODED_CELL_MARKER,
} from "./tableMarkdown.js";
import { parseNoteTable, parseNoteTableCells } from "./noteTables.js";
import type { RichNote } from "./noteRichText.js";

const fixture = readFileSync(new URL("./fixtures/background-probe-table.gz", import.meta.url));

/**
 * Replace one cell's text in the synthetic fixture with a same-byte-length string,
 * so every protobuf length prefix stays valid.
 */
function withCellText(original: string, replacement: string): Buffer {
  const raw = gunzipSync(fixture);
  const from = Buffer.from(original, "utf8");
  const to = Buffer.from(replacement, "utf8");
  expect(to.length).toBe(from.length);
  const at = raw.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  to.copy(raw, at);
  return gzipSync(raw);
}

function rich(
  objects: Array<{ id: string; type: string; start: number }>,
  data: Array<{ id: string; pk: number; mergeable: string }>
): RichNote {
  return {
    text: "",
    links: [],
    nativeTags: [],
    nativeObjectIds: objects.map((o) => o.id),
    hasNativeObjects: objects.length > 0,
    hasChecklist: false,
    revision: "r",
    objects: objects.map((o) => ({ ...o, length: 1 })),
    objectData: data.map((d) => ({ ...d, type: "com.apple.notes.table", view: null })),
  };
}

const NOTE = "x-coredata://ABC/ICNote/p42";

describe("escapeMarkdownTableCell", () => {
  it("escapes pipes so they cannot split a cell", () => {
    expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
  });
  it("doubles backslashes before escaping pipes", () => {
    expect(escapeMarkdownTableCell("a\\|b")).toBe("a\\\\\\|b");
    expect(escapeMarkdownTableCell("C:\\dir")).toBe("C:\\\\dir");
  });
  it("turns every line-break form into <br>", () => {
    expect(escapeMarkdownTableCell("a\r\nb\nc\rd\u2028e\u2029f")).toBe(
      "a<br>b<br>c<br>d<br>e<br>f"
    );
  });
  it("leaves ordinary Unicode untouched", () => {
    expect(escapeMarkdownTableCell("Проба 🧭")).toBe("Проба 🧭");
  });
});

describe("renderMarkdownTable", () => {
  it("renders the first row as the header with a separator row", () => {
    expect(
      renderMarkdownTable([
        ["Name", "Score"],
        ["A|B", "1\n2"],
      ])
    ).toBe("| Name | Score |\n| --- | --- |\n| A\\|B | 1<br>2 |");
  });
  it("renders a single-row table as a header-only table", () => {
    expect(renderMarkdownTable([["only"]])).toBe("| only |\n| --- |");
  });
  it("marks undecoded cells instead of guessing", () => {
    expect(renderMarkdownTable([["a", null]])).toBe(
      `| a | ${UNDECODED_CELL_MARKER} |\n| --- | --- |`
    );
  });
  it("pads short rows and keeps empty cells", () => {
    expect(renderMarkdownTable([["a", "b"], ["c"], ["", ""]])).toBe(
      "| a | b |\n| --- | --- |\n| c |  |\n|  |  |"
    );
  });
  it("returns an empty string for an empty table", () => {
    expect(renderMarkdownTable([])).toBe("");
    expect(renderMarkdownTable([[]])).toBe("");
  });
});

describe("parseNoteTableCells", () => {
  it("matches parseNoteTable on a fully decodable table", () => {
    const strict = parseNoteTable(fixture);
    const detailed = parseNoteTableCells(fixture);
    expect(detailed.rows).toEqual(strict.rows);
    expect(detailed.rowIds).toEqual(strict.rowIds);
    expect(detailed.columnIds).toEqual(strict.columnIds);
    expect(detailed.incompleteCells).toEqual([]);
  });
  it("flags a cell holding an embedded object as null while strict parsing still throws", () => {
    // "Готово" is 12 UTF-8 bytes; "Гото" (8) + U+FFFC (3) + "x" (1) keeps the length.
    const embedded = withCellText("Готово", "Гото\ufffcx");
    expect(() => parseNoteTable(embedded)).toThrow("Embedded or unsupported table cell");
    const detailed = parseNoteTableCells(embedded);
    expect(detailed.rows).toEqual([
      ["Имя", "Статус"],
      ["Проба 🧭", null],
    ]);
    expect(detailed.incompleteCells).toEqual([
      { row: 1, column: 1, reason: "Cell contains an embedded object" },
    ]);
  });
  it("lists several incomplete cells in row, then column order", () => {
    // Replace two same-length cells so both carry an embedded object.
    const raw = gunzipSync(withCellText("Готово", "Гото\ufffcx"));
    const from = Buffer.from("Статус", "utf8");
    const to = Buffer.from("Стат\ufffcx", "utf8");
    expect(to.length).toBe(from.length);
    const at = raw.indexOf(from);
    expect(at).toBeGreaterThanOrEqual(0);
    to.copy(raw, at);
    const detailed = parseNoteTableCells(gzipSync(raw));
    expect(detailed.rows).toEqual([
      ["Имя", null],
      ["Проба 🧭", null],
    ]);
    expect(detailed.incompleteCells).toEqual([
      { row: 0, column: 1, reason: "Cell contains an embedded object" },
      { row: 1, column: 1, reason: "Cell contains an embedded object" },
    ]);
  });
  it("still throws on structural damage", () => {
    expect(() => parseNoteTableCells(fixture.subarray(0, fixture.length / 2))).toThrow();
  });
});

describe("collectNoteTables", () => {
  const hex = fixture.toString("hex");

  it("returns tables in body order with Markdown and JSON forms", () => {
    const result = collectNoteTables(
      rich(
        [
          { id: "T2", type: "com.apple.notes.table", start: 30 },
          { id: "IMG", type: "public.jpeg", start: 5 },
          { id: "T1", type: "com.apple.notes.table", start: 10 },
        ],
        [
          { id: "T1", pk: 7, mergeable: hex },
          { id: "T2", pk: 9, mergeable: hex },
        ]
      ),
      NOTE
    );
    expect(result.tables.map((t) => [t.index, t.id, t.attachmentId])).toEqual([
      [1, "T1", "x-coredata://ABC/ICAttachment/p7"],
      [2, "T2", "x-coredata://ABC/ICAttachment/p9"],
    ]);
    expect(result.tableCellsComplete).toBe(true);
    const first = result.tables[0];
    expect(first).toMatchObject({ complete: true, rowCount: 2, columnCount: 2 });
    expect(first.rows).toEqual([
      ["Имя", "Статус"],
      ["Проба 🧭", "Готово"],
    ]);
    expect(first.markdown).toBe("| Имя | Статус |\n| --- | --- |\n| Проба 🧭 | Готово |");
    expect(result.markdown).toBe(`${first.markdown}\n\n${first.markdown}`);
  });

  it("reports a table with no stored data as incomplete without rows", () => {
    const result = collectNoteTables(
      rich([{ id: "T1", type: "com.apple.notes.table", start: 0 }], []),
      NOTE
    );
    expect(result.tableCellsComplete).toBe(false);
    expect(result.tables[0]).toEqual({
      index: 1,
      id: "T1",
      complete: false,
      reason: "Native table data is unavailable",
    });
    expect(result.markdown).toBe(
      "[table 1 could not be decoded: Native table data is unavailable]"
    );
  });

  it("reports a structurally damaged table as incomplete without rows", () => {
    const result = collectNoteTables(
      rich(
        [{ id: "T1", type: "com.apple.notes.table", start: 0 }],
        [{ id: "T1", pk: 3, mergeable: Buffer.from("not a table").toString("hex") }]
      ),
      NOTE
    );
    expect(result.tables[0].complete).toBe(false);
    expect(result.tables[0].rows).toBeUndefined();
    expect(result.tables[0].reason).toBeTruthy();
  });

  it("keeps readable cells and flags the undecodable one", () => {
    const embedded = withCellText("Готово", "Гото\ufffcx").toString("hex");
    const result = collectNoteTables(
      rich(
        [{ id: "T1", type: "com.apple.notes.table", start: 0 }],
        [{ id: "T1", pk: 3, mergeable: embedded }]
      ),
      NOTE
    );
    expect(result.tableCellsComplete).toBe(false);
    expect(result.tables[0]).toMatchObject({
      complete: false,
      reason: "1 cell(s) could not be decoded",
      incompleteCells: [{ row: 1, column: 1, reason: "Cell contains an embedded object" }],
    });
    expect(result.tables[0].markdown).toContain(`| Проба 🧭 | ${UNDECODED_CELL_MARKER} |`);
  });

  it("returns an empty result for a note without tables", () => {
    expect(collectNoteTables(rich([], []), NOTE)).toEqual({
      tables: [],
      tableCellsComplete: true,
      markdown: "",
    });
  });
});
