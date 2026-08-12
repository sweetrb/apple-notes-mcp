/**
 * JSON Schema dialect normalization for outgoing MCP tool schemas.
 *
 * The MCP SDK converts our Zod tool schemas with a draft-07 target and stamps
 * "$schema": "http://json-schema.org/draft-07/schema#" onto every emitted
 * inputSchema/outputSchema. MCP has since standardized on JSON Schema 2020-12
 * (SEP-834 / SEP-1613 / SEP-2106), and clients now reject anything else:
 *
 *   Tool '<name>' has an invalid outputSchema: JSON Schema declares an
 *   unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#").
 *   The default validator supports JSON Schema 2020-12 only.
 *
 * Upgrading Zod does NOT help: the SDK calls its converter without a target, so
 * both its v3 (zod-to-json-schema) and v4 (zod/v4-mini toJSONSchema) branches
 * fall back to draft-07. Verified empirically against SDK 1.30.0 + Zod 4.4.3.
 *
 * So we normalize the outgoing payload ourselves at the transport boundary --
 * the only public seam that does not reach into SDK internals.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const DEFINITIONS_REF_PREFIX = "#/definitions/";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively rewrite the draft-07 keywords whose meaning or spelling changed
 * in 2020-12. Anything already dialect-neutral passes through untouched.
 */
function convertNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNode);
  if (!isPlainObject(node)) return node;

  const hasTupleItems = Array.isArray(node.items);
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "$schema":
        // Dropped here and re-stamped at the root only; subschemas must not
        // carry their own dialect declaration.
        break;

      case "definitions":
        out.$defs = convertNode(value);
        break;

      case "$ref":
        out.$ref =
          typeof value === "string" && value.startsWith(DEFINITIONS_REF_PREFIX)
            ? "#/$defs/" + value.slice(DEFINITIONS_REF_PREFIX.length)
            : value;
        break;

      case "items":
        // The tuple form "items: [A, B]" became "prefixItems" in 2020-12.
        if (hasTupleItems) out.prefixItems = (value as unknown[]).map(convertNode);
        else out.items = convertNode(value);
        break;

      case "additionalItems":
        // Only meaningful alongside a tuple, where it is now plain "items".
        if (hasTupleItems) out.items = convertNode(value);
        break;

      case "dependencies": {
        // Split into the two keywords that replaced it.
        const dependentRequired: JsonObject = {};
        const dependentSchemas: JsonObject = {};
        if (isPlainObject(value)) {
          for (const [property, dependency] of Object.entries(value)) {
            if (Array.isArray(dependency)) dependentRequired[property] = dependency;
            else dependentSchemas[property] = convertNode(dependency);
          }
        }
        if (Object.keys(dependentRequired).length > 0) out.dependentRequired = dependentRequired;
        if (Object.keys(dependentSchemas).length > 0) out.dependentSchemas = dependentSchemas;
        break;
      }

      case "exclusiveMinimum":
      case "exclusiveMaximum": {
        // Draft-4 spelled these as booleans modifying minimum/maximum.
        const bound = key === "exclusiveMinimum" ? node.minimum : node.maximum;
        if (value === true && typeof bound === "number") out[key] = bound;
        else if (value !== false) out[key] = convertNode(value);
        break;
      }

      case "minimum":
        if (node.exclusiveMinimum === true) break;
        out.minimum = convertNode(value);
        break;

      case "maximum":
        if (node.exclusiveMaximum === true) break;
        out.maximum = convertNode(value);
        break;

      default:
        out[key] = convertNode(value);
    }
  }

  return out;
}

/** Convert one JSON Schema document to 2020-12, declaring the dialect at its root. */
export function toJsonSchema2020_12<T>(schema: T): T {
  if (!isPlainObject(schema)) return schema;
  return {
    $schema: JSON_SCHEMA_2020_12,
    ...(convertNode(schema) as JsonObject),
  } as T;
}

/**
 * Rewrite the tool schemas in an outgoing tools/list result. Any other message
 * -- responses, notifications, errors -- is returned unchanged.
 */
export function normalizeOutgoingMessage(message: unknown): unknown {
  if (!isPlainObject(message)) return message;

  const result = message.result;
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return message;

  const tools = result.tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const next: JsonObject = { ...tool };
    if (isPlainObject(tool.inputSchema)) next.inputSchema = toJsonSchema2020_12(tool.inputSchema);
    if (isPlainObject(tool.outputSchema))
      next.outputSchema = toJsonSchema2020_12(tool.outputSchema);
    return next;
  });

  return { ...message, result: { ...result, tools } };
}

/**
 * Wrap a transport so every tools/list payload it sends declares 2020-12.
 * Returns the same instance, so it composes directly into server.connect().
 */
export function withJsonSchema2020_12<T extends Transport>(transport: T): T {
  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) =>
    originalSend(normalizeOutgoingMessage(message) as Parameters<Transport["send"]>[0], options);
  return transport;
}
