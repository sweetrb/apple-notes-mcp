#!/usr/bin/env node
/** Real NotesShared writes against a fresh synthetic store; no personal store input.
 * Keeps evidence in a new private temporary directory. Never copies/discovers a
 * live store, overrides HOME, grants permissions, or calls Notes.app automation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  buildSyntheticNotePayload,
  text,
  noteIdentifier,
  replicaIdentifier,
} from "./lib/synthetic-note-payload.mjs";
import { readSingleLinkFile } from "./lib/synthetic-fixture-files.mjs";

if (process.argv.length !== 2)
  throw new Error("This fixture test accepts no paths or private input");
if (process.platform !== "darwin") throw new Error("Real Notes model validation requires macOS");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync("/private/tmp/apple-notes-synthetic-fixture-"));
chmodSync(root, 0o700);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const persist = (name, value) =>
  writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const report = {
  schemaVersion: 1,
  kind: "generated-synthetic-store",
  syntheticOnly: true,
  personalStoreRead: false,
  fixtureSeedPublic: true,
  nativeOutputPrivacyReviewed: false,
  tests: [],
  completed: false,
};
persist("report.json", report);
function command(binary, args, options = {}) {
  const r = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (r.error || r.status !== 0)
    throw new Error(`${binary} failed: ${r.error?.message ?? r.status}; ${r.stderr ?? ""}`);
  return r;
}
function test(name, fn) {
  fn();
  report.tests.push(name);
  persist("report.json", report);
}
const privateUser = join(root, "isolated-user");
mkdirSync(join(privateUser, "Library/Preferences"), { recursive: true, mode: 0o700 });
mkdirSync(join(root, "tmp"), { mode: 0o700 });
const profile = join(root, "fixture.sb");
// Allow runtime primitive operations but deny every filesystem path except
// explicit system files + this fresh root. All Mach services and network are
// denied, including cfprefsd (whose daemon could write outside the sandbox).
writeFileSync(
  profile,
  `(version 1)\n(allow default)\n(deny network*)\n(deny mach-lookup)\n(deny mach-register)\n` +
    `(deny file-read* (require-not (require-any (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") ` +
    `(subpath "/private/etc") (subpath "/Library/Apple") (literal "/") (literal "/private") (literal "/private/tmp") ` +
    `(literal "/tmp") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${JSON.stringify(root)}))))\n` +
    `(deny file-write* (require-not (subpath ${JSON.stringify(root)})))\n`,
  { mode: 0o600 }
);
const childEnv = { ...process.env, CFFIXED_USER_HOME: privateUser, TMPDIR: join(root, "tmp") };
for (const key of Object.keys(childEnv))
  if (key.startsWith("APPLE_NOTES_MCP_")) delete childEnv[key];
const sandbox = (binary, args = [], options = {}) =>
  command("/usr/bin/sandbox-exec", ["-f", profile, binary, ...args], {
    ...options,
    env: { ...childEnv, ...options.env },
    cwd: root,
  });
const compile = (source, output, frameworks) =>
  command("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    ...frameworks.flatMap((name) => ["-framework", name]),
    source,
    "-o",
    output,
  ]);
try {
  const probe = join(root, "isolation-probe");
  compile(join(repo, "scripts/lib/replica-isolation-probe.m"), probe, ["Foundation"]);
  report.isolation = JSON.parse(sandbox(probe).stdout);
  test("filesystem, preference-service, network and fixed-home preflight", () => {
    for (const key of [
      "realHomeDenied",
      "globalPreferencesDenied",
      "preferencesDaemonDenied",
      "networkDenied",
      "fixedUserHomeVerified",
      "productionBundleVerified",
    ])
      assert.equal(report.isolation[key], true);
    assert.notEqual(privateUser, homedir());
    assert.equal(childEnv.HOME, process.env.HOME);
  });
  const payload = buildSyntheticNotePayload();
  const payloadPath = join(root, "generated-baseline.gz");
  writeFileSync(payloadPath, payload, { mode: 0o600 });
  report.baselinePayloadSha256 = hash(payload);
  const generator = join(root, "generator");
  const generatorSource = join(repo, "test/native/synthetic-notes-store.m");
  const modelPath =
    "/System/Library/PrivateFrameworks/NotesShared.framework/Resources/NoteData.mom";
  const generatorBytes = readFileSync(generatorSource);
  assert.ok(
    generatorBytes.includes(Buffer.from(modelPath)),
    "generator uses the recorded system model"
  );
  report.model = {
    path: modelPath,
    resolvedPath: realpathSync(modelPath),
    sha256: hash(readFileSync(modelPath)),
  };
  compile(generatorSource, generator, ["Foundation", "CoreData"]);
  report.generatorBinarySha256 = hash(readFileSync(generator));
  const store = join(root, "NoteStore.sqlite");
  const generated = sandbox(generator, [store, payloadPath, noteIdentifier, replicaIdentifier]);
  writeFileSync(join(root, "generator.stderr"), generated.stderr, { mode: 0o600 });
  report.generator = JSON.parse(generated.stdout);
  report.generatorSourceSha256 = hash(generatorBytes);
  const initialStoreBytes = readSingleLinkFile(store);
  const sqlite = (query) => command("/usr/bin/sqlite3", ["-readonly", store, query]).stdout.trim();
  const body = () => Buffer.from(sqlite("SELECT hex(ZDATA) FROM ZICNOTEDATA;"), "hex");
  test("one synthetic note, account and folder; no attachments; exact baseline", () => {
    assert.deepEqual(report.generator, {
      created: true,
      frameworkLoaded: false,
      notes: 1,
      accounts: 1,
      folders: 1,
    });
    assert.equal(sqlite("PRAGMA integrity_check;"), "ok");
    assert.equal(sqlite("SELECT count(*) FROM ZICNOTEDATA;"), "1");
    assert.equal(sqlite("SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT;"), "3");
    assert.equal(
      sqlite("SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZTYPEUTI IS NOT NULL;"),
      "0"
    );
    assert.equal(hash(body()), hash(payload));
    assert.ok(!existsSync(store + "-wal") && !existsSync(store + "-shm"));
    assert.ok(!initialStoreBytes.includes(Buffer.from(process.env.HOME ?? "/Users/")));
    assert.ok(!initialStoreBytes.includes(Buffer.from("group.com.apple.notes")));
  });
  // The generator has closed the journal-free database and no writer has run.
  report.initialStoreSha256 = hash(initialStoreBytes);
  const decoder = join(root, "decoder.mjs");
  // Import only pure decoders. No store reader or Notes.app API is called;
  // their input is the fresh synthetic store's explicitly selected ZDATA.
  const decoderEntry = [
    ["parseNoteReplicaTable", "noteReplicaTable.ts"],
    ["decodeNoteBody", "noteQueryStore.ts"],
    ["decodeNoteBlocks", "noteBlocks.ts"],
  ]
    .map(
      ([name, file]) => `export { ${name} } from ${JSON.stringify(join(repo, "src/utils", file))};`
    )
    .join("\n");
  command(
    join(repo, "node_modules/.bin/esbuild"),
    [
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--tsconfig=${join(repo, "tsconfig.json")}`,
      `--outfile=${decoder}`,
      "--log-level=error",
    ],
    { input: decoderEntry }
  );
  const { parseNoteReplicaTable, decodeNoteBody, decodeNoteBlocks } = await import(
    pathToFileURL(decoder).href
  );
  const checkDecoded = (expectedText) => {
    const stored = body();
    const plain = gunzipSync(stored);
    assert.equal(
      decodeNoteBody(plain)?.text,
      expectedText,
      "independent stored plaintext equals the entire expected body"
    );
    const blocks = decodeNoteBlocks(plain);
    assert.equal(blocks.text, expectedText, "strict block decoder agrees on the complete body");
    const table = parseNoteReplicaTable(stored);
    assert.equal(table.layout.lengthsMatchText, true);
    assert.deepEqual(table.layout.warnings, []);
    assert.deepEqual(table.layout.unmappedReplicaIds, []);
    return { table, blocks };
  };
  test("generated CRDT has exact text length and one synthetic owner", () => {
    const { table } = checkDecoded(text);
    assert.equal(table.layout.textUtf16, text.length);
    assert.deepEqual(
      table.replicas.map((row) => row.uuid),
      [replicaIdentifier]
    );
  });
  const writer = join(root, "writer");
  const writerSource = join(repo, "native/private-helper/apple-notes-private-writer.m");
  compile(writerSource, writer, ["Foundation", "CoreData", "AppKit", "PencilKit"]);
  report.writerSourceSha256 = hash(readFileSync(writerSource));
  report.writerBinarySha256 = hash(readFileSync(writer));
  const writerEnv = { APPLE_NOTES_MCP_ENABLE_PRIVATE: "1", APPLE_NOTES_MCP_PRIVATE_STORE: store };
  let invocation = 0;
  function call(action, fields = {}, feature, expectedError) {
    invocation++;
    const env = { ...writerEnv };
    if (feature) env[`APPLE_NOTES_MCP_ALLOW_UNVERIFIED_${feature}`] = "1";
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, writer], {
      encoding: "utf8",
      timeout: 120000,
      env: { ...childEnv, ...env },
      cwd: root,
      input: JSON.stringify({ protocol: 1, action, ...fields }),
    });
    writeFileSync(join(root, `writer-${invocation}.stderr`), result.stderr ?? "", { mode: 0o600 });
    if (result.error) throw result.error;
    const response = JSON.parse(result.stdout);
    persist(`writer-${invocation}.json`, response);
    if (expectedError) {
      assert.equal(result.status, 1);
      assert.equal(response.code, expectedError);
      assert.equal(response.committed, false);
    } else {
      assert.equal(result.status, 0, JSON.stringify(response));
      assert.notEqual(response.status, "error");
      // read_note_state has no storeKind field in the native protocol. Every
      // write or plan must explicitly confirm that it opened the copy store.
      if (action !== "read_note_state") assert.equal(response.storeKind, "copy");
      assert.equal(response.identifier, noteIdentifier);
    }
    return response;
  }
  const read = () => call("read_note_state", { identifier: noteIdentifier });
  let state = read();
  test("actual NotesShared opens generated model, body and editable note", () => {
    assert.equal(state.bodyLengthUTF16, text.length);
    assert.equal(state.editable, true);
    assert.equal(state.bodyAvailable, true);
  });
  test("direct writer append refuses absent feature opt-in without mutation", () => {
    call(
      "append_plain_text",
      { identifier: noteIdentifier, ifRevision: state.revision, text: "GATED" },
      undefined,
      "not_live_validated"
    );
    assert.equal(read().revision, state.revision);
    checkDecoded(text);
  });
  const appendText = "SYNTHETIC APPEND PROOF";
  const afterAppend = text + appendText;
  test("actual append preserves the baseline and stores exactly the requested text", () => {
    const changed = call(
      "append_plain_text",
      { identifier: noteIdentifier, ifRevision: state.revision, text: appendText },
      "APPEND"
    );
    assert.equal(changed.committed, true);
    assert.equal(changed.verified, true);
    state = read();
    assert.equal(state.bodyLengthUTF16, afterAppend.length);
    checkDecoded(afterAppend);
  });
  const compose = {
    identifier: noteIdentifier,
    mode: "append",
    paragraphs: [
      { style: "heading", runs: [{ text: "Synthetic heading" }] },
      { style: "body", runs: [{ text: "Synthetic rich text", bold: true }] },
    ],
  };
  const plan = call("compose_note", { ...compose, dryRun: true });
  test("compose dry run returns digest and leaves revision unchanged", () => {
    assert.equal(plan.status, "planned");
    assert.match(plan.planDigest, /^c1:[0-9a-f]{64}$/);
    assert.equal(read().revision, state.revision);
    checkDecoded(afterAppend);
  });
  test("compose refuses missing/mismatched digest and preserves revision", () => {
    call("compose_note", { ...compose, ifRevision: state.revision }, "COMPOSE", "invalid_request");
    call(
      "compose_note",
      { ...compose, ifRevision: state.revision, ifPlanDigest: "c1:" + "0".repeat(64) },
      "COMPOSE",
      "plan_mismatch"
    );
    assert.equal(read().revision, state.revision);
    checkDecoded(afterAppend);
  });
  const afterCompose = afterAppend + "\nSynthetic heading\nSynthetic rich text";
  test("real rich compose preserves prior text and stores exact heading and bold runs", () => {
    const changed = call(
      "compose_note",
      { ...compose, ifRevision: state.revision, ifPlanDigest: plan.planDigest },
      "COMPOSE"
    );
    assert.equal(changed.committed, true);
    assert.equal(changed.verified, true);
    assert.notEqual(read().revision, state.revision);
    const { blocks } = checkDecoded(afterCompose);
    const added = blocks.blocks.filter((block) => block.start >= afterAppend.length + 1);
    assert.equal(added.length, 2, "exactly two composed paragraphs");
    const [heading, rich] = added;
    assert.deepEqual(
      [heading.text, heading.start, heading.length, heading.style, heading.styleType],
      ["Synthetic heading", afterAppend.length + 1, "Synthetic heading".length, "heading", 1]
    );
    assert.deepEqual(
      [rich.text, rich.start, rich.length, rich.style],
      [
        "Synthetic rich text",
        afterAppend.length + 1 + "Synthetic heading\n".length,
        "Synthetic rich text".length,
        "body",
      ]
    );
    for (const block of added) {
      assert.ok(block.runs.length > 0, "composed paragraph has stored attribute runs");
      assert.equal(
        block.runs.map((run) => run.text).join(""),
        block.text,
        "runs cover exactly the requested text"
      );
      let next = block.start;
      for (const run of block.runs) {
        assert.equal(run.start, next, "no missing or overlapping styled characters");
        assert.equal(run.length, run.text.length);
        if (block === rich)
          assert.equal(run.bold, true, "every rich-text character is stored bold");
        next += run.length;
      }
      assert.equal(next, block.start + block.length);
    }
  });
  test("final store integrity and exact synthetic population remain intact", () => {
    assert.equal(sqlite("PRAGMA integrity_check;"), "ok");
    assert.equal(sqlite("SELECT count(*) FROM ZICNOTEDATA;"), "1");
    assert.equal(sqlite("SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT;"), "3");
  });
  report.osVersion = command("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim();
  report.completed = true;
  report.limitations = [
    "Copy-store evidence only; no live editor merge or cloud upload proof.",
    "Preference daemon access is denied; this does not prove persistent preference behavior.",
    "Native output remains local until reviewed; only the generated baseline is designed as public fixture data.",
  ];
  persist("report.json", report);
  console.log(
    `Synthetic store checks passed (${report.tests.length}); private evidence: ${join(root, "report.json")}`
  );
} catch (error) {
  report.error = error.message;
  persist("report.json", report);
  console.error(
    `Synthetic store checks failed; private evidence: ${join(root, "report.json")}\n${error.message}`
  );
  process.exitCode = 1;
}
