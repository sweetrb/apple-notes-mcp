import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSvgAnalysis, runSvgAnalysis } from "./svgAnalysis.js";
import { ALLOW_PRIVATE_CONTENT_ENV } from "../utils/attachmentFs.js";
import { SVG_LIMITS } from "../utils/svgAnalyzer.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svg-tool-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

function tool() {
  const registerTool = vi.fn();
  registerSvgAnalysis({ registerTool } as unknown as McpServer);
  const [name, config, handler] = registerTool.mock.calls[0];
  return { name, config, call: (args: Record<string, unknown>) => handler(args) };
}

describe("analyze-svg", () => {
  it("registers a read-only tool", () => {
    const { name, config } = tool();
    expect(name).toBe("analyze-svg");
    expect(config.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(config.description).toMatch(/Safety: read-only/);
  });

  it("returns the analysis, with the drawing only on request", async () => {
    const p = file(
      "a.svg",
      `<svg ${NS} width="10" height="10"><path d="M0 0 L10 10" stroke="red" stroke-linecap="round"/></svg>`
    );
    const plain = await tool().call({ path: p });
    expect(plain.structuredContent).toMatchObject({ classification: "safe", importable: true });
    expect(plain.structuredContent.drawing).toBeUndefined();
    expect(JSON.parse(plain.content[0].text).analysisDigest).toMatch(/^sha256:/);
    const withDrawing = runSvgAnalysis({ path: p, includeDrawing: true }, [dir]);
    expect((withDrawing.drawing as { strokes: unknown[] }).strokes).toHaveLength(1);
  });

  it("reports refusals with svgCode and location", async () => {
    const p = file("bad.svg", `<svg ${NS}><g><script/></g></svg>`);
    const r = await tool().call({ path: p });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "validation_error",
      svgCode: "svg_unsafe",
      location: "svg/g[1]/script[1]",
    });
    const malformed = file("m.svg", "<svg");
    const m = await tool().call({ path: malformed });
    expect(m.structuredContent.svgCode).toBe("svg_invalid");
    expect(m.structuredContent.location).toBeUndefined();
  });

  it("refuses paths outside the allowed roots or that do not resolve", async () => {
    const outside = runCatch(() => runSvgAnalysis({ path: "/etc/hosts" }));
    expect(outside).toMatchObject({ code: "validation_error", svgCode: "svg_file_invalid" });
    const relative = await tool().call({ path: "a.svg" });
    expect(relative.structuredContent.svgCode).toBe("svg_file_invalid");
  });

  it("passes unexpected errors through", () => {
    const p = file("ok.svg", `<svg ${NS}/>`);
    // Fail inside the analysis (its digest), after the file was read.
    const keys = Object.keys;
    const spy = vi.spyOn(Object, "keys").mockImplementation((value: object) => {
      if ("analysis" in value && "drawing" in value) throw new RangeError("boom");
      return keys(value);
    });
    expect(() => runSvgAnalysis({ path: p }, [dir])).toThrow("boom");
    spy.mockRestore();
  });
});

describe("analyze-svg read scope", () => {
  const SVG = `<svg ${NS} width="10" height="10"><path d="M0 0 L10 10" stroke="red" stroke-linecap="round"/></svg>`;
  const svgCode = (path: string, roots = [dir]) =>
    runCatch(() => runSvgAnalysis({ path }, roots))?.svgCode ?? "ok";
  const message = (path: string, roots = [dir]) => {
    try {
      runSvgAnalysis({ path }, roots);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  afterEach(() => vi.unstubAllEnvs());

  it("refuses hidden paths, before and after realpath", () => {
    mkdirSync(join(dir, ".docker"));
    const hidden = file(".docker/logo.svg", SVG);
    expect(svgCode(hidden)).toBe("svg_file_invalid");
    expect(message(hidden)).toMatch(/hidden file or directory/);
    expect(message(hidden)).toContain(ALLOW_PRIVATE_CONTENT_ENV);
    // A plain-looking directory that is a symlink into a hidden one.
    symlinkSync(join(dir, ".docker"), join(dir, "art"));
    expect(message(join(dir, "art", "logo.svg"))).toMatch(/hidden file or directory/);
  });

  it("refuses ~/Library outside iCloud Drive and CloudStorage, and hidden entries inside those", () => {
    // homedir() follows HOME, so a scratch home stands in for the real one.
    const home = realpathSync(dir);
    vi.stubEnv("HOME", home);
    for (const sub of [
      "Library/Preferences",
      "Library/Mobile Documents/.secret",
      "Library/CloudStorage/Box",
    ])
      mkdirSync(join(home, sub), { recursive: true });
    const prefs = file("Library/Preferences/x.svg", SVG);
    expect(message(prefs)).toMatch(/in ~\/Library/);
    // A case variant of the same folder is caught after realpath.
    expect(message(join(dir, "library/Preferences/x.svg"))).toMatch(/in ~\/Library/);
    expect(message(file("Library/Mobile Documents/.secret/x.svg", SVG))).toMatch(
      /hidden file or directory/
    );
    expect(svgCode(file("Library/CloudStorage/Box/ok.svg", SVG))).toBe("ok");
  });

  it("refuses a FIFO without blocking, and a symlinked file", () => {
    const fifo = join(dir, "pipe.svg");
    execFileSync("mkfifo", [fifo]);
    expect(message(fifo)).toMatch(/not a regular file/);
    const real = file("real.svg", SVG);
    symlinkSync(real, join(dir, "link.svg"));
    expect(message(join(dir, "link.svg"))).toMatch(/symbolic link/);
  });

  it("refuses directories, missing, empty and oversized files", () => {
    mkdirSync(join(dir, "d.svg"));
    expect(message(join(dir, "d.svg"))).toMatch(/not a regular file/);
    expect(message(join(dir, "missing.svg"))).toMatch(/does not exist/);
    expect(message(file("empty.svg", ""))).toMatch(/is empty/);
    writeFileSync(join(dir, "big.svg"), Buffer.alloc(SVG_LIMITS.maxSourceBytes + 1, 0x20));
    expect(message(join(dir, "big.svg"))).toMatch(/over the \d+-byte limit/);
  });

  it("honours APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1", () => {
    mkdirSync(join(dir, ".cache"));
    const hidden = file(".cache/ok.svg", SVG);
    expect(svgCode(hidden)).toBe("svg_file_invalid");
    vi.stubEnv(ALLOW_PRIVATE_CONTENT_ENV, "1");
    expect(svgCode(hidden)).toBe("ok");
  });

  it("never quotes a file that is not SVG", () => {
    const secret = "hunter2-SECRET-VALUE";
    const cases = [
      `{"auths":{"registry":{"auth":"${secret}"}}}`,
      `<${secret} a="1"/>`,
      `<config ${secret}="x"/>`,
      `<config>&${secret};</config>`,
      `<a:b ${secret}/>`,
      `-----BEGIN KEY-----\n${secret}\n`,
    ];
    for (const body of cases) {
      const p = file("x.svg", body);
      const text = message(p);
      expect(text).not.toBe("");
      expect(text).not.toContain(secret);
    }
  });
});

function runCatch(fn: () => unknown): Record<string, unknown> | null {
  try {
    fn();
  } catch (error) {
    return (error as { envelope: Record<string, unknown> }).envelope;
  }
  return null;
}
