import { describe, it, expect, vi } from "vitest";

vi.mock("@/utils/checklistParser.js", () => ({ hasFullDiskAccess: vi.fn(() => true) }));
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({
    stdout: "",
    // codesign writes its details to stderr
    stderr:
      "Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)\nTeamIdentifier=HX7739G8FX\n",
    error: null,
  })),
}));

import { spawnSync } from "child_process";
import { runDoctor, formatDoctorReport, checkNodeRuntimeSignature } from "@/tools/doctor.js";
import { hasFullDiskAccess } from "@/utils/checklistParser.js";
import type { AppleNotesManager } from "@/services/appleNotesManager.js";

const mockSpawnSync = vi.mocked(spawnSync);

function fakeMgr(over: Partial<AppleNotesManager> = {}): AppleNotesManager {
  return {
    healthCheck: () => ({
      healthy: true,
      checks: [{ name: "reachable", passed: true, message: "Notes.app responded" }],
    }),
    listAccounts: () => [{ name: "iCloud" }, { name: "Gmail" }],
    ...over,
  } as unknown as AppleNotesManager;
}

describe("runDoctor (#22)", () => {
  it("reports accounts + Full Disk Access and stays healthy on warnings", () => {
    const r = runDoctor(fakeMgr());
    expect(r.healthy).toBe(true);
    expect(r.checks.find((c) => c.name === "Accounts")?.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "Accounts")?.detail).toMatch(/iCloud, Gmail/);
    expect(r.checks.find((c) => c.name === "Full Disk Access")?.status).toBe("ok");
  });

  it("warns (not fails) when Full Disk Access is not granted", () => {
    vi.mocked(hasFullDiskAccess).mockReturnValueOnce(false);
    const r = runDoctor(fakeMgr());
    const fda = r.checks.find((c) => c.name === "Full Disk Access");
    expect(fda?.status).toBe("warn");
    expect(fda?.detail).toMatch(/Full Disk Access/);
    expect(r.healthy).toBe(true);
  });

  it("is unhealthy when a Notes.app check fails", () => {
    const r = runDoctor(
      fakeMgr({
        healthCheck: () => ({
          healthy: false,
          checks: [{ name: "permission", passed: false, message: "not authorized" }],
        }),
      })
    );
    expect(r.healthy).toBe(false);
    expect(formatDoctorReport(r)).toMatch(/ISSUES FOUND/);
    expect(formatDoctorReport(r)).toMatch(/❌ Notes\.app: permission/);
  });

  it("includes the Node runtime signature check in the report", () => {
    const r = runDoctor(fakeMgr());
    const sig = r.checks.find((c) => c.name === "Node runtime signature");
    expect(sig?.status).toBe("ok");
    expect(sig?.detail).toMatch(/Team ID HX7739G8FX/);
  });
});

describe("checkNodeRuntimeSignature", () => {
  it("reports ok with the Team ID for a Developer-ID-signed Node", () => {
    const c = checkNodeRuntimeSignature();
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/Team ID HX7739G8FX/);
    expect(c.detail).toMatch(/persist/);
  });

  it("warns (not fails) for an ad-hoc signed Node and points at the fix", () => {
    mockSpawnSync.mockReturnValueOnce({
      stdout: "",
      stderr: "Signature=adhoc\nTeamIdentifier=not set\n",
      error: undefined,
    } as unknown as ReturnType<typeof spawnSync>);
    const c = checkNodeRuntimeSignature();
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/ad-hoc signed/);
    expect(c.detail).toMatch(/NODE-RUNTIME-AND-TCC-PERMISSIONS/);
  });

  it("warns when codesign output is unavailable", () => {
    mockSpawnSync.mockReturnValueOnce({
      stdout: "",
      stderr: "",
      error: new Error("spawn codesign ENOENT"),
    } as unknown as ReturnType<typeof spawnSync>);
    const c = checkNodeRuntimeSignature();
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/could not inspect/);
  });
});
