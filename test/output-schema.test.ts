/**
 * outputSchema contract — belt-and-suspenders for the registerTool/outputSchema
 * migration. Boots the REAL built server over stdio and verifies the MCP
 * output-schema guarantees end-to-end through the SDK:
 *
 *   1. every tool advertises an outputSchema (none slipped back to plain server.tool)
 *   2. every outputSchema is permissive — no required fields — so the SDK's
 *      structuredContent validation can never reject a valid success result for a
 *      conditionally-absent field
 *   3. the diagnostic tools round-trip without a validation rejection. The SDK's
 *      validateToolOutput (server mcp.js) THROWS McpError when a success result's
 *      structuredContent is missing or fails the schema, which rejects callTool —
 *      so a resolving call proves a real payload validates against its schema.
 *      (Environment failures return isError results, which the SDK exempts, so
 *      they don't cause a false failure.)
 *
 * Needs no Notes account, so it always runs (including CI). Requires build/ —
 * `npm ci` runs prepare→build and test:integration runs after the build in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = resolve(__dirname, "../build/index.js");

describe("outputSchema contract (real server over stdio)", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env } as Record<string, string>,
    });
    client = new Client({ name: "outputschema-contract-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("registers tools, and every tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing, `tools missing an outputSchema: ${missing.join(", ")}`).toEqual([]);
  });

  it("every outputSchema is permissive — no required fields", async () => {
    const { tools } = await client.listTools();
    const offenders = tools
      .filter((t) => {
        const req = (t.outputSchema as { required?: unknown } | undefined)?.required;
        return Array.isArray(req) && req.length > 0;
      })
      .map(
        (t) =>
          `${t.name}: requires [${(t.outputSchema as { required: string[] }).required.join(", ")}]`
      );
    expect(
      offenders,
      `outputSchemas must not require fields (a missing field would reject a valid result): ${offenders.join("; ")}`
    ).toEqual([]);
  });

  it("every outputSchema tolerates undeclared keys (additionalProperties !== false)", async () => {
    // The CLIENT validates structuredContent against the ADVERTISED JSON Schema
    // (client/index.js -> "Structured content does not match the tool's output
    // schema"), so `additionalProperties: false` makes any field the schema
    // didn't enumerate a hard -32602 that discards an otherwise-correct result.
    // The server never notices, because zod's own parse strips unknown keys
    // instead of failing — so nothing but this assertion catches it. A bare zod
    // raw shape renders as additionalProperties:false; registerTool() in
    // src/index.ts wraps every shape in .passthrough() to prevent that.
    // Not hypothetical: this took down get-mail-stats in the sibling
    // apple-mail-mcp (sweetrb/apple-mail-mcp#135).
    const { tools } = await client.listTools();
    const offenders = tools
      .filter(
        (t) =>
          (t.outputSchema as { additionalProperties?: unknown } | undefined)
            ?.additionalProperties === false
      )
      .map((t) => t.name);
    expect(
      offenders,
      `outputSchemas must tolerate undeclared keys — these advertise ` +
        `additionalProperties:false, so any field they don't enumerate is rejected ` +
        `client-side and the whole result is lost: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("diagnostic tools' real output validates against their outputSchema (when reachable)", async () => {
    // The SDK throws an "Output validation error" McpError when a success
    // result's structuredContent is missing or fails its schema — the only
    // failure we treat as a bug. A slow or unavailable backend (e.g. AppleScript
    // timing out on a headless CI runner) is tolerated, not failed.
    for (const name of ["health-check", "doctor"]) {
      const call = client.callTool({ name, arguments: {} });
      try {
        await Promise.race([
          call,
          new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
        ]);
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        if (/output validation error|invalid structured content/i.test(msg)) throw err;
        // otherwise: environment/transport error — the tool couldn't run here
      }
      // Swallow any late rejection (e.g. when the client closes mid-call).
      void Promise.resolve(call).catch(() => {});
    }
  }, 30_000);
});
