import { describe, expect, it } from "vitest";
import { countWords } from "./wordCount.js";
import { countWords as queryCountWords } from "./noteQueryStore.js";
import { countWords as audioCountWords } from "./noteAudio.js";
import { textStats } from "./noteRecentList.js";

describe("countWords", () => {
  it("counts whitespace-separated runs with a letter or digit, as before", () => {
    expect(countWords("Hello, world — 42 times! don't e-mail https://example.com/x")).toBe(7);
    expect(countWords("  \n\t ")).toBe(0);
    expect(countWords("a￼b")).toBe(2);
  });

  it("splits text written without spaces into words (#244)", () => {
    // Before: each unspaced run counted as one word.
    expect(countWords("今日は良い天気です")).toBe(5);
    expect(countWords("我喜欢学习中文")).toBeGreaterThan(1);
    expect(countWords("ภาษาไทยง่าย")).toBeGreaterThan(1);
    expect(countWords("Notes 今日は良い天気です 2026")).toBe(7);
    // Korean separates words with spaces already.
    expect(countWords("안녕하세요 세계")).toBe(2);
  });

  it("is the one count the query, recent-list and transcription tools use", () => {
    const text = "Plan\n今日は良い天気です and more";
    expect(queryCountWords(text)).toBe(countWords(text));
    expect(audioCountWords(text)).toBe(countWords(text));
    expect(textStats(text).wordCount).toBe(countWords(text));
  });
});
