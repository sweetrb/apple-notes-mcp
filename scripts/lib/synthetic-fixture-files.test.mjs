import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveIsolatedPreference, readSingleLinkFile } from "./synthetic-fixture-files.mjs";

const fixture = () => mkdtempSync(join(tmpdir(), "synthetic-file-guard-"));

test("reads a single-link regular fixture file without altering its bytes", () => {
  const path = join(fixture(), "fixture.bin");
  const bytes = Buffer.from([0, 10, 255, 42]);
  writeFileSync(path, bytes, { mode: 0o600 });
  assert.deepEqual(readSingleLinkFile(path), bytes);
  assert.deepEqual(readFileSync(path), bytes);
});

test("refuses symlinks, hardlinks, directories, and missing files", () => {
  const root = fixture();
  const target = join(root, "target");
  const symlink = join(root, "symlink");
  const hardlink = join(root, "hardlink");
  writeFileSync(target, "synthetic target", { mode: 0o600 });
  symlinkSync(target, symlink);
  linkSync(target, hardlink);
  assert.throws(() => readSingleLinkFile(symlink), { code: "ELOOP" });
  assert.throws(() => readSingleLinkFile(hardlink), /exactly one link/);
  assert.throws(() => readSingleLinkFile(target), /exactly one link/);
  assert.throws(() => readSingleLinkFile(root), /regular file/);
  assert.throws(() => readSingleLinkFile(join(root, "missing")), { code: "ENOENT" });
  assert.equal(readFileSync(target, "utf8"), "synthetic target");
});

test("archives equal preference basenames separately and retains each exact file", () => {
  const root = fixture();
  const archive = join(root, "archive");
  mkdirSync(archive, { mode: 0o700 });
  const results = [];
  for (const name of ["domain", "ByHost"]) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    const source = join(directory, "same.plist");
    const bytes = Buffer.from(`synthetic preference ${name}`);
    writeFileSync(source, bytes, { mode: 0o600 });
    const result = archiveIsolatedPreference(source, archive);
    assert.equal(existsSync(source), false);
    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual(readSingleLinkFile(result.archivePath), bytes);
    results.push(result);
  }
  assert.notEqual(results[0].archivePath, results[1].archivePath);
  assert.deepEqual(readSingleLinkFile(results[0].archivePath), results[0].bytes);
});

test("unsafe preference symlink stays recoverable and its target remains untouched", () => {
  const root = fixture();
  const archive = join(root, "archive");
  mkdirSync(archive, { mode: 0o700 });
  const target = join(root, "target");
  const source = join(root, "unsafe.plist");
  writeFileSync(target, "do not change this synthetic target", { mode: 0o600 });
  symlinkSync(target, source);
  assert.throws(
    () => archiveIsolatedPreference(source, archive),
    (error) => {
      assert.equal(error.cause.code, "ELOOP");
      assert.equal(readlinkSync(error.archivePath), target);
      return true;
    }
  );
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(target, "utf8"), "do not change this synthetic target");
});

test("unsafe preference hardlink stays recoverable without changing either file", () => {
  const root = fixture();
  const archive = join(root, "archive");
  mkdirSync(archive, { mode: 0o700 });
  const target = join(root, "target");
  const source = join(root, "unsafe.plist");
  writeFileSync(target, "synthetic hardlink target", { mode: 0o600 });
  linkSync(target, source);
  assert.throws(
    () => archiveIsolatedPreference(source, archive),
    (error) => {
      assert.match(error.cause.message, /exactly one link/);
      assert.equal(readFileSync(error.archivePath, "utf8"), "synthetic hardlink target");
      return true;
    }
  );
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(target, "utf8"), "synthetic hardlink target");
});
