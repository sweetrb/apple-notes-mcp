# Apple Notes MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, create, search, and manage notes in Apple Notes on macOS.

[![npm version](https://img.shields.io/npm/v/apple-notes-mcp)](https://www.npmjs.com/package/apple-notes-mcp)
[![CI](https://github.com/sweetrb/apple-notes-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-notes-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-notes-mcp
/plugin install apple-notes
```

This method also installs a **skill** that teaches Claude when and how to use Apple Notes effectively.

### Using the Codex Marketplace

The same plugin is available for Codex. Add the marketplace and install the plugin:

```bash
codex plugin marketplace add sweetrb/apple-notes-mcp
codex plugin add apple-notes@apple-notes-mcp
```

The Codex plugin runs the published `apple-notes-mcp` server through `npx` and ships the same Apple Notes skill, so behavior matches the Claude Code plugin.

### Manual Installation

**1. Install the server:**
```bash
npm install -g github:sweetrb/apple-notes-mcp
```

**2. Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["apple-notes-mcp"]
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
| **Read Notes** | Retrieve note content and metadata |
| **Update Notes** | Modify existing notes (title and/or content) |
| **Delete Notes** | Remove notes (moves to Recently Deleted) |
| **Move Notes** | Organize notes into folders (supports nested paths) |
| **Folder Management** | Create, list, and delete folders with full hierarchical path support |
| **Multi-Account** | Work with iCloud, Gmail, Exchange, or any configured account |
| **Batch Operations** | Delete or move multiple notes at once |
| **Checklist State** | Read checklist done/undone state directly from the Notes database (requires Full Disk Access) |
| **Export** | Export all notes as JSON or get individual notes as Markdown |
| **Attachments** | List attachments, save them to disk, or fetch their bytes as base64 |
| **Sync Awareness** | Detect iCloud sync in progress, warn about incomplete results |
| **Collaboration** | Detect shared notes, warn before modifying |
| **Diagnostics** | `health-check` plus a richer `doctor` (reachability, automation permission, accounts, Full Disk Access), sync status, and statistics |

Read/list/get tools also return **structured JSON** (`structuredContent`) alongside the text, so agents can consume results without parsing prose.

### MCP resources & prompts

Resources expose read-only context the client can attach without a tool call:
`notes://accounts`, `notes://folders`, `notes://stats`, and the
`notes://note/{id}` template (returns the note as Markdown). Prompts package
common workflows: `find-note`, `weekly-review`, `new-meeting-note`.

### Known limitations

A few Notes UI features are not exposed to AppleScript and therefore cannot be
supported. See **[docs/APPLESCRIPT-LIMITATIONS.md](docs/APPLESCRIPT-LIMITATIONS.md)**
for the investigation and verification behind each:

- **Pinned notes** — Notes has no scriptable `pinned` property, so pin state can be neither read nor set.
- **Note-to-note links** — there is no `applenotes://` deep link or link property; the only stable handle is the `x-coredata://` note id.

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Note Operations

#### `create-note`

Creates a new note in Apple Notes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | The title of the note. Automatically prepended as `<h1>` — do NOT include the title in `content` |
| `content` | string | Yes | The body content of the note (do not repeat the title here) |
| `tags` | string[] | No | Tags for organization (stored in metadata) |
| `folder` | string | No | Folder to create the note in. Supports nested paths like `"Work/Clients"`. Defaults to account root |
| `account` | string | No | Account name (defaults to iCloud) |
| `format` | string | No | Content format: `"plaintext"` (default) or `"html"`. In both formats, the title is automatically prepended as `<h1>`. In plaintext mode, newlines become `<br>`, tabs become `<br>`, and backslashes are preserved as HTML entities |

**Example:**
```json
{
  "title": "Meeting Notes",
  "content": "Discussed Q4 roadmap and budget allocation",
  "tags": ["work", "meetings"]
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

**Returns:** Confirmation message with note title and ID. Save the ID for subsequent operations like `update-note`, `delete-note`, etc.

---

#### `search-notes`

Searches for notes by title or content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Text to search for |
| `searchContent` | boolean | No | If `true`, searches note body; if `false` (default), searches titles only |
| `account` | string | No | Account to search in (defaults to iCloud) |
| `folder` | string | No | Limit search to a specific folder (supports nested paths like `"Work/Clients"`) |
| `modifiedSince` | string | No | ISO 8601 date string to filter notes modified on or after this date (e.g., `"2025-01-01"`) |
| `limit` | number | No | Maximum number of results to return |

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

**Returns:** List of matching notes with titles, folder names, and IDs. Use the returned ID for subsequent operations like `get-note-content`, `update-note`, etc.

---

#### `get-note-content`

Retrieves the full content of a specific note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Note title (use `id` instead when available) |
| `account` | string | No | Account containing the note (defaults to iCloud, ignored if `id` is provided) |

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

**Returns:** The HTML content of the note, or error if not found. The
`structuredContent` also includes `hashtags` — any inline `#hashtag` tags parsed
from the body. Apple Notes tags are inline hashtags, not a scriptable property;
see [docs/APPLESCRIPT-LIMITATIONS.md](../docs/APPLESCRIPT-LIMITATIONS.md#tags--hashtags-29). Smart Folders are not scriptable.

---

#### `get-note-details`

Retrieves metadata about a note (without full content).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact title of the note |
| `account` | string | No | Account containing the note (defaults to iCloud) |

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
| `id` | string | Yes | The CoreData URL identifier (e.g., `x-coredata://...`) |

**Returns:** JSON with note metadata, or error if not found.

---

#### `update-note`

Updates an existing note's content and/or title.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Current title of the note to update (use `id` instead when available) |
| `newTitle` | string | No | New title (if changing the title; ignored when `format` is `"html"`) |
| `newContent` | string | Yes | New content for the note body |
| `account` | string | No | Account containing the note (defaults to iCloud, ignored if `id` is provided) |
| `format` | string | No | Content format: `"plaintext"` (default) or `"html"`. When `"html"`, content replaces the entire note body as raw HTML and `newTitle` is ignored (the first HTML element serves as the title) |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "newContent": "Updated content here"
}
```

**Example - Update content only:**
```json
{
  "title": "Shopping List",
  "newContent": "- Milk\n- Eggs\n- Bread\n- Butter"
}
```

**Example - Update title and content:**
```json
{
  "title": "Draft",
  "newTitle": "Final Version",
  "newContent": "This is the completed document."
}
```

**Example - Update with HTML formatting:**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "newContent": "<p>New findings with <b>bold</b> emphasis.</p><pre><code>console.log('hello');</code></pre>",
  "format": "html"
}
```

**Returns:** Confirmation message, or error if note not found.

**Note:** `newContent` **replaces the entire note body** — it is not appended. To preserve existing content, read it first (e.g. with `get-note-content`) and include it in `newContent`.

---

#### `delete-note`

Deletes a note (moves to Recently Deleted in Notes.app).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Exact title of the note to delete (use `id` instead when available) |
| `account` | string | No | Account containing the note (defaults to iCloud, ignored if `id` is provided) |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456"
}
```

**Example - Using title:**
```json
{
  "title": "Old Draft"
}
```

**Returns:** Confirmation message, or error if note not found.

**⚠️ Safety:** Irreversible from the agent's side — requires explicit user confirmation before calling. Prefer `search-notes` / `list-notes` first to confirm the exact id(s) being deleted.

---

#### `move-note`

Moves a note to a different folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred - more reliable than title) |
| `title` | string | No | Title of the note to move (use `id` instead when available) |
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`) |
| `account` | string | No | Account containing the note (defaults to iCloud, ignored if `id` is provided) |

**Note:** Either `id` or `title` must be provided. Using `id` is recommended.

**Example - Using ID (recommended):**
```json
{
  "id": "x-coredata://ABC123/ICNote/p456",
  "folder": "Archive"
}
```

**Example - Using title:**
```json
{
  "title": "Completed Task",
  "folder": "Archive"
}
```

**Returns:** Confirmation message, or error if note or folder not found.

**Note:** This operation copies the note to the new folder then deletes the original. If the delete fails, the note will exist in both locations.

---

#### `list-notes`

Lists all notes, optionally filtered by folder, date, and limit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list notes from (defaults to iCloud) |
| `folder` | string | No | Filter to notes in this folder only (supports nested paths like `"Work/Clients"`) |
| `modifiedSince` | string | No | ISO 8601 date string to filter notes modified on or after this date (e.g., `"2025-01-01"`) |
| `limit` | number | No | Maximum number of notes to return |

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

**Returns:** List of note titles.

---

### Folder Operations

#### `list-folders`

Lists all folders in an account with full hierarchical paths.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list folders from (defaults to iCloud) |

**Example:**
```json
{}
```

**Returns:** List of folder paths. Nested folders are shown as full paths (e.g., `Work/Clients/Omnia`). Duplicate folder names are disambiguated by their full path. Literal slashes in folder names are escaped as `\/` (e.g., `Spain\/Portugal 2023`).

---

#### `create-folder`

Creates a new folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name for the new folder |
| `account` | string | No | Account to create folder in (defaults to iCloud) |

**Example:**
```json
{
  "name": "Work Projects"
}
```

**Returns:** Confirmation message, or error if folder already exists.

---

#### `delete-folder`

Deletes a folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name or path of the folder to delete (supports nested paths like `"Work/Old"`) |
| `account` | string | No | Account containing the folder (defaults to iCloud) |

**Example:**
```json
{
  "name": "Old Projects"
}
```

**Returns:** Confirmation message, or error if folder not found or not empty.

**⚠️ Safety:** Irreversible — requires explicit user confirmation before calling. Prefer `list-folders` first to confirm the exact folder path being deleted.

---

### Account Operations

#### `list-accounts`

Lists all configured Notes accounts.

**Parameters:** None

**Example:**
```json
{}
```

**Returns:** List of account names (e.g., "iCloud", "Gmail", "Exchange").

---

### Batch Operations

#### `batch-delete-notes`

Deletes multiple notes at once by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Array of note IDs to delete |

**Returns:** Summary of successes and failures.

**⚠️ Safety:** Irreversible — requires explicit user confirmation before calling. Prefer `search-notes` / `list-notes` first to confirm the exact ids being deleted.

---

#### `batch-move-notes`

Moves multiple notes to a folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Array of note IDs to move |
| `folder` | string | Yes | Destination folder name or nested path (e.g., `"Work/Clients"`) |
| `account` | string | No | Account containing the folder |

**Returns:** Summary of successes and failures.

---

### Export Operations

#### `export-notes-json`

Exports all notes as a JSON structure.

**Parameters:** None

**Returns:** Complete JSON export with all accounts, folders, and notes including metadata.

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

#### `get-checklist-state`

Reads checklist done/undone state for a note. This bypasses the AppleScript limitation where `body of note` strips checklist state, by reading directly from the NoteStore SQLite database.

**Requires:** Full Disk Access for the MCP host process (see [Full Disk Access Setup](#full-disk-access-for-checklist-features)).

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

#### `list-attachments`

Lists attachments in a note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Note ID (preferred) |
| `title` | string | No | Note title |
| `account` | string | No | Account containing the note |

**Returns:** List of attachments with names and content types.

---

#### `save-attachment`

Saves a note attachment to disk.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | CoreData note ID (from `search-notes`/`list-notes`) |
| `attachmentId` | string | Yes | Attachment ID (from `list-attachments`) |
| `savePath` | string | Yes | Absolute destination file path. Must be under your home directory, a temp directory, or `/Volumes` |

**Returns:** Confirmation with the saved path, name, and content type (also in `structuredContent`).

---

#### `fetch-attachment`

Returns a note attachment's bytes as base64, without writing to disk (the read counterpart to `save-attachment`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | CoreData note ID (from `search-notes`/`list-notes`) |
| `attachmentId` | string | Yes | Attachment ID (from `list-attachments`) |

**Returns:** The attachment name, content type, byte count, and base64 payload in `structuredContent.base64`.

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

**Returns:** A per-check report (`structuredContent` carries the raw `{healthy, checks[]}`). The Full Disk Access check tells you whether checklist-state features will work — see [Full Disk Access Setup](docs/FULL-DISK-ACCESS.md).

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

By default, all operations use iCloud. To work with other accounts:

```
User: "What accounts do I have?"
AI: [calls list-accounts]
    "You have 3 accounts: iCloud, Gmail, Exchange"

User: "List notes in my Gmail account"
AI: [calls list-notes with account="Gmail"]
    "Your Gmail account has 5 notes..."
```

### Organizing with Folders

```
User: "Create a folder called 'Archive'"
AI: [calls create-folder with name="Archive"]
    "Created folder 'Archive'"

User: "Move my old meeting notes to Archive"
AI: [calls move-note with title="Old Meeting Notes", folder="Archive"]
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
npm install -g github:sweetrb/apple-notes-mcp
```

### From Source

```bash
git clone https://github.com/sweetrb/apple-notes-mcp.git
cd apple-notes-mcp
npm install
npm run build
```

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

This repo ships a `.mcp.json` at its root so that, when you run `claude` from inside a clone, the server is registered automatically as a **project-scope** server — no manual config needed. After `npm run build`, just launch Claude Code from the repo directory and approve the server when prompted.

The entrypoint is written as:

```json
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
| `APPLE_NOTES_MCP_CONFIG_FILE` | `~/Library/Application Support/apple-notes-mcp/config.json` | Path to the JSON config file (see below). |
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

## Full Disk Access for Checklist Features

The `get-checklist-state` tool and checklist annotations in `get-note-markdown` read directly from the Apple Notes SQLite database. This requires **Full Disk Access** for the process running the MCP server.

> 📘 **For the full why-and-how walkthrough (which app to grant, verifying with `doctor`, graceful degradation), see the [Full Disk Access Setup Guide](docs/FULL-DISK-ACCESS.md).** The summary below is the quick version.

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

All other tools work normally without Full Disk Access. Only checklist state features are affected:
- `get-checklist-state` will return an error explaining that database access is needed
- `get-note-markdown` will return plain list items without `[x]`/`[ ]` annotations (graceful fallback)

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
| No pinned notes | Pin status is not exposed via AppleScript ([#28](https://github.com/sweetrb/apple-notes-mcp/issues/28)) |
| Limited rich formatting | Use `format: "html"` on create/update for headings, lists, bold, code blocks; some complex formatting may not render |
| Title matching | Most operations require exact title matches |
| Checklist state | Requires [Full Disk Access](docs/FULL-DISK-ACCESS.md) to read done/undone state from the database |
| Checklist **creation** | Not supported. AppleScript's `body of note` setter strips `<input type="checkbox">` and ignores any checklist-styling CSS class. Apple Notes stores checklist items as a protobuf paragraph style (`style_type=103`) that AppleScript doesn't expose, and the SQLite database is read-only. See [Creating Checklists](#creating-checklists) below for the workaround. |

### Roadmap

A few capabilities are deliberately deferred to a future release, tracked as open issues:

- **Pinned-note support** ([#28](https://github.com/sweetrb/apple-notes-mcp/issues/28)) — Apple doesn't expose pin status via AppleScript.
- **Tags / hashtags** ([#29](https://github.com/sweetrb/apple-notes-mcp/issues/29)).
- **Note links** ([#30](https://github.com/sweetrb/apple-notes-mcp/issues/30)).
- **Local integration-test suite** ([#31](https://github.com/sweetrb/apple-notes-mcp/issues/31)).

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
2. **Use the Apple Shortcuts app** to script the checklist creation, since Shortcuts can manipulate Notes content at a higher level than AppleScript.
3. **Read-only checklist support is fully implemented** — once a checklist exists (created manually or by another app), `get-checklist-state` and `get-note-markdown` will read its done/undone state correctly (with Full Disk Access).

If you need to *track* todos programmatically and don't strictly need them rendered as Apple Notes checklist UI, plain markdown-style `- [ ] item` / `- [x] item` lines in a `plaintext` note are a reasonable alternative — they are searchable, human-readable, and can be parsed by downstream tooling.

### Backslash Escaping (Important for AI Agents)

When sending content containing backslashes (`\`) to this MCP server, **you must escape them as `\\`** in the JSON parameters.

**Why:** The MCP protocol uses JSON for parameter passing. In JSON, a single backslash is an escape character. To include a literal backslash in content, it must be escaped as `\\`.

**Example - Shell command with escaped path:**
```json
{
  "title": "Install Script",
  "content": "cp ~/Library/Mobile\\\\ Documents/file.txt ~/.config/"
}
```

The `\\\\` in JSON becomes `\\` in the actual string, which represents a single `\` in the note.

**Common patterns requiring escaping:**
- Shell escaped spaces: `Mobile\ Documents` → `Mobile\\\\ Documents` in JSON
- Windows paths: `C:\Users\` → `C:\\\\Users\\\\` in JSON
- Regex patterns: `\d+` → `\\\\d+` in JSON

**If you see errors** when creating/updating notes with backslashes, double-check that backslashes are properly escaped in the JSON payload.

---

## Troubleshooting

### "Notes.app not responding"
- Ensure Notes.app is not frozen
- Try opening Notes.app manually
- Restart the MCP server

### "Permission denied"
- macOS needs automation permission
- Go to System Preferences > Privacy & Security > Automation
- Ensure your terminal/Claude has permission to control Notes

### "Note not found"
- Note titles must match exactly (case-sensitive)
- Check if the note is in a different account
- Use `list-notes` to see available notes

### Note creation/update fails silently with backslashes
- Content containing `\` characters requires JSON escaping
- Use `\\` to represent each literal backslash
- See "Backslash Escaping" section under Known Limitations

### `apple-notes` server fails to connect when run from a clone
- Launch `claude` from **inside the repo directory** so `CLAUDE_PROJECT_DIR` resolves to the repo root (the bare `.` fallback is unreliable — it points at the launching process's working directory)
- Run `npm run build` first — the entrypoint is `${CLAUDE_PROJECT_DIR:-.}/build/index.js`, which won't exist until you build
- Run `claude mcp list` to check for a conflicting `apple-notes` entry at another scope (project-scope outranks user-scope, but local-scope outranks project-scope)
- Approve the pending project-scope server when Claude Code prompts you

---

## Development

```bash
npm install            # Install dependencies
npm run build          # Compile TypeScript
npm test               # Run unit test suite (mocked AppleScript)
npm run test:integration  # Run integration tests against real Notes.app
npm run test:all       # Unit + integration
npm run lint           # Check code style
npm run format         # Format code
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

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Related Projects

Part of a family of macOS MCP servers:

- [apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp) — MCP server for Apple Mail (read, search, send, and organize email)
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers (read and write .numbers spreadsheets)
- [apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp) — MCP server for Apple Photos (query metadata and export originals)

## Recurring macOS permission prompts

If macOS keeps re-prompting for Full Disk Access or Automation for `node` (often after a `brew upgrade`), see [docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md](docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md) — the fix is to run this server under the official, Developer-ID-signed Node so the grant survives Node updates.
