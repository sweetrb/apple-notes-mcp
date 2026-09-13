import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseNoteTable } from "./noteTables.js";
const fixture = readFileSync(new URL("./fixtures/background-probe-table.gz", import.meta.url));
describe("native Notes tables", () => {
  it("reads the actual synthetic Notes table with correct dimensions, order and Unicode", () => {
    const table = parseNoteTable(fixture);
    expect(table.rows).toEqual([
      ["Имя", "Статус"],
      ["Проба 🧭", "Готово"],
    ]);
    expect(table.rowIds).toHaveLength(2);
    expect(table.columnIds).toHaveLength(2);
    expect(new Set(table.rowIds).size).toBe(2);
  });
  it("rejects a truncated native table instead of claiming complete cells", () =>
    expect(() => parseNoteTable(fixture.subarray(0, fixture.length / 2))).toThrow());
  it("rejects unrelated bytes", () =>
    expect(() => parseNoteTable(Buffer.from("not a table"))).toThrow());
});
