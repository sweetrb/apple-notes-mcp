/**
 * First-seen deduplication by identifier.
 *
 * Notes.app can enumerate the same object more than once: `id of notes of
 * account` has been seen to list one note twice (#183), and a freshly added
 * attachment can appear twice in both the AppleScript attachment list and
 * the note's attribute runs (#197). Every enumeration that reports objects by
 * identifier passes its rows through here so each identifier appears once.
 *
 * @module utils/uniqueById
 */

/**
 * Returns the items with repeated `id`s removed, keeping the first occurrence
 * of each identifier and the original order. Items with an empty id are kept
 * as-is: an empty id identifies nothing, so two of them are not duplicates.
 */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (item.id) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    result.push(item);
  }
  return result;
}
