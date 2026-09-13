import { describe, it, expect, vi } from "vitest";
import {
  assertPreserved,
  assertAppendedHtmlLinks,
  assertAppendedVisibleText,
  mutateBackground,
  validateAppendContent,
  type BackgroundSnapshot,
} from "./backgroundNotes.js";
const noteId = "x-coredata://ABC/ICNote/p1";
function snapshot(): BackgroundSnapshot {
  return {
    id: noteId,
    title: "Идеи",
    hash: "h1",
    html: "<div>Unique project marker</div>",
    pinned: false,
    checklist: [],
    rich: {
      text: "Unique project marker",
      links: [],
      nativeTags: [],
      nativeObjectIds: [],
      hasNativeObjects: false,
      hasChecklist: false,
      revision: "r1",
    },
  };
}
const request = { id: noteId, expectedContentHash: "h1", scopeText: "Unique project marker" };
function fixture() {
  const before = snapshot(),
    after = snapshot();
  after.hash = "h2";
  after.pinned = true;
  return {
    before,
    after,
    deps: {
      read: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(before).mockReturnValue(after),
      candidates: vi.fn(() => [noteId]),
      run: vi.fn(),
    },
  };
}
const pinVerify = (before: BackgroundSnapshot, after: BackgroundSnapshot) => {
  assertPreserved(before, after);
  if (!after.pinned) throw new Error("pin missing");
};
describe("background note mutation boundaries", () => {
  it("verifies appended text from Notes HTML when native tags replace rich-text ranges", () => {
    expect(() =>
      assertAppendedVisibleText(
        "<div>Existing text</div>",
        "<div>Existing text</div><div><b>Result</b> #project_tag</div>",
        "Result #project_tag"
      )
    ).not.toThrow();
    expect(() =>
      assertAppendedVisibleText(
        "<div>Existing text</div>",
        "<div>Existing text</div><div>Different result</div>",
        "Requested result"
      )
    ).toThrow(/not verified/);
  });
  it("verifies multiword HTML link labels using the normal link signature", () => {
    expect(() =>
      assertAppendedHtmlLinks(
        1,
        [
          { text: "old", url: "https://example.com/old" },
          { text: "Новая ссылка 🧭", url: "https://example.com/new" },
        ],
        '<a href="https://example.com/new">Новая <b>ссылка</b> 🧭</a>'
      )
    ).not.toThrow();
  });
  it("rejects wrong destinations, relabeling and missing duplicate links", () => {
    const html = '<a href="https://example.com/new">Новая ссылка</a>';
    expect(() =>
      assertAppendedHtmlLinks(0, [{ text: "Новая ссылка", url: "https://example.com/wrong" }], html)
    ).toThrow(/not verified/);
    expect(() =>
      assertAppendedHtmlLinks(0, [{ text: "Другой текст", url: "https://example.com/new" }], html)
    ).toThrow(/not verified/);
    expect(() =>
      assertAppendedHtmlLinks(
        0,
        [{ text: "Новая ссылка", url: "https://example.com/new" }],
        html + html
      )
    ).toThrow(/not verified/);
  });
  it("verifies the native outcome independently of empty transport output", () => {
    const f = fixture();
    expect(
      mutateBackground(request, "set-pinned", { change: "add" }, pinVerify, f.deps)
    ).toMatchObject({ ok: true, contentHash: "h2" });
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
  it("refuses a stale rich revision without invoking Shortcuts", () => {
    const f = fixture();
    expect(() =>
      mutateBackground(
        { ...request, expectedContentHash: "old" },
        "set-pinned",
        {},
        pinVerify,
        f.deps
      )
    ).toThrow(/revision/);
    expect(f.deps.run).not.toHaveBeenCalled();
  });
  it.each([[noteId, "other"], ["other"], []])(
    "refuses missing, wrong or ambiguous exact-ID selection %j",
    (...ids) => {
      const f = fixture();
      f.deps.candidates.mockReturnValue(ids as string[]);
      expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
        /Ambiguous/
      );
      expect(f.deps.run).not.toHaveBeenCalled();
    }
  );
  it("rechecks the revision after candidate selection", () => {
    const f = fixture();
    f.deps.read
      .mockReset()
      .mockReturnValueOnce(f.before)
      .mockReturnValue({ ...f.before, hash: "h3" });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /preflight/
    );
    expect(f.deps.run).not.toHaveBeenCalled();
  });
  it("reports verified completion after a transport timeout without repeating the write", () => {
    const f = fixture();
    f.deps.run.mockImplementation(() => {
      throw new Error("timeout");
    });
    expect(mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toHaveProperty(
      "transportWarning"
    );
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
  it("does not mistake an unchanged note for successful mutation", () => {
    const f = fixture();
    f.after.pinned = false;
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /uncertain/
    );
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
  it("includes a bounded transport diagnosis when readback fails, without retrying", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /Shortcuts timed out/
    );
    expect(f.deps.run).toHaveBeenCalledTimes(1);
  });
  it("rejects absent and multiline scope markers before a write", () => {
    for (const scopeText of ["different project marker", "Unique project\nmarker"]) {
      const f = fixture();
      expect(() =>
        mutateBackground({ ...request, scopeText }, "set-pinned", {}, pinVerify, f.deps)
      ).toThrow();
      expect(f.deps.run).not.toHaveBeenCalled();
    }
  });
});
describe("preservation verification", () => {
  it("allows Notes to normalize formatting of an object placeholder without changing visible text styles", () => {
    const before = snapshot(),
      after = snapshot();
    before.rich.text = after.rich.text = "Text\n\ufffc";
    before.rich.styleRuns = [
      { start: 0, length: 4, signature: "bold" },
      { start: 4, length: 2, signature: "old object paragraph" },
    ];
    after.rich.styleRuns = [
      { start: 0, length: 4, signature: "bold" },
      { start: 4, length: 2, signature: "normalized object paragraph" },
    ];
    expect(() => assertPreserved(before, after, { append: true })).not.toThrow();
    after.rich.styleRuns[0].signature = "plain";
    expect(() => assertPreserved(before, after, { append: true })).toThrow(/formatting/);
  });
  it("rejects a checklist recreated with identical text but a different native ID", () => {
    const before = snapshot(),
      after = snapshot();
    before.rich.checklistItems = [{ id: "original", text: "Item", done: false, start: 0 }];
    after.rich.checklistItems = [{ id: "replacement", text: "Item", done: false, start: 0 }];
    expect(() => assertPreserved(before, after, { append: true })).toThrow(/identity/);
  });
  it("rejects text edits hidden behind a successful pin or append", () => {
    const a = snapshot(),
      b = snapshot();
    b.rich.text = "Changed project marker";
    expect(() => assertPreserved(a, b, { append: true })).toThrow(/text/);
  });
  it("rejects loss of existing native objects", () => {
    const a = snapshot(),
      b = snapshot();
    a.rich.nativeObjectIds = ["table-id"];
    expect(() => assertPreserved(a, b, { append: true })).toThrow(/object/);
  });
  it("rejects a changed checklist state with identical visible text", () => {
    const a = snapshot(),
      b = snapshot();
    a.checklist = [{ text: "Task", done: false }];
    b.checklist = [{ text: "Task", done: true }];
    expect(() => assertPreserved(a, b, { append: true })).toThrow(/checklist/);
  });
  it("rejects a URL change with an unchanged link label", () => {
    const a = snapshot(),
      b = snapshot();
    a.rich.links = [{ start: 0, length: 6, text: "Unique", url: "https://example.com/a" }];
    b.rich.links = [{ ...a.rich.links[0], url: "https://example.com/b" }];
    expect(() => assertPreserved(a, b, { append: true })).toThrow(/links/);
  });
  it("rejects rich formatting changes even when text and links are unchanged", () => {
    const a = snapshot(),
      b = snapshot();
    a.rich.styleRuns = [{ start: 0, length: 21, signature: "bold" }];
    b.rich.styleRuns = [{ start: 0, length: 21, signature: "plain" }];
    expect(() => assertPreserved(a, b, { append: true })).toThrow(/formatting/);
  });
  it("accepts equivalent split attribute runs", () => {
    const a = snapshot(),
      b = snapshot();
    a.rich.styleRuns = [{ start: 0, length: 21, signature: "bold" }];
    b.rich.styleRuns = [
      { start: 0, length: 6, signature: "bold" },
      { start: 6, length: 15, signature: "bold" },
    ];
    expect(() => assertPreserved(a, b, { append: true })).not.toThrow();
  });
});
describe("rich append input", () => {
  it("accepts semantic HTML with visible blank paragraphs and real links", () =>
    expect(() =>
      validateAppendContent(
        '<h2>План</h2><div><br></div><div><b>Далее</b> <a href="notes://showNote?identifier=ABC">Задачи</a></div>',
        "html"
      )
    ).not.toThrow());
  it.each([
    '<img src="https://example.com/private">',
    '<div onclick="bad()">x</div>',
    "<iframe>x</iframe>",
    '<a href="javascript:alert(1)">x</a>',
    '<span style="color:red">x</span>',
    "<script>x</script>",
  ])("refuses unsupported or externally fetched HTML %s", (html) =>
    expect(() => validateAppendContent(html, "html")).toThrow()
  );
  it("does not permit silent rich-content truncation", () =>
    expect(() => validateAppendContent("x".repeat(1024 * 1024 + 1), "plaintext")).toThrow());
  it.each(["![image](https://example.com/x)", '<img src="file:///x">', "[x](javascript:bad)"])(
    "refuses unsafe Markdown content %s",
    (markdown) => expect(() => validateAppendContent(markdown, "markdown")).toThrow()
  );
});
