/**
 * Checklist attribute-run helpers shared by the Notes rich-text parsers.
 *
 * @module utils/checklistRuns
 */

/**
 * Returns the start offset of the line that a checklist attribute run styles.
 *
 * Notes stores a paragraph style on the attribute runs that cover the
 * paragraph's text, and two layouts are in use:
 *
 * - `"Item\n"`: the run starts at the line's first character and ends with the
 *   line's own terminating newline (the long-standing layout).
 * - `"\nItem"`: the run starts on the newline *before* the line. macOS 27.2
 *   stores an appended checklist item this way, and renders the preceding
 *   line as plain text, so that newline does not make it a checklist (#187).
 *
 * Both layouts are resolved by attributing the run to the line of its first
 * non-newline character. A run made only of newlines has no such character;
 * it is the split-off terminator of the line it ends (Notes splits a line's
 * runs when its characters carry different attributes), so it stays with
 * that line.
 */
export function checklistRunLineStart(text: string, position: number, length: number): number {
  const end = position + length;
  let anchor = position;
  while (anchor < end && text[anchor] === "\n") anchor++;
  if (anchor === end) anchor = position;
  return anchor === 0 ? 0 : text.lastIndexOf("\n", anchor - 1) + 1;
}
