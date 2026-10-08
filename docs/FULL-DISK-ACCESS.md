# Full Disk Access and related permissions

Apple Notes MCP uses separate macOS permissions for different operations. Connecting an MCP client does not grant them. This guide covers the released 2.14.3 server; use diagnostics from the client that actually runs it.

| Requirement | Enables |
| --- | --- |
| Automation → Notes | AppleScript operations that read or change notes, folders, and accounts |
| Full Disk Access (FDA) | Reading the protected Notes database and media, including structured content, native-object verification, and some mutation guards |
| Installed Shortcuts and their first-run consent | Native tag, checklist, table, pin, and rich append operations; optional Markdown note creation |
| Public native helper | Classic PencilKit drawing decode and on-device audio transcription |
| Speech Recognition, where required by the macOS transcription route | On-device transcription; distinct from FDA and Notes Automation |

The server reads `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite` with read-only database access. Writes use the supported AppleScript or Shortcut routes. FDA does not unlock password-protected notes or enable unsupported native edits.

## Which features need Full Disk Access?

These groups use protected Notes data:

| Feature group | Tools and conditions |
| --- | --- |
| Search and library metadata | `query-notes`, `list-recent-notes`, `list-special-notes`, `list-folder-tree`, `get-note-metadata`, native tag inventory, Smart Folder rules, and database details in `get-sync-status` |
| Structured note contents | `get-note-blocks`, `get-note-structure`, `get-native-objects`, `get-note-tables`, `get-checklist-state`, `list-note-paragraphs`, `get-paragraph-link`, `list-note-links`, and stored audio transcripts |
| Portable exports | `export-notes-markdown`, `export-notes-html`, and attachment/media exports that read the Notes store |
| Attachments and drawings | `list-attachments` with `includePaths` or `firstImage`, `export-attachments`, `list-paper-attachments`, `export-paper-image`, `get-note-drawings`, and `transcribe-note-audio` |
| Guarded operations and identifiers | `delete-folder-by-id`; database-backed copy/active-note deletion guards; UUID or numeric note/folder selectors; native preservation/readback and Smart Folder destination detection |
| Optional private helper | `native-note-state`; the helper is read-only and requires its separate opt-in and build |

`get-note-link` needs FDA on macOS 26 and later. On macOS 12–15 it can fall back to Notes' AppleScript link property. `get-note-markdown` can still return Markdown without FDA, but native checklist done/undone annotations are unavailable.

Basic AppleScript paths can work without FDA after Automation is granted. That does not mean every use of a tool is available: its options, note contents, identifier form, and verification requirements can select a database-backed path. Guarded whole-body updates are unavailable when the server cannot read the metadata needed to establish that replacement is safe. Adding text to a note with native objects can route `append-to-note` through native append; deleting with a verified-copy guard also needs a database read. Keep exact IDs, fresh content hashes, and the tool's other preconditions. Do not bypass a refusal by rewriting the note through another route.

See the [tool reference](../README.md#tool-reference) for each operation's requirements and limitations.

## Check before changing permissions

Use `get-capabilities` inside your MCP client first. It reports feature requirements, missing components, and unverified checks without opening Notes.app or running a Shortcut. It leaves Notes Automation unverified because testing that permission requires an Apple event.

For a non-prompting command-line permission report:

```bash
npx -y apple-notes-mcp@2.14.3 setup --permissions --once --json --check
```

Use the package version and launch context that match your client. A check run in Terminal reports Terminal's process context; it does not certify a server launched by Claude Desktop or another desktop client.

Inspect each result, not only the exit code. `ready: true` can coexist with deliberately unprobed Automation and unavailable optional components. A missing public helper makes Speech status unknown. A Shortcut listed as installed may still be waiting for first-run consent.

The MCP `doctor` tool checks Notes reachability, Automation, accounts, FDA, runtime signing, and optional features. Unlike `get-capabilities`, it contacts Notes and can cause the first Automation prompt. Run it in the actual client when you are at the Mac and ready to answer that prompt. The optional feature matrix does not by itself determine `healthy`.

## Grant access to the correct process

1. Find the responsible process from diagnostics in the actual MCP client. For **Claude Desktop**, the server's **Node binary** needs FDA; the grant on Claude.app alone does not cover it. A terminal-launched server ordinarily uses the terminal app's permission; a server launched by VS Code uses that context. For other clients, confirm the reported process instead of assuming the app name is enough.
2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Click **+** and add the diagnosed app or Node executable. Press **⌘⇧G** in the file picker to enter an absolute path; **⌘⇧.** shows hidden files.
4. Enable its toggle, then fully quit and relaunch the host application so it starts fresh processes.
5. Re-run diagnostics inside that client. If FDA remains unavailable, verify the executable path and that the client was fully restarted before trying further changes.

FDA and Automation are independent. To check Automation from a terminal on the Mac, when you are ready for the first-use prompt:

```bash
npx -y apple-notes-mcp@2.14.3 setup --permissions --once --probe-automation
```

This sends one read-only Apple event. Accept the macOS prompt to allow the launching process to control Notes. `--check` and SSH sessions suppress this probe even when `--probe-automation` is present. `--open` can open the relevant System Settings panes; it does not change a permission.

## Complete the optional native setup

For native operations, install the packaged workflows:

```bash
npx -y apple-notes-mcp@2.14.3 setup
npx -y apple-notes-mcp@2.14.3 setup --check
```

Confirm **Add Shortcut** for each imported workflow. After installation or upgrade, run **Apple Notes MCP - Native Tags** and **Apple Notes MCP - Background Operations v5** once in the foreground in Shortcuts.app and choose **Always Allow** when asked. The optional **Create Markdown Note** bridge requires macOS 26+ and the documented input for its foreground run. Follow the [Shortcut setup instructions](../shortcuts/README.md).

Installation checks cannot read Shortcut consent state. An unanswered prompt can stall background native writes while the bridge still reports installed. If a write times out or its outcome is uncertain, read the exact note before retrying; the change may already have landed.

For drawing decode or transcription, build the public helper locally with a current Swift toolchain and macOS SDK that expose the macOS 26 `SpeechAnalyzer` and `SpeechTranscriber` APIs. Having Command Line Tools installed does not alone prove that their SDK can build the helper; older SDK builds are unverified.

```bash
npx -y apple-notes-mcp@2.14.3 setup --public-helper
npx -y apple-notes-mcp@2.14.3 setup --public-helper --check
```

The helper never requests Speech Recognition permission in the background. On older macOS, the recognition route requires an existing grant to the launching app; on macOS 26+, the server handles SpeechAnalyzer separately. A missing language model returns `asset_unavailable`; downloading it requires the explicit `downloadAssets` option. See [on-device transcription](../README.md#transcribe-note-audio) for the current route and permission contract.

## When a feature is unavailable

- Without FDA, database-only tools return an access error. For simple searches, `search-notes` has an AppleScript fallback; this does not replace `query-notes`' structured query support.
- Without database visibility, `get-sync-status` cannot establish pending uploads or active sync. Treat absent/zero database information as unknown, not proof that syncing is complete.
- Smart Folder detection and native-object guards depend on their documented read paths. Do not infer safe destination or preservation behavior from an incomplete diagnostic.
- If `doctor` reports FDA missing, use the per-feature requirements above. Version 2.14.3's diagnostic text still contains an overbroad statement that other tools are unaffected; the database-backed tools listed here also need FDA.
- If prompts recur after Node updates, check the exact executable path and signature. A version-manager path change or replacement of an ad-hoc-signed binary can invalidate its grants. A stable path and a Developer-ID-signed Node runtime reduce this problem; see [Node runtime and TCC permissions](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

The permission-broker proposal in [PR 276](https://github.com/sweetrb/apple-notes-mcp/pull/276) is separate from the 2.14.3 setup described here. Its proposed `setup --broker` flow is not a released prerequisite. Follow its eventual release documentation before adopting it.
