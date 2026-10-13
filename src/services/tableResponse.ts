/** Response paging for native tables, measured after Markdown and JSON escaping. */
import type { NoteTable, NoteTablesResult } from "@/types.js";
import { CodedError } from "@/utils/errorCodes.js";
import { withStructuredText } from "@/utils/structuredText.js";

export const DEFAULT_TABLE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_TABLE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_TABLES_PER_PAGE = 500;
export const MIN_TABLE_RESPONSE_BYTES = 1024;

export interface TablePageOptions {
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

interface NormalizedTablePageOptions {
  offset: number;
  limit: number;
  maxBytes: number;
}

export function validateTablePageOptions(options: TablePageOptions): NormalizedTablePageOptions {
  const {
    offset = 0,
    limit = MAX_TABLES_PER_PAGE,
    maxBytes = DEFAULT_TABLE_RESPONSE_BYTES,
  } = options;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TABLES_PER_PAGE ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_TABLE_RESPONSE_BYTES ||
    maxBytes > MAX_TABLE_RESPONSE_BYTES
  ) {
    throw new CodedError("Invalid table page offset, limit or maxBytes.", {
      code: "validation_error",
    });
  }
  return { offset, limit, maxBytes };
}

interface TablePageResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    [key: string]: unknown;
    id: string;
    tables: NoteTable[];
    tableCount: number;
    tableCellsComplete: boolean;
    markdown: string;
    page: {
      offset: number;
      limit: number;
      maxBytes: number;
      totalAvailable: number;
      returned: number;
      nextOffset?: number;
      hasMore: boolean;
      stoppedAtSizeLimit: boolean;
    };
  };
}

function response(
  id: string,
  result: NoteTablesResult,
  tables: NoteTable[],
  options: NormalizedTablePageOptions,
  stoppedAtSizeLimit: boolean
): TablePageResponse {
  const tableCount = result.tables.length;
  const next = options.offset + tables.length;
  const hasMore = next < tableCount;
  const complete = result.tableCellsComplete && tables.every((table) => table.complete);
  const markdown = tables
    .map(
      (table) =>
        table.markdown ??
        `[table ${table.index} could not be ${table.contentOmitted ? "returned" : "decoded"}: ${table.reason}]`
    )
    .join("\n\n");
  let summary =
    tableCount === 0
      ? "This note has no native tables."
      : `${tables.length === tableCount ? tableCount : `${tables.length} of ${tableCount}`} table(s)${complete ? "" : " (some content could not be returned; see tables[].reason)"}:\n\n${markdown}`;
  if (hasMore)
    summary += `\n\nMore tables remain: call get-note-tables with offset ${next} and the same limit and maxBytes.`;
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: {
      id,
      tables,
      tableCount,
      tableCellsComplete: complete,
      markdown,
      page: {
        ...options,
        totalAvailable: tableCount,
        returned: tables.length,
        ...(hasMore ? { nextOffset: next } : {}),
        hasMore,
        stoppedAtSizeLimit,
      },
    },
  };
}

// The registration wrapper mirrors structuredContent into another text block.
// Measure its actual projection too, then return the original for one wrapping.
const size = (value: TablePageResponse) =>
  Buffer.byteLength(JSON.stringify(withStructuredText(value)));

/**
 * Retain whole decoded tables and advance in body order. A table larger than
 * an otherwise empty page gets an explicit metadata-only receipt, never
 * partial rows or fabricated cell identities. The input remains unchanged.
 */
export function tablePageResponse(
  id: string,
  result: NoteTablesResult,
  request: TablePageOptions = {}
): TablePageResponse {
  const options = validateTablePageOptions(request);
  const available = Math.max(0, Math.min(options.limit, result.tables.length - options.offset));
  // Bracket a fitting whole-table prefix without repeatedly serializing every
  // growing prefix. Every accepted candidate is checked independently: mirror
  // omission thresholds can make response sizes non-monotone.
  const fits = (count: number) => {
    const candidate = result.tables.slice(options.offset, options.offset + count);
    const couldStopLater = count < available;
    const candidateBytes = Math.max(
      size(response(id, result, candidate, options, false)),
      couldStopLater ? size(response(id, result, candidate, options, true)) : 0
    );
    return candidateBytes <= options.maxBytes;
  };
  let accepted = 0;
  let trial = 1;
  while (trial <= available) {
    if (fits(trial)) {
      accepted = trial;
      if (trial === available) break;
      trial = Math.min(available, trial * 2);
      continue;
    }
    let low = accepted + 1;
    let high = trial - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    break;
  }
  let tables = result.tables.slice(options.offset, options.offset + accepted);
  const stoppedAtSizeLimit = accepted < available;
  if (stoppedAtSizeLimit && accepted === 0) {
    const table = result.tables[options.offset];
    tables = [
      {
        index: table.index,
        id: table.id,
        ...(table.attachmentId !== undefined ? { attachmentId: table.attachmentId } : {}),
        ...(table.rowCount !== undefined ? { rowCount: table.rowCount } : {}),
        ...(table.columnCount !== undefined ? { columnCount: table.columnCount } : {}),
        complete: false,
        contentOmitted: true,
        reason:
          "Table content exceeds this response size limit. Increase maxBytes or export the note to a file.",
      },
    ];
  }
  const output = response(id, result, tables, options, stoppedAtSizeLimit);
  if (size(output) > options.maxBytes) {
    throw new CodedError(
      "Table metadata is too large for this response limit; increase maxBytes.",
      { code: "validation_error" }
    );
  }
  return output;
}
