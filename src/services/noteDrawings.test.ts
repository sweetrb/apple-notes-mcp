import type { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DrawingRow } from "@/utils/noteDrawings.js";
import { fitNoteDrawings, formatNoteDrawings, getNoteDrawings } from "./noteDrawings.js";
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

describe("erased strokes (#230)", () => {
  const pieces = {
    status: "ok",
    strokeCount: 2,
    truncated: false,
    hiddenStrokeCount: 1,
    bounds: { x: 0, y: 0, width: 100, height: 2 },
    strokes: [
      {
        inkType: "com.apple.ink.pen",
        color: { red: 0, green: 0, blue: 0, alpha: 1 },
        width: 2,
        pointCount: 2,
        bounds: { x: 0, y: -1, width: 35, height: 2 },
        masked: true,
        pointsTruncated: true,
        points: [
          { x: 0, y: 0, width: 2, opacity: 1, force: 1 },
          { x: 35, y: 0, width: 2, opacity: 1, force: 1 },
        ],
      },
    ],
  };

  it("passes the visible pieces, the erased count and per-stroke truncation through", () => {
    const erased = Buffer.from("erased");
    const [drawing] = getNoteDrawings(NOTE, {
      format: "both",
      deps: helperDeps({ [erased.toString("base64")]: pieces }),
      readRows: () => [row(5, erased)],
    }).drawings;
    expect(drawing).toMatchObject({ status: "ok", strokeCount: 2, hiddenStrokeCount: 1 });
    expect(drawing.strokes?.[0]).toMatchObject({ masked: true, pointsTruncated: true });
    expect(
      formatNoteDrawings({ id: NOTE, drawingCount: 1, status: "ok", drawings: [drawing] })
    ).toContain("2 strokes (1 fully erased)");
  });
});

describe("fitNoteDrawings", () => {
  const decode = (format: "json" | "svg" | "both") =>
    getNoteDrawings(NOTE, {
      format,
      deps: helperDeps(answers),
      readRows: () => [row(20, good), row(21, good)],
    });

  it("leaves a result under the limit alone", () => {
    const result = decode("both");
    expect(fitNoteDrawings(result, 10_000_000)).toEqual({
      result,
      pointsOmitted: false,
      svgOmitted: false,
      oversized: false,
    });
  });

  it("drops points first, then SVG, and reports a result that still cannot fit", () => {
    const result = decode("both");
    const withoutPoints = fitNoteDrawings(result, 10_000_000).result;
    const noPointsSize = Buffer.byteLength(
      JSON.stringify({
        ...withoutPoints,
        drawings: withoutPoints.drawings.map((d) => ({
          ...d,
          strokes: d.strokes?.map(({ points: _p, ...rest }) => rest),
        })),
      })
    );
    const pointsOnly = fitNoteDrawings(result, noPointsSize);
    expect(pointsOnly).toMatchObject({ pointsOmitted: true, svgOmitted: false, oversized: false });
    expect(pointsOnly.result.drawings[0].svg).toContain("<path ");
    expect(pointsOnly.result.drawings[0].strokes?.[0]).not.toHaveProperty("points");

    const svgToo = fitNoteDrawings(result, noPointsSize - 1);
    expect(svgToo).toMatchObject({ pointsOmitted: true, svgOmitted: true });
    expect(svgToo.result.drawings[0].svg).toBeUndefined();
    expect(svgToo.result.drawings[0].strokeCount).toBe(3);

    // svg-only output has no points to drop: the SVG goes, and a tiny limit is oversized.
    const svgOnly = fitNoteDrawings(decode("svg"), 10);
    expect(svgOnly).toMatchObject({ pointsOmitted: false, svgOmitted: true, oversized: true });
  });
});
