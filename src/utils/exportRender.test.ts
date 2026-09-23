/**
 * Format-neutral export pieces: inline pieces, title detection and
 * attachment plans. Locator and writer are in-memory fakes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AssetLocator, AssetWriter, AttachmentFiles, ResolvedAsset } from "./exportAssets.js";
import {
  attachmentLabel,
  blockPieces,
  emptyStats,
  isBlockPlan,
  isSafeHref,
  planAttachment,
  titleBlockIndex,
  unreferencedAttachments,
  type ExportContext,
} from "./exportRender.js";
import { attachment, attachmentRun, block, exportNote } from "./fixtures/exportNote.js";

const tableHex = readFileSync(
  new URL("./fixtures/background-probe-table.gz", import.meta.url)
).toString("hex");
const asset = (name: string, role: ResolvedAsset["role"] = "original"): ResolvedAsset => ({
  path: `/lib/${name}`,
  name,
  role,
});

function context(files: Record<string, AttachmentFiles> = {}, withWriter = true): ExportContext {
  const locator = { locate: (a: { id: string }) => files[a.id] ?? {} } as unknown as AssetLocator;
  const writer: AssetWriter = {
    count: 0,
    place: (a) =>
      a.path.includes("big")
        ? { error: "too-large" }
        : { url: `assets/${a.name}`, mime: "image/png" },
  };
  return { stats: emptyStats(), ...(withWriter ? { locator, writer } : {}) };
}

describe("pieces", () => {
  it("splits runs at attachments, merges equal formatting and keeps only safe links", () => {
    const b = block("ab\ufffcc", "body", {}, [
      { text: "a", bold: true, color: "#FF0000" },
      { text: "b", bold: true, color: "#FF0000" },
      attachmentRun("IMG"),
      { text: "c", link: "javascript:alert(1)", linkSafe: false, italic: true, underline: true },
      { text: "d", link: "https://x.test", linkSafe: true, strikethrough: true, superscript: true },
      { text: "e\ufffc", subscript: true, highlight: "mint" },
    ]);
    const pieces = blockPieces(b, (id) => ({ type: "inline", text: id }));
    expect(pieces).toEqual([
      { type: "text", text: "ab", fmt: { bold: true, color: "#FF0000" } },
      { type: "attachment", id: "IMG", plan: { type: "inline", text: "IMG" } },
      { type: "text", text: "c", fmt: { italic: true, underline: true } },
      {
        type: "text",
        text: "d",
        fmt: { strikethrough: true, superscript: true, link: "https://x.test" },
      },
      { type: "text", text: "e", fmt: { subscript: true, highlight: "mint" } },
    ]);
  });

  it("classifies block plans and safe links", () => {
    expect(isBlockPlan({ type: "table", rows: [] })).toBe(true);
    expect(isBlockPlan({ type: "divider" })).toBe(true);
    expect(isBlockPlan({ type: "gallery", items: [] })).toBe(true);
    expect(isBlockPlan({ type: "inline", text: "" })).toBe(false);
    expect(isSafeHref("https://a")).toBe(true);
    expect(isSafeHref("applenotes:note/x")).toBe(true);
    expect(isSafeHref("tel:123")).toBe(false);
    expect(isSafeHref("https://a\nb")).toBe(false);
    expect(attachmentLabel("scan")).toBe("Scanned document");
  });

  it("finds the title block", () => {
    expect(titleBlockIndex(exportNote([block(""), block("T", "title")]))).toBe(1);
    expect(titleBlockIndex(exportNote([block("Same"), block("x")], [], "Same"))).toBe(0);
    expect(titleBlockIndex(exportNote([block("Same", "heading")], [], "Same"))).toBe(0);
    expect(titleBlockIndex(exportNote([block("code", "monospaced")], [], "code"))).toBe(-1);
    expect(titleBlockIndex(exportNote([block("First")], [], "Other"))).toBe(-1);
    expect(titleBlockIndex(exportNote([block(" ")], [], ""))).toBe(-1);
  });

  it("lists unreferenced top-level attachments except tables and inline text", () => {
    const note = exportNote(
      [block("\ufffc", "body", {}, [attachmentRun("A")])],
      [
        attachment("A", "public.png"),
        attachment("B", "public.png"),
        attachment("T", "com.apple.notes.table"),
        attachment("H", "com.apple.notes.inlinetextattachment.hashtag"),
        attachment("D", "com.apple.notes.inlinetextattachment.dividerline"),
      ]
    );
    expect(unreferencedAttachments(note).map((a) => a.id)).toEqual(["B"]);
  });
});

describe("planAttachment", () => {
  it("plans inline text, note links, dividers and missing rows", () => {
    const ctx = context();
    expect(
      planAttachment(
        attachment("H", "com.apple.notes.inlinetextattachment.hashtag", { altText: "#x" }),
        ctx
      )
    ).toEqual({ type: "inline", text: "#x" });
    expect(
      planAttachment(
        attachment("L", "com.apple.notes.inlinetextattachment.link", {
          altText: "Other",
          tokenId: "applenotes:note/1",
        }),
        ctx
      )
    ).toEqual({ type: "inline", text: "Other", link: "applenotes:note/1" });
    expect(
      planAttachment(
        attachment("L", "com.apple.notes.inlinetextattachment.link", { tokenId: "javascript:x" }),
        ctx
      )
    ).toEqual({ type: "inline", text: "" });
    expect(
      planAttachment(attachment("D", "com.apple.notes.inlinetextattachment.dividerline"), ctx)
    ).toEqual({ type: "divider" });
    expect(planAttachment(undefined, ctx)).toEqual({
      type: "unavailable",
      label: "Attachment",
      reason: "missing",
    });
    expect(ctx.stats).toMatchObject({ attachments: 5, unavailable: 1 });
  });

  it("decodes tables and marks undecodable ones", () => {
    const ctx = context();
    expect(
      planAttachment(attachment("T", "com.apple.notes.table", { tableData: tableHex }), ctx)
    ).toMatchObject({
      type: "table",
      rows: [
        ["Имя", "Статус"],
        ["Проба 🧭", "Готово"],
      ],
    });
    expect(
      planAttachment(attachment("T", "com.apple.notes.table", { tableData: "00" }), ctx)
    ).toMatchObject({ type: "unavailable", label: "Table", reason: "undecodable" });
    expect(planAttachment(attachment("T", "com.apple.notes.table"), ctx).type).toBe("unavailable");
    expect(ctx.stats).toMatchObject({ tables: 3, unreadableTables: 2, unavailable: 2 });
  });

  it("plans link cards with safe URLs and previews", () => {
    const ctx = context({ C: { preview: asset("p.png", "preview") } });
    expect(
      planAttachment(attachment("C", "public.url", { url: "https://e.test", title: "E" }), ctx)
    ).toEqual({
      type: "card",
      title: "E",
      url: "https://e.test",
      displayUrl: "https://e.test",
      previewUrl: "assets/p.png",
    });
    expect(planAttachment(attachment("X", "public.url", { url: "tel:1" }), ctx)).toEqual({
      type: "card",
      title: "tel:1",
      displayUrl: "tel:1",
    });
    expect(planAttachment(attachment("Y", "public.url"), context({}, false))).toEqual({
      type: "card",
      title: "",
      displayUrl: "",
    });
    expect(ctx.stats.placed).toBe(1);
  });

  it("renders placeholders without a writer", () => {
    const ctx = context({}, false);
    expect(planAttachment(attachment("I", "public.png", { title: "a.png" }), ctx)).toEqual({
      type: "placeholder",
      label: "Image",
      name: "a.png",
    });
    expect(planAttachment(attachment("P", "com.adobe.pdf"), ctx)).toEqual({
      type: "placeholder",
      label: "PDF",
    });
    expect(ctx.stats.placeholders).toBe(2);
  });

  it("places originals, previews and fallbacks by kind", () => {
    const ctx = context({
      I: { primary: asset("i.png"), preview: asset("ip.png", "preview") },
      A: { primary: asset("a.m4a") },
      V: { primary: asset("v.mov") },
      F: { primary: asset("f.txt") },
      S: { primary: asset("s.pdf", "fallback"), preview: asset("sp.png", "preview") },
      B: { primary: asset("big.png"), preview: asset("bp.png", "preview") },
      N: { primary: asset("big.pdf") },
    });
    expect(planAttachment(attachment("I", "public.png", { title: "i" }), ctx)).toEqual({
      type: "asset",
      label: "Image",
      name: "i",
      display: "image",
      url: "assets/i.png",
      mime: "image/png",
    });
    expect(planAttachment(attachment("A", "com.apple.m4a-audio"), ctx)).toMatchObject({
      display: "audio",
    });
    expect(planAttachment(attachment("V", "public.movie"), ctx)).toMatchObject({
      display: "video",
    });
    expect(planAttachment(attachment("F", "public.data"), ctx)).toMatchObject({ display: "link" });
    expect(planAttachment(attachment("S", "com.apple.paper.doc.scan"), ctx)).toMatchObject({
      display: "link",
      url: "assets/s.pdf",
      previewUrl: "assets/sp.png",
    });
    expect(planAttachment(attachment("B", "public.png"), ctx)).toMatchObject({
      display: "image",
      url: "assets/bp.png",
    });
    expect(planAttachment(attachment("N", "com.adobe.pdf", { title: "n" }), ctx)).toEqual({
      type: "unavailable",
      label: "PDF",
      reason: "too-large",
      name: "n",
    });
    expect(planAttachment(attachment("Z", "public.png"), ctx)).toMatchObject({ reason: "missing" });
    const noLocator: ExportContext = { stats: emptyStats(), writer: ctx.writer };
    expect(planAttachment(attachment("I", "public.png"), noLocator)).toMatchObject({
      type: "unavailable",
    });
    expect(ctx.stats).toMatchObject({ placed: 6, unavailable: 2 });
  });

  it("plans gallery children without counting the gallery itself", () => {
    const ctx = context({}, false);
    const gallery = attachment("G", "com.apple.notes.gallery", {
      children: [attachment("C1", "public.jpeg"), attachment("C2", "public.jpeg")],
    });
    expect(planAttachment(gallery, ctx)).toEqual({
      type: "gallery",
      items: [
        { type: "placeholder", label: "Image" },
        { type: "placeholder", label: "Image" },
      ],
    });
    expect(ctx.stats.attachments).toBe(2);
  });
});
