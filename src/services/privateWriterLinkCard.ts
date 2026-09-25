/**
 * Rich URL link cards through the opt-in private WRITER.
 *
 * A Notes link card is an `ICAttachment` of type `public.url` plus one
 * attachment glyph (U+FFFC carrying an `ICTTAttachment`) in the note text.
 * No Shortcuts action creates one. The writer's `add_url_card` action asks
 * NotesShared to create the attachment row (`-[ICNote
 * addURLAttachmentWithURL:]`), inserts the glyph as its own paragraph at the
 * end of the note or right after one exactly matching paragraph, and re-reads
 * the note from a fresh Core Data stack to confirm the glyph position, the
 * attachment's type, URL, and owning note, and that nothing else in the text
 * changed. It makes no network request: Notes fetches the card's title and
 * preview image itself.
 *
 * @module services/privateWriterLinkCard
 */
import { z } from "zod";
import {
  LINK_CARD_LIVE_VALIDATED,
  PrivateWriteError,
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
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

export const MAX_URL_UTF16 = 2048;
export const MAX_ANCHOR_UTF16 = 2000;

const revision = z.string().regex(/^r1:[a-f0-9]{64}$/);

export const urlCardResultSchema = z
  .object({
    status: z.enum(["planned", "updated"]),
    committed: z.boolean(),
    dryRun: z.boolean(),
    identifier: z.string(),
    url: z.string(),
    placement: z.enum(["end", "afterParagraph"]),
    insertedAtUTF16: z.number().int().nonnegative(),
    glyphIndexUTF16: z.number().int().nonnegative(),
    separatorInserted: z.boolean(),
    /** A body-style newline after the card, when text follows it. */
    terminatorInserted: z.boolean().optional(),
    /** Dry run only: whether this macOS offers the write the plan describes. */
    writeAvailable: z.boolean().optional(),
    writeMissing: z.array(z.string()).optional(),
    revisionBefore: revision,
    revisionAfter: revision,
    attachment: z
      .object({
        attachmentIdentifier: z.string(),
        typeUTI: z.string().nullable(),
        urlString: z.string().nullable(),
        glyphIndexUTF16: z.number().int().nullable(),
        /** The attachment's own upload counters; it is a separate cloud object. */
        cloudSync: cloudSyncSchema.optional(),
      })
      .passthrough()
      .optional(),
    previewFetched: z.boolean().optional(),
    modificationDate: z.string().nullable(),
    ...writeSyncFields,
  })
  .passthrough();
export type UrlCardResult = z.infer<typeof urlCardResultSchema>;

/** Absolute http(s) URL with a host, no whitespace or control characters. */
export function assertCardUrl(url: string): void {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    url.length > MAX_URL_UTF16 ||
    // eslint-disable-next-line no-control-regex
    /[\s\x00-\x1F\x7F-\x9F\uFFFC\u2028\u2029]/u.test(url) ||
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname
  )
    throw new PrivateWriteError(
      "invalid_request",
      `url must be an absolute http or https URL with a host (at most ${MAX_URL_UTF16} characters)`,
      false
    );
}

export interface UrlCardRequest {
  identifier: string;
  url: string;
  afterParagraph?: string;
  ifRevision?: string;
  dryRun?: boolean;
  /** Folder preconditions, checked by the writer just before the save. */
  scope?: ScopeGuard;
}

/** Insert a URL link card at the end of a note or after one exact paragraph. */
export function addUrlCard(
  request: UrlCardRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): UrlCardResult {
  assertNoteIdentifier(request.identifier);
  assertCardUrl(request.url);
  if (
    request.afterParagraph !== undefined &&
    (!request.afterParagraph.length ||
      request.afterParagraph.length > MAX_ANCHOR_UTF16 ||
      request.afterParagraph.includes("\n"))
  )
    throw new PrivateWriteError(
      "invalid_request",
      `afterParagraph must be the full text of one paragraph (1 to ${MAX_ANCHOR_UTF16} characters, no newline)`,
      false
    );
  const dryRun = request.dryRun === true;
  const fields: Record<string, unknown> = { identifier: request.identifier, url: request.url };
  if (request.afterParagraph !== undefined) fields.afterParagraph = request.afterParagraph;
  Object.assign(fields, writerScopeFields(request.scope));
  if (request.ifRevision !== undefined) {
    assertRevision(request.ifRevision);
    fields.ifRevision = request.ifRevision;
  } else if (!dryRun) {
    throw new PrivateWriteError(
      "invalid_request",
      "ifRevision is required unless dryRun is true",
      false
    );
  }
  if (dryRun) fields.dryRun = true;
  else requireLiveValidated(LINK_CARD_LIVE_VALIDATED, "native-add-url-card", deps.env);
  try {
    return parseWriterResult(
      urlCardResultSchema,
      // Passing dryRun keeps a dry-run timeout from being described as a
      // possible save.
      callPrivateWriter("add_url_card", fields, deps, { dryRun }),
      !dryRun
    );
  } catch (error) {
    // A dry run opens the store read-only and cannot write, so no failure of
    // it has committed anything, whatever the transport reports.
    if (dryRun && error instanceof PrivateWriteError && error.committed !== false)
      throw new PrivateWriteError(error.code, error.message, false, error.details);
    throw error;
  }
}
