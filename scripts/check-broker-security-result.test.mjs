import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_FIXTURE_FILE_BYTES } from "./broker-fixture-files.mjs";
import { CS_RUNTIME, CS_VALID } from "./broker-host-capability.mjs";
import { validateBrokerSecurityResult } from "./check-broker-security-result.mjs";

const script = fileURLToPath(new URL("./check-broker-security-result.mjs", import.meta.url));
const warning = "::warning title=DYLD injection enforcement NOT VALIDATED::";
const heading = "## DYLD injection enforcement NOT VALIDATED on this host";

function probe(id, mode, runtime, broker = false) {
  const executable = `/private/tmp/fixture-${id}`;
  const nonce = `fixture-${id}-aaaaaaaaaaaaaaaa`;
  const identity = {
    pid: id,
    ppid: 999,
    csopsStatus: 0,
    csopsErrno: 0,
    csopsFlags: CS_VALID | (runtime ? CS_RUNTIME : 0),
  };
  return {
    pid: id,
    parentPid: 999,
    executable,
    nonce,
    mode,
    signature: { verified: true, flags: (runtime ? CS_RUNTIME : 0) | 2, entitlements: {} },
    status: 0,
    signal: null,
    error: null,
    main: identity,
    ...(broker ? { healthy: true } : {}),
    records: [{ ...identity, nonce, executable, executablePathStatus: 0 }],
  };
}

function gapReport() {
  return {
    schemaVersion: 1,
    result: { state: "host-gap", exitCode: 2, reasons: ["host gap"] },
    failures: [],
    checks: { passed: 32, completed: true },
    cleanupSucceeded: true,
    markersUnchanged: true,
    reportWritten: true,
    hostEvidence: {
      platform: "darwin",
      sip: "disabled",
      sipCommand: {
        command: ["/usr/bin/csrutil", "status"],
        status: 0,
        signal: null,
        stdout: "System Integrity Protection status: disabled.\n",
        stderr: "",
      },
      positives: {
        sync: probe(1001, "sync", false),
        detached: probe(1002, "detached", false),
      },
      controls: {
        sync: probe(1003, "sync", true),
        detached: probe(1004, "detached", true),
      },
      broker: probe(1005, "detached", true, true),
    },
  };
}

function fixture(t, report = gapReport()) {
  const directory = mkdtempSync(join(tmpdir(), "broker-result-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  const summaryPath = join(directory, "summary.md");
  writeFileSync(reportPath, JSON.stringify(report));
  return { directory, reportPath, summaryPath };
}

function cli(args, summaryPath) {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) env.GITHUB_STEP_SUMMARY = summaryPath;
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
    timeout: 4000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function checkArgs(code, reportPath) {
  return ["--exit-code", String(code), "--report", reportPath];
}

function rejected(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(warning), false);
  assert.match(result.stderr, /Native broker security result rejected:/);
}

test("native exit 0 passes directly, independently of the report", () => {
  for (const report of [undefined, null, {}, gapReport()])
    assert.deepEqual(validateBrokerSecurityResult(0, report), {
      exitCode: 0,
      state: "native-success",
    });
});

test("no report can override a failed or invalid native process status", () => {
  for (const code of [
    1,
    3,
    126,
    127,
    128,
    137,
    255,
    256,
    -1,
    NaN,
    Infinity,
    null,
    undefined,
    "0",
    "2",
  ])
    assert.equal(validateBrokerSecurityResult(code, gapReport()).exitCode, 1);
});

test("exit 2 accepts a complete report with independently valid host-gap evidence", () => {
  assert.deepEqual(validateBrokerSecurityResult(2, gapReport()), {
    exitCode: 0,
    state: "accepted-host-gap",
    checksPassed: 32,
  });
});

test("nonnegative safe check counts include zero and the maximum safe integer", () => {
  for (const count of [0, Number.MAX_SAFE_INTEGER]) {
    const report = gapReport();
    report.checks.passed = count;
    assert.equal(validateBrokerSecurityResult(2, report).checksPassed, count);
  }
});

test("malformed report roots cannot be accepted", () => {
  for (const report of [undefined, null, [], true, 2, "host-gap", {}])
    assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
});

for (const key of ["cleanupSucceeded", "markersUnchanged", "reportWritten"]) {
  test(`${key} must be exactly true`, () => {
    for (const value of [undefined, null, false, 0, 1, "true", [], {}]) {
      const report = gapReport();
      report[key] = value;
      assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
    }
  });
}

const invalidFields = {
  "unsupported schema": (r) => {
    r.schemaVersion = 2;
  },
  "string schema": (r) => {
    r.schemaVersion = "1";
  },
  "missing result": (r) => {
    delete r.result;
  },
  "result array": (r) => {
    r.result = [];
  },
  "verified result with native exit 2": (r) => {
    r.result.state = "verified";
    r.result.exitCode = 0;
  },
  "failed result with native exit 2": (r) => {
    r.result.state = "failure";
    r.result.exitCode = 1;
  },
  "string reported exit": (r) => {
    r.result.exitCode = "2";
  },
  "missing failures": (r) => {
    delete r.failures;
  },
  "non-array failures": (r) => {
    r.failures = {};
  },
  "ordinary failure after the host probe": (r) => {
    r.failures = ["runtime tampering failed"];
  },
  "missing checks": (r) => {
    delete r.checks;
  },
  "array checks": (r) => {
    r.checks = [];
  },
  "incomplete checks": (r) => {
    r.checks.completed = false;
  },
  "truthy completed string": (r) => {
    r.checks.completed = "true";
  },
  "missing host evidence": (r) => {
    delete r.hostEvidence;
  },
  "SIP enabled": (r) => {
    r.hostEvidence.sip = "enabled";
  },
  "SIP unknown": (r) => {
    r.hostEvidence.sip = "unknown";
  },
  "nonexact SIP value": (r) => {
    r.hostEvidence.sip = "disabled.";
  },
  "missing raw SIP command": (r) => {
    delete r.hostEvidence.sipCommand;
  },
  "wrong SIP command": (r) => {
    r.hostEvidence.sipCommand.command = ["/tmp/csrutil", "status"];
  },
  "failed SIP command": (r) => {
    r.hostEvidence.sipCommand.status = 1;
  },
  "signaled SIP command": (r) => {
    r.hostEvidence.sipCommand.signal = "SIGTERM";
  },
  "SIP spawn error": (r) => {
    r.hostEvidence.sipCommand.error = "timeout";
  },
  "contradictory raw SIP output": (r) => {
    r.hostEvidence.sipCommand.stdout = "System Integrity Protection status: enabled.\n";
  },
  "extra SIP output": (r) => {
    r.hostEvidence.sipCommand.stdout += "not confirmed\n";
  },
  "non-string raw SIP output": (r) => {
    r.hostEvidence.sipCommand.stdout = true;
  },
};
for (const [name, mutate] of Object.entries(invalidFields)) {
  test(`report mismatch fails: ${name}`, () => {
    const report = gapReport();
    mutate(report);
    assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
  });
}

test("invalid check counts fail instead of entering the summary", () => {
  for (const count of [
    undefined,
    null,
    "32",
    -1,
    1.25,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const report = gapReport();
    report.checks.passed = count;
    assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
  }
});

for (let mask = 0; mask < 7; mask++) {
  test(`recomputed control/broker evidence rejects non-gap outcome mask ${mask}`, () => {
    const report = gapReport();
    [
      report.hostEvidence.controls.sync,
      report.hostEvidence.controls.detached,
      report.hostEvidence.broker,
    ].forEach((probe, index) => {
      if (!(mask & (1 << index))) probe.records = [];
    });
    assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
  });
}

test("recomputation rejects missing positives, unsafe entitlements, and identity mismatches", () => {
  for (const mutate of [
    (e) => {
      e.positives.sync.records = [];
    },
    (e) => {
      e.positives.detached.status = 1;
    },
    (e) => {
      e.controls.sync.signature.verified = false;
    },
    (e) => {
      e.controls.detached.signature.entitlements[
        "com.apple.security.cs.disable-library-validation"
      ] = true;
    },
    (e) => {
      e.broker.records[0].pid++;
    },
    (e) => {
      e.broker.records[0].csopsFlags = CS_VALID;
    },
    (e) => {
      e.broker.healthy = false;
    },
  ]) {
    const report = gapReport();
    mutate(report.hostEvidence);
    assert.equal(validateBrokerSecurityResult(2, report).exitCode, 1);
  }
});

test("CLI emits the exact warning and appends the required headed summary", (t) => {
  const { reportPath, summaryPath } = fixture(t);
  writeFileSync(summaryPath, "Previous step summary.\n");
  const result = cli(checkArgs(2, reportPath), summaryPath);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(warning));
  assert.equal(result.stderr, "");
  const summary = readFileSync(summaryPath, "utf8");
  assert.ok(summary.startsWith("Previous step summary.\n"));
  assert.ok(summary.includes(heading));
  assert.match(summary, /32 native checks completed/);
  assert.match(summary, /System Integrity Protection status: disabled\./);
  assert.match(summary, /\*\*NOT VALIDATED\*\*/);
});

test("CLI native exit 0 needs neither a report file nor a step summary", (t) => {
  const { directory } = fixture(t);
  const result = cli(checkArgs(0, join(directory, "missing.json")));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(warning), false);
});

test("CLI never accepts exit 1, signal status, or another code with a valid gap report", (t) => {
  const { reportPath, summaryPath } = fixture(t);
  writeFileSync(summaryPath, "unchanged");
  for (const code of [1, 3, 126, 127, 137, 143, 255])
    rejected(cli(checkArgs(code, reportPath), summaryPath));
  assert.equal(readFileSync(summaryPath, "utf8"), "unchanged");
});

test("CLI requires a strictly formed status and report argument", (t) => {
  const { reportPath, summaryPath } = fixture(t);
  for (const args of [
    [],
    ["--exit-code", "2"],
    ["--report", reportPath],
    checkArgs("02", reportPath),
    checkArgs("2.0", reportPath),
    checkArgs("2e0", reportPath),
    checkArgs("-1", reportPath),
    checkArgs("256", reportPath),
    checkArgs("SIGTERM", reportPath),
    checkArgs(" 2", reportPath),
    checkArgs("2\n", reportPath),
    checkArgs(2, ""),
    checkArgs(2, "--other"),
    checkArgs(2, "line\nbreak"),
    [...checkArgs(2, reportPath), "extra"],
  ])
    rejected(cli(args, summaryPath));
});

test("CLI rejects missing, malformed, invalid UTF-8, and oversized reports", (t) => {
  const { directory, reportPath, summaryPath } = fixture(t);
  rejected(cli(checkArgs(2, join(directory, "missing.json")), summaryPath));
  for (const contents of [
    "{",
    "null",
    "[]",
    Buffer.from([0xff]),
    Buffer.alloc(MAX_FIXTURE_FILE_BYTES + 1),
  ]) {
    writeFileSync(reportPath, contents);
    rejected(cli(checkArgs(2, reportPath), summaryPath));
  }
});

test("CLI rejects report directories, symlinks, and nonblocking FIFOs", (t) => {
  const { directory, reportPath, summaryPath } = fixture(t);
  const link = join(directory, "link");
  symlinkSync(reportPath, link);
  rejected(cli(checkArgs(2, directory), summaryPath));
  rejected(cli(checkArgs(2, link), summaryPath));
  const fifo = join(directory, "fifo");
  const created = spawnSync("mkfifo", [fifo], { timeout: 2000, encoding: "utf8" });
  assert.equal(created.error, undefined);
  assert.equal(created.status, 0, created.stderr);
  rejected(cli(checkArgs(2, fifo), summaryPath));
});

test("CLI field mismatch fails before writing any acceptance summary", (t) => {
  const report = gapReport();
  report.cleanupSucceeded = false;
  const { reportPath, summaryPath } = fixture(t, report);
  writeFileSync(summaryPath, "unchanged");
  rejected(cli(checkArgs(2, reportPath), summaryPath));
  assert.equal(readFileSync(summaryPath, "utf8"), "unchanged");
});

test("CLI missing or unwritable summary stays fatal and emits no acceptance warning", (t) => {
  const { directory, reportPath } = fixture(t);
  for (const summary of [
    undefined,
    "",
    directory,
    join(directory, "missing", "summary.md"),
    "line\nbreak",
  ])
    rejected(cli(checkArgs(2, reportPath), summary));
});

test("CLI summary symlinks and FIFOs are rejected without blocking", (t) => {
  const { directory, reportPath, summaryPath } = fixture(t);
  writeFileSync(summaryPath, "unchanged");
  const link = join(directory, "summary-link");
  symlinkSync(summaryPath, link);
  rejected(cli(checkArgs(2, reportPath), link));
  assert.equal(readFileSync(summaryPath, "utf8"), "unchanged");
  const fifo = join(directory, "summary-fifo");
  const created = spawnSync("mkfifo", [fifo], { timeout: 2000, encoding: "utf8" });
  assert.equal(created.error, undefined);
  assert.equal(created.status, 0, created.stderr);
  rejected(cli(checkArgs(2, reportPath), fifo));
});

test("CLI does not interpolate report messages into workflow commands or Markdown", (t) => {
  const report = gapReport();
  const injected = "\n::error title=forged::payload\n## Forged heading";
  report.result.reasons = [injected];
  report.hostEvidence.sipCommand.stderr = injected;
  report.hostEvidence.broker.signature.display = injected;
  const { reportPath, summaryPath } = fixture(t, report);
  const result = cli(checkArgs(2, reportPath), summaryPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("forged"), false);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(summaryPath, "utf8").includes("Forged"), false);
});
