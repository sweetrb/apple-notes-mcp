# Node runtime & TCC permission stability

macOS gates this MCP server's access to your data behind **TCC** permissions —
**Full Disk Access** (to read the Notes database) and **Automation / Apple
Events** (to drive Notes.app via AppleScript). See the
[Full Disk Access guide](FULL-DISK-ACCESS.md) for which operations need which
permission.

This page is about a **separate, recurring annoyance**: being asked to approve
those permissions **over and over**, often right after a routine `brew upgrade`.

## Symptom

- You granted Full Disk Access (and/or Automation) to "node", but days later
  macOS prompts again — `"node" wants access to ...` or `"node" wants to control
  "Notes"`.
- System Settings → Privacy & Security → Full Disk Access shows **several
  identical "node" rows**, usually only one enabled.
- It tends to happen immediately after you update Node.

## Cause

TCC checks the **responsible process** for an access. Under Claude Desktop
without the broker, that is the `node` executable running the server; under a
terminal host it can be the terminal app. With the broker, it is
`~/Applications/Apple Notes MCP Broker.app`.

An **ad-hoc-signed** binary has no certificate-backed signing identity. Its
**cdhash** changes when its code changes, so a grant to one build may not apply
after an update. Moving the executable, including changing the resolved path
behind a version-manager symlink, can also require a new grant.

Check the Node binary you actually use. An ad-hoc signature looks like this:

```bash
$ codesign -dvvv "$(which node)" 2>&1 | grep -E 'Signature|TeamIdentifier'
Signature=adhoc
TeamIdentifier=not set
```

The `doctor` tool reports the runtime path and warns about ad-hoc signing.
Duplicate "node" rows in System Settings can be entries for previous binaries.

Certificate-signed code has a **designated requirement** that can identify it
across builds. Apple's documented Apple Development requirement includes the
leaf certificate's Common Name, while its Developer ID example uses certificate
type and Team ID constraints. A matching bundle identifier and Team ID alone
are therefore not a promise of permission continuity. See Apple's
[TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

## Option 1: opt in to the permission broker

The broker puts the grants on a signed app at a fixed path and runs a bundled
copy of the MCP server for connected clients. Run setup using a standalone Node
runtime whose dynamic library dependencies are all under `/usr/lib/` or
`/System/Library/`. Other dependencies, including the non-system libraries used
by common Homebrew Node builds, are rejected: pinning the Node executable alone
would not protect those libraries. The download steps under Option 2 below show
how to install an official Node runtime at a fixed path.

```bash
apple-notes-mcp setup --broker
apple-notes-mcp setup --broker --check
# Or explicitly select your standalone runtime for setup:
/path/to/node /path/to/apple-notes-mcp/build/index.js setup --broker
```

Add `~/Applications/Apple Notes MCP Broker.app` in **System Settings → Privacy
& Security → Full Disk Access**, and allow it to control Notes when prompted.
Restart your MCP client and run `doctor` to confirm that it is using the broker.

**Review the trust trade-off before installing:** every process running as your
macOS user can use the broker's Notes capabilities under its Full Disk Access
and Notes Automation grants. The socket's same-UID check excludes other users,
but does not authenticate same-user apps. This is comparable trust exposure to
granting Full Disk Access to a general-purpose Node binary. Socket requests
cannot select executable paths or safety overrides; this does not identify a
trusted MCP client. Brokered servers skip local JSON configuration files, and
external native helpers are unavailable in broker sessions.
See the [broker security design](../README.md#permission-broker-opt-in).

The signature and hash checks reject modifications detected at startup or
before spawn. They do not make later filesystem reads atomic or provide OS
isolation against a hostile, unsandboxed same-user process modifying the
user-writable bundle or runtime after validation. Installed Shortcuts remain
user-managed trusted integrations; the broker does not authenticate their
contents.

Setup automatically selects an identity only when exactly one Developer ID
Application or Apple Development identity qualifies. If more than one qualifies
across those types, specify `--sign-identity`. If none qualify, it signs ad hoc
and warns about re-granting permissions.
Keeping a compatible designated requirement can help preserve grants across
rebuilds, but **Apple Development signing is not a guarantee of continuity across
certificate renewal or signing identity changes**. Ad-hoc rebuilds may require
new grants. Always check `doctor` after reinstalling.

The signed configuration pins the Node executable's canonical path and digest.
After a package update, or after replacing or moving that runtime, run
`apple-notes-mcp setup --broker` again to refresh the bundled server and pin,
then restart your clients. A stale or unavailable broker causes clients to run
in-process with their own permissions; `doctor` reports that fallback.

Set `APPLE_NOTES_MCP_BROKER=off` to bypass it for one client. The broker continues
running and remains reachable by other same-user processes. To remove that
access, run `apple-notes-mcp setup --broker --uninstall` and restart your clients;
you can also revoke the broker's grants in System Settings.

## Option 2: run in-process under Developer-ID-signed Node

Node binaries distributed from **nodejs.org** are signed with a real Developer
ID (`Node.js Foundation`, Team `HX7739G8FX`), notarized, and self-contained.
Keeping the executable at a stable path avoids the path changes of version
managers and the code-identity changes of ad-hoc rebuilds. Permission continuity
still depends on the designated requirement and macOS permission state. This
also decouples the MCP runtime from your Homebrew/dev Node.

If you installed the broker, set `APPLE_NOTES_MCP_BROKER=off` in this client's
environment or uninstall it before using this option. Otherwise the client
will hand off to the broker when it is available.

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

5. **Grant the permissions** to the new binary:
   - *Full Disk Access*: System Settings → Privacy & Security → Full Disk Access
     → **+** → ⌘⇧G → paste `~/mcp-runtime/node-current/bin/node`.
   - *Automation*: the first time the server drives an app you'll get a
     `"node" wants to control "<App>"` prompt — click **Allow**.

   ⚠️ **A TCC grant is keyed to the binary's resolved *path*, not only to its
   signature.** Because the steps above unpack Node into a fixed directory
   (`~/mcp-runtime/node-current`) rather than a versioned one, that path never
   moves — see "Updating" below. If you
   instead point `node-current` at a `node-vX.Y.Z-…` directory, every update
   changes the resolved path and may require you to grant permissions again.

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

The path stays unchanged. Check the replacement binary's signature as above,
then run `doctor` in your MCP client to verify that macOS retained its grants.
Do not assume a new signing identity or a changed designated requirement will
match an earlier grant.

⚠️ **Restart your MCP client afterwards.** Replacing the binary unlinks the one
any already-running server is executing; those processes can fail with
*"Permission denied"* until restarted. Recheck permissions from a fresh session
before changing grants.
