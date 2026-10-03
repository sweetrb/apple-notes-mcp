/**
 * Purge-flag repair through the opt-in private writer (#89).
 *
 * Notes deletes a note by moving it to its account's Recently Deleted
 * folder. The note's `markedForDeletion` flag, which tells Notes to purge the
 * record for good (locally and in iCloud), stays clear until the 30-day
 * lifetime there ends or the user deletes it from Recently Deleted.
 *
 * A note with that flag set while it is still in an ordinary folder is in
 * neither state. Notes hides it and will purge it, but it never passed
 * through Recently Deleted, so the user cannot recover it. The known cause is
 * a tool that set the flag instead of moving the note. The repair finishes
 * the delete the ordinary way: it clears the flag and moves the note to
 * Recently Deleted, where the user can recover it or let it expire. It never
 * purges anything.
 *
 * - `dryRun: true` without an identifier scans the store for notes in that
 *   state (read-only).
 * - `dryRun: true` with an identifier plans one repair and returns the
 *   note's `revision` and any blockers (read-only).
 * - `dryRun: false` needs that `revision` as `ifRevision` and `confirm: true`.
 *   The writer re-checks the state, applies the move, and verifies it in a
 *   fresh read-only stack.
 *
 * Risk: a flag Notes set itself on purpose (a permanent delete from another
 * device that has not finished syncing) looks the same locally. Repairing
 * such a note brings it back into Recently Deleted, and that move then syncs
 * to every device. Only repair a note the user recognizes as wrongly lost.
 *
 * @module services/privateWriterPurgeRepair
 */
import { z } from "zod";
import {
  PURGE_REPAIR_LIVE_VALIDATED,
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

export const DELETION_STATES = [
  "active",
  "in_recently_deleted",
  "purging_from_recently_deleted",
  "purge_flag_outside_recently_deleted",
  "purge_flag_without_folder",
  "folderless",
] as const;

export const PURGE_REPAIR_BLOCKERS = [
  "not_in_purge_flag_state",
  "locked",
  "shared",
  "downloading",
  "account_unavailable",
  "no_recently_deleted_folder",
  "attachments_marked_for_deletion",
] as const;

const planFields = {
  identifier: z.string().nullable(),
  objectURI: z.string(),
  title: z.string().nullable(),
  state: z.enum(DELETION_STATES),
  repairable: z.boolean(),
  blockers: z.array(z.string()),
  folderIdentifier: z.string().nullable(),
  folderObjectURI: z.string().nullable(),
  folderMarkedForDeletion: z.boolean(),
  recentlyDeletedFolderIdentifier: z.string().nullable(),
  attachmentCount: z.number().int(),
  attachmentsMarkedForDeletion: z.number().int(),
  revision: z.string(),
  cloudSync: cloudSyncSchema,
};

export const purgeScanSchema = z
  .object({
    status: z.literal("scanned"),
    dryRun: z.literal(true),
    committed: z.literal(false),
    markedForDeletionCount: z.number().int(),
    candidateCount: z.number().int(),
    truncated: z.boolean(),
    candidates: z.array(z.object(planFields).passthrough()),
  })
  .passthrough();

export const purgePlanSchema = z
  .object({
    status: z.literal("planned"),
    dryRun: z.literal(true),
    committed: z.literal(false),
    ...planFields,
  })
  .passthrough();

export const purgeRepairResultSchema = z
  .object({
    status: z.literal("repaired"),
    dryRun: z.literal(false),
    committed: z.literal(true),
    verified: z.literal(true),
    repairedPurgeFlag: z.literal(true),
    identifier: z.string(),
    previousState: z.literal("purge_flag_outside_recently_deleted"),
    state: z.literal("in_recently_deleted"),
    fromFolderIdentifier: z.string().nullable(),
    recentlyDeletedFolderIdentifier: z.string().nullable(),
    folderIdentifier: z.string().nullable(),
    revisionBefore: z.string(),
    revisionAfter: z.string(),
    modificationDate: z.string().nullable(),
    ...writeSyncFields,
  })
  .passthrough();

export type PurgeScan = z.infer<typeof purgeScanSchema>;
export type PurgePlan = z.infer<typeof purgePlanSchema>;
export type PurgeRepairResult = z.infer<typeof purgeRepairResultSchema>;

export interface PurgeRepairRequest {
  /** The note; omit (with dryRun true) to scan the store. */
  identifier?: string;
  /** Defaults to true: nothing is written unless dryRun is false. */
  dryRun?: boolean;
  /** The plan's `revision`; required with dryRun false. */
  ifRevision?: string;
  /** Must be true with dryRun false: the user agreed to the move. */
  confirm?: boolean;
  /** Folder preconditions on the note (and its destination), checked just before the save. */
  scope?: ScopeGuard;
}

function invalid(message: string, committed: false | undefined): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, committed);
}

/** Scan, plan, or apply one purge-flag repair. */
export function repairPurgeFlag(
  request: PurgeRepairRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): PurgeScan | PurgePlan | PurgeRepairResult {
  const dryRun = request.dryRun !== false;
  const notCommitted = dryRun ? undefined : false;
  if (request.identifier !== undefined) assertNoteIdentifier(request.identifier);
  const scope = writerScopeFields(request.scope);
  if (dryRun) {
    if (request.ifRevision !== undefined || request.confirm !== undefined)
      throw invalid("ifRevision and confirm are only accepted with dryRun: false", notCommitted);
    if (request.identifier === undefined && Object.keys(scope).length)
      throw invalid("Folder scope guards need an identifier; a scan takes none", notCommitted);
    const fields: Record<string, unknown> = { dryRun: true, ...scope };
    if (request.identifier !== undefined) fields.identifier = request.identifier;
    // A dry run opens the store read-only, so it is sent as a read.
    const response = callPrivateWriter("repair_purge_flag", fields, deps, { dryRun: true });
    return request.identifier === undefined
      ? parseWriterResult(purgeScanSchema, response, false)
      : parseWriterResult(purgePlanSchema, response, false);
  }
  if (request.identifier === undefined) throw invalid("identifier is required to apply", false);
  if (request.ifRevision === undefined)
    throw invalid("ifRevision (the revision from a dry run) is required to apply", false);
  assertRevision(request.ifRevision, "a dry run of native-repair-purge-flag");
  if (request.confirm !== true)
    throw new PrivateWriteError(
      "confirmation_required",
      "The repair moves the note to Recently Deleted, where it syncs to every device. " +
        "Show the user the plan, then pass confirm: true.",
      false
    );
  requireLiveValidated(PURGE_REPAIR_LIVE_VALIDATED, "native-repair-purge-flag", deps.env);
  return parseWriterResult(
    purgeRepairResultSchema,
    callPrivateWriter(
      "repair_purge_flag",
      {
        identifier: request.identifier,
        dryRun: false,
        ifRevision: request.ifRevision,
        confirm: true,
        ...scope,
      },
      deps
    ),
    true
  );
}
