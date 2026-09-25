/**
 * MCP tools for paragraph identifiers through the opt-in private WRITER.
 *
 * - `native-set-paragraph-id`: give one paragraph (by `blockIndex` from the
 *   read-only list-note-paragraphs) a unique identifier, guarded by
 *   `ifRevision` and the paragraph text, and return its paragraph link.
 * - `native-add-section-link`: insert a native section-link chip (macOS 27)
 *   that opens a paragraph in the same or another note, minting the
 *   paragraph's identifier when needed.
 *
 * Listing paragraphs and building links stay with the read-only
 * `list-note-paragraphs` and `get-paragraph-link`; this module adds only the
 * write they leave out.
 *
 * @module tools/privateWriterParagraphTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import { setParagraphId } from "../services/privateWriterParagraphs.js";
import { addSectionLink } from "../services/privateWriterSectionLinks.js";
import {
  coreDataId,
  defaultWriterToolDeps,
  notesUuid,
  nudgeAfterWrite,
  registerWriterTool,
  resolveIdentifier,
  revisionToken,
  type WriterToolDeps,
} from "./privateWriterTools.js";
import { scopeGuardFrom, writerScopeGuardInput } from "../services/privateWriterScope.js";

/** The optional post-write nudge, shared by the paragraph write tools. */
export const nudgeInput = {
  nudge: z
    .boolean()
    .optional()
    .describe(
      "After a verified write, ask Notes.app to upload the changed note(s) by moving each into its own folder (default false)"
    ),
  nudgeWaitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_NUDGE_WAIT_SECONDS)
    .optional()
    .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
};

export function registerPrivateWriterParagraphTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-set-paragraph-id",
    "Use when: list-note-paragraphs shows paragraphIdStatus `shared` or `missing` (or get-paragraph-link refuses with paragraph-id-shared / paragraph-id-missing) for a paragraph you need to link to. Gives that paragraph an identifier of its own so its paragraph link opens exactly there.\n" +
      "Returns: `status` (`updated`, or `unchanged` when the paragraph already had a unique identifier and nothing was written), `paragraphId`, `url` (applenotes://showNote?identifier=…&paragraphID=…), `previousParagraphId`, `previousParagraphIdStatus`, revisionBefore/revisionAfter, sync state (pushScheduled is always false), and with nudge: true a `sync` report.\n" +
      "Do not use when: the paragraph is already `unique` (use its url from list-note-paragraphs), or the note is locked, shared, trashed, or still downloading.\n" +
      "Safety: writes to the Notes database through unsupported private API. Needs the paragraph's `blockIndex` and exact `text` (as expectedText) from list-note-paragraphs, and a fresh `revision` from native-note-state as ifRevision; refuses on any change (revision_conflict or paragraph_changed, committed: false). Only the paragraph style's identifier changes: a fresh read-back verifies the text, the paragraph's other attributes, every other paragraph's identifier, and that no other paragraph carries the new one. A timeout is indeterminate (indeterminate: true): read native-note-state before any retry. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer (setup --native-writer), and APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1 until live-validated.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      blockIndex: z
        .number()
        .int()
        .min(0)
        .describe("The paragraph's `blockIndex` from list-note-paragraphs"),
      expectedText: z
        .string()
        .min(1)
        .max(50_000)
        .describe("The paragraph's `text` from list-note-paragraphs"),
      ifRevision: revisionToken.describe(
        "The `revision` returned by native-note-state for this note"
      ),
      paragraphId: notesUuid
        .optional()
        .describe("Optional UUID to assign; must not be in use in the note. Omit to mint one"),
      ...writerScopeGuardInput(),
      ...nudgeInput,
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = setParagraphId(
        {
          identifier,
          blockIndex: args.blockIndex,
          expectedText: args.expectedText,
          ifRevision: args.ifRevision,
          paragraphId: args.paragraphId,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge || result.status !== "updated") return { ...result };
      return {
        ...result,
        sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-add-section-link",
    "Use when: inserting a native section-link chip (what Notes' Copy Link to Section pastes) that opens a paragraph or heading in the same note or another note. macOS 27 or later.\n" +
      "Returns: `url` and `token` (applenotes://showNote?identifier=…&paragraphID=…), the `section` label, `paragraphId`, `paragraphIdMinted` (true when the target paragraph needed an identifier of its own), `inlineAttachmentIdentifier`, `clearedSectionLinks`, revisionBefore/After (plus targetRevisionBefore/After for another note), sync state (pushScheduled is always false), and with nudge: true a `sync` report.\n" +
      "Do not use when: a link string is enough (get-paragraph-link, or native-set-paragraph-id first when the identifier is shared), or you want a chip to a whole note.\n" +
      "Safety: writes to the Notes database through unsupported private API. Selects the target paragraph by `blockIndex` + `expectedText` from list-note-paragraphs, by a unique `paragraphId`, by `heading` text (exact, case-insensitive), or defaults to the first heading or subheading; refuses a missing or ambiguous match. Needs `ifRevision` and, for another note, `ifTargetRevision`, both from native-note-state; refuses on any change (committed: false). `clearExistingSectionLinks` removes only chips that are section links; note-link chips stay. Verified by a fresh read-back of both notes and the attachment. A timeout is indeterminate (indeterminate: true). Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer (setup --native-writer), and APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1 until live-validated.",
    {
      identifier: notesUuid.optional().describe("Notes UUID of the note that receives the chip"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      target: notesUuid
        .optional()
        .describe("Notes UUID of the note the chip opens; omit to link within the same note"),
      blockIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Target paragraph's `blockIndex` from list-note-paragraphs (with expectedText)"),
      expectedText: z
        .string()
        .min(1)
        .max(50_000)
        .optional()
        .describe("With blockIndex: the paragraph's `text` from list-note-paragraphs"),
      paragraphId: notesUuid
        .optional()
        .describe("A paragraph identifier that is unique in the target note"),
      heading: z
        .string()
        .min(1)
        .max(1000)
        .optional()
        .describe("Title, heading, or subheading text to link to (exact, case-insensitive)"),
      position: z
        .enum(["end", "belowTitle"])
        .optional()
        .describe(
          "end (default) appends; belowTitle inserts after the title and any section chips right below it"
        ),
      clearExistingSectionLinks: z
        .boolean()
        .optional()
        .describe("Remove the note's existing section-link chips first (default false)"),
      ifRevision: revisionToken.describe(
        "The `revision` from native-note-state for the note that receives the chip"
      ),
      ifTargetRevision: revisionToken
        .optional()
        .describe("The target note's `revision` from native-note-state; required for another note"),
      ...writerScopeGuardInput(),
      ...nudgeInput,
    },
    // destructiveHint: clearExistingSectionLinks removes chips.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = addSectionLink(
        {
          identifier,
          target: args.target,
          blockIndex: args.blockIndex,
          expectedText: args.expectedText,
          paragraphId: args.paragraphId,
          heading: args.heading,
          position: args.position,
          clearExistingSectionLinks: args.clearExistingSectionLinks,
          ifRevision: args.ifRevision,
          ifTargetRevision: args.ifTargetRevision,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge) return { ...result };
      // A minted identifier changed the target note too.
      const changed =
        !result.selfLink && result.paragraphIdMinted ? [identifier, result.target] : [identifier];
      return { ...result, sync: await nudgeAfterWrite(changed, args.nudgeWaitSeconds, deps.nudge) };
    }
  );
}
