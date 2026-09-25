/**
 * Paper client tests. A small Node script stands in for the native writer,
 * so these exercise the real spawn, gating, and committed paths of
 * `add_paper` and `read_paper` without NotesShared, PencilKit, PaperKit, or
 * the store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot, sha256Hex } from "./privateHelper.js";
import { compileArguments } from "./privateHelperBuild.js";
import { MAX_PAPER_READ_POINTS, addPaper, readPaper } from "./privatePaperWriter.js";
import { writerCompileArguments } from "./privateWriterBuild.js";
import {
  PAPER_WRITE_LIVE_VALIDATED,
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_ACTIONS,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  WRITER_SOURCE_RELATIVE,
  defaultWriterDeps,
  privateWriterCapabilities,
  type PrivateHelperDeps,
} from "./privateWriter.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const ATTACHMENT = "0F3C2B1A-1111-4222-8333-444455556666";
const REV = `r1:${"a".repeat(64)}`;
const SOURCE = "// fake writer source\n";

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  const feature = { available: true, reason: null, missing: [] };
  if (req.action === "probe")
    out({ status: "ok", protocolVersion: 1, role: "writer", readOnly: false, writesEnabled: true, os: { version: "27.2.0", notesAppVersion: "4.13" }, framework: { loaded: true, error: null }, store: { kind: "live", opened: true, reason: null, noteRows: 3 }, syncHostRunning: true, features: { readNoteState: feature, appendPlainText: feature, ...(mode === "old-writer" ? {} : { addPaper: mode === "no-paper-api" ? { available: false, reason: "private_api_unavailable", missing: ["+[ICPaperAttachmentCreationHelper createSystemPaperAttachmentWithPKDrawing:inNote:]"], formats: ["drawing"] } : { ...feature, formats: ["paper", "drawing"] }, readPaper: feature, readPaperShapes: mode === "macos-26" ? { available: false, reason: "requires_macos_27", missing: ["macOS 27 or later"] } : feature }) } });
  if (req.action === "read_paper") {
    if (mode === "ambiguous") out({ status: "error", code: "ambiguous_attachment", message: "two", attachmentIdentifiers: ["A", "B"] }, 1);
    const shapeDecode = mode === "macos-26"
      ? { available: false, reason: "requires_macos_27", missing: ["macOS 27 or later"], elementCount: null, elementKinds: null }
      : { available: true, reason: null, missing: [], elementCount: 2, elementKinds: { shape: 1, stroke: 1 } };
    const shapes = mode === "macos-26" ? [] : [{ index: 0, kind: "rectangle", frame: [10, 20, 120, 60], renderFrame: [8.5, 18.5, 123, 63], rotation: 0, lineWidth: 3, opacity: 1, fillColor: null, strokeColor: [1, 0, 0, 1], startLineMarker: "none", endLineMarker: "none", path: "M 10 20 L 10 80 L 130 80 L 130 20 Z", pathBounds: [10, 20, 120, 60], text: null }];
    out({ status: "ok", storeKind: "live", identifier: req.identifier, revision: "r1:" + "b".repeat(64), attachmentIdentifier: "${ATTACHMENT}", typeUTI: "com.apple.paper", drawingCount: 1, strokeCount: 1, returnedStrokeCount: 1, pointCount: 2, bounds: [0, 0, 1, 1], inks: ["pen"], pointFields: ["x", "y", "width", "height", "opacity", "force", "azimuth", "altitude", "timeOffset"], strokes: [{ ink: "pen", inkIdentifier: "com.apple.ink.pen", color: [0, 0, 0, 1], width: 2, transform: [1, 0, 0, 1, 0, 0], pointCount: 2, renderBounds: [0, 0, 1, 1], masked: false, points: [[0, 0, 2, 2, 1, 1, 0, 1.5708, 0], [1, 1, 2, 2, 1, 1, 0, 1.5708, 0.01]] }], shapeDecode, shapes, fallbackGeometry: { available: false, reason: "no_fallback_pdf" }, truncated: false, warnings: [], echo: req });
  }
  if (req.action !== "add_paper") out({ status: "error", code: "unknown_action", message: "no" }, 1);
  if (mode === "conflict") out({ status: "error", code: "revision_conflict", message: "changed", committed: false, currentRevision: "r1:" + "c".repeat(64) }, 1);
  if (mode === "verify-failed") out({ status: "error", code: "verification_failed", message: "decoded 0 strokes", committed: true, attachmentIdentifier: "${ATTACHMENT}" }, 1);
  if (mode === "no-committed") out({ status: "error", code: "internal_error", message: "?" }, 1);
  if (mode === "malformed") out({ status: req.dryRun ? "planned" : "created" });
  const plan = { format: req.format === "drawing" ? "drawing" : "paper", availableFormats: ["paper", "drawing"], strokeCount: req.drawing.strokes.length, pointCount: 2, inks: ["pen"], bounds: [0, 0, 1, 1], revisionBefore: req.ifRevision, storeKind: "copy", echo: req };
  if (req.dryRun) out({ status: "planned", committed: false, ...plan });
  const cloudSync = { available: true, inICloudAccount: true, currentLocalVersion: 5, latestVersionSyncedToCloud: 4, uploadPending: true };
  out({ status: "created", committed: true, verified: true, identifier: req.identifier, attachmentIdentifier: "${ATTACHMENT}", typeUTI: "com.apple.paper", decodedStrokeCount: 1, decodedPointCount: 2, glyphInserted: true, previewUpdated: true, revisionAfter: "r1:" + "d".repeat(64), modificationDate: "2026-09-24T00:00:00.000Z", cloudSync, pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, ...plan });
});
`;

const DRAWING = {
  strokes: [
    {
      ink: "pen" as const,
      color: [0, 0, 0, 1] as [number, number, number, number],
      width: 2,
      points: [
        [0, 0],
        [1, 1],
      ] as [number, number][],
    },
  ],
};

const ON = { APPLE_NOTES_MCP_ENABLE_PRIVATE: "1", APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1" };
const UNVERIFIED = { ...ON, APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

let root: string;
let installDir: string;
let sourcePath: string;

function deps(env: Record<string, string> = {}): PrivateHelperDeps {
  return defaultWriterDeps({
    env: { PATH: process.env.PATH, APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir, ...env },
    platform: "darwin",
    sourcePath,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-paper-writer-test-"));
  installDir = join(root, "install");
  sourcePath = join(root, "writer.m");
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
      builtAt: "2026-09-24T00:00:00.000Z",
      osVersion: "27.2",
      compiler: "clang",
    })
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function thrown(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateWriteError);
    return error as PrivateWriteError;
  }
  throw new Error("expected a throw");
}

const SPAWN_TIMEOUT = { timeout: 20_000 };

describe("add_paper contract", () => {
  const writerSource = readFileSync(join(packageRoot(__dirname), WRITER_SOURCE_RELATIVE), "utf8");
  const handler = writerSource.slice(
    writerSource.indexOf("static NSDictionary *HandleAddPaper(NSDictionary *request) {"),
    writerSource.indexOf("#pragma mark - Main")
  );

  it("is a writer write action that is not yet live-validated", () => {
    expect(WRITER_ACTIONS.add_paper).toBe("write");
    expect(PAPER_WRITE_LIVE_VALIDATED).toBe(false);
  });

  it("redirects Notes file directories beside a copy store before opening it", () => {
    const sandbox = handler.indexOf(
      "if (store.isCopy) InstallAccountSandbox([store.path stringByDeletingLastPathComponent]);"
    );
    expect(sandbox).toBeGreaterThan(-1);
    expect(sandbox).toBeLessThan(handler.indexOf("OpenContext(store, dryRun)"));
  });

  it("builds the drawing before the store is opened and plans read-only", () => {
    expect(handler.indexOf("DrawingFromSpec(")).toBeLessThan(handler.indexOf("OpenContext("));
    expect(handler).toMatch(/OpenContext\(store, dryRun\)/);
    expect(handler).toMatch(/if \(dryRun\) \{[\s\S]*?@"planned"[\s\S]*?@"committed"\] = @NO/);
  });

  it("verifies through a fresh read-only stack by decoding the saved drawing", () => {
    const verify = handler.slice(handler.indexOf("Fresh read-back"));
    expect(verify).toMatch(/OpenContext\(store, YES\)/);
    expect(verify).toMatch(/VerifiedDrawings\(/);
    expect(verify).toMatch(/@"verification_failed"/);
  });

  it("gives the writer a bundle identifier for PencilKit and links PencilKit", () => {
    expect(writerSource).toMatch(/section\("__TEXT,__info_plist"\)/);
    expect(writerSource).toMatch(/io\.github\.apple-notes-mcp\.private-writer/);
    const args = writerCompileArguments("/writer.m", "/out", "0".repeat(64));
    expect(args.slice(args.indexOf("PencilKit") - 1, args.indexOf("PencilKit") + 1)).toEqual([
      "-framework",
      "PencilKit",
    ]);
    // The read-only helper's flags are unchanged.
    expect(compileArguments("/reader.m", "/out", "0".repeat(64))).not.toContain("PencilKit");
  });
});

describe("addPaper", SPAWN_TIMEOUT, () => {
  it("plans without the unverified gate and sends the dry-run flag", () => {
    const plan = addPaper(
      { identifier: NOTE, ifRevision: REV, drawing: DRAWING, dryRun: true },
      deps(ON)
    );
    expect(plan).toMatchObject({ status: "planned", committed: false, format: "paper" });
    expect((plan as Record<string, unknown>).echo).toMatchObject({
      protocol: 1,
      action: "add_paper",
      format: "auto",
      dryRun: true,
      drawing: DRAWING,
    });
  });

  it("writes only with the unverified gate and returns the verified result", () => {
    const gated = thrown(() =>
      addPaper({ identifier: NOTE, ifRevision: REV, drawing: DRAWING }, deps(ON))
    );
    expect(gated).toMatchObject({ code: "not_live_validated", committed: false });
    const created = addPaper(
      { identifier: NOTE, ifRevision: REV, drawing: DRAWING, format: "drawing" },
      deps(UNVERIFIED)
    );
    expect(created).toMatchObject({
      status: "created",
      committed: true,
      verified: true,
      attachmentIdentifier: ATTACHMENT,
      pushScheduled: false,
      pushState: "awaiting_notes_app",
      format: "drawing",
    });
    const echo = (created as Record<string, unknown>).echo as Record<string, unknown>;
    expect(echo).not.toHaveProperty("dryRun");
    expect(echo.format).toBe("drawing");
  });

  it("needs both writer switches, even for a dry run", () => {
    const off = thrown(() =>
      addPaper(
        { identifier: NOTE, ifRevision: REV, drawing: DRAWING, dryRun: true },
        deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })
      )
    );
    expect(off).toMatchObject({ code: "writes_disabled", committed: false });
  });

  it("validates identifiers and revisions before spawning", () => {
    expect(
      thrown(() =>
        addPaper({ identifier: "x", ifRevision: REV, drawing: DRAWING }, deps(UNVERIFIED))
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
    expect(
      thrown(() =>
        addPaper({ identifier: NOTE, ifRevision: "r1:bad", drawing: DRAWING }, deps(UNVERIFIED))
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
  });

  it("carries the writer's committed answer on failures", () => {
    const conflict = thrown(() =>
      addPaper(
        { identifier: NOTE, ifRevision: REV, drawing: DRAWING },
        deps({ ...UNVERIFIED, FAKE_MODE: "conflict" })
      )
    );
    expect(conflict).toMatchObject({ code: "revision_conflict", committed: false });
    expect(conflict.details.currentRevision).toMatch(/^r1:c/);
    const unverified = thrown(() =>
      addPaper(
        { identifier: NOTE, ifRevision: REV, drawing: DRAWING },
        deps({ ...UNVERIFIED, FAKE_MODE: "verify-failed" })
      )
    );
    expect(unverified).toMatchObject({ code: "verification_failed", committed: true });
    expect(unverified.details.attachmentIdentifier).toBe(ATTACHMENT);
  });

  it("reports a malformed success or an unexplained failure after a write as indeterminate", () => {
    for (const mode of ["malformed", "no-committed"]) {
      const error = thrown(() =>
        addPaper(
          { identifier: NOTE, ifRevision: REV, drawing: DRAWING },
          deps({ ...UNVERIFIED, FAKE_MODE: mode })
        )
      );
      expect(error.committed, mode).toBe("unknown");
    }
  });

  it("never reports a dry run as possibly committed", () => {
    for (const mode of ["malformed", "no-committed"]) {
      const error = thrown(() =>
        addPaper(
          { identifier: NOTE, ifRevision: REV, drawing: DRAWING, dryRun: true },
          deps({ ...ON, FAKE_MODE: mode })
        )
      );
      expect(error.committed, mode).toBe(false);
    }
    const timedOut = thrown(() =>
      addPaper(
        { identifier: NOTE, ifRevision: REV, drawing: DRAWING, dryRun: true },
        deps({ ...ON, FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
      )
    );
    expect(timedOut).toMatchObject({ code: "timeout", committed: false });
    // The transport treats the dry run as a read, so the message does not
    // describe a possible save.
    expect(timedOut.message).not.toMatch(/INDETERMINATE|may have been saved/);
  });

  it("reports a timed-out write as indeterminate", () => {
    const timedOut = thrown(() =>
      addPaper(
        { identifier: NOTE, ifRevision: REV, drawing: DRAWING },
        deps({ ...UNVERIFIED, FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
      )
    );
    expect(timedOut).toMatchObject({ code: "timeout", committed: "unknown" });
  });
});

describe("read_paper contract", () => {
  const writerSource = readFileSync(join(packageRoot(__dirname), WRITER_SOURCE_RELATIVE), "utf8");
  const section = writerSource.slice(
    writerSource.indexOf("#pragma mark - Paper reading"),
    writerSource.indexOf("#pragma mark - Sync state")
  );
  const handler = section.slice(section.indexOf("static NSDictionary *HandleReadPaper("));

  it("is a read action that decodes a private copy of the bundle", () => {
    expect(WRITER_ACTIONS.read_paper).toBe("read");
    const sandbox = handler.indexOf("InstallAccountSandbox(sandbox);");
    expect(sandbox).toBeGreaterThan(-1);
    expect(sandbox).toBeLessThan(handler.indexOf("OpenContext(store, YES)"));
    expect(handler).not.toMatch(/OpenContext\(store, NO\)/);
    expect(handler.indexOf("SnapshotPaperBundle(")).toBeLessThan(
      handler.indexOf("DrawingsForAttachment(")
    );
    expect(handler).toMatch(/removeItemAtPath:sandbox/);
  });

  it("reaches PaperKit only through symbols resolved at run time on macOS 27", () => {
    // Every Swift entry point is looked up with dlsym, so a missing one is a
    // reported gap, not a failed load; nothing is linked by symbol name.
    expect(section).toMatch(/dlsym\(RTLD_DEFAULT, kPaperKitSymbols\[i\]\)/);
    expect(section).not.toMatch(/extern [^;]*\$s/);
    expect(section).toMatch(/operatingSystemVersion\.majorVersion >= 27/);
    expect(section).toMatch(/@"requires_macos_27"/);
    // Buffers are sized from runtime metadata, never from a constant.
    expect(section).toMatch(/SwiftSize\(gPaperKitTypes\[type\]\)/);
  });

  it("reads the fallback PDF without following links and within a size limit", () => {
    expect(section).toMatch(/O_RDONLY \| O_NOFOLLOW/);
    expect(section).toMatch(/S_ISREG\(info\.st_mode\)/);
    expect(section).toMatch(/MAX_FALLBACK_PDF_BYTES/);
    expect(section).toMatch(/CGPDFScannerScan/);
  });
});

describe("readPaper", SPAWN_TIMEOUT, () => {
  it("sends only the fields given and returns the decoded layers", () => {
    const read = readPaper(
      { identifier: NOTE, attachmentIdentifier: ATTACHMENT, maxPoints: 10, includeShapes: true },
      deps(ON)
    );
    expect(read).toMatchObject({
      status: "ok",
      strokeCount: 1,
      shapeDecode: { available: true },
      fallbackGeometry: { available: false, reason: "no_fallback_pdf" },
    });
    expect(read.shapes[0]).toMatchObject({
      kind: "rectangle",
      path: expect.stringMatching(/^M 10 20/),
    });
    expect((read as Record<string, unknown>).echo).toEqual({
      protocol: 1,
      action: "read_paper",
      identifier: NOTE,
      attachmentIdentifier: ATTACHMENT,
      maxPoints: 10,
      includeShapes: true,
    });
  });

  it("reports an unavailable shape layer as data, not as a failure", () => {
    const read = readPaper({ identifier: NOTE }, deps({ ...ON, FAKE_MODE: "macos-26" }));
    expect(read.shapeDecode).toMatchObject({ available: false, reason: "requires_macos_27" });
    expect(read.shapes).toEqual([]);
    expect(read.strokes).toHaveLength(1);
  });

  it("validates before spawning and never reports a read as committed", () => {
    expect(thrown(() => readPaper({ identifier: "x" }, deps(ON)))).toMatchObject({
      code: "invalid_request",
    });
    expect(
      thrown(() => readPaper({ identifier: NOTE, attachmentIdentifier: "nope" }, deps(ON)))
    ).toMatchObject({ code: "invalid_request" });
    for (const maxPoints of [0, 1.5, MAX_PAPER_READ_POINTS + 1])
      expect(thrown(() => readPaper({ identifier: NOTE, maxPoints }, deps(ON)))).toMatchObject({
        code: "invalid_request",
      });
    const ambiguous = thrown(() =>
      readPaper({ identifier: NOTE }, deps({ ...ON, FAKE_MODE: "ambiguous" }))
    );
    expect(ambiguous).toMatchObject({ code: "ambiguous_attachment" });
    expect(ambiguous.committed).toBeUndefined();
    const timedOut = thrown(() =>
      readPaper(
        { identifier: NOTE },
        deps({ ...ON, FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
      )
    );
    expect(timedOut).toMatchObject({ code: "timeout" });
    expect(timedOut.committed).toBeUndefined();
  });

  it("reports both Paper read layers in the capability matrix, needing no unverified gate", () => {
    expect(privateWriterCapabilities(deps(ON)).features.readPaper).toEqual({
      available: true,
      reason: null,
      detail: null,
    });
    const old = privateWriterCapabilities(deps({ ...ON, FAKE_MODE: "macos-26" }));
    expect(old.features.readPaper.available).toBe(true);
    expect(old.features.readPaperShapes).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
    });
    expect(old.features.readPaperShapes.detail).toMatch(/macOS 27/);
  });
});

describe("addPaper capability", SPAWN_TIMEOUT, () => {
  it("keeps Paper authoring behind the unverified gate", () => {
    expect(privateWriterCapabilities(deps(ON)).features.addPaper).toMatchObject({
      available: false,
      reason: "not_live_validated",
    });
    expect(privateWriterCapabilities(deps(UNVERIFIED)).features.addPaper).toEqual({
      available: true,
      reason: null,
      detail: null,
    });
  });

  it("reports missing API, an older writer, and the switches", () => {
    const missing = privateWriterCapabilities(deps({ ...UNVERIFIED, FAKE_MODE: "no-paper-api" }));
    expect(missing.features.addPaper).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
    });
    expect(missing.features.addPaper.detail).toMatch(/ICPaperAttachmentCreationHelper/);
    expect(missing.features.appendPlainText.available).toBe(true);
    const old = privateWriterCapabilities(deps({ ...UNVERIFIED, FAKE_MODE: "old-writer" }));
    expect(old.features.addPaper.reason).toBe("private_api_unavailable");
    expect(privateWriterCapabilities(deps()).features.addPaper.reason).toBe("disabled");
    expect(
      privateWriterCapabilities(deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })).features.addPaper
        .reason
    ).toBe("writes_disabled");
  });
});
