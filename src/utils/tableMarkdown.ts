/**
 * GitHub-flavored Markdown rendering for decoded native Notes tables.
 *
 * Notes tables have no header concept, but a GFM table requires one, so the
 * first stored row becomes the header row. Cell text is rendered verbatim
 * apart from the escaping GFM needs to keep the grid intact.
 *
 * @module utils/tableMarkdown
 */

import type { NoteTable, NoteTablesResult } from "@/types.js";
import type { RichNote } from "@/utils/noteRichText.js";
import { parseNoteTableCells } from "@/utils/noteTables.js";

/** Markdown shown in place of a cell that could not be decoded. Never guessed text. */
export const UNDECODED_CELL_MARKER = "[undecoded cell]";

/**
 * Escape one cell's text for a GFM table row.
 *
 * - Backslashes are doubled first, so an existing `\` cannot swallow the pipe
 *   escape that follows it (`a\|b` stays literal instead of splitting a cell).
 * - Pipes become `\|` (the GFM spec's escape for a literal pipe in a cell).
 * - Line breaks (CRLF, CR, LF, U+2028, U+2029) become `<br>`, because a raw newline
 *   ends the table row. GFM renders `<br>` inside a cell as a line break.
 */
export function escapeMarkdownTableCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|[\r\n\u2028\u2029]/g, "<br>");
}

/**
 * Render rows as a GFM table. `null` cells (undecodable) render as
 * {@link UNDECODED_CELL_MARKER}. Short rows are padded with empty cells so the
 * grid is always rectangular. Returns an empty string for an empty table.
 */
export function renderMarkdownTable(rows: ReadonlyArray<ReadonlyArray<string | null>>): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length === 0 || width === 0) return "";
  const line = (row: ReadonlyArray<string | null>) =>
    "| " +
    Array.from({ length: width }, (_, i) => {
      const cell = row[i];
      return cell === null ? UNDECODED_CELL_MARKER : escapeMarkdownTableCell(cell ?? "");
    }).join(" | ") +
    " |";
  const [header, ...body] = rows;
  return [line(header), "| " + Array(width).fill("---").join(" | ") + " |", ...body.map(line)].join(
    "\n"
  );
}

/**
 * Decode every native table referenced by one note's rich text, in body order.
 *
 * Tables are ordered by their position in the note body. A table whose stored
 * data is missing or structurally undecodable is returned with `complete: false`
 * and a `reason`, never with partial or invented rows.
 *
 * @param rich - Result of readRichNote for the note
 * @param noteId - The note's CoreData id, used to derive each table's attachment id
 */
export function collectNoteTables(rich: RichNote, noteId: string): NoteTablesResult {
  const seen = new Set<string>();
  const ordered = (rich.objects || [])
    .filter((object) => object.type.includes("table"))
    .sort((a, b) => a.start - b.start)
    .filter((object) => {
      if (seen.has(object.id)) return false;
      seen.add(object.id);
      return true;
    });
  const tables: NoteTable[] = ordered.map((object, i) => {
    const index = i + 1;
    const data = (rich.objectData || []).find((row) => row.id === object.id);
    if (!data || !data.mergeable) {
      return { index, id: object.id, complete: false, reason: "Native table data is unavailable" };
    }
    const attachmentId = noteId.replace(/ICNote\/p\d+$/, `ICAttachment/p${data.pk}`);
    try {
      const table = parseNoteTableCells(Buffer.from(data.mergeable, "hex"));
      const complete = table.incompleteCells.length === 0;
      return {
        index,
        id: object.id,
        attachmentId,
        complete,
        ...(complete
          ? {}
          : { reason: `${table.incompleteCells.length} cell(s) could not be decoded` }),
        rows: table.rows,
        rowIds: table.rowIds,
        columnIds: table.columnIds,
        rowCount: table.rowIds.length,
        columnCount: table.columnIds.length,
        incompleteCells: table.incompleteCells,
        markdown: renderMarkdownTable(table.rows),
      };
    } catch (error) {
      return {
        index,
        id: object.id,
        attachmentId,
        complete: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const markdown = tables
    .map((table) =>
      table.markdown !== undefined
        ? table.markdown
        : `[table ${table.index} could not be decoded: ${table.reason}]`
    )
    .join("\n\n");
  return { tables, tableCellsComplete: tables.every((table) => table.complete), markdown };
}
