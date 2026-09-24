import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("../utils/checklistParser.js", () => ({ hasFullDiskAccess: vi.fn(() => true) }));

import { execFileSync } from "node:child_process";
import { hasFullDiskAccess } from "../utils/checklistParser.js";
import {
  FEATURES,
  compareVersions,
  evaluateFeature,
  evaluateFeatures,
  formatCapabilityMatrix,
  getCapabilityMatrix,
  probeCapabilityEnvironment,
  readMacOSVersion,
  type CapabilityEnvironment,
  type FeatureDefinition,
} from "./capabilityMatrix.js";

const mockExec = vi.mocked(execFileSync);

const BG = "Apple Notes MCP - Background Operations v5";
const TAGS = "Apple Notes MCP - Native Tags";
const MD = "Apple Notes MCP - Create Markdown Note";
const line = (name: string, n: number) => `${name} (00000000-0000-0000-0000-00000000000${n})`;

function env(over: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return {
    platform: "darwin",
    macOSVersion: "26.1",
    darwinRelease: "25.1.0",
    fullDiskAccess: true,
    shortcutLines: [line(BG, 1), line(TAGS, 2), line(MD, 3), "Unrelated (not-a-uuid)"],
    ...over,
  };
}
const feature = (name: string) => {
  const found = FEATURES.find((f) => f.name === name);
  if (!found) throw new Error(`no feature ${name}`);
  return found;
};

beforeEach(() => {
  mockExec.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("FEATURES registry", () => {
  it("has unique names and names every documented group", () => {
    const names = FEATURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "applescriptCore",
        "fullDiskAccessReads",
        "shortcutsBridges",
        "backgroundOperationsBridge",
        "nativeTagsBridge",
        "markdownNoteBridge",
        "checklistToggle",
        "smartFolders",
        "paragraphLinks",
        "audioTranscription",
      ])
    );
  });

  it("registers a new feature with one entry", () => {
    const extra: FeatureDefinition = {
      name: "futureThing",
      description: "x",
      tools: ["future-tool"],
      minimumMacOSVersion: "27.0",
      requirements: [{ kind: "full_disk_access" }],
    };
    const m = evaluateFeatures(env(), [...FEATURES, extra]);
    expect(m.features.futureThing).toMatchObject({
      available: false,
      osSupported: false,
      reason: "requires_macos_27",
      tools: ["future-tool"],
    });
  });
});

describe("evaluateFeature", () => {
  it("reports everything available on a fully set-up macOS 26 Mac", () => {
    const m = evaluateFeatures(env());
    for (const name of [
      "applescriptCore",
      "fullDiskAccessReads",
      "shortcutsBridges",
      "backgroundOperationsBridge",
      "nativeTagsBridge",
      "markdownNoteBridge",
    ])
      expect(m.features[name]).toMatchObject({ available: true, reason: null, missing: [] });
    expect(m.runtimeOS).toEqual({
      platform: "darwin",
      macOSVersion: "26.1",
      darwinRelease: "25.1.0",
    });
  });

  it("marks the Automation grant unverified instead of guessing", () => {
    const s = evaluateFeature(feature("applescriptCore"), env());
    expect(s.available).toBe(true);
    expect(s.unverified).toEqual(["notes_automation"]);
    expect(s.requirements).toEqual(["notes_automation"]);
  });

  it("reports placeholders as not_implemented", () => {
    for (const name of ["checklistToggle", "smartFolders"])
      expect(evaluateFeature(feature(name), env())).toMatchObject({
        available: false,
        osSupported: true,
        reason: "not_implemented",
        missing: ["native_write_helper"],
      });
  });

  it("reports paragraph links and audio transcription as shipped database reads", () => {
    expect(feature("paragraphLinks").tools).toEqual(["list-note-paragraphs", "get-paragraph-link"]);
    expect(feature("audioTranscription").tools).toEqual([
      "get-audio-transcripts",
      "transcribe-note-audio",
    ]);
    for (const name of ["paragraphLinks", "audioTranscription"]) {
      expect(evaluateFeature(feature(name), env())).toMatchObject({
        available: true,
        reason: null,
        requirements: ["full_disk_access"],
      });
      expect(evaluateFeature(feature(name), env({ fullDiskAccess: false }))).toMatchObject({
        available: false,
        reason: "full_disk_access_missing",
      });
    }
  });

  it("keeps write-dependent features not_implemented even with the read-only helper enabled", () => {
    const saved = process.env.APPLE_NOTES_MCP_ENABLE_PRIVATE;
    process.env.APPLE_NOTES_MCP_ENABLE_PRIVATE = "1";
    try {
      for (const f of FEATURES.filter((x) =>
        x.requirements.some((r) => r.kind === "native_write_helper")
      ))
        expect(evaluateFeature(f, env())).toMatchObject({
          available: false,
          reason: "not_implemented",
        });
      expect(FEATURES.flatMap((f) => f.tools)).not.toContain("native-append-plain-text");
    } finally {
      if (saved === undefined) delete process.env.APPLE_NOTES_MCP_ENABLE_PRIVATE;
      else process.env.APPLE_NOTES_MCP_ENABLE_PRIVATE = saved;
    }
  });

  it("gates the Markdown bridge on macOS 26", () => {
    const s = evaluateFeature(feature("markdownNoteBridge"), env({ macOSVersion: "15.6" }));
    expect(s).toMatchObject({
      available: false,
      osSupported: false,
      minimumMacOSVersion: "26.0",
      reason: "requires_macos_26",
    });
    // The macOS 15 Mac still runs the other bridges.
    expect(
      evaluateFeature(feature("backgroundOperationsBridge"), env({ macOSVersion: "15.6" }))
    ).toMatchObject({ available: true, osSupported: true });
  });

  it("reports unknown_os_version only for features with a floor", () => {
    const e = env({ macOSVersion: null });
    expect(evaluateFeature(feature("markdownNoteBridge"), e).reason).toBe("unknown_os_version");
    expect(evaluateFeature(feature("markdownNoteBridge"), e).osSupported).toBe(false);
    expect(evaluateFeature(feature("applescriptCore"), e)).toMatchObject({
      available: true,
      osSupported: true,
    });
  });

  it("reports full_disk_access_missing with the requirement named", () => {
    const e = env({ fullDiskAccess: false });
    expect(evaluateFeature(feature("fullDiskAccessReads"), e)).toMatchObject({
      available: false,
      osSupported: true,
      reason: "full_disk_access_missing",
      missing: ["full_disk_access"],
    });
    // Bridges verify by database readback, so they need it too.
    expect(evaluateFeature(feature("backgroundOperationsBridge"), e).reason).toBe(
      "full_disk_access_missing"
    );
    expect(evaluateFeature(feature("applescriptCore"), e).available).toBe(true);
  });

  it("reports shortcut_not_installed per bridge", () => {
    const e = env({ shortcutLines: [line(BG, 1)] });
    expect(evaluateFeature(feature("backgroundOperationsBridge"), e).available).toBe(true);
    expect(evaluateFeature(feature("nativeTagsBridge"), e)).toMatchObject({
      available: false,
      reason: "shortcut_not_installed",
      missing: [`shortcut:${TAGS}`],
    });
  });

  it("treats a duplicated bridge as not installed", () => {
    const e = env({ shortcutLines: [line(TAGS, 2), line(TAGS, 4)] });
    expect(evaluateFeature(feature("nativeTagsBridge"), e).reason).toBe("shortcut_not_installed");
  });

  it("reports shortcuts_unavailable and leaves bridge presence unverified when the CLI fails", () => {
    const s = evaluateFeature(feature("nativeTagsBridge"), env({ shortcutLines: null }));
    expect(s).toMatchObject({
      available: false,
      reason: "shortcuts_unavailable",
      missing: ["shortcuts_cli"],
    });
    expect(s.unverified).toContain(`shortcut:${TAGS}`);
  });

  it("honors bridge name overrides from the environment", () => {
    vi.stubEnv("APPLE_NOTES_MCP_BACKGROUND_SHORTCUT", "Custom Bridge");
    const without = evaluateFeature(feature("backgroundOperationsBridge"), env());
    expect(without.reason).toBe("shortcut_not_installed");
    expect(without.requirements).toContain("shortcut:Custom Bridge");
    const withIt = evaluateFeature(
      feature("backgroundOperationsBridge"),
      env({ shortcutLines: [line("Custom Bridge", 5)] })
    );
    expect(withIt.available).toBe(true);
  });

  it("puts the platform first, then not_implemented, then OS, then requirements", () => {
    const linux = env({ platform: "linux", macOSVersion: null, fullDiskAccess: false });
    for (const f of FEATURES)
      expect(evaluateFeature(f, linux)).toMatchObject({
        available: false,
        osSupported: false,
        reason: "unsupported_platform",
      });
    // OS floor beats a missing requirement.
    expect(
      evaluateFeature(
        feature("markdownNoteBridge"),
        env({ macOSVersion: "14.0", fullDiskAccess: false, shortcutLines: [] })
      ).reason
    ).toBe("requires_macos_26");
    // FDA beats a missing Shortcut.
    expect(
      evaluateFeature(
        feature("nativeTagsBridge"),
        env({ fullDiskAccess: false, shortcutLines: [] })
      ).reason
    ).toBe("full_disk_access_missing");
  });
});

describe("compareVersions", () => {
  it("compares numerically, padding missing segments", () => {
    expect(compareVersions("26.0", "26")).toBe(0);
    expect(compareVersions("15.10", "15.9")).toBeGreaterThan(0);
    expect(compareVersions("12.0", "26.0")).toBeLessThan(0);
    expect(compareVersions("27.2", "26.0")).toBeGreaterThan(0);
  });
});

describe("probeCapabilityEnvironment", () => {
  it("probes sw_vers, Full Disk Access, and one shortcuts list without touching Notes", () => {
    if (process.platform !== "darwin")
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mockExec.mockImplementation(((cmd: string) => {
      if (cmd === "/usr/bin/sw_vers") return "26.1\n";
      if (cmd === "/usr/bin/shortcuts") return `${line(BG, 1)}\n${line(TAGS, 2)}\n`;
      throw new Error(`unexpected ${cmd}`);
    }) as unknown as typeof execFileSync);
    const e = probeCapabilityEnvironment();
    expect(e).toMatchObject({ platform: "darwin", macOSVersion: "26.1", fullDiskAccess: true });
    expect(e.shortcutLines).toContain(line(TAGS, 2));
    const commands = mockExec.mock.calls.map((c) => [c[0], c[1]]);
    expect(commands).toEqual([
      ["/usr/bin/shortcuts", ["list", "--show-identifiers"]],
      ["/usr/bin/sw_vers", ["-productVersion"]],
    ]);
    // Never osascript, open, or `shortcuts run`.
    expect(JSON.stringify(commands)).not.toMatch(/osascript|"run"|\/open/);
    vi.restoreAllMocks();
  });

  it("degrades to null when sw_vers or shortcuts fail", () => {
    if (process.platform !== "darwin")
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mockExec.mockImplementation(() => {
      throw new Error("boom");
    });
    vi.mocked(hasFullDiskAccess).mockReturnValueOnce(false);
    const e = probeCapabilityEnvironment();
    expect(e).toMatchObject({ macOSVersion: null, shortcutLines: null, fullDiskAccess: false });
    vi.restoreAllMocks();
  });

  it("skips every macOS probe off macOS", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const e = probeCapabilityEnvironment();
    expect(e).toMatchObject({
      platform: "linux",
      macOSVersion: null,
      shortcutLines: null,
      fullDiskAccess: false,
    });
    expect(mockExec).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("rejects non-version sw_vers output", () => {
    if (process.platform !== "darwin")
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mockExec.mockReturnValueOnce("garbage" as unknown as ReturnType<typeof execFileSync>);
    expect(readMacOSVersion()).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("getCapabilityMatrix / formatCapabilityMatrix", () => {
  it("evaluates an injected probe and renders one line per feature", () => {
    const m = getCapabilityMatrix(() => env({ fullDiskAccess: false }));
    const text = formatCapabilityMatrix(m);
    expect(text).toMatch(/^Feature matrix \(macOS 26\.1, Darwin 25\.1\.0\):/);
    expect(text).toMatch(/✗ fullDiskAccessReads: full_disk_access_missing/);
    expect(text).toMatch(/✗ smartFolders: not_implemented/);
    expect(text.split("\n")).toHaveLength(FEATURES.length + 1);
  });
});
