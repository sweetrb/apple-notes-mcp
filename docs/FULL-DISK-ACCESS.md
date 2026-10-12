# Full Disk Access and related permissions

Apple Notes MCP uses separate macOS permissions for different operations. Connecting an MCP client does not grant them. This guide covers the released 2.15.1 server; use diagnostics from the client that actually runs it.

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
npx -y apple-notes-mcp@2.15.1 setup --permissions --once --json --check
```

Use the package version and launch context that match your client. A check run in Terminal reports Terminal's process context; it does not certify a server launched by Claude Desktop or another desktop client.

Inspect each result, not only the exit code. `ready: true` can coexist with deliberately unprobed Automation and unavailable optional components. A missing public helper makes Speech status unknown. A Shortcut listed as installed may still be waiting for first-run consent.

The MCP `doctor` tool checks Notes reachability, Automation, accounts, FDA, runtime signing, and optional features. Unlike `get-capabilities`, it contacts Notes and can cause the first Automation prompt. Run it in the actual client when you are at the Mac and ready to answer that prompt. The optional feature matrix does not by itself determine `healthy`.

## Grant access to the correct process

1. Find the responsible process from diagnostics in the actual MCP client. For a **brokered session**, grant FDA to **Apple Notes MCP Broker.app**; `doctor` identifies whether the session uses the broker. For **Claude Desktop without the broker**, the server's **Node binary** needs FDA; the grant on Claude.app alone does not cover it. A terminal-launched server ordinarily uses the terminal app's permission; a server launched by VS Code uses that context. For other clients, confirm the reported process instead of assuming the app name is enough.
2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Click **+** and add the diagnosed app or Node executable. Press **⌘⇧G** in the file picker to enter an absolute path; **⌘⇧.** shows hidden files.
4. Enable its toggle, then fully quit and relaunch the host application so it starts fresh processes.
5. Re-run diagnostics inside that client. If FDA remains unavailable, verify the executable path and that the client was fully restarted before trying further changes.

A client sandbox can separately prevent the server from launching or connecting to the broker's Unix socket. Privacy grants do not expand that sandbox; check the client's launch and socket-access diagnostics separately.

FDA and Automation are independent. To check Automation from a terminal on the Mac, when you are ready for the first-use prompt:

```bash
npx -y apple-notes-mcp@2.15.1 setup --permissions --once --probe-automation
```

This sends one read-only Apple event. Accept the macOS prompt to allow the launching process to control Notes. `--check` and SSH sessions suppress this probe even when `--probe-automation` is present. `--open` can open the relevant System Settings panes; it does not change a permission.

## Optional permission broker

`apple-notes-mcp setup --broker` installs a signed app at
`~/Applications/Apple Notes MCP Broker.app`. Grant Full Disk Access to that app
and allow it to control Notes when macOS asks. Brokered sessions use its grants
instead of those of the Node binary or MCP host that launched the client.
Setup requires a standalone Node runtime linked only to system libraries; see
the [runtime setup guide](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

**This trusts every process running as your macOS user.** While the broker is
running, any such process can connect and use the server's Notes capabilities
under the broker's Full Disk Access and Notes Automation grants. The socket's
permissions and same-UID check exclude other users; they do not authenticate
apps running as you. That is comparable trust exposure to granting Full Disk
Access to Node. Use the broker only if you accept this trade-off.

The broker runs a server sealed inside its signed app, verifies the bundle and
the pinned Node executable before spawning, and accepts only a short allowlist
of numeric limits and timeouts from clients. Code paths, helper paths, and
safety overrides cannot be selected through a socket request, and brokered
servers skip local JSON configuration files. External native
helpers are unavailable in broker sessions; tools that require them need an
in-process server. See [Permission broker](../README.md#permission-broker-opt-in)
for the security design and signing caveats.

The signature and hash checks reject changes detected at startup or before
spawn. They do not provide OS isolation against a hostile, unsandboxed
same-user process modifying the user-writable bundle or runtime after
validation. Installed Shortcuts are user-managed trusted integrations; the
broker does not authenticate their contents.

After updating the package or replacing the broker's Node runtime, run
`apple-notes-mcp setup --broker` again, restart your MCP clients, and check
`doctor`. Rebuilding with an ad-hoc signature or changing the signing identity
may require new macOS grants.

To bypass the broker for one client, set `APPLE_NOTES_MCP_BROKER=off` in that
client's environment. This does **not** stop the broker or prevent other
same-user processes from using it. To remove that access, run
`apple-notes-mcp setup --broker --uninstall`, then restart your clients. You can
also revoke the broker's Full Disk Access and Notes Automation grants in System
Settings.

## Complete the optional native setup

For native operations, install the packaged workflows:

```bash
npx -y apple-notes-mcp@2.15.1 setup
npx -y apple-notes-mcp@2.15.1 setup --check
```

Confirm **Add Shortcut** for each imported workflow. After installation or upgrade, run **Apple Notes MCP - Native Tags** and **Apple Notes MCP - Background Operations v5** once in the foreground in Shortcuts.app and choose **Always Allow** when asked. The optional **Create Markdown Note** bridge requires macOS 26+ and the documented input for its foreground run. Follow the [Shortcut setup instructions](../shortcuts/README.md).

Installation checks cannot read Shortcut consent state. An unanswered prompt can stall background native writes while the bridge still reports installed. If a write times out or its outcome is uncertain, read the exact note before retrying; the change may already have landed.

External public and private native helpers are unavailable in brokered sessions. Set `APPLE_NOTES_MCP_BROKER=off` for this client and restart it before using tools that require them.

For drawing decode or transcription, build the public helper locally with a current Swift toolchain and macOS SDK that expose the macOS 26 `SpeechAnalyzer` and `SpeechTranscriber` APIs. Having Command Line Tools installed does not alone prove that their SDK can build the helper; older SDK builds are unverified.

```bash
npx -y apple-notes-mcp@2.15.1 setup --public-helper
npx -y apple-notes-mcp@2.15.1 setup --public-helper --check
```

The helper never requests Speech Recognition permission in the background. On older macOS, the recognition route requires an existing grant to the launching app; on macOS 26+, the server handles SpeechAnalyzer separately. A missing language model returns `asset_unavailable`; downloading it requires the explicit `downloadAssets` option. See [on-device transcription](../README.md#transcribe-note-audio) for the current route and permission contract.

## When a feature is unavailable

- Without FDA, database-only tools return an access error. For simple searches, `search-notes` has an AppleScript fallback; this does not replace `query-notes`' structured query support.
- Without database visibility, `get-sync-status` cannot establish pending uploads or active sync. Treat absent/zero database information as unknown, not proof that syncing is complete.
- Smart Folder detection and native-object guards depend on their documented read paths. Do not infer safe destination or preservation behavior from an incomplete diagnostic.
- If `doctor` reports FDA missing, use the per-feature requirements above. Optional feature availability does not determine `doctor.healthy`, and its summary does not enumerate every database-backed guard.
- If prompts recur after Node updates, check the exact executable path and signature. A version-manager path change or replacement of an ad-hoc-signed binary can invalidate its grants. A stable path and a Developer-ID-signed Node runtime reduce this problem; see [Node runtime and TCC permissions](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

Broker installation remains optional. Use its [setup and migration instructions](../README.md#permission-broker-opt-in) when you choose it, and rerun setup after a package or runtime change. A broker fallback uses the in-process server's own permissions; inspect `doctor.broker` before choosing which process to grant.
