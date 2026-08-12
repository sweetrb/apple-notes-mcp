import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSON_SCHEMA_2020_12,
  toJsonSchema2020_12,
  normalizeOutgoingMessage,
  withJsonSchema2020_12,
} from "@/utils/jsonSchemaDialect.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

describe("toJsonSchema2020_12", () => {
  it("stamps the 2020-12 dialect at the root", () => {
    const out = toJsonSchema2020_12({ type: "object", properties: { a: { type: "string" } } }) as {
      $schema: string;
      type: string;
    };
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(out.type).toBe("object");
  });

  it("replaces an existing draft-07 declaration rather than keeping both", () => {
    const out = toJsonSchema2020_12({ $schema: DRAFT_07, type: "object" });
    expect(JSON.stringify(out)).not.toContain("draft-07");
    expect((out as { $schema: string }).$schema).toBe(JSON_SCHEMA_2020_12);
  });

  it("strips $schema from nested subschemas — only the root declares a dialect", () => {
    const out = toJsonSchema2020_12({
      $schema: DRAFT_07,
      type: "object",
      properties: {
        nested: { $schema: DRAFT_07, type: "string" },
        inArray: { type: "array", items: { $schema: DRAFT_07, type: "number" } },
      },
    });
    expect(JSON.stringify(out)).not.toContain("draft-07");
    expect(JSON.stringify(out).match(/2020-12/g)).toHaveLength(1);
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      properties: {
        nested: { type: "string" },
        inArray: { type: "array", items: { type: "number" } },
      },
    });
  });

  it("returns non-objects untouched", () => {
    expect(toJsonSchema2020_12(true)).toBe(true);
    expect(toJsonSchema2020_12(null)).toBe(null);
    expect(toJsonSchema2020_12("nope")).toBe("nope");
  });

  it("renames definitions to $defs and rewrites #/definitions/X refs", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      definitions: { Note: { type: "object", properties: { id: { type: "string" } } } },
      properties: { note: { $ref: "#/definitions/Note" } },
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      $defs: { Note: { type: "object", properties: { id: { type: "string" } } } },
      properties: { note: { $ref: "#/$defs/Note" } },
    });
  });

  it("leaves a $ref that is not a #/definitions/ pointer alone", () => {
    const out = toJsonSchema2020_12({
      properties: {
        dateFrom: { type: "string" },
        dateTo: { $ref: "#/properties/dateFrom" },
        external: { $ref: "https://example.com/schema.json" },
        weird: { $ref: 42 },
      },
    }) as { properties: Record<string, { $ref: unknown }> };
    expect(out.properties.dateTo.$ref).toBe("#/properties/dateFrom");
    expect(out.properties.external.$ref).toBe("https://example.com/schema.json");
    expect(out.properties.weird.$ref).toBe(42);
  });

  it("converts tuple items to prefixItems and additionalItems to items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: { type: "boolean" },
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "boolean" },
    });
    expect(out).not.toHaveProperty("additionalItems");
  });

  it("drops a stray additionalItems rather than clobbering a non-tuple items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: { type: "string" },
      additionalItems: { type: "boolean" },
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "array",
      items: { type: "string" },
    });
    expect(out).not.toHaveProperty("additionalItems");
    expect(out).not.toHaveProperty("prefixItems");
  });

  it("splits dependencies into dependentRequired and dependentSchemas", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      dependencies: {
        creditCard: ["billingAddress"],
        shipping: { properties: { carrier: { type: "string" } } },
      },
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      dependentRequired: { creditCard: ["billingAddress"] },
      dependentSchemas: { shipping: { properties: { carrier: { type: "string" } } } },
    });
    expect(out).not.toHaveProperty("dependencies");
  });

  it("emits only the halves of dependencies that are populated", () => {
    const arraysOnly = toJsonSchema2020_12({ dependencies: { a: ["b"] } });
    expect(arraysOnly).not.toHaveProperty("dependentSchemas");
    expect(arraysOnly).toHaveProperty("dependentRequired");

    const schemasOnly = toJsonSchema2020_12({ dependencies: { a: { type: "string" } } });
    expect(schemasOnly).not.toHaveProperty("dependentRequired");
    expect(schemasOnly).toHaveProperty("dependentSchemas");

    // A malformed (non-object) dependencies value yields neither keyword.
    const malformed = toJsonSchema2020_12({ dependencies: "nonsense" });
    expect(malformed).toEqual({ $schema: JSON_SCHEMA_2020_12 });
  });

  it("collapses boolean exclusiveMinimum/Maximum onto the numeric bound", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 5,
      exclusiveMinimum: true,
      maximum: 10,
      exclusiveMaximum: true,
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "number",
      exclusiveMinimum: 5,
      exclusiveMaximum: 10,
    });
    expect(out).not.toHaveProperty("minimum");
    expect(out).not.toHaveProperty("maximum");
  });

  it("drops a false exclusiveMinimum/Maximum and keeps the inclusive bound", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 5,
      exclusiveMinimum: false,
      maximum: 10,
      exclusiveMaximum: false,
    });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      type: "number",
      minimum: 5,
      maximum: 10,
    });
    expect(out).not.toHaveProperty("exclusiveMinimum");
    expect(out).not.toHaveProperty("exclusiveMaximum");
  });

  it("passes an already-numeric exclusiveMinimum/Maximum through unchanged", () => {
    const out = toJsonSchema2020_12({ exclusiveMinimum: 5, exclusiveMaximum: 10 });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      exclusiveMinimum: 5,
      exclusiveMaximum: 10,
    });
  });

  it("keeps a boolean exclusiveMinimum when there is no numeric bound to fold into", () => {
    // Degenerate input, but silently dropping the keyword would change meaning
    // less predictably than carrying it forward.
    const out = toJsonSchema2020_12({ exclusiveMinimum: true, exclusiveMaximum: true });
    expect(out).toEqual({
      $schema: JSON_SCHEMA_2020_12,
      exclusiveMinimum: true,
      exclusiveMaximum: true,
    });
  });
});

describe("normalizeOutgoingMessage", () => {
  const toolsListResult = () => ({
    jsonrpc: "2.0" as const,
    id: 2,
    result: {
      tools: [
        {
          name: "list-notes",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
          outputSchema: { $schema: DRAFT_07, type: "object", additionalProperties: true },
        },
        {
          name: "search-notes",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
          outputSchema: { $schema: DRAFT_07, type: "object", additionalProperties: true },
        },
      ],
    },
  });

  it("rewrites inputSchema and outputSchema on every tool", () => {
    const out = normalizeOutgoingMessage(toolsListResult()) as {
      result: { tools: { inputSchema: { $schema: string }; outputSchema: { $schema: string } }[] };
    };
    expect(out.result.tools).toHaveLength(2);
    for (const tool of out.result.tools) {
      expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
      expect(tool.outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    }
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("leaves a tool without an outputSchema alone", () => {
    const message = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "no-output", inputSchema: { $schema: DRAFT_07, type: "object" } },
          "not-an-object",
        ],
      },
    };
    const out = normalizeOutgoingMessage(message) as {
      result: { tools: [{ outputSchema?: unknown; inputSchema: { $schema: string } }, string] };
    };
    expect(out.result.tools[0]).not.toHaveProperty("outputSchema");
    expect(out.result.tools[0].inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.result.tools[1]).toBe("not-an-object");
  });

  it("does not mutate the message it was given", () => {
    const message = toolsListResult();
    normalizeOutgoingMessage(message);
    expect(message.result.tools[0].inputSchema.$schema).toBe(DRAFT_07);
  });

  it("returns a tools/call result unchanged", () => {
    const message = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "hi" }], structuredContent: { ok: true } },
    };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns a notification unchanged", () => {
    const message = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns an error response unchanged", () => {
    const message = { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns a result whose tools is not an array unchanged", () => {
    const message = { jsonrpc: "2.0", id: 5, result: { tools: "nope" } };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns non-objects unchanged", () => {
    expect(normalizeOutgoingMessage(null)).toBe(null);
    expect(normalizeOutgoingMessage("string")).toBe("string");
  });
});

describe("withJsonSchema2020_12", () => {
  it("returns the same transport instance so it composes into server.connect()", () => {
    const transport = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Transport;
    expect(withJsonSchema2020_12(transport)).toBe(transport);
  });

  it("delegates to the original send with the NORMALIZED message and forwards options", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const transport = { send } as unknown as Transport;
    const originalSend = send;

    withJsonSchema2020_12(transport);
    expect(transport.send).not.toBe(originalSend);

    const options = { relatedRequestId: 7 };
    await transport.send(
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "list-notes",
              inputSchema: { $schema: DRAFT_07, type: "object" },
              outputSchema: { $schema: DRAFT_07, type: "object" },
            },
          ],
        },
      } as unknown as Parameters<Transport["send"]>[0],
      options as Parameters<Transport["send"]>[1]
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [sentMessage, sentOptions] = send.mock.calls[0];
    expect(sentOptions).toBe(options);
    expect(JSON.stringify(sentMessage)).not.toContain("draft-07");
    expect(sentMessage.result.tools[0].inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(sentMessage.result.tools[0].outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
  });

  it("passes a non-tools/list message straight through", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const transport = { send } as unknown as Transport;
    withJsonSchema2020_12(transport);

    const message = { jsonrpc: "2.0", method: "notifications/initialized" };
    await transport.send(message as unknown as Parameters<Transport["send"]>[0]);

    expect(send).toHaveBeenCalledWith(message, undefined);
    expect(send.mock.calls[0][0]).toBe(message);
  });

  it("binds send to its transport, so the original implementation keeps its `this`", async () => {
    class FakeTransport {
      sent: unknown[] = [];
      async send(message: unknown): Promise<void> {
        // Throws a TypeError if `this` was lost by the wrapper.
        this.sent.push(message);
      }
    }
    const transport = new FakeTransport() as unknown as Transport;
    withJsonSchema2020_12(transport);
    await transport.send({ jsonrpc: "2.0", method: "ping" } as unknown as Parameters<
      Transport["send"]
    >[0]);
    expect((transport as unknown as FakeTransport).sent).toHaveLength(1);
  });
});
