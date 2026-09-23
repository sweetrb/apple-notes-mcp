/**
 * Classic PencilKit drawings: locate them in the Notes database and render
 * decoded strokes as SVG.
 *
 * A classic drawing is an attachment row with UTI `com.apple.drawing.2` (or
 * the older `com.apple.drawing`). Its native PencilKit bytes live in
 * `ZICCLOUDSYNCINGOBJECT.ZMERGEABLEDATA1` on that row (`ZMERGEABLEDATA` on
 * older schemas). Decoding those bytes needs PencilKit, which the public
 * native helper provides; this module only reads (read-only) and renders.
 *
 * Modern Paper drawings (`com.apple.paper`) are a different format and are
 * deliberately not matched here.
 *
 * @module utils/noteDrawings
 */
import type { DrawingBounds, DrawingStroke } from "@/types.js";
import {
  assertNoteReadable,
  NOTE_STATE_SQL,
  parseNoteObjectId,
  queryNoteScoped,
} from "./noteStoreQuery.js";
import { NOTES_DB_PATH, NoteStoreError, notTombstonedSql, readColumns } from "./noteStoreSql.js";

export const DRAWING_UTIS = ["com.apple.drawing.2", "com.apple.drawing"] as const;

/** One drawing attachment row as read from the store. */
export interface DrawingRow {
  pk: number;
  attachmentId: string;
  identifier: string;
  typeUti: string;
  /** The PencilKit bytes, or null when the row has no stored drawing data. */
  data: Buffer | null;
}

/**
 * The drawing query for one data column. The column name comes from a fixed
 * allowlist, never from input; the note key is the bound `@pk` parameter.
 * Attachments marked for deletion are skipped where the schema tracks that.
 */
export function drawingRowsSql(
  columns: ReadonlySet<string>,
  dataColumn: "ZMERGEABLEDATA1" | "ZMERGEABLEDATA"
): string {
  return [
    NOTE_STATE_SQL,
    "SELECT json_group_array(json_object('pk', a.Z_PK, 'identifier', a.ZIDENTIFIER, " +
      `'uti', a.ZTYPEUTI, 'data', hex(a.${dataColumn}))) FROM ` +
      "(SELECT * FROM ZICCLOUDSYNCINGOBJECT a WHERE a.ZNOTE = @pk AND " +
      "a.ZTYPEUTI IN ('com.apple.drawing.2', 'com.apple.drawing') " +
      `AND ${notTombstonedSql(columns, "a")} ORDER BY a.Z_PK) a;`,
  ].join("\n");
}

/** Reads every classic drawing attachment of one note, in primary-key order. */
export function readDrawingRows(noteId: string, dbPath: string = NOTES_DB_PATH): DrawingRow[] {
  const { store, pk } = parseNoteObjectId(noteId);
  const columns = readColumns(dbPath);
  const dataColumn = columns.has("ZMERGEABLEDATA1")
    ? "ZMERGEABLEDATA1"
    : columns.has("ZMERGEABLEDATA")
      ? "ZMERGEABLEDATA"
      : null;
  if (!dataColumn)
    throw new NoteStoreError(
      "This macOS version's Notes database has no drawing data column.",
      "schema"
    );
  const [stateLine, rowsLine] = queryNoteScoped(drawingRowsSql(columns, dataColumn), pk, dbPath);
  assertNoteReadable(stateLine, noteId);
  const rows = JSON.parse(rowsLine || "[]") as Array<{
    pk: number;
    identifier: string | null;
    uti: string;
    data: string | null;
  }>;
  return rows.map((row) => ({
    pk: row.pk,
    attachmentId: `x-coredata://${store}/ICAttachment/p${row.pk}`,
    identifier: row.identifier ?? "",
    typeUti: row.uti,
    data: row.data ? Buffer.from(row.data, "hex") : null,
  }));
}

// -----------------------------------------------------------------------------
// SVG
// -----------------------------------------------------------------------------

/** Compact number text for SVG attributes (at most two decimals, no "-0"). */
export function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const clampChannel = (value: number) => Math.min(255, Math.max(0, Math.round(value || 0)));
const clampUnit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));

/** The union of stroke bounds, padded so round caps are not clipped. */
export function drawingViewBox(strokes: DrawingStroke[], fallback?: DrawingBounds): DrawingBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const pad = stroke.width / 2;
    const extend = (x: number, y: number, r: number) => {
      minX = Math.min(minX, x - r);
      minY = Math.min(minY, y - r);
      maxX = Math.max(maxX, x + r);
      maxY = Math.max(maxY, y + r);
    };
    if (stroke.points?.length) for (const p of stroke.points) extend(p.x, p.y, pad);
    else {
      extend(stroke.bounds.x, stroke.bounds.y, 0);
      extend(stroke.bounds.x + stroke.bounds.width, stroke.bounds.y + stroke.bounds.height, 0);
    }
  }
  if (minX === Infinity) return fallback ?? { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * Renders decoded strokes as a standalone SVG document: one path per stroke
 * through its control points, with the stroke's color, alpha, and mean width.
 * This is a faithful outline, not a pixel-exact reproduction of PencilKit's
 * ink textures (pencil grain and marker blending are approximated).
 */
export function drawingToSvg(strokes: DrawingStroke[], fallback?: DrawingBounds): string {
  const box = drawingViewBox(strokes, fallback);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svgNumber(box.x)} ${svgNumber(box.y)} ` +
      `${svgNumber(box.width)} ${svgNumber(box.height)}" width="${svgNumber(box.width)}" ` +
      `height="${svgNumber(box.height)}">`,
  ];
  for (const stroke of strokes) {
    const points = stroke.points ?? [];
    if (points.length === 0) continue;
    const c = stroke.color;
    const color = `rgb(${clampChannel(c.red)},${clampChannel(c.green)},${clampChannel(c.blue)})`;
    const shared =
      `stroke="${color}" stroke-opacity="${svgNumber(clampUnit(c.alpha))}" ` +
      `data-ink="${escapeAttribute(stroke.inkType)}"`;
    if (points.length === 1) {
      parts.push(
        `<circle cx="${svgNumber(points[0].x)}" cy="${svgNumber(points[0].y)}" ` +
          `r="${svgNumber(stroke.width / 2)}" fill="${color}" fill-opacity="${svgNumber(clampUnit(c.alpha))}" ` +
          `data-ink="${escapeAttribute(stroke.inkType)}"/>`
      );
      continue;
    }
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${svgNumber(p.x)} ${svgNumber(p.y)}`)
      .join(" ");
    parts.push(
      `<path d="${d}" fill="none" ${shared} stroke-width="${svgNumber(stroke.width)}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}
