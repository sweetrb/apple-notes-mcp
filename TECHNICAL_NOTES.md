# Apple Notes Technical Documentation

This document contains research findings on Apple Notes internals, programmatic access methods, and known limitations. It serves as a reference for improving the apple-notes-mcp project.

## Table of Contents

- [Data Storage Architecture](#data-storage-architecture)
- [AppleScript API](#applescript-api)
- [Direct Database Access](#direct-database-access)
- [Protobuf Data Format](#protobuf-data-format)
- [Alternative Approaches](#alternative-approaches)
- [Known Issues & Limitations](#known-issues--limitations)
- [Related Tools & Projects](#related-tools--projects)
- [Sources](#sources)

---

## Data Storage Architecture

### Database Location

Notes are stored in a SQLite database at:
```
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
```

The database consists of three files:
- `NoteStore.sqlite` - Main database
- `NoteStore.sqlite-shm` - Shared memory file
- `NoteStore.sqlite-wal` - Write-ahead log (active changes)

**Important**: The WAL file contains uncommitted changes while Notes.app is running. Always copy the database files before reading directly.

### Key Tables

| Table | Purpose |
|-------|---------|
| `ZICCLOUDSYNCINGOBJECT` | Sync state for notes, attachments, folders (209 columns as of iOS 18) |
| `ZICNOTEDATA` | Note content (gzipped protobuf in `ZDATA` column) |

### Identifiers

- **CoreData IDs**: Format `x-coredata://DEVICE-UUID/ICNote/pXXXX`
- **UUID Identifiers**: Stored in `ZIDENTIFIER` column
- **Z_PK**: Primary key linking tables

### Attachments

Media files are stored separately at:
```
~/Library/Group Containers/group.com.apple.notes/Media/<UUID>/
```

---

## AppleScript API

### Capabilities

The Notes.app scripting dictionary exposes:
- Creating, reading, updating, deleting notes
- Folder management
- Account enumeration
- Note properties (name, body, id, creation date, modification date, shared, password protected)

### Limitations

1. **Attachment Positioning**: Cannot determine where attachments appear within note body
2. **Image Embedding**: Adding images via AppleScript is unreliable; images may appear in attachments browser but not inline
3. **Rich Text Formatting**: Limited control over formatting; markdown is inserted as plain text
4. **Password-Protected Notes**: Cannot read content of locked notes
5. **No Undo**: Operations are immediate and cannot be reverted programmatically
6. **Maintenance Mode**: Apple has disbanded the AppleScript team; no new features expected

### ID-Based Operations

Notes can be accessed by CoreData ID at the application level (not account-scoped):
```applescript
tell application "Notes"
  set n to note id "x-coredata://UUID/ICNote/p123"
  get body of n
  delete note id "x-coredata://UUID/ICNote/p123"
end tell
```

This is more reliable than title-based lookups when duplicate titles exist.

### HTML Body Format

Notes stores content as HTML internally:
```html
<div>Title</div>
<div>First paragraph</div>
<div><br></div>
<div>Second paragraph</div>
```

The first `<div>` becomes the note title. Attachments use a proprietary object tag format.

---

## Direct Database Access

### Reading the Database

```python
import sqlite3
import gzip

db_path = "~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
conn = sqlite3.connect(db_path)

# Get note data
cursor = conn.execute('''
    SELECT n.Z_PK, n.ZDATA, o.ZTITLE1
    FROM ZICNOTEDATA n
    JOIN ZICCLOUDSYNCINGOBJECT o ON n.ZNOTE = o.Z_PK
''')

for pk, data, title in cursor:
    if data:
        decompressed = gzip.decompress(data)
        # Parse protobuf...
```

### Safety Considerations

- **Read-Only**: Never write to the live database
- **Copy First**: Make a copy of all three files before reading
- **Quit Notes**: For consistent reads, quit Notes.app first
- **Full Disk Access**: Required to access the Group Containers path

---

## Protobuf Data Format

### Document Structure

The `ZDATA` blob contains gzipped protobuf data:

```protobuf
message Document {
  repeated Version version = 2;
}

message Version {
  optional bytes data = 3;  // Format-specific content
}
```

### Note Content

```protobuf
message String {
  string string = 2;                    // Plain text content
  repeated AttributeRun attributeRun = 5;
}

message AttributeRun {
  uint32 length = 1;
  ParagraphStyle paragraphStyle = 2;
  Font font = 3;
  uint32 fontHints = 5;     // 1:bold, 2:italic, 3:bold+italic
  uint32 underline = 6;
  uint32 strikethrough = 7;
  int32 superscript = 8;
  string link = 9;
  Color color = 10;
  AttachmentInfo attachmentInfo = 12;
}

message ParagraphStyle {
  uint32 style = 1;     // 0:title, 1:heading, 4:monospace, 100-103:lists
  uint32 alignment = 2; // 0:left, 1:center, 2:right, 3:justified
  int32 indent = 4;
  Todo todo = 5;
}
```

### Embedded Objects

The Unicode replacement character `￼` (U+FFFC) marks attachment positions. Each has a corresponding `AttachmentInfo` in the AttributeRun with type and UUID.

### CRDT Implementation

Tables and collaborative editing use Conflict-Free Replicated Data Types (CRDTs). Apple uses "topotext" for synchronization with first-write-wins conflict resolution via iCloud.

---

## Alternative Approaches

### JavaScript for Automation (JXA)

JXA provides similar capabilities to AppleScript but with JavaScript syntax:

```javascript
#!/usr/bin/env osascript -l JavaScript

const Notes = Application('Notes');
const note = Notes.notes.byId('x-coredata://...');
console.log(note.body());
```

**Status**: Abandoned by Apple (like AppleScript), has rough edges.

### ScriptingBridge (Swift/Objective-C)

Enables programmatic access via Objective-C messages:

```swift
import ScriptingBridge

if let notes = SBApplication(bundleIdentifier: "com.apple.Notes") {
    // Access notes via generated protocols
}
```

**Limitations**:
- Cannot be used in Mac App Store apps
- Some operations (like adding attachments) don't work
- Considered "incompetent" by many developers

### Shortcuts.app

Can export notes to HTML/Markdown using built-in actions, but limited programmatic control.

---

## Known Issues & Limitations

### macOS Sequoia/Sonoma (2024)

- Notes.app crashes after OS updates (especially on M1 Macs)
- Sync issues between devices
- Database corruption reported by some users

**Workarounds**:
- Delete `com.apple.Notes.plist` and restart
- Toggle iCloud Notes sync off/on
- Change to gallery view, restart, change back to list view

### AppleScript-Specific Issues

| Issue | Impact | Workaround |
|-------|--------|------------|
| Duplicate titles | Wrong note affected | Use CoreData IDs |
| Special characters | Escaping failures | HTML-encode backslashes |
| Timeout on large operations | Script hangs | Break into smaller batches |
| Attachment positioning unknown | Can't recreate note layout | Accept limitation |
| Password-protected notes | Cannot read | Skip or warn user |

### Database Access Issues

- Launch agents cannot access Group Containers even with Full Disk Access
- WAL file may contain uncommitted changes
- Schema changes with each iOS/macOS version (209 columns in iOS 18)

---

## Related Tools & Projects

### Forensic/Parsing Tools

| Tool | Language | Features |
|------|----------|----------|
| [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser) | Ruby | Full forensic parser, protobuf decoding, iOS 9-18 support |
| [dunhamsteve/notesutils](https://github.com/dunhamsteve/notesutils) | Python | Lightweight export to HTML/Bear format |
| [akx/notorious](https://github.com/akx/notorious) | Python | Database parser |

### Export Tools

| Tool | Language | Features |
|------|----------|----------|
| [storizzi/notes-exporter](https://github.com/storizzi/notes-exporter) | Python | Export to HTML, Markdown, PDF, DOCX |
| [Kylmakalle/apple-notes-exporter](https://github.com/Kylmakalle/apple-notes-exporter) | Python | Shortcuts + Python for HTML/Markdown |

### Other MCP Implementations

| Project | Approach | Notes |
|---------|----------|-------|
| [RafalWilinski/mcp-apple-notes](https://github.com/RafalWilinski/mcp-apple-notes) | RAG/Semantic search | Uses embeddings for search |
| [sirmews/apple-notes-mcp](https://github.com/sirmews/apple-notes-mcp) | Direct SQLite | Requires Full Disk Access |
| [harperreed/notes-mcp](https://github.com/harperreed/notes-mcp) | Go + AppleScript | CLI tool included |

---

## Sources

### Official Documentation
- [AppleScript Language Guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html)
- [ScriptingBridge Documentation](https://developer.apple.com/documentation/scriptingbridge)
- [SBApplication Documentation](https://developer.apple.com/documentation/scriptingbridge/sbapplication)

### Technical Analysis
- [Ciofeca Forensics - Apple Notes Series](https://www.ciofecaforensics.com/2020/01/10/apple-notes-revisited/)
- [Yogesh Khatri - Reading Notes Database](http://www.swiftforensics.com/2018/02/reading-notes-database-on-macos.html)
- [Simon Willison - Notes on Notes.app](https://simonwillison.net/2021/Dec/9/notes-on-notesapp/)
- [dunhamsteve/notesutils - Format Documentation](https://github.com/dunhamsteve/notesutils/blob/master/notes.md)

### Community Resources
- [macosxautomation.com - Notes AppleScript](http://www.macosxautomation.com/applescript/notes/index.html)
- [JXA Cookbook](https://github.com/JXA-Cookbook/JXA-Cookbook)
- [bru6.de - JXA Notes Examples](https://bru6.de/jxa/automating-applications/notes/)

### Issue Discussions
- [Apple Community - AppleScript with Notes.app](https://discussions.apple.com/thread/7390030)
- [Late Night Software - Exporting Notes Attachments](https://forum.latenightsw.com/t/exporting-apple-notes-attachments/766)
- [Clutterstack - Getting Notes Out of Apple Notes](https://clutterstack.com/posts/2024-09-27-applenotes)

---

*Last updated: December 2024*
