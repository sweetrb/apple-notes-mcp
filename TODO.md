# Apple Notes MCP - Improvement Roadmap

_Reviewed 2026-10-02 against upstream 2.9.34 and the open contribution branches._

This is a status map, not a promise to implement every candidate. Shipped public
features, work awaiting review, and possible future work are listed separately.
See [README.md](./README.md) for tool contracts and
[TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md) for implementation limits.

## Open issues and contributions

### Native writer evidence and review

[Issue #181](https://github.com/sweetrb/apple-notes-mcp/issues/181) tracks the
roadmap. Its read-only database/protobuf and Shortcuts/public-helper groups have
merged. The read-only private helper shipped in
[#204](https://github.com/sweetrb/apple-notes-mcp/pull/204); private writes remain
under review in draft [#262](https://github.com/sweetrb/apple-notes-mcp/pull/262).

The writer branch implements in-place edits, compose, checklists, highlights,
link cards, paragraph links, tables, smart folders, Paper drawings and guarded
repair operations. That is implementation progress, not release validation.
Remaining requirements are:

- Dirty-editor trials with a running Notes.app (Q1).
- Full CRDT replica-identity experiments across helper processes and builds (Q2).
- Upload timing verified on a second device, not only local version counters.
- A sanitized, quiescent NoteStore fixture for repeatable copy-store checks,
  including successful prune/purge cases that meet the cloud-state guards.
- Restaging the writer into the maintainer's requested review sequence after
  the evidence is available.

The [disposable-fixture smoke record](./docs/private-writer-validation/fixture-smoke-2026-10-02.md)
does not satisfy Q1, Q2 or second-device validation. Feature validation records
remain unset. Attachment removal and replacement are refused until safe
tombstoning and its validation are implemented. The writer's registration and
per-feature opt-ins are documented in README; a blanket unverified switch does
not enable private writes.

Other open contributions have been separated for review:

| Contribution                           | PR                                                          | Remaining review or validation                      |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| PDF attachment verification follow-up  | [#270](https://github.com/sweetrb/apple-notes-mcp/pull/270) | Review and merge                                    |
| Additional query facets                | [#271](https://github.com/sweetrb/apple-notes-mcp/pull/271) | Review and merge                                    |
| SVG drawings in HTML export            | [#272](https://github.com/sweetrb/apple-notes-mcp/pull/272) | Review; vector output defaults off                  |
| Template editor                        | [#273](https://github.com/sweetrb/apple-notes-mcp/pull/273) | Review; tailnet behavior has not been tested live   |
| Permissions dashboard                  | [#274](https://github.com/sweetrb/apple-notes-mcp/pull/274) | Review; visually verify the optional Swift window   |
| Paragraph anchor registry and resolver | [#275](https://github.com/sweetrb/apple-notes-mcp/pull/275) | Review; resolver server still needs live validation |

Version numbers must be reconciled as these PRs merge. Their presence in a
contribution branch does not mean they have shipped upstream.

### Full Disk Access under Claude Desktop

[Issue #220](https://github.com/sweetrb/apple-notes-mcp/issues/220) remains open
for reports not covered by the current guidance. The reporter confirmed a fix,
and [#227](https://github.com/sweetrb/apple-notes-mcp/pull/227) shipped the doctor
and documentation corrections: Claude Desktop's responsibility disclaimer can
make the Node binary require its own Full Disk Access grant. The guide names the
exact Node path and explains version-manager changes and restart behavior.

A direct-node versus `npx` comparison is optional diagnostic evidence, not a
confirmed outstanding server defect. See the
[Full Disk Access guide](./docs/FULL-DISK-ACCESS.md). Do not reset permissions or
add grants merely to reconcile this roadmap.

## Shipped capabilities

### AppleScript surfaces and body safety

The earlier AppleScript surface checklist is complete: reveal notes, folders,
accounts and attachments; read selected notes and default locations; return
account/folder identifiers and richer attachment metadata; and read native
plaintext ([#41](https://github.com/sweetrb/apple-notes-mcp/pull/41),
[#44](https://github.com/sweetrb/apple-notes-mcp/pull/44),
[#46](https://github.com/sweetrb/apple-notes-mcp/pull/46)).

Safe HTML guidance, body-replacement warnings and Notes-normalized regression
fixtures also shipped. `update-note` replaces the body; attachment-bearing notes
need the documented guarded native append or attachment operations. Do not
write a lossy body returned by a read back into the note.

### Shortcuts and public-framework helpers

The Shortcuts bridge is implemented, not deferred. Public background operations
include native append, Markdown import, real checklist creation, table creation,
note-link insertion, pin changes and supported tag operations. Supported actions
are listed in [get-capabilities](./README.md#get-capabilities) and
[`nativeOperations.ts`](./src/tools/nativeOperations.ts); setup and macOS
requirements still apply.

Markdown task/block import shipped in
[#199](https://github.com/sweetrb/apple-notes-mcp/pull/199). Native append avoids
full-body replacement for its supported subset. Creating checklist items is
distinct from toggling existing items: the latter has no supported public
background action and remains part of the private-writer review. Table creation
does not imply arbitrary cell editing or row deletion.

Classic PencilKit drawing decoding and SVG export shipped in
[#230](https://github.com/sweetrb/apple-notes-mcp/pull/230); Notes-rendered raster
exports are available separately. On-device audio transcription shipped in
[#231](https://github.com/sweetrb/apple-notes-mcp/pull/231), using a locally built
public helper and the documented Speech permission. A Swift helper does not
provide a general API for invoking another app's App Intents.

### Read-only database, structure and exports

The hybrid read path is implemented. Database reads use `sqlite3 -readonly`,
with schema detection and bounded decoding; the project does not require
`better-sqlite3` or `protobufjs`. Reads do not all copy the store first. Preserve
the actual read-only and consistency contracts in each reader; never replace
them with direct SQL writes to the live store.

Shipped features include boolean query search
([#182](https://github.com/sweetrb/apple-notes-mcp/pull/182)), typed note structure,
links, tables, smart-folder reads, ordered HTML export with assets
([#210](https://github.com/sweetrb/apple-notes-mcp/pull/210)), and Markdown export
templates and their local library
([#234](https://github.com/sweetrb/apple-notes-mcp/pull/234),
[#235](https://github.com/sweetrb/apple-notes-mcp/pull/235)). Extra query facets
and vector drawings in HTML exports remain in the open PRs listed above.

The metadata roadmap is partly complete:

- `get-note-metadata` exposes scalar pinned, checklist, trash/recovery, snippet,
  password and smart-folder fields with column detection.
- Attachment tools expose stored UTI, kind, body order, files and previews;
  drawing tools report validated raster dimensions and stored handwriting text.
- `get-audio-transcripts` reads stored word-level transcripts, speakers and
  recording summaries ([#194](https://github.com/sweetrb/apple-notes-mcp/pull/194)).

These specific fields do not amount to a general OCR, classification, location,
sharing-participant or arbitrary archived-metadata API.

## Possible future work

These are proposals or known platform limits, not unfinished implementations
promised for the current PRs:

- **Signed permission broker:** unimplemented. The permissions dashboard and
  locally built helper tools do not supply one. Distribution, signing,
  permission ownership and maintenance need a separate design decision.
- **Additional metadata:** general OCR/image classification, attachment location,
  sharing participants/invitations and other archived fields need schema
  research, a defined output contract and sanitized fixtures. Stored audio
  transcripts and drawing handwriting summaries should not be rebuilt.
- **Foreground-only actions:** recording audio, locks, sharing invitations,
  scanning/markup and unsupported checklist/table edits require a supported
  interface or an explicit product decision. They are not enabled by the
  existing public Shortcuts bridge.
- **New macOS APIs:** reassess Notes' dictionary and App Intents on major macOS
  releases. Do not infer a public cross-app API from the presence of an intent.

## Validation and compatibility

- Keep unit coverage for parsers, feature detection, guards and error outcomes.
  Prefer synthetic or sanitized database fixtures for repeatable read tests.
- Record the exact macOS/helper build and test scope for native behavior. Mock
  tests, protocol tests and a successful write on one note do not prove editor
  concurrency, CRDT identity or iCloud arrival.
- Live integration runs need bounded, explicitly authorized fixtures. Record
  skipped scenarios instead of treating them as passed.
- Preserve existing public fields and compatibility contracts. New draft writer
  safeguards may intentionally tighten apply requirements before release.
- Report partial database coverage and truncation. Measure performance against a
  stated library size and environment before setting latency guarantees.

_Created: December 2025. Last reconciled: October 2026._
