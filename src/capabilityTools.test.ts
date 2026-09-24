/**
 * The capability matrix must describe tools that exist. A feature that names a
 * missing tool, or a placeholder that hides a shipped tool, sends agents the
 * wrong way. The truth is the built server's tools/list, as in docsTruth.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FEATURES } from "@/services/capabilityMatrix.js";

/** "get-note-markdown (checklist annotations)" names the tool get-note-markdown. */
const toolName = (entry: string): string => entry.split(/[\s(]/)[0];

describe("capability matrix vs the built server's tools", () => {
  let client: Client;
  let tools: Array<{ name: string; description?: string }>;

  beforeAll(async () => {
    client = new Client({ name: "capability-tools-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(__dirname, "../build/index.js")],
        env: { ...process.env } as Record<string, string>,
      })
    );
    tools = (await client.listTools()).tools;
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it("registers every tool a feature names", () => {
    const registered = new Set(tools.map((t) => t.name));
    const named = FEATURES.flatMap((f) => f.tools.map((entry) => [f.name, toolName(entry)]));
    expect(named.length).toBeGreaterThan(0);
    const missing = named.filter(([, name]) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it("lists every tool that requires Full Disk Access under a feature that requires it", () => {
    const fdaTools = new Set(
      FEATURES.filter((f) => f.requirements.some((r) => r.kind === "full_disk_access")).flatMap(
        (f) => f.tools.map(toolName)
      )
    );
    const requiresFda = tools
      .filter((t) => /requires Full Disk Access/i.test(t.description ?? ""))
      .map((t) => t.name);
    expect(requiresFda.length).toBeGreaterThan(0);
    expect(requiresFda.filter((name) => !fdaTools.has(name))).toEqual([]);
  });
});
