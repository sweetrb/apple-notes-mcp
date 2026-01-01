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
content: "Path: C:\\\\Users\\\\Documents"
```

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

### create-note / update-note
- Always escape backslashes in content (see above)
- Newlines can be sent as `\n` (this is a valid JSON escape)
- The title becomes the first line of the note
- `create-note` returns the new note's ID for subsequent operations

### search-notes
- Set `searchContent: true` to search note body, not just titles
- Searches are case-insensitive
- Results include note IDs for reliable subsequent operations

### list-notes
- Returns note titles only, not content
- Use `get-note-content` to retrieve full content

### move-note
- Internally copies then deletes the original
- If delete fails, note exists in both locations (still returns success)
- Prefer using `id` parameter to avoid issues with duplicate titles

### Multi-account
- Default account is iCloud
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

## Testing Your Understanding

Before creating notes with shell commands or paths containing backslashes, verify you're escaping correctly:

- `~/path/to/file` - No escaping needed (no backslashes)
- `Mobile\ Documents` - Needs escaping: `Mobile\\ Documents`
- `C:\Users\` - Needs escaping: `C:\\Users\\`
