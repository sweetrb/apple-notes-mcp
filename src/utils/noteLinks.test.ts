/**
 * Tests for link classification. Fixtures are synthetic: block documents are
 * built by hand.
 */
import { describe, expect, it } from "vitest";
import {
  isSafeLink,
  type InlineRun,
  type NoteBlock,
  type NoteBlocksDocument,
} from "./noteBlocks.js";
import {
  cardLink,
  inlineLinks,
  markerPosition,
  nativeLink,
  parseNotesShowUrl,
} from "./noteLinks.js";

const NOTE = "0A1B2C3D-0000-4000-8000-00000000000A";
const PARA = "0A1B2C3D-0000-4000-8000-00000000000B";

function block(index: number, start: number, runs: Array<Partial<InlineRun> & { text: string }>) {
  let at = start;
  const built = runs.map((run) => {
    const out = { ...run, start: at, length: run.text.length } as InlineRun;
    at += run.text.length;
    return out;
  });
  return {
    index,
    start,
    length: at - start,
    text: built.map((r) => r.text).join(""),
    style: "body",
    styleType: null,
    indent: 0,
    alignment: "left",
    blockQuote: false,
    runs: built,
    attachments: [],
  } as NoteBlock;
}
const docOf = (blocks: NoteBlock[], markers: NoteBlocksDocument["attachments"] = []) =>
  ({ blocks, attachments: markers }) as unknown as NoteBlocksDocument;

describe("parseNotesShowUrl", () => {
  it("reads note and paragraph UUIDs from both Notes schemes", () => {
    expect(
      parseNotesShowUrl(
        `applenotes://showNote?identifier=${NOTE.toLowerCase()}&paragraphID=${PARA}`
      )
    ).toEqual({ targetNote: NOTE, paragraphId: PARA });
    expect(parseNotesShowUrl(`notes://showNote?identifier=${NOTE}`)).toEqual({ targetNote: NOTE });
  });

  it("ignores other URLs and malformed values", () => {
    expect(parseNotesShowUrl("https://example.com/showNote?identifier=x")).toBeUndefined();
    expect(parseNotesShowUrl("notes://showNote?identifier=not-a-uuid&paragraphId=x")).toEqual({});
  });
});

describe("isSafeLink", () => {
  it("accepts the write-path schemes and rejects others or control characters", () => {
    expect(isSafeLink("https://example.com")).toBe(true);
    expect(isSafeLink("mailto:someone@example.com")).toBe(true);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("https://example.com/\u0007")).toBe(false);
  });
});

describe("inlineLinks", () => {
  it("merges adjacent runs with one destination and keeps separate links apart", () => {
    const doc = docOf([
      block(0, 0, [
        { text: "See " },
        { text: "Exa", link: "https://example.com", linkSafe: true },
        { text: "mple", link: "https://example.com", linkSafe: true, bold: true },
        { text: " and " },
        { text: "x", link: "javascript:alert(1)", linkSafe: false },
      ]),
      block(1, 18, [
        { text: "one", link: `notes://showNote?identifier=${NOTE}`, linkSafe: true },
        { text: "two", link: "https://example.com", linkSafe: true },
      ]),
    ]);
    expect(inlineLinks(doc)).toEqual([
      {
        kind: "inline",
        url: "https://example.com",
        linkSafe: true,
        text: "Example",
        start: 4,
        length: 7,
        blockIndex: 0,
      },
      {
        kind: "inline",
        url: "javascript:alert(1)",
        linkSafe: false,
        text: "x",
        start: 16,
        length: 1,
        blockIndex: 0,
      },
      {
        kind: "inline",
        url: `notes://showNote?identifier=${NOTE}`,
        linkSafe: true,
        text: "one",
        start: 18,
        length: 3,
        blockIndex: 1,
        targetNote: NOTE,
      },
      {
        kind: "inline",
        url: "https://example.com",
        linkSafe: true,
        text: "two",
        start: 21,
        length: 3,
        blockIndex: 1,
      },
    ]);
  });

  it("does not merge equal destinations across a paragraph break", () => {
    const doc = docOf([
      block(0, 0, [{ text: "a", link: "https://example.com", linkSafe: true }]),
      block(1, 2, [{ text: "b", link: "https://example.com", linkSafe: true }]),
    ]);
    expect(inlineLinks(doc)).toHaveLength(2);
  });
});

describe("markerPosition, nativeLink and cardLink", () => {
  const doc = docOf(
    [],
    [
      { id: "chip-1", uti: "com.apple.notes.inlinetextattachment.link", start: 7, blockIndex: 2 },
      { id: "CARD-1", uti: "public.url", start: 3, blockIndex: 1 },
    ]
  );

  it("locates markers case-insensitively and reports rows absent from the body", () => {
    expect(markerPosition(doc, "CHIP-1")).toEqual({ start: 7, blockIndex: 2, inBody: true });
    expect(markerPosition(doc, "missing")).toEqual({ inBody: false });
    expect(markerPosition(undefined, "CHIP-1")).toEqual({});
  });

  it("classifies native chips as section or note links", () => {
    expect(
      nativeLink(
        {
          identifier: "CHIP-1",
          token: `applenotes://showNote?identifier=${NOTE}&paragraphID=${PARA}`,
          alt: "Plans",
        },
        doc
      )
    ).toEqual({
      kind: "section",
      url: `applenotes://showNote?identifier=${NOTE}&paragraphID=${PARA}`,
      linkSafe: true,
      text: "Plans",
      start: 7,
      blockIndex: 2,
      inBody: true,
      targetNote: NOTE,
      paragraphId: PARA,
      section: "Plans",
      attachmentIdentifier: "CHIP-1",
    });
    expect(
      nativeLink({ identifier: "X", token: `notes://showNote?identifier=${NOTE}`, alt: null })
    ).toEqual({
      kind: "note",
      url: `notes://showNote?identifier=${NOTE}`,
      linkSafe: true,
      targetNote: NOTE,
      attachmentIdentifier: "X",
    });
    expect(nativeLink({ identifier: "X", token: "tel:123", alt: "Call" })).toMatchObject({
      kind: "note",
      linkSafe: false,
      text: "Call",
    });
    expect(nativeLink({ identifier: "X", token: null, alt: "x" })).toBeUndefined();
  });

  it("builds card links with ids and previews only when known", () => {
    const row = { pk: 25, identifier: "CARD-1", url: "https://example.com/a", title: "Example" };
    expect(
      cardLink(row, {
        doc,
        noteId: "x-coredata://S/ICNote/p10",
        previewPath: "/tmp/p.png",
      })
    ).toEqual({
      kind: "card",
      url: "https://example.com/a",
      linkSafe: true,
      text: "Example",
      start: 3,
      blockIndex: 1,
      inBody: true,
      attachmentIdentifier: "CARD-1",
      attachmentId: "x-coredata://S/ICAttachment/p25",
      previewPath: "/tmp/p.png",
    });
    expect(cardLink({ ...row, title: null })).toEqual({
      kind: "card",
      url: "https://example.com/a",
      linkSafe: true,
      attachmentIdentifier: "CARD-1",
    });
    expect(cardLink({ ...row, url: null })).toBeUndefined();
  });
});
