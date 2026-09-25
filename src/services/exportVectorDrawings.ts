/**
 * Vector drawings for export-notes-html.
 *
 * A classic PencilKit drawing (`com.apple.drawing.2` / `com.apple.drawing`)
 * is decoded through the public native helper, exactly as get-note-drawings
 * does, and placed as an SVG file (sidecar) or SVG data URL (embedded) in
 * place of the PNG Notes renders for it. Paper drawings (`com.apple.paper`)
 * have no public decoder and keep Notes' raster rendering.
 *
 * The vector path never fails an export. When the helper is not built, a
 * drawing does not decode, the helper stopped at its stroke limit, or the SVG
 * is over the export's size limits, the drawing falls back to the raster
 * rendering and the receipt counts why.
 *
 * @module services/exportVectorDrawings
 */
import type { ExportVectorDrawingStats, NoteDrawingsResult } from "@/types.js";
import type { AssetWriter } from "@/utils/exportAssets.js";
import type { ExportAttachment, ExportNote } from "@/utils/noteExportData.js";
import { getNoteDrawings } from "./noteDrawings.js";
import { PublicHelperError } from "./publicHelper.js";

/** Reads one note's classic drawings as SVG. */
export type ReadNoteDrawings = (noteId: string) => NoteDrawingsResult;

export const defaultReadNoteDrawings: ReadNoteDrawings = (noteId) =>
  getNoteDrawings(noteId, { format: "svg" });

/**
 * Per-drawing codes after which no further note is decoded in this export:
 * a helper that timed out once is likely to time out again, and each attempt
 * costs the full helper timeout.
 */
const STOP_CODES = new Set(["timeout"]);

type Outcome = { svg: string } | { reason: string };

function errorCode(error: unknown): string {
  if (error instanceof PublicHelperError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "internal_error";
}

/**
 * Decodes every classic drawing in `notes` before rendering and returns the
 * `vectorDrawing` hook for the export context plus its running counts.
 *
 * A PublicHelperError thrown for a whole note (helper not built, stale, or
 * modified) stops decoding for the rest of the export, since every later note
 * would fail the same way.
 */
export function prepareVectorDrawings(
  notes: ExportNote[],
  writer: AssetWriter,
  readDrawings: ReadNoteDrawings = defaultReadNoteDrawings
): {
  vectorDrawing: (attachment: ExportAttachment) => { url: string; mime: string } | undefined;
  stats: ExportVectorDrawingStats;
} {
  const outcomes = new Map<string, Outcome>();
  let stopped: string | undefined;
  for (const note of notes) {
    const pending = [...note.attachments.values()].filter((a) => a.kind === "drawing");
    if (pending.length === 0) continue;
    if (stopped) {
      for (const attachment of pending) outcomes.set(attachment.id, { reason: stopped });
      continue;
    }
    let result: NoteDrawingsResult;
    try {
      result = readDrawings(note.id);
    } catch (error) {
      const reason = errorCode(error);
      if (error instanceof PublicHelperError) stopped = reason;
      for (const attachment of pending) outcomes.set(attachment.id, { reason });
      continue;
    }
    for (const drawing of result.drawings) {
      if (drawing.status !== "ok" || !drawing.svg) {
        const reason = drawing.code ?? "undecodable";
        outcomes.set(drawing.identifier, { reason });
        if (STOP_CODES.has(reason)) stopped = reason;
      } else if (drawing.truncated) {
        // The helper stopped at its stroke or point limit; the raster is complete.
        outcomes.set(drawing.identifier, { reason: "truncated" });
      } else {
        outcomes.set(drawing.identifier, { svg: drawing.svg });
      }
    }
  }

  const stats: ExportVectorDrawingStats = { rendered: 0, fallback: 0 };
  const fallback = (reason: string) => {
    stats.fallback++;
    stats.fallbackReasons = stats.fallbackReasons ?? {};
    stats.fallbackReasons[reason] = (stats.fallbackReasons[reason] ?? 0) + 1;
    return undefined;
  };
  const vectorDrawing = (attachment: ExportAttachment) => {
    if (attachment.kind !== "drawing") return undefined;
    const outcome = outcomes.get(attachment.id) ?? { reason: "not_decoded" };
    if ("reason" in outcome) return fallback(outcome.reason);
    if (!writer.placeBytes) return fallback("unsupported");
    const placed = writer.placeBytes(
      Buffer.from(outcome.svg, "utf8"),
      `${attachment.title?.trim() || "Drawing"}.svg`,
      "image/svg+xml",
      `drawing:${attachment.id}`
    );
    if ("error" in placed) return fallback(placed.error);
    stats.rendered++;
    return placed;
  };
  return { vectorDrawing, stats };
}
