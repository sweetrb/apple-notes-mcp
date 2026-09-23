# Full Disk Access

Apple Notes MCP works almost entirely without any special disk permission. The
tools that need **Full Disk Access (FDA)** for the process that runs the MCP
server are the ones that read Notes' own SQLite store:

- **`get-checklist-state`** — reads a note's checklist done/undone state.
- **Checklist annotations in `get-note-markdown`** — the `[x]` / `[ ]` prefixes on
  checklist items.
- **`get-note-metadata` (BETA)** — pinned state, checklist flags, trash/recovery
  state, snippets, password hint. These columns exist nowhere else, so this tool
  needs FDA unconditionally.
- **`get-note-link`** — its primary path reads the note's `ZIDENTIFIER` from the
  database. On macOS 12–15 it can fall back to the AppleScript `note link`
  property; that property is absent from the Notes SDEF on macOS 26+, so there
  FDA is the only route.
- **`get-sync-status`** — degrades rather than fails: without database access it
  cannot see pending uploads or recent write activity.

Everything else (creating, reading, searching, updating, moving, deleting notes;
folders, accounts, attachments, stats, export, etc.) works **without** Full Disk
Access.

## Why it's needed

Apple Notes stores checklist items as a paragraph style inside a gzipped protobuf
blob in its SQLite store, `NoteStore.sqlite`. AppleScript's `body of note`
interface strips that state — it can't tell you whether a checklist item is
checked. The same store also holds the pinned/trash/snippet columns behind
`get-note-metadata` and the `ZIDENTIFIER` value behind `get-note-link`. To
recover any of them, the MCP reads the SQLite store directly.

That database lives in a macOS-protected directory:

```
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
```

Reading anything under `~/Library/Group Containers/` requires **Full Disk
Access** for the process that runs the server — without it, macOS denies the read. (The MCP only
ever **reads** this database; it never writes to it.)

## How to grant Full Disk Access

1. Open **System Settings** (or **System Preferences** on older macOS).
2. Go to **Privacy & Security → Full Disk Access**.
3. Click the **+** button (you may need to unlock with Touch ID / your password
   first) and add the right entry for how you run the server:
   - **Claude Desktop** → the **Node binary** that runs the server, e.g.
     `/usr/local/bin/node` or `~/.nvm/versions/node/v24.11.1/bin/node`. The
     `doctor` tool prints the exact path. In the file picker, press **⌘⇧G** and
     paste it (use **⌘⇧.** to show hidden folders such as `~/.nvm`). Adding
     `/Applications/Claude.app` as well does no harm, but on its own it is not
     enough (see below).
   - **Claude Code or another client in a terminal** → the terminal app:
     `/Applications/Utilities/Terminal.app` or `/Applications/iTerm.app`
   - **VS Code** → `/Applications/Visual Studio Code.app`
4. Make sure the toggle next to the entry is **on**.
5. **Fully quit and reopen the host app.** macOS only applies the new permission
   to processes started *after* the change. A reload or restart-server is not
   enough; quit the host application itself (⌘Q) and relaunch it. If `doctor`
   still reports Full Disk Access as not granted after that, restart the Mac.

> **Why Claude Desktop needs the Node binary itself.** macOS checks Full Disk
> Access against the *responsible process*, the app it holds accountable for a
> request. A terminal passes that role on to everything it launches, so a grant
> on Terminal or iTerm covers the server. Claude Desktop does not: it starts each
> MCP server through a helper that *disclaims* responsibility, which makes the
> `node` process its own responsible process. macOS then looks for a grant on the
> Node binary's path and ignores the one on Claude.app
> ([#220](https://github.com/sweetrb/apple-notes-mcp/issues/220)).
>
> The grant is tied to that exact path. With a version manager (nvm, fnm, Volta,
> asdf, mise) the path changes with every Node version, so switching versions
> drops the grant, and `npx` runs whichever `node` is first on the `PATH` Claude
> Desktop sees. Pointing the config at one fixed Node binary keeps the grant
> stable:
>
> ```json
> "apple-notes": {
>   "command": "/Users/you/.nvm/versions/node/v24.11.1/bin/node",
>   "args": ["/path/to/global/node_modules/apple-notes-mcp/build/index.js"]
> }
> ```
>
> A Developer-ID-signed Node keeps its grant across updates at the same path;
> an ad-hoc-signed one (typically Homebrew's) does not. See
> [Node runtime and TCC permissions](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

## Verifying it worked

Run the **`doctor`** tool. It reports a dedicated **Full Disk Access** check as
`ok` / `warn` / `fail` with the reason, so you can confirm the grant took effect
without guessing. You can also just call `get-checklist-state` on a note that has
a checklist — if it returns items with `[x]`/`[ ]` state, FDA is working.

## Without Full Disk Access

The server degrades gracefully — nothing crashes:

- `get-checklist-state` returns a clear error explaining that database access is
  needed (and points here).
- `get-note-metadata` returns the same kind of error — it has no non-database
  path, so it cannot answer at all without FDA.
- `get-note-link` returns an error on macOS 26+. On macOS 12–15 it still works,
  via the AppleScript `note link` fallback.
- `get-note-markdown` still returns the note as Markdown, but checklist items
  appear as plain list items without the `[x]`/`[ ]` annotations.
- `get-sync-status` still answers, but with no database visibility it reports no
  pending uploads and no active sync — treat that as "unknown", not "idle".
- **Every other tool works normally**, since the rest of the server is pure
  AppleScript.

See also: [Known Limitations](../README.md#known-limitations) and
[Creating Checklists](../README.md#creating-checklists) in the README.
