/**
 * get-note-drawings: decode a note's classic PencilKit drawings to strokes
 * and SVG through the public native helper.
 *
 * @module services/noteDrawings
 */
import { z } from "zod";
import type { DrawingStroke, NoteDrawing, NoteDrawingsResult } from "@/types.js";
import { drawingToSvg, readDrawingRows, type DrawingRow } from "@/utils/noteDrawings.js";
import {
  callPublicHelper,
  defaultPublicHelperDeps,
  inspectPublicHelper,
  PublicHelperError,
  type PublicHelperDeps,
} from "./publicHelper.js";

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const strokeSchema = z
  .object({
    inkType: z.string(),
    color: z.object({
      red: z.number(),
      green: z.number(),
      blue: z.number(),
      alpha: z.number(),
    }),
    width: z.number(),
    pointCount: z.number().int(),
    bounds,
    points: z
      .array(
        z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          opacity: z.number(),
          force: z.number(),
        })
      )
      .optional(),
    transformApplied: z.boolean().optional(),
  })
  .strip();

export const decodedDrawingSchema = z.object({
  status: z.literal("ok"),
  strokeCount: z.number().int(),
  strokes: z.array(strokeSchema),
  truncated: z.boolean(),
  bounds,
});

export type DrawingFormat = "json" | "svg" | "both";

export interface GetNoteDrawingsOptions {
  format?: DrawingFormat;
  /** Include per-point data in JSON output (default true). SVG always uses points. */
  includePoints?: boolean;
  /** Test seams. */
  dbPath?: string;
  deps?: PublicHelperDeps;
  readRows?: (noteId: string, dbPath?: string) => DrawingRow[];
}

function decodeRow(
  row: DrawingRow,
  format: DrawingFormat,
  includePoints: boolean,
  deps: PublicHelperDeps
): NoteDrawing {
  const base: NoteDrawing = {
    attachmentId: row.attachmentId,
    identifier: row.identifier,
    typeUti: row.typeUti,
    status: "error",
  };
  if (!row.data || row.data.length === 0)
    return { ...base, code: "no_data", message: "This drawing has no stored PencilKit data." };
  let decoded: z.infer<typeof decodedDrawingSchema>;
  try {
    const needPoints = includePoints || format !== "json";
    const raw = callPublicHelper(
      "decode_drawing",
      { dataBase64: row.data.toString("base64"), includePoints: needPoints },
      deps
    );
    const parsed = decodedDrawingSchema.safeParse(raw);
    if (!parsed.success)
      return { ...base, code: "invalid_response", message: "Unexpected helper response." };
    decoded = parsed.data;
  } catch (error) {
    const code = error instanceof PublicHelperError ? error.code : "internal_error";
    return { ...base, code, message: error instanceof Error ? error.message : String(error) };
  }
  const strokes: DrawingStroke[] = decoded.strokes;
  const result: NoteDrawing = {
    ...base,
    status: "ok",
    strokeCount: decoded.strokeCount,
    bounds: decoded.bounds,
    truncated: decoded.truncated,
  };
  if (format !== "json") result.svg = drawingToSvg(strokes, decoded.bounds);
  if (format !== "svg")
    result.strokes = includePoints ? strokes : strokes.map(({ points: _points, ...rest }) => rest);
  return result;
}

/**
 * Reads every classic drawing in the note and decodes each one. A drawing that
 * fails does not fail the call: it carries status "error" with a code, and the
 * overall status says ok, partial, error, or none.
 *
 * Throws NoteStoreError or a coded error for note-level problems (bad id, not found, locked,
 * no Full Disk Access) and PublicHelperError when drawings exist but the helper
 * is not usable, so the caller gets one actionable message instead of N copies.
 */
export function getNoteDrawings(
  noteId: string,
  options: GetNoteDrawingsOptions = {}
): NoteDrawingsResult {
  const format = options.format ?? "json";
  const includePoints = options.includePoints ?? true;
  const deps = options.deps ?? defaultPublicHelperDeps();
  const rows = (options.readRows ?? readDrawingRows)(noteId, options.dbPath);
  if (rows.length === 0) return { id: noteId, drawingCount: 0, status: "none", drawings: [] };
  const install = inspectPublicHelper(deps);
  if (!install.ready)
    throw new PublicHelperError(install.reason ?? "helper_not_installed", install.detail ?? "");
  const drawings = rows.map((row) => decodeRow(row, format, includePoints, deps));
  const ok = drawings.filter((d) => d.status === "ok").length;
  return {
    id: noteId,
    drawingCount: drawings.length,
    status: ok === drawings.length ? "ok" : ok ? "partial" : "error",
    drawings,
  };
}

/** Short human summary for the text content block (counts only, no SVG bodies). */
export function formatNoteDrawings(result: NoteDrawingsResult): string {
  if (result.drawingCount === 0) return `No classic PencilKit drawings in note ${result.id}.`;
  const lines = [
    `${result.drawingCount} classic drawing${result.drawingCount === 1 ? "" : "s"} in note ${result.id} (${result.status}):`,
  ];
  for (const d of result.drawings)
    lines.push(
      d.status === "ok"
        ? `- ${d.attachmentId}: ${d.strokeCount} stroke${d.strokeCount === 1 ? "" : "s"}${d.truncated ? " (truncated)" : ""}`
        : `- ${d.attachmentId}: error ${d.code}: ${d.message}`
    );
  return lines.join("\n");
}
