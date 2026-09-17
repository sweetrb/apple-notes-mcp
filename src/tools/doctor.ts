/**
 * Setup "doctor" (#22): one diagnostic covering the things that actually break an
 * apple-notes-mcp setup — Notes.app reachability, Automation permission, account
 * state, Full Disk Access (required for checklist parsing, a common silent
 * failure), and the Node runtime's code signature (an ad-hoc signed Node loses
 * its TCC grants on every update) — each reported as ok / warn / fail with an
 * actionable message.
 *
 * @module tools/doctor
 */
import { spawnSync } from "child_process";
import type { AppleNotesManager } from "@/services/appleNotesManager.js";
import { hasFullDiskAccess } from "@/utils/checklistParser.js";
import { FULL_DISK_ACCESS_GUIDE_URL, NODE_RUNTIME_TCC_GUIDE_URL } from "@/utils/docsUrls.js";
import { NATIVE_TAGS_SHORTCUT, nativeTagsStatus } from "@/services/nativeTags.js";
import { BACKGROUND_SHORTCUT, MARKDOWN_NOTE_SHORTCUT } from "@/services/backgroundNotes.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export function runDoctor(manager: AppleNotesManager): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Notes.app reachability + Automation permission (existing health checks).
  const hc = manager.healthCheck();
  for (const c of hc.checks) {
    checks.push({
      name: `Notes.app: ${c.name}`,
      status: c.passed ? "ok" : "fail",
      detail: c.message,
    });
  }

  // 2. Accounts.
  try {
    const accounts = manager.listAccounts();
    checks.push({
      name: "Accounts",
      status: accounts.length > 0 ? "ok" : "warn",
      detail:
        accounts.length > 0
          ? `${accounts.length} account(s): ${accounts.map((a) => a.name).join(", ")}`
          : "no Notes accounts found",
    });
  } catch (e) {
    checks.push({
      name: "Accounts",
      status: "fail",
      detail: `could not list accounts: ${String(e)}`,
    });
  }

  // 3. Full Disk Access — required by every tool that reads NoteStore.sqlite:
  // get-checklist-state, get-note-markdown's checklist annotations,
  // get-note-metadata, get-note-link's primary path, and get-sync-status'
  // database half. Enumerate them so a user who doesn't use checklists doesn't
  // read the warning as irrelevant and skip the grant.
  const fda = hasFullDiskAccess();
  checks.push({
    name: "Full Disk Access",
    status: fda ? "ok" : "warn",
    detail: fda
      ? "granted — the Notes database is readable (checklist state, note metadata, note links, sync detail)"
      : "not granted — get-checklist-state, get-note-metadata, and the checklist annotations in " +
        "get-note-markdown won't work; get-note-link fails on macOS 26+ (macOS 12-15 falls back to " +
        "AppleScript); get-sync-status still answers but cannot see pending uploads. Everything else " +
        "is pure AppleScript and is unaffected. " +
        "In System Settings > Privacy & Security > Full Disk Access, grant access to the app that " +
        "launches this server (Claude Desktop / Terminal / iTerm2), then fully quit and relaunch it " +
        `and re-run doctor. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`,
  });

  // 4. Optional native-write bridges. Installation is explicit because macOS
  // requires the user to approve every imported Shortcut. Installed is not the
  // same as consented: a background run cannot display Shortcuts' first-run
  // consent prompt, and the `shortcuts` CLI exposes no consent or run history to
  // check, so the reminder is unconditional rather than a detected state (#172).
  const consentReminder =
    "After install or upgrade, run each bridge Shortcut once in the foreground in Shortcuts.app " +
    "and choose Always Allow: a background run cannot display a first-run consent prompt, so an " +
    "unanswered one stalls that bridge's native writes until they time out while this check stays ok";
  try {
    const bridgeStatuses = [NATIVE_TAGS_SHORTCUT, BACKGROUND_SHORTCUT].map((name) =>
      nativeTagsStatus(name)
    );
    const missing = bridgeStatuses.filter((status) => !status.installed);
    const markdown = markdownBridgeDetail();
    checks.push({
      name: "Native write Shortcuts",
      status: missing.length ? "warn" : "ok",
      detail: missing.length
        ? `missing: ${missing.map((status) => status.shortcut).join(", ")}. Run apple-notes-mcp setup and approve Add Shortcut in macOS. ${markdown} ${consentReminder}`
        : `both native-write bridges are installed. ${markdown} ${consentReminder}`,
    });
  } catch (error) {
    checks.push({
      name: "Native write Shortcuts",
      status: "warn",
      detail: `could not inspect Shortcuts: ${String(error)}. Run apple-notes-mcp setup --check`,
    });
  }

  // 5. Node runtime code signature. An ad-hoc signed Node (typically Homebrew's)
  // gets a new cdhash on every update, so macOS TCC treats it as a brand-new
  // binary and silently drops its Automation / Full Disk Access grants — the
  // most common cause of "this worked last week" permission flakiness.
  checks.push(checkNodeRuntimeSignature());

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
}

/**
 * Describe the optional Create Markdown Note bridge. It serves only create-note's
 * `format: "markdown"` and cannot run before macOS 26, so it never changes the
 * native-write check's status (#172 review); get-capabilities reports whether
 * `create-note-markdown` is available.
 */
function markdownBridgeDetail(): string {
  const purpose = 'needed only for create-note format: "markdown" on macOS 26+';
  try {
    return nativeTagsStatus(MARKDOWN_NOTE_SHORTCUT).installed
      ? `Optional ${MARKDOWN_NOTE_SHORTCUT} bridge: installed (${purpose}).`
      : `Optional ${MARKDOWN_NOTE_SHORTCUT} bridge: not installed (${purpose}; apple-notes-mcp setup offers it).`;
  } catch (error) {
    return `Optional ${MARKDOWN_NOTE_SHORTCUT} bridge: could not inspect (${purpose}): ${String(error)}.`;
  }
}

/**
 * Inspect the code signature of the Node binary running this server
 * (process.execPath) via `codesign`. Ad-hoc signatures (no Team ID) are the
 * TCC-churn case documented in docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md.
 */
export function checkNodeRuntimeSignature(): DoctorCheck {
  const name = "Node runtime signature";
  try {
    const r = spawnSync("codesign", ["-dvvv", process.execPath], { encoding: "utf8" });
    // codesign writes its details to stderr.
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.error || !out.trim()) {
      return {
        name,
        status: "warn",
        detail: `could not inspect ${process.execPath} with codesign`,
      };
    }
    const adhoc = /^Signature=adhoc$/m.test(out) || /^TeamIdentifier=not set$/m.test(out);
    if (adhoc) {
      return {
        name,
        status: "warn",
        detail:
          `${process.execPath} is ad-hoc signed (no Team ID). macOS revokes its Automation and ` +
          `Full Disk Access grants every time the binary changes (e.g. every brew upgrade), which ` +
          `looks like random permission loss. Fix: run the server with a Developer-ID-signed Node ` +
          `at a stable path — see ${NODE_RUNTIME_TCC_GUIDE_URL}`,
      };
    }
    const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1];
    return {
      name,
      status: "ok",
      detail: `${process.execPath} has a stable signature${team ? ` (Team ID ${team})` : ""} — TCC grants persist across updates`,
    };
  } catch (e) {
    return { name, status: "warn", detail: `could not inspect node signature: ${String(e)}` };
  }
}

/** Render a DoctorReport as readable text. */
export function formatDoctorReport(r: DoctorReport): string {
  const icon = (s: CheckStatus): string => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  const lines = [`🩺 apple-notes-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
  for (const c of r.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
