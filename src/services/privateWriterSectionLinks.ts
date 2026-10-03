/**
 * Native section-link chips (macOS 27) through the opt-in private WRITER.
 *
 * A section link is the chip Notes pastes for "Copy Link to Section": an
 * inline attachment of type `com.apple.notes.inlinetextattachment.link` whose
 * token is an `applenotes://showNote?identifier=<note>&paragraphID=<uuid>`
 * link. The read tools report these chips (list-note-links and get-note-structure
 * report them as kind `section`) but cannot create one. The writer's
 * `add_section_link` action has NotesShared build the attachment, inserts its
 * glyph, and, when the target paragraph's identifier is not unique by
 * the read tools' rules (see privateWriterParagraphs.ts), mints one in the same
 * save.
 *
 * @module services/privateWriterSectionLinks
 */
import { z } from "zod";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";
import {
  PrivateWriteError,
  SECTION_LINKS_LIVE_VALIDATED,
  assertNoteIdentifier,
  assertRevision,
  callPrivateWriter,
  cloudSyncSchema,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  writeSyncFields,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { PARAGRAPH_URL } from "./privateWriterParagraphs.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

const revision = z.string().regex(/^r1:[a-f0-9]{64}$/);

export const addSectionLinkSchema = z
  .object({
    status: z.literal("updated"),
    committed: z.literal(true),
    verified: z.literal(true),
    identifier: z.string(),
    target: z.string(),
    selfLink: z.boolean(),
    section: z.string(),
    targetStyleType: z.number().int(),
    paragraphId: z.string().regex(UUID_PATTERN),
    previousParagraphIdStatus: z.enum(["unique", "shared", "missing"]),
    paragraphIdMinted: z.boolean(),
    url: z.string().regex(PARAGRAPH_URL),
    token: z.string().nullable(),
    inlineAttachmentIdentifier: z.string().regex(UUID_PATTERN),
    position: z.enum(["end", "belowTitle"]),
    clearedSectionLinks: z.number().int().nonnegative(),
    revisionBefore: revision,
    revisionAfter: revision,
    modificationDate: z.string().nullable(),
    targetRevisionBefore: revision.optional(),
    targetRevisionAfter: revision.optional(),
    targetCloudSync: cloudSyncSchema.optional(),
    ...writeSyncFields,
  })
  .passthrough();
export type AddSectionLinkResult = z.infer<typeof addSectionLinkSchema>;

export interface AddSectionLinkRequest {
  /** Note that receives the chip. */
  identifier: string;
  /** Note the chip opens; defaults to `identifier` (a link within the note). */
  target?: string;
  /** Target paragraph by `blockIndex` from list-note-paragraphs; needs `expectedText`. */
  blockIndex?: number;
  expectedText?: string;
  /** Target paragraph by an identifier that is unique in the target note. */
  paragraphId?: string;
  /** Target a title, heading, or subheading by its text (exact, case-insensitive). */
  heading?: string;
  position?: "end" | "belowTitle";
  clearExistingSectionLinks?: boolean;
  /** `revision` of `identifier` from native-note-state. */
  ifRevision: string;
  /** `revision` of `target` from native-note-state; required when it is another note. */
  ifTargetRevision?: string;
  /** Folder preconditions on the note that receives the chip, checked just before the save. */
  scope?: ScopeGuard;
}

function invalid(message: string): never {
  throw new PrivateWriteError("invalid_request", message, false);
}

/** Insert one section-link chip, verified by a fresh read-back of both notes. */
export function addSectionLink(
  request: AddSectionLinkRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): AddSectionLinkResult {
  assertNoteIdentifier(request.identifier);
  if (request.target !== undefined) assertNoteIdentifier(request.target);
  const selfLink =
    request.target === undefined ||
    request.target.toUpperCase() === request.identifier.toUpperCase();
  assertRevision(request.ifRevision);
  if (selfLink && request.ifTargetRevision !== undefined)
    invalid("ifTargetRevision is only for a link to another note");
  if (!selfLink) {
    if (request.ifTargetRevision === undefined)
      invalid(
        "ifTargetRevision (the target note's revision) is required for a link to another note"
      );
    assertRevision(request.ifTargetRevision, "native-note-state for the target note");
  }
  const selectors = [request.blockIndex, request.paragraphId, request.heading].filter(
    (value) => value !== undefined
  ).length;
  if (selectors > 1) invalid("pass at most one of blockIndex, paragraphId, heading");
  if (request.blockIndex !== undefined) {
    if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0)
      invalid("blockIndex must be a non-negative integer from list-note-paragraphs");
    if (!request.expectedText?.replace(/\ufffc/g, "").trim())
      invalid("expectedText (the paragraph text from list-note-paragraphs) goes with blockIndex");
  } else if (request.expectedText !== undefined) {
    invalid("expectedText goes with blockIndex");
  }
  if (request.paragraphId !== undefined && !UUID_PATTERN.test(request.paragraphId))
    invalid("paragraphId must be a UUID");
  if (request.heading !== undefined && !request.heading.trim()) invalid("heading is empty");
  requireLiveValidated(SECTION_LINKS_LIVE_VALIDATED, "native-add-section-link", deps.env);

  const fields: Record<string, unknown> = {
    identifier: request.identifier,
    ifRevision: request.ifRevision,
  };
  if (!selfLink) {
    fields.target = request.target;
    fields.ifTargetRevision = request.ifTargetRevision;
  }
  if (request.blockIndex !== undefined) {
    fields.blockIndex = request.blockIndex;
    fields.expectedText = request.expectedText;
  }
  if (request.paragraphId !== undefined) fields.paragraphId = request.paragraphId.toUpperCase();
  if (request.heading !== undefined) fields.heading = request.heading;
  if (request.position !== undefined) fields.position = request.position;
  if (request.clearExistingSectionLinks !== undefined)
    fields.clearExistingSectionLinks = request.clearExistingSectionLinks;
  Object.assign(fields, writerScopeFields(request.scope));
  return parseWriterResult(
    addSectionLinkSchema,
    callPrivateWriter("add_section_link", fields, deps),
    true
  );
}
