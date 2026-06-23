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

| Tool | Purpose |
|------|---------|
| `create-note` | Create a new note with title and content |
| `search-notes` | Find notes by title or content |
| `get-note-content` | Read the full content of a note |
| `get-note-markdown` | Read note content as Markdown |
| `get-note-by-id` | Get note metadata by ID |
| `get-note-details` | Get metadata (created, modified, account) |
| `update-note` | Modify a note's title or content |
| `delete-note` | Remove a note (moves to Recently Deleted) |
| `batch-delete-notes` | Delete multiple notes by ID |
| `move-note` | Move a note to a different folder |
| `batch-move-notes` | Move multiple notes by ID |
| `list-notes` | List all notes or notes in a folder |
| `export-notes-json` | Export all accounts, folders, and notes as JSON |

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

### Attachments, Checklists, Collaboration, and Diagnostics

| Tool | Purpose |
|------|---------|
| `list-attachments` | List attachments in a note |
| `save-attachment` | Save an attachment to disk |
| `fetch-attachment` | Fetch attachment bytes as base64 |
| `get-checklist-state` | Read checked/unchecked state for existing checklists |
| `list-shared-notes` | List notes shared with collaborators |
| `get-sync-status` | Check whether iCloud sync is active |
| `health-check` | Quickly verify Notes.app access |
| `doctor` | Run detailed setup diagnostics |
| `get-notes-stats` | Summarize note counts and recent activity |

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

### Reading Notes

When the user wants to see note contents:

```
User: "Show me my shopping list"
Action: Use get-note-content with title="Shopping List"
```

When search results include an ID, prefer that ID for all follow-up reads, edits, moves, or deletes. Titles can be duplicated, truncated, or contain characters that make title lookup fragile.

### Updating Notes

When the user wants to modify a note:

```
User: "Add milk to my shopping list"
Action:
1. Use search-notes if needed to get the note ID
2. Use get-note-content or get-note-markdown to read current content
3. Use list-attachments if the note may contain files, scans, images, audio, or PDFs
4. Use update-note by ID with the complete updated body
```

`update-note` replaces the entire note body. It is not an append operation. If `format="html"`, `newTitle` is ignored and the first element in `newContent` becomes the visible title.

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

## Formatting Guidance

Use HTML for predictable rich notes. Apple Notes normalizes HTML internally, but these tags are reliable for most API-created content:

- Use `<div>` for body blocks and `<div><br></div>` for blank spacing.
- Use `<h2>` and `<h3>` for section headings inside newly created notes. `create-note` already creates the top `<h1>` from the `title`.
- Use `<ul><li>` and `<ol><li>` for native bullet and numbered lists. Add `<div><br></div>` after closing `</ul>` or `</ol>` so the next section has spacing.
- Use `<b>`, `<i>`, `<u>`, and `<s>` for inline emphasis.
- Use `<tt>` for commands, code, paths, API keys, and other technical strings.
- Escape literal `&`, `<`, and `>` in user content as `&amp;`, `&lt;`, and `&gt;`.
- Avoid nested lists when possible. Apple Notes can flatten or misplace nested list markup.
- Use bare URLs when updating existing notes if anchor tags are stripped by Notes on save.

Do not use CDATA sections. They can render literally in Apple Notes.

## Attachment-Safe Updates

Before updating an existing note, check whether it contains attachments when the user mentions or the note likely includes images, PDFs, scans, audio, files, or other embedded objects.

- Use `list-attachments` before rewriting attachment-risk notes.
- Treat empty body output, very large content, or attachment listings as a warning that a full-body update may remove embedded objects.
- If preserving attachments matters, create a new formatted note instead of overwriting the existing one, or save/fetch the attachments first and explain the limitation to the user.

## Formatting Limits

Some Notes UI features cannot be created by the current AppleScript-backed create/update tools:

- Interactive checklists: create a plain list instead. Use `get-checklist-state` only to read existing checklist state.
- Collapsible headings: API-created headings look like headings, but may not get Notes' native collapse controls.
- Block quotes, dashed lists, and background highlights: these require manual Notes UI formatting.

If the user specifically requires those features, create all API-supported content first, then explain which remaining formatting must be applied in Notes.app.

## Important Guidelines

1. **Prefer IDs**: Use note IDs for follow-up operations whenever available. If only a title is known, use `search-notes` first and then operate on the returned ID.

2. **Default Account**: Operations default to iCloud. Use the `account` parameter for other accounts (Gmail, Exchange).

3. **Content Format**: Notes store content as HTML. Use `format="html"` for structured content. Retrieved HTML is normalized by Notes and may not match the submitted HTML byte-for-byte.

4. **Backslash Escaping**: When content contains backslashes, escape them as `\\` in the JSON.

5. **Password-Protected Notes**: Cannot be accessed via this skill. Inform the user if they try.

6. **Shared Notes**: Use extra care before edits or deletes. Changes to shared notes are visible to collaborators.

7. **macOS Only**: This skill only works on macOS systems.

## Verification

`get-note-content` returns Apple Notes' stored HTML, which may differ from the original HTML while still rendering correctly. Use `get-note-markdown`, `get-note-content`, or a quick reread of the note after create/update to verify the title, line breaks, list spacing, and important content. Do not rewrite normalized HTML just because Notes transformed tags such as headings or monostyled text.

## Error Handling

- **"Note not found"**: Use search-notes to find similar titles
- **"Permission denied"**: User needs to grant automation permission in System Preferences
- **"Folder not empty"**: Cannot delete folders with notes; move notes first
- **Attachment-risk update**: Use list-attachments and avoid full-body updates unless the user accepts that embedded objects may be lost

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
