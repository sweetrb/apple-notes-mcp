/**
 * Guided permissions check for setup: `apple-notes-mcp setup --permissions`.
 *
 * One report covers the four grants that decide what the server can do on this
 * Mac, each probed the same way `doctor` and `get-capabilities` probe it:
 *
 * - Full Disk Access: one read-only `SELECT 1` against NoteStore.sqlite.
 * - Automation of Notes.app: one read-only Apple event (the name of the first
 *   account). The first time, macOS shows its "wants to control Notes" prompt;
 *   that prompt is the only way to grant Automation, since the Automation pane
 *   has no + button.
 * - Shortcut bridges: `shortcuts list`, as `apple-notes-mcp setup --check` does.
 * - Speech Recognition: the public native helper's `speech_status` action,
 *   which reads the status without prompting.
 *
 * macOS attributes every one of these grants to the app that launched the
 * process (Terminal, iTerm2, Claude Desktop's Node, ...), so the report names
 * that app. For each missing grant it names the exact System Settings pane and
 * its `x-apple.systempreferences:` URL, and opens the pane only when asked.
 * Nothing here changes a setting or a grant.
 *
 * @module services/permissions
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { hasFullDiskAccess } from "@/utils/checklistParser.js";
import { executeAppleScript, isPermissionDenied } from "@/utils/applescript.js";
import { fdaRemediation } from "@/tools/doctor.js";
import { setupShortcuts, type ShortcutSetupReport } from "@/setupShortcuts.js";
import { compareVersions, readMacOSVersion } from "@/services/capabilityMatrix.js";
import {
  callPublicHelper,
  inspectPublicHelper,
  PUBLIC_HELPER_SETUP_COMMAND,
} from "@/services/publicHelper.js";

export type PermissionId =
  "fullDiskAccess" | "notesAutomation" | "shortcutBridges" | "speechRecognition";

/**
 * - `granted`: the probe confirmed it.
 * - `missing`: the probe confirmed it is not granted or not installed.
 * - `not_needed`: not granted, but nothing on this macOS version needs it.
 * - `unknown`: the probe could not decide (the reason is in `detail`).
 */
export type PermissionStatus = "granted" | "missing" | "not_needed" | "unknown";

export type SettingsPane = "fullDiskAccess" | "automation" | "speechRecognition";

export interface PermissionItem {
  id: PermissionId;
  title: string;
  status: PermissionStatus;
  /** Required items decide `ready`; optional ones only unlock some tools. */
  required: boolean;
  detail: string;
  /** Human path to the pane, e.g. "System Settings > Privacy & Security > Full Disk Access". */
  settingsPane: string | null;
  settingsUrl: string | null;
  /** What to do when the status is not granted. */
  fix: string | null;
}

export interface PermissionsReport {
  /** True when every required item is granted. */
  ready: boolean;
  /** The .app macOS attributes these grants to, when one was found above this process. */
  launchingApp: string | null;
  /** The Node binary running this check. */
  execPath: string;
  macOSVersion: string | null;
  items: PermissionItem[];
}

/** Everything that touches the machine, injectable for tests. */
export interface PermissionProbes {
  fullDiskAccess: () => boolean;
  /** Result of one read-only Apple event to Notes.app. */
  notesAutomation: () => { success: boolean; error?: string };
  shortcuts: () => ShortcutSetupReport;
  /** The public helper's `speech_status`, or a reason it could not be asked. */
  speech: () =>
    | { ok: true; speechAuthorization: string; requiresGrant: boolean }
    | { ok: false; reason: string };
  macOSVersion: () => string | null;
  launchingApp: () => string | null;
  execPath: string;
}

const PRIVACY = "System Settings > Privacy & Security";

/** Anchors in the Privacy & Security pane, by the settings pane they open. */
const PANE_ANCHORS: Record<SettingsPane, { anchor: string; label: string }> = {
  fullDiskAccess: { anchor: "Privacy_AllFiles", label: "Full Disk Access" },
  automation: { anchor: "Privacy_Automation", label: "Automation" },
  speechRecognition: { anchor: "Privacy_SpeechRecognition", label: "Speech Recognition" },
};

/**
 * The `x-apple.systempreferences:` URL of one Privacy & Security pane. Apple's
 * EndpointSecurity header (ESClient.h) documents both forms for Full Disk
 * Access: `com.apple.settings.PrivacySecurity.extension` on macOS 13 and
 * later, `com.apple.preference.security` until macOS 12. The other anchors
 * follow the same naming.
 */
export function settingsUrl(pane: SettingsPane, macOSVersion: string | null): string {
  const legacy = macOSVersion !== null && compareVersions(macOSVersion, "13.0") < 0;
  const base = legacy
    ? "x-apple.systempreferences:com.apple.preference.security"
    : "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";
  return `${base}?${PANE_ANCHORS[pane].anchor}`;
}

function paneFields(pane: SettingsPane, macOSVersion: string | null) {
  return {
    settingsPane: `${PRIVACY} > ${PANE_ANCHORS[pane].label}`,
    settingsUrl: settingsUrl(pane, macOSVersion),
  };
}

/** Run every probe once and build the report. A probe that throws reports `unknown`. */
export function checkPermissions(
  probes: PermissionProbes = defaultPermissionProbes()
): PermissionsReport {
  const macOSVersion = safe(probes.macOSVersion, null);
  const launchingApp = safe(probes.launchingApp, null);
  const who = launchingApp ?? "the app that launches the server";
  const items = [
    fullDiskAccessItem(probes, macOSVersion),
    automationItem(probes, macOSVersion, who),
    shortcutsItem(probes),
    speechItem(probes, macOSVersion, who),
  ];
  return {
    ready: items.every((item) => !item.required || item.status === "granted"),
    launchingApp,
    execPath: probes.execPath,
    macOSVersion,
    items,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fullDiskAccessItem(probes: PermissionProbes, macOSVersion: string | null): PermissionItem {
  const base = {
    id: "fullDiskAccess" as const,
    title: "Full Disk Access",
    required: true,
    ...paneFields("fullDiskAccess", macOSVersion),
  };
  let granted: boolean;
  try {
    granted = probes.fullDiskAccess();
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      detail: `could not probe the Notes database: ${errorText(error)}`,
      fix: fdaRemediation(probes.execPath),
    };
  }
  return granted
    ? {
        ...base,
        status: "granted",
        detail: "the Notes database (NoteStore.sqlite) is readable",
        fix: null,
      }
    : {
        ...base,
        status: "missing",
        detail:
          "the Notes database is not readable, so query-notes, checklist state, note metadata, " +
          "note links, native objects, exports and the bridges' readback do not work",
        fix: fdaRemediation(probes.execPath),
      };
}

function automationItem(
  probes: PermissionProbes,
  macOSVersion: string | null,
  who: string
): PermissionItem {
  const base = {
    id: "notesAutomation" as const,
    title: "Automation of Notes.app",
    required: true,
    ...paneFields("automation", macOSVersion),
  };
  let result: { success: boolean; error?: string };
  try {
    result = probes.notesAutomation();
  } catch (error) {
    result = { success: false, error: errorText(error) };
  }
  if (result.success)
    return {
      ...base,
      status: "granted",
      detail: "Notes.app answered a read-only Apple event",
      fix: null,
    };
  if (isPermissionDenied(result.error))
    return {
      ...base,
      status: "missing",
      detail: "macOS refused the Apple event to Notes.app (Automation denied)",
      fix:
        `In ${PRIVACY} > Automation, expand ${who} and turn on Notes. ` +
        "Then fully quit (Cmd+Q) and relaunch that app. If Notes is not listed, run this check " +
        "again and choose Allow when macOS asks to control Notes.",
    };
  return {
    ...base,
    status: "unknown",
    detail: `Notes.app did not answer: ${result.error || "no response"}`,
    fix:
      "Open Notes.app once, then run this check again. If macOS asks whether this app may " +
      "control Notes, choose Allow.",
  };
}

function shortcutsItem(probes: PermissionProbes): PermissionItem {
  const base = {
    id: "shortcutBridges" as const,
    title: "Shortcut bridges",
    required: false,
    settingsPane: null,
    settingsUrl: null,
  };
  let report: ShortcutSetupReport;
  try {
    report = probes.shortcuts();
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      detail: `could not run the shortcuts command: ${errorText(error)}`,
      fix: "Run `apple-notes-mcp setup --check`.",
    };
  }
  const required = report.items.filter((item) => !item.optional);
  const failed = required.filter((item) => item.error && !item.installed);
  const missing = required.filter((item) => !item.installed);
  // Readiness is separate from consent (#172): nothing can detect whether
  // each bridge was run once in the foreground and allowed.
  const consent =
    "After install or upgrade, run each bridge once in Shortcuts.app and choose Always Allow.";
  if (missing.length === 0)
    return {
      ...base,
      status: "granted",
      detail: `both required bridges are installed (${required.map((item) => item.name).join(", ")}). ${consent}`,
      fix: null,
    };
  if (failed.length === missing.length && failed.length > 0)
    return {
      ...base,
      status: "unknown",
      detail: `could not inspect: ${failed.map((item) => `${item.name}: ${item.error}`).join("; ")}`,
      fix: "Run `apple-notes-mcp setup --check`.",
    };
  return {
    ...base,
    status: "missing",
    detail:
      `not installed: ${missing.map((item) => item.name).join(", ")}. The native-write tools ` +
      "(append-native, checklists, tables, native tags, pinning, note links) need them; " +
      "everything else works without them",
    fix: `Run \`apple-notes-mcp setup\` and approve Add Shortcut in macOS. ${consent}`,
  };
}

function speechItem(
  probes: PermissionProbes,
  macOSVersion: string | null,
  who: string
): PermissionItem {
  const base = {
    id: "speechRecognition" as const,
    title: "Speech Recognition",
    required: false,
    ...paneFields("speechRecognition", macOSVersion),
  };
  let answer: ReturnType<PermissionProbes["speech"]>;
  try {
    answer = probes.speech();
  } catch (error) {
    answer = { ok: false, reason: errorText(error) };
  }
  if (!answer.ok)
    return {
      ...base,
      status: "unknown",
      detail: `only transcribe-note-audio needs this; could not read the status: ${answer.reason}`,
      fix: `Build the public native helper with \`${PUBLIC_HELPER_SETUP_COMMAND}\`, then run this check again.`,
    };
  const state = answer.speechAuthorization;
  if (state === "authorized")
    return {
      ...base,
      status: "granted",
      detail: "transcribe-note-audio can use on-device speech recognition",
      fix: null,
    };
  if (state === "restricted")
    return {
      ...base,
      status: "missing",
      detail: "Speech Recognition is restricted on this Mac (for example by a management profile)",
      fix: "Ask the Mac's administrator; the restriction cannot be lifted in System Settings.",
    };
  if (state === "denied")
    return {
      ...base,
      status: "missing",
      detail:
        "Speech Recognition was denied, so transcribe-note-audio stops with permission_required",
      fix: `In ${PRIVACY} > Speech Recognition, turn on ${who}, then relaunch it.`,
    };
  if (!answer.requiresGrant)
    return {
      ...base,
      status: "not_needed",
      detail:
        "not granted, and not needed: on macOS 26 and later transcription runs on-device " +
        "without a Speech Recognition grant",
      fix: null,
    };
  return {
    ...base,
    status: "missing",
    detail:
      `status ${state}. Before macOS 26, transcription needs this grant, and the server ` +
      "never shows the permission prompt",
    fix: `In ${PRIVACY} > Speech Recognition, turn on ${who} if it is listed, then relaunch it.`,
  };
}

// -----------------------------------------------------------------------------
// Default probes
// -----------------------------------------------------------------------------

/**
 * Walk up the process tree to the nearest ancestor inside an `.app` bundle.
 * macOS attributes TCC grants to that app when it launched this process
 * (a terminal, an editor). Returns null when there is none, for example under
 * Claude Desktop, where the Node binary is its own responsible process.
 */
export function findLaunchingApp(
  startPid: number = process.ppid,
  readProcess: (pid: number) => { ppid: number; command: string } | null = readProcessEntry
): string | null {
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const entry = readProcess(pid);
    if (!entry) return null;
    const match = /^(.*?\.app)\//.exec(entry.command);
    if (match) return match[1];
    pid = entry.ppid;
  }
  return null;
}

function readProcessEntry(pid: number): { ppid: number; command: string } | null {
  const result = spawnSync("/bin/ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 3000,
  });
  const match = /^\s*(\d+)\s+(.+)$/.exec(String(result.stdout ?? "").trim());
  return match ? { ppid: Number(match[1]), command: match[2] } : null;
}

/** Automation can wait on the user's answer to macOS's prompt, so allow a minute. */
const AUTOMATION_TIMEOUT_MS = 60_000;

export function defaultPermissionProbes(): PermissionProbes {
  return {
    fullDiskAccess: hasFullDiskAccess,
    notesAutomation: () => {
      const result = executeAppleScript('tell application "Notes" to get name of account 1', {
        timeoutMs: AUTOMATION_TIMEOUT_MS,
        maxRetries: 1,
      });
      return { success: result.success, error: result.error };
    },
    shortcuts: () => setupShortcuts(true),
    speech: () => {
      const install = inspectPublicHelper();
      if (!install.ready)
        return { ok: false, reason: install.detail ?? "the public native helper is not built" };
      const answer = callPublicHelper("speech_status");
      return {
        ok: true,
        speechAuthorization: String(answer.speechAuthorization ?? "unknown"),
        requiresGrant: answer.requiresGrant !== false,
      };
    },
    macOSVersion: readMacOSVersion,
    launchingApp: () => findLaunchingApp(),
    execPath: process.execPath,
  };
}

// -----------------------------------------------------------------------------
// Opening panes
// -----------------------------------------------------------------------------

/**
 * Open one item's System Settings pane. Only URLs from {@link settingsUrl}
 * are opened, and only for an item that has a pane. Opening a pane changes
 * nothing; the user makes any change there.
 */
export function openSettingsPane(
  item: PermissionItem,
  open: (url: string) => { ok: boolean; error?: string } = openUrl
): { ok: boolean; error?: string } {
  if (!item.settingsUrl || !item.settingsUrl.startsWith("x-apple.systempreferences:"))
    return { ok: false, error: `${item.title} has no System Settings pane` };
  return open(item.settingsUrl);
}

function openUrl(url: string): { ok: boolean; error?: string } {
  const result = spawnSync("/usr/bin/open", [url], { encoding: "utf8" });
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: result.stderr || result.error?.message || "open failed" };
}

/** Items that still need the user's attention. */
export function pendingItems(report: PermissionsReport): PermissionItem[] {
  return report.items.filter((item) => item.status === "missing" || item.status === "unknown");
}

// -----------------------------------------------------------------------------
// Terminal output and the interactive loop
// -----------------------------------------------------------------------------

const ICONS: Record<PermissionStatus, string> = {
  granted: "✓",
  not_needed: "✓",
  missing: "✗",
  unknown: "?",
};

/** Render the report for the terminal. */
export function formatPermissionsReport(report: PermissionsReport): string {
  const lines = ["Apple Notes MCP permissions", ""];
  lines.push(
    report.launchingApp
      ? `macOS attributes these grants to ${report.launchingApp}, the app that launched this check.`
      : `No launching app was found above this process, so macOS attributes these grants to ${report.execPath}.`
  );
  lines.push(
    "An MCP host (Claude Desktop, an editor) can hold different grants: run this check from the " +
      "same app, or use the doctor tool there.",
    ""
  );
  for (const item of report.items) {
    const tag = item.required ? "" : " (optional)";
    lines.push(`${ICONS[item.status]} ${item.title}${tag}: ${item.detail}`);
    if (item.status === "missing" || item.status === "unknown") {
      if (item.settingsPane) lines.push(`    Pane: ${item.settingsPane}`);
      if (item.settingsUrl) lines.push(`    URL:  ${item.settingsUrl}`);
      if (item.fix) lines.push(`    Fix:  ${item.fix}`);
    }
  }
  lines.push("");
  lines.push(
    report.ready
      ? "Every required permission is granted."
      : "Required permissions are missing; the server works only partly until they are granted."
  );
  return lines.join("\n");
}

export interface PermissionsCliOptions {
  /** Open the pane of every pending item that has one. */
  open: boolean;
  /** Print once and exit, even on a terminal. */
  once: boolean;
  /** Print JSON instead of text. */
  json: boolean;
}

export function parsePermissionsArgs(args: readonly string[]): PermissionsCliOptions {
  return {
    open: args.includes("--open"),
    once: args.includes("--once") || args.includes("--check"),
    json: args.includes("--json"),
  };
}

export interface PermissionsCliDeps {
  check: () => PermissionsReport;
  open: (item: PermissionItem) => { ok: boolean; error?: string };
  write: (text: string) => void;
  /** Resolves when the user presses Enter; null at end of input. */
  waitForEnter: () => Promise<string | null>;
  interactive: boolean;
}

/**
 * The `setup --permissions` loop: check, print, optionally open panes, and on a
 * terminal wait for Enter and check again until every item is settled or the
 * user quits. Returns the process exit code: 0 when required grants are in place.
 */
export async function runPermissionsCli(
  options: PermissionsCliOptions,
  deps: PermissionsCliDeps
): Promise<number> {
  const opened = new Set<PermissionId>();
  for (;;) {
    const report = deps.check();
    deps.write(
      options.json ? JSON.stringify(report, null, 2) + "\n" : formatPermissionsReport(report) + "\n"
    );
    const pending = pendingItems(report);
    if (options.open) {
      // Each pane opens once per run, not again on every re-check.
      for (const item of pending) {
        if (!item.settingsUrl || opened.has(item.id)) continue;
        opened.add(item.id);
        const result = deps.open(item);
        if (!options.json)
          deps.write(
            result.ok
              ? `Opened ${item.settingsPane}.\n`
              : `Could not open ${item.settingsPane}: ${result.error}\n`
          );
      }
    }
    if (pending.length === 0 || options.once || !deps.interactive) return report.ready ? 0 : 1;
    deps.write("\nPress Enter to check again, or type q and press Enter to quit. ");
    const line = await deps.waitForEnter();
    if (line === null || line.trim().toLowerCase() === "q") return report.ready ? 0 : 1;
    deps.write("\n");
  }
}

/** Default CLI dependencies: real probes, stdout, and stdin lines. */
export function defaultPermissionsCliDeps(): PermissionsCliDeps & { close: () => void } {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin }) : null;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl?.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl?.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  return {
    check: () => checkPermissions(),
    open: (item) => openSettingsPane(item),
    write: (text) => process.stdout.write(text),
    waitForEnter: () =>
      new Promise((resolveLine) => {
        if (lines.length) resolveLine(lines.shift()!);
        else if (closed || !rl) resolveLine(null);
        else waiters.push(resolveLine);
      }),
    interactive,
    close: () => rl?.close(),
  };
}
