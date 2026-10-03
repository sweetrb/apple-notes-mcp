/** Synthetic Core Data save tests: no NotesShared, Notes data, or private opt-ins. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./privateHelper.js";
import { writerCompileArguments } from "./privateWriterBuild.js";
import { composePlanDigest } from "./privateCompose.js";
import { WRITER_ACTIONS } from "./privateWriter.js";

let directory: string;
let binary: string;
const MACOS = process.platform === "darwin";

beforeAll(() => {
  if (!MACOS) return;
  directory = mkdtempSync(join(tmpdir(), "private-writer-synthetic-"));
  binary = join(directory, "fixture");
  execFileSync(
    "/usr/bin/xcrun",
    writerCompileArguments(
      join(packageRoot(), "test/native/private-writer-safety.m"),
      binary,
      "fixture"
    ),
    { encoding: "utf8", timeout: 120_000 }
  );
}, 150_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[] = [], input?: Record<string, unknown>) {
  return JSON.parse(
    execFileSync(binary, args, {
      input: input ? JSON.stringify(input) : undefined,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        ...(args[0] === "dispatch"
          ? {
              APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
              APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
              APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1",
            }
          : {}),
      },
    })
  ) as {
    frameworkLoaded: boolean;
    passed: string[];
    digest: string;
    code?: string;
    committed?: boolean;
    optIn?: string;
  };
}

describe.skipIf(!MACOS)("synthetic native writer safety", () => {
  it("saves expected objects and refuses unrelated, undeclared, and early saves", () => {
    const result = run();
    expect(result.frameworkLoaded).toBe(false);
    expect(result.passed).toHaveLength(11);
    expect(result.passed).toContain("save boundary cannot widen frozen ownership");
    expect(result.passed).toContain(
      "early private API save stays committed and blocks continuation"
    );
  });

  it.each(
    Object.entries(WRITER_ACTIONS)
      .filter(([, kind]) => kind === "write")
      .map(([action]) => action)
  )("direct %s dispatch refuses a blanket opt-in before loading NotesShared", (action) => {
    const result = run(["dispatch"], { protocol: 1, action });
    expect(result).toMatchObject({
      code: "not_live_validated",
      committed: false,
      frameworkLoaded: false,
    });
    expect(result.optIn).toMatch(/^APPLE_NOTES_MCP_ALLOW_UNVERIFIED_[A-Z_]+$/);
  });

  it.each([
    [{ style: "body", runs: [{ text: "café / 東京 🙂 — \\ tab\t and <html>" }] }],
    [{ kind: "file", path: "/tmp/Reviewed file.txt", expectedSha256: "a".repeat(64) }],
    [
      {
        kind: "table",
        rows: [
          ["a", "b"],
          ['quoted "text"', "line\u2028separator"],
        ],
      },
    ],
  ])("matches TypeScript compose digests across JSON encodings: %j", (...paragraphs) => {
    const fields = {
      identifier: "12345678-1234-1234-1234-123456789ABC",
      mode: "append",
      ifRevision: `r1:${"b".repeat(64)}`,
      paragraphs,
      requireNonSystemPaper: true,
      insertBeforeHeading: { text: "Title / café", expectedCount: 1, occurrence: 1 },
      forbiddenAncestorFolderIds: ["x-coredata://store/ICFolder/p1"],
    };
    const result = run(["digest"], fields);
    expect(result.frameworkLoaded).toBe(false);
    expect(result.digest).toBe(composePlanDigest(fields));
  });
});
