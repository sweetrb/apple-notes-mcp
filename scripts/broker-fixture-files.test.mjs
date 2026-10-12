import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_FIXTURE_FILE_BYTES, readFixtureFile } from "./broker-fixture-files.mjs";

function fixture(t, contents = "original\n") {
  const directory = fs.mkdtempSync(join(tmpdir(), "broker-fixture-read-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "marker");
  fs.writeFileSync(path, contents);
  return { directory, path };
}

function trackedOperations(overrides = {}) {
  const calls = { openSync: [], fstatSync: [], readSync: [], closeSync: [] };
  const operations = Object.fromEntries(
    Object.keys(calls).map((name) => [
      name,
      (...args) => {
        calls[name].push(args);
        return (overrides[name] ?? fs[name])(...args);
      },
    ])
  );
  return { calls, operations };
}

function assertClosed(calls) {
  assert.equal(calls.openSync.length, 1);
  assert.equal(calls.closeSync.length, 1);
  const descriptor = calls.closeSync[0][0];
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  for (const [fd] of [...calls.fstatSync, ...calls.readSync]) assert.equal(fd, descriptor);
}

test("missing file returns null without opening or closing another object", (t) => {
  const { path } = fixture(t);
  fs.unlinkSync(path);
  const { calls, operations } = trackedOperations();
  assert.equal(readFixtureFile(path, {}, operations), null);
  assert.equal(calls.openSync.length, 1);
  assert.equal(calls.fstatSync.length + calls.readSync.length + calls.closeSync.length, 0);
});

for (const [name, contents] of [
  ["empty", Buffer.alloc(0)],
  ["binary", Buffer.from([0, 255, 195, 40, 10])],
  ["exactly at the byte bound", Buffer.alloc(MAX_FIXTURE_FILE_BYTES, 0xa7)],
]) {
  test(`reads ${name} evidence as exact bytes through one closed descriptor`, (t) => {
    const { path } = fixture(t, contents);
    const { calls, operations } = trackedOperations();
    assert.deepEqual(readFixtureFile(path, {}, operations), contents);
    assert.equal(
      calls.openSync[0][1],
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    assert.ok(calls.readSync.every(([, buffer]) => buffer.length <= MAX_FIXTURE_FILE_BYTES + 1));
    assertClosed(calls);
  });
}

for (const dangling of [false, true]) {
  test(`rejects a ${dangling ? "dangling" : "regular-file"} symlink`, (t) => {
    const { directory, path } = fixture(t);
    const link = join(directory, "link");
    fs.symlinkSync(dangling ? join(directory, "missing") : path, link);
    assert.throws(() => readFixtureFile(link), { code: "ELOOP" });
  });
}

test("rejects a directory and closes the descriptor", (t) => {
  const { directory } = fixture(t);
  const { calls, operations } = trackedOperations();
  assert.throws(() => readFixtureFile(directory, {}, operations), /regular file/);
  assert.equal(calls.readSync.length, 0);
  assertClosed(calls);
});

test("rejects a FIFO without waiting for a writer", (t) => {
  const { directory } = fixture(t);
  const path = join(directory, "fifo");
  const created = spawnSync("mkfifo", [path], { timeout: 2000, encoding: "utf8" });
  assert.equal(created.error, undefined);
  assert.equal(created.status, 0, created.stderr);
  const helperUrl = new URL("./broker-fixture-files.mjs", import.meta.url).href;
  // A subprocess timeout also catches removal of O_NONBLOCK: a JS test timeout
  // cannot interrupt its own synchronous open() on a FIFO with no writer.
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import { readFixtureFile } from ${JSON.stringify(helperUrl)};
       assert.throws(() => readFixtureFile(process.argv[1]), /regular file/);`,
      path,
    ],
    { timeout: 3000, encoding: "utf8" }
  );
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
});

for (const allowAppend of [false, true]) {
  const mode = allowAppend ? "append" : "stable";
  test(`${mode} mode rejects an initially oversized file before reading`, (t) => {
    const { path } = fixture(t, Buffer.alloc(MAX_FIXTURE_FILE_BYTES + 1));
    const { calls, operations } = trackedOperations();
    assert.throws(() => readFixtureFile(path, { allowAppend }, operations), /byte bound/);
    assert.equal(calls.readSync.length, 0);
    assertClosed(calls);
  });

  test(`${mode} mode handles short reads and a separate EOF probe`, (t) => {
    const { path } = fixture(t);
    const { calls, operations } = trackedOperations({
      readSync(fd, buffer, offset, length, position) {
        return fs.readSync(fd, buffer, offset, Math.min(length, 2), position);
      },
    });
    assert.equal(readFixtureFile(path, { allowAppend }, operations).toString(), "original\n");
    assert.ok(calls.readSync.length > 2);
    assert.equal(calls.readSync.at(-1)[4], 9);
    assertClosed(calls);
  });

  test(`${mode} mode reads the original inode after pathname replacement`, (t) => {
    const { directory, path } = fixture(t);
    const { calls, operations } = trackedOperations({
      openSync(...args) {
        const fd = fs.openSync(...args);
        fs.renameSync(path, join(directory, "original-inode"));
        fs.writeFileSync(path, "replacement must not be read\n");
        return fd;
      },
    });
    assert.equal(readFixtureFile(path, { allowAppend }, operations).toString(), "original\n");
    assertClosed(calls);
  });

  test(`${mode} mode rejects truncation after initial fstat`, (t) => {
    const { path } = fixture(t);
    const { calls, operations } = trackedOperations({
      fstatSync(...args) {
        const metadata = fs.fstatSync(...args);
        if (calls.fstatSync.length === 1) fs.truncateSync(path, 1);
        return metadata;
      },
    });
    assert.throws(() => readFixtureFile(path, { allowAppend }, operations), /truncated/);
    assertClosed(calls);
  });

  test(`${mode} mode rejects truncation after the EOF probe`, (t) => {
    const { path } = fixture(t);
    const { calls, operations } = trackedOperations({
      readSync(...args) {
        const count = fs.readSync(...args);
        if (count === 0) fs.truncateSync(path, 1);
        return count;
      },
    });
    assert.throws(() => readFixtureFile(path, { allowAppend }, operations), /truncated/);
    assertClosed(calls);
  });

  test(`${mode} mode rejects growth past the byte bound during reading`, (t) => {
    const { path } = fixture(t, Buffer.alloc(MAX_FIXTURE_FILE_BYTES));
    const { calls, operations } = trackedOperations({
      readSync(...args) {
        if (calls.readSync.length === 1) fs.appendFileSync(path, "x");
        return fs.readSync(...args);
      },
    });
    assert.throws(() => readFixtureFile(path, { allowAppend }, operations), /read bound/);
    const bytesRead = calls.readSync.reduce((total, [, , , length]) => total + length, 0);
    assert.equal(bytesRead, MAX_FIXTURE_FILE_BYTES + 1);
    assertClosed(calls);
  });

  test(`${mode} mode rejects growth past the byte bound after the EOF probe`, (t) => {
    const { path } = fixture(t);
    const { calls, operations } = trackedOperations({
      readSync(...args) {
        const count = fs.readSync(...args);
        if (count === 0) fs.appendFileSync(path, Buffer.alloc(MAX_FIXTURE_FILE_BYTES));
        return count;
      },
    });
    assert.throws(() => readFixtureFile(path, { allowAppend }, operations), /byte bound/);
    assertClosed(calls);
  });
}

for (const afterEof of [false, true]) {
  for (const allowAppend of [false, true]) {
    test(`${allowAppend ? "append" : "stable"} mode ${allowAppend ? "allows" : "rejects"} bounded growth ${afterEof ? "after EOF" : "during reading"}`, (t) => {
      const { path } = fixture(t);
      let appended = false;
      const { calls, operations } = trackedOperations({
        readSync(...args) {
          if (!afterEof && !appended) {
            fs.appendFileSync(path, "spawn\n");
            appended = true;
          }
          const count = fs.readSync(...args);
          if (afterEof && count === 0 && !appended) {
            fs.appendFileSync(path, "spawn\n");
            appended = true;
          }
          return count;
        },
      });
      if (allowAppend) {
        assert.equal(
          readFixtureFile(path, { allowAppend }, operations).toString(),
          afterEof ? "original\n" : "original\nspawn\n"
        );
      } else {
        assert.throws(() => readFixtureFile(path, {}, operations), /read bound|changed/);
      }
      assertClosed(calls);
    });
  }
}

test("stable mode rejects an observed same-size rewrite", (t) => {
  const { path } = fixture(t);
  const { calls, operations } = trackedOperations({
    readSync(...args) {
      if (calls.readSync.length === 1) {
        fs.writeFileSync(path, "modified\n");
        // Make the metadata change deterministic even on coarse filesystems.
        fs.utimesSync(path, new Date("2000-01-01"), new Date("2000-01-01"));
      }
      return fs.readSync(...args);
    },
  });
  assert.throws(() => readFixtureFile(path, {}, operations), /changed/);
  assertClosed(calls);
});

test("permission errors from open remain fatal", () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const { calls, operations } = trackedOperations({
    openSync() {
      throw denied;
    },
  });
  assert.throws(
    () => readFixtureFile("unused", {}, operations),
    (error) => error === denied
  );
  assert.equal(calls.closeSync.length, 0);
});

for (const operation of ["fstatSync", "readSync"]) {
  for (const code of ["ENOENT", "EIO"]) {
    test(`${operation} ${code} remains fatal and closes the descriptor`, (t) => {
      const { path } = fixture(t);
      const failed = Object.assign(new Error("fixture read failed"), { code });
      const { calls, operations } = trackedOperations({
        [operation]() {
          throw failed;
        },
      });
      assert.throws(
        () => readFixtureFile(path, {}, operations),
        (error) => error === failed
      );
      assertClosed(calls);
    });
  }
}

for (const readFails of [false, true]) {
  test(`close failure is fatal ${readFails ? "even after a read failure" : "after a successful read"}`, (t) => {
    const { path } = fixture(t);
    const closeError = Object.assign(new Error("close failed"), { code: "EIO" });
    const { calls, operations } = trackedOperations({
      readSync(...args) {
        if (readFails) throw new Error("read failed");
        return fs.readSync(...args);
      },
      closeSync(fd) {
        fs.closeSync(fd);
        throw closeError;
      },
    });
    assert.throws(
      () => readFixtureFile(path, {}, operations),
      (error) => error === closeError
    );
    assertClosed(calls);
  });
}
