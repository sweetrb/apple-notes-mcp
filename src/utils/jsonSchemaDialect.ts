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

/**
 * Keywords whose value is a map of caller-chosen NAME -> schema.
 *
 * Their keys are user data -- a tool's parameter names -- not schema keywords,
 * so they must never be run through the keyword rewrites below. Without this,
 * a tool declaring a parameter named "definitions" would have it renamed to
 * "$defs" on the wire, and one named "$schema" would be silently DELETED, while
 * "required" still named the original -- yielding a schema no input satisfies.
 *
 * "definitions" is deliberately absent: it is a real keyword at a schema
 * position, and its own case below converts it and renames it to $defs.
 */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "dependentSchemas",
]);

/**
 * Keywords whose value is instance DATA rather than a schema. Recursing into
 * them would rewrite a caller's literal values as if they were schema keywords
 * (e.g. a default of { definitions: 1, $schema: "x" }), so they pass verbatim.
 */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "enum",
  "const",
  "default",
  "examples",
  "required",
  "dependentRequired",
]);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert every VALUE of a name -> schema map, leaving the caller's names untouched. */
function convertSchemaMap(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: JsonObject = {};
  for (const [name, subschema] of Object.entries(node)) out[name] = convertNode(subschema);
  return out;
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
        out.$defs = convertSchemaMap(value);
        break;

      case "$ref":
        // Known, deliberate limitation: only a $ref with the exact ROOT prefix
        // "#/definitions/" is rewritten. A pointer THROUGH a nested definitions
        // block (e.g. "#/properties/x/definitions/Y") is left alone, because
        // "#/properties/definitions/..." could legitimately address a property
        // NAMED definitions and the two are indistinguishable without resolving
        // the pointer. The SDK's converter emits neither construct.
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
        // Position-aware fallthrough: instance data passes verbatim, a
        // name -> schema map has only its VALUES converted, and anything else
        // is a schema position and recurses.
        if (DATA_KEYWORDS.has(key)) out[key] = value;
        else if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = convertSchemaMap(value);
        else out[key] = convertNode(value);
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
