# CLAUDE.md - Apple Notes MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server enables AI assistants to interact with Apple Notes on macOS via AppleScript. All operations are local - no data leaves the user's machine.

## Related Documentation

- **[TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md)** - Deep technical research on Apple Notes internals, database structure, protobuf format, and alternative access methods
- **[TODO.md](./TODO.md)** - Prioritized improvement roadmap with stability fixes and new features

## Critical: Backslash Escaping

**When sending content with backslashes to any tool, you MUST escape them.**

The MCP protocol uses JSON for parameters. In JSON, `\` is an escape character. To include a literal backslash:

| You want | Send in JSON parameter |
|----------|------------------------|
| `\` | `\\` |
| `\\` | `\\\\` |
| `Mobile\ Documents` | `Mobile\\ Documents` |

### Why This Matters

If you send a single backslash without escaping:
- The JSON parser interprets `\` as an escape sequence
- Invalid sequences like `\ ` (backslash-space) cause silent failures
- The note creation/update will fail with no clear error

### Examples

**Correct - Shell command with escaped space:**
```
content: "cp ~/Library/Mobile\\ Documents/file.txt ~/dest/"
```
→ arrives as: `cp ~/Library/Mobile\ Documents/file.txt ~/dest/`

**Correct - Regex pattern:**
```
content: "Version pattern: \\d+\\.\\d+"
```
→ arrives as: `Version pattern: \d+\.\d+`

**Correct - Literal double backslash:**
```
content: "In a JSON string, one backslash is written \\\\"
```
→ arrives as: `In a JSON string, one backslash is written \\`

(One `\\` per literal backslash, exactly as in the shell example above. `\\\\`
is the escaping for a literal *double* backslash — see the table's second row —
so sending `\\\\` where you mean a single backslash stores two of them.)

**Incorrect - Will fail:**
```
content: "cp ~/Library/Mobile\ Documents/file.txt ~/dest/"
```

## Tool Usage Tips

### Using IDs for Reliability (Recommended)

All note operations support an optional `id` parameter. **Using IDs is more reliable than titles** because:
- IDs are unique across all accounts
- Titles can be duplicated
- No issues with special characters

**Recommended workflow:**
1. Use `search-notes` or `create-note` to get the note's ID
2. Use the ID for subsequent operations (`get-note-content`, `update-note`, `delete-note`, `move-note`)

```
# Search returns IDs
search-notes query="Meeting"
→ "Meeting Notes (Work) [id: x-coredata://ABC/ICNote/p123]"

# Use ID for reliable operations
get-note-content id="x-coredata://ABC/ICNote/p123"
update-note id="x-coredata://ABC/ICNote/p123" newContent="Updated"
delete-note id="x-coredata://ABC/ICNote/p123"
```

**Other id forms.** Anywhere a note id is accepted, you may also pass the note's Notes UUID (the `identifier` field that list and read tools return, and the value in `notes://showNote?identifier=` links) or its numeric Core Data key (the digits after `p`). The server resolves either to the `x-coredata` id before the tool runs. Both need Full Disk Access; without it they fail with an error naming it, and `x-coredata` ids keep working. A numeric key resolves only to a note, never a folder or attachment. Folder-id tools (`show-folder`, `get-folder-by-id`, `rename-folder`) accept a folder's UUID or numeric key the same way. Prefer `identifier` when you need to store a reference outside this session: it is stable across devices, while `x-coredata` ids are local to this Mac's database.

### create-note / update-note / append-to-note
- Always escape backslashes in content (see above)
- Newlines can be sent as `\n` (this is a valid JSON escape)
- **Title handling:** The `title` parameter is automatically prepended as `<h1>` in the note body. Do NOT include the title in the `content` parameter, or it will appear twice.
- **HTML format:** When using `format: "html"`, do NOT include a `<h1>` tag in `content` — the title is prepended automatically as `<h1>`.
- `create-note` returns the new note's ID for subsequent operations
- **`create-note`'s `folder` must already exist.** It does not create the folder — call `create-folder` first (it is idempotent, so calling it unconditionally is fine). Passing a folder Notes doesn't have fails with a generic "check that Notes.app is configured and accessible" message, which is misleading: Notes.app is fine, the folder isn't there. The same applies to a misspelled `account`.
- **To add to a note, use `append-to-note`, not `update-note`.** `update-note` replaces the whole body; `append-to-note` takes `content` plus `position` (`"after"` default / `"before"` to insert directly below the title line), `separator`, and `format`, does the read-and-concatenate itself, and always round-trips the body as HTML so existing rich formatting survives.
- **Body from a file:** `create-note` takes `contentPath` (an absolute path to a UTF-8 file of at most 1 MiB in home, temp, or `/Volumes`) instead of `content`. Pass exactly one of the two.
- **Markdown title line:** with `format: "markdown"`, a first line that is exactly `# <title>` is removed (plus one blank line), since `title` is supplied separately. A different first heading is kept.
- **`markdownRoute: "html"`** imports Markdown through AppleScript HTML instead of the Shortcut: any account, tags allowed, no real Heading styles. Task items (`- [ ]`, `- [x]`) become list rows starting with a visible ☐ / ☑ character. Those are text, not checkable checklist items; tell the user so. Block quotes, fenced code and inline code are refused on this route, and a `---` line stays literal text; only the Shortcut route imports these natively.
- **`timeoutSeconds`** (1–120) on `create-note`, `update-note`, `append-to-note`, `delete-note`, and `move-note` sets the timeout of each Notes.app automation step for that call. A timed-out write is uncertain: read the note by id before retrying.
- **`delete-note` checks placement.** If Notes.app accepts the delete but the note is still in its original folder, the call reports that nothing was deleted.
- **Do not hand-roll read-modify-write from `get-note-content`.** That body is lossy for image-heavy notes: inline base64 images over `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` (default 256 KB) come back as `[inline image omitted: …]` placeholders, flagged as `strippedImages` / `truncated` in `structuredContent`. Writing it back with `update-note` replaces the real images with that text.
- Both `append-to-note` and `update-note` rewrite the full body, so run `list-attachments` first when a note may hold embedded files.

### insert-link
- Adds one URL to an exact note as its own paragraph: `mode: "raw"` (default) shows the URL, `mode: "hyperlink"` shows `label`. `position` is `"end"` (default) or `"after-title"`; `blankLine` (default `true`) controls the blank line before it.
- Needs the same `expectedContentHash` as `append-to-note`. Notes with native objects route to native end-append and need `scopeText`; only `position: "end"` with `blankLine: true` works there.
- Verified from the note's stored link runs, not the HTML sent: the result carries `linkStored` and `storedUrl` (a bare origin comes back with a trailing `/`).
- A bare URL written as plain text is not linked by Notes. `linked: false` writes it that way on purpose and reports `linkStored: false`.
- Rich URL preview cards cannot be created, and a link cannot be placed inside an existing paragraph. For a link to another note by id, use `insert-note-link`.

### Checklist Creation Is Not Supported

**You cannot create an Apple Notes checklist (the interactive ☐ / ☑ items) via this MCP server.** This is an Apple Notes limitation, not a server bug.

The exception is the Background Operations Shortcut bridge: when `get-capabilities` reports `create-checklist-item` available, `create-checklist-item` appends one real unchecked item and `create-checklist-items` appends several in order (1–20, one bridge run of a few seconds each; a client-side timeout does not stop the server, so read the note before any retry). If `create-checklist-items` returns `ok: false`, only the items in `landed` are verified; read the note before retrying, and retry only items that are not present.

When you send checklist HTML or markdown to `create-note` or `update-note`:

| You send | What Notes.app renders |
|----------|------------------------|
| `<input type="checkbox"> Buy milk` | `Buy milk` (the `<input>` is stripped) |
| `<ul class="checklist"><li>Buy milk</li></ul>` | A plain bulleted list (the class is dropped) |
| `- [ ] Buy milk` in `plaintext` mode | Literal text `- [ ] Buy milk` |

Apple Notes stores checklists as a paragraph style inside a gzipped protobuf blob. AppleScript's `body` interface does not expose paragraph styles, so there is no HTML or markdown input that produces a real checklist.

**What to do when a user asks for a checklist note:**

1. Create the note with `<ul><li>…</li></ul>` items (HTML) or `- ` bullet lines (plaintext) — the list structure is preserved.
2. Tell the user to open the note in Notes.app, select the list items, and press **⇧⌘L** (or **Format → Checklist**) to convert them.
3. Once converted, `get-checklist-state` and `get-note-markdown` can read the done/undone state correctly.

Do not try alternative HTML class names, data attributes, or Unicode characters like `☐` — none of them produce a real checklist. The interface to set paragraph styles simply isn't exposed.

**Exception — Notes' own Markdown importer.** `create-note` with `format: "markdown"` runs the Create Markdown Note Shortcut, and Notes' importer turns `- [ ] item` / `- [x] item` into real checklist items with that done state, `> text` into a block quote, a bare ```` ``` ```` fence into Monospaced paragraphs, a `---` line (after a blank line) into a divider, and `` `inline code` `` into highlighted text (not monospace). The server verifies each construct by exact-ID readback. These constructs are gated separately as `create-note-markdown-blocks` in `get-capabilities`. `append-native`'s Markdown refuses them, because its converter flattens them to plain text. `markdownRoute: "html"` does not map them either: it renders `- [ ]`/`- [x]` as ☐ / ☑ glyph rows, keeps `---` as literal text, and refuses the rest.

### Whitespace Accumulation on Iterative Updates

**Important:** When repeatedly updating a note (especially with HTML content), Apple Notes can accumulate whitespace artifacts - specifically `<div><br></div>` tags that persist between sections even after removing them from your content.

**Symptoms:**
- Large gaps appear between sections that weren't in your content
- Reading the note back shows multiple blank `<div><br></div>` lines
- The whitespace persists even when you update with clean content

**Cause:** Apple Notes' internal HTML processing preserves empty divs from previous edits. Each update can leave behind formatting artifacts.

**Solution:** If a note has accumulated unwanted whitespace:
1. Delete the note with `delete-note`
2. Create a fresh note with `create-note`

This is more reliable than trying to fix the whitespace through updates, as the artifacts are baked into the note's internal representation.

### Folder Paths (Nested Folder Support)

All folder operations support hierarchical paths using `/` as a separator:
- `"Work"` — simple folder name
- `"Work/Clients"` — nested path (folder "Clients" inside "Work")
- `"Work/Clients/Omnia"` — deeply nested path
- `"Travel/Spain\/Portugal 2023"` — literal slash in folder name escaped as `\/`

This works in: `create-note` (folder param), `create-folder`, `search-notes`, `list-notes`, `move-note`, `batch-move-notes`, `delete-folder`.

`create-folder` is the one that *creates* a hierarchy: pass it a whole path and every missing segment is created, existing ones skipped. It is idempotent — an already-existing folder is not an error — so call it before any `create-note` / `move-note` / `batch-move-notes` that targets a folder you have not confirmed exists.

`list-folders` returns full hierarchical paths, so duplicate folder names (e.g., multiple "Archive" folders) are disambiguated.

### list-smart-folders
- Read-only; reads the NoteStore database, so it needs Full Disk Access
- Each smart folder's rules come back as `match` (`all` / `any` / `none`) plus `filters`; each filter has a readable `description`, and `excluded: true` marks an Exclude rule. Nested rule groups are filters of type `group`
- `query` is the stored query without Notes' outer `{"deleted": false}` wrapper; `rawQuery` is the stored JSON verbatim
- **Check `fullyDecoded`.** When false, at least one rule is a filter of type `unknown`; report it from `value` rather than guessing its meaning
- `includeMatchingNotes: true` asks Notes.app which notes each smart folder currently shows (`matchingNoteCount`, `matchingNotes`, capped by `limit`, default 50). This is Notes' own evaluation, not a re-implementation of the rules

### search-notes
- Set `searchContent: true` to search note bodies **instead of** titles, not in addition to them. The two modes are exclusive, so no single call matches titles or bodies. A title-only search that finds nothing says so in the response; treat that as "no title matched", not "no such note exists", and retry with `searchContent: true`.
- Searches are case-insensitive
- Results include note IDs for reliable subsequent operations
- Use `modifiedSince` (ISO 8601 date) to filter to recently modified notes — useful for large collections
- Use `limit` to cap the number of results returned. **`limit` defaults to 50** — a broad query (e.g. a single common letter) reads several properties per match via AppleScript, so an unbounded search over hundreds of matches times out; the default keeps it useful. The response discloses the applied limit and warns when results were truncated — pass a higher `limit`, or narrow with `folder`/`modifiedSince`, to see more.
- Use `folder` to restrict search to a specific folder (supports nested paths)

### query-notes
- Boolean search read straight from the NoteStore database (read-only, needs Full Disk Access). Prefer it over `search-notes` when Full Disk Access is available: one call matches title **or** body, and it returns in well under a second instead of ~200ms per result
- Syntax: bare words / `"phrases"`; `title:`, `body:`, `text:`, `folder:`, `account:`, `tag:`; `has:link|attachment|checklist|drawing|image|video|audio|pdf|table|scan|tag`; `checklist:open|done`; `pinned`, `locked`, `shared`; `words:>250`; `created:>=2026-07-01`, `modified:<2026-09-01`. AND is implicit; `OR`, `NOT`, leading `-`, and parentheses work. Quote an operator word to search it literally
- Scans the 500 most recently modified notes by default (`scanLimit` up to 5000). When `scanTruncated` is true, older notes were not examined — raise `scanLimit` before concluding a note does not exist
- Excludes Recently Deleted and folderless notes unless `includeDeleted: true`
- Locked notes match on title and metadata only; body predicates never match them
- Result ids chain directly into `get-note-content` and every other id-based tool

### list-notes
- Returns each note's `{title, id}` — not content. **Changed in 2.7.0:** `notes` was `string[]`
- Prefer the returned `id` over the title for any follow-up read/update/move/delete — titles are not unique, and a by-title lookup collapses duplicates onto one note (the `search-notes`/`export-notes-json` identity trap)
- Use `get-note-content` to retrieve full content
- Use `modifiedSince` (ISO 8601 date) to filter to recently modified notes
- Use `limit` to cap the number of notes returned

### move-note
- Native move — the note is relocated in place via Notes.app's `move`, so its id, creation date, and embedded attachments are preserved
- The destination folder must already exist (create it first with `create-folder`)
- Prefer using `id` parameter to avoid issues with duplicate titles

### add-attachment / create-note-with-attachment
- `filename` sets the name the attachment shows in Notes. It must keep the source file's extension and be a single path component.
- `create-note-with-attachment` creates the note, then attaches. If the attach step fails, the error names the new note's id: call `add-attachment` on that id rather than repeating the tool, which would create a second note.

### create-table
- Omit `rows` for an empty 2 × 2 table (the size Notes inserts from Format > Table).

### get-checklist-state
- Requires note ID (not title) — use `search-notes` to find the ID first
- Reads directly from the NoteStore SQLite database (not via AppleScript)
- Requires Full Disk Access for the MCP host process
- **There is no `null` result.** A successful call returns `items` / `checked` / `total`; every other outcome is an MCP **error response** (`isError: true`), including the routine "this note simply has no checklist". Distinguish them by the message text:
  - `"This note does not contain any checklist items."` — the note parsed fine and has none. Not a failure; report it as an empty checklist.
  - `"No data found for this note in the database."` — no row for that note (e.g. not yet synced to the local store).
  - `"Full Disk Access is required to read checklist state. …"` — permission, not data.
  - `"Invalid note ID format: …"` — the id isn't an `x-coredata://…/ICNote/pNNN` URL.
  - `"Failed to decompress note data."` — the stored blob wasn't parseable.
  - Plus note-not-found and password-protected errors raised before the database is touched.
- Works independently of `get-note-content` — use both for full picture

### get-audio-transcripts
- Reads the transcript (and summary, if any) that Notes already computed for each audio recording in a note, by note id. It never transcribes audio itself
- Requires Full Disk Access; reads the NoteStore database read-only. Password-protected notes are refused
- One entry per top-level audio attachment, in body order. Check each entry's `status`: `ok` has `text`; `none` means Notes stored no transcript (not a failure); `undecodable` carries a `reason`
- `includeSegments: true` adds word-level `segments` (text, start, duration, speaker), capped per attachment by `maxSegments` (default 2000). Leave it off unless word timings matter; it multiplies the response size
- The `attachmentId` works with `save-attachment` if the user also wants the audio file

### get-note-tables
- Requires the note ID; reads the NoteStore database read-only (Full Disk Access)
- Returns every native table in body order as GitHub-flavored Markdown (`markdown`, first row as header) and as JSON (`tables[].rows`, `rowIds`, `columnIds`)
- A note with no tables succeeds with an empty `tables` list; it is not an error
- **Check `tableCellsComplete`.** When false, an undecodable cell is `null` in `rows`, listed in `incompleteCells`, and shown as `[undecoded cell]` in Markdown; a table that cannot be decoded at all has `complete: false`, a `reason`, and no rows. Never fill those cells in
- Cell text only: links and styling inside cells are not rendered
- Password-protected notes are refused

### get-note-blocks
- Read-only structure of one note by exact id: paragraph styles, indent, alignment, block quote, checklist state, inline formatting, links, and attachment positions
- Requires Full Disk Access; password-protected notes are refused with `[encrypted]`
- Paged: while `page.hasMore` is true, call again with `offset: page.nextOffset`
- Offsets count UTF-16 code units, like `links` in `get-note-content`
- `paragraphUuid` is not unique per paragraph. Do not use it as a key
- `link` is the stored URL; check `linkSafe` before emitting it into HTML
- Read-only view: do not build a full-body update from it

### get-capabilities / doctor feature matrix
- Both return `runtimeOS` and a `features` object keyed by feature group (`applescriptCore`, `fullDiskAccessReads`, `backgroundOperationsBridge`, `nativeTagsBridge`, `markdownNoteBridge`, ...). Check a feature's `available` before relying on it, and branch on its machine `reason` (`full_disk_access_missing`, `shortcut_not_installed`, `requires_macos_26`, `not_implemented`, ...) rather than on prose.
- `unverified: ["notes_automation"]` means the probe did not contact Notes.app, not that Automation is denied. Run `doctor` to confirm it.
- Placeholder features (`checklistToggle`, `smartFolders`, `paragraphLinks`, `audioTranscription`) always report `not_implemented`; do not attempt them through other tools.

### Batch operations
- `batch-delete-notes` and `batch-move-notes` accept at most **500 ids per request** (the limit is enforced at the schema boundary, so an over-long array is rejected before anything runs). Chunk larger sets.
- `batch-move-notes`' destination folder must already exist — create it with `create-folder` first.

### get-note-link
- Returns the shareable `notes://showNote?identifier=<uuid>` deep link — use this, not the `x-coredata://` id, whenever a link is meant to be handed to a person, stored in a Reminders task, or opened on iOS
- Primary path reads `ZIDENTIFIER` from the NoteStore database, so it needs Full Disk Access; on macOS 12–15 it can fall back to the AppleScript `note link` property, which macOS 26+ no longer exposes
- Password-protected notes cannot be linked

### get-note-markdown (checklist enrichment)
- Automatically annotates checklist items with `[x]`/`[ ]` when database is accessible
- Falls back to plain list items if Full Disk Access is not granted (no error)
- No action needed — enrichment happens transparently

### Multi-account
- Omitting `account` targets whatever Notes.app reports as its **`default account`** — which is often, but not necessarily, iCloud. Since 2.7.1 the server resolves that name at runtime instead of assuming the literal `"iCloud"`, so it is also correct for a localized account name, a non-iCloud default, or a name carrying a trailing U+F8FF ()
- Use `list-accounts` to see available accounts
- Pass `account` parameter to target specific account
- When using `id`, account is not needed (IDs are globally unique)

## Sync and Collaboration Awareness

### iCloud Sync
- Use `get-sync-status` to check if sync is in progress
- `search-notes`, `list-notes`, and `list-folders` will warn if sync is active
- If you get incomplete results, wait a moment and retry

### Shared Notes
- Use `list-shared-notes` to find notes shared with collaborators
- `update-note` and `delete-note` will warn when modifying shared notes
- Changes to shared notes are immediately visible to all collaborators

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "Notes.app not responding" | Notes.app frozen or not running |
| "Note not found" | Title doesn't match exactly (case-sensitive) |
| Silent failure | Backslash not escaped in content |
| "Permission denied" | macOS automation permission needed |
| "iCloud sync in progress" | Wait and retry - results may be incomplete |
| "No checklist items found" | Note has no checklists, or Full Disk Access not granted |

Every error result (`isError: true`) also carries `structuredContent.code`: `not_found`, `ambiguous`, `permission_denied`, `full_disk_access_missing`, `shortcut_not_installed`, `timeout_indeterminate`, `verification_failed`, `revision_conflict`, `validation_error`, `unsupported`, `notes_unavailable`, or `operation_failed`. Prefer it over matching message text. When `indeterminate` is `true`, the write may or may not have happened: read the note by exact id before any retry. `committed: false` means nothing was written, so re-reading and retrying is safe. Input-schema rejections raised by the MCP SDK itself carry no code.

## Recurring macOS permission prompts → offer the official-Node fix

If a user reports being **repeatedly** prompted for Full Disk Access or
Automation for "node" (especially after a `brew upgrade`), or that this MCP
loses its permissions every so often, the cause is almost always an **ad-hoc
signed Node** (typically Homebrew's) whose cdhash changes on every update, so
macOS TCC keeps treating it as a brand-new binary.

Detect it:

```bash
codesign -dvvv "$(which node)" 2>&1 | grep -E 'Signature=adhoc|TeamIdentifier=not set'
```

If that matches (ad-hoc / no Team ID), **offer to migrate this MCP to the
official Developer-ID-signed Node** per
[`docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`](docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md):
install an official LTS Node to a stable path (e.g. `~/mcp-runtime/node-current`),
repoint this server's `command` at it, and have the user grant the permission
once — it then persists across Node updates. Do not repoint `npx`-launched
servers that don't need Full Disk Access.
