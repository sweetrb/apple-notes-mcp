#!/usr/bin/env node
import { appendFileSync, closeSync, constants, fstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFixtureFile } from "./broker-fixture-files.mjs";
import { classifyHostCapability, finalizeNativeResult } from "./broker-host-capability.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const gapHeading = "DYLD injection enforcement NOT VALIDATED on this host";
const disabledSip = "System Integrity Protection status: disabled.";
const reject = (reason) => ({ exitCode: 1, state: "failure", reason });

/** Apply the maintainer's CI policy without changing native classification. */
export function validateBrokerSecurityResult(nativeExitCode, report) {
  // Native success passes directly. Only the special exit-2 acceptance path
  // relies on a report; no report can override any other failed process status.
  if (nativeExitCode === 0) return { exitCode: 0, state: "native-success" };
  if (nativeExitCode !== 2) return reject("native broker checks did not exit with 0 or 2");
  if (!object(report) || report.schemaVersion !== 1)
    return reject("missing or unsupported native report");
  if (!object(report.result) || report.result.state !== "host-gap" || report.result.exitCode !== 2)
    return reject("native report does not identify an exit-2 host gap");
  if (
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !object(report.checks) ||
    report.checks.completed !== true ||
    !Number.isSafeInteger(report.checks.passed) ||
    report.checks.passed < 0 ||
    report.cleanupSucceeded !== true ||
    report.markersUnchanged !== true ||
    report.reportWritten !== true
  )
    return reject("native checks, cleanup, marker integrity, or report writing did not succeed");
  if (!object(report.hostEvidence) || report.hostEvidence.sip !== "disabled")
    return reject("SIP evidence does not identify the confirmed host gap");
  const sip = report.hostEvidence.sipCommand;
  if (
    !object(sip) ||
    !Array.isArray(sip.command) ||
    sip.command.length !== 2 ||
    sip.command[0] !== "/usr/bin/csrutil" ||
    sip.command[1] !== "status" ||
    sip.status !== 0 ||
    sip.signal !== null ||
    (sip.error !== undefined && sip.error !== null) ||
    typeof sip.stdout !== "string" ||
    sip.stdout.trim() !== disabledSip
  )
    return reject("raw SIP command evidence disagrees with the claimed host gap");

  const recomputed = finalizeNativeResult(classifyHostCapability(report.hostEvidence), {
    failures: report.failures,
    checksCompleted: report.checks.completed,
    cleanupSucceeded: report.cleanupSucceeded,
    markersUnchanged: report.markersUnchanged,
  });
  if (recomputed.state !== "host-gap" || recomputed.exitCode !== 2)
    return reject("independent controls and broker evidence do not establish a host gap");
  return { exitCode: 0, state: "accepted-host-gap", checksPassed: report.checks.passed };
}

function appendGapSummary(path, checkCount) {
  if (typeof path !== "string" || !path || /[\r\n\0]/.test(path))
    throw new Error("GITHUB_STEP_SUMMARY must name a writable summary file for an accepted gap");
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("step summary must be a regular file");
    appendFileSync(
      descriptor,
      `\n## ${gapHeading}\n\n` +
        `Native exit 2 was accepted after validating the complete host-gap report. ` +
        `${checkCount} native checks completed; cleanup, marker integrity, and report writing succeeded.\n\n` +
        `SIP evidence: \`${disabledSip}\` ` +
        `Both independent hardened control launch modes and the broker admitted the challenged dylib. ` +
        `DYLD injection enforcement was **NOT VALIDATED**; this is a host coverage gap, not an injection test pass.\n`
    );
  } finally {
    closeSync(descriptor);
  }
}

function main(args) {
  try {
    if (
      args.length !== 4 ||
      args[0] !== "--exit-code" ||
      !/^(0|[1-9][0-9]{0,2})$/.test(args[1]) ||
      Number(args[1]) > 255 ||
      args[2] !== "--report" ||
      !args[3] ||
      args[3].startsWith("--") ||
      /[\r\n\0]/.test(args[3])
    )
      throw new Error(
        "usage: node scripts/check-broker-security-result.mjs --exit-code <0..255> --report <path>"
      );
    const nativeExitCode = Number(args[1]);
    let report;
    if (nativeExitCode === 2) {
      const bytes = readFixtureFile(args[3]);
      if (bytes === null) throw new Error("native broker report is missing");
      report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    const result = validateBrokerSecurityResult(nativeExitCode, report);
    if (result.exitCode !== 0) throw new Error(result.reason);
    if (result.state === "accepted-host-gap") {
      // A summary failure stays fatal. Emit the acceptance warning only after
      // the required persistent disclosure has been written and closed.
      appendGapSummary(process.env.GITHUB_STEP_SUMMARY, result.checksPassed);
      console.log(
        "::warning title=DYLD injection enforcement NOT VALIDATED::" +
          `Accepted native exit 2: ${result.checksPassed} checks completed, SIP reports disabled, ` +
          "and both independent hardened control launch modes and the broker admitted injection. " +
          "This host cannot validate the DYLD injection enforcement boundary."
      );
    } else {
      console.log("Native broker security command exited successfully.");
    }
    return 0;
  } catch (error) {
    console.error(
      `Native broker security result rejected: ${String(error.message).replace(/[\r\n]/g, " ")}`
    );
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = main(process.argv.slice(2));
