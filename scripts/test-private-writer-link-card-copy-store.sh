#!/bin/bash
# Exercise the private writer's add_url_card action against a COPY of the
# Notes store. See scripts/private-writer-copy-store-lib.sh for the copy and
# live-store rules. The writer fetches nothing, so no file may appear under
# the live Notes container while the cards are added.
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-writer-link-card-copy-store.sh [NOTE_UUID]
#   NOTE_UUID  note to use in the copy. Default: the most recent writable note.
#   HELPER=/path/to/binary to reuse a built writer instead of compiling.
set -euo pipefail
# shellcheck source=scripts/private-writer-copy-store-lib.sh
. "$(dirname "$0")/private-writer-copy-store-lib.sh"

NOTE="${1:-}"
if [ -z "$NOTE" ]; then
  for CANDIDATE in $(writable_candidates "1 = 1"); do
    if is_writable "$CANDIDATE"; then
      NOTE="$CANDIDATE"
      break
    fi
  done
fi
[ -n "$NOTE" ] || fail "no writable candidate note found in the copy"
READ="$(read_request "$NOTE")"
LIVE_BEFORE="$(field "$(run "$READ")" revision)"
[ -n "$LIVE_BEFORE" ] || fail "could not read the live note state"

card_request() {
  printf '{"protocol":1,"action":"add_url_card","identifier":"%s","url":"%s","ifRevision":"%s"%s}' \
    "$NOTE" "$1" "$2" "${3:-}"
}
MARKER_FILE="$WORK/card-marker"
touch "$MARKER_FILE"

# 1. Without the write switch the writer refuses a read-write open of the live store.
OUT="$(run "$(card_request "https://example.com/" "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "live read-write open not gated: $(field "$OUT" code)"
echo "ok: live add_url_card refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. Fixture text with an anchor paragraph, then refusals and a dry run.
ANCHOR="card-anchor-$(date +%s)"
REV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"$ANCHOR\\ncard tail\",\"ifRevision\":\"$REV\"}")"
[ "$(field "$OUT" verified)" = "true" ] || fail "could not add the card fixture text"
REV="$(field "$OUT" revisionAfter)"
LEN_BEFORE="$(field "$(copy_run "$READ")" bodyLengthUTF16)"
OUT="$(copy_run "$(card_request "https://example.com/" "$REV" ",\"afterParagraph\":\"$ANCHOR-missing\"")" || true)"
[ "$(field "$OUT" code)" = "match_count_mismatch" ] && [ "$(field "$OUT" found)" = "0" ] &&
  [ "$(field "$OUT" committed)" = "false" ] || fail "missing anchor not refused: $(field "$OUT" code)"
for BAD in "javascript:alert(1)" "file:///etc/hosts" "https://" "notes://showNote"; do
  OUT="$(copy_run "$(card_request "$BAD" "$REV")" || true)"
  [ "$(field "$OUT" code)" = "invalid_request" ] || fail "URL not refused: $BAD"
done
OUT="$(copy_run "$(card_request "https://example.com/" "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "stale card revision not refused"
OUT="$(copy_run "$(card_request "https://example.com/" "$REV" ",\"afterParagraph\":\"$ANCHOR\",\"dryRun\":true")" || true)"
[ "$(field "$OUT" status)" = "planned" ] && [ "$(field "$OUT" separatorInserted)" = "false" ] &&
  [ "$(field "$OUT" terminatorInserted)" = "true" ] || fail "card dry run failed: $(field "$OUT" code)"
[ -n "$(field "$OUT" writeAvailable)" ] || fail "card dry run did not report writeAvailable"
[ "$(field "$(copy_run "$READ")" revision)" = "$REV" ] || fail "card dry run changed the note"
echo "ok: anchor guard, URL checks, stale revision, and dry run (no write) behave"

# 3. A card after the anchor paragraph, then one at the end.
OUT="$(copy_run "$(card_request "https://example.com/" "$REV" ",\"afterParagraph\":\"$ANCHOR\"")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "card after paragraph failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" attachment.typeUTI)" = "public.url" ] || fail "card attachment is not public.url"
[ "$(field "$OUT" attachment.urlString)" = "https://example.com/" ] || fail "card URL not stored"
[ "$(field "$OUT" attachment.glyphIndexUTF16)" = "$(field "$OUT" glyphIndexUTF16)" ] ||
  fail "card glyph is not at the planned index"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "card did not report the copy store"
echo "copy cloud state: note current=$(field "$OUT" cloudSync.currentLocalVersion) synced=$(field "$OUT" cloudSync.latestVersionSyncedToCloud); attachment current=$(field "$OUT" attachment.cloudSync.currentLocalVersion) synced=$(field "$OUT" attachment.cloudSync.latestVersionSyncedToCloud) uploadPending=$(field "$OUT" attachment.cloudSync.uploadPending)"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(card_request "https://example.com/" "$REV" ",\"afterParagraph\":\"$ANCHOR\"")" || true)"
[ "$(field "$OUT" status)" = "updated" ] || fail "second card after the same paragraph failed"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(card_request "https://example.org/path?q=1" "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" placement)" = "end" ] ||
  fail "card at end failed: $(field "$OUT" code)"
LEN_AFTER="$(field "$(copy_run "$READ")" bodyLengthUTF16)"
[ "$LEN_AFTER" = "$((LEN_BEFORE + 6))" ] || fail "body length $LEN_BEFORE -> $LEN_AFTER, expected +6"
OUT="$(copy_run "$(card_request "https://example.org/" "$REV")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed card not refused"
NEW_FILES="$(/usr/bin/find "$(dirname "$LIVE")" -newer "$MARKER_FILE" -type f ! -name 'NoteStore.sqlite*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$NEW_FILES" = "0" ] || fail "$NEW_FILES file(s) appeared under the live Notes container during the card test"
echo "ok: three public.url cards inserted and read back at the planned glyph index (+6 UTF-16 units); replay refused; no live container files"

# 3b. A card after a checklist item goes after the item's own newline and is
#     a body paragraph: the item keeps its line and todo, and the writer's
#     read-back checks the card line's style.
CHK="card-checklist-$(date +%s)"
REV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"compose_note\",\"identifier\":\"$NOTE\",\"mode\":\"append\",\"ifRevision\":\"$REV\",\"paragraphs\":[{\"style\":\"checklist\",\"checked\":false,\"runs\":[{\"text\":\"$CHK\"}]},{\"style\":\"body\",\"runs\":[{\"text\":\"after the checklist\"}]}]}" || true)"
[ "$(field "$OUT" verified)" = "true" ] || fail "could not add the checklist fixture: $(field "$OUT" code) $(field "$OUT" message)"
CL0="$(copy_run "{\"protocol\":1,\"action\":\"read_checklist\",\"identifier\":\"$NOTE\"}" || true)"
ITEMS_BEFORE="$(field "$CL0" total)"
[ -n "$ITEMS_BEFORE" ] || fail "read_checklist failed: $(field "$CL0" code) $(field "$CL0" message)"
OUT="$(copy_run "$(card_request "https://example.net/" "$(field "$OUT" revisionAfter)" ",\"afterParagraph\":\"$CHK\"")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "card after a checklist item failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" terminatorInserted)" = "true" ] && [ "$(field "$OUT" separatorInserted)" = "false" ] ||
  fail "card after a checklist item was not placed after the item's newline"
CHECKLIST="$(copy_run "{\"protocol\":1,\"action\":\"read_checklist\",\"identifier\":\"$NOTE\"}")"
[ "$(field "$CHECKLIST" total)" = "$ITEMS_BEFORE" ] || fail "the card changed the checklist item count ($ITEMS_BEFORE -> $(field "$CHECKLIST" total))"
grep -q "\"text\":\"$CHK\"" <<<"$CHECKLIST" || fail "the checklist item lost its text"
echo "ok: card after a checklist item is its own body line; the item is unchanged"

# 4. The live note is untouched.
assert_live_unchanged "$NOTE" "$LIVE_BEFORE"
echo "PASS"
