/**
 * Non-mutating SVG preflight: classify an SVG for conversion into editable
 * monoline strokes, list the visible losses that conversion needs, and bind
 * the result to a digest.
 *
 * The analyzer reads one regular UTF-8 file of at most 1 MiB. It supports
 * path, rect, circle, ellipse, line, polyline and polygon; g, a, nested svg,
 * local defs/symbol/use; transforms; viewBox and preserveAspectRatio; solid
 * fills and strokes, currentColor, opacity, fill rules and dashes. Active or
 * unsafe input (scripts, event handlers, style elements, animation, DOCTYPE
 * and entities, external resources) is refused outright and cannot be
 * accepted as a loss.
 *
 * Output is a normalized drawing in the root viewport's pixel space: a list
 * of strokes, each a color, a width and a polyline. Curves are flattened to
 * within 0.25 output pixels of the true curve, below what a stroke can show,
 * so flattening alone is not reported as a loss. Three loss modes describe
 * what the conversion cannot keep exactly:
 *
 * - `geometry-approximation`: non-round caps or joins, non-uniform stroke
 *   scaling, viewport clipping of centerlines;
 * - `paint-approximation`: fills scan-converted into strokes, group opacity
 *   applied per stroke, blend modes or paint order ignored;
 * - `drop-content`: visible content that cannot be represented (text, images,
 *   gradients and patterns, filters, masks, clip paths, markers, unknown
 *   elements) and is omitted.
 *
 * `analysisDigest` is a SHA-256 over the canonical JSON of the analysis and
 * the normalized drawing. Equal digests mean the same classification, losses
 * and output, so a caller can tell whether a file's analysis has changed.
 *
 * @module utils/svgAnalyzer
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseColor, parsePaint, type Paint, type Rgba } from "./svgColor.js";
import {
  IDENTITY,
  clipPolyline,
  dashPolyline,
  ellipseSubpath,
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
  type Rect,
  type Subpath,
} from "./svgGeometry.js";
import { SVG_NS, SvgError, XLINK_NS, parseXml, type XmlElement } from "./svgXml.js";

export { SvgError } from "./svgXml.js";

export const SVG_ANALYZER_VERSION = "apple-notes-mcp/svg-analyzer@1";

export const SVG_LIMITS = {
  maxSourceBytes: 1_048_576,
  maxSourceElements: 16_384,
  maxExpandedElements: 16_384,
  maxReferenceExpansions: 8_192,
  maxDepth: 64,
  maxReferenceDepth: 32,
  maxPathSegments: 100_000,
  maxGeometryWork: 100_000,
  maxDashWork: 100_000,
  maxScanWork: 5_000_000,
  maxStrokes: 4_096,
  maxPoints: 100_000,
  maxDrawingBytes: 8_388_608,
  maxCoordinate: 1_000_000,
  maxStrokeWidth: 8_192,
  maxIssues: 128,
  maxLocationLength: 240,
} as const;

/** Flattening tolerance in output pixels. */
const TOLERANCE = 0.25;
/** Fill brushes aim for this many scanlines across a shape's height. */
const FILL_SCANLINES = 80;
const MIN_FILL_BRUSH = 2;
const MAX_FILL_BRUSH = 16;

export const SVG_LOSSES = [
  "drop-content",
  "geometry-approximation",
  "paint-approximation",
] as const;
export type SvgLoss = (typeof SVG_LOSSES)[number];

export interface SvgIssue {
  code: string;
  loss: SvgLoss | null;
  location: string;
  message: string;
}

export interface DrawingStroke {
  ink: "monoline";
  /** sRGB red, green, blue, alpha, each 0..1. */
  color: Rgba;
  width: number;
  points: Point[];
}

export interface NormalizedDrawing {
  version: 1;
  width: number;
  height: number;
  strokes: DrawingStroke[];
}

export interface WorkCount {
  used: number;
  max: number;
}

export interface SvgAnalysis {
  analyzer: string;
  source: { sha256: string; bytes: number };
  classification: "safe" | "lossy" | "unsupported";
  importable: boolean;
  defaultWriteAllowed: boolean;
  requiredLosses: SvgLoss[];
  viewport: { width: number; height: number };
  counts: {
    sourceElements: number;
    expandedElements: number;
    referenceExpansions: number;
    pathSegments: number;
    strokes: number;
    points: number;
    geometryWork: WorkCount;
    dashWork: WorkCount;
    scanWork: WorkCount;
  };
  drawingBytes: number;
  issues: SvgIssue[];
  issuesTruncated: boolean;
  analysisDigest: string;
}

export interface SvgAnalysisResult {
  analysis: SvgAnalysis;
  drawing: NormalizedDrawing;
}

// ---------------------------------------------------------------------------
// Element and property tables

const UNSAFE_ELEMENTS = new Set([
  "script",
  "style",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "animate",
  "animateMotion",
  "animateTransform",
  "animateColor",
  "set",
  "discard",
  "handler",
  "listener",
]);

const NON_RENDERING = new Set([
  "title",
  "desc",
  "metadata",
  "defs",
  "symbol",
  "linearGradient",
  "radialGradient",
  "meshgradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "filter",
  "view",
  "cursor",
  "font",
  "font-face",
  "glyph",
  "missing-glyph",
  "hkern",
  "vkern",
  "color-profile",
]);

const GEOMETRY = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const TEXT = new Set(["text", "tspan", "textPath", "tref"]);

const STYLE_PROPERTIES = new Set([
  "fill",
  "stroke",
  "color",
  "stroke-width",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "visibility",
  "display",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "vector-effect",
  "overflow",
]);

/** Properties whose effect is dropped (drop-content) when set to anything but none. */
const DROPPED_MODIFIERS = new Set([
  "clip-path",
  "mask",
  "filter",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** Properties with no effect on geometry or solid paint of the supported elements. */
const IGNORED_PROPERTY =
  /^(?:font(?:-.*)?|text-.*|letter-spacing|word-spacing|line-height|writing-mode|direction|unicode-bidi|dominant-baseline|alignment-baseline|baseline-shift|shape-rendering|color-rendering|color-interpolation(?:-filters)?|image-rendering|stop-.*|flood-.*|lighting-color|enable-background|solid-.*|clip-rule|isolation|pointer-events|cursor|shape-inside|shape-padding|inline-size|white-space|transform-origin|transform-box|-inkscape-.*|-webkit-.*|-moz-.*)$/;

// ---------------------------------------------------------------------------
// Helpers

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

const round = (v: number, digits: number) => {
  const r = Number(v.toFixed(digits));
  return r === 0 ? 0 : r;
};

const UNITS: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** A length in px; `percentOf` resolves %. Null when missing or unsupported. */
export function parseLength(value: string | undefined, percentOf: number): number | null {
  if (value === undefined) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|%)?\s*$/i.exec(
    value
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const px = unit === "%" ? (n / 100) * percentOf : n * UNITS[unit];
  return Number.isFinite(px) ? px : null;
}

function parseOpacity(value: string): number | null {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]) / (m[2] ? 100 : 1);
  return Math.min(1, Math.max(0, n));
}

/** viewBox to viewport mapping per preserveAspectRatio. */
export function viewBoxMatrix(
  viewBox: [number, number, number, number],
  width: number,
  height: number,
  preserve: string | undefined
): Matrix {
  const [vx, vy, vw, vh] = viewBox;
  const parts = (preserve ?? "xMidYMid meet").trim().split(/\s+/);
  const align = parts[0] === "defer" ? (parts[1] ?? "xMidYMid") : parts[0];
  const slice = parts.includes("slice");
  let sx = width / vw;
  let sy = height / vh;
  if (align !== "none") {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
  }
  let tx = -vx * sx;
  let ty = -vy * sy;
  if (align !== "none") {
    const xAlign = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
    const yAlign = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
    tx += (width - vw * sx) * xAlign;
    ty += (height - vh * sy) * yAlign;
  }
  // `+ 0` turns -0 into 0 so the matrix is canonical.
  return [sx + 0, 0, 0, sy + 0, tx + 0, ty + 0];
}

function parseViewBox(value: string | undefined): [number, number, number, number] | null {
  if (value === undefined) return null;
  const nums = parseNumberList(value);
  if (!nums || nums.length !== 4 || nums[2] <= 0 || nums[3] <= 0) return null;
  return nums as [number, number, number, number];
}

function attr(el: XmlElement, local: string): string | undefined {
  return el.attributes.find((a) => a.local === local && a.ns === null)?.value;
}

function href(el: XmlElement): string | undefined {
  return (
    el.attributes.find((a) => a.local === "href" && (a.ns === null || a.ns === XLINK_NS))?.value ??
    undefined
  );
}

function parseStyleAttribute(value: string): [string, string][] {
  const out: [string, string][] = [];
  for (const decl of value.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim().toLowerCase();
    const val = decl
      .slice(colon + 1)
      .replace(/!important\s*$/i, "")
      .trim();
    if (name) out.push([name, val]);
  }
  return out;
}

function hasText(el: XmlElement): boolean {
  return el.text.trim().length > 0 || el.children.some(hasText);
}

// ---------------------------------------------------------------------------
// Safety pre-pass: runs over every element, rendered or not.

const ACTIVE_SCHEME = /^\s*(?:javascript|vbscript|data)\s*:/i;

function assertInert(el: XmlElement, location: string): void {
  if (UNSAFE_ELEMENTS.has(el.local))
    throw new SvgError(
      "svg_unsafe",
      `<${el.local}> is not allowed (scripts, styles, animation and embedded content are refused)`,
      location
    );
  for (const a of el.attributes) {
    if (/^on/i.test(a.local))
      throw new SvgError(
        "svg_unsafe",
        `Event handler attribute ${a.name} is not allowed`,
        location
      );
    const value = a.value;
    if (a.local === "href" && (a.ns === null || a.ns === XLINK_NS)) {
      const target = value.trim();
      if (el.local === "a") {
        if (ACTIVE_SCHEME.test(target))
          throw new SvgError("svg_unsafe", "Link uses an active URL scheme", location);
      } else if (el.local === "image" && /^data:image\/(?:png|jpeg|gif|webp);/i.test(target)) {
        // Embedded raster: not active, reported later as dropped content.
      } else if (!target.startsWith("#")) {
        throw new SvgError(
          "svg_unsafe",
          `External reference ${target.slice(0, 80)} is not allowed`,
          location
        );
      }
    }
    for (const m of value.matchAll(/url\(\s*['"]?([^'")]*)/gi))
      if (!m[1].trim().startsWith("#"))
        throw new SvgError("svg_unsafe", "url() references must be local (#id)", location);
    if (a.local === "style" && /@import|expression\s*\(|javascript\s*:/i.test(value))
      throw new SvgError("svg_unsafe", "Active content in a style attribute", location);
  }
  const counts = new Map<string, number>();
  for (const child of el.children) {
    const n = (counts.get(child.local) ?? 0) + 1;
    counts.set(child.local, n);
    assertInert(child, `${location}/${child.local}[${n}]`);
  }
}

// ---------------------------------------------------------------------------
// Analyzer

interface Style {
  fill: Paint;
  stroke: Paint;
  color: Rgba;
  fillOpacity: number;
  strokeOpacity: number;
  strokeWidth: number;
  linecap: string;
  linejoin: string;
  dasharray: number[] | null;
  dashoffset: number;
  evenOdd: boolean;
  visible: boolean;
}

interface Context {
  matrix: Matrix;
  style: Style;
  /** Accumulated group opacity. */
  opacity: number;
  clip: Rect | null;
  /** Viewport size for percentages. */
  viewport: [number, number];
  location: string;
  refDepth: number;
  depth: number;
  refStack: string[];
}

const INITIAL_STYLE: Style = {
  fill: { kind: "color", rgba: [0, 0, 0, 1] },
  stroke: { kind: "none" },
  color: [0, 0, 0, 1],
  fillOpacity: 1,
  strokeOpacity: 1,
  strokeWidth: 1,
  linecap: "butt",
  linejoin: "miter",
  dasharray: null,
  dashoffset: 0,
  evenOdd: false,
  visible: true,
};

class Analyzer {
  issues: SvgIssue[] = [];
  private issueKeys = new Set<string>();
  issuesTruncated = false;
  strokes: DrawingStroke[] = [];
  points = 0;
  layers = 0;
  sourceElements = 0;
  expandedElements = 0;
  referenceExpansions = 0;
  pathSegments = 0;
  geometryWork = 0;
  dashWork = 0;
  scanWork = 0;
  private ids = new Map<string, XmlElement[]>();

  constructor(private readonly root: XmlElement) {
    const index = (el: XmlElement) => {
      this.sourceElements++;
      const id = attr(el, "id");
      if (id !== undefined) this.ids.set(id, [...(this.ids.get(id) ?? []), el]);
      el.children.forEach(index);
    };
    index(root);
  }

  issue(code: string, loss: SvgLoss | null, location: string, message: string) {
    const loc =
      location.length > SVG_LIMITS.maxLocationLength
        ? "…" + location.slice(-(SVG_LIMITS.maxLocationLength - 1))
        : location;
    const key = `${code}\u0000${loc}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    if (this.issues.length >= SVG_LIMITS.maxIssues) {
      this.issuesTruncated = true;
      // Losses must never be hidden by truncation: keep the loss set complete.
      if (loss && !this.issues.some((i) => i.loss === loss))
        this.issues.push({ code, loss, location: loc, message });
      return;
    }
    this.issues.push({ code, loss, location: loc, message });
  }

  private charge(kind: "geometryWork" | "dashWork" | "scanWork", n: number) {
    const max =
      kind === "geometryWork"
        ? SVG_LIMITS.maxGeometryWork
        : kind === "dashWork"
          ? SVG_LIMITS.maxDashWork
          : SVG_LIMITS.maxScanWork;
    if (this[kind] + n > max)
      throw new SvgError("svg_complexity_limit", `The ${kind} budget of ${max} was exceeded`);
    this[kind] += n;
  }

  /** Apply presentation attributes, then the style attribute, onto an inherited style. */
  private resolveStyle(
    el: XmlElement,
    inherited: Style,
    ctx: Context
  ): { style: Style; opacity: number; display: boolean } {
    const style: Style = { ...inherited };
    let opacity = 1;
    let display = true;
    const declarations: [string, string][] = [];
    for (const a of el.attributes)
      if (
        a.ns === null &&
        (STYLE_PROPERTIES.has(a.local) ||
          DROPPED_MODIFIERS.has(a.local) ||
          a.local === "mix-blend-mode" ||
          a.local === "paint-order")
      )
        declarations.push([a.local, a.value.trim()]);
    const styleAttr = attr(el, "style");
    if (styleAttr) declarations.push(...parseStyleAttribute(styleAttr));
    const diag = Math.hypot(ctx.viewport[0], ctx.viewport[1]) / Math.SQRT2;
    for (const [name, value] of declarations) {
      if (value === "inherit") continue;
      const invalid = () =>
        this.issue(
          "invalid_value",
          null,
          ctx.location,
          `Ignored invalid ${name} value "${value.slice(0, 40)}"`
        );
      switch (name) {
        case "fill":
        case "stroke": {
          const paint = parsePaint(value);
          if (paint.kind === "invalid") invalid();
          else if (name === "fill") style.fill = paint;
          else style.stroke = paint;
          break;
        }
        case "color": {
          const c = parseColor(value);
          if (c) style.color = c;
          else invalid();
          break;
        }
        case "stroke-width": {
          const w = parseLength(value, diag);
          if (w === null || w < 0) invalid();
          else style.strokeWidth = w;
          break;
        }
        case "opacity":
        case "fill-opacity":
        case "stroke-opacity": {
          const o = parseOpacity(value);
          if (o === null) invalid();
          else if (name === "opacity") opacity = o;
          else if (name === "fill-opacity") style.fillOpacity = o;
          else style.strokeOpacity = o;
          break;
        }
        case "fill-rule":
          if (value === "evenodd" || value === "nonzero") style.evenOdd = value === "evenodd";
          else invalid();
          break;
        case "visibility":
          style.visible = value === "visible";
          break;
        case "display":
          if (value === "none") display = false;
          break;
        case "stroke-linecap":
          style.linecap = value;
          break;
        case "stroke-linejoin":
          style.linejoin = value;
          break;
        case "stroke-dasharray": {
          if (value === "none") {
            style.dasharray = null;
            break;
          }
          const list = parseNumberList(value);
          if (!list || list.some((v) => v < 0)) invalid();
          else
            style.dasharray =
              list.reduce((s, v) => s + v, 0) > 0
                ? list.length % 2
                  ? [...list, ...list]
                  : list
                : null;
          break;
        }
        case "stroke-dashoffset": {
          const o = parseLength(value, diag);
          if (o === null) invalid();
          else style.dashoffset = o;
          break;
        }
        case "stroke-miterlimit":
        case "vector-effect":
        case "overflow":
          break;
        case "mix-blend-mode":
          if (value !== "normal")
            this.issue(
              "blend_mode_ignored",
              "paint-approximation",
              ctx.location,
              `mix-blend-mode ${value.slice(0, 20)} is drawn as normal`
            );
          break;
        case "paint-order":
          if (value !== "normal" && !/^fill(\s+stroke)?(\s+markers)?$/.test(value))
            this.issue(
              "paint_order_ignored",
              "paint-approximation",
              ctx.location,
              "paint-order is drawn as fill then stroke"
            );
          break;
        default:
          if (DROPPED_MODIFIERS.has(name)) {
            if (value !== "none")
              this.issue(
                "modifier_dropped",
                "drop-content",
                ctx.location,
                `${name} is not supported and its effect is dropped`
              );
          } else if (!IGNORED_PROPERTY.test(name)) {
            this.issue(
              "ignored_property",
              null,
              ctx.location,
              `Ignored style property ${name.slice(0, 40)}`
            );
          }
      }
    }
    return { style, opacity, display };
  }

  private propertyValue(el: XmlElement, name: string): string | undefined {
    const styleAttr = attr(el, "style");
    const fromStyle = styleAttr
      ? parseStyleAttribute(styleAttr)
          .filter(([n]) => n === name)
          .pop()
      : undefined;
    return fromStyle ? fromStyle[1] : attr(el, name);
  }

  run(): { width: number; height: number } {
    const root = this.root;
    if (root.local !== "svg" || (root.ns !== null && root.ns !== SVG_NS))
      throw new SvgError("svg_invalid", "The root element is not <svg>");
    assertInert(root, "svg");
    const viewBox = parseViewBox(attr(root, "viewBox"));
    if (attr(root, "viewBox") !== undefined && !viewBox)
      this.issue("invalid_value", null, "svg", "Ignored an invalid viewBox");
    let width = parseLength(attr(root, "width"), viewBox ? viewBox[2] : 300);
    let height = parseLength(attr(root, "height"), viewBox ? viewBox[3] : 150);
    if (width === null || width <= 0) width = viewBox ? viewBox[2] : 300;
    if (height === null || height <= 0) height = viewBox ? viewBox[3] : 150;
    if (!viewBox && (attr(root, "width") === undefined || attr(root, "height") === undefined))
      this.issue(
        "viewport_assumed",
        null,
        "svg",
        `No viewBox or size; assumed a ${width}x${height} viewport`
      );
    if (width > SVG_LIMITS.maxCoordinate || height > SVG_LIMITS.maxCoordinate)
      throw new SvgError("svg_complexity_limit", "The viewport is too large");
    const matrix = viewBox
      ? viewBoxMatrix(viewBox, width, height, attr(root, "preserveAspectRatio"))
      : IDENTITY;
    const ctx: Context = {
      matrix,
      style: INITIAL_STYLE,
      opacity: 1,
      clip: { x0: 0, y0: 0, x1: width, y1: height },
      viewport: viewBox ? [viewBox[2], viewBox[3]] : [width, height],
      location: "svg",
      refDepth: 0,
      depth: 0,
      refStack: [],
    };
    const { style, opacity, display } = this.resolveStyle(root, INITIAL_STYLE, ctx);
    if (display) {
      const layersBefore = this.layers;
      this.container(root, { ...ctx, style, opacity });
      if (opacity < 1 && this.layers - layersBefore > 1)
        this.issue(
          "group_opacity",
          "paint-approximation",
          "svg",
          "Group opacity is applied to each stroke separately"
        );
    }
    return { width: round(width, 3), height: round(height, 3) };
  }

  private expand() {
    this.expandedElements++;
    if (this.expandedElements > SVG_LIMITS.maxExpandedElements)
      throw new SvgError(
        "svg_complexity_limit",
        `More than ${SVG_LIMITS.maxExpandedElements} elements after expanding references`
      );
  }

  /** Walk an element's children with its own style and transform applied. */
  private container(el: XmlElement, ctx: Context) {
    const counts = new Map<string, number>();
    for (const child of el.children) {
      const n = (counts.get(child.local) ?? 0) + 1;
      counts.set(child.local, n);
      const id = attr(child, "id");
      this.element(child, {
        ...ctx,
        depth: ctx.depth + 1,
        location: `${ctx.location}/${child.local}[${n}]${id ? `#${id}` : ""}`,
      });
    }
  }

  private element(el: XmlElement, parent: Context) {
    this.expand();
    if (parent.depth > SVG_LIMITS.maxDepth)
      throw new SvgError(
        "svg_complexity_limit",
        `Elements nest deeper than ${SVG_LIMITS.maxDepth}`
      );
    if (el.ns !== null && el.ns !== SVG_NS) return; // foreign namespace: not rendered
    const name = el.local;
    if (NON_RENDERING.has(name)) return;
    const { style, opacity, display } = this.resolveStyle(el, parent.style, parent);
    if (!display) return;
    let matrix = parent.matrix;
    const transform = attr(el, "transform");
    if (transform !== undefined) {
      const t = parseTransform(transform);
      if (!t) {
        this.issue(
          "invalid_transform",
          "drop-content",
          parent.location,
          "An element with an invalid transform is not drawn"
        );
        return;
      }
      matrix = multiply(matrix, t);
    }
    const ctx: Context = { ...parent, matrix, style, opacity: parent.opacity * opacity };
    const layersBefore = this.layers;

    if (name === "g" || name === "a") this.container(el, ctx);
    else if (name === "svg") this.nestedViewport(el, ctx, el, undefined);
    else if (name === "use") this.use(el, ctx);
    else if (GEOMETRY.has(name)) this.shape(el, ctx);
    else if (TEXT.has(name)) {
      if (hasText(el))
        this.issue(
          "text_dropped",
          "drop-content",
          ctx.location,
          "Text is not converted to strokes"
        );
    } else if (name === "image")
      this.issue(
        "image_dropped",
        "drop-content",
        ctx.location,
        "Embedded images are not converted to strokes"
      );
    else if (name === "switch")
      this.issue(
        "switch_dropped",
        "drop-content",
        ctx.location,
        "Conditional <switch> content is not evaluated"
      );
    else
      this.issue(
        "unsupported_element",
        "drop-content",
        ctx.location,
        `<${name.slice(0, 40)}> is not supported`
      );

    if (opacity < 1 && this.layers - layersBefore > 1)
      this.issue(
        "group_opacity",
        "paint-approximation",
        ctx.location,
        "Group opacity is applied to each stroke separately"
      );
  }

  /** A nested <svg> or a <use>d <symbol>: a new viewport with its own viewBox. */
  private nestedViewport(
    el: XmlElement,
    ctx: Context,
    sizeFrom: XmlElement,
    useEl: XmlElement | undefined
  ) {
    const [pw, ph] = ctx.viewport;
    const x = useEl ? 0 : (parseLength(attr(el, "x"), pw) ?? 0);
    const y = useEl ? 0 : (parseLength(attr(el, "y"), ph) ?? 0);
    const viewBox = parseViewBox(attr(el, "viewBox"));
    const w =
      parseLength(attr(sizeFrom, "width") ?? attr(el, "width"), pw) ??
      (useEl && viewBox ? viewBox[2] : pw);
    const h =
      parseLength(attr(sizeFrom, "height") ?? attr(el, "height"), ph) ??
      (useEl && viewBox ? viewBox[3] : ph);
    if (w <= 0 || h <= 0) return;
    let matrix = multiply(ctx.matrix, [1, 0, 0, 1, x, y]);
    let clip = ctx.clip;
    const overflow = this.propertyValue(el, "overflow");
    if (overflow !== "visible" && overflow !== "auto") {
      const [a, b, c, d, e, f] = matrix;
      if (b === 0 && c === 0) {
        const xs = [e, a * w + e].sort((p, q) => p - q);
        const ys = [f, d * h + f].sort((p, q) => p - q);
        const r: Rect = { x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] };
        clip = clip
          ? {
              x0: Math.max(clip.x0, r.x0),
              y0: Math.max(clip.y0, r.y0),
              x1: Math.min(clip.x1, r.x1),
              y1: Math.min(clip.y1, r.y1),
            }
          : r;
      } else {
        this.issue(
          "viewport_clip_skipped",
          "geometry-approximation",
          ctx.location,
          "A rotated or skewed nested viewport is not clipped"
        );
      }
    }
    if (viewBox)
      matrix = multiply(matrix, viewBoxMatrix(viewBox, w, h, attr(el, "preserveAspectRatio")));
    this.container(el, {
      ...ctx,
      matrix,
      clip,
      viewport: viewBox ? [viewBox[2], viewBox[3]] : [w, h],
    });
  }

  private use(el: XmlElement, ctx: Context) {
    const ref = href(el);
    if (!ref) return;
    const id = ref.trim().slice(1);
    const targets = this.ids.get(id) ?? [];
    if (targets.length === 0) {
      this.issue(
        "reference_missing",
        null,
        ctx.location,
        `#${id.slice(0, 60)} does not exist; nothing is drawn`
      );
      return;
    }
    if (targets.length > 1)
      throw new SvgError(
        "svg_reference_invalid",
        `More than one element has id ${id.slice(0, 60)}`,
        ctx.location
      );
    if (ctx.refStack.includes(id))
      throw new SvgError(
        "svg_reference_invalid",
        `Reference cycle through #${id.slice(0, 60)}`,
        ctx.location
      );
    if (ctx.refDepth + 1 > SVG_LIMITS.maxReferenceDepth)
      throw new SvgError(
        "svg_complexity_limit",
        `References nest deeper than ${SVG_LIMITS.maxReferenceDepth}`
      );
    this.referenceExpansions++;
    if (this.referenceExpansions > SVG_LIMITS.maxReferenceExpansions)
      throw new SvgError(
        "svg_complexity_limit",
        `More than ${SVG_LIMITS.maxReferenceExpansions} reference expansions`
      );
    const target = targets[0];
    const [pw, ph] = ctx.viewport;
    const x = parseLength(attr(el, "x"), pw) ?? 0;
    const y = parseLength(attr(el, "y"), ph) ?? 0;
    const inner: Context = {
      ...ctx,
      matrix: multiply(ctx.matrix, [1, 0, 0, 1, x, y]),
      location: `${ctx.location}>#${id}`,
      refDepth: ctx.refDepth + 1,
      refStack: [...ctx.refStack, id],
    };
    if (target.ns !== null && target.ns !== SVG_NS) return;
    if (target.local === "symbol" || target.local === "svg") {
      this.expand();
      const { style, opacity, display } = this.resolveStyle(target, inner.style, inner);
      if (!display) return;
      const layersBefore = this.layers;
      const symbolCtx = { ...inner, style, opacity: inner.opacity * opacity };
      this.nestedViewport(target, symbolCtx, el, el);
      if (opacity < 1 && this.layers - layersBefore > 1)
        this.issue(
          "group_opacity",
          "paint-approximation",
          inner.location,
          "Group opacity is applied to each stroke separately"
        );
    } else {
      this.element(target, inner);
    }
  }

  private subpathsFor(
    el: XmlElement,
    ctx: Context
  ): { subpaths: Subpath[]; fillable: boolean } | null {
    const [pw, ph] = ctx.viewport;
    const diag = Math.hypot(pw, ph) / Math.SQRT2;
    const len = (name: string, of: number) => parseLength(attr(el, name), of);
    const bad = (what: string) => {
      this.issue("invalid_geometry", null, ctx.location, `${what}; the element is not drawn`);
      return null;
    };
    switch (el.local) {
      case "path": {
        const d = attr(el, "d");
        if (d === undefined || !d.trim()) return null;
        const parsed = parsePathData(d);
        const segs = parsed.subpaths.reduce((s, p) => s + p.segments.length, 0);
        this.pathSegments += segs;
        if (this.pathSegments > SVG_LIMITS.maxPathSegments)
          throw new SvgError(
            "svg_complexity_limit",
            `More than ${SVG_LIMITS.maxPathSegments} path segments`
          );
        if (parsed.error)
          this.issue(
            "path_data_error",
            "drop-content",
            ctx.location,
            "Path data has an error; the part after it is dropped"
          );
        return { subpaths: parsed.subpaths, fillable: true };
      }
      case "rect": {
        const x = len("x", pw) ?? 0;
        const y = len("y", ph) ?? 0;
        const w = len("width", pw) ?? 0;
        const h = len("height", ph) ?? 0;
        if (w < 0 || h < 0) return bad("Negative rectangle size");
        if (w === 0 || h === 0) return null;
        let rx = len("rx", pw);
        let ry = len("ry", ph);
        if (rx !== null && rx < 0) rx = null;
        if (ry !== null && ry < 0) ry = null;
        rx = Math.min(rx ?? ry ?? 0, w / 2);
        ry = Math.min(ry ?? rx, h / 2);
        return {
          subpaths: [rectSubpath(x, y, w, h, rx, ry)],
          fillable: true,
        };
      }
      case "circle":
      case "ellipse": {
        const cx = len("cx", pw) ?? 0;
        const cy = len("cy", ph) ?? 0;
        let rx: number | null;
        let ry: number | null;
        if (el.local === "circle") rx = ry = len("r", diag) ?? 0;
        else {
          rx = len("rx", pw);
          ry = len("ry", ph);
          rx = rx ?? ry ?? 0;
          ry = ry ?? rx;
        }
        if (rx < 0 || ry < 0) return bad("Negative radius");
        if (rx === 0 || ry === 0) return null;
        return { subpaths: [ellipseSubpath(cx, cy, rx, ry)], fillable: true };
      }
      case "line": {
        const p0: Point = [len("x1", pw) ?? 0, len("y1", ph) ?? 0];
        const p1: Point = [len("x2", pw) ?? 0, len("y2", ph) ?? 0];
        return {
          subpaths: [{ start: p0, segments: [{ kind: "L", to: p1 }], closed: false }],
          fillable: false,
        };
      }
      default: {
        // polyline, polygon
        const nums = parseNumberList(attr(el, "points") ?? "");
        if (!nums) return bad("Malformed points list");
        const pts: Point[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        if (nums.length % 2)
          this.issue(
            "invalid_geometry",
            null,
            ctx.location,
            "Odd number of coordinates; the last one is ignored"
          );
        if (pts.length < 2) return null;
        return {
          subpaths: [
            {
              start: pts[0],
              segments: pts.slice(1).map((to) => ({ kind: "L" as const, to })),
              closed: el.local === "polygon",
            },
          ],
          fillable: true,
        };
      }
    }
  }

  private emit(points: Point[], color: Rgba, width: number, ctx: Context) {
    const rounded: Point[] = [];
    for (const p of points) {
      const q: Point = [round(p[0], 3), round(p[1], 3)];
      const last = rounded[rounded.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) rounded.push(q);
    }
    if (!rounded.length) return;
    if (width > SVG_LIMITS.maxStrokeWidth)
      throw new SvgError(
        "svg_complexity_limit",
        `A stroke is wider than ${SVG_LIMITS.maxStrokeWidth}`,
        ctx.location
      );
    this.strokes.push({
      ink: "monoline",
      color: [round(color[0], 4), round(color[1], 4), round(color[2], 4), round(color[3], 4)],
      width: round(width, 3),
      points: rounded,
    });
    this.points += rounded.length;
    if (this.strokes.length > SVG_LIMITS.maxStrokes)
      throw new SvgError(
        "svg_complexity_limit",
        `More than ${SVG_LIMITS.maxStrokes} output strokes`
      );
    if (this.points > SVG_LIMITS.maxPoints)
      throw new SvgError("svg_complexity_limit", `More than ${SVG_LIMITS.maxPoints} output points`);
  }

  private clipped(polyline: Point[], ctx: Context): Point[][] {
    if (!ctx.clip) return [polyline];
    const { parts, clipped } = clipPolyline(polyline, ctx.clip);
    if (clipped)
      this.issue(
        "viewport_clipped",
        "geometry-approximation",
        ctx.location,
        "Content outside the viewport is clipped"
      );
    return parts;
  }

  private paintColor(paint: Paint, style: Style): Rgba | "url" | null {
    if (paint.kind === "color") return paint.rgba;
    if (paint.kind === "current") return style.color;
    if (paint.kind === "url") return "url";
    return null;
  }

  private shape(el: XmlElement, ctx: Context) {
    const geometry = this.subpathsFor(el, ctx);
    if (!geometry || !ctx.style.visible) return;
    const { style } = ctx;
    const polylines = geometry.subpaths
      .filter((s) => s.segments.length > 0)
      .map((s) => {
        const pts = flattenSubpath(s, ctx.matrix, TOLERANCE);
        this.charge("geometryWork", pts.length);
        // Checked before clipping, so geometry far outside the viewport is refused too.
        if (
          pts.some(
            (p) =>
              !(
                Math.abs(p[0]) <= SVG_LIMITS.maxCoordinate &&
                Math.abs(p[1]) <= SVG_LIMITS.maxCoordinate
              )
          )
        )
          throw new SvgError(
            "svg_geometry_invalid",
            "Geometry is not finite or exceeds the coordinate limit",
            ctx.location
          );
        return pts;
      });
    if (!polylines.length) return;
    const fill = this.paintColor(style.fill, style);
    const stroke = style.strokeWidth > 0 ? this.paintColor(style.stroke, style) : null;
    if (fill === "url")
      this.issue(
        "paint_server_dropped",
        "drop-content",
        ctx.location,
        "Gradient or pattern fill is not supported and is dropped"
      );
    if (stroke === "url")
      this.issue(
        "paint_server_dropped",
        "drop-content",
        ctx.location,
        "Gradient or pattern stroke is not supported and is dropped"
      );

    if (fill && fill !== "url" && geometry.fillable) {
      const alpha = fill[3] * style.fillOpacity * ctx.opacity;
      const rings = polylines.filter((p) => p.length >= 3);
      if (alpha > 0 && rings.length) {
        const ys = rings.flat().map((p) => p[1]);
        const h = Math.max(...ys) - Math.min(...ys);
        const brush = Math.min(MAX_FILL_BRUSH, Math.max(MIN_FILL_BRUSH, h / FILL_SCANLINES));
        const chains = scanFill(rings, style.evenOdd, brush, brush * 0.8, (n) =>
          this.charge("scanWork", n)
        );
        if (chains.length) {
          this.issue(
            "fill_as_strokes",
            "paint-approximation",
            ctx.location,
            "Filled area is drawn with overlapping strokes"
          );
          this.layers++;
          for (const chain of chains)
            for (const part of this.clipped(chain, ctx))
              this.emit(part, [fill[0], fill[1], fill[2], alpha], brush, ctx);
        }
      }
    }

    if (stroke && stroke !== "url") {
      const alpha = stroke[3] * style.strokeOpacity * ctx.opacity;
      if (alpha > 0) {
        const nonScaling = this.propertyValue(el, "vector-effect") === "non-scaling-stroke";
        const [s1, s2] = scales(ctx.matrix);
        const mean = Math.sqrt(s1 * s2);
        if (!nonScaling && s2 > 0 && s1 / s2 > 1.001)
          this.issue(
            "nonuniform_stroke",
            "geometry-approximation",
            ctx.location,
            "Non-uniformly scaled stroke is drawn with one width"
          );
        const width = nonScaling ? style.strokeWidth : style.strokeWidth * mean;
        if (width > 0) {
          const openPath =
            geometry.subpaths.some((s) => s.segments.length > 0 && !s.closed) || style.dasharray;
          if (style.linecap !== "round" && openPath)
            this.issue(
              "cap_approximated",
              "geometry-approximation",
              ctx.location,
              `stroke-linecap ${style.linecap.slice(0, 20)} is drawn round`
            );
          if (style.linejoin !== "round" && polylines.some((p) => p.length > 2))
            this.issue(
              "join_approximated",
              "geometry-approximation",
              ctx.location,
              `stroke-linejoin ${style.linejoin.slice(0, 20)} is drawn round`
            );
          let pieces: Point[][] = polylines;
          if (style.dasharray) {
            const k = nonScaling ? 1 : mean;
            const pattern = style.dasharray.map((v) => v * k);
            pieces = polylines.flatMap((p) =>
              dashPolyline(p, pattern, style.dashoffset * k, (n) => this.charge("dashWork", n))
            );
          }
          this.layers++;
          for (const piece of pieces) {
            const zeroLength = piece.every((p) => p[0] === piece[0][0] && p[1] === piece[0][1]);
            if (zeroLength && style.linecap !== "round") continue;
            for (const part of this.clipped(zeroLength ? [piece[0]] : piece, ctx))
              this.emit(part, [stroke[0], stroke[1], stroke[2], alpha], width, ctx);
          }
        }
      }
    }
  }
}

function analysisFor(
  source: Buffer,
  analyzer: Analyzer,
  viewport: { width: number; height: number }
): SvgAnalysisResult {
  const drawing: NormalizedDrawing = {
    version: 1,
    width: viewport.width,
    height: viewport.height,
    strokes: analyzer.strokes,
  };
  const drawingJson = canonicalJson(drawing);
  if (drawingJson.length > SVG_LIMITS.maxDrawingBytes)
    throw new SvgError(
      "normalized_drawing_too_large",
      `The normalized drawing exceeds ${SVG_LIMITS.maxDrawingBytes} bytes`
    );
  const importable = drawing.strokes.length > 0;
  if (!importable)
    analyzer.issue("empty_drawing", null, "svg", "Nothing drawable remains after conversion");
  const requiredLosses = SVG_LOSSES.filter((loss) => analyzer.issues.some((i) => i.loss === loss));
  const classification: SvgAnalysis["classification"] =
    !importable || requiredLosses.includes("drop-content")
      ? "unsupported"
      : requiredLosses.length
        ? "lossy"
        : "safe";
  const analysis: Omit<SvgAnalysis, "analysisDigest"> = {
    analyzer: SVG_ANALYZER_VERSION,
    source: { sha256: sha256(source), bytes: source.length },
    classification,
    importable,
    defaultWriteAllowed: importable && classification === "safe",
    requiredLosses,
    viewport,
    counts: {
      sourceElements: analyzer.sourceElements,
      expandedElements: analyzer.expandedElements,
      referenceExpansions: analyzer.referenceExpansions,
      pathSegments: analyzer.pathSegments,
      strokes: drawing.strokes.length,
      points: analyzer.points,
      geometryWork: { used: analyzer.geometryWork, max: SVG_LIMITS.maxGeometryWork },
      dashWork: { used: analyzer.dashWork, max: SVG_LIMITS.maxDashWork },
      scanWork: { used: analyzer.scanWork, max: SVG_LIMITS.maxScanWork },
    },
    drawingBytes: drawingJson.length,
    issues: analyzer.issues,
    issuesTruncated: analyzer.issuesTruncated,
  };
  const analysisDigest = "sha256:" + sha256(canonicalJson({ analysis, drawing }));
  return { analysis: { ...analysis, analysisDigest }, drawing };
}

/** Recompute the digest of a result, e.g. to prove it was not altered. */
export function computeAnalysisDigest(result: SvgAnalysisResult): string {
  const { analysisDigest: _digest, ...analysis } = result.analysis;
  void _digest;
  return "sha256:" + sha256(canonicalJson({ analysis, drawing: result.drawing }));
}

/** Analyze SVG source bytes. Throws SvgError for refused or malformed input. */
export function analyzeSvgBuffer(source: Buffer): SvgAnalysisResult {
  if (source.length > SVG_LIMITS.maxSourceBytes)
    throw new SvgError(
      "svg_file_invalid",
      `The SVG is larger than ${SVG_LIMITS.maxSourceBytes} bytes`
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new SvgError("svg_file_invalid", "The SVG is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const root = parseXml(text, {
    maxElements: SVG_LIMITS.maxSourceElements,
    maxDepth: SVG_LIMITS.maxDepth,
  });
  const analyzer = new Analyzer(root);
  const viewport = analyzer.run();
  return analysisFor(source, analyzer, viewport);
}

/**
 * Read one SVG file: a regular file (not a symlink) of at most 1 MiB. The file
 * is opened without following links, and the opened descriptor is checked.
 */
export function readSvgSource(path: string): Buffer {
  // Open first and check the opened descriptor, so there is no window between
  // a check and the open. O_NOFOLLOW refuses a symbolic link (ELOOP), and
  // O_NONBLOCK keeps a FIFO from blocking the event loop; neither affects a
  // regular file.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new SvgError("svg_file_invalid", "The SVG path is a symbolic link");
    throw new SvgError("svg_file_invalid", "The SVG file does not exist or cannot be read");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new SvgError("svg_file_invalid", "The SVG path is not a regular file");
    if (info.size > SVG_LIMITS.maxSourceBytes)
      throw new SvgError(
        "svg_file_invalid",
        `The SVG is larger than ${SVG_LIMITS.maxSourceBytes} bytes`
      );
    const buffer = Buffer.alloc(SVG_LIMITS.maxSourceBytes + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > SVG_LIMITS.maxSourceBytes)
        throw new SvgError(
          "svg_file_invalid",
          `The SVG is larger than ${SVG_LIMITS.maxSourceBytes} bytes`
        );
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** Read and analyze one SVG file. Never writes anything. */
export function analyzeSvgFile(path: string): SvgAnalysisResult {
  return analyzeSvgBuffer(readSvgSource(path));
}
