/**
 * Template asset writers, per-note asset directories and template file reads,
 * against real files in a temporary directory.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEMPLATE_BYTES } from "./markdownTemplate.js";
import { ALLOW_PRIVATE_CONTENT_ENV } from "./attachmentFs.js";
import {
  HashedSidecarWriter,
  readTemplateFile,
  ReferenceWriter,
  templateAssetsDir,
} from "./templateAssets.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

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

  it("leaves nothing under the hashed name when a copy is interrupted", () => {
    const out = join(dir, "out5");
    const name = `My Photo-${hash8(png)}.png`;
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    const writer = new HashedSidecarWriter(out);
    expect(writer.place({ path: photo, name: "My Photo.png", role: "original" })).toEqual({
      error: expect.stringContaining("ENOSPC"),
    });
    expect(readdirSync(out)).toEqual([]);
    // A later export copies the file instead of reporting the name as taken.
    expect(
      new HashedSidecarWriter(out).place({ path: photo, name: "My Photo.png", role: "original" })
    ).toMatchObject({ mime: "image/png" });
    expect(readdirSync(out)).toEqual([name]);
    expect(readFileSync(join(out, name))).toEqual(png);
  });

  it("refuses a FIFO source or destination without blocking", () => {
    const fifo = join(dir, "lib", "pipe.png");
    execFileSync("mkfifo", [fifo]);
    const out = join(dir, "out6");
    expect(
      new HashedSidecarWriter(out).place({ path: fifo, name: "pipe.png", role: "original" })
    ).toEqual({ error: "unreadable" });
    mkdirSync(out, { recursive: true });
    execFileSync("mkfifo", [join(out, `My Photo-${hash8(png)}.png`)]);
    expect(
      new HashedSidecarWriter(out).place({ path: photo, name: "My Photo.png", role: "original" })
    ).toEqual({ error: "destination-not-regular" });
    expect(new ReferenceWriter().place({ path: fifo, name: "pipe.png", role: "original" })).toEqual(
      { error: "unreadable" }
    );
    const template = join(dir, "pipe.json");
    execFileSync("mkfifo", [template]);
    expect(() => readTemplateFile(template)).toThrow(/not a regular file/);
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
    expect(() => readTemplateFile(join(dir, "missing.json"))).toThrow(
      "Template file does not exist"
    );
    symlinkSync(join(dir, "t.json"), join(dir, "link.json"));
    expect(() => readTemplateFile(join(dir, "link.json"))).toThrow("symbolic link");
    mkdirSync(join(dir, "folder.json"));
    expect(() => readTemplateFile(join(dir, "folder.json"))).toThrow("not a regular file");
    writeFileSync(join(dir, "notes.txt"), '{"schemaVersion":1}');
    expect(() => readTemplateFile(join(dir, "notes.txt"))).toThrow("must have a .json extension");
    expect(() => readTemplateFile(join(dir, "lib"))).toThrow("must have a .json extension");
    writeFileSync(join(dir, "big.json"), Buffer.alloc(MAX_TEMPLATE_BYTES + 1, 32));
    expect(() => readTemplateFile(join(dir, "big.json"))).toThrow(/over the \d+-byte limit/);
    expect(() => readTemplateFile("/etc/template.json")).toThrow("outside allowed locations");
    expect(() => readTemplateFile("relative.json")).toThrow("must be absolute");
  });

  describe("private locations", () => {
    const secret = "hunter2-SECRET-VALUE";
    const credential = `{"auths":{"registry.example":{"auth":"${secret}"}}}`;
    const refusal = (path: string) => {
      try {
        readTemplateFile(path);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };
    afterEach(() => vi.unstubAllEnvs());

    it("refuses a credential JSON in a hidden directory without quoting it", () => {
      mkdirSync(join(dir, ".docker"), { recursive: true });
      const config = join(dir, ".docker", "config.json");
      writeFileSync(config, credential);
      const message = refusal(config);
      expect(message).toMatch(/hidden file or directory/);
      expect(message).toContain(ALLOW_PRIVATE_CONTENT_ENV);
      expect(message).not.toContain(secret);
      // Reached through a symlinked, plain-looking directory: caught after realpath.
      symlinkSync(join(dir, ".docker"), join(dir, "docker-link"));
      expect(refusal(join(dir, "docker-link", "config.json"))).toMatch(/hidden file or directory/);
    });

    it("refuses ~/Library outside iCloud Drive and CloudStorage, and hidden entries inside them", () => {
      const home = join(dir, "home");
      vi.stubEnv("HOME", home);
      for (const sub of [
        "Library/Application Support/app",
        "Library/Mobile Documents/.hidden",
        "Library/CloudStorage/Box",
      ])
        mkdirSync(join(home, sub), { recursive: true });
      const put = (sub: string) => {
        const path = join(home, sub);
        writeFileSync(path, '{"schemaVersion":1}');
        return path;
      };
      expect(refusal(put("Library/Application Support/app/t.json"))).toMatch(/in ~\/Library/);
      expect(refusal(join(home, "library/Application Support/app/t.json"))).toMatch(
        /in ~\/Library/
      );
      expect(refusal(put("Library/Mobile Documents/.hidden/t.json"))).toMatch(
        /hidden file or directory/
      );
      expect(readTemplateFile(put("Library/CloudStorage/Box/t.json"))).toBe('{"schemaVersion":1}');
    });

    it("honours APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1", () => {
      mkdirSync(join(dir, ".templates"), { recursive: true });
      const file = join(dir, ".templates", "t.json");
      writeFileSync(file, '{"schemaVersion":1}');
      expect(refusal(file)).toMatch(/hidden file or directory/);
      vi.stubEnv(ALLOW_PRIVATE_CONTENT_ENV, "1");
      expect(readTemplateFile(file)).toBe('{"schemaVersion":1}');
    });

    it("refuses an empty file", () => {
      const file = join(dir, "empty.json");
      writeFileSync(file, "");
      expect(refusal(file)).toMatch(/is empty/);
    });
  });
});
