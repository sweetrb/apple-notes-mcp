/**
 * Absolute paths for the system tools this server runs.
 *
 * Every child process is spawned by absolute path, never by bare name, so a
 * directory placed early in the server's `PATH` cannot substitute its own
 * `osascript` or `sqlite3`. These all ship with macOS in `/usr/bin`.
 */

/**
 * The `osascript` to run. `APPLE_NOTES_MCP_TEST_OSASCRIPT` replaces it with a
 * fixture in the end-to-end tests that drive the built server; an explicit,
 * named setting, unlike a `PATH` lookup that any writable directory can win.
 */
export function osascriptPath(): string {
  return process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT || "/usr/bin/osascript";
}
