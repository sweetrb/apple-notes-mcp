/**
 * URL link card tool on the opt-in private WRITER.
 *
 * `native-add-url-card` inserts a rich web link card (a `public.url`
 * attachment plus its glyph on a line of its own) at the end of a note or
 * after one exact paragraph, with a dry run, an `ifRevision` compare-and-swap,
 * a fresh read-back, and the optional move-in-place sync nudge. It shares the
 * envelope in privateWriterTools.ts.
 *
 * @module tools/privateWriterLinkCardTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import { MAX_ANCHOR_UTF16, MAX_URL_UTF16, addUrlCard } from "../services/privateWriterLinkCard.js";
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

export function registerPrivateWriterLinkCardTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-add-url-card",
    "Use when: adding a rich web link card (the preview tile Notes shows for a pasted URL) to one note, at the end or right after one exact paragraph. Neither AppleScript nor Shortcuts can create one.\n" +
      "Returns: status (planned for a dry run, updated), the attachment identifier, its stored type and URL, its own cloudSync counters, the glyph position re-read from a fresh Core Data stack, revisionBefore/revisionAfter, sync state (pushScheduled is always false), and with nudge: true a `sync` report.\n" +
      "Do not use when: you want a plain or labeled text link (insert-link or append-native), or a link to another note (insert-note-link).\n" +
      "Safety: writes to the Notes database through unsupported private API: one new public.url attachment and one attachment glyph on its own line; no other text changes. `url` must be absolute http(s). `afterParagraph` must equal the full text of exactly one paragraph, or nothing is written (match_count_mismatch). The writer makes no network request; Notes fetches the card title and preview image itself later. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer, and a fresh `revision` from native-note-state as ifRevision (optional for dryRun). Not idempotent: a repeat adds a second card, but the replayed revision is refused. A timeout is indeterminate (indeterminate: true): read the note before any retry. Writes are not yet live-validated, so they also require APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1; dryRun does not.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      url: z.string().min(1).max(MAX_URL_UTF16).describe("Absolute http or https URL for the card"),
      afterParagraph: z
        .string()
        .min(1)
        .max(MAX_ANCHOR_UTF16)
        .optional()
        .describe(
          "Full text of the one paragraph the card should follow; omit to append at the end"
        ),
      ifRevision: revisionToken
        .optional()
        .describe("The `revision` from native-note-state; required unless dryRun is true"),
      dryRun: z.boolean().optional().describe("Report where the card would go without writing"),
      ...writerScopeGuardInput(),
      nudge: z
        .boolean()
        .optional()
        .describe(
          "After a verified write, ask Notes.app to upload the note by moving it into its own folder (default false)"
        ),
      nudgeWaitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_NUDGE_WAIT_SECONDS)
        .optional()
        .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = addUrlCard(
        {
          identifier,
          url: args.url,
          afterParagraph: args.afterParagraph,
          ifRevision: args.ifRevision,
          dryRun: args.dryRun,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge || !result.committed) return { ...result };
      return {
        ...result,
        sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );
}
