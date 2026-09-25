#!/bin/bash
# Shared setup for the private writer's per-feature copy-store tests
# (scripts/test-private-writer-*-copy-store.sh). Source it; do not run it.
#
# It builds the writer from source (or reuses HELPER=/path/to/binary), makes a
# private copy of the Notes store with sqlite3's online backup, and defines:
#   run REQUEST       send REQUEST to the writer against the LIVE store, with
#                     the write switch cleared (reads only)
#   copy_run REQUEST  send REQUEST to the writer against the COPY
#   field JSON PATH   extract one value from a JSON response
#   fail MESSAGE      print FAIL and exit 1
#   read_request UUID the read_note_state request for a note
#   writable_candidates SQL_WHERE
#                     print up to 25 recent note UUIDs from the copy matching
#                     an extra WHERE clause over ZICCLOUDSYNCINGOBJECT n
#   is_writable UUID  true when the writer reports the copy note editable,
#                     unshared, and not trashed
#   assert_live_unchanged UUID REVISION
#                     fail unless the live note still has REVISION
# The live store is only ever opened read-only. Prints states and counts only,
# never note titles or bodies. Removes the copy on exit.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO/native/private-helper/apple-notes-private-writer.m"
LIVE="$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/private-writer-copy.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
field() { printf '%s' "$1" | /usr/bin/plutil -extract "$2" raw -o - - 2>/dev/null || true; }

[ -r "$LIVE" ] || fail "cannot read the live store (grant Full Disk Access to this terminal)"
[ "${APPLE_NOTES_MCP_ENABLE_PRIVATE:-}" = "1" ] ||
  fail "set APPLE_NOTES_MCP_ENABLE_PRIVATE=1 so live notes can be compared (reads only)"

if [ -z "${HELPER:-}" ]; then
  HELPER="$WORK/apple-notes-private-writer"
  SHA="$(/usr/bin/shasum -a 256 "$SOURCE" | cut -d' ' -f1)"
  /usr/bin/xcrun clang -fobjc-arc -O2 -Wall -framework Foundation -framework CoreData \
    -framework AppKit -framework PencilKit "-DHELPER_SOURCE_SHA256=\"$SHA\"" -o "$HELPER" "$SOURCE"
  echo "built writer from source sha256 $SHA"
fi

COPY="$WORK/NoteStore.sqlite"
/usr/bin/sqlite3 -readonly "$LIVE" ".backup '$COPY'"
echo "copied store: $(/usr/bin/stat -f %z "$COPY") bytes"

run() { printf '%s' "$1" | env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES "$HELPER" 2>/dev/null; }
copy_run() {
  printf '%s' "$1" | env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES \
    APPLE_NOTES_MCP_PRIVATE_STORE="$COPY" "$HELPER" 2>/dev/null
}
read_request() { printf '{"protocol":1,"action":"read_note_state","identifier":"%s"}' "$1"; }
ZERO="r1:$(printf '0%.0s' $(seq 1 64))"
export ZERO

writable_candidates() {
  /usr/bin/sqlite3 "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT n
    JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
    WHERE n.ZIDENTIFIER IS NOT NULL AND n.ZFOLDER IS NOT NULL
      AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0 AND IFNULL(n.ZMARKEDFORDELETION,0)=0
      AND ($1)
    ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT 25;"
}

is_writable() {
  local state
  state="$(copy_run "$(read_request "$1")" || true)"
  [ "$(field "$state" editable)" = "true" ] && [ "$(field "$state" sharedViaICloud)" = "false" ] &&
    [ "$(field "$state" deletedOrInTrash)" = "false" ]
}

assert_live_unchanged() {
  [ "$2" = "$(field "$(run "$(read_request "$1")")" revision)" ] ||
    fail "live note revision changed during the copy test"
  echo "ok: live note revision unchanged"
}
