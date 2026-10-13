/** Whole-table paging must budget the final text and structured MCP payload. */
import { describe, expect, it } from "vitest";
import type { NoteTable, NoteTablesResult } from "@/types.js";
import { CodedError } from "@/utils/errorCodes.js";
import { MAX_MIRROR_CHARS, SHOWN_ABOVE, withStructuredText } from "@/utils/structuredText.js";
import {
  DEFAULT_TABLE_RESPONSE_BYTES,
  MAX_TABLE_RESPONSE_BYTES,
  MAX_TABLES_PER_PAGE,
  MIN_TABLE_RESPONSE_BYTES,
  tablePageResponse,
  validateTablePageOptions,
  type TablePageOptions,
} from "./tableResponse.js";

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const wireBytes = (value: ReturnType<typeof tablePageResponse>) => bytes(withStructuredText(value));

function table(index: number, text = `cell ${index}`): NoteTable {
  return {
    index,
    id: `table-${index}`,
    attachmentId: `x-coredata://ABC/ICAttachment/p${index}`,
    complete: true,
    rows: [
      ["Header", "Value"],
      [text, `value ${index}`],
    ],
    rowIds: [`row-${index}-header`, `row-${index}-body`],
    columnIds: [`column-${index}-first`, `column-${index}-second`],
    rowCount: 2,
    columnCount: 2,
    markdown: `| Header | Value |\n| --- | --- |\n| ${text} | value ${index} |`,
  };
}

function result(tables: NoteTable[]): NoteTablesResult {
  return {
    tables,
    tableCellsComplete: tables.every((item) => item.complete),
    markdown: tables.map((item) => item.markdown ?? "").join("\n\n"),
  };
}

/** Account for the budget's own decimal representation in both JSON copies. */
function exactBudget(input: NoteTablesResult, options: TablePageOptions = {}): number {
  const base = tablePageResponse(ID, input, { ...options, maxBytes: MAX_TABLE_RESPONSE_BYTES });
  let budget = wireBytes(base);
  for (let attempt = 0; attempt < 10; attempt++) {
    base.structuredContent.page.maxBytes = budget;
    const measured = wireBytes(base);
    if (measured === budget) return budget;
    budget = measured;
  }
  throw new Error("Serialized budget did not stabilize");
}

function expectValidationError(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CodedError);
  expect((caught as CodedError).envelope).toEqual({ code: "validation_error" });
}

describe("table page option validation", () => {
  it("uses the advertised defaults and accepts inclusive integer bounds", () => {
    expect(validateTablePageOptions({})).toEqual({
      offset: 0,
      limit: MAX_TABLES_PER_PAGE,
      maxBytes: DEFAULT_TABLE_RESPONSE_BYTES,
    });
    expect(
      validateTablePageOptions({
        offset: Number.MAX_SAFE_INTEGER,
        limit: 1,
        maxBytes: MIN_TABLE_RESPONSE_BYTES,
      })
    ).toEqual({ offset: Number.MAX_SAFE_INTEGER, limit: 1, maxBytes: MIN_TABLE_RESPONSE_BYTES });
    expect(
      validateTablePageOptions({
        offset: 0,
        limit: MAX_TABLES_PER_PAGE,
        maxBytes: MAX_TABLE_RESPONSE_BYTES,
      })
    ).toEqual({ offset: 0, limit: MAX_TABLES_PER_PAGE, maxBytes: MAX_TABLE_RESPONSE_BYTES });
  });

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: NaN },
    { offset: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 1.5 },
    { limit: MAX_TABLES_PER_PAGE + 1 },
    { limit: NaN },
    { maxBytes: MIN_TABLE_RESPONSE_BYTES - 1 },
    { maxBytes: MIN_TABLE_RESPONSE_BYTES + 0.5 },
    { maxBytes: MAX_TABLE_RESPONSE_BYTES + 1 },
    { maxBytes: Infinity },
  ])("rejects invalid options before building a response: %j", (options) => {
    expectValidationError(() => tablePageResponse(ID, result([]), options));
  });
});

describe("whole-table count and byte paging", () => {
  it("pages in body order without changing stable identities, nullable cells, or input", () => {
    const incomplete = table(2);
    incomplete.complete = false;
    incomplete.rows![1][0] = null;
    incomplete.incompleteCells = [{ row: 1, column: 0, reason: "Cell could not be decoded" }];
    incomplete.reason = "One cell could not be decoded";
    incomplete.markdown = "| Header | Value |\n| --- | --- |\n| [undecoded cell] | value 2 |";
    const input = result([table(1), incomplete, table(3)]);
    const before = structuredClone(input);
    const first = tablePageResponse(ID, input, { limit: 2 });
    expect(first.structuredContent).toMatchObject({
      tables: before.tables.slice(0, 2),
      tableCount: 3,
      tableCellsComplete: false,
      page: {
        offset: 0,
        limit: 2,
        totalAvailable: 3,
        returned: 2,
        nextOffset: 2,
        hasMore: true,
        stoppedAtSizeLimit: false,
      },
    });
    expect(first.structuredContent.tables[1]).toMatchObject({
      rows: [
        ["Header", "Value"],
        [null, "value 2"],
      ],
      rowIds: ["row-2-header", "row-2-body"],
      columnIds: ["column-2-first", "column-2-second"],
      incompleteCells: [{ row: 1, column: 0, reason: "Cell could not be decoded" }],
    });
    const last = tablePageResponse(ID, input, {
      offset: first.structuredContent.page.nextOffset,
      limit: 2,
    });
    expect(last.structuredContent.tables).toEqual([before.tables[2]]);
    expect(last.structuredContent.page).toMatchObject({
      offset: 2,
      returned: 1,
      hasMore: false,
      stoppedAtSizeLimit: false,
    });
    expect(last.structuredContent.page).not.toHaveProperty("nextOffset");
    expect(input).toEqual(before);
  });

  it("defaults to 500 tables and supplies the offset for the remaining table", () => {
    const input = result(
      Array.from({ length: MAX_TABLES_PER_PAGE + 1 }, (_, index) => table(index + 1))
    );
    const page = tablePageResponse(ID, input);
    expect(page.structuredContent.page).toMatchObject({
      limit: MAX_TABLES_PER_PAGE,
      maxBytes: DEFAULT_TABLE_RESPONSE_BYTES,
      returned: MAX_TABLES_PER_PAGE,
      nextOffset: MAX_TABLES_PER_PAGE,
      hasMore: true,
      stoppedAtSizeLimit: false,
    });
    expect(wireBytes(page)).toBeLessThanOrEqual(DEFAULT_TABLE_RESPONSE_BYTES);
  });

  it("stops on a byte boundary with only whole tables and resumes without gaps", () => {
    const input = result([
      table(1, "a".repeat(1000)),
      table(2, "b".repeat(1000)),
      table(3, "c".repeat(1000)),
    ]);
    const before = structuredClone(input);
    const seen: NoteTable[] = [];
    let offset = 0;
    for (let attempt = 0; attempt < input.tables.length; attempt++) {
      const page = tablePageResponse(ID, input, { offset, maxBytes: 8192 });
      expect(wireBytes(page)).toBeLessThanOrEqual(8192);
      expect(page.structuredContent.tables.every((item) => !item.contentOmitted)).toBe(true);
      expect(page.structuredContent.tables).toEqual(
        before.tables.slice(offset, offset + page.structuredContent.page.returned)
      );
      seen.push(...page.structuredContent.tables);
      if (!page.structuredContent.page.hasMore) break;
      expect(page.structuredContent.page.stoppedAtSizeLimit).toBe(true);
      expect(page.structuredContent.page.nextOffset).toBeGreaterThan(offset);
      offset = page.structuredContent.page.nextOffset!;
    }
    expect(seen).toEqual(before.tables);
    expect(input).toEqual(before);
  });

  it("counts JSON escaping, UTF-8 Unicode, every Markdown copy, and the text mirror", () => {
    const text = '"\\\n\t\u0000🧭漢';
    const special = table(1, text);
    special.rows = Array.from({ length: 10 }, () => [text, text]);
    special.rowIds = Array.from({ length: 10 }, (_, index) => `stable-${index}`);
    special.rowCount = special.rows.length;
    special.markdown = `| Header | Value |\n| --- | --- |\n${special.rows.map((row) => `| ${row[0]} | ${row[1]} |`).join("\n")}`;
    const input = result([special]);
    const budget = exactBudget(input);
    expect(budget).toBeGreaterThan(MIN_TABLE_RESPONSE_BYTES);
    const page = tablePageResponse(ID, input, { maxBytes: budget });
    const wire = withStructuredText(page);
    expect(page.structuredContent.tables).toEqual([special]);
    expect(bytes(wire)).toBe(budget);
    expect(bytes(wire)).toBeGreaterThan(JSON.stringify(wire).length);
    expect(bytes(wire)).toBeGreaterThan(bytes(page));
    expect(wire.content).toHaveLength(2);
    expect(page.content[0].text).toContain(special.markdown);
    expect(page.structuredContent.markdown).toBe(special.markdown);
    expect(page.structuredContent.tables[0].markdown).toBe(special.markdown);
    expect(JSON.stringify(wire)).toContain("\\u0000");

    const smaller = tablePageResponse(ID, input, { maxBytes: budget - 1 });
    expect(wireBytes(smaller)).toBeLessThanOrEqual(budget - 1);
    expect(smaller.structuredContent.tables[0]).toMatchObject({
      id: special.id,
      contentOmitted: true,
      complete: false,
    });
    expect(smaller.structuredContent.tables[0]).not.toHaveProperty("rows");
    expect(smaller.structuredContent.page).toMatchObject({
      returned: 1,
      hasMore: false,
      stoppedAtSizeLimit: true,
    });
  });
});

describe("oversized and empty pages", () => {
  it("keeps a page bounded when a size stop restores the mirror at its truncation threshold", () => {
    const second = table(2, "second table".repeat(10000));
    const fixture = (rowCount: number, padding = 0) => {
      const first = table(1);
      first.rows = Array.from({ length: rowCount }, (_, index) => [
        "x".repeat(10 + (index === 0 ? padding : 0)),
      ]);
      first.rowIds = Array.from({ length: rowCount }, (_, index) => `stable-${index}`);
      first.columnIds = ["column-1"];
      first.rowCount = rowCount;
      first.columnCount = 1;
      first.markdown = `| Column |\n| --- |\n${first.rows.map((row) => `| ${row[0]} |`).join("\n")}`;
      const input = result([first, second]);
      const draft = tablePageResponse(ID, input, {
        limit: 1,
        maxBytes: MAX_TABLE_RESPONSE_BYTES,
      });
      draft.structuredContent.page.limit = 2;
      draft.structuredContent.page.maxBytes = 60000;
      return { input, draft };
    };
    const untruncatedMirrorLength = (draft: ReturnType<typeof tablePageResponse>) => {
      const projection = structuredClone(draft.structuredContent);
      projection.markdown = SHOWN_ABOVE;
      projection.tables[0].markdown = SHOWN_ABOVE;
      return JSON.stringify(projection).length;
    };

    // Short cells and row IDs remain in the mirror; Markdown is shown above.
    // Tune its JSON to one character past the exact truncation threshold.
    const target = MAX_MIRROR_CHARS + 1;
    let lower = 2;
    let upper = 2000;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (untruncatedMirrorLength(fixture(middle).draft) <= target) lower = middle;
      else upper = middle;
    }
    const padding = target - untruncatedMirrorLength(fixture(lower).draft);
    expect(10 + padding).toBeLessThan(64);
    const { input, draft } = fixture(lower, padding);
    let budget = wireBytes(draft);
    for (let attempt = 0; attempt < 10; attempt++) {
      draft.structuredContent.page.maxBytes = budget;
      const measured = wireBytes(draft);
      if (measured === budget) break;
      budget = measured;
    }
    expect(String(budget)).toHaveLength(5);
    expect(untruncatedMirrorLength(draft)).toBe(target);
    expect(wireBytes(draft)).toBe(budget);
    const stopped = structuredClone(draft);
    stopped.structuredContent.page.stoppedAtSizeLimit = true;
    expect(untruncatedMirrorLength(stopped)).toBe(MAX_MIRROR_CHARS);
    expect(wireBytes(stopped)).toBeGreaterThan(budget);

    const page = tablePageResponse(ID, input, { limit: 2, maxBytes: budget });
    expect(wireBytes(page)).toBeLessThanOrEqual(budget);
    expect(page.structuredContent.tables).toHaveLength(1);
    expect(page.structuredContent.tables[0]).toMatchObject({
      id: "table-1",
      complete: false,
      contentOmitted: true,
    });
    expect(page.structuredContent.page).toMatchObject({
      returned: 1,
      nextOffset: 1,
      hasMore: true,
      stoppedAtSizeLimit: true,
    });
  });

  it("returns one metadata-only receipt for an oversized table and advances past it", () => {
    const large = table(7, "oversized cell".repeat(5000));
    const next = table(8);
    const input = result([large, next]);
    const before = structuredClone(input);
    const page = tablePageResponse(ID, input, { limit: 2, maxBytes: 4096 });
    expect(wireBytes(page)).toBeLessThanOrEqual(4096);
    expect(page.structuredContent.tables).toEqual([
      {
        index: large.index,
        id: large.id,
        attachmentId: large.attachmentId,
        rowCount: 2,
        columnCount: 2,
        complete: false,
        contentOmitted: true,
        reason: expect.stringMatching(/size limit/),
      },
    ]);
    for (const key of ["rows", "rowIds", "columnIds", "incompleteCells", "markdown"])
      expect(page.structuredContent.tables[0]).not.toHaveProperty(key);
    expect(page.structuredContent).toMatchObject({
      tableCount: 2,
      tableCellsComplete: false,
      page: { offset: 0, returned: 1, nextOffset: 1, hasMore: true, stoppedAtSizeLimit: true },
    });
    expect(page.content[0].text).toContain("offset 1");
    expect(page.content[0].text).not.toContain("oversized cell");
    const resumed = tablePageResponse(ID, input, { offset: 1, limit: 2, maxBytes: 4096 });
    expect(resumed.structuredContent.tables).toEqual([next]);
    expect(resumed.structuredContent.page.hasMore).toBe(false);
    expect(input).toEqual(before);
  });

  it("throws a short coded error when even table metadata cannot fit", () => {
    const hugeMetadata = table(1, "large".repeat(5000));
    hugeMetadata.id = "metadata-🧭".repeat(1000);
    expectValidationError(() => tablePageResponse(ID, result([hugeMetadata]), { maxBytes: 4096 }));
    try {
      tablePageResponse(ID, result([hugeMetadata]), { maxBytes: 4096 });
    } catch (error) {
      expect(
        bytes({ message: (error as Error).message, envelope: (error as CodedError).envelope })
      ).toBeLessThan(4096);
      expect((error as Error).message).not.toContain(hugeMetadata.id);
    }
  });

  it("reports undecodable table metadata without claiming a paging omission", () => {
    const undecodable: NoteTable = {
      index: 1,
      id: "table-1",
      complete: false,
      reason: "No table data",
    };
    const page = tablePageResponse(ID, result([undecodable]));
    expect(page.structuredContent.tables).toEqual([undecodable]);
    expect(page.structuredContent.tableCellsComplete).toBe(false);
    expect(page.structuredContent.page.stoppedAtSizeLimit).toBe(false);
    expect(page.structuredContent.markdown).toContain("could not be decoded");
    expect(page.structuredContent.tables[0]).not.toHaveProperty("contentOmitted");
  });

  it("returns an empty bounded page for a note without tables", () => {
    const page = tablePageResponse(ID, result([]), { maxBytes: MIN_TABLE_RESPONSE_BYTES });
    expect(wireBytes(page)).toBeLessThanOrEqual(MIN_TABLE_RESPONSE_BYTES);
    expect(page.content[0].text).toBe("This note has no native tables.");
    expect(page.structuredContent).toMatchObject({
      tables: [],
      tableCount: 0,
      tableCellsComplete: true,
      markdown: "",
      page: { returned: 0, hasMore: false, stoppedAtSizeLimit: false },
    });
    expect(page.structuredContent.page).not.toHaveProperty("nextOffset");
  });

  it.each([2, 20, Number.MAX_SAFE_INTEGER])(
    "returns a terminal empty page for offset %i at or beyond the end",
    (offset) => {
      const page = tablePageResponse(ID, result([table(1), table(2)]), { offset, maxBytes: 2048 });
      expect(wireBytes(page)).toBeLessThanOrEqual(2048);
      expect(page.structuredContent).toMatchObject({
        tables: [],
        tableCount: 2,
        markdown: "",
        page: { offset, returned: 0, hasMore: false, stoppedAtSizeLimit: false },
      });
      expect(page.structuredContent.page).not.toHaveProperty("nextOffset");
    }
  );
});
