#!/usr/bin/env node
// Independent preservation check for the private writer's edit_note action.
//
// It never uses the writer or NotesShared. It reads a COPY of NoteStore.sqlite
// with `sqlite3 -readonly`, gunzips the note's stored protobuf, and decodes the
// text and attribute runs itself, so a bug shared by the writer's own
// read-back cannot hide here.
//
//   snapshot STORE UUID OUT.json   record the decoded note and store digests
//   same BEFORE.json AFTER.json   prove the note and store did not change at all
//   compare BEFORE.json AFTER.json RESPONSE.json
//       prove that every UTF-16 unit outside the edited ranges kept its exact
//       serialized attribute run (paragraph style, checklist state, fonts,
//       inline formatting, attachment reference), that every attachment row
//       other than one the writer reported in `removedAttachments` and every
//       other note and object row are byte-identical, and that the text
//       inside the edits is what the writer reported. A removed attachment's
//       row may be unchanged, changed, or gone; its state is printed. A file
//       that replaced an attachment may add exactly the attachment and media
//       rows the response lists in `replacementFiles`, and bump the version
//       counter (Z_OPT, nothing else) of one row, the note's account.
//
// Prints counts and offsets only, never note text.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function sql(store, statements) {
  return execFileSync("/usr/bin/sqlite3", ["-readonly", store], {
    input: statements,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

const sha = (data) => createHash("sha256").update(data).digest("hex");

function varint(buf, at) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[at++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7n;
  }
}

/** Top-level fields of one protobuf message: [{ field, wire, start, end, value }]. */
function fields(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const start = at;
    const [key, next] = varint(buf, at);
    at = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) [value, at] = varint(buf, at);
    else if (wire === 1) ((value = buf.subarray(at, at + 8)), (at += 8));
    else if (wire === 5) ((value = buf.subarray(at, at + 4)), (at += 4));
    else if (wire === 2) {
      const [length, body] = varint(buf, at);
      value = buf.subarray(body, body + Number(length));
      at = body + Number(length);
    } else throw new Error(`unsupported wire type ${wire}`);
    out.push({ field, wire, start, end: at, value });
  }
  return out;
}

const one = (list, field) => list.find((f) => f.field === field);

/** Decode NoteStoreProto -> Document(2) -> Note(3): text(2), attribute runs(5). */
function decodeNote(gz) {
  const note = fields(one(fields(one(fields(gunzipSync(gz)), 2).value), 3).value);
  const text = Buffer.from(one(note, 2).value).toString("utf8");
  // Per-UTF-16-unit run keys. A run's key is its serialized bytes minus the
  // length field (1), so equal attributes compare equal however the runs
  // happen to be split.
  const keys = [];
  for (const run of note.filter((f) => f.field === 5)) {
    const parts = fields(run.value);
    const length = Number(one(parts, 1)?.value ?? 0n);
    const key = sha(
      Buffer.concat(
        parts.filter((p) => p.field !== 1).map((p) => run.value.subarray(p.start, p.end))
      )
    ).slice(0, 16);
    for (let i = 0; i < length; i++) keys.push(key);
  }
  return { text, keys };
}

function snapshot(store, uuid, out) {
  if (!UUID.test(uuid)) throw new Error("UUID required");
  const pk = sql(
    store,
    `.parameter set :id '${uuid}'\nSELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = :id;\n`
  ).trim();
  if (!/^\d+$/.test(pk)) throw new Error("note not found in the copy");
  const param = `.parameter set :pk ${pk}\n.mode quote\n`;
  const hex = sql(store, `${param}SELECT hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE = :pk;\n`)
    .trim()
    .replace(/'/g, "");
  const note = decodeNote(Buffer.from(hex, "hex"));
  // One digest per attachment row, keyed by its identifier (JSON output keeps
  // multi-line text values on one record).
  const attachmentJson = sql(
    store,
    `.parameter set :pk ${pk}\n.mode json\nSELECT * FROM ZICCLOUDSYNCINGOBJECT WHERE ZNOTE = :pk ORDER BY Z_PK;\n`
  ).trim();
  const attachments = {};
  for (const row of attachmentJson ? JSON.parse(attachmentJson) : [])
    attachments[String(row.ZIDENTIFIER ?? `pk${row.Z_PK}`).toLowerCase()] = {
      digest: sha(JSON.stringify(row)),
      markedForDeletion: Boolean(row.ZMARKEDFORDELETION),
    };
  // Everything else, one digest per row: the note's own row is compared
  // through its text and runs, its attachment rows row by row above. Each
  // row also keeps a digest without Z_OPT (Core Data's version counter), so
  // a row that only had its counter bumped can be told apart.
  const others = {};
  const otherJson = sql(
    store,
    `.parameter set :pk ${pk}\n.mode json\n` +
      `SELECT * FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK != :pk AND ZNOTE IS NOT :pk ORDER BY Z_PK;\n`
  ).trim();
  for (const row of otherJson ? JSON.parse(otherJson) : []) {
    const { Z_OPT, ...rest } = row;
    void Z_OPT;
    others[`o${row.Z_PK}`] = {
      digest: sha(JSON.stringify(row)),
      withoutVersion: sha(JSON.stringify(rest)),
      identifier: row.ZIDENTIFIER ? String(row.ZIDENTIFIER).toLowerCase() : null,
    };
  }
  const noteData = sql(
    store,
    `${param}SELECT Z_PK, ZNOTE, hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE IS NOT :pk ORDER BY Z_PK;\n`
  );
  const state = {
    uuid,
    textLength: note.text.length,
    text: note.text,
    keys: note.keys,
    attachmentRows: Object.keys(attachments).length,
    attachments,
    others,
    noteDataDigest: sha(noteData),
  };
  writeFileSync(out, JSON.stringify(state));
  console.log(
    `snapshot: ${state.textLength} UTF-16 units, ${new Set(note.keys).size} distinct runs, ` +
      `${state.attachmentRows} attachment rows`
  );
}

function compare(beforePath, afterPath, responsePath) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const response = responsePath
    ? JSON.parse(readFileSync(responsePath, "utf8"))
    : { operations: [], lengthAfter: before.textLength };
  const failures = [];
  if (before.keys.length !== before.textLength)
    failures.push("before: run lengths do not cover the text (non-BMP text?)");
  const targets = response.operations
    .flatMap((op) => op.targets)
    .sort((a, b) => a.location - b.location);
  let oldAt = 0;
  let newAt = 0;
  let unchangedUnits = 0;
  const check = (oldStart, newStart, length) => {
    for (let i = 0; i < length; i++) {
      if (before.text[oldStart + i] !== after.text[newStart + i]) {
        failures.push(`text differs at old ${oldStart + i}`);
        return;
      }
      if (before.keys[oldStart + i] !== after.keys[newStart + i]) {
        failures.push(`attributes differ at old ${oldStart + i} / new ${newStart + i}`);
        return;
      }
    }
    unchangedUnits += length;
  };
  for (const t of targets) {
    check(oldAt, newAt, t.location - oldAt);
    newAt += t.location - oldAt + t.newLength;
    oldAt = t.location + t.length;
  }
  check(oldAt, newAt, before.textLength - oldAt);
  if (newAt + (before.textLength - oldAt) !== after.textLength)
    failures.push(
      `length ${after.textLength} is not the planned ${newAt + before.textLength - oldAt}`
    );
  if (response.lengthAfter !== after.textLength)
    failures.push(
      `writer reported lengthAfter ${response.lengthAfter}, store has ${after.textLength}`
    );
  const removed = new Set((response.removedAttachments ?? []).map((id) => id.toLowerCase()));
  const removedState = [];
  for (const [id, row] of Object.entries(before.attachments)) {
    if (removed.has(id)) {
      const now = after.attachments[id];
      removedState.push(
        !now
          ? "gone"
          : now.digest === row.digest
            ? "row unchanged"
            : `row changed (markedForDeletion ${now.markedForDeletion})`
      );
      continue;
    }
    if (!after.attachments[id]) failures.push("an untargeted attachment row left the note");
    else if (after.attachments[id].digest !== row.digest)
      failures.push("an untargeted attachment row (including table data) changed");
  }
  // A file that replaced an attachment adds exactly the attachment and media
  // rows the writer reported; creating them may bump the version counter
  // (and nothing else) of the note's account row.
  const files = response.replacementFiles ?? [];
  const created = new Set(
    files.map((f) => String(f.attachmentIdentifier ?? "").toLowerCase()).filter(Boolean)
  );
  const createdMedia = new Set(
    files.map((f) => String(f.mediaIdentifier ?? "").toLowerCase()).filter(Boolean)
  );
  for (const id of Object.keys(after.attachments))
    if (!before.attachments[id] && !created.has(id))
      failures.push("a new attachment row appeared in the note");
  for (const id of created)
    if (!after.attachments[id]) failures.push("a replacement attachment row is not in the note");
  // EDIT_CHECK_NOTE_ONLY=1 skips the whole-store comparison, for reading a
  // live store where Notes and sync legitimately change other rows.
  let versionBumps = 0;
  if (process.env.EDIT_CHECK_NOTE_ONLY !== "1") {
    if (before.noteDataDigest !== after.noteDataDigest)
      failures.push("another note's body changed");
    for (const [key, row] of Object.entries(after.others)) {
      const old = before.others[key];
      if (!old) {
        if (!row.identifier || !createdMedia.has(row.identifier))
          failures.push("an object row appeared that the edit did not report");
      } else if (old.digest !== row.digest) {
        if (files.length && old.withoutVersion === row.withoutVersion) versionBumps++;
        else failures.push("another note, folder, or object row changed");
      }
    }
    for (const key of Object.keys(before.others))
      if (!after.others[key]) failures.push("an object row disappeared");
    for (const id of createdMedia)
      if (!Object.values(after.others).some((row) => row.identifier === id))
        failures.push("a replacement file's media row is missing");
    if (versionBumps > 1) failures.push(`${versionBumps} rows changed their version counter`);
  }
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log(
    `ok: ${unchangedUnits} unchanged UTF-16 units kept their serialized runs across ` +
      `${targets.length} edited range(s); ${before.attachmentRows - removedState.length} ` +
      `untargeted attachment rows identical` +
      (removedState.length ? `; removed attachment rows: ${removedState.join(", ")}` : "") +
      (created.size ? `; ${created.size} replacement attachment(s) with their media rows` : "") +
      (process.env.EDIT_CHECK_NOTE_ONLY === "1"
        ? " (note-only check)"
        : `; all other rows identical${versionBumps ? " (account version counter bumped)" : ""}`)
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === "snapshot" && args.length === 3) snapshot(...args);
else if (command === "compare" && args.length === 3) compare(...args);
else if (command === "same" && args.length === 2) compare(...args);
else {
  console.error(
    "usage: check-edit-preservation.mjs snapshot STORE UUID OUT | same BEFORE AFTER | compare BEFORE AFTER RESPONSE"
  );
  process.exit(2);
}
