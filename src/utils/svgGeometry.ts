/**
 * Geometry for the SVG analyzer: affine transforms, path data, curve
 * flattening, viewport clipping, dashing and fill scan conversion.
 *
 * Shapes and path data become subpaths made of line and cubic segments in the
 * element's own coordinates. Quadratic curves are raised to cubics exactly and
 * elliptical arcs become cubics of at most 90 degrees. Control points are then
 * mapped through the element's transform (an affine map keeps a Bezier a
 * Bezier) and the cubics are flattened in output space, so the flattening
 * tolerance is in output pixels.
 *
 * @module utils/svgGeometry
 */

export type Point = [number, number];
/** SVG matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `left` applied after `right` (SVG nesting: parent x child). */
export function multiply(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left;
  const [A, B, C, D, E, F] = right;
  return [
    a * A + c * B,
    b * A + d * B,
    a * C + c * D,
    b * C + d * D,
    a * E + c * F + e,
    b * E + d * F + f,
  ];
}

export function apply(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Singular values of the linear part, largest first. */
export function scales(m: Matrix): [number, number] {
  const [a, b, c, d] = m;
  const s1 = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const root = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
  return [Math.sqrt((s1 + root) / 2), Math.sqrt(Math.max(0, (s1 - root) / 2))];
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Reads numbers (and single-digit arc flags) from SVG number lists. */
export class NumberScanner {
  private pos = 0;
  /** A comma was consumed since the last token (one comma separates two tokens). */
  private comma = true;
  constructor(private readonly text: string) {}

  private skip() {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") this.pos++;
      else if (ch === "," && !this.comma) {
        this.pos++;
        this.comma = true;
      } else break;
    }
  }

  done(): boolean {
    this.skip();
    return this.pos >= this.text.length;
  }

  /** The next character, after separators, without consuming it. */
  peek(): string {
    this.skip();
    return this.text[this.pos] ?? "";
  }

  take(): string {
    this.skip();
    this.comma = false;
    return this.text[this.pos++] ?? "";
  }

  number(): number | null {
    this.skip();
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text);
    if (!m) return null;
    this.pos += m[0].length;
    this.comma = false;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  flag(): number | null {
    this.skip();
    const ch = this.text[this.pos];
    if (ch !== "0" && ch !== "1") return null;
    this.pos++;
    this.comma = false;
    return ch === "1" ? 1 : 0;
  }
}

/** Parse a `points` or number-list attribute; null when malformed. */
export function parseNumberList(text: string): number[] | null {
  const scanner = new NumberScanner(text);
  const out: number[] = [];
  while (!scanner.done()) {
    const n = scanner.number();
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** Parse a `transform` attribute. Null when malformed. */
export function parseTransform(text: string): Matrix | null {
  let m: Matrix = IDENTITY;
  const re = /\s*,?\s*([a-zA-Z]+)\s*\(([^)]*)\)/y;
  let pos = 0;
  const trimmed = text.trim();
  while (pos < trimmed.length) {
    re.lastIndex = pos;
    const hit = re.exec(trimmed);
    if (!hit) return null;
    pos = re.lastIndex;
    const args = parseNumberList(hit[2]);
    if (!args) return null;
    const n = args.length;
    let t: Matrix;
    switch (hit[1]) {
      case "matrix":
        if (n !== 6) return null;
        t = args as Matrix;
        break;
      case "translate":
        if (n !== 1 && n !== 2) return null;
        t = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case "scale":
        if (n !== 1 && n !== 2) return null;
        t = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case "rotate": {
        if (n !== 1 && n !== 3) return null;
        const r = (args[0] * Math.PI) / 180;
        const [cos, sin] = [Math.cos(r), Math.sin(r)];
        t = [cos, sin, -sin, cos, 0, 0];
        if (n === 3)
          t = multiply(multiply([1, 0, 0, 1, args[1], args[2]], t), [
            1,
            0,
            0,
            1,
            -args[1],
            -args[2],
          ]);
        break;
      }
      case "skewX":
        if (n !== 1) return null;
        t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        if (n !== 1) return null;
        t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        return null;
    }
    m = multiply(m, t);
  }
  return m.every(Number.isFinite) ? m : null;
}

export type Segment = { kind: "L"; to: Point } | { kind: "C"; c1: Point; c2: Point; to: Point };

export interface Subpath {
  start: Point;
  segments: Segment[];
  closed: boolean;
}

export interface ParsedPath {
  subpaths: Subpath[];
  /** True when the data had an error; subpaths hold everything before it. */
  error: boolean;
  /** True when any segment is a curve. */
  curved: boolean;
}

const KAPPA = 0.5522847498307936;

/** Cubic segments approximating an elliptical arc (SVG implementation notes F.6). */
export function arcToCubics(
  from: Point,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: number,
  sweep: number,
  to: Point
): Segment[] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ kind: "L", to }];
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const map = (x: number, y: number): Point => [cos * x - sin * y + cx, sin * x + cos * y + cy];
  const out: Segment[] = [];
  for (let i = 0; i < pieces; i++) {
    const t1 = theta1 + i * step;
    const t2 = t1 + step;
    const [e1x, e1y] = [rx * Math.cos(t1), ry * Math.sin(t1)];
    const [e2x, e2y] = [rx * Math.cos(t2), ry * Math.sin(t2)];
    const [d1x, d1y] = [-rx * Math.sin(t1), ry * Math.cos(t1)];
    const [d2x, d2y] = [-rx * Math.sin(t2), ry * Math.cos(t2)];
    out.push({
      kind: "C",
      c1: map(e1x + k * d1x, e1y + k * d1y),
      c2: map(e2x - k * d2x, e2y - k * d2y),
      to: i === pieces - 1 ? to : map(e2x, e2y),
    });
  }
  return out;
}

/** Parse SVG path data into subpaths of absolute line and cubic segments. */
export function parsePathData(d: string): ParsedPath {
  const s = new NumberScanner(d);
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let pen: Point = [0, 0];
  let start: Point = [0, 0];
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let curved = false;
  let command = "";
  const result = (error: boolean): ParsedPath => ({ subpaths, error, curved });
  const lineTo = (to: Point) => {
    current!.segments.push({ kind: "L", to });
    pen = to;
  };

  while (!s.done()) {
    const next = s.peek();
    if (/[a-zA-Z]/.test(next)) command = s.take();
    else if (!command || command === "z" || command === "Z") return result(true);
    const rel = command === command.toLowerCase();
    const base = rel ? pen : ([0, 0] as Point);
    const num = () => s.number();
    const pt = (): Point | null => {
      const x = num();
      const y = x === null ? null : num();
      return x === null || y === null ? null : [x + base[0], y + base[1]];
    };
    const upper = command.toUpperCase();
    if (!current && upper !== "M") return result(true);
    let cubicCtrl: Point | null = null;
    let quadCtrl: Point | null = null;
    switch (upper) {
      case "M": {
        const p = pt();
        if (!p) return result(true);
        current = { start: p, segments: [], closed: false };
        subpaths.push(current);
        pen = p;
        start = p;
        // Further pairs after a moveto are implicit linetos.
        command = rel ? "l" : "L";
        break;
      }
      case "L": {
        const p = pt();
        if (!p) return result(true);
        lineTo(p);
        break;
      }
      case "H": {
        const x = num();
        if (x === null) return result(true);
        lineTo([x + base[0], pen[1]]);
        break;
      }
      case "V": {
        const y = num();
        if (y === null) return result(true);
        lineTo([pen[0], y + base[1]]);
        break;
      }
      case "C":
      case "S": {
        let c1: Point | null;
        if (upper === "C") c1 = pt();
        else c1 = lastCubic ? [2 * pen[0] - lastCubic[0], 2 * pen[1] - lastCubic[1]] : pen;
        const c2: Point | null = c1 ? pt() : null;
        const to: Point | null = c2 ? pt() : null;
        if (!c1 || !c2 || !to) return result(true);
        current!.segments.push({ kind: "C", c1, c2, to });
        cubicCtrl = c2;
        pen = to;
        curved = true;
        break;
      }
      case "Q":
      case "T": {
        let q: Point | null;
        if (upper === "Q") q = pt();
        else q = lastQuad ? [2 * pen[0] - lastQuad[0], 2 * pen[1] - lastQuad[1]] : pen;
        const to: Point | null = q ? pt() : null;
        if (!q || !to) return result(true);
        current!.segments.push({
          kind: "C",
          c1: [pen[0] + (2 / 3) * (q[0] - pen[0]), pen[1] + (2 / 3) * (q[1] - pen[1])],
          c2: [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
          to,
        });
        quadCtrl = q;
        pen = to;
        curved = true;
        break;
      }
      case "A": {
        const rx = num();
        const ry = rx === null ? null : num();
        const rot = ry === null ? null : num();
        const large = rot === null ? null : s.flag();
        const sweep = large === null ? null : s.flag();
        const to: Point | null = sweep === null ? null : pt();
        if (!to) return result(true);
        const segs = arcToCubics(pen, rx!, ry!, rot!, large!, sweep!, to);
        current!.segments.push(...segs);
        if (segs.some((g) => g.kind === "C")) curved = true;
        pen = to;
        break;
      }
      case "Z":
        current!.closed = true;
        pen = start;
        // A command after Z without a moveto starts a new subpath at the start point.
        current = { start, segments: [], closed: false };
        subpaths.push(current);
        break;
      default:
        return result(true);
    }
    lastCubic = cubicCtrl;
    lastQuad = quadCtrl;
  }
  return result(false);
}

/** Cubic segments for an axis-aligned ellipse, starting at its rightmost point. */
export function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    start: [cx + rx, cy],
    closed: true,
    segments: [
      { kind: "C", c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], to: [cx, cy + ry] },
      { kind: "C", c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], to: [cx - rx, cy] },
      { kind: "C", c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], to: [cx, cy - ry] },
      { kind: "C", c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], to: [cx + rx, cy] },
    ],
  };
}

/** A rectangle, with elliptical corners when rx/ry are positive. */
export function rectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number
): Subpath {
  if (rx <= 0 || ry <= 0)
    return {
      start: [x, y],
      closed: true,
      segments: [
        { kind: "L", to: [x + w, y] },
        { kind: "L", to: [x + w, y + h] },
        { kind: "L", to: [x, y + h] },
        { kind: "L", to: [x, y] },
      ],
    };
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + w;
  const b = y + h;
  return {
    start: [x + rx, y],
    closed: true,
    segments: [
      { kind: "L", to: [r - rx, y] },
      { kind: "C", c1: [r - rx + kx, y], c2: [r, y + ry - ky], to: [r, y + ry] },
      { kind: "L", to: [r, b - ry] },
      { kind: "C", c1: [r, b - ry + ky], c2: [r - rx + kx, b], to: [r - rx, b] },
      { kind: "L", to: [x + rx, b] },
      { kind: "C", c1: [x + rx - kx, b], c2: [x, b - ry + ky], to: [x, b - ry] },
      { kind: "L", to: [x, y + ry] },
      { kind: "C", c1: [x, y + ry - ky], c2: [x + rx - kx, y], to: [x + rx, y] },
    ],
  };
}

function distanceToChord(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Flatten a cubic to points after p0 (p0 itself is not emitted). */
export function flattenCubic(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  tolerance: number,
  out: Point[],
  depth = 0
): void {
  if (
    depth >= 16 ||
    Math.max(distanceToChord(c1, p0, p3), distanceToChord(c2, p0, p3)) <= tolerance
  ) {
    out.push(p3);
    return;
  }
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = mid(p0, c1);
  const b = mid(c1, c2);
  const c = mid(c2, p3);
  const d = mid(a, b);
  const e = mid(b, c);
  const m = mid(d, e);
  flattenCubic(p0, a, d, m, tolerance, out, depth + 1);
  flattenCubic(m, e, c, p3, tolerance, out, depth + 1);
}

/** Map a subpath through `m` and flatten it into a polyline in output space. */
export function flattenSubpath(sub: Subpath, m: Matrix, tolerance: number): Point[] {
  const points: Point[] = [apply(m, sub.start)];
  let pen = sub.start;
  for (const seg of sub.segments) {
    if (seg.kind === "L") points.push(apply(m, seg.to));
    else
      flattenCubic(
        apply(m, pen),
        apply(m, seg.c1),
        apply(m, seg.c2),
        apply(m, seg.to),
        tolerance,
        points
      );
    pen = seg.to;
  }
  if (sub.closed) {
    const first = points[0];
    const last = points[points.length - 1];
    if (last[0] !== first[0] || last[1] !== first[1]) points.push(first);
  }
  return points;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Clip one segment to a rectangle (Liang-Barsky). Null when fully outside. */
export function clipSegment(a: Point, b: Point, r: Rect): [Point, Point] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** Clip a polyline to a rectangle; `clipped` is true when anything was cut. */
export function clipPolyline(points: Point[], r: Rect): { parts: Point[][]; clipped: boolean } {
  const inside = (p: Point) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
  if (points.every(inside)) return { parts: [points], clipped: false };
  if (points.length === 1) return { parts: [], clipped: true };
  const parts: Point[][] = [];
  let run: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    const seg = clipSegment(points[i - 1], points[i], r);
    if (!seg) {
      if (run.length) parts.push(run);
      run = [];
      continue;
    }
    const [a, b] = seg;
    const last = run[run.length - 1];
    if (!run.length || last[0] !== a[0] || last[1] !== a[1]) {
      if (run.length) parts.push(run);
      run = [a];
    }
    run.push(b);
    if (b[0] !== points[i][0] || b[1] !== points[i][1]) {
      parts.push(run);
      run = [];
    }
  }
  if (run.length) parts.push(run);
  return { parts, clipped: true };
}

/**
 * Split a polyline into dashes. `charge(n)` is called with the number of
 * dashes produced, so the caller can enforce its work budget.
 */
export function dashPolyline(
  points: Point[],
  pattern: number[],
  offset: number,
  charge: (n: number) => void
): Point[][] {
  const total = pattern.reduce((s, v) => s + v, 0);
  let index = 0;
  let remaining = pattern[0];
  let on = true;
  let shift = ((offset % total) + total) % total;
  while (shift > 0) {
    const step = Math.min(shift, remaining);
    remaining -= step;
    shift -= step;
    if (remaining <= 0) {
      index = (index + 1) % pattern.length;
      remaining = pattern[index];
      on = !on;
    }
  }
  const dashes: Point[][] = [];
  let currentDash: Point[] | null = on ? [points[0]] : null;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (segLen > remaining) {
      const t = remaining / segLen;
      const cut: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (on && currentDash) {
        currentDash.push(cut);
        dashes.push(currentDash);
        charge(1);
        currentDash = null;
      } else currentDash = [cut];
      on = !on;
      segLen -= remaining;
      a = cut;
      index = (index + 1) % pattern.length;
      remaining = pattern[index];
    }
    remaining -= segLen;
    if (on && currentDash) currentDash.push(b);
  }
  if (on && currentDash && currentDash.length > 1) {
    dashes.push(currentDash);
    charge(1);
  }
  return dashes;
}

/**
 * Scan-convert closed rings into horizontal brush strokes. Scanlines are
 * `spacing` apart; each span is inset by half the brush width so the round
 * brush stays inside the shape where the span is wide enough. Consecutive
 * scanlines with the same number of overlapping spans are chained into
 * serpentine strokes. `charge(n)` receives the edge checks performed.
 */
export function scanFill(
  rings: Point[][],
  evenOdd: boolean,
  brush: number,
  spacing: number,
  charge: (n: number) => void
): Point[][] {
  const edges: [Point, Point][] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[1] !== b[1]) edges.push([a, b]);
      minY = Math.min(minY, a[1]);
      maxY = Math.max(maxY, a[1]);
    }
  if (!edges.length) return [];
  const height = maxY - minY;
  const lines = Math.max(1, Math.round(height / spacing));
  const step = height / lines;
  const out: Point[][] = [];
  let chains: Point[][] = [];
  let previous: [number, number][] = [];
  for (let k = 0; k < lines; k++) {
    const y = minY + step * (k + 0.5);
    charge(edges.length);
    const crossings: { x: number; dir: number }[] = [];
    for (const [a, b] of edges) {
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      if (y < lo || y >= hi) continue;
      crossings.push({
        x: a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]),
        dir: b[1] > a[1] ? 1 : -1,
      });
    }
    crossings.sort((p, q) => p.x - q.x);
    const spans: [number, number][] = [];
    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding = evenOdd ? winding ^ 1 : winding + crossings[i].dir;
      if (winding !== 0 && crossings[i + 1].x > crossings[i].x)
        spans.push([crossings[i].x, crossings[i + 1].x]);
    }
    // Merge touching spans produced by nonzero winding.
    const merged: [number, number][] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    const continues =
      merged.length === previous.length &&
      merged.every((s, i) => s[0] <= previous[i][1] && s[1] >= previous[i][0]);
    if (!continues) {
      out.push(...chains);
      chains = merged.map(() => []);
    }
    merged.forEach(([x0, x1], i) => {
      const inset = Math.min(brush / 2, (x1 - x0) / 2);
      const left: Point = [x0 + inset, y];
      const right: Point = [x1 - inset, y];
      const forward = k % 2 === 0;
      const pts = left[0] === right[0] ? [left] : forward ? [left, right] : [right, left];
      chains[i].push(...pts);
    });
    previous = merged;
  }
  out.push(...chains);
  return out.filter((c) => c.length > 0);
}
