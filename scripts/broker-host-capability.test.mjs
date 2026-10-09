import assert from "node:assert/strict";
import test from "node:test";
import {
  assessProbe,
  classifyHostCapability,
  finalizeNativeResult,
  CS_VALID,
  CS_RUNTIME,
} from "./broker-host-capability.mjs";

function probe(id, mode, runtime, injected, broker = false) {
  const nonce = `probe-${id}-aaaaaaaaaaaaaaaaaaaaaaaa`;
  const identity = {
    pid: id,
    ppid: 999,
    csopsStatus: 0,
    csopsErrno: 0,
    csopsFlags: CS_VALID | (runtime ? CS_RUNTIME : 0) | 0x02000000,
  };
  return {
    pid: id,
    parentPid: 999,
    executable: `/private/tmp/probe-${id}`,
    nonce,
    mode,
    signature: { verified: true, flags: (runtime ? CS_RUNTIME : 0) | 2, entitlements: {} },
    status: 0,
    signal: null,
    error: null,
    main: identity,
    ...(broker ? { healthy: true } : {}),
    records: injected
      ? [{ ...identity, nonce, executable: `/private/tmp/probe-${id}`, executablePathStatus: 0 }]
      : [],
  };
}

function evidence(injected = false, sip = "disabled") {
  return {
    platform: "darwin",
    sip,
    positives: {
      sync: probe(1001, "sync", false, true),
      detached: probe(1002, "detached", false, true),
    },
    controls: {
      sync: probe(1003, "sync", true, injected),
      detached: probe(1004, "detached", true, injected),
    },
    broker: probe(1005, "detached", true, injected, true),
  };
}

for (const sip of ["enabled", "disabled", "unknown"]) {
  test(`all empirical probes blocked: verified despite SIP report ${sip}`, () => {
    assert.equal(classifyHostCapability(evidence(false, sip)).exitCode, 0);
  });
  test(`all probes admitted: gap only for explicitly disabled SIP (${sip})`, () => {
    assert.equal(classifyHostCapability(evidence(true, sip)).exitCode, sip === "disabled" ? 2 : 1);
  });
}
for (let mask = 1; mask < 7; mask++) {
  test(`mixed control/broker outcomes are failures (${mask})`, () => {
    const input = evidence();
    input.controls.sync = probe(1003, "sync", true, Boolean(mask & 1));
    input.controls.detached = probe(1004, "detached", true, Boolean(mask & 2));
    input.broker = probe(1005, "detached", true, Boolean(mask & 4), true);
    assert.equal(classifyHostCapability(input).exitCode, 1);
  });
}

const invalid = {
  "failed strict signature": (p) => {
    p.signature.verified = false;
  },
  "missing parsed entitlements": (p) => {
    delete p.signature.entitlements;
  },
  "unsafe entitlement": (p) => {
    p.signature.entitlements["com.apple.security.cs.disable-library-validation"] = true;
  },
  "malformed entitlement": (p) => {
    p.signature.entitlements["com.apple.security.get-task-allow"] = "false";
  },
  "missing static runtime": (p) => {
    p.signature.flags = 2;
  },
  "missing live runtime": (p) => {
    p.main.csopsFlags = CS_VALID;
  },
  "missing live validity": (p) => {
    p.main.csopsFlags = CS_RUNTIME;
  },
  "negative flags": (p) => {
    p.main.csopsFlags = -1;
  },
  "fractional flags": (p) => {
    p.main.csopsFlags = 65537.5;
  },
  "overflow flags": (p) => {
    p.main.csopsFlags = 0x100010001;
  },
  "failed csops": (p) => {
    p.main.csopsStatus = -1;
  },
  "nonzero csops errno": (p) => {
    p.main.csopsErrno = 1;
  },
  timeout: (p) => {
    p.error = "timeout";
  },
  signal: (p) => {
    p.signal = "SIGKILL";
  },
  "nonzero exit": (p) => {
    p.status = 1;
  },
  "missing main JSON": (p) => {
    p.main = null;
  },
  "main identity mismatch": (p) => {
    p.main.pid = 1010;
  },
  "missing spawned PID": (p) => {
    p.pid = undefined;
  },
  "duplicate constructor": (p) => {
    p.records.push({ ...p.records[0] });
  },
  "unexpected constructor PID": (p) => {
    p.records[0].pid = 1011;
  },
  "unexpected constructor PPID": (p) => {
    p.records[0].ppid = 1;
  },
  "wrong executable": (p) => {
    p.records[0].executable += "-other";
  },
  "failed executable query": (p) => {
    p.records[0].executablePathStatus = 1;
  },
  "stale nonce": (p) => {
    p.records[0].nonce = "old-nonce";
  },
  "constructor runtime absent": (p) => {
    p.records[0].csopsFlags = CS_VALID;
  },
  "malformed marker": (p) => {
    p.records = [null];
  },
};
for (const [name, mutate] of Object.entries(invalid)) {
  test(`invalid hardened evidence fails: ${name}`, () => {
    const input = evidence(true);
    mutate(input.controls.sync);
    assert.equal(classifyHostCapability(input).exitCode, 1);
  });
}
for (const mode of ["sync", "detached"]) {
  test(`missing ${mode} positive control is fatal`, () => {
    const input = evidence(true);
    input.positives[mode].records = [];
    assert.equal(classifyHostCapability(input).exitCode, 1);
  });
  test(`failed ${mode} positive process is fatal`, () => {
    const input = evidence(true);
    input.positives[mode].error = "spawn failure";
    assert.equal(classifyHostCapability(input).exitCode, 1);
  });
}
test("unexpected platform, incomplete evidence, reused identities and failed broker health are fatal", () => {
  for (const mutate of [
    (e) => {
      e.platform = "linux";
    },
    (e) => {
      delete e.controls.detached;
    },
    (e) => {
      e.controls.sync.mode = "detached";
    },
    (e) => {
      e.broker.nonce = e.controls.sync.nonce;
      e.broker.records[0].nonce = e.broker.nonce;
    },
    (e) => {
      e.broker.healthy = false;
    },
  ]) {
    const input = evidence(true);
    mutate(input);
    assert.equal(classifyHostCapability(input).exitCode, 1);
  }
});
test("extra benign code-signing bits and explicitly false escape entitlements are allowed", () => {
  const input = evidence(true);
  input.controls.sync.signature.entitlements["com.apple.security.get-task-allow"] = false;
  assert.equal(classifyHostCapability(input).exitCode, 2);
});
test("malformed probes cannot throw or become a pass", () => {
  for (const input of [undefined, null, [], {}, "wrong"]) {
    assert.equal(classifyHostCapability(input).exitCode, 1);
    assert.ok(assessProbe(input, { runtime: true }).errors.length);
  }
});
for (const injected of [false, true]) {
  test(`later failures override ${injected ? "gap" : "verified"} classification`, () => {
    const capability = classifyHostCapability(evidence(injected));
    const passed = {
      failures: [],
      checksCompleted: true,
      cleanupSucceeded: true,
      markersUnchanged: true,
    };
    assert.equal(finalizeNativeResult(capability, passed).exitCode, injected ? 2 : 0);
    for (const override of [
      { failures: ["ordinary check failed"] },
      { failures: ["report write failed"] },
      { checksCompleted: false },
      { cleanupSucceeded: false },
      { markersUnchanged: false },
      { failures: undefined },
    ])
      assert.equal(finalizeNativeResult(capability, { ...passed, ...override }).exitCode, 1);
  });
}
