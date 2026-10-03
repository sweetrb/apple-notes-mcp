#!/bin/bash
# Compatibility entrypoint. The previous harness copied the personal store and
# changed the user's writer preference domain. Q2 now requires a dedicated,
# independently isolated synthetic store and an authorized same-note GUI receipt.
# A NOTE_UUID or inherited HELPER is not sufficient. Run --help for explicit paths.
set -euo pipefail
exec node "$(dirname "$0")/test-private-writer-replica-identity-synthetic.mjs" "$@"
