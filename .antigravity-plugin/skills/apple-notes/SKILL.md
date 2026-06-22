---
name: apple-notes
description: Use this skill when the user wants to interact with Apple Notes on macOS - creating, searching, reading, updating, deleting, or organizing notes and folders. This skill provides access to the full Apple Notes app through MCP tools.
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

| Tool | Purpose |
|------|---------|
| `create-note` | Create a new note with title and content |
| `search-notes` | Find notes by title or content |
| `get-note-content` | Read the full content of a note |
| `get-note-details` | Get metadata (created, modified, account) |
| `update-note` | Modify a note's title or content |
| `delete-note` | Remove a note (moves to Recently Deleted) |
| `move-note` | Move a note to a different folder |
| `list-notes` | List all notes or notes in a folder |

### Folder Operations

| Tool | Purpose |
|------|---------|
| `list-folders` | List all folders in an account |
| `create-folder` | Create a new folder |
| `delete-folder` | Delete an empty folder |

### Account Operations

| Tool | Purpose |
|------|---------|
| `list-accounts` | List configured accounts (iCloud, Gmail, etc.) |

## Usage Patterns

### Creating Notes

When the user wants to save information:

```
User: "Save this meeting summary as a note"
Action: Use create-note with appropriate title and the content
```

```
User: "Create a shopping list note"
Action: Use create-note with title="Shopping List" and formatted content
```

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

### Reading Notes

When the user wants to see note contents:

```
User: "Show me my shopping list"
Action: Use get-note-content with title="Shopping List"
```

### Updating Notes

When the user wants to modify a note:

```
User: "Add milk to my shopping list"
Action:
1. Use get-note-content to read current content
2. Use update-note with the updated content including "milk"
```

### Organizing Notes

When the user wants to organize:

```
User: "Move my old notes to Archive"
Action: Use move-note with the note title and folder="Archive"
```

```
User: "Create a Work folder"
Action: Use create-folder with name="Work"
```

## Important Guidelines

1. **Title Matching**: Note operations require exact title matches. If a note isn't found, suggest using `search-notes` first.

2. **Default Account**: Operations default to iCloud. Use the `account` parameter for other accounts (Gmail, Exchange).

3. **Content Format**: Notes store content as HTML. Plain text works fine for creation, but retrieved content may include HTML tags.

4. **Backslash Escaping**: When content contains backslashes, escape them as `\\` in the JSON.

5. **Password-Protected Notes**: Cannot be accessed via this skill. Inform the user if they try.

6. **macOS Only**: This skill only works on macOS systems.

## Error Handling

- **"Note not found"**: Use search-notes to find similar titles
- **"Permission denied"**: User needs to grant automation permission in System Preferences
- **"Folder not empty"**: Cannot delete folders with notes; move notes first

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
