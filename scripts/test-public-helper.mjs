#!/usr/bin/env node
/**
 * Live check for the public native helper (not part of `pnpm test`, because it
 * needs a compiled helper, and CI does not compile native code).
 *
 *   node build/index.js setup --public-helper
 *   node scripts/test-public-helper.mjs            # verify the fixture decodes and
 *                                                  # synthetic speech transcribes
 *   node scripts/test-public-helper.mjs --write    # regenerate the fixture
 *
 * The fixture is synthetic: the strokes below are encoded by PencilKit itself
 * (`encode_drawing`), then decoded back (`decode_drawing`). `--write` stores the
 * bytes and the decode as src/utils/fixtures/pencil-drawing.json, which the
 * unit tests use for the SQL and SVG paths. The default mode decodes the stored
 * bytes with the installed helper and requires the result to equal the stored
 * decode, which proves the checked-in bytes are a real PencilKit drawing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(root, "src/utils/fixtures/pencil-drawing.json");
const installDir =
  process.env.APPLE_NOTES_MCP_PUBLIC_HELPER_DIR ||
  join(homedir(), "Library", "Application Support", "apple-notes-mcp", "public-helper");
const helper = join(installDir, "apple-notes-public-helper");

function call(action, fields) {
  const r = spawnSync(helper, [], {
    input: JSON.stringify({ protocol: 1, action, ...fields }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const out = JSON.parse(r.stdout);
  if (out.status !== "ok") throw new Error(`${action}: ${out.code}: ${out.message}`);
  return out;
}

const STROKES = [
  {
    inkType: "com.apple.ink.pen",
    color: { red: 220, green: 30, blue: 40, alpha: 1 },
    width: 4,
    points: [
      { x: 20, y: 20 },
      { x: 60, y: 55 },
      { x: 110, y: 30 },
      { x: 150, y: 70 },
    ],
  },
  {
    inkType: "com.apple.ink.marker",
    color: { red: 250, green: 210, blue: 0, alpha: 0.5 },
    width: 14,
    points: [
      { x: 25, y: 110 },
      { x: 170, y: 115 },
    ],
  },
  {
    inkType: "com.apple.ink.pencil",
    color: { red: 30, green: 90, blue: 200, alpha: 1 },
    width: 2,
    points: [
      { x: 40, y: 150 },
      { x: 80, y: 140 },
      { x: 120, y: 160 },
    ],
  },
];

if (process.argv.includes("--write")) {
  const encoded = call("encode_drawing", { strokes: STROKES });
  const decoded = call("decode_drawing", { dataBase64: encoded.dataBase64, includePoints: true });
  writeFileSync(
    fixturePath,
    JSON.stringify({ synthetic: true, strokes: STROKES, dataBase64: encoded.dataBase64, decoded }, null, 2) +
      "\n"
  );
  console.log(`wrote ${fixturePath}: ${decoded.strokeCount} strokes`);
} else {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const decoded = call("decode_drawing", { dataBase64: fixture.dataBase64, includePoints: true });
  if (!isDeepStrictEqual(decoded, fixture.decoded)) {
    console.error("FAIL: helper decode differs from the stored fixture decode");
    process.exit(1);
  }
  const bad = spawnSync(helper, [], {
    input: JSON.stringify({ protocol: 1, action: "decode_drawing", dataBase64: "bm90IGEgZHJhd2luZw==" }),
    encoding: "utf8",
  });
  const refusal = JSON.parse(bad.stdout);
  if (bad.status === 0 || refusal.code !== "undecodable") {
    console.error("FAIL: non-drawing bytes were not refused with code undecodable");
    process.exit(1);
  }
  console.log(`ok: fixture decodes to ${decoded.strokeCount} strokes; garbage refused (${refusal.code})`);

  // Transcription: synthesize a known sentence with `say`, then transcribe it on-device.
  const dir = mkdtempSync(join(tmpdir(), "public-helper-speech-"));
  try {
    const sentence = "The quick brown fox jumps over the lazy dog";
    const aiff = join(dir, "speech.aiff");
    const say = spawnSync("/usr/bin/say", ["-o", aiff, sentence]);
    if (say.status !== 0) throw new Error("say failed");
    const heard = call("transcribe", { path: aiff, locale: "en-US", timeoutSeconds: 120 });
    const words = heard.transcript.toLowerCase().match(/[a-z]+/g) ?? [];
    const expected = sentence.toLowerCase().split(" ");
    const matched = expected.filter((w) => words.includes(w)).length;
    if (!heard.complete || matched < expected.length - 1) {
      console.error(`FAIL: transcription matched ${matched}/${expected.length} words`);
      process.exit(1);
    }
    console.log(`ok: transcribed synthetic speech with ${heard.engine} (${matched}/${expected.length} words)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
