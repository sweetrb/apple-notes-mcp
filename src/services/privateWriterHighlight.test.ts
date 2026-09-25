/**
 * Highlight client tests. A Node script stands in for the native writer so
 * the real spawn, checksum, gating, and response-validation paths run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./privateHelper.js";
import {
  HIGHLIGHT_LIVE_VALIDATED,
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { assertHighlightMatch, setHighlight } from "./privateWriterHighlight.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const SOURCE = "// fake highlight writer source\n";

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "mismatch") out({ status: "error", code: "match_count_mismatch", message: "2 not 1", committed: false, found: 2 }, 1);
  if (mode === "malformed") out({ status: "updated" });
  if (mode === "empty") out({ status: "error", code: "nothing_to_highlight", message: "no body", committed: false, skipped: { titleUTF16: 6, attachmentGlyphs: 1, highlightedAttachmentGlyphs: 0 } }, 1);
  const note = req.scope === "note";
  const base = { identifier: req.identifier, scope: req.scope, color: req.color, rangeCount: note ? 2 : req.expectedCount, characterCount: note ? 40 : 4 * req.expectedCount,
    ...(note ? { skipped: { titleUTF16: 6, attachmentGlyphs: 1, highlightedAttachmentGlyphs: 0 } } : {}), revisionBefore: "r1:" + "b".repeat(64),
    hasEmphasis: req.color !== "none", modificationDate: null, cloudSync: { available: true, inICloudAccount: true }, pushScheduled: false,
    pushState: "awaiting_notes_app", syncHostRunning: true, storeKind: "live", echo: req };
  const run = { start: 3, lengthUTF16: 4, color: req.color === "none" ? null : req.color };
  if (req.dryRun) out({ ...base, status: "planned", committed: false, dryRun: true, wouldChange: true, revisionAfter: base.revisionBefore,
    plan: [{ start: 3, lengthUTF16: 4, currentRuns: [{ ...run, color: null }], changes: true }] });
  if (mode === "unchanged") out({ ...base, status: "unchanged", committed: false, dryRun: false, verified: true, revisionBefore: req.ifRevision, revisionAfter: req.ifRevision,
    plan: [{ start: 3, lengthUTF16: 4, currentRuns: [run], changes: false }] });
  out({ ...base, status: "updated", committed: true, verified: true, dryRun: false, revisionBefore: req.ifRevision, revisionAfter: "r1:" + "c".repeat(64),
    ranges: [{ start: 3, lengthUTF16: 4, storedRuns: [run] }] });
});
`;

let root: string;
let deps: (env?: Record<string, string>) => PrivateHelperDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-highlight-"));
  const installDir = join(root, "install");
  const sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, SOURCE);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, WRITER_BINARY_NAME), FAKE_WRITER);
  chmodSync(join(installDir, WRITER_BINARY_NAME), 0o755);
  writeFileSync(
    join(installDir, WRITER_MANIFEST_NAME),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: PRIVATE_WRITER_PROTOCOL,
      sourceSha256: sha256Hex(SOURCE),
      binarySha256: sha256Hex(FAKE_WRITER),
      builtAt: "2026-09-23T00:00:00.000Z",
      osVersion: "27.2",
      compiler: "clang",
    })
  );
  deps = (env = {}) =>
    defaultWriterDeps({
      env: {
        PATH: process.env.PATH,
        APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir,
        APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
        APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
        ...env,
      },
      platform: "darwin",
      sourcePath,
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ALLOW = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

function caught(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateWriteError) return error;
    throw error;
  }
  throw new Error("expected a PrivateWriteError");
}

const SPAWN_TIMEOUT = { timeout: 20_000 };

describe("match rules", () => {
  it("accepts ordinary text with tabs", () => {
    expect(() => assertHighlightMatch("deadline\tFriday")).not.toThrow();
  });

  it("refuses empty, over-long, multi-paragraph, glyph, and control-character matches", () => {
    for (const bad of [
      "",
      "x".repeat(1001),
      "a\nb",
      "a\rb",
      `a${String.fromCharCode(0xfffc)}b`,
      `a${String.fromCharCode(0x2028)}b`,
      `a${String.fromCharCode(0x7)}b`,
    ])
      expect(caught(() => assertHighlightMatch(bad))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
  });
});

describe("setHighlight", SPAWN_TIMEOUT, () => {
  const target = { scope: "text" as const, match: "due" };
  const request = { identifier: NOTE, target, color: "mint" as const, ifRevision: REV };

  it("gates writes until live validation but lets a dry run through", () => {
    expect(HIGHLIGHT_LIVE_VALIDATED).toBe(false);
    expect(caught(() => setHighlight(request, deps()))).toMatchObject({
      code: "not_live_validated",
      committed: false,
    });
    const plan = setHighlight({ ...request, ifRevision: undefined, dryRun: true }, deps());
    expect(plan).toMatchObject({ status: "planned", committed: false, dryRun: true });
    expect(plan.echo).toEqual({
      protocol: 1,
      action: "set_highlight",
      identifier: NOTE,
      scope: "text",
      match: "due",
      color: "mint",
      expectedCount: 1,
      dryRun: true,
    });
  });

  it("validates input before spawning", () => {
    const d = deps(ALLOW);
    const bad = [
      { ...request, identifier: "x" },
      { ...request, target: { ...target, match: "" } },
      { ...request, target: { ...target, scope: "para" as never } },
      { ...request, target: { scope: "note", match: "due" } as never },
      { ...request, target: { scope: "note", expectedCount: 1 } as never },
      { ...request, color: "red" as never },
      { ...request, target: { ...target, expectedCount: 0 } },
      { ...request, target: { ...target, expectedCount: 1.5 } },
      { ...request, target: { ...target, expectedCount: 101 } },
      { ...request, ifRevision: "r1:x" },
      { ...request, ifRevision: undefined },
    ];
    for (const input of bad)
      expect(caught(() => setHighlight(input, d))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
  });

  it("writes with the count and revision and returns the stored runs", () => {
    const r = setHighlight({ ...request, target: { ...target, expectedCount: 2 } }, deps(ALLOW));
    expect(r).toMatchObject({ status: "updated", committed: true, hasEmphasis: true });
    expect(r.ranges?.[0].storedRuns[0].color).toBe("mint");
    expect(r.echo).toMatchObject({ scope: "text", expectedCount: 2, ifRevision: REV });
    expect((r.echo as Record<string, unknown>).dryRun).toBeUndefined();
  });

  it("sends the whole-note scope without match or count and returns what it skipped", () => {
    const note = { ...request, target: { scope: "note" as const } };
    const plan = setHighlight({ ...note, ifRevision: undefined, dryRun: true }, deps());
    expect(plan.echo).toEqual({
      protocol: 1,
      action: "set_highlight",
      identifier: NOTE,
      scope: "note",
      color: "mint",
      dryRun: true,
    });
    expect(plan).toMatchObject({
      status: "planned",
      scope: "note",
      rangeCount: 2,
      characterCount: 40,
      skipped: { titleUTF16: 6, attachmentGlyphs: 1, highlightedAttachmentGlyphs: 0 },
    });
    const r = setHighlight({ ...note, color: "none" }, deps(ALLOW));
    expect(r).toMatchObject({ status: "updated", committed: true, scope: "note" });
    expect(r.echo).toMatchObject({ scope: "note", color: "none", ifRevision: REV });
    expect(caught(() => setHighlight(note, deps({ ...ALLOW, FAKE_MODE: "empty" })))).toMatchObject({
      code: "nothing_to_highlight",
      committed: false,
    });
  });

  it("removes a highlight with color none", () => {
    const r = setHighlight({ ...request, color: "none" }, deps(ALLOW));
    expect(r.ranges?.[0].storedRuns[0].color).toBeNull();
    expect(r.hasEmphasis).toBe(false);
  });

  it("reports the idempotent no-op without a commit", () => {
    const r = setHighlight(request, deps({ ...ALLOW, FAKE_MODE: "unchanged" }));
    expect(r).toMatchObject({ status: "unchanged", committed: false, revisionAfter: REV });
  });

  it("passes the count guard refusal through as not committed", () => {
    expect(
      caught(() => setHighlight(request, deps({ ...ALLOW, FAKE_MODE: "mismatch" })))
    ).toMatchObject({ code: "match_count_mismatch", committed: false, details: { found: 2 } });
  });

  it("treats a malformed write response as indeterminate, a dry run as not committed", () => {
    expect(
      caught(() => setHighlight(request, deps({ ...ALLOW, FAKE_MODE: "malformed" })))
    ).toMatchObject({ code: "invalid_response", committed: "unknown" });
    const e = caught(() =>
      setHighlight(
        { ...request, dryRun: true },
        deps({ FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
      )
    );
    expect(e).toMatchObject({ code: "timeout", committed: false });
    // The transport treats the dry run as a read, so the message does not
    // describe a possible save.
    expect(e.message).not.toMatch(/INDETERMINATE|may have been saved/);
  });
});
