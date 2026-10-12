/** Production registration and SDK validation over serialized synthetic messages. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NoteTable, NoteTablesResult } from "@/types.js";

const fixture = vi.hoisted(() => ({
  transport: undefined as unknown,
  getNoteTablesById: vi.fn(),
  getNoteMetadata: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return fixture.transport;
  }),
}));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock(import("@/services/appleNotesManager.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  AppleNotesManager: vi.fn().mockImplementation(function () {
    return { getNoteTablesById: fixture.getNoteTablesById };
  }) as never,
}));
vi.mock("@/utils/noteMetadata.js", () => ({ getNoteMetadata: fixture.getNoteMetadata }));

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";
const packets: Array<{ result: unknown; bytes: number }> = [];
let client: Client;

function table(index: number, text: string, complete = true): NoteTable {
  const rows = [["Header"], [complete ? text : null]];
  return {
    index,
    id: `table-${index}`,
    attachmentId: `x-coredata://ABC/ICAttachment/p${index}`,
    complete,
    rows,
    rowIds: [`header-${index}`, `body-${index}`],
    columnIds: [`column-${index}`],
    rowCount: 2,
    columnCount: 1,
    markdown: `| Header |\n| --- |\n| ${complete ? text : "[undecoded cell]"} |`,
    ...(!complete
      ? {
          reason: "Synthetic undecodable cell",
          incompleteCells: [{ row: 1, column: 0, reason: "Synthetic undecodable cell" }],
        }
      : {}),
  };
}

beforeAll(async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  fixture.transport = serverTransport;
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    // Encode and decode every outgoing packet rather than sharing object references.
    const wire = JSON.stringify(message);
    const serialized = JSON.parse(wire) as typeof message;
    if ("result" in serialized) {
      packets.push({
        result: serialized.result,
        bytes: Buffer.byteLength(JSON.stringify(serialized.result), "utf8"),
      });
    }
    await send(serialized, options);
  };
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  try {
    await import("@/index.js");
  } finally {
    on.mockRestore();
    stdinOn.mockRestore();
  }
  client = new Client({ name: "synthetic-table-budget", version: "0" });
  await client.connect(clientTransport);
}, 30000);
afterAll(async () => client?.close());
beforeEach(() => {
  packets.length = 0;
  vi.clearAllMocks();
  fixture.getNoteMetadata.mockReturnValue({ metadata: { passwordProtected: false } });
});

describe("get-note-tables synthetic SDK transport", () => {
  it("continues whole tables, oversized receipts and null cells through the production handler", async () => {
    const tables = [
      table(1, '"\\🧭漢'.repeat(120)),
      table(2, "oversized".repeat(20000)),
      table(3, "", false),
    ];
    const input: NoteTablesResult = {
      tables,
      tableCellsComplete: false,
      markdown: tables.map((t) => t.markdown).join("\n\n"),
    };
    fixture.getNoteTablesById.mockReturnValue(input);
    const seen: NoteTable[] = [];
    let offset = 0;
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const result = await client.callTool({
        name: "get-note-tables",
        arguments: { id: ID, offset, maxBytes: 8192, limit: 3 },
      });
      expect(result.isError).toBeFalsy();
      const packet = packets.at(-1)!;
      expect(packet.result).toEqual(result);
      expect(packet.bytes).toBeLessThanOrEqual(8192);
      const content = result.structuredContent as {
        tables: NoteTable[];
        page: { nextOffset?: number; hasMore: boolean };
      };
      seen.push(...content.tables);
      if (!content.page.hasMore) break;
      expect(content.page.nextOffset).toBeGreaterThan(offset);
      offset = content.page.nextOffset!;
    }
    expect(seen.map((t) => t.id)).toEqual(tables.map((t) => t.id));
    expect(seen[0]).toEqual(tables[0]);
    expect(seen[1]).toMatchObject({ id: "table-2", contentOmitted: true, complete: false });
    expect(seen[1]).not.toHaveProperty("rows");
    expect(seen[2]).toEqual(tables[2]);
    expect(fixture.getNoteTablesById.mock.calls.every(([id]) => id === ID)).toBe(true);
  });

  it("rejects invalid budgets through SDK validation before any fixture read", async () => {
    const result = await client.callTool({
      name: "get-note-tables",
      arguments: { id: ID, maxBytes: 1023 },
    });
    expect(result.isError).toBe(true);
    expect(fixture.getNoteMetadata).not.toHaveBeenCalled();
    expect(fixture.getNoteTablesById).not.toHaveBeenCalled();
  });
});
