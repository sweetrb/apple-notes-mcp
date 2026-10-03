import { describe, expect, it } from "vitest";
import { paperToSvg, type PaperSvgStroke } from "./paperSvg.js";
import { analyzeSvgBuffer } from "./svgAnalyzer.js";

const ID: PaperSvgStroke["transform"] = [1, 0, 0, 1, 0, 0];

function stroke(over: Partial<PaperSvgStroke> = {}): PaperSvgStroke {
  return {
    ink: "com.apple.ink.pen",
    color: [0, 0, 0, 1],
    width: 2,
    transform: ID,
    points: [
      [10, 20, 2, 2, 1, 0.5],
      [30, 40, 2, 2, 1, 0.5],
    ],
    ...over,
  };
}

describe("paperToSvg", () => {
  it("draws one round-capped path per stroke through its points, in order", () => {
    const r = paperToSvg({ bounds: [0, 0, 100, 100], strokes: [stroke(), stroke({ ink: "x" })] });
    expect(r.strokeCount).toBe(2);
    expect(r.skippedStrokes).toBe(0);
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(r.svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(r.svg).toContain('d="M10 20 L30 40"');
    expect(r.svg).toContain('stroke="rgb(0,0,0)"');
    expect(r.svg).toContain('stroke-linecap="round"');
    expect(r.svg).toContain('data-ink="com.apple.ink.pen"');
  });

  it("converts 0..1 sRGB to bytes and keeps alpha as stroke-opacity", () => {
    const r = paperToSvg({ bounds: null, strokes: [stroke({ color: [1, 0.5, 0, 0.25] })] });
    expect(r.svg).toContain('stroke="rgb(255,128,0)"');
    expect(r.svg).toContain('stroke-opacity="0.25"');
  });

  it("clamps out-of-range channels and paints an unknown color black", () => {
    const clamped = paperToSvg({ bounds: null, strokes: [stroke({ color: [1.2, -0.1, 0.5, 2] })] });
    expect(clamped.svg).toContain('stroke="rgb(255,0,128)"');
    expect(clamped.svg).toContain('stroke-opacity="1"');
    const unknown = paperToSvg({ bounds: null, strokes: [stroke({ color: null })] });
    expect(unknown.svg).toContain('stroke="rgb(0,0,0)"');
  });

  it("moves points into drawing space and scales the width by the transform", () => {
    const r = paperToSvg({
      bounds: null,
      strokes: [
        stroke({
          transform: [2, 0, 0, 2, 5, -5],
          width: 3,
          points: [
            [1, 1, 3],
            [2, 2, 3],
          ],
        }),
      ],
    });
    expect(r.svg).toContain('d="M7 -3 L9 -1"');
    expect(r.svg).toContain('stroke-width="6"');
    expect(r.svg).not.toContain("transform=");
  });

  it("applies a shear or rotation through all six matrix terms", () => {
    // 90 degree rotation, then a shift: (x, y) -> (-y + 10, x).
    const r = paperToSvg({
      bounds: null,
      strokes: [
        stroke({
          transform: [0, 1, -1, 0, 10, 0],
          points: [
            [1, 2, 2],
            [3, 4, 2],
          ],
        }),
      ],
    });
    expect(r.svg).toContain('d="M8 1 L6 3"');
    expect(r.svg).toContain('stroke-width="2"');
  });

  it("draws a single point as a dot", () => {
    const r = paperToSvg({ bounds: null, strokes: [stroke({ points: [[5, 6, 4]], width: 4 })] });
    expect(r.svg).toContain('<circle cx="5" cy="6" r="2"');
  });

  it("skips strokes with no returned points and reports them", () => {
    const r = paperToSvg({
      bounds: [3, 4, 50, 60],
      strokes: [stroke({ points: undefined }), stroke({ points: [] })],
    });
    expect(r.strokeCount).toBe(0);
    expect(r.skippedStrokes).toBe(2);
    expect(r.svg).toContain('viewBox="3 4 50 60"');
    expect(r.svg).not.toContain("<path");
  });

  it("falls back to a unit viewBox with neither strokes nor bounds", () => {
    expect(paperToSvg({ bounds: null, strokes: [] }).svg).toContain('viewBox="0 0 1 1"');
  });

  it("produces a document analyze-svg reads back as the same strokes", () => {
    const { svg } = paperToSvg({
      bounds: null,
      strokes: [
        stroke({ color: [1, 0, 0, 1] }),
        stroke({
          points: [
            [50, 50, 2],
            [60, 70, 2],
            [80, 60, 2],
          ],
        }),
      ],
    });
    const { analysis, drawing } = analyzeSvgBuffer(Buffer.from(svg));
    expect(analysis.classification).toBe("safe");
    expect(drawing.strokes).toHaveLength(2);
    expect(drawing.strokes[0].color.map((c) => Math.round(c * 255))).toEqual([255, 0, 0, 255]);
    // The viewBox moves the origin, so compare the step between points.
    const [first, second] = drawing.strokes[0].points;
    expect([second[0] - first[0], second[1] - first[1]]).toEqual([20, 20]);
    expect(drawing.strokes[1].points).toHaveLength(3);
  });
});
