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

Open the signed file and confirm **Add Shortcut** once. Do not install obsolete
workflow versions with the same display name; the server resolves one exact
installed UUID and refuses duplicates.
