#!/bin/bash
# Exercise the opt-in private WRITER's write paths against a COPY of the Notes
# store. (The read-only helper has no write path; this script builds the
# separate writer, native/private-helper/apple-notes-private-writer.m.)
#
# The live NoteStore.sqlite is only ever opened read-only: once by sqlite3's
# online backup (to make the copy) and by the writer's read-only
# read_note_state before and after the copy writes, to prove the live note did
# not change. Every write runs with APPLE_NOTES_MCP_PRIVATE_STORE pointing at
# the copy; the writer refuses that variable if it resolves to the live store.
# This script never sets APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES, so the writer
# also refuses any read-write open of the live store (checked in step 1b).
#
# Usage: APPLE_NOTES_MCP_ENABLE_PRIVATE=1 scripts/test-private-helper-copy-store.sh [NOTE_UUID]
#   NOTE_UUID  note to write to in the copy. Default: the most recently
#              modified unlocked note with a folder, chosen from the copy.
#   HELPER=/path/to/binary to reuse a built writer instead of compiling.
#   EDIT_NOTES="UUID ..." notes for the plan_edit / edit_note round trip.
#              Default: up to EDIT_SAMPLE (5) recent editable notes that own
#              attachments, plus up to 3 without. The first note also runs
#              the rich-run, inline-link, and checklist steps (4c2); notes
#              with an attachment in the body also run the attachment
#              selector steps (4d), including a file replacement when one
#              of the first five attachments is a file (image, PDF). If the
#              default sample has none, name such notes in EDIT_NOTES.
#
# Some steps use the writer's copy-only fault injection
# (APPLE_NOTES_MCP_PRIVATE_TEST_FAULT), which the writer ignores unless
# APPLE_NOTES_MCP_PRIVATE_STORE names a copy.
#
# Prints states and counts only, never note titles or bodies. Needs Full Disk
# Access for the terminal running it. Removes the copy on exit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
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
json_field() { printf '%s' "$1" | /usr/bin/plutil -extract "$2" json -o - - 2>/dev/null || true; }

[ -r "$LIVE" ] || fail "cannot read the live store (grant Full Disk Access to this terminal)"
[ "${APPLE_NOTES_MCP_ENABLE_PRIVATE:-}" = "1" ] ||
  fail "set APPLE_NOTES_MCP_ENABLE_PRIVATE=1 so the live note can be compared (reads only)"

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

# The write switch is always cleared, so the live store can only be opened
# read-only; copy writes do not need it.
run() { printf '%s' "$1" | env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES "$HELPER" 2>/dev/null; }
copy_run() {
  printf '%s' "$1" | env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES \
    APPLE_NOTES_MCP_PRIVATE_STORE="$COPY" "$HELPER" 2>/dev/null
}
read_request() { printf '{"protocol":1,"action":"read_note_state","identifier":"%s"}' "$1"; }
ZERO="r1:$(printf '0%.0s' $(seq 1 64))"

NOTE="${1:-}"
if [ -z "$NOTE" ]; then
  # First recent candidate the writer itself reports as writable.
  for CANDIDATE in $(/usr/bin/sqlite3 "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT n
    JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
    WHERE n.ZIDENTIFIER IS NOT NULL AND n.ZFOLDER IS NOT NULL
      AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0 AND IFNULL(n.ZMARKEDFORDELETION,0)=0
    ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT 25;"); do
    STATE="$(copy_run "$(read_request "$CANDIDATE")" || true)"
    if [ "$(field "$STATE" editable)" = "true" ] && [ "$(field "$STATE" sharedViaICloud)" = "false" ] &&
      [ "$(field "$STATE" deletedOrInTrash)" = "false" ]; then
      NOTE="$CANDIDATE"
      break
    fi
  done
fi
[ -n "$NOTE" ] || fail "no writable candidate note found in the copy"

READ="$(read_request "$NOTE")"
LIVE_BEFORE="$(field "$(run "$READ")" revision)"
[ -n "$LIVE_BEFORE" ] || fail "could not read the live note state"

# 1. The writer must refuse to treat the live store as a copy.
REFUSED="$(printf '%s' "$READ" | APPLE_NOTES_MCP_PRIVATE_STORE="$LIVE" "$HELPER" || true)"
[ "$(field "$REFUSED" code)" = "invalid_request" ] || fail "live store accepted as a copy"
echo "ok: live store refused as a copy"

# 1b. Without the write switch the writer refuses a read-write open of the
# live store. The request also carries a zero revision, so even a broken
# switch could only end in revision_conflict, never in a write.
GATED="$(run "{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"x\",\"ifRevision\":\"$ZERO\"}" || true)"
[ "$(field "$GATED" code)" = "writes_disabled" ] || fail "live read-write open not gated: $(field "$GATED" code)"
[ "$(field "$GATED" committed)" = "false" ] || fail "gated write did not report committed=false"
echo "ok: live read-write open refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

# 2. Stale revision is refused with nothing committed.
STALE="{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"x\",\"ifRevision\":\"$ZERO\"}"
OUT="$(copy_run "$STALE" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "stale revision not refused: $(field "$OUT" code)"
[ "$(field "$OUT" committed)" = "false" ] || fail "stale revision reported committed"
echo "ok: stale ifRevision refused, committed=false"

# 3. Guarded append on the copy, verified by the writer's fresh read-back.
BEFORE="$(copy_run "$READ")"
REV="$(field "$BEFORE" revision)"
LEN_BEFORE="$(field "$BEFORE" bodyLengthUTF16)"
[ -n "$REV" ] || fail "no revision from read_note_state: $(field "$BEFORE" code)"
TEXT="copy-store append $(date +%s)"
APPEND="{\"protocol\":1,\"action\":\"append_plain_text\",\"identifier\":\"$NOTE\",\"text\":\"$TEXT\",\"ifRevision\":\"$REV\"}"
OUT="$(copy_run "$APPEND" || true)"
[ "$(field "$OUT" status)" = "updated" ] || fail "append failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" verified)" = "true" ] || fail "append not verified"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "append did not report the copy store"
echo "ok: append committed and verified on the copy (pushState $(field "$OUT" pushState))"

AFTER="$(copy_run "$READ")"
LEN_AFTER="$(field "$AFTER" bodyLengthUTF16)"
[ "$(field "$AFTER" revision)" != "$REV" ] || fail "revision did not change"
echo "ok: body length $LEN_BEFORE -> $LEN_AFTER UTF-16 units; revision changed"
echo "copy cloud state: current=$(field "$AFTER" cloudSync.currentLocalVersion) synced=$(field "$AFTER" cloudSync.latestVersionSyncedToCloud) uploadPending=$(field "$AFTER" cloudSync.uploadPending)"

# 3b. read_sync_state (the sync nudge's read) sees the same pending upload.
SYNC="$(copy_run "{\"protocol\":1,\"action\":\"read_sync_state\",\"identifiers\":[\"$NOTE\"]}" || true)"
[ "$(field "$SYNC" objects.0.uploadPending)" = "true" ] || fail "read_sync_state did not report the pending upload"
[ "$(field "$SYNC" objects.0.revision)" = "$(field "$AFTER" revision)" ] || fail "read_sync_state revision differs from read_note_state"
[ "$(field "$SYNC" objects.0.kind)" = "note" ] || fail "read_sync_state did not classify the note"
echo "ok: read_sync_state reports the pending upload (library backlog $(field "$SYNC" pendingUploadCount))"

# 4. The replayed request is now stale.
OUT="$(copy_run "$APPEND" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed append not refused"
echo "ok: replayed append refused"

# Feature write checks go here, each against the copy only. Each note a
# feature writes to in the copy is recorded with watch_live first, and step 5
# proves its live revision did not change.
WATCHED="$WORK/watched-live"
: >"$WATCHED"
watch_live() { printf '%s %s\n' "$1" "$(field "$(run "$(read_request "$1")")" revision)" >>"$WATCHED"; }

# The read-only readers (src/utils/noteParagraphs.ts and
# noteLinkInventory.ts), bundled once and pointed at the copy, so every
# paragraph or link write is checked by the same code list-note-paragraphs and
# list-note-links run. Prints one JSON object per call.
READER="$WORK/paragraph-reader.mjs"
cat >"$WORK/paragraph-reader.ts" <<'TS'
import { readNoteParagraphs } from "@/utils/noteParagraphs.js";
import { listNoteLinks } from "@/utils/noteLinkInventory.js";
import { readNoteBlocks } from "@/utils/noteBlocks.js";
const [mode, id, dbPath] = process.argv.slice(2);
try {
  const result =
    mode === "links"
      ? listNoteLinks({ id, kinds: ["section"], dbPath })
      : mode === "blocks"
        ? readNoteBlocks(id, { dbPath }).blocks
        : readNoteParagraphs({ id }, { dbPath });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error) }));
}
TS
(cd "$REPO" && node_modules/.bin/esbuild "$WORK/paragraph-reader.ts" --bundle --platform=node \
  --format=esm --log-level=error --tsconfig="$REPO/tsconfig.json" \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$READER")
object_uri() { field "$(copy_run "$(read_request "$1")")" objectURI; }
paragraphs_on_copy() { node "$READER" paragraphs "$(object_uri "$1")" "$COPY"; }
blocks_on_copy() { node "$READER" blocks "$(object_uri "$1")" "$COPY"; }
# The first block whose text is exactly $2 in blocks JSON $1, as JSON ({} if none).
block_with_text() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const hit = (JSON.parse(s) || []).find((b) => b.text === process.argv[1]);
      process.stdout.write(JSON.stringify(hit || {}));
    });' "$2"
}
section_links_on_copy() { node "$READER" links "$(object_uri "$1")" "$COPY"; }
# JSON-encode one string field (plutil cannot emit a bare JSON string).
json_string() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) v = v[k];
      process.stdout.write(JSON.stringify(v));
    });' "$2"
}

writable() {
  local state
  state="$(copy_run "$(read_request "$1")" || true)"
  [ "$(field "$state" editable)" = "true" ] && [ "$(field "$state" sharedViaICloud)" = "false" ] &&
    [ "$(field "$state" deletedOrInTrash)" = "false" ]
}
recent_notes() {
  /usr/bin/sqlite3 "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT n
    JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
    WHERE n.ZIDENTIFIER IS NOT NULL AND n.ZFOLDER IS NOT NULL
      AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0 AND IFNULL(n.ZMARKEDFORDELETION,0)=0
    ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT $1;"
}

# 4a. Paragraph identifiers: mint one for a block whose ID is shared (a
#    recent writable note that has one, else the append note), or re-assign a
#    unique one, which must be a no-op.
PNOTE="$NOTE"
for CANDIDATE in $(recent_notes 80); do
  writable "$CANDIDATE" || continue
  if [ "$(field "$(paragraphs_on_copy "$CANDIDATE")" counts.shared)" -gt 0 ] 2>/dev/null; then
    PNOTE="$CANDIDATE"
    break
  fi
done
watch_live "$PNOTE"
PARAS="$(paragraphs_on_copy "$PNOTE")"
[ -z "$(field "$PARAS" error)" ] || fail "paragraph reader: $(field "$PARAS" error)"
PCOUNT="$(printf '%s' "$PARAS" | /usr/bin/plutil -extract paragraphs raw -o - - 2>/dev/null || echo 0)"
PI=""
for WANT in shared missing; do
  I=0
  while [ -z "$PI" ] && [ "$I" -lt "${PCOUNT:-0}" ]; do
    [ "$(field "$PARAS" "paragraphs.$I.paragraphIdStatus")" = "$WANT" ] && PI="$I"
    I=$((I + 1))
  done
done
EXPECT_UNCHANGED=""
if [ -z "$PI" ]; then
  PI=0
  EXPECT_UNCHANGED=1
fi
BLOCK="$(field "$PARAS" "paragraphs.$PI.blockIndex")"
echo "paragraphs: $PCOUNT (unique $(field "$PARAS" counts.unique), shared $(field "$PARAS" counts.shared), missing $(field "$PARAS" counts.missing)); target block $BLOCK status $(field "$PARAS" "paragraphs.$PI.paragraphIdStatus")"
REV="$(field "$(copy_run "$(read_request "$PNOTE")")" revision)"
set_paragraph_request() { # expectedText-json revision
  printf '{"protocol":1,"action":"set_paragraph_id","identifier":"%s","blockIndex":%s,"expectedText":%s,"ifRevision":"%s"}' \
    "$PNOTE" "$BLOCK" "$1" "$2"
}
OUT="$(copy_run "$(set_paragraph_request '"not the paragraph text"' "$REV")" || true)"
[ "$(field "$OUT" code)" = "paragraph_changed" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "wrong expectedText not refused: $(field "$OUT" code)"
echo "ok: wrong expectedText refused, committed=false"
SETP="$(set_paragraph_request "$(json_string "$PARAS" "paragraphs.$PI.text")" "$REV")"
OUT="$(copy_run "$SETP" || true)"
STATUS="$(field "$OUT" status)"
if [ -n "$EXPECT_UNCHANGED" ]; then
  [ "$STATUS" = "unchanged" ] || fail "unique paragraph re-assigned: $STATUS $(field "$OUT" code)"
  echo "ok: every paragraph already unique; set_paragraph_id was a no-op"
else
  [ "$STATUS" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "set_paragraph_id: $(field "$OUT" code) $(field "$OUT" message)"
  PID="$(field "$OUT" paragraphId)"
  AFTERP="$(paragraphs_on_copy "$PNOTE")"
  [ "$(field "$AFTERP" "paragraphs.$PI.paragraphId")" = "$PID" ] || fail "reader does not see the new identifier"
  [ "$(field "$AFTERP" "paragraphs.$PI.paragraphIdStatus")" = "unique" ] || fail "reader does not see it as unique"
  [ "$(field "$AFTERP" "paragraphs.$PI.url")" = "$(field "$OUT" url)" ] || fail "reader url differs from the writer's"
  echo "ok: paragraph identifier minted and verified; list-note-paragraphs reader agrees (unique $(field "$AFTERP" counts.unique))"
  OUT="$(copy_run "$SETP" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed set_paragraph_id not refused: $(field "$OUT" code)"
  echo "ok: replayed set_paragraph_id refused"
fi

# 4a1. Anchor heal: resolve-paragraph-anchor's remint through the writer
#    client (src/services/privateWriterReminter.ts). Records an anchor for a
#    paragraph whose ID is shared or missing (in the paragraph note or another
#    recent writable note), checks that it reports needs-reminting and, with
#    no reminter installed, writer-unavailable; then installs the writer
#    reminter and resolves with remint, which must mint a unique ID through
#    set_paragraph_id on the copy and resolve the anchor to it. The client runs
#    against a writer installed by `setup --native-writer` in the work
#    directory; the writer process itself never gets the write switch.
HNOTE=""
HBLOCK=""
for CANDIDATE in "$PNOTE" $(recent_notes 80); do
  writable "$CANDIDATE" || continue
  HPARAS="$(paragraphs_on_copy "$CANDIDATE")"
  HBLOCK="$(printf '%s' "$HPARAS" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const hit = (JSON.parse(s).paragraphs || []).find(
        (p) => p.paragraphIdStatus !== "unique" && p.text.replace(/￼/g, "").trim()
      );
      process.stdout.write(hit ? String(hit.blockIndex) : "");
    });')"
  if [ -n "$HBLOCK" ]; then
    HNOTE="$CANDIDATE"
    break
  fi
done
if [ -z "$HNOTE" ]; then
  echo "skipped: anchor heal (no paragraph with a shared or missing ID in the recent notes)"
else
  watch_live "$HNOTE"
  HEAL_INSTALL="$WORK/writer-install"
  APPLE_NOTES_MCP_PRIVATE_HELPER_DIR="$HEAL_INSTALL" node "$REPO/build/index.js" setup --native-writer \
    >"$WORK/heal-setup.log" 2>&1 || fail "setup --native-writer for the heal step failed: $(tail -3 "$WORK/heal-setup.log")"
  HEAL="$WORK/anchor-heal.mjs"
  cat >"$WORK/anchor-heal.ts" <<'TS'
import { spawnSync } from "node:child_process";
import { AnchorRegistry } from "@/services/anchorRegistry.js";
import { resolveStoredAnchor } from "@/services/paragraphAnchorOps.js";
import { defaultWriterDeps } from "@/services/privateWriter.js";
import { installWriterParagraphIdReminter } from "@/services/privateWriterReminter.js";
import { readNoteParagraphs } from "@/utils/noteParagraphs.js";
import { anchorFor, setParagraphIdReminter } from "@/utils/paragraphAnchors.js";
const [id, dbPath, block, registryPath, sourcePath] = process.argv.slice(2);
// The client's gates see both switches; the writer process gets neither the
// write switch nor anything but the copy.
const env = { ...process.env, APPLE_NOTES_MCP_ENABLE_PRIVATE: "1", APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1", APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };
const childEnv = { ...env };
delete childEnv.APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES;
const deps = () =>
  defaultWriterDeps({
    env,
    sourcePath,
    spawn: ((command: string, args: string[], options: object) =>
      spawnSync(command, args, { ...options, env: childEnv })) as typeof spawnSync,
  });
try {
  const note = readNoteParagraphs({ id }, { dbPath });
  const paragraph = note.paragraphs.find((p) => p.blockIndex === Number(block));
  if (!paragraph) throw new Error(`block ${block} not found`);
  const registry = new AnchorRegistry(registryPath);
  const [{ anchor }] = registry.record([anchorFor(note, paragraph, { anchorId: "", now: new Date() })]);
  setParagraphIdReminter(undefined);
  const before = await resolveStoredAnchor(anchor.anchorId, { registry, dbPath, remint: true });
  const installed = installWriterParagraphIdReminter(env, deps);
  const healed = await resolveStoredAnchor(anchor.anchorId, { registry, dbPath, remint: true });
  const after = readNoteParagraphs({ id }, { dbPath }).paragraphs.find(
    (p) => p.blockIndex === Number(block)
  );
  process.stdout.write(
    JSON.stringify({
      before: { status: before.status, remint: before.remint },
      installed,
      healed: { status: healed.status, url: healed.url ?? null, remint: healed.remint },
      reader: { paragraphId: after?.paragraphId ?? null, status: after?.paragraphIdStatus ?? null, url: after?.url ?? null },
    })
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error) }));
}
TS
  (cd "$REPO" && node_modules/.bin/esbuild "$WORK/anchor-heal.ts" --bundle --platform=node \
    --format=esm --log-level=error --tsconfig="$REPO/tsconfig.json" \
    "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --outfile="$HEAL")
  OUT="$(env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES APPLE_NOTES_MCP_PRIVATE_HELPER_DIR="$HEAL_INSTALL" \
    APPLE_NOTES_MCP_PRIVATE_STORE="$COPY" node "$HEAL" "$(object_uri "$HNOTE")" "$COPY" "$HBLOCK" \
    "$WORK/anchors.json" "$SOURCE")"
  [ -z "$(field "$OUT" error)" ] || fail "anchor heal: $(field "$OUT" error)"
  [ "$(field "$OUT" before.status)" = "needs-reminting" ] || fail "anchor did not need reminting: $(field "$OUT" before.status)"
  [ "$(field "$OUT" before.remint.reason)" = "writer-unavailable" ] ||
    fail "remint without a reminter: $(field "$OUT" before.remint.reason)"
  [ "$(field "$OUT" installed)" = "true" ] || fail "writer reminter not installed with both switches"
  [ "$(field "$OUT" healed.remint.attempted)" = "true" ] && [ -n "$(field "$OUT" healed.remint.paragraphId)" ] ||
    fail "remint failed: $(field "$OUT" healed.remint.reason) $(field "$OUT" healed.remint.message)"
  [ "$(field "$OUT" healed.status)" = "resolved" ] || fail "healed anchor did not resolve: $(field "$OUT" healed.status)"
  [ "$(field "$OUT" reader.paragraphId)" = "$(field "$OUT" healed.remint.paragraphId)" ] &&
    [ "$(field "$OUT" reader.status)" = "unique" ] || fail "reader does not see the re-minted identifier as unique"
  [ "$(field "$OUT" healed.url)" = "$(field "$OUT" reader.url)" ] || fail "healed url differs from the reader's"
  echo "ok: anchor heal: needs-reminting, writer-unavailable without a reminter, then re-minted through set_paragraph_id and resolved"
fi

# 4a2. Section-link chips (macOS 27). A chip within a note that has a heading,
#    a replacement below the title that clears it, and a chip from the append
#    note into that heading. Each is checked with the list-note-links
#    reader on the copy: one `section` link whose attachment, target note and
#    paragraph match the writer's result.
# The section link with this attachment identifier, as JSON ({} if none), and
# how many section links the reader lists.
section_link() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const links = JSON.parse(s).links || [];
      const hit = links.find((l) => (l.attachmentIdentifier || "").toUpperCase() === process.argv[1].toUpperCase());
      process.stdout.write(JSON.stringify(hit || {}));
    });' "$2"
}
section_count() { printf '%s' "$1" | /usr/bin/plutil -extract links raw -o - - 2>/dev/null || echo 0; }
check_chip() { # writer-output source-note
  local out="$1" links hit
  links="$(section_links_on_copy "$2")"
  hit="$(section_link "$links" "$(field "$out" inlineAttachmentIdentifier)")"
  [ "$(field "$hit" kind)" = "section" ] || fail "list-note-links does not list the chip as a section link"
  [ "$(field "$hit" inBody)" = "true" ] || fail "the chip's glyph is not in the body"
  [ "$(field "$hit" targetNote)" = "$(field "$out" target)" ] || fail "the chip targets another note"
  [ "$(field "$hit" paragraphId)" = "$(field "$out" paragraphId)" ] || fail "the chip targets another paragraph"
  [ "$(field "$hit" url)" = "$(field "$out" token)" ] || fail "the stored URL differs from the writer's token"
  TPARAS="$(paragraphs_on_copy "$(field "$out" target)")"
  grep -qF "\"url\":\"$(field "$out" url)\"" <<<"$TPARAS" ||
    fail "list-note-paragraphs does not link the target paragraph"
  LAST_SECTION_COUNT="$(section_count "$links")"
}
if [ "$(field "$(copy_run '{"protocol":1,"action":"probe"}')" features.addSectionLink.available)" != "true" ]; then
  echo "skip: section-link chips unavailable here (need macOS 27)"
else
  SNOTE=""
  for CANDIDATE in $(recent_notes 80); do
    [ "$CANDIDATE" != "$NOTE" ] || continue
    writable "$CANDIDATE" || continue
    if grep -Eq '"style":"(heading|subheading)"' <<<"$(paragraphs_on_copy "$CANDIDATE")"; then
      SNOTE="$CANDIDATE"
      break
    fi
  done
  # Without a heading in any recent note, link a paragraph of the step 6
  # note by blockIndex instead of the default first heading.
  SELECTOR=""
  if [ -z "$SNOTE" ] && [ "$PNOTE" != "$NOTE" ]; then
    SNOTE="$PNOTE"
    SPARAS="$(paragraphs_on_copy "$SNOTE")"
    # Prefer a paragraph whose identifier is shared, so the chip must mint one.
    SPI=0
    I=0
    while [ -n "$(field "$SPARAS" "paragraphs.$I.blockIndex")" ]; do
      if [ "$(field "$SPARAS" "paragraphs.$I.paragraphIdStatus")" = "shared" ]; then
        SPI="$I"
        break
      fi
      I=$((I + 1))
    done
    SELECTOR=",\"blockIndex\":$(field "$SPARAS" "paragraphs.$SPI.blockIndex"),\"expectedText\":$(json_string "$SPARAS" "paragraphs.$SPI.text")"
    echo "no heading in recent notes; linking block $(field "$SPARAS" "paragraphs.$SPI.blockIndex") of the step 6 note"
  fi
  if [ -z "$SNOTE" ]; then
    echo "skip: no second writable note for section-link chips in the copy"
  else
    watch_live "$SNOTE"
    chip_request() { # revision position clear
      printf '{"protocol":1,"action":"add_section_link","identifier":"%s","ifRevision":"%s","position":"%s","clearExistingSectionLinks":%s%s}' \
        "$SNOTE" "$1" "$2" "$3" "$SELECTOR"
    }
    SREV="$(field "$(copy_run "$(read_request "$SNOTE")")" revision)"
    OUT="$(copy_run "$(chip_request "$SREV" end false)" || true)"
    [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
      fail "add_section_link: $(field "$OUT" code) $(field "$OUT" message)"
    check_chip "$OUT" "$SNOTE"
    echo "ok: chip within a note added and verified (minted=$(field "$OUT" paragraphIdMinted), previous status $(field "$OUT" previousParagraphIdStatus)); reader lists $LAST_SECTION_COUNT section link(s)"
    OUT2="$(copy_run "$(chip_request "$(field "$OUT" revisionAfter)" belowTitle true)" || true)"
    [ "$(field "$OUT2" status)" = "updated" ] || fail "clear and re-add: $(field "$OUT2" code) $(field "$OUT2" message)"
    [ "$(field "$OUT2" clearedSectionLinks)" -ge 1 ] || fail "clearExistingSectionLinks cleared nothing"
    [ "$(field "$OUT2" paragraphIdMinted)" = "false" ] || fail "second chip minted again"
    check_chip "$OUT2" "$SNOTE"
    [ "$LAST_SECTION_COUNT" = "1" ] || fail "cleared section links are still listed ($LAST_SECTION_COUNT)"
    echo "ok: $(field "$OUT2" clearedSectionLinks) chip(s) cleared and one re-added below the title"
    OUT3="$(copy_run "$(chip_request "$SREV" end false)" || true)"
    [ "$(field "$OUT3" code)" = "revision_conflict" ] && [ "$(field "$OUT3" committed)" = "false" ] ||
      fail "stale add_section_link not refused: $(field "$OUT3" code)"
    echo "ok: stale add_section_link refused, committed=false"

    # A chip in the append note that opens the same heading in SNOTE.
    NREV="$(field "$(copy_run "$READ")" revision)"
    TREV="$(field "$(copy_run "$(read_request "$SNOTE")")" revision)"
    CROSS="{\"protocol\":1,\"action\":\"add_section_link\",\"identifier\":\"$NOTE\",\"target\":\"$SNOTE\",\"ifRevision\":\"$NREV\""
    OUT4="$(copy_run "$CROSS}" || true)"
    [ "$(field "$OUT4" code)" = "invalid_request" ] || fail "cross-note chip without ifTargetRevision not refused"
    OUT4="$(copy_run "$CROSS,\"paragraphId\":\"$(field "$OUT2" paragraphId)\",\"ifTargetRevision\":\"$TREV\"}" || true)"
    [ "$(field "$OUT4" status)" = "updated" ] && [ "$(field "$OUT4" selfLink)" = "false" ] ||
      fail "cross-note chip: $(field "$OUT4" code) $(field "$OUT4" message)"
    [ "$(field "$OUT4" targetRevisionAfter)" = "$TREV" ] || fail "an unminted target note changed"
    check_chip "$OUT4" "$NOTE"
    echo "ok: chip into another note added by paragraphId, target note unchanged"

    # A chip into another note's paragraph whose identifier is shared, so
    # the writer mints it in the target note within the same save.
    XPARAS="$(paragraphs_on_copy "$SNOTE")"
    XI=""
    I=0
    while [ -z "$XI" ] && [ -n "$(field "$XPARAS" "paragraphs.$I.blockIndex")" ]; do
      [ "$(field "$XPARAS" "paragraphs.$I.paragraphIdStatus")" = "shared" ] && XI="$I"
      I=$((I + 1))
    done
    if [ -z "$XI" ]; then
      echo "skip: no shared paragraph left for a minting cross-note chip"
    else
      NREV="$(field "$OUT4" revisionAfter)"
      TREV="$(field "$(copy_run "$(read_request "$SNOTE")")" revision)"
      OUT5="$(copy_run "{\"protocol\":1,\"action\":\"add_section_link\",\"identifier\":\"$NOTE\",\"target\":\"$SNOTE\",\"ifRevision\":\"$NREV\",\"ifTargetRevision\":\"$TREV\",\"blockIndex\":$(field "$XPARAS" "paragraphs.$XI.blockIndex"),\"expectedText\":$(json_string "$XPARAS" "paragraphs.$XI.text")}" || true)"
      [ "$(field "$OUT5" status)" = "updated" ] && [ "$(field "$OUT5" paragraphIdMinted)" = "true" ] ||
        fail "minting cross-note chip: $(field "$OUT5" code) $(field "$OUT5" message)"
      [ "$(field "$OUT5" targetRevisionAfter)" != "$TREV" ] || fail "the minted target note did not change"
      check_chip "$OUT5" "$NOTE"
      echo "ok: chip into another note minted the target paragraph's identifier ($LAST_SECTION_COUNT section links in the source)"
    fi
  fi
fi

# 4a3. Two chips on the last two lines of the append note, then one more that
#    clears every chip: the removal ranges of the two end lines overlap and
#    must be merged. Self-links to the note's first non-empty paragraph by
#    blockIndex, which the chips at the end never move.
if [ "$(field "$(copy_run '{"protocol":1,"action":"probe"}')" features.addSectionLink.available)" != "true" ]; then
  echo "skip: two chips at the end (section-link chips need macOS 27)"
else
  EPARAS="$(paragraphs_on_copy "$NOTE")"
  EI=0
  while [ -n "$(field "$EPARAS" "paragraphs.$EI.blockIndex")" ] && [ -z "$(field "$EPARAS" "paragraphs.$EI.text")" ]; do
    EI=$((EI + 1))
  done
  end_chip() { # revision clear
    printf '{"protocol":1,"action":"add_section_link","identifier":"%s","ifRevision":"%s","position":"end","clearExistingSectionLinks":%s,"blockIndex":%s,"expectedText":%s}' \
      "$NOTE" "$1" "$2" "$(field "$EPARAS" "paragraphs.$EI.blockIndex")" "$(json_string "$EPARAS" "paragraphs.$EI.text")"
  }
  E1="$(copy_run "$(end_chip "$(field "$(copy_run "$READ")" revision)" false)" || true)"
  [ "$(field "$E1" status)" = "updated" ] || fail "first end chip: $(field "$E1" code) $(field "$E1" message)"
  E2="$(copy_run "$(end_chip "$(field "$E1" revisionAfter)" false)" || true)"
  [ "$(field "$E2" status)" = "updated" ] || fail "second end chip: $(field "$E2" code) $(field "$E2" message)"
  E3="$(copy_run "$(end_chip "$(field "$E2" revisionAfter)" true)" || true)"
  [ "$(field "$E3" status)" = "updated" ] && [ "$(field "$E3" verified)" = "true" ] ||
    fail "clearing two chips at the end: $(field "$E3" code) $(field "$E3" message)"
  [ "$(field "$E3" clearedSectionLinks)" -ge 2 ] || fail "cleared $(field "$E3" clearedSectionLinks) chips, expected at least 2"
  check_chip "$E3" "$NOTE"
  [ "$LAST_SECTION_COUNT" = "1" ] || fail "cleared end chips are still listed ($LAST_SECTION_COUNT)"
  echo "ok: two chips on the last lines cleared together ($(field "$E3" clearedSectionLinks) cleared); one chip remains"
fi

# 4b. plan_edit / edit_note on the copy, checked by an independent decoder
# (scripts/check-edit-preservation.mjs decodes the stored protobuf itself, with
# no writer and no NotesShared). Each note gets a content-free round trip:
# insert styled blocks after the first body paragraph, restyle one of them,
# then delete them all. Every step must keep each character outside the edited
# ranges on its exact serialized attribute run and leave attachment rows and
# every other row byte-identical; the last step must restore the note exactly.
# Every plan must leave the store unchanged.
CHECK="$REPO/scripts/check-edit-preservation.mjs"
edit_request() { # action identifier ifRevision(or empty) operations-json [extra fields, leading comma]
  if [ -n "$3" ]; then
    printf '{"protocol":1,"action":"%s","identifier":"%s","ifRevision":"%s","operations":%s%s}' \
      "$1" "$2" "$3" "$4" "${5:-}"
  else
    printf '{"protocol":1,"action":"%s","identifier":"%s","operations":%s%s}' "$1" "$2" "$4" "${5:-}"
  fi
}
# A copy-store run with the writer's copy-only fault injection switched on.
fault_run() { # fault request
  printf '%s' "$2" | env -u APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES APPLE_NOTES_MCP_PRIVATE_STORE="$COPY" \
    APPLE_NOTES_MCP_PRIVATE_TEST_FAULT="$1" "$HELPER" 2>/dev/null
}
snap() { node "$CHECK" snapshot "$COPY" "$1" "$WORK/$2.json" >/dev/null; }
edit_step() { # uuid label operations-json
  snap "$1" before
  PLAN="$(copy_run "$(edit_request plan_edit "$1" "" "$3")" || true)"
  [ "$(field "$PLAN" status)" = "planned" ] || fail "$2 plan: $(field "$PLAN" code) $(field "$PLAN" message)"
  snap "$1" planned
  node "$CHECK" same "$WORK/before.json" "$WORK/planned.json" >/dev/null || fail "$2: plan_edit changed the store"
  OUT="$(copy_run "$(edit_request edit_note "$1" "$(field "$PLAN" revisionBefore)" "$3" \
    ",\"ifPlanDigest\":\"$(field "$PLAN" planDigest)\"")" || true)"
  [ "$(field "$OUT" status)" = "updated" ] || fail "$2 apply: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" verified)" = "true" ] || fail "$2 apply not verified"
  [ "$(field "$OUT" preservation.formattingOutsideEditsVerified)" = "true" ] || fail "$2: no preservation report"
  [ "$(field "$OUT" planDigest)" = "$(field "$PLAN" planDigest)" ] || fail "$2: apply planned differently"
  printf '%s' "$OUT" >"$WORK/response.json"
  snap "$1" after
  node "$CHECK" compare "$WORK/before.json" "$WORK/after.json" "$WORK/response.json" ||
    fail "$2: independent preservation check failed"
  echo "ok: $2 ($(field "$OUT" targetCount) targets, $(field "$OUT" preservation.unchangedUTF16) units kept, $(field "$OUT" preservation.attachmentGlyphs) glyphs; writer verified; independent check passed)"
}

EDIT_NOTES="${EDIT_NOTES:-}"
if [ -z "$EDIT_NOTES" ]; then
  editable() {
    local state
    state="$(copy_run "$(read_request "$1")" || true)"
    [ "$(field "$state" editable)" = "true" ] && [ "$(field "$state" sharedViaICloud)" = "false" ] &&
      [ "$(field "$state" deletedOrInTrash)" = "false" ] && [ "$(field "$state" passwordProtected)" = "false" ]
  }
  pick() { # "" or "NOT" (owns attachments or not), how many
    local found=0 candidate
    for candidate in $(/usr/bin/sqlite3 -readonly "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT n
      JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
      WHERE n.ZIDENTIFIER IS NOT NULL AND n.ZFOLDER IS NOT NULL
        AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0 AND IFNULL(n.ZMARKEDFORDELETION,0)=0
        AND $1 EXISTS (SELECT 1 FROM ZICCLOUDSYNCINGOBJECT a WHERE a.ZNOTE = n.Z_PK)
      ORDER BY n.ZMODIFICATIONDATE1 DESC LIMIT 60;"); do
      [ "$found" -lt "$2" ] || break
      if editable "$candidate"; then
        EDIT_NOTES="$EDIT_NOTES $candidate"
        found=$((found + 1))
      fi
    done
  }
  pick "" "${EDIT_SAMPLE:-5}"
  pick "NOT" 3
fi
[ -n "$EDIT_NOTES" ] || fail "no editable candidate notes for edit_note"

MARK_OPS='[{"op":"insert_after","anchor":{"kind":"style","style":"body","occurrence":1},"expectedCount":COUNT,"blocks":[{"type":"heading","text":"copy-store edit marker"},{"type":"checklist","text":"copy-store checklist","checked":true},{"type":"body","runs":[{"text":"copy-store "},{"text":"bold","bold":true}]}]}]'
RESTYLE_OPS='[{"op":"replace","selector":{"kind":"text","text":"copy-store edit marker","match":"equals"},"replacement":{"runs":[{"text":"copy-store edit marker 2","italic":true}]}}]'
DELETE_OPS='[{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store edit marker 2"}},{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store checklist"}},{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store bold"}}]'
CAPTION_OPS='[{"op":"replace","selector":{"kind":"attachment","ordinal":1,"position":"after"},"replacement":{"text":" copy-store attachment caption"}}]'
UNCAPTION_OPS='[{"op":"replace","selector":{"kind":"text","text":" copy-store attachment caption","scope":"all"},"replacement":{"text":""}}]'
ATTACHMENT_ANCHOR_OPS='[{"op":"insert_after","anchor":{"kind":"attachment","ordinal":1},"blocks":[{"type":"body","text":"copy-store attachment anchor"}]}]'
ATTACHMENT_ANCHOR_UNDO_OPS='[{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store attachment anchor"}}]'
REMOVE_ATTACHMENT_OPS='[{"op":"replace","selector":{"kind":"attachment","ordinal":1},"replacement":{"text":""}}]'
ATTACHMENT_EDITED=0
TRIM_MARK_OPS='[{"op":"insert_after","anchor":{"kind":"style","style":"body","occurrence":1},"expectedCount":COUNT,"blocks":[{"type":"body","text":"copy-store trim start"},{"type":"body","text":""},{"type":"body","text":" "},{"type":"body","text":""},{"type":"body","text":"copy-store trim end"}]}]'
TRIM_AROUND_OPS='[{"op":"trim_blank_lines","mode":"around","anchor":{"kind":"text","text":"copy-store trim start"},"side":"after","expectedCount":3}]'
TRIM_UNMARK_OPS='[{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store trim start"}},{"op":"delete_paragraph","selector":{"kind":"text","text":"copy-store trim end"}}]'
TRIM_RUNS_OPS='[{"op":"trim_blank_lines","mode":"runs"}]'
RICH_MARK_OPS='[{"op":"insert_after","anchor":{"kind":"style","style":"body","occurrence":1},"expectedCount":COUNT,"blocks":[{"type":"body","text":"copy-store rich"},{"type":"checklist","text":"copy-store item 1","checked":true},{"type":"checklist","text":"copy-store item 2","checked":false},{"type":"body","text":"copy-store rich end"}]}]'
RICH_RUN_OPS='[{"op":"append_to_paragraph","anchor":{"text":"copy-store rich"},"runs":[{"text":" "},{"text":"copy-store link","link":"https://example.com/copy-store","highlight":"mint","color":"#FF0000","bold":true}]},{"op":"replace","selector":{"text":"copy-store rich end","match":"equals"},"replacement":{"runs":[{"text":"copy-store rich end","link":"mailto:copy-store@example.com","italic":true}]}}]'
RICH_CHECKLIST_OPS='[{"op":"replace_checklist","containing":"copy-store item 1","expectedCount":2,"items":[{"text":"copy-store new 1","checked":false},{"text":"copy-store new 2","checked":true,"indent":1},{"runs":[{"text":"copy-store new 3"}],"checked":false}]}]'
RICH_TAMPER_OPS='[{"op":"replace","selector":{"text":"copy-store new 1","match":"equals"},"replacement":{"text":"copy-store new 1b"}}]'
RICH_UNMARK_OPS='[{"op":"delete_paragraph","selector":{"text":"copy-store rich copy-store link"}},{"op":"delete_paragraph","selector":{"text":"copy-store new 1b"}},{"op":"delete_paragraph","selector":{"text":"copy-store new 2"}},{"op":"delete_paragraph","selector":{"text":"copy-store new 3"}},{"op":"delete_paragraph","selector":{"text":"copy-store rich end"}}]'
RICH_DONE=0
FILE_REPLACED=0
# A small PNG from the system to stand in for a new chart.
REPLACEMENT_FILE="$WORK/copy-store-source.png"
cp /System/Library/CoreServices/Dock.app/Contents/Resources/pileArrow@2x.png "$REPLACEMENT_FILE"
REPLACEMENT_SHA="$(/usr/bin/shasum -a 256 "$REPLACEMENT_FILE" | cut -d' ' -f1)"
TRIMMED=0
EDITED=0
REFUSED_NOTES=0
EDIT_LIVE_BEFORE=""
for EDIT_NOTE in $EDIT_NOTES; do
  EDIT_LIVE_BEFORE="$EDIT_LIVE_BEFORE $EDIT_NOTE=$(field "$(run "$(read_request "$EDIT_NOTE")")" revision)"
  # Guard rails: the live store is gated, a missing ifRevision is refused, a
  # stale one is a conflict, and none of them commit.
  OUT="$(run "$(edit_request edit_note "$EDIT_NOTE" "$ZERO" "$RESTYLE_OPS")" || true)"
  [ "$(field "$OUT" code)" = "writes_disabled" ] || fail "live edit_note not gated: $(field "$OUT" code)"
  OUT="$(copy_run "$(edit_request edit_note "$EDIT_NOTE" "" "$RESTYLE_OPS")" || true)"
  [ "$(field "$OUT" code)" = "invalid_request" ] || fail "edit_note without ifRevision was not refused"
  OUT="$(copy_run "$(edit_request edit_note "$EDIT_NOTE" "$ZERO" "$RESTYLE_OPS")" || true)"
  if [ "$(field "$OUT" code)" != "revision_conflict" ] || [ "$(field "$OUT" committed)" != "false" ]; then
    fail "stale edit ifRevision not refused: $(field "$OUT" code)"
  fi
  # How many body paragraphs the style anchor sees (a count mismatch reports it).
  PROBE="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "${MARK_OPS/COUNT/1000}")" || true)"
  COUNT="$(field "$PROBE" matchedCount)"
  [ "$(field "$PROBE" status)" = "planned" ] && COUNT=1000
  if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
    echo "skip: a candidate has no body paragraph to anchor on ($(field "$PROBE" code))"
    continue
  fi
  # A note whose edit would dirty another object (for example Notes
  # re-deriving the title from an attachment) must be refused at the plan.
  PROBE="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "${MARK_OPS/COUNT/$COUNT}")" || true)"
  if [ "$(field "$PROBE" code)" = "unexpected_side_effect" ]; then
    REFUSED_NOTES=$((REFUSED_NOTES + 1))
    echo "ok: plan refused a note whose edit would change another object"
    continue
  fi
  snap "$EDIT_NOTE" original
  edit_step "$EDIT_NOTE" "insert blocks" "${MARK_OPS/COUNT/$COUNT}"
  edit_step "$EDIT_NOTE" "restyle inserted text" "$RESTYLE_OPS"
  edit_step "$EDIT_NOTE" "delete inserted paragraphs" "$DELETE_OPS"
  snap "$EDIT_NOTE" final
  node "$CHECK" same "$WORK/original.json" "$WORK/final.json" >/dev/null ||
    fail "the round trip did not restore the original text and runs"
  EDITED=$((EDITED + 1))

  # 4c. trim_blank_lines: insert a marker, three empty body paragraphs (one
  # holding a space), and a second marker; trim the blank run after
  # the first marker (exactly 3 removed); delete the markers. The note must
  # be restored exactly. Then trim the note's own runs of blank lines on the
  # copy (not undoable, so it runs last); the plan must list each removed
  # paragraph, and the independent check proves nothing else changed.
  snap "$EDIT_NOTE" original
  edit_step "$EDIT_NOTE" "insert blank lines between markers" "${TRIM_MARK_OPS/COUNT/$COUNT}"
  edit_step "$EDIT_NOTE" "trim the blank lines after a marker" "$TRIM_AROUND_OPS"
  [ "$(field "$OUT" operations.0.matchedCount)" = "3" ] || fail "trim around removed $(field "$OUT" operations.0.matchedCount), not 3"
  [ "$(field "$OUT" operations.0.targets.1.blankUTF16)" = "1" ] || fail "trim did not report the whitespace paragraph"
  edit_step "$EDIT_NOTE" "delete the trim markers" "$TRIM_UNMARK_OPS"
  snap "$EDIT_NOTE" final
  node "$CHECK" same "$WORK/original.json" "$WORK/final.json" >/dev/null ||
    fail "the trim round trip did not restore the original text and runs"
  PLAN="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$TRIM_RUNS_OPS")" || true)"
  [ "$(field "$PLAN" status)" = "planned" ] || fail "trim runs plan: $(field "$PLAN" code) $(field "$PLAN" message)"
  if [ "$(field "$PLAN" targetCount)" != "0" ]; then
    edit_step "$EDIT_NOTE" "trim the note's own blank runs" "$TRIM_RUNS_OPS"
    [ "$(field "$OUT" targetCount)" = "$(field "$PLAN" targetCount)" ] || fail "trim runs removed a different number than planned"
  else
    echo "ok: no redundant blank lines to trim in this note"
  fi
  TRIMMED=$((TRIMMED + 1))

  # 4c2. Rich runs, an inline link at the end of a paragraph, checklist
  # replacement, verification of a changed stored field, and deleting the
  # last paragraph (first note only). Insert a marker paragraph, two
  # checklist rows, and an end marker; append a formatted link to the marker
  # and relink the end marker; replace the two rows with three new ones;
  # prove the read-back catches a toggled todo; delete everything inserted,
  # which must restore the note exactly. Each step is checked by the
  # independent decoder, and the stored run attributes by the get-note-blocks
  # reader.
  if [ "$RICH_DONE" = "0" ]; then
    snap "$EDIT_NOTE" original
    edit_step "$EDIT_NOTE" "insert rich markers" "${RICH_MARK_OPS/COUNT/$COUNT}"
    edit_step "$EDIT_NOTE" "append a formatted link and relink a paragraph" "$RICH_RUN_OPS"
    RBLOCKS="$(blocks_on_copy "$EDIT_NOTE")"
    LINKED="$(block_with_text "$RBLOCKS" "copy-store rich copy-store link")"
    [ "$(field "$LINKED" runs.1.text)" = "copy-store link" ] || fail "the appended run is not its own run"
    [ "$(field "$LINKED" runs.1.link)" = "https://example.com/copy-store" ] || fail "the appended link did not persist"
    [ "$(field "$LINKED" runs.1.highlight)" = "mint" ] || fail "the appended highlight did not persist"
    [ "$(field "$LINKED" runs.1.color)" = "#FF0000" ] || fail "the appended color did not persist"
    [ "$(field "$LINKED" runs.1.bold)" = "true" ] || fail "the appended bold did not persist"
    [ -z "$(field "$LINKED" runs.0.link)" ] || fail "the paragraph's own text became linked"
    ENDED="$(block_with_text "$RBLOCKS" "copy-store rich end")"
    [ "$(field "$ENDED" runs.0.link)" = "mailto:copy-store@example.com" ] || fail "the replacement link did not persist"
    [ "$(field "$ENDED" runs.0.italic)" = "true" ] || fail "the replacement italic did not persist"
    echo "   get-note-blocks reader sees the link, highlight, color, and bold runs"
    edit_step "$EDIT_NOTE" "replace a checklist block" "$RICH_CHECKLIST_OPS"
    [ "$(field "$OUT" operations.0.matchedCount)" = "2" ] || fail "replace_checklist replaced $(field "$OUT" operations.0.matchedCount) rows, not 2"
    [ "$(field "$OUT" operations.0.removedItems.0.checked)" = "true" ] || fail "replace_checklist did not report the old done state"
    RBLOCKS="$(blocks_on_copy "$EDIT_NOTE")"
    for WANT in "copy-store new 1:false:0" "copy-store new 2:true:1" "copy-store new 3:false:0"; do
      ROW="$(block_with_text "$RBLOCKS" "${WANT%%:*}")"
      REST="${WANT#*:}"
      [ "$(field "$ROW" style)" = "checklist" ] || fail "${WANT%%:*} is not a checklist row"
      [ "$(field "$ROW" checklist.done)" = "${REST%%:*}" ] || fail "${WANT%%:*} has the wrong done state"
      [ "$(field "$ROW" indent)" = "${REST#*:}" ] || fail "${WANT%%:*} has the wrong indent"
    done
    [ "$(block_with_text "$RBLOCKS" "copy-store item 1")" = "{}" ] || fail "an old checklist row is still there"
    echo "   get-note-blocks reader sees the three new rows with their done states and indent"
    # The writer's read-back must catch a stored field changed outside the
    # edit (a toggled checklist todo, injected into the read-back on the copy).
    snap "$EDIT_NOTE" before
    PLAN="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$RICH_TAMPER_OPS")" || true)"
    OUT="$(fault_run tamper_todo "$(edit_request edit_note "$EDIT_NOTE" "$(field "$PLAN" revisionBefore)" "$RICH_TAMPER_OPS")" || true)"
    [ "$(field "$OUT" code)" = "verification_failed" ] && [ "$(field "$OUT" committed)" = "true" ] ||
      fail "a toggled todo outside the edit was not caught: $(field "$OUT" code) $(field "$OUT" message)"
    echo "ok: the read-back catches a checklist todo toggled outside the edited ranges ($(field "$OUT" message))"
    # ifPlanDigest: the digest of the same operations planned with
    # requireNonSystemPaper is refused, nothing saved.
    OTHER="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$RICH_UNMARK_OPS" ',"requireNonSystemPaper":true')" || true)"
    [ -n "$(field "$OTHER" planDigest)" ] || fail "second plan: $(field "$OTHER" code) $(field "$OTHER" message)"
    PLAN="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$RICH_UNMARK_OPS")" || true)"
    OUT="$(copy_run "$(edit_request edit_note "$EDIT_NOTE" "$(field "$PLAN" revisionBefore)" "$RICH_UNMARK_OPS" \
      ",\"ifPlanDigest\":\"$(field "$OTHER" planDigest)\"")" || true)"
    [ "$(field "$OUT" code)" = "plan_mismatch" ] && [ "$(field "$OUT" committed)" = "false" ] ||
      fail "a mismatched ifPlanDigest was not refused: $(field "$OUT" code)"
    echo "ok: a mismatched ifPlanDigest is refused, committed=false"
    edit_step "$EDIT_NOTE" "delete the rich markers" "$RICH_UNMARK_OPS"
    snap "$EDIT_NOTE" final
    node "$CHECK" same "$WORK/original.json" "$WORK/final.json" >/dev/null ||
      fail "the rich round trip did not restore the original text and runs"

    # Deleting two equal paragraphs that end the note: one operation, one
    # merged target, and the paragraph before them keeps its line break.
    LASTTEXT="$(printf '%s' "$(paragraphs_on_copy "$EDIT_NOTE")" | node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        const list = JSON.parse(s).paragraphs || [];
        const last = list[list.length - 1];
        const same = list.filter((p) => p.text === (last && last.text)).length;
        process.stdout.write(last && last.text && same === 1 && !/[\u0000-\u001f"\\\\]/.test(last.text) ? last.text : "");
      });')"
    if [ -n "$LASTTEXT" ]; then
      TAIL_OPS="[{\"op\":\"insert_after\",\"anchor\":{\"text\":$(printf '%s' "$LASTTEXT" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>process.stdout.write(JSON.stringify(s)))'),\"scope\":\"all\"},\"blocks\":[{\"type\":\"body\",\"text\":\"copy-store tail\"},{\"type\":\"body\",\"text\":\"copy-store tail\"}]}]"
      edit_step "$EDIT_NOTE" "insert two last paragraphs" "$TAIL_OPS"
      edit_step "$EDIT_NOTE" "delete the two last paragraphs in one operation" \
        '[{"op":"delete_paragraph","selector":{"text":"copy-store tail"},"expectedCount":2}]'
      [ "$(field "$OUT" operations.0.matchedCount)" = "2" ] && [ "$(field "$OUT" targetCount)" = "1" ] ||
        fail "the two deleted paragraphs were not merged into one target"
      echo "   two adjacent deleted paragraphs, the last one unterminated, merged into one target"
    else
      echo "note: the last paragraph is empty or not unique; last-paragraph deletion not exercised on this note"
    fi
    RICH_DONE=1
  fi

  # 4d. Attachment selectors on notes whose body holds an attachment: add a
  # caption inline after the first attachment and remove it, insert and
  # delete a paragraph anchored on it (both must restore the note exactly),
  # then remove the attachment from the body. The removal cannot be undone,
  # so it runs last, on the copy only; the independent check proves every
  # other attachment row and every other row unchanged.
  PROBE="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$CAPTION_OPS")" || true)"
  if [ "$(field "$PROBE" code)" = "match_count_mismatch" ]; then
    continue
  elif [ "$(field "$PROBE" code)" = "unexpected_side_effect" ]; then
    echo "ok: plan refused an attachment edit that would change another object"
    continue
  fi
  [ "$(field "$PROBE" status)" = "planned" ] || fail "attachment plan: $(field "$PROBE" code) $(field "$PROBE" message)"
  snap "$EDIT_NOTE" original
  edit_step "$EDIT_NOTE" "caption beside an attachment" "$CAPTION_OPS"
  edit_step "$EDIT_NOTE" "remove the caption" "$UNCAPTION_OPS"
  edit_step "$EDIT_NOTE" "insert after an attachment's paragraph" "$ATTACHMENT_ANCHOR_OPS"
  edit_step "$EDIT_NOTE" "delete the inserted paragraph" "$ATTACHMENT_ANCHOR_UNDO_OPS"
  snap "$EDIT_NOTE" final
  node "$CHECK" same "$WORK/original.json" "$WORK/final.json" >/dev/null ||
    fail "the attachment round trip did not restore the original text and runs"
  # The read-back must catch an attachment glyph re-pointed outside the
  # edit (injected into the read-back on the copy); the caption it commits
  # is then removed again.
  PLAN="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$CAPTION_OPS")" || true)"
  OUT="$(fault_run tamper_attachment "$(edit_request edit_note "$EDIT_NOTE" "$(field "$PLAN" revisionBefore)" "$CAPTION_OPS")" || true)"
  [ "$(field "$OUT" code)" = "verification_failed" ] && [ "$(field "$OUT" committed)" = "true" ] ||
    fail "a re-pointed attachment glyph was not caught: $(field "$OUT" code) $(field "$OUT" message)"
  echo "ok: the read-back catches an attachment glyph re-pointed outside the edited ranges"
  edit_step "$EDIT_NOTE" "remove the caption again" "$UNCAPTION_OPS"
  # Replace the first attachment with a new image file in one save. A
  # failure injected just before the save must leave the store and the
  # media folder untouched; the real apply is then checked by the
  # independent decoder (the new attachment and media rows are the only new
  # rows) and by the media file's bytes.
  # The first of the note's first five attachments that is a file (image,
  # PDF, or other file); tables, drawings, and cards are refused.
  PLAN=""
  for ORDINAL in 1 2 3 4 5; do
    FILE_OPS="$(printf '[{"op":"replace","selector":{"kind":"attachment","ordinal":%s},"replacement":{"file":"%s","filename":"copy-store-chart.png"}}]' "$ORDINAL" "$REPLACEMENT_FILE")"
    PLAN="$(copy_run "$(edit_request plan_edit "$EDIT_NOTE" "" "$FILE_OPS")" || true)"
    [ "$(field "$PLAN" code)" = "unsupported_attachment" ] || break
  done
  if [ "$(field "$PLAN" code)" = "unsupported_attachment" ] || [ "$(field "$PLAN" code)" = "match_count_mismatch" ]; then
    echo "note: no file attachment among the first five; file replacement not exercised on this note"
  else
    [ "$(field "$PLAN" status)" = "planned" ] || fail "file replacement plan: $(field "$PLAN" code) $(field "$PLAN" message)"
    [ "$(field "$PLAN" replacementFiles.0.sha256)" = "$REPLACEMENT_SHA" ] || fail "the plan hashed another file"
    snap "$EDIT_NOTE" before
    MEDIA_BEFORE="$(find "$WORK" -name copy-store-chart.png | wc -l | tr -d ' ')"
    OUT="$(fault_run fail_before_save "$(edit_request edit_note "$EDIT_NOTE" "$(field "$PLAN" revisionBefore)" "$FILE_OPS")" || true)"
    [ "$(field "$OUT" code)" = "test_fault" ] && [ "$(field "$OUT" committed)" = "false" ] ||
      fail "injected failure: $(field "$OUT" code) $(field "$OUT" message)"
    snap "$EDIT_NOTE" after
    node "$CHECK" same "$WORK/before.json" "$WORK/after.json" >/dev/null ||
      fail "a failed file replacement left rows behind"
    [ "$(find "$WORK" -name copy-store-chart.png | wc -l | tr -d ' ')" = "$MEDIA_BEFORE" ] ||
      fail "a failed file replacement left its media file"
    echo "ok: a file replacement that fails before the save leaves no row and no media file"
    edit_step "$EDIT_NOTE" "replace an attachment with a file" "$FILE_OPS"
    [ -n "$(field "$OUT" replacementFiles.0.attachmentIdentifier)" ] || fail "file replacement reported no new attachment"
    [ "$(field "$OUT" preservation.replacementFilesVerified)" = "1" ] || fail "file replacement was not verified"
    [ "$(find "$WORK" -name copy-store-chart.png | wc -l | tr -d ' ')" = "$((MEDIA_BEFORE + 1))" ] ||
      fail "the file replacement did not write exactly one media file"
    while IFS= read -r STORED; do
      [ "$(/usr/bin/shasum -a 256 "$STORED" | cut -d' ' -f1)" = "$REPLACEMENT_SHA" ] ||
        fail "the new attachment's media file does not hold the source bytes"
    done < <(find "$WORK" -name copy-store-chart.png)
    echo "   new attachment $(field "$OUT" replacementFiles.0.uti), media file beside the copy with the source bytes"
    FILE_REPLACED=$((FILE_REPLACED + 1))
  fi
  edit_step "$EDIT_NOTE" "remove an attachment from the body" "$REMOVE_ATTACHMENT_OPS"
  [ "$(field "$OUT" removedAttachments.0)" != "" ] || fail "attachment removal reported no removed attachment"
  [ "$(field "$OUT" preservation.removedAttachments.0.identifier)" = "$(field "$OUT" removedAttachments.0)" ] ||
    fail "attachment removal did not report the removed row's state"
  echo "   removed attachment row: stillInNote=$(field "$OUT" preservation.removedAttachments.0.rowStillInNote) markedForDeletion=$(field "$OUT" preservation.removedAttachments.0.markedForDeletion) changedBeforeSave=$(json_field "$OUT" removedAttachmentRowChanges)"
  ATTACHMENT_EDITED=$((ATTACHMENT_EDITED + 1))
done
[ "$EDITED" -gt 0 ] || fail "the edit_note round trip ran on no note"
echo "ok: edit_note round trip restored $EDITED note(s) exactly; $REFUSED_NOTES refused at plan"
[ "$ATTACHMENT_EDITED" -gt 0 ] || fail "the attachment selector steps ran on no note (EDIT_NOTES needs a note with an attachment in its body)"
echo "ok: attachment selector steps passed on $ATTACHMENT_EDITED note(s)"
echo "ok: trim_blank_lines steps passed on $TRIMMED note(s)"
[ "$RICH_DONE" = "1" ] || fail "the rich-run and checklist steps ran on no note"
[ "$FILE_REPLACED" -gt 0 ] || fail "file replacement ran on no note (EDIT_NOTES needs a note whose first attachment is an image, PDF, or file)"
echo "ok: rich runs, inline link, checklist replacement, and file replacement ($FILE_REPLACED note(s)) passed"

# 4e. Structured compose: plan, guarded apply with verified read-back, replay,
#     prepend below the title, and insertion before an exact heading.
PARAS='[{"style":"heading","runs":[{"text":"Compose check"}]},
{"style":"body","runs":[{"text":"b","bold":true},{"text":"i","italic":true},{"text":"u","underline":true},{"text":"s","strikethrough":true},{"text":"l","link":"https://example.com/"},{"text":"h","highlight":"mint"},{"text":"c","color":"#FF0000"}]},
{"style":"body","blockQuote":true,"runs":[{"text":"quote"}]},
{"style":"monospaced","runs":[{"text":"code"}]},{"style":"monospaced","runs":[]},{"style":"monospaced","runs":[{"text":"\tmore"}]},
{"style":"bulleted","runs":[{"text":"b1"}]},{"style":"bulleted","indent":1,"runs":[{"text":"b1.1"}]},
{"style":"dashed","runs":[{"text":"d"}]},{"style":"numbered","runs":[{"text":"n"}]},
{"style":"checklist","checked":true,"runs":[{"text":"done"}]},{"style":"checklist","checked":false,"indent":1,"runs":[{"text":"open"}]},
{"style":"subheading","runs":[{"text":"end"}]}]'
compose_req() { # mode, extra JSON fields (leading comma)
  printf '{"protocol":1,"action":"compose_note","identifier":"%s","mode":"%s","paragraphs":%s%s}' \
    "$NOTE" "$1" "$PARAS" "$2"
}
GATED="$(run "$(compose_req append ",\"ifRevision\":\"$ZERO\"")" || true)"
[ "$(field "$GATED" code)" = "writes_disabled" ] && [ "$(field "$GATED" committed)" = "false" ] ||
  fail "live compose not gated: $(field "$GATED" code)"
echo "ok: live compose refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"
PLAN="$(copy_run "$(compose_req append ',"dryRun":true')" || true)"
[ "$(field "$PLAN" status)" = "planned" ] || fail "compose plan failed: $(field "$PLAN" code) $(field "$PLAN" message)"
[ "$(field "$PLAN" committed)" = "false" ] || fail "compose plan reported committed"
CREV="$(field "$PLAN" revisionBefore)"
[ "$CREV" = "$(field "$(copy_run "$READ")" revision)" ] || fail "plan revision differs from note state"
echo "ok: compose dry run planned $(field "$PLAN" paragraphs) paragraphs, nothing written"
OUT="$(copy_run "$(compose_req append ",\"ifRevision\":\"$ZERO\"")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "stale compose revision not refused"
OUT="$(copy_run "$(compose_req append ",\"ifRevision\":\"$CREV\"")" || true)"
[ "$(field "$OUT" status)" = "updated" ] || fail "compose failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" verified)" = "true" ] || fail "compose not verified"
[ "$(field "$OUT" storeKind)" = "copy" ] || fail "compose did not report the copy store"
[ "$(field "$OUT" readBack)" = "13" ] || fail "compose read back $(field "$OUT" readBack) paragraphs, expected 13"
[ "$(field "$OUT" readBack.10.checked)" = "true" ] && [ "$(field "$OUT" readBack.11.checked)" = "false" ] ||
  fail "checklist state did not persist"
[ "$(field "$OUT" readBack.1.runs.6.attributes.color)" = "#FF0000" ] || fail "run color did not persist"
[ "$(field "$OUT" unitStart)" = "$(field "$PLAN" unitStart)" ] || fail "unitStart differs between plan and apply"
[ -n "$(field "$OUT" objectURI)" ] || fail "compose did not report objectURI"
[ "$(field "$OUT" pushScheduled)" = "false" ] || fail "compose reported a scheduled push"
echo "ok: compose applied; 13 paragraphs verified (styles, indent, quote, checklist state, runs); unitStart $(field "$OUT" unitStart)"
OUT="$(copy_run "$(compose_req append ",\"ifRevision\":\"$CREV\"")" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "replayed compose not refused"
echo "ok: stale and replayed compose refused, committed=false"
PREV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "$(compose_req prepend ",\"ifRevision\":\"$PREV\"")" || true)"
[ "$(field "$OUT" verified)" = "true" ] || fail "prepend failed: $(field "$OUT" code) $(field "$OUT" message)"
echo "ok: prepend verified at UTF-16 offset $(field "$OUT" insertAt) (below the title line)"
ANCHOR=',"insertBeforeHeading":{"text":"Compose check","occurrence":2,"expectedCount":2}'
HREV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "$(compose_req append "$ANCHOR,\"ifRevision\":\"$HREV\"")" || true)"
[ "$(field "$OUT" placementVerified)" = "true" ] || fail "insert before heading failed: $(field "$OUT" code) $(field "$OUT" message)"
OUT="$(copy_run "$(compose_req append "$ANCHOR,\"dryRun\":true")" || true)"
[ "$(field "$OUT" code)" = "selector_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "stale heading count not refused"
echo "ok: insert before heading verified; a stale expectedCount is refused"
OBJECTS='[{"style":"body","runs":[{"text":"objects"}]},{"kind":"divider"},
{"kind":"table","rows":[["A","B"],["1",""]]},{"kind":"divider"},
{"style":"body","runs":[{"text":"link","link":"notes://showNote?identifier='"$NOTE"'"}]}]'
OREQ="$(printf '{"protocol":1,"action":"compose_note","identifier":"%s","mode":"append","paragraphs":%s' "$NOTE" "$OBJECTS")"
OUT="$(copy_run "$OREQ,\"dryRun\":true}" || true)"
[ "$(field "$OUT" status)" = "planned" ] || fail "object plan failed: $(field "$OUT" code) $(field "$OUT" message)"
OBJ_BEFORE="$(/usr/bin/sqlite3 "$COPY" "SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZTYPEUTI IN ('com.apple.notes.table','com.apple.notes.inlinetextattachment.dividerline') OR ZTYPEUTI1 IN ('com.apple.notes.table','com.apple.notes.inlinetextattachment.dividerline');" 2>/dev/null || echo "?")"
OREV="$(field "$(copy_run "$READ")" revision)"
OUT="$(copy_run "$OREQ,\"ifRevision\":\"$OREV\"}" || true)"
[ "$(field "$OUT" verified)" = "true" ] || fail "object compose failed: $(field "$OUT" code) $(field "$OUT" message)"
[ "$(field "$OUT" objects)" = "3" ] || fail "expected 3 created objects, got $(field "$OUT" objects)"
[ "$(field "$OUT" objects.1.uti)" = "com.apple.notes.table" ] || fail "table object has UTI $(field "$OUT" objects.1.uti)"
OBJ_AFTER="$(/usr/bin/sqlite3 "$COPY" "SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZTYPEUTI IN ('com.apple.notes.table','com.apple.notes.inlinetextattachment.dividerline') OR ZTYPEUTI1 IN ('com.apple.notes.table','com.apple.notes.inlinetextattachment.dividerline');" 2>/dev/null || echo "?")"
echo "ok: 2 dividers and a table created, placed, and verified cell by cell (divider UTI $(field "$OUT" objects.0.uti); object rows $OBJ_BEFORE -> $OBJ_AFTER)"
OUT="$(copy_run "$OREQ,\"ifRevision\":\"$OREV\"}" || true)"
[ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
  fail "replayed object compose not refused"
echo "ok: replayed object compose refused, committed=false"
QUICK="$(/usr/bin/sqlite3 "$COPY" "SELECT ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE ZISSYSTEMPAPER=1
  AND IFNULL(ZMARKEDFORDELETION,0)=0 AND ZFOLDER IS NOT NULL LIMIT 1;" 2>/dev/null || true)"
if [ -n "$QUICK" ]; then
  OUT="$(copy_run "$(compose_req append ',"dryRun":true,"requireNonSystemPaper":true' | sed "s/$NOTE/$QUICK/")" || true)"
  [ "$(field "$OUT" code)" = "unsupported_note" ] || fail "Quick Note not refused: $(field "$OUT" code)"
  echo "ok: requireNonSystemPaper refuses a Quick Note"
else
  echo "note: no Quick Note in this store; requireNonSystemPaper refusal not exercised"
fi

# 4f. Native tables: row delete (two-phase), row insert, cell edit, and orphan
#    prune, all on the copy. Candidate: the first editable note with a table
#    that is visible exactly once and has at least two rows.
tables_request() { printf '{"protocol":1,"action":"read_tables","identifier":"%s"}' "$1"; }
delete_request() { # dryRun [ifRevision ifTableDigest]
  if [ "$1" = "true" ]; then
    printf '{"protocol":1,"action":"delete_table_row","identifier":"%s","tableIdentifier":"%s","rowIdentifier":"%s","dryRun":true}' \
      "$TNOTE" "$TID" "$ROW1"
  else
    printf '{"protocol":1,"action":"delete_table_row","identifier":"%s","tableIdentifier":"%s","rowIdentifier":"%s","dryRun":false,"ifRevision":"%s","ifTableDigest":"%s"}' \
      "$TNOTE" "$TID" "$ROW1" "$2" "$3"
  fi
}
prune_request() { # tableIdentifier dryRun [ifRevision ifTableDigest]
  if [ "$2" = "true" ]; then
    printf '{"protocol":1,"action":"prune_orphan_table","identifier":"%s","tableIdentifier":"%s","dryRun":true}' "$TNOTE" "$1"
  else
    printf '{"protocol":1,"action":"prune_orphan_table","identifier":"%s","tableIdentifier":"%s","dryRun":false,"ifRevision":"%s","ifTableDigest":"%s"}' \
      "$TNOTE" "$1" "$3" "$4"
  fi
}
ZERO_DIGEST="t1:${ZERO#r1:}"

table_checks() {
  local CANDIDATE STATE COUNT I TREAD TLIVE TLIVE_BEFORE ROWS_BEFORE ROW0 COL0 PLAN PREV PDIG OUT
  local REV_AFTER DIG_AFTER INSERT NEWROW SETCELL ORPHAN
  TNOTE=""
  TABLE=""
  TSTATE=""
  for CANDIDATE in $(/usr/bin/sqlite3 "$COPY" "SELECT n.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT a
    JOIN ZICCLOUDSYNCINGOBJECT n ON a.ZNOTE = n.Z_PK
    WHERE a.ZTYPEUTI = 'com.apple.notes.table' AND IFNULL(a.ZMARKEDFORDELETION,0)=0
      AND n.ZFOLDER IS NOT NULL AND IFNULL(n.ZISPASSWORDPROTECTED,0)=0
      AND IFNULL(n.ZMARKEDFORDELETION,0)=0
    GROUP BY n.Z_PK ORDER BY MAX(n.ZMODIFICATIONDATE1) DESC LIMIT 40;"); do
    STATE="$(copy_run "$(read_request "$CANDIDATE")" || true)"
    if [ "$(field "$STATE" editable)" != "true" ] || [ "$(field "$STATE" sharedViaICloud)" != "false" ] ||
      [ "$(field "$STATE" deletedOrInTrash)" != "false" ]; then
      continue
    fi
    TSTATE="$(copy_run "$(tables_request "$CANDIDATE")" || true)"
    # The live store's tables for the same note. Earlier steps write to the
    # copy only (the compose step gives the append note a table there), so a
    # table is a candidate only when the live store holds the same table in
    # the same state; that is what the live comparison below checks.
    TLIVE="$(run "$(tables_request "$CANDIDATE")" || true)"
    COUNT="$(field "$TSTATE" tableCount)"
    I=0
    while [ "$I" -lt "${COUNT:-0}" ]; do
      if [ "$(field "$TSTATE" "tables.$I.glyphCount")" = "1" ] &&
        [ "$(field "$TSTATE" "tables.$I.readable")" = "true" ] &&
        [ "$(field "$TSTATE" "tables.$I.rowCount")" -ge 2 ] &&
        [ -n "$(field "$TSTATE" "tables.$I.digest")" ] &&
        [ "$(field "$TLIVE" "tables.$I.identifier")" = "$(field "$TSTATE" "tables.$I.identifier")" ] &&
        [ "$(field "$TLIVE" "tables.$I.digest")" = "$(field "$TSTATE" "tables.$I.digest")" ]; then
        TNOTE="$CANDIDATE"
        TABLE="$I"
        break 2
      fi
      I=$((I + 1))
    done
  done
  if [ -z "$TNOTE" ]; then
    echo "skip: no editable note with a visible multi-row table that the copy and the live store share"
    return 0
  fi
  TREAD="$(tables_request "$TNOTE")"
  TLIVE_BEFORE="$(field "$(run "$TREAD")" "tables.$TABLE.digest")"
  [ -n "$TLIVE_BEFORE" ] || fail "could not read the live table state"
  TID="$(field "$TSTATE" "tables.$TABLE.identifier")"
  ROWS_BEFORE="$(field "$TSTATE" "tables.$TABLE.rowCount")"
  ROW0="$(field "$TSTATE" "tables.$TABLE.rows.0.identifier")"
  ROW1="$(field "$TSTATE" "tables.$TABLE.rows.1.identifier")"
  COL0="$(field "$TSTATE" "tables.$TABLE.columnIdentifiers.0")"

  # Without the write switch an apply against the live store is refused
  # before any read-write open (and carries zero tokens besides).
  OUT="$(run "$(delete_request false "$ZERO" "$ZERO_DIGEST")" || true)"
  [ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "live table apply not gated: $(field "$OUT" code)"
  echo "ok: live table apply refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

  PLAN="$(copy_run "$(delete_request true)" || true)"
  [ "$(field "$PLAN" status)" = "planned" ] || fail "delete dry run: $(field "$PLAN" code) $(field "$PLAN" message)"
  [ "$(field "$PLAN" committed)" = "false" ] || fail "dry run reported committed"
  PREV="$(field "$PLAN" revision)"
  PDIG="$(field "$PLAN" tableDigest)"
  echo "ok: delete-row dry run planned row $(field "$PLAN" rowIndex) of $ROWS_BEFORE"
  OUT="$(copy_run "$(delete_request false "$PREV" "$ZERO_DIGEST")" || true)"
  [ "$(field "$OUT" code)" = "attachment_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "stale table digest not refused: $(field "$OUT" code)"
  echo "ok: stale ifTableDigest refused, committed=false"
  OUT="$(copy_run "$(delete_request false "$ZERO" "$PDIG")" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "stale ifRevision not refused: $(field "$OUT" code)"
  echo "ok: stale ifRevision refused, committed=false"
  OUT="$(copy_run "$(delete_request false "$PREV" "$PDIG")" || true)"
  [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "delete apply: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" rowCount)" = "$((ROWS_BEFORE - 1))" ] || fail "row count did not drop by one"
  [ "$(field "$OUT" storeKind)" = "copy" ] || fail "delete did not report the copy store"
  [ "$(field "$OUT" pushScheduled)" = "false" ] || fail "delete claimed a push"
  REV_AFTER="$(field "$OUT" revisionAfter)"
  DIG_AFTER="$(field "$OUT" tableDigestAfter)"
  echo "ok: row deleted and verified ($ROWS_BEFORE -> $(field "$OUT" rowCount) rows, uploadPending $(field "$OUT" cloudSync.uploadPending))"
  OUT="$(copy_run "$(delete_request false "$PREV" "$PDIG")" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed delete not refused: $(field "$OUT" code)"
  echo "ok: replayed delete refused"

  INSERT="$(printf '{"protocol":1,"action":"insert_table_row","identifier":"%s","tableIdentifier":"%s","afterRowIdentifier":"%s","cells":["copy-store row"],"ifRevision":"%s","ifTableDigest":"%s"}' \
    "$TNOTE" "$TID" "$ROW0" "$REV_AFTER" "$DIG_AFTER")"
  OUT="$(copy_run "$INSERT" || true)"
  [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "insert: $(field "$OUT" code) $(field "$OUT" message)"
  NEWROW="$(field "$OUT" rowIdentifier)"
  echo "ok: row inserted at index $(field "$OUT" rowIndex) and verified"
  SETCELL="$(printf '{"protocol":1,"action":"set_table_cell","identifier":"%s","tableIdentifier":"%s","rowIdentifier":"%s","columnIdentifier":"%s","text":"copy-store edit","ifRevision":"%s","ifTableDigest":"%s"}' \
    "$TNOTE" "$TID" "$NEWROW" "$COL0" "$(field "$OUT" revisionAfter)" "$(field "$OUT" tableDigestAfter)")"
  OUT="$(copy_run "$SETCELL" || true)"
  [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "set cell: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" previousText)" = "copy-store row" ] || fail "set cell saw the wrong previous text"
  echo "ok: cell edited and verified"
  OUT="$(copy_run "$SETCELL" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed cell edit not refused: $(field "$OUT" code)"
  echo "ok: replayed cell edit refused"

  # 7. Orphan prune. COPY-ONLY fixture: reassign another note's table
  #    attachment to this note with SQL on the copy, so the note owns an
  #    active table that no body glyph shows. The writer itself never runs SQL.
  /usr/bin/sqlite3 "$COPY" "UPDATE ZICCLOUDSYNCINGOBJECT
    SET ZNOTE = (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = '$TNOTE')
    WHERE Z_PK = (SELECT a.Z_PK FROM ZICCLOUDSYNCINGOBJECT a
      WHERE a.ZTYPEUTI = 'com.apple.notes.table' AND IFNULL(a.ZMARKEDFORDELETION,0)=0
        AND a.ZNOTE != (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = '$TNOTE')
      ORDER BY a.Z_PK LIMIT 1);"
  TSTATE="$(copy_run "$TREAD" || true)"
  ORPHAN=""
  I=0
  while [ "$I" -lt "$(field "$TSTATE" tableCount)" ]; do
    if [ "$(field "$TSTATE" "tables.$I.orphan")" = "true" ]; then
      ORPHAN="$(field "$TSTATE" "tables.$I.identifier")"
    fi
    I=$((I + 1))
  done
  if [ -z "$ORPHAN" ]; then
    echo "skip: the copy has no second table to turn into an orphan"
  else
    OUT="$(copy_run "$(prune_request "$TID" true)" || true)"
    [ "$(field "$OUT" code)" = "unsupported_attachment" ] || fail "visible table accepted as an orphan"
    echo "ok: visible table refused by prune"
    PLAN="$(copy_run "$(prune_request "$ORPHAN" true)" || true)"
    [ "$(field "$PLAN" status)" = "planned" ] || fail "prune dry run: $(field "$PLAN" code) $(field "$PLAN" message)"
    OUT="$(copy_run "$(prune_request "$ORPHAN" false "$(field "$PLAN" revision)" "$(field "$PLAN" tableDigest)")" || true)"
    [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
      fail "prune apply: $(field "$OUT" code) $(field "$OUT" message)"
    echo "ok: orphan pruned and verified (active tables $(field "$OUT" activeTableCountBefore) -> $(field "$OUT" activeTableCountAfter))"
    OUT="$(copy_run "$(prune_request "$ORPHAN" true)" || true)"
    [ "$(field "$OUT" code)" = "unsupported_attachment" ] || fail "pruned table still prunable"
    echo "ok: pruned table no longer offered"
  fi

  [ "$TLIVE_BEFORE" = "$(field "$(run "$TREAD")" "tables.$TABLE.digest")" ] ||
    fail "live table changed during the copy test"
  echo "ok: live table digest unchanged"
}
table_checks

# 4g. Smart folders on the copy: create inside an ordinary folder, idempotent
#    retry, title conflict, a smart folder refused as a parent, an
#    unrepresentable query refused, guarded update, then dry-run and guarded
#    delete. The live smart-folder rows are fingerprinted read-only before and
#    after.
live_smart_rows() {
  /usr/bin/sqlite3 -readonly "$LIVE" "SELECT ZIDENTIFIER, ZTITLE2, ZSMARTFOLDERQUERYJSON,
    ZMARKEDFORDELETION FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDERTYPE = 2 ORDER BY ZIDENTIFIER;" |
    /usr/bin/shasum -a 256
}
smart_create() { # title queryJSON [extra fields]
  printf '{"protocol":1,"action":"create_smart_folder","title":"%s","queryJSON":"%s"%s}' "$1" "$2" "${3:-}"
}
smart_read() { printf '{"protocol":1,"action":"read_smart_folder","identifier":"%s"}' "$1"; }
smart_update() { # identifier queryJSON ifRevision
  printf '{"protocol":1,"action":"update_smart_folder","identifier":"%s","queryJSON":"%s","ifRevision":"%s"}' "$1" "$2" "$3"
}
smart_delete() { # identifier dryRun [ifRevision]
  if [ "$2" = "true" ]; then
    printf '{"protocol":1,"action":"delete_smart_folder","identifier":"%s","dryRun":true}' "$1"
  else
    printf '{"protocol":1,"action":"delete_smart_folder","identifier":"%s","dryRun":false,"ifRevision":"%s"}' "$1" "$3"
  fi
}
ZERO_FOLDER="f1:${ZERO#r1:}"

smart_folder_checks() {
  local LIVE_SMART_BEFORE PARENT TITLE Q1 Q2 QNOT OUT SMART REVF REVU
  LIVE_SMART_BEFORE="$(live_smart_rows)"
  PARENT="$(/usr/bin/sqlite3 "$COPY" "SELECT f.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT f
    WHERE f.ZIDENTIFIER IS NOT NULL AND f.ZTITLE2 IS NOT NULL AND IFNULL(f.ZFOLDERTYPE,0)=0
      AND IFNULL(f.ZMARKEDFORDELETION,0)=0 AND f.ZIDENTIFIER NOT LIKE 'TrashFolder%'
      AND f.ZIDENTIFIER NOT LIKE 'DefaultFolder%' AND f.ZOWNER IS NOT NULL AND f.ZSERVERSHAREDATA IS NULL
    ORDER BY f.Z_PK DESC LIMIT 1;" 2>/dev/null || true)"
  if [ -z "$PARENT" ]; then
    echo "skip: no ordinary folder in the copy for the smart-folder test"
    return 0
  fi
  TITLE="copy-store smart folder $(date +%s)"
  Q1='{\"entity\":\"note\",\"type\":{\"checklist\":true}}'
  Q2='{\"entity\":\"note\",\"type\":{\"or\":[{\"pinned\":true},{\"attachment\":true}]}}'
  QNOT='{\"entity\":\"note\",\"type\":{\"not\":{\"pinned\":true}}}'

  # Without the write switch a create against the live store is refused
  # before any read-write open.
  OUT="$(run "$(smart_create "$TITLE" "$Q1" ",\"parentIdentifier\":\"$PARENT\"")" || true)"
  [ "$(field "$OUT" code)" = "writes_disabled" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "live smart-folder create not gated: $(field "$OUT" code)"
  echo "ok: live smart-folder create refused without APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES"

  OUT="$(copy_run "$(smart_create "$TITLE" "$Q1" ",\"parentIdentifier\":\"$PARENT\"")" || true)"
  [ "$(field "$OUT" status)" = "created" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "smart folder create: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" folderType)" = "2" ] || fail "created folder is not a smart folder"
  [ "$(field "$OUT" parentDurability)" = "stamped" ] || fail "parent timestamp not stamped"
  [ "$(field "$OUT" titleDurability)" = "stamped" ] || fail "title timestamp not stamped"
  [ "$(field "$OUT" storeKind)" = "copy" ] || fail "create did not report the copy store"
  [ "$(field "$OUT" pushScheduled)" = "false" ] || fail "create claimed a push"
  SMART="$(field "$OUT" identifier)"
  echo "ok: smart folder created and verified on the copy (filters $(field "$OUT" filterCount), uploadPending $(field "$OUT" cloudSync.uploadPending))"
  OUT="$(copy_run "$(smart_create "$TITLE" "$Q1" ",\"parentIdentifier\":\"$PARENT\"")" || true)"
  [ "$(field "$OUT" status)" = "ok" ] && [ "$(field "$OUT" changed)" = "false" ] &&
    [ "$(field "$OUT" committed)" = "false" ] || fail "idempotent retry changed something"
  echo "ok: identical retry is a no-op"
  OUT="$(copy_run "$(smart_create "$TITLE" "$Q2" ",\"parentIdentifier\":\"$PARENT\"")" || true)"
  [ "$(field "$OUT" code)" = "folder_exists" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "different query under the same title not refused: $(field "$OUT" code)"
  echo "ok: a different query under the same title is refused, committed=false"
  OUT="$(copy_run "$(smart_create "$TITLE x" "$Q1" ",\"parentIdentifier\":\"$SMART\"")" || true)"
  [ "$(field "$OUT" code)" = "unsupported_folder" ] && [ "$(field "$OUT" reason)" = "smart_folder_destination" ] &&
    [ "$(field "$OUT" committed)" = "false" ] || fail "smart folder accepted as a parent: $(field "$OUT" code)"
  echo "ok: a smart folder is refused as a parent (smart_folder_destination), committed=false"
  OUT="$(copy_run "$(smart_create "$TITLE y" "$QNOT" ",\"parentIdentifier\":\"$PARENT\"")" || true)"
  [ "$(field "$OUT" code)" = "query_not_representable" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "unrepresentable query not refused: $(field "$OUT" code)"
  echo "ok: a query Notes would change is refused, committed=false"

  REVF="$(field "$(copy_run "$(smart_read "$SMART")")" revision)"
  [ -n "$REVF" ] || fail "read_smart_folder returned no revision"
  OUT="$(copy_run "$(smart_update "$SMART" "$Q2" "$ZERO_FOLDER")" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "stale update revision not refused: $(field "$OUT" code)"
  OUT="$(copy_run "$(smart_update "$SMART" "$Q2" "$REVF")" || true)"
  [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "guarded update failed: $(field "$OUT" code) $(field "$OUT" message)"
  REVU="$(field "$OUT" revisionAfter)"
  [ "$REVU" != "$REVF" ] || fail "update did not change the folder revision"
  OUT="$(copy_run "$(smart_update "$SMART" "$Q2" "$REVF")" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] || fail "replayed update not refused: $(field "$OUT" code)"
  echo "ok: stale update refused; guarded update verified; replay refused"

  # A folder whose title timestamp is missing (cleared with SQL on the copy):
  # the update changes only the query, reports the gap, and stamps nothing.
  /usr/bin/sqlite3 "$COPY" "UPDATE ZICCLOUDSYNCINGOBJECT SET ZDATEFORLASTTITLEMODIFICATION = NULL WHERE ZIDENTIFIER = '$SMART';"
  REVF="$(field "$(copy_run "$(smart_read "$SMART")")" revision)"
  OUT="$(copy_run "$(smart_update "$SMART" "$Q1" "$REVF")" || true)"
  [ "$(field "$OUT" status)" = "updated" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "update of an unstamped folder failed: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" timestampsMissing.0)" = "dateForLastTitleModification" ] &&
    [ "$(field "$OUT" titleDurability)" = "missing" ] ||
    fail "a missing title timestamp was stamped or not reported"
  REVU="$(field "$OUT" revisionAfter)"
  echo "ok: an unstamped folder's query updated; the missing title timestamp reported, not stamped"

  OUT="$(copy_run "$(smart_delete "$SMART" true)" || true)"
  [ "$(field "$OUT" status)" = "planned" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "delete dry run: $(field "$OUT" code) $(field "$OUT" message)"
  [ "$(field "$OUT" revision)" = "$REVU" ] || fail "dry-run revision differs from the update's revisionAfter"
  OUT="$(copy_run "$(smart_delete "$SMART" false "$ZERO_FOLDER")" || true)"
  [ "$(field "$OUT" code)" = "revision_conflict" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "stale delete revision not refused: $(field "$OUT" code)"
  OUT="$(copy_run "$(smart_delete "$SMART" false "$REVU")" || true)"
  [ "$(field "$OUT" status)" = "deleted" ] && [ "$(field "$OUT" verified)" = "true" ] ||
    fail "delete apply: $(field "$OUT" code) $(field "$OUT" message)"
  OUT="$(copy_run "$(smart_delete "$SMART" false "$REVU")" || true)"
  [ "$(field "$OUT" code)" = "unsupported_folder" ] && [ "$(field "$OUT" committed)" = "false" ] ||
    fail "replayed delete not refused: $(field "$OUT" code)"
  echo "ok: delete planned, stale revision refused, tombstone verified, replay refused"
  OUT="$(copy_run "$(smart_delete "$PARENT" true)" || true)"
  [ "$(field "$OUT" code)" = "unsupported_folder" ] || fail "ordinary folder accepted for smart-folder delete"
  echo "ok: ordinary folder refused by the smart-folder delete"

  [ "$LIVE_SMART_BEFORE" = "$(live_smart_rows)" ] || fail "live smart folders changed during the copy test"
  echo "ok: live smart-folder rows unchanged"
}
smart_folder_checks

# 5. The live notes are untouched.
LIVE_AFTER="$(field "$(run "$READ")" revision)"
[ "$LIVE_BEFORE" = "$LIVE_AFTER" ] || fail "live note revision changed during the copy test (a concurrent edit in Notes also causes this; rerun)"
for PAIR in $EDIT_LIVE_BEFORE; do
  [ "$(field "$(run "$(read_request "${PAIR%%=*}")")" revision)" = "${PAIR#*=}" ] ||
    fail "a live edit-note revision changed during the copy test (a concurrent edit in Notes also causes this; rerun)"
done
echo "ok: live note revisions unchanged"
while read -r WNOTE WREV; do
  [ "$WREV" = "$(field "$(run "$(read_request "$WNOTE")")" revision)" ] ||
    fail "a live note used by a feature check changed during the copy test"
done <"$WATCHED"
echo "ok: $(wc -l <"$WATCHED" | tr -d ' ') feature-check live note revision(s) unchanged"
echo "PASS"
