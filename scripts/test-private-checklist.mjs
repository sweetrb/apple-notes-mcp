#!/usr/bin/env node
// Compile a temporary synthetic harness. Never installs a helper or opens Notes data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "private-checklist-"));
const binary = join(temporary, "checklist-harness");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, ...options });
  if (result.error) throw result.error;
  return result;
}
try {
  const build = run("/usr/bin/xcrun", [
    "clang", "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror",
    "-framework", "Foundation", "-framework", "CoreData", "-framework", "AppKit",
    join(root, "scripts/fixtures/private-checklist-harness.m"), "-o", binary,
  ]);
  assert.equal(build.status, 0, build.stderr);
  const fixture = run(binary, []);
  assert.equal(fixture.status, 0, fixture.stderr);
  const summary = JSON.parse(fixture.stdout);
  assert.equal(summary.frameworkLoaded, false);
  const dispatch = (request) => {
    const result = run(binary, ["--dispatch"], { input: JSON.stringify({ protocol: 1, ...request }) });
    return { exitCode: result.status, ...JSON.parse(result.stdout) };
  };
  const hello = dispatch({ action: "hello" });
  assert.equal(hello.exitCode, 0);
  assert.equal(hello.status, "ok");
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.readOnly, true);
  assert.deepEqual(hello.actions, ["hello", "probe", "read_note_state", "read_checklist"]);
  for (const action of ["write", "set_checklist_item", "append_plain_text"]) {
    const refusal = dispatch({ action });
    assert.equal(refusal.exitCode, 1);
    assert.equal(refusal.status, "error");
    assert.equal(refusal.code, "unknown_action");
  }
  for (const request of [
    { action: "read_checklist", identifier: "irrelevant", done: true },
    { action: "read_checklist" },
    { action: "read_checklist", identifier: "not-a-uuid" },
    { action: "read_checklist", identifier: 7 },
  ]) {
    const refusal = dispatch(request);
    assert.equal(refusal.exitCode, 1);
    assert.equal(refusal.status, "error");
    assert.equal(refusal.code, "invalid_request");
  }
  console.log(`ok: ${summary.tests} synthetic checklist assertions; hello/whitelist/key/identifier refusals; no NotesShared or store access`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
