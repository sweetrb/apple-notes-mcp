import { describe, expect, it } from "vitest";
import {
  AUTHOR_INKS,
  PaperAuthoringError,
  authorizeSvgDrawing,
  drawingFromInput,
  drawingFromSvg,
  shapeToStrokes,
  type ShapeInput,
} from "./paperAuthoring.js";
import { analyzeSvgBuffer } from "./svgAnalyzer.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const SAFE = analyzeSvgBuffer(
  Buffer.from(
    `<svg ${NS} width="20" height="20"><path d="M1 1 L19 19" stroke="red" stroke-linecap="round" stroke-width="2"/></svg>`
  )
);
const LOSSY = analyzeSvgBuffer(
  Buffer.from(`<svg ${NS} width="20" height="20"><rect width="10" height="10" fill="blue"/></svg>`)
);
const EMPTY = analyzeSvgBuffer(Buffer.from(`<svg ${NS} width="20" height="20"/>`));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PaperAuthoringError) return error.code;
    throw error;
  }
  throw new Error("expected a PaperAuthoringError");
}

describe("shapeToStrokes", () => {
  it("traces rectangles, with and without rounded corners", () => {
    const [plain] = shapeToStrokes({ kind: "rectangle", x: 0, y: 0, width: 10, height: 5 });
    expect(plain.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
      [0, 0],
    ]);
    expect(plain).toMatchObject({ ink: "pen", color: [0, 0, 0, 1], width: 2 });
    const [rounded] = shapeToStrokes({
      kind: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      cornerRadius: 3,
      ink: "marker",
      color: [1, 0, 0, 1],
      strokeWidth: 4,
    });
    expect(rounded.points.length).toBeGreaterThan(10);
    expect(rounded).toMatchObject({ ink: "marker", color: [1, 0, 0, 1], width: 4 });
  });

  it("traces ellipses, polygons and stars as closed outlines", () => {
    const [ellipse] = shapeToStrokes({ kind: "ellipse", cx: 0, cy: 0, rx: 10, ry: 5 });
    expect(ellipse.points[0]).toEqual([10, 0]);
    expect(ellipse.points[ellipse.points.length - 1]).toEqual([10, 0]);
    const [triangle] = shapeToStrokes({ kind: "polygon", cx: 0, cy: 0, radius: 10, sides: 3 });
    expect(triangle.points).toHaveLength(4);
    expect(triangle.points[0]).toEqual([0, -10]);
    const [star] = shapeToStrokes({
      kind: "star",
      cx: 0,
      cy: 0,
      outerRadius: 10,
      innerRadius: 4,
      points: 5,
      rotation: 90,
    });
    expect(star.points).toHaveLength(11);
    expect(star.points[0]).toEqual([10, 0]);
  });

  it("adds arrowheads to lines and outlines block arrows", () => {
    expect(shapeToStrokes({ kind: "line", from: [0, 0], to: [10, 0] })).toHaveLength(1);
    const both = shapeToStrokes({
      kind: "line",
      from: [0, 0],
      to: [100, 0],
      arrowStart: true,
      arrowEnd: true,
    });
    expect(both).toHaveLength(3);
    expect(both[1].points[1]).toEqual([100, 0]);
    expect(both[2].points[1]).toEqual([0, 0]);
    const [arrow] = shapeToStrokes({ kind: "arrow", from: [0, 0], to: [100, 0] });
    expect(arrow.points).toHaveLength(8);
    expect(arrow.points[3]).toEqual([100, 0]);
  });

  it("draws a chat bubble body and a tail toward either side", () => {
    const left = shapeToStrokes({
      kind: "chatBubble",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      tail: [5, 60],
    });
    const right = shapeToStrokes({
      kind: "chatBubble",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      tail: [95, 60],
    });
    expect(left).toHaveLength(2);
    expect(left[1].points[1]).toEqual([5, 60]);
    expect(left[1].points[0][0]).toBeLessThan(right[1].points[0][0]);
  });

  it("draws polylines, closing them on request", () => {
    const [open] = shapeToStrokes({
      kind: "polyline",
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const [closed] = shapeToStrokes({
      kind: "polyline",
      points: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
      closed: true,
    });
    expect(open.points).toHaveLength(2);
    expect(closed.points).toHaveLength(4);
  });

  it.each<[ShapeInput]>([
    [{ kind: "rectangle", x: 0, y: 0, width: 0, height: 5 }],
    [{ kind: "ellipse", cx: 0, cy: 0, rx: 1, ry: -1 }],
    [{ kind: "polygon", cx: 0, cy: 0, radius: 1, sides: 2 }],
    [{ kind: "star", cx: 0, cy: 0, outerRadius: 1, innerRadius: 1, points: 1.5 }],
    [{ kind: "chatBubble", x: 0, y: 0, width: 5, height: 0, tail: [0, 0] }],
    [{ kind: "polyline", points: [[0, 0]] }],
    [{ kind: "arrow", from: [1, 1], to: [1, 1] }],
  ])("refuses degenerate %o", (shape) => {
    expect(code(() => shapeToStrokes(shape))).toBe("invalid_request");
  });
});

describe("drawingFromInput", () => {
  it("keeps free strokes, trims decoded point rows, and converts shapes", () => {
    const out = drawingFromInput({
      strokes: [
        { points: [[1, 2]] },
        { ink: "pencil", width: 5, points: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] },
      ],
      shapes: [{ kind: "line", from: [0, 0], to: [1, 1] }],
    });
    expect(out.inputStrokeCount).toBe(2);
    expect(out.shapeCount).toBe(1);
    expect(out.shapePersistence).toBe("stroke-fallback");
    expect(out.drawing.strokes[0]).toEqual({
      ink: "pen",
      color: [0, 0, 0, 1],
      width: 2,
      points: [[1, 2]],
    });
    expect(out.drawing.strokes[1].points).toEqual([[1, 2, 3]]);
    expect(out.drawing.strokes).toHaveLength(3);
    expect(drawingFromInput({ strokes: [{ points: [[0, 0]] }] }).shapePersistence).toBe("none");
  });

  it("refuses empty input and malformed points", () => {
    expect(code(() => drawingFromInput({}))).toBe("invalid_request");
    expect(code(() => drawingFromInput({ strokes: [{ points: [] }] }))).toBe("invalid_request");
    expect(code(() => drawingFromInput({ strokes: [{ points: [[1]] }] }))).toBe("invalid_request");
    expect(code(() => drawingFromInput({ shapes: [] }))).toBe("invalid_request");
  });
});

describe("SVG binding", () => {
  it("converts the analyzer's strokes to pen strokes", () => {
    const drawing = drawingFromSvg(SAFE.drawing);
    expect(drawing.strokes[0]).toMatchObject({ ink: "pen", width: 2, color: [1, 0, 0, 1] });
    expect(drawing.strokes[0].points).toEqual([
      [1, 1],
      [19, 19],
    ]);
    expect(AUTHOR_INKS).not.toContain("monoline");
  });

  it("allows a safe SVG without a digest, or with the matching one", () => {
    expect(authorizeSvgDrawing(SAFE, {})).toBe(SAFE.drawing);
    expect(authorizeSvgDrawing(SAFE, { ifSvgAnalysis: SAFE.analysis.analysisDigest })).toBe(
      SAFE.drawing
    );
  });

  it("requires the exact digest and exactly the reported losses for a lossy SVG", () => {
    const digest = LOSSY.analysis.analysisDigest;
    expect(LOSSY.analysis.requiredLosses).toEqual(["paint-approximation"]);
    expect(code(() => authorizeSvgDrawing(LOSSY, {}))).toBe("svg_analysis_required");
    expect(
      code(() => authorizeSvgDrawing(LOSSY, { allowSvgLosses: ["paint-approximation"] }))
    ).toBe("svg_analysis_required");
    expect(
      code(() =>
        authorizeSvgDrawing(LOSSY, {
          ifSvgAnalysis: SAFE.analysis.analysisDigest,
          allowSvgLosses: ["paint-approximation"],
        })
      )
    ).toBe("svg_analysis_conflict");
    expect(code(() => authorizeSvgDrawing(LOSSY, { ifSvgAnalysis: digest }))).toBe(
      "svg_lossy_import_refused"
    );
    expect(
      code(() =>
        authorizeSvgDrawing(LOSSY, {
          ifSvgAnalysis: digest,
          allowSvgLosses: ["paint-approximation", "drop-content"],
        })
      )
    ).toBe("svg_lossy_import_refused");
    expect(
      authorizeSvgDrawing(LOSSY, {
        ifSvgAnalysis: digest,
        allowSvgLosses: ["paint-approximation", "paint-approximation"],
      })
    ).toBe(LOSSY.drawing);
  });

  it("never writes an SVG with nothing drawable", () => {
    expect(code(() => authorizeSvgDrawing(EMPTY, {}))).toBe("svg_not_importable");
  });
});
