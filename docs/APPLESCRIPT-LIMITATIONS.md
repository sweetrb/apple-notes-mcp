# AppleScript Limitations

Apple Notes is automated through its AppleScript dictionary. A few features that
exist in the Notes UI are simply **not exposed to AppleScript**, so no script can
read or write them. Where this server recovers one of them anyway, it does so by
reading Notes' private `NoteStore.sqlite` store **read-only** — which needs
[Full Disk Access](./FULL-DISK-ACCESS.md). Each section below says which case it
is. This page documents what was investigated, how it was verified, and the
conclusion, so the limitation isn't re-investigated every release.

The full set of properties Notes exposes on a `note` is:

```
container, class, password protected, modification date, creation date,
shared, body, id, name, plaintext
```

(obtained with `properties of note 1 of account "iCloud"`).

## Pinned notes (#28)

**Status: not feasible via AppleScript; read from the NoteStore database and set through a Shortcut.**
The Notes UI lets you pin a note to the top of a folder, but the `note` class
has no `pinned` property. Asking for it raises error `-1700`:

```applescript
tell application "Notes"
    set p to pinned of note 1 of account "iCloud"
    -- error -1700: Can't make pinned of note id "x-coredata://…" into type specifier.
end tell
```

There is no alternative property, element, or command (`pin`, `pinned`,
`favorite`, …) in the dictionary. Pinned state lives only in Notes' private
Core Data store (`NoteStore.sqlite`), which is not part of the scriptable
surface, and AppleScript offers no way to _set_ it.

Reading it, however, did turn out to be worth doing. Since 2.5.0 the BETA
`get-note-metadata` tool queries `ZISPINNED` on `ZICCLOUDSYNCINGOBJECT` in that
store, opened **read-only**, feature-detecting each column with
`PRAGMA table_info` so it degrades instead of breaking when the private schema
changes across macOS releases. It requires
[Full Disk Access](./FULL-DISK-ACCESS.md) and is marked BETA precisely because
the schema is version-dependent.

**Conclusion:** pin state is **not scriptable** through AppleScript in either
direction. It is **readable** (BETA, from the NoteStore database, Full Disk
Access required) and, since the native background operations were added,
**settable** through the packaged Background Operations Shortcut by
`set-note-pinned`, which checks the expected current state and the note
revision first. If a future macOS exposes a scriptable property, revisit by
re-running the probe above.

## Note-to-note links (#30)

**Status: link _relationships_ are not exposed to AppleScript; the server reads them from the database and inserts links by other routes.**
Apple Notes lets you insert a link from one note to another in the UI, but
AppleScript exposes no property or element for that relationship:

- A `note` has no `URL`, `url`, or `link` property — each raises error `-2753`
  (undefined). There is no element that enumerates outgoing/incoming links.
- Nothing in the dictionary inserts a link into a note's body.

A shareable deep link to a note _is_ available, and has been since 2.6.0:
`get-note-link` returns a `notes://showNote?identifier=<uuid>` URL that opens
the note in Notes.app on macOS and iOS.

- **Primary path — the NoteStore database.** The UUID in that URL is
  `ZIDENTIFIER` on `ZICCLOUDSYNCINGOBJECT`, read **read-only** from
  `NoteStore.sqlite`. This works on every macOS version but needs
  [Full Disk Access](./FULL-DISK-ACCESS.md).
- **Fallback — AppleScript.** On macOS 12–15 the Notes dictionary does expose a
  two-word `note link` property, used when the database read fails. It is absent
  from the Notes SDEF on macOS 26+, which is why the database is the primary
  path. (`note link` is a different term from the `URL` / `url` / `link` names
  probed above, which genuinely do not exist.)
- Password-protected notes return no link.

The `show` command reveals an object in the Notes UI by id:

```applescript
tell application "Notes" to show note id "x-coredata://…/ICNote/p123"
```

It **is** wrapped, as `show-note`, `show-folder`, `show-account`, and
`show-attachment`. Those tools activate the Notes.app GUI, so they only do
something useful on a machine with an active desktop session; to read a note's
content, use `get-note-content` / `get-note-markdown` instead.

**Conclusion:** AppleScript can neither read link relationships between notes
nor insert a link into a body. The server does both by other routes:
`list-note-links` reads a note's or folder's links from the NoteStore database
(Full Disk Access required), `insert-link` appends a web, mail or Notes link,
and `insert-note-link` appends another note's real deep link through the
Background Operations Shortcut. To hand a note to a person or another app, use
`get-note-link`; to address a note in a follow-up tool call, use the `id`
returned by every read tool.

## Tags / hashtags (#29)

**Status: not scriptable; native tags go through Shortcuts.** A native Apple
Notes tag is an inline tag attachment backed by an `ICHashtag` object in Notes'
private Core Data store. It is **not** a scriptable property — the `note` class
exposes no `tags` element — and `#word` text written through AppleScript stays
plain text: Notes does not convert it into a native tag.

This server therefore separates two things. `get-note-content` parses textual
`#hashtag` tokens out of the body and returns them as `hashtags` (see
`src/utils/hashtags.ts`); the rules match Notes' own — `#` followed by
letters/digits/underscores containing **at least one letter**, so `#123` is not
a tag; tokens are de-duplicated case-insensitively. Actual native tags are read
from the database (`nativeTags`, `list-native-tags`, Full Disk Access) and
written with `add-native-tags` / `remove-native-tags` / `replace-native-tag`,
which drive the Notes Shortcuts action. A textual `hashtags` entry is not proof
that Notes registered a native tag.

Two related caveats:

- The `tags` parameter on `create-note` is an application-level pass-through. It
  is stored on the returned object but Notes does **not** persist it, and it does
  **not** create tags. Typing `#tag` into the content does not either; use
  `add-native-tags` on the created note.
- **Smart folders are not scriptable.** Notes' tag-driven Smart Folders cannot be
  created, read, or enumerated via AppleScript; there is no `smart folder` class
  in the dictionary. Only regular folders are scriptable.
