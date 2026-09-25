#!/bin/bash
# Exercise the private writer's folder scope guards (#57) and the purge-flag
# repair (#89) against a COPY of the Notes store. See
# scripts/private-writer-copy-store-lib.sh for the copy and live-store rules.
#
# The purge-flag state is created in the copy only, with sqlite3 on the
# copy's file, because nothing in Notes produces it on purpose.
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-writer-guards-copy-store.sh
#   HELPER=/path/to/binary to reuse a built writer instead of compiling.
set -euo pipefail
# shellcheck source=scripts/private-writer-copy-store-lib.sh
. "$(dirname "$0")/private-writer-copy-store-lib.sh"

STORE_UUID="$(/usr/bin/sqlite3 "$COPY" "SELECT Z_UUID FROM Z_METADATA;")"
folder_uri() { printf 'x-coredata://%s/ICFolder/p%s' "$STORE_UUID" "$1"; }

# A writable note whose folder has a parent folder, and a second writable note.
NOTE=""
OTHER=""
for CANDIDATE in $(writable_candidates "(SELECT f.ZPARENT FROM ZICCLOUDSYNCINGOBJECT f WHERE f.Z_PK = n.ZFOLDER) IS NOT NULL"); do
  if is_writable "$CANDIDATE"; then
    if [ -z "$NOTE" ]; then
      NOTE="$CANDIDATE"
    elif [ -z "$OTHER" ]; then
      OTHER="$CANDIDATE"
      break
    fi
  fi
done
[ -n "$NOTE" ] && [ -n "$OTHER" ] || fail "need two writable notes in nested folders in the copy"
IFS='|' read -r FOLDER_PK PARENT_PK <<<"$(/usr/bin/sqlite3 "$COPY" "SELECT f.Z_PK, f.ZPARENT
  FROM ZICCLOUDSYNCINGOBJECT n JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  WHERE n.ZIDENTIFIER = '$NOTE';")"
FOLDER="$(folder_uri "$FOLDER_PK")"
PARENT="$(folder_uri "$PARENT_PK")"
MISSING="$(folder_uri 999999999)"
LIVE_NOTE="$(field "$(run "$(read_request "$NOTE")")" revision)"
LIVE_OTHER="$(field "$(run "$(read_request "$OTHER")")" revision)"
[ -n "$LIVE_NOTE" ] && [ -n "$LIVE_OTHER" ] || fail "could not read the live note states"

# 1. Without the write switch a guarded live write is still refused first.
OUT="$(run "{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"x\",\"ifRevision\":\"$ZERO\",\"ifFolderId\":\"$FOLDER\"}" || true)"
[ "$(field "$OUT" code)" = "writes_disabled" ] || fail "live guarded write not gated: $(field "$OUT" code)"
echo "ok: live guarded write refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. Dry runs evaluate the guard too.
plan() {
  printf '{"protocol":1,"action":"set_highlight","identifier":"%s","scope":"note","color":"mint","dryRun":true%s}' "$NOTE" "$1"
}
OUT="$(copy_run "$(plan ",\"ifFolderId\":\"$FOLDER\",\"ifAncestorFolderId\":\"$PARENT\"")")"
[ "$(field "$OUT" status)" = "planned" ] || fail "passing guard refused: $(field "$OUT" code) $(field "$OUT" message)"
OUT="$(copy_run "$(plan ",\"forbiddenAncestorFolderIds\":[\"$PARENT\"]")" || true)"
[ "$(field "$OUT" code)" = "scope_conflict" ] && [ "$(field "$OUT" scopeReason)" = "inside_forbidden_folder" ] &&
  [ "$(field "$OUT" committed)" = "false" ] || fail "forbidden ancestor not refused: $(field "$OUT" code)"
OUT="$(copy_run "$(plan ",\"ifFolderId\":\"$PARENT\"")" || true)"
[ "$(field "$OUT" scopeReason)" = "not_in_expected_folder" ] || fail "wrong folder not refused"
OUT="$(copy_run "$(plan ",\"forbiddenAncestorFolderIds\":[\"$MISSING\"]")" || true)"
[ "$(field "$OUT" code)" = "scope_folder_not_found" ] || fail "unknown forbidden id not refused (fail-open)"
OUT="$(copy_run "$(plan ",\"ifAncestorFolderId\":\"x-coredata://nope\"")" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] || fail "malformed folder id not refused"
echo "ok: dry runs pass a matching guard and refuse a forbidden, wrong, unknown, or malformed one"

# 3. A guarded write refuses in its own transaction and writes nothing.
REV="$(field "$(copy_run "$(read_request "$NOTE")")" revision)"
append() {
  printf '{"protocol":1,"action":"append_plain_text","identifier":"%s","text":"guarded append","ifRevision":"%s"%s}' "$NOTE" "$REV" "$1"
}
OUT="$(copy_run "$(append ",\"forbiddenAncestorFolderIds\":[\"$FOLDER\"]")" || true)"
[ "$(field "$OUT" code)" = "scope_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "forbidden write not refused: $(field "$OUT" code)"
[ "$(field "$(copy_run "$(read_request "$NOTE")")" revision)" = "$REV" ] || fail "refused write changed the note"
OUT="$(copy_run "$(append ",\"ifFolderId\":\"$FOLDER\",\"ifAncestorFolderId\":\"$PARENT\",\"forbiddenAncestorFolderIds\":[\"$MISSING\"]")" || true)"
[ "$(field "$OUT" code)" = "scope_folder_not_found" ] || fail "write with unknown forbidden id not refused"
OUT="$(copy_run "$(append ",\"ifFolderId\":\"$FOLDER\",\"ifAncestorFolderId\":\"$PARENT\"")")"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "guarded write failed: $(field "$OUT" code) $(field "$OUT" message)"
echo "ok: guarded append refused inside a forbidden folder, applied inside the expected one"

# 4. Smart-folder create: the destination parent is the guarded folder.
QUERY='{\"entity\":\"note\",\"type\":{\"and\":[{\"checklist\":true}]}}'
BEFORE_FOLDERS="$(/usr/bin/sqlite3 "$COPY" "SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDERTYPE = 2;")"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"create_smart_folder\",\"title\":\"Guard copy test\",\"queryJSON\":\"$QUERY\",\"parentIdentifier\":\"$PARENT\",\"forbiddenAncestorFolderIds\":[\"$PARENT\"]}" || true)"
[ "$(field "$OUT" code)" = "scope_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "smart folder in a forbidden parent not refused: $(field "$OUT" code) $(field "$OUT" message)"
[ "$BEFORE_FOLDERS" = "$(/usr/bin/sqlite3 "$COPY" "SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDERTYPE = 2;")" ] ||
  fail "refused smart-folder create left a folder behind"
echo "ok: smart-folder create refused in a forbidden parent, nothing saved"

# The smart folder itself may be forbidden; its own pending deletion does not
# turn that into "deleted folder".
OUT="$(copy_run "{\"protocol\":1,\"action\":\"create_smart_folder\",\"title\":\"Guard copy test\",\"queryJSON\":\"$QUERY\",\"parentIdentifier\":\"$PARENT\",\"ifFolderId\":\"$PARENT\"}")"
[ "$(field "$OUT" status)" = "created" ] || fail "guarded smart-folder create failed: $(field "$OUT" code) $(field "$OUT" message)"
SMART="$(field "$OUT" identifier)"
SMART_URI="$(field "$OUT" objectURI)"
SREV="$(field "$OUT" revision)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"delete_smart_folder\",\"identifier\":\"$SMART\",\"dryRun\":false,\"ifRevision\":\"$SREV\",\"forbiddenAncestorFolderIds\":[\"$SMART_URI\"]}" || true)"
[ "$(field "$OUT" scopeReason)" = "inside_forbidden_folder" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "delete of a forbidden smart folder not refused: $(field "$OUT" code) $(field "$OUT" scopeReason)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"delete_smart_folder\",\"identifier\":\"$SMART\",\"dryRun\":false,\"ifRevision\":\"$SREV\",\"ifAncestorFolderId\":\"$PARENT\"}")"
[ "$(field "$OUT" status)" = "deleted" ] || fail "guarded smart-folder delete failed: $(field "$OUT" code)"
echo "ok: smart-folder create and delete apply inside the expected parent; a forbidden smart folder is refused"

# 5. Purge-flag repair on a note put into the corrupt state in the copy only.
/usr/bin/sqlite3 "$COPY" "UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1 WHERE ZIDENTIFIER = '$OTHER';"
repair() { printf '{"protocol":1,"action":"repair_purge_flag"%s}' "$1"; }
OUT="$(copy_run "$(repair ',"dryRun":true')")"
[ "$(field "$OUT" status)" = "scanned" ] || fail "scan failed: $(field "$OUT" code)"
case "$OUT" in *"$OTHER"*) ;; *) fail "scan did not find the flagged note" ;; esac
OUT="$(copy_run "$(repair ",\"dryRun\":true,\"identifier\":\"$OTHER\"")")"
[ "$(field "$OUT" state)" = "purge_flag_outside_recently_deleted" ] && [ "$(field "$OUT" repairable)" = "true" ] ||
  fail "plan did not find a repairable state: $(field "$OUT" state)"
PREV="$(field "$OUT" revision)"
TRASH_ID="$(field "$OUT" recentlyDeletedFolderIdentifier)"
TRASH_PK="$(/usr/bin/sqlite3 "$COPY" "SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT
  WHERE ZIDENTIFIER = '$TRASH_ID' AND ZFOLDERTYPE = 1 LIMIT 1;")"
OUT="$(copy_run "$(repair ",\"dryRun\":false,\"identifier\":\"$OTHER\",\"ifRevision\":\"$PREV\"")" || true)"
[ "$(field "$OUT" code)" = "confirmation_required" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "repair without confirm not refused: $(field "$OUT" code)"
OUT="$(copy_run "$(repair ",\"dryRun\":false,\"identifier\":\"$OTHER\",\"ifRevision\":\"$ZERO\",\"confirm\":true")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "stale repair revision not refused"
if [ -n "$TRASH_PK" ]; then
  OUT="$(copy_run "$(repair ",\"dryRun\":false,\"identifier\":\"$OTHER\",\"ifRevision\":\"$PREV\",\"confirm\":true,\"forbiddenAncestorFolderIds\":[\"$(folder_uri "$TRASH_PK")\"]")" || true)"
  [ "$(field "$OUT" scopeReason)" = "destination_inside_forbidden_folder" ] ||
    fail "repair into a forbidden Recently Deleted not refused: $(field "$OUT" code)"
  echo "ok: repair refuses a forbidden destination"
fi
OUT="$(copy_run "$(repair ",\"dryRun\":false,\"identifier\":\"$OTHER\",\"ifRevision\":\"$PREV\",\"confirm\":true")")"
[ "$(field "$OUT" status)" = "repaired" ] && [ "$(field "$OUT" verified)" = "true" ] &&
  [ "$(field "$OUT" state)" = "in_recently_deleted" ] ||
  fail "repair failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(/usr/bin/sqlite3 "$COPY" "SELECT IFNULL(ZMARKEDFORDELETION,0) FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = '$OTHER';")" = "0" ] ||
  fail "the copy still has the purge flag"
OUT="$(copy_run "$(repair ",\"dryRun\":true,\"identifier\":\"$OTHER\"")")"
[ "$(field "$OUT" state)" = "in_recently_deleted" ] && [ "$(field "$OUT" repairable)" = "false" ] ||
  fail "repaired note not in Recently Deleted: $(field "$OUT" state)"
echo "ok: purge flag cleared and the note moved to Recently Deleted, verified; a new plan reports nothing to repair"

assert_live_unchanged "$NOTE" "$LIVE_NOTE"
assert_live_unchanged "$OTHER" "$LIVE_OTHER"
echo "PASS: scope guards and purge-flag repair on a store copy"
