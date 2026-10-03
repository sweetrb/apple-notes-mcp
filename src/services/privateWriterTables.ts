/**
 * Native table actions of the opt-in private writer.
 *
 * Notes tables are CRDT documents stored on their attachment. Each row and
 * column has a stable native identifier, so every action here selects rows,
 * columns, and tables by identifier, never by position alone.
 *
 * Writes use two compare-and-swap tokens: `ifRevision` (the note's revision,
 * covering the body) and `ifTableDigest` (the table attachment's serialized
 * document). Row deletion and orphan pruning are two-phase: a dry run opens
 * the store read-only and returns the plan and both tokens, and the apply
 * must present them unchanged. Every apply follows the writer contract in
 * privateWriter.ts (both switches, the live-validation gate, a fresh
 * read-back, and `committed` on every failure).
 *
 * @module services/privateWriterTables
 */
import { z } from "zod";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";
import {
  PrivateWriteError,
  TABLE_WRITES_LIVE_VALIDATED,
  assertNoteIdentifier,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  writeSyncFields,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

export const REVISION_TOKEN = /^r1:[a-f0-9]{64}$/;
export const TABLE_DIGEST = /^t1:[a-f0-9]{64}$/;
export const MAX_CELL_TEXT = 10_000;

const revision = z.string().regex(REVISION_TOKEN);
const tableDigest = z.string().regex(TABLE_DIGEST);

export const tableSchema = z
  .object({
    identifier: z.string(),
    glyphCount: z.number().int(),
    orphan: z.boolean(),
    digest: tableDigest,
    readable: z.boolean(),
    unreadableReason: z.string().optional(),
    rowCount: z.number().int().optional(),
    columnCount: z.number().int().optional(),
    columnIdentifiers: z.array(z.string()).optional(),
    rows: z.array(z.object({ identifier: z.string(), cells: z.array(z.string()) })).optional(),
  })
  .passthrough();
export type NativeTable = z.infer<typeof tableSchema>;

export const readTablesSchema = z
  .object({
    status: z.literal("ok"),
    identifier: z.string(),
    revision,
    deletedOrInTrash: z.boolean(),
    sharedViaICloud: z.boolean(),
    tableCount: z.number().int(),
    tables: z.array(tableSchema),
  })
  .passthrough();
export type NativeTables = z.infer<typeof readTablesSchema>;

const planBase = {
  status: z.literal("planned"),
  dryRun: z.literal(true),
  committed: z.literal(false),
  identifier: z.string(),
  tableIdentifier: z.string(),
  revision,
  tableDigest,
};

export const tableWriteResultSchema = z
  .object({
    status: z.literal("updated"),
    dryRun: z.literal(false),
    committed: z.literal(true),
    verified: z.literal(true),
    identifier: z.string(),
    tableIdentifier: z.string(),
    revisionBefore: revision,
    revisionAfter: revision,
    tableDigestBefore: tableDigest,
    tableDigestAfter: tableDigest,
    rowCount: z.number().int(),
    columnCount: z.number().int(),
    ...writeSyncFields,
  })
  .passthrough();
export type TableWriteResult = z.infer<typeof tableWriteResultSchema>;

export const deleteRowPlanSchema = z
  .object({
    ...planBase,
    rowIdentifier: z.string(),
    rowIndex: z.number().int(),
    rowCells: z.array(z.string()),
    rowCountBefore: z.number().int(),
    columnCount: z.number().int(),
  })
  .passthrough();

export const prunePlanSchema = z
  .object({
    ...planBase,
    glyphCount: z.literal(0),
    activeTableCountBefore: z.number().int(),
    readable: z.boolean(),
  })
  .passthrough();

export const pruneResultSchema = z
  .object({
    status: z.literal("updated"),
    dryRun: z.literal(false),
    committed: z.literal(true),
    verified: z.literal(true),
    identifier: z.string(),
    tableIdentifier: z.string(),
    removedTableIdentifier: z.string(),
    activeTableCountBefore: z.number().int(),
    activeTableCountAfter: z.number().int(),
    revisionBefore: revision,
    revisionAfter: revision,
    ...writeSyncFields,
  })
  .passthrough();

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CELL_TEXT = /[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFFC\u2028\u2029]/u;

function invalid(message: string): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, false);
}

/** Cell text may be empty; otherwise it follows the writer's plain-text rules. */
export function assertCellText(text: string): void {
  if (text.length > MAX_CELL_TEXT)
    throw invalid(`cell text exceeds ${MAX_CELL_TEXT} UTF-16 code units`);
  if (FORBIDDEN_CELL_TEXT.test(text))
    throw invalid("cell text may contain only printable characters, tabs and \\n newlines");
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw invalid(`${field} must be a UUID`);
}

interface Guards {
  ifRevision?: string;
  ifTableDigest?: string;
  /** Folder preconditions, checked by the writer just before the save (and in a dry run). */
  scope?: ScopeGuard;
}

function assertGuards(guards: Guards): asserts guards is Required<Guards> {
  if (!guards.ifRevision || !REVISION_TOKEN.test(guards.ifRevision))
    throw invalid("ifRevision must be the `revision` from native-read-tables or a dry run");
  if (!guards.ifTableDigest || !TABLE_DIGEST.test(guards.ifTableDigest))
    throw invalid(
      "ifTableDigest must be the table `digest` from native-read-tables or `tableDigest` from a dry run"
    );
}

/** A dry run carries no guards; an apply carries both. */
function modeFields(dryRun: boolean, guards: Guards): Record<string, unknown> {
  if (dryRun) {
    if (guards.ifRevision !== undefined || guards.ifTableDigest !== undefined)
      throw invalid("ifRevision and ifTableDigest are only accepted with dryRun: false");
    return { dryRun: true };
  }
  assertGuards(guards);
  return { dryRun: false, ifRevision: guards.ifRevision, ifTableDigest: guards.ifTableDigest };
}

/** Every active table in a note, with native identifiers and both tokens. Read-only. */
export function readTables(
  identifier: string,
  deps: PrivateHelperDeps = defaultWriterDeps()
): NativeTables {
  assertNoteIdentifier(identifier);
  return parseWriterResult(
    readTablesSchema,
    callPrivateWriter("read_tables", { identifier }, deps),
    false
  );
}

export interface DeleteTableRowRequest extends Guards {
  identifier: string;
  tableIdentifier: string;
  rowIdentifier: string;
  dryRun: boolean;
}

export function deleteTableRow(
  request: DeleteTableRowRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): Record<string, unknown> {
  assertNoteIdentifier(request.identifier);
  assertUuid(request.tableIdentifier, "tableIdentifier");
  assertUuid(request.rowIdentifier, "rowIdentifier");
  const mode = modeFields(request.dryRun, request);
  if (!request.dryRun)
    requireLiveValidated(TABLE_WRITES_LIVE_VALIDATED, "native-delete-table-row", deps.env);
  const fields = {
    identifier: request.identifier,
    tableIdentifier: request.tableIdentifier,
    rowIdentifier: request.rowIdentifier,
    ...mode,
    ...writerScopeFields(request.scope),
  };
  const response = callPrivateWriter("delete_table_row", fields, deps, {
    dryRun: request.dryRun,
  });
  return request.dryRun
    ? parseWriterResult(deleteRowPlanSchema, response, false)
    : parseWriterResult(tableWriteResultSchema, response, true);
}

export interface InsertTableRowRequest extends Guards {
  identifier: string;
  tableIdentifier: string;
  afterRowIdentifier?: string;
  cells?: string[];
}

export function insertTableRow(
  request: InsertTableRowRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): TableWriteResult {
  assertNoteIdentifier(request.identifier);
  assertUuid(request.tableIdentifier, "tableIdentifier");
  if (request.afterRowIdentifier !== undefined)
    assertUuid(request.afterRowIdentifier, "afterRowIdentifier");
  (request.cells ?? []).forEach(assertCellText);
  assertGuards(request);
  requireLiveValidated(TABLE_WRITES_LIVE_VALIDATED, "native-insert-table-row", deps.env);
  const fields: Record<string, unknown> = {
    identifier: request.identifier,
    tableIdentifier: request.tableIdentifier,
    ifRevision: request.ifRevision,
    ifTableDigest: request.ifTableDigest,
  };
  if (request.afterRowIdentifier !== undefined)
    fields.afterRowIdentifier = request.afterRowIdentifier;
  if (request.cells !== undefined) fields.cells = request.cells;
  Object.assign(fields, writerScopeFields(request.scope));
  return parseWriterResult(
    tableWriteResultSchema,
    callPrivateWriter("insert_table_row", fields, deps),
    true
  );
}

export interface SetTableCellRequest extends Guards {
  identifier: string;
  tableIdentifier: string;
  rowIdentifier: string;
  columnIdentifier: string;
  text: string;
}

export function setTableCell(
  request: SetTableCellRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): TableWriteResult {
  assertNoteIdentifier(request.identifier);
  assertUuid(request.tableIdentifier, "tableIdentifier");
  assertUuid(request.rowIdentifier, "rowIdentifier");
  assertUuid(request.columnIdentifier, "columnIdentifier");
  assertCellText(request.text);
  assertGuards(request);
  requireLiveValidated(TABLE_WRITES_LIVE_VALIDATED, "native-set-table-cell", deps.env);
  return parseWriterResult(
    tableWriteResultSchema,
    callPrivateWriter(
      "set_table_cell",
      {
        identifier: request.identifier,
        tableIdentifier: request.tableIdentifier,
        rowIdentifier: request.rowIdentifier,
        columnIdentifier: request.columnIdentifier,
        text: request.text,
        ifRevision: request.ifRevision,
        ifTableDigest: request.ifTableDigest,
        ...writerScopeFields(request.scope),
      },
      deps
    ),
    true
  );
}

export interface PruneOrphanTableRequest extends Guards {
  identifier: string;
  tableIdentifier: string;
  dryRun: boolean;
}

export function pruneOrphanTable(
  request: PruneOrphanTableRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): Record<string, unknown> {
  assertNoteIdentifier(request.identifier);
  assertUuid(request.tableIdentifier, "tableIdentifier");
  const mode = modeFields(request.dryRun, request);
  if (!request.dryRun)
    requireLiveValidated(TABLE_WRITES_LIVE_VALIDATED, "native-prune-orphan-table", deps.env);
  const response = callPrivateWriter(
    "prune_orphan_table",
    {
      identifier: request.identifier,
      tableIdentifier: request.tableIdentifier,
      ...mode,
      ...writerScopeFields(request.scope),
    },
    deps,
    { dryRun: request.dryRun }
  );
  return request.dryRun
    ? parseWriterResult(prunePlanSchema, response, false)
    : parseWriterResult(pruneResultSchema, response, true);
}
