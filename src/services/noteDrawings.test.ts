import type { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DrawingRow } from "@/utils/noteDrawings.js";
import { formatNoteDrawings, getNoteDrawings } from "./noteDrawings.js";
import { PublicHelperError, type PublicHelperDeps } from "./publicHelper.js";

const pencil = JSON.parse(
  readFileSync(join(__dirname, "../utils/fixtures/pencil-drawing.json"), "utf8")
) as { dataBase64: string; decoded: Record<string, unknown> };

const NOTE = "x-coredata://S/ICNote/p1";
const row = (pk: number, data: Buffer | null, typeUti = "com.apple.drawing.2"): DrawingRow => ({
  pk,
  attachmentId: `x-coredata://S/ICAttachment/p${pk}`,
  identifier: `ID-${pk}`,
  typeUti,
  data,
});

/**
 * Deps whose helper is "installed" (exists/readFile satisfy inspection) and
 * whose spawn answers decode requests from a table keyed by base64 input.
 */
function helperDeps(answers: Record<string, unknown>, installed = true): PublicHelperDeps {
  const source = Buffer.from("src");
  const binary = Buffer.from("bin");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    sourceSha256: sha(source),
    binarySha256: sha(binary),
    builtAt: "t",
    osVersion: "27",
    compiler: "swift",
  });
  return {
    env: { APPLE_NOTES_MCP_PUBLIC_HELPER_DIR: "/helper" },
    platform: "darwin",
    sourcePath: "/pkg/helper.swift",
    exists: (p) => installed || p === "/pkg/helper.swift",
    readFile: (p) =>
      p.endsWith("manifest.json") ? Buffer.from(manifest) : p.endsWith(".swift") ? source : binary,
    spawn: ((_cmd: string, _args: string[], opts: { input: string }) => {
      const request = JSON.parse(opts.input) as { dataBase64: string; includePoints: boolean };
      const answer = answers[request.dataBase64] ?? {
        status: "error",
        code: "undecodable",
        message: "bad",
      };
      const ok = (answer as { status: string }).status === "ok";
      return {
        status: ok ? 0 : 1,
        stdout: JSON.stringify(answer),
        stderr: "",
        signal: null,
        pid: 1,
        output: [],
      };
    }) as unknown as typeof spawnSync,
  };
}

const good = Buffer.from(pencil.dataBase64, "base64");
const answers = { [pencil.dataBase64]: pencil.decoded };

describe("getNoteDrawings", () => {
  it("returns strokes with points by default", () => {
    const result = getNoteDrawings(NOTE, {
      deps: helperDeps(answers),
      readRows: () => [row(20, good)],
    });
    expect(result).toMatchObject({ id: NOTE, drawingCount: 1, status: "ok" });
    const [drawing] = result.drawings;
    expect(drawing).toMatchObject({ status: "ok", strokeCount: 3, truncated: false });
    expect(drawing.strokes?.[0].points).toHaveLength(4);
    expect(drawing.svg).toBeUndefined();
  });

  it("returns SVG only, or both, and can omit points from JSON", () => {
    const svg = getNoteDrawings(NOTE, {
      format: "svg",
      deps: helperDeps(answers),
      readRows: () => [row(20, good)],
    }).drawings[0];
    expect(svg.svg).toContain("<path ");
    expect(svg.strokes).toBeUndefined();
    const both = getNoteDrawings(NOTE, {
      format: "both",
      includePoints: false,
      deps: helperDeps(answers),
      readRows: () => [row(20, good)],
    }).drawings[0];
    expect(both.svg).toContain("<path ");
    expect(both.strokes?.[0]).not.toHaveProperty("points");
    expect(both.strokes?.[0].pointCount).toBe(4);
  });

  it("reports per-drawing failures and a partial status", () => {
    const result = getNoteDrawings(NOTE, {
      deps: helperDeps({ ...answers, [Buffer.from("x").toString("base64")]: { status: "ok" } }),
      readRows: () => [
        row(20, good),
        row(21, null, "com.apple.drawing"),
        row(22, Buffer.from("x")),
        row(23, Buffer.from("y")),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.drawings.map((d) => d.code ?? d.status)).toEqual([
      "ok",
      "no_data",
      "invalid_response",
      "undecodable",
    ]);
    expect(formatNoteDrawings(result)).toContain("error no_data");
  });

  it("is status error when nothing decodes and none when there are no drawings", () => {
    expect(
      getNoteDrawings(NOTE, { deps: helperDeps({}), readRows: () => [row(1, Buffer.from("z"))] })
        .status
    ).toBe("error");
    const none = getNoteDrawings(NOTE, { deps: helperDeps({}, false), readRows: () => [] });
    expect(none).toEqual({ id: NOTE, drawingCount: 0, status: "none", drawings: [] });
    expect(formatNoteDrawings(none)).toContain("No classic PencilKit drawings");
  });

  it("fails once, with the setup instruction, when drawings exist but the helper is missing", () => {
    expect(() =>
      getNoteDrawings(NOTE, { deps: helperDeps(answers, false), readRows: () => [row(1, good)] })
    ).toThrow(PublicHelperError);
    expect(() =>
      getNoteDrawings(NOTE, { deps: helperDeps(answers, false), readRows: () => [row(1, good)] })
    ).toThrow(/setup --public-helper/);
  });

  it("maps a non-helper exception to internal_error", () => {
    const deps = helperDeps(answers);
    deps.spawn = (() => {
      throw new TypeError("spawn exploded");
    }) as unknown as typeof spawnSync;
    const [drawing] = getNoteDrawings(NOTE, { deps, readRows: () => [row(1, good)] }).drawings;
    expect(drawing).toMatchObject({ status: "error", code: "internal_error" });
  });

  it("summarizes counts without stroke data", () => {
    const text = formatNoteDrawings(
      getNoteDrawings(NOTE, { deps: helperDeps(answers), readRows: () => [row(20, good)] })
    );
    expect(text).toBe(
      `1 classic drawing in note ${NOTE} (ok):\n- x-coredata://S/ICAttachment/p20: 3 strokes`
    );
  });
});
