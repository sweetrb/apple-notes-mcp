import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TAGS_SHORTCUT, nativeTagsStatus } from "./services/nativeTags.js";
import { BACKGROUND_SHORTCUT, MARKDOWN_NOTE_SHORTCUT } from "./services/backgroundNotes.js";

export interface ShortcutSetupItem {
  name: string;
  installed: boolean;
  identifier?: string;
  file: string;
  opened: boolean;
  /** Not needed for readiness; see OPTIONAL_BRIDGE_NOTE. */
  optional?: boolean;
  /** Why setup did not open a missing optional bridge. */
  skipped?: string;
  error?: string;
}

export interface ShortcutSetupReport {
  ready: boolean;
  checkOnly: boolean;
  items: ShortcutSetupItem[];
}

interface SetupDependencies {
  status?: typeof nativeTagsStatus;
  exists?: typeof existsSync;
  open?: (path: string) => { ok: boolean; error?: string };
  baseDirectory?: string;
  /** Darwin kernel release, as `os.release()` reports it. */
  osRelease?: () => string;
}

/** Shown beside the Create Markdown Note bridge, which readiness never depends on. */
export const OPTIONAL_BRIDGE_NOTE =
  "(optional — needed only for create-note format: markdown, macOS 26+)";

/** Darwin 25 is macOS 26, the first release whose Create Note action interprets Markdown. */
const MARKDOWN_MIN_DARWIN_MAJOR = 25;

const shortcutFiles = [
  { name: NATIVE_TAGS_SHORTCUT, file: "Apple Notes MCP - Native Tags.shortcut" },
  {
    name: BACKGROUND_SHORTCUT,
    file: "Apple Notes MCP - Background Operations v5.shortcut",
  },
  {
    name: MARKDOWN_NOTE_SHORTCUT,
    file: "Apple Notes MCP - Create Markdown Note.shortcut",
    optional: true,
  },
];

/** Check packaged bridge workflows and explicitly open only missing ones. */
export function setupShortcuts(
  checkOnly: boolean,
  dependencies: SetupDependencies = {}
): ShortcutSetupReport {
  const status = dependencies.status || nativeTagsStatus;
  const exists = dependencies.exists || existsSync;
  const open =
    dependencies.open ||
    ((path: string) => {
      const result = spawnSync("/usr/bin/open", [path], { encoding: "utf8" });
      return result.status === 0
        ? { ok: true }
        : { ok: false, error: result.stderr || result.error?.message || "open failed" };
    });
  const baseDirectory =
    dependencies.baseDirectory || resolve(dirname(fileURLToPath(import.meta.url)), "../shortcuts");
  const osRelease = (dependencies.osRelease || release)();
  const darwinMajor = Number.parseInt(osRelease.split(".")[0], 10);

  const items = shortcutFiles.map(({ name, file, optional }) => {
    const path = resolve(baseDirectory, file);
    let installed = false;
    let identifier: string | undefined;
    let error: string | undefined;
    try {
      const current = status(name);
      installed = current.installed;
      identifier = current.identifier;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    let opened = false;
    let skipped: string | undefined;
    if (!installed && !checkOnly) {
      // Before macOS 26 Notes cannot interpret Markdown, so the optional bridge
      // could never run; don't open an Add Shortcut dialog for it.
      if (optional && !(darwinMajor >= MARKDOWN_MIN_DARWIN_MAJOR))
        skipped = `requires macOS 26 or later (this Mac reports Darwin ${osRelease})`;
      else if (!exists(path)) error = `Packaged Shortcut is missing: ${path}`;
      else {
        const result = open(path);
        opened = result.ok;
        if (!result.ok) error = result.error || `Could not open ${file}`;
      }
    }
    return {
      name,
      installed,
      identifier,
      file: path,
      opened,
      ...(optional ? { optional } : {}),
      ...(skipped ? { skipped } : {}),
      ...(error ? { error } : {}),
    };
  });
  // Readiness is the two required bridges only (#172 review): the Markdown
  // bridge serves one optional create-note format and cannot install before macOS 26.
  return { ready: items.every((item) => item.optional || item.installed), checkOnly, items };
}

/** Render a concise terminal summary for Shortcut setup or check-only mode. */
export function formatShortcutSetup(report: ShortcutSetupReport): string {
  const lines = ["Apple Notes MCP Shortcut setup", ""];
  for (const item of report.items) {
    const note = item.optional ? ` ${OPTIONAL_BRIDGE_NOTE}` : "";
    if (item.installed) lines.push(`✓ ${item.name} (${item.identifier})${note}`);
    else if (item.opened) lines.push(`→ ${item.name}: confirm “Add Shortcut” in macOS${note}`);
    else if (item.skipped) lines.push(`– ${item.name}: skipped, ${item.skipped}${note}`);
    else lines.push(`✗ ${item.name}: ${item.error || "not installed"}${note}`);
  }
  lines.push("");
  if (report.ready) lines.push("Both required Shortcut bridges are installed.");
  else if (report.checkOnly) lines.push("Run `apple-notes-mcp setup` to open missing workflows.");
  else
    lines.push(
      "After approving the macOS dialogs, run `apple-notes-mcp setup --check` or the MCP doctor tool."
    );
  // Installed is not consented (#172): the server's background runs cannot
  // display Shortcuts' first-run consent prompt, and nothing can detect it.
  lines.push(
    "After install or upgrade, run each bridge once in the foreground in Shortcuts.app and choose Always Allow; a background run cannot display a first-run consent prompt and stalls until it times out."
  );
  return lines.join("\n");
}
