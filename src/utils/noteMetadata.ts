/**
 * Apple Notes Read-Only Metadata Reader [BETA]
 *
 * Reads note metadata that the AppleScript dictionary does not expose (pinned
 * state, checklist flags, trash/recovery, preview snippet, password hint) by
 * querying the NoteStore SQLite database directly.
 *
 * Unlike the note body (a gzipped protobuf blob in ZICNOTEDATA.ZDATA), these are
 * plain scalar columns on ZICCLOUDSYNCINGOBJECT, so no protobuf decoding is
 * needed — an ordinary SELECT is enough.
 *
 * BETA / safety:
 * - The database is opened READ-ONLY (`sqlite3 -readonly`). This code never
 *   writes to the live store; doing so would corrupt CloudKit sync state.
 * - Requires Full Disk Access for the host process.
 * - The schema changes between macOS releases, so the reader feature-detects
 *   which columns exist (PRAGMA table_info) and only selects those.
 *
 * @module utils/noteMetadata
 * @see TECHNICAL_NOTES.md#read-only-metadata-columns-verified-macos-27--notes-413
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

const FDA_MESSAGE =
  "Full Disk Access is required to read note metadata. " +
  "Grant access in System Settings > Privacy & Security > Full Disk Access, " +
  "then add and restart this application.";

/**
 * Read-only metadata for a single note. Every field is optional: a field is
 * absent when the column does not exist on this macOS version or is NULL.
 */
export interface NoteMetadata {
  /** Whether the note is pinned (AppleScript cannot read this). */
  pinned?: boolean;
  /** Whether the note contains a checklist. */
  hasChecklist?: boolean;
  /** Whether the note has at least one unchecked checklist item. */
  hasChecklistInProgress?: boolean;
  /** Whether the note is being recovered from the trash. */
  recoveringFromTrash?: boolean;
  /** Whether the note is password-protected. */
  passwordProtected?: boolean;
  /** The password hint, if one is set. */
  passwordHint?: string;
  /** The note's preview snippet. */
  snippet?: string;
  /** The widget preview snippet. */
  widgetSnippet?: string;
  /** Smart Folder query JSON (set on smart-folder objects, not regular notes). */
  smartFolderQuery?: string;
}

/**
 * Result from getNoteMetadata with error classification for actionable messages.
 */
export interface NoteMetadataResult {
  /** Metadata object, or null on failure. */
  metadata: NoteMetadata | null;
  error?: "no_fda" | "invalid_id" | "not_found" | "query_error";
  message?: string;
}

/**
 * Friendly field name -> NoteStore column. This is a fixed allowlist; nothing
 * here is built from user input, so the column names are never an injection
 * vector. `bool` columns store 0/1; `text` columns store strings.
 */
const COLUMN_MAP: Array<{ key: keyof NoteMetadata; column: string; type: "bool" | "text" }> = [
  { key: "pinned", column: "ZISPINNED", type: "bool" },
  { key: "hasChecklist", column: "ZHASCHECKLIST", type: "bool" },
  { key: "hasChecklistInProgress", column: "ZHASCHECKLISTINPROGRESS", type: "bool" },
  { key: "recoveringFromTrash", column: "ZISRECOVERINGFROMTRASH", type: "bool" },
  { key: "passwordProtected", column: "ZISPASSWORDPROTECTED", type: "bool" },
  { key: "passwordHint", column: "ZPASSWORDHINT", type: "text" },
  { key: "snippet", column: "ZSNIPPET", type: "text" },
  { key: "widgetSnippet", column: "ZWIDGETSNIPPET", type: "text" },
  { key: "smartFolderQuery", column: "ZSMARTFOLDERQUERYJSON", type: "text" },
];

/**
 * Runs a read-only sqlite3 query against the live NoteStore and returns trimmed
 * stdout. Throws on failure (callers classify the error).
 *
 * Uses execFileSync with an argument array (no shell), so the database path's
 * spaces and the query string are passed verbatim and shell metacharacters are
 * never interpreted. The only dynamic value in any query is the note's primary
 * key, which callers constrain to digits before it reaches here.
 */
function runSqlite(query: string): string {
  return execFileSync("sqlite3", ["-readonly", NOTES_DB_PATH, query], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Returns the set of column names present on ZICCLOUDSYNCINGOBJECT, so the
 * reader can skip columns that do not exist on this macOS version.
 */
function presentColumns(): Set<string> {
  const out = runSqlite("PRAGMA table_info(ZICCLOUDSYNCINGOBJECT);");
  const cols = new Set<string>();
  for (const line of out.split("\n")) {
    // Each row: cid|name|type|notnull|dflt_value|pk
    const name = line.split("|")[1];
    if (name) cols.add(name);
  }
  return cols;
}

/**
 * Reads read-only metadata for a note by its CoreData ID.
 *
 * @param noteId - CoreData URL identifier (e.g., "x-coredata://ABC/ICNote/p123")
 * @returns Structured result with the metadata, an error type, and a message
 */
export function getNoteMetadata(noteId: string): NoteMetadataResult {
  const pkMatch = noteId.match(/\/p(\d+)$/);
  if (!pkMatch) {
    return {
      metadata: null,
      error: "invalid_id",
      message: `Invalid note ID format: "${noteId}". Expected format: x-coredata://UUID/ICNote/pNNN`,
    };
  }
  const pk = pkMatch[1];

  if (!fs.existsSync(NOTES_DB_PATH)) {
    return { metadata: null, error: "no_fda", message: FDA_MESSAGE };
  }

  try {
    const available = presentColumns();
    const selected = COLUMN_MAP.filter((c) => available.has(c.column));
    if (selected.length === 0) {
      // Schema has none of the known columns (very old or very new macOS).
      return { metadata: {} };
    }

    const pairs = selected.map((c) => `'${c.key}', ${c.column}`).join(", ");
    const row = runSqlite(
      `SELECT json_object(${pairs}) FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ${pk};`
    );
    if (!row) {
      return {
        metadata: null,
        error: "not_found",
        message: `No note found in the database for ID "${noteId}".`,
      };
    }

    const raw = JSON.parse(row) as Record<string, unknown>;
    const metadata: Record<string, boolean | string> = {};
    for (const c of selected) {
      const value = raw[c.key];
      if (value === null || value === undefined) continue;
      if (c.type === "bool") {
        metadata[c.key] = value === 1 || value === "1" || value === true;
      } else {
        metadata[c.key] = String(value);
      }
    }

    return { metadata: metadata as NoteMetadata };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("authorization denied") || message.includes("unable to open database")) {
      return { metadata: null, error: "no_fda", message: FDA_MESSAGE };
    }
    console.error(`Failed to read note metadata: ${message}`);
    return { metadata: null, error: "query_error", message: "Failed to read note metadata." };
  }
}
