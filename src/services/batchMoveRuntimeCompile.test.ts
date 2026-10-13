/** Compile the actual runtime input without sending any Apple Events to Notes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeGuard } from "@/utils/scopeGuard.js";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("@/utils/smartFolders.js", () => ({
  readSmartFolders: vi.fn(() => ({ folders: [] })),
}));

import { AppleNotesManager } from "./appleNotesManager.js";

const exec = vi.mocked(execFileSync);
const STORE = "x-coredata://ABC00000-0000-0000-0000-000000000004";
const ID1 = `${STORE}/ICNote/p1`;
const ID2 = `${STORE}/ICNote/p2`;
const F1 = `${STORE}/ICFolder/p10`;
const F2 = `${STORE}/ICFolder/p20`;
const R = "\x1e";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APPLE_NOTES_MCP_TIMEOUT_MS", "30000");
});

afterEach(() => vi.unstubAllEnvs());

describe("batch move scripts compile through the real execution wrapper", () => {
  it.each<ScopeGuard | undefined>([
    undefined,
    { ifFolderId: F1 },
    { ifAncestorFolderId: F1 },
    { forbiddenAncestorFolderIds: [F2] },
    { ifFolderId: F1, ifAncestorFolderId: F1, forbiddenAncestorFolderIds: [F2] },
  ])("compiles the exact osascript stdin for guard %j", async (guard) => {
    const native = await vi.importActual<typeof import("child_process")>("child_process");
    const dir = mkdtempSync(join(tmpdir(), "batch-runtime-compile-"));
    try {
      exec.mockImplementation((file, args, options) => {
        expect(file).toBe("osascript");
        expect(args).toEqual(["-"]);
        const input = (options as { input: string }).input;
        expect(input).toMatch(/^with timeout of 25 seconds\n/);
        expect(input).toMatch(/\nend timeout$/);
        expect(options).toMatchObject({ killSignal: "SIGKILL" });
        expect((options as { timeout: number }).timeout).toBeGreaterThan(25000);
        expect((options as { timeout: number }).timeout).toBeLessThanOrEqual(30000);
        const source = join(dir, "script.applescript");
        writeFileSync(source, input);
        // Compile only: the generated move command is never executed.
        native.execFileSync("/usr/bin/osacompile", ["-o", join(dir, "script.scpt"), source], {
          stdio: "pipe",
        });
        return `ok${R}SAFETY_SCOPE:the note is not in the expected folder${R}`;
      });
      const account = guard === undefined ? undefined : "iCloud";
      const results = new AppleNotesManager().batchMoveNotes([ID1, ID2], "Archive", account, guard);
      expect(results[0]).toEqual({ id: ID1, success: true });
      expect(results[1]).toMatchObject({
        id: ID2,
        success: false,
        committed: false,
        indeterminate: false,
      });
      // The compile probe intercepts the only mutation dispatch attempt.
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a runtime timeout uncertain without retrying the mutation", () => {
    exec.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync osascript ETIMEDOUT"), {
        code: "ETIMEDOUT",
        signal: "SIGKILL",
      });
    });
    const results = new AppleNotesManager().batchMoveNotes([ID1, ID2], "Archive", "iCloud", {
      ifFolderId: F1,
    });
    for (const result of results) {
      expect(result).toMatchObject({ success: false, indeterminate: true });
      expect(result).not.toHaveProperty("committed");
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
