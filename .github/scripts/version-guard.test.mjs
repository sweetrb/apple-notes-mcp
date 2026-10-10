// Exercise the exact shell guard CI runs, using isolated public Git fixtures.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guard = join(dirname(fileURLToPath(import.meta.url)), "version-guard.sh");
const packageJson = { name: "release-guard-fixture", version: "2.14.3", dependencies: {} };
const changelog = "## [Unreleased]\n\n## [2.14.3] - 2026-10-08\n\n### Fixed\n\n- Fixture.\n";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  const write = (path, contents = "fixture\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Release guard fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("package.json", JSON.stringify(packageJson));
  write("CHANGELOG.md", changelog);
  write("build/index.js");
  write("src/index.ts");
  write("src/sidecar.py");
  write("requirements.txt");
  write("native/private-helper/helper.m");
  write("native/public-helper/helper.swift");
  write("native/private-helper/helper.h");
  write("shortcuts/Existing signed.shortcut");
  write("shortcuts/Existing unsigned.unsigned.shortcut");
  write("native/README.md");
  write("shortcuts/README.md");
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const base = commit();
  // Keep npm's registry check deterministic and entirely offline.
  const bin = mkdtempSync(join(tmpdir(), "release-guard-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const npm = join(bin, "npm");
  writeFileSync(npm, "#!/bin/sh\nexit 0\n");
  chmodSync(npm, 0o755);
  const run = () =>
    spawnSync("bash", [guard], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: commit(),
        PATH: bin + ":" + process.env.PATH,
      },
    });
  return { root, write, run, npm };
}

function assertOutcome(result, status, message) {
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, message);
}

for (const path of [
  "native/private-helper/helper.m",
  "native/public-helper/helper.swift",
  "native/private-helper/helper.h",
  "native/helper/new.hpp",
  "native/helper/runtime.json",
  "shortcuts/Existing signed.shortcut",
  "shortcuts/Existing unsigned.unsigned.shortcut",
  "shortcuts/New shortcut.shortcut",
  "native/helper/new\nline.h",
  "build/index.js",
  "requirements.txt",
  "src/sidecar.py",
  "src/new.sidecar",
]) {
  test("rejects an unbumped runtime change: " + JSON.stringify(path), (t) => {
    const f = fixture(t);
    f.write(path, "changed\n");
    assertOutcome(f.run(), 1, /Shipped bytes changed.*version is unchanged/);
  });
}

for (const path of [
  "README.md",
  "docs/runtime.md",
  ".github/workflows/fixture.yml",
  "native/README.md",
  "native/helper/guide.rst",
  "shortcuts/README.md",
  "native/helper.test.m",
  "native/helper.spec.swift",
  "native/tests/helper.h",
  "native/__tests__/helper.swift",
  "src/index.ts",
  "src/example.test.ts",
  "src/__mocks__/sidecar.py",
]) {
  test("accepts an exempt change: " + path, (t) => {
    const f = fixture(t);
    f.write(path, "changed\n");
    assertOutcome(f.run(), 0, /No shipped-byte changes/);
  });
}

for (const path of [
  "native/private-helper/helper.m",
  "native/private-helper/helper.h",
  "shortcuts/Existing signed.shortcut",
]) {
  test("rejects deletion of an unbumped runtime file: " + path, (t) => {
    const f = fixture(t);
    rmSync(join(f.root, path));
    assertOutcome(f.run(), 1, /Shipped bytes changed.*version is unchanged/);
  });
}

for (const [from, to] of [
  ["native/private-helper/helper.h", "docs/helper.h"],
  ["native/private-helper/helper.m", "native/private-helper/renamed.m"],
  ["shortcuts/Existing signed.shortcut", "shortcuts/retired.md"],
  ["native/README.md", "native/new.swift"],
]) {
  test("rejects an unbumped rename across runtime paths: " + from + " -> " + to, (t) => {
    const f = fixture(t);
    mkdirSync(dirname(join(f.root, to)), { recursive: true });
    renameSync(join(f.root, from), join(f.root, to));
    assertOutcome(f.run(), 1, /Shipped bytes changed.*version is unchanged/);
  });
}

test("accepts a documentation-only rename", (t) => {
  const f = fixture(t);
  renameSync(join(f.root, "native/README.md"), join(f.root, "native/Guide.md"));
  assertOutcome(f.run(), 0, /No shipped-byte changes/);
});

test("rejects TypeScript when its committed bundle also changes", (t) => {
  const f = fixture(t);
  f.write("src/index.ts", "changed\n");
  f.write("build/index.js", "changed\n");
  assertOutcome(f.run(), 1, /Shipped bytes changed.*version is unchanged/);
});

test("rejects a runtime dependency change with an unchanged bundle", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ ...packageJson, dependencies: { runtime: "2" } }));
  assertOutcome(f.run(), 1, /Runtime dependencies changed.*version is unchanged/);
});

test("accepts a devDependency-only change with an unchanged bundle", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ ...packageJson, devDependencies: { fixture: "2" } }));
  assertOutcome(f.run(), 0, /No shipped-byte changes/);
});

function bump(f, version = "2.14.4") {
  f.write("package.json", JSON.stringify({ ...packageJson, version }));
  f.write(
    "CHANGELOG.md",
    changelog.replace(
      "## [2.14.3]",
      "## [" + version + "] - 2026-10-08\n\n### Fixed\n\n- New fixture.\n\n## [2.14.3]"
    )
  );
}

test("accepts a documented increasing native-only version bump", (t) => {
  const f = fixture(t);
  f.write("native/private-helper/helper.m", "changed\n");
  bump(f);
  assertOutcome(f.run(), 0, /Shipped bytes changed and version is bumped/);
});

test("rejects an erased published changelog heading even for exempt changes", (t) => {
  const f = fixture(t);
  f.write("CHANGELOG.md", "## [Unreleased]\n\n");
  assertOutcome(f.run(), 1, /must never be renamed/);
});

test("rejects a version downgrade", (t) => {
  const f = fixture(t);
  bump(f, "2.14.2");
  assertOutcome(f.run(), 1, /not an increase/);
});

test("rejects a bump without its changelog heading", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ ...packageJson, version: "2.14.4" }));
  assertOutcome(f.run(), 1, /CHANGELOG.md has no/);
});

test("rejects a bump with populated Unreleased notes", (t) => {
  const f = fixture(t);
  bump(f);
  f.write(
    "CHANGELOG.md",
    readFileSync(join(f.root, "CHANGELOG.md"), "utf8").replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n- Pending fixture.\n"
    )
  );
  assertOutcome(f.run(), 1, /Unreleased.*is not empty/);
});

test("rejects a version already published according to npm", (t) => {
  const f = fixture(t);
  bump(f);
  writeFileSync(f.npm, "#!/bin/sh\nprintf '%s\\n' '2.14.4'\n");
  assertOutcome(f.run(), 1, /already published on npm/);
});
