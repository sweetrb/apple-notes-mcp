/**
 * Folder scope preconditions for note writes.
 *
 * A caller that reviewed a note in one place can require that it is still
 * there when the write runs:
 *
 * - `ifFolderId`: the note's folder is exactly this folder.
 * - `ifAncestorFolderId`: this folder is the note's folder or one of its
 *   ancestors (the note is somewhere inside that subtree).
 * - `forbiddenAncestorFolderIds`: none of these is the note's folder or an
 *   ancestor. For a move, the destination's chain is checked too.
 *
 * The checks are emitted as AppleScript that runs inside the same script as
 * the write, immediately before it, against Notes.app's live containers. Where
 * the write itself is not an AppleScript (native Shortcuts operations), the
 * same snippet runs as a read-only pre-check just before the write, so the
 * guard is not atomic there.
 *
 * @module utils/scopeGuard
 */

/** Optional folder preconditions on a note write. */
export interface ScopeGuard {
  ifFolderId?: string;
  ifAncestorFolderId?: string;
  forbiddenAncestorFolderIds?: string[];
}

/** Exact AppleScript folder id. */
export const SCOPE_FOLDER_ID = /^x-coredata:\/\/[0-9a-f-]+\/ICFolder\/p\d+$/i;

/** Maximum forbidden folder ids per call. */
export const MAX_FORBIDDEN_FOLDERS = 50;

/** Result marker a guarded script returns when a scope check fails. */
export const SCOPE_MARKER = "SAFETY_SCOPE";

/** Whether any scope precondition was given. */
export function hasScopeGuard(guard: ScopeGuard | undefined): guard is ScopeGuard {
  return Boolean(
    guard &&
    (guard.ifFolderId ||
      guard.ifAncestorFolderId ||
      (guard.forbiddenAncestorFolderIds && guard.forbiddenAncestorFolderIds.length > 0))
  );
}

/** Throws when an id is not an exact folder id or the forbidden list is too long. */
export function validateScopeGuard(guard: ScopeGuard): void {
  const ids = [
    guard.ifFolderId,
    guard.ifAncestorFolderId,
    ...(guard.forbiddenAncestorFolderIds ?? []),
  ].filter((value): value is string => value !== undefined);
  for (const id of ids) {
    if (!SCOPE_FOLDER_ID.test(id)) throw new Error(`Scope guard needs exact folder ids: ${id}`);
  }
  if ((guard.forbiddenAncestorFolderIds?.length ?? 0) > MAX_FORBIDDEN_FOLDERS)
    throw new Error(`At most ${MAX_FORBIDDEN_FOLDERS} forbidden folder ids are allowed`);
}

/** AppleScript that collects a folder's id and every ancestor folder id. */
function chainScript(chainVar: string, startExpr: string): string {
  return `
      set ${chainVar} to {}
      set ${chainVar}Cursor to ${startExpr}
      repeat while class of ${chainVar}Cursor is folder
        set end of ${chainVar} to (id of ${chainVar}Cursor)
        set ${chainVar}Cursor to container of ${chainVar}Cursor
      end repeat`;
}

/** AppleScript list literal of validated folder ids. */
function idList(ids: string[]): string {
  return `{${ids.map((id) => `"${id}"`).join(", ")}}`;
}

/**
 * Builds the in-script scope checks (inside `tell application "Notes"`).
 *
 * @param noteVar - AppleScript variable holding the note reference
 * @param guard - The preconditions; ids are validated here
 * @param destinationVar - For a move: variable holding the destination folder
 * @returns AppleScript that returns `SAFETY_SCOPE:<reason>` on failure, or ""
 */
export function buildScopeGuardScript(
  noteVar: string,
  guard: ScopeGuard | undefined,
  destinationVar?: string
): string {
  if (!hasScopeGuard(guard)) return "";
  validateScopeGuard(guard);
  const forbidden = guard.forbiddenAncestorFolderIds ?? [];
  let script = `
      set scopeFolder to container of ${noteVar}
      if class of scopeFolder is not folder then return "${SCOPE_MARKER}:the note is not in a folder"`;
  if (guard.ifFolderId)
    script += `
      if (id of scopeFolder) is not "${guard.ifFolderId}" then return "${SCOPE_MARKER}:the note is not in the expected folder"`;
  if (guard.ifAncestorFolderId || forbidden.length > 0)
    script += chainScript("scopeChain", "scopeFolder");
  if (guard.ifAncestorFolderId)
    script += `
      if scopeChain does not contain "${guard.ifAncestorFolderId}" then return "${SCOPE_MARKER}:the note is not inside the expected ancestor folder"`;
  if (forbidden.length > 0) {
    script += `
      repeat with forbiddenId in ${idList(forbidden)}
        if scopeChain contains (contents of forbiddenId) then return "${SCOPE_MARKER}:the note is inside a forbidden folder"
      end repeat`;
    if (destinationVar) {
      script += chainScript("scopeDestChain", destinationVar);
      script += `
      repeat with forbiddenId in ${idList(forbidden)}
        if scopeDestChain contains (contents of forbiddenId) then return "${SCOPE_MARKER}:the destination is inside a forbidden folder"
      end repeat`;
    }
  }
  return script;
}

/** Extracts the reason from a `SAFETY_SCOPE:<reason>` script result, or null. */
export function parseScopeFailure(output: string): string | null {
  const trimmed = output.trim();
  return trimmed.startsWith(`${SCOPE_MARKER}:`) ? trimmed.slice(SCOPE_MARKER.length + 1) : null;
}

/** User-facing message for a failed scope precondition. */
export function scopeConflictMessage(reason: string): string {
  return `Scope guard failed: ${reason}. Nothing was changed; read the note's current folder and review before retrying.`;
}
