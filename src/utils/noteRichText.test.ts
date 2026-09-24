import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  parseRichNote,
  restoreNoteLinks,
  linkSignature,
  htmlLinks,
  assertLinkedWrite,
  richContentHash,
  readRichNote,
  enrichNoteRead,
  type RichNote,
  type RichRead,
} from "./noteRichText.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const encodeVarint = (value: number): number[] => {
  const bytes = [];
  do {
    let byte = value & 127;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return bytes;
};
const n = (field: number, value: number) =>
  Buffer.from([...encodeVarint(field * 8), ...encodeVarint(value)]);
const b = (field: number, value: Buffer | string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([
    Buffer.from([...encodeVarint(field * 8 + 2), ...encodeVarint(bytes.length)]),
    bytes,
  ]);
};
const document = (text: string, runs: Buffer[]) =>
  b(2, b(3, Buffer.concat([b(2, text), ...runs.map((r) => b(5, r))])));
const run = (length: number, url?: string) =>
  Buffer.concat([n(1, length), ...(url ? [b(9, url)] : [])]);
const url = "notes://showNote?identifier=ABC";
function rich(text: string, start: number, length: number): RichNote {
  return parseRichNote(
    document(text, [run(start), run(length, url), run(text.length - start - length)])
  );
}
function read(note: RichNote): RichRead {
  return {
    content: "",
    links: note.links,
    nativeTags: [],
    complete: true,
    writable: true,
    revision: note.revision,
  };
}

describe("Notes rich text", () => {
  it("ignores regenerated paragraph UUIDs in style comparison but keeps rich revisions distinct", () => {
    const doc = (id: number) =>
      document("Bold", [
        Buffer.concat([
          run(4),
          b(2, Buffer.concat([n(3, 1), b(9, Buffer.alloc(16, id))])),
          n(5, 1),
        ]),
      ]);
    const before = parseRichNote(doc(1)),
      after = parseRichNote(doc(2));
    expect(before.styleRuns).toEqual(after.styleRuns);
    expect(before.revision).not.toBe(after.revision);
  });
  it("decodes the paragraph style, block-quote level and highlight of each run", () => {
    const runs = parseRichNote(
      document("Qcode\nhi", [
        Buffer.concat([run(1), b(2, Buffer.concat([n(1, 3), n(8, 1)]))]),
        Buffer.concat([run(5), b(2, n(1, 4))]),
        Buffer.concat([run(1)]),
        Buffer.concat([run(1), n(14, 2)]),
      ])
    ).styleRuns;
    expect(
      runs?.map(({ paragraphStyle, blockQuote, highlight }) => [
        paragraphStyle,
        blockQuote,
        highlight,
      ])
    ).toEqual([
      [3, true, false],
      [4, false, false],
      [3, false, false],
      [3, false, true],
    ]);
  });
  it("retains paragraph formatting, checklist identities and unknown fields in style comparison", () => {
    const style = (paragraph: Buffer) =>
      parseRichNote(document("A", [Buffer.concat([run(1), b(2, paragraph)])])).styleRuns;
    expect(style(n(2, 1))).not.toEqual(style(n(2, 2)));
    expect(style(n(4, 1))).not.toEqual(style(n(4, 2)));
    expect(style(n(8, 0))).not.toEqual(style(n(8, 1)));
    expect(style(b(5, Buffer.concat([b(1, Buffer.alloc(16, 1)), n(2, 0)])))).not.toEqual(
      style(b(5, Buffer.concat([b(1, Buffer.alloc(16, 2)), n(2, 0)])))
    );
    expect(style(b(9, "unexpected"))).not.toEqual(style(b(9, "different")));
    expect(style(n(15, 1))).not.toEqual(style(n(15, 2)));
    expect(style(Buffer.from([0x7d, 1, 0, 0, 0]))).not.toEqual(
      style(Buffer.from([0x7d, 2, 0, 0, 0]))
    );
    expect(style(Buffer.from([0x4a, 16, 1]))).not.toEqual(style(Buffer.from([0x4a, 16, 2])));
  });
  it("reads only the requested note read-only and ignores stale native tag rows", () => {
    const attachment = Buffer.concat([run(1), b(12, b(1, "active-tag"))]);
    const blob = gzipSync(document("\ufffc", [attachment])).toString("hex");
    vi.mocked(execFileSync).mockReturnValue(
      blob + "\n" + JSON.stringify({ "active-tag": "#project", "deleted-tag": "#old" }) + "\n"
    );
    const result = readRichNote("x-coredata://ABCDEF/ICNote/p12");
    expect(result.nativeTags).toEqual(["project"]);
    expect(vi.mocked(execFileSync).mock.lastCall?.[1]).toEqual(
      expect.arrayContaining(["-readonly", expect.stringContaining("ZNOTE=12")])
    );
  });
  it("retains and sorts metadata for referenced native objects", () => {
    const first = Buffer.concat([run(1), b(12, b(1, "object-b"))]);
    const second = Buffer.concat([run(1), b(12, b(1, "object-a"))]);
    const blob = gzipSync(document("\ufffc\ufffc", [first, second])).toString("hex");
    vi.mocked(execFileSync).mockReturnValue(
      blob +
        "\n{}\n" +
        JSON.stringify([
          { id: "object-b", pk: 2, type: "table", mergeable: "BB", view: 1 },
          { id: "object-a", pk: 1, type: "attachment", mergeable: "AA", view: 0 },
          { id: "stale", pk: 3, type: "tag", mergeable: "CC", view: 0 },
        ]) +
        "\n"
    );
    expect(readRichNote("x-coredata://ABCDEF/ICNote/p12").objectData).toEqual([
      { id: "object-a", pk: 1, type: "attachment", mergeable: "AA", view: 0 },
      { id: "object-b", pk: 2, type: "table", mergeable: "BB", view: 1 },
    ]);
  });
  it("reports a native object referenced twice once, at its first position (#197)", () => {
    const ref = (id: string) => Buffer.concat([run(1), b(12, b(1, id))]);
    const blob = gzipSync(
      document("\ufffc\ufffc\ufffc", [ref("object-b"), ref("object-a"), ref("object-b")])
    ).toString("hex");
    vi.mocked(execFileSync).mockReturnValue(
      blob +
        "\n{}\n" +
        JSON.stringify([
          { id: "object-b", pk: 2, type: "attachment", mergeable: "B1", view: 1 },
          { id: "object-a", pk: 1, type: "attachment", mergeable: "AA", view: 0 },
          { id: "object-b", pk: 2, type: "attachment", mergeable: "B2", view: 1 },
        ]) +
        "\n"
    );
    const result = readRichNote("x-coredata://ABCDEF/ICNote/p12");
    expect(result.nativeObjectIds).toEqual(["object-b", "object-a"]);
    expect(result.objects?.map((o) => [o.id, o.start])).toEqual([
      ["object-b", 0],
      ["object-a", 1],
    ]);
    expect(result.objectData).toEqual([
      { id: "object-a", pk: 1, type: "attachment", mergeable: "AA", view: 0 },
      { id: "object-b", pk: 2, type: "attachment", mergeable: "B1", view: 1 },
    ]);
  });
  it("deduplicates native checklist runs by their stable item ID", () => {
    const item = (id: number, done: number) =>
      Buffer.concat([
        run(2),
        b(
          2,
          Buffer.concat([n(1, 103), b(5, Buffer.concat([b(1, Buffer.alloc(16, id)), n(2, done)]))])
        ),
      ]);
    const parsed = parseRichNote(document("A\nB\n", [item(1, 0), item(1, 0)]));
    expect(parsed.checklistItems).toEqual([
      { id: Buffer.alloc(16, 1).toString("hex"), start: 0, text: "A", done: false },
    ]);
  });
  describe("checklist line attribution (#187)", () => {
    const id = (value: number) => Buffer.alloc(16, value);
    const checklist = (length: number, item: number, done = 0) =>
      Buffer.concat([
        run(length),
        b(2, Buffer.concat([n(1, 103), b(5, Buffer.concat([b(1, id(item)), n(2, done)]))])),
      ]);
    const items = (text: string, runs: Buffer[]) =>
      parseRichNote(document(text, runs)).checklistItems;

    it("gives a run that starts on the preceding newline to the line after it", () => {
      // macOS 27.2 layout: "Title\nPlain" is plain, "\nNew item" is the checklist run.
      expect(items("Title\nPlain\nNew item", [run(11), checklist(9, 1)])).toEqual([
        { id: id(1).toString("hex"), start: 12, text: "New item", done: false },
      ]);
    });
    it("keeps a run that starts at the line's first character on that line", () => {
      // Long-standing layout: the run covers "Old item\n".
      expect(items("Title\nOld item\nAfter", [run(6), checklist(9, 1), run(5)])).toEqual([
        { id: id(1).toString("hex"), start: 6, text: "Old item", done: false },
      ]);
    });
    it("attributes both layouts in one note and reads a checked newline-led item", () => {
      expect(items("Title\nFirst\nSecond", [run(6), checklist(5, 1), checklist(7, 2, 1)])).toEqual([
        { id: id(1).toString("hex"), start: 6, text: "First", done: false },
        { id: id(2).toString("hex"), start: 12, text: "Second", done: true },
      ]);
    });
    it("keeps a split-off newline-only run with the line it terminates", () => {
      // A line whose characters carry different attributes is split into
      // several runs; its terminating newline can be a run of its own.
      expect(
        items("Title\nBold item\nNext", [
          run(6),
          checklist(4, 1),
          checklist(5, 1),
          checklist(1, 1),
          run(4),
        ])
      ).toEqual([{ id: id(1).toString("hex"), start: 6, text: "Bold item", done: false }]);
    });
  });
  it("blocks writes when the rich store is unavailable and rejects noncanonical IDs", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("access denied");
    });
    expect(enrichNoteRead("x-coredata://ABCDEF/ICNote/p12", "<div>Hello</div>")).toMatchObject({
      writable: false,
      complete: false,
    });
    expect(() => readRichNote("x-coredata://ABCDEF/ICNote/p12;DROP TABLE x")).toThrow(/Invalid/);
  });
  it("keeps verified native metadata when an object's HTML cannot be restored", () => {
    const native = Buffer.concat([run(1), b(12, b(1, "tag-id"))]);
    const blob = gzipSync(document("\ufffc", [native])).toString("hex");
    vi.mocked(execFileSync).mockReturnValue(blob + '\n{"tag-id":"#дроп"}\n');
    const result = enrichNoteRead("x-coredata://ABCDEF/ICNote/p12", "<div>#дроп</div>");
    expect(result.nativeTags).toEqual(["дроп"]);
    expect(result.writable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.revision).not.toBe("unavailable");
  });
  describe("formatting that AppleScript HTML drops (#188, #189)", () => {
    const id = "x-coredata://ABCDEF/ICNote/p12";
    // Attribute-run field 8 = -1 (subscript), a sign-extended 10-byte varint.
    const subscript = Buffer.from([
      0x40, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]);
    const stored = (text: string, runs: Buffer[]) =>
      vi
        .mocked(execFileSync)
        .mockReturnValue(gzipSync(document(text, runs)).toString("hex") + "\n{}\n[]\n");

    it("reads a subscript note and blocks the full-body rewrite that would drop it", () => {
      stored("H2O", [n(1, 1), Buffer.concat([n(1, 1), subscript]), n(1, 1)]);
      const result = enrichNoteRead(id, "<div>H2O</div>");
      expect(result.revision).not.toBe("unavailable");
      expect(result.complete).toBe(true);
      expect(result.writable).toBe(false);
      expect(result.warning).toContain("(subscript)");
      expect(() => assertLinkedWrite(result, "<div>H2O!</div>", "html")).toThrow(/subscript/);
    });

    it("names superscript, alignment and highlight together", () => {
      stored("x2\ny", [
        n(1, 1),
        Buffer.concat([n(1, 2), n(8, 1)]),
        Buffer.concat([n(1, 1), b(2, n(2, 1)), n(14, 3)]),
      ]);
      const result = enrichNoteRead(id, "<div>x2</div><div>y</div>");
      expect(result.writable).toBe(false);
      expect(result.warning).toContain("(superscript, alignment, highlight)");
    });

    it("keeps plain formatted notes writable", () => {
      stored("Bold", [Buffer.concat([n(1, 4), n(5, 1)])]);
      const result = enrichNoteRead(id, "<div><b>Bold</b></div>");
      expect(result).toMatchObject({ writable: true, complete: true });
      expect(result.warning).toBeUndefined();
    });
  });
  it("allows explicit link changes but still blocks native-object replacement", () => {
    const current = read(rich("Link", 0, 4));
    expect(() => assertLinkedWrite(current, "<div>New content</div>", "html", true)).not.toThrow();
    expect(() =>
      assertLinkedWrite({ ...current, writable: false }, "<div>New content</div>", "html", true)
    ).toThrow();
  });
  it("handles semicolonless entities emitted by Apple Notes and literal ampersands", () => {
    const text = "A & B & C";
    const note = rich(text, 0, text.length);
    const result = restoreNoteLinks("<div>A &amp B & C</div>", note);
    expect(linkSignature(htmlLinks(result))).toBe(linkSignature(note.links));
  });
  it("decodes a semicolonless &quot immediately followed by a letter (#166)", () => {
    // AppleScript emits &quot with no trailing semicolon, and Apple's own
    // output routinely runs it straight into the next word (`&quothello`).
    // The legacy-reference lookahead used to treat that as "don't decode",
    // splitting one rich-text `"` into five literal HTML characters and
    // throwing "Notes HTML and rich text do not match".
    const text = 'say "hello" now';
    const note = rich(text, 0, 0);
    const html = "<div>say &quothello&quot now</div>";
    expect(() => restoreNoteLinks(html, note)).not.toThrow();
    expect(restoreNoteLinks(html, note)).toBe(html);
  });
  it("decodes repeated semicolonless &quot runs with no intervening whitespace", () => {
    // The exact shape from the issue's instrumented failure: many adjacent
    // `&quot` occurrences, none terminated by `;`.
    const text = '"wrapup","wrapup","wrapitup","';
    const note = rich(text, 0, 0);
    const html = "<div>&quotwrapup&quot,&quotwrapup&quot,&quotwrapitup&quot,&quot</div>";
    expect(() => restoreNoteLinks(html, note)).not.toThrow();
  });
  it("still requires a trailing semicolon for &apos, which is not a legacy reference", () => {
    const text = "cats'r us";
    const note = rich(text, 0, 0);
    // No semicolon: HTML5 never treats bare "apos" as a reference outside an
    // explicit `;`, so this must read back as five literal characters, not a
    // decoded apostrophe.
    expect(() => restoreNoteLinks("<div>cats&aposr us</div>", note)).toThrow(/do not match/);
    expect(() => restoreNoteLinks("<div>cats&apos;r us</div>", note)).not.toThrow();
  });
  it("decodes a semicolonless &nbsp the same as &quot, per the HTML5 legacy list", () => {
    const text = "a b";
    const note = rich(text, 0, 0);
    // nbsp is whitespace once decoded, so it (like every other decoded
    // character here) is dropped from the comparison stream entirely.
    expect(() => restoreNoteLinks("<div>a&nbspb</div>", note)).not.toThrow();
  });
  it("appends the real exception to the generic warning instead of discarding it", () => {
    // #166 also reported that enrichNoteRead's bare `catch {}` hid the actual
    // mismatch, sending readers to check Full Disk Access / sync for what was
    // really an entity-decoding bug. The specific cause should now survive
    // into the warning text.
    const result = enrichNoteRead("x-coredata://ABCDEF/ICNote/p12", "<div>Other</div>");
    expect(result.writable).toBe(false);
    expect(result.warning).toContain("check Full Disk Access and retry after sync.");
  });
  it("reads actual URLs and accounts for UTF-16 emoji positions", () => {
    const text = "Планы 🐈\nЗадачи";
    const note = rich(text, text.indexOf("Задачи"), 6);
    expect(note.links).toEqual([{ start: 9, length: 6, text: "Задачи", url }]);
    const html = "<div>Планы 🐈</div><div><u>Задачи</u></div>";
    expect(restoreNoteLinks(html, note)).toContain(`<u><a href="${url}">Задачи</a></u>`);
  });
  it("restores only the linked occurrence of a repeated label", () => {
    const text = "Задачи\nЗадачи";
    const note = rich(text, 7, 6);
    expect(restoreNoteLinks("<div>Задачи</div><div>Задачи</div>", note)).toBe(
      `<div>Задачи</div><div><a href="${url}">Задачи</a></div>`
    );
  });
  it("preserves formatting, entities and split attribute runs", () => {
    const text = "A & B";
    const note = rich(text, 0, text.length);
    const html = "<div><b>A &amp; </b><i>B</i></div>";
    const restored = restoreNoteLinks(html, note);
    expect(restored).toContain("<b><a href=");
    expect(restored).toContain("<i><a href=");
    expect(linkSignature(htmlLinks(restored))).toBe(linkSignature(note.links));
  });
  it("does not nest anchors already preserved by AppleScript", () => {
    const note = rich("Link", 0, 4);
    expect(restoreNoteLinks(`<div><a href="${url}">Link</a></div>`, note)).toBe(
      `<div><a href="${url}">Link</a></div>`
    );
  });
  it("rejects a stale database snapshot instead of assigning a URL to other text", () => {
    expect(() => restoreNoteLinks("<div>Other</div>", rich("Link", 0, 4))).toThrow(/do not match/);
  });
  it("rejects malformed run coverage and unsafe link schemes", () => {
    expect(() => parseRichNote(document("Text", [run(2)]))).toThrow(/Incomplete/);
    expect(() => parseRichNote(document("Text", [run(4, "javascript:alert(1)")]))).toThrow(
      /scheme/
    );
  });
  it("skips unsafe links, keeping native objects, only when a read asks for it (#193)", () => {
    const withPhone = document("Call \ufffc", [
      run(5, "tel:+15555550100"),
      Buffer.concat([n(1, 1), b(12, Buffer.concat([b(1, "T1"), b(2, "com.apple.notes.table")]))]),
    ]);
    expect(() => parseRichNote(withPhone)).toThrow(/scheme/);
    const lenient = parseRichNote(withPhone, [], { skipUnsafeLinks: true });
    expect(lenient.links).toEqual([]);
    expect(lenient.objects).toEqual([
      { id: "T1", type: "com.apple.notes.table", start: 5, length: 1 },
    ]);
  });
  it("treats a bare http(s) origin as equal to the same origin with a trailing slash (#172)", () => {
    // Notes rewrites a path-less origin to add a trailing slash on save, so a
    // link written as "https://growthpath.systems" reads back as
    // "https://growthpath.systems/" — the two must produce the same signature
    // or a successful write is reported as an unverified append.
    expect(linkSignature([{ text: "site", url: "https://growthpath.systems" }])).toBe(
      linkSignature([{ text: "site", url: "https://growthpath.systems/" }])
    );
    // A URL that already has a path, query, or fragment is left untouched —
    // only a bare origin is ambiguous.
    expect(linkSignature([{ text: "site", url: "https://growthpath.systems/docs" }])).not.toBe(
      linkSignature([{ text: "site", url: "https://growthpath.systems/docs/" }])
    );
    expect(linkSignature([{ text: "site", url: "https://growthpath.systems?x=1" }])).not.toBe(
      linkSignature([{ text: "site", url: "https://growthpath.systems/?x=1" }])
    );
    // Non-http(s) schemes are unaffected.
    expect(linkSignature([{ text: "n", url: "notes://showNote?identifier=1" }])).toBe(
      linkSignature([{ text: "n", url: "notes://showNote?identifier=1" }])
    );
  });
  it("distinguishes native objects and checklists from plain hashtags", () => {
    expect(parseRichNote(document("#topic", [run(6)])).hasNativeObjects).toBe(false);
    const native = Buffer.concat([run(1), b(12, b(1, "native-tag-id"))]);
    expect(parseRichNote(document("\ufffc", [native]), ["topic"]).hasNativeObjects).toBe(true);
    const checklist = Buffer.concat([run(1), b(2, n(1, 103))]);
    expect(parseRichNote(document("A", [checklist])).hasChecklist).toBe(true);
  });
  it("changes revision when only a destination changes", () => {
    const first = read(rich("Link", 0, 4));
    const second = read(parseRichNote(document("Link", [run(4, "https://example.com")])));
    expect(richContentHash("<u>Link</u>", first)).not.toBe(richContentHash("<u>Link</u>", second));
  });
  it("blocks lossy writes and missing old link occurrences", () => {
    const current = read(rich("Link", 0, 4));
    expect(() => assertLinkedWrite(current, "Link", "plaintext")).toThrow(/format=html/);
    expect(() => assertLinkedWrite(current, "<div>Link</div>", "html")).toThrow(/remove/);
    expect(() =>
      assertLinkedWrite({ ...current, writable: false }, "<div>Link</div>", "html")
    ).toThrow();
    expect(() =>
      assertLinkedWrite(current, `<div><a href="${url}">Link</a> plus text</div>`, "html")
    ).not.toThrow();
  });
  it("accepts links split across formatting wrappers and rejects dropped duplicates", () => {
    const current = read(rich("AB", 0, 2));
    expect(() =>
      assertLinkedWrite(
        current,
        `<b><a href="${url}">A</a></b><i><a href="${url}">B</a></i>`,
        "html"
      )
    ).not.toThrow();
    current.links.push({ ...current.links[0], start: 3 });
    expect(() => assertLinkedWrite(current, `<a href="${url}">AB</a>`, "html")).toThrow(/remove/);
  });
});
