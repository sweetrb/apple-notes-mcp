#!/usr/bin/env node
/** Read only explicit, previously authorized synthetic snapshots; never open a Notes store. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createNotesAppControl } from "./lib/replica-identity-evidence.mjs";

const flags = [
  "--before-json",
  "--after-json",
  "--before-payload",
  "--after-payload",
  "--gui-receipt",
  "--output",
];
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`usage: ${flags.map((flag) => `${flag} PRIVATE_PATH`).join(" ")}`);
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!flags.includes(args[i]) || !args[i + 1] || options[args[i]])
    throw new Error("Invalid arguments; use --help");
  options[args[i]] = resolve(args[i + 1]);
}
if (flags.some((flag) => !options[flag]))
  throw new Error("Every explicit path is required; use --help");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Build in memory. The decoder only receives the two explicitly supplied blobs.
const compiled = await build({
  stdin: {
    contents: `
import { gunzipSync } from 'node:zlib';
import { parseNoteReplicaTable } from './src/utils/noteReplicaTable.ts';
import { decodeWireFields } from './src/utils/protobuf.ts';
export function decodeSnapshot(bytes) {
  let fields = decodeWireFields(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }));
  for (const n of [2, 3]) {
    const field = fields.find(f => f.fieldNumber === n && f.wireType === 2);
    if (!field?.bytes) throw new Error('Unsupported Notes payload');
    fields = decodeWireFields(field.bytes);
  }
  const field = fields.find(f => f.fieldNumber === 2 && f.wireType === 2);
  if (!field?.bytes) throw new Error('Missing note text');
  return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(field.bytes), replicaTable: parseNoteReplicaTable(bytes) };
}`,
    resolveDir: repo,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { decodeSnapshot } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforePayload = readFileSync(options["--before-payload"]);
const afterPayload = readFileSync(options["--after-payload"]);
const before = JSON.parse(readFileSync(options["--before-json"], "utf8"));
const after = JSON.parse(readFileSync(options["--after-json"], "utf8"));
for (const [snapshot, bytes] of [
  [before, beforePayload],
  [after, afterPayload],
]) {
  const decoded = decodeSnapshot(bytes);
  assert.equal(hash(bytes) === snapshot.payloadSha256, true, "Snapshot provenance hash differs");
  assert.equal(
    decoded.text === snapshot.text,
    true,
    "Snapshot text differs from the supplied blob"
  );
  // Do not put potentially identifying tables in assertion diagnostic output.
  assert.equal(
    JSON.stringify(decoded.replicaTable) === JSON.stringify(snapshot.replicaTable),
    true,
    "Snapshot replica table differs from the supplied blob"
  );
}
const receiptBytes = readFileSync(options["--gui-receipt"]);
const control = createNotesAppControl({
  before,
  after,
  receipt: JSON.parse(receiptBytes),
  beforePayloadSha256: hash(beforePayload),
  afterPayloadSha256: hash(afterPayload),
  receiptSha256: hash(receiptBytes),
});
writeFileSync(options["--output"], JSON.stringify(control, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: "verified",
    appendedUTF16: control.appendedUTF16,
    activeReplicaCount: control.ownerUuids.length,
    privateControl: options["--output"],
  })
);
