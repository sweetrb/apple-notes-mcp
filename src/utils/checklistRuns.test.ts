import { describe, expect, it } from "vitest";
import { checklistRunLineStart } from "./checklistRuns.js";

describe("checklistRunLineStart", () => {
  it("anchors on the run's first non-newline character", () => {
    expect(checklistRunLineStart("A\nB", 1, 2)).toBe(2);
    expect(checklistRunLineStart("A\n\nB", 1, 3)).toBe(3);
    expect(checklistRunLineStart("A\nB\n", 2, 2)).toBe(2);
  });
  it("keeps a run that starts mid-line on its own line", () => {
    expect(checklistRunLineStart("Title\nItem", 8, 3)).toBe(6);
  });
  it("keeps a newline-only run with the line it terminates", () => {
    expect(checklistRunLineStart("A\nB", 1, 1)).toBe(0);
    expect(checklistRunLineStart("\nB", 0, 1)).toBe(0);
    expect(checklistRunLineStart("A\n\nB", 2, 1)).toBe(2);
  });
});
