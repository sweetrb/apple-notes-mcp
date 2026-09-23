import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DrawingStroke } from "@/types.js";
import { createNoteStoreFixture } from "./fixtures/noteStoreFixture.js";
import {
  DRAWING_UTIS,
  drawingRowsSql,
  drawingToSvg,
  drawingViewBox,
  readDrawingRows,
  svgNumber,
} from "./noteDrawings.js";
import { NoteStoreError } from "./noteStoreSql.js";

/**
 * A synthetic drawing encoded by PencilKit itself (see
 * scripts/test-public-helper.mjs), with the helper's decode of it.
 */
const pencil = JSON.parse(
  readFileSync(join(__dirname, "fixtures/pencil-drawing.json"), "utf8")
) as { dataBase64: string; decoded: { strokes: DrawingStroke[]; bounds: DrawingStroke["bounds"] } };
const drawingHex = Buffer.from(pencil.dataBase64, "base64").toString("hex");

const STORE = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const noteId = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;

const fixture = createNoteStoreFixture([
  { pk: 1, ent: "ICNote" },
  { pk: 2, ent: "ICNote", locked: 1 },
  { pk: 3, ent: "ICNote" },
  // note 1: a v2 drawing, a v1 drawing without data, a Paper sketch, a
  // deleted drawing, and an image; note 3 owns another drawing.
  {
    pk: 20,
    ent: "ICAttachment",
    note: 1,
    uti: "com.apple.drawing.2",
    identifier: "D-2",
    dataHex: drawingHex,
  },
  { pk: 21, ent: "ICAttachment", note: 1, uti: "com.apple.drawing", identifier: "D-1" },
  { pk: 22, ent: "ICAttachment", note: 1, uti: "com.apple.paper", identifier: "P", dataHex: "00" },
  {
    pk: 23,
    ent: "ICAttachment",
    note: 1,
    uti: "com.apple.drawing.2",
    identifier: "gone",
    dataHex: "00",
    deleted: 1,
  },
  { pk: 24, ent: "ICAttachment", note: 1, uti: "public.jpeg", identifier: "img" },
  {
    pk: 30,
    ent: "ICAttachment",
    note: 3,
    uti: "com.apple.drawing.2",
    identifier: "other",
    dataHex: "01",
  },
  {
    pk: 31,
    ent: "ICAttachment",
    note: 2,
    uti: "com.apple.drawing.2",
    identifier: "secret",
    dataHex: "02",
  },
]);
afterAll(() => fixture.cleanup());

describe("readDrawingRows (real sqlite3, fixture database)", () => {
  it("returns only the note's live classic drawings, in key order, with bytes intact", () => {
    const rows = readDrawingRows(noteId(1), fixture.dbPath);
    expect(rows.map((r) => [r.pk, r.typeUti, r.identifier])).toEqual([
      [20, "com.apple.drawing.2", "D-2"],
      [21, "com.apple.drawing", "D-1"],
    ]);
    expect(rows[0].attachmentId).toBe(`x-coredata://${STORE}/ICAttachment/p20`);
    expect(rows[0].data?.toString("base64")).toBe(pencil.dataBase64);
    expect(rows[1].data).toBeNull();
  });

  it("returns an empty list for a note without drawings", () => {
    const empty = createNoteStoreFixture([{ pk: 5, ent: "ICNote" }]);
    try {
      expect(readDrawingRows(noteId(5), empty.dbPath)).toEqual([]);
    } finally {
      empty.cleanup();
    }
  });

  it("refuses a locked note and a missing note", () => {
    expect(() => readDrawingRows(noteId(2), fixture.dbPath)).toThrow(/password-protected/);
    expect(() => readDrawingRows(noteId(99), fixture.dbPath)).toThrow(/No note found/);
  });

  it("rejects a malformed id before touching the database", () => {
    expect(() => readDrawingRows("x-coredata://X/ICNote/p1 OR 1=1", fixture.dbPath)).toThrow(
      NoteStoreError
    );
  });

  it("falls back to ZMERGEABLEDATA on older schemas and fails clearly without either column", () => {
    const dir = createNoteStoreFixture([]);
    try {
      execFileSync("sqlite3", [
        dir.dbPath,
        "ALTER TABLE ZICCLOUDSYNCINGOBJECT RENAME COLUMN ZMERGEABLEDATA1 TO ZMERGEABLEDATA;" +
          "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZISPASSWORDPROTECTED) VALUES (1, 12, 0);" +
          "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNOTE, ZTYPEUTI, ZIDENTIFIER, ZMERGEABLEDATA, ZMARKEDFORDELETION) " +
          "VALUES (2, 5, 1, 'com.apple.drawing.2', 'old', X'0A0B', 0);",
      ]);
      const rows = readDrawingRows(noteId(1), dir.dbPath);
      expect(rows.map((r) => r.data?.toString("hex"))).toEqual(["0a0b"]);
      execFileSync("sqlite3", [
        dir.dbPath,
        "ALTER TABLE ZICCLOUDSYNCINGOBJECT RENAME COLUMN ZMERGEABLEDATA TO ZOTHER;",
      ]);
      expect(() => readDrawingRows(noteId(1), dir.dbPath)).toThrow(/no drawing data column/);
    } finally {
      dir.cleanup();
    }
  });

  it("keeps the SQL free of caller input", () => {
    for (const column of ["ZMERGEABLEDATA1", "ZMERGEABLEDATA"] as const) {
      const sql = drawingRowsSql(new Set(["ZMARKEDFORDELETION", column]), column);
      expect(sql).toContain("@pk");
      expect(sql).toContain("COALESCE(a.ZMARKEDFORDELETION, 0) = 0");
      expect(sql).not.toMatch(/ZNOTE = \d/);
      for (const uti of DRAWING_UTIS) expect(sql).toContain(`'${uti}'`);
    }
  });
});

describe("SVG rendering", () => {
  const strokes = pencil.decoded.strokes;

  it("renders one path per multi-point stroke with color, alpha, width and ink", () => {
    const svg = drawingToSvg(strokes, pencil.decoded.bounds);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<path /g)).toHaveLength(3);
    expect(svg).toContain('d="M20 20 L60 55 L110 30 L150 70"');
    expect(svg).toContain(
      'stroke="rgb(220,30,40)" stroke-opacity="1" data-ink="com.apple.ink.pen"'
    );
    expect(svg).toContain(
      'stroke="rgb(250,210,0)" stroke-opacity="0.5" data-ink="com.apple.ink.marker"'
    );
    expect(svg).toContain('stroke-width="14"');
  });

  it("draws a dot for a single-point stroke and skips a stroke without points", () => {
    const dot: DrawingStroke = {
      ...strokes[0],
      points: [strokes[0].points![0]],
    };
    const bare: DrawingStroke = { ...strokes[1], points: undefined };
    const svg = drawingToSvg([dot, bare]);
    expect(svg).toContain('<circle cx="20" cy="20" r="2" fill="rgb(220,30,40)"');
    expect(svg).not.toContain("<path");
  });

  it("escapes attribute text and clamps color channels", () => {
    const odd: DrawingStroke = {
      ...strokes[0],
      inkType: 'x"<&>',
      color: { red: 300, green: -5, blue: Number.NaN, alpha: 7 },
    };
    const svg = drawingToSvg([odd]);
    expect(svg).toContain('data-ink="x&quot;&lt;&amp;&gt;"');
    expect(svg).toContain('stroke="rgb(255,0,0)" stroke-opacity="1"');
  });

  it("pads the view box by half the stroke width and falls back when empty", () => {
    const box = drawingViewBox([strokes[0]]);
    expect(box).toEqual({ x: 18, y: 18, width: 134, height: 54 });
    const fromBounds = drawingViewBox([{ ...strokes[0], points: [] }]);
    expect(fromBounds).toEqual(strokes[0].bounds);
    expect(drawingViewBox([], { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(drawingViewBox([])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("formats numbers compactly", () => {
    expect(svgNumber(1.23456)).toBe("1.23");
    expect(svgNumber(-0.001)).toBe("0");
    expect(svgNumber(Number.POSITIVE_INFINITY)).toBe("0");
    expect(svgNumber(12)).toBe("12");
  });
});
