/** Real SDK registration and manager parsing with synthetic mutation outcomes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fixture = vi.hoisted(() => ({ transport: undefined as unknown, execute: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return fixture.transport;
  }),
}));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock("@/utils/applescript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/applescript.js")>()),
  executeAppleScript: fixture.execute,
}));
vi.mock("@/utils/smartFolders.js", () => ({
  readSmartFolders: vi.fn(() => ({ folders: [] })),
}));

const STORE = "x-coredata://ABC00000-0000-0000-0000-000000000004";
const ids = [1, 2, 3].map((number) => `${STORE}/ICNote/p${number}`);
const folderId = `${STORE}/ICFolder/p10`;
const R = "\x1e";
const packets: unknown[] = [];
let client: Client;

beforeAll(async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  fixture.transport = serverTransport;
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    const serialized = JSON.parse(JSON.stringify(message)) as typeof message;
    if ("result" in serialized) packets.push(serialized.result);
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
  client = new Client({ name: "synthetic-batch-move-outcomes", version: "0" });
  await client.connect(clientTransport);
}, 30000);
afterAll(async () => client?.close());
beforeEach(() => {
  vi.clearAllMocks();
  packets.length = 0;
});

describe("batch-move-notes synthetic SDK transport", () => {
  it("preserves empty-slot uncertainty, confirmed moves and refusals at their exact IDs", async () => {
    fixture.execute.mockReturnValue({
      success: true,
      output: `${R}ok${R}SAFETY_SCOPE:the note is not in the expected folder${R}`,
    });
    const result = await client.callTool({
      name: "batch-move-notes",
      arguments: { ids, folder: "Archive", account: "iCloud", ifFolderId: folderId },
    });
    expect(result.isError).toBeFalsy();
    expect(packets.at(-1)).toEqual(result);
    expect(result.structuredContent).toMatchObject({ ok: false, succeeded: 1, failed: 2 });
    const outcomes = (result.structuredContent as { results: unknown[] }).results;
    expect(outcomes[0]).toEqual({
      id: ids[0],
      success: false,
      error: "Unknown error",
      indeterminate: true,
    });
    expect(outcomes[1]).toEqual({ id: ids[1], success: true });
    expect(outcomes[2]).toMatchObject({
      id: ids[2],
      success: false,
      committed: false,
      indeterminate: false,
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execute.mock.calls[0][1]).toEqual({ maxRetries: 1 });
  });

  it("does not claim the entire batch was refused when another result is missing", async () => {
    fixture.execute.mockReturnValue({
      success: true,
      output: `SAFETY_SCOPE:the note is not in the expected folder${R}${R}`,
    });
    const result = await client.callTool({
      name: "batch-move-notes",
      arguments: {
        ids: ids.slice(0, 2),
        folder: "Archive",
        account: "iCloud",
        ifFolderId: folderId,
      },
    });
    expect(result.isError).toBe(true);
    expect(packets.at(-1)).toEqual(result);
    expect(result.structuredContent).toMatchObject({
      code: "verification_failed",
      indeterminate: true,
    });
    expect(result.structuredContent).not.toHaveProperty("committed");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execute.mock.calls[0][1]).toEqual({ maxRetries: 1 });
  });
});
