# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- **Regression fixtures for Notes-normalized HTML to Markdown.** `src/services/__fixtures__/notesNormalizedHtml.ts` captures representative Apple Notes-normalized bodies (div-wrapped paragraphs, `<div><br></div>` spacer rows, headings, native lists, inline emphasis, `<tt>` code spans) alongside the Markdown `getNoteMarkdown` currently produces, and `notesHtmlMarkdown.test.ts` locks it in. These characterization tests pin two existing quirks so future changes are deliberate: a `<div><br></div>` spacer leaves a stray two-space line (the Markdown-side fingerprint of the whitespace-accumulation behavior), and `<tt>` is dropped so code styling does not round-trip.

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
