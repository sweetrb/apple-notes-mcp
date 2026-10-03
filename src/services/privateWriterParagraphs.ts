/**
 * Paragraph identifiers through the opt-in private WRITER.
 *
 * The read-only `list-note-paragraphs` and `get-paragraph-link`
 * (src/utils/noteParagraphs.ts, #218) list each paragraph's stored UUID as
 * `unique`, `shared` or `missing` and refuse to link the last two. This module
 * adds the one write they deliberately lack: `set_paragraph_id` gives one
 * paragraph (chosen by its `blockIndex` from list-note-paragraphs) a UUID of
 * its own, so its `applenotes://showNote?identifier=…&paragraphID=…` link
 * opens exactly there. The writer applies the same block and uniqueness
 * rules to the live body, and its read-back checks the result by them.
 *
 * @module services/privateWriterParagraphs
 */
import { z } from "zod";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";
import {
  PARAGRAPH_IDS_LIVE_VALIDATED,
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

const revision = z.string().regex(/^r1:[a-f0-9]{64}$/);
export const PARAGRAPH_URL =
  /^applenotes:\/\/showNote\?identifier=[0-9A-F-]{36}&paragraphID=[0-9A-F-]{36}$/;

const setBase = {
  identifier: z.string(),
  blockIndex: z.number().int(),
  styleType: z.number().int(),
  paragraphId: z.string().regex(UUID_PATTERN),
  url: z.string().regex(PARAGRAPH_URL),
  previousParagraphId: z.string().nullable(),
  previousParagraphIdStatus: z.enum(["unique", "shared", "missing"]),
  revisionBefore: revision,
  revisionAfter: revision,
};

export const setParagraphIdSchema = z.union([
  z
    .object({
      ...setBase,
      status: z.literal("unchanged"),
      changed: z.literal(false),
      committed: z.literal(false),
    })
    .passthrough(),
  z
    .object({
      ...setBase,
      status: z.literal("updated"),
      changed: z.literal(true),
      committed: z.literal(true),
      verified: z.literal(true),
      modificationDate: z.string().nullable(),
      ...writeSyncFields,
    })
    .passthrough(),
]);
export type SetParagraphIdResult = z.infer<typeof setParagraphIdSchema>;

export interface SetParagraphIdRequest {
  identifier: string;
  /** `blockIndex` of a paragraph from list-note-paragraphs. */
  blockIndex: number;
  /** That paragraph's `text` from list-note-paragraphs. */
  expectedText: string;
  /** `revision` from native-note-state. */
  ifRevision: string;
  /** Assign this UUID instead of minting one. It must not be in use in the note. */
  paragraphId?: string;
  /** Folder preconditions, checked by the writer just before the save. */
  scope?: ScopeGuard;
}

function invalid(message: string): never {
  throw new PrivateWriteError("invalid_request", message, false);
}

/**
 * Give one paragraph a unique identifier. Returns `unchanged` (nothing
 * written) when it already has one and no other was requested.
 */
export function setParagraphId(
  request: SetParagraphIdRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): SetParagraphIdResult {
  assertNoteIdentifier(request.identifier);
  if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0)
    invalid("blockIndex must be a non-negative integer from list-note-paragraphs");
  if (!request.expectedText.replace(/\ufffc/g, "").trim())
    invalid("expectedText must be the paragraph text from list-note-paragraphs");
  assertRevision(request.ifRevision);
  if (request.paragraphId !== undefined && !UUID_PATTERN.test(request.paragraphId))
    invalid("paragraphId must be a UUID");
  requireLiveValidated(PARAGRAPH_IDS_LIVE_VALIDATED, "native-set-paragraph-id", deps.env);
  const fields: Record<string, unknown> = {
    identifier: request.identifier,
    blockIndex: request.blockIndex,
    expectedText: request.expectedText,
    ifRevision: request.ifRevision,
  };
  if (request.paragraphId !== undefined) fields.paragraphId = request.paragraphId.toUpperCase();
  Object.assign(fields, writerScopeFields(request.scope));
  return parseWriterResult(
    setParagraphIdSchema,
    callPrivateWriter("set_paragraph_id", fields, deps),
    true
  );
}
