import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterHighlight.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setHighlight: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import { setHighlight } from "../services/privateWriterHighlight.js";
import { registerPrivateWriterHighlightTools } from "./privateWriterHighlightTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const WRITER = { writer: true };
const NUDGE = { nudge: true };

function fixture() {
  const registerTool = vi.fn();
  const manager = {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
  } as unknown as AppleNotesManager;
  registerPrivateWriterHighlightTools({ registerTool } as unknown as McpServer, manager, () => ({
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

describe("highlight writer tool", () => {
  it("registers one idempotent write tool with the writer's safety notes", () => {
    const { config, names } = fixture();
    expect(names()).toEqual(["native-highlight-text"]);
    expect(config("native-highlight-text").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    const description = config("native-highlight-text").description;
    expect(description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
    expect(description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
    expect(description).toMatch(/match_count_mismatch/);
  });

  it("sends a text-scope target for a resolved note, without a nudge by default", async () => {
    vi.mocked(setHighlight).mockReturnValue({ status: "updated", committed: true } as never);
    const r = await fixture().call("native-highlight-text", {
      id: CD,
      match: "due",
      color: "mint",
      expectedCount: 2,
      ifRevision: REV,
    });
    expect(setHighlight).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        target: { scope: "text", match: "due", expectedCount: 2 },
        color: "mint",
        ifRevision: REV,
        dryRun: undefined,
      },
      WRITER
    );
    expect(r.structuredContent).toEqual({ ok: true, status: "updated", committed: true });
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("sends a note-scope target and refuses match or count with it", async () => {
    vi.mocked(setHighlight).mockReturnValue({ status: "planned", committed: false } as never);
    const { call } = fixture();
    await call("native-highlight-text", {
      identifier: NOTE,
      scope: "note",
      color: "blue",
      dryRun: true,
    });
    expect(setHighlight).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        target: { scope: "note" },
        color: "blue",
        ifRevision: undefined,
        dryRun: true,
      },
      WRITER
    );
    for (const extra of [{ match: "due" }, { expectedCount: 2 }]) {
      const r = await call("native-highlight-text", {
        identifier: NOTE,
        scope: "note",
        color: "blue",
        ifRevision: REV,
        ...extra,
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        code: "validation_error",
        helperCode: "invalid_request",
        committed: false,
      });
    }
    const missing = await call("native-highlight-text", {
      identifier: NOTE,
      color: "blue",
      ifRevision: REV,
    });
    expect(missing.structuredContent).toMatchObject({
      helperCode: "invalid_request",
      committed: false,
    });
    expect(setHighlight).toHaveBeenCalledTimes(1);
  });

  it("maps an empty whole-note scope to a validation error", async () => {
    vi.mocked(setHighlight).mockImplementationOnce(() => {
      throw new PrivateWriteError("nothing_to_highlight", "no body", false);
    });
    const r = await fixture().call("native-highlight-text", {
      identifier: NOTE,
      scope: "note",
      color: "mint",
      ifRevision: REV,
    });
    expect(r.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "nothing_to_highlight",
      committed: false,
    });
  });

  it("nudges only after a committed write", async () => {
    vi.mocked(nudgeInPlace).mockResolvedValue({
      allUploadsRecorded: false,
      targets: [],
      before: {},
      after: {},
    } as never);
    vi.mocked(setHighlight).mockReturnValueOnce({ status: "updated", committed: true } as never);
    const args = { identifier: NOTE, match: "due", color: "mint", ifRevision: REV, nudge: true };
    const r = await fixture().call("native-highlight-text", { ...args, nudgeWaitSeconds: 5 });
    expect(r.structuredContent.sync).toEqual({ ok: true, allUploadsRecorded: false, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0]).toEqual([
      { identifiers: [NOTE], waitSeconds: 5 },
      NUDGE,
    ]);
    vi.mocked(setHighlight).mockReturnValueOnce({ status: "planned", committed: false } as never);
    const plan = await fixture().call("native-highlight-text", { ...args, dryRun: true });
    expect(plan.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).toHaveBeenCalledTimes(1);
  });

  it("reports the count guard through the shared envelope", async () => {
    vi.mocked(setHighlight).mockImplementationOnce(() => {
      throw new PrivateWriteError("match_count_mismatch", "2 not 1", false, { found: 2 });
    });
    const r = await fixture().call("native-highlight-text", {
      identifier: NOTE,
      match: "due",
      color: "mint",
      ifRevision: REV,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "match_count_mismatch",
      committed: false,
      found: 2,
    });
  });

  it("validates color, count, and revision in the schema", () => {
    const schema = fixture().config("native-highlight-text").inputSchema;
    expect(schema.color.safeParse("mint").success).toBe(true);
    expect(schema.color.safeParse("none").success).toBe(true);
    expect(schema.color.safeParse("red").success).toBe(false);
    expect(schema.expectedCount.safeParse(0).success).toBe(false);
    expect(schema.expectedCount.safeParse(101).success).toBe(false);
    expect(schema.ifRevision.safeParse(undefined).success).toBe(true);
    expect(schema.ifRevision.safeParse("r1:abc").success).toBe(false);
    expect(schema.match.safeParse("").success).toBe(false);
    expect(schema.match.safeParse(undefined).success).toBe(true);
    expect(schema.scope.safeParse("note").success).toBe(true);
    expect(schema.scope.safeParse("paragraph").success).toBe(false);
  });
});
