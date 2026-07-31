/**
 * Build the advisory fragment that discloses a title-only search on an empty result.
 *
 * `search-notes` matches note titles unless the caller passes `searchContent: true`,
 * and the two modes are exclusive: the AppleScript `whose` clause is built as either
 * `name contains` or `body contains`, never both. A title-only search that matches
 * nothing therefore returns `{"notes":[],"count":0}` for a term that may appear in
 * dozens of note bodies, and nothing in that response says bodies were never read.
 * The obvious reading is "no such note exists", which is a silent false negative: the
 * tool does not error, it confidently reports absence.
 *
 * The hint fires only on the empty result, so an ordinary successful search is
 * unchanged and no extra AppleScript work is done. Search behaviour is untouched;
 * this is disclosure only, mirroring how the applied result cap is disclosed by
 * `describeSearchLimit` in ./searchLimit.ts.
 *
 * @param searchContent - true when the caller asked for a body search
 * @param resultCount - number of notes returned after dedup
 * @returns a trailing hint, empty unless a title-only search returned nothing
 */
export function describeSearchScope(searchContent: boolean, resultCount: number): string {
  if (searchContent || resultCount > 0) {
    return "";
  }
  return (
    "\n\nℹ️ Only note titles were searched, so a term that appears in note bodies " +
    "would not match. Retry with `searchContent: true` to search bodies instead."
  );
}
