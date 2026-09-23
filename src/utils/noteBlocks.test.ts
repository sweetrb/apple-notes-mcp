/**
 * Tests for the typed note-body block model. Every fixture is synthetic and
 * built with a small protobuf encoder, so the wire layout under test is
 * explicit in each case.
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  decodeCompressedNoteBlocks,
  decodeNoteBlocks,
  NoteBlocksError,
  pageNoteBlocks,
  blocksMaxResponseBytes,
} from "./noteBlocks.js";
import { parseRichNote } from "./noteRichText.js";

const varint = (value: number | bigint): number[] => {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
};
const n = (field: number, value: number) => Buffer.from([...varint(field * 8), ...varint(value)]);
const b = (field: number, value: Buffer | string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes]);
};
const f32 = (field: number, value: number) => {
  const bytes = Buffer.alloc(5);
  bytes[0] = field * 8 + 5;
  bytes.writeFloatLE(value, 1);
  return bytes;
};
const doc = (text: string, runs: Buffer[]) =>
  b(2, Buffer.concat([n(1, 0), b(3, Buffer.concat([b(2, text), ...runs.map((r) => b(5, r))]))]));
const run = (length: number, ...parts: Buffer[]) => Buffer.concat([n(1, length), ...parts]);
const para = (...parts: Buffer[]) => b(2, Buffer.concat(parts));
const uuid = (fill: number) => Buffer.alloc(16, fill);

describe("decodeNoteBlocks", () => {
  it("splits paragraphs and maps every confirmed paragraph style", () => {
    const lines: Array<[string, number | null]> = [
      ["T", 0],
      ["H", 1],
      ["S", 2],
      ["B", null],
      ["M", 4],
      ["*", 100],
      ["-", 101],
      ["1", 102],
      ["?", 7],
    ];
    const text = lines.map(([t]) => t).join("\n") + "\n";
    const decoded = decodeNoteBlocks(
      doc(
        text,
        lines.map(([, style]) => run(2, para(...(style === null ? [] : [n(1, style)]))))
      )
    );
    expect(decoded.blocks.map((block) => [block.text, block.style, block.styleType])).toEqual([
      ["T", "title", 0],
      ["H", "heading", 1],
      ["S", "subheading", 2],
      ["B", "body", null],
      ["M", "monospaced", 4],
      ["*", "bulleted", 100],
      ["-", "dashed", 101],
      ["1", "numbered", 102],
      ["?", "unknown", 7],
    ]);
    expect(decoded.blocks.map((block) => block.start)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it("decodes checklist state, indent, alignment, block quote and paragraph UUID", () => {
    const decoded = decodeNoteBlocks(
      doc("a\nb\nc\nd\n", [
        run(2, para(n(1, 103), b(5, Buffer.concat([b(1, uuid(1)), n(2, 1)])), b(9, uuid(0xab)))),
        run(2, para(n(1, 103), b(5, Buffer.concat([b(1, uuid(2)), n(2, 0)])), n(4, 2))),
        run(2, para(n(2, 1), n(8, 1))),
        run(2, para(n(2, 9))),
      ])
    );
    const [a, bb, c, d] = decoded.blocks;
    expect(a.checklist).toEqual({ id: "01".repeat(16), done: true });
    expect(a.paragraphUuid).toBe("ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB");
    expect(bb).toMatchObject({ checklist: { id: "02".repeat(16), done: false }, indent: 2 });
    expect(c).toMatchObject({ alignment: "center", blockQuote: true, style: "body" });
    expect(d).toMatchObject({ alignment: "unknown", alignmentValue: 9 });
    expect(decoded.summary.checklist).toEqual({ total: 2, done: 1 });
  });

  it("treats the proto default style_type -1 as body", () => {
    const decoded = decodeNoteBlocks(doc("x", [run(1, para(n(1, -1)))]));
    expect(decoded.blocks[0]).toMatchObject({ style: "body", styleType: null });
  });

  it("decodes inline attributes including negative (10-byte) subscript varints", () => {
    const text = "bBiIuSpsCHL";
    const decoded = decodeNoteBlocks(
      doc(text, [
        run(1, n(5, 1)),
        run(1, b(3, n(3, 1))),
        run(1, n(5, 2)),
        run(1, n(5, 3)),
        run(1, n(6, 1)),
        run(1, n(7, 1)),
        run(1, n(8, 1)),
        run(1, n(8, -1)),
        run(1, b(10, Buffer.concat([f32(1, 1), f32(2, 0.5), f32(3, 0), f32(4, 0.5)]))),
        run(1, n(14, 4)),
        run(1, b(9, "https://example.com/")),
      ])
    );
    const runs = decoded.blocks[0].runs;
    expect(runs.map(({ start: _s, length: _l, text: _t, ...attrs }) => attrs)).toEqual([
      { bold: true },
      { bold: true },
      { italic: true },
      { bold: true, italic: true },
      { underline: true },
      { strikethrough: true },
      { superscript: true },
      { subscript: true },
      { color: "#FF800080" },
      { highlight: "mint" },
      { link: "https://example.com/", linkSafe: true },
    ]);
    expect(decoded.summary.inline).toMatchObject({
      bold: 3,
      italic: 2,
      superscript: 1,
      subscript: 1,
      color: 1,
      highlight: 1,
      link: 1,
      unsafeLink: 0,
    });
  });

  it("formats opaque colors without alpha and keeps unknown highlight values raw", () => {
    const decoded = decodeNoteBlocks(
      doc("ab", [
        run(1, b(10, Buffer.concat([f32(1, 0), f32(2, 0), f32(3, 1), f32(4, 1)]))),
        run(1, n(14, 42)),
      ])
    );
    expect(decoded.blocks[0].runs[0].color).toBe("#0000FF");
    expect(decoded.blocks[0].runs[1]).toMatchObject({ highlight: "unknown", highlightValue: 42 });
  });

  it("reports font name and size", () => {
    const decoded = decodeNoteBlocks(
      doc("x", [run(1, b(3, Buffer.concat([b(1, "Courier"), f32(2, 13)])))])
    );
    expect(decoded.blocks[0].runs[0].font).toEqual({ name: "Courier", size: 13 });
  });

  it("returns links with other schemes as data instead of throwing", () => {
    const bytes = doc("call", [run(4, b(9, "tel:+15555550100"))]);
    // The legacy reader fails closed on this scheme (a write-safety guard).
    expect(() => parseRichNote(bytes)).toThrow(/scheme/);
    const decoded = decodeNoteBlocks(bytes);
    expect(decoded.blocks[0].runs[0]).toMatchObject({
      link: "tel:+15555550100",
      linkSafe: false,
    });
    expect(decoded.summary.inline.unsafeLink).toBe(1);
  });

  it("places attachment markers in body order with their block", () => {
    const decoded = decodeNoteBlocks(
      doc("a\ufffc\n\ufffc", [
        run(1),
        run(1, b(12, Buffer.concat([b(1, "ATT-1"), b(2, "public.jpeg")]))),
        run(1),
        run(1, b(12, b(1, "ATT-2"))),
      ])
    );
    expect(decoded.attachments).toEqual([
      { id: "ATT-1", uti: "public.jpeg", start: 1, blockIndex: 0 },
      { id: "ATT-2", uti: "unknown", start: 3, blockIndex: 1 },
    ]);
    expect(decoded.blocks[0].runs[1].attachment).toEqual({ id: "ATT-1", uti: "public.jpeg" });
    expect(decoded.blocks[1].attachments).toHaveLength(1);
  });

  it("splits a run that spans paragraphs and keeps empty paragraphs", () => {
    const decoded = decodeNoteBlocks(doc("ab\n\ncd", [run(3, n(5, 1)), run(3, para(n(1, 100)))]));
    expect(decoded.blocks.map((block) => [block.text, block.style])).toEqual([
      ["ab", "body"],
      ["", "bulleted"],
      ["cd", "bulleted"],
    ]);
    expect(decoded.blocks[0].runs).toEqual([{ start: 0, length: 2, text: "ab", bold: true }]);
    expect(decoded.blocks[1].runs).toEqual([]);
    expect(decoded.blocks[2].runs).toEqual([{ start: 4, length: 2, text: "cd" }]);
  });

  it("counts UTF-16 code units the way Notes does", () => {
    const text = "😀x\ny";
    const decoded = decodeNoteBlocks(doc(text, [run(2, n(5, 1)), run(3)]));
    expect(decoded.textLength).toBe(5);
    expect(decoded.blocks[0].runs.map((r) => r.text)).toEqual(["😀", "x"]);
    expect(decoded.blocks[1]).toMatchObject({ start: 4, text: "y" });
  });

  it("counts fields it does not interpret instead of guessing", () => {
    const decoded = decodeNoteBlocks(
      doc("ab", [run(1, n(13, 1700000000), para(n(3, 1), n(7, 2))), run(1, b(15, "x"))])
    );
    expect(decoded.undecodedFields).toEqual({
      attributeRun: { "13": 1, "15": 1 },
      paragraphStyle: { "3": 1, "7": 1 },
    });
  });

  it("rejects malformed documents with stable error codes", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof NoteBlocksError ? error.code : String(error);
      }
      return "no error";
    };
    expect(code(() => decodeNoteBlocks(Buffer.from([0x12, 0x05, 0x01])))).toBe(
      "malformed-protobuf"
    );
    expect(code(() => decodeNoteBlocks(b(2, n(1, 1))))).toBe("unsupported-structure");
    expect(code(() => decodeNoteBlocks(doc("abc", [run(2)])))).toBe("invalid-runs");
    expect(code(() => decodeNoteBlocks(doc("a", [run(5)])))).toBe("invalid-runs");
    expect(code(() => decodeCompressedNoteBlocks(Buffer.from("not gzip")))).toBe(
      "decompress-failed"
    );
  });

  it("decodes a gzipped blob", () => {
    const decoded = decodeCompressedNoteBlocks(gzipSync(doc("hi", [run(2)])));
    expect(decoded.blocks[0].text).toBe("hi");
  });
});

describe("pageNoteBlocks", () => {
  const many = decodeNoteBlocks(
    doc(
      Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
      Array.from({ length: 10 }, (_, i) => run(i === 9 ? 6 : 7))
    )
  );

  it("pages by count and reports the next offset", () => {
    const page = pageNoteBlocks(many, { offset: 0, limit: 4, maxBytes: 1e6 });
    expect(page.page).toEqual({ offset: 0, returned: 4, total: 10, hasMore: true, nextOffset: 4 });
    const last = pageNoteBlocks(many, { offset: 8, limit: 4, maxBytes: 1e6 });
    expect(last.page).toEqual({ offset: 8, returned: 2, total: 10, hasMore: false });
    expect(last.summary.blocks).toBe(10);
  });

  it("stops early under the byte cap and always advances", () => {
    const size = Buffer.byteLength(JSON.stringify(many.blocks[0]));
    const page = pageNoteBlocks(many, { limit: 10, maxBytes: size * 2 + 1 });
    expect(page.page.returned).toBe(2);
    const tiny = pageNoteBlocks(many, { limit: 10, maxBytes: 10 });
    expect(tiny.page.returned).toBe(1);
    expect(tiny.blocks[0]).toMatchObject({ text: "", textOmitted: true });
  });

  it("reads the byte cap from the environment", () => {
    expect(blocksMaxResponseBytes({})).toBe(4 * 1024 * 1024);
    expect(blocksMaxResponseBytes({ APPLE_NOTES_MCP_BLOCKS_MAX_BYTES: "1000" })).toBe(1000);
    expect(blocksMaxResponseBytes({ APPLE_NOTES_MCP_BLOCKS_MAX_BYTES: "nope" })).toBe(
      4 * 1024 * 1024
    );
  });
});
