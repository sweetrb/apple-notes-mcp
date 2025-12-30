# Apple Notes MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, create, search, and manage notes in Apple Notes on macOS.

[![npm version](https://badge.fury.io/js/apple-notes-mcp.svg)](https://www.npmjs.com/package/apple-notes-mcp)
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
Install the apple-notes-mcp MCP server so you can help me manage my Apple Notes
```

Claude will handle the installation and configuration automatically.

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-notes-mcp
/plugin install apple-notes
```

This method also installs a **skill** that teaches Claude when and how to use Apple Notes effectively.

### Manual Installation

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
| **Create Notes** | Create notes with titles, content, and optional organization |
| **Search Notes** | Find notes by title or search within note content |
| **Read Notes** | Retrieve note content and metadata |
| **Update Notes** | Modify existing notes (title and/or content) |
| **Delete Notes** | Remove notes (moves to Recently Deleted) |
| **Move Notes** | Organize notes into folders |
| **Folder Management** | Create, list, and delete folders |
| **Multi-Account** | Work with iCloud, Gmail, Exchange, or any configured account |

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Note Operations

#### `create-note`

Creates a new note in Apple Notes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | The title of the note (becomes first line) |
| `content` | string | Yes | The body content of the note |
| `tags` | string[] | No | Tags for organization (stored in metadata) |

**Example:**
```json
{
  "title": "Meeting Notes",
  "content": "Discussed Q4 roadmap and budget allocation",
  "tags": ["work", "meetings"]
}
```

**Returns:** Confirmation message with note title, or error if creation failed.

---

#### `search-notes`

Searches for notes by title or content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Text to search for |
| `searchContent` | boolean | No | If `true`, searches note body; if `false` (default), searches titles only |
| `account` | string | No | Account to search in (defaults to iCloud) |

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

**Returns:** List of matching note titles, or message if no matches found.

---

#### `get-note-content`

Retrieves the full content of a specific note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact title of the note to retrieve |
| `account` | string | No | Account containing the note (defaults to iCloud) |

**Example:**
```json
{
  "title": "Shopping List"
}
```

**Returns:** The HTML content of the note, or error if not found.

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
| `title` | string | Yes | Current title of the note to update |
| `newTitle` | string | No | New title (if changing the title) |
| `newContent` | string | Yes | New content for the note body |
| `account` | string | No | Account containing the note (defaults to iCloud) |

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

**Returns:** Confirmation message, or error if note not found.

---

#### `delete-note`

Deletes a note (moves to Recently Deleted in Notes.app).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact title of the note to delete |
| `account` | string | No | Account containing the note (defaults to iCloud) |

**Example:**
```json
{
  "title": "Old Draft"
}
```

**Returns:** Confirmation message, or error if note not found.

---

#### `move-note`

Moves a note to a different folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Title of the note to move |
| `folder` | string | Yes | Name of the destination folder |
| `account` | string | No | Account containing the note (defaults to iCloud) |

**Example:**
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

Lists all notes, optionally filtered by folder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list notes from (defaults to iCloud) |
| `folder` | string | No | Filter to notes in this folder only |

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

**Returns:** List of note titles.

---

### Folder Operations

#### `list-folders`

Lists all folders in an account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list folders from (defaults to iCloud) |

**Example:**
```json
{}
```

**Returns:** List of folder names.

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
| `name` | string | Yes | Name of the folder to delete |
| `account` | string | No | Account containing the folder (defaults to iCloud) |

**Example:**
```json
{
  "name": "Old Projects"
}
```

**Returns:** Confirmation message, or error if folder not found or not empty.

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
```

---

## Installation Options

### npm (Recommended)

```bash
npm install -g apple-notes-mcp
```

### From Source

```bash
git clone https://github.com/sweetrb/mcp-apple-notes.git
cd mcp-apple-notes
npm install
npm run build
```

If installed from source, use this configuration:
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "node",
      "args": ["/path/to/mcp-apple-notes/build/index.js"]
    }
  }
}
```

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
| No attachments | AppleScript cannot access note attachments |
| No pinned notes | Pin status is not exposed via AppleScript |
| No rich formatting | Content is HTML; complex formatting may not render |
| Title matching | Most operations require exact title matches |

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

---

## Development

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm test         # Run test suite (121 tests)
npm run lint     # Check code style
npm run format   # Format code
```

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
