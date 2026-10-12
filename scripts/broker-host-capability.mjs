/** Pure evidence validation for the isolated native broker harness. */
export const CS_VALID = 0x1;
export const CS_RUNTIME = 0x10000;
const unsafeEntitlements = [
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.get-task-allow",
];

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uint32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const pid = (value) => Number.isSafeInteger(value) && value > 1;
const has = (flags, bit) => (flags & bit) !== 0;

function signatureErrors(signature, runtime) {
  if (!object(signature)) return ["missing signature evidence"];
  const errors = [];
  if (signature.verified !== true) errors.push("strict signature verification failed");
  if (!uint32(signature.flags) || has(signature.flags, CS_RUNTIME) !== runtime)
    errors.push("signature runtime flag does not match the probe");
  if (!object(signature.entitlements)) errors.push("missing parsed entitlements");
  else if (
    unsafeEntitlements.some(
      (key) => key in signature.entitlements && signature.entitlements[key] !== false
    )
  )
    errors.push("signature has an unsafe or malformed escape entitlement");
  return errors;
}

function identityErrors(record, probe, runtime, constructor) {
  if (!object(record)) return ["missing process identity evidence"];
  const errors = [];
  if (record.pid !== probe.pid || record.ppid !== probe.parentPid)
    errors.push("process PID or parent PID does not match the launched probe");
  if (record.csopsStatus !== 0 || record.csopsErrno !== 0 || !uint32(record.csopsFlags))
    errors.push("invalid live code-signing evidence");
  else if (!has(record.csopsFlags, CS_VALID) || has(record.csopsFlags, CS_RUNTIME) !== runtime)
    errors.push("live code-signing flags do not match the probe");
  if (
    constructor &&
    (record.nonce !== probe.nonce ||
      record.executable !== probe.executable ||
      record.executablePathStatus !== 0)
  )
    errors.push("constructor nonce or executable does not match the launched probe");
  return errors;
}

/** Validate one completed C probe or the broker's pre-child startup snapshot. */
export function assessProbe(probe, { runtime, broker = false, positive = false }) {
  if (!object(probe)) return { errors: ["missing probe"], injected: false };
  const errors = signatureErrors(probe.signature, runtime);
  if (
    !pid(probe.pid) ||
    !pid(probe.parentPid) ||
    typeof probe.executable !== "string" ||
    !probe.executable.startsWith("/") ||
    probe.executable.includes("\0") ||
    typeof probe.nonce !== "string" ||
    !/^[A-Za-z0-9-]{16,128}$/.test(probe.nonce) ||
    !["sync", "detached"].includes(probe.mode)
  )
    errors.push("invalid expected probe identity");
  if (broker) {
    if (probe.mode !== "detached" || probe.healthy !== true)
      errors.push("broker startup did not complete its verified ping");
  } else {
    if (probe.status !== 0 || probe.signal !== null || probe.error !== null)
      errors.push("control did not exit successfully");
    errors.push(...identityErrors(probe.main, probe, runtime, false));
  }
  if (!Array.isArray(probe.records) || probe.records.length > 1)
    errors.push("missing, duplicate, or unexpected constructor records");
  else if (probe.records.length === 1)
    errors.push(...identityErrors(probe.records[0], probe, runtime, true));
  const injected = Array.isArray(probe.records) && probe.records.length === 1;
  if (positive && !injected) errors.push("positive control did not load the challenged dylib");
  return { errors, injected };
}

function failure(reasons) {
  return { state: "failure", exitCode: 1, reasons };
}

/** Only empirical controls can establish a host gap; SIP alone never can. */
export function classifyHostCapability(evidence) {
  if (!object(evidence) || evidence.platform !== "darwin")
    return failure(["native macOS enforcement was not verified on this platform"]);
  const errors = [];
  const outcomes = [];
  const nonces = new Set();
  const pids = new Set();
  for (const mode of ["sync", "detached"]) {
    for (const [name, runtime, positive] of [
      ["positives", false, true],
      ["controls", true, false],
    ]) {
      const probe = evidence[name]?.[mode];
      const result = assessProbe(probe, { runtime, positive });
      if (probe?.mode !== mode) result.errors.push("control launch mode is missing or mismatched");
      errors.push(...result.errors.map((message) => `${name}.${mode}: ${message}`));
      if (name === "controls") outcomes.push(result.injected);
      if (probe) {
        if (nonces.has(probe.nonce) || pids.has(probe.pid))
          errors.push("probe identity was reused");
        nonces.add(probe.nonce);
        pids.add(probe.pid);
      }
    }
  }
  const broker = assessProbe(evidence.broker, { runtime: true, broker: true });
  errors.push(...broker.errors.map((message) => `broker: ${message}`));
  if (evidence.broker && (nonces.has(evidence.broker.nonce) || pids.has(evidence.broker.pid)))
    errors.push("broker probe identity was reused");
  if (errors.length) return failure(errors);
  outcomes.push(broker.injected);
  if (outcomes.every((injected) => !injected))
    return {
      state: "verified",
      exitCode: 0,
      reasons: ["both hardened control launch modes and the broker blocked the validated dylib"],
    };
  if (outcomes.every(Boolean) && evidence.sip === "disabled")
    return {
      state: "host-gap",
      exitCode: 2,
      reasons: [
        "SIP reports disabled and both valid hardened controls and the broker admitted the dylib; pre-main injection protection is NOT VERIFIED",
      ],
    };
  return failure(["contradictory, mixed, or insufficient host-enforcement evidence"]);
}

/** Later product, marker, cleanup, or reporting failures always dominate a gap. */
export function finalizeNativeResult(
  capability,
  { failures, checksCompleted, cleanupSucceeded, markersUnchanged }
) {
  if (
    !Array.isArray(failures) ||
    failures.length ||
    checksCompleted !== true ||
    cleanupSucceeded !== true ||
    markersUnchanged !== true
  )
    return failure([
      ...(Array.isArray(failures) ? failures : ["missing check results"]),
      ...(checksCompleted === true ? [] : ["regression checks did not complete"]),
      ...(cleanupSucceeded === true ? [] : ["fixture cleanup did not succeed"]),
      ...(markersUnchanged === true
        ? []
        : ["unexpected constructor records after the capability probe"]),
    ]);
  if (
    !object(capability) ||
    !["verified", "host-gap", "failure"].includes(capability.state) ||
    capability.exitCode !== { verified: 0, "host-gap": 2, failure: 1 }[capability.state]
  )
    return failure(["host capability was not established"]);
  return capability;
}
