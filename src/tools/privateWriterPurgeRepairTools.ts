/**
 * Purge-flag repair tool on the opt-in private WRITER (#89).
 *
 * `native-repair-purge-flag` finds notes that carry Notes' permanent-deletion
 * flag while still in an ordinary folder, a state no ordinary delete leaves
 * behind, and finishes a normal delete for one of them: the flag is cleared
 * and the note moves to Recently Deleted. Scan and plan are read-only; the
 * apply needs the plan's revision and `confirm: true`. See
 * services/privateWriterPurgeRepair.ts.
 *
 * @module tools/privateWriterPurgeRepairTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { repairPurgeFlag } from "../services/privateWriterPurgeRepair.js";
import { scopeGuardFrom, writerScopeGuardInput } from "../services/privateWriterScope.js";
import {
  coreDataId,
  defaultWriterToolDeps,
  notesUuid,
  registerWriterTool,
  resolveIdentifier,
  revisionToken,
  type WriterToolDeps,
} from "./privateWriterTools.js";

export function registerPrivateWriterPurgeRepairTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-repair-purge-flag",
    "Use when: a note vanished from Notes without passing through Recently Deleted, or you want to check for notes that carry Notes' permanent-deletion (purge) flag while still in an ordinary folder. That state is corrupt: Notes hides the note and will purge it, and the user cannot recover it. The repair finishes an ordinary delete: it clears the flag and moves the note to Recently Deleted.\n" +
      "Returns: without identifier (scan): candidateCount, truncated, and up to 50 candidates. With identifier and dryRun (default): the note's state (active, in_recently_deleted, purging_from_recently_deleted, purge_flag_outside_recently_deleted, purge_flag_without_folder, folderless), repairable, blockers, its folder and the account's Recently Deleted folder, attachment counts, and `revision`. Apply: status repaired, state in_recently_deleted, revisionBefore/revisionAfter, and sync state (pushScheduled is always false). The move-in-place nudge skips trashed notes, so to upload the move now use native-sync-push with method relaunch.\n" +
      "Do not use when: deleting an ordinary note (delete-note), restoring a note from Recently Deleted (move-note), or the plan lists blockers (locked, shared, downloading, attachments_marked_for_deletion, no_recently_deleted_folder).\n" +
      "Safety: scan and plan are read-only. The apply writes through unsupported private API and never purges: it clears the note's flag, moves it to its account's Recently Deleted folder, stamps the folder time (which starts Notes' 30-day clock), and verifies all of it plus an unchanged body in a fresh Core Data stack. It needs the plan's `revision` as ifRevision and confirm: true after the user agreed. A flag Notes set on purpose (a permanent delete on another device that has not finished syncing) looks the same, and repairing it brings that note back into Recently Deleted on every device; only repair a note the user recognizes. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer, and, until live-validated, APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1 for the apply. A timeout is indeterminate: plan again before any retry.",
    {
      identifier: notesUuid
        .optional()
        .describe("Notes UUID; omit (with dryRun) to scan for every note in the purge-flag state"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      dryRun: z
        .boolean()
        .optional()
        .describe("true (default): scan or plan only. false: apply; needs ifRevision and confirm"),
      ifRevision: revisionToken
        .optional()
        .describe("The `revision` from the dry run of the same note (required to apply)"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to apply, after the user agreed to the move to Recently Deleted"),
      ...writerScopeGuardInput(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args, deps) => {
      const identifier =
        args.identifier === undefined && args.id === undefined
          ? undefined
          : resolveIdentifier(manager, args);
      return {
        ...repairPurgeFlag(
          {
            identifier,
            dryRun: args.dryRun,
            ifRevision: args.ifRevision,
            confirm: args.confirm,
            scope: scopeGuardFrom(args),
          },
          deps.writer
        ),
      };
    }
  );
}
