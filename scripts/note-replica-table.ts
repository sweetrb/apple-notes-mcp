#!/usr/bin/env npx tsx
/**
 * Prints the CRDT replica table of one note, read-only.
 *
 *   note-replica-table STORE.sqlite NOTE-UUID [--shape]
 *
 * STORE is opened with `sqlite3 -readonly`; the live store is fine. Output is
 * line-oriented so a shell script can parse it, and never contains note text:
 *
 *   replicas N substrings M
 *   replica I UUID clock=C chars=X live=Y substrings=Z
 *   layout lengthsMatchText=true liveChars=.. textUtf16=.. indexBase=0|1|unknown
 *   warning ...
 *
 * `--shape` prints the field structure (numbers, wire types, sizes) instead,
 * for re-deriving the layout after a macOS change. The decoder is
 * src/utils/noteReplicaTable.ts; scripts/test-private-writer-replica-identity-copy-store.sh
 * bundles this file with esbuild and runs it.
 */
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  describeProtoShape,
  parseNoteReplicaTableFromPlain,
} from "../src/utils/noteReplicaTable.js";

const [store, uuid, flag, ...rest] = process.argv.slice(2);
if (!store || !uuid || rest.length > 0 || (flag !== undefined && flag !== "--shape")) {
  console.error("usage: note-replica-table STORE.sqlite NOTE-UUID [--shape]");
  process.exit(2);
}
if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(uuid)) {
  console.error("NOTE-UUID must be a Notes UUID");
  process.exit(2);
}

// The UUID was validated above, so it is safe to put in the statement.
const hex = execFileSync(
  "/usr/bin/sqlite3",
  [
    "-readonly",
    store,
    `SELECT hex(d.ZDATA) FROM ZICNOTEDATA d JOIN ZICCLOUDSYNCINGOBJECT n ON d.ZNOTE = n.Z_PK
     WHERE n.ZIDENTIFIER = '${uuid.toUpperCase()}' LIMIT 1;`,
  ],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
).trim();
if (!/^[0-9A-F]+$/i.test(hex)) {
  console.error("no readable note data for that UUID (missing, or password protected)");
  process.exit(1);
}
const plain = gunzipSync(Buffer.from(hex, "hex"), { maxOutputLength: 64 * 1024 * 1024 });

if (flag === "--shape") {
  for (const line of describeProtoShape(plain)) console.log(line);
} else {
  const table = parseNoteReplicaTableFromPlain(plain);
  console.log(`replicas ${table.replicas.length} substrings ${table.substrings}`);
  for (const r of table.replicas)
    console.log(
      `replica ${r.index} ${r.uuid} clock=${r.clock} chars=${r.chars} live=${r.liveChars} substrings=${r.substrings}`
    );
  const l = table.layout;
  console.log(
    `layout lengthsMatchText=${l.lengthsMatchText} liveChars=${l.liveChars} textUtf16=${l.textUtf16} indexBase=${l.indexBase ?? "unknown"}`
  );
  for (const w of l.warnings) console.log(`warning ${w}`);
}
