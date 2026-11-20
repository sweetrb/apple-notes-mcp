# Native Tags bridge

`Notes MCP Tags.shortcut` adds actual native Apple Notes tags.
It contains no note contents or credentials. The unsigned source is committed
beside it and can be regenerated with:

```sh
python3 scripts/build-native-tags-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Notes MCP Tags.unsigned.shortcut" \
  --output "shortcuts/Notes MCP Tags.shortcut"
```

Open the signed file and confirm **Add Shortcut** once. macOS may also request
Notes access on first execution. The `shortcuts` CLI can run an installed
workflow but cannot silently import one.

The bridge names are short so Shortcuts.app shows each one whole on its tile.
Bridges installed under the pre-2.16.1 names (`Apple Notes MCP - Native Tags`,
`Apple Notes MCP - Background Operations v6`, `Apple Notes MCP - Create Markdown Note`)
are still found when nothing is installed under the current name.

After install and after every upgrade, run each bridge once in the foreground in
Shortcuts.app and choose **Always Allow** when it asks for permission. The
server runs bridges in the background, where Shortcuts cannot display a
first-run consent prompt, so an unanswered one stalls that bridge's native
writes until they time out. Quitting or relaunching Shortcuts.app or Notes.app
does not clear it; one foreground run per bridge does.

The bridge receives a private temporary JSON file with a title, a distinctive
existing scope phrase, and normalized tags. Both the server and workflow refuse
ambiguous note selection. Server readback, rather than CLI output, establishes
success and verifies that existing content survived.

## Background Operations bridge

`Notes MCP Background v6.shortcut` performs native append,
checklist and table creation, pin state changes, link insertion, tag removal, and
file attachment. Its input is the JSON request, optionally followed by one file:
`add-file` hands that file to Notes' Add File to Note action, which inserts it into
the note body once, where AppleScript's `make new attachment` inserts it twice (#321).
The file must be the input itself: Add File refused a file the workflow built with
Base64 Decode and Set Name. v6 replaces v5; delete `Apple Notes MCP - Background
Operations v5` from Shortcuts.app after installing v6.
Markdown append hands Notes the plain text with "Interpret as Markdown" (Notes' own
parser, as the Create Markdown Note bridge does) rather than pre-rendering it in
Shortcuts (#308). On a Notes build without that option the server sends its own
HTML rendering through `append-html` instead (see below, #337). Its allowlist rejects unknown operations. It uses exact title plus distinctive
existing scope text, and the server verifies the note revision and preserved
rich content before accepting any result.

Regenerate and test the unsigned source with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-operations-shortcut.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build-native-operations-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Notes MCP Background v6.unsigned.shortcut" \
  --output "shortcuts/Notes MCP Background v6.shortcut"
```

Open the signed file and confirm **Add Shortcut** once, then run it once in the
foreground in Shortcuts.app and choose **Always Allow** (see above). Do not install obsolete
workflow versions with the same display name; the server resolves one exact
installed UUID and refuses duplicates.

## Notes builds without "Interpret as Markdown" (#337)

Both Markdown bridges depend on the "Interpret as Markdown" option of Notes'
generic Create Note (`CreateNoteLinkAction`) and Append to Note
(`AppendToNoteLinkAction`) actions. On macOS 26.6.2 (Notes 4.13) those actions
have no such option: Notes offers separate Create Note from Markdown
(`CreateNoteFromMarkdownLinkAction`: `name`, `markdownContents`, `folder`) and
Append Markdown to Note (`AppendMarkdownToNoteLinkAction`: `entity`,
`markdownText`) actions instead, and silently ignores the flag, so the bridges
would save the Markdown as literal text. macOS 27.2 builds that also report
Notes 4.13 still have the option, so the Notes version alone does not decide it.

The server reads Notes' App Intents metadata
(`/System/Applications/Notes.app/Contents/Resources/Metadata.appintents/extract.actionsdata`,
a plain file read that never contacts Notes) and, when the option is missing:

- `create-note` with `format: "markdown"` and no `markdownRoute` uses
  `markdownRoute: "html"`; an explicit `markdownRoute: "shortcut"` is refused
  before anything is created, and `get-capabilities` reports
  `create-note-markdown` unavailable.
- `append-native` with `format: "markdown"` sends the server's HTML rendering
  through the bridge's `append-html` branch, the same one `format: "html"` uses,
  so `###` renders as Heading rather than Subheading.
- `doctor` and `setup --check` say so.

A bridge built on the dedicated actions has not shipped yet: it has to be built
and signed in Shortcuts.app on such a release. Set
`APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS=1` to turn the detection off.

## Create Markdown Note bridge

`Notes MCP Markdown.shortcut` creates one note with Notes'
Create Note action and "Interpret as Markdown" (macOS 26+, iCloud accounts only)
in the iCloud default folder. It is optional: only `create-note` with
`format: "markdown"` uses it, and neither `setup --check`'s readiness nor
`doctor`'s native-write check depends on it. It reads the same JSON request file and runs only
for `operation: "create-markdown"`; it has no search, edit or delete actions.
The server finds the new note by exact ID and verifies it before reporting
success. It is refused on a Notes build whose Create Note action has no
"Interpret as Markdown" option (see above, #337).

Regenerate and test the unsigned source with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-markdown-note-shortcut.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build-markdown-note-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Notes MCP Markdown.unsigned.shortcut" \
  --output "shortcuts/Notes MCP Markdown.shortcut"
```

Open the signed file and confirm **Add Shortcut** once. Then run it once in the
foreground so macOS can ask for Notes access, and choose **Always Allow**. A
background run cannot show that prompt and waits until the server times out.
Run by hand with no input, the Shortcut stops before reaching Notes, so start the
first run with a request instead. This creates a note titled "Apple Notes MCP
check", which you can delete:

```sh
open "shortcuts://run-shortcut?name=Notes%20MCP%20Markdown&input=text&text=%7B%22operation%22%3A%22create-markdown%22%2C%22text%22%3A%22%23%20Apple%20Notes%20MCP%20check%22%7D"
```
