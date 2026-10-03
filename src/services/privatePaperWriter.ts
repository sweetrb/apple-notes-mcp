/**
 * Paper authoring through the opt-in private WRITER (#181).
 *
 * `add_paper` appends one drawing to the end of an exact note as a new
 * attachment: a Paper drawing (`com.apple.paper`) or a classic drawing
 * (`com.apple.drawing.2`). The drawing arrives already normalized by
 * utils/paperAuthoring.ts. The writer builds it as a public PencilKit
 * drawing, lets NotesShared create the attachment, saves with
 * NSErrorMergePolicy, and verifies by decoding the saved drawing through a
 * brand-new read-only Core Data stack.
 *
 * A dry run validates the drawing and the revision and reports the plan. It
 * opens the store read-only, so it never commits and does not need the
 * live-validation gate; it still needs both writer switches.
 *
 * @module services/privatePaperWriter
 */
import { z } from "zod";
import type { AuthorDrawing } from "../utils/paperAuthoring.js";
import {
  PAPER_WRITE_LIVE_VALIDATED,
  PrivateWriteError,
  assertNoteIdentifier,
  assertRevision,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  writeSyncFields,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

export const PAPER_FORMATS = ["auto", "paper", "drawing"] as const;
export type PaperFormat = (typeof PAPER_FORMATS)[number];

const rect = z.array(z.number()).length(4);

const addPaperPlanSchema = z
  .object({
    format: z.enum(["paper", "drawing"]),
    availableFormats: z.array(z.string()),
    strokeCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    inks: z.array(z.string()),
    bounds: rect,
    revisionBefore: z.string(),
    storeKind: z.enum(["live", "copy"]),
  })
  .passthrough();

export const addPaperPlannedSchema = addPaperPlanSchema.extend({
  status: z.literal("planned"),
  committed: z.literal(false),
});

export const addPaperCreatedSchema = addPaperPlanSchema.extend({
  status: z.literal("created"),
  committed: z.literal(true),
  verified: z.literal(true),
  identifier: z.string(),
  attachmentIdentifier: z.string(),
  typeUTI: z.string().nullable(),
  decodedStrokeCount: z.number().int().nonnegative(),
  decodedPointCount: z.number().int().nonnegative(),
  glyphInserted: z.boolean(),
  previewUpdated: z.boolean(),
  revisionAfter: z.string(),
  modificationDate: z.string().nullable(),
  ...writeSyncFields,
});

export type AddPaperPlan = z.infer<typeof addPaperPlannedSchema>;
export type AddPaperCreated = z.infer<typeof addPaperCreatedSchema>;
export type AddPaperResult = AddPaperPlan | AddPaperCreated;

export interface AddPaperRequest {
  identifier: string;
  ifRevision: string;
  drawing: AuthorDrawing;
  format?: PaperFormat;
  dryRun?: boolean;
  /** Folder preconditions, checked by the writer just before the save. */
  scope?: ScopeGuard;
}

/**
 * Add one drawing to the end of a note as a new Paper (or classic drawing)
 * attachment. Guarded by `ifRevision`, verified by a fresh read-back that
 * decodes the saved drawing. `dryRun` validates and plans without writing.
 */
export function addPaper(
  request: AddPaperRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): AddPaperResult {
  assertNoteIdentifier(request.identifier);
  assertRevision(request.ifRevision);
  const dryRun = request.dryRun === true;
  if (!dryRun) requireLiveValidated(PAPER_WRITE_LIVE_VALIDATED, "native-add-paper", deps.env);
  const fields: Record<string, unknown> = {
    identifier: request.identifier,
    ifRevision: request.ifRevision,
    drawing: request.drawing,
    format: request.format ?? "auto",
    ...writerScopeFields(request.scope),
  };
  if (dryRun) fields.dryRun = true;
  if (!dryRun)
    return parseWriterResult(
      addPaperCreatedSchema,
      callPrivateWriter("add_paper", fields, deps),
      true
    );
  // A dry run opens the store read-only, so no failure of it can have
  // committed anything, whatever the transport reports. Passing dryRun to
  // the transport also keeps a timeout from being described as a possible
  // save.
  try {
    return parseWriterResult(
      addPaperPlannedSchema,
      callPrivateWriter("add_paper", fields, deps, { dryRun: true }),
      false
    );
  } catch (error) {
    if (error instanceof PrivateWriteError && error.committed !== false)
      throw new PrivateWriteError(error.code, error.message, false, error.details);
    throw error;
  }
}

/** Points returned when the caller does not choose a budget. */
export const DEFAULT_PAPER_READ_POINTS = 20_000;
/** Hard ceiling on returned points, matching the writer's MAX_READ_PAPER_POINTS. */
export const MAX_PAPER_READ_POINTS = 40_000;
/** Order of the values in each compact point array. */
export const PAPER_POINT_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "force",
  "azimuth",
  "altitude",
  "timeOffset",
] as const;

const finite = z.number().finite();
const rgba = z.tuple([finite, finite, finite, finite]);
const rectOrNull = z.tuple([finite, finite, finite, finite]).nullable();
const layerStatus = {
  available: z.boolean(),
  reason: z.string().nullable(),
};

export const paperStrokeSchema = z
  .object({
    ink: z.string(),
    inkIdentifier: z.string(),
    /** sRGB red, green, blue, alpha, each 0..1; null when the ink color has no sRGB form. */
    color: rgba.nullable(),
    /** Mean point width. */
    width: finite,
    /** [a, b, c, d, tx, ty] from point space to drawing space. */
    transform: z.tuple([finite, finite, finite, finite, finite, finite]).nullable(),
    pointCount: z.number().int().nonnegative(),
    renderBounds: rectOrNull,
    masked: z.boolean(),
    points: z.array(z.array(finite).length(PAPER_POINT_FIELDS.length)).optional(),
    pointsOmitted: z.literal(true).optional(),
  })
  .passthrough();

export const paperShapeSchema = z
  .object({
    /** Position in PaperKit's element order (drawing order, back to front). */
    index: z.number().int().nonnegative(),
    kind: z.string(),
    /** [x, y, width, height] before rotation. */
    frame: rectOrNull,
    /** Bounds of everything the shape paints, stroke included. */
    renderFrame: rectOrNull,
    /** Radians about the frame's center. */
    rotation: finite.nullable(),
    lineWidth: finite.nullable(),
    opacity: finite.nullable(),
    fillColor: rgba.nullable(),
    strokeColor: rgba.nullable(),
    startLineMarker: z.string().nullable(),
    endLineMarker: z.string().nullable(),
    /** SVG path data in drawing coordinates, frame and rotation applied. */
    path: z.string().nullable(),
    pathBounds: rectOrNull,
    /** Text inside the shape (a text box is a rectangle with text). */
    text: z.string().nullable(),
  })
  .passthrough();

export const paperFallbackPathSchema = z
  .object({
    page: z.number().int().nonnegative(),
    paint: z.enum(["stroke", "fill", "fillStroke"]),
    kind: z.enum(["path", "rectangle"]),
    /** SVG path data in PDF page space (points, origin at the bottom left). */
    d: z.string(),
    bounds: rectOrNull,
    fillRule: z.enum(["nonzero", "evenodd"]).optional(),
    fillColor: z.array(finite.nullable()).length(4).optional(),
    strokeColor: z.array(finite.nullable()).length(4).optional(),
    lineWidth: finite.nullable().optional(),
  })
  .passthrough();

export const paperReadSchema = z
  .object({
    status: z.literal("ok"),
    storeKind: z.enum(["live", "copy"]),
    identifier: z.string(),
    revision: z.string(),
    attachmentIdentifier: z.string(),
    typeUTI: z.string(),
    drawingCount: z.number().int().nonnegative(),
    strokeCount: z.number().int().nonnegative(),
    returnedStrokeCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    bounds: rectOrNull,
    inks: z.array(z.string()),
    pointFields: z.array(z.string()),
    strokes: z.array(paperStrokeSchema),
    shapeDecode: z
      .object({
        ...layerStatus,
        missing: z.array(z.string()),
        elementCount: z.number().int().nonnegative().nullable(),
        elementKinds: z.record(z.string(), z.number().int().nonnegative()).nullable(),
      })
      .passthrough(),
    shapes: z.array(paperShapeSchema),
    fallbackGeometry: z
      .object({
        ...layerStatus,
        generation: z.string().optional(),
        pageCount: z.number().int().nonnegative().optional(),
        paths: z.array(paperFallbackPathSchema).optional(),
        skipped: z.record(z.string(), z.number().int().nonnegative()).optional(),
        truncated: z.boolean().optional(),
      })
      .passthrough(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  })
  .passthrough();
export type PaperRead = z.infer<typeof paperReadSchema>;

export interface PaperReadRequest {
  /** Notes UUID of the note that holds the drawing. */
  identifier: string;
  /** Attachment UUID; required when the note has more than one Paper drawing. */
  attachmentIdentifier?: string;
  /** Include per-point arrays (default true). */
  includePoints?: boolean;
  /** Point budget, 1..40000 (default 20000). */
  maxPoints?: number;
  /** Decode typed shapes through PaperKit (default true; macOS 27 or later). */
  includeShapes?: boolean;
}

/**
 * Decode one Paper drawing: strokes, typed shapes (macOS 27 or later), and
 * the painted geometry of Notes' fallback PDF when it keeps one. Read-only:
 * the writer opens the store read-only and decodes a private copy of the
 * drawing's bundle.
 */
export function readPaper(
  request: PaperReadRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): PaperRead {
  assertNoteIdentifier(request.identifier);
  const fields: Record<string, unknown> = { identifier: request.identifier };
  if (request.attachmentIdentifier !== undefined) {
    try {
      assertNoteIdentifier(request.attachmentIdentifier);
    } catch {
      throw new PrivateWriteError("invalid_request", "attachmentIdentifier must be a UUID", false);
    }
    fields.attachmentIdentifier = request.attachmentIdentifier;
  }
  if (
    request.maxPoints !== undefined &&
    (!Number.isInteger(request.maxPoints) ||
      request.maxPoints < 1 ||
      request.maxPoints > MAX_PAPER_READ_POINTS)
  )
    throw new PrivateWriteError(
      "invalid_request",
      `maxPoints must be an integer from 1 to ${MAX_PAPER_READ_POINTS}`,
      false
    );
  if (request.includePoints !== undefined) fields.includePoints = request.includePoints;
  if (request.maxPoints !== undefined) fields.maxPoints = request.maxPoints;
  if (request.includeShapes !== undefined) fields.includeShapes = request.includeShapes;
  return parseWriterResult(paperReadSchema, callPrivateWriter("read_paper", fields, deps), false);
}
