import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterChecklist.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readNativeChecklist: vi.fn(),
  setChecklistItem: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import { readNativeChecklist, setChecklistItem } from "../services/privateWriterChecklist.js";
import { registerPrivateWriterChecklistTools } from "./privateWriterChecklistTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const TODO = "056bf1349dc54f3490aaf36649efe82e";
const WRITER = { writer: true };
const NUDGE = { nudge: true };

function fixture() {
  const registerTool = vi.fn();
  const manager = {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
  } as unknown as AppleNotesManager;
  registerPrivateWriterChecklistTools({ registerTool } as unknown as McpServer, manager, () => ({
    writer: WRITER as never,
    nudge: NUDGE as never,
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error(`missing ${name}`);
    return item[2](args);
  };
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  const names = () => registerTool.mock.calls.map((c) => c[0]);
  return { call, config, names };
}

beforeEach(() => vi.clearAllMocks());

describe("checklist writer tools", () => {
  it("registers a read-only state tool and an idempotent write tool", () => {
    const { config, names } = fixture();
    expect(names()).toEqual(["native-checklist-state", "native-set-checklist-item"]);
    expect(config("native-checklist-state").annotations.readOnlyHint).toBe(true);
    expect(config("native-set-checklist-item").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    const description = config("native-set-checklist-item").description;
    expect(description).toMatch(/Safety:.*ifRevision/s);
    expect(description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
    expect(description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
  });

  it("reads the native checklist for a resolved note through the writer deps", async () => {
    vi.mocked(readNativeChecklist).mockReturnValue({ items: [], revision: REV } as never);
    const r = await fixture().call("native-checklist-state", { id: CD });
    expect(readNativeChecklist).toHaveBeenCalledWith(NOTE, WRITER);
    expect(r.structuredContent).toMatchObject({ ok: true, revision: REV });
  });

  it("toggles one item and returns the writer's read-back without a nudge by default", async () => {
    vi.mocked(setChecklistItem).mockReturnValue({
      status: "updated",
      committed: true,
      persistedDone: true,
    } as never);
    const r = await fixture().call("native-set-checklist-item", {
      identifier: NOTE,
      todoIdentifier: TODO,
      done: true,
      ifRevision: REV,
    });
    expect(setChecklistItem).toHaveBeenCalledWith(
      { identifier: NOTE, todoIdentifier: TODO, done: true, ifRevision: REV },
      WRITER
    );
    expect(r.structuredContent).toEqual({
      ok: true,
      status: "updated",
      committed: true,
      persistedDone: true,
    });
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("nudges after a committed toggle, and skips the nudge for a no-op", async () => {
    vi.mocked(setChecklistItem).mockReturnValueOnce({
      status: "updated",
      committed: true,
    } as never);
    vi.mocked(nudgeInPlace).mockResolvedValueOnce({
      allUploadsRecorded: true,
      targets: [],
      before: {},
      after: {},
    } as never);
    const args = { identifier: NOTE, todoIdentifier: TODO, done: true, ifRevision: REV };
    const r = await fixture().call("native-set-checklist-item", { ...args, nudge: true });
    expect(r.structuredContent.sync).toEqual({ ok: true, allUploadsRecorded: true, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0]).toEqual([
      { identifiers: [NOTE], waitSeconds: undefined },
      NUDGE,
    ]);
    vi.mocked(setChecklistItem).mockReturnValueOnce({
      status: "unchanged",
      committed: false,
    } as never);
    const noop = await fixture().call("native-set-checklist-item", { ...args, nudge: true });
    expect(noop.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).toHaveBeenCalledTimes(1);
  });

  it("reports writer refusals through the shared envelope", async () => {
    vi.mocked(setChecklistItem).mockImplementationOnce(() => {
      throw new PrivateWriteError("ambiguous_target", "twice", false);
    });
    const r = await fixture().call("native-set-checklist-item", {
      identifier: NOTE,
      todoIdentifier: TODO,
      done: false,
      ifRevision: REV,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "ambiguous",
      helperCode: "ambiguous_target",
      committed: false,
    });
  });

  it("validates the todo identifier, done flag, and revision in the schema", () => {
    const schema = fixture().config("native-set-checklist-item").inputSchema;
    expect(schema.todoIdentifier.safeParse(TODO).success).toBe(true);
    expect(schema.todoIdentifier.safeParse("056BF134-9DC5-4F34-90AA-F36649EFE82E").success).toBe(
      true
    );
    expect(schema.todoIdentifier.safeParse("item 1").success).toBe(false);
    expect(schema.done.safeParse("true").success).toBe(false);
    expect(schema.ifRevision.safeParse("r1:abc").success).toBe(false);
  });
});
