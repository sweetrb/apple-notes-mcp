#!/bin/bash
# Exercise the private writer's set_highlight action against a COPY of the
# Notes store. See scripts/private-writer-copy-store-lib.sh for the copy and
# live-store rules.
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-writer-highlight-copy-store.sh [NOTE_UUID]
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

highlight_request() {
  printf '{"protocol":1,"action":"set_highlight","identifier":"%s","match":"%s","color":"%s","expectedCount":%s,"ifRevision":"%s"%s}' \
    "$NOTE" "$1" "$2" "$3" "$4" "${5:-}"
}

# 1. Without the write switch the writer refuses a read-write open of the live store.
OUT="$(run "$(highlight_request "x" mint 1 "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "live read-write open not gated: $(field "$OUT" code)"
echo "ok: live set_highlight refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. Add the fixture text twice so the count guard matters.
MARK="hl-$(date +%s)"
REV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"$MARK one\\n$MARK two\",\"ifRevision\":\"$REV\"}")"
[ "$(field "$OUT" verified)" = "true" ] || fail "could not add the highlight fixture text"
REV="$(field "$OUT" revisionAfter)"
FLAG_BEFORE="$(field "$(copy_run "$(highlight_request "$MARK" mint 2 "$REV" ',"dryRun":true')")" hasEmphasis)"

# 3. Refusals and the dry run write nothing.
OUT="$(copy_run "$(highlight_request "$MARK" mint 1 "$REV")" || true)"
[ "$(field "$OUT" code)" = "match_count_mismatch" ] && [ "$(field "$OUT" found)" = "2" ] &&
  [ "$(field "$OUT" committed)" = "false" ] || fail "count guard did not refuse: $(field "$OUT" code)"
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$ZERO")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "stale highlight revision not refused"
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$REV" ',"scope":"paragraph"')" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] || fail "unknown scope not refused"
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$REV" ',"scope":"note"')" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] || fail "scope note with match not refused"
OUT="$(copy_run "$(highlight_request "$MARK" teal 2 "$REV")" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] || fail "unknown color not refused"
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$REV" ',"dryRun":true')" || true)"
[ "$(field "$OUT" status)" = "planned" ] && [ "$(field "$OUT" wouldChange)" = "true" ] &&
  [ "$(field "$OUT" plan.1.changes)" = "true" ] || fail "dry run did not plan: $(field "$OUT" code)"
[ "$(field "$OUT" writeAvailable)" = "true" ] || fail "dry run did not report writeAvailable"
[ "$(field "$(copy_run "$READ")" revision)" = "$REV" ] || fail "dry run changed the note"
echo "ok: count guard, stale revision, unknown scope and color, and dry run (no write) behave"

# 3b. A match that ends inside a composed character (a letter and its
#     combining accent) is refused; the whole character matches.
CMARK="cm-$(date +%s)"
OUT="$(copy_run "{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"${CMARK}e\\u0301\",\"ifRevision\":\"$REV\"}")"
[ "$(field "$OUT" verified)" = "true" ] || fail "could not add the composed-character fixture"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(highlight_request "${CMARK}e" mint 1 "$REV")" || true)"
[ "$(field "$OUT" code)" = "invalid_request" ] && [ "$(field "$OUT" splittingMatches)" = "1" ] &&
  [ "$(field "$OUT" committed)" = "false" ] || fail "a match splitting a composed character was not refused: $(field "$OUT" code)"
OUT="$(copy_run "$(highlight_request "${CMARK}e\\u0301" mint 1 "$REV" ',"dryRun":true')" || true)"
[ "$(field "$OUT" status)" = "planned" ] || fail "the whole composed character did not match: $(field "$OUT" code)"
echo "ok: a match inside a composed character is refused; the whole character matches"

# 4. Highlight both matches, repeat (no-op), then remove.
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
  fail "highlight failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" ranges.0.storedRuns.0.color)" = "mint" ] &&
  [ "$(field "$OUT" ranges.1.storedRuns.0.color)" = "mint" ] || fail "stored runs are not mint"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "highlight did not report the copy store"
[ "$(field "$OUT" hasEmphasis)" = "true" ] || fail "hasEmphasis not set after the highlight"
echo "ok: hasEmphasis $FLAG_BEFORE -> true"
echo "copy cloud state: current=$(field "$OUT" cloudSync.currentLocalVersion) synced=$(field "$OUT" cloudSync.latestVersionSyncedToCloud) uploadPending=$(field "$OUT" cloudSync.uploadPending)"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(highlight_request "$MARK" mint 2 "$REV")" || true)"
[ "$(field "$OUT" status)" = "unchanged" ] && [ "$(field "$OUT" committed)" = "false" ] &&
  [ "$(field "$OUT" revisionAfter)" = "$REV" ] || fail "repeat highlight was not a no-op"
OUT="$(copy_run "$(highlight_request "$MARK" purple 2 "$REV")" || true)"
[ "$(field "$OUT" ranges.0.storedRuns.0.color)" = "purple" ] || fail "recolor failed: $(field "$OUT" code)"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(highlight_request "$MARK" none 2 "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ -z "$(field "$OUT" ranges.0.storedRuns.0.color)" ] ||
  fail "highlight removal failed: $(field "$OUT" code)"
[ "$(field "$OUT" hasEmphasis)" = "$FLAG_BEFORE" ] || fail "hasEmphasis did not return to $FLAG_BEFORE"
echo "ok: two matches highlighted mint, repeat was a no-op, recolored purple, removal read back"

# 5. Whole-note scope, preferably on a note with attachments so the glyph
#    skip is exercised. Falls back to the note above.
WHOLE=""
for CANDIDATE in $(writable_candidates "EXISTS (SELECT 1 FROM ZICCLOUDSYNCINGOBJECT a WHERE a.ZNOTE = n.Z_PK AND a.ZTYPEUTI IS NOT NULL)"); do
  if is_writable "$CANDIDATE"; then
    WHOLE="$CANDIDATE"
    break
  fi
done
[ -n "$WHOLE" ] || WHOLE="$NOTE"
WHOLE_READ="$(read_request "$WHOLE")"
WHOLE_LIVE_BEFORE="$(field "$(run "$WHOLE_READ")" revision)"
note_request() {
  printf '{"protocol":1,"action":"set_highlight","identifier":"%s","scope":"note","color":"%s","ifRevision":"%s"%s}' \
    "$WHOLE" "$1" "$2" "${3:-}"
}
REV="$(field "$(copy_run "$WHOLE_READ")" revision)"
for EXTRA in ',"match":"x"' ',"expectedCount":1'; do
  OUT="$(copy_run "$(note_request mint "$REV" "$EXTRA")" || true)"
  [ "$(field "$OUT" code)" = "invalid_request" ] || fail "scope note accepted $EXTRA"
done
OUT="$(copy_run "$(note_request mint "$REV" ',"dryRun":true')" || true)"
[ "$(field "$OUT" status)" = "planned" ] && [ "$(field "$OUT" scope)" = "note" ] ||
  fail "whole-note dry run did not plan: $(field "$OUT" code) $(field "$OUT" message)"
CHARS="$(field "$OUT" characterCount)"
RANGES="$(field "$OUT" rangeCount)"
TITLE="$(field "$OUT" skipped.titleUTF16)"
GLYPHS="$(field "$OUT" skipped.attachmentGlyphs)"
WHOLE_FLAG_BEFORE="$(field "$OUT" hasEmphasis)"
# The first range starts right after the title, or after the attachment
# glyphs that open the body (the whole-note scope skips every glyph).
START="$(field "$OUT" plan.0.start)"
[ "$START" -ge "$TITLE" ] && [ $((START - TITLE)) -le "${GLYPHS:-0}" ] ||
  fail "whole-note range starts at $START, not after the title ($TITLE) and at most $GLYPHS glyphs"
[ "$(field "$(copy_run "$WHOLE_READ")" revision)" = "$REV" ] || fail "whole-note dry run changed the note"
echo "ok: whole-note dry run: ranges=$RANGES chars=$CHARS titleUTF16=$TITLE attachmentGlyphs=$GLYPHS highlightedGlyphs=$(field "$OUT" skipped.highlightedAttachmentGlyphs)"
OUT="$(copy_run "$(note_request blue "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] &&
  [ "$(field "$OUT" characterCount)" = "$CHARS" ] && [ "$(field "$OUT" hasEmphasis)" = "true" ] ||
  fail "whole-note highlight failed: $(field "$OUT" code) $(field "$OUT" message)"
LAST=$((RANGES - 1))
[ "$(field "$OUT" ranges.0.storedRuns.0.color)" = "blue" ] &&
  [ "$(field "$OUT" "ranges.$LAST.storedRuns.0.color")" = "blue" ] || fail "whole-note stored runs are not blue"
REV="$(field "$OUT" revisionAfter)"
OUT="$(copy_run "$(note_request blue "$REV")" || true)"
[ "$(field "$OUT" status)" = "unchanged" ] && [ "$(field "$OUT" revisionAfter)" = "$REV" ] ||
  fail "repeat whole-note highlight was not a no-op"
OUT="$(copy_run "$(note_request none "$REV")" || true)"
[ "$(field "$OUT" status)" = "updated" ] && [ -z "$(field "$OUT" ranges.0.storedRuns.0.color)" ] ||
  fail "whole-note removal failed: $(field "$OUT" code)"
echo "ok: whole note highlighted blue (hasEmphasis $WHOLE_FLAG_BEFORE -> true), repeat was a no-op, removal read back (hasEmphasis $(field "$OUT" hasEmphasis))"

# 6. The live notes are untouched.
assert_live_unchanged "$NOTE" "$LIVE_BEFORE"
[ "$WHOLE" = "$NOTE" ] || assert_live_unchanged "$WHOLE" "$WHOLE_LIVE_BEFORE"
echo "PASS"
