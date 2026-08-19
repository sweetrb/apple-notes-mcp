# Node runtime & TCC permission stability

macOS gates this MCP server's access to your data behind **TCC** permissions —
**Full Disk Access** (to read app data such as Mail, Notes, or Photos) and
**Automation / Apple Events** (to drive an app like Mail.app or Notes.app via
AppleScript). See this repo's Full Disk Access / Automation notes for *which*
operations need which permission.

This page is about a **separate, recurring annoyance**: being asked to approve
those permissions **over and over**, often right after a routine `brew upgrade`.

## Symptom

- You granted Full Disk Access (and/or Automation) to "node", but days later
  macOS prompts again — `"node" wants access to ...` or `"node" wants to control
  "Mail"`.
- System Settings → Privacy & Security → Full Disk Access shows **several
  identical "node" rows**, usually only one enabled.
- It tends to happen immediately after you update Node.

## Cause

TCC binds a permission grant to the **code identity of the binary that performs
the access** — here, the `node` executable that launches the MCP server. For a
binary that is only **ad-hoc signed** (no Developer ID / Team ID), TCC keys the
grant to the binary's **cdhash**, a hash of its contents.

Homebrew's `node` formula is ad-hoc signed:

```bash
$ codesign -dvvv "$(which node)" 2>&1 | grep -E 'Signature|TeamIdentifier'
Signature=adhoc
TeamIdentifier=not set
```

Every Node update **replaces the binary**, which **changes the cdhash**, so TCC
no longer recognizes it as the thing you approved — and re-prompts. The extra
"node" rows are stale cdhashes from previous versions.

By contrast, properly signed apps (Chrome, Slack, …) keep their permissions
across auto-updates because TCC matches them on a stable **Designated
Requirement** derived from their Developer ID, not on the cdhash.

## Fix: run the MCP under the official, Developer-ID-signed Node

Node binaries distributed from **nodejs.org** are signed with a real Developer
ID (`Node.js Foundation`, Team `HX7739G8FX`), notarized, and self-contained.
Pointing the MCP server at one gives TCC a **stable** identity to match, so a
permission you grant **persists across future Node updates**. It also decouples
the MCP runtime from your Homebrew/dev Node, which can keep updating freely.

### Steps (Apple Silicon shown; use `darwin-x64` on Intel)

1. Install a current LTS to a stable path (kept off `PATH` so it won't shadow
   your dev Node):

   ```bash
   VER=v24.17.0 ARCH=darwin-arm64
   mkdir -p ~/mcp-runtime && cd ~/mcp-runtime
   curl -O https://nodejs.org/dist/$VER/node-$VER-$ARCH.tar.gz
   curl -O https://nodejs.org/dist/$VER/SHASUMS256.txt
   grep "  node-$VER-$ARCH.tar.gz$" SHASUMS256.txt | shasum -a 256 -c -   # must print OK
   mkdir -p node-current
   tar -xzf node-$VER-$ARCH.tar.gz --strip-components=1 -C node-current
   ```

2. Confirm it's Developer-ID signed:

   ```bash
   codesign -dvvv ~/mcp-runtime/node-current/bin/node 2>&1 | grep -E 'Authority=Developer ID|TeamIdentifier'
   # Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)
   # TeamIdentifier=HX7739G8FX
   ```

3. Point this MCP server's launcher at it. For Claude Desktop, edit
   `~/Library/Application Support/Claude/claude_desktop_config.json` and set this
   server's `command` to the absolute path:

   ```json
   {
     "mcpServers": {
       "apple-notes": {
         "command": "/Users/<you>/mcp-runtime/node-current/bin/node",
         "args": ["/path/to/apple-notes-mcp/build/index.js"]
       }
     }
   }
   ```

   Servers launched via `npx` that don't need Full Disk Access can stay on
   Homebrew Node.

4. **Restart your MCP client** so the server relaunches under the new Node.

5. **Grant the permissions once** to the new binary:
   - *Full Disk Access*: System Settings → Privacy & Security → Full Disk Access
     → **+** → ⌘⇧G → paste `~/mcp-runtime/node-current/bin/node`.
   - *Automation*: the first time the server drives an app you'll get a one-time
     `"node" wants to control "<App>"` prompt — click **Allow**.

   ⚠️ **A TCC grant is keyed to the binary's resolved *path*, not only to its
   signature.** Because the steps above unpack Node into a fixed directory
   (`~/mcp-runtime/node-current`) rather than a versioned one, that path never
   moves and the grants survive Node updates — see "Updating" below. If you
   instead point `node-current` at a `node-vX.Y.Z-…` directory, every update
   changes the resolved path, presents a brand-new ungranted identity, and you
   will be re-prompted for all of it.

   You can delete any stale "node" rows from the Full Disk Access list.

### Updating the dedicated Node later

Replace the **contents** of the same directory — do not create a new one and do
not repoint anything:

```bash
VER=v24.19.0 ARCH=darwin-arm64
cd ~/mcp-runtime
curl -O https://nodejs.org/dist/$VER/node-$VER-$ARCH.tar.gz
curl -O https://nodejs.org/dist/$VER/SHASUMS256.txt
grep "  node-$VER-$ARCH.tar.gz$" SHASUMS256.txt | shasum -a 256 -c -   # must print OK
rm -rf node-current && mkdir -p node-current
tar -xzf node-$VER-$ARCH.tar.gz --strip-components=1 -C node-current
```

The path is unchanged and the official builds are Developer-ID signed with a
requirement that pins identifier + Team ID (no cdhash), so **both** halves of
the grant still match: existing grants carry over with no re-approval.

⚠️ **Restart your MCP client afterwards.** Replacing the binary unlinks the one
any already-running server is executing; macOS then cannot validate that path,
so those processes fail with *"Permission denied"* until they are restarted.
Nothing is wrong with your grants — a freshly launched server works fine.
