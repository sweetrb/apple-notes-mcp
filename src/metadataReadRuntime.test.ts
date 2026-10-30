/**
 * Exact-ID metadata failures through the built server, real executor and MCP
 * stdio transport. The child PATH contains only a test-owned osascript fixture
 * and a Node symlink: no AppleScript or Notes operation can run.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p999999";
const CASES = [
  { name: "automation", code: "permission_denied", text: "Automation" },
  {
    name: "timeout",
    code: "timeout_indeterminate",
    text: "Operation timed out",
    indeterminate: true,
  },
  { name: "connection", code: "notes_unavailable", text: "Lost connection" },
  { name: "missing", code: "not_found", text: "Note not found" },
  { name: "malformed", code: "operation_failed", text: "Unexpected note metadata response" },
  {
    name: "quoted",
    code: "operation_failed",
    text: 'Metadata read failed near "timed out, not found, -1743"',
  },
  {
    name: "quoted-canonical",
    code: "operation_failed",
    text: 'Metadata read failed near "Note not found. The note may have been deleted or the ID is invalid."',
  },
  {
    name: "uncertain",
    code: "verification_failed",
    text: "Metadata read may have been interrupted",
    indeterminate: true,
  },
  {
    // #316: the first attempt hits Notes' AppleEvent timeout and the retry
    // reports the ID missing. The timeout must survive as the result.
    name: "timeout-then-missing",
    code: "timeout_indeterminate",
    text: "AppleEvent timed out",
    indeterminate: true,
    attempts: 2,
  },
  { name: "protected", code: "unsupported", text: "password-protected" },
  { name: "launcher", code: "operation_failed", text: "spawnSync osascript EACCES" },
];

const FIXTURE = `#!/usr/bin/env node
const fs = require("node:fs");
const script = fs.readFileSync(0, "utf8");
const metadataOnly = script.includes("set noteProps to") && !script.includes("get body") && !script.includes("set body");
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ metadataOnly }) + "\\n");
if (!metadataOnly) { process.stderr.write("Unexpected synthetic request"); process.exit(2); }
const responses = {
  automation: "execution error: Not authorized to send Apple events to Notes. (-1743)",
  connection: "execution error: Lost connection to Notes.app. (-609)",
  missing: "execution error: Can't get note id. (-1728)",
  quoted: 'execution error: Metadata read failed near "timed out, not found, -1743"',
  "quoted-canonical": 'execution error: Metadata read failed near "Note not found. The note may have been deleted or the ID is invalid."',
  uncertain: "execution error: Metadata read may have been interrupted",
};
const mode = process.env.FIXTURE_CASE;
const attempt = fs.readFileSync(process.env.FIXTURE_CALLS, "utf8").trim().split("\\n").length;
if (mode === "timeout-then-missing") {
  process.stderr.write(attempt === 1 ? "execution error: Notes got an error: AppleEvent timed out. (-1712)" : responses.missing);
  process.exit(1);
}
if (mode === "timeout") { setTimeout(() => process.exit(0), 3000); }
else if (mode === "malformed") { process.stdout.write('Private "timed out -1743" note not found'); }
else if (mode === "protected") { process.stdout.write(["timed out -1743", process.env.FIXTURE_ID, "2026-10-12-10-20-0", "2026-10-12-11-30-0", "false", "true"].join("\\x1f")); }
else { process.stderr.write(responses[mode]); process.exit(1); }
`;

describe("built server retains initial metadata diagnostics", () => {
  it.each(CASES)(
    "%s",
    async (test) => {
      const fixture = mkdtempSync(join(tmpdir(), "metadata-read-runtime-"));
      const executable = join(fixture, "osascript");
      const calls = join(fixture, "calls.jsonl");
      const config = join(fixture, "config.json");
      const client = new Client({ name: "synthetic-metadata-runtime", version: "0.0.0" });
      try {
        symlinkSync(process.execPath, join(fixture, "node"));
        writeFileSync(executable, FIXTURE);
        chmodSync(executable, test.name === "launcher" ? 0o644 : 0o755);
        writeFileSync(config, "{}");
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve(__dirname, "../build/index.js")],
          env: {
            PATH: fixture,
            APPLE_NOTES_MCP_BROKER: "off",
            APPLE_NOTES_MCP_CONFIG_FILE: config,
            APPLE_NOTES_MCP_MAX_RETRIES: String(test.attempts ?? 1),
            APPLE_NOTES_MCP_TIMEOUT_MS: test.attempts ? "10000" : "1000",
            APPLE_NOTES_MCP_RETRY_DELAY_MS: "1",
            FIXTURE_CASE: test.name,
            FIXTURE_CALLS: calls,
            FIXTURE_ID: ID,
          },
          stderr: "pipe",
        });
        await client.connect(transport);
        const result = await client.callTool({ name: "get-note-content", arguments: { id: ID } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.code).toBe(test.code);
        expect(result.structuredContent?.indeterminate).toBe(test.indeterminate);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining(test.text),
        });
        if (test.name === "malformed")
          expect(result.content[0]).not.toHaveProperty("text", expect.stringContaining("Private"));
        if (test.name !== "launcher") {
          // Failed or protected metadata must never proceed to a body read.
          expect(
            readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          ).toEqual(Array(test.attempts ?? 1).fill({ metadataOnly: true }));
        }
      } finally {
        await client.close();
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    15_000
  );
});
