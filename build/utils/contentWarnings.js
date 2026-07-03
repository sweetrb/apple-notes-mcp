/**
 * Content Warnings for create-note / update-note
 *
 * Detects content patterns that look like the user is trying to do something
 * Apple Notes via AppleScript cannot actually render — so the response can
 * carry a clear warning instead of silently producing a broken note.
 *
 * @module utils/contentWarnings
 */
/**
 * Detects checklist-like syntax in note content.
 *
 * Apple Notes checklists are a paragraph style stored in a protobuf blob in
 * the NoteStore SQLite database. AppleScript's `body of note` setter does not
 * expose paragraph styles: `<input type="checkbox">` is stripped, a
 * `class="checklist"` on `<ul>` is dropped, and markdown `- [ ]` lines in
 * `plaintext` mode arrive as literal text. There is no input that produces a
 * real checklist.
 *
 * @param content - The user-supplied note body (HTML or plaintext)
 * @returns A user-facing warning string, or null when no checklist-like
 *   patterns are present
 */
export function detectChecklistAttempt(content) {
    if (!content)
        return null;
    // HTML checkbox input — `<input type="checkbox" ...>` in either quoting style.
    const htmlCheckbox = /<input\b[^>]*\btype\s*=\s*["']checkbox["']/i.test(content);
    // Markdown-style checklist: lines starting with optional whitespace, then
    // `-` or `*`, a space, and `[ ]` / `[x]` / `[X]`.
    const markdownCheckbox = /^[ \t]*[-*]\s+\[[ xX]\]/m.test(content);
    // CSS class hint — some clients try `<ul class="checklist">` or
    // `<li class="todo">`. AppleScript drops these classes too.
    const checklistClass = /class\s*=\s*["'][^"']*\b(?:checklist|todo)\b/i.test(content);
    if (!htmlCheckbox && !markdownCheckbox && !checklistClass)
        return null;
    return ("\n\n⚠️ Your content looks like a checklist, but Apple Notes checklists " +
        'cannot be created via AppleScript — `<input type="checkbox">` is ' +
        "stripped, checklist CSS classes are dropped, and markdown `- [ ]` lines " +
        "arrive as literal text. The note was created with the surrounding " +
        "structure (list items or paragraphs) intact. To convert it to a real " +
        "Apple Notes checklist, open the note, select the items, and press " +
        "⇧⌘L (Format → Checklist).");
}
