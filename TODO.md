# Apple Notes MCP - Improvement Roadmap

Based on technical research into Apple Notes internals and analysis of other implementations, here are prioritized improvements for stability, reliability, and new features.

## Priority 1: Stability & Reliability

### 1.1 Add Timeout Handling for AppleScript Operations
**Problem**: AppleScript calls can hang indefinitely, especially on large notes or when Notes.app is unresponsive.

**Solution**:
- Wrap all `executeAppleScript` calls with configurable timeouts
- Return graceful error on timeout rather than hanging
- Default timeout: 30 seconds, configurable per operation

**Files**: `src/utils/applescript.ts`

---

### 1.2 Detect and Handle Password-Protected Notes
**Problem**: Operations on locked notes fail silently or with cryptic errors.

**Solution**:
- Check `passwordProtected` property before content operations
- Return clear error message: "Note is password-protected and cannot be accessed"
- Add `skipLocked` option to list/search operations

**Files**: `src/services/appleNotesManager.ts`, `src/index.ts`

---

### 1.3 Add Retry Logic for Transient Failures
**Problem**: Notes.app occasionally returns errors due to sync operations or temporary unavailability.

**Solution**:
- Implement exponential backoff retry (3 attempts, 1s/2s/4s delays)
- Only retry on specific error patterns (timeout, "not responding")
- Log retry attempts for debugging

**Files**: `src/utils/applescript.ts`

---

### 1.4 Validate Note Existence Before Destructive Operations
**Problem**: Delete/update operations on non-existent notes fail with unclear errors.

**Solution**:
- For title-based operations, verify note exists first
- Return specific "Note not found" error
- Suggest using ID-based operations for reliability

**Files**: `src/services/appleNotesManager.ts`

---

## Priority 2: Enhanced Features

### 2.1 Add Markdown Export Tool
**Problem**: Notes are returned as HTML, which is harder to work with.

**Solution**:
- Add `get-note-markdown` tool that converts HTML to Markdown
- Use `turndown` or similar library for conversion
- Handle Apple Notes-specific HTML quirks

**Dependencies**: `turndown` npm package

**New tool schema**:
```typescript
{
  name: "get-note-markdown",
  params: { id?: string, title?: string, account?: string }
}
```

---

### 2.2 Add Batch Operations
**Problem**: Operating on multiple notes requires many individual calls.

**Solution**:
- Add `batch-delete-notes` tool (accepts array of IDs)
- Add `batch-move-notes` tool
- Add `search-and-delete` tool for cleanup operations
- Implement with progress reporting

---

### 2.3 Add Note Statistics Tool
**Problem**: No way to get overview of notes database.

**Solution**:
- Add `get-notes-stats` tool returning:
  - Total note count per account
  - Notes per folder
  - Recently modified notes (last 24h/7d/30d)
  - Notes with attachments count

---

### 2.4 Improve Search with Folder Filtering
**Problem**: Search searches all notes; can't limit to specific folder.

**Solution**:
- Add `folder` parameter to `search-notes` tool
- Combine with existing `searchContent` option
- Return folder path in results

---

### 2.5 Add Attachment Listing Tool
**Problem**: No visibility into note attachments.

**Solution**:
- Add `list-attachments` tool for a specific note
- Return attachment type, filename, size
- Note: Cannot determine inline position (AppleScript limitation)

---

## Priority 3: Alternative Access Methods

### 3.1 Hybrid SQLite + AppleScript Approach
**Problem**: AppleScript is slow and limited; direct SQLite is read-only.

**Solution**:
- Use SQLite for fast read operations (search, list, get content)
- Use AppleScript only for write operations (create, update, delete)
- Requires copying database for reads (safety)
- Significant performance improvement for large note collections

**Complexity**: High - requires protobuf parsing
**Dependencies**: `better-sqlite3`, `protobufjs`

---

### 3.2 Add Database Snapshot Tool
**Problem**: No backup/export functionality.

**Solution**:
- Add `export-notes-json` tool that exports all notes as JSON
- Include metadata, content (HTML and plaintext), folder structure
- Useful for backup and migration

---

### 3.3 Implement JXA Alternative
**Problem**: AppleScript string escaping is complex and error-prone.

**Solution**:
- Evaluate JavaScript for Automation (JXA) as alternative
- May have better Unicode handling
- Same underlying OSA architecture, so similar limitations
- Could simplify escaping logic

**Files**: `src/utils/applescript.ts` (new `executeJXA` function)

---

## Priority 4: Developer Experience

### 4.1 Add Verbose Logging Mode
**Problem**: Difficult to debug issues in production.

**Solution**:
- Add `DEBUG` environment variable support
- Log AppleScript commands being executed
- Log timing information
- Log full error details

---

### 4.2 Add Health Check Tool
**Problem**: No way to verify Notes.app accessibility.

**Solution**:
- Add `health-check` tool that verifies:
  - Notes.app is installed
  - AppleScript permissions granted
  - At least one account accessible
  - Basic operations work
- Return detailed status for each check

---

### 4.3 Improve Error Messages
**Problem**: Some errors are cryptic AppleScript messages.

**Solution**:
- Map common AppleScript errors to user-friendly messages
- Include suggested fixes in error responses
- Add error codes for programmatic handling

**Error mapping examples**:
| AppleScript Error | User Message |
|-------------------|--------------|
| "Can't get note" | "Note not found. Verify the title is exact (case-sensitive)." |
| "Not authorized" | "Permission denied. Grant automation access in System Preferences > Privacy > Automation." |
| "Application isn't running" | "Notes.app is not running. It will be launched automatically." |

---

## Priority 5: Future Considerations

### 5.1 Watch for macOS API Changes
- Apple may deprecate AppleScript entirely
- Monitor for new Notes.app APIs in future macOS versions
- Consider Shortcuts integration as potential future path

### 5.2 iCloud Sync Awareness
- Detect sync-in-progress state
- Warn when operating on notes that may not be fully synced
- Consider adding sync status to note details

### 5.3 Collaboration Features
- Detect shared notes
- Show collaboration participants (if accessible)
- Warn before modifying shared notes

---

## Implementation Notes

### Testing Strategy
- Unit tests with mocked AppleScript responses (existing)
- Integration tests against real Notes.app (manual, documented)
- Test matrix: macOS versions (Sonoma, Sequoia), note types (simple, attachments, locked)

### Backwards Compatibility
- All new parameters should be optional
- Existing tool signatures must not change
- Use feature detection for new capabilities

### Performance Targets
- Simple operations (get, create): < 500ms
- Search operations: < 2s for 1000 notes
- Batch operations: Linear scaling with count

---

## Quick Wins (Completed ✓)

1. [x] Add timeout to AppleScript executor (v1.2.4)
2. [x] Check password-protected before content operations (v1.2.4)
3. [x] Improve error message mapping (v1.2.7)
4. [x] Add `folder` filter to search-notes (v1.2.5)
5. [x] Add health-check tool (v1.2.6)
6. [x] Retry logic for transient failures (v1.2.7)
7. [x] Validate note existence before destructive ops (v1.2.8)
8. [x] Note statistics tool (v1.2.9)
9. [x] Verbose logging mode (v1.2.10)
10. [x] Attachment listing tool (v1.2.11)
11. [x] Batch operations (v1.2.12)
12. [x] Database snapshot/export (v1.2.13)
13. [x] Markdown export tool (v1.2.14)

---

*Created: December 2024*
*Based on research in [TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md)*
