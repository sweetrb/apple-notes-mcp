import { describe, expect, it } from "vitest";
import { uniqueById } from "./uniqueById.js";

describe("uniqueById", () => {
  it("keeps the first occurrence of each id in original order", () => {
    const rows = [
      { id: "b", n: 1 },
      { id: "a", n: 2 },
      { id: "b", n: 3 },
      { id: "c", n: 4 },
      { id: "a", n: 5 },
    ];
    expect(uniqueById(rows)).toEqual([
      { id: "b", n: 1 },
      { id: "a", n: 2 },
      { id: "c", n: 4 },
    ]);
  });

  it("leaves items without an id alone and does not mutate the input", () => {
    const rows = [{ id: "" }, { id: "" }, { id: "x" }];
    const copy = [...rows];
    expect(uniqueById(rows)).toEqual(rows);
    expect(rows).toEqual(copy);
  });
});
