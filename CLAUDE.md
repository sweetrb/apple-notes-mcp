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

**Correct - Windows path:**
```
content: "Path: C:\\Users\\Documents"
```
(One `\\` per literal backslash, exactly as in the shell example above. `\\\\`
is the escaping for a literal *double* backslash — see the table's second row —
so it would store `C:\\Users\\Documents`, not a Windows path.)

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

### create-note / update-note / append-to-note
- Always escape backslashes in content (see above)
- Newlines can be sent as `\n` (this is a valid JSON escape)
- **Title handling:** The `title` parameter is automatically prepended as `<h1>` in the note body. Do NOT include the title in the `content` parameter, or it will appear twice.
- **HTML format:** When using `format: "html"`, do NOT include a `<h1>` tag in `content` — the title is prepended automatically as `<h1>`.
- `create-note` returns the new note's ID for subsequent operations
- **`create-note`'s `folder` must already exist.** It does not create the folder — call `create-folder` first (it is idempotent, so calling it unconditionally is fine). Passing a folder Notes doesn't have fails with a generic "check that Notes.app is configured and accessible" message, which is misleading: Notes.app is fine, the folder isn't there. The same applies to a misspelled `account`.
- **To add to a note, use `append-to-note`, not `update-note`.** `update-note` replaces the whole body; `append-to-note` takes `content` plus `position` (`"after"` default / `"before"` to prepend), `separator`, and `format`, does the read-and-concatenate itself, and always round-trips the body as HTML so existing rich formatting survives.
- **Do not hand-roll read-modify-write from `get-note-content`.** That body is lossy for image-heavy notes: inline base64 images over `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` (default 256 KB) come back as `[inline image omitted: …]` placeholders, flagged as `strippedImages` / `truncated` in `structuredContent`. Writing it back with `update-note` replaces the real images with that text.
- Both `append-to-note` and `update-note` rewrite the full body, so run `list-attachments` first when a note may hold embedded files.

### Checklist Creation Is Not Supported

**You cannot create an Apple Notes checklist (the interactive ☐ / ☑ items) via this MCP server.** This is an Apple Notes limitation, not a server bug.

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

### search-notes
- Set `searchContent: true` to search note bodies **instead of** titles, not in addition to them. The two modes are exclusive, so no single call matches titles or bodies. A title-only search that finds nothing says so in the response; treat that as "no title matched", not "no such note exists", and retry with `searchContent: true`.
- Searches are case-insensitive
- Results include note IDs for reliable subsequent operations
- Use `modifiedSince` (ISO 8601 date) to filter to recently modified notes — useful for large collections
- Use `limit` to cap the number of results returned. **`limit` defaults to 50** — a broad query (e.g. a single common letter) reads several properties per match via AppleScript, so an unbounded search over hundreds of matches times out; the default keeps it useful. The response discloses the applied limit and warns when results were truncated — pass a higher `limit`, or narrow with `folder`/`modifiedSince`, to see more.
- Use `folder` to restrict search to a specific folder (supports nested paths)

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
