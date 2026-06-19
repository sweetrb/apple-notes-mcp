# apple-notes-mcp — Stability & Performance Audit

**Date:** 2026-06-19 · **Version audited:** 1.4.4 (`main` @ `bb677d6`)
**Scope:** full codebase — `services/appleNotesManager.ts` (~2375 LOC), `index.ts` (23 tools), `utils/{applescript,jxa,checklistParser,protobuf,syncDetection}.ts`, CI/publish workflows.

This audit measures apple-notes-mcp against the maturity bar set by its sibling
**apple-mail-mcp (v2.1.1)** — robustness, performance, and the maturity surface
(structured output, diagnostics, resources/prompts, config). Findings are ranked
by **impact × likelihood** with rough effort (S/M/L). Many fixes are direct ports
of code already hardened in apple-mail. Line numbers are against `main` @ `bb677d6`.

## Resolution status

| # | Finding | Tier | Issue | Status |
|---|---------|------|-------|--------|
| H1 | `execSync` has no `maxBuffer` cap | High | [#16](https://github.com/sweetrb/apple-notes-mcp/issues/16) | Open |
| H2 | No `with timeout` + SIGTERM wedges Notes.app | High | [#17](https://github.com/sweetrb/apple-notes-mcp/issues/17) | Open |
| H3 | Printable `\|\|\|` / comma delimiters collide with user content | High | [#18](https://github.com/sweetrb/apple-notes-mcp/issues/18) | Open |
| H4 | Swallowed failures return `[]`/`null`/`0` | High | [#19](https://github.com/sweetrb/apple-notes-mcp/issues/19) | Open |
| H5 | Unbounded full-library scans, no partial-result signal | High | [#20](https://github.com/sweetrb/apple-notes-mcp/issues/20) | Open |
| M1 | No `structuredContent` on any tool | Medium | [#21](https://github.com/sweetrb/apple-notes-mcp/issues/21) | Open |
| M2 | No `doctor` tool (incl. Full Disk Access check) | Medium | [#22](https://github.com/sweetrb/apple-notes-mcp/issues/22) | Open |
| M3 | No MCP resources or prompts | Medium | [#23](https://github.com/sweetrb/apple-notes-mcp/issues/23) | Open |
| M4 | No file-based config loader | Medium | [#24](https://github.com/sweetrb/apple-notes-mcp/issues/24) | Open |
| M5 | Locale-fragile date parsing | Medium | [#25](https://github.com/sweetrb/apple-notes-mcp/issues/25) | Open |
| M6 | Batch ops are N+1 osascript fan-out | Medium | [#26](https://github.com/sweetrb/apple-notes-mcp/issues/26) | Open |
| M7 | No `save-attachment` / `fetch-attachment` | Medium | [#27](https://github.com/sweetrb/apple-notes-mcp/issues/27) | Open |
| L1 | Pinned notes not exposed | Low | [#28](https://github.com/sweetrb/apple-notes-mcp/issues/28) | Open |
| L2 | Tags/hashtags not surfaced | Low | [#29](https://github.com/sweetrb/apple-notes-mcp/issues/29) | Open |
| L3 | Note-to-note links not supported | Low | [#30](https://github.com/sweetrb/apple-notes-mcp/issues/30) | Open |
| L5 | No integration test suite | Low | [#31](https://github.com/sweetrb/apple-notes-mcp/issues/31) | Open |
| L6 | Full Disk Access guide + commit this audit | Low | [#32](https://github.com/sweetrb/apple-notes-mcp/issues/32) | Open |

Target release for the fixes: **2.0.0** (full parity with apple-mail), built on a
long-lived `v2` branch, one item at a time with tests, then full regression +
docs + merge.

---

## High

### H1 — `execSync` has no `maxBuffer` cap → ENOBUFS on large output (S)
`src/utils/applescript.ts:324` and `src/utils/jxa.ts:103` call `execSync` with no
`maxBuffer`, inheriting Node's 1 MB default. `export-notes-json` (full-library
JSON), `getRecentlyModifiedCounts` (every note's mod-date across all accounts,
`appleNotesManager.ts:1838-1851`), `get name of notes`, and `get-note-content` on
long notes can exceed it. Over the limit `execSync` throws and the catch path
returns `[]`/`null` — a silent, data-dependent failure. **Fix:** add a 64 MB
default `maxBuffer` (env-overridable) to both executors (port apple-mail #27).

### H2 — No `with timeout` wrap; SIGTERM kill wedges Notes.app (M)
`applescript.ts` wraps nothing in `with timeout` and relies on `execSync`'s
default SIGTERM (timeout detection keys on `signal === "SIGTERM"`, line 88).
Killing osascript with SIGTERM leaves work already dispatched inside the
single-threaded app running, wedging it for subsequent calls (apple-mail #11).
**Fix:** port `wrapWithTimeout()` (a script-level `with timeout` set below the
process timeout) and `killSignal: "SIGKILL"`.

### H3 — Printable `|||` / comma delimiters collide with user content (M)
Output is split on printable tokens a user can type into a note title or folder
name: `|||` and `|||ITEM|||` (~20 sites in `appleNotesManager.ts`), bare commas in
`parseCommaSeparatedList` (`:495`, used at `:1242` and `:1656`), and comma
field-splitting in `parseNotePropertiesOutput` (`:326-345`). A note titled
"Groceries, etc." splits into two phantom notes. **This is a real
data-corruption-on-ordinary-input bug.** **Fix:** switch field/record delimiters
to control chars (`\x1f`/`\x1e`/`\x1d`) and stop comma-splitting list output
(port apple-mail #30).

### H4 — Swallowed failures: error → `return []`/`null`/`0` (M)
On `result.success === false`, many manager methods log to stderr and return an
empty/neutral value, so the caller can't distinguish "operation failed" from "no
notes": search `:808-810`, list `:1212-1216`/`:1239`, folders `:1367-1371`,
accounts `:1652`, `getRecentlyModifiedCounts` `:1852-1853`, and `getNotesStats`
(wrong totals if any folder scan fails). **Fix:** surface failures (throw or a
discriminated result) and add partial-coverage diagnostics (apple-mail #28/#29).

### H5 — Unbounded full-library scans, no partial-result signal (M)
`getRecentlyModifiedCounts` (`:1838-1851`) iterates *every note of every account*
into one giant string; `getNotesStats` (`:1785-1815`) loops account×folder calling
`listNotes` (one osascript spawn) per folder. No bound, no coverage diagnostic —
this both trips H1's buffer and H2's timeout on large libraries. **Fix:** bound
the scan, batch stats into fewer Apple Events, report coverage (apple-mail #24).

## Medium

### M1 — No `structuredContent` on any tool (M)
No tool returns `structuredContent` (grep: none); `export-notes-json` even
stringifies JSON into a text block (`index.ts:955-961`). **Fix:** add
`successResponse`/`errorResponse` helpers carrying typed JSON and emit from all
read/list/get tools (apple-mail A1).

### M2 — No `doctor` tool (M)
Only a thin `health-check` (`index.ts:763`, `appleNotesManager.ts:1687`). **Fix:**
add a `doctor` checking Notes.app reachability, Automation permission, **Full Disk
Access** (required for checklist parsing — a common silent-failure source),
account list, and default-account resolution, with actionable messages +
`structuredContent` (apple-mail C3).

### M3 — No MCP resources or prompts (M)
No `registerResource`/`registerPrompt`. **Fix:** expose resources
(`notes://accounts`, `notes://folders`, `notes://note/{id}`) and prompts
(find-note, create-checklist, weekly-review) (apple-mail D2).

### M4 — No file-based config loader (S)
**Fix:** port `fileConfig` reading
`~/Library/Application Support/apple-notes-mcp/config.json`, merged without
overriding existing env, so settings work when the host app strips the MCP `env`
block (apple-mail 2.1.1) — relevant for the default-account setting.

### M5 — Locale-fragile date parsing (S)
`parseAppleScriptDate` (`:252-266`) feeds AppleScript `(date as text)` into
`new Date()` and falls back to `new Date()` (now) on failure — breaks under
non-en-US locales, corrupting created/modified timestamps and recency counts.
`listNotes`/search already use the locale-safe `whose modification date >=` clause
(`:1188`, `:774`); the read path doesn't. **Fix:** emit ISO-stable date components
from AppleScript (or parse explicitly) and never fall back to "now."

### M6 — Batch ops are N+1 osascript fan-out (M)
`batchDeleteNotes` (`:2041`) and `batchMoveNotes` (`:2088`) loop per id issuing
several separate osascript spawns each. **Fix:** collapse existence/property reads
and mutations into single scripts where feasible, preserving per-item isolation
(apple-mail #31).

### M7 — No `save-attachment` / `fetch-attachment` (M)
`list-attachments` (`:1887`) returns metadata only. **Fix:** add `save-attachment`
(AppleScript `save attachment … in (POSIX file …)`, validated path) and
`fetch-attachment` (base64), mirroring apple-mail.

## Low

- **L1 — Pinned notes** ([#28](https://github.com/sweetrb/apple-notes-mcp/issues/28)): AppleScript `pinned` support is version-dependent; investigate, expose if feasible, else document.
- **L2 — Tags/hashtags** ([#29](https://github.com/sweetrb/apple-notes-mcp/issues/29)): `create-note`'s `tags` is cosmetic (`:608`); Notes tags are inline `#hashtags` not in the dictionary — parse from body and document; smart folders aren't scriptable.
- **L3 — Note-to-note links** ([#30](https://github.com/sweetrb/apple-notes-mcp/issues/30)): weak AppleScript support; investigate/document.
- **L5 — Integration tests** ([#31](https://github.com/sweetrb/apple-notes-mcp/issues/31)): 327 unit tests, no integration suite/CI job; add opt-in tests against a real library (gated).
- **L6 — FDA guide + audit doc** ([#32](https://github.com/sweetrb/apple-notes-mcp/issues/32)): add a Full-Disk-Access setup guide; commit this audit.

## Recommended sequencing

1. **Stability core** (H1–H4): port the hardened executor wholesale from apple-mail
   (`maxBuffer` + `with timeout` + `SIGKILL`), control-char delimiters, stop
   swallowing failures. Highest risk reduction per line; bring over apple-mail's
   buffer/timeout/delimiter unit tests.
2. **Scan safety** (H5, M6): bound and batch the stats/recent scans and the batch
   mutations; add partial-coverage diagnostics.
3. **Maturity surface** (M1, M2): `structuredContent` everywhere + `doctor` (the
   Full Disk Access check is the high-value Notes-specific piece).
4. **Config + dates** (M4, M5): small, isolated ports.
5. **Resources/prompts** (M3) and **attachments** (M7).
6. **Tests + docs** (L5, L6): integration suite + permissions guide.
7. **Notes-specific** (L1, L2, L3): verify AppleScript feasibility first; document
   limits where not feasible.
