# Apple Notes MCP - Improvement Roadmap

*As of v2.1.0*

Based on technical research into Apple Notes internals, the current
AppleScript dictionary, Notes App Intents metadata, and analysis of other
implementations, here are remaining improvements.

## Future Considerations

### AppleScript Surface Gaps
**Problem**: A few low-risk Notes AppleScript capabilities are exposed by
`Notes.sdef` but are not wrapped as MCP tools yet.

**Candidate tools**:
- Show or reveal a note, folder, account, or attachment in Notes.app
- Return the currently selected note IDs
- Return the default account and default folder
- Include account IDs, account upgrade status, folder IDs, and folder shared state
- Include richer attachment metadata: content identifier, URL, created/modified
  dates, and shared state

**Complexity**: Low to medium - AppleScript only, no private database parsing

---

### App Intents Bridge
**Problem**: AppleScript cannot create or update several modern Notes features,
but Notes ships App Intents for many of them. The `shortcuts` CLI can run named
shortcuts but does not directly invoke arbitrary App Intents, so the MCP server
needs a reliable bridge before these can become tools.

**Candidate features**:
- Append or prepend to a note without replacing the full body
- Interpret appended content as Markdown
- Create real checklist items and check/uncheck/toggle existing checklist items
- Create, add, remove, open, and delete real Notes tags
- Pin and unpin notes
- Insert note-to-note links and list linked notes
- Add file attachments and URL/link attachments
- Add tables from CSV and delete/reveal tables
- Rename folders and move notes with native App Intents
- Open Quick Notes, Shared, Math Notes, and Call Recordings views
- Start audio recording in Notes.app

**Possible approaches**:
- Native Swift helper that invokes App Intents directly
- Generated or bundled Shortcuts used as a stable runner
- Hybrid approach: keep AppleScript for existing CRUD, use App Intents only for
  capabilities AppleScript cannot express

**Complexity**: High - requires feature detection, macOS-version gating,
permission handling, packaging, and integration tests

**Feasibility (researched 2026-06, verified against macOS 27 + Apple docs; see [TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md#app-intents-and-the-shortcuts-bridge))**:
- The "native Swift helper that invokes App Intents directly" approach is not
  possible. App Intents are system-invoked and app-local; there is no public API to
  `perform()` another app's intents. A helper could only fall back to AppleScript.
- The only working route is a user-installed wrapper Shortcut run via
  `shortcuts run "<name>"`. It needs an active GUI login session (no SSH or launchd),
  a one-time manual install, and is plain-text only. This is a BETA, opt-in path.
- Reachable through that bridge: pin / unpin, add / remove / create / delete tags,
  move to folder, append checklist item, append plain text, attach a file.
- Still GUI-only under every approach (drop from scope): prepend, Markdown body
  writes, checklist toggle, tables, note-to-note links, URL attachments.

---

### Hybrid SQLite + AppleScript Approach
**Problem**: AppleScript is slow and limited; direct SQLite is read-only.

**Solution**:
- Use SQLite for fast read operations (search, list, get content)
- Use AppleScript only for write operations (create, update, delete)
- Requires copying database for reads (safety)
- Significant performance improvement for large note collections

**Complexity**: High - requires protobuf parsing
**Dependencies**: `better-sqlite3`, `protobufjs`

---

### Read-Only SQLite Metadata Expansion
**Problem**: The server already reads checklist state from the Notes database,
but many useful read-only metadata fields are still unavailable through
AppleScript.

**Candidate metadata**:
- Pinned state
- Smart folder query JSON
- Trash/recovery state
- Checklist-present and checklist-in-progress flags
- OCR, handwriting, image-classification, and summary text
- Attachment dimensions, type UTI, URL string, preview dates, and file size
- Location coordinates for attachments with location metadata
- Participants, invitations, and share URLs
- Audio transcription availability and temporary transcript data
- Thumbnail and fallback image/PDF generation status

**Safety rule**: SQLite work must stay read-only. Copy the database, WAL, and SHM
files before reading; never write to the live Notes store.

**Complexity**: Medium to high - schema differs across macOS releases and some
fields require protobuf or archived-data parsing

**Verified (2026-06, macOS 27 / Notes 4.13; see [TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md#read-only-metadata-columns-verified-macos-27--notes-413))**:
The highest-value fields are plain scalar columns on `ZICCLOUDSYNCINGOBJECT` and need no
protobuf decoding: `ZISPINNED` (pinned), `ZHASCHECKLIST` / `ZHASCHECKLISTINPROGRESS`,
`ZISRECOVERINGFROMTRASH` (trash state), `ZSMARTFOLDERQUERYJSON` (smart-folder query),
`ZSNIPPET` / `ZWIDGETSNIPPET`, and `ZPASSWORDHINT`. These are the low-risk first
increment; the existing checklist reader already supplies the copy-DB and Full Disk
Access scaffolding. The protobuf or archived-data fields (OCR, summary text, attachment
dimensions, participants, transcripts) remain the harder, later tier. `ZISPINNED` also
closes the read half of the "pinned notes" known limitation; the write half needs the
Shortcuts bridge above.

---

### Formatting and Note-Body Safety
**Problem**: Apple Notes normalizes HTML on save, and full-body updates can
overwrite embedded objects if callers treat updates like append operations.

**Improvements**:
- Document HTML patterns that render well in Notes: `<div>`, `<h2>/<h3>`,
  `<ul>/<ol>/<li>`, `<tt>`, inline emphasis, and explicit blank spacer divs
- Warn that `create-note` already prepends the title as `<h1>`
- Warn that `update-note` replaces the entire body and ignores `newTitle` in
  HTML mode
- Encourage `list-attachments` before updating notes that may contain files,
  images, scans, PDFs, or audio
- Add regression fixtures for Notes-normalized HTML so agents do not rewrite
  safe normalized output unnecessarily

**Complexity**: Low - documentation, tests, and tool-description improvements

---

### Watch for macOS API Changes
- Apple may deprecate AppleScript entirely
- Monitor for new Notes.app APIs and App Intents in future macOS versions
- Re-run `sdef /System/Applications/Notes.app` and inspect bundled App Intents
  metadata during each major macOS release
- Consider Shortcuts or a native helper as a future App Intents bridge

---

## Implementation Notes

### Testing Strategy
- Unit tests with mocked AppleScript responses (existing)
- Integration tests against real Notes.app (manual, documented)
- Test matrix: macOS versions (Sonoma, Sequoia), note types (simple, attachments, locked)
- Feature-detection tests for optional App Intents-backed tools
- SQLite parser fixtures copied from sanitized note databases where possible
- Safety tests that prove private SQLite code opens read-only copies, not the
  live database

### Backwards Compatibility
- All new parameters should be optional
- Existing tool signatures must not change
- Use feature detection for new capabilities
- Prefer adding new tools over changing semantics of existing tools
- Gate GUI-opening or app-activating features clearly in tool descriptions

### Performance Targets
- Simple operations (get, create): < 500ms
- Search operations: < 2s for 1000 notes
- Batch operations: Linear scaling with count
- SQLite-backed read operations should report partial coverage when a database
  copy, WAL read, or parser step fails

*Created: December 2025*
*Last reviewed: June 2026*
*Based on research in [TECHNICAL_NOTES.md](./TECHNICAL_NOTES.md)*
