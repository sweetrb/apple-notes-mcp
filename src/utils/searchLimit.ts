/**
 * Default result cap applied to `search-notes` when the caller does not pass an
 * explicit `limit`.
 *
 * `search-notes` reads several properties per matching note via AppleScript
 * (~200ms/note on an iCloud library), so an unbounded broad query — e.g. `"a"`
 * matching hundreds of titles — exceeds the 30s AppleScript budget and returns a
 * timeout *error* instead of any results (issue #100). Capping the common broad
 * search keeps it fast and useful; the cap is always disclosed in the response
 * (see {@link describeSearchLimit}) so the truncation is visible rather than silent.
 *
 * This only bounds the per-note read loop, not the underlying `whose` clause, so a
 * pathological query matching thousands of notes can still be slow — but the common
 * "broad query on an ordinary library" case goes from guaranteed failure to a useful
 * answer.
 */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Resolve the effective result cap for a search.
 *
 * Returns the floored positive `limit` when the caller supplied one, otherwise
 * {@link DEFAULT_SEARCH_LIMIT}. A non-positive or non-finite value is treated as
 * unset (the tool schema already rejects those, so this is defensive).
 */
export function resolveSearchLimit(limit?: number): number {
  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }
  return DEFAULT_SEARCH_LIMIT;
}

/**
 * Build the disclosure fragments appended to a search response so the applied cap —
 * and any truncation it caused — is always visible to the caller.
 *
 * @param effectiveLimit - the cap actually passed to the search
 * @param wasDefault - true when the cap is {@link DEFAULT_SEARCH_LIMIT} because no
 *   explicit `limit` was supplied
 * @param resultCount - number of notes returned after dedup
 * @returns `info` (a `(limit: N[, default])` fragment for the summary line) and
 *   `truncationNote` (a trailing hint, empty unless the result hit the cap)
 */
export function describeSearchLimit(
  effectiveLimit: number,
  wasDefault: boolean,
  resultCount: number
): { info: string; truncationNote: string } {
  const info = ` (limit: ${effectiveLimit}${wasDefault ? ", default" : ""})`;
  const truncationNote =
    resultCount >= effectiveLimit
      ? `\n\nℹ️ Showing the first ${effectiveLimit}${wasDefault ? " (default limit)" : ""}; there may be more. ` +
        "Narrow the query, filter with `folder`/`modifiedSince`, or pass a higher `limit` to see additional matches."
      : "";
  return { info, truncationNote };
}
