# Writer evidence continuation — 2026-10-03

These are bounded experiments on newly created disposable notes and freshly
generated synthetic stores. They are not release validation. No private writer
feature flag has been promoted. The production writer source SHA-256 was
`3fff29256539f7a7751db82298c956c8a54f260a28cb5bffc27ef397576f38cb`.

## Contributor closeout

On 2026-10-03 the contributor accepted the current work and stopped the
remaining experiments. No further user testing or phone response is
requested. All three continuation fixtures were moved through the guarded
Recently Deleted route after fresh exact-content/folder checks; the empty
test folder and private evidence are retained. The earlier three fixtures
were already recoverably removed.

The missing dirty-editor, independent-device, preference-reset and
prune/purge evidence remains **unverified**, not passing. This closes the
contributor task; it does not waive the maintainer's review criteria or
authorize release. The writer remains draft under the existing hold, with
release-validation gates unchanged. Acceptance of the evidence and the
requested staged return are now explicit owner review decisions.

## Replica ownership (Q2)

A controlled insertion through the actual Notes.app editor added 34 UTF-16
units. Independent before/after payload decoding attributed the insertion to
the existing Notes.app replica, labeled R1 here. The exact note identity,
editor observations, source blobs and timestamps are retained privately;
actual replica UUIDs and account metadata are not included in this report.

Two separately invoked production writer processes then appended to that
same disposable note using normal preferences, with no home override or
explicit preference changes. Both writes committed and verified. Independent
payload checks confirmed that the previous text was preserved and each
expected marker was added exactly once.

| Step | Added UTF-16 units | Owner | Replica count | Matches Notes.app owner |
| --- | ---: | --- | ---: | --- |
| GUI control | 34 | R1 | 1 | Yes |
| Production process 1 | 40 | R14 | 2 | No |
| Production process 2 | 41 | R15 | 3 | No |

The two production observations agree with the initial isolated 12-save
experiment: each process produced a new owner. The isolated run used two
separate builds of the same source, five saves per build, then two saves
after an isolated preference-reset checkpoint. Its preference file was
absent, so that checkpoint was a no-op. Blocking cfprefsd confines the
experiment but can prevent preference persistence. These observations do
not establish the effect of deleting an existing preference file.

The initial isolated run verified ownership and lengths. The revised
[reproducible experiment](../../scripts/replica-identity-experiment.md) then
passed all 12 saves with exact expected plaintext at every step. Independent
review re-decoded all 13 retained payloads. Its owners were R2–R13; exact
private comparison confirmed that the production owners R14–R15 were also
distinct from all isolated owners. Labels are consistent across both arms.
The [sanitized result](replica-identity-2026-10-03.json) retains per-save clocks
and ownership deltas. The fixture’s account-to-replica mapping is constructed
test input, not copied production metadata.

## Mac display and independent-device sync

A separate supported Computer Use session successfully controlled this Mac.
After a native append with no nudge or relaunch, the exact synthetic marker
was confirmed in stored text and in the Mac Notes GUI at 00:15:10 UTC. The
append returned at 00:04:33 UTC; the later observation bounds visibility but
does not measure when the GUI first adopted the change.

The baseline had been confirmed on an independent iPhone. Its first reported
post-write observation showed only the baseline. A fresh phone observation
was not collected before the contributor stopped the experiments. Local status at 00:08:48 UTC still showed
version 4 pending against cloud version 1. At 01:05:44 UTC it reported cloud
version 4, with the target upload recorded. The wide polling interval does
not establish an exact upload time. Opening the Mac fixture is itself a
recorded intervention; two other synthetic replica writes also occurred
during this interval. Neither counters nor Mac display prove arrival on
the phone. No sync nudge or relaunch has run in this phase.

## Dirty editor (Q1)

A one-shot harness and exact-note GUI protocol are prepared. The harness
requires a fresh visible marker absent from persisted text, reads a fresh
revision, and rechecks the GUI signal and stored payload immediately before
spawning at most one append. It records content and timing privately and
stops on cancellation or uncertainty. It does not suspend Notes, disable
autosave, or infer a dirty editor from a running application.

The first coordination trial reached its two-minute limit without a GUI
signal: no append was attempted. Further trials were stopped at contributor closeout; no fresh trial is requested.
Even a sampled dirty window does not by itself prove that the editor was
dirty at the exact native commit instant. The default running-Notes refusal
remains in place.

## Generated store and CI

The [synthetic-store harness](synthetic-store.md) creates a new Core Data
store using the installed Notes model and entirely fabricated source data.
It reads no personal store. Native processes run under a file allowlist with
writes confined to the scratch directory and Mach service/network access
denied. Actual append and rich-compose operations are exercised alongside
feature-gate and digest refusals. The CI workflow runs on macOS and uploads
no store, preference file, or native reserialized payload.

This supplies a repeatable store for those operations. It does not establish
live-editor concurrency, cloud arrival, or successful prune/purge behavior.

The final local generated-store run passed all ten native checks, including
exact plaintext and heading/bold assertions, on macOS 27.2. The installed
model hash was `24070002f26ccff5d326c8487e71cd86c18ca1008acf5fd97853261f1f7bb0af`.
The report records generator/source/binary hashes and the initial SQLite
hash; generated database bytes remain private. Hosted CI is a separate
check and is not inferred from this local result.

The harness also passes 54 pure fixture/evidence/filesystem tests and 20
existing decoder tests. File validation and reads use the same open
descriptor, rejecting symlinks and hard links. Preference archival moves
the isolated entry into a fresh private directory before reading it; an
unsafe entry remains recoverable there. These five filesystem regressions
were added after hosted CodeQL identified three check/reopen races.
