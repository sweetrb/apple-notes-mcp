// Root skills/ is the canonical copy; the per-surface duplicates
// (codex/skills/, .antigravity-plugin/skills/) are generated from it and must
// never be edited directly. (.agents/plugins/marketplace.json sources ./codex,
// and .hermes-plugin carries no skill copy — syncing codex covers every other
// surface.)
//
//   node scripts/sync-skills.mjs          overwrite the copies from skills/
//   node scripts/sync-skills.mjs --check  exit 1 on any drift (CI gate)
//
// Edit skills/**, run `pnpm run sync:skills`, and commit all three trees.

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const CANONICAL = "skills";
const TARGETS = ["codex/skills", ".antigravity-plugin/skills"];

const check = process.argv.includes("--check");
const canonicalFiles = listFiles(path.join(root, CANONICAL));
const drifted = [];

for (const target of TARGETS) {
  const targetRoot = path.join(root, target);
  // Files present in a target but absent from skills/ are orphans from a
  // removed or renamed skill — stale content, so they count as drift too.
  for (const rel of listFiles(targetRoot)) {
    if (!canonicalFiles.includes(rel)) {
      drifted.push(`${path.join(target, rel)} (orphan; not in ${CANONICAL}/)`);
      if (!check) fs.rmSync(path.join(targetRoot, rel));
    }
  }
  for (const rel of canonicalFiles) {
    const source = path.join(root, CANONICAL, rel);
    const dest = path.join(targetRoot, rel);
    if (
      fs.existsSync(dest) &&
      fs.readFileSync(source).equals(fs.readFileSync(dest))
    ) {
      continue;
    }
    drifted.push(path.join(target, rel));
    if (!check) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
    }
  }
}

if (drifted.length === 0) {
  console.log(`skill copies in sync with ${CANONICAL}/: ${TARGETS.join(", ")}`);
} else if (check) {
  console.error(`skill copies have drifted from ${CANONICAL}/:`);
  for (const file of drifted) console.error(`  ${file}`);
  console.error("Run 'pnpm run sync:skills' and commit the result.");
  process.exit(1);
} else {
  console.log(`synced from ${CANONICAL}/:`);
  for (const file of drifted) console.log(`  ${file}`);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}
