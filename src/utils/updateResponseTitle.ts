/**
 * Resolve the title reported by update-note without claiming that `newTitle`
 * changed an HTML note. In HTML mode Apple Notes derives the visible title
 * from the first line of `newContent`, and the manager intentionally ignores
 * the separate `newTitle` argument.
 */
export function resolveUpdateResponseTitle(
  currentTitle: string,
  newTitle: string | undefined,
  format: "plaintext" | "html"
): string {
  if (format === "html") return currentTitle;
  return newTitle || currentTitle;
}
