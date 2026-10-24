import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";
import { withJsonSchema2020_12 } from "./jsonSchemaDialect.js";
import { installSchemaContracts, integerNumber } from "./toolRegistration.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture() {
  const server = new McpServer({ name: "schema-contract", version: "1" });
  installSchemaContracts(server);
  const client = new Client({ name: "schema-contract-test", version: "1" });
  cleanup.push(
    () => client.close(),
    () => server.close()
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return {
    server,
    client,
    connect: async () => {
      await server.connect(withJsonSchema2020_12(serverTransport));
      await client.connect(clientTransport);
    },
  };
}

describe("tool schema contracts across Zod versions", () => {
  it("advertises closed root/nested inputs while stripping unknown keys before callbacks", async () => {
    const { server, client, connect } = await fixture();
    let received: unknown;
    server.registerTool(
      "nested",
      {
        inputSchema: { row: z.object({ value: z.string() }) },
        outputSchema: z.object({ row: z.object({ value: z.string() }).optional() }).passthrough(),
      },
      async (args) => {
        received = args;
        return { content: [], structuredContent: { extra: true } };
      }
    );
    await connect();
    const { tools } = await client.listTools();
    const schema = tools[0].inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect((schema.properties!.row as { additionalProperties: boolean }).additionalProperties).toBe(
      false
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ row: { value: "ok" } })).toBe(true);
    expect(validate({ row: { value: "ok", extra: true } })).toBe(false);
    await client.callTool({
      name: "nested",
      arguments: { row: { value: "ok", extra: true }, extra: true },
    });
    expect(received).toEqual({ row: { value: "ok" } });
    expect(tools[0].outputSchema?.additionalProperties).toBe(true);
    expect(
      (tools[0].outputSchema?.properties as Record<string, { additionalProperties: boolean }>).row
        .additionalProperties
    ).toBe(false);
  });

  it("advertises passthrough items as open and keeps their undeclared keys", async () => {
    const { server, client, connect } = await fixture();
    server.registerTool(
      "items",
      {
        inputSchema: {},
        outputSchema: z
          .object({ notes: z.array(z.object({}).passthrough()).optional() })
          .passthrough(),
      },
      async () => ({ content: [], structuredContent: { notes: [{ id: "x" }], extra: 1 } })
    );
    await connect();
    const { tools } = await client.listTools();
    const notes = (tools[0].outputSchema?.properties as Record<string, { items: unknown }>).notes;
    expect(notes.items).toMatchObject({ additionalProperties: true });
    expect(await client.callTool({ name: "items", arguments: {} })).toMatchObject({
      structuredContent: { notes: [{ id: "x" }], extra: 1 },
    });
  });

  it("retains raw empty input shapes' permissive advertisement", async () => {
    const { server, client, connect } = await fixture();
    server.registerTool("empty", { inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    await connect();
    const { tools } = await client.listTools();
    expect(tools[0].inputSchema.additionalProperties).not.toBe(false);
    expect(await client.callTool({ name: "empty", arguments: { extra: true } })).not.toHaveProperty(
      "isError",
      true
    );
  });

  it("keeps integers beyond the safe range, rejects fractions, and advertises integer bounds", async () => {
    const { server, client, connect } = await fixture();
    let received: unknown;
    server.registerTool(
      "integer",
      { inputSchema: { count: integerNumber().min(1).default(50) } },
      async (args) => {
        received = args;
        return { content: [] };
      }
    );
    await connect();
    const { tools } = await client.listTools();
    const count = tools[0].inputSchema.properties!.count;
    expect(count).toMatchObject({ type: "integer", minimum: 1, default: 50 });
    expect(count).not.toHaveProperty("maximum");
    await client.callTool({ name: "integer", arguments: { count: 1e20 } });
    expect(received).toEqual({ count: 1e20 });
    expect(await client.callTool({ name: "integer", arguments: { count: 1.5 } })).toMatchObject({
      isError: true,
    });
    expect(await client.callTool({ name: "integer", arguments: { count: 0 } })).toMatchObject({
      isError: true,
    });
  });

  it("validates two-argument record values through the SDK", async () => {
    const { server, client, connect } = await fixture();
    server.registerTool(
      "record",
      { inputSchema: { tags: z.record(z.string(), z.array(z.string())) } },
      async () => ({ content: [] })
    );
    await connect();
    expect(
      await client.callTool({ name: "record", arguments: { tags: { a: ["x"] } } })
    ).not.toHaveProperty("isError", true);
    expect(
      await client.callTool({ name: "record", arguments: { tags: { a: [1] } } })
    ).toMatchObject({ isError: true });
    const { tools } = await client.listTools();
    expect(tools[0].inputSchema.properties!.tags).toMatchObject({
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
    });
  });
});
