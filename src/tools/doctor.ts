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

  // 3. Full Disk Access — required for checklist state + checklist annotations.
  const fda = hasFullDiskAccess();
  checks.push({
    name: "Full Disk Access",
    status: fda ? "ok" : "warn",
    detail: fda
      ? "granted — checklist features available"
      : "not granted — get-checklist-state and checklist annotations in get-note-markdown won't work. Grant in System Settings > Privacy & Security > Full Disk Access.",
  });

  // 4. Node runtime code signature. An ad-hoc signed Node (typically Homebrew's)
  // gets a new cdhash on every update, so macOS TCC treats it as a brand-new
  // binary and silently drops its Automation / Full Disk Access grants — the
  // most common cause of "this worked last week" permission flakiness.
  checks.push(checkNodeRuntimeSignature());

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
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
          `at a stable path — see docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md.`,
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
