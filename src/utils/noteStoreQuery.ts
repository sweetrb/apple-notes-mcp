/**
 * Read-only, parameterized queries against the NoteStore database.
 *
 * Every query here is a constant string. Values reach SQLite only through
 * sqlite3's own parameter table (`.parameter set :name value`), and the only
 * values accepted are non-negative integers, so no caller input is ever
 * spliced into SQL text. The database is opened with `-readonly` through
 * execFileSync with an argument array (no shell).
 *
 * @module utils/noteStoreQuery
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { FULL_DISK_ACCESS_GUIDE_URL } from "./docsUrls.js";

/** The live Notes database. Read-only access only. */
export const NOTE_STORE_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Root of the per-account attachment folders (Media, Previews, ...). */
export const NOTE_ACCOUNTS_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/Accounts"
);

export type NoteStoreErrorKind = "invalid_id" | "not_found" | "locked" | "no_fda" | "query_error";

export class NoteStoreReadError extends Error {
  constructor(
    readonly kind: NoteStoreErrorKind,
    message: string
  ) {
    super(message);
    this.name = "NoteStoreReadError";
  }
}

/** Splits an `x-coredata://<store>/ICNote/p<pk>` id into its store UUID and primary key. */
export function parseNoteObjectId(noteId: string): { store: string; pk: number } {
  const match = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d{1,15})$/.exec(noteId);
  if (!match)
    throw new NoteStoreReadError(
      "invalid_id",
      `Invalid note ID format: "${noteId}". Expected format: x-coredata://UUID/ICNote/pNNN`
    );
  return { store: match[1], pk: Number(match[2]) };
}

/**
 * Runs one constant SQL script with integer parameters bound through the
 * sqlite3 parameter table. Returns stdout split into lines.
 */
export function queryNoteStore(
  sql: string,
  params: Record<string, number>,
  dbPath: string = NOTE_STORE_PATH
): string[] {
  const args = ["-readonly"];
  for (const [name, value] of Object.entries(params)) {
    if (!/^[a-z]\w*$/i.test(name) || !Number.isSafeInteger(value) || value < 0)
      throw new NoteStoreReadError("query_error", "Invalid query parameter");
    args.push("-cmd", `.parameter set :${name} ${value}`);
  }
  args.push(dbPath, sql);
  try {
    return execFileSync("sqlite3", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).split("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message))
      throw new NoteStoreReadError(
        "no_fda",
        "Full Disk Access is required to read the Notes database. Grant it to the app that " +
          `launches this server, then fully quit and relaunch it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`
      );
    throw new NoteStoreReadError("query_error", "Failed to read the Notes database.");
  }
}

/**
 * First line of every note-scoped script: whether `:pk` is a note, and whether
 * it is password-protected. Uses the entity table so a non-note row with the
 * same primary key is never mistaken for a note.
 */
export const NOTE_STATE_SQL =
  "SELECT json_object(" +
  "'found', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = :pk AND " +
  "n.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')), " +
  "'locked', (SELECT COALESCE(n.ZISPASSWORDPROTECTED, 0) FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = :pk));";

/** Throws the matching NoteStoreReadError when the state line says the note is unusable. */
export function assertNoteReadable(stateLine: string | undefined, noteId: string): void {
  let state: { found?: number; locked?: number | null };
  try {
    state = JSON.parse(stateLine || "{}");
  } catch {
    throw new NoteStoreReadError("query_error", "Unexpected response from the Notes database.");
  }
  if (!state.found)
    throw new NoteStoreReadError("not_found", `No note found in the database for ID "${noteId}".`);
  if (state.locked)
    throw new NoteStoreReadError(
      "locked",
      "This note is password-protected; its attachments are encrypted and cannot be read."
    );
}
