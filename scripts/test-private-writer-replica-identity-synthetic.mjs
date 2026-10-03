#!/usr/bin/env node
/**
 * Q2 experiment over one dedicated synthetic Notes-model store. Never backs up
 * or discovers a personal store, never uses `defaults`, never changes HOME.
 * All private artifacts remain under the caller's private scratch fixture.
 *
 * node scripts/test-private-writer-replica-identity-synthetic.mjs \
 *   --manifest /private/tmp/fixture/manifest.json \
 *   --notes-app-payload /private/tmp/fixture/authorized-synthetic-zdata.gz
 *
 * The generator must first prove isolation and emit the manifest below. The
 * old Notes.app payload may exercise the harness, but only a controlled
 * Notes.app before/after edit attributes the application's active replica.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  assertExactAppend,
  assertReplicaTable,
  evaluateReplicaIdentity,
} from "./lib/replica-identity-evidence.mjs";
import { archiveIsolatedPreference } from "./lib/synthetic-fixture-files.mjs";

const stop = (message) => {
  throw new Error(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: --manifest PRIVATE_SYNTHETIC_MANIFEST --notes-app-payload AUTHORIZED_SYNTHETIC_ZDATA --notes-app-control PRIVATE_CONTROL_JSON"
  );
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--manifest", "--notes-app-payload", "--notes-app-control"].includes(args[i]) ||
    !args[i + 1]
  )
    stop("Unknown or incomplete arguments; use --help");
  if (options[args[i]]) stop("Duplicate argument");
  options[args[i]] = resolve(args[i + 1]);
}
if (!options["--manifest"] || !options["--notes-app-payload"] || !options["--notes-app-control"])
  stop(
    "Explicit manifest, synthetic payload, and controlled Notes.app evidence paths are required"
  );
const manifestBytes = readFileSync(options["--manifest"]);
const manifest = JSON.parse(manifestBytes);
const fixtureRoot = realpathSync(dirname(options["--manifest"]));
const allowedScratch = [...new Set(["/private/tmp", realpathSync(tmpdir())])];
if (
  !allowedScratch.some((root) => within(root, fixtureRoot)) ||
  allowedScratch.includes(fixtureRoot)
)
  stop(
    "Fixture must have its own private directory under /private/tmp or the OS temporary directory"
  );
if (
  manifest.schemaVersion !== 1 ||
  manifest.shareable !== false ||
  manifest.baselineSource !== "authorized-synthetic-snapshot" ||
  manifest.syntheticOnly !== true
)
  stop(
    "Manifest must describe a synthetic-only store seeded from the authorized Notes.app snapshot"
  );
if (!manifest.isolation?.proven || !manifest.quiescence?.verified)
  stop("Generator has not proven isolation and store quiescence; do not run Q2 yet");
const note = manifest.noteIdentifier;
if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(note))
  stop("Invalid fixture note UUID");
let store = realpathSync(manifest.storePath);
if (
  !within(fixtureRoot, store) ||
  lstatSync(manifest.storePath).isSymbolicLink() ||
  lstatSync(store).nlink !== 1
)
  stop("Store must be a regular, unlinked file within the private fixture directory");
const payloadPath = realpathSync(options["--notes-app-payload"]);
if (!within(fixtureRoot, payloadPath))
  stop("Copy only the authorized synthetic payload into the private fixture directory first");
const originalPayload = readFileSync(payloadPath);
if (manifest.baselinePayloadSha256 !== hash(originalPayload))
  stop("Payload does not match generator provenance");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repo, "native/private-helper/apple-notes-private-writer.m");
const runRoot = join(fixtureRoot, `replica-experiment-${randomUUID()}`);
mkdirSync(runRoot, { mode: 0o700 });
const prefsRoot = join(runRoot, "isolated-user");
mkdirSync(join(prefsRoot, "Library/Preferences"), { recursive: true, mode: 0o700 });
const isolatedTemp = join(runRoot, "tmp");
mkdirSync(isolatedTemp, { mode: 0o700 });
const persist = (name, value) =>
  writeFileSync(join(runRoot, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const evidence = {
  schemaVersion: 1,
  kind: "synthetic-replica-identity",
  capturedAt: new Date().toISOString(),
  fixtureManifestSha256: hash(manifestBytes),
  noteIdentifier: note,
  builds: [],
  steps: [],
  fixtureConditions: {
    accountReplicaMapConstructed:
      manifest.replicaAccountMapping?.kind === "synthetic-fixture-assumption",
    productionAccountMapInspected:
      manifest.replicaAccountMapping?.productionAccountInspected === true,
  },
  notesAppBaselineVerified: false,
  preferencesReset: null,
  isolation: null,
};
persist("private-run.json", evidence);

function command(binary, argv, config = {}) {
  const result = spawnSync(binary, argv, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    ...config,
  });
  if (result.error || result.status !== 0) {
    persist(`command-failure-${Date.now()}.json`, {
      binary,
      argv,
      status: result.status,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    stop(
      `${binary} failed (${result.status ?? result.error?.code}); private artifacts retained at ${runRoot}`
    );
  }
  return result;
}
function sqlite(query) {
  return command("/usr/bin/sqlite3", ["-readonly", store, query]).stdout.trim();
}
if (sqlite("SELECT count(*) FROM ZICNOTEDATA;") !== "1")
  stop("Synthetic store must contain exactly one note body");
const query = `SELECT hex(d.ZDATA) FROM ZICNOTEDATA d JOIN ZICCLOUDSYNCINGOBJECT n ON d.ZNOTE=n.Z_PK WHERE n.ZIDENTIFIER='${note.toUpperCase()}';`;
const loadPayload = () => {
  const hex = sqlite(query);
  if (!/^[a-f0-9]+$/i.test(hex)) stop("Missing/ambiguous synthetic note data");
  return Buffer.from(hex, "hex");
};
if (hash(loadPayload()) !== hash(originalPayload))
  stop("Store baseline differs from the authorized Notes.app payload");
// Back up only this verified, one-note synthetic fixture. Keep the generator's
// pristine source available for independent experiments and recovery.
const experimentStore = join(runRoot, "NoteStore.sqlite");
command("/usr/bin/sqlite3", [
  "-readonly",
  store,
  `.backup '${experimentStore.replaceAll("'", "''")}'`,
]);
store = experimentStore;
chmodSync(store, 0o600);
if (hash(loadPayload()) !== hash(originalPayload))
  stop("Synthetic experiment backup changed the seed payload");
evidence.notesAppBaselineVerified = true;
evidence.notesAppControl = JSON.parse(readFileSync(options["--notes-app-control"], "utf8"));
if (
  evidence.notesAppControl.noteIdentifier !== note ||
  evidence.notesAppControl.afterPayloadSha256 !== hash(originalPayload) ||
  evidence.notesAppControl.kind !== "notes-app-controlled-gui-insertion" ||
  evidence.notesAppControl.persistedReadAfterCloseVerified !== true ||
  evidence.notesAppControl.beforeSnapshotBoundToNoteAndTime !== true
)
  stop("Controlled Notes.app evidence does not match the exact synthetic store seed");
evidence.osVersion = command("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim();

// Bundle the pure decoder. It does not open any store or touch Notes.app.
const decoder = join(runRoot, "replica-decoder.mjs");
await build({
  stdin: {
    contents: `
import { gunzipSync } from "node:zlib";
import { decodeNoteBody } from "./src/utils/noteQueryStore.ts";
export { parseNoteReplicaTable } from "./src/utils/noteReplicaTable.ts";
export function decodePlaintext(bytes) {
  const body = decodeNoteBody(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }));
  if (!body || typeof body.text !== "string") throw new Error("Unsupported note plaintext");
  return body.text;
}`,
    resolveDir: repo,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: decoder,
  logLevel: "silent",
});
const { decodePlaintext, parseNoteReplicaTable } = await import(pathToFileURL(decoder).href);
if (
  JSON.stringify(parseNoteReplicaTable(originalPayload)) !==
  JSON.stringify(evidence.notesAppControl.afterTable)
)
  stop("Controlled Notes.app replica table differs from the seed");
const sourceBytes = readFileSync(source);
const sourceSha256 = hash(sourceBytes);
const sourceCopy = join(runRoot, "writer-source.m");
writeFileSync(sourceCopy, sourceBytes, { mode: 0o600 });
for (const letter of ["A", "B"]) {
  const binary = join(runRoot, `writer-${letter}`);
  const compilerInvocation = [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-framework",
    "Foundation",
    "-framework",
    "CoreData",
    "-framework",
    "AppKit",
    "-framework",
    "PencilKit",
    `-DHELPER_SOURCE_SHA256=\"${sourceSha256}\"`,
    "-o",
    binary,
    sourceCopy,
  ];
  command("/usr/bin/xcrun", compilerInvocation);
  evidence.builds.push({
    buildId: `build-${letter}`,
    sourceSha256,
    binarySha256: hash(readFileSync(binary)),
    compilerInvocation,
    binaryPath: binary,
    compiledAt: new Date().toISOString(),
  });
}

// Denying cfprefsd IPC is necessary: a daemon can otherwise perform writes
// outside this process's file sandbox. CFFIXED_USER_HOME changes Foundation's
// preference root in this isolated experiment; the ordinary HOME is untouched.
const policy = join(runRoot, "writer.sb");
const escaped = (value) => JSON.stringify(value);
const readPaths = ["/System", "/usr", "/bin", "/sbin", "/private/etc", "/Library/Apple", runRoot]
  .map((path) => `(subpath ${escaped(path)})`)
  .join(" ");
const readFiles = [
  "/",
  "/private",
  "/private/tmp",
  "/tmp",
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
  fixtureRoot,
]
  .map((path) => `(literal ${escaped(path)})`)
  .join(" ");
writeFileSync(
  policy,
  `(version 1)\n(allow default)\n(deny network*)\n(deny mach-lookup)\n(deny mach-register)\n` +
    `(deny file-read* (require-not (require-any ${readPaths} ${readFiles})))\n` +
    `(deny file-write* (require-not (subpath ${escaped(runRoot)})))\n`,
  { mode: 0o600 }
);
const childEnv = {
  ...process.env,
  CFFIXED_USER_HOME: prefsRoot,
  TMPDIR: isolatedTemp,
  APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
  APPLE_NOTES_MCP_ALLOW_UNVERIFIED_APPEND: "1",
  APPLE_NOTES_MCP_PRIVATE_STORE: store,
};
for (const key of Object.keys(childEnv)) {
  if (
    key.startsWith("APPLE_NOTES_MCP_ALLOW_UNVERIFIED_") &&
    key !== "APPLE_NOTES_MCP_ALLOW_UNVERIFIED_APPEND"
  )
    delete childEnv[key];
}
delete childEnv.APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES;
delete childEnv.APPLE_NOTES_MCP_ALLOW_NOTES_RUNNING;
delete childEnv.APPLE_NOTES_MCP_WRITER_FAULT;

// Independently check this exact child profile before loading NotesShared.
// sandbox_check inspects permission without opening a real preference file.
const isolationSource = join(repo, "scripts/lib/replica-isolation-probe.m");
const isolationSourceCopy = join(runRoot, "isolation-probe.m");
copyFileSync(isolationSource, isolationSourceCopy);
const isolationBinary = join(runRoot, "isolation-probe");
command("/usr/bin/xcrun", [
  "clang",
  "-fobjc-arc",
  "-framework",
  "Foundation",
  isolationSourceCopy,
  "-o",
  isolationBinary,
]);
const isolationResult = command("/usr/bin/sandbox-exec", ["-f", policy, isolationBinary], {
  env: childEnv,
  cwd: runRoot,
});
const checks = JSON.parse(isolationResult.stdout);
for (const key of [
  "realHomeDenied",
  "globalPreferencesDenied",
  "preferencesDaemonDenied",
  "networkDenied",
  "fixedUserHomeVerified",
  "productionBundleVerified",
])
  if (checks[key] !== true) stop(`Isolation probe did not verify ${key}`);
evidence.isolation = {
  sandboxed: true,
  ...checks,
  fixedUserHome: prefsRoot,
  policySha256: hash(readFileSync(policy)),
  probeSourceSha256: hash(readFileSync(isolationSourceCopy)),
};
persist("private-run.json", evidence);
function writer(build, request) {
  const result = command("/usr/bin/sandbox-exec", ["-f", policy, build.binaryPath], {
    input: JSON.stringify({ protocol: 1, ...request }),
    env: childEnv,
    cwd: runRoot,
  });
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    stop("Writer returned non-JSON output");
  }
  if (response.status === "error") stop(`Writer refused ${request.action}: ${response.code}`);
  return { response, processId: result.pid };
}
const snapshot = (id) => {
  const bytes = loadPayload();
  // Retain every exact body privately so another reviewer can reproduce the
  // plaintext and ownership checks without trusting this process's counters.
  writeFileSync(join(runRoot, `${id}.zdata`), bytes, { mode: 0o600, flag: "wx" });
  const table = parseNoteReplicaTable(bytes);
  const text = decodePlaintext(bytes);
  assertReplicaTable(table);
  if (text.length !== table.layout.textUtf16)
    stop(`${id} plaintext and ownership lengths disagree`);
  return { payloadSha256: hash(bytes), table, text, readAt: new Date().toISOString() };
};
let state = writer(evidence.builds[0], { action: "read_note_state", identifier: note }).response;
evidence.steps.push({
  id: "baseline",
  phase: "baseline",
  revision: state.revision,
  ...snapshot("baseline"),
});
persist("private-run.json", evidence);
for (const [phase, count, build] of [
  ["A", 5, evidence.builds[0]],
  ["B", 5, evidence.builds[1]],
  ["C", 2, evidence.builds[0]],
]) {
  if (phase === "C") {
    const preferences = join(prefsRoot, "Library/Preferences");
    const archived = join(runRoot, "preferences-before-reset");
    mkdirSync(archived, { mode: 0o700 });
    const domain = "io.github.apple-notes-mcp.private-writer";
    const removedFiles = [];
    for (const directory of [preferences, join(preferences, "ByHost")]) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (
          name !== `${domain}.plist` &&
          !(name.startsWith(`${domain}.`) && name.endsWith(".plist"))
        )
          continue;
        const path = join(directory, name);
        const { archivePath, bytes } = archiveIsolatedPreference(path, archived);
        removedFiles.push({
          relativePath: relative(prefsRoot, path),
          archivePath: relative(runRoot, archivePath),
          sha256: hash(bytes),
        });
      }
    }
    evidence.preferencesReset = { isolatedOnly: true, beforeStep: "C1", removedFiles };
    persist("private-run.json", evidence);
  }
  for (let i = 1; i <= count; i++) {
    const id = `${phase}${i}`;
    const requestedText = `Synthetic replica experiment ${id}`;
    const { response, processId } = writer(build, {
      action: "append_plain_text",
      identifier: note,
      text: requestedText,
      ifRevision: state.revision,
    });
    const captured = snapshot(id);
    assertExactAppend(
      evidence.steps.at(-1).text,
      captured.text,
      requestedText,
      response.appendedUTF16,
      id
    );
    evidence.steps.push({
      id,
      phase,
      requestedText,
      buildId: build.buildId,
      processId,
      revision: response.revisionAfter,
      write: {
        verified: response.verified,
        committed: response.committed,
        storeKind: response.storeKind,
        appendedUTF16: response.appendedUTF16,
        revisionBefore: response.revisionBefore,
        revisionAfter: response.revisionAfter,
      },
      ...captured,
    });
    state = { revision: response.revisionAfter };
    persist("private-run.json", evidence);
    if (!response.verified || !response.committed || response.storeKind !== "copy")
      stop(`${id} did not prove a committed synthetic-store save; no retry was attempted`);
  }
}

const result = evaluateReplicaIdentity(evidence);
persist("private-run.json", evidence);
persist("private-replica-labels.json", result.privateReplicaLabels);
persist("public-evidence.json", result.publicEvidence);
console.log(
  JSON.stringify({
    status: "completed",
    privateArtifacts: runRoot,
    publicEvidence: join(runRoot, "public-evidence.json"),
    liveValidated: false,
    limitations: result.publicEvidence.limitations,
  })
);
