/**
 * Note-scoped reads on top of the shared NoteStore plumbing in noteStoreSql.
 *
 * Queries run through `runReadOnlySql` (read-only sqlite3, argument array, no
 * shell). The only value bound here is the note's primary key, as a validated
 * integer through sqlite3's parameter table, so no caller input is spliced
 * into SQL text.
 *
 * @module utils/noteStoreQuery
 */
import { CodedError } from "./errorCodes.js";
import { entity, NOTES_DB_PATH, NoteStoreError, runReadOnlySql } from "./noteStoreSql.js";

/** Splits an `x-coredata://<store>/ICNote/p<pk>` id into its store UUID and primary key. */
export function parseNoteObjectId(noteId: string): { store: string; pk: number } {
  const match = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d{1,15})$/.exec(noteId);
  if (!match)
    throw new NoteStoreError(
      `Invalid note ID format: "${noteId}". Expected format: x-coredata://UUID/ICNote/pNNN`,
      "invalid_input"
    );
  return { store: match[1], pk: Number(match[2]) };
}

/**
 * Runs one constant SQL script with the note's primary key bound as `@pk`.
 * Returns stdout split into lines.
 */
export function queryNoteScoped(sql: string, pk: number, dbPath: string = NOTES_DB_PATH): string[] {
  return runReadOnlySql(dbPath, sql, { pk: { int: pk } }).split("\n");
}

/**
 * First line of every note-scoped script: whether `@pk` is a note, and whether
 * it is password-protected. Uses the entity table so a non-note row with the
 * same primary key is never mistaken for a note.
 */
export const NOTE_STATE_SQL =
  "SELECT json_object(" +
  "'found', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = @pk AND " +
  `n.Z_ENT = ${entity("ICNote")}), ` +
  "'locked', (SELECT COALESCE(n.ZISPASSWORDPROTECTED, 0) FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = @pk));";

/**
 * Throws when the state line says the note is unusable: a coded `not_found`
 * for a missing note, a coded `unsupported` for a locked one (its attachments
 * are encrypted), and a NoteStoreError for an unreadable response.
 */
export function assertNoteReadable(stateLine: string | undefined, noteId: string): void {
  let state: { found?: number; locked?: number | null };
  try {
    state = JSON.parse(stateLine || "{}");
  } catch {
    throw new NoteStoreError("Unexpected response from the Notes database.", "query_error");
  }
  if (!state.found)
    throw new CodedError(`No note found in the database for ID "${noteId}".`, {
      code: "not_found",
    });
  if (state.locked)
    throw new CodedError(
      "This note is password-protected; its attachments are encrypted and cannot be read.",
      { code: "unsupported" }
    );
}
