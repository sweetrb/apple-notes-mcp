import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactAppend,
  createNotesAppControl,
  evaluateReplicaIdentity,
} from "./replica-identity-evidence.mjs";

const NOTES = "11111111-1111-4111-8111-111111111111";
const WRITER = "22222222-2222-4222-8222-222222222222";
const RESET = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const table = (a, b) => {
    const replicas = [{ uuid: NOTES, clock: 10, chars: 10, liveChars: 10, substrings: 1 }];
    if (a) replicas.push({ uuid: WRITER, clock: a, chars: a, liveChars: a, substrings: 1 });
    if (b) replicas.push({ uuid: RESET, clock: b, chars: b, liveChars: b, substrings: 1 });
    return {
      replicas,
      substrings: replicas.length,
      layout: {
        lengthsMatchText: true,
        indexBase: 1,
        warnings: [],
        unmappedReplicaIds: [],
        liveChars: 10 + a + b,
        textUtf16: 10 + a + b,
      },
    };
  };
  let text = "before!\nx\n";
  let a = 0,
    b = 0;
  const steps = [{ id: "baseline", phase: "baseline", revision: "r0", table: table(0, 0), text }];
  for (let i = 1; i <= 12; i++) {
    const phase = i <= 5 ? "A" : i <= 10 ? "B" : "C";
    const id = `${phase}${i <= 5 ? i : i <= 10 ? i - 5 : i - 10}`;
    const requestedText = `Synthetic replica experiment ${id}`;
    const insertion = (text.endsWith("\n") ? "" : "\n") + requestedText;
    text += insertion;
    if (phase === "C") b += insertion.length;
    else a += insertion.length;
    steps.push({
      id,
      phase,
      requestedText,
      text,
      payloadSha256: "c".repeat(64),
      buildId: phase === "B" ? "build-B" : "build-A",
      processId: 1000 + i,
      revision: `r${i}`,
      table: table(a, b),
      write: {
        verified: true,
        committed: true,
        storeKind: "copy",
        appendedUTF16: insertion.length,
        revisionBefore: `r${i - 1}`,
        revisionAfter: `r${i}`,
      },
    });
  }
  const before = structuredClone(steps[0].table);
  before.replicas[0].clock = before.replicas[0].chars = before.replicas[0].liveChars = 8;
  before.layout.liveChars = before.layout.textUtf16 = 8;
  steps[0].payloadSha256 = "d".repeat(64);
  return {
    noteIdentifier: "44444444-4444-4444-8444-444444444444",
    notesAppControl: {
      schemaVersion: 1,
      kind: "notes-app-controlled-gui-insertion",
      noteIdentifier: "44444444-4444-4444-8444-444444444444",
      persistedReadAfterCloseVerified: true,
      beforeSnapshotBoundToNoteAndTime: true,
      beforePayloadSha256: "e".repeat(64),
      afterPayloadSha256: "d".repeat(64),
      receiptSha256: "f".repeat(64),
      markerSha256: "0".repeat(64),
      appendedUTF16: 2,
      beforeTable: before,
      afterTable: structuredClone(steps[0].table),
    },
    schemaVersion: 1,
    kind: "synthetic-replica-identity",
    capturedAt: "2026-10-02T00:00:00Z",
    notesAppBaselineVerified: true,
    osVersion: "test",
    steps,
    isolation: {
      sandboxed: true,
      realHomeDenied: true,
      preferencesDaemonDenied: true,
      networkDenied: true,
    },
    builds: ["A", "B"].map((letter) => ({
      buildId: `build-${letter}`,
      sourceSha256: "a".repeat(64),
      binarySha256: "b".repeat(64),
      compilerInvocation: ["clang", `writer-${letter}.m`],
    })),
    preferencesReset: { isolatedOnly: true, beforeStep: "C1", removedFiles: ["isolated.plist"] },
  };
}

test("attributes every write and distinguishes process/build reuse from a preference-reset change", () => {
  const result = evaluateReplicaIdentity(fixture());
  assert.deepEqual(result.publicEvidence.observations.phaseAOwners, ["R2"]);
  assert.deepEqual(result.publicEvidence.observations.phaseBOwners, ["R2"]);
  assert.deepEqual(result.publicEvidence.observations.phaseCOwners, ["R3"]);
  assert.equal(result.publicEvidence.observations.newOwnerInPhaseC, true);
  assert.deepEqual(result.publicEvidence.observations.writerOwnersPresentInNotesAppBaseline, []);
  assert.deepEqual(result.publicEvidence.notesAppControl.activeOwnerReplicas, [
    { replica: "R1", liveDelta: 2, clockDelta: 2 },
  ]);
  assert.deepEqual(
    result.publicEvidence.observations.writerOwnersMatchingControlledNotesAppOwner,
    []
  );
  assert.equal(result.publicEvidence.liveValidated, false);
  assert.equal(result.publicEvidence.steps.length, 13);
});

test("public evidence never includes raw replica UUIDs or private paths", () => {
  const evidence = fixture();
  evidence.privatePath = "/Users/private/Notes.sqlite";
  const result = evaluateReplicaIdentity(evidence);
  const serialized = JSON.stringify(result.publicEvidence);
  for (const secret of [NOTES, WRITER, RESET, evidence.privatePath, "isolated.plist"])
    assert.equal(serialized.includes(secret), false);
  assert.deepEqual(result.privateReplicaLabels, { R1: NOTES, R2: WRITER, R3: RESET });
});

test("does not claim deletion of an existing plist when the isolated domain was absent", () => {
  const evidence = fixture();
  evidence.preferencesReset.removedFiles = [];
  const result = evaluateReplicaIdentity(evidence).publicEvidence;
  assert.equal(result.observations.preferenceResetRemovedExistingPlist, false);
  assert.match(result.limitations[0], /no-op/);
});

for (const [name, alter] of [
  ["layout warning", (e) => e.steps[1].table.layout.warnings.push("schema drift")],
  ["unmapped owner", (e) => e.steps[1].table.layout.unmappedReplicaIds.push(5)],
  ["missing layout diagnostics", (e) => delete e.steps[1].table.layout.warnings],
  ["unsupported index base", (e) => (e.steps[1].table.layout.indexBase = 2)],
  ["invalid replica UUID", (e) => (e.steps[1].table.replicas[1].uuid = "not-a-replica")],
  ["uncertain index base", (e) => (e.steps[1].table.layout.indexBase = null)],
  ["unattributed live characters", (e) => e.steps[1].table.replicas[1].liveChars--],
  [
    "same-length earlier text corruption",
    (e) => (e.steps[1].text = "X" + e.steps[1].text.slice(1)),
  ],
  [
    "same-length wrong marker",
    (e) => (e.steps[1].text = e.steps[1].text.replace("experiment A1", "experiment Z1")),
  ],
  ["missing decoded plaintext", (e) => delete e.steps[1].text],
  ["missing request marker", (e) => delete e.steps[1].requestedText],
  ["missing snapshot hash", (e) => delete e.steps[1].payloadSha256],
  ["unbound GUI before snapshot", (e) => delete e.notesAppControl.beforeSnapshotBoundToNoteAndTime],
  ["incorrect append length", (e) => e.steps[1].write.appendedUTF16++],
  ["reused process", (e) => (e.steps[2].processId = e.steps[1].processId)],
  ["wrong build", (e) => (e.steps[6].buildId = "build-A")],
  ["broken revision chain", (e) => (e.steps[2].write.revisionBefore = "different")],
  ["unverified save", (e) => (e.steps[1].write.verified = false)],
  ["live-store result", (e) => (e.steps[1].write.storeKind = "live")],
  ["baseline provenance missing", (e) => (e.notesAppBaselineVerified = false)],
  ["preferences daemon not isolated", (e) => (e.isolation.preferencesDaemonDenied = false)],
  ["one binary merely copied", (e) => (e.builds[1].buildId = e.builds[0].buildId)],
  ["different source revisions", (e) => (e.builds[1].sourceSha256 = "c".repeat(64))],
  ["no controlled Notes.app edit", (e) => delete e.notesAppControl],
  ["different note control", (e) => (e.notesAppControl.noteIdentifier = WRITER)],
  ["different payload control", (e) => (e.notesAppControl.afterPayloadSha256 = "1".repeat(64))],
  ["different table control", (e) => e.notesAppControl.afterTable.replicas[0].clock++],
  ["GUI edit not attributed", (e) => e.notesAppControl.appendedUTF16++],
  ["unsafe preference reset", (e) => (e.preferencesReset.isolatedOnly = false)],
])
  test(`refuses ${name}`, () => {
    const evidence = fixture();
    alter(evidence);
    assert.throws(() => evaluateReplicaIdentity(evidence), /Invalid replica evidence/);
  });

function guiFixture() {
  const e = fixture();
  const noteIdentifier = e.noteIdentifier;
  return {
    before: {
      text: "before!\n",
      noteIdentifier,
      readAt: "2026-10-03T00:00:00Z",
      replicaTable: e.notesAppControl.beforeTable,
    },
    after: {
      text: "before!\nx\n",
      noteIdentifier,
      readAt: "2026-10-03T00:00:06Z",
      replicaTable: e.notesAppControl.afterTable,
    },
    receipt: {
      q2: {
        noteIdentifier,
        markerVisible: true,
        insertedText: "\nx",
        beforeUiText: "before!",
        afterUiText: "before!\nx",
        beforeObservedAt: "2026-10-03T00:00:01Z",
        typingStartedAt: "2026-10-03T00:00:02Z",
        typingReturnedAt: "2026-10-03T00:00:03Z",
        afterObservedAt: "2026-10-03T00:00:04Z",
        leaveEditorReturnedAt: "2026-10-03T00:00:05Z",
      },
    },
    beforePayloadSha256: "e".repeat(64),
    afterPayloadSha256: "d".repeat(64),
    receiptSha256: "f".repeat(64),
  };
}
test("attributes a persisted GUI marker allowing only paragraph-boundary normalization", () => {
  const result = createNotesAppControl(guiFixture());
  assert.equal(result.appendedUTF16, 2);
  assert.deepEqual(result.ownerUuids, [NOTES]);
  assert.equal(result.persistedReadAfterCloseVerified, true);
});
for (const [name, alter] of [
  ["different marker", (f) => (f.after.text = "before!\nz\n")],
  ["replacement", (f) => (f.after.text = "differ!\nx\n")],
  ["missing visible marker", (f) => (f.receipt.q2.markerVisible = false)],
  ["unclosed editor", (f) => delete f.receipt.q2.leaveEditorReturnedAt],
  ["stale snapshot", (f) => (f.after.readAt = "2026-10-03T00:00:01Z")],
  ["different note", (f) => (f.after.noteIdentifier = WRITER)],
  ["different before note", (f) => (f.before.noteIdentifier = WRITER)],
  ["missing before note", (f) => delete f.before.noteIdentifier],
  ["future before snapshot", (f) => (f.before.readAt = "2099-01-01T00:00:00Z")],
  ["before snapshot after typing", (f) => (f.before.readAt = "2026-10-03T00:00:03Z")],
  ["missing before timestamp", (f) => delete f.before.readAt],
])
  test(`rejects controlled GUI evidence with ${name}`, () => {
    const f = guiFixture();
    alter(f);
    assert.throws(() => createNotesAppControl(f), /Invalid replica evidence/);
  });

test("baseline membership does not misattribute the GUI edit to an inactive replica", () => {
  const e = fixture();
  const unused = { uuid: WRITER, clock: 0, chars: 0, liveChars: 0, substrings: 0 };
  e.steps[0].table.replicas.push({ ...unused });
  e.notesAppControl.afterTable.replicas.push({ ...unused });
  e.notesAppControl.beforeTable.replicas.push({ ...unused });
  const report = evaluateReplicaIdentity(e).publicEvidence;
  assert.deepEqual(report.observations.writerOwnersPresentInNotesAppBaseline, ["R2"]);
  assert.deepEqual(report.observations.writerOwnersMatchingControlledNotesAppOwner, []);
  assert.deepEqual(
    report.notesAppControl.activeOwnerReplicas.map((r) => r.replica),
    ["R1"]
  );
});

test("exact append checks separator and UTF-16 units independently", () => {
  assert.doesNotThrow(() => assertExactAppend("prefix", "prefix\nmarker🧪", "marker🧪", 9));
  assert.doesNotThrow(() => assertExactAppend("prefix\n", "prefix\nmarker🧪", "marker🧪", 8));
  assert.throws(
    () => assertExactAppend("prefix", "prefixmarker🧪", "marker🧪", 8),
    /exact expected append/
  );
  assert.throws(
    () => assertExactAppend("prefix", "preFIX\nmarker🧪", "marker🧪", 9),
    /exact expected append/
  );
});
