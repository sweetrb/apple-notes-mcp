/**
 * Compiles the real native writer and exercises `compose_note` request
 * validation end to end. None of these requests reach a Notes store: each
 * one either fails validation or stops at the opt-in gate (no
 * APPLE_NOTES_MCP_ENABLE_PRIVATE) or at a nonexistent copy-store path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writerCompileArguments } from "./privateWriterBuild.js";
import { packageRoot } from "./privateHelper.js";
import { WRITER_SOURCE_RELATIVE } from "./privateWriter.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
let dir: string;
let binary: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "private-writer-native-"));
  binary = join(dir, "writer");
  const args = writerCompileArguments(join(packageRoot(), WRITER_SOURCE_RELATIVE), binary, "test");
  execFileSync("/usr/bin/xcrun", args, { stdio: "pipe", timeout: 120_000 });
}, 150_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One request to the compiled writer, with no opt-in and no store override by default. */
function call(request: Record<string, unknown>, env: Record<string, string> = {}) {
  const r = spawnSync(binary, [], {
    input: JSON.stringify({ protocol: 1, ...request }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 20_000,
  });
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

const para = (extra: Record<string, unknown> = {}) => ({
  style: "body",
  runs: [{ text: "x" }],
  ...extra,
});
const compose = (extra: Record<string, unknown> = {}) => ({
  action: "compose_note",
  identifier: NOTE,
  mode: "append",
  dryRun: true,
  paragraphs: [para()],
  ...extra,
});

describe("native compose_note", { timeout: 30_000 }, () => {
  it("is in the action whitelist", () => {
    expect(call({ action: "hello" }).actions).toContain("compose_note");
  });

  it("rejects an unknown request field in the dispatcher", () => {
    expect(call(compose({ extra: 1 }))).toMatchObject({ status: "error", code: "invalid_request" });
  });

  it.each([
    ["an unknown mode", compose({ mode: "replace" })],
    ["a non-UUID identifier", compose({ identifier: "x" })],
    ["an apply without ifRevision", compose({ dryRun: false })],
    ["a dry run with ifRevision", compose({ ifRevision: "r1:x" })],
    ["a non-boolean dryRun", compose({ dryRun: 1 })],
    [
      "a heading anchor on prepend",
      compose({ mode: "prepend", insertBeforeHeading: { text: "H" } }),
    ],
    ["a multi-line heading anchor", compose({ insertBeforeHeading: { text: "a\nb" } })],
    ["an unknown heading-anchor field", compose({ insertBeforeHeading: { text: "H", x: 1 } })],
    ["a zero occurrence", compose({ insertBeforeHeading: { text: "H", occurrence: 0 } })],
    ["no paragraphs", compose({ paragraphs: [] })],
    ["paragraphs that are not objects", compose({ paragraphs: ["x"] })],
    ["the title style", compose({ paragraphs: [para({ style: "title" })] })],
    ["an unknown paragraph field", compose({ paragraphs: [para({ color: "#000000" })] })],
    ["indent on a heading", compose({ paragraphs: [para({ style: "heading", indent: 1 })] })],
    ["indent past 8", compose({ paragraphs: [para({ indent: 9 })] })],
    ["a fractional indent", compose({ paragraphs: [para({ indent: 1.5 })] })],
    ["a checklist without state", compose({ paragraphs: [para({ style: "checklist" })] })],
    ["state on a body paragraph", compose({ paragraphs: [para({ checked: true })] })],
    ["a blank last paragraph", compose({ paragraphs: [para(), para({ runs: [] })] })],
    ["a run that is not an object", compose({ paragraphs: [para({ runs: ["x"] })] })],
    ["an unknown run field", compose({ paragraphs: [para({ runs: [{ text: "x", size: 2 }] })] })],
    ["an empty run", compose({ paragraphs: [para({ runs: [{ text: "" }] })] })],
    ["a newline in a run", compose({ paragraphs: [para({ runs: [{ text: "a\nb" }] })] })],
    ["an attachment glyph", compose({ paragraphs: [para({ runs: [{ text: "a\uFFFC" }] })] })],
    ["a numeric bold flag", compose({ paragraphs: [para({ runs: [{ text: "x", bold: 1 }] })] })],
    [
      "a javascript link",
      compose({ paragraphs: [para({ runs: [{ text: "x", link: "javascript:x" }] })] }),
    ],
    ["a non-string link", compose({ paragraphs: [para({ runs: [{ text: "x", link: 5 }] })] })],
    ["a bad color", compose({ paragraphs: [para({ runs: [{ text: "x", color: "#12345" }] })] })],
    [
      "an unknown highlight",
      compose({ paragraphs: [para({ runs: [{ text: "x", highlight: "red" }] })] }),
    ],
    ["an unknown paragraph kind", compose({ paragraphs: [{ kind: "image" }] })],
    ["a divider with other fields", compose({ paragraphs: [{ kind: "divider", runs: [] }] })],
    ["a table without rows", compose({ paragraphs: [{ kind: "table" }] })],
    ["a table with an empty row", compose({ paragraphs: [{ kind: "table", rows: [[]] }] })],
    ["a ragged table", compose({ paragraphs: [{ kind: "table", rows: [["a", "b"], ["c"]] }] })],
    ["a non-string cell", compose({ paragraphs: [{ kind: "table", rows: [[1]] }] })],
    ["a newline in a cell", compose({ paragraphs: [{ kind: "table", rows: [["a\nb"]] }] })],
    [
      "a table past 10000 cells",
      compose({ paragraphs: [{ kind: "table", rows: Array(101).fill(Array(100).fill("")) }] }),
    ],
    ["an unknown table field", compose({ paragraphs: [{ kind: "table", rows: [["a"]], x: 1 }] })],
  ])("rejects %s with invalid_request and nothing committed", (_label, request) => {
    expect(call(request)).toMatchObject({
      status: "error",
      code: "invalid_request",
      committed: false,
    });
  });

  describe("file and link-card paragraphs", () => {
    let files: string;
    beforeAll(() => {
      files = mkdtempSync(join(tmpdir(), "private-writer-files-"));
      writeFileSync(join(files, "report.pdf"), "%PDF-1.4\n");
      writeFileSync(join(files, "empty.txt"), "");
      symlinkSync(join(files, "report.pdf"), join(files, "link.pdf"));
    });
    afterAll(() => rmSync(files, { recursive: true, force: true }));
    const file = (extra: Record<string, unknown>) =>
      compose({ paragraphs: [para(), { kind: "file", ...extra }] });
    const card = (url: unknown) => compose({ paragraphs: [para(), { kind: "url", url }] });

    // Every refusal raised before the save (a Fail with no `committed` of its
    // own) must reach the client as committed: false.
    it.each([
      ["a relative path", () => file({ path: "report.pdf" })],
      ["a missing file", () => file({ path: join(files, "missing.pdf") })],
      ["an empty file", () => file({ path: join(files, "empty.txt") })],
      ["a symbolic link", () => file({ path: join(files, "link.pdf") })],
      ["a directory", () => file({ path: files })],
      ["a changed extension", () => file({ path: join(files, "report.pdf"), filename: "r.txt" })],
      ["a name with a slash", () => file({ path: join(files, "report.pdf"), filename: "a/b.pdf" })],
      ["a hidden name", () => file({ path: join(files, "report.pdf"), filename: ".pdf" })],
      ["an unknown file field", () => file({ path: join(files, "report.pdf"), size: 1 })],
      ["a non-http card", () => card("notes://showNote?identifier=x")],
      ["a card URL NSURL would re-encode", () => card("https://example.com/a b")],
      ["a non-string card URL", () => card(5)],
      [
        "an unknown card field",
        () => compose({ paragraphs: [{ kind: "url", url: "https://e.test/", x: 1 }] }),
      ],
      [
        "more than 20 file and card paragraphs",
        () => compose({ paragraphs: Array(21).fill({ kind: "url", url: "https://e.test/" }) }),
      ],
      [
        "a run link NSURL would re-encode",
        () =>
          compose({ paragraphs: [para({ runs: [{ text: "x", link: "https://e.test/a b" }] })] }),
      ],
      [
        "a table cell past 10000 UTF-16 units",
        () => compose({ paragraphs: [{ kind: "table", rows: [["x".repeat(10_001)]] }] }),
      ],
      [
        "table cells past the request's UTF-16 budget",
        () =>
          compose({
            paragraphs: [{ kind: "table", rows: Array(21).fill(["x".repeat(10_000)]) }],
          }),
      ],
    ])("rejects %s with invalid_request and nothing committed", (_label, request) => {
      expect(call(request())).toMatchObject({
        status: "error",
        code: "invalid_request",
        committed: false,
      });
    });

    it("accepts files and cards, then stops at the opt-in gate", () => {
      const gated = call(
        compose({
          paragraphs: [
            { kind: "file", path: join(files, "report.pdf"), filename: "Q3 Report.PDF" },
            { kind: "url", url: "https://example.com/" },
            para(),
          ],
        })
      );
      expect(["disabled", "private_api_unavailable"]).toContain(gated.code);
      expect(gated.committed).toBe(false);
    });
  });

  it("accepts every style and run attribute, then stops at the opt-in gate", () => {
    const request = compose({
      requireNonSystemPaper: true,
      insertBeforeHeading: { text: "H", occurrence: 1, expectedCount: 1 },
      paragraphs: [
        para({ style: "heading" }),
        para({ style: "subheading" }),
        para({ blockQuote: true }),
        para({ style: "monospaced" }),
        para({ style: "body", runs: [] }),
        para({ style: "bulleted", indent: 1 }),
        para({ style: "dashed", indent: 8 }),
        para({ style: "numbered" }),
        para({ style: "checklist", checked: true }),
        { kind: "divider" },
        {
          kind: "table",
          rows: [
            ["a", ""],
            ["", "d"],
          ],
        },
        { kind: "text", style: "body", runs: [{ text: "explicit kind" }] },
        para({
          runs: [
            {
              text: "all",
              bold: true,
              italic: true,
              underline: true,
              strikethrough: true,
              link: "https://example.com/",
              highlight: "blue",
              color: "#A1B2C3",
            },
          ],
        }),
      ],
    });
    const gated = call(request);
    // The opt-in gate runs before the store is opened. A macOS without the
    // private API stops one step earlier, still after full validation.
    expect(["disabled", "private_api_unavailable"]).toContain(gated.code);
    expect(gated.committed).toBe(false);
    const noCopy = call(request, {
      APPLE_NOTES_MCP_PRIVATE_STORE: join(dir, "missing.sqlite"),
    });
    expect(["store_unavailable", "private_api_unavailable"]).toContain(noCopy.code);
  });
});
