import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSvgAnalysis, runSvgAnalysis } from "./svgAnalysis.js";

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
    const spy = vi.spyOn(Buffer, "alloc").mockImplementationOnce(() => {
      throw new RangeError("boom");
    });
    expect(() => runSvgAnalysis({ path: p }, [dir])).toThrow("boom");
    spy.mockRestore();
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
