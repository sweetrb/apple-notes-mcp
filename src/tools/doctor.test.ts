import { describe, it, expect, vi } from "vitest";

vi.mock("@/utils/checklistParser.js", () => ({ hasFullDiskAccess: vi.fn(() => true) }));
vi.mock("@/services/nativeTags.js", () => ({
  NATIVE_TAGS_SHORTCUT: "Apple Notes MCP - Native Tags",
  nativeTagsShortcutName: () => "Apple Notes MCP - Native Tags",
  listInstalledShortcuts: vi.fn(() => []),
  resolveShortcut: vi.fn(),
  nativeTagsStatus: vi.fn((shortcut: string) => ({
    shortcut,
    installed: true,
    identifier: shortcut,
  })),
}));
vi.mock("@/services/backgroundNotes.js", () => ({
  BACKGROUND_SHORTCUT: "Apple Notes MCP - Background Operations v5",
  MARKDOWN_NOTE_SHORTCUT: "Apple Notes MCP - Create Markdown Note",
  backgroundShortcutName: () => "Apple Notes MCP - Background Operations v5",
  markdownShortcutName: () => "Apple Notes MCP - Create Markdown Note",
}));
const { matrix } = vi.hoisted(() => ({
  matrix: {
    runtimeOS: { platform: "darwin", macOSVersion: "26.1", darwinRelease: "25.1.0" },
    features: {
      applescriptCore: {
        description: "core",
        tools: [],
        available: true,
        osSupported: true,
        minimumMacOSVersion: null,
        requirements: ["notes_automation"],
        missing: [],
        unverified: ["notes_automation"],
        reason: null,
      },
      smartFolders: {
        description: "placeholder",
        tools: [],
        available: false,
        osSupported: true,
        minimumMacOSVersion: null,
        requirements: ["native_write_helper"],
        missing: ["native_write_helper"],
        unverified: [],
        reason: "not_implemented",
      },
    },
  },
}));
vi.mock("@/services/capabilityMatrix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/capabilityMatrix.js")>()),
  getCapabilityMatrix: vi.fn(() => matrix),
}));
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
import {
  runDoctor,
  formatDoctorReport,
  checkNodeRuntimeSignature,
  fdaRemediation,
} from "@/tools/doctor.js";
import { hasFullDiskAccess } from "@/utils/checklistParser.js";
import { nativeTagsStatus } from "@/services/nativeTags.js";
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
    // #220: names the Node binary, not just the launching app.
    expect(fda?.detail).toContain(process.execPath);
    expect(r.healthy).toBe(true);
  });

  it("fdaRemediation says Claude Desktop needs the Node binary itself (#220)", () => {
    const msg = fdaRemediation("/opt/node/bin/node");
    expect(msg).toContain("/opt/node/bin/node");
    expect(msg).toMatch(/Claude Desktop/);
    expect(msg).toMatch(/does not reach them/);
    expect(msg).not.toMatch(/version manager/);
  });

  it("fdaRemediation warns that a version-manager Node path changes per version (#220)", () => {
    const msg = fdaRemediation("/Users/x/.nvm/versions/node/v24.11.1/bin/node");
    expect(msg).toMatch(/version manager/);
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

  it("points to setup when a native-write Shortcut is missing", () => {
    vi.mocked(nativeTagsStatus)
      .mockReturnValueOnce({ shortcut: "Native Tags", installed: true, identifier: "native" })
      .mockReturnValueOnce({ shortcut: "Background Operations", installed: false });
    const check = runDoctor(fakeMgr()).checks.find(
      (item) => item.name === "Native write Shortcuts"
    );
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toContain("apple-notes-mcp setup");
    expect(check?.detail).toMatch(/once in the foreground in Shortcuts\.app.*Always Allow/);
  });

  // #172 item 5 — the CLI exposes no consent state, so doctor cannot detect an
  // unanswered first-run prompt; it reminds instead of reporting a false "ok".
  it("reminds that installed bridges still need one foreground run to answer consent", () => {
    const check = runDoctor(fakeMgr()).checks.find(
      (item) => item.name === "Native write Shortcuts"
    );
    expect(check).toMatchObject({ status: "ok" });
    expect(check?.detail).toMatch(/installed/);
    expect(check?.detail).toMatch(/after install or upgrade/i);
    expect(check?.detail).toMatch(/once in the foreground in Shortcuts\.app.*Always Allow/);
    expect(check?.detail).toMatch(/first-run consent prompt/);
    expect(check?.detail).toMatch(/^both native-write bridges are installed\./);
    expect(check?.detail).toContain(
      "Optional Apple Notes MCP - Create Markdown Note bridge: installed"
    );
  });

  // #172 review — the Markdown bridge serves one optional create-note format and
  // cannot run before macOS 26, so its absence must not degrade the check.
  it("stays ok when only the optional Create Markdown Note bridge is missing", () => {
    vi.mocked(nativeTagsStatus).mockImplementation((shortcut?: string) => ({
      shortcut: shortcut!,
      installed: !shortcut!.includes("Create Markdown Note"),
      identifier: shortcut,
    }));
    try {
      const report = runDoctor(fakeMgr());
      const check = report.checks.find((item) => item.name === "Native write Shortcuts");
      expect(check).toMatchObject({ status: "ok" });
      expect(check?.detail).toMatch(/^both native-write bridges are installed\./);
      expect(check?.detail).toMatch(
        /Optional Apple Notes MCP - Create Markdown Note bridge: not installed \(needed only for create-note format: "markdown" on macOS 26\+/
      );
      expect(check?.detail).not.toMatch(/missing:/);
      expect(check?.detail).toMatch(/once in the foreground in Shortcuts\.app.*Always Allow/);
      expect(report.healthy).toBe(true);
    } finally {
      vi.mocked(nativeTagsStatus).mockImplementation((shortcut?: string) => ({
        shortcut: shortcut!,
        installed: true,
        identifier: shortcut,
      }));
    }
  });

  it("stays ok when the optional bridge cannot be inspected", () => {
    vi.mocked(nativeTagsStatus)
      .mockReturnValueOnce({ shortcut: "Native Tags", installed: true, identifier: "native" })
      .mockReturnValueOnce({ shortcut: "Background", installed: true, identifier: "background" })
      .mockImplementationOnce(() => {
        throw new Error("shortcuts list failed");
      });
    const check = runDoctor(fakeMgr()).checks.find(
      (item) => item.name === "Native write Shortcuts"
    );
    expect(check).toMatchObject({ status: "ok" });
    expect(check?.detail).toMatch(/Create Markdown Note bridge: could not inspect/);
  });

  it("warns for a missing required bridge but does not list the optional one as missing", () => {
    vi.mocked(nativeTagsStatus)
      .mockReturnValueOnce({ shortcut: "Native Tags", installed: false })
      .mockReturnValueOnce({ shortcut: "Background", installed: true, identifier: "background" })
      .mockReturnValueOnce({ shortcut: "Create Markdown Note", installed: false });
    const check = runDoctor(fakeMgr()).checks.find(
      (item) => item.name === "Native write Shortcuts"
    );
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toMatch(/^missing: Native Tags\. Run apple-notes-mcp setup/);
    expect(check?.detail).toContain("Create Markdown Note bridge: not installed");
  });
});

describe("runDoctor feature matrix", () => {
  it("adds runtimeOS and features without changing checks or health", () => {
    const r = runDoctor(fakeMgr());
    expect(r.runtimeOS).toEqual(matrix.runtimeOS);
    expect(r.features?.smartFolders.reason).toBe("not_implemented");
    expect(r.healthy).toBe(true);
    expect(r.checks.some((c) => /matrix/i.test(c.name))).toBe(false);
    const text = formatDoctorReport(r);
    expect(text).toMatch(/Feature matrix \(macOS 26\.1, Darwin 25\.1\.0\)/);
    expect(text).toMatch(/✓ applescriptCore: available \(unverified: notes_automation\)/);
    expect(text).toMatch(/✗ smartFolders: not_implemented \(missing: native_write_helper\)/);
  });

  it("keeps the original report when the matrix probe throws", () => {
    const r = runDoctor(fakeMgr(), () => {
      throw new Error("probe failed");
    });
    expect(r.runtimeOS).toBeUndefined();
    expect(r.features).toBeUndefined();
    expect(r.checks.length).toBeGreaterThan(0);
    expect(formatDoctorReport(r)).not.toMatch(/Feature matrix/);
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
