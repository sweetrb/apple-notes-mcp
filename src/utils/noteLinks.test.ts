/**
 * Tests for link and attachment classification. Fixtures are synthetic: block
 * documents are built by hand and preview files live in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineRun, NoteBlock, NoteBlocksDocument } from "./noteBlocks.js";
import {
  attachmentIdFor,
  cardLink,
  classifyAttachmentKind,
  inlineLinks,
  isDrawingUti,
  isSafeLink,
  markerPosition,
  nativeLink,
  parseNotesShowUrl,
  rankPreviews,
  resolvePreviewPath,
  type PreviewRow,
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

describe("classifyAttachmentKind", () => {
  it.each([
    ["public.url", "url"],
    ["com.apple.notes.table", "table"],
    ["com.apple.notes.gallery", "gallery"],
    ["com.apple.paper.doc.scan", "scan"],
    ["com.apple.paper.doc.pdf", "pdf"],
    ["com.adobe.pdf", "pdf"],
    ["com.apple.paper", "drawing"],
    ["com.apple.drawing.2", "drawing"],
    ["com.apple.drawing", "drawing"],
    ["com.apple.m4a-audio", "audio"],
    ["public.mpeg-4-audio", "audio"],
    ["public.mp3", "audio"],
    ["com.apple.quicktime-movie", "video"],
    ["public.mpeg-4", "video"],
    ["com.apple.mapkit.map", "map"],
    ["public.jpeg", "image"],
    ["public.heic", "image"],
    ["com.adobe.raw-image", "image"],
    ["com.compuserve.gif", "image"],
    ["public.plain-text", "file"],
    ["public.bitmap-archive", "file"],
    ["", "file"],
    [null, "file"],
  ])("%s -> %s", (uti, kind) => {
    expect(classifyAttachmentKind(uti)).toBe(kind);
  });

  it("counts classic and Paper drawings but not Paper scans as drawings", () => {
    expect(isDrawingUti("com.apple.paper")).toBe(true);
    expect(isDrawingUti("com.apple.drawing.2")).toBe(true);
    expect(isDrawingUti("com.apple.paper.doc.scan")).toBe(false);
    expect(isDrawingUti(undefined)).toBe(false);
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

  it("maps a note id to an attachment id in the same store", () => {
    expect(attachmentIdFor("x-coredata://AB-12/ICNote/p7", 99)).toBe(
      "x-coredata://AB-12/ICAttachment/p99"
    );
  });
});

describe("previews", () => {
  let store: string;
  const row = (
    identifier: string | null,
    width: number,
    appearance = 0,
    scale = 1
  ): PreviewRow => ({
    attachment: 1,
    identifier,
    width,
    height: width,
    scale,
    appearance,
  });

  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "note-links-"));
    const previews = join(store, "Accounts", "ACCT-1", "Previews");
    mkdirSync(previews, { recursive: true });
    writeFileSync(join(previews, "FLAT-1-1-100x100-0.png"), "png");
    writeFileSync(join(previews, "BARE-1-1-100x100-0"), "png");
    mkdirSync(join(previews, "BUNDLE-1-1-400x400-0", "1_ABC"), { recursive: true });
    writeFileSync(join(previews, "BUNDLE-1-1-400x400-0", "1_ABC", "Preview.png"), "png");
    mkdirSync(join(previews, "EMPTY-1-1-900x900-0", "1_ABC"), { recursive: true });
    mkdirSync(join(previews, "HUGE-1"), { recursive: true });
    for (let i = 0; i < 70; i++) mkdirSync(join(previews, "HUGE-1", `d${i}`));
    writeFileSync(join(store, "outside.png"), "png");
    symlinkSync(join(store, "outside.png"), join(previews, "ESCAPE-1.png"));
    mkdirSync(join(store, "Accounts", "EMPTY-ACCT"), { recursive: true });
  });
  afterAll(() => rmSync(store, { recursive: true, force: true }));

  it("ranks light renditions first, then by pixel area", () => {
    const ranked = rankPreviews([
      row("small", 10),
      row("dark", 999, 1),
      row("big", 50, 0, 2),
      { ...row("nulls", 1), width: null, height: null, scale: null, appearance: null },
    ]);
    expect(ranked.map((r) => r.identifier)).toEqual(["big", "small", "nulls", "dark"]);
  });

  it("resolves flat files, extensionless files and bundle directories", () => {
    const flat = resolvePreviewPath(store, "ACCT-1", [row("FLAT-1-1-100x100-0", 100)]);
    expect(flat).toMatch(/Previews\/FLAT-1-1-100x100-0\.png$/);
    expect(resolvePreviewPath(store, "ACCT-1", [row("BARE-1-1-100x100-0", 100)])).toMatch(
      /BARE-1-1-100x100-0$/
    );
    expect(
      resolvePreviewPath(store, "ACCT-1", [
        row("FLAT-1-1-100x100-0", 100),
        row("BUNDLE-1-1-400x400-0", 400),
      ])
    ).toMatch(/BUNDLE-1-1-400x400-0\/1_ABC\/Preview\.png$/);
  });

  it("falls back past empty or oversized bundles and missing files", () => {
    expect(
      resolvePreviewPath(store, "ACCT-1", [
        row("EMPTY-1-1-900x900-0", 900),
        row("HUGE-1", 800),
        row("MISSING-1", 700),
        row("FLAT-1-1-100x100-0", 100),
      ])
    ).toMatch(/FLAT-1-1-100x100-0\.png$/);
    expect(resolvePreviewPath(store, "ACCT-1", [row("MISSING-1", 700)])).toBeNull();
  });

  it("refuses unsafe identifiers, symlink escapes and unknown accounts", () => {
    expect(resolvePreviewPath(store, "ACCT-1", [row("../outside", 1)])).toBeNull();
    expect(resolvePreviewPath(store, "ACCT-1", [row(null, 1)])).toBeNull();
    expect(resolvePreviewPath(store, "ACCT-1", [row("ESCAPE-1", 1)])).toBeNull();
    expect(resolvePreviewPath(store, "../Accounts", [row("FLAT-1-1-100x100-0", 1)])).toBeNull();
    expect(resolvePreviewPath(store, null, [row("FLAT-1-1-100x100-0", 1)])).toBeNull();
    expect(resolvePreviewPath(store, "NO-SUCH", [row("FLAT-1-1-100x100-0", 1)])).toBeNull();
    expect(resolvePreviewPath(store, "EMPTY-ACCT", [row("FLAT-1-1-100x100-0", 1)])).toBeNull();
  });
});
