import { describe, it, expect, vi } from "vitest";
import { insertLink, type LinkInsertDependencies } from "./linkInsert.js";
import type { InsertLinkParams } from "../types.js";
import { CodedError } from "../utils/errorCodes.js";
import type { NoteLink } from "../utils/noteRichText.js";

const ID = "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p1";
const HASH = "sha256:" + "a".repeat(64);
const NEW_HASH = "sha256:" + "b".repeat(64);
const link = (text: string, url: string): NoteLink => ({
  start: 0,
  length: text.length,
  text,
  url,
});

function deps(
  after: NoteLink[],
  before: NoteLink[] = [],
  route: "applescript" | "native" = "applescript"
) {
  const readLinks = vi.fn<(id: string) => NoteLink[]>();
  readLinks.mockReturnValueOnce(before).mockReturnValueOnce(after);
  const append = vi.fn<LinkInsertDependencies["append"]>(() => ({ route, contentHash: NEW_HASH }));
  return { readLinks, append };
}

const base: InsertLinkParams = {
  id: ID,
  expectedContentHash: HASH,
  url: "https://example.org/page",
  mode: "raw",
  position: "end",
  blankLine: true,
};

describe("insertLink", () => {
  it("appends a raw linked URL at the end with a blank line and verifies it", () => {
    const d = deps([link("https://example.org/page", "https://example.org/page")]);
    const result = insertLink(base, d);
    expect(d.append).toHaveBeenCalledWith({
      id: ID,
      expectedContentHash: HASH,
      content: '<div><a href="https://example.org/page">https://example.org/page</a></div>',
      position: "after",
      separator: "\n\n",
      scopeText: undefined,
    });
    expect(result).toEqual({
      ok: true,
      id: ID,
      mode: "raw",
      url: "https://example.org/page",
      text: "https://example.org/page",
      position: "end",
      route: "applescript",
      linkStored: true,
      storedUrl: "https://example.org/page",
      previousContentHash: HASH,
      contentHash: NEW_HASH,
    });
  });

  it("maps after-title to a prepend with no separator when blankLine is false", () => {
    const d = deps([link("Label", "https://example.org/page")]);
    insertLink(
      { ...base, mode: "hyperlink", label: "Label", position: "after-title", blankLine: false },
      d
    );
    expect(d.append.mock.calls[0][0]).toMatchObject({ position: "before", separator: "" });
  });

  it("passes scopeText through and reports the native route", () => {
    const d = deps([link("Label", "https://example.org/page")], [], "native");
    const result = insertLink(
      { ...base, mode: "hyperlink", label: "Label", scopeText: "an existing phrase" },
      d
    );
    expect(d.append.mock.calls[0][0].scopeText).toBe("an existing phrase");
    expect(result.route).toBe("native");
  });

  it("reports plain text for linked=false", () => {
    const d = deps([]);
    const result = insertLink({ ...base, linked: false }, d);
    expect(d.append.mock.calls[0][0].content).toBe("<div>https://example.org/page</div>");
    expect(result.linkStored).toBe(false);
    expect(result.storedUrl).toBeUndefined();
  });

  it("validates before touching the note", () => {
    const d = deps([]);
    expect(() => insertLink({ ...base, url: "javascript:alert(1)" }, d)).toThrow("absolute");
    expect(d.readLinks).not.toHaveBeenCalled();
    expect(d.append).not.toHaveBeenCalled();
  });

  it("propagates append failures unchanged", () => {
    const d = deps([]);
    d.append.mockImplementation(() => {
      throw new Error("Note changed after it was read");
    });
    expect(() => insertLink(base, d)).toThrow("Note changed after it was read");
  });

  it("says the write landed when only link verification fails", () => {
    const d = deps([]);
    expect(() => insertLink(base, d)).toThrow(
      /The text was written, but link verification failed: .*not found.*Do not retry automatically/
    );
  });

  // #212: the envelope must say the text committed, not leave it unknown.
  it("marks a failed link verification as committed", () => {
    let thrown: unknown;
    try {
      insertLink(base, deps([]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodedError);
    expect((thrown as CodedError).envelope).toEqual({
      code: "verification_failed",
      committed: true,
      indeterminate: true,
    });
  });

  it("wraps a non-Error verification failure too", async () => {
    vi.resetModules();
    vi.doMock("../utils/linkInsert.js", async (orig) => ({
      ...(await orig<typeof import("../utils/linkInsert.js")>()),
      verifyLinkReadback: () => {
        throw "boom";
      },
    }));
    const { insertLink: mocked } = await import("./linkInsert.js");
    expect(() => mocked(base, deps([]))).toThrow("link verification failed: boom");
    vi.doUnmock("../utils/linkInsert.js");
  });
});
