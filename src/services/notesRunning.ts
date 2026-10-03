import { execFileSync } from "node:child_process";

/**
 * Whether this user has a Notes.app process. `pgrep` is scoped to the
 * current user, so another logged-in user's Notes.app does not count, and
 * only its "no match" exit (1) means not running: any other failure throws
 * rather than reading as "quit".
 */
export function notesRunningForThisUser(
  run: typeof execFileSync = execFileSync,
  uid: number = process.getuid?.() ?? -1
): boolean {
  if (uid < 0)
    throw new Error("Cannot tell whose Notes.app is running: no user id on this platform");
  try {
    run("/usr/bin/pgrep", ["-x", "-u", String(uid), "Notes"], {
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if ((error as { status?: number | null }).status === 1) return false;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not check whether Notes.app is running (pgrep: ${reason})`, {
      cause: error,
    });
  }
}
