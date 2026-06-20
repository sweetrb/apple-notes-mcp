# AppleScript Limitations

Apple Notes is automated through its AppleScript dictionary. A few features that
exist in the Notes UI are simply **not exposed to AppleScript**, so this MCP
server cannot read or write them no matter how the script is written. This page
documents what was investigated, how it was verified, and the conclusion, so the
limitation isn't re-investigated every release.

The full set of properties Notes exposes on a `note` is:

```
container, class, password protected, modification date, creation date,
shared, body, id, name, plaintext
```

(obtained with `properties of note 1 of account "iCloud"`).

## Pinned notes (#28)

**Status: not feasible via AppleScript.** The Notes UI lets you pin a note to
the top of a folder, but the `note` class has no `pinned` property. Asking for
it raises error `-1700`:

```applescript
tell application "Notes"
    set p to pinned of note 1 of account "iCloud"
    -- error -1700: Can't make pinned of note id "x-coredata://…" into type specifier.
end tell
```

There is no alternative property, element, or command (`pin`, `pinned`,
`favorite`, …) in the dictionary. Pinned state lives only in Notes' private
Core Data store (`NoteStore.sqlite`), which is not part of the scriptable
surface. Reading it would require parsing the SQLite store directly — brittle
across macOS releases and outside what an AppleScript-based server should do —
and there is no supported way to *set* it at all.

**Conclusion:** pinned read/write is not supported and will not be added while
Notes lacks a scriptable property. If a future macOS exposes one, revisit by
re-running the probe above.

## Note-to-note links (#30)

<!-- documented in #30 -->
