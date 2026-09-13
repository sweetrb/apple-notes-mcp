import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TAGS_SHORTCUT, nativeTagsStatus } from "./services/nativeTags.js";
import { BACKGROUND_SHORTCUT } from "./services/backgroundNotes.js";

export interface ShortcutSetupItem {
  name: string;
  installed: boolean;
  identifier?: string;
  file: string;
  opened: boolean;
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
}

const shortcutFiles = [
  { name: NATIVE_TAGS_SHORTCUT, file: "Apple Notes MCP - Native Tags.shortcut" },
  {
    name: BACKGROUND_SHORTCUT,
    file: "Apple Notes MCP - Background Operations v5.shortcut",
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

  const items = shortcutFiles.map(({ name, file }) => {
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
    if (!installed && !checkOnly) {
      if (!exists(path)) error = `Packaged Shortcut is missing: ${path}`;
      else {
        const result = open(path);
        opened = result.ok;
        if (!result.ok) error = result.error || `Could not open ${file}`;
      }
    }
    return { name, installed, identifier, file: path, opened, ...(error ? { error } : {}) };
  });
  return { ready: items.every((item) => item.installed), checkOnly, items };
}

/** Render a concise terminal summary for Shortcut setup or check-only mode. */
export function formatShortcutSetup(report: ShortcutSetupReport): string {
  const lines = ["Apple Notes MCP Shortcut setup", ""];
  for (const item of report.items) {
    if (item.installed) lines.push(`✓ ${item.name} (${item.identifier})`);
    else if (item.opened) lines.push(`→ ${item.name}: confirm “Add Shortcut” in macOS`);
    else lines.push(`✗ ${item.name}: ${item.error || "not installed"}`);
  }
  lines.push("");
  if (report.ready) lines.push("Both Shortcut bridges are installed.");
  else if (report.checkOnly) lines.push("Run `apple-notes-mcp setup` to open missing workflows.");
  else
    lines.push(
      "After approving the macOS dialogs, run `apple-notes-mcp setup --check` or the MCP doctor tool."
    );
  return lines.join("\n");
}
