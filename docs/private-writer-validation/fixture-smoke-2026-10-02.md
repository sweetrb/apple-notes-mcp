# Disposable-fixture smoke test, 2026-10-02

This is partial development evidence for draft PR #262. It does **not** validate
any private-writer feature for release. All validation registry entries remain
null. Q1 dirty-editor behavior, complete Q2 replica identity, and second-device
upload observations remain outstanding.

## Environment and scope

- macOS 27.2; Notes 4.13; Node 26.10.0; Apple clang 21.
- Writer source SHA-256: `3fff29256539f7a7751db82298c956c8a54f260a28cb5bffc27ef397576f38cb`.
- Current source-built MCP bundle over stdio, with a scratch helper installation;
  installed plugin binaries and permission settings were unchanged.
- Automation and Full Disk Access passed the connector health check.
- Two synthetic notes in one newly created, uniquely named disposable folder.
  Exact note/folder IDs, before/after bodies and hashes, tool requests, responses,
  and attachment bytes were retained in the local test journal. No pre-existing
  personal note was edited or deleted.

## Observed results

| Check | Result |
| --- | --- |
| Public create, exact-ID read, append, update | Passed; fresh readback and changed content hashes |
| Public stale append/update hashes | Refused; content and hash unchanged |
| Native edit/compose dry-run plans | Returned real revisions and plan digests |
| Missing edit/compose digest | Refused before mutation |
| Valid plan without feature-specific opt-in | Refused `not_live_validated` |
| Altered edit/compose digest | Refused `plan_mismatch` |
| Native text edit and compose apply | `committed: true`, `verified: true`; public connector readback matched |
| Running Notes without experimental override | Refused `notes_app_running`; tested with a no-op edit request |
| Sync nudge without feature-specific opt-in | Refused `not_live_validated`; no nudge ran |
| File bytes changed after compose plan | Refused `plan_mismatch`; note unchanged |
| Compose synthetic PNG with valid plan | Committed and verified; connector-fetched bytes matched source SHA-256 |
| Attachment removal plan | Refused `unsupported_attachment_change` |
| Cleanup | Both exact notes moved once to Recently Deleted with fresh hashes and folder guards; folder readback empty |

Positive private-write trials explicitly used `ALLOW_UNVERIFIED_EDIT`,
`ALLOW_UNVERIFIED_COMPOSE`, and the process-local `ALLOW_NOTES_RUNNING` test
switch on the recorded synthetic note. This tests ordinary fixture writes while
Notes is running; it does not exercise an unsaved editor. No quit/relaunch,
sync nudge, permanent deletion, or Recently Deleted purge was performed. The
empty disposable folder was retained.

The first edit-refusal attempt omitted required `dryRun: false` in the test
client and was rejected by schema validation. The client was corrected and the
same fixture reused; the intended refusal tests then passed. This was a test
client error, not a product failure.

## Replica decoder observation

Read-only snapshots of these two synthetic notes exposed paired zero-length
boundary records (`replica=0`, clocks `0` and `UINT32_MAX`). They incorrectly
selected zero-based owner indexing even though character owners were one-based.
The decoder now excludes only that recognized boundary pair from owner inference
and counts, preserving diagnostics for arbitrary zero-length records and support
for real zero-based owners. Four constructed regressions cover the fix. Offline
replay of the saved fixture payloads maps all 140/140 and 118/118 live UTF-16
characters without warnings. This establishes decoding correctness for the
fixtures, not replica-identity behavior across processes, binaries, or preferences.

## Public attachment metadata follow-up

A third disposable note received the same synthetic PNG through the public
`add-attachment` connector. Both public and private attachments reported
`contentType` equal to `contentId`. This is the documented compatibility alias
introduced in 2.6.7, not a writer defect. Reading the public fixture with
`list-attachments` and `includePaths: true` returned the actual `uti: public.png`.
Tool text and documentation now label the alias accurately; response fields and
values are unchanged. The third note was also moved once to Recently Deleted
with fresh hash and folder guards. The retained disposable folder is empty.

## Remaining evidence

The broad live integration suite and copy-store harnesses were not run: they
are not limited to these recorded fixtures. No sanitized quiescent NoteStore
fixture exists for copy-store CI or successful prune/purge validation. The
permissions checklist UI was not inspected because this session exposes no
Computer Use runtime. No live-validation flag may be promoted from this smoke
test alone.
