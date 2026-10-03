/**
 * SVG rendering of decoded Paper strokes (`native-read-paper`, `format: "svg"`).
 *
 * Paper strokes arrive from the private writer in point space with a per-stroke
 * affine transform. This module moves each stroke into drawing space and hands
 * it to `drawingToSvg`, the renderer `get-note-drawings` uses for classic
 * drawings, so both drawing kinds produce the same kind of document: one
 * round-capped path per stroke through its recorded points, in its own color,
 * alpha and mean width. No point is added, removed or smoothed.
 *
 * The result is a faithful outline of the recorded geometry, not a pixel match:
 * PencilKit inks vary width along a stroke and add texture that SVG strokes
 * cannot express. Typed shapes and the fallback PDF's geometry are not drawn;
 * the caller already has them as `shapes` and `fallbackGeometry`.
 *
 * @module utils/paperSvg
 */
import type { DrawingBounds, DrawingStroke } from "../types.js";
import { drawingToSvg } from "./noteDrawings.js";

type Rect = [number, number, number, number];
type Affine = [number, number, number, number, number, number];

/** The stroke fields the renderer reads from a decoded Paper drawing. */
export interface PaperSvgStroke {
  ink: string;
  /** sRGB red, green, blue, alpha, each 0..1; null when the ink has no sRGB form. */
  color: [number, number, number, number] | null;
  /** Mean point width, in point space. */
  width: number;
  /** [a, b, c, d, tx, ty] from point space to drawing space; null means identity. */
  transform: Affine | null;
  /** Rows of x, y, width, height, opacity, force, ... in point space. Absent when not returned. */
  points?: number[][];
}

export interface PaperSvgInput {
  bounds: Rect | null;
  strokes: PaperSvgStroke[];
}

export interface PaperSvgResult {
  svg: string;
  /** Strokes drawn. */
  strokeCount: number;
  /** Strokes left out because no points were returned for them. */
  skippedStrokes: number;
}

const unit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** A stroke moved into drawing space; its width scales by the transform's area factor. */
function toDrawingStroke(stroke: PaperSvgStroke, points: number[][]): DrawingStroke {
  const [a, b, c, d, tx, ty] = stroke.transform ?? [1, 0, 0, 1, 0, 0];
  const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
  const moved = points.map((p) => ({
    x: a * p[0] + c * p[1] + tx,
    y: b * p[0] + d * p[1] + ty,
    width: (p[2] ?? stroke.width) * scale,
    opacity: p[4] ?? 1,
    force: p[5] ?? 0,
  }));
  const xs = moved.map((p) => p.x);
  const ys = moved.map((p) => p.y);
  const [r, g, bl, alpha] = stroke.color ?? [0, 0, 0, 1];
  return {
    inkType: stroke.ink,
    color: {
      red: unit(r) * 255,
      green: unit(g) * 255,
      blue: unit(bl) * 255,
      alpha: unit(alpha),
    },
    width: Math.max(stroke.width * scale, 0),
    pointCount: moved.length,
    bounds: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    points: moved,
    transformApplied: true,
  };
}

/** Render decoded Paper strokes as a standalone SVG document. */
export function paperToSvg(input: PaperSvgInput): PaperSvgResult {
  const drawable: DrawingStroke[] = [];
  let skippedStrokes = 0;
  for (const stroke of input.strokes) {
    if (!stroke.points || stroke.points.length === 0) skippedStrokes++;
    else drawable.push(toDrawingStroke(stroke, stroke.points));
  }
  const fallback: DrawingBounds | undefined = input.bounds
    ? { x: input.bounds[0], y: input.bounds[1], width: input.bounds[2], height: input.bounds[3] }
    : undefined;
  return {
    svg: drawingToSvg(drawable, fallback) + "\n",
    strokeCount: drawable.length,
    skippedStrokes,
  };
}
