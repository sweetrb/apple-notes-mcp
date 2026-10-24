/**
 * Keep the advertised tool contracts stable across the Zod 3 -> Zod 4 upgrade.
 *
 * Zod 3's JSON Schema converter advertised a plain (strip) object as closed
 * (`additionalProperties: false`) and a `.passthrough()` object as open
 * (`additionalProperties: true`). Zod 4's converter, as the MCP SDK calls it,
 * omits both, so every tool's inputSchema would silently lose the closed-object
 * contract and every outputSchema its explicit permissive one. Parsing is
 * unchanged either way (strip objects still strip, passthrough still passes
 * through); only the advertisement drifts. These helpers restore it through
 * Zod 4's supported JSON Schema metadata, without touching parsing, catchall
 * validation, refinements, transforms or handlers.
 *
 * Ported from sweetrb/apple-mail-mcp#327 (approach from #326). This repo
 * registers tools from index.ts and from several src/tools modules, so the
 * contract is applied at the one seam they all share — `server.registerTool` —
 * via installSchemaContracts(), the same install pattern as structuredText.
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Walk a Zod 4 schema graph and stamp `additionalProperties` metadata onto
 * every object: `false` for strip/strict objects, `true` for objects whose
 * catchall is unknown/any (`.passthrough()` / `.loose()`). Objects with any
 * other catchall are left to the converter.
 */
export function preserveObjectSchemaContracts(schema: unknown): void {
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof z.ZodType) {
      if (value instanceof z.ZodObject) {
        const catchall = value.def.catchall;
        if (!catchall || catchall instanceof z.ZodNever) {
          z.globalRegistry.add(value, { ...value.meta(), additionalProperties: false });
        } else if (catchall instanceof z.ZodUnknown || catchall instanceof z.ZodAny) {
          z.globalRegistry.add(value, { ...value.meta(), additionalProperties: true });
        }
      }
      visit(value.def);
    } else {
      for (const child of Object.values(value)) visit(child);
    }
  }
  visit(schema);
}

/**
 * Apply the schema contracts to a tool the SDK has just registered.
 *
 * The SDK retains a raw input shape and wraps it in an object only when it
 * lists tools, so a non-empty raw shape is wrapped here first; the root
 * advertisement then carries the same metadata as nested objects. An empty raw
 * shape is left alone so its (permissive) advertisement is unchanged.
 */
export function applySchemaContracts(tool: RegisteredTool, inputSchema: unknown): RegisteredTool {
  // Test doubles of McpServer may return nothing from registerTool.
  if (!tool || typeof tool !== "object") return tool;
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    !(inputSchema instanceof z.ZodType) &&
    Object.keys(inputSchema).length > 0
  ) {
    tool.inputSchema = z.object(inputSchema as z.ZodRawShape);
  }
  preserveObjectSchemaContracts(tool.inputSchema);
  preserveObjectSchemaContracts(tool.outputSchema);
  return tool;
}

/**
 * Make every tool registered on `server` from now on advertise the Zod 3-era
 * object contracts. Call once, right after the server is constructed and
 * before any tool is registered.
 */
export function installSchemaContracts(server: McpServer): void {
  const target = server as unknown as {
    registerTool: (name: string, config: { inputSchema?: unknown }, cb: unknown) => RegisteredTool;
  };
  const register = target.registerTool;
  target.registerTool = function (name, config, cb) {
    return applySchemaContracts(register.call(this, name, config, cb), config?.inputSchema);
  };
}

/**
 * An integer that keeps Zod 3's full integer domain. Zod 4's `.int()` also
 * caps values at Number.MAX_SAFE_INTEGER and advertises that cap as a
 * `maximum`/`minimum`, which would tighten every unbounded integer parameter.
 */
export function integerNumber() {
  return z
    .number()
    .refine(Number.isInteger, { message: "Expected integer" })
    .meta({ type: "integer" });
}
