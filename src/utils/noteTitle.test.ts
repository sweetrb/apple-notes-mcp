import { describe, expect, it } from "vitest";
import { resolveUpdatedNoteTitle } from "@/utils/noteTitle.js";

describe("resolveUpdatedNoteTitle", () => {
  it("uses the first rendered HTML line instead of newTitle", () => {
    expect(
      resolveUpdatedNoteTitle({
        currentTitle: "Old title",
        newTitle: " ",
        newContent: "<h1>Sailing Helmet Recommendations</h1><div>Body</div>",
        format: "html",
      })
    ).toBe("Sailing Helmet Recommendations");
  });

  it("decodes inline formatting and entities in an HTML title", () => {
    expect(
      resolveUpdatedNoteTitle({
        currentTitle: "Old title",
        newContent: "<div><b>Tom &amp; Jerry</b></div><div>Body</div>",
        format: "html",
      })
    ).toBe("Tom & Jerry");
  });

  it("falls back to the current title when HTML has no rendered text", () => {
    expect(
      resolveUpdatedNoteTitle({
        currentTitle: "Keep this title",
        newTitle: " ",
        newContent: "<div><br></div>",
        format: "html",
      })
    ).toBe("Keep this title");
  });

  it("does not fail the response on an invalid numeric entity", () => {
    expect(
      resolveUpdatedNoteTitle({
        currentTitle: "Old title",
        newContent: "<h1>Title &#999999999999;</h1>",
        format: "html",
      })
    ).toBe("Title &#999999999999;");
  });

  it("uses newTitle for plaintext updates", () => {
    expect(
      resolveUpdatedNoteTitle({
        currentTitle: "Old title",
        newTitle: "New title",
        newContent: "Body",
        format: "plaintext",
      })
    ).toBe("New title");
  });
});
