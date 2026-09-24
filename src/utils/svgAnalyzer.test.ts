/**
 * SVG analyzer tests. Every fixture is a small synthetic SVG written here.
 */
import { describe, expect, it } from "vitest";
import {
  SVG_LIMITS,
  SvgError,
  analyzeSvgBuffer,
  computeAnalysisDigest,
  parseLength,
  viewBoxMatrix,
  type SvgAnalysisResult,
} from "./svgAnalyzer.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attrs = 'width="100" height="100"') =>
  `<svg ${NS} ${attrs}>${body}</svg>`;
const run = (source: string): SvgAnalysisResult => analyzeSvgBuffer(Buffer.from(source, "utf8"));
const codes = (r: SvgAnalysisResult) => r.analysis.issues.map((i) => i.code);

function refused(source: string | Buffer): SvgError {
  try {
    analyzeSvgBuffer(typeof source === "string" ? Buffer.from(source) : source);
  } catch (error) {
    if (error instanceof SvgError) return error;
    throw error;
  }
  throw new Error("expected an SvgError");
}

const ROUND = 'stroke-linecap="round" stroke-linejoin="round"';

describe("classification", () => {
  it("rates round-capped strokes as safe with a stable digest", () => {
    const source = svg(
      `<g fill="none" stroke="#123456" stroke-width="4" ${ROUND}>` +
        `<path d="M10 10 L90 10 L90 90"/><circle cx="50" cy="50" r="20"/></g>`
    );
    const a = run(source);
    expect(a.analysis.classification).toBe("safe");
    expect(a.analysis.importable).toBe(true);
    expect(a.analysis.defaultWriteAllowed).toBe(true);
    expect(a.analysis.requiredLosses).toEqual([]);
    expect(a.drawing.strokes).toHaveLength(2);
    expect(a.drawing.strokes[0]).toEqual({
      ink: "monoline",
      color: [0.0706, 0.2039, 0.3373, 1],
      width: 4,
      points: [
        [10, 10],
        [90, 10],
        [90, 90],
      ],
    });
    expect(a.analysis.analysisDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(run(source).analysis.analysisDigest).toBe(a.analysis.analysisDigest);
    expect(computeAnalysisDigest(a)).toBe(a.analysis.analysisDigest);
    expect(a.analysis.source.bytes).toBe(Buffer.byteLength(source));
    expect(a.analysis.counts.geometryWork.max).toBe(SVG_LIMITS.maxGeometryWork);
  });

  it("changes the digest when the output changes", () => {
    const a = run(svg(`<path d="M0 0 L10 10" stroke="red" ${ROUND}/>`));
    const b = run(svg(`<path d="M0 0 L10 11" stroke="red" ${ROUND}/>`));
    expect(a.analysis.analysisDigest).not.toBe(b.analysis.analysisDigest);
    const tampered = { ...a, drawing: { ...a.drawing, width: 5 } };
    expect(computeAnalysisDigest(tampered)).not.toBe(a.analysis.analysisDigest);
  });

  it("reports fills as paint approximation and default caps as geometry approximation", () => {
    const a = run(svg('<rect x="10" y="10" width="50" height="30" fill="blue" stroke="black"/>'));
    expect(a.analysis.classification).toBe("lossy");
    expect(a.analysis.requiredLosses).toEqual(["geometry-approximation", "paint-approximation"]);
    expect(codes(a)).toEqual(expect.arrayContaining(["fill_as_strokes", "join_approximated"]));
    expect(a.analysis.defaultWriteAllowed).toBe(false);
    const line = run(svg('<line x1="0" y1="0" x2="10" y2="0" stroke="black"/>'));
    expect(codes(line)).toContain("cap_approximated");
  });

  it("marks dropped content unsupported and an empty result not importable", () => {
    const text = run(
      svg(`<text x="1" y="1">Hello</text><path d="M0 0 L5 5" stroke="red" ${ROUND}/>`)
    );
    expect(text.analysis.classification).toBe("unsupported");
    expect(text.analysis.importable).toBe(true);
    expect(text.analysis.requiredLosses).toEqual(["drop-content"]);
    const empty = run(svg("<text> </text><g/>"));
    expect(empty.analysis.importable).toBe(false);
    expect(empty.analysis.classification).toBe("unsupported");
    expect(codes(empty)).toEqual(["empty_drawing"]);
  });
});

describe("safety refusals", () => {
  it.each([
    [svg("<script>alert(1)</script>"), "svg_unsafe"],
    [svg("<style>path{}</style>"), "svg_unsafe"],
    [svg('<animate attributeName="x"/>'), "svg_unsafe"],
    [svg("<foreignObject/>"), "svg_unsafe"],
    [svg('<rect onclick="x()" width="1" height="1"/>'), "svg_unsafe"],
    [svg('<use href="other.svg#a"/>'), "svg_unsafe"],
    [svg('<image href="https://example.com/a.png"/>'), "svg_unsafe"],
    [svg('<rect fill="url(https://example.com/p)" width="1" height="1"/>'), "svg_unsafe"],
    [svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'), "svg_unsafe"],
    [svg('<rect style="fill:red;@import url(#x)" width="1" height="1"/>'), "svg_unsafe"],
    // CSS escapes spell url( and @import; a tab or newline splits a scheme name.
    [svg('<rect style="fill:u\\72 l(https://example.com/p)" width="1" height="1"/>'), "svg_unsafe"],
    [svg('<rect fill="\\75rl(https://example.com/p)" width="1" height="1"/>'), "svg_unsafe"],
    [svg('<rect style="fill:red;\\@import \'x\'" width="1" height="1"/>'), "svg_unsafe"],
    [svg('<a href="java&#9;script:alert(1)"><rect width="1" height="1"/></a>'), "svg_unsafe"],
    [svg('<a href="&#10;java&#13;script:alert(1)"><rect width="1" height="1"/></a>'), "svg_unsafe"],
    [svg('<rect fill="url(&#9;https://example.com/p)" width="1" height="1"/>'), "svg_unsafe"],
    ['<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>', "svg_unsafe"],
    [svg("&ent;"), "svg_unsafe"],
    ['<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', "svg_invalid"],
    ['<html xmlns="http://www.w3.org/1999/xhtml"/>', "svg_invalid"],
    ['<svg xmlns="urn:other"/>', "svg_invalid"],
  ])("refuses %s", (source, code) => {
    expect(refused(source).code).toBe(code);
  });

  it("checks elements that are never rendered too", () => {
    expect(refused(svg('<defs><g onload="x()"/></defs>')).location).toBe("svg/defs[1]/g[1]");
  });

  it("refuses non-UTF-8 and oversized input", () => {
    expect(refused(Buffer.from([0x3c, 0xff, 0xfe])).code).toBe("svg_file_invalid");
    expect(refused(Buffer.alloc(SVG_LIMITS.maxSourceBytes + 1, 0x20)).code).toBe(
      "svg_file_invalid"
    );
  });

  it("accepts a byte order mark and an embedded raster as dropped content", () => {
    const r = run(
      "\uFEFF" + svg('<image href="data:image/png;base64,AAAA" width="5" height="5"/>')
    );
    expect(codes(r)).toContain("image_dropped");
  });
});

describe("references", () => {
  it("prefers a plain href over xlink:href, as SVG 2 does", () => {
    const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
    const r = run(
      svg(
        `<defs><path id="a" d="M0 0 L5 5" stroke="red" ${ROUND}/><path id="b" d="M0 0 L5 6" stroke="red" ${ROUND}/></defs>` +
          `<use xlink:href="#a" href="#b"/>`,
        `width="100" height="100" ${XL}`
      )
    );
    expect(r.drawing.strokes).toHaveLength(1);
    expect(r.drawing.strokes[0].points[1]).toEqual([5, 6]);
  });

  it("expands use of symbols with viewBox and of plain elements", () => {
    const r = run(
      svg(
        `<defs><symbol id="s" viewBox="0 0 10 10"><path d="M0 0 L10 10" stroke="red" ${ROUND}/></symbol>` +
          `<path id="p" d="M0 0 L1 0" stroke="blue" ${ROUND}/></defs>` +
          `<use href="#s" x="10" y="10" width="20" height="20"/>` +
          `<use xlink:href="#p" xmlns:xlink="http://www.w3.org/1999/xlink" transform="scale(2)"/>` +
          `<use href="#missing"/><use/>`
      )
    );
    expect(r.drawing.strokes[0].points).toEqual([
      [10, 10],
      [30, 30],
    ]);
    expect(r.drawing.strokes[0].width).toBe(2);
    expect(r.drawing.strokes[1].points).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(codes(r)).toContain("reference_missing");
    expect(r.analysis.counts.referenceExpansions).toBe(2);
  });

  it("refuses cycles and duplicate referenced ids", () => {
    expect(refused(svg('<g id="a"><use href="#a"/></g>')).code).toBe("svg_reference_invalid");
    expect(refused(svg('<g id="d"/><g id="d"/><use href="#d"/>')).code).toBe(
      "svg_reference_invalid"
    );
  });

  it("limits reference depth", () => {
    let body = `<g id="r0"><path d="M0 0 L1 1" stroke="red" ${ROUND}/></g>`;
    for (let i = 1; i <= SVG_LIMITS.maxReferenceDepth + 1; i++)
      body += `<g id="r${i}"><use href="#r${i - 1}"/></g>`;
    expect(
      refused(svg(`<defs>${body}</defs><use href="#r${SVG_LIMITS.maxReferenceDepth + 1}"/>`)).code
    ).toBe("svg_complexity_limit");
  });

  it("applies symbol opacity and display from the referenced element", () => {
    const r = run(
      svg(
        `<symbol id="s" opacity="0.5"><path d="M0 0 L5 5" stroke="red" ${ROUND}/><path d="M0 5 L5 0" stroke="red" ${ROUND}/></symbol>` +
          `<symbol id="h" display="none"><path d="M0 0 L5 5" stroke="red"/></symbol>` +
          `<symbol id="f" xmlns="urn:x"/><use href="#s"/><use href="#h"/><use href="#f"/>`
      )
    );
    expect(r.drawing.strokes).toHaveLength(2);
    expect(r.drawing.strokes[0].color[3]).toBe(0.5);
    expect(codes(r)).toContain("group_opacity");
  });
});

describe("viewports", () => {
  it("maps viewBox with preserveAspectRatio variants", () => {
    expect(viewBoxMatrix([0, 0, 10, 20], 100, 100, undefined)).toEqual([5, 0, 0, 5, 25, 0]);
    expect(viewBoxMatrix([0, 0, 10, 20], 100, 100, "xMinYMin slice")).toEqual([10, 0, 0, 10, 0, 0]);
    expect(viewBoxMatrix([0, 0, 10, 20], 100, 100, "xMaxYMax meet")).toEqual([5, 0, 0, 5, 50, 0]);
    expect(viewBoxMatrix([5, 5, 10, 20], 100, 100, "none")).toEqual([10, 0, 0, 5, -50, -25]);
    expect(viewBoxMatrix([0, 0, 10, 10], 100, 50, "defer xMidYMax")).toEqual([5, 0, 0, 5, 25, 0]);
    expect(viewBoxMatrix([0, 0, 10, 10], 100, 50, "defer")).toEqual([5, 0, 0, 5, 25, 0]);
  });

  it("resolves lengths and units", () => {
    expect(parseLength("10", 0)).toBe(10);
    expect(parseLength("1in", 0)).toBe(96);
    expect(parseLength("50%", 200)).toBe(100);
    expect(parseLength("2em", 0)).toBeNull();
    expect(parseLength(undefined, 0)).toBeNull();
    expect(parseLength("1e999", 0)).toBeNull();
  });

  it("uses the viewBox size when width and height are missing or unusable", () => {
    const r = run(
      `<svg ${NS} viewBox="0 0 40 30" width="-1"><path d="M0 0 L40 30" stroke="red" ${ROUND}/></svg>`
    );
    expect(r.analysis.viewport).toEqual({ width: 40, height: 30 });
    const bare = run(`<svg ${NS}><path d="M0 0 L1 1" stroke="red" ${ROUND}/></svg>`);
    expect(bare.analysis.viewport).toEqual({ width: 300, height: 150 });
    expect(codes(bare)).toContain("viewport_assumed");
    const badBox = run(`<svg ${NS} viewBox="0 0 0 0" width="10" height="10"/>`);
    expect(codes(badBox)).toContain("invalid_value");
    expect(refused(`<svg ${NS} width="2000000" height="1"/>`).code).toBe("svg_complexity_limit");
  });

  it("clips content at the viewport and at nested viewports", () => {
    const r = run(
      svg(
        `<path d="M50 50 L150 50" stroke="red" ${ROUND}/>` +
          `<svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10"><path d="M0 5 L20 5" stroke="red" ${ROUND}/></svg>` +
          `<svg x="0" y="0" width="5" height="5" overflow="visible"><path d="M0 1 L50 1" stroke="red" ${ROUND}/></svg>` +
          `<g transform="rotate(10)"><svg width="5" height="5"><path d="M0 1 L1 1" stroke="red" ${ROUND}/></svg></g>` +
          `<svg width="0" height="5"><path d="M0 1 L1 1" stroke="red"/></svg>`
      )
    );
    expect(r.drawing.strokes[0].points).toEqual([
      [50, 50],
      [100, 50],
    ]);
    expect(r.drawing.strokes[1].points).toEqual([
      [10, 20],
      [30, 20],
    ]);
    expect(r.drawing.strokes[2].points).toEqual([
      [0, 1],
      [50, 1],
    ]);
    expect(codes(r)).toEqual(expect.arrayContaining(["viewport_clipped", "viewport_clip_skipped"]));
    expect(r.analysis.requiredLosses).toEqual(["geometry-approximation"]);
  });
});

describe("styles", () => {
  it("inherits presentation attributes and lets style declarations win", () => {
    const r = run(
      svg(
        `<g stroke="red" stroke-width="3" ${ROUND} style="stroke: rgb(0,0,255) !important">` +
          `<path d="M0 0 L10 0"/><path d="M0 5 L10 5" style="stroke:inherit;stroke-width:50%"/></g>`,
        'width="100" height="100" style="fill:none"'
      )
    );
    expect(r.drawing.strokes[0].color).toEqual([0, 0, 1, 1]);
    expect(r.drawing.strokes[0].width).toBe(3);
    expect(r.drawing.strokes[1].width).toBe(50);
  });

  it("resolves currentColor and opacity", () => {
    const r = run(
      svg(
        `<g color="#00ff00" fill="none"><path d="M0 0 L10 0" stroke="currentColor" stroke-opacity="50%" opacity=".5" ${ROUND}/></g>`
      )
    );
    expect(r.drawing.strokes[0].color).toEqual([0, 1, 0, 0.25]);
  });

  it("skips hidden and display:none content and zero-alpha paint", () => {
    const r = run(
      svg(
        `<g display="none"><path d="M0 0 L5 5" stroke="red"/></g>` +
          `<g visibility="hidden"><path d="M0 0 L5 5" stroke="red"/><path d="M0 0 L5 6" stroke="red" visibility="visible" ${ROUND}/></g>` +
          `<path d="M0 0 L5 5" stroke="red" stroke-opacity="0" fill="none"/>` +
          `<path d="M0 0 L5 5" stroke="red" stroke-width="0"/>` +
          `<rect width="5" height="5" fill="red" fill-opacity="0"/>`
      )
    );
    expect(r.drawing.strokes).toHaveLength(1);
    expect(r.drawing.strokes[0].points[1]).toEqual([5, 6]);
  });

  it("lets a later display declaration re-show content hidden by an earlier one", () => {
    const r = run(
      svg(
        `<g display="none" style="display:inline"><path d="M0 0 L5 5" stroke="red" ${ROUND}/></g>` +
          `<g display="inline" style="display:none"><path d="M0 0 L5 6" stroke="red" ${ROUND}/></g>`
      )
    );
    expect(r.drawing.strokes).toHaveLength(1);
    expect(r.drawing.strokes[0].points[1]).toEqual([5, 5]);
  });

  it("matches CSS keywords case-insensitively", () => {
    const r = run(
      svg(
        `<g display="NONE"><path d="M0 0 L5 5" stroke="red"/></g>` +
          `<g visibility="Hidden"><path d="M0 0 L5 5" stroke="red"/></g>` +
          `<path d="M0 0 L5 6" stroke="red" stroke-linecap="Round" stroke-linejoin="ROUND" fill="none" stroke-dasharray="None"/>`
      )
    );
    expect(r.drawing.strokes).toHaveLength(1);
    expect(codes(r)).not.toContain("cap_approximated");
    expect(codes(r)).not.toContain("invalid_value");
    const rule = run(svg('<path d="M0 0 L10 0 L10 10 Z" fill="red" fill-rule="EvenOdd"/>'));
    expect(codes(rule)).not.toContain("invalid_value");
  });

  it("reports ignored, invalid and unsupported properties", () => {
    const r = run(
      svg(
        `<path d="M0 0 L5 5" ${ROUND} stroke="red" fill="bogus" color="nope" stroke-width="-1" opacity="x" fill-rule="odd" stroke-dasharray="1,-1" stroke-dashoffset="x" ` +
          `style="font-size:12px;weird-prop:1;mix-blend-mode:multiply;paint-order:stroke;filter:url(#f);clip-path:none;stroke-miterlimit:4;vector-effect:none;overflow:hidden;stroke-dasharray:none"/>`
      )
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "invalid_value",
        "ignored_property",
        "blend_mode_ignored",
        "paint_order_ignored",
        "modifier_dropped",
      ])
    );
    expect(codes(r)).not.toContain("font-size");
    expect(r.analysis.requiredLosses).toEqual(["drop-content", "paint-approximation"]);
  });

  it("drops gradient paint and invalid transforms", () => {
    const r = run(
      svg(
        `<linearGradient id="g"/><rect width="5" height="5" fill="url(#g)" stroke="url(#g)"/>` +
          `<path d="M0 0 L1 1" stroke="red" transform="spin(3)"/>`
      )
    );
    expect(codes(r)).toEqual(expect.arrayContaining(["paint_server_dropped", "invalid_transform"]));
  });

  it("applies non-scaling strokes and flags non-uniform scaling", () => {
    const r = run(
      svg(
        `<g transform="scale(4 2)" stroke="red" ${ROUND}><path d="M0 0 L5 0" vector-effect="non-scaling-stroke"/><path d="M0 1 L5 1"/></g>`
      )
    );
    expect(r.drawing.strokes[0].width).toBe(1);
    expect(r.drawing.strokes[1].width).toBeCloseTo(Math.sqrt(8), 3);
    expect(codes(r)).toEqual(["nonuniform_stroke"]);
  });

  it("warns once per group when group opacity spans several strokes", () => {
    const r = run(
      svg(
        `<g opacity="0.5" stroke="red" ${ROUND}><path d="M0 0 L5 0"/><path d="M0 2 L5 2"/></g>`,
        'width="10" height="10" opacity="0.9"'
      )
    );
    expect(codes(r).filter((c) => c === "group_opacity")).toHaveLength(2);
    expect(r.drawing.strokes[0].color[3]).toBe(0.45);
  });

  it("skips the whole document when the root has display:none", () => {
    expect(
      run(svg(`<path d="M0 0 L5 5" stroke="red"/>`, 'width="9" height="9" display="none"')).analysis
        .importable
    ).toBe(false);
  });
});

describe("geometry", () => {
  it("draws every basic shape", () => {
    const r = run(
      svg(
        `<g stroke="black" fill="none" ${ROUND}>` +
          `<rect x="1" y="1" width="10" height="10"/><rect x="20" y="1" width="10" height="10" rx="2"/>` +
          `<rect x="40" y="1" width="10" height="10" ry="3" rx="-1"/><rect width="0" height="5"/>` +
          `<ellipse cx="50" cy="50" rx="10"/><ellipse cx="50" cy="50" ry="5"/><circle r="0"/>` +
          `<line x2="5"/><polyline points="0,0 5,5 10,0"/><polygon points="0 0 5 5 10 0"/>` +
          `<polyline points="1"/><path d=" "/><path/></g>`
      )
    );
    // Zero-size rect and zero-radius circle draw nothing.
    expect(r.drawing.strokes).toHaveLength(8);
    expect(r.analysis.classification).toBe("safe");
  });

  it("reports invalid shapes and path errors", () => {
    const r = run(
      svg(
        `<g stroke="black" ${ROUND}><rect width="-1" height="5"/><circle r="-2"/>` +
          `<polyline points="0 0 x"/><polyline points="0 0 5 5 9"/><path d="M0 0 L5 5 L"/></g>`
      )
    );
    expect(codes(r)).toEqual(expect.arrayContaining(["invalid_geometry", "path_data_error"]));
    expect(r.analysis.requiredLosses).toContain("drop-content");
  });

  it("dashes strokes in output units and drops zero-length butt dashes", () => {
    const r = run(
      svg(
        `<path d="M0 0 L10 0" stroke="red" stroke-dasharray="2" ${ROUND} transform="scale(2)"/>` +
          `<path d="M0 5 L4 5" stroke="red" stroke-dasharray="0 2" stroke-linecap="butt"/>` +
          `<path d="M0 9 L0 9" stroke="red" stroke-linecap="round"/>`
      )
    );
    const dashes = r.drawing.strokes.filter((s) => s.points[0][1] === 0);
    expect(dashes[0].points).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(r.analysis.counts.dashWork.used).toBeGreaterThan(0);
    expect(r.drawing.strokes.some((s) => s.points.length === 1 && s.points[0][1] === 9)).toBe(true);
    expect(r.drawing.strokes.some((s) => s.points[0][1] === 5)).toBe(false);
  });

  it("scan-fills with even-odd and nonzero rules", () => {
    const d = "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z";
    const evenOdd = run(svg(`<path d="${d}" fill="red" fill-rule="evenodd"/>`));
    const nonZero = run(svg(`<path d="${d}" fill="red"/>`));
    expect(evenOdd.analysis.counts.scanWork.used).toBeGreaterThan(0);
    // A horizontal run at hole height that spans the hole's center.
    const inHole = (res: SvgAnalysisResult) =>
      res.drawing.strokes.some((s) =>
        s.points.some(
          (p, i) =>
            i > 0 &&
            p[1] === s.points[i - 1][1] &&
            p[1] > 12 &&
            p[1] < 28 &&
            Math.min(p[0], s.points[i - 1][0]) < 20 &&
            Math.max(p[0], s.points[i - 1][0]) > 20
        )
      );
    expect(inHole(evenOdd)).toBe(false);
    expect(inHole(nonZero)).toBe(true);
    // A line has no area; a flat polygon produces nothing to fill.
    expect(run(svg('<line x2="10" fill="red"/>')).analysis.importable).toBe(false);
    expect(run(svg('<polygon points="0 0 10 0 20 0" fill="red"/>')).analysis.importable).toBe(
      false
    );
  });

  it("refuses non-finite or far-out coordinates", () => {
    expect(refused(svg('<path d="M0 0 L1e308 0" stroke="red" transform="scale(10)"/>')).code).toBe(
      "svg_geometry_invalid"
    );
    const far = refused(
      `<svg ${NS} width="100" height="100"><svg overflow="visible"><path d="M0 0 L2000000 0" stroke="red"/></svg></svg>`
    );
    expect(far.code).toBe("svg_geometry_invalid");
  });
});

describe("limits and elements", () => {
  it("drops unknown, text, switch and foreign-namespace content correctly", () => {
    const r = run(
      svg(
        `<blink/><switch><rect width="1" height="1"/></switch><text><tspan>x</tspan></text>` +
          `<ink:thing xmlns:ink="urn:ink"/><title>t</title><desc/><metadata/>`
      )
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(["unsupported_element", "switch_dropped", "text_dropped"])
    );
  });

  it("caps the issue list without hiding a loss", () => {
    let body = "";
    for (let i = 0; i < SVG_LIMITS.maxIssues + 5; i++)
      body += `<path d="M0 0 L1 1" stroke="red" bogus-${i}="1" style="x-${i}:1"/>`;
    body += "<text>late</text>";
    const r = run(svg(body));
    expect(r.analysis.issuesTruncated).toBe(true);
    expect(r.analysis.requiredLosses).toContain("drop-content");
    expect(r.analysis.issues.length).toBeLessThanOrEqual(SVG_LIMITS.maxIssues + 3);
  });

  it("shortens very long issue locations", () => {
    let open = "";
    let close = "";
    for (let i = 0; i < 40; i++) {
      open += `<g id="group-with-a-long-identifier-${i}">`;
      close += "</g>";
    }
    const r = run(svg(`${open}<text>x</text>${close}`));
    const loc = r.analysis.issues[0].location;
    expect(loc.length).toBe(SVG_LIMITS.maxLocationLength);
    expect(loc.startsWith("…")).toBe(true);
  });

  it("enforces path, stroke, point and width budgets", () => {
    const manySegments = "M0 0" + " L1 1".repeat(SVG_LIMITS.maxPathSegments + 1);
    expect(refused(svg(`<path d="${manySegments}"/>`)).code).toBe("svg_complexity_limit");
    const manyStrokes = `<path d="M0 0 L1 1" stroke="red" ${ROUND}/>`.repeat(
      SVG_LIMITS.maxStrokes + 1
    );
    expect(refused(svg(manyStrokes)).code).toBe("svg_complexity_limit");
    expect(refused(svg('<path d="M0 0 L1 1" stroke="red" stroke-width="9000"/>')).code).toBe(
      "svg_complexity_limit"
    );
    const pts = Array.from({ length: 30_000 }, (_, i) => `${i % 100} ${(i * 7) % 100}`).join(" ");
    expect(
      refused(
        svg(
          `<polyline points="${pts}" stroke="red"/><polyline points="${pts}" stroke="red"/><polyline points="${pts}" stroke="red"/><polyline points="${pts}" stroke="red"/>`
        )
      ).code
    ).toBe("svg_complexity_limit");
    expect(
      refused(svg('<path d="M0 0 L100 0" stroke="red" stroke-dasharray="0.0001"/>')).code
    ).toBe("svg_complexity_limit");
    const zigzag =
      "M0 0 " +
      Array.from({ length: 1000 }, (_, i) => `L${i + 1} ${i % 2 ? 1000 : 990}`).join(" ") +
      " L1000 0 Z";
    expect(refused(svg(`<path d="${zigzag}" fill="red"/>`.repeat(60))).code).toBe(
      "svg_complexity_limit"
    );
    // Each case builds input just past a budget; slow under coverage instrumentation.
  }, 30_000);

  it("stops flattening a hostile path at the geometry budget, not after it", () => {
    // Each cubic flattens to hundreds of points at this scale; charging only
    // after a whole subpath was flattened let a 1 MiB file exhaust the heap.
    const d = "M0 0" + " c1 1 -1 1 0 0".repeat(20_000);
    const started = Date.now();
    const error = refused(svg(`<path d="${d}" transform="scale(100000)" stroke="red"/>`));
    expect(error.code).toBe("svg_complexity_limit");
    expect(error.message).toMatch(/geometryWork/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("refuses out-of-range control points before flattening them", () => {
    const d = "M0 0" + " c1 1 -1 1 0 0".repeat(20_000);
    const error = refused(svg(`<path d="${d}" transform="scale(1e9)" stroke="red"/>`));
    expect(error.code).toBe("svg_geometry_invalid");
  });

  it("limits traversal depth through nested references", () => {
    let chain = "";
    for (let i = 0; i < 20; i++) chain = `<g>${chain}</g>`;
    let defs = `<g id="d0">${chain}</g>`;
    for (let i = 1; i < 5; i++)
      defs += `<g id="d${i}">${chain.replace("<g></g>", `<g><use href="#d${i - 1}"/></g>`)}</g>`;
    expect(refused(svg(`<defs>${defs}</defs><use href="#d4"/>`)).code).toBe("svg_complexity_limit");
  });
});
