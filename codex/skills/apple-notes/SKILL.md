---
name: apple-notes
description: Use this skill when the user wants to interact with Apple Notes on macOS - creating, searching, reading, updating, deleting, organizing, or formatting notes and folders. This skill provides access to Apple Notes through MCP tools and includes safe formatting guidance.
---

# Apple Notes Skill

This skill enables you to manage Apple Notes on macOS through natural language. Use it whenever the user mentions notes, wants to save information to Notes, or needs to retrieve, update, or organize their notes.

## When to Use This Skill

Use this skill when the user:

- Wants to create a new note or save information
- Asks to find, search, or look up notes
- Wants to read the contents of a note
- Needs to update or edit an existing note
- Wants to delete or remove a note
- Asks to move or organize notes into folders
- Wants to list their notes or folders
- Mentions Apple Notes, Notes app, or "my notes"

## Available Tools

### Note Operations

| Tool                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create-note`           | Create a new note with title and content                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `search-notes`          | Find notes by title or content                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `query-notes`           | Find notes with a boolean expression over text, folders, tags, attachments, checklists, flags, word counts, and dates (reads the database; needs Full Disk Access)                                                                                                                                                                                                                                                                                           |
| `get-note-content`      | Read the full content of a note                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get-note-plaintext`    | Read a note's body as plain text (no HTML)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get-note-markdown`     | Read note content as Markdown                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `get-note-by-id`        | Get note metadata by ID                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `get-note-details`      | Get metadata (created, modified, account)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get-note-link`         | Get the shareable `notes://showNote?identifier=…` deep link for a note                                                                                                                                                                                                                                                                                                                                                                                       |
| `update-note`           | Replace a note's title and/or body                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `append-to-note`        | Add content to a note without replacing it (`position: "after"` / `"before"`, which inserts below the title)                                                                                                                                                                                                                                                                                                                                                 |
| `insert-link`           | Add one URL to a note as its raw text or as a labeled hyperlink, verified from the stored link                                                                                                                                                                                                                                                                                                                                                               |
| `delete-note`           | Remove a note (moves to Recently Deleted; refuses a note already there, where delete is permanent); like `update-note`, `append-to-note`, and `move-note` it accepts `ifFolderId`, `ifAncestorFolderId`, and `forbiddenAncestorFolderIds` folder preconditions. For copy-then-retire, pass `guardNoteId` and `expectedGuardContentHash` (the verified copy's `contentHash`) so the original is deleted only while the copy is intact; needs Full Disk Access |
| `batch-delete-notes`    | Delete multiple notes by ID (max 500 per call; refuses notes already in Recently Deleted)                                                                                                                                                                                                                                                                                                                                                                    |
| `move-note`             | Move a note to a different folder                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `batch-move-notes`      | Move multiple notes by ID (max 500 per call)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list-notes`            | List all notes or notes in a folder (excludes Recently Deleted unless `includeRecentlyDeleted`)                                                                                                                                                                                                                                                                                                                                                              |
| `list-special-notes`    | List pinned notes, Quick Notes, Recently Deleted, or locked notes (`kind`; metadata only, needs Full Disk Access)                                                                                                                                                                                                                                                                                                                                            |
| `list-native-tags`      | Native tags in one folder, or omit `folder` for an account-wide inventory with note counts                                                                                                                                                                                                                                                                                                                                                                   |
| `list-recent-notes`     | Changes since a cursor, oldest first, for incremental sync: pass `since`, then keep calling with `nextSince` until `saturated` is false (needs Full Disk Access)                                                                                                                                                                                                                                                                                             |
| `show-note`             | Reveal a note in the Notes.app UI by ID                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `get-selected-notes`    | Read the notes currently selected in Notes.app                                                                                                                                                                                                                                                                                                                                                                                                               |
| `export-notes-json`     | Export notes as JSON one page at a time (`offset`/`limit`/`modifiedSince`); repeat with `page.nextOffset` while `page.hasMore`                                                                                                                                                                                                                                                                                                                               |
| `export-notes-markdown` | Export one note or a folder as one Markdown document from the decoded body; optional create-only `outputPath` and `assetsDir` for attachment copies (presentation format, not a backup)                                                                                                                                                                                                                                                                      |
| `export-notes-html`     | Export one note or a folder as one standalone HTML file (semantic tables, attachments in body order); `outputPath` required and create-only; assets embedded (10 MiB each) or in a sidecar directory with `embedAssets: false`                                                                                                                                                                                                                               |

### Folder Operations

| Tool                  | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `list-folders`        | List all folders in an account                                                          |
| `list-smart-folders`  | List Smart Folders with their decoded rules; optionally the notes each one shows        |
| `list-folder-tree`    | Folder hierarchy with direct and cumulative note counts per account                     |
| `create-folder`       | Create a new folder                                                                     |
| `delete-folder`       | Delete an empty folder                                                                  |
| `delete-folder-by-id` | Guarded delete of one exact empty folder: dry run returns a revision, apply requires it |
| `show-folder`         | Reveal a folder in the Notes.app UI by ID                                               |

### Account Operations

| Tool                   | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `list-accounts`        | List configured accounts (iCloud, Gmail, etc.)         |
| `get-default-location` | Read the default account and folder used for new notes |
| `show-account`         | Reveal an account in the Notes.app UI by ID            |

### Attachments, Checklists, Collaboration, and Diagnostics

| Tool                          | Purpose                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-attachments`            | List attachments in a note; `includePaths` adds on-disk `assetPaths`/`previewPath`, `firstImage` returns the lead visual in body order              |
| `add-attachment`              | Attach one local file to an exact note (optional `filename` renames it in Notes)                                                                    |
| `create-note-with-attachment` | Create a note and attach one local file in one call; on a failed attach, reuse the named note id with `add-attachment`                              |
| `save-attachment`             | Save an attachment to disk                                                                                                                          |
| `list-paper-attachments`      | List Paper and classic drawings in a note, with Notes' rendered image size and any recognized handwriting text                                      |
| `export-paper-image`          | Save Notes' rendered PNG (or JPEG) of one drawing to a new file                                                                                     |
| `export-attachments`          | Copy a note\'s attachment files (or only its lead visual) into a directory; `exportedKind` says asset or preview                                    |
| `fetch-attachment`            | Fetch attachment bytes as base64                                                                                                                    |
| `show-attachment`             | Reveal an attachment in the Notes.app UI                                                                                                            |
| `get-checklist-state`         | Read checked/unchecked state for existing checklists                                                                                                |
| `get-note-tables`             | Read a note's native tables as Markdown and JSON rows, in body order                                                                                |
| `create-checklist-items`      | Append several unchecked native checklist items in order (needs the Background Operations bridge; on `ok: false`, only `landed` items are verified) |
| `get-note-metadata`           | [BETA] Read pinned/trash/snippet metadata from the NoteStore DB                                                                                     |
| `get-note-drawings`           | Decode classic PencilKit drawings to strokes or SVG (needs `apple-notes-mcp setup --public-helper` once)                                            |
| `get-note-blocks`             | Read a note's paragraph styles, inline formatting, and attachment positions as typed blocks                                                         |
| `list-note-paragraphs`        | List a note's paragraphs with style, stored paragraph ID, and a direct link when the ID is unique                                                   |
| `get-paragraph-link`          | Get a link that opens Notes at one paragraph, refused when its ID is shared                                                                         |
| `get-note-structure`          | Read a note's links by kind, tags, attachments (as list-attachments reports them), counts, and view/lock/share/trash state in one call              |
| `list-note-links`             | List links (inline, card, note, section) in a note, folder (with subfolders), account, or the whole library                                         |
| `get-audio-transcripts`       | Read the transcripts and summaries Notes stored for a note's audio recordings                                                                       |
| `list-shared-notes`           | List notes shared with collaborators                                                                                                                |
| `get-sync-status`             | Check whether iCloud sync is active                                                                                                                 |
| `health-check`                | Quickly verify Notes.app access                                                                                                                     |
| `doctor`                      | Run detailed setup diagnostics, including the feature matrix                                                                                        |
| `get-capabilities`            | Check native-write operations and the OS-aware feature matrix (`features.<name>.available` / `reason`) before calling a tool that depends on them   |
| `get-notes-stats`             | Summarize note counts and recent activity                                                                                                           |

### Private Helper (opt-in, read-only, unsupported Apple API)

Off unless the user built it (`apple-notes-mcp setup --native-helper`) and set
`APPLE_NOTES_MCP_ENABLE_PRIVATE=1`. Call `native-helper-status` first; use
`native-note-state` only when it reports the feature `available`. The helper is
read-only: write support was deliberately deferred by the maintainer.

| Tool                   | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `native-helper-status` | Report opt-in, build, and live-probe state with a reason code (read-only) |
| `native-note-state`    | Read a note's native state and `revision` change token (read-only)        |

## Usage Patterns

### Creating Notes

When the user wants to save information:

```
User: "Save this meeting summary as a note"
Action: Use create-note with an appropriate title and the content
```

```
User: "Create a shopping list note"
Action: Use create-note with title="Shopping List" and formatted content
```

For structured notes, pass `format="html"` and use simple Apple Notes-friendly HTML. The server automatically prepends the `title` as an `<h1>` in both plaintext and HTML modes, so do not include the same `<h1>` title in `content` when creating a note.

### Finding Notes

When the user wants to find notes:

```
User: "Find my notes about the project"
Action: Use search-notes with query="project"
```

```
User: "Search for notes containing budget information"
Action: Use search-notes with query="budget" and searchContent=true
```

With Full Disk Access, a `searchContent` search reads the Notes database and
returns quickly even for a common word; without it, a broad body search can time
out, so narrow it with `folder` or `modifiedSince`.

When Full Disk Access is available, prefer `query-notes` for anything beyond a
single keyword. It matches title or body in one call, runs in well under a
second, and combines conditions:

```
User: "Which work notes still have open to-dos?"
Action: Use query-notes with query='folder:Work checklist:open'

User: "Find invoices or anything tagged finance since July"
Action: Use query-notes with query='(title:invoice OR tag:finance) modified:>=2026-07-01'

User: "Long notes with a PDF that aren't in Archive"
Action: Use query-notes with query='words:>250 has:pdf -folder:Archive'
```

Bare words and "quoted phrases" match title or body. Fields are `title:`,
`body:`, `text:`, `folder:`, `account:`, and `tag:`; facets are
`has:link|attachment|checklist|drawing|image|video|audio|pdf|table|scan|tag`;
`checklist:open|done`; flags `pinned`, `locked`, `shared`; and `words:`,
`created:`, `modified:` take `=`, `>`, `>=`, `<`, `<=` with `YYYY-MM-DD` local
dates. AND is implicit; use `OR`, `NOT` or a leading `-`, and parentheses.
Quote an operator word (`"and"`) to search it literally. It scans the 500 most
recently modified notes unless `scanLimit` is raised (max 5000), and the
response says when older notes were left out. Recently Deleted is excluded
unless `includeDeleted` is true. Locked notes match on title and metadata only.
The returned ids work with every id-based tool.

### Reading Notes

When the user wants to see note contents:

```
User: "Show me my shopping list"
Action: Search by title if needed, then use get-note-content with the exact ID
```

For a note's tables, use `get-note-tables` with the note ID. It returns each
table as Markdown and as JSON rows. When `tableCellsComplete` is false, some
cells could not be decoded: they are `null` in `rows` and shown as
`[undecoded cell]` in Markdown. Report that to the user rather than filling
them in.

Use titles for discovery only. Mutations require the exact note ID; update,
append, and delete also require the `contentHash` returned by
`get-note-content`. This prevents duplicate-title mistakes and stale saves.

For a note with audio recordings, `get-audio-transcripts` returns the
transcript Notes already computed for each recording (it never transcribes).
Check each attachment's `status`: `none` means Notes stored no transcript, not
that the read failed. Ask for `includeSegments` only when word timings or
speakers per word matter, because segments make the response much larger.

### Updating Notes

**Adding to a note — use `append-to-note`.** It takes the new `content` plus an
optional `position` (`"after"` is the default and appends; `"before"` prepends),
`separator`, and `format` (`"plaintext"` / `"html"`), and does the read-and-splice
itself, always round-tripping the body as HTML so existing rich formatting
survives. Do not hand-roll read-then-`update-note` for an addition.

A note that already contains native objects (a table, a checklist, native tags)
cannot be spliced, so `append-to-note` routes it to the native end-append bridge
instead. That path additionally needs `scopeText` (a unique existing phrase),
keeps the default blank-line `separator` and `position: "after"`, and accepts a
fixed HTML subset: `<a> <b> <br> <code> <del> <div> <em> <h1> <h2> <h3> <i> <li>
<ol> <p> <s> <span> <strong> <table> <tbody> <td> <th> <thead> <tr> <tt> <u>
<ul>`, with `href` on `<a>` and a `font-size` style on `<span>` as the only
attributes. Anything outside that subset is refused by name — rewrite the whole
body with `update-note` instead.

**Adding a web link — use `insert-link`.** Pass `url` and either `mode: "raw"`
(the URL is its own clickable text) or `mode: "hyperlink"` with a `label`.
`position` is `"end"` (default) or `"after-title"`. It checks the stored link
afterwards and reports `linkStored` and `storedUrl`. A plain URL typed into
`append-to-note` content stays plain text: Notes does not turn it into a stored
link. Rich URL preview cards cannot be created. For a link to another note, use
`insert-note-link`.

```
User: "Add milk to my shopping list"
Action:
1. Use search-notes if needed to get the note ID
2. Read it with get-note-content and retain contentHash
3. Use append-to-note with its exact ID, expectedContentHash, and content="Milk"
```

**Replacing a note — use `update-note`.** Only reach for it when the body really
is being rewritten:

```
User: "Rewrite my project brief with this new version"
Action:
1. Use search-notes if needed to get the note ID
2. Read it with get-note-content and retain contentHash
3. Use update-note with its exact ID, expectedContentHash, and complete new body
```

`update-note` replaces the entire note body. It is not an append operation. If `format="html"`, `newTitle` is ignored and the first element in `newContent` becomes the visible title.

**Do not write `get-note-content`'s body back through another tool.** For image-heavy notes that body is lossy: inline base64 images over the configured cap (default 256 KB each) come back as `[inline image omitted: …]` text placeholders. This server blocks updates and appends when attachments exist; edit those notes in Notes.app.

Both tools refuse to rewrite a note that contains attachments. Use Notes.app
for those notes.

### Organizing Notes

When the user wants to organize:

```
User: "Move my old notes to Archive"
Action: Search for each note, then use move-note with its exact ID and folder="Archive"
```

```
User: "Create a Work folder"
Action: Use create-folder with name="Work"
```

`create-folder` takes a whole nested path (`name="Work/Clients/Omnia"`) and creates every missing segment, skipping ones that already exist — so it is idempotent and safe to call unconditionally. Do call it first: `create-note`, `move-note`, and `batch-move-notes` all require the destination folder to already exist, and `create-note` reports a missing folder with a generic "check that Notes.app is configured and accessible" message that looks like a permissions problem but is not.

### Sharing and Revealing Notes

```
User: "Send me a link to that note"
Action: Use get-note-link with the note ID → notes://showNote?identifier=<uuid>
```

Hand out that deep link, not the `x-coredata://` id — the link opens the note in Notes.app on macOS and iOS and can be pasted into a Reminders task or a message. It needs Full Disk Access for the process that runs the server (under Claude Desktop, the Node binary itself) (it reads the note's identifier from the Notes database; macOS 12–15 has an AppleScript fallback), and password-protected notes cannot be linked.

```
User: "Open that note for me" / "What note am I looking at?"
Action: show-note by ID to reveal it in Notes.app; get-selected-notes to read the current selection
```

`show-note`, `show-folder`, `show-account`, and `show-attachment` activate the Notes.app GUI, so they only do something useful on a Mac with an active desktop session.

## Formatting Guidance

Use HTML for predictable rich notes. Apple Notes normalizes HTML internally, but these tags are reliable for most API-created content:

- Use `<div>` for body blocks and `<div><br></div>` for blank spacing.
- `create-note` already creates the top `<h1>` from the `title`, but `<h2>`/`<h3>`
  in its `content` do **not** produce real Heading/Subheading styles — AppleScript's
  `body` property renders them as plain bold text (#172). For a new note with real
  headings, use `create-note` with `format: "markdown"` (`##`/`###` →
  Heading/Subheading, flat lists, `**bold**`/`*italic*` and inline links; iCloud
  only, no `account`). `tags` are refused with this format: create the note,
  then use `add-native-tags` on the returned id. It needs the optional Create
  Markdown Note Shortcut (macOS 26+); check `get-capabilities` for
  `create-note-markdown`. On an existing note, use `append-native` with
  `format: "markdown"`. Both refuse Markdown Notes would rewrite, such as `_`
  emphasis outside a word or backslash escapes; underscores inside a link
  destination are fine.
- With `format: "markdown"`, do not repeat the title as a `# ` line; if the first
  line is exactly `# <title>`, the server removes it. Without the Shortcut, or in
  another account, pass `markdownRoute: "html"`: same Markdown subset through
  AppleScript HTML, no real Heading styles, and `- [ ]` / `- [x]` task items
  become list rows with a visible ☐ / ☑ character (text, not a checkable
  checklist; say so to the user).
- To import a Markdown or text file, pass its absolute path as `contentPath`
  instead of `content` (UTF-8, at most 1 MiB, inside home, temp, or `/Volumes`).
- On the default Shortcut route, `create-note` with `format: "markdown"` also
  maps block constructs to native Notes styles (`create-note-markdown-blocks` in `get-capabilities`): `- [ ]`/`- [x]` → native checklist items with that done state,
  `> text` → a block quote, a bare ` ``` ` fence (no language) →
  Monospaced paragraphs, a `---` line after a blank line → a divider, and
  `` `inline code` `` → **highlighted** text (not monospace). Code content is
  kept literal. `append-native` still refuses all of these, because its
  converter flattens them (quotes and code to plain body text, `- [ ]` to a
  bullet with literal brackets, `---` dropped). `markdownRoute: "html"` does not map them either: it renders `- [ ]`/`- [x]` as ☐ / ☑ glyph rows, keeps `---` as literal text, and refuses the rest.
- Use `<ul><li>` and `<ol><li>` for native bullet and numbered lists. Add `<div><br></div>` after closing `</ul>` or `</ol>` so the next section has spacing.
- Use `<b>`, `<i>`, `<u>`, and `<s>` for inline emphasis.
- Use `<tt>` (or `<code>`) for commands, code, paths, API keys, and other technical strings.
- Escape literal `&`, `<`, and `>` in user content as `&amp;`, `&lt;`, and `&gt;`.
- Avoid nested lists when possible. Apple Notes can flatten or misplace nested list markup.
- For a clickable link, use `<a href="…">` in HTML content or `insert-link`. A bare URL written as text is stored as plain text, not as a link.
- Do not use decorative separators between sections (horizontal rules, repeated dashes, or box-drawing characters). They render inconsistently in Notes; use an empty `<div><br></div>` spacer instead.

Do not use CDATA sections. They can render literally in Apple Notes.

## Attachment-Safe Updates

`update-note` and `append-to-note` automatically refuse any note containing an
attachment. Do not bypass this control. Use Notes.app for attachment-bearing
notes, or create a separate formatted note.

## Formatting Limits

Some Notes UI features cannot be created by the current AppleScript-backed create/update tools:

- Interactive checklists: in plaintext or HTML, create a plain list instead; `create-note` with `format: "markdown"` and `- [ ]`/`- [x]` lines creates real ones, and `create-checklist-item` appends one unchecked item. Use `get-checklist-state` to read checklist state.
- Collapsible headings: API-created headings look like headings, but may not get Notes' native collapse controls.
- Block quotes, dashed lists, and background highlights: these require manual Notes UI formatting.

If the user specifically requires those features, create all API-supported content first, then explain which remaining formatting must be applied in Notes.app.

## Important Guidelines

1. **Exact IDs for writes**: Search may use titles, but update, append, delete,
   and move require the exact note ID. Update, append, and delete also require
   the `contentHash` from the version just read. A note ID may be the
   `x-coredata://…` id, the note's Notes UUID (the `identifier` field list and
   read tools return with Full Disk Access), or its numeric key (the digits
   after `p`). UUIDs and numeric keys need Full Disk Access; store the
   `identifier` when a reference must outlive this session.

2. **Default Account**: Operations default to iCloud. Use the `account` parameter for other accounts (Gmail, Exchange).

3. **Content Format**: Notes store content as HTML. Use `format="html"` for structured content. Retrieved HTML is normalized by Notes and may not match the submitted HTML byte-for-byte. `verifiedVisibleText` proves the words survived, not every rich-formatting detail.

4. **Backslash Escaping**: When content contains backslashes, escape them as `\\` in the JSON.

5. **Password-Protected Notes**: Cannot be accessed via this skill. Inform the user if they try.

6. **Shared Notes**: Use extra care before edits or deletes. Changes to shared notes are visible to collaborators.

7. **macOS Only**: This skill only works on macOS systems.

## Verification

`get-note-content` returns Apple Notes' stored HTML, which may differ from the original HTML while still rendering correctly. Use `get-note-markdown`, `get-note-content`, or a quick reread of the note after create/update to verify the title, line breaks, list spacing, and important content. Do not rewrite normalized HTML just because Notes transformed tags such as headings or monostyled text.

When the stored HTML looks suspicious, `get-note-plaintext` is the quickest check: it returns the note's plain-text body (what Notes itself shows) with no markup, so you can confirm the title, line breaks, and text survived without reading through normalized HTML.

## Error Handling

Every error result carries `structuredContent.code` (`not_found`, `ambiguous`, `permission_denied`, `full_disk_access_missing`, `shortcut_not_installed`, `timeout_indeterminate`, `verification_failed`, `revision_conflict`, `validation_error`, `unsupported`, `notes_unavailable`, `operation_failed`). Branch on the code rather than the wording. If `indeterminate` is `true`, the write may have landed: read the exact note before deciding whether to retry. `committed: false` means nothing was written.

- **"Note not found"**: Use search-notes to find similar titles
- **"Permission denied"**: User needs to grant automation permission in System Settings > Privacy & Security > Automation
- **Native write times out or reports an uncertain outcome** ("Shortcuts timed out waiting for …", "Operation outcome uncertain", "readback was not verified"): do not retry. Read the exact note first — the write may have landed. If it did not, the named bridge Shortcut is likely waiting on a first-run consent prompt that a background run cannot display; ask the user to run that Shortcut once in the foreground in Shortcuts.app and choose Always Allow (once per bridge, after install or upgrade), then retry
- **Slow Notes.app**: `create-note`, `update-note`, `append-to-note`, `delete-note`, and `move-note` accept `timeoutSeconds` (1–120) for each automation step of that call. A timed-out write is uncertain; read the exact note before retrying
- **"Notes.app accepted the delete, but the note is still in its original folder"**: nothing was deleted. Read the note again before retrying
- **"Folder not empty"**: Cannot delete folders with notes; move notes first
- **Attachment-risk update**: The mutation is rejected. Use Notes.app or create a separate note.
- **Notes accumulate blank lines after repeated updates**: Apple Notes' internal HTML processing preserves empty `<div><br></div>` artifacts from previous edits, and they persist even when you update with clean content. Fix: delete the note with delete-note and create a fresh one with create-note — the artifacts are baked into the note's internal representation, so this is more reliable than trying to fix the whitespace through updates

## Examples

### Save conversation to notes

```
User: "Save our conversation about the API design to my notes"
→ create-note with title="API Design Discussion" and summarized content
```

### Daily workflow

```
User: "What's on my todo list?"
→ search-notes with query="todo" or get-note-content with title="Todo"
```

### Multi-step organization

```
User: "Archive all my completed project notes"
→ 1. list-notes to find notes
→ 2. create-folder name="Archive" if needed
→ 3. move-note for each relevant note
```
