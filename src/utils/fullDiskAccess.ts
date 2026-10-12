/**
 * Full Disk Access guidance shared by tools and setup diagnostics.
 * Pure message formatting: no filesystem access, process inspection, or prompts.
 * Read the runtime environment on each call so brokered children name their app.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";

/**
 * Say which identity needs the Full Disk Access grant (#220). macOS checks FDA
 * against the *responsible process*. A terminal passes its own responsibility to
 * its children, so granting Terminal/iTerm2 is enough there. Claude Desktop
 * launches MCP servers through a helper that disclaims responsibility, which
 * makes the Node binary itself the responsible process: a grant on Claude.app
 * never reaches it, and the Node binary needs its own entry.
 */
export function fdaRemediation(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): string {
  // Under the permission broker (#220) the grant belongs to the broker app.
  if (env.APPLE_NOTES_MCP_BROKERED === "1")
    return (
      "This server runs under the permission broker, so the grant belongs to the broker app, not to Node or the MCP host. " +
      "In System Settings > Privacy & Security > Full Disk Access, click + and add " +
      `${env.APPLE_NOTES_MCP_BROKER_APP || join(homedir(), "Applications", "Apple Notes MCP Broker.app")} (press Cmd+Shift+G in the file picker to paste the path), ` +
      `turn it on, and re-run doctor. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`
    );
  const versioned =
    /\/(\.nvm|\.fnm|\.volta|\.asdf|\.local\/share\/mise|\.nodenv|n\/versions)\//.test(execPath);
  return (
    "In System Settings > Privacy & Security > Full Disk Access, click + and add the Node binary " +
    `running this server: ${execPath} (press Cmd+Shift+G in the file picker to paste the path). ` +
    "Under Claude Desktop that entry is required: Claude Desktop launches servers as their own " +
    "responsible process, so a grant on Claude.app does not reach them. When the server runs from " +
    "a terminal (Terminal, iTerm2) or an editor, granting that app is enough. Then fully quit (Cmd+Q) " +
    "and relaunch the host app and re-run doctor; if it still reports not granted, restart the Mac. " +
    (versioned
      ? "This Node lives under a version manager, so the path changes with each Node version and the " +
        "grant has to be added again after switching; pointing the MCP config at one fixed Node path avoids that. "
      : "") +
    `Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`
  );
}
