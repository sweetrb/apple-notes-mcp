/** Read-only table decoding. Wire-field reference:
 * https://github.com/threeplanetssoftware/apple_cloud_notes_parser/blob/master/proto/notestore.proto
 * Resolves CRDT row/column aliases; unknown or embedded-cell content is reported incomplete.
 */
import { gunzipSync } from "node:zlib";
import {
  decodeMessage,
  embeddedMessage,
  getField,
  getFields,
  stringValue,
  varintValue,
  type ProtoField,
} from "./protobuf.js";
type Fields = ProtoField[];
const sub = (f: Fields, n: number): Fields => {
  const value = embeddedMessage(getField(f, n));
  if (!value) throw new Error(`Missing table field ${n}`);
  return value;
};
const num = (f: Fields, n: number): number => {
  const v = varintValue(getField(f, n));
  if (v === undefined) throw new Error(`Missing table index ${n}`);
  return v;
};
const many = (f: Fields, n: number) =>
  getFields(f, n).map((v) => {
    const m = embeddedMessage(v);
    if (!m) throw new Error("Invalid table entry");
    return m;
  });
const hex = (f: ProtoField | undefined) => {
  if (!(f?.value instanceof Uint8Array)) throw new Error("Missing table UUID");
  return Buffer.from(f.value).toString("hex");
};
/** Decode a complete native Notes table, including stable row and column IDs. */
export function parseNoteTable(compressed: Uint8Array): {
  rows: string[][];
  rowIds: string[];
  columnIds: string[];
} {
  const root = decodeMessage(gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }));
  const data = sub(sub(root, 2), 3),
    entries = many(data, 3);
  if (entries.length > 100000) throw new Error("Table too large");
  const keys = getFields(data, 4).map(stringValue),
    types = getFields(data, 5).map(stringValue),
    uuids = getFields(data, 6).map(hex);
  const entry = (index: number) => {
    if (!entries[index]) throw new Error("Invalid table reference");
    return entries[index];
  };
  const uuidIndex = (index: number) => num(sub(many(sub(entry(index), 13), 3)[0], 2), 2);
  const roots = entries.filter((e) => {
    const map = embeddedMessage(getField(e, 13));
    return map && types[num(map, 1)] === "com.apple.notes.ICTable";
  });
  if (roots.length !== 1) throw new Error("Ambiguous native table root");
  const refs = new Map(
    many(sub(roots[0], 13), 3)
      .filter((m) => ["crRows", "crColumns", "cellColumns"].includes(keys[num(m, 1)] || ""))
      .map((m) => [keys[num(m, 1)], num(sub(m, 2), 6)])
  );
  const ordered = (key: string) => {
    const ref = refs.get(key);
    if (ref === undefined) throw new Error("Missing table dimension");
    const ordering = sub(sub(entry(ref), 16), 1),
      array = sub(ordering, 1);
    const ids = many(array, 2).map((a) => hex(getField(a, 2)));
    const map = new Map<number, number>();
    ids.forEach((id, i) => {
      const index = uuids.indexOf(id);
      if (index < 0) throw new Error("Missing dimension UUID");
      map.set(index, i);
    });
    const aliases = many(sub(ordering, 2), 1).map((pair) => [
      uuidIndex(num(sub(pair, 1), 6)),
      uuidIndex(num(sub(pair, 2), 6)),
    ]);
    for (let pass = 0; pass < aliases.length + 1; pass++) {
      let changed = false;
      for (const [key, value] of aliases)
        if (map.has(key) && !map.has(value)) {
          map.set(value, map.get(key)!);
          changed = true;
        }
      if (!changed) break;
    }
    return { ids, map };
  };
  const rows = ordered("crRows"),
    columns = ordered("crColumns");
  if (!rows.ids.length || !columns.ids.length || rows.ids.length * columns.ids.length > 100000)
    throw new Error("Unsupported table size");
  const values = rows.ids.map(() => columns.ids.map(() => ""));
  const cellRef = refs.get("cellColumns");
  if (cellRef === undefined) throw new Error("Missing table cells");
  for (const column of many(sub(entry(cellRef), 6), 1)) {
    const ci = columns.map.get(uuidIndex(num(sub(column, 1), 6)));
    const cells = entry(num(sub(column, 2), 6));
    for (const row of many(sub(cells, 6), 1)) {
      const ri = rows.map.get(uuidIndex(num(sub(row, 1), 6)));
      if (ri === undefined || ci === undefined) continue; // deleted CRDT row/column
      const note = sub(entry(num(sub(row, 2), 6)), 10);
      const text = stringValue(getField(note, 2));
      if (text === undefined || text.includes("\ufffc"))
        throw new Error("Embedded or unsupported table cell");
      values[ri][ci] = text.replace(/\n$/u, "");
    }
  }
  const rtl = entries.some((e) => {
    const map = embeddedMessage(getField(e, 13));
    return (
      map &&
      many(map, 3).some(
        (m) => stringValue(getField(sub(m, 2), 4)) === "CRTableColumnDirectionRightToLeft"
      )
    );
  });
  if (rtl) {
    for (const row of values) row.reverse();
    columns.ids.reverse();
  }
  return { rows: values, rowIds: rows.ids, columnIds: columns.ids };
}
