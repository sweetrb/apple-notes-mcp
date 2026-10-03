import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
  buildSyntheticNotePayload,
  noteIdentifier,
  paragraphIdentifier,
  replicaIdentifier,
  text,
} from "./synthetic-note-payload.mjs";

// Independent strict wire reader: malformed/trailing bytes fail instead of
// being silently ignored. Only the fixture's declared wire types are accepted.
function fields(buffer) {
  let offset = 0;
  const result = [];
  function varint() {
    let value = 0;
    let factor = 1;
    for (let count = 0; count < 10; count++) {
      assert.ok(offset < buffer.length, "complete varint");
      const byte = buffer[offset++];
      value += (byte & 127) * factor;
      assert.ok(Number.isSafeInteger(value), "fixture integers are safe");
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    assert.fail("overlong varint");
  }
  while (offset < buffer.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    assert.ok(field > 0);
    let value;
    if (wire === 0) value = varint();
    else {
      assert.ok(wire === 2 || wire === 5, "declared fixture wire type");
      const length = wire === 2 ? varint() : 4;
      assert.ok(offset + length <= buffer.length, "complete field bytes");
      value = buffer.subarray(offset, offset + length);
      offset += length;
    }
    result.push({ field, wire, value });
  }
  return result;
}
const all = (message, field) => message.filter((item) => item.field === field);
const one = (message, field) => {
  const found = all(message, field);
  assert.equal(found.length, 1, `one field ${field}`);
  return found[0].value;
};
const idBytes = (id) => Buffer.from(id.replaceAll("-", ""), "hex");
function document() {
  const plain = gunzipSync(buildSyntheticNotePayload());
  const root = fields(plain);
  const version = fields(one(root, 2));
  return { plain, root, version, body: fields(one(version, 3)) };
}

test("fixture is deterministic, accepts no external input, and returns fresh bytes", () => {
  const first = buildSyntheticNotePayload();
  const second = buildSyntheticNotePayload();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(first[3], 0, "no optional filename, comment, or other gzip header");
  assert.equal(first.readUInt32LE(4), 0, "no capture timestamp");
  assert.equal(first[9], 255, "no host OS marker");
  assert.throws(() => buildSyntheticNotePayload(Buffer.from("saved data")), /accepts no input/);
  assert.throws(() => buildSyntheticNotePayload({ text: "override" }), /accepts no input/);
});

test("every character and attribute reference belongs to the fixed synthetic graph", () => {
  const { body } = document();
  assert.equal(one(body, 2).toString("utf8"), text);
  assert.equal(text.length, 184);
  assert.equal(Buffer.byteLength(text), 184);
  const records = all(body, 3).map(({ value }) => fields(value));
  assert.equal(records.length, 8);
  const owners = records.slice(1, -1);
  const ranges = owners.map((record) => {
    const owner = fields(one(record, 1));
    const attribute = fields(one(record, 3));
    assert.equal(one(owner, 1), 1);
    assert.equal(one(attribute, 1), 1);
    assert.ok(one(attribute, 2) >= 0 && one(attribute, 2) < 3);
    return { start: one(owner, 2), length: one(record, 2) };
  });
  let end = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    assert.equal(range.start, end, "character clock coverage has no gaps or overlaps");
    end += range.length;
  }
  assert.equal(end, text.length);
  for (const [index, record] of records.entries()) {
    assert.equal(all(record, 4).length, 0, "no hidden tombstoned content");
    if (index < records.length - 1) assert.equal(one(record, 5), index + 1);
    else assert.equal(all(record, 5).length, 0);
  }
  for (const [record, counter] of [
    [records[0], 0],
    [records.at(-1), 0xffffffff],
  ]) {
    assert.equal(one(record, 2), 0);
    for (const key of [1, 3]) {
      const id = fields(one(record, key));
      assert.equal(one(id, 1), 0);
      assert.equal(one(id, 2), counter);
    }
  }
  const clocks = fields(one(body, 4));
  const replica = fields(one(clocks, 1));
  assert.deepEqual(one(replica, 1), idBytes(replicaIdentifier));
  assert.deepEqual(
    all(replica, 2).map(({ value }) => one(fields(value), 1)),
    [end, 3]
  );
});

test("all payload leaves are allowlisted public text, identifiers, or numeric state", () => {
  const { plain, root, version, body } = document();
  const schema = (message, allowed) => {
    for (const item of message) {
      assert.equal(item.wire, allowed[item.field], `known field ${item.field} wire type`);
    }
  };
  schema(root, { 1: 0, 2: 2 });
  schema(version, { 1: 0, 2: 0, 3: 2 });
  schema(body, { 2: 2, 3: 2, 4: 2, 5: 2 });
  for (const { value } of all(body, 3)) {
    const record = fields(value);
    schema(record, { 1: 2, 2: 0, 3: 2, 5: 0 });
    for (const key of [1, 3]) schema(fields(one(record, key)), { 1: 0, 2: 0 });
  }
  const timestamp = fields(one(body, 4));
  schema(timestamp, { 1: 2 });
  const replica = fields(one(timestamp, 1));
  schema(replica, { 1: 2, 2: 2 });
  assert.deepEqual(one(replica, 1), idBytes(replicaIdentifier));
  for (const { value } of all(replica, 2)) schema(fields(value), { 1: 0 });
  const runs = all(body, 5).map(({ value }) => fields(value));
  assert.equal(runs.length, 6);
  assert.equal(
    runs.reduce((sum, run) => sum + one(run, 1), 0),
    text.length
  );
  for (const run of runs) {
    schema(run, { 1: 0, 2: 2, 3: 2, 5: 0, 13: 0 });
    const style = fields(one(run, 2));
    schema(style, { 3: 0, 9: 2 });
    assert.deepEqual(one(style, 9), idBytes(paragraphIdentifier));
    for (const { value } of all(run, 13)) assert.ok([1700000000, 1700000001].includes(value));
    for (const { value } of all(run, 3)) {
      const font = fields(value);
      schema(font, { 1: 2, 2: 5, 3: 0 });
      assert.equal(one(font, 1).toString("utf8"), ".AppleSystemUIFontBold");
      assert.equal(one(font, 2).readFloatLE(), 24);
      assert.equal(one(font, 3), 1);
    }
  }
  assert.equal(plain.length, 587);
  assert.equal(new Set([noteIdentifier, paragraphIdentifier, replicaIdentifier]).size, 3);
  for (const id of [noteIdentifier, paragraphIdentifier, replicaIdentifier]) {
    assert.match(id, /^[1-3]{8}-[1-3]{4}-4[1-3]{3}-8[1-3]{3}-[1-3]{12}$/);
  }
});
