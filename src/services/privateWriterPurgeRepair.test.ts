/**
 * Purge-flag repair client (#89). The writer is faked at the spawn level, so
 * these cover the request shape, the two-phase and confirm rules, and
 * response validation without touching Notes data. The writer side runs
 * against a store copy in scripts/test-private-writer-guards-copy-store.sh.
 */
import { describe, expect, it } from "vitest";
import type { spawnSync } from "node:child_process";
import { sha256Hex } from "./privateHelper.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  PURGE_REPAIR_LIVE_VALIDATED,
  PrivateWriteError,
  WRITER_ACTIONS,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { repairPurgeFlag } from "./privateWriterPurgeRepair.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const REV2 = `r1:${"b".repeat(64)}`;
const cloudSync = {
  available: true,
  inICloudAccount: true,
  currentLocalVersion: 3,
  latestVersionSyncedToCloud: 1,
  uploadPending: true,
};
const plan = {
  identifier: NOTE,
  objectURI: "x-coredata://S/ICNote/p5",
  title: "Lost note",
  state: "purge_flag_outside_recently_deleted",
  repairable: true,
  blockers: [],
  folderIdentifier: "F1",
  folderObjectURI: "x-coredata://S/ICFolder/p9",
  folderMarkedForDeletion: false,
  recentlyDeletedFolderIdentifier: "TrashFolder-CloudKit",
  attachmentCount: 2,
  attachmentsMarkedForDeletion: 0,
  revision: REV,
  cloudSync,
};

function writer(
  requests: Array<Record<string, unknown>>,
  env: Record<string, string> = {}
): PrivateHelperDeps {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    protocolVersion: PRIVATE_WRITER_PROTOCOL,
    sourceSha256: sha256Hex("src"),
    binarySha256: sha256Hex("bin"),
    builtAt: "x",
    osVersion: "27.2",
    compiler: "clang",
  });
  const spawn = ((_bin: string, _args: string[], options: { input: string }) => {
    const req = JSON.parse(options.input);
    requests.push(req);
    let out: Record<string, unknown>;
    if (req.dryRun && !req.identifier)
      out = {
        status: "scanned",
        dryRun: true,
        committed: false,
        markedForDeletionCount: 4,
        candidateCount: 1,
        truncated: false,
        candidates: [plan],
      };
    else if (req.dryRun) out = { ...plan, status: "planned", dryRun: true, committed: false };
    else
      out = {
        status: "repaired",
        dryRun: false,
        committed: true,
        verified: true,
        repairedPurgeFlag: true,
        identifier: NOTE,
        previousState: "purge_flag_outside_recently_deleted",
        state: "in_recently_deleted",
        fromFolderIdentifier: "F1",
        recentlyDeletedFolderIdentifier: "TrashFolder-CloudKit",
        folderIdentifier: "TrashFolder-CloudKit",
        revisionBefore: REV,
        revisionAfter: REV2,
        modificationDate: null,
        cloudSync,
        pushScheduled: false,
        pushState: "awaiting_notes_app",
        syncHostRunning: true,
        storeKind: "copy",
      };
    return { status: 0, stdout: JSON.stringify(out), stderr: "", signal: null };
  }) as unknown as typeof spawnSync;
  return defaultWriterDeps({
    env: {
      APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
      APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
      APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: "/fake",
      ...env,
    },
    platform: "darwin",
    sourcePath: "/fake/src.m",
    exists: () => true,
    readFile: (path) =>
      Buffer.from(
        path.endsWith(WRITER_MANIFEST_NAME) ? manifest : path.endsWith(".m") ? "src" : "bin"
      ),
    spawn,
  });
}

function refusal(call: () => unknown): PrivateWriteError {
  try {
    call();
  } catch (error) {
    if (error instanceof PrivateWriteError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("repairPurgeFlag", () => {
  it("is a write action that has not passed live validation", () => {
    expect(WRITER_ACTIONS.repair_purge_flag).toBe("write");
    expect(PURGE_REPAIR_LIVE_VALIDATED).toBe(false);
  });

  it("scans read-only when no identifier is given (the default is a dry run)", () => {
    const requests: Array<Record<string, unknown>> = [];
    const scan = repairPurgeFlag({}, writer(requests));
    expect(requests).toEqual([
      { protocol: PRIVATE_WRITER_PROTOCOL, action: "repair_purge_flag", dryRun: true },
    ]);
    expect(scan).toMatchObject({ status: "scanned", candidateCount: 1 });
  });

  it("plans one note read-only and returns its revision", () => {
    const requests: Array<Record<string, unknown>> = [];
    const planned = repairPurgeFlag({ identifier: NOTE }, writer(requests));
    expect(requests[0]).toEqual({
      protocol: PRIVATE_WRITER_PROTOCOL,
      action: "repair_purge_flag",
      dryRun: true,
      identifier: NOTE,
    });
    expect(planned).toMatchObject({ status: "planned", repairable: true, revision: REV });
  });

  it("applies only with the plan's revision, confirm, and the live-validation gate", () => {
    const requests: Array<Record<string, unknown>> = [];
    const gated = writer(requests);
    expect(
      refusal(() => repairPurgeFlag({ identifier: NOTE, dryRun: false, ifRevision: REV }, gated))
    ).toMatchObject({ code: "confirmation_required", committed: false });
    expect(
      refusal(() => repairPurgeFlag({ identifier: NOTE, dryRun: false, confirm: true }, gated))
    ).toMatchObject({ code: "invalid_request", committed: false });
    expect(
      refusal(() => repairPurgeFlag({ dryRun: false, ifRevision: REV, confirm: true }, gated))
    ).toMatchObject({ code: "invalid_request", committed: false });
    expect(
      refusal(() =>
        repairPurgeFlag({ identifier: NOTE, dryRun: false, ifRevision: REV, confirm: true }, gated)
      )
    ).toMatchObject({ code: "not_live_validated", committed: false });
    expect(requests).toEqual([]);

    const repaired = repairPurgeFlag(
      { identifier: NOTE, dryRun: false, ifRevision: REV, confirm: true },
      writer(requests, { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" })
    );
    expect(requests[0]).toEqual({
      protocol: PRIVATE_WRITER_PROTOCOL,
      action: "repair_purge_flag",
      identifier: NOTE,
      dryRun: false,
      ifRevision: REV,
      confirm: true,
    });
    expect(repaired).toMatchObject({
      status: "repaired",
      committed: true,
      state: "in_recently_deleted",
      revisionAfter: REV2,
    });
  });

  it("refuses apply-only fields in a dry run and a guard on a scan", () => {
    const requests: Array<Record<string, unknown>> = [];
    const deps = writer(requests);
    expect(
      refusal(() => repairPurgeFlag({ identifier: NOTE, ifRevision: REV }, deps))
    ).toMatchObject({ code: "invalid_request" });
    expect(refusal(() => repairPurgeFlag({ confirm: true }, deps))).toMatchObject({
      code: "invalid_request",
    });
    expect(
      refusal(() =>
        repairPurgeFlag(
          {
            scope: {
              forbiddenAncestorFolderIds: ["x-coredata://8FA9FE0E-3B93/ICFolder/p1"],
            },
          },
          deps
        )
      )
    ).toMatchObject({ code: "invalid_request", message: /need an identifier/ });
    expect(refusal(() => repairPurgeFlag({ identifier: "nope" }, deps))).toMatchObject({
      code: "invalid_request",
    });
    expect(requests).toEqual([]);
  });
});
