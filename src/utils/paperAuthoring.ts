/**
 * Input side of Paper authoring: turn stroke JSON, shapes, or an analyzed
 * SVG into the normalized drawing the private writer stores (`add_paper`).
 *
 * The writer's drawing format is `{strokes: [{ink, color, width, points}]}`:
 * `ink` is a PencilKit ink name, `color` is sRGB `[r, g, b, a]` from 0 to 1,
 * `width` is the stroke width, and each point is `[x, y]` or `[x, y, width]`.
 * Shapes have no native form the writer can store, so each one is converted
 * to strokes that trace its outline (`shapePersistence: "stroke-fallback"`).
 *
 * An SVG is written only from its analysis: the caller must pass the exact
 * `analysisDigest` whenever the analysis reports a loss, and accept exactly
 * the reported losses.
 *
 * @module utils/paperAuthoring
 */
import type { NormalizedDrawing, SvgAnalysisResult } from "./svgAnalyzer.js";

/** Inks the writer can store on macOS 27 (the identifier survives serialization). */
export const AUTHOR_INKS = [
  "pen",
  "pencil",
  "marker",
  "fountainpen",
  "watercolor",
  "crayon",
] as const;
export type AuthorInk = (typeof AUTHOR_INKS)[number];

export type Rgba = [number, number, number, number];
export type AuthorPoint = [number, number] | [number, number, number];

export interface AuthorStroke {
  ink: AuthorInk;
  color: Rgba;
  width: number;
  points: AuthorPoint[];
}

export interface AuthorDrawing {
  strokes: AuthorStroke[];
}

/** Common paint fields every shape and free stroke accepts. */
interface Paint {
  ink?: AuthorInk;
  color?: Rgba;
}

type Xy = [number, number];

export type ShapeInput = Paint & { strokeWidth?: number } & (
    | {
        kind: "rectangle";
        x: number;
        y: number;
        width: number;
        height: number;
        cornerRadius?: number;
      }
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { kind: "line"; from: Xy; to: Xy; arrowStart?: boolean; arrowEnd?: boolean }
    | { kind: "arrow"; from: Xy; to: Xy; headLength?: number; shaftWidth?: number }
    | { kind: "polygon"; cx: number; cy: number; radius: number; sides: number; rotation?: number }
    | {
        kind: "star";
        cx: number;
        cy: number;
        outerRadius: number;
        innerRadius: number;
        points: number;
        rotation?: number;
      }
    | { kind: "chatBubble"; x: number; y: number; width: number; height: number; tail: Xy }
    | { kind: "polyline"; points: Xy[]; closed?: boolean }
  );

export type StrokeInput = Paint & { width?: number; points: number[][] };

export interface DrawingInput {
  strokes?: StrokeInput[];
  shapes?: ShapeInput[];
}

export class PaperAuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PaperAuthoringError";
  }
}

const DEFAULT_COLOR: Rgba = [0, 0, 0, 1];
const DEFAULT_WIDTH = 2;
/** Segments used to trace a full ellipse. */
const ELLIPSE_SEGMENTS = 72;

function paint(input: Paint, width: number | undefined): Omit<AuthorStroke, "points"> {
  return {
    ink: input.ink ?? "pen",
    color: input.color ?? DEFAULT_COLOR,
    width: width ?? DEFAULT_WIDTH,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000 || 0;
const pt = (x: number, y: number): Xy => [round(x), round(y)];

function arc(cx: number, cy: number, rx: number, ry: number, start: number, end: number): Xy[] {
  const steps = Math.max(2, Math.ceil((ELLIPSE_SEGMENTS * Math.abs(end - start)) / (2 * Math.PI)));
  const out: Xy[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps;
    out.push(pt(cx + rx * Math.cos(t), cy + ry * Math.sin(t)));
  }
  return out;
}

function regular(cx: number, cy: number, radii: number[], count: number, rotation = 0): Xy[] {
  const out: Xy[] = [];
  const n = count * radii.length;
  const start = -Math.PI / 2 + (rotation * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const t = start + (2 * Math.PI * i) / n;
    const r = radii[i % radii.length];
    out.push(pt(cx + r * Math.cos(t), cy + r * Math.sin(t)));
  }
  out.push(out[0]);
  return out;
}

function roundedRect(x: number, y: number, w: number, h: number, radius: number): Xy[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h), pt(x, y)];
  const h2 = Math.PI / 2;
  return [
    ...arc(x + w - r, y + r, r, r, -h2, 0),
    ...arc(x + w - r, y + h - r, r, r, 0, h2),
    ...arc(x + r, y + h - r, r, r, h2, Math.PI),
    ...arc(x + r, y + r, r, r, Math.PI, 3 * h2),
    pt(x + w - r, y),
  ];
}

/** Two short strokes forming an arrowhead at `tip`, pointing away from `from`. */
function arrowHead(from: Xy, tip: Xy, length: number): Xy[] {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const wing = (a: number) => pt(tip[0] - length * Math.cos(a), tip[1] - length * Math.sin(a));
  return [wing(angle + Math.PI / 6), pt(tip[0], tip[1]), wing(angle - Math.PI / 6)];
}

function blockArrow(from: Xy, to: Xy, head: number, shaft: number): Xy[] {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len === 0)
    throw new PaperAuthoringError("invalid_request", "An arrow needs two distinct points");
  const ux = (to[0] - from[0]) / len;
  const uy = (to[1] - from[1]) / len;
  const nx = -uy;
  const ny = ux;
  const headLen = Math.min(head, len);
  const base: Xy = [to[0] - ux * headLen, to[1] - uy * headLen];
  const s = shaft / 2;
  const h = Math.max(head / 2, s * 2);
  const at = (p: Xy, k: number): Xy => pt(p[0] + nx * k, p[1] + ny * k);
  return [
    at(from, s),
    at(base, s),
    at(base, h),
    pt(to[0], to[1]),
    at(base, -h),
    at(base, -s),
    at(from, -s),
    at(from, s),
  ];
}

function positive(value: number, what: string) {
  if (!(value > 0)) throw new PaperAuthoringError("invalid_request", `${what} must be positive`);
}

/** Convert one shape into strokes that trace it. */
export function shapeToStrokes(shape: ShapeInput): AuthorStroke[] {
  const p = paint(shape, shape.strokeWidth);
  const one = (points: Xy[]) => [{ ...p, points }];
  switch (shape.kind) {
    case "rectangle":
      positive(shape.width, "Rectangle width");
      positive(shape.height, "Rectangle height");
      return one(roundedRect(shape.x, shape.y, shape.width, shape.height, shape.cornerRadius ?? 0));
    case "ellipse":
      positive(shape.rx, "Ellipse rx");
      positive(shape.ry, "Ellipse ry");
      return one(arc(shape.cx, shape.cy, shape.rx, shape.ry, 0, 2 * Math.PI));
    case "line": {
      const head = Math.max(8, p.width * 4);
      const strokes = one([pt(...shape.from), pt(...shape.to)]);
      if (shape.arrowEnd) strokes.push({ ...p, points: arrowHead(shape.from, shape.to, head) });
      if (shape.arrowStart) strokes.push({ ...p, points: arrowHead(shape.to, shape.from, head) });
      return strokes;
    }
    case "arrow":
      return one(blockArrow(shape.from, shape.to, shape.headLength ?? 24, shape.shaftWidth ?? 8));
    case "polygon":
      positive(shape.radius, "Polygon radius");
      if (!Number.isInteger(shape.sides) || shape.sides < 3 || shape.sides > 512)
        throw new PaperAuthoringError("invalid_request", "Polygon sides must be 3 to 512");
      return one(regular(shape.cx, shape.cy, [shape.radius], shape.sides, shape.rotation));
    case "star":
      positive(shape.outerRadius, "Star outerRadius");
      positive(shape.innerRadius, "Star innerRadius");
      if (!Number.isInteger(shape.points) || shape.points < 3 || shape.points > 512)
        throw new PaperAuthoringError("invalid_request", "Star points must be 3 to 512");
      return one(
        regular(
          shape.cx,
          shape.cy,
          [shape.outerRadius, shape.innerRadius],
          shape.points,
          shape.rotation
        )
      );
    case "chatBubble": {
      positive(shape.width, "Chat bubble width");
      positive(shape.height, "Chat bubble height");
      const r = Math.min(shape.width, shape.height) / 4;
      const body = roundedRect(shape.x, shape.y, shape.width, shape.height, r);
      // The tail joins the bottom edge near whichever end is closer to it.
      const baseX =
        shape.tail[0] < shape.x + shape.width / 2
          ? shape.x + r * 1.5
          : shape.x + shape.width - r * 1.5;
      const bottom = shape.y + shape.height;
      const tail: Xy[] = [pt(baseX - r / 2, bottom), pt(...shape.tail), pt(baseX + r / 2, bottom)];
      return [
        { ...p, points: body },
        { ...p, points: tail },
      ];
    }
    case "polyline": {
      if (shape.points.length < 2)
        throw new PaperAuthoringError("invalid_request", "A polyline needs at least two points");
      const points = shape.points.map((q) => pt(q[0], q[1]));
      if (shape.closed) points.push(points[0]);
      return one(points);
    }
  }
}

/** Convert free strokes and shapes into the writer's drawing. */
export function drawingFromInput(input: DrawingInput): {
  drawing: AuthorDrawing;
  inputStrokeCount: number;
  shapeCount: number;
  shapePersistence: "stroke-fallback" | "none";
} {
  const strokes: AuthorStroke[] = (input.strokes ?? []).map((s) => {
    if (!s.points.length)
      throw new PaperAuthoringError("invalid_request", "Every stroke needs at least one point");
    return {
      ...paint(s, s.width),
      // Decoded points carry up to nine values; x, y and width are what a stroke keeps.
      points: s.points.map((q) => {
        if (q.length < 2)
          throw new PaperAuthoringError("invalid_request", "Each point needs at least x and y");
        return (q.length >= 3 ? [q[0], q[1], q[2]] : [q[0], q[1]]) as AuthorPoint;
      }),
    };
  });
  const shapes = input.shapes ?? [];
  for (const shape of shapes) strokes.push(...shapeToStrokes(shape));
  if (!strokes.length)
    throw new PaperAuthoringError("invalid_request", "The drawing has no strokes or shapes");
  return {
    drawing: { strokes },
    inputStrokeCount: input.strokes?.length ?? 0,
    shapeCount: shapes.length,
    shapePersistence: shapes.length ? "stroke-fallback" : "none",
  };
}

/**
 * The analyzer's normalized drawing as writer strokes. Its monoline strokes
 * are written with the pen ink: at a constant width the two draw the same
 * line, and macOS 27 stores monoline as pen anyway.
 */
export function drawingFromSvg(drawing: NormalizedDrawing): AuthorDrawing {
  return {
    strokes: drawing.strokes.map((s) => ({
      ink: "pen",
      color: s.color,
      width: s.width,
      points: s.points.map(([x, y]) => [x, y] as AuthorPoint),
    })),
  };
}

/**
 * Bind a write to an exact analysis. A safe result may be written without a
 * digest. Any required loss needs `ifSvgAnalysis` equal to the analysis
 * digest and `allowSvgLosses` equal to the required losses: nothing missing
 * and nothing extra.
 */
export function authorizeSvgDrawing(
  result: SvgAnalysisResult,
  options: { ifSvgAnalysis?: string; allowSvgLosses?: string[] }
): NormalizedDrawing {
  const { analysis } = result;
  const allow = [...new Set(options.allowSvgLosses ?? [])];
  if (allow.length && options.ifSvgAnalysis === undefined)
    throw new PaperAuthoringError(
      "svg_analysis_required",
      "Accepting an SVG loss requires ifSvgAnalysis with the exact analysisDigest"
    );
  if (options.ifSvgAnalysis !== undefined && options.ifSvgAnalysis !== analysis.analysisDigest)
    throw new PaperAuthoringError(
      "svg_analysis_conflict",
      "The SVG or its normalized drawing changed since it was analyzed; run analyze-svg again"
    );
  if (!analysis.importable)
    throw new PaperAuthoringError("svg_not_importable", "The SVG has no drawable content");
  if (analysis.requiredLosses.length && options.ifSvgAnalysis === undefined)
    throw new PaperAuthoringError(
      "svg_analysis_required",
      `This SVG needs ${analysis.requiredLosses.join(", ")}; pass ifSvgAnalysis and allowSvgLosses`
    );
  const required: string[] = analysis.requiredLosses;
  const missing = required.filter((l) => !allow.includes(l));
  const extra = allow.filter((l) => !required.includes(l));
  if (missing.length || extra.length)
    throw new PaperAuthoringError(
      "svg_lossy_import_refused",
      "allowSvgLosses must list exactly the required losses" +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; not required ${extra.join(", ")}` : "")
    );
  return result.drawing;
}
