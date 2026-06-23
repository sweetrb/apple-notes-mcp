import { describe, it, expect, vi, beforeEach } from "vitest";
import { NOTES_NORMALIZED_HTML_FIXTURES } from "@/services/__fixtures__/notesNormalizedHtml.js";

// Mock the same seams the main manager test does: AppleScript execution and the
// SQLite-backed checklist reader (no Full Disk Access in unit tests).
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));
vi.mock("@/utils/checklistParser.js", () => ({
  getChecklistItems: vi.fn().mockReturnValue({ items: null }),
}));

import { executeAppleScript } from "@/utils/applescript.js";
import { AppleNotesManager } from "@/services/appleNotesManager.js";

const mockExecuteAppleScript = vi.mocked(executeAppleScript);

const NOTE_ID = "x-coredata://ABC/ICNote/p1";

/**
 * Regression coverage for Notes-normalized HTML -> Markdown conversion.
 *
 * The fixtures encode the HTML shape Apple Notes returns and the Markdown the
 * server currently emits. Routing through getNoteMarkdownById exercises the real
 * Turndown pipeline (including the notesDivs rule) with AppleScript mocked to
 * return the fixture body.
 */
describe("Notes-normalized HTML to Markdown", () => {
  let manager: AppleNotesManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleNotesManager();
  });

  for (const fixture of NOTES_NORMALIZED_HTML_FIXTURES) {
    it(`converts ${fixture.name} (${fixture.description})`, () => {
      mockExecuteAppleScript.mockReturnValue({ success: true, output: fixture.html });

      const markdown = manager.getNoteMarkdownById(NOTE_ID);

      expect(markdown).toBe(fixture.expectedMarkdown);
    });
  }

  it("documents that a <div><br></div> spacer leaves a two-space line", () => {
    mockExecuteAppleScript.mockReturnValue({
      success: true,
      output: "<div>A</div><div><br></div><div>B</div>",
    });

    const markdown = manager.getNoteMarkdownById(NOTE_ID);

    // The spacer survives as a stray "  " line — the Markdown-side fingerprint of
    // the whitespace-accumulation behavior CLAUDE.md warns about.
    expect(markdown).toBe("A\n  \n\nB");
  });

  it("documents that <tt> is dropped, keeping only its text", () => {
    mockExecuteAppleScript.mockReturnValue({
      success: true,
      output: "<div>Run <tt>npm install</tt> first.</div>",
    });

    const markdown = manager.getNoteMarkdownById(NOTE_ID);

    expect(markdown).toBe("Run npm install first.");
    expect(markdown).not.toContain("`");
  });
});
