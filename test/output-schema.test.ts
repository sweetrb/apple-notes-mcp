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

  it("every advertised schema declares JSON Schema 2020-12 and no draft-07 construct", async () => {
    // MCP standardized on 2020-12 (SEP-834 / SEP-1613 / SEP-2106) and clients
    // now HARD-REJECT anything else: "JSON Schema declares an unsupported
    // dialect … The default validator supports JSON Schema 2020-12 only",
    // which takes out every tool at once. The SDK converts our zod schemas
    // with a draft-07 target and stamps draft-07 on every emitted
    // inputSchema/outputSchema (upgrading zod does not change that — the SDK
    // calls its converter with no target, and both branches fall back to
    // draft-07), so src/index.ts wraps the transport with
    // withJsonSchema2020_12 to normalize the outgoing tools/list payload.
    // Asserted against the REAL advertised schemas, since that wrapper sits at
    // the transport boundary and a unit test of the converter alone would not
    // prove the server is actually using it. (sweetrb/apple-mail-mcp#147)
    const { tools } = await client.listTools();
    const EXPECTED = "https://json-schema.org/draft/2020-12/schema";
    // Keywords that either changed spelling in 2020-12 or were removed.
    const DRAFT_07_ONLY = ["definitions", "dependencies", "additionalItems"] as const;

    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);

    // Walk schema POSITIONS, not raw text: a substring scan would false-flag a
    // tool that legitimately has a property named "definitions". Keys under
    // "properties" / "$defs" are names, not keywords, so only their values are
    // re-entered as schemas.
    const walk = (node: unknown, path: string, report: (msg: string) => void): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`, report));
        return;
      }
      if (!isObject(node)) return;

      if (path !== "" && "$schema" in node) {
        report(`${path} declares its own $schema (only the root may)`);
      }
      for (const keyword of DRAFT_07_ONLY) {
        if (keyword in node) report(`${path || "(root)"} uses draft-07-only "${keyword}"`);
      }
      if (Array.isArray(node.items)) {
        report(`${path || "(root)"} uses tuple-form "items" (2020-12 spells it "prefixItems")`);
      }
      for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
        if (typeof node[key] === "boolean") {
          report(`${path || "(root)"} uses draft-4 boolean "${key}"`);
        }
      }
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/definitions/")) {
        report(`${path || "(root)"} $ref points into "#/definitions/" (should be "#/$defs/")`);
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === "properties" || key === "$defs" || key === "patternProperties") {
          if (isObject(value)) {
            for (const [name, sub] of Object.entries(value)) {
              walk(sub, `${path}.${key}.${name}`, report);
            }
          }
          continue;
        }
        walk(value, path ? `${path}.${key}` : key, report);
      }
    };

    const offenders: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        const dialect = (schema as { $schema?: unknown }).$schema;
        if (dialect !== EXPECTED) {
          offenders.push(`${tool.name}.${kind}: $schema=${JSON.stringify(dialect)}`);
        }
        if (JSON.stringify(schema).includes("draft-07")) {
          offenders.push(`${tool.name}.${kind}: mentions draft-07`);
        }
        walk(schema, "", (msg) => offenders.push(`${tool.name}.${kind}: ${msg}`));
      }
    }

    expect(
      offenders,
      `every advertised schema must declare ${EXPECTED} and use no draft-07-only construct — ` +
        `clients reject the whole tool otherwise: ${offenders.join("; ")}`
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
