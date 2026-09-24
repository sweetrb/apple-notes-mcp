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
- **Notes with large images stay readable and deletable.** A body embeds its inline images as base64, so a 40 MB image makes a body of about 110 MB. `get-note-content` accepts bodies up to 512 MB, and `delete-note` still compares the whole body before deleting. An error saying Notes.app "returned more than … of output" is a size limit, not a timeout; retrying will not help.
- **`delete-note` checks placement.** If Notes.app accepts the delete but the note is still in its original folder, the call reports that nothing was deleted.
- **`delete-note` and `batch-delete-notes` refuse a note already in Recently Deleted**, where a delete is permanent. The folder is read live from Notes.app; the database only identifies which folder is Recently Deleted.
- **Copy-then-retire with `delete-note`:** after copying note A to note B and verifying B, read both with `get-note-content`, then call `delete-note` on A with `guardNoteId` = B and `expectedGuardContentHash` = B's `contentHash`. The delete stops if B changed, was locked, moved to Recently Deleted, or is a Quick Note. It needs Full Disk Access (the Quick Note flag is only in the database); a B the database has not saved yet still passes on Notes.app's live checks. It is a guard, not a transaction. `requireActiveNoteId` only requires the other note to stay active; it does not fingerprint its content.
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

### delete-folder-by-id
- Prefer it over `delete-folder` when you have an exact folder id. Read the folder with `get-folder-by-id` (it returns `name`, `parentId`, `accountId`, and `isRoot`), call with `dryRun: true`, then apply with the same guards, `dryRun: false`, and `expectedRevision` set to the returned `revision`.
- Pass `expectedRoot: true` for a top-level folder, otherwise `expectedParentId`; exactly one is required.
- It refuses Recently Deleted, smart folders, default and system folders, shared folders, and non-empty folders, with no override. Move or delete the contents first.
- It is not atomic: the guard is a pre-check followed by an AppleScript delete. Messages starting `Conflict:` mean something changed; read and plan again. It needs Full Disk Access.

### Folder scope guards
- `update-note`, `append-to-note`, `delete-note`, and `move-note` accept optional `ifFolderId`, `ifAncestorFolderId`, and `forbiddenAncestorFolderIds` (exact folder ids from `list-folders`).
- Use them when a write should only happen while the note is still where you reviewed it, or must never touch a protected subtree (for `move-note`, the destination is checked against the forbidden list too).
- They are re-checked inside the write's own AppleScript. A failure reads `Scope guard failed: …` and nothing is changed; re-read the note before retrying.

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
- With Full Disk Access, `searchContent: true` reads the Notes database instead of asking Notes.app (`source: "database"` in the response): it matches the full plain text, title line included, scans the 5000 most recently modified notes, and excludes Recently Deleted. Without Full Disk Access it falls back to AppleScript (`source: "applescript"`), which scans every body before `limit` applies and can time out on a broad term; the timeout error then says how to fix it
- `matchedIn` (`["title"]`, `["body"]`, or both; body = text after the first line) appears when the note text came from the database: always on a database body search, and on any search with `includeWordCount`. It is absent for locked notes and for AppleScript searches without `includeWordCount`; its absence is not evidence either way
- `includeWordCount: true` adds `wordCount` (null = locked or unreadable). An AppleScript search reads the bodies in one batched read-only database query, never per note; without Full Disk Access the results stay unchanged and `wordCountUnavailable` says why

### query-notes
- Boolean search read straight from the NoteStore database (read-only, needs Full Disk Access). Prefer it over `search-notes` when Full Disk Access is available: one call matches title **or** body, and it returns in well under a second instead of ~200ms per result
- Syntax: bare words / `"phrases"`; `title:`, `body:`, `text:`, `folder:`, `account:`, `tag:`; `has:link|attachment|checklist|drawing|image|video|audio|pdf|table|scan|tag`; `checklist:open|done`; `pinned`, `locked`, `shared`; `words:>250`; `created:>=2026-07-01`, `modified:<2026-09-01`. AND is implicit; `OR`, `NOT`, leading `-`, and parentheses work. Quote an operator word to search it literally
- Scans the 500 most recently modified notes by default (`scanLimit` up to 5000). When `scanTruncated` is true, older notes were not examined — raise `scanLimit` before concluding a note does not exist
- Excludes Recently Deleted and folderless notes unless `includeDeleted: true`
- Locked notes match on title and metadata only; body predicates never match them
- Each hit has `matchedIn` (where the positive text terms occur: `title`, `body`, or both) when the query has a text term and the body is readable; a `title:` term only counts toward the title and a `body:` term only toward the body. An empty list means the note matched through a non-text branch (`pinned OR x`)
- `includeWordCount: true` adds `wordCount`, the same count `words:` filters on (null = locked or unreadable). A metadata-only query reads just the returned notes' bodies in one extra query
- Result ids chain directly into `get-note-content` and every other id-based tool

### list-notes
- Returns each note's `{title, id}` — not content. **Changed in 2.7.0:** `notes` was `string[]`
- Prefer the returned `id` over the title for any follow-up read/update/move/delete — titles are not unique, and a by-title lookup collapses duplicates onto one note (the `search-notes`/`export-notes-json` identity trap)
- Use `get-note-content` to retrieve full content
- Use `modifiedSince` (ISO 8601 date) to filter to recently modified notes
- Use `limit` to cap the number of notes returned
- Excludes notes in Recently Deleted (counted in `excludedRecentlyDeleted`); `includeRecentlyDeleted: true` lists them flagged `inRecentlyDeleted`

### list-special-notes
- Lists `kind: "pinned" | "quick-notes" | "recently-deleted" | "locked"` from the NoteStore database (read-only, needs Full Disk Access). AppleScript cannot enumerate any of these sets
- Rows are metadata only, newest first, with the usual `x-coredata` `id`; `total` is the match count before `limit` (default 100, max 1000)
- `locked` deliberately includes trashed and folderless locked notes; check `inRecentlyDeleted`, `markedForDeletion`, and `folder` before acting on a row
- `supported: false` means this macOS version's database cannot answer that kind; it is not an error

### list-native-tags
- Pass `folder` for the per-folder tag → note-id map; omit `folder` for an account-wide inventory with `noteCount` per tag (all accounts unless `account` is given)
- `complete: false` with `unverifiedNotes` means some tagged notes (usually locked ones) were counted without confirming the tag in their body

### list-recent-notes (incremental sync)
- Database-backed (read-only, needs Full Disk Access). `since` takes a `modifiedCheckpoint` cursor, or an ISO date or date-time (strictly after that moment)
- With `since`, rows come **oldest first** and `nextSince` is the last row's cursor. Store it and call again with it; every call advances. `saturated: true` (count equals limit) means more changes may follow, so call again right away; `false` means you are caught up
- For a first full sync, start with `since: "1970-01-01"` and page the same way; the maximum `limit` is 1000, and paging reaches every note exactly once
- Without `since`, rows come newest first (a browse view). `nextSince` is then set only when the call returned every matching note
- A modification-date cursor can miss an edit that iCloud delivers later from another device with an older timestamp; run a full pass from the start now and then
- Deletions are invisible unless `includeDeleted: true`, which adds Recently Deleted, notes awaiting deletion, and folderless rows; check `inRecentlyDeleted`/`markedForDeletion` before acting on them. A purged note leaves no row at all
- `modifiedCheckpoint` is exact; the ISO `modified` string is not. Two notes can share the same `modified` text and still differ
- `wordCounts: true` adds `wordCount`/`charCount` (null = locked or unavailable, 0 = known empty). `bodyPreview: true` adds a 180-character preview

### list-folder-tree
- One read for the whole hierarchy with `noteCount` (direct) and `totalNoteCount` (with subfolders), grouped by account; `kind` distinguishes regular, smart, and trash folders

### move-note
- Native move — the note is relocated in place via Notes.app's `move`, so its id, creation date, and embedded attachments are preserved
- The destination folder must already exist (create it first with `create-folder`)
- **Smart folders are refused as destinations** by `move-note`, `batch-move-notes`, `create-note`, `create-note-with-attachment`, and `create-folder` (any path segment): `code: "unsupported"`, `committed: false`, `reason: "smart_folder_destination"`, nothing written. Notes.app would otherwise move the note to Recently Deleted. Pick an ordinary folder from `list-folders`. Needs Full Disk Access to detect; without it the guard is off
- Prefer using `id` parameter to avoid issues with duplicate titles

### add-attachment / create-note-with-attachment
- `filename` sets the name the attachment shows in Notes. It must keep the source file's extension and be a single path component.
- macOS 27: Notes' AppleScript never lists PDF attachments. When AppleScript shows no new attachment, the tool verifies through the read-only NoteStore rows (needs Full Disk Access) and returns `verifiedBy: "database"`; without FDA a PDF attach reports "outcome uncertain", and the PDF was probably created, so read the note before retrying.
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

### list-note-paragraphs / get-paragraph-link
- Paragraph links have the form `applenotes://showNote?identifier=<note>&paragraphID=<paragraph>` and open Notes at that paragraph
- A link is given only when the paragraph's stored ID is `unique` in the note. Notes copies IDs when a paragraph is split, so body paragraphs often share one; `reason: "paragraph-id-shared"` is an expected answer, not a failure. Headings and titles usually link
- Do not build a paragraph link yourself from `get-note-blocks` `paragraphUuid`: it skips the uniqueness check and can open the wrong paragraph
- To link a paragraph, call `list-note-paragraphs` (optionally `linkableOnly: true`) and pick one with a `url`, or call `get-paragraph-link` with `contains`; on `reason: "ambiguous-paragraph"` pass `occurrence` or a longer snippet
- Select the note by `id` (a Notes UUID works too) or exact `title`; `folder` narrows a title using list-folders paths. Title lookups never match a note in Recently Deleted
- Neither tool creates or changes a paragraph ID. A later edit in Notes can replace the ID and break a link
- Requires Full Disk Access; password-protected notes are refused

### get-note-structure
- One read-only call for a note's overview by exact id: text, block summary, links with `kind` (`inline`, `card`, `note`, `section`), tags, attachments, and metadata (`deepLink`, `isShared`, `isLocked`, `inRecentlyDeleted`, `lastViewed`, word/char counts, `attachmentCount`, checklist counts, `hasDrawing`, `firstImage`)
- Attachments use the same `kind`, body order, `previewPath` and `firstImage` as `list-attachments`, so the two tools agree about the same attachment
- Requires Full Disk Access. A locked note still returns metadata and attachments; `bodyDecoded` is false and body-derived fields are null, so do not read null counts as zero
- `lastViewed: null` is normal: check `lastViewedStatus` (`never-viewed` for most notes)
- `attachmentCount` counts top-level attachments; gallery items and recording parts are under `children`
- `previewPath` is Notes' cached rendition (a thumbnail), not the attachment file itself; it is null when Notes has not rendered one
- Check `linkSafe` before emitting a link into HTML

### list-note-links
- Lists links with `kind` (`inline`, `card`, `note`, `section`) in one note (`id`), a `folder` (subfolders included unless `includeSubfolders: false`), an `account`, or the whole library, each with its source note id, title, folder path (as `list-folders` prints it) and account
- Requires Full Disk Access. Folder, account and library scans skip inline links unless `includeInline: true` (it decodes every body in scope); `counts.inline` is 0 then, which does not mean there are none
- `account` resolves like the other tools (exact name, then a unique prefix). A bare folder name must be unique; when it is ambiguous, retry with one of the paths the error lists
- `previewPath` on a card is Notes' cached preview image; it is null when Notes has not rendered one
- Page with `offset: page.nextOffset` while `page.hasMore` is true
- Check `linkSafe` before emitting a link into HTML

### get-capabilities / doctor feature matrix
- Both return `runtimeOS` and a `features` object keyed by feature group (`applescriptCore`, `fullDiskAccessReads`, `backgroundOperationsBridge`, `nativeTagsBridge`, `markdownNoteBridge`, ...). Check a feature's `available` before relying on it, and branch on its machine `reason` (`full_disk_access_missing`, `shortcut_not_installed`, `requires_macos_26`, `not_implemented`, ...) rather than on prose.
- `unverified: ["notes_automation"]` means the probe did not contact Notes.app, not that Automation is denied. Run `doctor` to confirm it.
- Placeholder features (`checklistToggle`, `smartFolders`, `paragraphLinks`, `audioTranscription`) always report `not_implemented`; do not attempt them through other tools.

### export-notes-markdown
- Exactly one of `id` (exact note ID) or `folder` (path, optional `account`, `limit` default 100)
- Renders from the decoded body, so checklist state, tables and attachment positions are exact; `get-note-markdown` is unchanged
- A folder document joins notes with `---`. It is a presentation format: never split it back into notes or use it as a backup
- `outputPath` is create-only; `[output_exists]` means choose a new path, never delete the old file on the user's behalf
- Pass `assetsDir` to copy attachment files; without it attachments are placeholders like `\[Image: name\]`
- Password-protected notes are listed in `skipped`; Full Disk Access is required
- `template` (`standard-markdown`, `obsidian`) or `templateFile` (JSON, exclusive) renders through a Markdown template; the schema is in docs/markdown-templates.md. `standard-markdown` output equals the default export
- `[invalid-template]` lists one `$.json.path: problem` per line: fix those fields, do not guess a new template
- Templated `warnings` (for example `missing_asset`, `assets_dir_required`) do not fail the export; report them

### export-notes-html
- Same selection as `export-notes-markdown`; `outputPath` is required (the HTML is never returned inline) and create-only
- Assets are embedded as data URLs by default. Use `embedAssets: false` (optionally with `assetsDir`) for large media: embedded assets over 10 MiB render as an unavailable marker
- A sidecar directory defaults to `<output stem>.assets`; keep it next to the HTML when moving the file
- Presentation format only: not a backup and not something to import back

### Batch operations
- `batch-delete-notes` and `batch-move-notes` accept at most **500 ids per request** (the limit is enforced at the schema boundary, so an over-long array is rejected before anything runs). Chunk larger sets.
- `batch-move-notes`' destination folder must already exist — create it with `create-folder` first.

### Paper and drawings
- `list-paper-attachments` (note `id`, Full Disk Access) reports each Paper (`com.apple.paper`) or classic drawing with `raster` (format and size of Notes' own rendering) and `handwritingSummary` when Notes stored recognized text.
- `export-paper-image` copies that rendering to a new file. The `savePath` extension must match the format (`.png` for Paper). Pass `attachmentId` when a note has more than one drawing. It never overwrites.
- Strokes are not decoded; there is no public reader for Notes' Paper bundles. Do not describe the export as vector data.

### analyze-svg
- Standalone, read-only analysis of one local SVG file (absolute path in home, temp, or `/Volumes`; at most 1 MiB). It opens no Notes data.
- Branch on `classification` and `requiredLosses`, not on the issue text. `safe` needs no approximation; `lossy` needs `geometry-approximation` or `paint-approximation`; `unsupported` drops visible content or has nothing drawable (`importable: false`).
- Refusals are errors with `svgCode` (`svg_unsafe`, `svg_invalid`, `svg_reference_invalid`, `svg_complexity_limit`, `svg_geometry_invalid`, `svg_file_invalid`). An unsafe file cannot be analyzed with any option; do not try to strip parts of it on the user's behalf.
- `includeDrawing: true` returns the normalized strokes; leave it off unless you need them, since it can be large.

### Attachment paths, first image, and batch export
- `list-attachments` with `includePaths: true` (needs the note `id` and Full Disk Access) adds `assetPaths` (the attachment's own files), `previewPath` (Notes' largest rendered thumbnail, always an image file), and `paths`. Use `assetPaths` when you need the original; a `previewPath` alone means the asset has not downloaded.
- `list-attachments` with `firstImage: true` returns only the lead visual in body order: the first image even when `path` is `null`, else the first scan or drawing, else `null`.
- `export-attachments` copies files into `exportDir` (same allowlist as `save-attachment`, never the Notes data folder). Check `exportedKind`: `"preview"` means you got a thumbnail, not the original. It never overwrites; collisions become `-2`, `-3`.
- Do not hand raw Notes paths to a browser or another tool. Export first.

### get-note-link
- Returns the shareable `notes://showNote?identifier=<uuid>` deep link — use this, not the `x-coredata://` id, whenever a link is meant to be handed to a person, stored in a Reminders task, or opened on iOS
- Primary path reads `ZIDENTIFIER` from the NoteStore database, so it needs Full Disk Access; on macOS 12–15 it can fall back to the AppleScript `note link` property, which macOS 26+ no longer exposes
- Password-protected notes cannot be linked

### get-note-markdown (checklist enrichment)
- Automatically annotates checklist items with `[x]`/`[ ]` when database is accessible
- Falls back to plain list items if Full Disk Access is not granted (no error)
- No action needed — enrichment happens transparently

### get-note-drawings (classic PencilKit drawings)
- Decodes `com.apple.drawing.2` / `com.apple.drawing` attachments into strokes (`inkType`, sRGB `color`, `width`, `points`) and/or SVG (`format: "json" | "svg" | "both"`). Modern Paper sketches (`com.apple.paper`) are not decoded.
- Needs Full Disk Access and the public native helper, built once by the user with `apple-notes-mcp setup --public-helper`. An error mentioning `setup --public-helper` means it is not built or is stale after an upgrade; tell the user to run that command rather than retrying.
- Overall `status` is `none` when the note has no classic drawing. A per-drawing `status: "error"` carries a `code` (`no_data`, `undecodable`, `timeout`, ...) and does not fail the call.
- For large drawings pass `includePoints: false` or `format: "svg"`; the server also drops points itself (`pointsOmitted`) past the response size limit.

### transcribe-note-audio (on-device transcription)
- Transcribes a note's voice recordings and audio attachments on this Mac with the Speech framework (never a server). Same prerequisites as `get-note-drawings`: Full Disk Access and `apple-notes-mcp setup --public-helper`.
- Pass `locale` (BCP-47, default `en-US`) when the speech is not US English. Transcribe long recordings one at a time with `attachmentId`; clients may stop waiting after a fixed time.
- Per-recording `status`: `ok`, `partial` (some text; `code: "incomplete"` or a failed take), `error` (with `code`), or `indeterminate` (the helper timed out; the outcome is unknown, so a retry may work). Overall `none` means the note has no audio.
- `asset_unavailable` can mean the audio file has not downloaded from iCloud, or that the language's on-device speech model is not installed. The server never downloads a model on its own: ask the user before retrying with `downloadAssets: true`.
- The server never shows a permission prompt. `permission_required` means the app hosting this server lacks Speech Recognition access; tell the user to allow it under System Settings > Privacy & Security > Speech Recognition rather than retrying.
- `maxSeconds` (30 to 3600, default 900) caps the whole call; takes not started in time report `time_limit`, so transcribe the rest by `attachmentId`. Cancelling the request stops the helper.
- Use `includeText: false` when only statuses and word counts are needed.

### Private helper tools (opt-in)
- `native-helper-status` and `native-note-state` use Apple's private NotesShared framework through a **read-only** helper the user builds with `apple-notes-mcp setup --native-helper`. They are off unless `APPLE_NOTES_MCP_ENABLE_PRIVATE=1`; each refusal carries the shared error `code` plus a `helperCode` (`disabled`, `helper_not_installed`, `helper_stale`, `helper_modified`, `private_api_unavailable`, `store_unavailable`).
- Always call `native-helper-status` first. Do not suggest enabling the helper unprompted: it is unsupported API and can break on any macOS update.
- The helper cannot write. Write support was deliberately deferred by the maintainer (#204): a second writer beside a running Notes.app, CRDT replica identity, and the iCloud upload lag are unresolved. Use the AppleScript or Shortcuts-bridge tools for edits. `cloudSync.uploadPending` in `native-note-state` shows whether Notes has an upload queued.

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
