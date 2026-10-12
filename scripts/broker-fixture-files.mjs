import assert from "node:assert/strict";
import * as fs from "node:fs";

export const MAX_FIXTURE_FILE_BYTES = 128 * 1024;

/**
 * Read a small, regular fixture file through one descriptor, without following
 * a final-component symlink or blocking on a FIFO. Missing files return null;
 * every other I/O error is fatal, including failures to close the descriptor.
 *
 * Constructor evidence must remain stable during a read. Launch-count polling
 * may instead allow concurrent appends, while retaining the same byte bound.
 * A descriptor pins the opened inode, not immutable content: the harness still
 * compares exact snapshots and validates constructor provenance separately.
 * The operations argument is only a seam for deterministic filesystem races.
 */
export function readFixtureFile(path, { allowAppend = false } = {}, operations = fs) {
  let descriptor;
  try {
    descriptor = operations.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  function inspect() {
    const metadata = operations.fstatSync(descriptor, { bigint: true });
    assert.ok(metadata.isFile(), "fixture evidence must be a regular file");
    assert.ok(
      metadata.size >= 0n && metadata.size <= BigInt(MAX_FIXTURE_FILE_BYTES),
      "fixture evidence exceeded its byte bound"
    );
    return metadata;
  }

  try {
    const before = inspect();
    // The extra byte is an EOF probe, never an unbounded read. Stable snapshots
    // probe immediately after their initial size; polling allows bounded growth.
    const capacity = (allowAppend ? MAX_FIXTURE_FILE_BYTES : Number(before.size)) + 1;
    const bytes = Buffer.alloc(capacity);
    let length = 0;
    while (length < capacity) {
      const count = operations.readSync(
        descriptor,
        bytes,
        length,
        Math.min(4096, capacity - length),
        length
      );
      if (count === 0) break;
      length += count;
    }
    assert.ok(length < capacity, "fixture evidence grew beyond its read bound");
    const after = inspect();
    assert.ok(before.dev === after.dev && before.ino === after.ino, "fixture inode changed");
    assert.ok(
      BigInt(length) >= before.size && after.size >= BigInt(length),
      "fixture evidence was truncated during its read"
    );
    if (!allowAppend) {
      assert.ok(
        after.size === before.size && after.mtimeNs === before.mtimeNs,
        "fixture evidence changed during its read"
      );
    }
    return bytes.subarray(0, length);
  } finally {
    operations.closeSync(descriptor);
  }
}
