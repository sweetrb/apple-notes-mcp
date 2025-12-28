# CLAUDE.md - Apple Notes MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server enables AI assistants to interact with Apple Notes on macOS via AppleScript. All operations are local - no data leaves the user's machine.

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
content: "Path: C:\\\\Users\\\\Documents"
```

**Incorrect - Will fail:**
```
content: "cp ~/Library/Mobile\ Documents/file.txt ~/dest/"
```

## Tool Usage Tips

### create-note / update-note
- Always escape backslashes in content (see above)
- Newlines can be sent as `\n` (this is a valid JSON escape)
- The title becomes the first line of the note

### search-notes
- Set `searchContent: true` to search note body, not just titles
- Searches are case-insensitive

### list-notes
- Returns note titles only, not content
- Use `get-note-content` to retrieve full content

### move-note
- Internally copies then deletes the original
- If delete fails, note exists in both locations (still returns success)

### Multi-account
- Default account is iCloud
- Use `list-accounts` to see available accounts
- Pass `account` parameter to target specific account

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "Notes.app not responding" | Notes.app frozen or not running |
| "Note not found" | Title doesn't match exactly (case-sensitive) |
| Silent failure | Backslash not escaped in content |
| "Permission denied" | macOS automation permission needed |

## Testing Your Understanding

Before creating notes with shell commands or paths containing backslashes, verify you're escaping correctly:

- `~/path/to/file` - No escaping needed (no backslashes)
- `Mobile\ Documents` - Needs escaping: `Mobile\\ Documents`
- `C:\Users\` - Needs escaping: `C:\\Users\\`
