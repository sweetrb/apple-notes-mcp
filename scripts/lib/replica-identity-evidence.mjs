/** Strict Q2 evidence checks with text-free public output. No filesystem or Notes access. */
import { createHash } from "node:crypto";
const fail = (message) => {
  throw new Error(`Invalid replica evidence: ${message}`);
};
const sha = /^[a-f0-9]{64}$/;

export function assertReplicaTable(table, label = "snapshot") {
  if (
    table?.layout?.lengthsMatchText !== true ||
    ![0, 1].includes(table.layout.indexBase) ||
    !Array.isArray(table.layout.warnings) ||
    table.layout.warnings.length ||
    !Array.isArray(table.layout.unmappedReplicaIds) ||
    table.layout.unmappedReplicaIds.length ||
    !Number.isSafeInteger(table.layout.textUtf16) ||
    table.layout.textUtf16 < 0 ||
    !Number.isSafeInteger(table.layout.liveChars) ||
    table.layout.liveChars < 0
  )
    fail(`${label} has an unverified decoder layout`);
  if (!Array.isArray(table.replicas) || table.replicas.length === 0)
    fail(`${label} has no replicas`);
  const ids = new Set();
  let live = 0;
  for (const replica of table.replicas) {
    if (
      !/^[A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12}$/i.test(replica.uuid) ||
      ids.has(replica.uuid)
    )
      fail(`${label} has duplicate/invalid replicas`);
    ids.add(replica.uuid);
    for (const field of ["clock", "chars", "liveChars", "substrings"])
      if (!Number.isSafeInteger(replica[field]) || replica[field] < 0)
        fail(`${label} has an invalid ${field}`);
    if (replica.liveChars > replica.chars) fail(`${label} has more live than total characters`);
    live += replica.liveChars;
  }
  if (live !== table.layout.liveChars || live !== table.layout.textUtf16)
    fail(`${label} leaves live characters without a replica owner`);
}

/** Verify content independently of a writer's success response or length counters. */
export function assertExactAppend(beforeText, afterText, marker, appendedUTF16, label = "append") {
  if (
    typeof beforeText !== "string" ||
    typeof afterText !== "string" ||
    typeof marker !== "string" ||
    !marker ||
    beforeText.includes(marker)
  )
    fail(`${label} lacks a unique marker or decoded plaintext`);
  const insertion = (beforeText && !beforeText.endsWith("\n") ? "\n" : "") + marker;
  if (afterText !== beforeText + insertion || insertion.length !== appendedUTF16)
    fail(`${label} changed plaintext beyond the exact expected append`);
}

/** Attribute a controlled append to actual replica counters, not set membership. */
function appendOwners(before, after, appendedUTF16, label) {
  assertReplicaTable(before, `${label} before`);
  assertReplicaTable(after, `${label} after`);
  if (
    !Number.isSafeInteger(appendedUTF16) ||
    appendedUTF16 <= 0 ||
    after.layout.textUtf16 - before.layout.textUtf16 !== appendedUTF16
  )
    fail(`${label} is not the expected append`);
  const old = new Map(before.replicas.map((r) => [r.uuid, r]));
  if (before.replicas.some((r) => !after.replicas.some((a) => a.uuid === r.uuid)))
    fail(`${label} lost an existing replica`);
  const owners = [];
  let attributed = 0;
  for (const replica of after.replicas) {
    const prior = old.get(replica.uuid);
    const liveDelta = replica.liveChars - (prior?.liveChars ?? 0);
    const clockDelta = replica.clock - (prior?.clock ?? 0);
    if (liveDelta < 0 || clockDelta < 0) fail(`${label} regressed counters`);
    if (liveDelta > 0) owners.push({ uuid: replica.uuid, liveDelta, clockDelta });
    attributed += liveDelta;
  }
  if (attributed !== appendedUTF16 || !owners.length) fail(`${label} has unattributed characters`);
  return owners;
}

/** Create private provenance from already-authorized exact-note snapshots. */
export function createNotesAppControl({
  before,
  after,
  receipt,
  beforePayloadSha256,
  afterPayloadSha256,
  receiptSha256,
}) {
  const q = receipt?.q2;
  if (
    !q?.noteIdentifier ||
    before.noteIdentifier !== q.noteIdentifier ||
    after.noteIdentifier !== q.noteIdentifier ||
    q.markerVisible !== true
  )
    fail("controlled GUI receipt does not identify the persisted note");
  if (
    typeof before.text !== "string" ||
    typeof after.text !== "string" ||
    typeof q.insertedText !== "string" ||
    !after.text.startsWith(before.text)
  )
    fail("controlled GUI edit was not append-only");
  if (
    before.text.length !== before.replicaTable?.layout?.textUtf16 ||
    after.text.length !== after.replicaTable?.layout?.textUtf16
  )
    fail("controlled GUI text and ownership lengths disagree");
  const addedText = after.text.slice(before.text.length);
  // Notes moves the paragraph delimiter from the start of a typed insertion
  // to the end of the stored paragraph. Only those boundary newlines may vary.
  const marker = q.insertedText.replace(/^\n+|\n+$/g, "");
  if (
    !marker ||
    before.text.includes(marker) ||
    addedText.replace(/^\n+|\n+$/g, "") !== marker ||
    !q.afterUiText?.includes(marker) ||
    q.beforeUiText?.includes(marker)
  )
    fail("controlled marker does not match the exact stored insertion");
  if (
    !Number.isFinite(Date.parse(before.readAt)) ||
    Date.parse(before.readAt) > Date.parse(q.typingStartedAt)
  )
    fail("controlled GUI before snapshot was not collected before typing");
  const times = [
    q.beforeObservedAt,
    q.typingStartedAt,
    q.typingReturnedAt,
    q.afterObservedAt,
    q.leaveEditorReturnedAt,
    after.readAt,
  ].map(Date.parse);
  if (times.some((t) => !Number.isFinite(t)) || times.some((t, i) => i > 0 && t < times[i - 1]))
    fail("controlled GUI snapshot was not read after the editor closed");
  for (const digest of [beforePayloadSha256, afterPayloadSha256, receiptSha256])
    if (!sha.test(digest)) fail("controlled GUI provenance hashes are missing");
  const owners = appendOwners(
    before.replicaTable,
    after.replicaTable,
    addedText.length,
    "controlled Notes.app edit"
  );
  return {
    schemaVersion: 1,
    kind: "notes-app-controlled-gui-insertion",
    noteIdentifier: q.noteIdentifier,
    beforePayloadSha256,
    afterPayloadSha256,
    receiptSha256,
    beforeSnapshotBoundToNoteAndTime: true,
    persistedReadAfterCloseVerified: true,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    appendedUTF16: addedText.length,
    beforeTable: before.replicaTable,
    afterTable: after.replicaTable,
    ownerUuids: owners.map((o) => o.uuid),
  };
}

/**
 * Evaluate actual per-save tables; UUID-set changes alone do not attribute an
 * edit to a replica. Independent build receipts are generated by the harness,
 * not inferred from different binary paths or differing executable hashes.
 */
export function evaluateReplicaIdentity(evidence) {
  if (evidence.schemaVersion !== 1 || evidence.kind !== "synthetic-replica-identity")
    fail("wrong schema");
  if (!evidence.notesAppBaselineVerified)
    fail("baseline does not match the authorized Notes.app payload");
  if (
    !evidence.isolation?.sandboxed ||
    !evidence.isolation?.realHomeDenied ||
    !evidence.isolation?.preferencesDaemonDenied ||
    !evidence.isolation?.networkDenied
  )
    fail("isolation is not proven");
  if (evidence.builds?.length !== 2 || new Set(evidence.builds.map((b) => b.buildId)).size !== 2)
    fail("two independent builds are required");
  for (const build of evidence.builds)
    if (!sha.test(build.sourceSha256) || !sha.test(build.binarySha256) || !build.compilerInvocation)
      fail("missing build receipt");
  if (evidence.builds[0].sourceSha256 !== evidence.builds[1].sourceSha256)
    fail("builds use different source revisions");
  const phases = ["baseline", ...Array(5).fill("A"), ...Array(5).fill("B"), ...Array(2).fill("C")];
  if (evidence.steps?.length !== phases.length)
    fail("expected baseline, five A, five B, and two C snapshots");
  if (!evidence.preferencesReset?.isolatedOnly || evidence.preferencesReset.beforeStep !== "C1")
    fail("preference reset was not isolated and bracketed before C1");
  const labels = new Map();
  const labelFor = (uuid) => {
    if (!labels.has(uuid)) labels.set(uuid, `R${labels.size + 1}`);
    return labels.get(uuid);
  };
  const processIds = new Set();
  const steps = [];
  let previous;
  for (let i = 0; i < phases.length; i++) {
    const step = evidence.steps[i];
    if (step.phase !== phases[i]) fail(`unexpected phase at step ${i}`);
    assertReplicaTable(step.table, step.id);
    if (
      typeof step.text !== "string" ||
      step.text.length !== step.table.layout.textUtf16 ||
      !sha.test(step.payloadSha256)
    )
      fail(`${step.id} lacks decoded plaintext or payload provenance`);
    const owners = [];
    const deltas = [];
    if (previous) {
      const marker = `Synthetic replica experiment ${step.id}`;
      if (step.requestedText !== marker)
        fail(`${step.id} did not record the expected request marker`);
      assertExactAppend(previous.text, step.text, marker, step.write?.appendedUTF16, step.id);
      if (!step.write?.verified || !step.write.committed || step.write.storeKind !== "copy")
        fail(`${step.id} did not verify a committed synthetic-store write`);
      if (!Number.isSafeInteger(step.processId) || processIds.has(step.processId))
        fail(`${step.id} did not use a distinct writer process`);
      processIds.add(step.processId);
      if (step.buildId !== evidence.builds[step.phase === "B" ? 1 : 0].buildId)
        fail(`${step.id} used the wrong build`);
      if (
        step.write.revisionBefore !== previous.revision ||
        step.revision !== step.write.revisionAfter ||
        step.revision === previous.revision
      )
        fail(`${step.id} broke the revision chain`);
      const before = new Map(previous.table.replicas.map((r) => [r.uuid, r]));
      const afterIds = new Set(step.table.replicas.map((r) => r.uuid));
      if ([...before.keys()].some((id) => !afterIds.has(id)))
        fail(`${step.id} lost an existing replica`);
      for (const replica of step.table.replicas) {
        const old = before.get(replica.uuid);
        const liveDelta = replica.liveChars - (old?.liveChars ?? 0);
        const clockDelta = replica.clock - (old?.clock ?? 0);
        if (liveDelta < 0 || clockDelta < 0)
          fail(`${step.id} regressed append-only replica counters`);
        if (liveDelta > 0) owners.push(labelFor(replica.uuid));
        if (liveDelta > 0 || clockDelta > 0 || !old)
          deltas.push({ replica: labelFor(replica.uuid), newReplica: !old, liveDelta, clockDelta });
      }
      const added = step.table.layout.textUtf16 - previous.table.layout.textUtf16;
      if (
        !Number.isSafeInteger(step.write.appendedUTF16) ||
        step.write.appendedUTF16 <= 0 ||
        added !== step.write.appendedUTF16 ||
        deltas.reduce((sum, d) => sum + d.liveDelta, 0) !== added ||
        owners.length === 0
      )
        fail(`${step.id} does not attribute all appended characters`);
    }
    steps.push({
      id: step.id,
      phase: step.phase,
      processOrdinal: i || null,
      buildId: step.buildId ?? null,
      replicaCount: step.table.replicas.length,
      textUtf16: step.table.layout.textUtf16,
      ownerReplicas: owners,
      deltas,
      replicas: step.table.replicas.map((r) => ({
        replica: labelFor(r.uuid),
        clock: r.clock,
        chars: r.chars,
        liveChars: r.liveChars,
        substrings: r.substrings,
      })),
    });
    previous = step;
  }
  const control = evidence.notesAppControl;
  if (
    control?.schemaVersion !== 1 ||
    control.kind !== "notes-app-controlled-gui-insertion" ||
    !control.persistedReadAfterCloseVerified ||
    !control.beforeSnapshotBoundToNoteAndTime ||
    control.noteIdentifier !== evidence.noteIdentifier ||
    control.afterPayloadSha256 !== evidence.steps[0].payloadSha256 ||
    JSON.stringify(control.afterTable) !== JSON.stringify(evidence.steps[0].table)
  )
    fail("Notes.app control is missing or does not match this same-note baseline");
  for (const digest of [
    control.beforePayloadSha256,
    control.afterPayloadSha256,
    control.receiptSha256,
    control.markerSha256,
  ])
    if (!sha.test(digest)) fail("Notes.app control provenance is incomplete");
  const appOwners = appendOwners(
    control.beforeTable,
    control.afterTable,
    control.appendedUTF16,
    "controlled Notes.app edit"
  ).map(({ uuid, liveDelta, clockDelta }) => ({ replica: labelFor(uuid), liveDelta, clockDelta }));
  const baseline = new Set(steps[0].replicas.map((r) => r.replica));
  const owners = [...new Set(steps.flatMap((s) => s.ownerReplicas))];
  const phaseOwners = (phase) => [
    ...new Set(steps.filter((s) => s.phase === phase).flatMap((s) => s.ownerReplicas)),
  ];
  const cOwners = phaseOwners("C");
  const abOwners = new Set([...phaseOwners("A"), ...phaseOwners("B")]);
  const resetObserved = evidence.preferencesReset.removedFiles?.length > 0;
  return {
    publicEvidence: {
      schemaVersion: 1,
      kind: "synthetic-replica-identity-result",
      capturedAt: evidence.capturedAt,
      osVersion: evidence.osVersion,
      writerSourceSha256: evidence.builds[0].sourceSha256,
      builds: evidence.builds.map(({ buildId, sourceSha256, binarySha256 }) => ({
        buildId,
        sourceSha256,
        binarySha256,
      })),
      scope:
        "Dedicated synthetic store, actual Notes model; no live Notes write or preference change.",
      fixtureConditions: {
        accountReplicaMapConstructed:
          evidence.fixtureConditions?.accountReplicaMapConstructed === true,
        productionAccountMapInspected:
          evidence.fixtureConditions?.productionAccountMapInspected === true,
      },
      notesAppBaselineVerified: true,
      decoderChecksPassed: true,
      exactPlaintextChecksPassed: true,
      notesAppControl: {
        source: control.kind,
        appendedUTF16: control.appendedUTF16,
        activeOwnerReplicas: appOwners,
        beforeSnapshotBoundToNoteAndTime: true,
        persistedReadAfterCloseVerified: true,
      },
      steps,
      observations: {
        writerOwnerReplicas: owners,
        phaseAOwners: phaseOwners("A"),
        phaseBOwners: phaseOwners("B"),
        phaseCOwners: cOwners,
        writerOwnersPresentInNotesAppBaseline: owners.filter((id) => baseline.has(id)),
        writerOwnersMatchingControlledNotesAppOwner: owners.filter((id) =>
          appOwners.some((o) => o.replica === id)
        ),
        preferenceResetRemovedExistingPlist: resetObserved,
        newOwnerInPhaseC: cOwners.some((id) => !abOwners.has(id)),
        preferenceResetComparison: resetObserved
          ? "existing-isolated-domain-archived"
          : "no-existing-domain",
      },
      limitations: [
        ...(evidence.fixtureConditions?.accountReplicaMapConstructed
          ? [
              "The fixture account replica map is constructed metadata; the production account map was not inspected.",
            ]
          : []),
        ...(resetObserved
          ? []
          : [
              "The isolated writer preference domain was absent; reset was a no-op, so deletion of an existing preference plist was not tested.",
            ]),
        "All cfprefsd IPC was denied to protect real preferences. Replica behavior in this experiment may differ from a production process with preferences available; an isolated result alone cannot establish production identity or preference-reset effects.",
      ],
      liveValidated: false,
    },
    privateReplicaLabels: Object.fromEntries([...labels].map(([uuid, label]) => [label, uuid])),
  };
}
