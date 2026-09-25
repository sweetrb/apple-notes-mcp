/**
 * Folder scope guards for the private writer's write tools (#57).
 *
 * The same three preconditions the AppleScript write tools take
 * (utils/scopeGuard.ts), with the same shapes and meaning:
 *
 * - `ifFolderId`: the note's folder is exactly this folder;
 * - `ifAncestorFolderId`: this folder is the note's folder or an ancestor;
 * - `forbiddenAncestorFolderIds`: none of these is the note's folder or an
 *   ancestor (nor on the destination's chain when the write moves the note).
 *
 * The writer checks them itself, in the write's own Core Data context right
 * before the save, so a note that moved after it was reviewed is refused with
 * nothing written (`scope_conflict`). A call that saves nothing (a dry run or
 * a no-op) runs the same check read-only before it answers. Unlike the
 * AppleScript guard, every id must name an existing folder: an unknown id, or
 * a forbidden id naming a deleted folder, refuses the call
 * (`scope_folder_not_found`) instead of matching nothing.
 *
 * For the smart-folder tools the subject is the smart folder: its "folder" is
 * its parent (the destination parent for a create), and a forbidden id may
 * also name the smart folder itself.
 *
 * @module services/privateWriterScope
 */
import { exactIdArrayInput, exactIdInput } from "../utils/noteIdentifiers.js";
import {
  MAX_FORBIDDEN_FOLDERS,
  SCOPE_FOLDER_ID,
  hasScopeGuard,
  validateScopeGuard,
  type ScopeGuard,
} from "../utils/scopeGuard.js";
import { PrivateWriteError } from "./privateWriter.js";

export type { ScopeGuard };

const FOLDER_ID_MESSAGE = "Use an exact folder id from list-folders (x-coredata://…/ICFolder/p…)";

/**
 * The input fragment every writer tool that writes a note (or a smart folder)
 * spreads into its schema. Folder UUIDs and numeric keys are resolved to the
 * x-coredata id before the handler runs, like every other exact id input.
 */
export function writerScopeGuardInput(subject: "note" | "smart folder" = "note") {
  const where =
    subject === "note" ? "the note's folder" : "the smart folder's parent (or destination) folder";
  return {
    ifFolderId: exactIdInput("ICFolder", SCOPE_FOLDER_ID, FOLDER_ID_MESSAGE, { maxLength: 256 })
      .optional()
      .describe(
        `Precondition: ${where} must be exactly this folder (id from list-folders). The writer checks it in the same transaction, just before the save.`
      ),
    ifAncestorFolderId: exactIdInput("ICFolder", SCOPE_FOLDER_ID, FOLDER_ID_MESSAGE, {
      maxLength: 256,
    })
      .optional()
      .describe(
        `Precondition: ${where} must be this folder or one of its subfolders. Checked just before the save.`
      ),
    forbiddenAncestorFolderIds: exactIdArrayInput("ICFolder", SCOPE_FOLDER_ID, FOLDER_ID_MESSAGE, {
      maxLength: 256,
      maxItems: MAX_FORBIDDEN_FOLDERS,
    })
      .optional()
      .describe(
        `Precondition: ${where} must not be any of these folders or inside them${subject === "note" ? "" : ", and none may be the smart folder itself"}. Every id must name an existing folder, or the call is refused. Checked just before the save.`
      ),
  };
}

/** The guard from a tool's arguments, or undefined when none was given. */
export function scopeGuardFrom(args: ScopeGuard): ScopeGuard | undefined {
  const guard: ScopeGuard = {
    ifFolderId: args.ifFolderId,
    ifAncestorFolderId: args.ifAncestorFolderId,
    forbiddenAncestorFolderIds: args.forbiddenAncestorFolderIds,
  };
  return hasScopeGuard(guard) ? guard : undefined;
}

/**
 * The writer request fields for a guard, validated. Empty when there is no
 * guard; a malformed id never reaches the writer (nothing committed).
 */
export function writerScopeFields(guard: ScopeGuard | undefined): Record<string, unknown> {
  if (!hasScopeGuard(guard)) return {};
  try {
    validateScopeGuard(guard);
  } catch (error) {
    throw new PrivateWriteError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
      false
    );
  }
  const fields: Record<string, unknown> = {};
  if (guard.ifFolderId) fields.ifFolderId = guard.ifFolderId;
  if (guard.ifAncestorFolderId) fields.ifAncestorFolderId = guard.ifAncestorFolderId;
  if (guard.forbiddenAncestorFolderIds?.length)
    fields.forbiddenAncestorFolderIds = [...guard.forbiddenAncestorFolderIds];
  return fields;
}

/** The writer actions that accept the guard fields, and their subject (kScopeGuardedActions). */
export const SCOPE_GUARDED_ACTIONS: Readonly<Record<string, "note" | "folder" | "new_folder">> = {
  append_plain_text: "note",
  plan_edit: "note",
  edit_note: "note",
  compose_note: "note",
  set_checklist_item: "note",
  set_highlight: "note",
  add_url_card: "note",
  set_paragraph_id: "note",
  add_section_link: "note",
  delete_table_row: "note",
  insert_table_row: "note",
  set_table_cell: "note",
  prune_orphan_table: "note",
  add_paper: "note",
  repair_purge_flag: "note",
  create_smart_folder: "new_folder",
  update_smart_folder: "folder",
  delete_smart_folder: "folder",
};
