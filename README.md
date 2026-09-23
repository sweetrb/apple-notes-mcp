# Apple Notes MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, create, search, and manage notes in Apple Notes on macOS.

[![npm version](https://img.shields.io/npm/v/apple-notes-mcp)](https://www.npmjs.com/package/apple-notes-mcp)
[![npm downloads](https://img.shields.io/npm/dm/apple-notes-mcp)](https://www.npmjs.com/package/apple-notes-mcp)
[![node](https://img.shields.io/node/v/apple-notes-mcp)](https://www.npmjs.com/package/apple-notes-mcp)
[![CI](https://github.com/sweetrb/apple-notes-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-notes-mcp/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sweetrb/apple-notes-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/sweetrb/apple-notes-mcp)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-111?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetrb/apple-notes-mcp/main/codex/assets/screenshot.png" alt="Apple Notes MCP — create, search, and organize Apple Notes from Codex, Claude, and other AI assistants" width="680">
</p>

## What is This?

This server acts as a bridge between AI assistants and Apple Notes. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Save this conversation as a note called 'Meeting Summary'"
- "Find all my notes about the project deadline"
- "Read my shopping list note"
- "Move my draft notes to the Archive folder"
- "What notes do I have in my Work folder?"

The AI assistant communicates with this server, which then uses AppleScript to interact with the Notes app on your Mac. All data stays local on your machine.

## Quick Start

### Using Claude Code (Easiest)

If you're using [Claude Code](https://claude.com/product/claude-code) (in Terminal or VS Code), just ask Claude to install it:

```
Install the sweetrb/apple-notes-mcp MCP server so you can help me manage my Apple Notes
```

Claude will handle the installation and configuration automatically.

Or register it yourself with one deterministic command:

```bash
claude mcp add apple-notes -s user -- npx -y apple-notes-mcp
```

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-notes-mcp
/plugin install apple-notes
```

This method also installs a **skill** that teaches Claude when and how to use Apple Notes effectively.

On the first tool call, macOS shows an Automation permission prompt ("Claude" wants access to control "Notes") — click **OK**. Optionally, grant **Full Disk Access** to the app that launches the server to enable the database-backed tools (`get-checklist-state`, `get-note-metadata`, `get-audio-transcripts`, `list-special-notes`, `list-native-tags`, `get-note-link`, checklist annotations in `get-note-markdown`, and full `get-sync-status` detail); see the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md). The rest of the server is pure AppleScript and works without it.

Native tag, checklist, table, pin, and rich append operations use two packaged
Apple Shortcuts. A third, `Apple Notes MCP - Create Markdown Note`, is optional:
only `create-note`'s `format: "markdown"` needs it, and only on macOS 26 or
later. Run the explicit setup once:

```bash
npx -y apple-notes-mcp setup
```

The command checks existing installations and opens only missing signed
workflows; it opens the optional Create Markdown Note bridge only on macOS 26 or
later. Confirm **Add Shortcut** in each macOS window, then verify with
`npx -y apple-notes-mcp setup --check` or the MCP `doctor` tool. `setup --check`
reports ready and `doctor` reports ok once the two required bridges are
installed; both list the optional bridge's status separately. macOS does not
support silent Shortcut import, so merely connecting an MCP client never opens
setup windows or bypasses these confirmations.

After install **and after every upgrade**, open Shortcuts.app and run each
installed bridge — `Apple Notes MCP - Native Tags`,
`Apple Notes MCP - Background Operations v5` and, if you installed it, the
optional `Apple Notes MCP - Create Markdown Note` — once in the foreground, choosing
**Always Allow** when Shortcuts asks for permission. The Create Markdown Note
bridge stops before reaching Notes when run with no input, so start its run
with the request in [`shortcuts/README.md`](shortcuts/README.md). The server runs these
Shortcuts in the background, where Shortcuts cannot display a first-run consent
prompt: an unanswered one stalls every native write on that bridge until it
times out, while `doctor` still reports the bridge installed. Quitting or
relaunching Shortcuts.app or Notes.app does not clear it; the foreground run
does, once per bridge.

### Using the Codex Marketplace

The same plugin is available for Codex. Add the marketplace and install the plugin:

```bash
codex plugin marketplace add sweetrb/apple-notes-mcp
codex plugin add apple-notes@apple-notes-mcp
```

The Codex plugin runs the published `apple-notes-mcp` server through `npx` and ships the same Apple Notes skill, so behavior matches the Claude Code plugin.

### Other Hosts (Hermes, Antigravity)

Two more hosts can run the same `apple-notes` MCP server (`npx -y apple-notes-mcp`):

- **[Hermes Agent](https://hermes-agent.nousresearch.com/)** (NousResearch) — Hermes has no plugin/marketplace drop-in, so there is nothing in this repo to install from. Register the server with the CLI:

  ```bash
  hermes mcp add apple-notes --command npx --args -y apple-notes-mcp
  ```

  Or add it to `~/.hermes/config.yaml` by hand:

  ```yaml
  mcp_servers:
    apple-notes:
      command: npx
      args: ["-y", "apple-notes-mcp"]
  ```

  Restart your Hermes session afterward so the tools load.
- **[Antigravity](https://antigravity.google/)** (Google) — add the server entry from [`.antigravity-plugin/mcp_config.json`](https://github.com/sweetrb/apple-notes-mcp/blob/main/.antigravity-plugin/mcp_config.json) to `~/.gemini/config/mcp_config.json` (or via Antigravity's MCP settings).

### Using Claude Desktop

**1. Install the server:**
```bash
npm install -g apple-notes-mcp
```

**2. Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "apple-notes-mcp"]
    }
  }
}
```

**3. Restart Claude Desktop** and start using natural language:
```
"Create a note called 'Ideas' with my brainstorming thoughts"
```

On first use, macOS will ask for permission to automate Notes.app. Click "OK" to allow.

## Requirements

- **macOS** - Apple Notes and AppleScript are macOS-only
- **Node.js 20+** - Required for the MCP server
- **Apple Notes** - Must have at least one account configured (iCloud, Gmail, etc.)

## Features

| Feature | Description |
|---------|-------------|
| **Create Notes** | Create notes with titles, content, and optional folder/account targeting |
| **Search Notes** | Find notes by title or search within note content |
| **Query Language** | `query-notes` combines text, folder, account, tag, attachment, checklist, flag, word-count, and date conditions with AND/OR/NOT, read from the Notes database (requires Full Disk Access) |
| **Read Notes** | Retrieve note content and metadata |
| **Update Notes** | Modify existing notes (title and/or content) |
| **Delete Notes** | Remove notes (moves to Recently Deleted) |
| **Move Notes** | Organize notes into folders (supports nested paths) |
| **Folder Management** | Create, list, and delete folders with full hierarchical path support |
| **Multi-Account** | Work with iCloud, Gmail, Exchange, or any configured account, including account IDs and default folders |
| **Batch Operations** | Delete or move multiple notes at once |
| **Checklist State** | Read checklist done/undone state directly from the Notes database (requires Full Disk Access) |
| **Audio Transcripts** | Read the transcripts and summaries Notes stored for audio recordings (requires Full Disk Access) |
| **Export** | Export all notes as JSON or get individual notes as Markdown |
| **Attachments** | List attachments with their on-disk asset and preview paths, find a note's lead image, save or batch-export them to disk, or fetch their bytes as base64 |
| **Notes.app UI State** | Reveal a note in Notes.app or read the current Notes.app selection |
| **Sync Awareness** | Detect iCloud sync in progress, warn about incomplete results |
| **Collaboration** | Detect shared notes, warn before modifying |
| **Diagnostics** | `health-check` plus a richer `doctor` (reachability, automation permission, accounts, Full Disk Access), sync status, and statistics |

Read/list/get tools also return **structured JSON** (`structuredContent`) alongside the text, so agents can consume results without parsing prose.

### MCP resources & prompts

Resources expose read-only context the client can attach without a tool call:
`notes://accounts`, `notes://folders`, `notes://stats`, and the
`notes://note/{id}` template (returns the note as Markdown). Prompts package
common workflows: `find-note`, `weekly-review`, `new-meeting-note`.

### AppleScript limitations

A few Notes UI features are not exposed to AppleScript. Some are recovered by
reading Notes' own database instead; the rest genuinely cannot be supported. See
**[docs/APPLESCRIPT-LIMITATIONS.md](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/APPLESCRIPT-LIMITATIONS.md)**
for the investigation and verification behind each:

- **Pinned notes** — Notes has no scriptable `pinned` property via AppleScript. Pin state can now be **read** with the BETA `get-note-metadata` tool (from the NoteStore database), but it still cannot be **set** programmatically.
- **Note-to-note links** — AppleScript exposes no link property or link element, so link *relationships* between notes cannot be read, and a link cannot be inserted into a note body. A shareable `notes://showNote?identifier=<uuid>` deep link **is** available via [`get-note-link`](#get-note-link).

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Identifier forms

Every tool that takes a note id (`id`, `noteId`, `ids`, `linkedNoteId`, or the `id` inside a batch entry) accepts any of three forms of the same note:

| Form | Example shape | Needs Full Disk Access |
|------|---------------|------------------------|
| AppleScript id (canonical) | `x-coredata://<store-uuid>/ICNote/p123` | No |
| Notes UUID (`identifier`) | `8-4-4-4-12` hex digits, as in `notes://showNote?identifier=` links | Yes |
| Numeric Core Data key | `123` (the digits after `p`) | Yes |

The server turns a UUID or numeric key into the canonical id before the tool runs, reading the Notes database read-only. A numeric key or UUID resolves only to a note, never to a folder or attachment. Without Full Disk Access those two forms fail with an error that says so, while `x-coredata` ids keep working as before. Folder-id inputs (`show-folder`, `get-folder-by-id`, `rename-folder`) accept a folder's UUID or numeric key the same way, resolving only to folders.

When Full Disk Access is granted, list and read tools also return stable identifiers next to each `id`: notes carry `identifier`, `folderIdentifier`, and `accountIdentifier`; folders carry `identifier`, `parentIdentifier` (nested folders only), and `accountIdentifier`; accounts carry `identifier`. These fields come from one batched read-only query per call and are omitted when the database cannot be read. Tools that return them: `search-notes`, `list-notes`, `get-selected-notes`, `list-shared-notes`, `get-note-content`, `get-note-by-id`, `get-note-details`, `list-folders`, `get-folder-by-id`, `list-accounts`, and `get-default-location`.

### Error results

A failed call returns `isError: true` with the same human-readable text as
before, plus `structuredContent` carrying a stable machine-readable `code`.
Branch on `code`, not on the prose, which may be reworded.

| `code` | Meaning |
|--------|---------|
| `not_found` | The note, folder, account, attachment, or checklist does not exist |
| `ambiguous` | More than one item matched; use an exact id |
| `permission_denied` | macOS refused Automation access to Notes.app |
| `full_disk_access_missing` | The Notes database is not readable; grant Full Disk Access |
| `shortcut_not_installed` | A native-write bridge Shortcut is not installed exactly once |
| `timeout_indeterminate` | The operation timed out; for a write, the outcome is unknown |
| `verification_failed` | The write ran, but exact-ID readback did not confirm it |
| `revision_conflict` | The note changed since it was read |
| `validation_error` | The request was rejected before anything ran |
| `unsupported` | Not supported for this note or in this mode, such as a locked note |
| `notes_unavailable` | Notes.app is not running, busy, or not responding |
| `operation_failed` | The server could not classify the failure; read the text |

Two optional booleans describe a write's outcome when it is known.
`indeterminate: true` means the outcome is uncertain: read the target by exact
id before any retry, and never retry blindly. `committed: true` means the write
took effect even though its verification failed; `committed: false` means
nothing was written (for example a `revision_conflict`). An absent flag means
unknown. Errors the MCP SDK raises itself before a tool runs, such as an
argument that fails the input schema, carry no `structuredContent`.

### Note Operations

#### `create-note`

Creates a new note in Apple Notes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | The title of the note. Automatically prepended as `<h1>` — do NOT include the title in `content` |
| `content` | string | One of `content`/`contentPath` | The body content of the note (do not repeat the title here) |
| `contentPath` | string | One of `content`/`contentPath` | Absolute path of a local UTF-8 file to use as the body instead of `content`. Allowed in the same places [`save-attachment`](#save-attachment) may write (home, temp, `/Volumes`); symbolic links, non-regular files, invalid UTF-8 and files over 1 MiB are refused before anything is written. A leading byte-order mark is dropped |
| `tags` | string[] | No | Returned-only metadata — **NOT written to Notes.app**. Apple Notes tags can't be set via AppleScript, so values passed here are echoed back in the response but do not appear on the created note. Use inline `#hashtags` in `content` instead (Notes.app turns those into real tags). Refused with `format: "markdown"` |
| `folder` | string | No | Folder to create the note in. Supports nested paths like `"Work/Clients"`. **The folder must already exist** — create it first with [`create-folder`](#create-folder). Defaults to account root |
| `account` | string | No | Account name (defaults to Notes.app's default account; matched exactly or by a *unique* prefix — an ambiguous prefix is refused). Must be an account Notes.app already has configured — see [`list-accounts`](#list-accounts) |
| `format` | string | No | Content format: `"plaintext"` (default), `"html"`, or `"markdown"`. In all formats, the title is automatically prepended as the note's title line. In plaintext mode, newlines become `<br>`, tabs become `<br>`, and backslashes are preserved as HTML entities. `"markdown"` produces real Title/Heading/Subheading styles through a Shortcut; see [Markdown notes](#markdown-notes) |
| `markdownRoute` | string | No | With `format: "markdown"` only: `"shortcut"` (default) or `"html"`. See [Markdown through HTML](#markdown-through-html) |
| `timeoutSeconds` | number | No | Whole seconds, 1–120, for each Notes.app automation step this call runs; overrides `APPLE_NOTES_MCP_TIMEOUT_MS` for this call only. A timed-out write is uncertain, not failed: read the note by id before any retry. Also accepted by `update-note`, `append-to-note`, `delete-note` and `move-note` |

**Example (tagged with inline hashtags):**
```json
{
  "title": "Meeting Notes",
  "content": "Discussed Q4 roadmap and budget allocation\n\n#work #meetings"
}
```

**Example - Create in a specific folder:**
```json
{
  "title": "Client Meeting",
  "content": "Discussed project timeline",
  "folder": "Work/Clients"
}
```

**Example - HTML formatting:**
```json
{
  "title": "Status Report",
  "content": "<h2>Summary</h2><p>All tasks <b>on track</b>.</p><ul><li>Feature A: complete</li><li>Feature B: in progress</li></ul>",
  "format": "html"
}
```

> **Note:** The title is automatically prepended as `<h1>` in both plaintext and HTML formats. Do not include a `<h1>` title tag in the `content` parameter, or the title will appear twice.

> **Known limitation:** with `"plaintext"` or `"html"`, `create-note` sets the note
> body directly via AppleScript's `body` property, which does not apply real Notes
> paragraph styles for interior content — an `<h2>`/`<h3>` tag or a
> `<span style="font-size: …px">` heading span in `content` renders as plain bold,
> styled text, not an actual Heading or Subheading
> ([#172](https://github.com/sweetrb/apple-notes-mcp/issues/172)). Use
> `format: "markdown"` for real headings in a new note, or
> [`append-native`](#append-native)'s `format: "markdown"` on a note that already
> exists.

##### Markdown notes

`format: "markdown"` creates the note with Notes' own Markdown importer (the
Create Note action's "Interpret as Markdown" option, macOS 26+), run through the
packaged `Apple Notes MCP - Create Markdown Note` Shortcut. `#`, `##` and `###`
become real Title, Heading and Subheading styles, and the note starts with the
title line, with no seed line.

```json
{
  "title": "Project Plan",
  "content": "## Goals\n\n- Ship the beta\n- Collect feedback\n\n### Links\n\n[Tracker](https://example.com/tracker)",
  "format": "markdown",
  "folder": "Work"
}
```

- Notes interprets Markdown only in an iCloud account. The note is created in the
  iCloud account's default folder, then moved to `folder` in that account.
  `folder` must already exist and is checked before anything is created. If it
  exists only in another account, the note is still created and verified in the
  iCloud default folder, and the error names that account and the note's id so
  you can create the folder there and `move-note` it instead of creating the
  note again. `account` is refused with this format.
- `tags` are refused with this format. Create the note without them, then add
  native tags to the returned id with [`add-native-tags`](#add-native-tags).
- `content` accepts the same bounded subset as `append-native`'s Markdown:
  `#`/`##`/`###` headings, flat lists, `**bold**`, `*italic*` and inline links.
  It also refuses Markdown that Notes would rewrite and the server could not
  verify: `_` emphasis (underscores inside a word, as in `snake_case`, and
  inside a link destination, as in `[docs](https://example.com/_next/static)`,
  are fine), backslash escapes, character references such as `&amp;`, `===` lines
  and rule lines other than the `---` divider described below, indented headings or list items, `1)` lists, closing `#`s, and
  formatting inside link labels. Content that needs one of these literally, such
  as a `/_next` path or a literal `\*`, has no Markdown form here: use
  `format: "html"` for that note (or `append-native` with `format: "html"` on an
  existing one), which keeps the characters but not the Heading and Subheading
  styles. Markdown punctuation in `title` is escaped, so the title stays literal.
- Notes' importer also maps these block constructs to native styles. They are
  gated separately, and `get-capabilities` reports them as
  `create-note-markdown-blocks`. Each mapping below was live-verified on
  macOS 27.2 by reading the created note's stored styles.

  | Markdown | Native result |
  |----------|---------------|
  | `- [ ] item` / `- [x] item` | Checklist item, unchecked / checked |
  | `> text` (consecutive lines form one quote) | Body paragraph with a block quote |
  | A fence of bare ```` ``` ```` lines (no language) | Monospaced paragraphs; the code text is kept literally |
  | `---` on its own line, after a blank line | Divider line |
  | `` `inline code` `` | **Highlighted** text, not monospace |

  Constructs Notes would not render faithfully, or that this server cannot yet
  verify, are refused before anything is created: `~~~` fences, a language
  after the opening fence, nested (`>>`) or indented quotes, lists or headings
  inside a quote, a quote followed directly by text (Markdown would join that
  text to the quote), `---` directly under text (Markdown would make that text
  a heading), `***`/`___`/`----` rules, `[X]`, `* [ ]` or `+ [ ]` items, checklist
  items directly next to ordinary list items, inline code padded with spaces or
  inside a link label, tables, and `~~strikethrough~~`. The readback checks the
  block-quote text, the Monospaced text, each checklist item's text and done
  state, the divider count, and the highlighted text. These mappings apply to
  the default Shortcut route only; see
  [Markdown through HTML](#markdown-through-html) for `markdownRoute: "html"`.
- [`append-native`](#append-native)'s `format: "markdown"` refuses all of the
  constructs above: its Shortcuts converter is a different one, which renders
  a quote and a fenced block as plain body text, `- [ ]` as a bullet with
  literal brackets, and inline code as plain text, and drops `---`.
- The server finds the new note among the notes added to the default folder
  during the run by verifying each one's visible text, heading levels and links
  by exact-ID readback, and moves it only after exactly one verifies. On any
  uncertain result it names the note (or says to search for the title) and
  never retries.
- It is gated like the other native operations; `get-capabilities` reports it
  as `create-note-markdown`. The Create Markdown Note Shortcut is optional and
  needed only for this format (macOS 26+); install and approve it as described in
  [`shortcuts/README.md`](shortcuts/README.md).
- A first line that is exactly `# <title>` (same case and spacing as `title`) is
  removed together with one blank line after it, because the title is supplied
  separately; the response then carries `strippedDuplicateTitle: true`. A
  different first heading stays in the body. This applies to both Markdown
  routes, and Markdown that holds only that heading is refused.

##### Markdown through HTML

`markdownRoute: "html"` imports the same bounded Markdown subset without the
Shortcut: the server converts it to HTML and creates the note through AppleScript,
like `format: "html"`. It works in any account, accepts `tags`, and needs no
Shortcut, but headings get the plain bold styling described in the known
limitation above rather than real Heading and Subheading styles.

On this route, bullet task items (`- [ ] item`, `- [x] item`) become ordinary
list rows that start with a visible `☐` or `☑` character, and the response
reports how many as `taskItemsRendered`. They are text, not native checkable
checklist items. Use this route as the glyph fallback when the Shortcut is not
installed or the note is outside iCloud. Block quotes, fenced code and inline code, which
the Shortcut route maps natively, are refused on this route, and a `---` line
stays literal text rather than becoming a divider.

```json
{
  "title": "Weekly Review",
  "contentPath": "/Users/me/Documents/weekly-review.md",
  "format": "markdown",
  "markdownRoute": "html",
  "folder": "Work"
}
```

**Returns:** Confirmation message with note title and ID. Save the ID for subsequent operations like `update-note`, `delete-note`, etc.

---

#### `search-notes`

Searches for notes by title or content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Text to search for |
| `searchContent` | boolean | No | If `true`, searches note content (title line included); if `false` (default), searches titles only. With Full Disk Access, content search reads the Notes database (well under a second, the 5000 most recently modified notes, Recently Deleted excluded); without it, it falls back to AppleScript, which scans every body and can time out on a broad term |
| `account` | string | No | Account to search in (defaults to Notes.app's default account; exact or unique-prefix match) |
| `folder` | string | No | Limit search to a specific folder (supports nested paths like `"Work/Clients"`) |
| `modifiedSince` | string | No | ISO 8601 date string to filter notes modified on or after this date (e.g., `"2025-01-01"`) |
| `limit` | number | No | Maximum number of results to return. **Defaults to 50** — a broad query reads several properties per match via AppleScript (~200ms/note), so an unbounded search over hundreds of matches can exceed Notes' 30s timeout and return an error instead of results. Pass a higher value to see more; the applied limit (and whether it truncated the results) is disclosed in the response. |

**Example - Search titles:**
```json
{
  "query": "meeting"
}
```

**Example - Search content:**
```json
{
  "query": "budget allocation",
  "searchContent": true
}
```

**Example - Search recent notes with limit:**
```json
{
  "query": "todo",
  "searchContent": true,
  "modifiedSince": "2025-01-01",
  "limit": 10
}
```

**Returns:** List of matching notes with titles, folder names, and IDs. Use the returned ID for subsequent operations like `get-note-content`, `update-note`, etc. A content search also returns `source` (`"database"` or `"applescript"`), and `scanTruncated` when the database path left older notes unsearched.

---

#### `query-notes`

Finds notes with a boolean query expression evaluated against the NoteStore
database, read-only. Because it does not go through AppleScript, a query over
several hundred notes typically returns in well under a second, and one call
can match titles and bodies together.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)). Without it, use `search-notes`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Query expression (syntax below), at most 2000 characters |
| `limit` | number | No | Maximum notes to return. Defaults to 50, maximum 500. The response reports the total match count. |
| `scanLimit` | number | No | How many of the most recently modified notes to examine. Defaults to 500, maximum 5000. The response says when older notes were left unscanned. |
| `includeDeleted` | boolean | No | Also scan notes in Recently Deleted, notes pending deletion, and folderless notes. Defaults to `false`. |

**Syntax:**

| Form | Matches |
|------|---------|
| `budget`, `"quarterly budget"` | Title or body contains the word or phrase (case-insensitive substring) |
| `title:x`, `body:x`, `text:x` | Title only, body only (text after the first line), or either |
| `folder:Work`, `folder:"Work/Clients"` | The note's own folder, by name or full path, case-insensitive (notes in subfolders are not included); a literal `/` in a name can be written `\/` as in `list-folders` |
| `account:iCloud` | Account name, case-insensitive |
| `tag:finance` | Native Notes tag (with or without `#`); textual hashtags are ordinary words |
| `has:link`, `has:attachment`, `has:checklist`, `has:drawing`, `has:image`, `has:video`, `has:audio`, `has:pdf`, `has:table`, `has:scan`, `has:tag` | The note body contains that kind of object |
| `checklist:open`, `checklist:done` | At least one unchecked item; or items present and all checked |
| `pinned`, `locked`, `shared` (or `is:pinned` …) | Note flags; `shared` includes notes in a shared folder |
| `words:>250` | Word count, with `=`, `>`, `>=`, `<`, `<=` |
| `created:>=2026-07-01`, `modified:<2026-09-01` | Dates as `YYYY-MM-DD` in local time, with the same operators; `=` means that whole day |
| `a b`, `a AND b`, `a OR b`, `NOT a`, `-a`, `( … )` | AND is implicit and binds tighter than OR |

Operators are case-insensitive. Quote an operator or flag word to search it
literally, for example `"and"` or `"pinned"`. Queries are capped at 256 tokens
and 64 levels of nesting. An unknown field such as `titel:x` is an error rather
than a silent text search; quote it to search the literal text.

Password-protected notes match on title and metadata only. Their bodies are
encrypted, so body predicates never match them, and `-body:x` therefore does.
Their snippets are always empty.

**Example - Open to-dos in a folder:**
```json
{
  "query": "folder:\"Work Projects\" has:checklist -checklist:done"
}
```

**Example - Invoices or finance-tagged notes since July, scanning more history:**
```json
{
  "query": "(title:invoice OR tag:finance) modified:>=2026-07-01",
  "scanLimit": 2000,
  "limit": 20
}
```

**Returns:** Matching notes, most recently modified first, each with `id`,
`title`, `folder`, `account`, `modified`, `created`, and a `snippet` centred on
the first matched phrase. The ids are the same `x-coredata://…/ICNote/p…` form
every other tool accepts. `structuredContent` also reports `matched` (total
matches), `scanned`, `eligible`, `scanTruncated`, `truncated`, and `unreadable`
(bodies that could not be decoded). A malformed query returns an error naming
the problem and its position.

---

#### `get-note-content`

Retrieves the full content of a specific note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Note title (use `id` instead when available) |
| `account` | string | No | Account containing the note (defaults to Notes.app's default account; exact or unique-prefix match, ignored if `id` is provided) |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended as it's unique and avoids issues with duplicate titles.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456"
}
```

**Example - Using title:**
```json
{
  "title": "Shopping List"
}
```

**Returns:** The HTML content of the note, its exact `id`, and a
`contentHash`. Pass that hash back as `expectedContentHash` for a later update,
append, or delete; the write is rejected if the note's body or rich metadata
changed after this read. With Full Disk Access, embedded URLs omitted by
AppleScript are restored and returned in `links`. The response also reports
actual `nativeTags`, `richContentComplete`, and `writable`. Textual `hashtags`
remain a separate field and are not proof that Notes registered native tags.
`writable` is also false when the note uses formatting that AppleScript's HTML
does not carry (superscript, subscript, non-left paragraph alignment, or
highlight): a full-body `update-note` would silently drop it, so it is refused
and the `warning` names the formatting. `append-to-note` with `scopeText` still
works through the native path, which verifies existing formatting.

**⚠️ The returned body can be lossy — do not write it back verbatim.** Inline
base64 images larger than `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` (default
256 KB) are replaced with `[inline image omitted: …]` text placeholders so an
image-heavy note cannot blow the MCP message limit. `structuredContent` reports
this as `strippedImages` (count) and `truncated` (boolean). When either is set,
passing this body to an unguarded full-body writer would replace the real images
with placeholder text. This server refuses update and append operations on
attachment-bearing notes; edit them in Notes.app.

---

#### `get-native-objects`

Reads native object identities and ranges, checklist item IDs and state, actual
native tags, and native table data from one exact note ID. Table output includes
stable row and column identifiers. `tableCellsComplete` is false when Notes
metadata cannot be decoded completely. This tool is read-only and requires Full
Disk Access.

---

#### `get-note-tables`

Reads every native table in one exact note, in body order, from the NoteStore
database. Each table is returned as GitHub-flavored Markdown and as JSON `rows`
with stable `rowIds` and `columnIds`. Notes tables have no header row, so the
Markdown uses the first row as the header. Pipes are escaped as `\|`,
backslashes are doubled, and line breaks inside a cell become `<br>`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID (`x-coredata://…/ICNote/pNNN`) |

`tableCellsComplete` is false when any table or cell could not be decoded. A
cell holding an embedded object is `null` in `rows`, listed in
`incompleteCells`, and shown as `[undecoded cell]` in Markdown. A table whose
data cannot be decoded at all has `complete: false`, a `reason`, and no rows.
Cell text is never guessed. Links and styling inside cells are not rendered.
A note without tables returns an empty `tables` list. This tool is read-only,
requires Full Disk Access, and refuses password-protected notes.

---

#### `get-note-blocks`

Decodes one note's body into typed blocks, read-only, from the NoteStore
database. Each block is one paragraph with its `style` (`title`, `heading`,
`subheading`, `body`, `monospaced`, `bulleted`, `dashed`, `numbered`,
`checklist`, or `unknown` with the raw `styleType`), `indent`, `alignment`,
`blockQuote`, checklist `id`/`done`, and `paragraphUuid` when stored. Each
block lists its inline `runs` with `bold`, `italic`, `underline`,
`strikethrough`, `superscript`, `subscript`, `color`, `highlight`, `link`
(plus `linkSafe`), `font`, and `attachment`, and its attachment markers in body
order. Offsets and lengths count UTF-16 code units. `summary` counts styles and
inline attributes for the whole note. `undecodedFields` lists stored field
numbers the decoder deliberately does not interpret.

**Requires:** Full Disk Access. Password-protected notes are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID |
| `offset` | number | No | First block to return (default 0). Use `page.nextOffset` |
| `limit` | number | No | Maximum blocks per page (default 500, max 5000) |

A page also stops early to stay under `APPLE_NOTES_MCP_BLOCKS_MAX_BYTES`
(default 4 MB). `paragraphUuid` is not unique: Notes copies it when a paragraph
is split. Link URLs are returned as stored, and `linkSafe` is false for schemes
other than http(s), `notes:`, `applenotes:` and `mailto:`. Errors carry a
stable code in brackets, such as `[encrypted]` or `[no-full-disk-access]`.

---

#### `list-native-tags`

Lists actual native Notes tags. This differs from textual hashtag search. It is
read-only and requires Full Disk Access.

- **Folder mode** (pass `folder`, optionally `account`): maps each tag used in that
  folder to its matching note IDs. The response reports `complete: false` and per-note
  errors when some native metadata is unavailable.
- **Inventory mode** (omit `folder`): an account-wide inventory with counts, read-only from the
  database. `account` narrows it to one account; omit it to count every
  account. Each `inventory` entry has `tag`, `noteCount` (distinct notes, Recently
  Deleted excluded), per-account counts in `accounts`, and any other `spellings` Notes
  treats as the same tag. Tags with no remaining notes are listed with `noteCount: 0`.
  A tag counts for a note only while the note body still references it. Locked or
  unreadable bodies are counted from the tag objects alone and reported through
  `unverifiedNotes` and `complete: false`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | No | Folder to list (nested paths supported). Omit for the inventory |
| `account` | string | No | Account name, exact or unique prefix |

---

#### `native-tags-status`

Checks whether exactly one configured Native Tags Shortcut is installed. An
installed workflow may still need macOS permission on its first execution, and
installation does not show whether that consent was given: run it once in the
foreground in Shortcuts.app and choose **Always Allow** after install or upgrade
(see [Troubleshooting](#native-writes-time-out-or-report-an-uncertain-outcome)).

---

#### `add-native-tags`

Adds actual native Notes tag objects to one exact note using `id`, a fresh
`expectedContentHash`, a distinctive existing `scopeText`, and `tags`. The
operation verifies the note's original text, links, and native objects after the
Shortcut runs. It refuses ambiguous title-and-scope matches and never retries an
uncertain write. Install the signed workflow as described in
[`shortcuts/README.md`](shortcuts/README.md).

---

#### `get-note-plaintext`

Retrieves a note's body as plain text, with no HTML markup.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Note title (use `id` instead when available) |
| `account` | string | No | Account containing the note (defaults to Notes.app's default account; exact or unique-prefix match, ignored if `id` is provided) |

**Note:** Either `id` or `title` must be provided. This reads the note's native `plaintext` property, so it skips the HTML-to-text conversion that `get-note-content` plus a Markdown pass would do. Use `get-note-content` when you need the HTML, or `get-note-markdown` when you want Markdown with checklist state.

**Returns:** The plain-text content of the note in `structuredContent.plaintext`, or error if not found.

---

#### `get-note-details`

Retrieves metadata about a note (without full content).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact title of the note |
| `account` | string | No | Account containing the note (defaults to Notes.app's default account; exact or unique-prefix match) |

**Example:**
```json
{
  "title": "Project Plan"
}
```

**Returns:** JSON with note metadata:
```json
{
  "id": "x-coredata://...",
  "title": "Project Plan",
  "created": "2025-01-15T10:30:00.000Z",
  "modified": "2025-01-20T14:22:00.000Z",
  "shared": false,
  "passwordProtected": false,
  "account": "iCloud"
}
```

---

#### `get-note-by-id`

Retrieves a note using its unique CoreData identifier.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The CoreData URL identifier (e.g., `x-coredata://...`), or the note's Notes UUID or numeric key (see [Identifier forms](#identifier-forms)) |

**Returns:** JSON with note metadata, plus `identifier`, `folderIdentifier`, and `accountIdentifier` when Full Disk Access is granted, or error if not found.

---

#### `show-note`

Reveals a note in Notes.app using its unique CoreData identifier.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The CoreData URL identifier (e.g., `x-coredata://...`), or the note's Notes UUID or numeric key |
| `separately` | boolean | No | Open in a separate note window when supported by Notes.app |

**Returns:** Confirmation that Notes.app accepted the show command.

---

#### `update-note`

Updates an existing note's content and/or title.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID returned by a read or search |
| `expectedContentHash` | string | Yes | `contentHash` from the exact note version being replaced |
| `newTitle` | string | No | New title (if changing the title; ignored when `format` is `"html"`) |
| `newContent` | string | Yes | New content for the note body |
| `format` | string | No | Content format: `"plaintext"` (default) or `"html"`. When `"html"`, content replaces the entire note body as raw HTML and `newTitle` is ignored (the first HTML element serves as the title) |
| `allowLinkChanges` | boolean | No | Set to `true` only when intentionally changing or removing existing links |

Title-only updates are rejected because Apple Notes titles are not unique.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "newContent": "Updated content here"
}
```

**Example - Update with HTML formatting:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "newContent": "<p>New findings with <b>bold</b> emphasis.</p><pre><code>console.log('hello');</code></pre>",
  "format": "html"
}
```

**Returns:** Confirmation with the exact ID, post-save `contentHash`, and
`verifiedVisibleText: true`, or an error if the note changed before saving.
Apple Notes normalizes HTML, so this proves the visible text after saving, not
byte-identical rich formatting.

**Note:** `newContent` **replaces the entire note body** — it is not appended. To add to a note, prefer [`append-to-note`](#append-to-note), which does the read-and-concatenate for you and always round-trips the body as HTML. If you do read-modify-write by hand, note that `get-note-content` replaces oversized inline images with text placeholders (see [`get-note-content`](#get-note-content)) — writing that body back bakes the placeholders in.

**Rich-content safety:** `update-note` refuses to replace a note when its rich
metadata is unavailable or it contains attachments, native tags, inline
objects, or checklists that AppleScript cannot preserve. Existing link
destinations must remain present unless `allowLinkChanges` is explicitly set.

---

#### `delete-note`

Deletes a note (moves to Recently Deleted in Notes.app).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID returned by a read or search |
| `expectedContentHash` | string | Yes | `contentHash` from the exact note version being deleted |

Title-only deletion is rejected. If the note changed after the supplied hash
was read, deletion is also rejected.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

**Returns:** Confirmation message, or error if note not found. The delete and a
check of the note's original folder run in one AppleScript: if Notes.app accepts
the delete but the note is still listed in that folder, the call reports that
nothing was deleted instead of claiming success.

A note that is already in Recently Deleted is refused, because deleting it there
removes it permanently. The folder is read live from Notes.app in the same
AppleScript; the Recently Deleted folder is recognised by its database id (with
Full Disk Access) or by its English name. To remove such a note for good, do it
in Notes.app.

**⚠️ Safety:** Irreversible from the agent's side — requires explicit user confirmation before calling. Prefer `search-notes` / `list-notes` first to confirm the exact id(s) being deleted.

---

#### `move-note`

Moves a note to a different folder. The note is relocated in place via Notes.app's native `move`, so its id, creation date, and all embedded attachments (files, images, scans, PDFs, audio) are preserved. The destination folder must already exist — create it first with [`create-folder`](#create-folder).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID returned by a read or search |
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`) |

Title-only moves are rejected.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "folder": "Archive"
}
```

**Returns:** Confirmation only after the same note ID is read back and its
actual destination folder ID matches the requested folder.

---

#### `append-to-note`

Appends or prepends content to an existing note without replacing it. Always reads and writes as HTML, preserving all existing rich formatting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID returned by a read or search |
| `expectedContentHash` | string | Yes | `contentHash` from the exact note version being extended |
| `content` | string | Yes | Text to append to the note body |
| `position` | string | No | `"after"` (default) appends to the end; `"before"` inserts directly below the note's title line, so the title stays first |
| `separator` | string | No | String placed between existing content and new content (default: two newlines → `<div><br></div>` in HTML) |
| `format` | string | No | Format of the content being appended: `"plaintext"` (default) or `"html"` |

Title-only appends are rejected.

**Example - Append plaintext:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "content": "New item added today"
}
```

**Example - Prepend HTML:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "content": "<div><b>Status:</b> done</div>",
  "format": "html",
  "position": "before"
}
```

**Returns:** Confirmation with the exact ID, post-save `contentHash`, and
`verifiedVisibleText: true`. Apple Notes normalizes HTML, so this proves the
visible text after saving, not byte-identical rich formatting. Warns when the
note is shared with collaborators.

**Safety:** The append is rejected if the note changed since it was read, rich
metadata is unavailable, or the note contains attachments. Existing link
destinations are verified after saving.

**Notes containing native objects** (a table, a checklist, native tags) cannot be
spliced, so they are routed to the native end-append bridge — see
[`append-native`](#append-native). That path additionally requires `scopeText`,
keeps the default blank-line `separator` and `position: "after"`, and accepts a
fixed HTML subset rather than anything Notes.app can render:

| | Native append |
|---|---|
| Elements | `<a>` `<b>` `<br>` `<code>` `<del>` `<div>` `<em>` `<h1>` `<h2>` `<h3>` `<i>` `<li>` `<ol>` `<p>` `<s>` `<span>` `<strong>` `<table>` `<tbody>` `<td>` `<th>` `<thead>` `<tr>` `<tt>` `<u>` `<ul>` |
| Attributes | `href` on `<a>` (`https:`, `http:`, `notes:`, `applenotes:`, `mailto:` only) and a `font-size` style on `<span>`, e.g. `<span style="font-size: 18px">` — the form Notes itself stores a heading as |
| Refused | every other element and attribute, by name, naming the accepted subset; `<table>` here (use [`create-table`](#create-table)); comments, doctype and processing instructions |

Ordinary notes take the guarded HTML path and are not restricted to that subset.

---

#### `insert-link`

Adds one web, mail or Notes link to an exact note as its own paragraph, then
proves it from the link runs Notes actually stored. Use `mode: "raw"` to show
the URL itself, or `mode: "hyperlink"` with a `label` to show text that links to
the URL. For a link to another note by id, use
[`insert-note-link`](#insert-note-link), which looks up that note's real deep
link.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID |
| `expectedContentHash` | string | Yes | `contentHash` from the exact note version being extended |
| `url` | string | Yes | Absolute `http(s)` URL with a host, or a `mailto:`, `notes://` or `applenotes:` link. No spaces, `<`, `>` or `"` |
| `mode` | string | No | `"raw"` (default) shows the URL; `"hyperlink"` shows `label` |
| `label` | string | Hyperlink only | Visible text for `mode: "hyperlink"`; refused in raw mode |
| `linked` | boolean | No | Raw mode only. `true` (default) stores a real link on the URL text. `false` writes plain text with no stored link |
| `position` | string | No | `"end"` (default) or `"after-title"` (first paragraph under the title) |
| `blankLine` | boolean | No | Leave a blank line between existing text and the link paragraph (default `true`) |
| `scopeText` | string | Native-object notes only | Unique existing phrase, as for [`append-native`](#append-native) |

**Example - Hyperlink under the title:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "url": "https://example.com/report",
  "mode": "hyperlink",
  "label": "Quarterly report",
  "position": "after-title"
}
```

**Returns:** `route` (`"applescript"` for ordinary notes, `"native"` for notes
with native objects), `linkStored`, `storedUrl` (the destination read back from
the note, for example `https://example.com/` for a bare origin), and the new
`contentHash`.

**Safety:** The same guards as [`append-to-note`](#append-to-note): a fresh
`expectedContentHash`, the attachment block, and every existing link must
survive. A linked insert must add exactly one stored link with the requested
label and destination; if the text lands but that proof fails, the error says
the write happened so it is not repeated.

**Limits:**

- Plain URL text is not linked by Notes when written this way. With
  `linked: false`, the note stores no link and readers of the body see ordinary
  text; Notes.app may still underline the URL on screen through its own data
  detection. The result reports `linkStored: false`.
- Notes with native objects (a table, a checklist, native tags) take the native
  end-append path, so only `position: "end"` with `blankLine: true` works there.
- The link always gets its own paragraph. Placing it at the end of one existing
  paragraph, or inside the text, is not available.
- Rich URL preview cards (the link tile Notes makes when you paste a URL) are
  not produced. No public automation route creates one: the Shortcuts Notes
  actions write text, and AppleScript's `body` has no card markup.
- To start a new note with a link, use [`create-note`](#create-note) with
  `format: "html"` and an `<a href>` in `content`; the link is stored the same
  way.

---

#### `get-note-link`

Returns the `notes://showNote?identifier=<uuid>` deep-link URL for a note. The URL opens the note in Notes.app on iOS and macOS and can be stored in Reminders tasks or shared links.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Note title (use `id` instead when available) |
| `account` | string | No | Account containing the note (defaults to Notes.app's default account; exact or unique-prefix match, ignored if `id` is provided) |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended. Password-protected notes cannot be linked.

**Example:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456"
}
```

**Returns:** `notes://showNote?identifier=<uuid>` URL string, plus the note id and title.

**Note:** Requires Full Disk Access for the app that launches the server so the Notes SQLite database is readable. On macOS 12–15 the tool also falls back to the AppleScript `note link` property. Run the `doctor` tool to verify access.

---

#### `list-notes`

Lists all notes, optionally filtered by folder, date, and limit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list notes from (defaults to Notes.app's default account; exact or unique-prefix match) |
| `folder` | string | No | Filter to notes in this folder only (supports nested paths like `"Work/Clients"`) |
| `modifiedSince` | string | No | ISO 8601 date string to filter notes modified on or after this date (e.g., `"2025-01-01"`) |
| `limit` | number | No | Maximum number of notes to return |
| `includeRecentlyDeleted` | boolean | No | Also list notes in Recently Deleted, each flagged `inRecentlyDeleted: true` (default `false`) |

**Example - All notes:**
```json
{}
```

**Example - Notes in a folder:**
```json
{
  "folder": "Work"
}
```

**Example - Recent notes with limit:**
```json
{
  "modifiedSince": "2025-06-01",
  "limit": 20
}
```

**Returns:** List of notes as `{title, id}` pairs — `notes: Array<{title, id}>`, plus `count`. The human-readable line is `  - <title> [id: <id>]`. Notes in Recently Deleted are left out by default and counted in `excludedRecentlyDeleted` (present only when nonzero); with `includeRecentlyDeleted: true` they are listed with `inRecentlyDeleted: true` and a `[RECENTLY DELETED]` marker. Notes.app's own listing includes them, so the Recently Deleted folder is recognised by its database id (with Full Disk Access) or by its English name. With Full Disk Access each entry also carries `identifier`, `folderIdentifier`, and `accountIdentifier` (see [Identifier forms](#identifier-forms)).

Use the returned `id` for any follow-up read/update/move/delete rather than re-resolving the title: titles are not unique, and a by-title lookup resolves a duplicated title to the same one note every time, silently skipping the others.

> **Changed in 2.7.0:** `notes` was previously `string[]` (titles only). Callers that treated the array as strings must now read `.title`.

---

#### `get-selected-notes`

Reads the currently selected note(s) from the Notes.app UI.

**Parameters:** None

**Returns:** Selected note metadata, including IDs for follow-up operations. Returns an empty list when Notes.app has no selected note.

---

### Folder Operations

#### `list-folders`

Lists all folders in an account with full hierarchical paths.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list folders from (defaults to Notes.app's default account; exact or unique-prefix match) |

**Example:**
```json
{}
```

**Returns:** List of folders with IDs, paths, account names, and shared state, plus `identifier`, `parentIdentifier`, and `accountIdentifier` when Full Disk Access is granted. Nested folders are shown as full paths (e.g., `Work/Clients/Omnia`). Duplicate folder names are disambiguated by their full path. Literal slashes in folder names are escaped as `\/` (e.g., `Spain\/Portugal 2023`).

---

#### `list-smart-folders`

Lists every Smart Folder with the rules that define it, read from the NoteStore
database. Requires Full Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeMatchingNotes` | boolean | No | Also list the notes each smart folder currently shows (default `false`) |
| `limit` | number | No | Maximum matching notes per folder, 1–500 (default 50). `matchingNoteCount` is always the total |

**Example:**
```json
{
  "includeMatchingNotes": true,
  "limit": 20
}
```

**Returns:** For each smart folder: `name`, `id`, `identifier`, `account`,
`accountId`, `accountIdentifier`, `parent`, `parentId`, and `parentIdentifier`
(the parent fields are `null` at the account root). Its rules are decoded as
`match` (`"all"`, `"any"`, or `"none"`) and `filters`. Each filter has a `type`
(the stored rule key, such as `folder`, `tag`, `checklist`, or
`creationDateRelativeRange`), its stored `value`, `excluded` for an Exclude
rule, and a readable `description`. Folder filters add the folder's `name` and
`folderId`, and a nested rule group is a filter of type `group` with its own
`match` and `filters`. Notes stores each query inside an outer
`{"deleted": false}` wrapper that keeps Recently Deleted out. `query` is the
stored query with that wrapper removed, `includesRecentlyDeleted` reports the
wrapper's value, and `rawQuery` is the stored JSON verbatim. A rule this server
does not recognize is kept as a filter of type `unknown`, and `fullyDecoded` is
then `false`.

With `includeMatchingNotes`, each folder also carries `matchingNoteCount` and
`matchingNotes` (`title` and `id`). These come from Notes.app itself, which
evaluates the folder's rules, so they need Automation permission. The server
does not re-evaluate the rules on its own. A folder whose notes cannot be read
carries `matchingNotesError` instead.

---

#### `create-folder`

Creates a new folder, including a whole nested hierarchy in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Folder name, or a nested path separated by `/` (e.g. `"Retro Tech/PC/CPUs"`). Every intermediate folder is created; segments that already exist are skipped |
| `account` | string | No | Account to create folder in (defaults to Notes.app's default account; exact or unique-prefix match) |

**Example:**
```json
{
  "name": "Work Projects"
}
```

**Example - Create a nested hierarchy:**
```json
{
  "name": "Work/Clients/Omnia"
}
```

**Returns:** Confirmation message. The call is **idempotent** — an already-existing folder (or path segment) is skipped rather than treated as an error, so it is safe to call before every `create-note` that targets a folder.

---

#### `get-folder-by-id`

Reads one exact folder's current name and parent ID. Use these values with
`rename-folder`; this avoids relying on ambiguous folder names or paths. The
`id` may also be the folder's Notes UUID or numeric key, and the result adds
`identifier`, `parentIdentifier`, and `accountIdentifier` when Full Disk Access
is granted.

---

#### `rename-folder`

Renames an existing folder in place using its exact `id`, `expectedName`,
`expectedParentId`, and `newName`. The operation preserves the folder ID, notes,
and descendants. It refuses stale metadata and a conflicting sibling name.

---

#### `delete-folder`

Deletes a folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name or path of the folder to delete (supports nested paths like `"Work/Old"`) |
| `account` | string | No | Account containing the folder (defaults to Notes.app's default account; exact or unique-prefix match) |

**Example:**
```json
{
  "name": "Old Projects"
}
```

**Returns:** Confirmation message, or error if folder not found or not empty.

**⚠️ Safety:** Irreversible — requires explicit user confirmation before calling. Prefer `list-folders` first to confirm the exact folder path being deleted.

---

#### `show-folder`

Reveals a folder in Notes.app using its unique CoreData identifier.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The folder's CoreData identifier (from `list-folders`), or its Notes UUID or numeric key |
| `separately` | boolean | No | Open in a separate window when supported by Notes.app |

**Returns:** Confirmation that Notes.app accepted the show command.

---

### Account Operations

#### `list-accounts`

Lists all configured Notes accounts.

**Parameters:** None

**Example:**
```json
{}
```

**Returns:** List of accounts with names, IDs, upgraded state, and default folder metadata, plus each account's `identifier` (Notes UUID) when Full Disk Access is granted.

---

#### `get-default-location`

Returns the default account and folder Notes.app uses for newly created notes.

**Parameters:** None

**Returns:** Default account and folder metadata, including IDs and shared state.

---

#### `show-account`

Reveals an account in Notes.app using its unique CoreData identifier.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The account's CoreData identifier (from `list-accounts`) |
| `separately` | boolean | No | Open in a separate window when supported by Notes.app |

**Returns:** Confirmation that Notes.app accepted the show command.

---

### Batch Operations

#### `batch-delete-notes`

Deletes multiple notes at once by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `notes` | object[] | Yes | Array of `{id, expectedContentHash}` snapshots to delete (max 500 per request) |

**Returns:** Summary of successes and failures. A note already in Recently Deleted fails without being deleted, as in `delete-note`.

**⚠️ Safety:** Irreversible — requires explicit user confirmation before calling. Prefer `search-notes` / `list-notes` first to confirm the exact ids being deleted.

---

#### `batch-move-notes`

Moves multiple notes to a folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Array of note IDs to move (max 500 per request) |
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`). Must already exist — create it with [`create-folder`](#create-folder) |
| `account` | string | No | Account containing the folder |

**Returns:** Summary of successes and failures. Each success is reported only
after the note's actual container folder ID matches the destination folder ID.

---

### Export Operations

#### `export-notes-json`

Exports notes as JSON — metadata, HTML content, and plaintext, grouped by account and folder — one page at a time. A whole library rarely fits in one MCP message (note bodies embed images as base64), so each call returns a page and says where the next one starts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `offset` | number | No | 0-based position to start from, counting notes in account → folder → note order (default `0`). Pass the previous page's `page.nextOffset` |
| `limit` | number | No | Maximum notes in this page (default `50`, max `500`). A page holds fewer when it reaches the response size limit |
| `modifiedSince` | string | No | ISO 8601 date string; export only notes modified on or after this date (e.g., `"2025-01-01"`). Keep the same value while paging |

**Example - First page:**
```json
{}
```

**Example - A later page of an incremental backup:**
```json
{
  "offset": 50,
  "modifiedSince": "2025-06-01"
}
```

**Returns:** `exportDate`, `version`, `accounts` (every account and folder, holding the notes that fall in this page), `summary` (`totalNotes` in this page, `totalFolders`, `totalAccounts`), and `page`:

| Field | Description |
|-------|-------------|
| `offset` / `limit` | The window that was applied |
| `totalAvailable` | Notes in the library, after `modifiedSince` |
| `returned` | Notes in this page |
| `nextOffset` | Where the next page starts; absent on the last page |
| `hasMore` | `true` until the last page — call again with `offset` set to `nextOffset` |
| `stoppedAtSizeLimit` | `true` when the page closed early to stay under the response size limit |

**Size limit:** each response stays under `APPLE_NOTES_MCP_EXPORT_MAX_BYTES` (default 8 MB), below the 10 MB per-message limit of MCP SDK stdio clients, which drop the connection on anything larger without passing on any error text. A note too large to fit on its own is still returned: its oversized inline images are replaced with placeholders (`strippedImages`), or failing that its HTML body, and if necessary its plaintext, is left empty with `contentOmitted: true`. Read such a note with `get-note-content`, and its files with `list-attachments` / `save-attachment`. Lower `limit` if your MCP client caps tool output below that size.

**Paging:** positions are worked out on every call, so notes created, deleted, or moved between calls can shift a page. Page through promptly, or use `modifiedSince` for incremental backups.

---

#### `get-note-markdown`

Gets a note's content as Markdown instead of HTML. If the note contains checklists and Full Disk Access is granted, checklist items are automatically annotated with `[x]` (done) or `[ ]` (undone).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred) |
| `title` | string | No | Note title |
| `account` | string | No | Account containing the note |

**Returns:** Note content converted to Markdown format. Checklist items include `[x]`/`[ ]` prefixes when database access is available.

---

#### `export-notes-markdown`

Exports one note, or the notes of one folder, as a single Markdown document
rendered from the decoded note body (the same block model as
[`get-note-blocks`](#get-note-blocks)). Titles render as `#`, headings as `##`,
subheadings as `###`. Bulleted, dashed and numbered lists keep their indent
(four spaces per level), checklists render as `- [x]`/`- [ ]`, block quotes as
`>`, and monospaced paragraphs as fenced code. Inline runs keep bold, italic,
strikethrough, underline (`<u>`), highlight (`==`), superscript and subscript
(`<sup>`/`<sub>`), and links whose scheme is http(s), `notes:`, `applenotes:`
or `mailto:`. Tables render as GitHub tables. Attachments stay in body order:
with `assetsDir` they link to copies of their files (images inline, drawings
through Notes' fallback image, scans as their PDF), and without it they render
as labeled placeholders such as `\[Image: name\]`. An attachment whose file
cannot be found renders as `\[Image unavailable: name\]`. This tool leaves
`get-note-markdown` unchanged.

A folder export is one presentation document with notes separated by `---`.
It is not a backup or restore format; use `export-notes-json` for that.

**Requires:** Full Disk Access. Password-protected notes are skipped in a
folder export (listed in `skipped` with code `encrypted`) and refused for a
single note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | One of `id`/`folder` | Exact note ID |
| `folder` | string | One of `id`/`folder` | Folder path, as for `list-notes` |
| `account` | string | No | Account holding `folder` |
| `limit` | number | No | Maximum notes read from the folder (default 100, max 1000) |
| `outputPath` | string | No | Absolute file to create. Create-only: an existing file (or symlink) is refused with `[output_exists]` |
| `assetsDir` | string | No | Absolute directory for attachment copies. Existing files are never replaced; a taken name gets `-2`, `-3`, ... |
| `wrap` | number | No | Hard-wrap prose at this many columns. Code, tables and headings are never wrapped |

Both paths follow the `save-attachment` rules (absolute, under the home
directory, a temp directory, or `/Volumes`, no symlink escapes) and may not
point inside the Notes library container. With `outputPath`, asset links are
relative to the document's directory; without it they are absolute paths.

**Returns:** without `outputPath`, the Markdown itself (refused with
`[too-large]` above half of `APPLE_NOTES_MCP_EXPORT_MAX_BYTES`, because the
document travels in both the text and structured result). With `outputPath`, a
receipt: `format`, `count`, `bytes`, `output`, and `assets` (`dir`, `files`).
Both carry `stats` (attachments, placed, placeholders, unavailable, tables,
unreadableTables, unreferenced) and `skipped`. Nothing already written is
deleted if a later step fails.

---

#### `export-notes-html`

Exports one note, or the notes of one folder, as one standalone HTML file
rendered from the decoded note body. It uses the same block model and
attachment handling as [`export-notes-markdown`](#export-notes-markdown).
Headings become `h1`-`h3`, lists nest by indent as `ul`/`ol`, checklists show
disabled checkboxes, block quotes and monospaced paragraphs become
`blockquote` and `pre`, and inline runs keep bold, italic, underline,
strikethrough, highlight, superscript, subscript, text color and safe links.
Tables are semantic `<table>` elements with a header row. Images, drawings
(Notes' fallback image, or its preview), scans (PDF with preview), audio,
video, files and link cards (title, domain and preview thumbnail) appear in
body order. Attachments with no body marker are appended in creation order.
An attachment with no usable source renders a visible
`[Image unavailable: name]` marker. The document contains no script, no
`file:` URL and no Notes library path.

A folder export is one presentation document with notes separated by
`<hr class="note-separator">`. It is not a backup or restore format.

**Requires:** Full Disk Access. Password-protected notes are skipped in a
folder export and refused for a single note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | One of `id`/`folder` | Exact note ID |
| `folder` | string | One of `id`/`folder` | Folder path, as for `list-notes` |
| `account` | string | No | Account holding `folder` |
| `limit` | number | No | Maximum notes read from the folder (default 100, max 1000) |
| `outputPath` | string | Yes | Absolute HTML file to create. Create-only: an existing file is refused with `[output_exists]` |
| `embedAssets` | boolean | No | Embed assets as data URLs (default `true`). Each asset is capped at 10 MiB and a document at 256 MiB of embedded assets; a larger one renders as unavailable with a hint to use `embedAssets: false` |
| `assetsDir` | string | No | With `embedAssets: false`, the sidecar directory (default `<output stem>.assets` beside the file). Existing files are never replaced; a taken name gets `-2`, `-3`, ... |

The HTML is always written to a file, because an embedded document is too
large for an MCP message. Paths follow the `save-attachment` rules and may not
point inside the Notes library container. Sidecar URLs are relative to the
HTML file, so the file and its `.assets` directory can be moved together.

**Returns:** `format`, `count`, `bytes`, `output`, either `embedded` (assets
embedded) or `assets` (`dir`, `files`), `stats`, and `skipped`. Nothing
already written is deleted if a later step fails.

---

#### `get-checklist-state`

Reads checklist done/undone state for a note. This bypasses the AppleScript limitation where `body of note` strips checklist state, by reading directly from the NoteStore SQLite database.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID (use `search-notes` to find it first) |

**Example:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456"
}
```

**Returns:** Checklist items with done/undone state and progress count:
```
Checklist for "Shopping List" (2/4 done):
[x] Buy milk
[x] Get bread
[ ] Pick up laundry
[ ] Call dentist
```

---

#### `get-note-metadata` (BETA)

Reads note metadata that AppleScript cannot expose, by querying the NoteStore SQLite database directly: pinned state, checklist flags, trash/recovery state, the preview snippet, and the password hint. The available fields vary by macOS version.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)).

**BETA:** the NoteStore schema changes between macOS releases, so some fields can be absent on older or newer systems. The database is only ever read, never written.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID (use `search-notes` to find it first) |

**Returns:** A metadata object in `structuredContent` holding any of `pinned`, `hasChecklist`, `hasChecklistInProgress`, `recoveringFromTrash`, `passwordProtected`, `passwordHint`, `snippet`, `widgetSnippet`, and `smartFolderQuery`. Unlike most read tools, it also resolves trashed notes that AppleScript can no longer find.

---

#### `list-special-notes`

Lists a set of notes that AppleScript cannot enumerate: pinned notes, Quick Notes, notes in Recently Deleted, or password-protected notes. It reads the NoteStore database read-only and returns metadata only, never body text.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `kind` | string | Yes | `pinned`, `quick-notes`, `recently-deleted`, or `locked` |
| `account` | string | No | Only this account (exact or unique-prefix name). Omit for every account |
| `limit` | number | No | Maximum rows, 1–1000 (default 100) |

**Returns:** `notes`, newest first, each with `id`, `identifier` (Notes UUID), `title`, `folder` (path in `list-folders` syntax, or `null`), `account`, `created`, `modified`, and the flags `pinned`, `locked`, `quickNote`, `inRecentlyDeleted`, and `markedForDeletion`. Unlocked rows add the stored `snippet`. The `locked` listing adds `passwordHint` when one is set. Also returns `count`, `total` (matches before `limit`), `limit`, and `supported`.

- `pinned` and `quick-notes` cover notes in folders outside Recently Deleted. Folderless Quick Note drafts, which Notes.app never shows, are left out.
- `recently-deleted` lists notes in each account's Recently Deleted folder and skips tombstones already waiting to sync away.
- `locked` lists every password-protected note, including trashed and folderless ones, so a misplaced locked note can still be found. Their flags and `folder` say where each one is.
- `supported: false` means this macOS version's database has no column for that kind (for example, Quick Notes before macOS 12).

---

#### `get-audio-transcripts`

Reads the transcript, and the summary when one exists, that Notes already computed for the audio recordings in a note. It does not transcribe anything itself. Notes keeps each recording's transcript as word-level mergeable data on the audio attachment's database row, and this tool decodes it read-only.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)). Password-protected notes are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID (use `search-notes` to find it first) |
| `includeSegments` | boolean | No | Also return word-level segments: `text`, `start` and `duration` in seconds, and `speaker`. Default `false` |
| `maxSegments` | number | No | Cap on segments per attachment when `includeSegments` is set (default 2000, at most 20000) |

**Example:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "includeSegments": true,
  "maxSegments": 500
}
```

**Returns:** `structuredContent.attachments` holds one entry per top-level audio attachment, in the order the recordings appear in the note. Each entry has:

- `attachmentId` (usable with `save-attachment`), `identifier`, `typeUti`, and `durationSeconds` when known
- `status`: `ok` (a transcript is stored), `none` (no transcript is stored, for example a recording Notes has not transcribed, or an audio file attached from elsewhere), or `undecodable` with a `reason`
- `text` (the words joined into readable text), `wordCount`, `fragmentCount`, `speakers`, `summary` and `topLineSummary` when stored, and `needsTranscription` when the database records it
- `segments`, only when `includeSegments` is set, with `segmentsTruncated` when the cap cut them short

A recording extended with more takes has several fragments. Their transcripts are joined in stored order, separated by a blank line, and each segment carries a `fragment` index. Recordings with more than one fragment have been verified against synthetic fixtures only. A response that would exceed `APPLE_NOTES_MCP_EXPORT_MAX_BYTES` (default 8 MB) drops segments first and then shortens `text`, marking `truncated`, `segmentsTruncated` and `textTruncated`. When the note body cannot be parsed, attachments come back in database order with `bodyOrder: false`.

---

#### `add-attachment`

Adds one nonempty local file of at most 64 MiB to an exact note using `id`, the
latest `expectedContentHash`, and an absolute `path`. The server never retries
the insertion. It verifies that existing rich content survived and compares the
fetched attachment bytes with the source before reporting success.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID |
| `expectedContentHash` | string | Yes | `contentHash` from the note version being extended |
| `path` | string | Yes | Absolute path of the local file; symbolic links are refused |
| `filename` | string | No | Name the attachment gets in Notes instead of the source file's name. One path component that keeps the source file's extension, with no slash, colon, backslash, control character, leading dot or surrounding spaces. Notes names a file attachment after the file it receives, so the server gives its private temporary copy this name |

**Returns:** `attachmentId`, `bytes`, the `name` Notes reports, and the new
`contentHash`. With `filename`, `filenameVerified` says whether Notes reports
that exact name. A mismatch is a warning (`filenameWarning`), not a failure,
because the attachment and its bytes are already verified.

---

#### `create-note-with-attachment`

Creates a note and attaches one local file to it in a single call. It checks the
file and `filename` before creating anything, creates the note through Notes.app
the way [`create-note`](#create-note) does in plaintext, then attaches with the
same verification as [`add-attachment`](#add-attachment).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | One-line note title |
| `content` | string | No | Plain-text body placed above the attachment |
| `folder` | string | No | Existing folder or nested path; create it first with [`create-folder`](#create-folder) |
| `account` | string | No | Account name; defaults to Notes.app's default account |
| `path` | string | Yes | Absolute path of the local file (at most 64 MiB) |
| `filename` | string | No | Attachment name override, as in `add-attachment` |

```json
{
  "title": "Signed lease",
  "folder": "Home",
  "path": "/Users/me/Downloads/scan-0042.pdf",
  "filename": "Lease 2026.pdf"
}
```

**Returns:** the new note's `id` with `noteCreated: true` and the
`add-attachment` result. If the attachment step fails after the note exists,
the error names the new note's id: attach to it with `add-attachment` instead of
calling this tool again, which would create a second note.

---

#### `list-attachments`

Lists attachments in a note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred) |
| `title` | string | No | Note title |
| `account` | string | No | Account containing the note |
| `includePaths` | boolean | No | Also report where each attachment's files are on disk (needs `id` and Full Disk Access) |
| `firstImage` | boolean | No | Return only the note's lead visual instead of the list (needs `id` and Full Disk Access) |

**Returns:** List of attachments with IDs, names, content identifiers, URLs when available, created/modified dates, and shared state.

With `includePaths`, each attachment also carries `identifier`, `uti`, `kind` (`image`, `scan`, `drawing`, `pdf`, `audio`, `video`, `url`, `table`, `other`), `bodyIndex`, and three path fields read from NoteStore and the Notes data folder (read-only):

- `assetPaths`: the attachment's own files, best first (the media file, or Notes' fallback image or PDF rendering).
- `previewPath`: Notes' largest rendered thumbnail, chosen by pixel area from the `Previews` entries named `<identifier>-<scale>-<W>x<H>-<appearance>`. It is always the image file, including when the entry is a directory holding `<n>_<uuid>/Preview.png`. `null` when there is none.
- `paths`: `assetPaths` followed by `previewPath`.

Container attachments (a scan gallery) list their child rows under `children`. If the database cannot be read, the list is still returned with a `pathsError`.

With `firstImage`, the result is `{firstImage, orderSource}`. `firstImage` is the first image in the note's body order, even when its asset has not downloaded (`path: null`, possibly with a `previewPath`). A scan or drawing stands in only when the note has no image, and a gallery's pages are considered at the gallery's position (`parentIdentifier`, `galleryIndex`). `orderSource` is `body`, or `creation` when the body did not record attachment order. `firstImage` is `null` when the note has no visual.

**⚠️ Safety:** A lookup failure is reported as an error, never as an empty list — so an empty result reliably means the note has no attachments and is safe to replace wholesale. Treat an error as "unknown", not "none". Treat returned paths as local data: copy files out with [`export-attachments`](#export-attachments) instead of passing raw paths on.

---

#### `save-attachment`

Saves a note attachment to disk.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | CoreData note ID (from `search-notes`/`list-notes`) |
| `attachmentId` | string | Yes | Attachment ID (from `list-attachments`) |
| `savePath` | string | Yes | Absolute destination file path. Must be under your home directory, a temp directory, or `/Volumes`, and never inside the Notes data folder (`~/Library/Group Containers/group.com.apple.notes`), however it is reached (symlink or different letter case) |

**Returns:** Confirmation with the saved path, name, and content type (also in `structuredContent`).

---

#### `list-paper-attachments`

Lists the Paper drawings (`com.apple.paper`) and classic drawings (`com.apple.drawing`, `com.apple.drawing.2`) in one note, and whether Notes has a rendered image of each. Read-only; needs Full Disk Access and does not open Notes.app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID |

**Returns:** Per drawing: `attachmentId`, `identifier`, `uti`, `kind` (`paper` or `drawing`), `handwritingSummary` (the handwriting text Notes recognized, or `null` when it stored none), `bundlePresent` (the Paper data bundle is on disk), `fallbackImagePath` (Notes' full rendering), `previewPath` (its largest thumbnail), and `raster` `{source, format, width, height}`: the validated image `export-paper-image` would copy, or `null`.

Strokes are not decoded. Notes' Paper bundle has no public reader, so the image is Notes' own rendering.

---

#### `export-paper-image`

Saves Notes' rendered image of one Paper drawing or classic drawing to a new file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | Exact CoreData note ID |
| `savePath` | string | Yes | Absolute path for the new file. It must end in the image's extension (`.png`, or `.jpg`/`.jpeg` for a JPEG rendering) |
| `attachmentId` | string | No | The drawing to export (`attachmentId` or `identifier` from `list-paper-attachments`). Required when the note has more than one |

**Returns:** `savedPath`, `format`, `width`, `height`, `bytes`, `source` (`fallback` for Notes' full rendering, `preview` for its largest thumbnail when no full rendering exists), and the drawing's `attachmentId`, `identifier`, `kind`, and `handwritingSummary`.

**⚠️ Safety:** Writes one new file, readable only by you (mode 0600). `savePath` follows the `save-attachment` allowlist (home, temp, or `/Volumes`), may not be inside the Notes data folder, and must not exist yet. The image header (PNG signature and IHDR, or JPEG frame) is checked before copying and the written file is checked again; a file that fails is removed.

---

#### `export-attachments`

Copies a note's attachment files into a directory without opening Notes.app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | Exact CoreData note ID |
| `exportDir` | string | Yes | Absolute destination directory, created if missing. Same allowlist as `save-attachment` (home, temp, or `/Volumes`), and never inside the Notes data folder |
| `firstImageOnly` | boolean | No | Export only the lead visual that `list-attachments` `firstImage` reports |

**Returns:** `exportDir`, counts (`exported`, `previews`, `skipped`, `failed`), and per attachment its `attachmentId`, `identifier`, `kind`, `exportedTo`, and `exportedKind`: `"asset"` for the real file, `"preview"` when the asset never downloaded and only Notes' thumbnail was on disk, or `null` when nothing was on disk. A preview is never chosen over an available asset, and it is named `<name>-preview.<ext>` so it is not mistaken for the original. A scan gallery with no file of its own exports its pages.

**⚠️ Safety:** Existing files are never replaced. A name that is taken gets `-2`, `-3`, and so on. Reads NoteStore and the Notes data folder read-only and needs Full Disk Access.

---

#### `fetch-attachment`

Returns a note attachment's bytes as base64, without writing to disk (the read counterpart to `save-attachment`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | CoreData note ID (from `search-notes`/`list-notes`) |
| `attachmentId` | string | Yes | Attachment ID (from `list-attachments`) |

**Returns:** The attachment name, content type, byte count, and base64 payload in `structuredContent.base64`.

---

#### `show-attachment`

Reveals one note attachment in Notes.app. Attachments are elements of a note, so this takes both the note id and the attachment id (the same pair used by `save-attachment` / `fetch-attachment`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | CoreData note ID (from `search-notes`/`list-notes`) |
| `attachmentId` | string | Yes | Attachment ID (from `list-attachments`) |
| `separately` | boolean | No | Open in a separate window when supported by Notes.app |

**Returns:** Confirmation that Notes.app revealed the attachment.

---

### Diagnostics

#### `health-check`

Verifies Notes.app connectivity and permissions.

**Parameters:** None

**Returns:** Status of all health checks (app installed, permissions, account access).

---

#### `doctor`

Run a full setup diagnostic: Notes.app reachability, the Automation permission, configured accounts, and Full Disk Access — each reported as ok / warn / fail with an actionable message. This is the richer counterpart to `health-check`; reach for it first when something isn't working.

**Parameters:** None

**Returns:** A per-check report (`structuredContent` carries the raw `{healthy, checks[]}`). The Full Disk Access check tells you whether checklist-state features will work — see [Full Disk Access Setup](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md).

The report ends with the same feature matrix as [`get-capabilities`](#get-capabilities)
(`structuredContent.runtimeOS` and `structuredContent.features`). It is
informational: an unavailable optional feature never changes `healthy`.

---

#### `get-notes-stats`

Gets comprehensive statistics about your notes.

**Parameters:** None

**Returns:** Total counts, per-account breakdown, folder statistics, and recently modified counts.

The `structuredContent` also includes a `coverage` object — `{ complete, scanned, covered, warnings[] }`. If `complete` is `false`, one or more accounts (or the recent-activity scan) could not be read and the counts reflect only the scopes that succeeded; the text output adds a "⚠️ Partial results" line. This lets you tell a genuinely empty library apart from a partial failure.

---

#### `get-sync-status`

Checks iCloud sync status.

**Parameters:** None

**Returns:** Whether sync is active, pending uploads, and last activity time.

---

#### `list-shared-notes`

Lists all notes shared with collaborators.

**Parameters:** None

**Returns:** List of shared notes with warnings about collaboration.

---

### Native background operations

Install the signed workflows once as described in
[`shortcuts/README.md`](shortcuts/README.md), then run each once in the
foreground in Shortcuts.app and choose **Always Allow** — again after every
upgrade — so no first-run consent prompt is left for a background run that
cannot display it. Native writes never use UI
automation or write directly to the Notes database. Every operation on an
existing note requires an exact note ID, a fresh `expectedContentHash`, and a
distinctive existing `scopeText` so the Shortcut and server can independently
resolve the same note. Creating a note from Markdown is
[`create-note`](#create-note) with `format: "markdown"`.

#### `get-capabilities`

Reports which background operations are implemented, live-verified, installed,
and currently available, with a specific reason for each unavailable operation.

It also reports `runtimeOS` (`platform`, `macOSVersion` from `sw_vers`,
`darwinRelease`) and a `features` matrix, one entry per feature group:
`applescriptCore`, `fullDiskAccessReads`, `shortcutsBridges`,
`backgroundOperationsBridge`, `nativeTagsBridge`, `markdownNoteBridge`, and the
placeholders `checklistToggle`, `smartFolders`, `paragraphLinks`, and
`audioTranscription`, which need a native helper this server does not ship.
Each entry carries `available`, `osSupported`, `minimumMacOSVersion`,
`requirements`, `missing`, `unverified`, `tools`, and a machine-readable
`reason` that is `null` when available and otherwise the first that applies:

| `reason` | Meaning |
|----------|---------|
| `unsupported_platform` | Not running on macOS |
| `not_implemented` | The server has no implementation for this feature yet |
| `unknown_os_version` | The feature has a macOS floor and `sw_vers` could not be read |
| `requires_macos_<major>` | macOS is older than `minimumMacOSVersion`, e.g. `requires_macos_26` |
| `full_disk_access_missing` | The Notes database is not readable by this process |
| `shortcuts_unavailable` | The `shortcuts` command could not be run |
| `shortcut_not_installed` | A bridge Shortcut is missing or installed more than once |

The probe never opens Notes.app or runs a Shortcut, so the Automation
permission for Notes.app appears under `unverified` rather than being guessed;
`doctor` and `health-check` confirm it by contacting Notes.

#### `append-native`

Appends bounded plaintext, semantic HTML, or Markdown while preserving existing
native objects. The regular `append-to-note` tool routes protected notes here
when `scopeText` is supplied. Use a distinctive phrase of plain words without
punctuation, hashtags, or paths because Notes search may not resolve them
literally. `format: "html"` accepts the fixed subset tabulated under
[`append-to-note`](#append-to-note); content outside it is refused by name, with
the accepted subset in the error. `format: "markdown"` accepts the same bounded
subset as `format: "html"`'s Markdown-shaped content (`#`/`##`/`###` headings,
flat lists, emphasis, and inline links) but is sent through Notes' own native
Markdown importer rather than converted to HTML first, so `#`/`##`/`###`
produce real Title/Heading/Subheading — Notes' HTML importer only
distinguishes two heading levels and renders `###` the same as `##`. Markdown
that the importer would rewrite, so the appended text could not be verified, is
refused before anything is written; the list is under
[Markdown notes](#markdown-notes). A
transport failure names the Shortcut it was waiting on, so a missing or
unapproved bridge is identified rather than guessed at; a timeout also says it
may be an unanswered first-run consent prompt and names the Shortcut to run once
in the foreground.

#### `create-checklist-item`

Appends one real unchecked Notes checklist item and verifies its native identity
and text.

#### `create-checklist-items`

Appends several real unchecked checklist items, 1 to 20, in the order given.
It takes the same `id`, `expectedContentHash` and `scopeText` as
`create-checklist-item`, plus `items`, an array of one-line texts. Each item is
one run of the same verified bridge, so the call takes a few seconds per item
(a full batch of 20 can run about a minute; if your client times out first,
read the note before retrying rather than resending the whole batch) and is
gated with `create-checklist-item` in `get-capabilities`.

After every run the server checks that exactly one new unchecked item with that
text and a new native identity appeared, that every item appended earlier in the
call kept its identity and text, and that nothing else in the note changed. The
verified revision feeds the next run. A final check confirms the new items are
the note's last checklist items in the requested order.

```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "scopeText": "Packing list for the trip",
  "items": ["Passport", "Charger", "Rain jacket"]
}
```

**Returns:** `items`, each with its `index`, native `id` and `text`, plus
`orderVerified` and the new `contentHash`. The first uncertain result stops the
call without a retry and returns `ok: false` with `landed` (the verified items),
`stoppedAt` (the item's index, text, `outcome` of `"not-written"` or
`"uncertain"`, and the error), and `notAttempted`. After an uncertain stop, read
the note before retrying, and retry only the items that are not present.

#### `create-table`

Appends a native table from rectangular string rows and verifies every decoded
cell. It never substitutes a text table. Omit `rows` for an empty 2 × 2 table,
the size Notes itself inserts from Format > Table; its four empty cells are
verified the same way.

#### `set-note-pinned`

Sets an explicit pinned state after checking both the expected current state and
the note revision. It does not rewrite the body.

#### `remove-native-tags`

Removes specified tags from one exact note while preserving unrelated tags and
native objects. It does not delete global tag definitions.

#### `replace-native-tag`

Adds and verifies the new tag before removing the old tag on an explicit list of
freshly read notes. Stops on the first uncertain result. Smart Folder rules are
not changed.

#### `insert-note-link`

Retrieves another note's real deep link and appends it with a static label while
preserving the target note's native objects.

## Usage Patterns

### Basic Workflow

```
User: "Create a note called 'Todo' with my tasks for today"
AI: [calls create-note with title="Todo", content="Tasks for today..."]
    "I've created a note called 'Todo' with your tasks."

User: "What notes do I have?"
AI: [calls list-notes]
    "You have 15 notes: Todo, Shopping List, Meeting Notes..."

User: "Show me the Shopping List"
AI: [calls get-note-content with title="Shopping List"]
    "Here's your shopping list: - Milk - Eggs - Bread..."
```

### Working with Accounts

Omit `account` and an operation targets whichever account **Notes.app itself
reports as the default** — not a hardcoded "iCloud". That matters if your default
is a non-iCloud account, if the account name is localized, or if it carries a
trailing U+F8FF () character.

```
User: "What accounts do I have?"
AI: [calls list-accounts]
    "You have 3 accounts: iCloud, Gmail, Exchange"

User: "List notes in my Gmail account"
AI: [calls list-notes with account="Gmail"]
    "Your Gmail account has 5 notes..."
```

When you do pass `account`, it is resolved in this order:

1. **Exact name match** wins outright.
2. A **unique prefix match** resolves — `account="robert"` finds
   `robert.b.sweet@gmail.com`.
3. An **ambiguous prefix is refused**, with every candidate named:

   ```
   Account "rob" is ambiguous - it matches 2 accounts:
   rob@superiortech.io, robert.b.sweet@gmail.com. Use the full account name.
   ```

That third rule is deliberate. Silently taking the *first* prefix match would
make `delete-note` or `move-note` land in the wrong account and report success.
An unresolvable account is reported as such rather than as "note not found", so
you are not sent looking for the wrong problem.

### Organizing with Folders

```
User: "Create a folder called 'Archive'"
AI: [calls create-folder with name="Archive"]
    "Created folder 'Archive'"

User: "Move my old meeting notes to Archive"
AI: [searches for the note, then calls move-note with its exact id and folder="Archive"]
    "Moved 'Old Meeting Notes' to 'Archive'"

User: "What folders do I have?"
AI: [calls list-folders]
    "You have 5 folders: Work, Work/Clients, Work/Clients/Omnia, Archive, Recipes"

User: "Create a note in Work/Clients about Acme Corp"
AI: [calls create-note with title="Acme Corp", content="...", folder="Work/Clients"]
    "Created 'Acme Corp' in Work/Clients"
```

---

## Installation Options

### npm (Recommended)

```bash
npm install -g apple-notes-mcp
```

### From Source

```bash
git clone https://github.com/sweetrb/apple-notes-mcp.git
cd apple-notes-mcp
```

The repo ships a prebuilt, dependency-free `build/index.js`, so a bare clone runs with nothing but Node installed. `pnpm install` and `pnpm run build` are only needed when you change the source (development uses [pnpm](https://pnpm.io/), not npm).

You can also install straight from the git repo with `npm install -g github:sweetrb/apple-notes-mcp` (building from source requires pnpm), but the published npm package above is the recommended path.

If installed from source, use this configuration:
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "node",
      "args": ["/path/to/apple-notes-mcp/build/index.js"]
    }
  }
}
```

#### Running from a clone in Claude Code (project-scope `.mcp.json`)

This repo ships a `.mcp.json` at its root so that, when you run `claude` from inside a clone, the server is registered automatically as a **project-scope** server — no manual config needed. Just launch Claude Code from the repo directory and approve the server when prompted (the bundled `build/index.js` is committed, so no build step is required).

The entrypoint is written as (an excerpt of that file, not a whole config):

```text
"args": ["${CLAUDE_PROJECT_DIR:-.}/build/index.js"]
```

`CLAUDE_PROJECT_DIR` is the variable Claude Code injects into a project/user-scoped server's environment, and it resolves to the repo root. **You must launch `claude` from inside the repo** for this to work — the bare `.` fallback is only a last resort and is *not* reliable, because it resolves against the launching process's working directory, not the repo.

> **Why not `${CLAUDE_PLUGIN_ROOT}`?** `CLAUDE_PLUGIN_ROOT` is set **only** for marketplace plugin installs, never for a project-scope clone, so it can't drive the clone workflow. Conversely, a plugin install can't use `CLAUDE_PROJECT_DIR` (in a plugin, that points at the *user's* project, not the plugin's own directory). Claude Code does **not** support nested defaults like `${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}`, so a single entrypoint string cannot serve both contexts. The two distribution paths are therefore decoupled: the **plugin** carries its own MCP config in `.claude-plugin/plugin.json` (using `${CLAUDE_PLUGIN_ROOT}`), while the root `.mcp.json` is dedicated to the **clone** workflow (using `${CLAUDE_PROJECT_DIR:-.}`). Because `plugin.json` declares its own `mcpServers`, the plugin does not also auto-load the root `.mcp.json`, so there is no double-registration.

> **Heads-up on scope precedence:** project-scope (`.mcp.json`) outranks user-scope. If you *also* have an `apple-notes` entry registered at user scope (e.g. an absolute path in `~/.claude.json`), the project-scope entry wins and the user-scope one is ignored entirely. Pick one — for local development on this repo, the project-scope `.mcp.json` is the intended source. To pin a specific local build instead, register it at **local** scope (`claude mcp add apple-notes -s local -- node /abs/path/build/index.js`), which outranks project scope.

---

## Configuration

### Environment variables

All configuration is optional — the server works out of the box. Override behavior with these variables (set them in your MCP client's `env` block, or via the [config file](#configuration-file-when-the-host-strips-env) below):

| Variable | Default | Description |
|----------|---------|-------------|
| `APPLE_NOTES_MCP_MAX_BUFFER` | `67108864` (64 MB) | Max bytes captured from a single AppleScript invocation. Raise it if a very large export/list is truncated; lower it to cap memory. |
| `APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES` | `26214400` (25 MB) | Max size of an attachment that [`fetch-attachment`](#fetch-attachment) will base64-encode inline. Larger attachments are rejected with an error pointing at [`save-attachment`](#save-attachment) (which streams to disk and has no such limit). Raise it to fetch bigger attachments inline; lower it to cap memory. |
| `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` | `262144` (256 KB) | Per-image cap on the base64 payload kept inline in a [`get-note-content`](#get-note-content) response. Inline images over the cap are replaced with placeholders (with a warning appended) so an image-heavy note cannot exceed the MCP client's message limit and drop the connection; export the real files with [`save-attachment`](#save-attachment) or [`fetch-attachment`](#fetch-attachment). Raise it to keep bigger images inline. |
| `APPLE_NOTES_MCP_CONFIG_FILE` | `~/Library/Application Support/apple-notes-mcp/config.json` | Path to the JSON config file (see below). |
| `APPLE_NOTES_MCP_TIMEOUT_MS` | `30000` (30 s) | Total AppleScript operation timeout, including retry attempts and delays. Raise it if full-library operations (large searches, exports) time out on a big Notes library. Per-call `timeoutMs` options still win, and a write tool's `timeoutSeconds` argument overrides it for that call. |
| `APPLE_NOTES_MCP_EXPORT_MAX_BYTES` | `8388608` (8 MB) | Largest response `export-notes-json` sends; a page closes early to stay under it. `export-notes-markdown` returns inline Markdown up to half of it. The default sits below the 10 MB per-message limit of MCP SDK stdio clients, which drop the connection on anything larger. Raise it only if your MCP client accepts bigger messages. |
| `APPLE_NOTES_MCP_BLOCKS_MAX_BYTES` | `4194304` (4 MB) | Largest block payload one [`get-note-blocks`](#get-note-blocks) page returns; the page closes early to stay under it, and a single oversized paragraph comes back with `textOmitted: true`. |
| `APPLE_NOTES_MCP_MAX_RETRIES` | `2` | Maximum attempts for a read-only AppleScript call that fails with a **transient** error (Notes.app busy / not responding / lost connection). `2` means one retry; set `1` to fail fast with no retries. Retries share the single `APPLE_NOTES_MCP_TIMEOUT_MS` budget rather than each getting a fresh one, and a retry is skipped when under a second of that budget remains — so this is a ceiling, not a guarantee. In particular a call that exhausts the budget with a **timeout** has no time left to retry by construction. Mutating operations run once because a timeout can occur after Notes.app applied the change. Non-transient errors (e.g. "note not found") never retry. |
| `APPLE_NOTES_MCP_RETRY_DELAY_MS` | `1000` (1 s) | Base delay before the first retry; subsequent retries back off exponentially (1s, 2s, 4s, ...). |
| `DEBUG` / `VERBOSE` | unset | Set either to enable verbose diagnostic logging to stderr. |

### Configuration file (when the host strips `env`)

Some host apps (e.g. Claude Desktop) launch the MCP server with a scrubbed
environment and ignore the `env` block in their server config, so there's no way
to pass `APPLE_NOTES_MCP_*` settings through it. In that case, put them in a JSON
file the host doesn't manage — `APPLE_NOTES_MCP_CONFIG_FILE`, or by default
`~/Library/Application Support/apple-notes-mcp/config.json`:

```json
{
  "APPLE_NOTES_MCP_MAX_BUFFER": "134217728",
  "DEBUG": "1"
}
```

The server reads it at startup and merges values into the environment **without
overriding** anything already set there (so an explicit `env` still wins). This
is the recommended way to configure the server under Claude Desktop. Apple Notes
MCP stores no secrets, but as a general rule keep only non-secret config here.

---

## Full Disk Access

Several tools read directly from the Apple Notes SQLite database, which lives in a macOS-protected directory. Those tools require **Full Disk Access** for the process running the MCP server: `get-checklist-state`, `get-note-metadata`, `get-note-blocks`, `export-notes-markdown`, `export-notes-html`, `get-audio-transcripts`, `list-special-notes`, `list-native-tags`, `get-note-link`, the checklist annotations in `get-note-markdown`, `list-attachments` with `includePaths` or `firstImage`, `export-attachments`, `list-paper-attachments`, `export-paper-image`, and the database half of `get-sync-status`.

> 📘 **For the full why-and-how walkthrough (which app to grant, verifying with `doctor`, graceful degradation), see the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md).** The summary below is the quick version.

### How to Grant Full Disk Access

1. Open **System Settings** (or System Preferences on older macOS)
2. Go to **Privacy & Security > Full Disk Access**
3. Click the **+** button
4. Add the application that hosts the MCP server:
   - **Claude Desktop**: Add `/Applications/Claude.app`
   - **Terminal**: Add `/Applications/Utilities/Terminal.app`
   - **VS Code**: Add `/Applications/Visual Studio Code.app`
   - **iTerm**: Add `/Applications/iTerm.app`
5. Restart the application after granting access

### Without Full Disk Access

Every tool that does not read the Notes database works normally without Full Disk Access — that is the whole AppleScript surface (create, read, search, update, move, delete, folders, accounts, attachments, stats, export). The database-backed tools degrade like this:
- `get-checklist-state` returns an error explaining that database access is needed
- `get-note-metadata` returns the same kind of error — it has no non-database path
- `list-special-notes` and the `list-native-tags` inventory return the same kind of error
- `get-note-link` returns an error on macOS 26+; on macOS 12–15 it still works via the AppleScript `note link` fallback
- `get-note-markdown` returns plain list items without `[x]`/`[ ]` annotations (graceful fallback)
- `get-sync-status` still answers, but reports no pending uploads and no active sync — treat that as "unknown", not "idle"

---

## Security and Privacy

- **Local only** - All operations happen locally via AppleScript. No data is sent to external servers.
- **Permission required** - macOS will prompt for automation permission on first use.
- **Password-protected notes** - Notes with passwords cannot be read or modified via this server.
- **No credential storage** - The server doesn't store any passwords or authentication tokens.

---

## Known Limitations

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Notes and AppleScript are macOS-specific |
| Batch ops run per-note | `batch-delete-notes` / `batch-move-notes` apply each note individually rather than as one bulk operation — AppleScript has no bulk equivalent to IMAP's `UID STORE`/`MOVE`. This is deliberate: it preserves per-note success/failure reporting. ([#26](https://github.com/sweetrb/apple-notes-mcp/issues/26)) |
| Pinned notes are read-only | AppleScript exposes no `pinned` property. Pin state is readable via the BETA `get-note-metadata` tool (NoteStore database, needs Full Disk Access) but cannot be set ([#28](https://github.com/sweetrb/apple-notes-mcp/issues/28)) |
| Limited rich formatting | Use `format: "html"` on create/update for headings, lists, bold, code blocks; some complex formatting may not render |
| Title matching | Most operations require exact title matches |
| Checklist state | Requires [Full Disk Access](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md) to read done/undone state from the database |
| Checklist **creation** | Not supported. AppleScript's `body of note` setter strips `<input type="checkbox">` and ignores any checklist-styling CSS class. Apple Notes stores checklist items as a protobuf paragraph style (`style_type=103`) that AppleScript doesn't expose, and the SQLite database is read-only. See [Creating Checklists](#creating-checklists) below for the workaround. |

### Creating Checklists

**There is no programmatic way to create a true Apple Notes checklist via AppleScript** — and therefore no way via this MCP server. This is an Apple limitation, not a bug.

When a note is created or updated via AppleScript:

| You send | What Notes.app actually renders |
|----------|--------------------------------|
| `<input type="checkbox"> Item` | `Item` (the `<input>` tag is stripped) |
| `<ul class="checklist"><li>Item</li></ul>` | A plain bulleted list — the `checklist` class is dropped |
| Markdown `- [ ] Item` (in `plaintext` mode) | The literal text `- [ ] Item` |

Apple Notes stores checklists as a paragraph style (`style_type=103`) inside a gzipped protobuf blob in the `NoteStore.sqlite` database. AppleScript's note `body` interface does not expose paragraph styles, and writing directly to the live database is unsafe.

**Workarounds:**

1. **Create the note with bulleted list items, then convert manually in Notes.app.** Select the items and press <kbd>⇧⌘L</kbd> (or **Format → Checklist**). This converts the list in place and the resulting checklist will be readable by `get-checklist-state` and annotated by `get-note-markdown`.
2. **Use the Apple Shortcuts app** to script the checklist creation, since Shortcuts can manipulate Notes content at a higher level than AppleScript. This server does that for you in two ways: [`create-checklist-item`](#create-checklist-item) appends one unchecked item to an existing note, and [`create-note`](#create-note) with `format: "markdown"` turns `- [ ]` / `- [x]` lines into checklist items with that done state through Notes' own Markdown importer, (see [Markdown notes](#markdown-notes)).
3. **Read-only checklist support is fully implemented** — once a checklist exists (created manually or by another app), `get-checklist-state` and `get-note-markdown` will read its done/undone state correctly (with Full Disk Access).

If you need to *track* todos programmatically and don't strictly need them rendered as Apple Notes checklist UI, plain markdown-style `- [ ] item` / `- [x] item` lines in a `plaintext` note are a reasonable alternative — they are searchable, human-readable, and can be parsed by downstream tooling.

### Backslash Escaping (Important for AI Agents)

When sending content containing backslashes (`\`) to this MCP server, **you must escape them as `\\`** in the JSON parameters.

**Why:** The MCP protocol uses JSON for parameter passing. In JSON, a single backslash is an escape character. To include a literal backslash in content, it must be escaped as `\\`.

**Example - Shell command with escaped path:**
```json
{
  "title": "Install Script",
  "content": "cp ~/Library/Mobile\\ Documents/file.txt ~/.config/"
}
```
→ arrives as: `cp ~/Library/Mobile\ Documents/file.txt ~/.config/`

In a JSON string literal the two characters `\\` denote **one** literal backslash. Doubling them to `\\\\` denotes *two* backslashes in the note, which is almost never what you want.

**Example - Literal double backslash:**
```json
{
  "title": "Escaping Notes",
  "content": "Send \\\\ only when you want two backslashes"
}
```
→ arrives as: `Send \\ only when you want two backslashes`

**Common patterns requiring escaping:**
- Shell escaped spaces: `Mobile\ Documents` → `Mobile\\ Documents` in JSON
- Regex patterns: `\d+` → `\\d+` in JSON
- Literal double backslash: `\\` → `\\\\` in JSON

**If you see errors** when creating/updating notes with backslashes, double-check that backslashes are properly escaped in the JSON payload.

---

## Troubleshooting

### "Notes.app not responding"
- Ensure Notes.app is not frozen
- Try opening Notes.app manually
- Restart the MCP server

### "Permission denied"
- macOS needs automation permission
- Go to System Settings > Privacy & Security > Automation
- Ensure your terminal/Claude has permission to control Notes

### Native writes time out or report an uncertain outcome
- Symptom: `add-native-tags`, `set-note-pinned`, `append-native` or another native write fails with "Shortcuts timed out waiting for …", "Operation outcome uncertain" or "readback was not verified", while `doctor` and `get-capabilities` report the bridges installed
- Common cause, especially right after install or upgrade: the bridge Shortcut is waiting on a first-run consent prompt. The server runs it in the background, where Shortcuts cannot display that prompt, so the run stalls until it times out
- Fix: open Shortcuts.app, run the Shortcut the error names (`Apple Notes MCP - Native Tags`, `Apple Notes MCP - Background Operations v5` or `Apple Notes MCP - Create Markdown Note`) once in the foreground and choose **Always Allow**. Each bridge needs this once; quitting or relaunching Shortcuts.app or Notes.app does not clear it
- Read the exact note before retrying — the write may have landed

### "Note not found"
- Note titles must match exactly (case-sensitive)
- Check if the note is in a different account
- Use `list-notes` to see available notes

### Note creation/update fails silently with backslashes
- Content containing `\` characters requires JSON escaping
- Use `\\` to represent each literal backslash
- See "Backslash Escaping" section under Known Limitations

### Notes accumulate blank lines after repeated updates
- Repeatedly updating a note (especially with HTML content) can accumulate whitespace artifacts — `<div><br></div>` tags that persist between sections even after you remove them from your content
- Apple Notes' internal HTML processing preserves empty divs from previous edits, so the gaps are baked into the note's internal representation and cannot be fixed through further updates
- Fix: delete the note with `delete-note` and create a fresh one with `create-note`

### Every tool is refused: "invalid outputSchema … unsupported dialect"

If your client reports something like

```
Tool 'list-notes' has an invalid outputSchema: JSON Schema declares an unsupported
dialect ("$schema": "http://json-schema.org/draft-07/schema#"). The default
validator supports JSON Schema 2020-12 only.
```

you are on a version older than **2.7.2**. MCP standardized on JSON Schema
2020-12, and every tool this server advertised carried the older draft-07
dialect, so clients rejected all of them at once — nothing about your Notes
library, permissions, or configuration is involved.

- Fix: upgrade to 2.7.2 or later. `npx -y apple-notes-mcp@latest` picks it up on
  the next launch; a marketplace install updates through the marketplace.
- Running from a clone: `git pull && pnpm install && pnpm run build`, then
  restart the client.

### `apple-notes` server fails to connect when run from a clone
- Launch `claude` from **inside the repo directory** so `CLAUDE_PROJECT_DIR` resolves to the repo root (the bare `.` fallback is unreliable — it points at the launching process's working directory)
- If you've been editing the source, rerun `pnpm run build` — the entrypoint is `${CLAUDE_PROJECT_DIR:-.}/build/index.js`, and the committed bundle only reflects your changes after a rebuild
- Run `claude mcp list` to check for a conflicting `apple-notes` entry at another scope (project-scope outranks user-scope, but local-scope outranks project-scope)
- Approve the pending project-scope server when Claude Code prompts you

---

## Development

Development uses [pnpm](https://pnpm.io/) (see `packageManager` in `package.json`):

```bash
pnpm install            # Install dependencies
pnpm run build          # Typecheck, then bundle src/index.ts into build/index.js (esbuild)
pnpm test               # Run unit test suite (mocked AppleScript)
pnpm run test:integration  # Run integration tests against real Notes.app
pnpm run test:all       # Unit + integration
pnpm run lint           # Check code style
pnpm run format         # Format code
```

The integration suite (`test/integration.test.ts`) drives the real
`AppleNotesManager → AppleScript → Notes.app` stack — creating, reading,
searching, and deleting throwaway notes. Its live tests self-skip when no
writable Notes account is available (e.g. CI), so it is safe to run anywhere;
the pure path-safety and hashtag tests always run.

---

## Author

**Rob Sweet** - President, [Superior Technologies Research](https://www.superiortech.io)

A software consulting, contracting, and development company.

- Email: rob@superiortech.io
- GitHub: [@sweetrb](https://github.com/sweetrb)

## License

MIT License - see [LICENSE](https://github.com/sweetrb/apple-notes-mcp/blob/main/LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](https://github.com/sweetrb/apple-notes-mcp/blob/main/CONTRIBUTING.md) for guidelines.

## Related Projects

Part of a family of macOS MCP servers:

- [apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp) — MCP server for Apple Mail (read, search, send, and organize email)
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers (read and write .numbers spreadsheets)
- [apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp) — MCP server for Apple Photos (query metadata and export originals)

## Recurring macOS permission prompts

If macOS keeps re-prompting for Full Disk Access or Automation for `node` (often after a `brew upgrade`), the cause is almost always an **ad-hoc-signed Node** (typically Homebrew's): its code signature (cdhash) changes on every update, so macOS TCC treats each new build as a brand-new binary and silently drops the grants you already made. The fix is to run this server under an official, **Developer-ID-signed Node at a stable path** — its signing identity stays the same across updates, so you grant the permission once and it persists. The `doctor` tool detects the ad-hoc-signature case and the full walkthrough is in [docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md).
