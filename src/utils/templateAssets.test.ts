/**
 * Template asset writers, per-note asset directories and template file reads,
 * against real files in a temporary directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEMPLATE_BYTES } from "./markdownTemplate.js";
import {
  HashedSidecarWriter,
  readTemplateFile,
  ReferenceWriter,
  templateAssetsDir,
} from "./templateAssets.js";

let dir: string;
let photo: string;
const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(64, 7)]);
const hash8 = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 8);

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "template-assets-")));
  mkdirSync(join(dir, "lib"));
  photo = join(dir, "lib", "My Photo.png");
  writeFileSync(photo, png);
  writeFileSync(join(dir, "lib", "noext"), Buffer.from("%PDF-1.4"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("HashedSidecarWriter", () => {
  it("copies under a stable content-hashed name and reuses identical copies", () => {
    const out = join(dir, "out1");
    const writer = new HashedSidecarWriter(join(out, "a.assets"), out);
    const placed = writer.place({ path: photo, name: "My Photo.png", role: "original" });
    const name = `My Photo-${hash8(png)}.png`;
    expect(placed).toEqual({ url: `a.assets/${encodeURIComponent(name)}`, mime: "image/png" });
    expect(readFileSync(join(out, "a.assets", name))).toEqual(png);
    expect(writer.place({ path: photo, name: "My Photo.png", role: "original" })).toBe(
      writer.place({ path: photo, name: "My Photo.png", role: "original" })
    );
    expect(writer.count).toBe(1);

    const again = new HashedSidecarWriter(join(out, "a.assets"));
    expect(again.place({ path: photo, name: "My Photo.png", role: "original" })).toEqual({
      url: encodeURI(join(out, "a.assets", name)),
      mime: "image/png",
    });
    expect(again.files).toEqual([join(out, "a.assets", name)]);
    expect(readdirSync(join(out, "a.assets"))).toEqual([name]);

    const pdf = new HashedSidecarWriter(join(out, "b"), out);
    expect(pdf.place({ path: join(dir, "lib", "noext"), name: "noext", role: "fallback" })).toEqual(
      {
        url: `b/noext-${hash8(Buffer.from("%PDF-1.4"))}.pdf`,
        mime: "application/pdf",
      }
    );
  });

  it("never replaces a different file, a symlink, or writes through a symlinked directory", () => {
    const out = join(dir, "out2");
    const target = join(out, `My Photo-${hash8(png)}.png`);
    mkdirSync(out);
    writeFileSync(target, "different");
    const writer = new HashedSidecarWriter(out);
    expect(writer.place({ path: photo, name: "My Photo.png", role: "original" })).toEqual({
      error: "name-taken",
    });
    expect(readFileSync(target, "utf8")).toBe("different");

    const out3 = join(dir, "out3");
    mkdirSync(out3);
    symlinkSync(photo, join(out3, `My Photo-${hash8(png)}.png`));
    expect(
      new HashedSidecarWriter(out3).place({ path: photo, name: "My Photo.png", role: "original" })
    ).toEqual({ error: "destination-not-regular" });

    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "linked"));
    expect(
      new HashedSidecarWriter(join(dir, "linked")).place({
        path: photo,
        name: "My Photo.png",
        role: "original",
      })
    ).toEqual({ error: expect.stringContaining("Refusing to write to the symbolic link") });
    expect(readdirSync(real)).toEqual([]);
  });

  it("reports unreadable sources", () => {
    const writer = new HashedSidecarWriter(join(dir, "out4"));
    expect(writer.place({ path: join(dir, "nope"), name: "x", role: "original" })).toEqual({
      error: "unreadable",
    });
    expect(writer.place({ path: join(dir, "lib"), name: "x", role: "original" })).toEqual({
      error: "unreadable",
    });
  });
});

describe("ReferenceWriter", () => {
  it("links to the original file without copying", () => {
    const absolute = new ReferenceWriter();
    expect(absolute.place({ path: photo, name: "My Photo.png", role: "original" })).toEqual({
      url: encodeURI(photo),
      mime: "image/png",
    });
    const relative = new ReferenceWriter(join(dir, "docs"));
    expect(relative.place({ path: photo, name: "My Photo.png", role: "original" })).toEqual({
      url: "../lib/My%20Photo.png",
      mime: "image/png",
    });
    expect(relative.place({ path: join(dir, "gone"), name: "g", role: "original" })).toEqual({
      error: "unreadable",
    });
    expect(relative.count).toBe(1);
  });
});

describe("templateAssetsDir", () => {
  it("fills note placeholders as safe path components beneath the output directory", () => {
    const values = {
      title: { md: "x", raw: "a/b: c\u0001" },
      folder: "..",
      exportStem: "notes",
      uuid: undefined,
    };
    expect(
      templateAssetsDir("{{exportStem}}.assets/{{title}}/{{folder}}{{uuid}}", "/o", values)
    ).toBe("/o/notes.assets/a_b_ c_/untitled");
    expect(() => templateAssetsDir("../x", "/o", {})).toThrow(
      "resolves outside the output directory"
    );
    expect(() => templateAssetsDir("/abs", "/o", {})).toThrow("outside");
    expect(() => templateAssetsDir(".", "/o", {})).toThrow("outside");
  });
});

describe("readTemplateFile", () => {
  it("reads a regular file in an allowed location", () => {
    const file = join(dir, "t.json");
    writeFileSync(file, '{"schemaVersion":1}');
    expect(readTemplateFile(file)).toBe('{"schemaVersion":1}');
  });

  it("refuses other extensions, missing files, symlinks, directories, oversize files and other locations", () => {
    expect(() => readTemplateFile(join(dir, "missing.json"))).toThrow("Template file not found");
    symlinkSync(join(dir, "t.json"), join(dir, "link.json"));
    expect(() => readTemplateFile(join(dir, "link.json"))).toThrow("symbolic link");
    mkdirSync(join(dir, "folder.json"));
    expect(() => readTemplateFile(join(dir, "folder.json"))).toThrow("not a readable regular file");
    writeFileSync(join(dir, "notes.txt"), '{"schemaVersion":1}');
    expect(() => readTemplateFile(join(dir, "notes.txt"))).toThrow("must have a .json extension");
    expect(() => readTemplateFile(join(dir, "lib"))).toThrow("must have a .json extension");
    writeFileSync(join(dir, "big.json"), Buffer.alloc(MAX_TEMPLATE_BYTES + 1, 32));
    expect(() => readTemplateFile(join(dir, "big.json"))).toThrow("the limit is");
    expect(() => readTemplateFile("/etc/hosts")).toThrow("outside allowed locations");
    expect(() => readTemplateFile("relative.json")).toThrow("must be absolute");
  });
});
