# Apple Notes Technical Documentation

This document contains research findings on Apple Notes internals, programmatic access methods, and known limitations. It serves as a reference for improving the apple-notes-mcp project.

## Table of Contents

- [Data Storage Architecture](#data-storage-architecture)
- [AppleScript API](#applescript-api)
- [Direct Database Access](#direct-database-access)
- [Protobuf Data Format](#protobuf-data-format)
- [Alternative Approaches](#alternative-approaches)
- [Private helper (NotesShared)](#private-helper-notesshared)
- [Private writer](#private-writer)
- [Permissions check](#permissions-check)
- [Template editor server](#template-editor-server)
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
| `quicknote` | `ZISSYSTEMPAPER`, the flag `list-special-notes kind=quick-notes` reads |
| `shared` | `ZSERVERSHAREDATA IS NOT NULL` on the note or any ancestor folder. On the live store this set equalled AppleScript's `shared` set exactly |
| Text, words, links, checklists, attachments | The gzipped `ZICNOTEDATA.ZDATA` document, decoded per note: text (field 2), attribute-run links (field 9), `AttachmentInfo` type UTIs (field 12.2), checklist style 103 with done state (field 2.5.2) |
| `tag:` | `ICInlineAttachment` rows with `ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag'`, `ZNOTE1` = note, `ZALTTEXT` = `#tag`, counted only when their `ZIDENTIFIER` is still an object in the body |

Facets come from the body's `AttachmentInfo` types rather than from `ICAttachment`
rows, because rows outlive their objects: on the live store, some top-level
attachment rows (tables and URL previews) were no longer referenced by any note
body, while every referenced row's UTI equalled the body's UTI. The UTI mapping is
`public.url` (link preview cards) → `has:url` and `has:link`; inline note links →
`has:link` (as are attribute-run links); `com.apple.mapkit.map` → `has:map`;
`com.apple.notes.table` → `has:table`; `com.apple.paper.doc.scan` and the legacy
`com.apple.notes.gallery` → `has:scan`; `com.adobe.pdf` and `com.apple.paper.doc.pdf`
→ `has:pdf`; `com.apple.paper` and the legacy `com.apple.drawing*` /
`com.apple.notes.sketch` → `has:drawing`; image, video, and audio UTIs → their
facet. Every non-inline object except a table also counts as `has:attachment`.
`has:video` and `tag:` are verified against fixtures only; the store used for
live verification had no video attachments or native tags. `has:map` is verified
against fixtures only; the live store had no map attachment.

`scanLimit` goes up to 10,000 (`QUERY_SCAN.MAX`). The cost is latency, not
correctness: each scanned note's body is decompressed when the query needs it.
`search-notes` keeps its own fixed 5,000-note window
(`SEARCH_CONTENT_SCAN_LIMIT`), because it has no scan parameter and every body
search would pay for the larger window.

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
the 5000 most recently modified notes (`SEARCH_CONTENT_SCAN_LIMIT`) and discloses a truncated
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

### Vector Drawings in HTML Export

`export-notes-html` renders classic PencilKit drawings (`com.apple.drawing.2`,
`com.apple.drawing`) as SVG instead of Notes' `FallbackImage.png`
(`src/services/exportVectorDrawings.ts`). Before rendering, it decodes every
classic drawing in the selected notes through the same path as
`get-note-drawings`: the PencilKit bytes are read read-only from the
attachment row's `ZMERGEABLEDATA1` (`ZMERGEABLEDATA` on older schemas) and
decoded by the public helper's `decode_drawing` action, and `drawingToSvg`
builds the document. The attachment identifier (`ZIDENTIFIER`) links a decoded
drawing to its body marker. The SVG goes through the export's asset writer as
generated bytes (`AssetWriter.placeBytes`): an `image/svg+xml` data URL under
the same 10 MiB per-asset and 256 MiB per-document limits, or a create-only
`.svg` file in the sidecar directory. It is referenced with `<img>`, so the
SVG is displayed as an image and never scripted, and a white background keeps
dark ink legible in dark mode.

Every failure falls back to the raster path, drawing by drawing, and is
counted by code in the receipt's `vectorDrawings.fallbackReasons`. A helper
that is not built, stale or modified throws once for the whole note, so
decoding stops for the rest of the export; one `timeout` also stops it,
since each further attempt would wait the full helper timeout. A drawing the
helper marked `truncated` (stroke or point limit) falls back too, because the
PNG is complete. Paper drawings (`com.apple.paper`) are never sent to the
helper: no public API decodes them.

Verified on 2026-09-24 (macOS 27.2) against three live notes with classic
drawings, read-only, with a helper built into a scratch directory
(`APPLE_NOTES_MCP_PUBLIC_HELPER_DIR`): all three drawings rendered as SVG in
embedded and sidecar mode, the Paper drawings beside them kept their PNG, and
without a usable helper each drawing fell back with `helper_not_installed`.

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

### Paragraph Anchors

`src/utils/paragraphAnchors.ts` (matching and resolution, read-only),
`src/services/anchorRegistry.ts` (the registry file) and
`src/services/paragraphAnchorOps.ts` (record, resolve with refresh or
re-mint, prune) back the five anchor tools and the resolver service.

**What an anchor stores.** The note's `ZIDENTIFIER` (uppercase; the
`x-coredata` id is kept only as a hint, since it is local to one Mac), the
first-run paragraph UUID and its status, the paragraph text normalized as for
paragraph selection (NFKC, U+FFFC removed, whitespace collapsed, lowercase),
a fingerprint (the first 32 hex digits of SHA-256 of that text), the
fingerprints of the previous and next non-empty paragraphs (null at the
note's edges), the block index, the style and the creation time.

**Matching.** Against the note's current non-empty paragraphs:

1. Paragraph UUID. If exactly one paragraph's first run carries the UUID and
   its status is `unique`, it is the match (confidence 1 when the text is
   unchanged, 0.8 to 0.95 when edited). This is safe even for a heavily edited
   paragraph, because a link to that UUID opens that paragraph and nothing
   else. If several paragraphs carry it (a split or a copy), only an exact
   text match among them counts, with the neighbours breaking a tie.
2. Exact fingerprint anywhere in the note: 0.95 with a matching neighbour,
   0.85 without. Several equal fingerprints are narrowed to the single one
   with the most matching neighbours (at least one); otherwise `ambiguous`.
3. Text similarity (the Dice coefficient of character trigrams) for
   paragraphs with both recorded neighbours in place and similarity 0.5 or
   more, or one neighbour and 0.8 or more. Score = 0.4 × similarity + 0.2 ×
   matching neighbours. A runner-up within 0.1 of the best gives `ambiguous`;
   a best score under `minConfidence` (default 0.6) gives `low-confidence`.
   Only a match is ever linked. In practice one neighbour is enough only for
   nearly identical text.

Neither position alone nor the block index is ever used to choose, because
both shift with every insertion above the paragraph. A matched paragraph
whose UUID is `shared` or `missing` gives `needs-reminting`: the resolver
knows where the paragraph is but cannot produce a link that is certain to
open it.

The note itself is found by `ZIDENTIFIER` (bound upper and lower case, since
Notes stores some identifiers lower-case). A note in Recently Deleted or
marked for deletion is `note-deleted`, a locked or undecodable body is
`note-unreadable`, and a purged note is `note-not-found`. None of these
reaches the matcher.

**Re-minting hook.** Public automation cannot set a paragraph UUID. The
module exports `setParagraphIdReminter(fn)`. A registered function receives
`{ anchorId, noteId, noteIdentifier, blockIndex, expectedText,
currentParagraphId }`, must refuse when the block's text no longer equals
`expectedText`, and resolves with the new UUID only after its write is
committed and verified. `resolve-paragraph-anchor` with `remint: true` then
reads the note again and resolves as usual, so the new link is still checked
for uniqueness. Without a registered function the tool reports
`remint.reason: "writer-unavailable"`; when the function throws it reports
`writer-failed` with the message and, for a writer error, its `committed`
state.

The server registers one at startup only when both writer switches are on
(`src/services/privateWriterReminter.ts`). It reads the note's `revision`
through the writer's read-only `read_note_state`, then calls
`set_paragraph_id` with that revision as `ifRevision` and the resolver's
`blockIndex` and `text` as `expectedText`. The writer's own checks do the
rest: a changed note is `revision_conflict`, a changed paragraph is
`paragraph_changed`, and its read-back verifies that the new UUID is unique.
`native-set-paragraph-id`'s live-validation gate applies unchanged. The
copy-store script records an anchor for a shared or missing paragraph on the
copy and heals it this way.

**Registry.** One JSON file, `{ "version": 1, "anchors": [...] }`, at
`APPLE_NOTES_MCP_ANCHOR_FILE` or `~/Library/Application
Support/apple-notes-mcp/paragraph-anchors.json`. Changes take
`<file>.lock` (`O_EXCL`, waited on for up to 3 s, removed when older than 30
s), re-read the file, write `.paragraph-anchors.<random>.tmp` with mode 0600
and `fsync`, and rename it into place. The directory is created 0700. The
file and its directory are opened without following symlinks, a record with
a missing or mistyped field makes the whole file `corrupt-registry`, and a
corrupt file is never rewritten. The limit is 20,000 anchors.

**Resolver service.** `apple-notes-mcp anchors serve`
(`src/services/anchorServer.ts`) answers `GET /a/<anchor-id>` with a 302 to
the current `applenotes://` link when the anchor resolves, and a plain-text
409 or 404 otherwise. It binds 127.0.0.1, or with `--tailnet` the first IPv4
in 100.64.0.0/10 found by `os.networkInterfaces()` (utun interfaces first),
through the same `findTailnetAddress` as the template editor
(`src/utils/localServer.ts`). It never runs `tailscale` or changes any
configuration. The request checks
run in this order: the failed-token limit (429), the method (GET or HEAD),
the Host header (the bound address, or `localhost` on loopback), and the
token (`?token=` or `Authorization: Bearer`, compared with `timingSafeEqual`),
before the path is looked at. The token is in the query string because a link
opened from another app cannot add a header; `Referrer-Policy: no-referrer`
and `Cache-Control: no-store` keep it from leaking onward, and the request
log records only the method, path and status.

**Custom URL scheme (not built).** A scheme such as `notes-anchor://<id>`
would let a link work without a running server, but only on a Mac with a
handler installed. The handler would be a small signed app bundle that
declares the scheme in `CFBundleURLTypes`, receives the URL through
`NSAppleEventManager` (`kAEGetURL`), resolves the anchor with the same code
(it needs Full Disk Access of its own), and opens the result with
`NSWorkspace.open`. It must refuse anything but a well-formed anchor id and
open only `applenotes://showNote` URLs. It is left out because it adds a
separately signed app and its own privacy grant for a narrow benefit over the
loopback server; the resolution code needs no change to support it.

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

## Private writer

The writer keeps the read-only helper above exactly as merged and adds writes
as a **separate, opt-in layer**, for when the hold in "Why writes were
deferred" is lifted.

### Separation from the read-only helper

| | Read-only helper | Writer |
|---|---|---|
| Source | `apple-notes-private-helper.m` | `apple-notes-private-writer.m` |
| Binary / manifest | `apple-notes-private-helper` / `manifest.json` | `apple-notes-private-writer` / `writer-manifest.json` |
| Setup | `setup --native-helper` (refuses any write action) | `setup --native-writer` (refuses an action table that differs from the client's) |
| Client | `privateHelper.ts`, `READ_ONLY_ACTIONS` | `privateWriter.ts`, `WRITER_ACTIONS` (each `read` or `write`) |
| Switches | `APPLE_NOTES_MCP_ENABLE_PRIVATE=1` | that **and** `APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1` |

Both live in the same install directory but never share a file. The
read-only source test (`privateHelperReadOnly.test.ts`) still enforces every
read-only rule on the helper source, and also checks that the helper source,
`privateHelper.ts`, and `privateHelperBuild.ts` never mention the writer, that
the read-only build compiles only the helper source, and that no writer
`write` action is in `READ_ONLY_ACTIONS`. `privateWriterSource.test.ts` pins
the writer's own contract.

### Write contract

Every write action in the writer:

1. is refused before spawning unless both switches are on, and, until it has
   passed live validation in a release, `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1`;
2. is refused by the writer itself (`writes_disabled`, `committed: false`)
   when it would open the live store read-write without
   `APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1`;
3. takes an `ifRevision` token and compares it with the persisted note's
   `revision` (the same `r1:` digest the read-only helper reports) before
   changing anything (`revision_conflict`, `committed: false`);
4. edits through NotesShared's model (the CRDT for body text), never SQL, and
   saves with `NSErrorMergePolicy`, so a concurrent Notes.app save wins and the
   writer's save fails with nothing written;
5. re-reads the note through a brand-new coordinator opened read-only and
   compares the result with the intended change; a mismatch is
   `verification_failed` with `committed: true`;
6. reports `committed` on every failure after spawning; a timeout or an
   unreadable response is `committed: "unknown"`, which the MCP envelope
   reports as `indeterminate: true`.

The writer never uploads. Results carry `pushScheduled: false`, the
`cloudSync` counters, and `pushState` (`awaiting_notes_app` when Notes.app is
running, else `queued_for_next_launch`).

### Sync nudge

The writer's read-only `read_sync_state` action reports Notes' own counters
(`currentLocalVersion`, `latestVersionSyncedToCloud`, `uploadPending`) for up
to 50 notes or folders plus the library's pending-upload count. Observed on
macOS 27.2 on 2026-09-23 with an earlier prototype of this writer: Notes.app merges a
helper save and queues the note, but when it already holds that note in
memory its upload check reads cached counters and skips it. Moving the note
through AppleScript into the folder it is already in makes Notes.app save it
itself (only `folderModificationDate` changes), and the upload was recorded
6 to 12 seconds later in five trials. `privateSyncNudge.ts` implements that
move, refuses locked, shared, trashed, non-iCloud, and folder targets, and
compares the writer's revision token before and after (`contentUnchanged`).
`native-append-plain-text` runs it with `nudge: true`. `uploadRecorded` is
Notes' own record that the server accepted the version, not a cross-device
check.

`native-sync-push` runs the same code on its own, for changes written earlier
without a nudge or whose nudge timed out: `status` only reads `read_sync_state`,
`nudge` moves pending notes in place, and `relaunch` (only with
`confirm: true`) quits Notes.app through AppleScript, waits up to 20 s for the
process to exit, and reopens it in the background (`open -g -a Notes`), so its
launch sweep considers every object with pending changes. Relaunch is the only
route for a writer-changed folder, because AppleScript cannot move a folder in
place. It never writes to the store and adds no writer action. Not verified
live: the relaunch path (it would quit Notes.app while others use it) and the
upload of a writer-changed folder after a relaunch.

Relaunch details (#52 and a review of the relaunch path):

- The running check is `pgrep -x -u <uid> Notes`, so another logged-in user's
  Notes.app never counts, and only pgrep's "no match" exit (1) means not
  running. Any other failure stops the relaunch before Notes.app is opened
  (`relaunch_failed`), instead of reading as "quit".
- Once Notes.app has been quit or opened, a failure to read the counters
  afterwards is reported as `relaunch_failed` with `relaunched: true`, so the
  caller knows not to relaunch again.
- Folder adoption: for each folder target, the relaunch then asks Notes.app
  through AppleScript whether `folder id "<x-coredata id>"` exists, and its
  name, polling for up to 20 s. `adoptedByNotesApp` is true when a live folder
  is shown (with the stored title when the caller knows it) or a deleted one
  is gone. The smart-folder write tools run the same read-only check after a
  committed write when Notes.app is already running (`adoptionWaitSeconds`,
  default 10). The check never launches Notes.app. AppleScript lists smart
  folders among `folders`, so smart folders are covered.
- The tool is annotated `destructiveHint: true`: annotations are per tool,
  and relaunch interrupts whoever is using Notes.app.

### Folder scope guards on writes

Every write action (and `plan_edit`, the edit plan) accepts the AppleScript
tools' three folder preconditions, `ifFolderId`, `ifAncestorFolderId`, and
`forbiddenAncestorFolderIds` (at most 50), as exact `x-coredata://…/ICFolder/pN`
ids. The actions and what each guards are listed in `kScopeGuardedActions`:
a note (its folder chain), a smart folder (its parent chain; a forbidden id
may also name the smart folder itself), or a new smart folder (its
destination parent). The source test requires every write action to be in
that table.

- Where: `Dispatch` validates the fields before the handler runs. Every save
  goes through `EnforceScopeGuard` (in `SaveOrFailFor` and in the append's own
  save), which evaluates the guard in the write's own context immediately
  before `-save:`. A call that returns without saving (a dry run, a no-op, a
  plan) evaluates it in a fresh read-only context before it answers.
- What it reads: the note's folder as the write read it
  (`committedValuesForKeys:`), which the save's optimistic locking protects:
  if Notes.app moved the note meanwhile, the save fails with
  `revision_conflict`. Each folder above it is re-read from the store with a
  dictionary fetch (`includesPendingChanges = NO`), not from the context's
  cache. A folder moved by another process between that read and the save is
  not detected; the window is the few milliseconds of the save itself.
- A write that moves the note (the purge-flag repair) also checks the
  destination's chain against the forbidden ids.
- Fail closed: every id must resolve, through the coordinator, to an existing
  `ICFolder` in this store, and a forbidden id must not name a deleted folder
  (`scope_folder_not_found`, `committed: false`). The AppleScript guards match
  ids by string and treat an unknown forbidden id as "not an ancestor"; the
  writer refuses instead, because an unknown id is almost always a stale or
  mistyped one.
- A failure is `scope_conflict` with a `scopeReason` (`not_in_folder`,
  `not_in_expected_folder`, `not_inside_expected_ancestor`,
  `inside_forbidden_folder`, `destination_inside_forbidden_folder`,
  `folder_vanished`, `folder_chain_invalid`), always `committed: false`. The
  server maps it to `revision_conflict`.
- `compose-note` create mode refuses the guards: Notes.app makes the note in
  the named folder before the writer runs, so a guard there could only refuse
  after the note exists.

### In-place edit

`native-edit-note` uses two writer actions: `plan_edit` (read) and
`edit_note` (write). Both run the same planner, `PlanEdit()`, against one
snapshot of the note's attributed string. Each operation becomes one or more
`(range, replacement)` targets. Overlapping targets, and two insertions at
the same point, are refused (`conflicting_operations`). The targets are
applied through the mergeable string's
`replaceCharactersInRange:withAttributedString:`, last range first, so
characters outside them keep their CRDT identity and attributes.

- `plan_edit` opens the store read-only, rehearses the native edit in memory,
  runs the side-effect check, and rolls back. It returns the plan,
  `planDigest`, and `revisionBefore`.
- `edit_note` requires `ifRevision`. With the same operations and the plan's
  `revisionBefore` it reproduces exactly the planned targets. `planDigest`
  (`p2:`) is a SHA-256 over the note identifier, the operations,
  `requireNonSystemPaper`, and the SHA-256 of each replacement file in plan
  order. `edit_note` takes an optional `ifPlanDigest` and refuses a mismatch
  (`plan_mismatch`, committed false) before anything is written, so a changed
  request or a file edited after the dry run cannot be applied under the dry
  run's approval.
- Before the save, only the note, its note data, its cloud state, and the
  row of an attachment the plan removes from the body may be dirty. Anything
  else, such as Notes re-pointing an attachment it uses for the title, rolls
  back as `unexpected_side_effect`. A removed attachment's row may be updated
  but not deleted; its changed keys are reported as
  `removedAttachmentRowChanges`.
- After the save, a new read-only stack re-reads the note. It checks that
  the text equals the plan, that every unchanged stretch has the same
  canonical attribute runs as before (paragraph style and todo, fonts, hints,
  links, timestamps, attachment references), that the edited ranges carry the
  planned formatting (timestamps ignored), that the attachment glyph sequence
  equals the one in the planned text, and that every attachment row other
  than a removed one is still the note's with the same stored values (a
  digest of each non-transient, non-transformed attribute, data hashed, plus
  the owning note), with no new row. The result reports this as
  `preservation`, including `otherAttachmentRowsUnchanged` and, per removed
  attachment, `rowStillInNote` and `markedForDeletion`.

Canonical attribute values (`CanonicalValue()`) are built field by field for
each class a note body stores: numbers, strings, URLs, UUIDs, dates,
`ICTTParagraphStyle` (style, alignment, writing direction, indent, block
quote level, list start number, hints, paragraph UUID, and the todo's UUID
and done state), `ICTTTodo`, `ICTTAttachment` (UTI and identifier),
`ICTTFont` (name, size, hints), and colors (sRGB hex, as compose verifies
them). A survey of 600 recent notes on macOS 27.2 found only these classes.
Before this, values fell back to their `description`. That happened to
include the attachment identifier and the todo state, but not a paragraph
style's list start number or hints, and nothing kept it that way. Any other
class now has no canonical value: `PlanEdit()` refuses a note that holds one
(`unsupported_note`, listing the attribute and class) and the read-back
fails on one, so verification can never pass by comparing two equal
descriptions. The copy-store script also checks each step with
`scripts/check-edit-preservation.mjs`, which decodes the stored protobuf
itself (no writer, no NotesShared) and compares every UTF-16 unit outside the
edits with its serialized attribute run, plus a digest of every other row.

To prove the read-back is not blind, the writer honours
`APPLE_NOTES_MCP_PRIVATE_TEST_FAULT` on a copy store only (it is ignored when
`APPLE_NOTES_MCP_PRIVATE_STORE` is unset): `tamper_todo` and
`tamper_attachment` verify a read-back in which one checklist todo outside the
edit is toggled, or one attachment glyph outside it is re-pointed, and must
end in `verification_failed`; `fail_before_save` fails after the edit and any
new attachment, just before the save, and must leave no row and no file.

Literal matching compares UTF-16 units, so a selector could match half of a
surrogate pair or a letter without its combining mark. A hit whose ends are
not on composed-character boundaries
(`rangeOfComposedCharacterSequencesForRange:`) is refused as
`unsupported_selection` rather than skipped, so the match count the caller
sees never silently changes, and text with an unpaired surrogate is refused
as `invalid_request` (the client refuses both before spawning the writer).

#### Attachment selector

Selectors resolve through `ResolveSelector()` by `kind` (`text`, `style`,
`blank`, `attachment`), and the client schema is a union on the same key.
`{kind: "attachment"}` names exactly one of the note's attachment rows by
`identifier` (the row's UUID, which is also the `attachmentIdentifier` of the
`ICTTAttachment` value on its U+FFFC glyph), `id` (the row's x-coredata URI,
compared with the managed object's own URI, so no SQL is needed), or
`ordinal` (1-based among the body's attachments whose identifier belongs to
one of the note's `attachments` rows). Glyphs of inline objects
(`inlineAttachments`: hashtags, mentions, note links) are skipped by every
mode, so they are never selectable and not counted.

Notes stores some attachments as two or more adjacent glyphs that name the
same attachment; on macOS 27.2, 61 of 439 attachment glyph groups in 600
recent notes were pairs (images added through AppleScript, PDFs, and
plain-text files). `AttachmentSpans()` groups adjacent glyphs with the same
identifier into one span, and the selector works on spans: an ordinal counts
attachments, `expectedCount` counts attachments, and each target covers the
whole span. Per role:

| Role | Target |
|---|---|
| `replace`, `position: "self"` | the span; empty text removes it, a file replaces it with one new glyph |
| `replace`, `"before"` / `"after"` | the empty range at the span's first glyph or just after its last; text is inserted inline and takes the glyph's attributes minus the attachment and timestamp |
| `delete_paragraph` | the span's paragraph, refused (`unsupported_selection`) unless it holds only that span and whitespace |
| `insert_after` / `insert_before` / `append_to_paragraph` anchor | the span's paragraph |

`TargetMayTouchAttachment()` returns YES only for this kind, and
`RequireNoAttachmentGlyph()` then allows exactly the glyph range the
selector resolved; any other U+FFFC in the range, such as a second
attachment in the same paragraph, is refused. The plan reports each target's
`attachment` (identifier, UTI, ordinal) and `removedAttachments`: identifiers
whose glyph is in the snapshot but not in the planned text. Only those rows
are allowed to be dirty before the save and exempt from the row digest check
after it.

Removing a glyph does not delete the attachment's row or media. Whether
NotesShared marks the row for deletion during the save, or Notes.app does it
later, has not been observed yet; the apply reports it rather than assuming
it. The copy-store script adds a caption beside the first attachment and
removes it, inserts and deletes a paragraph anchored on it (both restore the
note exactly), and then removes the attachment on the copy.
`check-edit-preservation.mjs` compares attachment rows one by one and skips
only the rows named in the response's `removedAttachments`.

#### Replacing an attachment with a file

`replacement: {file, filename?}` with an attachment selector at position
`self` replaces the attachment's span with one new glyph for a new
attachment, in the same save. The writer reads the file itself through a
descriptor opened with `O_NOFOLLOW` (a non-empty regular file of at most
64 MiB, the add-attachment limit), derives its UTI from the name's extension
with `UTType`, and accepts only images (`+[ICAttachment typeUTIIsImage:]`)
and `com.adobe.pdf`. The attachment it replaces must have `media` (an image,
PDF, or other file); tables, drawings, Paper, and link cards are refused as
`unsupported_attachment`. The client also checks the path against the
add-attachment roots (home, temp, `/Volumes`) before spawning the writer.

The dry run reads and hashes the file and plans a placeholder glyph, but
creates nothing. The apply, after the revision and plan-digest checks,
calls `-[ICNote addAttachmentWithUTI:data:filename:]` with the bytes it
hashed. NotesShared writes the media file at once, under the account's
`mediaDirectoryURL` (`<media>/<media id>/<generation>/<name>`); on a copy
store `InstallAccountSandbox()` redirects every account directory beside the
copy first, as for Paper. The writer checks that the attachment has the
planned UTI and media, that NotesShared did not place a glyph itself, and
that the media file holds the planned bytes, then points the placeholder at
the new identifier and bumps both cloud states. The side-effect check allows
exactly the new attachment, its media, and their cloud states as inserted
objects, and the account's `attachments` and `media` relationships as its only
change. Any failure before the save rolls the context back and removes the
media container, but only when it sits exactly at
`<mediaDirectoryURL>/<media identifier>`; a failed save does the same. The
read-back then proves the new row belongs to the note with the planned UTI,
its media has the planned name, and the media file's SHA-256 matches. The old
attachment is handled like any removed attachment (its row is reported, not
deleted).

#### Inline runs, appends, and checklist replacement

Replacement, block, item, and appended runs are built by compose's
`RunAttributes()`, so they take the same `link`, `highlight`, and `color`
fields and the same validation. `InlineBase()` strips every inline attribute a
run can state (hints, underline, strikethrough, link, emphasis, color) from
the inherited attributes, so a run's formatting is exactly what it says. The
read-back compares the new runs' canonical values, so a link, highlight, or
color that did not persist fails verification.

`append_to_paragraph` is an insertion at the end of the anchor paragraph's
content (before its terminator). Its runs sit on the attributes of the
paragraph's last character (or its terminator when it is empty) minus the
inline formatting, so they share the paragraph's style and font.

`replace_checklist` (`PlanChecklistReplace()`) finds maximal runs of
consecutive style-103 paragraphs. Each chosen run is one target covering its
rows with their terminators; the first gets the new rows, each a fresh
`ICTTParagraphStyle` with a new todo in the requested state and its own
terminator (none for the last row when the run ended the note), and later
runs are removed. A run holding the title or any U+FFFC is refused. The plan
reports every replaced row's text and done state.

`delete_paragraph` removes a terminated paragraph with its terminator and an
unterminated last paragraph's text only, like `trim_blank_lines`. Earlier it
removed the previous paragraph's terminator with the last paragraph, which
also took an empty paragraph before it and reported two last-paragraph
deletions from one operation as conflicting. Overlapping or touching deletion
ranges from one operation are now merged into one target
(`mergedParagraphs`).

#### Line-break trimming

`trim_blank_lines` is an operation rather than a selector kind, because its
shape (a mode, how many blank lines to keep, an optional anchor) does not fit
the one-paragraph-per-match selectors. `PlanTrim()` returns whole
paragraphs, and each becomes an ordinary deletion target, so the plan,
overlap check, side-effect check, and read-back are the same as for any other
edit.

A paragraph is trimmable (`IsTrimmableBlank()`) when it is not the title
paragraph, holds no U+FFFC, holds only whitespace, and has a text style
(title, heading, subheading, body). Empty list and checklist rows are visible
bullets and are deleted with a `blank` selector instead; empty monospaced
lines belong to code blocks. Each removed paragraph goes with its own
terminating newline, and a whitespace-only unterminated last paragraph goes
alone, so no non-empty paragraph loses a character, its terminator, or the
paragraph style it carries. A note that ends in a newline keeps it.

| `mode` | Removes | `keep` default |
|---|---|---|
| `runs` | all but the first `keep` of every maximal run of trimmable paragraphs | 1 |
| `end` | the run that ends the note | 0 |
| `around` | the runs directly `before`, `after`, or on `both` sides of the one paragraph `anchor` names (text or style; `occurrence` picks one) | 0 |

`expectedCount` is optional here and, when given, must equal the number of
paragraphs removed. The dry run lists every paragraph it would remove as a
target (`paragraphIndex`, `paragraphStyle`, `location`, `length`, and
`blankUTF16`, the whitespace it held) and reports `blankRuns` and
`blankParagraphs` examined. A trim that finds nothing plans zero targets,
and applying it returns `status: "unchanged"`. Two trims that reach the same
paragraph (for example `runs` and `end`) are `conflicting_operations`.

The copy-store script inserts three blank paragraphs between two markers,
trims them with `around` (exactly 3), deletes the markers, and checks the note
is restored exactly; it then applies `runs` to the note's own blank lines on
the copy and checks the result with the independent decoder.

### Structured compose (`compose_note`)

`compose-note` (src/services/privateCompose.ts, src/tools/composeNoteTool.ts)
validates caller blocks or Markdown on the server and flattens them to one
wire entry per Notes paragraph:
`{style, indent?, blockQuote?, checked?, runs:[{text, bold?, italic?, underline?, strikethrough?, link?, highlight?, color?}]}`.
The writer validates the same shape again (unknown keys, strict JSON
booleans, style names, indent 0 to 8 on body, list, and checklist paragraphs
only, `checked` required on checklist paragraphs and refused elsewhere, one
line per run, link schemes http/https/mailto/tel/notes/applenotes,
`#RRGGBB` colors, a non-empty last paragraph) before it loads NotesShared, so
a malformed request fails the same way on every macOS. Every failure raised
before the save carries `committed: false`.

Extra NotesShared API, reported by the probe as the `composeNote` feature:
`-[ICTTMutableParagraphStyle setStyle:]`, `-setIndent:`,
`-setBlockQuoteLevel:`, `-setTodo:`; `-[ICTTParagraphStyle style]`,
`-indent`, `-blockQuoteLevel`, `-todo`; `-[ICTTTodo initWithIdentifier:done:]`,
`-done`; and, only for `requireNonSystemPaper`, the model property
`ICNote.isSystemPaper` (checked on the entity; missing fails closed with
`unsupported_note`).

| Request | Mergeable-string attribute | Stored as |
|---------|----------------------------|-----------|
| `heading`, `subheading`, `monospaced` | `TTStyle` style 1, 2, 4 | ParagraphStyle field 1 = 1, 2, 4 |
| `body` | `TTStyle` style 3 | no field 1 (body is the default) |
| `bulleted`, `dashed`, `numbered`, `checklist` | style 100, 101, 102, 103 | field 1 = 100 to 103 |
| `indent` | `-setIndent:` | ParagraphStyle field 4 |
| `blockQuote` | `-setBlockQuoteLevel:1` | ParagraphStyle field 8 = 1 |
| `checked` | `ICTTTodo` with a fresh UUID | ParagraphStyle field 5, done in its field 2 |
| `bold`, `italic` | `TTHints` 1, 2 (bitmask) | AttributeRun field 5 |
| `underline`, `strikethrough` | `TTUnderline`, `TTStrikethrough` = 1 | AttributeRun fields 6, 7 |
| `link` | `NSLink` (an `NSURL`) | AttributeRun field 9 |
| `highlight` | `TTEmphasis` 1 to 5 (purple, pink, orange, mint, blue) | AttributeRun field 14 |
| `color` | `TTColor` (a `CGColor`) | AttributeRun field 10 |

The table was recorded on 2026-09-23, when the same code ran in a combined
helper; it has not been re-derived for this writer beyond the copy-store run
below.

Each paragraph's `TTStyle` covers its text and its own terminating newline.
Placement: `append` closes the note's last paragraph with a newline carrying
that paragraph's style; `prepend` inserts after the first newline (the title
line) and ends the unit with a newline carrying its last paragraph's style;
a title-only note is closed like an append. `insertBeforeHeading` finds
paragraphs whose style is Heading and whose text equals the given text,
requires exactly `expectedCount` of them (`selector_conflict` otherwise, and
for a match at offset 0), and inserts before the `occurrence`-th.

The dry run opens the store read-only, builds the full unit, resolves the
placement, and returns `revisionBefore`, `insertAt`, `unitStart`, and the
per-paragraph plan; it needs both switches (every writer call does) but not
`APPLE_NOTES_MCP_ALLOW_UNVERIFIED`. The apply follows the write contract
above. Verification opens a new read-only coordinator and requires (1) the
persisted text to equal the old text with the insertion spliced in at
`insertAt`, and (2) each written paragraph's signature (style number, indent,
block-quote flag, checklist done state, the style on its terminator, and its
runs as `{length, attributes}`) to equal the signature of the unsaved
insertion. `readBack` returns the persisted signatures without text.

After a successful apply on the live store, the server adds a check that
does not go through NotesShared: `readNoteBlocks` (utils/noteBlocks) decodes
the note's `ZICNOTEDATA.ZDATA` by the writer's `objectURI`, and the blocks
from the one starting at `unitStart` on are compared with `readBack` (style,
indent, block quote, checklist done state, length, and each run's attribute
values: link URL, highlight, color, styles, and the attachment a glyph names;
adjacent runs with equal values are merged on both sides so storage-level
splits do not matter) and with the requested text, returned as
`databaseReadBack`. It only reports; the writer's own verification decides
success. On a store copy it reports `checked: false`.

The writer's verification compares the persisted note with its own rendering
of the request, so a mistake in that rendering would pass it. Before
returning a success, the server (`verifyAgainstRequest` in
privateCompose.ts) therefore compares `readBack` with the request it sent:
each paragraph's style, indent, block quote, checklist state, and length,
each run's attribute values, and, for each object paragraph, the created
object's kind, type, card URL, or file name. A difference is
`verification_failed` with `committed: true`, `indeterminate: true`, and
`requestMismatches`. Links must already be in the form `NSURL` keeps
(`-absoluteString` equal to the request; the server allows only RFC 3986
characters and `%`), so the stored link can be compared exactly.

**Limits checked before anything is created.** `create` mode makes the note
through Notes.app before the writer runs, so a writer refusal after that
would leave a stray title-only note. The server therefore applies every
content and character rule the writer applies (the writer's forbidden set,
link and color forms, table shape), and every size limit: 2,000 paragraphs,
200,000 UTF-16 units with table cell text included, 10,000 units per cell,
20,000 runs, 20 file and link-card blocks, 128 MiB of files, and the writer's
1 MiB stdin cap measured on the serialized request with placeholder
identifier and revision values. The writer enforces the same limits itself.
If a create-mode compose still fails with `committed: false`, the server
reads the note's writer revision again; when it still equals the revision
read right after the create, it moves the note to Recently Deleted with
`deleteNoteByIdIfUnchanged` (body compared in the same AppleScript as the
delete) and reports `createdNote: "moved_to_recently_deleted"`, else
`createdNote: "kept"` with the note's `id` and `identifier`.

A note whose body is empty has no title paragraph, so an append or prepend
would write the unit into the title position. The writer refuses such a note
(`unsupported_note`, `committed: false`) rather than invent a title.

**Dividers and tables.** A wire entry `{kind:"divider"}` or
`{kind:"table", rows}` becomes one U+FFFC glyph in its own body paragraph. The
dry run keeps a bare placeholder glyph and creates nothing. On apply, after
the revision check, the writer creates each object on the note and points its
glyph at it with an `ICTTAttachment` (`attachmentIdentifier`,
`attachmentUTI`) under the `NSAttachment` attribute:

- divider: `+[ICInlineAttachment newDividerLineAttachmentWithIdentifier:note:parentAttachment:]`
  (UTI `com.apple.notes.inlinetextattachment.dividerline`);
- table: `+[ICTable registerWithICCRCoder]` (Notes.app does this at launch;
  without it the table CRDT has no root type),
  `-[ICNote addAttachmentWithUTI:]` with `com.apple.notes.table`, rows and
  columns resized with
  `-insertRowAtIndex:`/`-removeRowAtIndex:` and the column equivalents, every
  cell written with `-setAttributedString:columnIndex:rowIndex:`, then
  `-[ICAttachmentTableModel writeMergeableData]`,
  `-regenerateTextContentInNote`, and `-[ICAttachment saveMergeableDataIfNeeded]`.

The table is not made with `-[ICNote addTableAttachment]`: on macOS 27.2
(store copy, 2026-09-24) that method saves the note's whole context itself,
through `-[NSManagedObjectContext ic_saveWithLogDescription:]` inside
`-addTableAttachmentWithTableData:`. A compose that failed after creating a
table therefore left the table row, every object created before it, and the
note's own changes saved while reporting `committed: false`.
`-addAttachmentWithUTI:` creates the same row without saving, and the table
model builds the empty table on first access. As a safety net the compose
handler also counts `NSManagedObjectContextDidSaveNotification` on its
context before its own save; if NotesShared saves by itself and the compose
then fails, the error is reported with `committed: true`, `indeterminate: true`,
and `earlySaves`, and no file is deleted.

Each object gets `updateChangeCountWithReason:`. The writer refuses
(`materialization_failed`, `committed: false`) if a factory changes the note
text by itself, and nothing is saved until the one context save, so a failure
leaves the store untouched. Verification adds a fresh-context fetch of each
object by identifier, checks that it belongs to the note, and for tables
compares the row and column counts and every cell with
`-stringForColumnIndex:rowIndex:`. The probe reports these selectors as the
`composeObjects` feature; a request with objects on a macOS without them
fails with `private_api_unavailable` and nothing written. `noteLink` blocks
are body text with a `notes://showNote?identifier=` link (the URL
`get-note-link` returns), so they read back as `inline` links, not as the
native link chips Notes' own "Add Link" makes. The server reads the target
through the writer's `read_note_state` first so a typo cannot become a dead
link.

Copy-store run, 2026-09-24, macOS 27.2: two dividers, a 2 x 2 table, and a
note link were created on the copy in one save and verified; the copy's
table and divider rows grew by 3; a replay was refused with
`committed: false`.

`noteLink` blocks are not the only note links: any run link with a `notes:`
or `applenotes:` scheme, from blocks or Markdown, must be a
`showNote?identifier=` link whose target `read_note_state` finds, and the
target must be neither locked nor deleted or in Recently Deleted.

**Files and link cards.** A wire entry `{kind:"file", path, filename?}` or
`{kind:"url", url}` is placed like a table: one U+FFFC glyph in its own body
paragraph, created only on apply. The writer validates a file before it
loads NotesShared, with `add-attachment`'s rules: an absolute path opened
with `O_NOFOLLOW`, a nonempty regular file of at most 64 MiB, and a
`filename` of one path component that keeps the source extension. It reads
the bytes once, hashes them, and takes the type from Launch Services'
reading of the source file (`NSURLTypeIdentifierKey`; an unregistered or
dynamic type becomes `public.data`). A request takes at most 20 file and
link-card entries and 128 MiB of files. The dry run reports each file's
name, size, SHA-256, and type under `objects`.

- file: `-[ICNote addAttachmentWithUTI:data:filename:]` creates the
  attachment row, its `ICMedia` row, and the media file at
  `Accounts/<account>/Media/<media identifier>/<generation>/<filename>`.
- link card: `-[ICNote addURLAttachmentWithURL:]`, as in `add_url_card`
  (`public.url`, the URL rules of `CardURL`, and the URL must already be in
  `NSURL`'s form). Notes fetches the title and preview later.

Before the save, each media file must sit under the store's `Accounts`
directory and hold exactly the bytes read (size and SHA-256). Every failure
between creating the first object and the save runs `DiscardComposeObjects`:
it deletes each new file attachment's preview images, its exportable media,
and its media directory (only the directory named after the media row, and
only inside `Accounts`), then rolls the context back. After the save, the
fresh read-back fetches each attachment by identifier and checks its note,
type, card URL, media row file name, and the media file's size and SHA-256.
On a store copy the writer points every `ICAccount` directory method at the
copy's directory before it creates a file (`InstallAccountSandbox`, as
`add_paper` does), so no file lands in the live container. The probe reports
the extra selectors (`addAttachmentWithUTI:data:filename:`,
`addURLAttachmentWithURL:`, `-[ICMedia mediaURL]`) and model properties
(`ICAttachment.media`, `ICMedia.filename`) as the `composeAttachments`
feature.

The copy-store tests set `APPLE_NOTES_MCP_WRITER_FAULT=compose_before_save`
to fail a compose after every object exists and just before the save. The
writer honors it only when `APPLE_NOTES_MCP_PRIVATE_STORE` names a copy.

**Frozen attachments.** Appending to a note that holds attachments must not
change them. The writer fingerprints them three times: after the revision
check, just before the save (in the write context), and after the save (in
the fresh read-only context). A fingerprint holds, per existing
`ICAttachment` row, a digest of every stored attribute (data values hashed;
transient and transformed attributes skipped; the owning note included), the
same digest of its `ICMedia` row, and the media file's size and SHA-256 when
the file is on this Mac (up to 512 MiB of hashing per fingerprint, then size
and modification time); per inline attachment row, the same row digest; and
the order of the attachment glyphs already in the body. Objects the compose
created are left out. A difference before the save refuses with
`attachment_drift`, `committed: false`, and the drifted keys in
`attachmentDrift`; nothing is saved and created files are removed. A
difference after the save is `verification_failed` with `committed: true`.
Before the save, any deleted object also counts as drift.

The version floor (`minimumSupportedNotesVersion`) is compared separately:
it may rise but not fall. Inserting a divider on a store copy (macOS 27.2,
2026-09-24) raised it on every existing image attachment and media row of
the note, from 0 or 2 to 6, inside Notes' own model code. Those rows are
listed in `frozenAttachments.versionFloorRaised`.

Copy-store run, 2026-09-24, macOS 27.2
(`scripts/test-private-writer-compose-copy-store.sh`, on a note with one
existing attachment): the live compose was refused with `writes_disabled`; a
relative file path was refused with `committed: false`; the dry run listed
four objects with the PNG's SHA-256 and changed nothing; the injected failure
left the revision, the note's attachment rows, and the files under
`Accounts` unchanged; the apply created two files, a link card, and a table
in one save (rows +4, both files found by SHA-256) with the existing
attachment unchanged; the replay was refused; no file appeared under the live
Notes container; the live note's revision was unchanged. In a separate run on
a copy, the server's `composeNote` (with `verifyAgainstRequest`) applied every
run attribute, a checklist, a quote, a divider, a table, a file, and a link
card through the real writer and accepted its `readBack`, and
`crossCheckWithDatabase` pointed at the copy decoded the same paragraphs with
matching text and attribute values.

`create` mode does not create notes in the writer. Notes.app creates the
note through the same AppleScript as `create-note`, the server resolves its
UUID from the database, reads a fresh revision through the writer's
read-only `read_note_state`, and applies an `append`. Keeping creation in
Notes.app avoids a writer-created record that Notes.app has never seen.

Copy-store run, 2026-09-24, macOS 27.2 (`scripts/test-private-helper-copy-store.sh`):
the live compose was refused with `writes_disabled`; a 13-paragraph plan and
apply verified every style, indent, quote, checklist state, and run
attribute; stale and replayed revisions and a stale heading count were
refused with `committed: false`; prepend and insert-before-heading verified;
a Quick Note was refused under `requireNonSystemPaper`; the live note's
revision was unchanged.

### Checklist toggling (`read_checklist`, `set_checklist_item`)

A checklist item's identity and done bit live in an `ICTTTodo` (`-uuid`,
`-done`, `-initWithIdentifier:done:`) held by the `ICTTParagraphStyle`
(`style` 103, `-todo`, `-setTodo:`) in the `TTStyle` attribute of the item's
characters. In the protobuf this is `AttributeRun.paragraphStyle` (field 2)
`.todo` (field 5): `uuid` bytes (field 1) and `done` (field 2). The 16 UUID
bytes as 32 lowercase hex digits are the `id` `get-native-objects` reports.

**Style runs are not aligned to lines.** On a note built with
`create-checklist-item` (macOS 27.2, observed 2026-09-23), each item's run
began with the newline that ends the previous line: the run for item one
covered `"\ntoggle alpha"`, and item two's run covered `"\ntoggle beta"`.
Reading "the style at each line's terminating newline" therefore attributes
item one's todo to the body line above it, and toggling by line would have
turned that body line into a checklist item. The writer never infers items
from line boundaries. `read_checklist` (a read action) collects the exact runs
whose todo UUID matches and reports `text` from the line holding the item's
first non-newline character, plus the note's `revision`.

`set_checklist_item` copies the paragraph style of each of the item's runs
(`-mutableCopyWithZone:`, which keeps indent, alignment, and paragraph UUID),
sets a todo with the same UUID and the new done bit, and writes it with
`-[ICTTMergeableAttributedString setAttributes:range:]` inside
`beginEditing`/`endEditing`. `setAttributes:range:` replaces a run's whole
attribute dictionary, so the writer merges every existing attribute (fonts,
links, `TTTimestamp`) back in per run. It then calls
`edited:range:changeInLength:` with `NSTextStorageEditedAttributes`,
`saveNoteData`, stamps `modificationDate`, and `updateChangeCountWithReason:`.
`saveNoteData` also refreshes the derived `ZHASCHECKLISTINPROGRESS` column
(observed 1 to 0 on a store copy on 2026-09-23 when the last open item was
checked).

The fresh read-back requires the same text, the item covering the same
characters with the requested done bit on every run, and every other item
unchanged in identity, characters, and state. A request for the state the item
already has writes nothing (`status: "unchanged"`, `committed: false`). A UUID
found in two separate places is refused as `ambiguous_target`, and so is one
whose characters, newlines at either end aside, still contain a line break:
two adjacent lines that share a todo UUID read as one item, and a toggle would
change both. The MCP tools
are `native-checklist-state` and `native-set-checklist-item` (optional
`nudge`, skipped when nothing was written).

`scripts/test-private-writer-checklist-copy-store.sh` runs these actions on a
store copy. On 2026-09-24 every checklist note in the test library was either
trashed or shared, so the script moved a trashed checklist note into a regular
folder of its account in the copy (plain SQL on the disposable copy, never on
the live store) and then passed: two items, one toggled and back, the no-op
and every refusal as expected, and the live note unchanged.

Earlier live test (2026-09-23, macOS 27.2, Notes running), run with the same
edit logic in an earlier prototype, before it moved into this writer:
on a note built with two `create-checklist-item` items in an iCloud folder,
the tool refused a stale revision, checked the second item
(`persistedDone: true`, protobuf `done` 1 on exactly that item's run, the
other item and the text unchanged), and then returned `unchanged` for the same
request. AppleScript still listed both list items, and `get-native-objects`
reported the new done state under the same identifier. `currentLocalVersion`
went from 3 to 4 while `latestVersionSyncedToCloud` stayed 3 for the whole
12-minute read-only poll (every 30 seconds). When checked again about two and
a half hours later both counters were 4, so Notes.app uploaded the change at
some point in between; what triggered it was not observed. That test predates
the sync nudge. The writer build of this action has not been live-tested yet.

### Highlight (`set_highlight`)

Notes' highlight is the `TTEmphasis` attribute, an `NSNumber` on the
highlighted characters, serialized as `AttributeRun` field 14. On 2026-09-23 a
scan of a store copy on macOS 27.2 found one note with Notes-written field 14
(value 1), and an earlier prototype read the same run back as
`TTEmphasis` = 1, confirming the mapping. The values follow Notes' color
order: 1 purple, 2 pink, 3 orange, 4 mint, 5 blue. That Notes-written run also
carried a `TTColor` attribute; whether Notes always pairs the two was not
determined, so the writer sets only `TTEmphasis`.

The action takes a `scope`. Target selection is one function; the plan, the
no-op check, the edit, and the verification work on any list of ranges, so the
scopes differ only there. An unknown scope is `invalid_request`.

- `"text"` (default): every non-overlapping literal, case-sensitive occurrence
  of `match` (no newlines, U+FFFC, or control characters; at most 1,000 UTF-16
  units), refused as `match_count_mismatch` with `found` unless the count
  equals `expectedCount` (1 to 100, default 1).
- `"note"`: the whole body after the title paragraph. `match` and
  `expectedCount` are `invalid_request` with this scope. The title paragraph
  runs through the first `\n`, so the title's paragraph mark, which carries
  its paragraph style, is not touched. The rest is split around every U+FFFC
  attachment glyph, and each non-empty stretch between glyphs is one range.
  A glyph stands for an object Notes draws itself (image, file, table,
  drawing, or an inline hashtag or mention). Text such as table cells lives in
  the attachment's own model, which this action never opens, and emphasis on
  the glyph would only rewrite the attachment's attribute run, so glyphs are
  skipped in both directions. Paragraph separators inside the body are
  included. That follows how Notes applies emphasis to a selection: the
  NotesEditor method that sets it,
  `ic_setAttributeWithName:enabled:withEmphasisColorType:`, enumerates the
  selection's attribute runs through one block, with no separate newline path
  visible in its signature. That is an inference from the method and block
  signatures, not from reading its body. A 2026-09-24 scan of a store copy
  found six notes with Notes-written highlights, all within one line, so it
  neither confirms nor contradicts it. Results report `skipped`
  (`titleUTF16`, `attachmentGlyphs`, and `highlightedAttachmentGlyphs`, the
  glyphs that already carry emphasis and therefore keep `hasEmphasis` true
  after a removal). A note with nothing left (title only, or only attachments
  after it) is refused as `nothing_to_highlight`, `committed: false`.

Both scopes report `rangeCount` and `characterCount` (UTF-16 units across the
target ranges), in dry runs and writes.

For each attribute run inside each target range the writer writes the run's
full attribute dictionary plus (or minus) `TTEmphasis` through
`-[ICTTMergeableAttributedString setAttributes:range:]`, then calls
`edited:range:changeInLength:` with `NSTextStorageEditedAttributes`,
`saveNoteData`, and `updateChangeCountWithReason:`. Verification applies the
same change to a detached copy of the pre-write attributed string and requires
the fresh read-back's text to be identical and its complete `TTEmphasis` run
map to equal the copy's, so an unexpected change anywhere in the note fails as
`verification_failed` with `committed: true`. `saveNoteData` also refreshes
the note's derived `hasEmphasis` flag (`ZHASEMPHASIS`): on a store copy on
2026-09-24 it went from false to true after a highlight and back to false after
removal. The read-back requires that flag to match whether any highlight
remains, and the result reports it. `dryRun` opens the store read-only and
reports each range with its current runs. A request every range already
satisfies writes nothing (`status: "unchanged"`). The MCP tool is
`native-highlight-text` (optional `nudge`, skipped when nothing was written).

`scripts/test-private-writer-highlight-copy-store.sh` passed on a store copy
on 2026-09-24: the live write gate, the count guard, a stale revision, an
unknown scope and color, a dry run with no change, two matches highlighted
mint and read back, a no-op repeat, a recolor to purple, removal, and the live
note unchanged. The same script's whole-note section passed on a fresh copy
on 2026-09-24 on a note with two attachment glyphs: `match` and
`expectedCount` refused with scope note, a dry run of 2 ranges and 46 UTF-16
units starting right after a 21-unit title with no change, the whole body
highlighted blue and read back with `hasEmphasis` false to true, a no-op
repeat, and removal read back with `hasEmphasis` false.

Earlier live test (2026-09-23, macOS 27.2, Notes running), run with the same
edit logic in an earlier prototype, before it moved into this writer:
on a note created in an iCloud folder, a dry run reported two matches without
changing the revision, a stale revision was refused, the write stored orange
(field 14 = 3) on both matches and nothing else, a repeat returned
`unchanged`, and a second call stored purple (1) on a third word. The
AppleScript HTML body does not show highlights, and the rendering in Notes.app
was not inspected visually. `currentLocalVersion` went from 1 to 3 while
`latestVersionSyncedToCloud` stayed 1 for the 12-minute read-only poll; about
two and a half hours later both were 3, so Notes.app uploaded the change in
between, on a trigger that was not observed. That test predates the sync

### URL link cards (`add_url_card`)

A card Notes made itself (inspected on a store copy, macOS 27.2, 2026-09-23)
is an `ICAttachment` row with `typeUTI` `public.url`, `urlString`, a title,
about 20 bytes of `metadataData`, and one preview-image child, plus a single
U+FFFC in the note text whose only attribute is `NSAttachment`, an
`ICTTAttachment` carrying the attachment identifier and UTI. The glyph run has
no `TTStyle`, so the card's line is body text.

The writer calls `-[ICNote addURLAttachmentWithURL:]`, which creates the
attachment row with the URL and type but does not place a glyph
(`-rangeForAttachment:` returns NotFound; if a future release places one, the
writer rolls back and refuses rather than guess). It then inserts the glyph
through `insertAttributedString:atIndex:` right after the chosen paragraph's
own newline, followed by a newline in the default (body) paragraph style when
text follows the card. The anchor keeps its terminator, and the card's line
takes no style from it: inserting `"\n" + glyph` before the anchor's newline,
as the first version did, left the card terminated by the anchor's newline,
so after a checklist item the card carried the item's todo. When the anchor is
the last paragraph and has no newline, a separator that copies its `TTStyle`
goes first, as at the end of a note. With no anchor the card goes at the end,
with a separator only when the body does not already end in a newline. An anchor
that matches zero or several whole paragraphs is `match_count_mismatch` with
`found`. `updateChangeCountWithReason:` runs on both the note and the
attachment, because the attachment is its own cloud object; the result reports
the attachment's own `cloudSync` counters. The probe also checks the
`ICAttachment` model properties the action reads (`identifier`, `typeUTI`,
`urlString`, `note`, `cloudState`).

The fresh read-back requires the text to equal the old text plus the
insertion at the planned index, the glyph to name the new attachment exactly
once at the planned index, the glyph and its terminator to carry no paragraph
style or a body style with no todo, and the attachment row to be a `public.url`
attachment for that URL on that note. `dryRun` opens the store read-only and
reports the insertion point and `writeAvailable`, the write feature's probe
result. The MCP tool is `native-add-url-card` (optional
`nudge`, which moves the note; whether the move alone also uploads the
attachment has not been observed).

The writer makes no network request and writes no file.
`scripts/test-private-writer-link-card-copy-store.sh` passed on a store copy on
2026-09-24: the live write gate, a missing anchor, four refused URLs, a stale
revision, a dry run with no change, two cards after the same paragraph and one
at the end (+6 UTF-16 units, each glyph read back at its planned index), a
refused replay, no new file under the live Notes container, and the live note
unchanged. On the copy the attachment reported `currentLocalVersion` 1 and
`latestVersionSyncedToCloud` 0, so it is marked for upload.

Earlier live test (2026-09-23, macOS 27.2), run with the same edit logic in
an earlier prototype, before it moved into this writer: on a test note
in an iCloud folder the attachment row started with no title, summary,
metadata, or preview image, and AppleScript already listed it with its URL.
About 20 seconds after the note was shown in Notes.app, Notes had fetched the
preview itself: both cards had a title, one had a summary and a preview-image
child, and both had metadata, the same shape as a card Notes made itself. The
note had not yet uploaded its own creation (`latestVersionSyncedToCloud` 0)
when the cards were added, and the writes raised `currentLocalVersion` to 4.
After the note was shown in Notes.app, Notes fetched the previews (its own
saves raised the note to 7), and within about two minutes the note and both
attachments reported `latestVersionSyncedToCloud` equal to
`currentLocalVersion`. Displaying the note, which made Notes.app save its own
change to it, was enough to upload those writes. Whether the card and its
preview appear on another device was not checked. That test predates the sync
nudge. The writer build of this action has not been live-tested yet.

### Paragraph identifiers

The read-only `list-note-paragraphs` and `get-paragraph-link` (#218)
classify each paragraph's stored UUID (ParagraphStyle field 9) as `unique`,
`shared` or `missing` and refuse to link the last two. They never mint one.
The writer's `set_paragraph_id` action (`native-set-paragraph-id`) adds that
write and builds on that listing rather than repeating it: the caller
picks a paragraph by its `blockIndex` and `text` from the listing.

The writer applies the same rules to the live attributed string: blocks
split on `\n` only, a block owns its terminating newline, its UUID is the one
on its first character, and that UUID is unique when no character of another
block carries it. It refuses a block whose text no longer matches
(`paragraph_changed`, `committed: false`), returns `unchanged` without saving
when the UUID is already unique, and otherwise gives every run of the block a
copy of its own `ICTTParagraphStyle` carrying a new UUID, through
`-[ICTTMergeableAttributedString setAttributes:range:]` so the change merges
like any attribute edit. The read-back checks that the text is identical,
that the block carries the new UUID on every character and uniquely, that its
other attributes and paragraph style value are unchanged, and that every
other block kept its first UUID. A run without a paragraph style counts as
body text (style 3) in that comparison, since the new style it receives is
the default body style. `scripts/test-private-helper-copy-store.sh` checks
the result on a copy with the read tools' own reader (`readNoteParagraphs`),
which must report the paragraph as `unique` with the writer's `url`.

### Section-link chips (macOS 27)

A section link is the chip Notes pastes for Copy Link to Section: an
`ICInlineAttachment` of type `com.apple.notes.inlinetextattachment.link`
whose token is an `applenotes://showNote?identifier=<note>&paragraphID=<uuid>`
link, shown in the body as one U+FFFC glyph. `list-note-links` and
`get-note-structure` read these as kind `section`, but no other tool creates
one. The writer's `add_section_link` action (`native-add-section-link`) does,
in one save:

1. It selects the target paragraph (`blockIndex` + `expectedText`, a unique
   `paragraphId`, `heading`, or the first heading or subheading) and, when
   its identifier is not unique by the rules above, mints one as
   `set_paragraph_id` does.
2. NotesShared builds the attachment with
   `+[ICInlineAttachment newParagraphLinkAttachmentWithIdentifier:toNote:paragraphName:paragraphID:fromNote:parentAttachment:]`,
   which first appears in macOS 27. The probe reports `macOS 27 or later` as
   missing on older systems.
3. The writer inserts an `ICTTAttachment` glyph naming that attachment
   through the mergeable string, at the end or below the title and any
   section chips already there. `clearExistingSectionLinks` first removes
   glyphs whose attachment answers `isParagraphLinkAttachment` (note-link
   chips share the type but not that answer) and marks those attachments for
   deletion. A chip alone on its line is removed with its line break; the
   ranges are merged first, because two chip lines at the end of a note widen
   into overlapping ranges, and deleting them one after the other ran past the
   end of the text. A separator added below the title copies only the last
   paragraph's style, never its other attributes.

A link into another note needs that note's `ifTargetRevision` as well, and
the target is written only when an identifier is minted. The read-back
checks the source text against the planned text, exactly one glyph for the
new attachment, the persisted attachment and its token (target note and
paragraph), that the target paragraph carries the identifier uniquely, that
a target note's text is unchanged, that its other paragraphs kept their
identifiers, and that cleared attachments are marked for deletion. The
copy-store script confirms each chip with the `listNoteLinks` reader.
On the 2026-09-24 copy test no recent note had a heading, so the default and
`heading` selectors have not yet run against a store; `blockIndex` and `paragraphId`,
minting in the same and in another note, and clearing ran on the copy.

### Native tables

A Notes table is an attachment (UTI `com.apple.notes.table`) whose content
is a CRDT document in `ICAttachment.mergeableData`. The body holds one U+FFFC
glyph per visible table, carrying an attachment object that names the
attachment. `ICTable` gives every row and column a stable identity, so the
writer's table actions address rows and columns by that UUID. A headless
process has to call `+[ICTable registerWithICCRCoder]` before it opens a
table document.

- `read_tables` (read) lists every active top-level table with its glyph
  count, row and column identifiers, cell text, and a `t1:` digest (SHA-256
  over the attachment identifier, its deletion flag, and the serialized
  document). A table larger than 1000 rows or columns or 10000 cells, or one
  without unique identities, is reported `readable: false`.
- `delete_table_row`, `insert_table_row`, `set_table_cell` (writes) edit the
  `ICTable`, serialize it with `-[ICAttachmentTableModel writeMergeableData]`,
  bump the attachment's and the note's change counts, and save once. The
  read-back checks that the body string is unchanged, that the glyph is still
  present exactly once, and that the re-read table equals the planned
  snapshot.
- `prune_orphan_table` (write) handles an active table attachment with no
  body glyph (an orphan: invisible, but still synced and counted). It calls
  `updateMarkedForDeletionStateAttachmentIsInUse:NO` and `markForDeletion`,
  which is Notes' own deletion path, and bumps the note's change count so a
  concurrent Notes save conflicts. It refuses a body with an attachment glyph
  whose attachment it cannot identify, since that glyph could be the table's,
  and before saving it refuses any staged change beyond the note and the table
  (`unexpected_changes`), as the smart-folder writes do. The note body and
  modification date do not change, so the note `revision` stays the same; the
  read-back checks that the table row still exists, is marked for deletion,
  and that the active table count dropped by exactly one.

Every table write takes `ifTableDigest` as a second compare-and-swap token
(`attachment_conflict`, `committed: false`). Row deletion and the prune are
two-phase: the dry run opens the store read-only (a timeout there is a failed
read, not an indeterminate write), and the apply must present the dry run's
tokens. `TABLE_WRITES_LIVE_VALIDATED` is false. The copy-store script covers
all four writes; for the prune it builds an orphan on the copy by
reassigning another note's table row with SQL, since no ordinary edit leaves
one behind.

### Smart folders

A smart folder is an ordinary synced `ICFolder` row with `folderType` 2 and a
query document in `smartFolderQueryJSON`. The read-only `list-smart-folders`
reader decodes those rows with SQL; the writer adds `read_smart_folder`
(read) and `create_smart_folder`, `update_smart_folder`, and
`delete_smart_folder` (writes).

- Query pipeline: the writer parses the request, peels Notes' outer
  `{"and":[{"deleted":false}, X]}` wrapper, checks every clause against the
  known set (booleans such as `checklist` and `pinned`, `attachmentSection`,
  `tag`, `folder`, date ranges, participants; 32 levels and 256 clauses at
  most), resolves `tag` names with `+[ICHashtag
  standardizedHashtagRepresentationForDisplayText:]` to exactly one tag in the
  destination account, and wraps a bare `folder` clause in a one-item `or`
  (the shape Notes resolves). It then sets the document on a scratch folder in
  a read-only context, parses it with `-smartFolderQueryObjC`, builds the
  filter selection, and asks `+[ICQueryObjC
  objc_queryForNotesMatchingFilterSelection:]` to regenerate it. The
  regenerated document is what gets stored. Observed on macOS 27.2: Notes'
  filter model drops a `not` and collapses some `and` groups, so the writer
  compares a normalized form of the request and of the regeneration and
  refuses the query when they differ (`query_not_representable`).
- Revision: folders have no `r1:` note revision, so the update and delete
  compare an `f1:` folder revision, a SHA-256 over the identifier, title,
  type, canonical query, account, parent, deletion flag, child-folder and
  note counts, title timestamp, and the cloud state's local version.
  `create_smart_folder` takes none, because nothing exists yet; its guard is
  the title check in the write context right before the save, and an
  identical existing smart folder makes it a no-op.
- Saves: the create uses `+[ICFolder newFolderInAccount:]` or
  `newFolderInParentFolder:`, sets the title, query, and type, and stamps
  `dateForLastTitleModification` (and `parentModificationDate` when nested),
  which the factories leave nil and which otherwise let the first server echo
  revert the title or drop the parent. The update changes the query only: a
  folder without a title or parent timestamp keeps it missing, reported in
  `timestampsMissing`, since stamping one would claim a title or parent change
  that did not happen. The delete calls `-markForDeletion`.
  Before each save the writer checks that the context holds only the intended
  changes (`unexpected_changes`, `committed: false`), and after it re-reads
  the folder through a new read-only stack.
- A write that fails before its first save reports `committed: false` even
  when the failing check did not set it; the writer tracks whether a save was
  attempted.
- A smart folder is never a parent, the same rule as the smart-folder
  destination guard: the refusal carries `reason: "smart_folder_destination"`.
- The sync nudge moves a note into its own folder and has no folder
  equivalent, so the smart-folder tools do not offer it.
  `SMART_FOLDERS_LIVE_VALIDATED` is false. On the earlier combined-helper
  branch, a live create, query repair, and delete in a test folder were
  recorded as uploaded by Notes.app without a relaunch (not checked on a
  second device).

### Paper authoring (`add_paper`)

`native-add-paper` turns stroke and shape JSON, or an SVG normalized by the
`analyze-svg` analyzer, into `{strokes: [{ink, color, width, points}]}`
(`utils/paperAuthoring.ts`) and sends it to the writer's `add_paper` action.
The writer builds a public `PKDrawing` from it and hands it to NotesShared:

| Format | Created by | Drawing stored in |
|---|---|---|
| `paper` (`com.apple.paper`) | `+[ICPaperAttachmentCreationHelper createSystemPaperAttachmentWithPKDrawing:inNote:]` | a bundle, `Accounts/<account>/Paper/Bundles/<attachment>.bundle` beside the store |
| `drawing` (`com.apple.drawing.2`) | `-[ICNote addInlineDrawingAttachmentWithAnalytics:]` then `-[ICAttachment setMergeableData:]` | the attachment's mergeable data in the store |

`format: "auto"` picks Paper when this macOS offers its creation API. The
writer then inserts the attachment glyph (U+FFFC) as the note's last
paragraph through the body CRDT, updates the preview when it can (best effort),
bumps both cloud states, and saves under the write contract above.
Verification opens a new read-only stack, checks the attachment belongs to the
note and its glyph is in the saved text, and decodes the drawing again
(`ICSystemPaperDrawingsHelper` for Paper, the inline drawing model for a
classic drawing): the stroke and point counts must equal what was written. A
live Paper bundle is decoded from a private temporary copy.

Findings, macOS 27.2, on copy stores:

- PencilKit traps when building a drawing in a process with no bundle
  identifier. The writer embeds an Info.plist (`__TEXT,__info_plist`) with
  `io.github.apple-notes-mcp.private-writer`; PencilKit keeps its replica
  identity in that preferences domain.
- The monoline ink is serialized as pen and the reed ink is not recognized,
  so the writer offers only inks whose identifier survives a serialization
  round trip, and refuses any stroke that comes back as a different ink.
- A copy-store run redirects every `ICAccount` directory method into
  `Accounts/` beside the copy before the store opens, so the bundle and
  previews never reach the live container. The redirect replaces all eleven
  methods or none. `scripts/test-private-writer-paper-copy-store.sh` checks
  both formats, the replay refusal, and the live container.
- Shapes are traced as strokes. Notes' typed shapes live in the Paper bundle's
  own model, which no stable entry point exposes, so none are created.

The read-back also requires the new glyph to be in the text exactly once and
the rest of the text to equal the text before the write. Reading a Paper
drawing back is `read_paper`, below.

### Paper reading (`read_paper`)

`native-read-paper` decodes one Paper drawing read-only. Like the add's
verification of a live write, it copies the drawing's bundle into a private
temporary directory, redirects every `ICAccount` directory method there before
the store opens (read-only), and removes the copy afterwards; nothing opens
the live bundle. The result has three layers, each with its own availability:

- **Strokes**: `+[ICSystemPaperDrawingsHelper drawingsForAttachment:]` returns
  public `PKDrawing` objects; each stroke's ink, sRGB color, transform, render
  bounds, and points are reported, within a point budget.
- **Typed shapes** (macOS 27): PaperKit's public `ShapeMarkup` describes a
  shape's kind, frame, rotation, colors, line markers, text, and path, but
  only inside a `PaperMarkup`. The only way from a Notes bundle to one is two
  internal Swift entry points, `CRDataStoreBundle<Paper>.readPaper(_:url:)`
  (in Coherence, exported by PaperKit) and `PaperMarkup.init(model:)`. The
  writer is Objective-C, so it calls them, and then only public PaperKit
  accessors, through the Swift calling convention with clang's `swiftcall`
  attributes: resilient values (`URL`, `Capsule<Paper>`, `PaperMarkup`, the
  shape enums, `AttributedString`) travel by address in buffers sized from
  their runtime metadata; `readPaper` takes the `CRDataStoreBundle<Paper>`
  metadata as `self` (from `swift_getTypeByMangledNameInContext`); the
  element list is walked as `any Markup` existentials whose type is compared
  with `ShapeMarkup`'s metadata; enum cases come from the value witness
  table's `getEnumTag`. Every symbol and type is resolved with `dlsym` when
  first needed, so a missing one is reported (`private_api_unavailable` with
  `missing`), never a failed load, and the layer is offered only on macOS 27
  (`requires_macos_27` elsewhere). The shape's path is in unit space mapped
  onto the frame; the writer applies the frame and the rotation (about the
  frame's center) and reports the path as SVG path data. A text box is a
  rectangle with text. Swift values this action creates are not released;
  the writer handles one request and exits.
- **Fallback geometry**: when the attachment records a
  `fallbackPDFGeneration`, Notes keeps a vector PDF of the drawing for
  clients that cannot read the bundle, at
  `Accounts/<account>/FallbackPDFs/<attachment>/<generation>/FallbackPDF.pdf`.
  The writer opens it with `O_NOFOLLOW` (at most 16 MiB, a regular file) and
  runs `CGPDFScanner` over each page's content stream, tracking the
  transformation matrix, line width, and gray, RGB, or CMYK colors, and
  reports every stroked or filled path in page space. Text, images,
  shadings, and form XObjects are counted, not decoded. None of the Paper
  drawings on the test library had a fallback PDF (only scanned documents
  did); `-[ICSystemPaperDocument toFallbackPDFData]` returned nothing for them
  in a writer process, and `+[ICAttachmentPaperBundleModel
  generateFallbackPDFDataForAttachment:]` needs Notes' shared context, which
  the writer does not start, so the writer reads the stored file only.

Findings, macOS 27.2, 2026-09-24: on the live library (read-only) a Paper
drawing decoded to 19 strokes, and PaperKit's element list reported the same
19 strokes and no shapes. On a store copy, a bundle written with PaperKit's
own model (a rectangle, a rotated ellipse, a star, an arrow shape, a line with
an arrow marker, a text box, and one stroke) decoded to those six shapes with
their kinds, frames, colors, markers, and text; each shape's path bounds
matched its frame and its `renderFrame` less half the line width.
`scripts/test-private-writer-paper-copy-store.sh` checks the strokes of a
drawing it adds, the element list, a fallback PDF fixture, and a live read
that leaves the note and bundle unchanged.

### Purge-flag repair (`repair_purge_flag`)

Notes deletes a note by moving it to the account's Recently Deleted folder
(`-[ICAccount trashFolder]`, `folderType` 1); `markedForDeletion` stays clear.
It sets that flag only when the note leaves Recently Deleted for good (the
30-day expiry, measured from `folderModificationDate`, or a delete there), and
the flag makes Notes purge the record locally and in iCloud. A note flagged
while still in an ordinary folder is in neither state: Notes hides it and will
purge it, but it never passed through Recently Deleted, so the user cannot
recover it. The known cause is a tool that called `-markForDeletion` instead
of moving the note.

The writer's `repair_purge_flag` action:

- Dry run without `identifier`: scans for notes flagged outside Recently
  Deleted (or flagged with no folder), up to 50.
- Dry run with `identifier`: the note's state, blockers (locked, shared,
  still downloading, no Recently Deleted folder in its account, an account
  being deleted, attachments that carry the flag themselves), and its `r1:`
  revision.
- Apply (`dryRun: false`, `ifRevision`, `confirm: true`): re-checks the state
  and revision in the write context, calls `-unmarkForDeletion`,
  `-notifyAttachmentsNoteWillMoveToRecentlyDeletedFolder` (when present; what
  Notes calls before a trash move), `-setFolder:` with the account's trash
  folder, stamps `folderModificationDate` (CloudKit's last-writer-wins stamp
  for the folder reference and the start of the 30-day clock), and
  `-updateChangeCountWithReason:`. It refuses any staged change beyond the
  note, its old and new folder, its account, and its attachments
  (`unexpected_changes`). A fresh read-only stack then checks the flag is
  clear, the folder is Recently Deleted, `isDeletedOrInTrash` is true, the
  timestamp was stored, and the body data is unchanged.

It never calls `-markForDeletion`, `+deleteNote:`, or `deleteObject:`.

Risk: a flag Notes set on purpose (a permanent delete on another device whose
record has synced here but not yet been purged) looks the same locally.
Repairing it moves that note back into Recently Deleted, and the move then
syncs to every device. Hence the dry run, `confirm`, and the advice to repair
only a note the user recognizes. Verified on copy stores
(`scripts/test-private-writer-guards-copy-store.sh`, which puts a note into the
flagged state with sqlite3 on the copy only); not validated live, so
`PURGE_REPAIR_LIVE_VALIDATED` is false.

### Still open

The three concerns in "Why writes were deferred" are not resolved by this
layer: it makes writes opt-in, guarded, and verifiable, not proven safe.
Concurrent saves are handled only by optimistic locking, CRDT replica
identity in a process without a bundle identifier is uninspected, and upload
depends on Notes.app (the nudge works around the observed skip).

---

## Permissions check

`apple-notes-mcp setup --permissions` (`src/services/permissions.ts`) is a setup aid, not part of the server. It reuses the probes the server already trusts and adds nothing that writes.

### Probes

| Item | Probe | Status values |
|------|-------|---------------|
| Full Disk Access | `hasFullDiskAccess()`: `sqlite3 -readonly NoteStore.sqlite "SELECT 1;"` | granted, missing, unknown (probe threw) |
| Automation of Notes.app | `tell application "Notes" to get name of account 1`, one attempt, 60 s | granted; missing when `isPermissionDenied` matches (-1743); unknown for any other failure |
| Shortcut bridges | `setupShortcuts(true)`, the `setup --check` path | granted, missing, unknown (the `shortcuts` command failed) |
| Speech Recognition | public helper `speech_status`: `SFSpeechRecognizer.authorizationStatus()`, never `requestAuthorization` | granted; missing for denied or restricted, and for notDetermined before macOS 26; not_needed for notDetermined on macOS 26+; unknown while the helper is not built |

Automation cannot be read without an Apple event: `get-capabilities` reports it as `unverified` for that reason. The setup command is run by a person at the keyboard, so it does send one read-only event. If the grant is undetermined, macOS shows its "wants to control Notes" prompt, which is the only way to create an Automation grant (the Automation pane has no + button). The 60-second timeout leaves time to answer it.

On macOS 26 and later the helper transcribes with SpeechAnalyzer, which needs no grant, so only an explicit refusal blocks it (see `checkSpeechAccess` in the helper). `speech_status` reports `requiresGrant` from the same `#available(macOS 26, *)` test, so the check and `transcribe` cannot disagree.

### Whose grants

TCC attributes a grant to the responsible process. A terminal passes responsibility to its children; Claude Desktop does not (see `fdaRemediation`). The check therefore walks up the process tree with `ps` to the nearest ancestor inside an `.app` bundle and names it. The result describes the process running the check. It can differ from the MCP host's, which is why the report says so and the agent guidance points to `doctor` inside the host.

### Settings URLs

Apple documents the Full Disk Access URL in `EndpointSecurity/ESClient.h`: `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` on macOS 13 and later, and `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` until macOS 12. The Automation (`Privacy_Automation`) and Speech Recognition (`Privacy_SpeechRecognition`) anchors are not in a public header. They follow the same naming and appear in the anchor list of `/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex` (checked on macOS 27.2, 2026-09-24). A future macOS could rename them; the report also prints the pane's path, so the user can still find it by hand. `openSettingsPane` opens only a URL that starts with `x-apple.systempreferences:` and belongs to a reported item.

### Window

The optional window (`native/permissions-window/apple-notes-permissions-window.swift`, `src/services/permissionsWindow.ts`) is built, signed, verified and installed exactly like the public helper, in its own Application Support folder with its own manifest. It speaks JSON lines: the command sends `{"type":"report","report":{...}}`, and the window sends `{"type":"open","id":...}` or `{"type":"recheck"}`. Anything else is ignored. The window holds no probe code and no URLs, so a report and its buttons cannot disagree with the terminal output, and a compromised window can at most ask to open one of the reported panes. It runs as a child of the command, so it shares the command's launching app. A `hello` line makes it answer and exit without creating a window, which is how setup and the tests verify it without showing UI.

---

## Template editor server

`apple-notes-mcp templates edit` (src/services/templateEditor.ts) starts a local
HTTP server. It is a command-line tool, never
started by the MCP server, and it runs until Ctrl-C or an idle timeout.

### Design

- **Reuse, not a second implementation.** Validation is `parseTemplate`, the
  preview is `renderNotesWithTemplate`, and save is `TemplateStore.save`, the
  same functions behind `validate-markdown-template`, `export-notes-markdown`
  and `save-markdown-template`. The page sends the raw JSON text so JSON
  syntax errors keep their line and column.
- **Sample notes by default.** src/utils/templateSamples.ts builds three
  synthetic block models (structure, inline formatting, attachments) with
  fixed metadata, so front matter placeholders have values. With the
  standard template each renders exactly as the fixed renderer does. A real
  note is read only with `--note <id>`, once at startup, through
  `readExportNote`/`readExportNoteMeta` (`sqlite3 -readonly`). No asset
  writer is passed, so file attachments render as placeholders and nothing
  is copied.
- **One page, no network.** The page is a string with one `<style>` and one
  `<script>`, each with a per-response nonce. The CSP is
  `default-src 'none'` plus those nonces and `connect-src 'self'`. The script
  writes only `textContent`.

### Request checks, in order

1. `Host` must equal the bound `address:port` (HTTP 421 otherwise). This
   stops DNS rebinding, where a hostile name resolves to 127.0.0.1.
2. The token (32 random bytes, hex, per run) must arrive as `?token=` or
   `Authorization: Bearer`, compared with `timingSafeEqual` (401).
3. `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`, and `Origin`,
   when sent, must be the editor's own origin (403). There is no CORS
   response, so a cross-origin script cannot read anything even if it
   guessed the token.
4. POST must carry the editor's `Origin` and `Content-Type: application/json`
   (403/415), which a cross-site HTML form cannot send. Bodies are capped at
   twice the template size limit (413).

Only requests that pass these checks reset the idle timer, so a stray
scanner cannot keep the editor alive. Unexpected failures return a generic
500 without the error text. The token is printed once on stdout, as part of
the URL, and never logged.

### `--tailnet`

The address comes from `os.networkInterfaces()`: the first non-internal IPv4
in 100.64.0.0/10, preferring `utun*` interfaces. No `tailscale` command runs,
and no Tailscale, Serve/Funnel or firewall setting is read or changed.
`findTailnetAddress` in src/utils/localServer.ts does this for both the
editor and `anchors serve`. The same module holds the parts the two servers
share: the per-run token, the Bearer header reader, the constant-time
comparison, the `Host` authority and the cross-origin check (used by the
editor only). Each server keeps its own order of checks and status codes.
Without such an address the command exits 1. The same token, host and origin
checks apply. Tailscale encrypts the traffic between devices, but the
editor speaks plain HTTP and anyone on the tailnet who can reach the port and
has the URL can save templates. The address range is shared with other
carrier-grade NAT users, so on a Mac with another VPN in that range the
editor could bind to that VPN's address instead; the startup message names
the bound address.

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
