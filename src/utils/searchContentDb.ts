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

import { matchLocations, type QueryNode } from "@/utils/noteQuery.js";
import {
  countWords,
  NOTE_TEXT_BATCH_MAX,
  NoteQueryStoreError,
  readNoteTexts,
  runNoteQuery,
} from "@/utils/noteQueryStore.js";
import type { Note, QueryNotesResult, SearchMatchDetails } from "@/types.js";

/** A search-notes result with its optional match details. */
export type SearchHit = Note & SearchMatchDetails;

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
  /** Add wordCount to each hit (the bodies are already decoded for the search). */
  includeWordCount?: boolean;
  /** Test hook: a fixture NoteStore. Production never sets it. */
  dbPath?: string;
}

export interface SearchContentDbResult {
  notes: SearchHit[];
  /** Scan accounting from the query engine, for disclosure. */
  scan: Pick<QueryNotesResult, "scanned" | "eligible" | "scanTruncated" | "matched">;
}

/**
 * How many of the most recently modified notes a search-notes body search
 * examines. Fixed below query-notes' own ceiling: search-notes has no scan
 * parameter, so every body search pays this cost.
 */
export const SEARCH_CONTENT_SCAN_LIMIT = 5000;

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
 * {@link SEARCH_CONTENT_SCAN_LIMIT} of the most recently modified notes.
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
    scanLimit: SEARCH_CONTENT_SCAN_LIMIT,
    includeWordCount: options.includeWordCount,
    dbPath: options.dbPath,
  });
  const notes: SearchHit[] = result.notes.map((hit) => ({
    id: hit.id,
    title: hit.title,
    content: "",
    tags: [],
    created: hit.created ? new Date(hit.created) : new Date(0),
    modified: hit.modified ? new Date(hit.modified) : new Date(0),
    ...(hit.folder !== undefined ? { folder: hit.folder } : {}),
    ...(hit.account !== undefined ? { account: hit.account } : {}),
    ...(hit.matchedIn ? { matchedIn: hit.matchedIn } : {}),
    ...(hit.wordCount !== undefined ? { wordCount: hit.wordCount } : {}),
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

const NOTE_ID = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d{1,15})$/;

/** Outcome of {@link addWordCountsFromDatabase}. */
export interface WordCountEnrichment {
  notes: SearchHit[];
  /** Why the database could not be read; the notes are then returned unchanged. */
  unavailable?: NoteQueryStoreError["kind"];
}

/**
 * Adds `wordCount` and `matchedIn` to AppleScript search results by reading
 * their bodies from the NoteStore in one batched read-only query, never one
 * AppleScript call per note. `matchedIn` treats the query as a bare phrase:
 * the title, the body, or both. Notes the database does not hold (another
 * store, a stale id) get `wordCount: null` and no `matchedIn`, as do notes
 * whose text does not contain the query as this server matches it.
 *
 * Best effort: when the database cannot be read (no Full Disk Access, unknown
 * schema), the notes come back unchanged with the reason in `unavailable`.
 */
export function addWordCountsFromDatabase(
  notes: SearchHit[],
  query: string,
  options: { dbPath?: string } = {}
): WordCountEnrichment {
  const keys = new Map<SearchHit, { store: string; pk: number }>();
  for (const note of notes) {
    const match = NOTE_ID.exec(note.id ?? "");
    if (match) keys.set(note, { store: match[1].toUpperCase(), pk: Number(match[2]) });
  }
  const pks = [...new Set([...keys.values()].map((key) => key.pk))];
  let store: string | undefined;
  const texts = new Map<number, string | null>();
  try {
    // search-notes' limit is unbounded, so read in batches of the SQL cap.
    for (let start = 0; start < pks.length; start += NOTE_TEXT_BATCH_MAX) {
      const read = readNoteTexts(pks.slice(start, start + NOTE_TEXT_BATCH_MAX), options);
      store = read.uuid?.toUpperCase();
      for (const [pk, text] of read.texts) texts.set(pk, text);
    }
  } catch (error) {
    if (error instanceof NoteQueryStoreError) return { notes, unavailable: error.kind };
    throw error;
  }
  const predicates = [{ field: "any" as const, value: query }];
  return {
    notes: notes.map((note) => {
      const key = keys.get(note);
      const text = key && key.store === store ? texts.get(key.pk) : undefined;
      if (typeof text !== "string") return { ...note, wordCount: null };
      // AppleScript already matched this note, so an empty result means only
      // that its matching (such as ignoring diacritics) differs from ours: the
      // location is unknown, not "metadata", and is left out.
      const matchedIn = matchLocations(predicates, note.title, text);
      return {
        ...note,
        ...(matchedIn?.length ? { matchedIn } : {}),
        wordCount: countWords(text),
      };
    }),
  };
}

/**
 * Short text-output suffix for one result's match details, e.g.
 * ` · matched in title, body · 245 words`. Empty when neither is present.
 */
export function describeMatchDetails(hit: SearchMatchDetails): string {
  const parts: string[] = [];
  if (hit.matchedIn) {
    parts.push(
      hit.matchedIn.length ? `matched in ${hit.matchedIn.join(", ")}` : "no text match (metadata)"
    );
  }
  if (hit.wordCount !== undefined) {
    parts.push(
      hit.wordCount === null
        ? "word count unavailable"
        : `${hit.wordCount} word${hit.wordCount === 1 ? "" : "s"}`
    );
  }
  return parts.map((part) => ` · ${part}`).join("");
}
