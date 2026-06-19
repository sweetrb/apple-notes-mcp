/**
 * Setup "doctor" (#22): one diagnostic covering the things that actually break an
 * apple-notes-mcp setup — Notes.app reachability, Automation permission, account
 * state, and Full Disk Access (required for checklist parsing, a common silent
 * failure) — each reported as ok / warn / fail with an actionable message.
 *
 * @module tools/doctor
 */
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

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
}

/** Render a DoctorReport as readable text. */
export function formatDoctorReport(r: DoctorReport): string {
  const icon = (s: CheckStatus): string => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  const lines = [`🩺 apple-notes-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
  for (const c of r.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
