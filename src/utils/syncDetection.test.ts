/**
 * Tests for iCloud Sync Detection Utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSyncStatus,
  logSyncWarning,
  withSyncAwareness,
  withSyncAwarenessSync,
  isSyncActive,
  getSyncStatusSummary,
  clearSyncStatusCache,
  type SyncStatus,
} from "./syncDetection.js";

// Mock child_process
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import * as fs from "fs";

const mockExecSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);

describe("getSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncStatusCache(); // Clear cache between tests
  });

  it("returns error when database not found", () => {
    mockExistsSync.mockReturnValue(false);

    const status = getSyncStatus();

    expect(status.error).toBe("Notes database not found");
    expect(status.syncDetected).toBe(false);
  });

  it("detects no sync activity when idle", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000, // 60 seconds ago
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    const status = getSyncStatus();

    expect(status.syncDetected).toBe(false);
    expect(status.pendingUpload).toBe(0);
    expect(status.recentActivity).toBe(false);
    expect(status.warning).toBeUndefined();
  });

  it("counts only cloud state rows referenced by live syncing objects", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    getSyncStatus();

    const sqliteArgs = mockExecSync.mock.calls[0]?.[1];
    expect(sqliteArgs).toEqual(
      expect.arrayContaining([expect.stringContaining("ZICCLOUDSYNCINGOBJECT")])
    );
    expect(sqliteArgs).toEqual(expect.arrayContaining([expect.stringContaining("ZCLOUDSTATE")]));
    expect(sqliteArgs).toEqual(
      expect.arrayContaining([expect.stringContaining("object.ZCLOUDSTATE = state.Z_PK")])
    );
  });

  it("detects pending uploads", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("5\n");

    const status = getSyncStatus();

    expect(status.syncDetected).toBe(true);
    expect(status.pendingUpload).toBe(5);
    expect(status.warning).toContain("5 item(s) pending upload");
  });

  it("detects recent database activity", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 2000, // 2 seconds ago
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    const status = getSyncStatus();

    expect(status.syncDetected).toBe(true);
    expect(status.recentActivity).toBe(true);
    expect(status.secondsSinceLastChange).toBeLessThan(5);
    expect(status.warning).toContain("database modified");
  });

  it("detects both pending uploads and recent activity", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 1000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("3\n");

    const status = getSyncStatus();

    expect(status.syncDetected).toBe(true);
    expect(status.pendingUpload).toBe(3);
    expect(status.recentActivity).toBe(true);
    expect(status.warning).toContain("3 item(s) pending upload");
    expect(status.warning).toContain("database modified");
  });

  it("handles sqlite3 errors gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockImplementation(() => {
      throw new Error("database is locked");
    });

    const status = getSyncStatus();

    expect(status.error).toContain("database is locked");
    expect(status.syncDetected).toBe(false);
  });
});

describe("logSyncWarning", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs warning when sync detected", () => {
    const status: SyncStatus = {
      syncDetected: true,
      pendingUpload: 2,
      secondsSinceLastChange: 3,
      recentActivity: true,
      warning: "iCloud sync in progress",
    };

    logSyncWarning(status, "test-operation");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Sync Warning]"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("test-operation"));
  });

  it("does not log when no warning", () => {
    const status: SyncStatus = {
      syncDetected: false,
      pendingUpload: 0,
      secondsSinceLastChange: 60,
      recentActivity: false,
    };

    logSyncWarning(status, "test-operation");

    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("withSyncAwareness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncStatusCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes operation and returns result with sync info", async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    const result = await withSyncAwareness("test", async () => "success");

    expect(result.result).toBe("success");
    expect(result.syncBefore).toBeDefined();
    expect(result.syncAfter).toBeDefined();
    expect(result.syncInterference).toBe(false);
  });

  it("detects sync interference when pending count changes", async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 1000,
    } as fs.Stats);

    // First call: 5 pending, second call: 3 pending
    mockExecSync.mockReturnValueOnce("5\n").mockReturnValueOnce("3\n");

    const result = await withSyncAwareness("test", async () => "data");

    expect(result.syncBefore.pendingUpload).toBe(5);
    expect(result.syncAfter?.pendingUpload).toBe(3);
    expect(result.syncInterference).toBe(true);
    expect(result.interferenceWarning).toContain("sync activity detected");
  });
});

describe("withSyncAwarenessSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncStatusCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes sync operation with sync awareness", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    const result = withSyncAwarenessSync("test", () => 42);

    expect(result.result).toBe(42);
    expect(result.syncBefore).toBeDefined();
    expect(result.syncAfter).toBeDefined();
  });
});

describe("isSyncActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncStatusCache();
  });

  it("returns true when sync is active", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 2000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    expect(isSyncActive()).toBe(true);
  });

  it("returns false when sync is idle", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    expect(isSyncActive()).toBe(false);
  });
});

describe("getSyncStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncStatusCache();
  });

  it("returns idle message when no sync activity", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 60000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("0\n");

    expect(getSyncStatusSummary()).toBe("iCloud sync: Idle");
  });

  it("returns active message with details", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 2000,
    } as fs.Stats);
    mockExecSync.mockReturnValue("3\n");

    const summary = getSyncStatusSummary();
    expect(summary).toContain("iCloud sync: Active");
    expect(summary).toContain("3 pending upload(s)");
  });

  it("returns error message when detection fails", () => {
    mockExistsSync.mockReturnValue(false);

    const summary = getSyncStatusSummary();
    expect(summary).toContain("Sync status unknown");
  });
});
