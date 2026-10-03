# Replica identity experiment (maintainer Q2)

This experiment measures character ownership from the actual note-body CRDT
replica table. It requires one dedicated store created using the system Notes
Core Data model, seeded only with a previously authorized synthetic note body.
It never discovers or copies the user's Notes store or opens the user's
preferences. The old `test-private-writer-replica-identity-copy-store.sh` name
forwards to this stricter entrypoint.

## Required private inputs

- A generator manifest adjacent to its dedicated store, in its own directory
  under `/private/tmp` or the operating system temporary directory. It must have
  `schemaVersion: 1`, `syntheticOnly: true`, `shareable: false`,
  `baselineSource: "authorized-synthetic-snapshot"`, `baselinePayloadSha256`,
  `storePath`, and `noteIdentifier`. It must record verified quiescence and
  proven isolation. The store must contain exactly one note-data row.
- The exact authorized Notes.app-authored compressed body, copied into that
  fixture directory. Preserve the synthetic note's identifier privately; do
  not substitute a different note.
- A private controlled GUI edit receipt and before/after snapshots. The edit
  must insert a unique marker, and the after snapshot must be captured after
  the editor closes. The preparer verifies actual blob text, decoded ownership,
  append length, timestamps, and the same note identifier on both snapshots.
  The before snapshot must predate typing; both metadata hashes must match the
  supplied payloads. Notes' normalization
  of boundary newlines is accepted; replacements or other text changes fail.

Prepare the control with explicitly authorized local snapshot paths:

```sh
node scripts/prepare-replica-notes-app-control.mjs \
  --before-json /private/path/before.json \
  --after-json /private/path/after.json \
  --before-payload /private/path/before.zdata \
  --after-payload /private/path/after.zdata \
  --gui-receipt /private/path/gui-receipt.json \
  --output /private/path/notes-app-control.json
```

Run only after the dedicated generator has completed and exited:

```sh
node scripts/test-private-writer-replica-identity-synthetic.mjs \
  --manifest /private/tmp/dedicated-fixture/manifest.json \
  --notes-app-payload /private/tmp/dedicated-fixture/authorized-synthetic-zdata.gz \
  --notes-app-control /private/path/notes-app-control.json
```

The harness verifies the seed and backs up only this one-note synthetic store
to a private experiment directory. It builds the same production writer source
twice through separate compiler invocations. Build A performs five saves,
build B performs five, then build A performs two after archiving any existing
isolated writer preference plist. Every save uses a fresh process, a current
revision guard, and a decoder snapshot. Each saved body must exactly equal the
previous body plus the requested marker and, only when needed, its newline
separator. Same-length substitutions and earlier-content changes fail before
the next write. No live preference plist is read,
deleted, imported, or restored; `HOME` remains unchanged.

Each native process runs under a file-read whitelist, with writes confined to
the experiment directory and all Mach lookups, Mach registrations, and network
access denied. A separate Foundation-only preflight checks the exact policy's
real-preferences and cfprefsd denials and verifies the isolated Foundation home
before NotesShared loads. A failing preflight or save stops the experiment and
retains private diagnostics.

## Evidence and limits

`private-run.json` preserves revisions, PIDs, build receipts, exact replica
tables, decoded plaintext, request markers, and provenance. Each step also
retains its exact private `.zdata` payload for independent reconstruction. `private-replica-labels.json` maps local R1/R2 labels to
the actual replica UUIDs. Keep both files and all blobs private. Only
`public-evidence.json` is designed for review: it contains labels, counts,
per-save ownership deltas, source/binary hashes, and explicit limitations.
Check it before sharing; do not publish the synthetic account metadata or
raw device/replica identifiers.

The report requires exact plaintext preservation as well as a verified replica
owner for every appended UTF-16 unit. A native `verified` response and matching
length counters alone do not establish this. Membership in the baseline replica set does not prove that replica
performed the controlled Notes.app edit; the report computes that owner from
the GUI before/after delta separately.

Blocking cfprefsd protects the user's preferences but can prevent persistence.
An absent isolated plist makes the reset a **no-op**, not a successful test of
deleting existing preferences. Results under this sandbox cannot alone prove
production identity or the effect of resetting production preferences. A
separately authorized production-process cross-check on the exact synthetic
note can test whether the observed per-process behavior agrees. It does not
remove the preference-reset limitation. Record constructed account replica
mapping as a fixture assumption; do not call it observed production metadata.

No result changes the feature's live-validation flags automatically.

## Regression checks without Notes access

```sh
node --test scripts/lib/replica-identity-evidence.test.mjs
node --check scripts/test-private-writer-replica-identity-synthetic.mjs
node --check scripts/prepare-replica-notes-app-control.mjs
bash -n scripts/test-private-writer-replica-identity-copy-store.sh
shellcheck scripts/test-private-writer-replica-identity-copy-store.sh
```
