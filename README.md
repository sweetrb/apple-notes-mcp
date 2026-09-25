# Apple Notes MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets Claude (Claude Code and Claude Desktop), Codex, and other MCP clients read, search, create, edit, organize, and export notes in Apple Notes on macOS. It runs locally on your Mac and talks to Notes through AppleScript, Apple Shortcuts, and read-only access to the Notes database.

Beyond creating and editing notes, it manages folders and accounts, native tags, checklists, tables, pinned notes, links, and attachments. It can also export notes as Markdown, HTML, or JSON, read audio transcripts and drawings, and run a query language across your whole library.

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

## Contents

- [What is This?](#what-is-this) · [Quick Start](#quick-start) · [Requirements](#requirements) · [Features](#features)
- [Tool Reference](#tool-reference): [notes](#note-operations), [folders](#folder-operations), [accounts](#account-operations), [batch](#batch-operations), [export, attachments, and media](#export-operations), [diagnostics](#diagnostics), [native background operations](#native-background-operations), [private helper](#private-helper-opt-in-unsupported-apple-api)
- [Usage Patterns](#usage-patterns) · [Installation Options](#installation-options) · [Configuration](#configuration) · [Full Disk Access](#full-disk-access) · [Public native helper](#public-native-helper)
- [Security and Privacy](#security-and-privacy) · [Known Limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Recurring macOS permission prompts](#recurring-macos-permission-prompts) · [Development](#development)

## What is This?

This server acts as a bridge between AI assistants and Apple Notes. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Save this conversation as a note called 'Meeting Summary'"
- "Find all my notes about the project deadline"
- "Read my shopping list note"
- "Move my draft notes to the Archive folder"
- "What notes do I have in my Work folder?"

The AI assistant communicates with this server, which then uses AppleScript to interact with the Notes app on your Mac. Some features also use packaged Apple Shortcuts (native tags, checklists, tables, pinning) or read the Notes database read-only (queries, checklist state, transcripts). The server itself makes no network requests; what your MCP client does with the results is up to that client.

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

On the first tool call, macOS shows an Automation permission prompt ("Claude" wants access to control "Notes") — click **OK**. Optionally, grant **Full Disk Access** (under Claude Desktop, to the Node binary that runs the server; from a terminal, to the terminal app) to enable the database-backed tools, such as `query-notes`, `get-checklist-state`, `get-note-tables`, `get-audio-transcripts`, `list-native-tags`, and `list-recent-notes` (the full list is under [Full Disk Access](#full-disk-access)); see the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md). The rest of the server is pure AppleScript and works without it.

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

### Other MCP clients

The server is a standard MCP server over stdio, so any client that can launch a local stdio server can run it with the same command the hosts above use: `npx -y apple-notes-mcp`. Most clients take it in an `mcpServers` entry shaped like the Claude Desktop example. If your client cannot pass environment variables, use the [configuration file](#configuration-file-when-the-host-strips-env).

## Requirements

- **macOS** - Apple Notes and AppleScript are macOS-only
- **Node.js 20+** - Required for the MCP server
- **Apple Notes** - Must have at least one account configured (iCloud, Gmail, etc.)

## Features

| Feature | Description |
|---------|-------------|
| **Create Notes** | Create notes from plaintext, HTML, or Markdown, with optional folder/account targeting (Markdown creation uses an optional Shortcut on macOS 26 or later) |
| **Search Notes** | Find notes by title or search within note content |
| **Query Language** | `query-notes` combines text, folder, account, tag, attachment, checklist, flag, word-count, and date conditions with AND/OR/NOT, read from the Notes database (requires Full Disk Access) |
| **Read Notes** | Retrieve note content as HTML, plain text, or Markdown, plus metadata that AppleScript does not expose (pinned, Quick Note, locked, Recently Deleted) |
| **Note Structure** | Decode a note into typed paragraph blocks, list its paragraphs and links, and get a direct link to one paragraph (requires Full Disk Access) |
| **Update Notes** | Replace, append to, or prepend to an existing note, guarded by a content hash so a note that changed since it was read is never overwritten |
| **Delete Notes** | Remove notes (moves to Recently Deleted) |
| **Move Notes** | Organize notes into folders (supports nested paths) |
| **Folder Management** | Create, list, rename, and delete folders with full hierarchical path support; read the folder tree with note counts and Smart Folder rules |
| **Multi-Account** | Work with iCloud, Gmail, Exchange, or any configured account, including account IDs and default folders |
| **Batch Operations** | Delete or move multiple notes at once |
| **Native Tags** | List, add, remove, and replace real Notes tags (not just `#hashtag` text) |
| **Checklists** | Read checklist done/undone state from the Notes database, and append real checklist items through a Shortcut |
| **Tables** | Read native tables as Markdown and JSON, and append new native tables |
| **Pinning** | Read pinned state and pin or unpin a note |
| **Links** | Get a note's `notes://` deep link, insert web, mail, or note-to-note links, and list the links in a note or folder |
| **Export** | Export notes as paginated JSON, or render a note or folder as Markdown (with reusable templates) or standalone HTML |
| **Attachments** | Add files to notes (from a path or the pasteboard), list attachments with their on-disk paths, find a note's lead image, save or batch-export them, or fetch their bytes as base64 |
| **Audio and Drawings** | Read the transcripts Notes stored for recordings, transcribe audio on-device, and decode drawings to strokes and SVG |
| **Incremental Sync** | `list-recent-notes` pages through notes by modification time with an exact cursor |
| **Notes.app UI State** | Reveal a note, folder, account, or attachment in Notes.app, or read the current Notes.app selection |
| **Sync Awareness** | Detect iCloud sync in progress, warn about incomplete results |
| **Collaboration** | Detect shared notes, warn before modifying |
| **Diagnostics** | `health-check` plus a richer `doctor` (reachability, automation permission, accounts, Full Disk Access), sync status, statistics, and `get-capabilities` for the Shortcut bridges |

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

- **Pinned notes** — Notes has no scriptable `pinned` property via AppleScript. Pin state is **read** from the NoteStore database by the BETA `get-note-metadata` tool and `list-special-notes`, and **set** through the Background Operations Shortcut by [`set-note-pinned`](#set-note-pinned).
- **Note-to-note links** — AppleScript exposes no link property or link element. Links are instead read from the NoteStore database by [`list-note-links`](#list-note-links), and inserted by [`insert-note-link`](#insert-note-link) (through a Shortcut) or [`insert-link`](#insert-link). A shareable `notes://showNote?identifier=<uuid>` deep link is available via [`get-note-link`](#get-note-link).

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
unknown. An argument that fails the input schema is rejected before the tool
runs, with `code: "validation_error"` and `committed: false`. The exception is
a Notes UUID or numeric key that could not be resolved to an id: it carries
`not_found`, or `full_disk_access_missing` when the database is unreadable.

### Note Operations

#### `create-note`

Creates a new note in Apple Notes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | The title of the note. Automatically prepended as `<h1>` — do NOT include the title in `content` |
| `content` | string | One of `content`/`contentPath` | The body content of the note (do not repeat the title here) |
| `contentPath` | string | One of `content`/`contentPath` | Absolute path of a local UTF-8 file to use as the body instead of `content`. Allowed in the same places [`save-attachment`](#save-attachment) may write (home, temp, `/Volumes`), except hidden paths (any component starting with `.`, such as `~/.ssh` or a project `.env`) and `~/Library` other than iCloud Drive (`~/Library/Mobile Documents`) and cloud storage folders (`~/Library/CloudStorage`), which can hold credentials; set `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1` to allow those. Symbolic links, non-regular files, invalid UTF-8 and files over 1 MiB are refused before anything is written. A leading byte-order mark is dropped |
| `tags` | string[] | No | Returned-only metadata — **NOT written to Notes.app**. Apple Notes tags can't be set via AppleScript, so values passed here are echoed back in the response but do not appear on the created note. Inline `#hashtags` in `content` stay searchable text and are returned as `hashtags`, but they do not become native Notes tags; add real tags afterwards with [`add-native-tags`](#add-native-tags). Refused with `format: "markdown"` |
| `folder` | string | No | Folder to create the note in. Supports nested paths like `"Work/Clients"`. **The folder must already exist** — create it first with [`create-folder`](#create-folder). A smart folder is refused (see [`move-note`](#move-note)). Defaults to account root |
| `account` | string | No | Account name (defaults to Notes.app's default account; matched exactly or by a *unique* prefix — an ambiguous prefix is refused). Must be an account Notes.app already has configured — see [`list-accounts`](#list-accounts) |
| `format` | string | No | Content format: `"plaintext"` (default), `"html"`, or `"markdown"`. In all formats, the title is automatically prepended as the note's title line. In plaintext mode, newlines become `<br>`, tabs become `<br>`, and backslashes are preserved as HTML entities. `"markdown"` produces real Title/Heading/Subheading styles through a Shortcut; see [Markdown notes](#markdown-notes) |
| `markdownRoute` | string | No | With `format: "markdown"` only: `"shortcut"` (default) or `"html"`. See [Markdown through HTML](#markdown-through-html) |
| `timeoutSeconds` | number | No | Whole seconds, 1–120, for each Notes.app automation step this call runs; overrides `APPLE_NOTES_MCP_TIMEOUT_MS` for this call only. A timed-out write is uncertain, not failed: read the note by id before any retry. Also accepted by `get-note-content`, `update-note`, `append-to-note`, `delete-note` and `move-note` |

**Example (with inline textual hashtags):**
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
| `includeWordCount` | boolean | No | Add `wordCount` to each result (`null` when the note is locked or its body unreadable). A database content search already has the text. Otherwise the bodies are read in one batched read-only database query, never one AppleScript call per note; that needs Full Disk Access and also adds `matchedIn`. Without it, the response carries `wordCountUnavailable` and the results are unchanged. |

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

When the note text came from the database (a database content search, or any search with `includeWordCount`), each result also carries `matchedIn`: `["title"]`, `["body"]`, or `["title", "body"]`, saying where the query text occurs. The body is the text after the first line. `matchedIn` is absent for locked notes and for AppleScript searches without `includeWordCount`. The text output appends the same details to each line, for example `· matched in title, body · 245 words`.

**Example - Content search with word counts:**
```json
{
  "query": "budget",
  "searchContent": true,
  "includeWordCount": true
}
```

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
| `scanLimit` | number | No | How many of the most recently modified notes to examine. Defaults to 500, maximum 10000. The response says when older notes were left unscanned. A large scan decodes more bodies, so it takes longer. |
| `includeDeleted` | boolean | No | Also scan notes in Recently Deleted, notes pending deletion, and folderless notes. Defaults to `false`. |
| `includeWordCount` | boolean | No | Add `wordCount` to each returned note, the same count `words:` filters on (`null` when locked or unreadable). Free when the query already reads bodies; a metadata-only query (for example `pinned`) reads just the returned notes' bodies in one extra read-only query. Defaults to `false`. |

**Syntax:**

| Form | Matches |
|------|---------|
| `budget`, `"quarterly budget"` | Title or body contains the word or phrase (case-insensitive substring) |
| `title:x`, `body:x`, `text:x` | Title only, body only (text after the first line), or either |
| `folder:Work`, `folder:"Work/Clients"` | The note's own folder, by name or full path, case-insensitive (notes in subfolders are not included); a literal `/` in a name can be written `\/` as in `list-folders` |
| `account:iCloud` | Account name, case-insensitive |
| `tag:finance` | Native Notes tag (with or without `#`); textual hashtags are ordinary words |
| `has:link`, `has:attachment`, `has:checklist`, `has:drawing`, `has:image`, `has:video`, `has:audio`, `has:pdf`, `has:table`, `has:scan`, `has:url`, `has:map`, `has:tag` | The note body contains that kind of object. `has:url` is a link preview card (it also counts as `has:link`, as inline links do); `has:map` is a map attachment |
| `checklist:open`, `checklist:done` | At least one unchecked item; or items present and all checked |
| `pinned`, `locked`, `shared`, `quicknote` (or `is:pinned` …) | Note flags; `shared` includes notes in a shared folder, and `quicknote` is a note created as a Quick Note |
| `words:>250` | Word count, with `=`, `>`, `>=`, `<`, `<=` |
| `created:>=2026-07-01`, `modified:<2026-09-01` | Dates as `YYYY-MM-DD` in local time, with the same operators; `=` means that whole day |
| `a b`, `a AND b`, `a OR b`, `NOT a`, `-a`, `( … )` | AND is implicit and binds tighter than OR |

Operators are case-insensitive. Quote an operator or flag word to search it
literally, for example `"and"` or `"pinned"`. Queries are capped at 256 tokens
and 64 levels of nesting. An unknown field such as `titel:x` is an error rather
than a silent text search; quote it to search the literal text.

Password-protected notes match on title and metadata only. Their bodies are
encrypted, so a body predicate is unknown for them rather than false: neither
`body:x` nor `-body:x` matches them, though `-body:x OR pinned` matches a
pinned one. Notes whose body cannot be decoded are treated the same way. Their
snippets are always empty.

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
the first matched phrase. Each note also has `matchedIn` when the query has a
positive text term: `["title"]`, `["body"]`, or both, saying where those terms
occur (a `title:` term is only looked for in the title, a `body:` term only in
the body). It is absent for locked or undecodable notes, and an empty list
means the note matched through a non-text branch such as `pinned OR x`. The ids are the same `x-coredata://…/ICNote/p…` form
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
| `timeoutSeconds` | number | No | Whole seconds, 1–120, for the body read; overrides `APPLE_NOTES_MCP_TIMEOUT_MS` for this call only |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended as it's unique and avoids issues with duplicate titles.

**Large images:** Notes.app returns images inside the body as base64, so a note holding a very large image (tens of MB) can take longer to read than the timeout allows. When the read times out or overflows the output buffer, the error says so and, with Full Disk Access, names the attachments of 5 MB or more. Retry with a larger `timeoutSeconds`; `delete-note` accepts the same argument, and it needs a successful read to verify the note before deleting it.

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
with placeholder text. This server's `update-note` refuses attachment-bearing
notes, and `append-to-note` routes them to native end-append with `scopeText`,
which never rewrites the existing body; make any other edit in Notes.app.

---

#### `get-native-objects`

Reads native object identities and ranges, checklist item IDs and state, actual
native tags, and native table data from one exact note ID. Table output includes
stable row and column identifiers. `tableCellsComplete` is false when Notes
metadata cannot be decoded completely. This tool is read-only and requires Full
Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID, in any [identifier form](#identifier-forms) |

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

#### `list-note-paragraphs`

Lists one note's non-empty paragraphs in body order, read-only from the
NoteStore database. Each paragraph has `blockIndex` (its index in
`get-note-blocks`, where empty paragraphs also count), `text`, `style`,
`styleType`, `paragraphId` (the UUID Notes stores on the paragraph's first
text run), and `paragraphIdStatus`:

- `unique`: no other paragraph in the note carries this ID. The paragraph also
  gets `url`, a direct
  `applenotes://showNote?identifier=<note>&paragraphID=<paragraph>` link that
  opens Notes at that paragraph.
- `shared`: other paragraphs carry the same ID (`sharedWith` counts them).
  Notes copies the ID when a paragraph is split, so this is common for body
  text. No `url` is given, because it could open the wrong paragraph.
- `missing`: no ID is stored.

`mixedParagraphIds: true` marks a paragraph whose text runs carry more than
one ID; only the first-run ID is used. Titles and headings usually have unique
IDs.

**Requires:** Full Disk Access. Password-protected notes are refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | One of `id`, `title` | Exact note ID, or the note's Notes UUID |
| `title` | string | One of `id`, `title` | Exact note title; must match one note. Notes in Recently Deleted are ignored, as in `list-notes` |
| `folder` | string | No | With `title`: the folder's name or full path as `list-folders` shows it, such as `Work/Clients` |
| `linkableOnly` | boolean | No | Return only paragraphs with a `url` |
| `offset` | number | No | First paragraph to return (default 0). Use `page.nextOffset` |
| `limit` | number | No | Maximum paragraphs per page (default 500, max 5000) |
| `recordAnchors` | boolean | No | Also record a [paragraph anchor](#paragraph-anchors) for each returned paragraph (at most 500 per call); each row gains `anchorId` and the result gains `anchorsRecorded` (the new ones). Writes only the local anchor registry |

---

#### `get-paragraph-link`

Returns a direct link to one paragraph of a note:
`applenotes://showNote?identifier=<note>&paragraphID=<paragraph>`. It selects
the note like `list-note-paragraphs` and the paragraph by exactly one of:

- `contains`: a snippet of the paragraph. Case, runs of spaces, and Unicode
  width are ignored.
- `match`: the whole paragraph, compared the same way.
- `blockIndex`: from `list-note-paragraphs`.

When `contains` or `match` hits several paragraphs, pass `occurrence` (1-based)
or a longer snippet.

The link is returned only when the paragraph's ID is `unique` in the note.
Otherwise the result is an error whose `structuredContent` carries the usual
`code` plus a `reason`: `paragraph-id-shared`, `paragraph-id-missing`,
`no-match`, `ambiguous-paragraph`, `occurrence-out-of-range`, `ambiguous-note`
(several notes have that title; the message lists their folders), `not-found`,
`encrypted`, or `no-body`. The tool never creates or changes a paragraph ID,
and an edit in Notes can later replace the ID and break the link.

**Requires:** Full Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id`, `title`, `folder` | string | One of `id`, `title` | Note selector, as in `list-note-paragraphs` |
| `contains` | string | One of `contains`, `match`, `blockIndex` | Snippet of the paragraph |
| `match` | string | One of `contains`, `match`, `blockIndex` | The whole paragraph |
| `blockIndex` | number | One of `contains`, `match`, `blockIndex` | The paragraph's `blockIndex` |
| `occurrence` | number | No | Which match to use when several paragraphs match |
| `recordAnchor` | boolean | No | Also record a [paragraph anchor](#paragraph-anchors) for the linked paragraph and return its `anchorId`. Writes only the local anchor registry |

---

#### Paragraph anchors

A paragraph link breaks when Notes replaces or copies the paragraph's ID. A
paragraph anchor records enough about the paragraph to find it again: the
note's Notes UUID, the paragraph ID and its status, the paragraph's normalized
text and a fingerprint of it, the fingerprints of the paragraphs before and
after it, its `blockIndex`, and when it was recorded. Anchors are kept in one
local file, `~/Library/Application Support/apple-notes-mcp/paragraph-anchors.json`
(or the absolute path in `APPLE_NOTES_MCP_ANCHOR_FILE`). It is created with
mode 0600 in a 0700 directory, replaced atomically under a lock file, and
holds the text of every anchored paragraph. A symlinked, unreadable or
corrupt registry is refused and left as it is. The anchor tools never change
Notes.

Resolving an anchor tries three steps in order, and every step fails closed:

1. **Paragraph ID.** A paragraph whose ID is still unique in the note is the
   anchored paragraph, even if its text was edited or it moved. A link to that
   ID opens exactly that paragraph.
2. **Exact text.** The same normalized text. When several paragraphs have it,
   only the one whose neighbours still match is chosen; a tie is `ambiguous`.
3. **Text and neighbours.** Similar text between both recorded neighbours, or
   nearly identical text beside one of them. Two close candidates are
   `ambiguous`; one below `minConfidence` is `low-confidence`.

A match whose ID is now shared or missing is `needs-reminting`: the paragraph
is found (the result names its block), but no safe link exists until it gets a
new ID. Public automation cannot set a paragraph ID. `remint: true` gives the
block a new ID through the opt-in private writer's `native-set-paragraph-id`
(with a fresh revision, refusing if the paragraph changed) and resolves again.
It runs only when `APPLE_NOTES_MCP_ENABLE_PRIVATE=1` and
`APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1` are set and the writer is built
(plus `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until that write is
live-validated); otherwise it reports `writer-unavailable`.

To share anchored links outside Notes, see the
[paragraph anchor resolver](#paragraph-anchor-resolver-opt-in).

#### `create-paragraph-anchor`

Records an anchor for one paragraph, selected exactly as in
`get-paragraph-link` (note by `id` or `title`/`folder`; paragraph by one of
`contains`, `match`, `blockIndex`, plus `occurrence`). Unlike
`get-paragraph-link`, a paragraph whose ID is shared or missing can be
anchored. Recording the same paragraph again (same note, ID, text and block)
returns the existing anchor with `created: false`.

Returns `anchor`, `created`, and `url` when the paragraph currently has a
unique ID.

**Requires:** Full Disk Access. Writes only the anchor registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id`, `title`, `folder` | string | One of `id`, `title` | Note selector, as in `list-note-paragraphs` |
| `contains`, `match`, `blockIndex`, `occurrence` | | One of `contains`, `match`, `blockIndex` | Paragraph selector, as in `get-paragraph-link` |

#### `resolve-paragraph-anchor`

Finds an anchored paragraph in the note as it is now. The result has `status`
(`resolved`, `needs-reminting`, `ambiguous`, `low-confidence`, `not-found`,
`note-not-found`, `note-deleted` for a note in Recently Deleted, or
`note-unreadable` for a locked note), `method` (`paragraph-id`, `exact-text`,
`text-and-neighbours`), `confidence` (0 to 1), `match` (`blockIndex`, `text`,
`paragraphId`, `paragraphIdStatus`), `changes` (`textChanged`,
`blockIndexChanged`, `paragraphIdChanged`), and `message`. `url`, the current
`applenotes://` link, is present only when `status` is `resolved`.

**Requires:** Full Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `anchorId` | string | Yes | The anchor (`pa_` and 24 hex digits) |
| `minConfidence` | number | No | Lowest confidence accepted as a match (default 0.6) |
| `refresh` | boolean | No | After a match with confidence 0.8 or more, store the paragraph as it is now (text, neighbours, block, ID), so later edits are tracked from here. Reports `refreshed` or `refreshSkipped` |
| `remint` | boolean | No | On `needs-reminting`, give the paragraph a new ID through the private writer and resolve again. Reports `remint.reason: "writer-unavailable"` unless both writer switches are on, and `"writer-failed"` (with the writer's message and `committed`) when the writer refuses |

#### `list-paragraph-anchors`

Lists recorded anchors in the order recorded, with `total`, the `registry`
path and `page` info. Reads only the registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteIdentifier` | string | No | Only anchors in the note with this Notes UUID |
| `offset` | number | No | First anchor to return (default 0) |
| `limit` | number | No | Maximum anchors (default 100, max 1000) |

#### `get-paragraph-anchor`

Returns one stored anchor as recorded. Reads only the registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `anchorId` | string | Yes | The anchor |

#### `prune-paragraph-anchors`

Removes anchors that no longer resolve, or the anchors you list. It is a dry
run unless `dryRun` is `false`. Without `anchorIds` it resolves every anchor
in scope and treats `not-found` and `note-not-found` as stale. A note in
Recently Deleted (`note-deleted`) is kept by default because it can be
restored. Returns `stale` (`anchorId`, `status`, `message`), `examined`, and
`removed`.

**Requires:** Full Disk Access unless `anchorIds` is given.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `anchorIds` | string[] | No | Remove exactly these anchors instead of resolving |
| `noteIdentifier` | string | No | Only anchors in the note with this Notes UUID |
| `statuses` | string[] | No | Statuses treated as stale (default `not-found`, `note-not-found`) |
| `dryRun` | boolean | No | Report without removing (default `true`) |

---

#### `get-note-structure`

Returns a read-only overview of one note from the NoteStore database, in one
call:

- `text` (decoded body), `textLength`, `wordCount`, `charCount` (Unicode
  characters, attachment placeholders excluded), and `blockSummary` (the
  `get-note-blocks` summary counts).
- `links`, each with a `kind`: `inline` (a hyperlink on text), `card` (a rich
  link preview attachment, with `attachmentId` and `previewPath`), `note` (a
  native link chip to another note), or `section` (a native link chip to a
  heading or paragraph, with `section`). Notes deep links also carry
  `targetNote` and `paragraphId`. `linkCounts` totals them.
- `tags` (native tags in body order) and `attachments`, listed the way
  [`list-attachments`](#list-attachments) with `includePaths` lists them: the
  same `kind` (`image`, `scan`, `drawing`, `pdf`, `audio`, `video`, `url`,
  `table`, `other`), the same body order, and the same `previewPath`, plus the
  card `title`/`url`, `fileSize`, and body position. Gallery items and
  recording parts are nested under `children`; `attachmentCount` counts
  top-level attachments only.
- `deepLink`, `isShared` (the note or any enclosing folder is shared),
  `isLocked`, `isPinned`, `inRecentlyDeleted`, `lastViewed`,
  `checklistTotal`, `checklistDone`, `hasDrawing` (classic sketches and Paper
  drawings), and `firstImage` (the same lead visual `list-attachments`
  returns with `firstImage`, plus its attachment `id`).

`lastViewed` is an ISO date, or null with `lastViewedStatus` set to
`never-viewed`, `not-recorded`, `malformed`, or `unsupported` (the column
does not exist on this macOS version). A password-protected note returns its
metadata and attachment rows with `bodyDecoded: false` and the body-derived
fields null.

**Requires:** Full Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID: the `x-coredata://` id, or the note's Notes UUID or numeric key (see [Identifier forms](#identifier-forms)) |
| `includeText` | boolean | No | Include the decoded text (default true). Text larger than `APPLE_NOTES_MCP_BLOCKS_MAX_BYTES` is omitted with `textOmitted: true` |

Link URLs are returned as stored; check `linkSafe` before emitting one into
HTML.

---

#### `list-note-links`

Lists links, read-only from the NoteStore database, in one note (`id`) or
across a `folder`, an `account`, or the whole library (no selector). Each link
has a `kind`:

| Kind | What it is | Where Notes stores it |
|------|------------|-----------------------|
| `inline` | A hyperlink on text | Inside the note body |
| `card` | A rich link preview | An attachment row with the URL and title |
| `note` | A native link chip to another note | An inline-attachment row with a Notes deep link |
| `section` | A native link chip to a heading or paragraph | Same, with `paragraphID` in the deep link |

Each row has `url`, `text` (label), `linkSafe`, `targetNote` and `paragraphId`
for Notes deep links, `section` for section chips, and for cards
`attachmentId` and `previewPath` (Notes' largest cached preview image, found
the same way [`list-attachments`](#list-attachments) finds it, or null when
Notes has none). Each row also names its source: `noteId`, `noteIdentifier`,
`noteTitle`, `noteModified`, `folder`, `folderPath` (as `list-folders` prints
it), `account`, and `accountIdentifier`. When bodies were decoded, `start` and
`blockIndex` give the link's position, and `inBody: false` marks a card or chip
row with no marker left in the body.

Inline links need every body in scope decompressed and decoded, so a folder,
account, or library scan includes them only with `includeInline: true`
(slower). A single note always includes them. A `folder` scope includes its
subfolders unless `includeSubfolders` is false. Scans skip Recently Deleted
and folderless notes; a note requested by `id` is read wherever it is. Links
come newest-modified note first, in body order within a note.

**Requires:** Full Disk Access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | One exact note ID (x-coredata id, Notes UUID, or numeric key). Do not combine with `account` or `folder` |
| `account` | string | No | Account name (exact or unique-prefix match, as in the other tools) |
| `folder` | string | No | Folder name (any depth, must be unique) or path from the top level as `list-folders` prints it, such as `Work/Clients`; escape a literal slash as `\/` |
| `includeSubfolders` | boolean | No | With `folder`, also list notes in its subfolders (default true) |
| `includeInline` | boolean | No | Decode bodies for inline links (default true for `id`, false otherwise) |
| `kinds` | string[] | No | Only these kinds: `inline`, `card`, `note`, `section` |
| `offset` | number | No | First link to return (default 0). Use `page.nextOffset` |
| `limit` | number | No | Maximum links per page (default 200, max 2000) |

The response also reports `scope`, `counts` per kind, `notesInScope`,
`notesWithoutBody` (locked, empty or undecodable bodies when inline links were
requested), and `page`. A page stops early to stay under
`APPLE_NOTES_MCP_BLOCKS_MAX_BYTES`. An ambiguous folder name is refused with a
message that lists the matching paths.

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID, in any [identifier form](#identifier-forms) |
| `expectedContentHash` | string | Yes | `contentHash` from a fresh read of the note |
| `scopeText` | string | Yes | Distinctive phrase already in the note, 12–500 characters |
| `tags` | string[] | Yes | 1–100 tag names to add |

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
| `ifFolderId`, `ifAncestorFolderId`, `forbiddenAncestorFolderIds` | string, string, string[] | No | Folder preconditions; see [Folder scope guards](#folder-scope-guards) |
| `timeoutSeconds` | number | No | Per-call timeout, 1–120 seconds, as for [`create-note`](#create-note). A timed-out write is uncertain: read the note by id before any retry |

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
| `ifFolderId`, `ifAncestorFolderId`, `forbiddenAncestorFolderIds` | string, string, string[] | No | Folder preconditions; see [Folder scope guards](#folder-scope-guards) |
| `timeoutSeconds` | number | No | Per-call timeout, 1–120 seconds, as for [`create-note`](#create-note). A timed-out write is uncertain: read the note by id before any retry |
| `guardNoteId` | string | No | A second note (usually a verified copy) that must still be intact; needs Full Disk Access |
| `expectedGuardContentHash` | string | With `guardNoteId` | `contentHash` of the guard note from `get-note-content` |
| `requireActiveNoteId` | string | No | A second note that must still exist, be unlocked, stay outside Recently Deleted, and not be a Quick Note; its content is not fingerprinted. Needs Full Disk Access |

Title-only deletion is rejected. If the note changed after the supplied hash
was read, deletion is also rejected.

**Notes with large images.** Notes.app returns a note's body with each inline
image embedded as base64, so a note holding one 40 MB image has a body of about
110 MB. Body reads accept up to 512 MB of output, and `delete-note` compares a
body longer than 5 MB against a private temporary file rather than embedding it
in the AppleScript. The comparison still covers the whole body, and the file
is removed when the delete finishes.

**Copy-then-retire.** To delete an original only while its copy is still good,
read both notes, verify the copy, and pass the copy as `guardNoteId` with its
`contentHash` as `expectedGuardContentHash`. The copy's revision is re-read just
before the delete, and its body, lock state, and folder are checked again
inside the delete AppleScript, with the same fail-closed Recently Deleted test
as the note being deleted. The guard note must not be a Quick Note, a flag only
the database holds, so the guard needs Full Disk Access. A copy the database
has not saved yet passes on the live checks alone. The pair is still not one
transaction: the rich revision (which also covers checklists and attachments)
is a pre-check, and the in-script check covers the body and state Notes.app
exposes. `requireActiveNoteId` is the narrower form for a destination you
wrote yourself rather than copied.

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
Full Disk Access) or by its English name. The check fails closed: a note whose
folder Notes.app reports as something other than a folder (as it does for a note
trashed earlier in the same Notes session) is refused the same way, and a note
whose folder cannot be read at all is refused with a message to retry. To remove
such a note for good, do it in Notes.app.

**⚠️ Safety:** Irreversible from the agent's side — requires explicit user confirmation before calling. Prefer `search-notes` / `list-notes` first to confirm the exact id(s) being deleted.

---

#### `move-note`

Moves a note to a different folder. The note is relocated in place via Notes.app's native `move`, so its id, creation date, and all embedded attachments (files, images, scans, PDFs, audio) are preserved. The destination folder must already exist — create it first with [`create-folder`](#create-folder).

A smart folder is never a destination: it only gathers notes by its rules, and Notes.app would move the note to Recently Deleted or store a created note where no folder shows it. `create-note`, `create-note-with-attachment`, `move-note`, `batch-move-notes`, and `create-folder` refuse one before writing anything, with `code: "unsupported"`, `committed: false`, and `reason: "smart_folder_destination"`. An ordinary folder that shares a smart folder's name is still found. Detection reads the NoteStore database, so it needs Full Disk Access; without it, destinations resolve as before.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID returned by a read or search |
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`) |
| `account` | string | No | Account whose `folder` is the destination (default: the default account) |
| `ifFolderId`, `ifAncestorFolderId`, `forbiddenAncestorFolderIds` | string, string, string[] | No | Folder preconditions; see [Folder scope guards](#folder-scope-guards) |
| `timeoutSeconds` | number | No | Per-call timeout, 1–120 seconds, as for [`create-note`](#create-note). A timed-out write is uncertain: read the note by id before any retry |

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

#### Folder scope guards

`update-note`, `append-to-note`, `delete-note`, and `move-note` accept three
optional folder preconditions. Use exact folder ids from `list-folders`.

- `ifFolderId`: the note must currently be in exactly this folder.
- `ifAncestorFolderId`: the note must be inside this folder or any of its
  subfolders.
- `forbiddenAncestorFolderIds` (up to 50): the note must not be inside any of
  these folders or their subfolders. For `move-note`, the destination must not
  be either.

The checks read Notes.app's live folders inside the same AppleScript as the
write, immediately before it, so a note moved after you reviewed it is left
alone and the call fails with `Scope guard failed: …`. The one exception is a
native append to a protected note (it runs through Shortcuts): there the check
is a separate read just before the append, so it is not atomic.

The [private writer](#private-writer-opt-in-unsupported-apple-api) tools take
the same three guards and check them inside the writer's own transaction; see
that section for how they differ.

**Example - retire a note only while it is still in the inbox:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "expectedContentHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "ifFolderId": "x-coredata://ABC123/ICFolder/p12"
}
```

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
| `scopeText` | string | Native-object notes only | Unique existing phrase, as for [`append-native`](#append-native) |
| `ifFolderId`, `ifAncestorFolderId`, `forbiddenAncestorFolderIds` | string, string, string[] | No | Folder preconditions; see [Folder scope guards](#folder-scope-guards) |
| `timeoutSeconds` | number | No | Per-call timeout, 1–120 seconds, as for [`create-note`](#create-note). A timed-out write is uncertain: read the note by id before any retry |

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
- The link always gets its own paragraph. To place it at the end of one
  existing paragraph, or to link text in place, use the opt-in writer's
  `native-edit-note` (`append_to_paragraph`, or `replace` with a linked run).
- Rich URL preview cards (the link tile Notes makes when you paste a URL) are
  not produced. No public automation route creates one: the Shortcuts Notes
  actions write text, and AppleScript's `body` has no card markup. The opt-in
  private writer's [`native-add-url-card`](#native-add-url-card) can add one.
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

**Note:** Requires Full Disk Access for the process that runs the server so the Notes SQLite database is readable. On macOS 12–15 the tool also falls back to the AppleScript `note link` property. Run the `doctor` tool to verify access.

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

For date order, incremental sync cursors, Recently Deleted, or word counts, use [`list-recent-notes`](#list-recent-notes).

---

#### `list-recent-notes`

Lists notes from the NoteStore database (read-only) by stored modification time, with an exact cursor for incremental sync. With `since`, it pages through changes oldest first; without it, it shows the newest notes first. Unlike `list-notes`, it can include Recently Deleted and can count words.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Only this account (exact or unique-prefix name). Omit for every account |
| `folder` | string | No | Only notes directly in this folder: a full path in `list-folders` syntax, or a unique folder name |
| `since` | string | No | Return notes after this point, **oldest first**. A `modifiedCheckpoint` cursor (from a row or `nextSince`), or an ISO 8601 date (local midnight) or date-time (local time unless it carries `Z` or an offset), meaning modified strictly after it |
| `limit` | number | No | Maximum rows, 1–1000 (default 50) |
| `includeDeleted` | boolean | No | Also return notes in Recently Deleted, notes awaiting deletion, and folderless notes (default `false`) |
| `wordCounts` | boolean | No | Decode each body and add `wordCount` and `charCount` (default `false`) |
| `bodyPreview` | boolean | No | Add `bodyPreview` (up to 180 characters) and `textDecoded` (default `false`) |

**Returns:** `notes`, each with `id`, `identifier`, `title`, `folder`, `account`, `created`, `modified`, `modifiedCheckpoint`, `pinned`, `locked`, `inRecentlyDeleted`, and `markedForDeletion`. Also `count`, `limit`, `order` (`oldest-first` or `newest-first`), `saturated`, and `nextSince`.

- **Cursors.** `modifiedCheckpoint` is an opaque token (`cdts1:`, 16 hex digits, `:`, the note's database key). It carries the exact stored timestamp bits, so it never loses precision the way an ISO string can, and the key orders notes that share one timestamp. Pass it back as `since`.
- **Syncing.** Call with `since`, store `nextSince`, and pass it as the next `since`. `nextSince` is the last returned row's cursor, or the incoming boundary when nothing matched, so every call advances. `saturated` is `true` when `count` equals `limit`: more changes may follow, so call again right away. When it is `false`, you are caught up. Notes that share a timestamp are split across pages by key, so none is skipped or repeated.
- **First sync.** Start with `since: "1970-01-01"` and page the same way. A library larger than the 1000-row maximum is reached in full.
- **Browsing.** Without `since`, rows come newest first. `nextSince` is then the newest row's cursor, set only when the call returned every matching note (`saturated` is `false`); otherwise it is `null`.
- **Late edits.** A modification-date cursor can miss an edit that iCloud delivers later from another device with an older timestamp, for example after that device was offline. The row then sorts before the cursor. Run a full pass from the start now and then to catch these.
- **Deletions.** Deleted notes are invisible unless `includeDeleted` is `true`. With it, notes in Recently Deleted and notes awaiting deletion appear, flagged, when their modification date is after the cursor. A note purged from the database leaves no row, so compare ids against a full pass to detect it.
- **Word counts.** A word is a whitespace-separated token containing a letter or digit, except that Chinese, Japanese, Thai, Lao, Khmer and Myanmar text, which has no spaces between words, is split at word boundaries (the same count `query-notes` uses for `words:` and `wordCount`); `charCount` counts Unicode code points. Attachment markers are not counted. Both are `null` for locked notes and bodies that are not downloaded or cannot be decoded, and `0` for a body known to be empty.
- **Previews.** With `wordCounts`, `bodyPreview` comes from the decoded body and `textDecoded` is `true`. Otherwise it is the stored snippet. Locked notes never get a preview.
- Folderless notes (abandoned Quick Note drafts Notes.app never shows) and Recently Deleted appear only with `includeDeleted`. Notes without a stored modification date never match a `since` query.

**Example - incremental sync:**
```json
{
  "since": "cdts1:41c7e0ef438fcd6f:4312",
  "limit": 200
}
```

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

**Returns:** List of folders with IDs, paths, account names, and shared state, plus `identifier`, `parentIdentifier`, and `accountIdentifier` when Full Disk Access is granted. Nested folders are shown as full paths (e.g., `Work/Clients/Omnia`). Duplicate folder names are disambiguated by their full path. Literal slashes in folder names are escaped as `\/` (e.g., `Spain\/Portugal 2023`). Smart folders are listed too, because Notes' AppleScript lists them like ordinary folders; with Full Disk Access they carry `smartFolder: true` (and `(smart folder)` in the text list). A smart folder cannot hold notes or folders.

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

#### `list-folder-tree`

Returns the folder hierarchy with note counts for each account, read from the NoteStore database in one pass.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access)).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Only this account (exact or unique-prefix name). Omit for every account |
| `includeDeleted` | boolean | No | Include folders marked for deletion (flagged `markedForDeletion`) and folders whose account no longer exists (default `false`) |

**Returns:** `accounts`, each with `account`, `identifier`, `noteCount`, and `folders`. Each folder node has `id`, `identifier`, `name`, `path` (in `list-folders` syntax), `kind` (`folder`, `smart`, or `trash`), `noteCount` (notes directly inside), `totalNoteCount` (including subfolders), and `children`. Regular folders sort by name, then smart folders, then Recently Deleted. An account's `noteCount` sums its regular folders. Smart folders report 0 because their contents are a saved search. Also returns `folderCount`.

---

#### `create-folder`

Creates a new folder, including a whole nested hierarchy in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Folder name, or a nested path separated by `/` (e.g. `"Retro Tech/PC/CPUs"`). Every intermediate folder is created; segments that already exist are skipped. A segment that names a smart folder is refused before anything is created |
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

Existence is decided by folder id, not by name: a folder deleted earlier in the same Notes session no longer counts as existing, and the call succeeds only once the created folder is confirmed by its id. Otherwise it reports failure.

---

#### `get-folder-by-id`

Reads one exact folder's current name, parent ID, and account ID (`accountId`,
plus `isRoot`, true when the folder sits at the account root). Use these values
with `rename-folder` or `delete-folder-by-id`; this avoids relying on ambiguous
folder names or paths. The `id` may also be the folder's Notes UUID or numeric
key, and the result adds `identifier`, `parentIdentifier`, and
`accountIdentifier` when Full Disk Access is granted.

---

#### `rename-folder`

Renames an existing folder in place using its exact `id`, `expectedName`,
`expectedParentId`, and `newName`. The operation preserves the folder ID, notes,
and descendants. It refuses stale metadata and a conflicting sibling name.

---

#### `delete-folder-by-id`

Deletes one exact, empty, ordinary folder through a plan-then-apply handshake.
Read the folder first with `get-folder-by-id`, call once with `dryRun: true`,
then repeat the same guards with `dryRun: false` and the returned `revision`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact folder id (`x-coredata://…/ICFolder/pN`), or the folder's Notes UUID or numeric key |
| `expectedName` | string | Yes | Current folder name (not a path), matched case-sensitively |
| `expectedAccountId` | string | Yes | Owning account id (`x-coredata://…/ICAccount/pN`) |
| `expectedParentId` | string | One of these two | Current parent folder id (same forms as `id`) |
| `expectedRoot` | `true` | One of these two | The folder sits at the account root |
| `dryRun` | boolean | Yes | `true` plans; `false` applies |
| `expectedRevision` | string | On apply | The `revision` from the dry run |

**Example (plan, then apply with the returned revision):**
```json
{
  "id": "x-coredata://ABC/ICFolder/p42",
  "expectedName": "Old Projects",
  "expectedAccountId": "x-coredata://ABC/ICAccount/p3",
  "expectedRoot": true,
  "dryRun": true
}
```

**Returns:** `status: "planned"` with `wouldDelete`, `identifier`, `name`,
`accountId`, `parentId`, `folderType: 0`, zero `childFolderCount` and
`noteCount`, and `revision`; on apply, `status: "deleted"`, `committed: true`,
`verified: true` (Notes.app no longer resolves the id), and `storeTombstoned`.

**Safety:** it always refuses Recently Deleted, smart folders, the account's
default and other system folders, shared folders (or folders inside a shared
folder), and any folder that still holds notes or subfolders. There is no
override. It is **not atomic**: the guard is a pre-check followed by an
AppleScript delete. The name, parent, account, sharing, and emptiness checks
repeat inside the delete script, but the folder type and stable identifier come
from the local Notes database just before it. It needs Full Disk Access and
fails closed without it.

**Errors** carry the standard `code`: `revision_conflict` (a `Conflict:` message;
read and plan again), `unsupported` (a `Refused:` message), `verification_failed`
with `indeterminate: true` (read the folder before any retry), and
`full_disk_access_missing`.

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
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`). Must already exist — create it with [`create-folder`](#create-folder). A smart folder is refused for the whole call before any note moves |
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
cannot be found renders as `\[Image unavailable: name\]`. Body text that
Markdown would read as block syntax (a leading `#` to `######`, `>`, `-`, `+`,
`*`, `1.` or `1)`, a `---` line, a code fence or a table row) is
backslash-escaped, so a plain paragraph such as `## Notes` stays a paragraph,
and `wrap` never starts a continuation line with such a marker. This tool
leaves `get-note-markdown` unchanged.

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
| `template` | string | No | Render through a template: `standard-markdown`, `obsidian`, or a saved template's name. Exclusive with `templateFile` |
| `templateFile` | string | No | Render through the JSON template in this `.json` file (at most 256 KiB), read under the same rules as `create-note`'s [`contentPath`](#create-note): hidden paths (such as `~/.docker` or a project `.env`) and `~/Library` other than iCloud Drive and `~/Library/CloudStorage` are refused, checked again after resolving symbolic links and letter case, unless the server sets `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`. Errors name the file, never its contents |

Both paths follow the `save-attachment` rules (absolute, under the home
directory, a temp directory, or `/Volumes`, no symlink escapes) and may not
point inside the Notes library container. `templateFile` is a read, so it
also follows `contentPath`'s private-location rule. With `outputPath`, asset links are
relative to the document's directory; without it they are absolute paths.

**Returns:** without `outputPath`, the Markdown itself (refused with
`[too-large]` above half of `APPLE_NOTES_MCP_EXPORT_MAX_BYTES`, because the
document travels in both the text and structured result). With `outputPath`, a
receipt: `format`, `count`, `bytes`, `output`, and `assets` (`dir`, `files`).
Both carry `stats` (attachments, placed, placeholders, unavailable, tables,
unreadableTables, unreferenced) and `skipped`. Nothing already written is
deleted if a later step fails.

**Templates:** `template` or `templateFile` renders through a portable JSON
template that sets how every block style, inline format, attachment,
per-note header and footer (for YAML front matter with title, dates,
folder, tags and id), and the note separator are written. The built-in
`standard-markdown` reproduces the default output; `obsidian` adds front
matter and copies attachments into `<file>.assets` beside `outputPath`.
Templated asset copies get stable content-hashed names and are reused on a
repeat export. An invalid template is refused with `[invalid-template]` and
one JSON path per problem, before any note is read. A templated receipt adds
`template`, `warnings` (such as `missing_asset`) and `assetFiles`. See
[docs/markdown-templates.md](docs/markdown-templates.md) for the schema,
every rule and placeholder, and examples.

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
(see below), scans (PDF with preview), audio,
video, files and link cards (title, domain and preview thumbnail) appear in
body order. Attachments with no body marker are appended in creation order.
An attachment with no usable source renders a visible
`[Image unavailable: name]` marker. The document contains no script, no
`file:` URL and no Notes library path.

A folder export is one presentation document with notes separated by
`<hr class="note-separator">`. It is not a backup or restore format.

Classic PencilKit drawings (`com.apple.drawing.2` and `com.apple.drawing`)
are rendered as SVG, decoded through the public native helper exactly as
[`get-note-drawings`](#get-note-drawings) does. The SVG is embedded as a data
URL, or written to the sidecar directory with `embedAssets: false`, and it is
subject to the same size limits as any other asset. It stays sharp at any
zoom, while Notes' own fallback image is a fixed-size PNG. Paper drawings
(`com.apple.paper`) have no public decoder and keep Notes' fallback image or
preview. If the helper is not built (`apple-notes-mcp setup --public-helper`),
a drawing does not decode, the helper stopped at its stroke limit, or the SVG
is too large, that drawing falls back to the PNG; the export never fails for
it. The SVG traces each stroke's points with its color and mean width, so
pencil grain and marker blending are approximated.

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
| `vectorDrawings` | boolean | No | Render classic drawings as SVG through the public native helper (default `true`). `false` keeps Notes' PNG for every drawing and never runs the helper |

The HTML is always written to a file, because an embedded document is too
large for an MCP message. Paths follow the `save-attachment` rules and may not
point inside the Notes library container. Sidecar URLs are relative to the
HTML file, so the file and its `.assets` directory can be moved together.

**Returns:** `format`, `count`, `bytes`, `output`, either `embedded` (assets
embedded) or `assets` (`dir`, `files`), `stats`, and `skipped`. When the notes
contain classic drawings and `vectorDrawings` is on, `vectorDrawings` reports
`rendered` (drawings placed as SVG), `fallback` (drawings left as PNG), and
`fallbackReasons`, a count per code such as `helper_not_installed`,
`undecodable`, `truncated`, `timeout`, or `too-large`. After one helper
timeout, or when the helper is not usable, the remaining drawings in the
export are not decoded. Nothing already written is deleted if a later step
fails.

---

#### `list-markdown-templates`

Lists the Markdown export templates: the built-ins (`standard-markdown`,
`obsidian`) and every saved template in the library, with its display name,
description, size and modification date. Unreadable, invalid or unsafe files
in the library are skipped and counted in `skipped`. Takes no parameters.

**Returns:** `builtins`, `templates`, `skipped`, and `dir` (the library
directory).

---

#### `show-markdown-template`

Returns one template in its portable form: a built-in, or a saved template
exactly as stored (overrides only). Use it as the starting point for a new
template.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | A built-in or saved template name |
| `expanded` | boolean | No | Also return `expanded`, with every rule filled in from its base |

**Returns:** `name`, `source` (`builtin` or `saved`), `template`, and
optionally `expanded`.

---

#### `validate-markdown-template`

Checks a template without saving it. Pass exactly one of `name`, `template`
or `templateFile`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | One of three | A saved or built-in template |
| `template` | object or string | One of three | The template as a JSON object or JSON text |
| `templateFile` | string | One of three | Absolute path of a JSON template file (home, a temp directory, or `/Volumes`; at most 256 KiB), read under the same rules as `create-note`'s [`contentPath`](#create-note): hidden paths (such as `~/.docker` or a project `.env`) and `~/Library` other than iCloud Drive and `~/Library/CloudStorage` are refused, checked again after resolving symbolic links and letter case, unless the server sets `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1` |

**Returns:** `valid`, and `errors` as `{path, message}` pairs such as
`$.rules["inline.bold"].after: is required when mode is "wrap"`. An invalid
template is a normal result, not a tool error.

---

#### `save-markdown-template`

Validates a template and stores it in the library so `export-notes-markdown`
can use it by `template` name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Lowercase `a-z`, `0-9`, `-` and `_`, 1-64 characters, starting with a letter or digit. Built-in names are reserved |
| `template` | object or string | One of `template`/`templateFile` | The template |
| `templateFile` | string | One of `template`/`templateFile` | A JSON template file, under the same rules as `validate-markdown-template`'s |
| `force` | boolean | No | Replace an existing template of this name (default `false`) |

Saving is create-only: an existing name is refused with `[template-exists]`
unless `force` is true. An invalid template is refused with
`[invalid-template]` and one JSON path per problem. The file is written to a
temporary name and then moved into place, with mode `0600` in a `0700`
directory. The library is `~/Library/Application Support/apple-notes-mcp/templates`,
or `APPLE_NOTES_MCP_TEMPLATE_DIR`. A symlinked library or template file is
refused.

**Returns:** `name`, `path`, `bytes`, and `replaced`.

---

#### `delete-markdown-template`

Removes one saved template file from the library. Built-in templates cannot
be deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | The saved template to delete |

**Returns:** `name`, `path`, and `deleted: true`.

#### Template editor (command line)

`apple-notes-mcp templates edit [name]` starts a local web editor for
templates: edit the JSON on one side and see it validated and rendered
against built-in sample notes on the other, then save it to the library
(create-only unless you tick "replace"). It prints one address with a
per-run token, listens on `127.0.0.1` only, refuses cross-origin requests,
and stops on Ctrl-C or after 30 idle minutes (`--idle-minutes`). It reads a
real note only when you pass `--note <id>`, and then read-only. `--tailnet`
listens on this Mac's Tailscale address instead, so another device on your
tailnet can open it; it never changes Tailscale or firewall settings. See
[docs/markdown-templates.md](docs/markdown-templates.md#editing-in-a-browser)
for options and exactly what it exposes.

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

#### `get-note-drawings`

Decodes a note's classic PencilKit drawings (`com.apple.drawing.2` and the older `com.apple.drawing` attachments) into strokes and SVG. The PencilKit bytes are read read-only from the NoteStore database and decoded by Apple's public `PKDrawing(data:)` in the [public native helper](#public-native-helper). Modern Paper sketches (`com.apple.paper`) are a different format and are not decoded here.

**Requires:** Full Disk Access for the MCP host process, and the public native helper built once with `apple-notes-mcp setup --public-helper`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID (use `search-notes` to find it first) |
| `format` | string | No | `"json"` (default) returns strokes, `"svg"` returns a standalone SVG document per drawing, `"both"` returns both |
| `includePoints` | boolean | No | Include per-point `x`, `y`, `width`, `opacity`, and `force` in JSON strokes (default `true`) |

**Returns:** `status` (`ok`, `partial`, `error`, or `none` when the note has no classic drawing), `drawingCount`, and one entry per drawing with `attachmentId`, `identifier`, `typeUti`, `status` (`ok`, or `error` with a `code` such as `no_data`, `undecodable`, or `timeout`), `strokeCount`, `bounds`, `truncated`, `strokes` (each with `inkType`, sRGB `color` with alpha, mean `width`, `pointCount`, `bounds`, and `points`), and `svg`. Points are already in drawing coordinates. Ink removed with the pixel eraser is left out: a partly erased stroke comes back as one entry per visible piece, each marked `masked: true`, and `hiddenStrokeCount` counts strokes erased completely. `pointsTruncated: true` marks a stroke cut short by the helper's point limit. When a response would exceed `APPLE_NOTES_MCP_EXPORT_MAX_BYTES`, points are dropped and `pointsOmitted` is set, then SVG documents are dropped and `svgOmitted` is set; if it still does not fit, the call fails with an error instead. The SVG draws one path per stroke; it is a faithful outline, not a pixel-exact copy of PencilKit's ink textures.

---

#### `transcribe-note-audio`

Transcribes a note's voice recordings and audio attachments now, on this Mac, with Apple's Speech framework through the [public native helper](#public-native-helper). Recognition is on-device only: `SpeechAnalyzer` on macOS 26 and later, or `SFSpeechRecognizer` with on-device recognition required on older systems (a locale without on-device support is refused, never sent to a server). The audio files are opened read-only where Notes keeps them.

**Requires:** Full Disk Access for the MCP host process, and the public native helper built once with `apple-notes-mcp setup --public-helper`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID (use `search-notes` to find it first) |
| `locale` | string | No | BCP-47 language of the speech, such as `"en-US"` (default), `"it-IT"`, or `"fr-FR"` |
| `attachmentId` | string | No | Only transcribe this audio attachment (an `x-coredata://…/ICAttachment/pN` id) |
| `includeText` | boolean | No | Include transcript text (default `true`); `false` returns statuses and word counts only |
| `downloadAssets` | boolean | No | Let macOS download the language's on-device speech model when it is missing (default `false`: the call returns `asset_unavailable` at once) |
| `maxSeconds` | integer | No | Total time budget for the call, 30 to 3600 seconds (default 900) |

**Returns:** Overall `status` and, per audio attachment, `status`, `durationSeconds`, `wordCount`, `transcript`, and `takes` (a Notes recording can hold several takes; each is transcribed and the texts are joined in stored order). Statuses:

- `ok`: the whole recording was transcribed.
- `partial`: some text came back, but a take failed or the helper stopped at its deadline (`code: "incomplete"`).
- `error`: nothing was transcribed; `code` says why (`asset_unavailable` when the audio file is not on this Mac or the language's speech model is not installed, `permission_required`, `unsupported_locale`, `unsupported_audio`, `time_limit`, ...).
- `indeterminate`: the helper did not answer in time, so the outcome is unknown and a retry may succeed.
- `none` (overall only): the note has no audio.

Each take gets a deadline of 1.5 times its length plus a minute (at most 30 minutes), shortened to what is left of `maxSeconds`. A take that cannot start before the budget runs out reports `code: "time_limit"`. The helper runs as a separate process without blocking the server, and cancelling the request stops it. On macOS 27 a 16-minute recording took about 22 seconds. Some MCP clients stop waiting for a tool after a fixed time, so transcribe long recordings one at a time with `attachmentId`. Transcripts longer than `APPLE_NOTES_MCP_EXPORT_MAX_BYTES` are shortened and marked `transcriptTruncated`.

**Speech models:** the call never starts a download on its own. When the language's on-device model is not installed, it returns `asset_unavailable` right away. Pass `downloadAssets: true` to let macOS download it (a one-time download); if it is still downloading when the call ends, try again shortly.

**Speech Recognition permission:** the server never shows the Speech Recognition prompt, because nobody may be watching an MCP server to answer it. The helper reads the current authorization first. On older macOS, the `SFSpeechRecognizer` path needs that access, and macOS attributes the grant to the app that launches the MCP server (Claude Desktop, Codex, Terminal, and so on), not to the helper. Without it the call returns `code: "permission_required"`; allow the app under System Settings > Privacy & Security > Speech Recognition. If the app has never asked for Speech Recognition access, macOS does not list it there yet, and the call returns `code: "permission_not_requested"` instead: use macOS 26 or later, or run the server from an app that already has the access. On macOS 26 and later, `SpeechAnalyzer` transcribed files without any grant in testing (authorization stayed "not determined"), so only an explicit refusal (denied or restricted) stops it.

---

#### `add-attachment`

Adds one nonempty local file of at most 64 MiB to an exact note using `id`, the
latest `expectedContentHash`, and an absolute `path`. The server never retries
the insertion. It verifies that existing rich content survived and compares the
size and streamed SHA-256 of Notes' saved copy with the source before reporting
success, with no read cap below the 64 MiB write limit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact CoreData note ID |
| `expectedContentHash` | string | Yes | `contentHash` from the note version being extended |
| `path` | string | Yes | Absolute path of the local file. Read under the same rules as `create-note`'s [`contentPath`](#create-note): home, temp or `/Volumes` only; hidden paths (any component starting with `.`, such as `~/.ssh` or a project `.env`) and `~/Library` other than iCloud Drive (`~/Library/Mobile Documents`) and `~/Library/CloudStorage` are refused, checked again after resolving symbolic links and letter case, unless the server sets `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`. Symbolic links and anything but a regular file (a FIFO, a device) are refused |
| `filename` | string | No | Name the attachment gets in Notes instead of the source file's name. One path component that keeps the source file's extension, with no slash, colon, backslash, control character, leading dot or surrounding spaces. Notes names a file attachment after the file it receives, so the server gives its private temporary copy this name |

**Returns:** `attachmentId`, `bytes`, the `name` Notes reports, and the new
`contentHash`. With `filename`, `filenameVerified` says whether Notes reports
that exact name. A mismatch is a warning (`filenameWarning`), not a failure,
because the attachment and its bytes are already verified.

On macOS 27, Notes' AppleScript does not list PDF attachments, so it cannot see
a PDF this tool just added. When that happens and the server has Full Disk
Access, it verifies through the read-only NoteStore database instead: success
requires exactly one new attachment row on the note whose media file matches
the source bytes, and the result carries `verifiedBy: "database"`. Without Full
Disk Access a PDF attach reports "insertion outcome uncertain"; read the note
before retrying, because the attachment was probably created.

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
| `path` | string | Yes | Absolute path of the local file (at most 64 MiB), under the same read rules as `add-attachment`; a refused path creates no note |
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
`add-attachment` result. If the attachment step fails after the note exists but
before the file is inserted, the error names the new note's id: attach to it
with `add-attachment` instead of calling this tool again, which would create a
second note. If insertion started and could not be verified, the error is
`code: "verification_failed"` with `indeterminate: true`: the file may already
be in the note, so read it with `list-attachments` before attaching again.

---

#### `add-attachment-from-pasteboard`

Attaches whatever image, PDF, or file is on the pasteboard (a screenshot, "Copy
Image", or a file copied in Finder) to an exact note. The pasteboard is read once
through AppKit's public `NSPasteboard` API (via JXA, no native build) and its
bytes are frozen into a private temporary file before anything touches the note.
The pasteboard itself is never written. The note and `expectedContentHash` are
checked before the pasteboard is read, so a request with a wrong id, a stale
revision, or a malformed `filename` never captures your clipboard. The frozen
file then goes through [`add-attachment`](#add-attachment)'s checks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Note ID |
| `expectedContentHash` | string | Yes | The note's current `contentHash` (from `get-note-content`) |
| `filename` | string | No | Attachment name. Defaults to the copied file's name, or `Pasted image.png` / `Pasted document.pdf` for image or PDF data. Without an extension, the pasted type's extension is added; with one, it must match the pasted type. Otherwise the same rules as `add-attachment` |
| `allowPasteAlert` | boolean | No | Default `false`. Read the pasteboard even when macOS will show its paste alert (see **Paste privacy** below). Never overrides a Deny setting |

**Returns:** the `add-attachment` result plus `source` (`kind`: `file` or
`data`, the pasteboard `type`, and the default `filename`). A copied file wins
over image data; among data types PDF is preferred (a copied PDF usually comes
with a raster preview of itself), then PNG, JPEG, HEIC, GIF, and TIFF. Several
copied files or several image or PDF items are refused rather than attaching
only the first.

**Paste privacy (macOS 15.4 and later):** macOS can show an alert asking
whether to allow a paste when a process reads the general pasteboard without a
user paste. Before reading anything, the tool checks AppKit's
[`NSPasteboard.accessBehavior`](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum).
It reads only when the value is `alwaysAllow`, or when you pass
`allowPasteAlert: true` and the value is `default` or `ask` (macOS then shows
its alert, and the call waits for your answer up to the automation timeout).
Otherwise it reads nothing and returns `code: "permission_denied"` with
`pasteboardCode: "pasteboard_access_denied"` and `accessBehavior` (`default`,
`ask`, `alwaysDeny`, or `unknown`). `alwaysDeny` is always refused; change it in
System Settings, where macOS lists an app after its first paste alert. On macOS
before 15.4 the property does not exist and the pasteboard is read as before.

**Errors** carry a `pasteboardCode` next to the shared `code`, and
`committed: false` because nothing was written:

| `pasteboardCode` | `code` | Cause |
|------------------|--------|-------|
| `pasteboard_access_denied` | `permission_denied` | Reading would show the macOS paste alert, or pasting is denied (see above) |
| `pasteboard_empty` | `validation_error` | Nothing is on the pasteboard |
| `unsupported_content` | `validation_error` | No PNG, JPEG, HEIC, GIF, TIFF, PDF, or copied file (text belongs in `append-to-note`); the message and `types` list the pasteboard types found |
| `multiple_files` | `validation_error` | More than one copied file; `count` says how many. Copy one file, or use `add-attachment` per file |
| `multiple_items` | `validation_error` | More than one image or PDF item (not files); `count` says how many. Copy one, or save each and use `add-attachment` |
| `too_large` | `validation_error` | More than 64 MiB |
| `file_unreadable` | `validation_error` | The copied file is a symlink, empty, over 64 MiB, or unreadable |
| `pasteboard_changed` | `operation_failed` | The pasteboard changed while it was being read; try again |
| `pasteboard_timeout` | `operation_failed` | The read timed out (for example an unanswered paste alert) |
| `pasteboard_unavailable` | `operation_failed` | The MCP host is not running in your logged-in GUI session (for example over SSH) |
| `write_failed` | `operation_failed` | The temporary copy could not be written |

The pasteboard read uses the same timeout as other automation steps
(`APPLE_NOTES_MCP_TIMEOUT_MS`, 30 seconds by default).

**Known limitation ([#236](https://github.com/sweetrb/apple-notes-mcp/issues/236)):** on macOS 27, Notes' AppleScript dictionary does not list
PDF attachments, so a PDF (pasted or from `add-attachment`) is inserted but
cannot be verified and the call reports "insertion outcome uncertain". Read the
note before retrying.

For testing, `APPLE_NOTES_MCP_PASTEBOARD_NAME` makes the tool read a private
named pasteboard instead of the general one, so a test never touches your
clipboard.

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

**Returns:** Per drawing: `attachmentId`, `identifier`, `uti`, `kind` (`paper` or `drawing`), `handwritingSummary` (the handwriting text Notes recognized, or `null` when it stored none), `bundlePresent` (the Paper data bundle is on disk), `fallbackImagePath` (Notes' full rendering), `fallbackImageStale` (true when Notes recorded a newer rendering than the one on disk, so the image may not show the latest strokes; `export-paper-image` then reports `stale: true`), `previewPath` (its largest thumbnail), and `raster` `{source, format, width, height}`: the validated image `export-paper-image` would copy, or `null`.

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

#### `analyze-svg`

Analyzes one local SVG file and reports whether it can be represented as editable monoline strokes (a list of strokes, each a solid color, a width, and a polyline) and what that conversion would approximate or drop. It is a standalone preflight: it reads only the file, opens no Notes data, and makes no network request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path of one `.svg` file: a regular file, not a symbolic link, at most 1 MiB of UTF-8, in home, temp, or `/Volumes`, read under the same rules as `create-note`'s [`contentPath`](#create-note): hidden paths (such as `~/.docker` or a project `.env`) and `~/Library` other than iCloud Drive and `~/Library/CloudStorage` are refused, checked again after resolving symbolic links and letter case, unless the server sets `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1`. A file whose first element is not `<svg>` is refused without quoting any of it |
| `includeDrawing` | boolean | No | Also return the normalized drawing. Off by default because it can be large |

**Returns:** `classification`, `importable`, `defaultWriteAllowed`, `requiredLosses`, `issues` (each with a `code`, the `loss` it causes or `null`, an element `location` such as `svg/g[2]/path[1]#id`, and a message), `viewport`, `counts` (elements, references, path segments, output strokes and points, and the `geometryWork`, `dashWork`, and `scanWork` budgets as `{used, max}`), `source` (`sha256`, `bytes`), `drawingBytes`, and `analysisDigest`.

| Classification | Meaning |
|---|---|
| `safe` | The output needs no reported approximation or omission. `defaultWriteAllowed` is true |
| `lossy` | The output needs `geometry-approximation` or `paint-approximation` |
| `unsupported` | Visible content would be dropped (`drop-content`), or nothing drawable remains (`importable: false`) |

The loss modes:

- `geometry-approximation`: non-round caps or joins are drawn round, a non-uniformly scaled stroke gets one width, or centerlines are clipped at a viewport. Curves are flattened to within 0.25 px, which is not reported as a loss.
- `paint-approximation`: solid fills become overlapping strokes, group opacity is applied to each stroke, and blend modes or a non-default paint order are ignored.
- `drop-content`: text, images, gradient and pattern paint, filters, masks, clip paths, markers, `<switch>`, and unknown elements are omitted.

Supported input: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`; `g`, `a`, nested `svg`; local `defs`, `symbol`, and `use`; transforms; `viewBox` and `preserveAspectRatio`; solid named, hex, `rgb()`/`rgba()`, and `hsl()` colors, `currentColor`, opacity, fill rules, and dashes, from attributes or the `style` attribute. `analysisDigest` is a SHA-256 over the canonical analysis and normalized drawing, so equal digests mean the same result.

**⚠️ Safety:** Read-only. Active or unsafe input is refused as an error with `code: "validation_error"` and an `svgCode`: `svg_unsafe` for scripts, event-handler attributes, `<style>` elements, animation, embedded objects, DOCTYPE or entity declarations, processing instructions, and any external reference (only local `#id` references and embedded raster images are allowed); `svg_invalid` for malformed XML; `svg_reference_invalid` for cyclic or duplicate-id references; `svg_complexity_limit` or `svg_geometry_invalid` when a limit is exceeded (16,384 elements, 100,000 path segments, 4,096 output strokes, 100,000 points, 5,000,000 fill scan checks); `svg_file_invalid` for a path or file that cannot be read.

---

#### `export-attachments`

Copies a note's attachment files into a directory without opening Notes.app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | Exact CoreData note ID |
| `exportDir` | string | Yes | Absolute destination directory, created if missing. Same allowlist as `save-attachment` (home, temp, or `/Volumes`), and never inside the Notes data folder |
| `firstImageOnly` | boolean | No | Export only the lead visual that `list-attachments` `firstImage` reports |

**Returns:** `exportDir`, counts (`exported`, `previews`, `fallbacks`, `skipped`, `failed`), and per attachment its `attachmentId`, `identifier`, `kind`, `exportedTo`, and `exportedKind`: `"asset"` for the real file, `"fallback"` for Notes' own full rendering of it (a drawing's PNG or a scan's PDF, named with that format's extension), `"preview"` when the asset never downloaded and only Notes' thumbnail was on disk, or `null` when nothing was on disk. `inBody: false` marks an attachment the note body no longer shows, and `stale: true` marks a rendering taken from an older generation because the one Notes recorded is missing; attachments inside a container Notes has deleted are not exported. A preview is never chosen over an available asset, and it is named `<name>-preview.<ext>` so it is not mistaken for the original. A scan gallery with no file of its own exports its pages.

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

Every tool below that edits one note takes these parameters, plus the ones
listed under the tool itself:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Exact note ID: x-coredata id, Notes UUID, or numeric key (see [Identifier forms](#identifier-forms)) |
| `expectedContentHash` | string | Yes | `contentHash` (`sha256:…`) from a fresh read of the note |
| `scopeText` | string | Yes | Distinctive phrase already in the note below its title line, 12–500 characters, that Notes search can find. Prefer plain words without punctuation, hashtags, or paths |

When the Shortcut refuses a request (its Find Notes step did not return
exactly one note with that exact title and `scopeText`) or stops with its own
action error, and the note reads back unchanged, the tool reports the
Shortcut's reason with `code: "operation_failed"`, `committed: false` and
`indeterminate: false`: nothing was written, so a retry is safe once the cause
is fixed. Notes search can lag behind a note created or edited moments ago, so
a refusal on a brand-new note may clear after a minute. A timeout, or a failed
readback on a note that did change, is still reported as indeterminate.
If the Shortcut is not installed, the error is `code: "shortcut_not_installed"`
with `committed: false`.

#### `get-capabilities`

Reports which background operations are implemented, live-verified, installed,
and currently available, with a specific reason for each unavailable operation.

It also reports `runtimeOS` (`platform`, `macOSVersion` from `sw_vers`,
`darwinRelease`) and a `features` matrix, one entry per feature group:
`applescriptCore`, `fullDiskAccessReads`, `shortcutsBridges`,
`backgroundOperationsBridge`, `nativeTagsBridge`, `markdownNoteBridge`,
`paragraphLinks` and `audioTranscription` (both database reads that need Full
Disk Access), and the placeholders `checklistToggle` and `smartFolders`
(creating or editing smart folders), which need a native *write* helper this
server does not ship (requirement `native_write_helper`). The opt-in private
helper below is read-only, so enabling it does not change them: they stay
`not_implemented`.
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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Content to append, up to 1,048,576 characters |
| `format` | string | No | `"plaintext"` (default), `"html"`, or `"markdown"` |

#### `create-checklist-item`

Appends one real unchecked Notes checklist item and verifies its native identity
and text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The item's text |

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

**Returns:** `items` (also as `landed`), each with its `index`, native `id` and
`text`, plus `orderVerified` and the new `contentHash`. The first uncertain
result stops the call without a retry and returns `ok: false` with `landed` (the
verified items), `stoppedAt` (the item's index, text, `outcome` of
`"not-written"` or `"uncertain"`, and the error), and `notAttempted`. Every
`ok: false` result is an error result (`isError: true`) with a `code`; after an
uncertain stop it has `indeterminate: true` and no `contentHash`, since the note
may have changed. Read the note before retrying, and retry only the items that
are not present.

#### `create-table`

Appends a native table from rectangular string rows and verifies every decoded
cell. It never substitutes a text table. Omit `rows` for an empty 2 × 2 table,
the size Notes itself inserts from Format > Table; its four empty cells are
verified the same way.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rows` | string[][] | No | Cell text, row by row: 1–1,000 rows of 1–100 cells, every row the same length. Omit for an empty 2 × 2 table |

#### `set-note-pinned`

Sets an explicit pinned state after checking both the expected current state and
the note revision. It does not rewrite the body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `expectedPinned` | boolean | Yes | The pinned state you last read; the call is refused if it differs |
| `pinned` | boolean | Yes | The pinned state to set |

#### `remove-native-tags`

Removes specified tags from one exact note while preserving unrelated tags and
native objects. It does not delete global tag definitions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tags` | string[] | Yes | 1–100 tag names to remove |

#### `replace-native-tag`

Adds and verifies the new tag before removing the old tag on an explicit list of
freshly read notes. Stops on the first uncertain result. Smart Folder rules are
not changed.

Unlike the other tools in this section, it takes a list of notes instead of one
`id`:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `notes` | object[] | Yes | 1–100 entries, each with the note's `id`, `expectedContentHash`, and `scopeText` |
| `oldTag` | string | Yes | Tag to remove after the new one is verified |
| `newTag` | string | Yes | Tag to add |

#### `insert-note-link`

Retrieves another note's real deep link and appends it with a static label while
preserving the target note's native objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `linkedNoteId` | string | Yes | ID of the note to link to, in any [identifier form](#identifier-forms) |
| `label` | string | No | Visible link text (default: the linked note's title) |

### Private helper (opt-in, unsupported Apple API)

An optional, **read-only** native helper reads note state through Notes' own
data model (Apple's private NotesShared framework) instead of AppleScript or
Shortcuts. It is **off by default** and nothing in the rest of the server
depends on it. It cannot write: every store it opens is opened read-only, and
write support was deliberately deferred by the maintainer until a second
writer beside a running Notes.app, CRDT replica identity, and the iCloud
upload lag are understood.
Private API can break on any macOS update; see
[TECHNICAL_NOTES.md](TECHNICAL_NOTES.md#private-helper-notesshared) for the
API surface, risks, and safety contract.

To use it:

1. Build it on your Mac from the packaged source (needs the Command Line
   Tools, `xcode-select --install`). No prebuilt binary ships with the package.

   ```bash
   apple-notes-mcp setup --native-helper          # build, ad-hoc sign, install
   apple-notes-mcp setup --native-helper --check  # report only
   ```

2. Set `APPLE_NOTES_MCP_ENABLE_PRIVATE=1` in the server's environment (or in
   the [config file](#configuration-file-when-the-host-strips-env)).
3. Give the app that launches the server Full Disk Access, the same grant the
   database reads already need.

The server checks the helper's recorded source and binary SHA-256 before every
call and refuses a missing, stale, or modified helper with a machine-readable
`code`. Rerun setup after upgrading apple-notes-mcp.

#### `native-helper-status`

Reports whether the helper is enabled, built, and current, and runs its live
probe: macOS and Notes versions, whether NotesShared loads, whether every
required class, selector, and model property exists, and whether the Notes
store opens. Each feature reports `available` plus a `reason` code
(`disabled`, `helper_not_installed`, `helper_stale`, `helper_modified`,
`private_api_unavailable`, `store_unavailable`, …). Read-only; the response
carries `readOnly: true`.

#### `native-note-state`

Reads one note's native state by Notes UUID (`identifier`) or x-coredata `id`:
title, modification date, folder identifier, lock/trash/shared/editable
flags, iCloud version counters, and a `revision` change token (compare two
reads to detect a change). Opens the store with Core Data's read-only option.

### Private writer (opt-in, unsupported Apple API)

An optional **writer** adds writes as a separate layer on top of the
read-only helper. It is a second program
(`native/private-helper/apple-notes-private-writer.m`) with its own binary,
checksum manifest (`writer-manifest.json`), and setup command. The read-only
helper above is unchanged, and nothing in its build or dispatch path can
reach the writer. The writer is **off by default** and needs two switches:

```bash
apple-notes-mcp setup --native-writer          # build, ad-hoc sign, install
apple-notes-mcp setup --native-writer --check  # report only
```

- `APPLE_NOTES_MCP_ENABLE_PRIVATE=1` (the private opt-in) **and**
  `APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1` (the write opt-in). The writer
  itself refuses a read-write open of the live store without the second one.
- `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` for a write that has not passed live
  validation in a release (every write so far).

Every write takes an `ifRevision` compare-and-swap token (the `revision` from
`native-note-state` or a feature's own read), saves through Notes' own data
model with optimistic locking, and re-reads the note through a fresh Core Data
stack before it reports success. Failures carry `committed: false` (nothing
was saved) or `indeterminate: true` (read the note before any retry). The
writer cannot upload to iCloud; only Notes.app can, and it may skip a note it
already holds in memory. The optional `nudge` asks Notes.app to save the note
by moving it into the folder it is already in.

Every writer tool that writes a note also takes the three
[folder scope guards](#folder-scope-guards) (`ifFolderId`,
`ifAncestorFolderId`, `forbiddenAncestorFolderIds`); the smart-folder writes
apply them to the smart folder's parent. The writer checks them itself, in
the same Core Data transaction as the write and just before the save, and a
dry run checks them too. A failure is `code: "revision_conflict"` with
`helperCode: "scope_conflict"` and `committed: false`. Unlike the AppleScript
tools, every id must name an existing folder: an unknown id, or a forbidden id
that names a deleted folder, refuses the call (`helperCode:
"scope_folder_not_found"`) instead of matching nothing. `compose-note` takes
the guards in `append` and `prepend` mode only.

#### `native-writer-status`

Reports both switches, the writer's installation and checksum state, its live
probe, and per-feature availability with a `reason` (`disabled`,
`writes_disabled`, `helper_not_installed`, `helper_stale`, `helper_modified`,
`not_live_validated`, `private_api_unavailable`, `store_unavailable`, …).
Read-only.

#### `native-append-plain-text`

Appends plain text paragraphs to one note by Notes UUID (`identifier`) or
x-coredata `id`, guarded by `ifRevision` and verified by read-back. Returns
`committed`, `verified`, `revisionBefore`/`revisionAfter`, and sync state
(`cloudSync`, `pushState`; `pushScheduled` is always false). With
`nudge: true` it then moves the note in place and watches Notes' upload
counters for `nudgeWaitSeconds` (default 30), reported under `sync`. Refuses
locked, shared, trashed, and still-downloading notes.

#### `native-sync-push`

Gets writer-saved changes uploaded after the fact, for example a note written
without `nudge` or one whose nudge timed out, and reports from Notes' own
counters whether they were. Pass up to 50 note or folder UUIDs in
`identifiers`. It never writes to the Notes database.

- `method: "status"` reads each target's `currentLocalVersion` and
  `latestVersionSyncedToCloud`, plus the library-wide `pendingUploadCount`.
  Read-only.
- `method: "nudge"` (default) makes a running Notes.app save each pending
  note by moving it into the folder it is already in, as `nudge: true` does
  after a write. Text, title, and modification date do not change
  (`contentUnchanged` compares the revision token). Locked, shared, trashed,
  and non-iCloud notes, and folders, are skipped with a `reason`.
- `method: "relaunch"` quits and reopens Notes.app (or opens it when it is not
  running) so its launch sweep uploads everything pending, folders included.
  It interrupts anyone using Notes, so it requires `confirm: true`, and the
  tool is annotated as destructive. It only counts this user's Notes.app
  process, and stops without relaunching when it cannot tell whether Notes.app
  quit.

Afterwards the tool watches the counters for `waitSeconds` (default 30, or 0
for `status`). `uploadRecorded` is true only when Notes recorded the current
version as synced to iCloud; `pushScheduled` is always `false`.

After a relaunch, each folder target also reports `adoptedByNotesApp`: whether
the reopened Notes.app shows the folder by its id (or, for a deleted folder,
no longer shows it), read through AppleScript for up to 20 seconds, with the
details under `adoption`. `null` means it could not be checked. If reading the
counters fails after Notes.app was restarted, the error
(`helperCode: "relaunch_failed"`, `relaunched: true`) says so; check again with
`method: "status"` rather than relaunching again.

#### `native-edit-note`

Edits selected text inside one note in place and leaves everything outside
the edited ranges alone: attachments, tables, checklist state, paragraph
styles, and inline formatting. Operations, applied together against one
snapshot of the note:

- `replace`: literal text (`match: "substring"` or `"equals"`), with plain
  `text` that inherits the replaced range's formatting, or `runs`. A run is
  `{text, bold?, italic?, underline?, strikethrough?, link?, highlight?,
  color?}`, the same fields as a `compose-note` run: `link` is an http,
  https, mailto, tel, notes, or applenotes URL, `highlight` is `purple`,
  `pink`, `orange`, `mint`, or `blue`, and `color` is `#RRGGBB`. A run's
  formatting is exactly what it states, so a run without `link` is not
  linked even when it replaces linked text.
- `insert_after` / `insert_before`: new paragraphs (`heading`, `subheading`,
  `body`, `monospaced`, `bulleted`, `dashed`, `numbered`, `checklist` with
  `checked: true` or `false`) next to a paragraph matched by its exact text or
  by style and position (`{kind: "style", style: "subheading", occurrence: 2}`).
  Only a `body` block may be empty.
- `append_to_paragraph`: adds `runs` at the end of one existing paragraph, on
  its own line, for example a source link after a bullet's text. `anchor`
  names the paragraph like an insert anchor. The runs take the paragraph's
  style and font; start the first run with a space.
- `replace_checklist`: replaces a checklist with new `items`, each
  `{text | runs, checked, indent?}`. With `select: "block"` (the default) it
  replaces one contiguous run of checklist rows: the one holding a row whose
  whole text is `containing`, the `occurrence`-th, or the only one. With
  `select: "all"` it replaces every checklist row: the first run becomes the
  new items and the other runs are removed. Every other paragraph and
  attachment stays as it is; a run that holds the title or an attachment is
  refused. The dry run lists `removedItems` (text and checked state), and the
  optional `expectedCount` counts replaced rows.
- `delete_paragraph`: a paragraph matched by its exact text, or an empty list,
  checklist, or heading row (`{kind: "blank", style}`). Each paragraph goes
  with its own line break; deleting the last paragraph removes only its text
  and leaves the previous paragraph's line break, as `trim_blank_lines` does.
  Adjacent paragraphs matched by one operation are removed as one range.
- `set_title`: the first paragraph.
- `trim_blank_lines`: removes redundant empty paragraphs. `mode: "runs"`
  keeps the first `keep` (default 1) of every run of blank lines, `"end"`
  removes trailing blank lines, and `"around"` removes the blank lines
  directly before and/or after (`side`) the one paragraph `anchor` names
  (`keep` defaults to 0 for both). Only paragraphs holding nothing but
  whitespace, in a title, heading, subheading, or body style, are removed,
  each with its own newline; the title paragraph and empty list, checklist,
  monospaced, and attachment rows are never touched. The dry run lists every
  paragraph it would remove (`paragraphIndex`, `paragraphStyle`,
  `blankUTF16`). Here `expectedCount` is optional and counts removed
  paragraphs.

`expectedCount` (default 1) must equal the number of matches, and
`occurrence` picks one of them, so it may not exceed `expectedCount`.
Matching is case-sensitive, stays inside one paragraph, never splits a
character (a match inside an emoji or before a combining accent is refused
with `unsupported_selection`), and never touches an attachment glyph unless an
attachment selector names it.

An attachment selector, `{kind: "attachment", identifier | id | ordinal}`,
names one of the note's attachments by its Notes UUID or x-coredata id (both
from `get-note-structure`; `list-attachments` gives the id) or by its
1-based position among the note's attachments in body order. Inline objects
(hashtags, mentions, note links) are not counted and cannot be selected.
Notes stores some attachments, such as an image added through AppleScript, as
two adjacent glyphs; the selector treats them as one attachment, counts it
once, and edits all of its glyphs together.

- In `replace`, `position: "self"` (the default) replaces the attachment with
  the replacement text, and empty text removes it from the body.
  `position: "before"` or `"after"` inserts the text inline beside it.
- In `replace` with `position: "self"`, `replacement: {file, filename?}` puts
  a new attachment in its place in the same save: `file` is an absolute path
  in your home folder, a temporary folder, or `/Volumes` to a non-empty image
  or PDF of at most 64 MiB (the final path component may not be a link), and
  `filename` is the name Notes shows, which must keep the file's extension.
  The attachment it replaces must be a file (image, PDF, or other file), not a
  table, drawing, or link card. The dry run reads the file and reports its
  size and SHA-256 in `replacementFiles` without writing anything; the apply
  creates the attachment, verifies its type, name, and bytes in a fresh read,
  and removes it again if anything fails before the save.
- In `delete_paragraph`, it removes the attachment's own paragraph, which must
  hold nothing but the attachment and whitespace.
- As an `insert_after` / `insert_before` / `append_to_paragraph` anchor, it
  names the paragraph that holds the attachment.

Only the named attachment's glyphs may be inside an edited range. The plan
lists `removedAttachments`. The apply proves that every other attachment row
still belongs to the note with the same stored values and reports what
happened to each removed attachment's row (`rowStillInNote`,
`markedForDeletion`). Removing an attachment from the body does not delete its
file; Notes decides when to clean up the row.

Always call it twice. `dryRun: true` is read-only and returns the plan
(targets, `lengthBefore`/`lengthAfter`, `unchangedUTF16`, `wouldChange`),
`revisionBefore`, and `planDigest`. Then send the identical request with
`dryRun: false`, `ifRevision` set to that `revisionBefore`, and `ifPlanDigest`
set to that `planDigest`. The digest covers the operations,
`requireNonSystemPaper`, and each replacement file's bytes, so the apply
refuses (`plan_mismatch`, reported as `revision_conflict`) when anything
differs from the dry run. The apply re-reads the note in a
fresh Core Data stack and returns `preservation`, which says that every
character outside the edits kept its formatting, that the attachment glyph
sequence is the planned one, and that the note's attachment rows did not
change (apart from an attachment the request removed or a replacement file
added). The comparison reads every stored field of each paragraph style
(including checklist state and list numbering), font, color, link, and
attachment reference; a note holding formatting of any other kind is refused
at the dry run (`unsupported_note`) rather than edited without that proof.
Refusals commit nothing: `revision_conflict`, `match_count_mismatch`,
`mixed_formatting` (use `runs`), `conflicting_operations`, `title_invariant`,
`unsupported_selection`, `unsupported_attachment`, and
`unexpected_side_effect` (the edit would change
another object, for example an attachment Notes uses for the title). Takes
`nudge` like `native-append-plain-text`. Planning needs the two writer
switches; applying also needs `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until the
edit path is live-validated.

#### `compose-note`

Writes natively formatted content through the writer in one save: headings,
subheadings, body paragraphs, block quotes, monospaced blocks, bulleted,
dashed, and numbered lists with indent, checklists with their checked state,
native dividers (`{"type":"divider"}`), native tables
(`{"type":"table","rows":[["A","B"],["1","2"]]}`), local files
(`{"type":"file","path":"/Users/me/Report.pdf","filename":"Q3 Report.pdf"}`),
rich link cards (`{"type":"urlCard","url":"https://example.com/"}`), and links
to other notes (`{"type":"noteLink","identifier":"<uuid>","text":"See"}`).
Inline runs carry bold, italic, underline, strikethrough, links (http,
https, mailto, tel, notes, applenotes), named highlights (purple, pink,
orange, mint, blue), and `#RRGGBB` text color. A link must already be
well-formed (spaces and non-ASCII characters percent-encoded), so the stored
link equals the request. Every link to a note, from a `noteLink` block, a run,
or Markdown, must name an existing note that is not locked or in Recently
Deleted. Give `blocks` or `markdown`, not both.

File and link-card blocks go where they appear, in the same save as the text.
A file follows `add-attachment`'s rules: an absolute path to a nonempty
regular file (not a symbolic link) of at most 64 MiB, and an optional
`filename` that keeps the source extension. The writer reads each file once
and creates the attachment from exactly those bytes; one request takes at
most 20 file and link-card blocks and 128 MiB of files. A link card is an
absolute http(s) URL; Notes fetches its title and image later, as with
`native-add-url-card`. If anything fails before the save, the writer rolls
back every row and deletes every attachment file it wrote.

| `mode` | Target | Guard |
|--------|--------|-------|
| `create` | `title` plus optional `folder` and `account` | Notes.app creates the note (AppleScript), then the writer appends the content below the title under a revision read immediately after |
| `append` | `identifier` or `id` | `dryRun: true`, then the identical request with `ifRevision` set to the plan's `revisionBefore` |
| `prepend` | `identifier` or `id` | Same; inserts directly below the title line |

`append` also takes `insertBeforeHeading` (`text`, `occurrence`,
`expectedCount`) to insert before one exact Heading-style paragraph; a count
mismatch returns `selector_conflict` with nothing written.
`requireNonSystemPaper` refuses a Quick Note target. A note with no body at
all (not even a title line) is refused, because its first paragraph is the
title. After saving, the writer
re-reads the note through a new Core Data stack and compares every written
paragraph's style, indent, block quote, checklist state, and runs with the
request; `readBack` reports them, and `unitStart` and `objectURI` say where
the written paragraphs begin. The server then checks `readBack` against the
request itself: each run's length and attribute values (link URL, highlight,
color, styles) and, for each object, its kind, type, card URL, or file name.
A mismatch at either step returns `verification_failed` with
`committed: true` and `indeterminate: true`. On the live store the server then
decodes the same paragraphs from NoteStore.sqlite with its own block decoder
(the one behind `get-note-blocks`) and reports the comparison of text and
attribute values as `databaseReadBack` (`matches`, or `checked: false` with a
reason).

Appending or prepending never changes what the note already holds. Before
anything changes, the writer fingerprints every existing attachment: each
attachment row (identifier, type, metadata, and mergeable data such as a
table's cells), its media row, its file's bytes where the file is on this
Mac, every inline attachment, and the order of attachment glyphs. It takes
the same fingerprint again just before the save and refuses with
`attachment_drift` (`committed: false`) on any difference, and once more
after the save, where a difference is `verification_failed` with
`attachmentDrift`. `frozenAttachments` in the result reports the counts. The
one change it accepts is a raised version floor
(`minimumSupportedNotesVersion`), which Notes' own model applies to every
attachment when new content, such as a divider, needs a newer Notes; those
rows are listed in `frozenAttachments.versionFloorRaised`.

With `nudge: true` a verified write is followed by the same move-in-place
nudge as `native-append-plain-text`. `create` checks every limit before
Notes.app creates the note: content rules, the writer's size limits (table
cell text counts toward the 200,000 UTF-16 limit, at most 10,000 per cell and
20,000 runs), and the writer's 1 MiB request size. If the compose still fails
with nothing written, the server moves the new title-only note to Recently
Deleted (`createdNote: "moved_to_recently_deleted"`), but only when the note
is still exactly as created. Otherwise the error names it (`noteCreated`,
`id`, `identifier`, `createdNote: "kept"`).

```json
{
  "mode": "append",
  "identifier": "D629A948-0C61-43BA-8FDE-04CD6DED38C7",
  "dryRun": true,
  "blocks": [
    { "type": "heading", "text": "Review" },
    { "type": "body", "runs": [{ "text": "Ready", "bold": true }, { "text": " to ship" }] },
    { "type": "checklist", "items": ["Draft", "Publish"], "checked": [true, false] },
    { "type": "bulleted", "items": ["Owner", { "text": "Backup owner", "indent": 1 }] },
    { "type": "code", "text": "npm test\nnpm run build" }
  ]
}
```

The Markdown importer maps `#` and `##` to Heading and `###` and deeper to
Subheading, and imports `-`/`*`/`+` and `1.` lists with nesting, `- [ ]` and
`- [x]` checklists, `>` quotes, fenced code, `**bold**`, `*italic*`,
`~~strikethrough~~`, `<u>underline</u>`, and links, and turns `---` into a
divider and pipe tables into native tables (cells as plain text). A table
needs a delimiter row with pipes and the header's cell count (`|-|-|` is
enough); extra cells in a body row are dropped with a warning. An image alone
on a line becomes a file block when it points at an absolute path
(`![](/Users/me/chart.png)`) and a link card when it points at an http(s) URL;
the alt text is dropped. In `create` mode a leading `# ` line equal to the
title is dropped. Dividers, tables, files, and link cards are created only on
apply and reported under `objects`; the dry run lists what it would create,
with each file's size and SHA-256. The writer re-reads each object, every
table cell, each card's URL, and each file's bytes. Writes need both writer
switches and, until this path passes live validation in a release,
`APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1`; dry runs do not. Files and link cards
also need the writer's `composeAttachments` feature (`native-writer-status`).

#### `native-checklist-state`

Lists a note's native checklist items from Notes' own model: each item's
`todoIdentifier` (32 hex digits, the same `id` `get-native-objects` reports),
`done`, `index`, `text`, line and styled-character offsets, plus the note's
`revision`. Read-only, but it runs through the writer, so it needs both
switches. Items come from the exact characters that carry each todo identity,
so a newline stored in the next item's run never shifts an item onto the
wrong line.

#### `native-set-checklist-item`

Checks (`done: true`) or unchecks (`done: false`) one existing checklist item
by `todoIdentifier`, guarded by `ifRevision`. Only that item's done bit
changes: its identity, text, indentation, and every other attribute are kept.
The writer re-reads the note through a new Core Data stack and reports
`persistedDone`, and fails verification if the text, the item's characters,
or any other item changed. When the item already has the requested state it
writes nothing and returns `status: "unchanged"`, `committed: false`. An
identifier that matches no item is `not_found`; one that appears in two places,
or that two adjacent lines share, is `ambiguous_target` (envelope code
`ambiguous`). Sync reporting and the
optional `nudge` match `native-append-plain-text`; the nudge is skipped when
nothing was written.

#### `native-highlight-text`

Applies Notes' highlight (`purple`, `pink`, `orange`, `mint`, `blue`) to, or
removes it (`color: "none"`) from, every exact occurrence of a literal,
case-sensitive `match` within one paragraph. It refuses with
`match_count_mismatch` (envelope code `validation_error`, with `found`),
writing nothing, unless the text occurs exactly `expectedCount` times
(default 1). A match that starts or ends inside a composed character (a
letter and its combining accent, an emoji sequence) is refused with
`invalid_request` and `splittingMatches`; include the whole character.
`dryRun: true` reports each match and its current highlight without writing,
plus `writeAvailable` (whether this macOS offers the write); a write needs
`ifRevision` from `native-note-state`. Only the
highlight attribute of the matched characters changes. The writer re-reads
the note through a new Core Data stack and requires the text to be unchanged,
every highlight run in the note to match the request, and Notes' `hasEmphasis`
flag to agree, then returns the stored runs per match (`ranges`). When every
match already has the requested state it writes nothing
(`status: "unchanged"`). Sync reporting and the optional `nudge` match
`native-append-plain-text`. Writes also require
`APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until live-validated in a release; dry
runs do not.

`scope: "note"` targets the whole body after the title instead of `match`
(which, like `expectedCount`, is refused with it). It skips the title
paragraph through its newline and every attachment glyph (images, files,
tables, drawings, inline tags), whose contents are never changed, and keeps
paragraph separators in the body. Every result reports `rangeCount` and
`characterCount` (UTF-16 units targeted), and for this scope `skipped`:
`titleUTF16`, `attachmentGlyphs`, and `highlightedAttachmentGlyphs` (glyphs
that already carry a highlight, which keep `hasEmphasis` true after a
removal). A note with no text after its title outside attachments is refused
as `nothing_to_highlight` (envelope code `validation_error`).

#### `native-add-url-card`

Adds a rich web link card (the preview tile Notes shows for a pasted URL) to
one note: a new `public.url` attachment plus its attachment glyph on a line of
its own, at the end of the note or directly after the one paragraph whose full
text equals `afterParagraph`. After a paragraph, the card goes after that
paragraph's own line break and ends with a body-style line break of its own
(`terminatorInserted`), so it never takes the paragraph's style: a card after
a checklist item is a plain line, not a second item. Zero or several matching
paragraphs refuse with `match_count_mismatch` (envelope code
`validation_error`, with `found`) and write nothing. `url` must be an absolute
`http` or `https` URL. `dryRun: true` reports the insertion point without
writing, plus `writeAvailable` (whether this macOS offers the write); a write
needs `ifRevision` from `native-note-state`. The writer re-reads the note
through a new Core Data stack and requires the text to equal the old text plus
the card at the planned index, the glyph to name the new attachment exactly
once, the card's line to have the body paragraph style, and the attachment
row to be a `public.url` attachment for that URL on that note. It makes no
network request: Notes fetches the card's title and preview image itself. The
result carries the attachment's own `cloudSync` counters. Not idempotent: a
repeat adds a second card, but the replayed revision is refused. Sync
reporting and the optional `nudge` match `native-append-plain-text`. Writes
also require `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until live-validated in a
release; dry runs do not.

#### `native-set-paragraph-id`

Gives one paragraph a paragraph identifier of its own, so
`get-paragraph-link` and `list-note-paragraphs` can link it. Use it when
`list-note-paragraphs` reports the paragraph's `paragraphIdStatus` as `shared`
or `missing`. Pass the paragraph's `blockIndex` and `text` (as
`expectedText`) from `list-note-paragraphs`, and `ifRevision` from
`native-note-state`. The writer applies the same block and uniqueness rules
as `list-note-paragraphs`, mints a UUID (or assigns `paragraphId` if it is
unused), and verifies by read-back that only that paragraph's identifier
changed. Returns `status: "updated"` with the new `paragraphId` and `url`, or
`status: "unchanged"` (nothing written) when the identifier was already
unique. `paragraph_changed` (code `revision_conflict`, `committed: false`)
means the block no longer holds that text. Takes the optional `nudge`.

#### `native-add-section-link`

Inserts a native section-link chip, the chip Notes pastes for Copy Link to
Section, into a note (macOS 27 or later). The chip opens a paragraph of the
same note or, with `target`, of another note. Choose the paragraph by
`blockIndex` plus `expectedText` from `list-note-paragraphs`, by a
`paragraphId` that is unique in the target, or by `heading` (title, heading,
or subheading text, exact and case-insensitive); with none of them it links
the first heading or subheading. When the paragraph's identifier is `shared`
or `missing`, the writer mints one in the same save (`paragraphIdMinted`).
`position` is `end` (default) or `belowTitle`, and
`clearExistingSectionLinks: true` first removes the note's section-link chips
(note-link chips stay). Needs `ifRevision` for the note and, for another
note, `ifTargetRevision`, both from `native-note-state`. Returns `url`,
`token`, `section`, `paragraphId`, `inlineAttachmentIdentifier`,
`clearedSectionLinks`, the revisions of both notes, and sync state.
`list-note-links` then reports the chip as kind `section`. With `nudge: true`
it nudges the note, and the target note too when an identifier was minted
there.

#### Native tables

Five tools edit native tables by their CRDT identifiers. Tables, rows, and
columns are addressed by native identifier, never by position alone, and
every write needs two tokens: the note `revision` as `ifRevision` and the
table `digest` as `ifTableDigest`.

Each apply verifies through a fresh Core Data stack that the body text is
unchanged and the table equals the planned result. A stale token fails with
`revision_conflict` (the envelope code for both the note and the table
token; `helperCode` says which) and `committed: false`. Applies take the
same optional `nudge`; its `uploadRecorded` covers the note record, not the
table attachment's own record. Dry runs and `native-read-tables` are not
gated by `APPLE_NOTES_MCP_ALLOW_UNVERIFIED`; applies are.

#### `native-read-tables`

Read-only. Returns every active table in a note with its `identifier`,
`glyphCount`, `orphan` flag, `digest`, `columnIdentifiers`, and `rows`
(`{identifier, cells}`), plus the note `revision`.

#### `native-delete-table-row`

Two phases. `dryRun: true` opens the store read-only and returns the row, its
cells, and both tokens; `dryRun: false` with those tokens deletes it. A
table's only row cannot be deleted.

#### `native-insert-table-row`

Adds a row after `afterRowIdentifier` (or at the end) with optional
plain-text `cells`, and returns the new `rowIdentifier`.

#### `native-set-table-cell`

Replaces one cell's text and returns `previousText`.

#### `native-prune-orphan-table`

Two phases, like the row delete. Tombstones a table attachment that no body
glyph shows (`orphan: true`), the same way Notes deletes an attachment. It
refuses a visible table, and a note whose body has an attachment glyph it
cannot identify, since that glyph could be the table's
(`unsupported_attachment`, `unidentifiedGlyphs`). Before saving it refuses
any change beyond the note and the table (`unexpected_changes`), and the
read-back requires the table row to exist and be marked deleted.

#### Smart folders

Four tools create, edit, and delete smart folders. Find a smart folder and
its rules with the read-only `list-smart-folders` first; it returns each
folder's `identifier` and stored query (`rawQuery`).

Each query goes through Notes' own query parser, and the writer stores the
form Notes regenerates from it. A query Notes cannot store without changing
its meaning is refused (`query_not_representable`); a tag must exist exactly
once in the destination account (`tag_not_found`), and a folder filter must
name an ordinary folder there. Like the smart-folder destination guard, a
smart folder is never a parent: the create refuses one with `code:
"unsupported"`, `committed: false`, and `reason: "smart_folder_destination"`.
Every write is verified through a fresh Core Data stack. The sync nudge is
not offered, because it moves notes and a folder has no equivalent; check
`cloudSync` with `native-read-smart-folder` after Notes.app saves. After a
committed write, the result reports `adoptedByNotesApp`: whether a running
Notes.app shows the change (the folder, with its title, or after a delete its
absence), polled for `adoptionWaitSeconds` (0 to 60, default 10). Notes.app is
never launched for this; when it is not running, `adoptedByNotesApp` is
`null`. Writes
need `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1`; the read and the delete's dry run
do not.

#### `native-read-smart-folder`

Read-only. One smart folder's state by `identifier`, with its canonical
`queryJSON`, decoded rules, child and note counts, `cloudSync`, and a folder
`revision` (`f1:…`).

#### `native-create-smart-folder`

`title` plus `query` (an object or a JSON string), at the root of `account`
(default: Notes' default account) or inside the ordinary folder
`parentIdentifier`. Calling it again with the same title, destination, and
query returns `status: "ok"` and writes nothing; a different folder with that
title is refused (`folder_exists`).

#### `native-update-smart-folder`

Replaces one smart folder's query, guarded by its `revision` as `ifRevision`.
It changes only the query. A folder that has no title or parent timestamp
keeps it missing, and the result lists it in `timestampsMissing` rather than
stamping one.

#### `native-delete-smart-folder`

Two phases. `dryRun: true` returns the folder and its `revision`;
`dryRun: false` with that revision marks it deleted, the way Notes deletes a
folder. Only empty smart folders.

#### `native-add-paper`

Adds one drawing to the end of a note as editable ink: a Paper drawing
(`com.apple.paper`), or a classic drawing (`com.apple.drawing.2`) with
`format: "drawing"` or when this macOS cannot create Paper. Pass exactly one
source:

- `drawing`: `strokes` (each with `points` as `[x, y]` or `[x, y, width]`,
  plus optional `ink`, `color` as sRGB `[r, g, b, a]` from 0 to 1, and
  `width`) and `shapes` (`rectangle`, `ellipse`, `line`, `arrow`, `polygon`,
  `star`, `chatBubble`, `polyline`). Shapes are written as strokes that trace
  them (`shapePersistence: "stroke-fallback"`), not as Notes shape objects.
- `svgPath`: an SVG file, converted by the same analyzer as `analyze-svg` and
  analyzed again at write time. A `safe` SVG needs nothing more. A `lossy` one
  needs `ifSvgAnalysis` equal to its `analysisDigest` and `allowSvgLosses`
  equal to its `requiredLosses`, no more and no less.

Inks are `pen` (default), `pencil`, `marker`, `fountainpen`, `watercolor`, and
`crayon`; the writer refuses an ink that PencilKit would store as a different
one. Guarded by `ifRevision` like every write; `dryRun: true` validates and
reports the plan (format, stroke and point counts, bounds) without writing and
without `APPLE_NOTES_MCP_ALLOW_UNVERIFIED`. A write is verified by decoding
the saved drawing in a fresh Core Data stack (`decodedStrokeCount`,
`decodedPointCount`) and returns `attachmentIdentifier` and the usual sync
fields; `nudge` works as for `native-append-plain-text`. The writer embeds a
bundle identifier because PencilKit needs one to build a drawing, so the
first Paper write creates
`~/Library/Preferences/io.github.apple-notes-mcp.private-writer.plist`.

#### `native-repair-purge-flag`

Finds and repairs a note that carries Notes' permanent-deletion flag
(`markedForDeletion`) while it is still in an ordinary folder. Notes deletes a
note by moving it to Recently Deleted and sets that flag only when the note
leaves Recently Deleted for good. A note flagged outside Recently Deleted is in
neither state: Notes hides it and will purge it, but the user cannot recover
it. The known cause is a tool that set the flag instead of moving the note.

- No `identifier` (dry run): scans the store and returns up to 50 candidates.
- `identifier` with `dryRun` (the default): returns the note's `state`
  (`active`, `in_recently_deleted`, `purging_from_recently_deleted`,
  `purge_flag_outside_recently_deleted`, `purge_flag_without_folder`,
  `folderless`), `repairable`, `blockers` (`locked`, `shared`, `downloading`,
  `attachments_marked_for_deletion`, `no_recently_deleted_folder`, …), and the
  note's `revision`.
- `dryRun: false` with that `revision` as `ifRevision` and `confirm: true`
  clears the flag and moves the note to its account's Recently Deleted
  folder, as an ordinary delete would, and stamps the folder time, which
  starts Notes' 30-day clock. It never purges anything. A fresh read-back
  checks the flag, the folder, the timestamp, and an unchanged body.

Risk: a flag Notes set on purpose, for example a permanent delete on another
device that has not finished syncing, looks the same on this Mac. Repairing
that note brings it back into Recently Deleted, and the move syncs to every
device. Only repair a note the user recognizes as wrongly lost. The move then
needs Notes.app to upload it; the in-place nudge skips trashed notes, so use
`native-sync-push` with `method: "relaunch"` if it should upload now. The
apply needs `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until live-validated.

#### `native-read-paper`

Read-only. Decodes one Paper drawing (`com.apple.paper`) in a note, in three
layers that each report whether they ran:

- `strokes`: every pen stroke with its `ink`, sRGB `color`, `width`,
  `transform`, `renderBounds`, and `points` as compact arrays in `pointFields`
  order (x, y, width, height, opacity, force, azimuth, altitude, timeOffset).
  `maxPoints` (default 20000, at most 40000) caps the points returned;
  `includePoints: false` leaves them out.
- `shapes` (macOS 27 or later): the drawing's typed shapes as Notes stores
  them, not traced strokes: `kind` (`rectangle`, `roundedRectangle`,
  `ellipse`, `line`, `arrowShape`, `star`, `regularPolygon`, `chatBubble`),
  `frame` and `rotation` (radians about the frame's center), `lineWidth`,
  `opacity`, `fillColor`, `strokeColor`, `startLineMarker` and `endLineMarker`
  (`none` or `arrow`), `path` as SVG path data in drawing coordinates with the
  frame and rotation applied, and `text` for a text box (a rectangle with
  text). `shapeDecode` gives `available`, a `reason` when it did not run
  (`requires_macos_27`, `private_api_unavailable` with `missing`, or
  `not_requested` with `includeShapes: false`), and `elementKinds`, the count
  of every PaperKit element by kind.
- `fallbackGeometry`: the painted paths of the fallback PDF Notes keeps for
  older devices, when the drawing has one (`reason: "no_fallback_pdf"`
  otherwise). Each path has `paint` (`stroke`, `fill`, or `fillStroke`),
  `kind` (`rectangle` or `path`), `d` as SVG path data in PDF page space
  (points, origin at the bottom left), `fillRule`, colors, and `lineWidth`.
  Text, images, and shadings are counted in `skipped`, not decoded.

Pass `attachmentIdentifier` when the note has more than one Paper drawing
(`ambiguous_attachment` lists them). The writer opens the store read-only and
decodes a private copy of the drawing's bundle, never the live one. The typed
shapes come from PaperKit through two internal entry points, so they are
checked at run time and offered only on macOS 27; the other layers use
NotesShared's drawing reader and the stored PDF. Like every writer tool it
needs both writer switches, but it writes nothing and needs no
`APPLE_NOTES_MCP_ALLOW_UNVERIFIED`.

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
| `APPLE_NOTES_MCP_MAX_BUFFER` | `67108864` (64 MB) | Max bytes captured from a single AppleScript invocation. Raise it if a very large export/list is truncated; lower it to cap memory. Reading one note body allows at least 512 MB regardless, since a body embeds its inline images. Output past the cap fails with an error naming this variable, not as a timeout. |
| `APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES` | `26214400` (25 MB) | Max size of an attachment that [`fetch-attachment`](#fetch-attachment) will base64-encode inline. Larger attachments are rejected with an error pointing at [`save-attachment`](#save-attachment) (which streams to disk and has no such limit). Raise it to fetch bigger attachments inline; lower it to cap memory. |
| `APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES` | `262144` (256 KB) | Per-image cap on the base64 payload kept inline in a [`get-note-content`](#get-note-content) response. Inline images over the cap are replaced with placeholders (with a warning appended) so an image-heavy note cannot exceed the MCP client's message limit and drop the connection; export the real files with [`save-attachment`](#save-attachment) or [`fetch-attachment`](#fetch-attachment). Raise it to keep bigger images inline. |
| `APPLE_NOTES_MCP_CONFIG_FILE` | `~/Library/Application Support/apple-notes-mcp/config.json` | Path to the JSON config file (see below). |
| `APPLE_NOTES_MCP_TIMEOUT_MS` | `30000` (30 s) | Total AppleScript operation timeout, including retry attempts and delays. Raise it if full-library operations (large searches, exports) time out on a big Notes library. Per-call `timeoutMs` options still win, and a write tool's `timeoutSeconds` argument overrides it for that call. |
| `APPLE_NOTES_MCP_TEMPLATE_DIR` | `~/Library/Application Support/apple-notes-mcp/templates` | Absolute directory of the saved Markdown template library (`save-markdown-template` and friends). |
| `APPLE_NOTES_MCP_ANCHOR_FILE` | `~/Library/Application Support/apple-notes-mcp/paragraph-anchors.json` | Absolute path of the [paragraph anchor](#paragraph-anchors) registry. |
| `APPLE_NOTES_MCP_ANCHORS_TOKEN` | unset | Token for `apple-notes-mcp anchors serve` (at least 32 characters). Unset, the resolver makes a new random token each run. |
| `APPLE_NOTES_MCP_EXPORT_MAX_BYTES` | `8388608` (8 MB) | Largest response `export-notes-json` sends; a page closes early to stay under it. `export-notes-markdown` returns inline Markdown up to half of it. The default sits below the 10 MB per-message limit of MCP SDK stdio clients, which drop the connection on anything larger. Raise it only if your MCP client accepts bigger messages. |
| `APPLE_NOTES_MCP_BLOCKS_MAX_BYTES` | `4194304` (4 MB) | Largest block payload one [`get-note-blocks`](#get-note-blocks) page returns; the page closes early to stay under it, and a single oversized paragraph comes back with `textOmitted: true`. [`get-note-structure`](#get-note-structure) also omits note text larger than this. A [`list-note-paragraphs`](#list-note-paragraphs) or [`list-note-links`](#list-note-links) page also stops early to stay under it. |
| `APPLE_NOTES_MCP_MAX_RETRIES` | `2` | Maximum attempts for a read-only AppleScript call that fails with a **transient** error (Notes.app busy / not responding / lost connection). `2` means one retry; set `1` to fail fast with no retries. Retries share the single `APPLE_NOTES_MCP_TIMEOUT_MS` budget rather than each getting a fresh one, and a retry is skipped when under a second of that budget remains — so this is a ceiling, not a guarantee. In particular a call that exhausts the budget with a **timeout** has no time left to retry by construction. Mutating operations run once because a timeout can occur after Notes.app applied the change. Non-transient errors (e.g. "note not found") never retry. |
| `APPLE_NOTES_MCP_RETRY_DELAY_MS` | `1000` (1 s) | Base delay before the first retry; subsequent retries back off exponentially (1s, 2s, 4s, ...). |
| `APPLE_NOTES_MCP_ENABLE_PRIVATE` | unset | Set to `1` to allow the opt-in [private helper](#private-helper-opt-in-unsupported-apple-api). Any other value keeps it off. |
| `APPLE_NOTES_MCP_PRIVATE_HELPER_DIR` | `~/Library/Application Support/apple-notes-mcp/private-helper` | Where `setup --native-helper` installs the helper and its checksum manifest. |
| `APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS` | `20000` (20 s) | Per-call timeout for the private helper. The helper is read-only, so a timeout changes nothing in Notes. |
| `APPLE_NOTES_MCP_PRIVATE_STORE` | unset | Testing only: points the helper at a **copy** of `NoteStore.sqlite`. The helper refuses a path that resolves to the live store. |
| `APPLE_NOTES_MCP_PUBLIC_HELPER_DIR` | `~/Library/Application Support/apple-notes-mcp/public-helper` | Where `setup --public-helper` installs the [public native helper](#public-native-helper) and its checksum manifest. |
| `APPLE_NOTES_MCP_PUBLIC_HELPER_TIMEOUT_MS` | `30000` (30 s) | Per-call timeout for the public native helper (`get-note-drawings`, `transcribe-note-audio`). |
| `APPLE_NOTES_MCP_TAGS_SHORTCUT` | `Apple Notes MCP - Native Tags` | Name or UUID of the installed Native Tags bridge to run. `setup` still installs and checks the default name. |
| `APPLE_NOTES_MCP_BACKGROUND_SHORTCUT` | `Apple Notes MCP - Background Operations v5` | Name or UUID of the installed Background Operations bridge to run. `setup` still installs and checks the default name. |
| `APPLE_NOTES_MCP_MARKDOWN_SHORTCUT` | `Apple Notes MCP - Create Markdown Note` | Name or UUID of the installed Create Markdown Note bridge to run. `setup` still installs and checks the default name. |
| `APPLE_NOTES_MCP_PASTEBOARD_NAME` | unset | Testing only: makes [`add-attachment-from-pasteboard`](#add-attachment-from-pasteboard) read a private named pasteboard instead of the general clipboard. |
| `APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS` | unset | Set to `1` to let `create-note` read a [`contentPath`](#create-note), [`add-attachment`](#add-attachment) and [`create-note-with-attachment`](#create-note-with-attachment) attach a `path`, [`analyze-svg`](#analyze-svg) read a `path`, and the Markdown template tools read a `templateFile`, inside a hidden directory or file (such as `~/.config`) or `~/Library` outside iCloud Drive and `~/Library/CloudStorage`. Off by default because those places hold keys, tokens and app data. |
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

Several tools read directly from the Apple Notes SQLite database, which lives in a macOS-protected directory. Those tools require **Full Disk Access** for the process running the MCP server: `query-notes`, `get-native-objects`, `get-note-tables`, `list-smart-folders`, `delete-folder-by-id`, `get-note-drawings`, `transcribe-note-audio`, `native-note-state`, `get-checklist-state`, `get-note-metadata`, `get-note-blocks`, `list-note-paragraphs`, `get-paragraph-link`, `get-note-structure`, `list-note-links`, `export-notes-markdown`, `export-notes-html`, `get-audio-transcripts`, `list-special-notes`, `list-native-tags`, `list-recent-notes`, `list-folder-tree`, `get-note-link`, the checklist annotations in `get-note-markdown`, `list-attachments` with `includePaths` or `firstImage`, `export-attachments`, `list-paper-attachments`, `export-paper-image`, and the database half of `get-sync-status`.

> 📘 **For the full why-and-how walkthrough (which app to grant, verifying with `doctor`, graceful degradation), see the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md).** The summary below is the quick version.

### How to Grant Full Disk Access

1. Open **System Settings** (or System Preferences on older macOS)
2. Go to **Privacy & Security > Full Disk Access**
3. Click the **+** button
4. Add the entry that matches how the server runs:
   - **Claude Desktop**: add the **Node binary** that runs the server (the `doctor` tool prints its path, e.g. `~/.nvm/versions/node/v24.11.1/bin/node`; press ⌘⇧G in the file picker to paste it). Claude Desktop launches MCP servers as their own responsible process, so a grant on `/Applications/Claude.app` alone does not reach them ([#220](https://github.com/sweetrb/apple-notes-mcp/issues/220)).
   - **Terminal**: Add `/Applications/Utilities/Terminal.app`
   - **VS Code**: Add `/Applications/Visual Studio Code.app`
   - **iTerm**: Add `/Applications/iTerm.app`
5. Fully quit (⌘Q) and relaunch the host app after granting access; if `doctor` still reports it missing, restart the Mac

### Without Full Disk Access

Every tool that does not read the Notes database works normally without Full Disk Access — that is the whole AppleScript surface (create, read, search, update, move, delete, folders, accounts, attachments, stats, export). The database-backed tools degrade like this:
- `get-checklist-state` returns an error explaining that database access is needed
- `query-notes` returns the same kind of error; use `search-notes` instead
- `delete-folder-by-id` refuses to delete anything (it fails closed)
- `get-note-metadata` returns the same kind of error — it has no non-database path
- `list-special-notes` and the `list-native-tags` inventory return the same kind of error
- `list-recent-notes` and `list-folder-tree` return the same kind of error
- `get-note-link` returns an error on macOS 26+; on macOS 12–15 it still works via the AppleScript `note link` fallback
- `get-note-markdown` returns plain list items without `[x]`/`[ ]` annotations (graceful fallback)
- `get-sync-status` still answers, but reports no pending uploads and no active sync — treat that as "unknown", not "idle"
- `get-note-drawings` and `transcribe-note-audio` return the same Full Disk Access error

---

## Permissions check

`apple-notes-mcp setup --permissions` checks, in one report, the four grants that decide what the server can do on this Mac:

| Item | How it is checked | Needed for |
|------|-------------------|------------|
| Full Disk Access | one read-only `SELECT 1` against `NoteStore.sqlite` | every database-backed tool (see [Full Disk Access](#full-disk-access)) |
| Automation of Notes.app | one read-only Apple event (the first account's name) | every AppleScript tool |
| Shortcut bridges (optional) | `shortcuts list`, like `setup --check` | the native-write tools |
| Speech Recognition (optional) | the public helper's `speech_status`, read without prompting | `transcribe-note-audio` before macOS 26 |

```bash
apple-notes-mcp setup --permissions          # report, then press Enter to check again
apple-notes-mcp setup --permissions --open   # also open the System Settings pane of each missing grant
apple-notes-mcp setup --permissions --once   # report once and exit (also --json)
```

For each missing grant the report names the System Settings pane and its URL, for example `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` (the `com.apple.preference.security` form before macOS 13). Panes open only with `--open`, each once per run. The command never changes a setting or a grant: you make the change in System Settings, then press Enter to check again. Type `q` to stop. It exits 0 when Full Disk Access and Automation are both granted, 1 otherwise. The first check may make macOS ask whether the app may control Notes; choose **Allow**, since that prompt is the only way to add an Automation grant.

macOS attributes these grants to the app that launched the process, so the report names it (for example `/Applications/iTerm.app`). Run the check from the app you use as the MCP host when you can. Claude Desktop launches servers as their own responsible process, so for it use the `doctor` tool inside Claude Desktop, and add the Node binary it names to Full Disk Access. The Speech item reads `unknown` until the [public native helper](#public-native-helper) is built.

### Optional checklist window

The same checklist is also available in a small window with **Open Settings** and **Re-check** buttons. Like the public helper, it is built on your Mac from the packaged Swift source, never shipped as a binary:

```bash
apple-notes-mcp setup --permissions-window           # compile, ad-hoc sign, verify, install
apple-notes-mcp setup --permissions-window --check   # report the installed state only
apple-notes-mcp setup --permissions --window         # open the window
```

Setup compiles `native/permissions-window/apple-notes-permissions-window.swift`, signs it ad hoc, runs its `hello` handshake (which shows no window), and installs it in `~/Library/Application Support/apple-notes-mcp/permissions-window/` with a manifest of source and binary SHA-256 digests; `APPLE_NOTES_MCP_PERMISSIONS_WINDOW_DIR` overrides the folder. The window probes nothing itself. The command runs every check and sends the results to it, and opens a pane only for an item it reported. If the window is not built, is stale after an upgrade, or was modified, `--window` says so and shows the checklist in the terminal instead. The server never uses the window.

---

## Public native helper

`get-note-drawings` needs Apple's PencilKit framework and `transcribe-note-audio` needs the Speech framework; neither has an AppleScript or command-line interface. For them, the server uses a small Swift helper that links public Apple frameworks only (AppKit, PencilKit, AVFoundation, and Speech). No prebuilt binary ships with the package. Build it once on your Mac:

```bash
apple-notes-mcp setup --public-helper          # compile, sign, verify, install
apple-notes-mcp setup --public-helper --check  # report the installed state only
```

Setup compiles `native/public-helper/apple-notes-public-helper.swift` with `xcrun swiftc` (install the Command Line Tools with `xcode-select --install` if it is missing), signs it ad hoc, runs its `hello` handshake, and installs it in `~/Library/Application Support/apple-notes-mcp/public-helper/` next to a manifest recording the SHA-256 of the source and the binary. Before every use the server re-checks both digests: after an upgrade that changes the helper source, or if the binary is replaced, the helper is refused until you run setup again. `APPLE_NOTES_MCP_PUBLIC_HELPER_DIR` overrides the install folder and `APPLE_NOTES_MCP_PUBLIC_HELPER_TIMEOUT_MS` the per-call timeout.

The helper never opens the Notes database and never writes under the Notes group container. The server reads the bytes it needs (read-only) and passes them to the helper on stdin, or, for transcription, names one audio file that the helper opens for reading; the helper answers with one JSON object on stdout.

---

## Paragraph anchor resolver (opt-in)

An `applenotes://` paragraph link only opens on an Apple device, and it breaks
when the paragraph's ID changes. For links shared outside Notes, you can run a
small local resolver that looks up a [paragraph anchor](#paragraph-anchors)
when the link is opened and redirects to the paragraph's current link:

```bash
apple-notes-mcp anchors serve                 # http://127.0.0.1:<random port>
apple-notes-mcp anchors serve --port 8765     # a fixed port
apple-notes-mcp anchors serve --tailnet       # this Mac's Tailscale address instead
```

It serves one route, `GET /a/<anchor-id>?token=<token>`. A `resolved` anchor
answers with a 302 redirect to the `applenotes://` link. Any other status gets
a short plain-text answer and no redirect: 409 for `ambiguous`,
`low-confidence`, `needs-reminting` and `note-unreadable`, and 404 for a gone
paragraph or note.

- **Off by default.** Only this command starts it; the MCP server never does.
  It runs in the foreground until you press Ctrl-C.
- **Loopback by default.** It binds `127.0.0.1`. `--tailnet` binds the first
  `100.64.0.0/10` address on this Mac (a Tailscale address) instead, and fails
  if there is none. It never runs `tailscale` and never changes Tailscale,
  firewall or system settings.
- **Token required.** Every request needs the token, as `?token=` or
  `Authorization: Bearer`. It is `APPLE_NOTES_MCP_ANCHORS_TOKEN` when set (at
  least 32 characters; use this for links that must survive a restart), or a
  random token printed once at startup. Tokens are compared in constant time
  and never logged; request logs on stderr omit the query string. After 20
  failed token checks in a minute, requests get 429 until the minute passes.
- **Host check.** The `Host` header must name the bound address, which blocks
  DNS rebinding. Only `GET` and `HEAD` are served, with `Cache-Control:
  no-store` and `Referrer-Policy: no-referrer`.
- It needs Full Disk Access for the terminal or process that runs it, and it
  reads the same registry as the anchor tools.

---

## Security and Privacy

- **Local only** - All operations happen locally, through AppleScript, the packaged Shortcuts, read-only reads of the Notes database, and helpers you build on your own Mac. The server makes no network requests, and `transcribe-note-audio` uses on-device speech recognition only. Whatever your MCP client does with the results is governed by that client.
- **Permission required** - macOS will prompt for automation permission on first use.
- **Password-protected notes** - Notes with passwords cannot be read or modified via this server.
- **No credential storage** - The server doesn't store any passwords or authentication tokens.

---

## Known Limitations

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Notes and AppleScript are macOS-specific |
| Batch ops run per-note | `batch-delete-notes` / `batch-move-notes` apply each note individually rather than as one bulk operation — AppleScript has no bulk equivalent to IMAP's `UID STORE`/`MOVE`. This is deliberate: it preserves per-note success/failure reporting. ([#26](https://github.com/sweetrb/apple-notes-mcp/issues/26)) |
| Pinning needs a Shortcut | AppleScript exposes no `pinned` property. Pin state is readable via the BETA `get-note-metadata` tool (NoteStore database, needs Full Disk Access), and [`set-note-pinned`](#set-note-pinned) sets it through the Background Operations Shortcut rather than AppleScript ([#28](https://github.com/sweetrb/apple-notes-mcp/issues/28)) |
| Limited rich formatting | Use `format: "html"` on create/update for headings, lists, bold, code blocks; some complex formatting may not render |
| Exact IDs for writes | Writes take an exact note ID and a fresh `contentHash`, because Notes titles are not unique. Read tools that accept a `title` need an exact, case-sensitive match |
| Checklist state | Requires [Full Disk Access](https://github.com/sweetrb/apple-notes-mcp/blob/main/docs/FULL-DISK-ACCESS.md) to read done/undone state from the database |
| Checklist **creation** | Not possible through AppleScript: its `body of note` setter strips `<input type="checkbox">` and ignores any checklist-styling CSS class, because Notes stores checklist items as a protobuf paragraph style (`style_type=103`). The server creates real checklist items through Shortcuts instead; see [Creating Checklists](#creating-checklists). Checking or unchecking an existing item is not supported. |

### Creating Checklists

**There is no programmatic way to create a true Apple Notes checklist via AppleScript.** This is an Apple limitation, not a bug. Plaintext and HTML writes therefore cannot produce checklists, so this server creates them through Apple Shortcuts instead (workaround 2 below).

When a note is created or updated via AppleScript:

| You send | What Notes.app actually renders |
|----------|--------------------------------|
| `<input type="checkbox"> Item` | `Item` (the `<input>` tag is stripped) |
| `<ul class="checklist"><li>Item</li></ul>` | A plain bulleted list — the `checklist` class is dropped |
| Markdown `- [ ] Item` (in `plaintext` mode) | The literal text `- [ ] Item` |

Apple Notes stores checklists as a paragraph style (`style_type=103`) inside a gzipped protobuf blob in the `NoteStore.sqlite` database. AppleScript's note `body` interface does not expose paragraph styles, and writing directly to the live database is unsafe.

**Workarounds:**

1. **Create the note with bulleted list items, then convert manually in Notes.app.** Select the items and press <kbd>⇧⌘L</kbd> (or **Format → Checklist**). This converts the list in place and the resulting checklist will be readable by `get-checklist-state` and annotated by `get-note-markdown`.
2. **Use the Apple Shortcuts app** to script the checklist creation, since Shortcuts can manipulate Notes content at a higher level than AppleScript. This server does that for you in two ways: [`create-checklist-item`](#create-checklist-item) and [`create-checklist-items`](#create-checklist-items) append unchecked items to an existing note, and [`create-note`](#create-note) with `format: "markdown"` turns `- [ ]` / `- [x]` lines into checklist items with that done state through Notes' own Markdown importer (see [Markdown notes](#markdown-notes)).
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
- `apple-notes-mcp setup --permissions --open` checks every grant and opens the pane of each missing one ([Permissions check](#permissions-check))

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

### Contributors

- **Oliver Ames** ([@oliverames](https://github.com/oliverames)) — the project's most prolific
  contributor, with dozens of merged pull requests spanning features, fixes, documentation, and
  sharp, well-reproduced bug reports.

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
