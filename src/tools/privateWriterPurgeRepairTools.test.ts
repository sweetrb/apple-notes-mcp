import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterPurgeRepair.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  repairPurgeFlag: vi.fn(),
}));
import { PrivateWriteError } from "../services/privateWriter.js";
import { repairPurgeFlag } from "../services/privateWriterPurgeRepair.js";
import { registerPrivateWriterPurgeRepairTools } from "./privateWriterPurgeRepairTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const F1 = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICFolder/p10298";
const WRITER = { writer: true };

function fixture() {
  const registerTool = vi.fn();
  const manager = {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
  } as unknown as AppleNotesManager;
  registerPrivateWriterPurgeRepairTools({ registerTool } as unknown as McpServer, manager, () => ({
    writer: WRITER as never,
    nudge: {} as never,
  }));
  const call = async (args: Record<string, unknown>) =>
    registerTool.mock.calls[0][2](args) as Promise<{
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    }>;
  return { call, registerTool, manager };
}

beforeEach(() => vi.clearAllMocks());

describe("native-repair-purge-flag", () => {
  it("registers one destructive, gated tool that explains the state and the risk", () => {
    const { registerTool } = fixture();
    expect(registerTool.mock.calls.map((c) => c[0])).toEqual(["native-repair-purge-flag"]);
    const config = registerTool.mock.calls[0][1];
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(config.description).toMatch(/never purges/);
    expect(config.description).toMatch(/confirm: true/);
    expect(config.description).toMatch(/permanent delete on another device/);
    expect(config.description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
    expect(Object.keys(config.inputSchema)).toEqual(
      expect.arrayContaining(["ifFolderId", "ifAncestorFolderId", "forbiddenAncestorFolderIds"])
    );
  });

  it("scans without an identifier and never resolves a note", async () => {
    vi.mocked(repairPurgeFlag).mockReturnValue({ status: "scanned" } as never);
    const { call, manager } = fixture();
    const r = await call({});
    expect(r.structuredContent).toEqual({ ok: true, status: "scanned" });
    expect(repairPurgeFlag).toHaveBeenCalledWith(
      {
        identifier: undefined,
        dryRun: undefined,
        ifRevision: undefined,
        confirm: undefined,
        scope: undefined,
      },
      WRITER
    );
    expect(manager.getNoteLinkById).not.toHaveBeenCalled();
  });

  it("resolves an x-coredata id and passes the apply fields and the guard through", async () => {
    vi.mocked(repairPurgeFlag).mockReturnValue({ status: "repaired", committed: true } as never);
    const { call } = fixture();
    await call({ id: CD, dryRun: false, ifRevision: REV, confirm: true, ifFolderId: F1 });
    expect(vi.mocked(repairPurgeFlag).mock.calls[0][0]).toEqual({
      identifier: NOTE,
      dryRun: false,
      ifRevision: REV,
      confirm: true,
      scope: { ifFolderId: F1 },
    });
  });

  it("reports a refusal through the writer envelope", async () => {
    vi.mocked(repairPurgeFlag).mockImplementation(() => {
      throw new PrivateWriteError("confirmation_required", "pass confirm: true", false);
    });
    const r = await fixture().call({ identifier: NOTE, dryRun: false, ifRevision: REV });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "confirmation_required",
      committed: false,
    });
  });
});
