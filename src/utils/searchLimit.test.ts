import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_LIMIT,
  resolveSearchLimit,
  describeSearchLimit,
} from "@/utils/searchLimit.js";

describe("resolveSearchLimit", () => {
  it("returns the default when no limit is supplied", () => {
    expect(resolveSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit()).toBe(50);
  });

  it("returns an explicit positive limit, floored", () => {
    expect(resolveSearchLimit(10)).toBe(10);
    expect(resolveSearchLimit(999)).toBe(999);
    expect(resolveSearchLimit(7.9)).toBe(7);
  });

  it("treats non-positive or non-finite values as unset (defensive)", () => {
    expect(resolveSearchLimit(0)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit(-5)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit(Infinity)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit(NaN)).toBe(DEFAULT_SEARCH_LIMIT);
  });
});

describe("describeSearchLimit", () => {
  it("marks the default cap so the caller knows it was implicit", () => {
    const { info } = describeSearchLimit(50, true, 3);
    expect(info).toBe(" (limit: 50, default)");
  });

  it("does not mark an explicit cap as default", () => {
    const { info } = describeSearchLimit(10, false, 3);
    expect(info).toBe(" (limit: 10)");
  });

  it("adds no truncation note when the result is below the cap", () => {
    expect(describeSearchLimit(50, true, 12).truncationNote).toBe("");
    expect(describeSearchLimit(10, false, 9).truncationNote).toBe("");
  });

  it("adds a truncation note when the result hits the cap", () => {
    const { truncationNote } = describeSearchLimit(50, true, 50);
    expect(truncationNote).toContain("Showing the first 50");
    expect(truncationNote).toContain("(default limit)");
    expect(truncationNote).toContain("higher `limit`");
  });

  it("truncation note for an explicit cap omits the default wording", () => {
    const { truncationNote } = describeSearchLimit(10, false, 10);
    expect(truncationNote).toContain("Showing the first 10");
    expect(truncationNote).not.toContain("default limit");
  });
});
