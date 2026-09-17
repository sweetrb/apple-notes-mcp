import { describe, it, expect, vi } from "vitest";
import {
  assertPreserved,
  assertAppendedHtmlLinks,
  assertAppendedVisibleText,
  headingLevels,
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
  it("verifies a bare-origin link even after Notes appends a trailing slash (#172)", () => {
    // Notes normalizes a path-less URL like "https://growthpath.systems" to
    // "https://growthpath.systems/" on save. Comparing the requested link
    // against the readback verbatim reported a successful write as
    // unverified; the signature-based comparison must treat them as equal.
    expect(() =>
      assertAppendedHtmlLinks(
        0,
        [{ text: "link", url: "https://growthpath.systems/" }],
        '<a href="https://growthpath.systems">link</a>'
      )
    ).not.toThrow();
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
  // #164 — the reporter could not tell which Shortcut the run had stalled on.
  it("names the Shortcut it waited on when the transport times out", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("timeout"), {
        code: "ETIMEDOUT",
        shortcut: "Apple Notes MCP - Background Operations v5",
      });
    });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /Shortcuts timed out waiting for the "Apple Notes MCP - Background Operations v5" Shortcut/
    );
  });
  // #172 item 5 — a headless run cannot display Shortcuts' first-run consent
  // prompt, so an unanswered one stalls the bridge until the transport timeout.
  it("points a timed-out run at the first-run Shortcuts consent prompt for that Shortcut", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("timeout"), {
        code: "ETIMEDOUT",
        shortcut: "Apple Notes MCP - Background Operations v5",
      });
    });
    // One invocation: the fixture's preflight reads are single-use.
    let message = "";
    try {
      mutateBackground(request, "set-pinned", {}, pinVerify, f.deps);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Operation outcome uncertain/);
    expect(message).toMatch(/first-run Shortcuts consent prompt/);
    expect(message).toMatch(
      /run "Apple Notes MCP - Background Operations v5" once in the foreground in Shortcuts\.app and choose Always Allow/
    );
  });
  it("keeps the consent hint when the timed-out Shortcut is unnamed", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /run the bridge Shortcut once in the foreground in Shortcuts\.app and choose Always Allow/
    );
  });
  it("does not blame consent for a non-timeout transport failure", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("no such shortcut"), { shortcut: "Named Bridge" });
    });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).not.toThrow(
      /consent/
    );
  });
  it("names the Shortcut on a non-timeout transport failure too", () => {
    const f = fixture();
    f.after.pinned = false;
    f.deps.run.mockImplementation(() => {
      throw Object.assign(new Error("no such shortcut"), { shortcut: "Named Bridge" });
    });
    expect(() => mutateBackground(request, "set-pinned", {}, pinVerify, f.deps)).toThrow(
      /the "Named Bridge" Shortcut failed: no such shortcut/
    );
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
describe("heading readback", () => {
  it("lists non-empty heading levels in order, skipping the empty heading Notes appends", () => {
    expect(
      headingLevels(
        '<div><b><h1>Plan</h1></b><font face=".AppleSystemUIFont"><span style="font-size: 13px"><h1><br></h1></span></font></div>' +
          "<div><br></div><div><b><h2>Goals</h2></b><h2><br></h2></div><div><b><h3>Detail</h3></b></div><div>text</div>"
      )
    ).toEqual([1, 2, 3]);
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
  // #164 — the native path rejected HTML that update-note/create-note accept:
  // the <tt> the bundled skill recommends for paths and commands, and the
  // font-size <span> Notes itself stores a heading as, so round-tripping a
  // heading read out of Notes was refused.
  it.each([
    "<div>Run <tt>/usr/bin/grep -rn foo</tt> next.</div>",
    "<div>Run <code>pnpm test</code> next.</div>",
    '<div><b><span style="font-size: 18px">Section</span></b><br></div>',
    '<div><span style="font-size:24.5pt">Bigger</span></div>',
  ])("accepts monospace and heading-sized HTML %s", (html) =>
    expect(() => validateAppendContent(html, "html")).not.toThrow()
  );
  it("names the rejected element and the accepted subset", () =>
    expect(() => validateAppendContent("<div><font>x</font></div>", "html")).toThrow(
      /Unsupported HTML element: <font>\. Native append accepts .*<tt>.*update-note/s
    ));
  it.each([
    '<span style="color:red">x</span>',
    '<span style="font-size: 18px; color: red">x</span>',
    '<span style="font-family: Menlo">x</span>',
  ])("accepts font-size but no other span style %s", (html) =>
    expect(() => validateAppendContent(html, "html")).toThrow(
      /Unsupported <span> style:.*font-size only/s
    )
  );
  it("still refuses attributes on the newly accepted elements", () =>
    expect(() => validateAppendContent('<tt class="x">y</tt>', "html")).toThrow(
      /Unsupported HTML attributes on <tt>/
    ));
  it("refuses Markdown that Notes' importer rewrites, and allows what it keeps literal", () => {
    for (const content of [
      "_note_ this",
      "Call __init__ first",
      "Deploy to /_next",
      "1\\. not a list",
      "AT&amp;T",
      "Goals\n---",
      " ## Goals",
      "1) first",
      "## Goals ##",
      "[**x**](https://example.com)",
    ])
      expect(() => validateAppendContent(content, "markdown"), content).toThrow(
        /Notes would change that text/
      );
    expect(() =>
      validateAppendContent("snake_case_name, #decision and 1. first", "markdown")
    ).not.toThrow();
    expect(() => validateAppendContent("_note_ this", "plaintext")).not.toThrow();
  });
  it("exempts link destinations from the underscore refusal, where CommonMark forms no emphasis", () => {
    for (const content of [
      "[docs](https://example.com/_next/static)",
      "[x](https://e.com/a_b/_c)",
      "## Links\n\n- [build output](https://example.com/_next/static) and [x](https://e.com/a_b/_c)",
    ])
      expect(() => validateAppendContent(content, "markdown"), content).not.toThrow();
  });
  it("still refuses underscores outside a word in text, labels and bare URLs", () => {
    for (const content of [
      "_x_",
      "__init__.py",
      "https://example.com/_next/_x_",
      "See https://example.com/_next/_x_ and [docs](https://example.com/_next/static)",
      "_x_ [docs](https://example.com/a)",
      "[docs](https://example.com/a) __init__.py",
    ])
      expect(() => validateAppendContent(content, "markdown"), content).toThrow(
        /underscores outside a word; Notes would change that text/
      );
    // Other patterns still see the destination.
    expect(() => validateAppendContent("[x](https://e.com/a\\_b)", "markdown")).toThrow(
      /backslash escapes/
    );
    expect(() => validateAppendContent("[_x_](https://e.com/a)", "markdown")).toThrow(
      /Notes would change that text/
    );
  });
  it("does not permit silent rich-content truncation", () =>
    expect(() => validateAppendContent("x".repeat(1024 * 1024 + 1), "plaintext")).toThrow());
  it.each(["![image](https://example.com/x)", '<img src="file:///x">', "[x](javascript:bad)"])(
    "refuses unsafe Markdown content %s",
    (markdown) => expect(() => validateAppendContent(markdown, "markdown")).toThrow()
  );
});
