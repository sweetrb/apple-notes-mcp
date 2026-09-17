# Native Tags bridge

`Apple Notes MCP - Native Tags.shortcut` adds actual native Apple Notes tags.
It contains no note contents or credentials. The unsigned source is committed
beside it and can be regenerated with:

```sh
python3 scripts/build-native-tags-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Apple Notes MCP - Native Tags.unsigned.shortcut" \
  --output "shortcuts/Apple Notes MCP - Native Tags.shortcut"
```

Open the signed file and confirm **Add Shortcut** once. macOS may also request
Notes access on first execution. The `shortcuts` CLI can run an installed
workflow but cannot silently import one.

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

`Apple Notes MCP - Background Operations v5.shortcut` performs native append,
checklist and table creation, pin state changes, link insertion, and tag removal.
Its allowlist rejects unknown operations. It uses exact title plus distinctive
existing scope text, and the server verifies the note revision and preserved
rich content before accepting any result.

Regenerate and test the unsigned source with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-operations-shortcut.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build-native-operations-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Apple Notes MCP - Background Operations v5.unsigned.shortcut" \
  --output "shortcuts/Apple Notes MCP - Background Operations v5.shortcut"
```

Open the signed file and confirm **Add Shortcut** once, then run it once in the
foreground in Shortcuts.app and choose **Always Allow** (see above). Do not install obsolete
workflow versions with the same display name; the server resolves one exact
installed UUID and refuses duplicates.

## Create Markdown Note bridge

`Apple Notes MCP - Create Markdown Note.shortcut` creates one note with Notes'
Create Note action and "Interpret as Markdown" (macOS 26+, iCloud accounts only)
in the iCloud default folder. It is optional: only `create-note` with
`format: "markdown"` uses it, and neither `setup --check`'s readiness nor
`doctor`'s native-write check depends on it. It reads the same JSON request file and runs only
for `operation: "create-markdown"`; it has no search, edit or delete actions.
The server finds the new note by exact ID and verifies it before reporting
success.

Regenerate and test the unsigned source with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-markdown-note-shortcut.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build-markdown-note-shortcut.py
shortcuts sign --mode anyone \
  --input "shortcuts/Apple Notes MCP - Create Markdown Note.unsigned.shortcut" \
  --output "shortcuts/Apple Notes MCP - Create Markdown Note.shortcut"
```

Open the signed file and confirm **Add Shortcut** once. Then run it once in the
foreground so macOS can ask for Notes access, and choose **Always Allow**. A
background run cannot show that prompt and waits until the server times out.
Run by hand with no input, the Shortcut stops before reaching Notes, so start the
first run with a request instead. This creates a note titled "Apple Notes MCP
check", which you can delete:

```sh
open "shortcuts://run-shortcut?name=Apple%20Notes%20MCP%20-%20Create%20Markdown%20Note&input=text&text=%7B%22operation%22%3A%22create-markdown%22%2C%22text%22%3A%22%23%20Apple%20Notes%20MCP%20check%22%7D"
```
