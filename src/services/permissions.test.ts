import { describe, expect, it, vi } from "vitest";
import {
  checkPermissions,
  findLaunchingApp,
  formatPermissionsReport,
  openSettingsPane,
  parsePermissionsArgs,
  pendingItems,
  runPermissionsCli,
  settingsUrl,
  type PermissionItem,
  type PermissionProbes,
  type PermissionsCliDeps,
  type PermissionsReport,
} from "./permissions.js";
import type { ShortcutSetupReport } from "@/setupShortcuts.js";

const bridges = (installed: boolean, error?: string): ShortcutSetupReport => ({
  ready: installed,
  checkOnly: true,
  items: [
    {
      name: "Apple Notes MCP - Native Tags",
      installed,
      file: "/x/tags.shortcut",
      opened: false,
      ...(error ? { error } : {}),
    },
    {
      name: "Apple Notes MCP - Background Operations v5",
      installed,
      file: "/x/bg.shortcut",
      opened: false,
      ...(error ? { error } : {}),
    },
    {
      name: "Apple Notes MCP - Create Markdown Note",
      installed: false,
      file: "/x/md.shortcut",
      opened: false,
      optional: true,
    },
  ],
});

function probes(over: Partial<PermissionProbes> = {}): PermissionProbes {
  return {
    fullDiskAccess: () => true,
    notesAutomation: () => ({ success: true }),
    shortcuts: () => bridges(true),
    speech: () => ({ ok: true, speechAuthorization: "authorized", requiresGrant: true }),
    macOSVersion: () => "15.5",
    launchingApp: () => "/Applications/Utilities/Terminal.app",
    execPath: "/usr/local/bin/node",
    ...over,
  };
}

const item = (report: PermissionsReport, id: string) =>
  report.items.find((candidate) => candidate.id === id)!;

describe("settingsUrl", () => {
  it("uses the macOS 13+ Privacy & Security extension form", () => {
    expect(settingsUrl("fullDiskAccess", "13.0")).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
    );
    expect(settingsUrl("automation", "27.2")).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation"
    );
    expect(settingsUrl("speechRecognition", "26.0")).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_SpeechRecognition"
    );
  });

  it("uses the legacy preference pane form before macOS 13", () => {
    expect(settingsUrl("fullDiskAccess", "12.7.4")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    );
  });

  it("assumes a current macOS when the version is unknown", () => {
    expect(settingsUrl("automation", null)).toContain("PrivacySecurity.extension");
  });
});

describe("checkPermissions", () => {
  it("reports ready when every probe passes", () => {
    const report = checkPermissions(probes());
    expect(report.ready).toBe(true);
    expect(report.items.map((i) => [i.id, i.status])).toEqual([
      ["fullDiskAccess", "granted"],
      ["notesAutomation", "granted"],
      ["shortcutBridges", "granted"],
      ["speechRecognition", "granted"],
    ]);
    expect(report.launchingApp).toBe("/Applications/Utilities/Terminal.app");
    expect(pendingItems(report)).toEqual([]);
  });

  it("marks missing Full Disk Access with its pane, URL, and the Node path to add", () => {
    const report = checkPermissions(probes({ fullDiskAccess: () => false }));
    const fda = item(report, "fullDiskAccess");
    expect(report.ready).toBe(false);
    expect(fda.status).toBe("missing");
    expect(fda.settingsPane).toBe("System Settings > Privacy & Security > Full Disk Access");
    expect(fda.settingsUrl).toContain("?Privacy_AllFiles");
    expect(fda.fix).toContain("/usr/local/bin/node");
  });

  it("reports a thrown Full Disk Access probe as unknown", () => {
    const report = checkPermissions(
      probes({
        fullDiskAccess: () => {
          throw new Error("sqlite3 missing");
        },
      })
    );
    expect(item(report, "fullDiskAccess").status).toBe("unknown");
    expect(item(report, "fullDiskAccess").detail).toContain("sqlite3 missing");
    expect(report.ready).toBe(false);
  });

  it("classifies a denied Apple event as missing Automation and names the app", () => {
    const report = checkPermissions(
      probes({
        notesAutomation: () => ({
          success: false,
          error: "Not authorized to send Apple events to Notes. (-1743)",
        }),
      })
    );
    const automation = item(report, "notesAutomation");
    expect(automation.status).toBe("missing");
    expect(automation.settingsUrl).toContain("?Privacy_Automation");
    expect(automation.fix).toContain("Terminal.app");
    expect(report.ready).toBe(false);
  });

  it("reports another Notes failure as unknown, not as denied", () => {
    const report = checkPermissions(
      probes({ notesAutomation: () => ({ success: false, error: "timed out" }) })
    );
    expect(item(report, "notesAutomation").status).toBe("unknown");
    expect(item(report, "notesAutomation").detail).toContain("timed out");
  });

  it("names a generic app when no launching app was found", () => {
    const report = checkPermissions(
      probes({
        launchingApp: () => null,
        notesAutomation: () => ({ success: false, error: "execution error: (-1743)" }),
      })
    );
    expect(item(report, "notesAutomation").fix).toContain("the app that launches the server");
    expect(formatPermissionsReport(report)).toContain(
      "attributes these grants to /usr/local/bin/node"
    );
  });

  it("treats the Shortcut bridges as optional and points at setup", () => {
    const report = checkPermissions(probes({ shortcuts: () => bridges(false) }));
    const shortcuts = item(report, "shortcutBridges");
    expect(shortcuts.status).toBe("missing");
    expect(shortcuts.required).toBe(false);
    expect(shortcuts.settingsUrl).toBeNull();
    expect(shortcuts.fix).toContain("apple-notes-mcp setup");
    expect(report.ready).toBe(true);
  });

  it("reports unknown when the shortcuts command fails", () => {
    const report = checkPermissions(
      probes({ shortcuts: () => bridges(false, "shortcuts: command not found") })
    );
    expect(item(report, "shortcutBridges").status).toBe("unknown");
    const thrown = checkPermissions(
      probes({
        shortcuts: () => {
          throw new Error("boom");
        },
      })
    );
    expect(item(thrown, "shortcutBridges").status).toBe("unknown");
  });

  it("maps every Speech Recognition status", () => {
    const speech = (speechAuthorization: string, requiresGrant: boolean) =>
      item(
        checkPermissions(
          probes({ speech: () => ({ ok: true, speechAuthorization, requiresGrant }) })
        ),
        "speechRecognition"
      );
    expect(speech("authorized", true).status).toBe("granted");
    expect(speech("denied", false).status).toBe("missing");
    expect(speech("denied", false).fix).toContain("Terminal.app");
    expect(speech("restricted", false).status).toBe("missing");
    expect(speech("notDetermined", false).status).toBe("not_needed");
    expect(speech("notDetermined", true).status).toBe("missing");
    expect(speech("notDetermined", true).settingsUrl).toContain("?Privacy_SpeechRecognition");
  });

  it("reports Speech as unknown with the helper setup command when the helper is not built", () => {
    const report = checkPermissions(
      probes({ speech: () => ({ ok: false, reason: "The public native helper is not built." }) })
    );
    const speech = item(report, "speechRecognition");
    expect(speech.status).toBe("unknown");
    expect(speech.fix).toContain("setup --public-helper");
    expect(report.ready).toBe(true);
  });

  it("keeps going when the version or launching-app probes throw", () => {
    const report = checkPermissions(
      probes({
        macOSVersion: () => {
          throw new Error("no sw_vers");
        },
        launchingApp: () => {
          throw new Error("no ps");
        },
      })
    );
    expect(report.macOSVersion).toBeNull();
    expect(report.launchingApp).toBeNull();
    expect(report.ready).toBe(true);
  });
});

describe("findLaunchingApp", () => {
  it("returns the nearest ancestor inside an app bundle", () => {
    const table: Record<number, { ppid: number; command: string }> = {
      500: { ppid: 400, command: "/bin/zsh" },
      400: { ppid: 300, command: "/usr/bin/login" },
      300: {
        ppid: 1,
        command: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
      },
    };
    expect(findLaunchingApp(500, (pid) => table[pid] ?? null)).toBe("/Applications/iTerm.app");
  });

  it("returns null when no ancestor is an app", () => {
    const table: Record<number, { ppid: number; command: string }> = {
      20: { ppid: 1, command: "/sbin/launchd" },
    };
    expect(findLaunchingApp(20, (pid) => table[pid] ?? null)).toBeNull();
    expect(findLaunchingApp(20, () => null)).toBeNull();
  });

  it("stops on a cycle", () => {
    expect(findLaunchingApp(7, () => ({ ppid: 7, command: "/bin/sh" }))).toBeNull();
  });
});

describe("openSettingsPane", () => {
  it("opens only the item's System Settings URL", () => {
    const report = checkPermissions(probes({ fullDiskAccess: () => false }));
    const open = vi.fn(() => ({ ok: true }));
    expect(openSettingsPane(item(report, "fullDiskAccess"), open)).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
    );
  });

  it("refuses an item without a pane or with a foreign URL", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = checkPermissions(probes({ shortcuts: () => bridges(false) }));
    expect(openSettingsPane(item(report, "shortcutBridges"), open).ok).toBe(false);
    const forged: PermissionItem = {
      ...item(report, "fullDiskAccess"),
      settingsUrl: "https://example.com",
    };
    expect(openSettingsPane(forged, open).ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("formatPermissionsReport", () => {
  it("prints pane, URL, and fix only for pending items", () => {
    const text = formatPermissionsReport(
      checkPermissions(probes({ fullDiskAccess: () => false, macOSVersion: () => "27.2" }))
    );
    expect(text).toContain("✗ Full Disk Access:");
    expect(text).toContain(
      "URL:  x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
    );
    expect(text).toContain("✓ Automation of Notes.app:");
    expect(text).not.toContain("?Privacy_Automation");
    expect(text).toContain("Required permissions are missing");
  });
});

describe("parsePermissionsArgs", () => {
  it("reads the flags", () => {
    expect(parsePermissionsArgs(["--permissions"])).toEqual({
      open: false,
      once: false,
      json: false,
    });
    expect(parsePermissionsArgs(["--permissions", "--open", "--once", "--json"])).toEqual({
      open: true,
      once: true,
      json: true,
    });
    expect(parsePermissionsArgs(["--permissions", "--check"]).once).toBe(true);
  });
});

describe("runPermissionsCli", () => {
  function cliDeps(
    reports: PermissionsReport[],
    answers: Array<string | null>,
    interactive = true
  ) {
    const output: string[] = [];
    let checks = 0;
    const deps: PermissionsCliDeps = {
      check: vi.fn(() => reports[Math.min(checks++, reports.length - 1)]),
      open: vi.fn(() => ({ ok: true })),
      write: (text) => output.push(text),
      waitForEnter: vi.fn(async () => (answers.length ? answers.shift()! : null)),
      interactive,
    };
    return { deps, output: () => output.join("") };
  }
  const missingFda = checkPermissions(probes({ fullDiskAccess: () => false }));
  const allGood = checkPermissions(probes());

  it("never opens a pane without --open", async () => {
    const { deps } = cliDeps([missingFda], [null]);
    expect(await runPermissionsCli({ open: false, once: false, json: false }, deps)).toBe(1);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("opens each pending pane once and re-checks on Enter until ready", async () => {
    const { deps, output } = cliDeps([missingFda, missingFda, allGood], ["", ""]);
    expect(await runPermissionsCli({ open: true, once: false, json: false }, deps)).toBe(0);
    expect(deps.check).toHaveBeenCalledTimes(3);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(output()).toContain("Opened System Settings > Privacy & Security > Full Disk Access.");
    expect(output()).toContain("Every required permission is granted.");
  });

  it("does not open items without a pane", async () => {
    const noBridges = checkPermissions(probes({ shortcuts: () => bridges(false) }));
    const { deps } = cliDeps([noBridges], []);
    await runPermissionsCli({ open: true, once: true, json: false }, deps);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("stops when the user types q or input ends", async () => {
    const quit = cliDeps([missingFda], ["q"]);
    expect(await runPermissionsCli({ open: false, once: false, json: false }, quit.deps)).toBe(1);
    expect(quit.deps.check).toHaveBeenCalledTimes(1);
    const eof = cliDeps([missingFda], [null]);
    expect(await runPermissionsCli({ open: false, once: false, json: false }, eof.deps)).toBe(1);
  });

  it("prints once without waiting when --once is set or stdin is not a terminal", async () => {
    const once = cliDeps([missingFda], [""]);
    await runPermissionsCli({ open: false, once: true, json: false }, once.deps);
    expect(once.deps.waitForEnter).not.toHaveBeenCalled();
    const piped = cliDeps([missingFda], [""], false);
    await runPermissionsCli({ open: false, once: false, json: false }, piped.deps);
    expect(piped.deps.waitForEnter).not.toHaveBeenCalled();
  });

  it("prints the report as JSON with --json", async () => {
    const { deps, output } = cliDeps([allGood], []);
    expect(await runPermissionsCli({ open: false, once: true, json: true }, deps)).toBe(0);
    const parsed = JSON.parse(output()) as PermissionsReport;
    expect(parsed.ready).toBe(true);
    expect(parsed.items).toHaveLength(4);
  });
});
