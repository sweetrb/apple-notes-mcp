/**
 * Read-only decoder for the CRDT replica table of a note body.
 *
 * `ZICNOTEDATA.ZDATA` is a gzipped `Document` whose note is the serialized
 * "topotext" `String`. Beside the text (field 2) and the attribute runs
 * (field 5) that the rest of this repository reads, that message carries the
 * CRDT state used to merge edits from several devices:
 *
 *   Document
 *     version (2) -> Version
 *       data (3)  -> String
 *         string (2)       the text
 *         substring (3)    repeated: charID (1) {replicaID (1), clock (2)},
 *                          length (2), timestamp (3), tombstone (4), child (5)
 *         timestamp (4)    vector timestamp: repeated clock (1) {replicaUUID
 *                          (1, 16 bytes), sub-clocks (2)}
 *         attributeRun (5)
 *
 * The field numbers for substring, timestamp and clock come from the public
 * reverse-engineering notes (https://github.com/dunhamsteve/notesutils/blob/master/notes.md
 * says the repeated field 3 is "a sequence clock, length, attribute clock,
 * tombstone, and children") and are an inference, not a vendor schema. So the
 * result carries self-checks (`layout`) that fail loudly when a macOS release
 * changes the layout, and {@link describeProtoShape} prints the raw field
 * structure (numbers, wire types, sizes; never text) for re-deriving it.
 *
 * Nothing here opens the Notes database or writes anything. It exists to answer
 * which replica an edit carries: the private writer edits the note as a CRDT
 * replica, and a writer that minted a replica per process would grow this
 * table on every write.
 *
 * @module utils/noteReplicaTable
 */

import { gunzipSync } from "node:zlib";
import { decodeWireFields, type WireField } from "./protobuf.js";

/** One replica in the note's vector timestamp. */
export interface NoteReplica {
  /** Position in the vector timestamp's clock list. */
  index: number;
  /** Replica UUID, upper-case and dashed. */
  uuid: string;
  /**
   * The highest counter in the replica's clock entry. When a clock entry has
   * several sub-clocks this is the largest of them; all are in `subClocks`.
   */
  clock: number;
  /** The counter of every sub-clock in the clock entry, in order. */
  subClocks: number[];
  /** Characters (live and deleted) whose character ID names this replica. */
  chars: number;
  /** Live characters among `chars`. */
  liveChars: number;
  /** Substring records whose character ID names this replica. */
  substrings: number;
}

/** Self-checks that tell a reader whether the inferred layout still holds. */
export interface ReplicaTableLayout {
  /** Sum of the lengths of substrings that are not tombstoned. */
  liveChars: number;
  /** UTF-16 length of the note text. */
  textUtf16: number;
  /** `liveChars === textUtf16`: the substring lengths and tombstones decode correctly. */
  lengthsMatchText: boolean;
  /**
   * Whether substring replica IDs index the clock list from 0 or from 1
   * (1 when no character-owner reference is 0 and the highest equals the list length).
   * The paired zero-length start/end sentinels are not character owners. `null`
   * when nothing in the note settles it.
   */
  indexBase: 0 | 1 | null;
  /** Replica IDs referenced by substrings that match no clock entry. */
  unmappedReplicaIds: number[];
  /** Problems found with the layout; empty when every check passed. */
  warnings: string[];
}

export interface NoteReplicaTable {
  replicas: NoteReplica[];
  substrings: number;
  layout: ReplicaTableLayout;
}

const MAX_COMPRESSED_OUTPUT = 32 * 1024 * 1024;

const field = (fields: WireField[], n: number): WireField | undefined =>
  fields.find((f) => f.fieldNumber === n);
const all = (fields: WireField[], n: number): WireField[] =>
  fields.filter((f) => f.fieldNumber === n);
const message = (f: WireField | undefined): WireField[] | undefined =>
  f?.wireType === 2 && f.bytes ? decodeWireFields(f.bytes) : undefined;
const int = (f: WireField | undefined): number | undefined =>
  f?.wireType === 0 && f.varint !== undefined ? Number(f.varint) : undefined;

/** Formats 16 bytes as an upper-case dashed UUID. */
export function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Locates the note's topotext String inside a decompressed `Document`. */
function noteString(plain: Uint8Array): WireField[] {
  const root = decodeWireFields(plain);
  const version = message(field(root, 2));
  const body = version && message(field(version, 3));
  if (!body || field(body, 2)?.wireType !== 2)
    throw new Error("Unsupported Notes document structure");
  return body;
}

/**
 * Decodes the replica table of one note from its decompressed `ZDATA`
 * protobuf. Throws when the document is not a note body or the vector
 * timestamp is missing; layout drift that still decodes is reported in
 * `layout.warnings` instead.
 */
export function parseNoteReplicaTableFromPlain(plain: Uint8Array): NoteReplicaTable {
  const body = noteString(plain);
  const textBytes = field(body, 2)?.bytes ?? new Uint8Array();
  const textUtf16 = new TextDecoder("utf-8", { ignoreBOM: true }).decode(textBytes).length;

  const clockEntries = all(message(field(body, 4)) ?? [], 1);
  if (clockEntries.length === 0) throw new Error("The note has no vector timestamp");
  const replicas: NoteReplica[] = clockEntries.map((entry, index) => {
    const fields = message(entry);
    const uuidBytes = fields && field(fields, 1)?.bytes;
    if (!fields || !uuidBytes || uuidBytes.length !== 16)
      throw new Error("A vector timestamp clock has no 16-byte replica UUID");
    // Each sub-clock holds its counter in field 2; when a sub-clock has no
    // field 2, every varint it carries is kept so nothing is silently dropped.
    const subClocks: number[] = [];
    for (const sub of all(fields, 2)) {
      const nested = message(sub);
      if (!nested) continue;
      const counter = int(field(nested, 2));
      if (counter !== undefined) subClocks.push(counter);
      else for (const f of nested) if (f.wireType === 0) subClocks.push(Number(f.varint));
    }
    return {
      index,
      uuid: formatUuid(uuidBytes),
      clock: subClocks.length ? Math.max(...subClocks) : 0,
      subClocks,
      chars: 0,
      liveChars: 0,
      substrings: 0,
    };
  });

  const warnings: string[] = [];
  const substrings = all(body, 3);
  const records: Array<{ replicaId: number; clock: number; length: number; live: boolean }> = [];
  for (const record of substrings) {
    const fields = message(record);
    const charId = fields && message(field(fields, 1));
    const replicaId = (charId && int(field(charId, 1))) ?? 0;
    const clock = (charId && int(field(charId, 2))) ?? 0;
    const length = (fields && int(field(fields, 2))) ?? 0;
    const tombstone = (fields && int(field(fields, 4))) ?? 0;
    records.push({ replicaId, clock, length, live: tombstone === 0 });
  }

  // Notes can wrap the substring sequence in two structural sentinels:
  // replica 0 / clock 0 at the start, and replica 0 / clock UINT32_MAX at
  // the end, both live and zero-length. They do not name vector-clock
  // entries. Counting their zero IDs as indexing evidence shifted every
  // one-based owner and left the last replica's characters unmapped.
  // Recognize only this complete boundary pair; arbitrary zero-length
  // records still participate in the normal diagnostics.
  const first = records[0];
  const last = records.at(-1);
  const hasBoundarySentinels =
    records.length >= 2 &&
    first.replicaId === 0 &&
    first.clock === 0 &&
    first.length === 0 &&
    first.live &&
    last?.replicaId === 0 &&
    last.clock === 0xffffffff &&
    last.length === 0 &&
    last.live;
  const owners = hasBoundarySentinels ? records.slice(1, -1) : records;
  const maxRef = owners.reduce((max, r) => Math.max(max, r.replicaId), -1);
  const minRef = owners.reduce((min, r) => Math.min(min, r.replicaId), Infinity);
  let indexBase: 0 | 1 | null = null;
  if (owners.length > 0) {
    if (minRef === 0) indexBase = 0;
    else if (maxRef === replicas.length) indexBase = 1;
  }
  const base = indexBase ?? 0;
  const unmapped = new Set<number>();
  let liveChars = 0;
  for (const r of owners) {
    const replica = replicas[r.replicaId - base];
    if (!replica) {
      unmapped.add(r.replicaId);
      continue;
    }
    replica.substrings += 1;
    replica.chars += r.length;
    if (r.live) replica.liveChars += r.length;
  }
  for (const r of records) if (r.live) liveChars += r.length;

  const lengthsMatchText = liveChars === textUtf16;
  if (!lengthsMatchText)
    warnings.push(
      `Live substring lengths sum to ${liveChars} but the text is ${textUtf16} UTF-16 units; ` +
        "the substring layout (fields 3.2 and 3.4) may have changed"
    );
  const unmappedIds = [...unmapped].sort((a, b) => a - b);
  if (unmappedIds.length)
    warnings.push(`Substrings reference replica IDs with no clock entry: ${unmappedIds.join(",")}`);
  if (records.length === 0) warnings.push("The note has no substring records");

  return {
    replicas,
    substrings: records.length,
    layout: {
      liveChars,
      textUtf16,
      lengthsMatchText,
      indexBase,
      unmappedReplicaIds: unmappedIds,
      warnings,
    },
  };
}

/** Decodes the replica table from the gzipped `ZICNOTEDATA.ZDATA` blob. */
export function parseNoteReplicaTable(compressed: Uint8Array): NoteReplicaTable {
  return parseNoteReplicaTableFromPlain(
    gunzipSync(compressed, { maxOutputLength: MAX_COMPRESSED_OUTPUT })
  );
}

/**
 * One line per distinct field path of a message tree: field number, wire type,
 * occurrence count and, for length-delimited fields, the total byte size and
 * whether it decodes as a nested message. Text is never printed. Use it to
 * re-derive the layout when `layout.warnings` is not empty.
 */
export function describeProtoShape(plain: Uint8Array, maxDepth = 6): string[] {
  const stats = new Map<string, { wire: number; count: number; bytes: number; nested: boolean }>();
  const walk = (fields: WireField[], path: string, depth: number): void => {
    for (const f of fields) {
      const key = `${path}.${f.fieldNumber}`;
      let nested: WireField[] | undefined;
      if (f.wireType === 2 && f.bytes && depth < maxDepth && f.bytes.length > 0) {
        try {
          nested = decodeWireFields(f.bytes);
        } catch {
          nested = undefined;
        }
        // A string or UUID can decode as a message by accident; treat only
        // fully-consumed, small-field-number decodes as nested messages.
        if (nested && nested.some((n) => n.fieldNumber > 64)) nested = undefined;
      }
      const entry = stats.get(key) ?? {
        wire: f.wireType,
        count: 0,
        bytes: 0,
        nested: nested !== undefined,
      };
      entry.count += 1;
      entry.bytes += f.bytes?.length ?? 0;
      entry.nested = entry.nested || nested !== undefined;
      stats.set(key, entry);
      if (nested) walk(nested, key, depth + 1);
    }
  };
  walk(decodeWireFields(plain), "", 0);
  return [...stats.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(
      ([path, s]) =>
        `${path.slice(1)} wire=${s.wire} count=${s.count}` +
        (s.wire === 2 ? ` bytes=${s.bytes}${s.nested ? " message" : ""}` : "")
    );
}
