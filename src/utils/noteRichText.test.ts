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
