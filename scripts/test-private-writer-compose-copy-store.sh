#!/bin/bash
# Exercise compose_note's file and link-card paragraphs and its frozen
# attachment proof against a COPY of the Notes store. See
# scripts/private-writer-copy-store-lib.sh for the copy and live-store rules.
# On a copy the writer points every account directory at the copy's own
# directory, so the attachment files it writes land under $WORK/Accounts,
# never in the live Notes container.
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-writer-compose-copy-store.sh [NOTE_UUID]
#   NOTE_UUID  note to use in the copy. Default: the most recent writable note
#              that already has an attachment.
#   HELPER=/path/to/binary to reuse a built writer instead of compiling.
set -euo pipefail
# shellcheck source=scripts/private-writer-copy-store-lib.sh
. "$(dirname "$0")/private-writer-copy-store-lib.sh"

NOTE="${1:-}"
if [ -z "$NOTE" ]; then
  for CANDIDATE in $(writable_candidates "EXISTS (SELECT 1 FROM ZICCLOUDSYNCINGOBJECT a
      WHERE a.ZNOTE = n.Z_PK AND a.ZTYPEUTI IS NOT NULL AND IFNULL(a.ZMARKEDFORDELETION,0)=0)"); do
    if is_writable "$CANDIDATE"; then
      NOTE="$CANDIDATE"
      break
    fi
  done
fi
[ -n "$NOTE" ] || fail "no writable note with an attachment found in the copy"
READ="$(read_request "$NOTE")"
LIVE_BEFORE="$(field "$(run "$READ")" revision)"
[ -n "$LIVE_BEFORE" ] || fail "could not read the live note state"
NOTE_PK="$(/usr/bin/sqlite3 "$COPY" "SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = '$NOTE' LIMIT 1;")"
attachment_rows() {
  /usr/bin/sqlite3 "$COPY" "SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZNOTE = $NOTE_PK AND ZTYPEUTI IS NOT NULL;"
}
copy_files() { { /usr/bin/find "$WORK/Accounts" -type f 2>/dev/null || true; } | wc -l | tr -d ' '; }

# Fixture files: a small PNG and a text file.
PNG="$WORK/fixture chart.png"
TXT="$WORK/fixture-notes.txt"
/usr/bin/sips -s format png -z 16 16 \
  /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns \
  --out "$PNG" >/dev/null 2>&1 || fail "could not make the PNG fixture"
printf 'compose copy-store fixture %s\n' "$(date +%s)" >"$TXT"
PNG_SHA="$(/usr/bin/shasum -a 256 "$PNG" | cut -d' ' -f1)"
TXT_SHA="$(/usr/bin/shasum -a 256 "$TXT" | cut -d' ' -f1)"
PARAS="[{\"style\":\"heading\",\"runs\":[{\"text\":\"Compose attachments\"}]},
{\"kind\":\"file\",\"path\":\"$PNG\",\"filename\":\"Chart.png\"},
{\"style\":\"body\",\"runs\":[{\"text\":\"between\"}]},
{\"kind\":\"url\",\"url\":\"https://example.com/compose\"},
{\"kind\":\"table\",\"rows\":[[\"A\",\"B\"],[\"1\",\"2\"]]},
{\"kind\":\"file\",\"path\":\"$TXT\"},
{\"style\":\"body\",\"runs\":[{\"text\":\"end\"}]}]"
compose_request() { # extra JSON fields (leading comma)
  printf '{"protocol":1,"action":"compose_note","identifier":"%s","mode":"append","paragraphs":%s%s}' \
    "$NOTE" "$PARAS" "$1"
}
MARKER_FILE="$WORK/compose-marker"
touch "$MARKER_FILE"

# 1. Without the write switch the writer refuses a read-write open of the live store.
OUT="$(run "$(compose_request ",\"ifRevision\":\"$ZERO\"")" || true)"
[ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "live compose not gated: $(field "$OUT" code)"
echo "ok: live compose with attachments refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. A refusal raised before the save reports committed=false.
BAD="{\"protocol\":1,\"action\":\"compose_note\",\"identifier\":\"$NOTE\",\"mode\":\"append\",\"paragraphs\":[{\"kind\":\"file\",\"path\":\"relative.png\"}],\"dryRun\":true}"
OUT="$(copy_run "$BAD" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "relative file path not refused with committed=false: $(field "$OUT" code)"
echo "ok: a relative file path is refused before anything is created, committed=false"

# 3. Dry run: the plan names each object and the bytes read; nothing changes.
REV="$(field "$(copy_run "$READ")" revision)"
ROWS_BEFORE="$(attachment_rows)"
OUT="$(copy_run "$(compose_request ',"dryRun":true')" || true)"
[ "$(field "$OUT" status)" = "planned" ] || fail "dry run failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" objects.0.sha256)" = "$PNG_SHA" ] || fail "plan does not carry the PNG's SHA-256"
[ "$(field "$OUT" objects.0.filename)" = "Chart.png" ] || fail "plan does not carry the file name"
[ "$(field "$OUT" objects.1.url)" = "https://example.com/compose" ] || fail "plan does not carry the card URL"
FROZEN="$(field "$OUT" frozenAttachments.attachments)"
[ "${FROZEN:-0}" -ge 1 ] || fail "the plan fingerprinted no existing attachment"
[ "$(field "$(copy_run "$READ")" revision)" = "$REV" ] || fail "dry run changed the note"
echo "ok: dry run planned 4 objects and fingerprinted $FROZEN existing attachment(s); nothing written"

# 4. A failure injected after every object exists, just before the save,
#    must leave no row and no file behind.
FILES_BEFORE="$(copy_files)"
OUT="$(printf '%s' "$(compose_request ",\"ifRevision\":\"$REV\"")" |
  env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES APPLE_NOTES_MCP_PRIVATE_STORE="$COPY" \
    APPLE_NOTES_MCP_WRITER_FAULT=compose_before_save "$HELPER" 2>/dev/null || true)"
[ "$(field "$OUT" code)" = "injected_fault" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "injected fault not reported: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$(copy_run "$READ")" revision)" = "$REV" ] || fail "the failed compose changed the note"
[ "$(attachment_rows)" = "$ROWS_BEFORE" ] || fail "the failed compose left attachment rows behind"
[ "$(copy_files)" = "$FILES_BEFORE" ] || fail "the failed compose left attachment files behind"
echo "ok: a failure before the save rolled back every row and removed every file written"

# 5. Apply: two files, a card, and a table in one verified save.
OUT="$(copy_run "$(compose_request ",\"ifRevision\":\"$REV\"")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "compose failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "compose did not report the copy store"
[ "$(field "$OUT" objects)" = "4" ] || fail "expected 4 created objects, got $(field "$OUT" objects)"
[ "$(field "$OUT" objects.0.uti)" = "public.png" ] || fail "PNG attachment has type $(field "$OUT" objects.0.uti)"
[ "$(field "$OUT" objects.1.uti)" = "public.url" ] || fail "card attachment has type $(field "$OUT" objects.1.uti)"
[ "$(field "$OUT" frozenAttachments.verified)" = "true" ] || fail "frozen attachments not verified"
[ "$(field "$OUT" readBack.1.runs.0.attributes.attachment.identifier)" = "$(field "$OUT" objects.0.identifier)" ] ||
  fail "the file glyph does not name the new attachment"
[ "$(attachment_rows)" = "$((ROWS_BEFORE + 4))" ] || fail "attachment rows $ROWS_BEFORE -> $(attachment_rows), expected +4"
STORED="$(/usr/bin/find "$WORK/Accounts" -type f -exec /usr/bin/shasum -a 256 {} +)"
for SHA in "$PNG_SHA" "$TXT_SHA"; do
  case "$STORED" in
    *"$SHA "*) ;;
    *) fail "no stored attachment file has SHA-256 $SHA" ;;
  esac
done
echo "ok: 2 files, a link card, and a table created in one save; glyphs, rows, and file bytes verified; $FROZEN existing attachment(s) unchanged"

# 6. The replayed request is stale.
OUT="$(copy_run "$(compose_request ",\"ifRevision\":\"$REV\"")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "replayed compose not refused"
echo "ok: replayed compose refused, committed=false"

# 7. A note with no body at all is refused: its first paragraph is the title.
EMPTY=""
for CANDIDATE in $(writable_candidates "1 = 1"); do
  if [ "$(field "$(copy_run "$(read_request "$CANDIDATE")")" bodyLengthUTF16)" = "0" ] && is_writable "$CANDIDATE"; then
    EMPTY="$CANDIDATE"
    break
  fi
done
if [ -n "$EMPTY" ]; then
  OUT="$(copy_run "$(compose_request ',"dryRun":true' | sed "s/$NOTE/$EMPTY/")" || true)"
  [ "$(field "$OUT" code)" = "unsupported_note" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "a note with no body was not refused: $(field "$OUT" code)"
  echo "ok: a note with no title paragraph is refused"
else
  echo "note: no empty note in this store; the empty-body refusal was not exercised"
fi

# 8. Nothing reached the live container, and the live note is untouched.
NEW_FILES="$(/usr/bin/find "$(dirname "$LIVE")" -newer "$MARKER_FILE" -type f ! -name 'NoteStore.sqlite*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$NEW_FILES" = "0" ] || fail "$NEW_FILES file(s) appeared under the live Notes container during the test"
echo "ok: no new file under the live Notes container"
assert_live_unchanged "$NOTE" "$LIVE_BEFORE"
echo "PASS"
