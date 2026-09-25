/**
 * MCP tools for native table edits through the opt-in private WRITER.
 *
 * - `native-read-tables`: every active table in a note, with native row and
 *   column identifiers, cell text, visibility, and both CAS tokens.
 * - `native-delete-table-row`: attended two-phase row deletion by identifier.
 * - `native-insert-table-row`, `native-set-table-cell`: guarded row insert
 *   and cell text edit.
 * - `native-prune-orphan-table`: attended two-phase tombstoning of a table
 *   attachment that no body glyph shows.
 *
 * All five share the writer envelope from privateWriterTools.ts. Applies
 * accept the optional move-in-place `nudge`; it reports on the note record,
 * not on the table attachment's own upload.
 *
 * @module tools/privateWriterTableTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import {
  MAX_CELL_TEXT,
  TABLE_DIGEST,
  deleteTableRow,
  insertTableRow,
  pruneOrphanTable,
  readTables,
  setTableCell,
} from "../services/privateWriterTables.js";
import {
  coreDataId,
  defaultWriterToolDeps,
  notesUuid,
  nudgeAfterWrite,
  registerWriterTool,
  resolveIdentifier,
  revisionToken,
  type WriterToolDeps,
} from "./privateWriterTools.js";
import { scopeGuardFrom, writerScopeGuardInput } from "../services/privateWriterScope.js";

const uuid = (what: string) => notesUuid.describe(what);
const noteRef = {
  identifier: notesUuid.optional().describe("Notes UUID of the note that holds the table"),
  id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
};
const ifRevision = revisionToken.describe(
  "The note `revision` from native-read-tables or the dry run"
);
const ifTableDigest = z
  .string()
  .regex(TABLE_DIGEST)
  .describe("The table `digest` from native-read-tables, or `tableDigest` from the dry run");
const cellText = z.string().max(MAX_CELL_TEXT);
const nudgeFields = {
  nudge: z
    .boolean()
    .optional()
    .describe(
      "After a verified apply, ask Notes.app to upload the note by moving it into its own folder (default false; ignored on a dry run)"
    ),
  nudgeWaitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_NUDGE_WAIT_SECONDS)
    .optional()
    .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
};

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

const GATE =
  "Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, and a built writer (setup --native-writer); applying (not a dry run) also requires APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1 until this path is live-validated. nudge: true runs the move-in-place sync nudge after a verified apply; its uploadRecorded covers the note record, not the table attachment.";

/** Run the nudge only after a verified apply the caller asked to nudge. */
async function withNudge(
  result: Record<string, unknown>,
  identifier: string,
  args: { nudge?: boolean; nudgeWaitSeconds?: number },
  deps: WriterToolDeps
): Promise<Record<string, unknown>> {
  if (!args.nudge || result.committed !== true) return { ...result };
  return { ...result, sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge) };
}

export function registerPrivateWriterTableTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-read-tables",
    "Use when: you need a note's native tables with stable row and column identifiers, before native-delete-table-row, native-insert-table-row, native-set-table-cell, or native-prune-orphan-table; or to find orphaned tables (table attachments no body glyph shows).\n" +
      "Returns: the note `revision`, and per active table its `identifier`, `glyphCount`, `orphan` flag, `digest` (pass as ifTableDigest), `rowCount`, `columnCount`, `columnIdentifiers`, and `rows` ({identifier, cells}). A table too large or without unique identities reports `readable: false`.\n" +
      "Do not use when: you only want table text as Markdown or a grid (get-note-tables). Row identifiers here are native CRDT identities and are the only ones the native table tools accept.\n" +
      "Safety: read-only; the writer opens the store with Core Data's read-only option. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, and a built writer.",
    noteRef,
    { readOnlyHint: true, openWorldHint: false },
    (args, deps) => ({ ...readTables(resolveIdentifier(manager, args), deps.writer) })
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-delete-table-row",
    "Use when: removing one exact row from a native Notes table, selected by its native row identifier from native-read-tables. Two phases: call with dryRun: true, show the returned row cells to the user, then apply with dryRun: false plus the plan's `revision` as ifRevision and `tableDigest` as ifTableDigest.\n" +
      "Returns: dry run: the row's index, cells, and the two tokens (nothing written). Apply: committed/verified, revisionBefore/After, tableDigestBefore/After, the new row count, and sync state (pushScheduled is always false).\n" +
      "Do not use when: the table is not visible in the body (use native-prune-orphan-table for orphans), or it is the table's only row.\n" +
      "Safety: deletes table content through unsupported private API, attended. Refuses locked, shared, trashed, and still-downloading notes. Refuses on any change to the note or table since the dry run (revision_conflict / attachment_conflict, committed: false). Saves once with optimistic locking and verifies through a fresh Core Data stack that the body is untouched and the table equals the plan. A timeout on apply is indeterminate (indeterminate: true): read the tables again before any retry. " +
      GATE,
    {
      ...noteRef,
      tableIdentifier: uuid("Table attachment identifier from native-read-tables"),
      rowIdentifier: uuid("Native row identifier from native-read-tables"),
      dryRun: z.boolean().describe("true = plan only; false = apply the planned deletion"),
      ifRevision: ifRevision.optional(),
      ifTableDigest: ifTableDigest.optional(),
      ...writerScopeGuardInput(),
      ...nudgeFields,
    },
    DESTRUCTIVE,
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = deleteTableRow(
        {
          identifier,
          tableIdentifier: args.tableIdentifier,
          rowIdentifier: args.rowIdentifier,
          dryRun: args.dryRun,
          ifRevision: args.ifRevision,
          ifTableDigest: args.ifTableDigest,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      return withNudge(result, identifier, args, deps);
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-insert-table-row",
    "Use when: adding one row to a native Notes table, after a given row or at the end, with optional plain-text cells.\n" +
      "Returns: committed/verified, the new `rowIdentifier` and `rowIndex`, revisionBefore/After, tableDigestBefore/After (chain tableDigestAfter and revisionAfter into the next table write), and sync state.\n" +
      "Do not use when: creating a new table (create-table) or the table is an orphan.\n" +
      "Safety: writes through unsupported private API. Needs ifRevision and ifTableDigest from a fresh native-read-tables and refuses on any change since. Cells are plain text (tabs and \\n allowed). Verified by a fresh read-back. A timeout is indeterminate. " +
      GATE,
    {
      ...noteRef,
      tableIdentifier: uuid("Table attachment identifier from native-read-tables"),
      afterRowIdentifier: uuid("Insert after this row; omit to append at the end").optional(),
      cells: z
        .array(cellText)
        .max(1000)
        .optional()
        .describe("Cell text by column order; missing trailing cells stay empty"),
      ifRevision,
      ifTableDigest,
      ...writerScopeGuardInput(),
      ...nudgeFields,
    },
    WRITE,
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = insertTableRow(
        {
          identifier,
          tableIdentifier: args.tableIdentifier,
          afterRowIdentifier: args.afterRowIdentifier,
          cells: args.cells,
          ifRevision: args.ifRevision,
          ifTableDigest: args.ifTableDigest,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      return withNudge(result, identifier, args, deps);
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-set-table-cell",
    "Use when: replacing the text of one cell in a native Notes table, addressed by native row and column identifiers.\n" +
      "Returns: committed/verified, `previousText`, revisionBefore/After, tableDigestBefore/After, and sync state.\n" +
      "Do not use when: the cell holds formatting you want to keep (the new text is plain), or the table is an orphan.\n" +
      "Safety: writes through unsupported private API. Needs ifRevision and ifTableDigest from a fresh native-read-tables and refuses on any change since. Verified by a fresh read-back. A timeout is indeterminate. " +
      GATE,
    {
      ...noteRef,
      tableIdentifier: uuid("Table attachment identifier from native-read-tables"),
      rowIdentifier: uuid("Native row identifier"),
      columnIdentifier: uuid("Native column identifier"),
      text: cellText.describe("New plain text for the cell; may be empty"),
      ifRevision,
      ifTableDigest,
      ...writerScopeGuardInput(),
      ...nudgeFields,
    },
    WRITE,
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = setTableCell(
        {
          identifier,
          tableIdentifier: args.tableIdentifier,
          rowIdentifier: args.rowIdentifier,
          columnIdentifier: args.columnIdentifier,
          text: args.text,
          ifRevision: args.ifRevision,
          ifTableDigest: args.ifTableDigest,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      return withNudge(result, identifier, args, deps);
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-prune-orphan-table",
    "Use when: removing one orphaned table from a note: an active table attachment that native-read-tables reports with `orphan: true` (no glyph in the body, so Notes does not show it, but it still syncs). Two phases: dryRun: true, show the plan (row/column counts and first row) to the user, then apply with dryRun: false plus the plan's `revision` and `tableDigest`.\n" +
      "Returns: dry run: the plan and tokens (nothing written). Apply: committed/verified, `removedTableIdentifier`, active table counts before and after, revisionBefore/After, and sync state.\n" +
      "Do not use when: the table is visible in the body (the writer refuses), or you want to delete a visible table.\n" +
      "Safety: tombstones the attachment the way Notes deletes one (it goes away on other devices once Notes uploads); the body is never edited. Attended and guarded like native-delete-table-row; verified by a fresh read-back. The note `revision` does not change, because the body and modification date do not. " +
      GATE,
    {
      ...noteRef,
      tableIdentifier: uuid("Orphaned table attachment identifier from native-read-tables"),
      dryRun: z.boolean().describe("true = plan only; false = apply the planned prune"),
      ifRevision: ifRevision.optional(),
      ifTableDigest: ifTableDigest.optional(),
      ...writerScopeGuardInput(),
      ...nudgeFields,
    },
    DESTRUCTIVE,
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = pruneOrphanTable(
        {
          identifier,
          tableIdentifier: args.tableIdentifier,
          dryRun: args.dryRun,
          ifRevision: args.ifRevision,
          ifTableDigest: args.ifTableDigest,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      return withNudge(result, identifier, args, deps);
    }
  );
}
