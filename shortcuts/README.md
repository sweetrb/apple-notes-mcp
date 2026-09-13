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
