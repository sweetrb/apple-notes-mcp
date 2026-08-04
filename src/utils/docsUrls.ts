/**
 * Absolute URLs for the project's setup guides.
 *
 * Error messages embed these instead of repo-relative paths (e.g.
 * "docs/FULL-DISK-ACCESS.md") because most users run the server from an npm
 * install or a marketplace plugin checkout and have no repo tree in front of
 * them — a relative path is a dead end, an absolute URL is clickable anywhere.
 */

export const FULL_DISK_ACCESS_GUIDE_URL =
  "https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md";

export const NODE_RUNTIME_TCC_GUIDE_URL =
  "https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md";

/** README troubleshooting section for a denied Automation (Apple Events) grant. */
export const AUTOMATION_PERMISSION_GUIDE_URL =
  "https://github.com/sweetrb/apple-notes-mcp#permission-denied";

/**
 * Shared remediation suffix for Automation-permission failures.
 *
 * Kept in one place so the executor's generic error mapping and the
 * health-check permission probe cannot drift apart, and so this failure class
 * ends with the same "docs URL + run the doctor tool" pointer every other
 * setup failure in this server does.
 */
export const AUTOMATION_REMEDIATION =
  "Grant automation access in System Settings > Privacy & Security > Automation " +
  "to the app that launches this server (Claude Desktop / Terminal / iTerm2), then " +
  `fully quit and relaunch it — run the doctor tool to verify. See: ${AUTOMATION_PERMISSION_GUIDE_URL}`;
