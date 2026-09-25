import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterLinkCard.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  addUrlCard: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import { addUrlCard } from "../services/privateWriterLinkCard.js";
import { registerPrivateWriterLinkCardTools } from "./privateWriterLinkCardTools.js";

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
  registerPrivateWriterLinkCardTools({ registerTool } as unknown as McpServer, manager, () => ({
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

describe("link card writer tool", () => {
  it("registers one non-idempotent write tool with the writer's safety notes", () => {
    const { config, names } = fixture();
    expect(names()).toEqual(["native-add-url-card"]);
    expect(config("native-add-url-card").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    const description = config("native-add-url-card").description;
    expect(description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
    expect(description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
    expect(description).toMatch(/no network request/);
  });

  it("adds a card to a resolved note, without a nudge by default", async () => {
    vi.mocked(addUrlCard).mockReturnValue({ status: "updated", committed: true } as never);
    const r = await fixture().call("native-add-url-card", {
      id: CD,
      url: "https://example.com/",
      afterParagraph: "Links",
      ifRevision: REV,
    });
    expect(addUrlCard).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        url: "https://example.com/",
        afterParagraph: "Links",
        ifRevision: REV,
        dryRun: undefined,
      },
      WRITER
    );
    expect(r.structuredContent).toEqual({ ok: true, status: "updated", committed: true });
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("nudges only after a committed write", async () => {
    vi.mocked(nudgeInPlace).mockResolvedValue({
      allUploadsRecorded: true,
      targets: [],
      before: {},
      after: {},
    } as never);
    vi.mocked(addUrlCard).mockReturnValueOnce({ status: "updated", committed: true } as never);
    const args = { identifier: NOTE, url: "https://example.com/", ifRevision: REV, nudge: true };
    const r = await fixture().call("native-add-url-card", args);
    expect(r.structuredContent.sync).toEqual({ ok: true, allUploadsRecorded: true, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0]).toEqual([
      { identifiers: [NOTE], waitSeconds: undefined },
      NUDGE,
    ]);
    vi.mocked(addUrlCard).mockReturnValueOnce({ status: "planned", committed: false } as never);
    const plan = await fixture().call("native-add-url-card", { ...args, dryRun: true });
    expect(plan.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).toHaveBeenCalledTimes(1);
  });

  it("reports the anchor guard through the shared envelope", async () => {
    vi.mocked(addUrlCard).mockImplementationOnce(() => {
      throw new PrivateWriteError("match_count_mismatch", "0 paragraphs", false, { found: 0 });
    });
    const r = await fixture().call("native-add-url-card", {
      identifier: NOTE,
      url: "https://example.com/",
      afterParagraph: "Nope",
      ifRevision: REV,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "match_count_mismatch",
      committed: false,
      found: 0,
    });
  });

  it("validates url, anchor, and revision in the schema", () => {
    const schema = fixture().config("native-add-url-card").inputSchema;
    expect(schema.url.safeParse("").success).toBe(false);
    expect(schema.url.safeParse("x".repeat(2049)).success).toBe(false);
    expect(schema.afterParagraph.safeParse("").success).toBe(false);
    expect(schema.ifRevision.safeParse(undefined).success).toBe(true);
    expect(schema.ifRevision.safeParse("r1:abc").success).toBe(false);
  });
});
