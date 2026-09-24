/**
 * Asset lookup and placement against a synthetic Notes container on disk.
 * Every file is created in a temp directory; the live library is never read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetLocator,
  assertExportPath,
  confine,
  DataUrlWriter,
  encodePathUrl,
  MAX_EMBED_BYTES,
  MAX_EMBED_TOTAL_BYTES,
  NOTES_CONTAINER,
  openCreateOnly,
  OutputExistsError,
  previewArea,
  safeAssetName,
  safeComponent,
  SidecarWriter,
  sniffMime,
  writeAllAndClose,
} from "./exportAssets.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7 synthetic");
const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const IMG = "AAAAAAAA-0000-0000-0000-000000000001";
const PAPER = "AAAAAAAA-0000-0000-0000-000000000002";
const SCAN = "AAAAAAAA-0000-0000-0000-000000000003";
const LINK = "AAAAAAAA-0000-0000-0000-000000000004";
const BUNDLED = "AAAAAAAA-0000-0000-0000-000000000005";
const ESCAPE = "AAAAAAAA-0000-0000-0000-000000000006";

let root: string;
let container: string;
let account: string;
let out: string;

const put = (path: string, data: Buffer | string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
};

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "export-assets-")));
  container = join(root, "group.com.apple.notes");
  account = join(container, "Accounts", ACCOUNT);
  out = join(root, "out");
  mkdirSync(out);
  put(join(account, "Media", "MEDIA-1", "1_GEN", "photo one.jpg"), JPG);
  put(join(account, "Media", "MEDIA-2", "flat.png"), PNG);
  put(join(account, "FallbackImages", PAPER, "3_GEN", "FallbackImage.png"), PNG);
  put(join(account, "FallbackPDFs", SCAN, "1_GEN", "FallbackPDF.pdf"), PDF);
  put(join(account, "Previews", `${SCAN}-1-200x100-0.png`), PNG);
  put(join(account, "Previews", `${LINK}-1-88x88-0.png`), PNG);
  put(join(account, "Previews", `${LINK}-1-1024x576-0`), JPG);
  put(join(account, "Previews", `${LINK}-1-10x10-0.plist`), "not an image");
  put(join(account, "Previews", `${BUNDLED}-1-300x300-0`, "1_UUID", "Preview.png"), PNG);
  put(join(root, "secret.png"), PNG);
  mkdirSync(join(account, "Media", "MEDIA-3"), { recursive: true });
  symlinkSync(join(root, "secret.png"), join(account, "Media", "MEDIA-3", "escape.png"));
  put(join(account, "Previews", `${ESCAPE}-1-50x50-0`, "note.txt"), "x");
  put(join(container, "Accounts", "not-a-dir"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("path helpers", () => {
  it("accepts single components only", () => {
    expect(safeComponent("abc")).toBe("abc");
    for (const bad of [undefined, null, "", ".", "..", "a/b", "a\\b", "a\0", "x".repeat(256)])
      expect(safeComponent(bad)).toBeUndefined();
  });

  it("confines to a canonical root", () => {
    expect(confine(join(account, "Media", "MEDIA-2", "flat.png"), account)).toContain("flat.png");
    expect(confine(join(account, "Media", "MEDIA-3", "escape.png"), account)).toBeUndefined();
    expect(confine(join(account, "missing"), account)).toBeUndefined();
  });

  it("reads the pixel area from the last size token", () => {
    expect(previewArea("X-1-1024x576-0")).toBe(1024 * 576);
    expect(previewArea("X-1-88x88-0.png")).toBe(88 * 88);
    expect(previewArea("X-1")).toBe(0);
  });

  it("sniffs MIME types by magic bytes, then extension", () => {
    expect(sniffMime(PNG, "x")).toBe("image/png");
    expect(sniffMime(JPG, "x")).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a"), "x")).toBe("image/gif");
    expect(sniffMime(PDF, "x")).toBe("application/pdf");
    expect(sniffMime(Buffer.from("\0\0\0\x18ftypheic", "latin1"), "x")).toBe("image/heic");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WEBP"), "x")).toBe("image/webp");
    expect(sniffMime(Buffer.from("zz"), "a.M4A")).toBe("audio/mp4");
    expect(sniffMime(Buffer.from("zz"), "a.bin")).toBe("application/octet-stream");
  });

  it("builds safe copy names and encoded URLs", () => {
    expect(safeAssetName("../a/b/My Photo (1).jpg", "image/jpeg")).toBe("My Photo _1_.jpg");
    expect(safeAssetName("preview", "image/png")).toBe("preview.png");
    expect(safeAssetName("...", "application/x-unknown")).toBe("attachment");
    const long = safeAssetName(`${"n".repeat(300)}.jpeg`, "image/jpeg");
    expect(long).toHaveLength(120);
    expect(long.endsWith(".jpeg")).toBe(true);
    expect(encodePathUrl("a b/c#d.png")).toBe("a%20b/c%23d.png");
  });

  it("refuses export paths inside the Notes container or outside the allowlist", () => {
    expect(assertExportPath(join(out, "doc.md"), container)).toBe(join(out, "doc.md"));
    expect(() => assertExportPath(join(container, "x.md"), container)).toThrow(/Notes library/);
    expect(() => assertExportPath(join(account, "Media", "x.md"), container)).toThrow(
      /Notes library/
    );
    expect(() => assertExportPath("relative.md", container)).toThrow(/absolute/);
    expect(() => assertExportPath("/etc/x.md", container)).toThrow(/outside allowed/);
    expect(() => assertExportPath(join(NOTES_CONTAINER, "x.md"))).toThrow(/Notes library/);
  });
});

describe("AssetLocator", () => {
  const locator = () => new AssetLocator(container);

  it("lists only account directories", () => {
    expect(locator().accountDirs).toEqual([account]);
    expect(new AssetLocator(join(root, "missing")).accountDirs).toEqual([]);
  });

  it("finds media with and without a generation directory", () => {
    const withGen = locator().locate({
      id: IMG,
      kind: "image",
      mediaId: "MEDIA-1",
      mediaFilename: "photo one.jpg",
      mediaGeneration: "1_GEN",
    });
    expect(withGen.primary).toMatchObject({ name: "photo one.jpg", role: "original" });
    const flat = locator().locate({
      id: IMG,
      kind: "image",
      mediaId: "MEDIA-2",
      mediaFilename: "flat.png",
      mediaGeneration: "9_MISSING",
    });
    expect(flat.primary?.path).toContain("flat.png");
  });

  it("never follows a media symlink out of the account", () => {
    expect(
      locator().locate({ id: IMG, kind: "image", mediaId: "MEDIA-3", mediaFilename: "escape.png" })
    ).toEqual({});
    expect(
      locator().locate({ id: IMG, kind: "image", mediaId: "../x", mediaFilename: "y" })
    ).toEqual({});
    expect(locator().locate({ id: "../bad", kind: "image" })).toEqual({});
  });

  it("uses fallback images for drawings and paper, scanning generations", () => {
    const exact = locator().locate({ id: PAPER, kind: "paper", fallbackImageGeneration: "3_GEN" });
    expect(exact.primary).toMatchObject({ name: "paper.png", role: "fallback" });
    const scanned = locator().locate({ id: PAPER, kind: "drawing" });
    expect(scanned.primary?.name).toBe("drawing.png");
    // Only a recorded generation that is missing makes the rendering stale.
    expect(exact.primary?.stale).toBeUndefined();
    expect(scanned.primary?.stale).toBeUndefined();
  });

  it("flags a rendering from an older generation than the one recorded", () => {
    const stale = locator().locate({ id: PAPER, kind: "paper", fallbackImageGeneration: "9_GONE" });
    expect(stale.primary).toMatchObject({ role: "fallback", stale: true });
    expect(stale.primary?.path).toContain("3_GEN");
  });

  it("falls back to a bundled preview for a drawing without a fallback image", () => {
    const files = locator().locate({ id: BUNDLED, kind: "drawing" });
    expect(files.primary).toMatchObject({ role: "preview" });
    expect(files.primary?.path.endsWith("Preview.png")).toBe(true);
    expect(locator().locate({ id: ESCAPE, kind: "drawing" })).toEqual({});
  });

  it("returns a scan's fallback PDF and preview", () => {
    const files = locator().locate({ id: SCAN, kind: "scan", fallbackPdfGeneration: "1_GEN" });
    expect(files.primary?.name).toBe("scan.pdf");
    expect(files.preview?.role).toBe("preview");
  });

  it("picks the largest preview for a link card and ignores non-images", () => {
    const loc = locator();
    const files = loc.locate({ id: LINK, kind: "link" });
    expect(files.preview?.path).toContain("1024x576");
    expect(loc.locate({ id: LINK.toLowerCase(), kind: "link" }).preview?.path).toContain(
      "1024x576"
    );
    expect(loc.locate({ id: IMG, kind: "link" })).toEqual({});
    expect(loc.locate({ id: IMG, kind: "scan" })).toEqual({});
  });
});

describe("create-only output", () => {
  it("writes a new file and refuses an existing one", () => {
    const path = join(out, "create.md");
    expect(writeAllAndClose(openCreateOnly(path), "héllo")).toBe(6);
    expect(readFileSync(path, "utf8")).toBe("héllo");
    expect(() => openCreateOnly(path)).toThrow(OutputExistsError);
    try {
      openCreateOnly(path);
    } catch (error) {
      expect((error as OutputExistsError).code).toBe("output_exists");
    }
  });

  it("refuses a dangling symlink and reports other errors as-is", () => {
    const link = join(out, "dangling.md");
    symlinkSync(join(out, "nowhere.md"), link);
    expect(() => openCreateOnly(link)).toThrow(OutputExistsError);
    expect(existsSync(join(out, "nowhere.md"))).toBe(false);
    expect(() => openCreateOnly(join(out, "no-such-dir", "x.md"))).toThrow(/ENOENT/);
  });
});

describe("SidecarWriter", () => {
  const png = () => new AssetLocator(container).locate({ id: PAPER, kind: "paper" }).primary!;

  it("copies create-only with numeric suffixes and relative URLs", () => {
    const dir = join(out, "doc.assets");
    mkdirSync(dir);
    writeFileSync(join(dir, "paper.png"), "existing");
    const writer = new SidecarWriter(dir, out);
    const placed = writer.place(png());
    expect(placed).toEqual({ url: "doc.assets/paper-2.png", mime: "image/png" });
    expect(readFileSync(join(dir, "paper.png"), "utf8")).toBe("existing");
    expect(readFileSync(join(dir, "paper-2.png"))).toEqual(PNG);
    expect(writer.place(png())).toBe(placed);
    expect(writer.count).toBe(1);
  });

  it("creates the directory lazily and returns absolute paths without a link base", () => {
    const dir = join(out, "lazy", "assets");
    const writer = new SidecarWriter(dir);
    expect(existsSync(dir)).toBe(false);
    const placed = writer.place({ ...png(), name: "a b.png" });
    expect(placed).toEqual({ url: join(dir, "a b.png"), mime: "image/png" });
  });

  it("reports unreadable sources, refused directories and exhausted names", () => {
    expect(
      new SidecarWriter(out).place({ path: join(root, "nope"), name: "x", role: "original" })
    ).toEqual({
      error: "unreadable",
    });
    expect(
      new SidecarWriter(join(root, "d")).place({ path: account, name: "x", role: "original" })
    ).toEqual({
      error: "unreadable",
    });
    const refused = new SidecarWriter(join(NOTES_CONTAINER, "never-created")).place(png());
    expect("error" in refused && refused.error).toMatch(/Notes library/);
    const full = join(out, "full");
    mkdirSync(full);
    writeFileSync(join(full, "paper.png"), "");
    for (let n = 2; n <= 1000; n++) writeFileSync(join(full, `paper-${n}.png`), "");
    expect(new SidecarWriter(full).place(png())).toEqual({ error: "no-free-name" });
    expect(readdirSync(full)).toHaveLength(1000);
  });

  it("surfaces unexpected open errors", () => {
    const dir = join(out, "ro");
    mkdirSync(dir);
    const blocker = join(dir, "paper.png");
    mkdirSync(blocker);
    const fd = openSync(join(dir, "keep"), "w");
    closeSync(fd);
    const placed = new SidecarWriter(join(dir, "keep")).place(png());
    expect("error" in placed).toBe(true);
  });
});

describe("DataUrlWriter", () => {
  it("embeds small assets once and refuses large or unreadable ones", () => {
    const asset = new AssetLocator(container).locate({ id: SCAN, kind: "scan" }).primary!;
    const writer = new DataUrlWriter();
    const placed = writer.place(asset);
    expect(placed).toEqual({
      url: `data:application/pdf;base64,${PDF.toString("base64")}`,
      mime: "application/pdf",
    });
    expect(writer.place(asset)).toBe(placed);
    expect(writer.count).toBe(1);
    expect(new DataUrlWriter(4).place(asset)).toEqual({ error: "too-large" });
    const budget = new DataUrlWriter(MAX_EMBED_BYTES, PDF.length + 1);
    expect(budget.place(asset)).toMatchObject({ mime: "application/pdf" });
    const png = new AssetLocator(container).locate({ id: PAPER, kind: "paper" }).primary!;
    expect(budget.place(png)).toEqual({ error: "too-large" });
    expect(MAX_EMBED_TOTAL_BYTES).toBe(256 * 1024 * 1024);
    expect(writer.place({ path: join(root, "nope"), name: "x", role: "original" })).toEqual({
      error: "unreadable",
    });
    expect(MAX_EMBED_BYTES).toBe(10 * 1024 * 1024);
  });
});
