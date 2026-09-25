/**
 * URL link card client tests. A Node script stands in for the native writer
 * so the real spawn, checksum, gating, and response-validation paths run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./privateHelper.js";
import {
  LINK_CARD_LIVE_VALIDATED,
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { addUrlCard, assertCardUrl } from "./privateWriterLinkCard.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const SOURCE = "// fake link card writer source\n";

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "mismatch") out({ status: "error", code: "match_count_mismatch", message: "0 paragraphs", committed: false, found: 0 }, 1);
  if (mode === "malformed") out({ status: "updated" });
  const base = { identifier: req.identifier, url: req.url, placement: req.afterParagraph ? "afterParagraph" : "end",
    insertedAtUTF16: 10, glyphIndexUTF16: 11, separatorInserted: true, revisionBefore: "r1:" + "b".repeat(64),
    modificationDate: null, cloudSync: { available: true, inICloudAccount: true }, pushScheduled: false,
    pushState: "awaiting_notes_app", syncHostRunning: true, storeKind: "live", echo: req };
  if (req.dryRun) out({ ...base, status: "planned", committed: false, dryRun: true, revisionAfter: base.revisionBefore });
  out({ ...base, status: "updated", committed: true, verified: true, dryRun: false, previewFetched: false,
    revisionAfter: "r1:" + "c".repeat(64),
    attachment: { attachmentIdentifier: "A", typeUTI: "public.url", urlString: req.url, glyphIndexUTF16: 11,
      cloudSync: { available: true, inICloudAccount: true, currentLocalVersion: 1, latestVersionSyncedToCloud: 0, uploadPending: true } } });
});
`;

let root: string;
let deps: (env?: Record<string, string>) => PrivateHelperDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-linkcard-"));
  const installDir = join(root, "install");
  const sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, SOURCE);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, WRITER_BINARY_NAME), FAKE_WRITER);
  chmodSync(join(installDir, WRITER_BINARY_NAME), 0o755);
  writeFileSync(
    join(installDir, WRITER_MANIFEST_NAME),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: PRIVATE_WRITER_PROTOCOL,
      sourceSha256: sha256Hex(SOURCE),
      binarySha256: sha256Hex(FAKE_WRITER),
      builtAt: "2026-09-23T00:00:00.000Z",
      osVersion: "27.2",
      compiler: "clang",
    })
  );
  deps = (env = {}) =>
    defaultWriterDeps({
      env: {
        PATH: process.env.PATH,
        APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir,
        APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
        APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
        ...env,
      },
      platform: "darwin",
      sourcePath,
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ALLOW = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

function caught(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateWriteError) return error;
    throw error;
  }
  throw new Error("expected a PrivateWriteError");
}

const SPAWN_TIMEOUT = { timeout: 20_000 };

describe("card URLs", () => {
  it("accepts absolute http and https URLs", () => {
    expect(() => assertCardUrl("https://example.com/a?b=c")).not.toThrow();
    expect(() => assertCardUrl("http://example.com")).not.toThrow();
  });

  it("refuses other schemes, relative URLs, whitespace, and over-long URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/hosts",
      "notes://showNote?identifier=x",
      "/relative",
      "https://exa mple.com",
      "https://example.com/\n",
      `https://example.com/${"a".repeat(2048)}`,
    ])
      expect(caught(() => assertCardUrl(bad))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
  });
});

describe("addUrlCard", SPAWN_TIMEOUT, () => {
  const request = { identifier: NOTE, url: "https://example.com/", ifRevision: REV };

  it("gates writes until live validation but lets a dry run through", () => {
    expect(LINK_CARD_LIVE_VALIDATED).toBe(false);
    expect(caught(() => addUrlCard(request, deps()))).toMatchObject({
      code: "not_live_validated",
      committed: false,
    });
    const plan = addUrlCard({ ...request, ifRevision: undefined, dryRun: true }, deps());
    expect(plan).toMatchObject({ status: "planned", committed: false, placement: "end" });
    expect(plan.echo).toEqual({
      protocol: 1,
      action: "add_url_card",
      identifier: NOTE,
      url: "https://example.com/",
      dryRun: true,
    });
  });

  it("validates input before spawning", () => {
    const d = deps(ALLOW);
    for (const input of [
      { ...request, identifier: "x" },
      { ...request, url: "ftp://example.com" },
      { ...request, afterParagraph: "" },
      { ...request, afterParagraph: "a\nb" },
      { ...request, afterParagraph: "x".repeat(2001) },
      { ...request, ifRevision: "r1:x" },
      { ...request, ifRevision: undefined },
    ])
      expect(caught(() => addUrlCard(input, d)).code).toBe("invalid_request");
  });

  it("writes after a paragraph and returns the verified attachment", () => {
    const r = addUrlCard({ ...request, afterParagraph: "Links" }, deps(ALLOW));
    expect(r).toMatchObject({ status: "updated", committed: true, placement: "afterParagraph" });
    expect(r.attachment).toMatchObject({
      typeUTI: "public.url",
      urlString: "https://example.com/",
      cloudSync: { uploadPending: true },
    });
    expect(r.echo).toMatchObject({ afterParagraph: "Links", ifRevision: REV });
  });

  it("passes the anchor refusal through as not committed", () => {
    expect(
      caught(() => addUrlCard(request, deps({ ...ALLOW, FAKE_MODE: "mismatch" })))
    ).toMatchObject({ code: "match_count_mismatch", committed: false });
  });

  it("treats a malformed write response as indeterminate, a dry run as not committed", () => {
    expect(
      caught(() => addUrlCard(request, deps({ ...ALLOW, FAKE_MODE: "malformed" })))
    ).toMatchObject({ code: "invalid_response", committed: "unknown" });
    const timedOut = caught(() =>
      addUrlCard(
        { ...request, dryRun: true },
        deps({ FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
      )
    );
    expect(timedOut).toMatchObject({ code: "timeout", committed: false });
    // The transport treats the dry run as a read, so the message does not
    // describe a possible save.
    expect(timedOut.message).not.toMatch(/INDETERMINATE|may have been saved/);
  });
});
