import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  NumberScanner,
  apply,
  arcToCubics,
  clipPolyline,
  clipSegment,
  dashPolyline,
  ellipseSubpath,
  flattenCubic,
  flattenSubpath,
  multiply,
  parseNumberList,
  parsePathData,
  parseTransform,
  rectSubpath,
  scales,
  scanFill,
  type Matrix,
  type Point,
} from "./svgGeometry.js";

const near = (a: number[], b: number[], digits = 6) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("matrices", () => {
  it("multiplies parent x child and applies to points", () => {
    const m = multiply([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0]);
    expect(apply(m, [1, 1])).toEqual([12, 2]);
    expect(multiply(IDENTITY, m)).toEqual(m);
  });
  it("reports singular values", () => {
    near(scales([2, 0, 0, 3, 0, 0]), [3, 2]);
    const r = Math.SQRT1_2;
    near(scales([r, r, -r, r, 5, 5]), [1, 1]);
  });
});

describe("number lists and transforms", () => {
  it("scans numbers, flags and separators", () => {
    expect(parseNumberList("1,2 3-4.5e1.5")).toEqual([1, 2, 3, -45, 0.5]);
    expect(parseNumberList("1,,2")).toBeNull();
    expect(parseNumberList(",1")).toBeNull();
    expect(parseNumberList("  ")).toEqual([]);
    const s = new NumberScanner(" 10 1e999");
    expect(s.peek()).toBe("1");
    expect(s.number()).toBe(10);
    expect(s.number()).toBeNull();
    const f = new NumberScanner("01x");
    expect(f.flag()).toBe(0);
    expect(f.flag()).toBe(1);
    expect(f.flag()).toBeNull();
    expect(f.take()).toBe("x");
    expect(f.take()).toBe("");
    expect(f.done()).toBe(true);
  });
  it("parses every transform function", () => {
    near(parseTransform("translate(5)")!, [1, 0, 0, 1, 5, 0]);
    near(parseTransform("translate(5, 6) scale(2)")!, [2, 0, 0, 2, 5, 6]);
    near(parseTransform("scale(2 3)")!, [2, 0, 0, 3, 0, 0]);
    near(parseTransform("rotate(90)")!, [0, 1, -1, 0, 0, 0]);
    near(apply(parseTransform("rotate(90 10 10)")!, [20, 10]), [10, 20]);
    near(parseTransform("skewX(45)")!, [1, 0, 1, 1, 0, 0]);
    near(parseTransform("skewY(45)")!, [1, 1, 0, 1, 0, 0]);
    near(parseTransform("matrix(1 2 3 4 5 6)")!, [1, 2, 3, 4, 5, 6]);
    expect(parseTransform("")).toEqual(IDENTITY);
  });
  it.each([
    "matrix(1 2)",
    "translate()",
    "scale(1 2 3)",
    "rotate(1 2)",
    "skewX(1 2)",
    "skewY()",
    "spin(4)",
    "translate(a)",
    "translate(1) junk",
    "scale(1e308) scale(1e308)",
  ])("rejects %s", (text) => expect(parseTransform(text)).toBeNull());
});

describe("path data", () => {
  it("parses absolute and relative commands into lines and cubics", () => {
    const p = parsePathData(
      "M10 10 h10 v10 H10 V10 l5 5 L0 0 z m1 1 c1 1 2 2 3 3 s1 1 2 2 S1 1 2 2"
    );
    expect(p.error).toBe(false);
    expect(p.curved).toBe(true);
    expect(p.subpaths[0].segments.map((s) => s.to)).toEqual([
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
      [15, 15],
      [0, 0],
    ]);
    expect(p.subpaths[0].closed).toBe(true);
    const curve = p.subpaths[2].segments;
    expect(curve[0]).toMatchObject({ kind: "C", c1: [12, 12], to: [14, 14] });
    // Smooth cubic reflects the previous second control point.
    expect(curve[1]).toMatchObject({ c1: [15, 15], to: [16, 16] });
    expect(curve[2]).toMatchObject({ kind: "C", to: [2, 2] });
  });
  it("raises quadratics to cubics and reflects smooth quadratics", () => {
    const p = parsePathData("M0 0 Q 3 3 6 0 T 12 0 t 6 0 M 0 0 T 1 1");
    const [q, t] = p.subpaths[0].segments;
    near((q as { c1: Point }).c1, [2, 2]);
    near((q as { c2: Point }).c2, [4, 2]);
    near((t as { c1: Point }).c1, [8, -2]);
    expect(p.subpaths[1].segments[0]).toMatchObject({ c1: [0, 0], to: [1, 1] });
  });
  it("turns arcs into cubics that end exactly at the target", () => {
    const p = parsePathData("M0 0 A10 10 0 0 1 20 0 a5 5 0 1 0 0 0 A0 5 0 0 1 30 0");
    const segs = p.subpaths[0].segments;
    expect(segs.length).toBe(3);
    expect(segs[1]).toEqual({
      kind: "C",
      c1: expect.any(Array),
      c2: expect.any(Array),
      to: [20, 0],
    });
    expect(segs[2]).toEqual({ kind: "L", to: [30, 0] });
  });
  it("renders up to the first error", () => {
    for (const d of [
      "M0 0 L5",
      "L1 1",
      "M0 0 5 5 Z 3",
      "M0 0 X1",
      "M",
      "M0 0 C1 1",
      "M0 0 Q1",
      "M0 0 A1 1 0 2 0 3 3",
      "M0 0 H",
      "M0 0 V",
    ])
      expect(parsePathData(d).error).toBe(true);
    const partial = parsePathData("M0 0 L5 5 L");
    expect(partial.subpaths[0].segments).toHaveLength(1);
  });
});

describe("arcToCubics", () => {
  it("handles degenerate arcs and scales up radii that are too small", () => {
    expect(arcToCubics([1, 1], 5, 5, 0, 0, 0, [1, 1])).toEqual([]);
    const small = arcToCubics([0, 0], 1, 1, 0, 0, 1, [10, 0]);
    expect(small).toHaveLength(2);
    const rotated = arcToCubics([0, 0], 10, 5, 30, 1, 0, [10, 10]);
    expect(rotated[rotated.length - 1].to).toEqual([10, 10]);
    // A semicircle's midpoint lies on the circle.
    const half = arcToCubics([0, 0], 10, 10, 0, 0, 1, [20, 0]);
    const out: Point[] = [];
    flattenCubic(
      [0, 0],
      (half[0] as { c1: Point }).c1,
      (half[0] as { c2: Point }).c2,
      half[0].to,
      0.01,
      out
    );
    for (const p of out) expect(Math.hypot(p[0] - 10, p[1])).toBeCloseTo(10, 1);
  });
});

describe("shapes and flattening", () => {
  it("builds rectangles with and without rounded corners", () => {
    expect(rectSubpath(0, 0, 10, 5, 0, 0).segments).toHaveLength(4);
    const rounded = rectSubpath(0, 0, 10, 10, 2, 2);
    expect(rounded.segments.filter((s) => s.kind === "C")).toHaveLength(4);
    expect(rounded.start).toEqual([2, 0]);
  });
  it("flattens an ellipse within tolerance and closes it", () => {
    const pts = flattenSubpath(ellipseSubpath(0, 0, 100, 50), IDENTITY, 0.25);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    for (const [x, y] of pts)
      expect(Math.abs((x / 100) ** 2 + (y / 50) ** 2 - 1)).toBeLessThan(0.02);
  });
  it("flattens after transforming, closing an open closed path", () => {
    const pts = flattenSubpath(
      { start: [0, 0], closed: true, segments: [{ kind: "L", to: [1, 0] }] },
      [2, 0, 0, 2, 1, 1] as Matrix,
      0.25
    );
    expect(pts).toEqual([
      [1, 1],
      [3, 1],
      [1, 1],
    ]);
  });
});

describe("clipping", () => {
  const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
  it("clips segments with Liang-Barsky", () => {
    expect(clipSegment([-5, 5], [15, 5], r)).toEqual([
      [0, 5],
      [10, 5],
    ]);
    expect(clipSegment([-5, -5], [-1, 20], r)).toBeNull();
    expect(clipSegment([5, -5], [5, -1], r)).toBeNull();
    expect(clipSegment([20, 5], [20, 6], r)).toBeNull();
  });
  it("splits polylines that leave and re-enter", () => {
    expect(
      clipPolyline(
        [
          [1, 1],
          [2, 2],
        ],
        r
      )
    ).toEqual({
      parts: [
        [
          [1, 1],
          [2, 2],
        ],
      ],
      clipped: false,
    });
    const out = clipPolyline(
      [
        [5, 5],
        [5, 15],
        [8, 15],
        [8, 5],
        [9, 5],
      ],
      r
    );
    expect(out.clipped).toBe(true);
    expect(out.parts).toEqual([
      [
        [5, 5],
        [5, 10],
      ],
      [
        [8, 10],
        [8, 5],
        [9, 5],
      ],
    ]);
    expect(clipPolyline([[20, 20]], r)).toEqual({ parts: [], clipped: true });
    expect(
      clipPolyline(
        [
          [20, 20],
          [30, 30],
          [2, 2],
        ],
        r
      ).parts
    ).toEqual([
      [
        [10, 10],
        [2, 2],
      ],
    ]);
  });
});

describe("dashPolyline", () => {
  it("splits a line into dashes and charges each", () => {
    let charged = 0;
    const dashes = dashPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      [2, 2],
      0,
      (n) => (charged += n)
    );
    expect(dashes).toEqual([
      [
        [0, 0],
        [2, 0],
      ],
      [
        [4, 0],
        [6, 0],
      ],
      [
        [8, 0],
        [10, 0],
      ],
    ]);
    expect(charged).toBe(3);
  });
  it("honours offsets and dashes that turn corners", () => {
    const dashes = dashPolyline(
      [
        [0, 0],
        [3, 0],
        [3, 3],
      ],
      [4, 1],
      -1,
      () => {}
    );
    // Offset -1 starts inside the 1-unit gap, so the first dash begins at x = 1
    // and turns the corner.
    expect(dashes[0]).toEqual([
      [1, 0],
      [3, 0],
      [3, 2],
    ]);
    const shifted = dashPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      [3, 2],
      4,
      () => {}
    );
    expect(shifted[0][0]).toEqual([1, 0]);
  });
});

describe("scanFill", () => {
  const square: Point[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  it("fills a square with one serpentine stroke inset by half the brush", () => {
    let work = 0;
    const strokes = scanFill([square], false, 2, 2, (n) => (work += n));
    expect(strokes).toHaveLength(1);
    expect(strokes[0][0]).toEqual([1, 1]);
    expect(strokes[0][1]).toEqual([9, 1]);
    expect(strokes[0][2]).toEqual([9, 3]);
    expect(work).toBeGreaterThan(0);
  });
  it("leaves holes empty under evenodd and fills them under nonzero with same winding", () => {
    const inner: Point[] = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ];
    const evenOdd = scanFill([square, inner], true, 1, 1, () => {});
    const nonZero = scanFill([square, inner], false, 1, 1, () => {});
    const midRow = (strokes: Point[][]) =>
      strokes
        .flat()
        .filter((p) => p[1] === 5.5)
        .map((p) => p[0]);
    expect(midRow(evenOdd).length).toBe(4);
    expect(midRow(nonZero).length).toBe(2);
  });
  it("emits a dot for spans narrower than the brush and nothing for flat input", () => {
    const sliver: Point[] = [
      [0, 0],
      [1, 0],
      [1, 10],
      [0, 10],
    ];
    const strokes = scanFill([sliver], false, 4, 4, () => {});
    expect(strokes[0][0]).toEqual([0.5, expect.any(Number)]);
    expect(
      scanFill(
        [
          [
            [0, 0],
            [5, 0],
          ],
        ],
        false,
        1,
        1,
        () => {}
      )
    ).toEqual([]);
  });
});
