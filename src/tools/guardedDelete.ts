/**
 * Guard orchestration for `delete-note` and `batch-delete-notes`.
 *
 * - Recently Deleted protection: deleting a note that is already in Recently
 *   Deleted removes it permanently, so it is refused unless the caller passes
 *   `permanent: true`. The check runs inside the delete AppleScript against
 *   the note's live container, because the local store can keep a
 *   just-trashed note in its old folder for minutes.
 * - Copy-then-retire (`guardNoteId` + `expectedGuardContentHash`): delete
 *   note A only while a second note B still has the reviewed revision and is
 *   active. Both revisions are re-read immediately before the AppleScript
 *   delete, and B's body, lock state, and folder are checked again inside it.
 * - `requireActiveNoteId`: a second note must still exist, be unlocked, stay
 *   outside Recently Deleted, and not be a Quick Note. Its content is not
 *   fingerprinted.
 *
 * Neither guard makes the pair one transaction. The rich revision (which also
 * covers native objects such as checklists) is a pre-check; the in-script
 * comparison covers the body and state Notes.app exposes.
 *
 * @module tools/guardedDelete
 */

import type { GuardedDeleteOptions, GuardedDeleteOutcome } from "../types.js";

/** The subset of an exact-note snapshot the guards need. */
export interface GuardSnapshot {
  note: { title: string; shared?: boolean };
  body: string;
  contentHash: string;
}

/** Injectable reads and the delete itself. */
export interface GuardedDeleteDeps {
  readSnapshot: (id: string) => GuardSnapshot | { error: string };
  deleteIfUnchanged: (
    id: string,
    expectedBody: string,
    options: GuardedDeleteOptions
  ) => GuardedDeleteOutcome;
  /** Primary keys of Recently Deleted folders; may throw when the store is unreadable. */
  readTrashFolderPks: () => number[];
  /** Quick Note flag for a note key, or null when the store has no such note; may throw. */
  readIsQuickNote: (pk: number) => boolean | null;
}

/** Arguments accepted by `delete-note`. */
export interface GuardedDeleteArgs {
  id: string;
  expectedContentHash: string;
  guardNoteId?: string;
  expectedGuardContentHash?: string;
  requireActiveNoteId?: string;
  permanent?: boolean;
}

/** Successful delete result. */
export type GuardedDeleteSuccess = {
  ok: true;
  id: string;
  title: string;
  wasShared: boolean;
  previousContentHash: string;
  permanent: boolean;
  guardNoteId?: string;
  guardContentHash?: string;
  requireActiveNoteId?: string;
};

/** Message for a note that changed after review. */
export function revisionConflictMessage(title: string): string {
  return `Note "${title}" changed after it was read. Read it again and review the newer version before retrying.`;
}

/** Message for a delete that would be permanent. */
export const IN_TRASH_MESSAGE =
  "This note is already in Recently Deleted, so deleting it again would remove it permanently. Pass permanent: true only when the user explicitly asked for permanent deletion.";

/** Exact Recently Deleted folder ids for the note's store, or [] when unreadable. */
export function trashFolderIdsFor(noteId: string, deps: GuardedDeleteDeps): string[] {
  const store = /^(x-coredata:\/\/[0-9a-f-]+)\//i.exec(noteId)?.[1];
  if (!store) return [];
  try {
    return deps.readTrashFolderPks().map((pk) => `${store}/ICFolder/p${pk}`);
  } catch {
    // The in-script container class and name checks still apply.
    return [];
  }
}

/** Primary key of an x-coredata note id. */
function notePk(id: string): number {
  return Number(/\/p(\d+)$/.exec(id)?.[1]);
}

/** Refuses a guard note that is a Quick Note or missing from the store. */
function assertNotQuickNote(label: string, id: string, deps: GuardedDeleteDeps): string | null {
  let quick: boolean | null;
  try {
    quick = deps.readIsQuickNote(notePk(id));
  } catch (error) {
    return `${label} note could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (quick === null) return `${label} note is not in the local Notes store yet; try again shortly`;
  if (quick) return `${label} note is a Quick Note; a destination must be an ordinary note`;
  return null;
}

/**
 * Runs the full guarded delete for one note.
 *
 * @returns the success payload, or `{ error }` with a message for the caller
 */
export function runGuardedNoteDelete(
  deps: GuardedDeleteDeps,
  args: GuardedDeleteArgs
): GuardedDeleteSuccess | { error: string } {
  const { id, expectedContentHash, guardNoteId, expectedGuardContentHash, requireActiveNoteId } =
    args;
  if ((guardNoteId === undefined) !== (expectedGuardContentHash === undefined))
    return { error: "Pass guardNoteId and expectedGuardContentHash together" };
  if (guardNoteId === id || requireActiveNoteId === id)
    return { error: "A guard note must be a different note from the one being deleted" };
  if (guardNoteId !== undefined && guardNoteId === requireActiveNoteId)
    return { error: "requireActiveNoteId repeats guardNoteId; pass only guardNoteId" };

  // Store reads first, so the revision reads below are the last step before
  // the AppleScript delete.
  for (const [label, guardId] of [
    ["Guard", guardNoteId],
    ["Required active", requireActiveNoteId],
  ] as const) {
    if (!guardId) continue;
    const refusal = assertNotQuickNote(label, guardId, deps);
    if (refusal) return { error: refusal };
  }
  const trashFolderIds = trashFolderIdsFor(id, deps);

  const snapshot = deps.readSnapshot(id);
  if ("error" in snapshot) return { error: snapshot.error };
  if (snapshot.contentHash !== expectedContentHash)
    return { error: revisionConflictMessage(snapshot.note.title) };

  const activeNotes: NonNullable<GuardedDeleteOptions["activeNotes"]> = [];
  const labels: string[] = [];
  let guardContentHash: string | undefined;
  if (guardNoteId) {
    const guard = deps.readSnapshot(guardNoteId);
    if ("error" in guard) return { error: `Guard note: ${guard.error}` };
    if (guard.contentHash !== expectedGuardContentHash)
      return {
        error: `Guard note "${guard.note.title}" changed after it was read; verify the copy again before retiring the original`,
      };
    guardContentHash = guard.contentHash;
    activeNotes.push({ id: guardNoteId, expectedBody: guard.body });
    labels.push("Guard");
  }
  if (requireActiveNoteId) {
    const active = deps.readSnapshot(requireActiveNoteId);
    if ("error" in active) return { error: `Required active note: ${active.error}` };
    activeNotes.push({ id: requireActiveNoteId });
    labels.push("Required active");
  }

  const outcome = deps.deleteIfUnchanged(id, snapshot.body, {
    allowPermanent: args.permanent === true,
    trashFolderIds,
    activeNotes,
  });
  switch (outcome.status) {
    case "deleted":
      return {
        ok: true,
        id,
        title: snapshot.note.title,
        wasShared: snapshot.note.shared ?? false,
        previousContentHash: expectedContentHash,
        permanent: outcome.permanent === true,
        ...(guardNoteId ? { guardNoteId, guardContentHash } : {}),
        ...(requireActiveNoteId ? { requireActiveNoteId } : {}),
      };
    case "conflict":
      return { error: revisionConflictMessage(snapshot.note.title) };
    case "in_trash":
      return { error: IN_TRASH_MESSAGE };
    case "guard_conflict":
      return {
        error: `${labels[outcome.index] ?? "Guard"} note changed just before the delete; nothing was deleted`,
      };
    case "guard_inactive":
      return {
        error: `${labels[outcome.index] ?? "Guard"} note is no longer active (${outcome.reason}); nothing was deleted`,
      };
    default:
      return {
        error: `The delete result for note "${snapshot.note.title}" is uncertain. Inspect exact ID ${id} before retrying.`,
      };
  }
}
