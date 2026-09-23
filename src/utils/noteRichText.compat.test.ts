/**
 * Compatibility lock for the legacy rich-text reader.
 *
 * `parseRichNote`'s `revision` and `styleRuns` feed the write guards
 * (revision tokens, background-edit style comparison). The block model in
 * noteBlocks.ts is additive and must never change them. These golden values
 * were captured from the unmodified reader; if one changes, a write guard's
 * behavior changed with it, and that needs its own review.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseRichNote } from "./noteRichText.js";
import { decodeNoteBlocks } from "./noteBlocks.js";

const varint = (value: number): number[] => {
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
  b(2, b(3, Buffer.concat([b(2, text), ...runs.map((r) => b(5, r))])));
const run = (length: number, ...parts: Buffer[]) => Buffer.concat([n(1, length), ...parts]);

/** Synthetic corpus: every attribute the block model decodes that the legacy reader accepts. */
const corpus: Record<string, Buffer> = {
  plain: doc("Hello\nWorld", [run(11)]),
  styled: doc("Title\nBody bold\n", [
    run(6, b(2, Buffer.concat([n(1, 0), b(9, Buffer.alloc(16, 7))]))),
    run(5),
    run(4, n(5, 1)),
    run(1),
  ]),
  lists: doc("a\nb\nc\n", [
    run(2, b(2, Buffer.concat([n(1, 100), n(4, 1)]))),
    run(2, b(2, Buffer.concat([n(1, 102), n(7, 1)]))),
    run(
      2,
      b(2, Buffer.concat([n(1, 103), b(5, Buffer.concat([b(1, Buffer.alloc(16, 3)), n(2, 1)]))]))
    ),
  ]),
  inline: doc("uSpCH", [
    run(1, n(6, 1)),
    run(1, n(7, 1)),
    run(1, n(8, 1)),
    run(1, b(10, Buffer.concat([f32(1, 1), f32(2, 0), f32(3, 0), f32(4, 1)]))),
    run(1, n(14, 2)),
  ]),
  layout: doc("q\nc\n", [run(2, b(2, Buffer.concat([n(8, 1), n(3, 1)]))), run(2, b(2, n(2, 1)))]),
  links: doc("Link text", [run(4, b(9, "https://example.com")), run(5, b(9, "notes://x"))]),
  attachment: doc("a\ufffc", [
    run(1),
    run(1, b(12, Buffer.concat([b(1, "ATT"), b(2, "public.png")]))),
  ]),
  unknownFields: doc("xy", [run(1, n(13, 1700000000)), run(1, b(15, "z"))]),
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

describe("parseRichNote compatibility", () => {
  it("keeps revision and styleRuns byte-for-byte identical on the synthetic corpus", () => {
    const outputs = Object.fromEntries(
      Object.entries(corpus).map(([name, bytes]) => {
        const rich = parseRichNote(bytes);
        // The guards read only each run's start, length and signature. The
        // decoded paragraphStyle / blockQuote / highlight fields are additive
        // (derived from bytes the signature already covers), so they are
        // projected out and the golden values stay the unmodified reader's.
        const guardRuns = rich.styleRuns?.map(({ start, length, signature }) => ({
          start,
          length,
          signature,
        }));
        // htmlLossyFormatting (#189) is additive in the same way and projected out.
        const legacy: Partial<typeof rich> = { ...rich };
        delete legacy.htmlLossyFormatting;
        return [
          name,
          {
            revision: rich.revision.slice(0, 16),
            styleRuns: digest(guardRuns),
            all: digest({ ...legacy, styleRuns: guardRuns }),
          },
        ];
      })
    );
    expect(outputs).toMatchInlineSnapshot(`
      {
        "attachment": {
          "all": "68c93448d0a8f421",
          "revision": "0172244437dac006",
          "styleRuns": "15ad826700c52155",
        },
        "inline": {
          "all": "79d9925bb7e40e16",
          "revision": "acdacdb4d8d6255b",
          "styleRuns": "4e74169d08c1aa8b",
        },
        "layout": {
          "all": "649def3fc599ba0e",
          "revision": "9ae6df604478d681",
          "styleRuns": "357cc067afb44593",
        },
        "links": {
          "all": "89fb2d1b891309e1",
          "revision": "4d101388ceef0c93",
          "styleRuns": "d8357532f31e3a4a",
        },
        "lists": {
          "all": "a155ea63f91caa96",
          "revision": "e4ef8809b1abe44d",
          "styleRuns": "1b5a3234ad066e68",
        },
        "plain": {
          "all": "0102ee67d40836c2",
          "revision": "47e3f83b4a18e99e",
          "styleRuns": "b26a2e89be52ade5",
        },
        "styled": {
          "all": "4e33b7014cbcfa67",
          "revision": "8cb704a6afe5852e",
          "styleRuns": "d46cdfcc4e4aca1b",
        },
        "unknownFields": {
          "all": "6d66f3796a052d84",
          "revision": "7748358aad30865b",
          "styleRuns": "d37a7b0b29a53843",
        },
      }
    `);
  });

  it("reads subscript runs (10-byte varint) and flags them as HTML-lossy (#188, #189)", () => {
    const bytes = doc("x", [run(1, n(8, -1))]);
    const rich = parseRichNote(bytes);
    expect(rich.text).toBe("x");
    expect(rich.styleRuns?.[0].signature).toBe("[[8,-1]]");
    expect(rich.htmlLossyFormatting).toEqual(["subscript"]);
    expect(decodeNoteBlocks(bytes).blocks[0].runs[0].subscript).toBe(true);
  });

  it("flags superscript, alignment and highlight, ignoring newline-only runs (#189)", () => {
    expect(parseRichNote(corpus.inline).htmlLossyFormatting).toEqual(["superscript", "highlight"]);
    expect(parseRichNote(corpus.layout).htmlLossyFormatting).toEqual(["alignment"]);
    for (const name of ["plain", "styled", "lists", "links", "attachment", "unknownFields"])
      expect(parseRichNote(corpus[name]).htmlLossyFormatting).toBeUndefined();
    // Explicit left alignment (0) is the default and is not lossy.
    expect(parseRichNote(doc("a", [run(1, b(2, n(2, 0)))])).htmlLossyFormatting).toBeUndefined();
    // Formatting left on a trailing newline alone cannot be lost by a rewrite.
    expect(
      parseRichNote(doc("a\n", [run(1), run(1, n(8, 1))])).htmlLossyFormatting
    ).toBeUndefined();
  });

  it("decodes every corpus document into blocks whose text matches the legacy reader", () => {
    for (const bytes of Object.values(corpus)) {
      const rich = parseRichNote(bytes);
      const blocks = decodeNoteBlocks(bytes);
      expect(blocks.text).toBe(rich.text);
      expect(blocks.blocks.map((block) => block.text).join("\n")).toBe(
        rich.text.replace(/\n$/, "")
      );
      expect(blocks.attachments.map((a) => a.id)).toEqual(rich.nativeObjectIds);
      expect(blocks.blocks.flatMap((block) => (block.checklist ? [block.checklist] : []))).toEqual(
        (rich.checklistItems ?? []).map(({ id, done }) => ({ id, done }))
      );
    }
  });
});
