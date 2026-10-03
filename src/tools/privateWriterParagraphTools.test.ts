import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterParagraphs.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setParagraphId: vi.fn(),
}));
vi.mock(import("../services/privateWriterSectionLinks.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  addSectionLink: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import { setParagraphId } from "../services/privateWriterParagraphs.js";
import { addSectionLink } from "../services/privateWriterSectionLinks.js";
import { registerPrivateWriterParagraphTools } from "./privateWriterParagraphTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const WRITER = { sourcePath: "writer.m" };

function fixture() {
  const registerTool = vi.fn();
  const manager = {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
  } as unknown as AppleNotesManager;
  registerPrivateWriterParagraphTools({ registerTool } as unknown as McpServer, manager, () => ({
    writer: WRITER as never,
    nudge: {} as never,
  }));
  const call = async (name: string, args: Record<string, unknown>) =>
    registerTool.mock.calls.find((c) => c[0] === name)![2](args);
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  return { call, config, registerTool, manager };
}

const args = { identifier: NOTE, blockIndex: 2, expectedText: "Heading", ifRevision: REV };

beforeEach(() => vi.clearAllMocks());

describe("native-set-paragraph-id", () => {
  it("registers the paragraph write tools; set-paragraph-id is not destructive", () => {
    const { config, registerTool } = fixture();
    expect(registerTool.mock.calls.map((c) => c[0])).toEqual([
      "native-set-paragraph-id",
      "native-add-section-link",
    ]);
    const tool = config("native-set-paragraph-id");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool.description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
    expect(tool.description).toMatch(/list-note-paragraphs/);
    expect(tool.outputSchema.safeParse({}).success).toBe(true);
  });

  it("declares strict input schemas", () => {
    const schema = fixture().config("native-set-paragraph-id").inputSchema;
    expect(schema.blockIndex.safeParse(-1).success).toBe(false);
    expect(schema.expectedText.safeParse("").success).toBe(false);
    expect(schema.ifRevision.safeParse("r1:x").success).toBe(false);
    expect(schema.paragraphId.safeParse("nope").success).toBe(false);
  });

  it("resolves an x-coredata id and passes the request to the writer deps", async () => {
    vi.mocked(setParagraphId).mockReturnValueOnce({ status: "updated" } as never);
    const { call, manager } = fixture();
    const r = await call("native-set-paragraph-id", { ...args, identifier: undefined, id: CD });
    expect(manager.getNoteLinkById).toHaveBeenCalledWith(CD);
    expect(r.structuredContent).toEqual({ ok: true, status: "updated" });
    expect(setParagraphId).toHaveBeenCalledWith({ ...args, paragraphId: undefined }, WRITER);
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("nudges only after an update, never after an unchanged answer", async () => {
    vi.mocked(nudgeInPlace).mockResolvedValue({ targets: [], before: {}, after: {} } as never);
    vi.mocked(setParagraphId).mockReturnValueOnce({ status: "unchanged" } as never);
    const same = await fixture().call("native-set-paragraph-id", { ...args, nudge: true });
    expect(same.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).not.toHaveBeenCalled();
    vi.mocked(setParagraphId).mockReturnValueOnce({ status: "updated" } as never);
    const r = await fixture().call("native-set-paragraph-id", {
      ...args,
      nudge: true,
      nudgeWaitSeconds: 3,
    });
    expect(r.structuredContent.sync).toEqual({ ok: true, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0][0]).toEqual({
      identifiers: [NOTE],
      waitSeconds: 3,
    });
  });

  it("reports a moved paragraph as a conflict with nothing committed", async () => {
    vi.mocked(setParagraphId).mockImplementationOnce(() => {
      throw new PrivateWriteError("paragraph_changed", "moved", false);
    });
    const r = await fixture().call("native-set-paragraph-id", args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: "revision_conflict",
      helperCode: "paragraph_changed",
      committed: false,
    });
  });
});

describe("native-add-section-link", () => {
  const OTHER = "1C2D3E4F-5A6B-4C7D-8E9F-0A1B2C3D4E5F";
  const chipArgs = { identifier: NOTE, ifRevision: REV };

  it("is a destructive write (it can clear chips) with strict inputs", () => {
    const tool = fixture().config("native-add-section-link");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool.description).toMatch(/macOS 27/);
    expect(tool.inputSchema.position.safeParse("middle").success).toBe(false);
    expect(tool.inputSchema.target.safeParse("nope").success).toBe(false);
    expect(tool.inputSchema.ifTargetRevision.safeParse("r1:x").success).toBe(false);
    expect(tool.inputSchema.blockIndex.safeParse(-1).success).toBe(false);
  });

  it("passes every option through and resolves an x-coredata id", async () => {
    vi.mocked(addSectionLink).mockReturnValueOnce({ status: "updated" } as never);
    const { call, manager } = fixture();
    const r = await call("native-add-section-link", {
      id: CD,
      target: OTHER,
      blockIndex: 3,
      expectedText: "Plans",
      position: "belowTitle",
      clearExistingSectionLinks: true,
      ifRevision: REV,
      ifTargetRevision: REV,
    });
    expect(manager.getNoteLinkById).toHaveBeenCalledWith(CD);
    expect(r.structuredContent).toEqual({ ok: true, status: "updated" });
    expect(addSectionLink).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        target: OTHER,
        blockIndex: 3,
        expectedText: "Plans",
        paragraphId: undefined,
        heading: undefined,
        position: "belowTitle",
        clearExistingSectionLinks: true,
        ifRevision: REV,
        ifTargetRevision: REV,
      },
      WRITER
    );
  });

  it("nudges the target too only when a minted identifier changed it", async () => {
    vi.mocked(nudgeInPlace).mockResolvedValue({ targets: [], before: {}, after: {} } as never);
    vi.mocked(addSectionLink).mockReturnValueOnce({
      selfLink: false,
      paragraphIdMinted: true,
      target: OTHER,
    } as never);
    const r = await fixture().call("native-add-section-link", { ...chipArgs, nudge: true });
    expect(r.structuredContent.sync).toEqual({ ok: true, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0][0].identifiers).toEqual([NOTE, OTHER]);
    vi.mocked(addSectionLink).mockReturnValueOnce({
      selfLink: false,
      paragraphIdMinted: false,
      target: OTHER,
    } as never);
    await fixture().call("native-add-section-link", { ...chipArgs, nudge: true });
    expect(vi.mocked(nudgeInPlace).mock.calls[1][0].identifiers).toEqual([NOTE]);
    vi.mocked(addSectionLink).mockReturnValueOnce({ selfLink: true } as never);
    const plain = await fixture().call("native-add-section-link", chipArgs);
    expect(plain.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).toHaveBeenCalledTimes(2);
  });

  it("maps an ambiguous heading onto the ambiguous code", async () => {
    vi.mocked(addSectionLink).mockImplementationOnce(() => {
      throw new PrivateWriteError("ambiguous_paragraph", "two headings", false);
    });
    const r = await fixture().call("native-add-section-link", chipArgs);
    expect(r.structuredContent).toMatchObject({
      code: "ambiguous",
      helperCode: "ambiguous_paragraph",
      committed: false,
    });
  });
});
