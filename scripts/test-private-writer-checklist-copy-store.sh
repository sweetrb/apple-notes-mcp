#!/bin/bash
# Exercise the private writer's checklist actions (read_checklist,
# set_checklist_item) against a COPY of the Notes store. See
# scripts/private-writer-copy-store-lib.sh for the copy and live-store rules.
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-writer-checklist-copy-store.sh
#   CHECKLIST_NOTE=<uuid> note whose first checklist item is toggled (and
#              toggled back) in the copy. Default: the most recent editable
#              note with a native checklist.
#   HELPER=/path/to/binary to reuse a built writer instead of compiling.
set -euo pipefail
# shellcheck source=scripts/private-writer-copy-store-lib.sh
. "$(dirname "$0")/private-writer-copy-store-lib.sh"

checklist_request() { printf '{"protocol":1,"action":"read_checklist","identifier":"%s"}' "$1"; }
set_item_request() {
  printf '{"protocol":1,"action":"set_checklist_item","identifier":"%s","todoIdentifier":"%s","done":%s,"ifRevision":"%s"}' \
    "$1" "$2" "$3" "$4"
}

NOTE="${CHECKLIST_NOTE:-}"
if [ -z "$NOTE" ]; then
  for CANDIDATE in $(writable_candidates "n.ZHASCHECKLIST = 1"); do
    LIST="$(copy_run "$(checklist_request "$CANDIDATE")" || true)"
    if is_writable "$CANDIDATE" && [ -n "$(field "$LIST" items.0.todoIdentifier)" ] &&
      [ "$(field "$LIST" items.0.contiguous)" = "true" ]; then
      NOTE="$CANDIDATE"
      break
    fi
  done
fi
# Fixture fallback: when every checklist note in the library is trashed or
# shared, move the most recent trashed one into a regular folder of its own
# account, in the COPY only (plain SQL on the disposable copy; the writer
# itself never issues SQL). The live store is not touched.
if [ -z "$NOTE" ]; then
  for CANDIDATE in $(/usr/bin/sqlite3 "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT n
    JOIN ZICCLOUDSYNCINGOBJECT t ON t.Z_PK = n.ZFOLDER AND t.ZFOLDERTYPE = 1
    WHERE n.ZHASCHECKLIST = 1 AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0
    ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT 10;"); do
    for FOLDER in $(/usr/bin/sqlite3 "$COPY" "SELECT f.Z_PK FROM ZICCLOUDSYNCINGOBJECT f
      JOIN ZICCLOUDSYNCINGOBJECT n ON n.ZIDENTIFIER = '$CANDIDATE'
      WHERE f.ZFOLDERTYPE = 0 AND f.ZACCOUNT8 = n.ZACCOUNT7 AND f.ZSMARTFOLDERQUERYJSON IS NULL
        AND IFNULL(f.ZMARKEDFORDELETION,0)=0 ORDER BY f.Z_PK LIMIT 10;"); do
      /usr/bin/sqlite3 "$COPY" "UPDATE ZICCLOUDSYNCINGOBJECT SET ZFOLDER = $FOLDER,
        ZMARKEDFORDELETION = 0 WHERE ZIDENTIFIER = '$CANDIDATE';"
      if is_writable "$CANDIDATE"; then
        NOTE="$CANDIDATE"
        echo "fixture: moved a trashed checklist note into a regular folder in the copy"
        break 2
      fi
    done
  done
fi
[ -n "$NOTE" ] || fail "no editable note with a native checklist in the copy"
LIVE_BEFORE="$(field "$(run "$(read_request "$NOTE")")" revision)"
[ -n "$LIVE_BEFORE" ] || fail "could not read the live note state"

LIST="$(copy_run "$(checklist_request "$NOTE")")"
TODO_ID="$(field "$LIST" items.0.todoIdentifier)"
ORIGINAL="$(field "$LIST" items.0.done)"
TOTAL="$(field "$LIST" total)"
CHECKED="$(field "$LIST" checked)"
REV="$(field "$LIST" revision)"
[ "$REV" = "$(field "$(copy_run "$(read_request "$NOTE")")" revision)" ] ||
  fail "read_checklist revision differs from read_note_state"
echo "ok: read_checklist lists $TOTAL items ($CHECKED checked) with the note revision"
if [ "$ORIGINAL" = "true" ]; then FLIP=false; else FLIP=true; fi

# 1. Without the write switch the writer refuses a read-write open of the live
#    store (zero revision, so a broken switch could only reach revision_conflict).
OUT="$(run "$(set_item_request "$NOTE" "$TODO_ID" "$FLIP" "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "live read-write open not gated: $(field "$OUT" code)"
echo "ok: live set_checklist_item refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. Refusals that write nothing.
OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" "$FLIP" "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "stale checklist revision not refused"
OUT="$(copy_run "$(set_item_request "$NOTE" "ffffffffffffffffffffffffffffffff" "$FLIP" "$REV")" || true)"
[ "$(field "$OUT" code)" = "not_found" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "unknown todo identifier not refused: $(field "$OUT" code)"
OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" '"yes"' "$REV")" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] || fail "non-boolean done not refused"
echo "ok: stale revision, unknown item, and non-boolean done refused, committed=false"

# 3. Same state is a no-op.
OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" "$ORIGINAL" "$REV")" || true)"
[ "$(field "$OUT" status)" = "unchanged" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "same-state toggle was not a no-op: $(field "$OUT" status) $(field "$OUT" code)"
[ "$(field "$OUT" revisionAfter)" = "$REV" ] || fail "no-op changed the revision"
echo "ok: same-state request is a no-op (committed=false, revision unchanged)"

# 4. Toggle, read back, and toggle back.
OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" "$FLIP" "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "toggle failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" persistedDone)" = "$FLIP" ] || fail "persistedDone is not $FLIP"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "toggle did not report the copy store"
echo "copy cloud state: current=$(field "$OUT" cloudSync.currentLocalVersion) synced=$(field "$OUT" cloudSync.latestVersionSyncedToCloud) uploadPending=$(field "$OUT" cloudSync.uploadPending)"
AFTER="$(copy_run "$(checklist_request "$NOTE")")"
[ "$(field "$AFTER" items.0.done)" = "$FLIP" ] || fail "re-read done state is not $FLIP"
[ "$(field "$AFTER" items.0.todoIdentifier)" = "$TODO_ID" ] || fail "item identity changed"
[ "$(field "$AFTER" total)" = "$TOTAL" ] || fail "checklist item count changed"
[ "$(field "$AFTER" revision)" != "$REV" ] || fail "revision did not change"
echo "ok: item toggled $ORIGINAL -> $FLIP; persistedDone and re-read agree; identity and item count ($TOTAL) kept"

OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" "$FLIP" "$REV")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed toggle not refused"
OUT="$(copy_run "$(set_item_request "$NOTE" "$TODO_ID" "$ORIGINAL" "$(field "$AFTER" revision)")" || true)"
[ "$(field "$OUT" persistedDone)" = "$ORIGINAL" ] || fail "toggle back failed: $(field "$OUT" code)"
[ "$(field "$(copy_run "$(checklist_request "$NOTE")")" checked)" = "$CHECKED" ] ||
  fail "checked count did not return to $CHECKED"
echo "ok: replayed toggle refused; item toggled back to $ORIGINAL ($CHECKED checked again)"

# 5. The live note is untouched.
assert_live_unchanged "$NOTE" "$LIVE_BEFORE"
echo "PASS"
