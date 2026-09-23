/**
 * Database-backed body search for `search-notes` (`searchContent: true`).
 *
 * The AppleScript body search (`notes where body contains "…"`) makes Notes.app
 * render and scan every note body before any result limit applies, so a broad
 * query ("the") times out at 30 seconds even with the default limit (#100). When
 * Full Disk Access is available, the same question is answered from the
 * NoteStore database through the `query-notes` engine in a fraction of a second.
 *
 * The query is assembled as an AST, never as a query-language string, so the
 * caller's text cannot be read as a field (`title:`), an operator (`OR`, `-`),
 * or a quote: it is always one literal, case-insensitive substring.
 *
 * @module utils/searchContentDb
 */

import type { QueryNode } from "@/utils/noteQuery.js";
import { QUERY_SCAN, runNoteQuery } from "@/utils/noteQueryStore.js";
import type { Note, QueryNotesResult } from "@/types.js";

export interface SearchContentDbOptions {
  /** Literal text to find in the note (title line included, as AppleScript's `body` does). */
  query: string;
  /** Account to restrict to; undefined searches every account. */
  account?: string;
  /** Folder name or list-folders path to restrict to. */
  folder?: string;
  /** ISO 8601 date; only notes modified on or after it match. Unparseable values are ignored, as in the AppleScript path. */
  modifiedSince?: string;
  /** Result cap (search-notes' effective limit). */
  limit: number;
  /** Test hook: a fixture NoteStore. Production never sets it. */
  dbPath?: string;
}

export interface SearchContentDbResult {
  notes: Note[];
  /** Scan accounting from the query engine, for disclosure. */
  scan: Pick<QueryNotesResult, "scanned" | "eligible" | "scanTruncated" | "matched">;
}

/** Builds the AST for one search-notes body search. Exported for tests. */
export function buildSearchContentQuery(
  options: Pick<SearchContentDbOptions, "query" | "account" | "folder" | "modifiedSince">
): QueryNode {
  const children: QueryNode[] = [{ type: "text", field: "any", value: options.query }];
  const folder = options.folder?.trim();
  if (folder) children.push({ type: "folder", value: folder });
  const account = options.account?.trim();
  if (account) children.push({ type: "account", value: account });
  if (options.modifiedSince) {
    const start = new Date(options.modifiedSince).getTime();
    if (Number.isFinite(start)) {
      children.push({
        type: "date",
        field: "modified",
        op: ">=",
        date: options.modifiedSince,
        start,
        end: start + 24 * 60 * 60 * 1000,
      });
    }
  }
  return children.length === 1 ? children[0] : { type: "and", children };
}

/**
 * Runs a search-notes body search against the NoteStore, scanning up to
 * {@link QUERY_SCAN.MAX} of the most recently modified notes.
 *
 * Recently Deleted and folderless notes are excluded, as in query-notes and
 * list-notes.
 *
 * @throws NoteQueryStoreError when the database cannot be read (no Full Disk
 *   Access, unknown schema, sqlite failure) — the caller falls back to AppleScript
 */
export function searchContentViaDatabase(options: SearchContentDbOptions): SearchContentDbResult {
  const result = runNoteQuery(buildSearchContentQuery(options), {
    limit: options.limit,
    scanLimit: QUERY_SCAN.MAX,
    dbPath: options.dbPath,
  });
  const notes: Note[] = result.notes.map((hit) => ({
    id: hit.id,
    title: hit.title,
    content: "",
    tags: [],
    created: hit.created ? new Date(hit.created) : new Date(0),
    modified: hit.modified ? new Date(hit.modified) : new Date(0),
    ...(hit.folder !== undefined ? { folder: hit.folder } : {}),
    ...(hit.account !== undefined ? { account: hit.account } : {}),
  }));
  return {
    notes,
    scan: {
      scanned: result.scanned,
      eligible: result.eligible,
      scanTruncated: result.scanTruncated,
      matched: result.matched,
    },
  };
}

/** Where a search-notes body search was answered from. */
export type ContentSearchSource = "database" | "applescript";

/**
 * Trailing note for a database-backed body search whose scan window did not
 * cover the whole library, so the caller knows older notes were not searched.
 */
export function describeContentScan(scan: SearchContentDbResult["scan"] | undefined): string {
  if (!scan?.scanTruncated) return "";
  return (
    `\n\nℹ️ Searched the ${scan.scanned} most recently modified of ${scan.eligible} notes; ` +
    "older notes were not searched. A title search (`searchContent: false`) covers every note."
  );
}

/**
 * Appends guidance to an AppleScript body-search failure that happened after
 * the database path was unavailable. A timeout there is the #100 failure mode:
 * Notes.app scans every body before any limit applies.
 *
 * @param message - the original error message
 * @param dbUnavailable - why the database path was skipped (a NoteQueryStoreError kind)
 */
export function contentSearchFailureHint(
  message: string,
  dbUnavailable: "no_fda" | "schema" | "query_error" | undefined
): string {
  if (!/timed out/i.test(message)) return message;
  const remedy =
    dbUnavailable === "no_fda"
      ? " Grant Full Disk Access to the Node binary running this server (run the doctor tool for its path) so search-notes can search note bodies through the Notes database instead, which takes well under a second."
      : "";
  return (
    `${message} Body search through AppleScript scans every note body before the result limit applies, ` +
    `so a broad term can exceed the time budget on a large library.${remedy} ` +
    "Otherwise narrow the search with `folder` or `modifiedSince`, or use a more specific term."
  );
}
