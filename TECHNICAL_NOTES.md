# Apple Notes Technical Documentation

This document contains research findings on Apple Notes internals, programmatic access methods, and known limitations. It serves as a reference for improving the apple-notes-mcp project.

## Table of Contents

- [Data Storage Architecture](#data-storage-architecture)
- [AppleScript API](#applescript-api)
- [Direct Database Access](#direct-database-access)
- [Protobuf Data Format](#protobuf-data-format)
- [Alternative Approaches](#alternative-approaches)
- [Private helper (NotesShared)](#private-helper-notesshared)
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

### Read-Only Metadata Columns (verified macOS 27 / Notes 4.13)

Most useful note metadata lives as plain scalar columns on `ZICCLOUDSYNCINGOBJECT`, so
it can be read with an ordinary `SELECT` and needs no protobuf decoding, unlike the
`ZICNOTEDATA.ZDATA` body blob. The columns below were confirmed against a live store on
macOS 27.0 (Notes 4.13). Column names and availability shift between OS releases, so
treat them as version-specific and feature-detect with `PRAGMA table_info` before use.

| Column | Exposes | Why it matters |
|--------|---------|----------------|
| `ZISPINNED` | Pinned state (boolean) | AppleScript has no `pinned` property, so this is the only read path for pin state |
| `ZHASCHECKLIST`, `ZHASCHECKLISTINPROGRESS` | Whether a note has a checklist, and whether any item is still unchecked | Cheap flags without decoding the body |
| `ZISRECOVERINGFROMTRASH` | Trash / recovery state | Distinguishes a recently deleted note |
| `ZSMARTFOLDERQUERYJSON` | Smart Folder query as JSON | The rules are not scriptable. AppleScript can still list a smart folder's current notes by folder id (`notes of folder id "…/ICFolder/pN"`, verified macOS 27.2, Notes 4.13); `list-smart-folders` uses both |
| `ZSNIPPET`, `ZWIDGETSNIPPET` | Preview snippet text | Fast preview without reading the full body |
| `ZISPASSWORDPROTECTED`, `ZLOCKEDNOTESMODE`, `ZPASSWORDHINT` | Lock state and hint | Richer than AppleScript's single `password protected` boolean |
| `ZFOLDERTYPE`, `ZCROPPINGQUAD*` | Folder kind; document-scan crop geometry | Smart vs regular folder; scan bounds |

#### Listing special sets (`list-special-notes`, `list-native-tags` inventory)

Each listing is one read-only transaction over the same table. Column detection
(`PRAGMA table_info`) and the folder/account context used to label rows are
separate `sqlite3 -readonly` runs, so paths and account names can come from a
slightly different snapshot than the rows. Findings from a
live macOS 27 store (counts only):

- **Quick Notes** carry `ZISSYSTEMPAPER = 1`. The column arrived with Quick Notes
  (macOS 12); without it the listing reports `supported: false`. Many flagged rows have
  no folder, a NULL title, and a NULL modification date. They are abandoned drafts
  Notes.app never shows (111 folderless note rows on the test store, all untitled), so
  every "active note" listing requires a folder. All 15 Quick Notes the listing returned
  also appeared in AppleScript's `list-notes`, confirming the filter.
- **Recently Deleted** is a folder, not a flag: `ZFOLDERTYPE = 1` with an identifier
  that starts `TrashFolder`. The reader accepts either signal, so a store without
  `ZFOLDERTYPE` still works. Rows with `ZMARKEDFORDELETION = 1` are tombstones awaiting
  sync and are left out. `ZISRECOVERINGFROMTRASH` is not a trash marker.
- **Accounts** hang off a numbered `ZACCOUNTn` column whose number differs by entity and
  release (notes use `ZACCOUNT7` on macOS 27). The reader takes the folder's `ZOWNER`
  first and otherwise coalesces every present `ZACCOUNTn`, joined against `ICAccount`
  rows so a column belonging to another relation cannot match.
- **Native tags** are `ICHashtag` rows plus one `ICInlineAttachment` per use
  (`ZTYPEUTI1 = com.apple.notes.inlinetextattachment.hashtag`, `ZNOTE1` = note,
  `ZALTTEXT` = `#tag`). A use counts only while the note body still references that
  inline object's identifier (attribute run field 12). Locked or undecodable bodies are
  counted from the object rows and reported as `unverifiedNotes`.
- Values are bound with the sqlite3 shell's `.parameter set`; entity numbers come from
  `Z_PRIMARYKEY`; note ids are rebuilt as `x-coredata://<Z_METADATA.Z_UUID>/ICNote/p<Z_PK>`,
  which matched every AppleScript id checked.

#### Exact sync cursors (`list-recent-notes`)

`ZMODIFICATIONDATE1` is a Core Data double: seconds since 2001-01-01 UTC with
sub-microsecond fraction bits. Every text path out of SQLite rounds it:
`json_object()` renders 15 significant digits and `printf('%.17g')` is not
reliable either, and a JavaScript `Date` keeps only milliseconds. So neither an
ISO string nor a decimal can serve as an exact incremental-sync boundary.

The sqlite3 command-line shell ships the `ieee754` extension. The reader selects
`hex(ieee754_to_blob(ZMODIFICATIONDATE1))`, the raw big-endian IEEE-754 bits,
and pairs them with the row's `Z_PK` in an opaque `cdts1:<16 hex>:<Z_PK>`
cursor. A `since` cursor is validated, decoded to a finite double, re-encoded
canonically, and bound with `.parameter set @since ieee754_from_blob(x'…')`,
so the comparison runs against the identical double. A fixture test stores two
timestamps one unit in the last place apart, which render to the same ISO
string, and shows the cursor separates them.

A `since` query walks the notes in ascending `(ZMODIFICATIONDATE1, Z_PK)` order
and keeps rows strictly after the cursor:
`ZMODIFICATIONDATE1 > @since OR (ZMODIFICATIONDATE1 = @since AND Z_PK > @sincePk)`.
`nextSince` is the last row's cursor, so every call advances, including one
that fills its `limit`. `Z_PK` breaks ties: notes sharing one stored
timestamp are split across pages by key and none is skipped or repeated. An
ISO `since`, or a cursor without the key, keeps only rows whose timestamp is
strictly later. Rows with no modification date never match a `since` query.

Limits of a modification-date cursor:

- **Late-arriving edits.** iCloud can deliver an edit made on another device
  after the cursor has moved past that edit's timestamp, for example when the
  device was offline or its clock was behind. The row then carries a timestamp
  at or before the cursor and is never returned. A periodic full pass from the
  beginning catches these.
- **Deletions.** Without `includeDeleted`, notes in Recently Deleted or
  awaiting deletion are filtered out, so a deletion looks like silence. With
  it, those rows appear, flagged, when their modification date is after the
  cursor. A note purged from the database has no row, so no cursor query can
  report it; compare ids against a full pass instead.

Reading these is safe under the existing rules: copy the three database files first, open
the copy read-only, and never touch the live store. Writing any of these values directly
is unsafe. It bypasses CloudKit's sync bookkeeping and can corrupt notes or desync iCloud.
To *change* pin state or tags, use the Shortcuts bridge (below), not a SQL `UPDATE`.

### query-notes Data Sources

`query-notes` (`src/utils/noteQuery.ts` for the grammar, `src/utils/noteQueryStore.ts`
for the reader) evaluates every predicate from the database, read-only, in two
`sqlite3 -readonly` calls: `PRAGMA table_info` for feature detection, then one
`BEGIN … COMMIT` read transaction. Entity numbers are looked up by name in
`Z_PRIMARYKEY` (`ICNote`, `ICFolder`, `ICAccount`) because they differ between
stores. The sources below were checked against a live store on macOS 27.2 on
2026-09-23:

| Predicate | Source |
|-----------|--------|
| Note id | `x-coredata://<Z_METADATA.Z_UUID>/ICNote/p<Z_PK>`; the UUID matched AppleScript's `id of note` |
| Title, dates | `ZTITLE1`; `ZMODIFICATIONDATE1`; `COALESCE(ZCREATIONDATE3, ZCREATIONDATE1)` (Core Data seconds since 2001-01-01 UTC) |
| Folder, path | note `ZFOLDER` → folder `ZTITLE2`, walked up `ZPARENT` |
| Account | folder `ZOWNER` (inherited from the parent) → account `ZNAME` |
| Recently Deleted | folder `ZFOLDERTYPE = 1` (identifier `TrashFolder-…`); also `ZMARKEDFORDELETION` and `ZFOLDER IS NULL` |
| `pinned`, `locked` | `ZISPINNED`, `ZISPASSWORDPROTECTED` |
| `shared` | `ZSERVERSHAREDATA IS NOT NULL` on the note or any ancestor folder. On the live store this set equalled AppleScript's `shared` set exactly |
| Text, words, links, checklists, attachments | The gzipped `ZICNOTEDATA.ZDATA` document, decoded per note: text (field 2), attribute-run links (field 9), `AttachmentInfo` type UTIs (field 12.2), checklist style 103 with done state (field 2.5.2) |
| `tag:` | `ICInlineAttachment` rows with `ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag'`, `ZNOTE1` = note, `ZALTTEXT` = `#tag`, counted only when their `ZIDENTIFIER` is still an object in the body |

Facets come from the body's `AttachmentInfo` types rather than from `ICAttachment`
rows, because rows outlive their objects: on the live store, some top-level
attachment rows (tables and URL previews) were no longer referenced by any note
body, while every referenced row's UTI equalled the body's UTI. The UTI mapping is
`public.url` and inline note links → `has:link` (as are attribute-run links);
`com.apple.notes.table` → `has:table`; `com.apple.paper.doc.scan` and the legacy
`com.apple.notes.gallery` → `has:scan`; `com.adobe.pdf` and `com.apple.paper.doc.pdf`
→ `has:pdf`; `com.apple.paper` and the legacy `com.apple.drawing*` /
`com.apple.notes.sketch` → `has:drawing`; image, video, and audio UTIs → their
facet. Every non-inline object except a table also counts as `has:attachment`.
`has:video` and `tag:` are verified against fixtures only; the store used for
live verification had no video attachments or native tags.

Password-protected notes store an encrypted `ZDATA`, so only title and metadata
predicates can match them.

---

## Protobuf Data Format

### search-notes Body Search

`search-notes` with `searchContent: true` goes through the same reader
(`src/utils/searchContentDb.ts`) before it asks Notes.app. AppleScript's
`notes where body contains "…"` makes Notes.app render and scan every body before
the result loop starts, so `limit` cannot bound it and a broad term ("the") times
out at 30 s even on an ordinary library (#100). The database path builds the query
AST directly — the caller's text is one literal `text` term, never tokenized, so
`title:`, `OR`, `-` and quotes in it are searched literally — plus `folder:`,
`account:` and a `modified >=` node for the other parameters. With no `account`,
it scopes to Notes.app's default account, as the AppleScript path does. It scans
the 5000 most recently modified notes (`QUERY_SCAN.MAX`) and discloses a truncated
window; `limit` is applied as given, not capped at query-notes' 500.

Differences from the AppleScript path, by design: text is matched against the
decoded plain text (title line included) instead of the HTML `body`, so markup
never matches; Recently Deleted and folderless notes are excluded, as in
list-notes; `folder` in results is the list-folders path, not only the leaf name.
Any `NoteQueryStoreError` (no Full Disk Access, unknown schema, sqlite failure)
falls back to AppleScript, and a fallback timeout names Full Disk Access as the fix
when that was why the database was skipped.

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

### Note Body Block Model: Verified Field Map (2026-09-23, macOS 27.2)

`src/utils/noteBlocks.ts` (the `get-note-blocks` tool) decodes these fields.
Evidence came from three places:

- **Proto:** the public [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser)
  `proto/notestore.proto` and its `lib/ProtoPatches.rb` renderer.
- **Survey:** a read-only scan of every `ZICNOTEDATA.ZDATA` blob in one live
  library: 713 rows, 710 decoded, and 3 password-protected rows with encrypted
  bodies. Only field numbers, wire types, and value counts were recorded.
- **Probe:** synthetic notes created with AppleScript HTML in a scratch
  folder, then read back from the database.

Run lengths count UTF-16 code units. Varints are 64-bit, so a negative value
is a 10-byte varint.

**AttributeRun (`Note.5`)**

| Field | Meaning | Evidence | Status |
|---|---|---|---|
| 1 | length (UTF-16 units) | proto; survey 63,400 runs | confirmed |
| 2 | ParagraphStyle | proto; survey 63,393 runs | confirmed |
| 3 | Font {1 name, 2 size (fixed32 float), 3 hints} | proto; probe (`Courier`, 24.0 for `<h1>`); survey hints 1 ×6,162 and 2 ×3 | confirmed. Hints bit 1 = bold, bit 2 = italic |
| 5 | font weight: 1 bold, 2 italic, 3 bold+italic | proto; probe `<b>`=1, `<i>`=2; survey 1/2/3 | confirmed |
| 6 | underline (1) | proto; probe `<u>`; survey 402 | confirmed |
| 7 | strikethrough (1) | proto; probe `<s>`, `<strike>`; survey 8 | confirmed |
| 8 | baseline: 1 superscript, -1 subscript | proto (`superscript`, "sign indicates super/sub"); probe `<sup>`=1, `<sub>`=-1 as a 10-byte varint | confirmed. None in the surveyed library |
| 9 | link URL (string) | proto; probe `https:` and `tel:`; survey 401 | confirmed |
| 10 | Color {1 red, 2 green, 3 blue, 4 alpha}, each a fixed32 float 0–1 | proto; probe `#ff0000` → (1,0,0,1); survey 29 | confirmed |
| 12 | AttachmentInfo {1 identifier, 2 type UTI} | proto; survey 456 | confirmed |
| 13 | varint whose values fall in the Unix-epoch-seconds range (2023–2026) | survey 3,324 runs in 138 notes. The proto names it `unknown_identifier` | **unconfirmed; not decoded** |
| 14 | emphasis (highlight) style: 1 purple, 2 pink, 3 orange, 4 mint, 5 blue | proto (`emphasis_style`) and its renderer's color table | documented, **not observed**: 0 runs in the survey, and AppleScript HTML cannot set it. Decoded; any other value is reported as `unknown` with the raw number |
| 15 | message with four length-delimited subfields | survey: 1 run | **unconfirmed; not decoded** |

**ParagraphStyle (`AttributeRun.2`)**

| Field | Meaning | Evidence | Status |
|---|---|---|---|
| 1 | style type: 0 title, 1 heading, 2 subheading, 4 monospaced, 100 bulleted, 101 dashed, 102 numbered, 103 checklist. Absent or -1 = body | proto; survey saw exactly these values; probe `<ul>`=100, `<ol>`=102, `<tt>`/`<pre>`=4 | confirmed. Other values decode as `unknown` with `styleType` kept |
| 2 | alignment: 0 left, 1 center, 2 right, 3 justify | proto; probe `text-align` center=1, right=2, justify=3; survey 0 ×22,364 | confirmed |
| 3 | varint, 1 on 60,663 of 63,393 styles | survey | **unconfirmed; not decoded** |
| 4 | indent level | proto; probe nested `<ul>`=1; survey 38 | confirmed |
| 5 | Checklist {1 UUID (16 bytes), 2 done 0/1} | proto; survey 301 (25 done) | confirmed |
| 7 | varint 1–8 on list paragraphs (1 on the first numbered item) | survey 1,892; probe first `<ol>` item = 1 | **unconfirmed; not decoded** |
| 8 | block quote (1) | proto (`block_quote`); survey 18 runs in 2 notes, all on body-style paragraphs | confirmed present. AppleScript `<blockquote>` does not set it |
| 9 | paragraph UUID (16 bytes) | survey: all 63,393 styles carry exactly 16 bytes | confirmed as a UUID. **Not unique per paragraph**: 14,939 of 40,985 paragraph-ending runs repeat an earlier paragraph's UUID in the same note, 14,808 of them the adjacent paragraph's |

Behavior the probe also showed:

- AppleScript HTML `<h1>`, `<h2>` and `<h3>` import as bold body text with a
  larger font. They do not set the Title, Heading or Subheading style.
- AppleScript's HTML export drops superscript, subscript, alignment and
  highlight. A full-body rewrite through AppleScript loses them.
- The legacy `decodeVarint` in `protobuf.ts` rejects varints longer than 35
  bits, so `parseRichNote` throws on a subscript run and such notes read as
  non-writable. The block model uses the lossless `decodeWireFields` instead.

The decoder takes paragraph attributes from the run that covers a
paragraph's first character. In the survey every run of a paragraph carried
the same visual style (40,989 of 40,989 paragraphs). Field numbers it does
not interpret are counted in `undecodedFields` rather than guessed.

### Links, Attachments and Note State (verified 2026-09-23, macOS 27.2)

`src/utils/noteLinks.ts`, `src/utils/noteStructure.ts` (the
`get-note-structure` tool) and `src/utils/noteLinkInventory.ts` (the
`list-note-links` tool) read these, through the shared helpers in
`noteStoreSql.ts` and `attachmentAssets.ts`. Counts come from a read-only survey of
one live library with 843 note rows; no content was recorded.

**Entity numbers and account keys vary.** Look up `Z_ENT` by class name in
`Z_PRIMARYKEY` (`ICNote`, `ICAttachment`, `ICInlineAttachment`,
`ICAttachmentPreviewImage`, `ICFolder`, `ICAccount`, `ICMedia`). Each entity
stores its account in a different column (notes `ZACCOUNT7`, folders
`ZACCOUNT8`, attachments `ZACCOUNT1`, inline attachments `ZACCOUNT4` on this
schema), so the reader coalesces every `ZACCOUNT<n>` column (`accountRef`).

**Link kinds.**

| Kind | Storage |
|---|---|
| inline | AttributeRun field 9 on the text run (see the block model above) |
| card | `ICAttachment` with `ZTYPEUTI = 'public.url'`; destination in `ZURLSTRING`, card title in `ZTITLE` (39 of 39 cards had both; `ZTITLE1` was always null for attachments) |
| note / section | `ICInlineAttachment` with `ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.link'`; URL in `ZTOKENCONTENTIDENTIFIER`, chip label in `ZALTTEXT`. A section chip's URL carries `paragraphID`. None existed in the surveyed library, so this row is from the Core Data model, not observation |

**Notes deep-link format.** Notes.app registers the `notes` and `applenotes`
URL schemes (`CFBundleURLTypes` in its Info.plist), and its binary contains
the literal `applenotes://showNote?identifier=`. The URL handler's query-key
string table in the system's shared library cache lists `identifier`,
`paragraphID`, `attachmentID` and `contentOffsetY`, next to the selectors
`appURLForNote:paragraphID:` and `paragraphIDForURL`. A paragraph link is
therefore `applenotes://showNote?identifier=<NOTE-UUID>&paragraphID=<PARAGRAPH-UUID>`,
with the key spelled exactly `paragraphID`.

**Attachment hierarchy.** `ZPARENTATTACHMENT` links a child to its container:
galleries hold their images, and each of the 6 audio recordings held one
`public.mpeg-4-audio` child. Notes shows only the parent, so top-level counts
exclude children.

**Preview renditions.** Each `ICAttachmentPreviewImage` row (283 surveyed)
points at its attachment through `ZATTACHMENT` and records `ZWIDTH`,
`ZHEIGHT`, `ZSCALE` and `ZAPPEARANCETYPE` (0 light, 1 dark). Its
`ZIDENTIFIER` (`<attachment-uuid>-<n>-<W>x<H>-<n>`) names the rendition under
`Accounts/<account-identifier>/Previews/`: 165 were flat `<id>.png` files,
102 were bundle directories holding `<n>_<uuid>/Preview.png`, and 16 had no
file on disk. Because the name starts with the attachment identifier,
`get-note-structure` finds previews the same way `list-attachments` does
(`previewPaths` in `attachmentAssets.ts`, largest pixel area first), so the
two tools report the same `previewPath`.

**Last viewed.** `ZLASTVIEWEDMODIFICATIONDATE` holds Apple-epoch seconds. The
model makes it non-optional, and a note that was never opened holds exactly
`-541228980` (1983-11-07T18:37:00Z): 748 of 843 notes, stored as an integer.
The other 95 were real dates. The reader returns null for that value, for
NULL, and for anything before 2007 or in the future.

**Sharing.** This schema has no `ZISSHARED` column. A note counts as shared
when its own `ZSERVERSHAREDATA` or that of its folder (or an enclosing
folder) is set. That rule selected 53 notes, the same 53 distinct notes
AppleScript reports with `shared = true`.

**Link inventory.** Cards and native chips are rows, so `list-note-links`
lists them across a scope in one query. Inline links exist only inside note
bodies (330 in the 448 notes outside Recently Deleted in the survey), so a
folder, account or library scan decodes bodies only when asked, 100 rows per
batch. The scope uses the same active-note predicate as the other listings
(`activeNoteSql`, which also treats a `TrashFolder%` folder identifier as
Recently Deleted). A folder scope walks the `ZPARENT` hierarchy with a
recursive query bound only to the folder's primary key, so subfolders are
included unless the caller turns that off.

### Embedded Objects

The Unicode replacement character `￼` (U+FFFC) marks attachment positions. Each has a corresponding `AttachmentInfo` in the AttributeRun with type and UUID.

### Paragraph Links (verified 2026-09-23, macOS 27.2)

`src/utils/noteParagraphs.ts` (the `list-note-paragraphs` and
`get-paragraph-link` tools) builds and guards these links.

**Format.** Notes opens a paragraph from
`applenotes://showNote?identifier=<NOTE-UUID>&paragraphID=<PARAGRAPH-UUID>`.
No note in the surveyed library held a Notes-generated section link to copy
the format from, so it was confirmed from Notes itself without opening a
link: Notes.app registers the `notes` and `applenotes` URL schemes
(`CFBundleURLTypes`), its binary holds the literal
`applenotes://showNote?identifier=`, and the URL handler's query-key string
table in the system's shared library cache lists `paragraphID` (with
`identifier`, `attachmentID` and `contentOffsetY`) beside the selectors
`appURLForNote:paragraphID:` and `paragraphIDForURL`. The key is spelled
exactly `paragraphID`. UUIDs are written uppercase, as `NSUUID` prints them.

**Where the paragraph UUID lives.** ParagraphStyle field 9 (16 bytes) on each
attribute run, as in the block model above. A run that crosses a paragraph
break carries one UUID for both paragraphs, which is how Notes ends up with
repeated IDs after a split.

**When a link is safe.** The reader takes the UUID on the paragraph's first
run and returns a link only if no run outside that paragraph (from its first
character through its newline) carries the same UUID. Otherwise the link
could open another paragraph, so the tools refuse. A survey of 738 decodable
note bodies in one live library (counts only) found 30,362 non-empty
paragraphs: 17,553 with a unique ID, 12,807 sharing one, and 2 with none.
Every title (78), heading (18) and subheading (7) was unique; body text was
roughly half and half. A paragraph whose runs carry more than one UUID is
common and reported as `mixedParagraphIds`; its first-run UUID is still used.

### CRDT Implementation

Tables and collaborative editing use Conflict-Free Replicated Data Types (CRDTs). Apple uses "topotext" for synchronization with first-write-wins conflict resolution via iCloud.

### Stored Audio Transcripts (verified macOS 27)

Notes stores the transcript it computes for an audio recording on the recording's attachment row (`ZTYPEUTI = 'com.apple.m4a-audio'`, `ZPARENTATTACHMENT IS NULL`) in `ZICCLOUDSYNCINGOBJECT.ZMERGEABLEDATA1`. Unlike table data, the blob is plain protobuf, not gzipped. Its root holds the object entries (field 3), the key names (4), the type names (5) and the UUIDs (6). The dedicated columns `ZTEMPORARYTRANSCRIPTDATA` and `ZSUMMARY` were empty on every audio row checked. `get-audio-transcripts` decodes the blob as follows:

- One `com.apple.notes.ICTTAudioRecording` custom map (entry field 13). Its `fragments` key points to a list (entry field 5) of `ICTTAudioRecording.Fragment` maps.
- Each fragment's `identity` is the `ZIDENTIFIER` of a child attachment (`public.mpeg-4-audio`, `ZPARENTATTACHMENT` = the recording). The child row carries that take's `ZDURATION`. The parent's `ZDURATION` was 0 on some recordings, so the tool falls back to the sum of the child durations.
- A fragment's `transcript` points to an ordered set in entry field 15. Field 15.1 holds a topotext note plus `{1: index, 2: 16-byte UUID}` pairs that give the order. Field 15.2 is a dictionary from an `NSUUID` map (whose `UUIDIndex` points into root field 6) to a segment object.
- Each `ICTTTranscriptSegment` is one recognized word. `text` and `speaker` are registers (entry field 1) that point to an `NSString` map (`self`, field 4). `timestamp` and `duration` point to an `NSNumber` map (`doubleValue`, a little-endian fixed64 double in field 3, in seconds). Words usually carry their own leading space.
- `summary` and `topLineSummary` are registers that point to a topotext note (entry field 10). They are empty unless Notes generated a summary.

On the test library, 6 of 6 recordings decoded, each with one fragment. Timestamps in ordering-index order are mostly monotonic, with small backward steps where speakers overlap. Recordings with several fragments were not available, so fragment concatenation in list order is covered by synthetic fixtures only.

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

## App Intents and the Shortcuts Bridge

Apple Notes ships App Intents (the `Metadata.appintents` bundle is present inside
`Notes.app` on macOS 27), which raises an obvious question: can the server call them to
do the things AppleScript cannot, such as pinning, tagging, or appending a checklist item?
This was researched in June 2026 and verified against the live `shortcuts` CLI on macOS 27
and Apple's developer documentation.

### There is no cross-app App Intent invocation

App Intents are a one-way, app-to-system contract. An app *exposes* its actions through an
`AppIntent`'s `perform()` method, and the **system** (Siri, Spotlight, Shortcuts, Apple
Intelligence) is the only caller. There is no public API to enumerate, reference, or
`perform()` another app's intents from your own process. A native Swift helper therefore
cannot invoke Notes' App Intents directly; it could only drive Notes through the same
AppleScript the server already uses, with a worse permissions story. This is consistent
with Apple's `AppIntent` documentation and the SiriKit donation model, where
`INInteraction.donate()` only informs Siri and does not execute anything.

### The only route is `shortcuts run` against a user-installed Shortcut

The `shortcuts` CLI runs a *named, already-installed* Shortcut
(`shortcuts run "<name>" -i <input> -o <output>`). It cannot run a `.shortcut` from a file
path, and it cannot invoke an App Intent directly, so each capability has to be wrapped in
a Shortcut the user installs once. There is no headless import: adding a `.shortcut` always
needs a GUI confirmation click (`shortcuts sign` only changes which prompt appears).

The constraints that make this a BETA, opt-in path rather than a default:

- **Needs an active GUI login session.** `shortcuts run` drives the Shortcuts app and is
  not documented to work at the login window, over plain SSH, or from a `launchd`
  background agent. Only `shortcuts list` is fully GUI-free.
- **One-time manual install** of each wrapper Shortcut, plus one foreground run in
  Shortcuts.app after install or upgrade to answer its first-run consent prompt with
  Always Allow. A background run cannot display that prompt, so it stalls until the
  transport timeout instead, and the CLI exposes no consent state to check first (#172).
- **Plain text only.** Notes actions take rich text or attachments only through their
  interactive compose sheet, which defeats automation.
- **Coarse results.** Exit code 0 or 1 with output on stdout; no structured error surface.

### What a Shortcuts bridge can and cannot add

| Reachable through a wrapper Shortcut | Not exposed as a Shortcuts action |
|--------------------------------------|--------------------------------------|
| Pin / unpin a note | Prepend to a body ¹ |
| Add / remove / create / delete tags | Toggle a checklist item done/undone |
| Move to folder; create / delete folder | Insert a table or import CSV |
| Append a checklist item | Insert a note-to-note link |
| Append plain text to a body | Rich text / Markdown body writes |
| Attach a file | Attach a URL / link |
| Find notes (plain-text result) | Get a note's full contents |

The right-hand column is scoped to the **Shortcuts** inventory — Notes ships no
action for these. It does not mean the capability is unreachable altogether.

¹ Prepend needs no bridge: `append-to-note` (2.6.0) does it over plain
AppleScript with `position: "before"`, by reading the body, splicing the new
block in after the title `<div>`, and writing the whole body back.

### macOS version gating

Apple's "What's new in Shortcuts" pages omit Notes actions, so per-version attributions
come from secondary sources and should be feature-detected at runtime rather than gated on
`sw_vers`:

- **Long-standing (macOS 13 and earlier):** Create Note, Append to Note, Find Notes, Show
  Note / Folder, Rename Folder.
- **Sequoia 15:** Pin Notes, Delete Notes, Move to Folder, Create / Delete Folder, and the
  tag actions (Add / Remove / Create / Delete Tag).
- **Tahoe 26:** Add File, Append Checklist Item (secondary-sourced; verify at runtime).

### Packaging note

If a native helper is ever shipped for the AppleScript path, the packaging is light:
`npm install` does not set the quarantine xattr, ad-hoc signing is enough to run (and is
mandatory on Apple Silicon), and notarization is optional for an npm-delivered CLI. But
TCC attributes the Automation prompt to the host app (the MCP client), not the helper, so a
compiled helper is no better than the in-process AppleScript on permissions and is not
worth the complexity.

### Verdict

Keep AppleScript as the primary engine. If write coverage for pin and tags is wanted, add
a BETA, opt-in Shortcuts bridge scoped to the reachable actions above, with the
GUI-session constraint documented loudly and runtime feature detection instead of version
gating. Do not invest in a Swift App Intents helper; it cannot do the cross-app thing that
would justify it. Markdown-interpreted body writes, checklist toggling, tables, and
*inserting* note-to-note links stay GUI-only under every known approach.

**Update (2026-07, apple-notes-mcp 2.6.0).** Two items on that GUI-only list turned out
not to need a bridge at all, and the verdict above is narrowed accordingly:

- **Prepend** ships as `append-to-note` with `position: "before"`, over plain AppleScript.
  It reads the existing HTML body, splices the new block in after the title `<div>`, and
  writes the body back — a full-body rewrite, not an in-place edit, so the
  attachment caveat still applies. Rich HTML *is* preserved on that round trip, so
  "rich-body manipulation" was too broad; what remains unavailable is having Notes
  interpret Markdown on write.
- **Reading a note-to-note link** ships as `get-note-link`, which returns the
  `notes://showNote?identifier=<uuid>` deep link (primary path: `ZIDENTIFIER` read
  read-only from `NoteStore.sqlite`, needs Full Disk Access; AppleScript `note link`
  fallback on macOS 12–15). Inserting a link into a body, and enumerating the links
  already in one, remain unavailable.

---

## Private helper (NotesShared)

An opt-in, **read-only** native helper
(`native/private-helper/apple-notes-private-helper.m`) reads note state through
Notes' own Core Data model. It is the foundation for features that have no
AppleScript or Shortcuts interface (checklist state, highlights, structured
edits, Smart Folders), but it **cannot write**: write support was deliberately
deferred by the maintainer (see "Why writes were deferred" below). It is
**unsupported Apple API**.
The findings below were verified on macOS 27.2 (build 26B5091g) with Notes 4.13
(3195.41.8.101.1) on 2026-09-23, by runtime introspection
(`objc_copyClassNamesForImage`, `class_copyMethodList`,
`class_copyPropertyList`) and by running the helper.

### Why Objective-C, and how it loads the framework

The helper is one Objective-C file compiled on the user's Mac with
`xcrun clang` from the Command Line Tools and ad-hoc signed. Objective-C needs
no Swift runtime or package manifest and calls private classes by name
naturally. Linking `-framework NotesShared` is refused for ordinary clients
("not an allowed client"), so the helper links only Foundation, CoreData, and
AppKit, `dlopen`s
`/System/Library/PrivateFrameworks/NotesShared.framework/NotesShared`, and
resolves everything with `objc_getClass` / `objc_msgSend`. Selectors are
compile-time constants; no request field ever becomes a selector.

### Opening the store the way Notes does

`ICNoteContext` (the object Notes.app uses) does not build its store in a
headless process and has no way to point at another file. The helper instead:

1. takes the model from `+[ICPersistentContainer managedObjectModel]` and the
   options from `+[ICPersistentContainer standardStoreOptions]` (on 27.2:
   automatic migration, inferred mapping, persistent history tracking, and
   remote-change notifications);
2. turns migration **off** (a model/store mismatch means the helper is out of
   date, never a reason to migrate the user's library) and always adds
   `NSReadOnlyPersistentStoreOption`: there is one store opener,
   `OpenReadOnlyContext()`, and no read-write variant;
3. attaches `NoteStore.sqlite` to its own `NSPersistentStoreCoordinator`, then
   refuses with `read_only_violation` if Core Data reports any attached store
   as writable;
4. fetches real `ICNote` objects by `identifier`.

Opening a store that is not the live one needs only a different file URL
(`APPLE_NOTES_MCP_PRIVATE_STORE`, for reading a copy; the helper refuses any
path that resolves to the live store, including symlinks and hard links).

### API surface used

| Kind | Name | Used for |
|------|------|----------|
| class methods | `+[ICPersistentContainer managedObjectModel]`, `+standardStoreOptions` | model and store options |
| model properties | `ICNote.identifier/title/modificationDate/creationDate/folder/account/noteData/cloudState/isPasswordProtected/markedForDeletion/needsInitialFetchFromCloud`, `ICNoteData.data`, `ICCloudState.currentLocalVersion/latestVersionSyncedToCloud`, `ICFolder.identifier` | reads, flags, change token |
| instance methods | `-[ICNote mergeableString]`, `-isDeletedOrInTrash`, `-isSharedViaICloud`, `-isEditable` | body length and flags |
| instance methods | `-[ICTTMergeableString attributedString]` | body text (read) |

Core Data attributes are `@dynamic`, so `respondsToSelector:` is false for
them until Core Data generates accessors. The probe therefore checks model
properties against the entity descriptions and real methods with
`instancesRespondToSelector:`. On 27.2 the mergeable string is an
`ICTTMergeableAttributedString` whose `-string` returns an attributed string;
the helper reads text from `-attributedString`. Paragraph style lives in the
`TTStyle` attribute (`ICTTParagraphStyle`) and rides on each paragraph's
terminating newline.

Fetching an `ICNote` logs a `+[ICNoteContext sharedContext]` backtrace from
`ICAuthenticationState` because no shared context exists in the helper. It is
a log line, not a failure; reads proceed.

### Protocol

One JSON object on stdin (1 MiB cap), one on stdout, exit 0 on success and 1
on error with `{status:"error", code, message}`. Every request carries
`protocol: 1`; a mismatch is `protocol_mismatch`. Unknown actions and unknown
request fields are refused. Actions: `hello` (context-free handshake,
reports the source SHA-256 compiled in and `readOnly: true`), `probe`, and
`read_note_state`. There is no write action; `append_plain_text` or any other
name is `unknown_action`, and the TypeScript client refuses anything outside
its read-only whitelist before spawning. Error codes: `input_too_large`,
`invalid_json`, `protocol_mismatch`, `unknown_action`, `invalid_request`,
`disabled`, `store_unavailable`, `read_only_violation`,
`private_api_unavailable`, `not_found`, `unsupported_note`, `internal_error`.
The MCP tools map these onto the shared error envelope (`code`, plus the raw
`helperCode`). Adding an action is a handler plus one row in `kActions` and,
when it needs new selectors, one requirement table the probe reports; it
must be read-only (`src/services/privateHelperReadOnly.test.ts` fails on a
save or write path).

### Safety contract

- **Off by default.** Both the server and the helper refuse to open the live
  store unless `APPLE_NOTES_MCP_ENABLE_PRIVATE=1`.
- **Fail closed on install drift.** Setup records the source and binary
  SHA-256 in `manifest.json`; the server re-checks both, and the protocol,
  before every call.
- **Read-only by construction.** Every store is opened with
  `NSReadOnlyPersistentStoreOption` and migration disabled, a writable store
  is refused after opening, and no code path saves a context. Setup refuses
  to install a helper whose `hello` does not report `readOnly: true` or lists
  any action outside the read-only whitelist.
- **Change token, not a lock.** `revision` (`r1:` + SHA-256) covers the note
  identifier, folder identifier, deletion and lock flags, modification date,
  and a digest of the serialized body (`ICNoteData.data`). Compare two reads
  to detect a persisted change; nothing accepts it back.
- **Never SQL, never a shell, never a caller-chosen selector.**

### Build, distribution, and TCC

`apple-notes-mcp setup --native-helper` compiles the packaged source
(`native/` ships in the npm package; no binary is committed or published),
signs it ad hoc, runs `hello` against the staged binary (which must report
`readOnly: true` and only read-only actions), and installs it with
its manifest under `~/Library/Application Support/apple-notes-mcp/private-helper`
(`APPLE_NOTES_MCP_PRIVATE_HELPER_DIR` overrides). Upgrading apple-notes-mcp
with a changed helper source makes the installed helper `helper_stale` until
setup runs again.

The helper opens `NoteStore.sqlite` itself, so it needs Full Disk Access.
macOS attributes a command-line child process to the app responsible for it
(Claude Desktop, Terminal), so in practice the helper uses the same grant as
the server's existing `sqlite3` reads. That was observed here only in the
positive case (a host with Full Disk Access; the helper opened the store); a
host without it gets `store_unavailable`. Because the helper is ad-hoc
signed and rebuilt on upgrade, it should not be added to Full Disk Access by
itself.

### Why writes were deferred

PR #204 originally included an `append_plain_text` action (a CRDT insert
through `ICTTMergeableString`, saved with `-saveNoteData` and
`-updateChangeCountWithReason:`, guarded by an `ifRevision` compare-and-swap
and verified by a fresh read-back). The maintainer accepted the helper
read-only and removed that path before merge, because three things are
unresolved:

1. **A second writer beside a running Notes.app.** The helper saved through
   its own coordinator while Notes.app held the same store; persistent history
   carried the change into Notes.app, but concurrent-save behaviour beyond one
   optimistic save was not characterised.
2. **CRDT replica identity.** The helper edits the note's CRDT as its own
   replica, like a new device. How NotesShared assigns that identity in a
   process with no bundle identifier was not inspected; repeated edits may
   add replica entries to the note.
3. **iCloud upload lag.** In the contributor's live test on macOS 27.2 the
   edit appeared in the running Notes.app at once and raised
   `currentLocalVersion` above `latestVersionSyncedToCloud`, but was not
   uploaded in 13 minutes of polling; it uploaded only when Notes.app next
   saved its own change to that note. The helper cannot upload itself
   (CloudKit needs Notes.app's private entitlements).

A future write PR needs evidence on all three first.

### Risks

- Any macOS update can rename or remove a class, selector, or model property.
  The probe then reports `private_api_unavailable` with the missing names; a
  changed model without migration makes the store fail to open
  (`store_unavailable`) rather than migrate.
- Reads go through a private model; a field's meaning can change without
  notice. Treat `native-note-state` as diagnostic, not as a contract.

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

### Note Creation: Body-Only Approach

When creating notes via AppleScript, setting both the `name` property and the `body` causes title duplication — the title appears twice in the rendered note. The fix is to set only the `body`, with the title prepended as an `<h1>` tag. Apple Notes derives the note's display title from the first element in the body HTML. This approach works for both plaintext (converted to HTML) and HTML format content.

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

### App Intents & Shortcuts Bridge (2026 research)
- Apple Developer - [AppIntent](https://developer.apple.com/documentation/appintents/appintent) and [App Intents overview](https://developer.apple.com/documentation/appintents): `perform()` is system-invoked; no cross-app call path.
- Apple Support - [Run shortcuts from the command line](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac), cross-checked against the live `shortcuts --help` on macOS 27: `run` takes a named shortcut, not a file path or an intent.
- Shortcuts action catalogs - [matthewcassinelli.com action library](https://matthewcassinelli.com/actions/) and MacStories Shortcuts coverage for the per-action Notes capability list and macOS-version debuts (secondary; feature-detect at runtime).

---

*Last updated: 2026-06-23 (added App Intents bridge feasibility and live-verified read-only SQLite metadata columns)*
