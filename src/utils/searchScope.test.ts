import { describe, it, expect } from "vitest";
import { describeSearchScope } from "@/utils/searchScope.js";

describe("describeSearchScope", () => {
  it("discloses the title-only scope when a title search returns nothing", () => {
    const hint = describeSearchScope(false, 0);
    expect(hint).toContain("Only note titles were searched");
    expect(hint).toContain("`searchContent: true`");
  });

  it("stays silent when a title search found matches", () => {
    expect(describeSearchScope(false, 1)).toBe("");
    expect(describeSearchScope(false, 50)).toBe("");
  });

  it("stays silent when the caller already searched bodies", () => {
    expect(describeSearchScope(true, 0)).toBe("");
    expect(describeSearchScope(true, 3)).toBe("");
  });
});
