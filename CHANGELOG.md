# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.5.10] - 2026-07-08
### Fixed
- **Timeouts were never actually detected in production.** `isTimeoutError` in both executors checked `killed === true || signal === "SIGTERM"`, which is the error shape of the *async* `exec` API. A timed-out `execSync`/`execFileSync` call throws the underlying spawnSync error instead: `code: "ETIMEDOUT"` with `signal` set to the configured kill signal (`SIGKILL`, per #17). So a real timeout fell through to generic error parsing (surfacing as the raw `spawnSync /bin/sh ETIMEDOUT`) and, because the retry gate keys off timeout detection and `ETIMEDOUT` does not match the `/timed? out/i` transient pattern, **timeouts were never retried** despite the retry-on-timeout behavior shipped in #70. The mocked unit tests passed because their fake errors used the async shape; the detection now checks `ETIMEDOUT`/`SIGKILL` first (keeping the old checks as a fallback), the tests use the real error shape, and the fix was verified against a live forced timeout.

### Security
- **AppleScript and JXA no longer pass through `/bin/sh`.** Both executors composed `osascript -e '<script>'` as a shell string for `execSync`, making single-quote escaping the only barrier between note content and arbitrary shell execution, and capping script size at the kernel's argv limit (a sufficiently large generated script — big note bodies — would fail with E2BIG). They now call `execFileSync("osascript", ["-"], ...)` with the script delivered over stdin: no shell is involved at all, so the shell-injection class of bug is structurally impossible, script size is unbounded, and each call saves a `/bin/sh` fork. The retry sleep also no longer forks a `sleep` subprocess per attempt; it blocks in-process via `Atomics.wait`.

## [2.5.9] - 2026-07-08
### Fixed
- **`list-attachments` always returned an empty list.** Both `listAttachmentsById` and `listAttachments` built their output with `repeat with item in attachmentList`; `item` is an AppleScript class name, so the generated script failed to compile ("Expected variable name or property but found class name", -2741) and every call surfaced as zero attachments. The silent empty array defeated the attachment-safety check callers are told to run before `update-note`, which replaces the whole body and drops attachments. The loop variable is renamed, and a regression test now inspects the generated script for reserved loop variables, which the mocked unit tests cannot catch on their own.
- **Attachment URLs no longer leak the literal string `"missing value"`.** `URL of a as text` renders as `missing value` for attachments without a URL (most images); the parsed `url` field is now absent in that case.
- **`save-attachment` no longer misreports successful saves as "attachment not found".** The OK/ERR sentinel interpolated the field separator inside the AppleScript string literal (`return "OK${AS_FIELD_SEP}" & ...`), so the script returned the literal text `OK(ASCII character 31)...` instead of a control character and the TypeScript split never matched, even though the file landed on disk. Separators are now concatenated as expressions, matching the list methods; `show-attachment` had the same quirk in its ERR return and is fixed for consistency. A regression test inspects the generated script for separators inside string literals.
- **`save-attachment` now handles common filesystem and link-preview cases.** `/private/tmp` destinations are allowed, since it is the real directory behind macOS's `/tmp` symlink; missing parent directories are created before asking Notes to save; and link-preview attachments now return a clear error that explains there is no file payload and includes the preview URL.
- **Image-heavy notes no longer kill the MCP connection on `get-note-content`.** Notes returns pasted images as base64 `data:` URIs in the note body; a few photos can produce a response large enough to exceed the client's message limit and drop the stdio transport. Each inline image whose base64 payload exceeds a per-image cap (256 KB default, `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` to override) is now replaced with a placeholder naming the media type and decoded size, and a warning points at `list-attachments` / `save-attachment` / `fetch-attachment` for exporting the real files. Small pasted images stay inline, and note text is not touched.

## [2.5.8] - 2026-07-06
### Added
- **Process-wide reliability knobs for AppleScript execution** (thanks [@oliverames](https://github.com/oliverames), #70). Three env vars now tune the AppleScript layer without a per-call override: `APPLE_NOTES_MCP_TIMEOUT_MS` (default `30000`) raises the per-call timeout for full-library operations on very large Notes libraries; `APPLE_NOTES_MCP_MAX_RETRIES` (default `2`, i.e. one retry) sets the total attempt count for transient failures, with `1` restoring the old fail-fast behavior; `APPLE_NOTES_MCP_RETRY_DELAY_MS` (default `1000`) sets the base retry delay before exponential back-off. Precedence is per-call options → env knob → built-in default; invalid values fall through to the default. A shared `envPositiveNumber()` helper validates all of them (and the existing `APPLE_NOTES_MCP_MAX_BUFFER`) the same way. Documented in the README.
- **`doctor` now checks the Node runtime's code signature** (thanks [@oliverames](https://github.com/oliverames), #70). A new `checkNodeRuntimeSignature()` check inspects `process.execPath` via `codesign` and **warns** when the running Node is ad-hoc signed (no Team ID) — an ad-hoc Node gets a fresh cdhash on every update (e.g. every `brew upgrade`), so macOS TCC silently drops its Automation / Full Disk Access grants, the most common cause of "this worked last week" permission flakiness. The warning points at `docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`; a Developer-ID-signed Node reports `ok` with its Team ID.

### Changed
- **Transient AppleScript failures now retry once by default** (thanks [@oliverames](https://github.com/oliverames), #70). `DEFAULT_MAX_RETRIES` went from `1` (no retries) to `2` (one retry after a 1s delay, backing off exponentially). Retries apply **only** to transient errors (Notes.app busy / not responding / lost connection / timeout); non-transient errors such as "note not found" still fail immediately. Set `APPLE_NOTES_MCP_MAX_RETRIES=1` to restore the previous fail-fast behavior.

### Fixed
- **A bare git clone now runs the server with nothing but Node present (fixes #68).** Committing `build/` (#65) gave a fresh clone the entrypoint, but the compiled output still imported its runtime dependencies from `node_modules/`, which a git clone never has. Claude Code's marketplace auto-update re-clones the plugin from scratch, so every refresh left the server dying at session start on `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`, with no install step anywhere between "marketplace refresh" and "server process starts". `npm run build` now typechecks (`tsc --noEmit`) and bundles `src/index.ts` with esbuild into a single self-contained `build/index.js` (shebang preserved, `@/` path aliases resolved from tsconfig). The only runtime file the bundle reads is `../package.json` (for the version string), which every distribution layout ships. `tsc-alias` is no longer needed and was dropped; the per-module compiled files under `build/` are gone, and only the bundled entrypoint is tracked in git.

## [2.5.7] - 2026-07-03
### Fixed
- **`create-note` now returns a usable note id.** `create-note` returned the raw AppleScript object specifier (`note id x-coredata://<uuid>/ICNote/pN`) — including a literal `note id ` prefix — as the note's `id`. Downstream tools rejected it: `get-note-content id=<that>` failed with `Invalid note ID format: … Expected CoreData URL (x-coredata://...) or temp ID.` The returned specifier is now run through `extractCoreDataId`, so `create-note` returns the bare `x-coredata://` URL that the id validator and all consumers (`get-note-content`, `update-note`, etc.) accept and can round-trip.
- **CI `format:check` restored to green.** `src/index.ts` and `src/utils/attachmentFs.test.ts` had drifted from Prettier style (unformatted code merged via dependabot PR #63), failing the `format:check` CI gate. Reformatted with `prettier --write`.

## [2.5.6] - 2026-06-30
### Fixed
- **`move-note` no longer drops attachments or resets note identity (data-loss fix).** The single-note `move-note` was implemented as copy-then-delete: it rebuilt the note from its body HTML in the destination folder and deleted the original, silently discarding every embedded attachment (files, images, PDFs, scans, audio) and resetting the note's creation date and id. It now uses Notes.app's native `move` command — the same one `batch-move-notes` already used — which relocates the note in place, preserving its id, creation date, and all attachments. The destination-folder-must-exist behavior is unchanged. Tests updated to assert the native `move` path (no `make new note`).

### Added
- **Configurable cap on inline attachment fetch size.** `fetch-attachment` exports an attachment to a temp file and base64-encodes it into the response via `readFileSync`, which previously had no upper bound (`APPLE_NOTES_MCP_MAX_BUFFER` does not apply to `readFileSync`), so a multi-GB attachment could exhaust memory. A size check now runs **before** the read and rejects oversized attachments with a clear error pointing at `save-attachment`. Default 25 MB, overridable via the new `APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES` env var (documented in the README). Temp-dir cleanup is preserved.

### Changed
- **All MCP string/array inputs now have upper bounds.** Every Zod input field previously used only `.min(1)`; sane `.max(...)` caps were added to string fields (query, id, title, content, folder, account, savePath, attachmentId, tags entries, etc.) and array caps (`.max(500)`) to the unbounded `ids` arrays in `batch-delete-notes` / `batch-move-notes`. Limits mirror the bounds the manager already enforced internally. Oversized input is now rejected at the schema boundary with a clear message.
- **`syncDetection` SQLite access converted to `execFileSync`** (argv array, no shell), matching the sibling `checklistParser` / `noteMetadata` callers. The interpolated values were not user-controlled, so this is consistency hardening, not a fix for an exploitable bug.
- **Graceful shutdown on SIGINT/SIGTERM and stdin EOF.** Added signal and stdin `end`/`close` handlers that exit cleanly, alongside the existing `uncaughtException`/`unhandledRejection` net. This server holds no persistent resources, so the impact is low; it brings shutdown behavior in line with the sibling apple-mail server.

### Docs
- **`create-note` `tags`: documented as returned-only.** The `tags` parameter was accepted but never written to Notes.app (Apple Notes tags can't be set via AppleScript). Its description now states that values are echoed back in the response but not applied to the note, and points to in-body `#hashtags` as the way to create real tags. The parameter is still accepted (not dropped) to avoid breaking existing callers.
- **`move-note` tool description** no longer claims a copy-then-delete implementation or warns about attachment loss; it now states the note is relocated in place via the native move.

## [2.5.5] - 2026-06-26
### Changed
- **Release tooling: publish now uses `pnpm publish` over OIDC trusted publishing** (Phase 2 of the npm→pnpm migration), replacing `npm publish`. Still tokenless (no `NPM_TOKEN`) with provenance attestation; the npm trusted-publisher config is keyed to the repo + workflow file, not the CLI, so it is unaffected. **No runtime or library changes** — the published package is byte-for-byte equivalent to 2.5.4; this release exists to validate the pnpm publish pipeline.

## [2.5.4] - 2026-06-25
### Security
- **Hardened `htmlToPlaintext` tag stripping (note export).** The HTML-tag strip now loops until the string stabilizes instead of running a single regex pass, so overlapping angle brackets (e.g. `<<i>>`) can no longer leave residue. Clears the open CodeQL `js/incomplete-multi-character-sanitization` (high) on the export helper. It is export-only formatting (not an injection sink), but this keeps the security scan clean.

## [2.5.3] - 2026-06-25
### Fixed
- Added a process-level uncaughtException/unhandledRejection safety net so a stray error or a broken stdout pipe (EPIPE) on client disconnect can no longer crash the long-lived server; EPIPE now exits cleanly.


## [2.5.2] - 2026-06-24
### Fixed
- **`htmlToPlaintext` (note export) no longer double-unescapes HTML entities.** It decoded `&amp;` before the other entities, so an encoded sequence like `&amp;lt;` (the literal text `&lt;`) was wrongly collapsed to `<`. `&amp;` is now decoded last, so entities round-trip correctly in the exported `plaintext` field. Added unit tests covering each entity and the round-trip case. (Surfaced by CodeQL `js/double-escaping`.)

## [2.5.1] - 2026-06-24
### Security
- **Fixed an AppleScript injection in `list-attachments` (title path).** The `account` parameter was interpolated into the AppleScript `tell account "…"` block without escaping — every other method escapes it — so a crafted `account` value could terminate the string literal and inject AppleScript (e.g. `do shell script`). It is now escaped via `escapePlainStringForAppleScript`, matching the rest of the codebase, with a regression test added. Found by an internal security audit. No other tool was affected (ids/titles/folders were already escaped or schema-constrained).

### Changed
- **Hardened `checklistParser` SQLite access** to use `execFileSync` with an argument array instead of an `execSync` shell string (matching `noteMetadata`). Defense-in-depth — the query was already constrained to a digit-only primary key, so this is consistency hardening, not a fix for an exploitable bug.

## [2.5.0] - 2026-06-24
### Added
- **`get-note-metadata` tool (BETA).** Reads note metadata AppleScript cannot expose — pinned state (`ZISPINNED`), checklist flags, trash/recovery state, preview snippet, and password hint — by querying plain scalar columns on `ZICCLOUDSYNCINGOBJECT` in the NoteStore database. No protobuf decoding (these are not the body blob), opened read-only via `execFileSync` (no shell), with Full Disk Access required. The reader feature-detects columns with `PRAGMA table_info`, so it degrades gracefully as the schema changes across macOS versions, and it resolves trashed notes AppleScript can no longer find. Marked BETA because the private schema is version-dependent. This makes pinned state **readable** for the first time (it remains unsettable); see the updated "Known limitations" note in the README.

### Documentation
- **Apple Notes skill: four added techniques.** Ported field-tested guidance into `skills/apple-notes/SKILL.md` (and the Codex mirror): (1) use `get-note-plaintext` as the quickest way to verify rendered text when stored HTML looks off; (2) do not use decorative separators (horizontal rules, repeated dashes, box-drawing) between sections, since they render inconsistently; (3) treat a `stdout maxBuffer length exceeded` error as an attachment-risk signal alongside the existing ones; (4) an optional technique for taking full control of the title HTML without a duplicate sidebar line (create with a styled `<h1>` then `update-note` with `newTitle: " "`), documented with its CoreData-id-resolution caveat and flagged as advanced, not the default.

## [2.4.0] - 2026-06-23
### Added
- **Regression fixtures for Notes-normalized HTML to Markdown.** `src/services/__fixtures__/notesNormalizedHtml.ts` captures representative Apple Notes-normalized bodies (div-wrapped paragraphs, `<div><br></div>` spacer rows, headings, native lists, inline emphasis, `<tt>` code spans) alongside the Markdown `getNoteMarkdown` currently produces, and `notesHtmlMarkdown.test.ts` locks it in. These characterization tests pin two existing quirks so future changes are deliberate: a `<div><br></div>` spacer leaves a stray two-space line (the Markdown-side fingerprint of the whitespace-accumulation behavior), and `<tt>` is dropped so code styling does not round-trip.
- **Reveal folders, accounts, and attachments in Notes.app.** Three new tools extend the existing `show-note` to the rest of the objects the Notes scripting dictionary's `show` command accepts: `show-folder` (by folder id), `show-account` (by account id), and `show-attachment` (by note id + attachment id, since attachments are note-scoped). Each takes an optional `separately` flag, mirroring `show-note`. This closes the "show or reveal a note, folder, account, or attachment" surface gap from the roadmap; everything is additive AppleScript, and no existing tool changed.
- **`get-note-plaintext` tool.** Reads a note's body as plain text by id or title via the scripting dictionary's read-only `note.plaintext` property, which Notes derives from the body with markup removed. This is more faithful than reading the HTML body and stripping it, and it skips the conversion entirely. `get-note-content` (HTML) and `get-note-markdown` (Markdown with checklist state) are unchanged; this adds a third read shape. Additive — no existing tool changed.

### Changed
- **`update-note` now warns about attachments in its tool description.** A full-body replace can drop embedded files, images, scans, PDFs, or audio, so the description (and the README `update-note` section) now tells callers to run `list-attachments` first when a note may hold them. The skill already carried this guidance; this brings the MCP-visible tool description in line. Description and docs only — no behavior change.

## [2.3.0] - 2026-06-23
### Added
- **All tools now declare an MCP `outputSchema`.** Every tool migrated from `server.tool(...)` to `server.registerTool(...)` so its structured-output shape is advertised in the tool metadata and validated by the SDK. Schemas are intentionally permissive (all fields optional, no `.strict()`, loose element types for arrays) so they describe the output contract without ever rejecting a valid result. No tool names, inputs, descriptions, or handler behavior changed.

## [2.2.0] - 2026-06-23
### Added
- **Full `structuredContent` coverage across all tools.** Filled the last nine gaps so every data-returning and mutation tool now emits a typed `structuredContent` payload alongside its human-readable text: `health-check` (`{ healthy, checks[], fullDiskAccess }`) and the eight mutation tools — `create-note` (`{ ok, id, title, folder?, account? }`), `update-note` (`{ ok, id?, title, shared }`), `delete-note` (`{ ok, id?, title, wasShared }`), `move-note` (`{ ok, id?, title, folder }`), `batch-delete-notes` and `batch-move-notes` (`{ ok, succeeded, failed, results[] }`, the latter also `folder`), and `create-folder` / `delete-folder` (`{ ok, folder }`). Text output is unchanged; agents can now consume results without parsing prose.

### Changed
- **Rewrote the Hermes Agent packaging to match NousResearch's real spec.** `.hermes-plugin/` previously shipped Claude-format JSON (`plugin.json` / `marketplace.json` / `mcp.json`) that Hermes never reads; it now provides a `config.yaml` (a `~/.hermes/config.yaml` `mcp_servers:` snippet) plus a README with the `hermes mcp add` command. The README "Other Hosts" section is corrected to match (Hermes has no plugin/marketplace drop-in; Antigravity uses its native `mcp_config.json`). Claude Code, Codex, and Antigravity packaging are unchanged.

## [2.1.4] - 2026-06-23
### Changed
- Bumped `@modelcontextprotocol/sdk` to ^1.29.0, clearing the remaining `npm audit` advisory (transitive, from the SDK's unused HTTP transport) — `npm audit --omit=dev` is now clean, and the SDK version is in line with the other Apple MCP servers.
- `publish.yml`'s `npm install -g npm@latest` step now retries, so a transient registry `ECONNRESET` no longer aborts a release.

## [2.1.3] - 2026-06-23
### Documentation
- README: added npm-downloads, supported-Node, platform-macOS, and MCP badges next to the existing version/CI/License badges.
- Synced the Codex marketplace skill (`codex/skills/apple-notes/SKILL.md`) with the canonical `skills/apple-notes/SKILL.md`, which had drifted ~100 lines behind (missing several documented tools and the formatting/safety guidance added in #42).

## [2.1.2] - 2026-06-22
### Added
- **Additional AppleScript Notes surfaces (#41).** Three new read-only/UI tools — `show-note` (reveal a note in Notes.app by ID), `get-selected-notes` (the current Notes.app selection), and `get-default-location` (the default account/folder for new notes) — plus richer metadata: folder/account `shared` flags, account `upgraded` state and default folder, and attachment `url`/`created`/`modified`/`shared` fields. Output stays backward-compatible with the prior tab/newline AppleScript format. Thanks @oliverames.

### Tests
- Added branch-coverage tests for the new surfaces (AppleScript failure paths, legacy tab/newline + plain-name fallbacks, and empty-field parsing), keeping `src/services/**` branch coverage above the 80% gate.

## [2.1.1] - 2026-06-22
### Added
- **Hermes and Antigravity plugin packaging (#40).** Adds `.hermes-plugin/` and `.antigravity-plugin/` marketplace manifests plus the Apple Notes skill, so the server installs as a plugin on those hosts alongside the Claude Code and Codex packaging; each launches the published `apple-notes-mcp` via `npx`. Wired into `scripts/sync-plugin-version.mjs` so their versions track `package.json`, and documented in the README. Thanks @oliverames.
- **MCP-visible structured tool descriptions on all 26 tools (#37).** Every tool now registers a description in the `Use when: / Returns: / Do not use when:` shape so agents can pick the right tool without trial and error. The eight write/destructive tools (`create-note`, `update-note`, `delete-note`, `move-note`, `batch-delete-notes`, `batch-move-notes`, `delete-folder`, `save-attachment`) additionally carry explicit `Safety:` wording calling out the confirmation expectation. No tool behavior or parameters changed — descriptions only.

### Documentation
- Added `docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`: why macOS re-prompts for Full Disk Access / Automation when the server runs under an ad-hoc-signed (e.g. Homebrew) Node, and the fix — run it under the official Developer-ID-signed Node so the grant survives Node updates. README and CLAUDE.md now point at it.
- Synced the `package.json` `description` with the canonical GitHub repo one-liner ("…via Claude and other AI assistants").

## [2.1.0] - 2026-06-20

Closes the remaining maturity-parity backlog (#16–#32). Eleven of the seventeen
items were already implemented in the 2.0 line and are now verified/closed; this
release adds the six that remained: partial-coverage diagnostics, batch-op
collapse, inline-hashtag surfacing, an integration suite, and documentation of
the pinned-notes and note-link AppleScript limitations.

### Added
- **Integration test suite against real Notes.app (#31).** New `test/integration.test.ts` + `vitest.integration.config.ts` exercise the full `AppleNotesManager → AppleScript → Notes.app` stack (create → read → hashtags → search → delete, plus stats coverage), run via `npm run test:integration` / `npm run test:all`. The live tests self-skip when no writable Notes account is available, so the suite is safe on CI; a new `integration` CI job runs it on macOS. Default `npm test` (unit) is unchanged.

### Changed
- **Batch delete/move collapsed from N+1 to a single osascript spawn (#26).** `batch-delete-notes` and `batch-move-notes` previously spawned 3–5 `osascript` processes *per note* (existence check + duplicate password check + the mutation, plus copy-then-delete for moves). Each now runs as one app-level script that loops over every id with per-id `try` isolation, so a batch of N notes costs one spawn instead of 3N–5N. Moves use the native `move` command, which preserves note identity and metadata instead of copy-then-delete. Per-item results, ordering, and error messages are unchanged; an invalid id is isolated to its own failed entry without a spawn. Verified end-to-end against real Notes.app.
- **`get-notes-stats` now reports partial-coverage diagnostics (#19).** A single unreachable or locked account (or a failed recent-activity scan) no longer throws away the whole stats result — the healthy scopes are returned and the failures are surfaced as a `coverage` object (`complete`, `scanned`, `covered`, `warnings[]`) in `structuredContent`, with a "⚠️ Partial results" note in the text. Only a total wipeout (no account readable) still throws, so callers can always tell a genuinely empty library apart from a partial failure.

### Added
- **`get-note-content` now surfaces inline hashtags (#29).** The body is parsed for `#hashtag` tokens and they are returned as `hashtags` in `structuredContent`. Parsing matches Notes' own rule (a tag needs at least one letter, so `#123` is ignored) and de-duplicates case-insensitively (`src/utils/hashtags.ts`). Documented that Apple Notes tags are inline hashtags (not a scriptable property), that the `create-note` `tags` param is an app-level pass-through, and that Smart Folders are not scriptable.

### Documented
- **Pinned notes are not supported (#28).** Investigated and confirmed Apple Notes exposes no scriptable `pinned` property (raises AppleScript error `-1700`); pin state lives only in the private Core Data store. Documented in `docs/APPLESCRIPT-LIMITATIONS.md`.
- **Note-to-note links are not exposed (#30).** Investigated and confirmed a note has no `URL`/`link` property (error `-2753`) and no readable/constructable `applenotes://` deep link; the `x-coredata://` `id` is the only stable handle. The `show` command can reveal a note in the UI by id but is intentionally not wrapped as a tool. Documented in `docs/APPLESCRIPT-LIMITATIONS.md`.

## [2.0.1] - 2026-06-19

### Fixed
- **By-title / by-name lookups failed on `&` (and other HTML-significant characters).** `get-note-content`, `get-note-details`, `delete-note`, `update-note`, `search-notes`, `list-attachments` (by title), folder creation, and the new attachment tools were escaping the lookup string with the HTML body-escaper (turning `&` into `&amp;`), so a note titled e.g. "Tom & Jerry" could never be found by title. These now use the literal AppleScript-string escaper. Found during live testing of 2.0.0. (Note bodies, which Notes stores as HTML, still use the HTML escaper — unchanged.)

## [2.0.0] - 2026-06-19

Maturity release bringing apple-notes-mcp to feature/stability parity with apple-mail-mcp.

### Added
- **`doctor` tool** — a richer diagnostic than `health-check`: checks Notes.app reachability, the Automation permission, configured accounts, and Full Disk Access, each reported as ok / warn / fail with actionable advice (`structuredContent` carries the raw `{healthy, checks[]}`). (#22)
- **`save-attachment` tool** — saves a note attachment to disk (`noteId`, `attachmentId`, `savePath`; destination must be under home, a temp dir, or `/Volumes`).
- **`fetch-attachment` tool** — returns a note attachment's bytes as base64 in `structuredContent` (no disk write).
- **Structured tool output** — all read/list/get tools (`search-notes`, `get-note-content`, `get-note-by-id`, `get-note-details`, `list-notes`, `list-folders`, `list-accounts`, `list-shared-notes`, `get-sync-status`, `get-notes-stats`, `list-attachments`, `export-notes-json`, `get-note-markdown`, `get-checklist-state`) now return typed JSON (`structuredContent`) alongside the human-readable text so agents can consume results without parsing prose.
- **MCP resources** — `notes://accounts`, `notes://folders`, `notes://stats`, and a `notes://note/{id}` template (returns the note as Markdown).
- **MCP prompts** — `find-note`, `weekly-review`, `new-meeting-note`.
- **File-based config loader** — reads `~/Library/Application Support/apple-notes-mcp/config.json` (override path via `APPLE_NOTES_MCP_CONFIG_FILE`) and merges `APPLE_NOTES_MCP_*` keys into the environment **without** overriding anything already set. This is the recommended way to configure the server under hosts (e.g. Claude Desktop) that spawn it with a scrubbed environment and ignore the MCP `env` block.
- **`APPLE_NOTES_MCP_MAX_BUFFER` env var** — configures the AppleScript output buffer cap (default 64 MB).
- **Full Disk Access guide** — new `docs/FULL-DISK-ACCESS.md` explaining why checklist-state features need Full Disk Access and how to grant it, linked from the README. (#32)

### Changed
- **Hardened AppleScript execution** — `execSync` now uses a 64 MB `maxBuffer` (configurable via `APPLE_NOTES_MCP_MAX_BUFFER`), `killSignal: SIGKILL`, and every script is wrapped in `with timeout` so a hung Apple Event can no longer wedge the process.
- **Bounded full-library scans** — `get-notes-stats` and recent-activity counts are now counted server-side in AppleScript instead of streaming every note to JS.
- **Locale-independent dates** — dates returned by the server are now parsed independently of the Mac's locale (previously could be wrong on non-US-locale Macs).

### Fixed
- **Data corruption from delimiter collisions** — result parsing now uses ASCII control-character delimiters (US `\x1f` / RS `\x1e`) internally instead of `|||` / commas, fixing corruption when note titles or folder names contained those tokens (e.g. a note titled "Groceries, etc.").
- **Silent empty results** — `read`/`list`/`search`/`stats` tools now surface backend failures as MCP errors instead of returning an empty result that looked like "no data".

### Known limitations / deferred
- **Batch operations run per-note** — `batch-delete-notes` / `batch-move-notes` apply each note individually (AppleScript has no bulk equivalent to IMAP's `UID STORE`/`MOVE`); this preserves per-note success/failure reporting. (#26)
- Pinned-note support (#28), tags/hashtags (#29), note links (#30), and a local integration-test suite (#31) are planned for a future release.

## [1.4.4] - 2026-06-18

### Fixed
- **Folder and account names containing `&` (and other HTML-significant characters) silently matched nothing** — `buildFolderReference()` and `sanitizeAccountName()` escaped names with `escapeForAppleScript()`, which HTML-encodes `&` → `&amp;`. Apple Notes stores folder/account names as plain text, so `notes of folder "R&amp;D"` never matched the real folder "R&D" and the tool returned 0 notes for that folder. Added `escapePlainStringForAppleScript()` (escapes only `\` and `"`, no HTML encoding) and use it for folder and account names; note **body** content still uses the HTML-aware escaper. ([#14](https://github.com/sweetrb/apple-notes-mcp/issues/14) / [#15](https://github.com/sweetrb/apple-notes-mcp/pull/15))

### Changed
- **CI: serialize npm publish runs** to stop the release-race 403 failures (a release lands two pushes → two publish runs; a `concurrency` group makes the second skip cleanly). Matches the guard added to apple-mail-mcp.

## [1.4.3] - 2026-06-01

### Fixed
- **`.mcp.json` now serves both plugin installs and clones** — the marketplace plugin install was broken (no `mcpServers` declared in `plugin.json`), and the clone/contributor workflow ran the *published* `apple-notes-mcp` package via `npx` instead of the local build. These two contexts can't share one entrypoint string because plugin installs need `${CLAUDE_PLUGIN_ROOT}` while clones need `${CLAUDE_PROJECT_DIR:-.}`, and Claude Code does not support nested defaults like `${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}`. The two paths are now decoupled: the root `.mcp.json` uses `${CLAUDE_PROJECT_DIR:-.}/build/index.js` (clone workflow), and `.claude-plugin/plugin.json` declares its own `mcpServers` using `${CLAUDE_PLUGIN_ROOT}/build/index.js` (plugin install). Because `plugin.json` declares `mcpServers`, the plugin no longer auto-loads the root `.mcp.json`, so there is no double-registration. Matches the fix shipped in apple-mail-mcp.

## [1.4.2] - 2026-05-27

### Added
- **Runtime warning for unsupported checklist content** — `create-note` and `update-note` now detect checklist-like input (`<input type="checkbox">`, `class="checklist"|"todo"`, markdown `- [ ]` / `* [ ]` lines) and append a warning to the success response explaining that AppleScript cannot produce real Apple Notes checklists, so the failure mode is no longer silent
- **`detectChecklistAttempt()` utility** in `src/utils/contentWarnings.ts` with 14 unit tests

### Documentation
- **New "Creating Checklists" section in README** — explains why checklist creation is impossible via AppleScript (Apple Notes stores checklists as protobuf paragraph style `103`, which the scripting interface doesn't expose) and documents the ⇧⌘L manual-conversion workaround
- **New "Checklist Creation Is Not Supported" section in CLAUDE.md** — explicit guidance so AI agents stop trying alternative HTML class names, data attributes, or Unicode characters
- **Tool schema descriptions** — `create-note.content` and `update-note.newContent` now mention the checklist limitation so it surfaces in MCP tool listings
- **Known Limitations table** — added a row for checklist creation alongside the existing checklist-state read row

### Fixes Issues
- Closes #11 — "Can't create notes with Checklists (possibly a documentation issue)"

## [1.4.1] - 2026-04-06

### Fixed
- **Nested folder creation** — `create-folder` now supports hierarchical paths (e.g., `"Retro Tech/PC/CPUs"`) by creating intermediate folders and checking existence first to prevent duplicate ghost folders in CoreData
- **Note creation in deeply nested folders** — Fixed AppleScript `-1728` error when creating notes in nested folder contexts by switching to implicit return pattern
- **Updated `create-folder` tool description** — Schema now documents nested path support

### Contributors
- @robschmitt — nested folder creation fix and deep folder note creation fix (PR #9)

## [1.4.0] - 2026-04-06

### Added
- **Hierarchical folder paths** — `list-folders` now returns full paths (e.g., `Work/Clients/Omnia`) using folder IDs to disambiguate duplicates
- **Nested folder support** — `create-note`, `search-notes`, `list-notes`, `move-note`, and `delete-folder` all accept nested paths like `"Work/Clients"`
- **`folder` and `account` parameters on `create-note`** — Create notes directly in a specific folder and account
- **Literal slash escaping** — Folder names containing `/` are escaped as `\/` in paths (e.g., `Spain\/Portugal 2023`)
- **Folder IDs** — `list-folders` now includes the CoreData ID for each folder
- **Input length validation** — Titles (2K), content (5MB), folder paths (1K), account names (200 chars), and folder nesting depth (20 levels) are all validated
- **Security tests** — Injection payloads, malformed IDs, boundary conditions for folder paths

### Security
- **CoreData ID validation** — New `sanitizeId()` validates ID format with regex before embedding in AppleScript, preventing injection via crafted IDs
- **Account name sanitization** — Account names are now escaped in `buildAccountScopedScript()` to prevent AppleScript injection
- **Defense-in-depth** — All ID-based methods (`getNoteById`, `getNoteContentById`, `deleteNoteById`, `updateNoteById`, `moveNoteById`, `listAttachmentsById`) now validate and escape IDs

### Changed
- **Rewrote `listSharedNotes()` output parsing** — Switched from fragile regex/comma-based parsing to delimited `|||` output, fixing potential breakage when note titles contain commas or braces

### Contributors
- Rob Schmitt ([@robschmitt](https://github.com/robschmitt)) — Hierarchical folder paths and nested folder support (PR #8)

## [1.3.1] - 2026-03-27

### Changed
- **createNote uses body-only approach** — Title is now set exclusively via `<h1>` prefix in the note body instead of setting both the `name` property and body. This eliminates title duplication.

### Fixed
- **Title duplication in createNote** — Previously, setting both `name` and `body` caused the title to appear twice in the note. Now only `body` (with `<h1>` title prefix) is used.

### Added
- **Proper backslash and tab handling** in plaintext content encoding — Backslashes are encoded as `&#92;` and tabs are converted to `<br>` to prevent AppleScript escaping issues.

## [1.2.17] - 2025-01-01

### Security
- **Fixed command injection vulnerability** in `moveNote()` - HTML content from notes was not properly escaped before embedding in AppleScript commands

### Changed
- **Improved sleep implementation** - Replaced CPU-spinning busy-wait with efficient system sleep command
- **Added sync status caching** - Sync detection now caches results for 2 seconds to reduce database queries
- **Extracted shared parsing logic** - Consolidated duplicated note property parsing into `parseNotePropertiesOutput()` helper

### Added
- **New helper functions** for cleaner code:
  - `escapeHtmlForAppleScript()` - Safely escape already-HTML content for AppleScript
  - `generateFallbackId()` - Consistent unique ID generation when AppleScript doesn't return one
  - `parseNotePropertiesOutput()` - Shared parsing for AppleScript note property output
  - `clearSyncStatusCache()` - Clear cached sync status for testing/forced refresh
- **Export type definitions** - Added proper TypeScript interfaces for export operations (`NotesExport`, `ExportedNote`, etc.)
- **Additional retry tests** - Coverage for all retryable error patterns (timed out, lost connection, busy)

### Developer Experience
- **ESLint flat config** - Migrated from deprecated `.eslintrc.cjs` to modern `eslint.config.js`
- **Pre-commit hooks** - Added husky + lint-staged for automatic linting on commit
- **Test coverage thresholds** - Enforced minimum coverage (services ≥80%, utils ≥90%)
- **Dynamic version** - Server version now read from package.json instead of hardcoded

## [1.2.16] - 2025-01-01

### Added
- **Collaboration Awareness**
  - `list-shared-notes` tool to find all notes shared with collaborators
  - Warnings on `update-note` when modifying shared notes
  - Warnings on `delete-note` when removing shared notes
  - `listSharedNotes()` method in AppleNotesManager

## [1.2.15] - 2025-01-01

### Added
- **iCloud Sync Awareness**
  - `get-sync-status` tool to check if iCloud sync is active
  - Sync warnings integrated into `search-notes`, `list-notes`, `list-folders`
  - Detection of pending uploads and recent database activity
  - Follow-up verification to detect sync interference

- **JXA Research** (utilities only, not primary executor)
  - `src/utils/jxa.ts` - JavaScript for Automation execution utilities
  - Research documented in `docs/JXA_RESEARCH.md`
  - Finding: JXA is 7.6x slower than AppleScript, not recommended for primary use

## [1.2.14] - 2024-12-31

### Added
- **Markdown Export**
  - `get-note-markdown` tool to retrieve note content as Markdown
  - Uses Turndown library for HTML to Markdown conversion

## [1.2.13] - 2024-12-31

### Added
- **Database Export**
  - `export-notes-json` tool for complete notes backup as JSON

## [1.2.12] - 2024-12-31

### Added
- **Batch Operations**
  - `batch-delete-notes` tool to delete multiple notes by ID
  - `batch-move-notes` tool to move multiple notes to a folder

## [1.2.11] - 2024-12-31

### Added
- **Attachment Listing**
  - `list-attachments` tool to see attachments in a note

## [1.2.10] - 2024-12-31

### Added
- **Verbose Logging**
  - DEBUG environment variable support for troubleshooting

## [1.2.9] - 2024-12-31

### Added
- **Statistics**
  - `get-notes-stats` tool for comprehensive notes statistics

## [1.2.8] - 2024-12-31

### Changed
- Validate note existence before destructive operations
- Better error messages for missing notes

## [1.2.7] - 2024-12-31

### Added
- Retry logic for transient failures (Notes.app not responding)
- Improved error message mapping

## [1.2.6] - 2024-12-31

### Added
- `health-check` tool to verify Notes.app connectivity and permissions

## [1.2.5] - 2024-12-31

### Added
- `folder` parameter to `search-notes` for filtering by folder

## [1.2.4] - 2024-12-31

### Added
- Timeout handling for AppleScript operations (30 second default)
- Password-protected note detection with clear error messages

## [1.1.2] - 2024-12-31

### Fixed

- Search functionality crash when notes have inaccessible containers (orphaned/corrupted notes)
  - Added error handling in AppleScript loop to skip problematic notes instead of failing entirely
  - Search now returns all accessible matching notes even if some cannot be processed

## [1.1.0] - 2025-12-27

### Added

- **Folder Operations**
  - `list-folders` - List all folders in an account
  - `create-folder` - Create a new folder
  - `delete-folder` - Delete a folder

- **Multiple Account Support**
  - `list-accounts` - List all available accounts
  - All tools now accept optional `account` parameter

- **Enhanced Search**
  - `searchContent` option to search note bodies instead of just titles

- **Note Management**
  - `get-note-by-id` - Retrieve note by unique ID
  - `get-note-details` - Get full note metadata (dates, shared status)
  - `update-note` - Update existing note title and content
  - `delete-note` - Delete notes by title
  - `move-note` - Move notes between folders (copy-then-delete)

- **Developer Experience**
  - Comprehensive JSDoc documentation
  - Unit tests with Vitest (121 tests)
  - Integration tests for all MCP tool handlers
  - ESLint and Prettier configuration
  - TypeScript strict mode

### Fixed

- AppleScript escaping for apostrophes (shell quoting issue)
- Newline handling in note content (now converts to HTML breaks)
- Date parsing in getNoteById (handles commas in AppleScript date format)

### Changed

- Complete rewrite of all source code with new architecture
- Updated to Node.js 20+ requirement
- Improved error messages throughout

## [1.0.0] - 2025-01-01

Initial release.

### Features

- Create notes with title and content
- Search notes by title
- Retrieve note content by title
- iCloud account support
