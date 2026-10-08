import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { registerNativeTagsBridge } from "./nativeTagsBridge.js";
import { runNativeTagsShortcut } from "../services/nativeTags.js";
import {
  enrichNoteRead,
  readRichNote,
  richContentHash,
  type RichNote,
} from "../utils/noteRichText.js";

vi.mock(import("../utils/noteRichText.js"), async (original) => ({
  ...(await original()),
  enrichNoteRead: vi.fn(),
  readRichNote: vi.fn(),
}));
vi.mock(import("../services/nativeTags.js"), async (original) => ({
  ...(await original()),
  runNativeTagsShortcut: vi.fn(),
}));

const id = "x-coredata://ABCDEF/ICNote/p12";
const body = "<div>Title</div><div>Project marker retained</div><div>Item</div>";
const scopeText = "Project marker retained";
const tagType = "com.apple.notes.inlinetextattachment.hashtag";
const semantics = (objects: Array<{ id: string; type: string }> = []) => ({
  complete: true,
  unknown: false,
  structuredParagraph: false,
  links: false,
  objects,
});
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const rich: RichNote = {
    text: "Title\nProject marker retained\nItem\n\ufffc",
    revision: "revision",
    links: [],
    nativeTags: ["existing"],
    nativeObjectIds: ["tag"],
    hasNativeObjects: true,
    hasChecklist: true,
    objects: [{ id: "tag", type: tagType, start: 35, length: 1 }],
    objectData: [
      { id: "tag", type: tagType, pk: 1, mergeable: "", view: null, altText: "#existing" },
    ],
    checklistItems: [{ id: "item", text: "Item", done: false, start: 30 }],
    nativeTagObjectIds: { existing: ["tag"] },
    nativeObjectDataComplete: true,
    styleRuns: [
      { start: 0, length: 35, signature: "body", nativeSemantics: semantics() },
      {
        start: 35,
        length: 1,
        signature: "tag",
        nativeSemantics: semantics([{ id: "tag", type: tagType }]),
      },
    ],
  };
  const enriched = {
    content: body,
    links: [],
    nativeTags: rich.nativeTags,
    complete: false,
    writable: false,
    revision: rich.revision,
  };
  vi.mocked(enrichNoteRead).mockImplementation(() => ({ ...enriched, revision: rich.revision }));
  vi.mocked(readRichNote).mockImplementation(() => structuredClone(rich));
  const manager = {
    getNoteById: vi.fn(() => ({ id, title: "Title", passwordProtected: false })),
    getNoteContentById: vi.fn(() => body),
    getNotePlaintextById: vi.fn(() => rich.text),
    listAccounts: vi.fn(() => [{ name: "Account" }]),
    searchNotes: vi.fn(() => [{ id, title: "Title", passwordProtected: false }]),
  };
  const registerTool = vi.fn();
  registerNativeTagsBridge(
    { registerTool } as unknown as McpServer,
    manager as unknown as AppleNotesManager
  );
  const invoke = registerTool.mock.calls.find(([name]) => name === "add-native-tags")![2];
  const request = {
    id,
    expectedContentHash: richContentHash(body, enriched),
    scopeText,
    tags: ["newtag"],
  };
  vi.mocked(runNativeTagsShortcut).mockImplementation(() => {
    rich.nativeTags.push("newtag");
    rich.nativeObjectIds.push("new-tag");
    rich.objects!.push({ id: "new-tag", type: tagType, start: rich.text.length + 1, length: 1 });
    rich.objectData!.push({
      id: "new-tag",
      type: tagType,
      pk: 2,
      mergeable: "",
      view: null,
      altText: "#newtag",
    });
    rich.styleRuns!.push(
      { start: rich.text.length, length: 1, signature: "body", nativeSemantics: semantics() },
      {
        start: rich.text.length + 1,
        length: 1,
        signature: "tag",
        nativeSemantics: semantics([{ id: "new-tag", type: tagType }]),
      }
    );
    rich.text += "\n\ufffc";
    rich.nativeTagObjectIds!.newtag = ["new-tag"];
    rich.revision = "after";
  });
  return { rich, enriched, manager, invoke, request };
}

describe("native tag bridge read guards", () => {
  it("allows a valid native-tag/checklist read whose HTML is incomplete for full-body writes", async () => {
    const { invoke, request } = fixture();
    expect((await invoke(request)).structuredContent).toMatchObject({
      ok: true,
      added: ["newtag"],
    });
    expect(runNativeTagsShortcut).toHaveBeenCalledTimes(1);
  });

  it("allows a no-op for existing tags without running Shortcuts", async () => {
    const { invoke, request } = fixture();
    expect((await invoke({ ...request, tags: ["existing"] })).structuredContent).toMatchObject({
      ok: true,
      added: [],
    });
    expect(runNativeTagsShortcut).not.toHaveBeenCalled();
  });

  it("still refuses a revision mismatch before writing", async () => {
    const { invoke, request, enriched } = fixture();
    vi.mocked(enrichNoteRead).mockReturnValue({ ...enriched, revision: "different" });
    const result = await invoke(request);
    expect(result.structuredContent).toMatchObject({ code: "revision_conflict", committed: false });
    expect(runNativeTagsShortcut).not.toHaveBeenCalled();
  });
  it("refuses unavailable enriched metadata before writing", async () => {
    const { invoke, request, enriched } = fixture();
    vi.mocked(enrichNoteRead).mockReturnValue({ ...enriched, revision: "unavailable" });
    const result = await invoke(request);
    expect(result.structuredContent).toMatchObject({ code: "revision_conflict", committed: false });
    expect(runNativeTagsShortcut).not.toHaveBeenCalled();
  });
  it("still requires strict link metadata before writing", async () => {
    const { invoke, request } = fixture();
    vi.mocked(readRichNote).mockImplementation(() => {
      throw new Error("Unsupported link scheme in note");
    });
    const result = await invoke(request);
    expect(result.structuredContent).toMatchObject({ code: "unsupported" });
    expect(runNativeTagsShortcut).not.toHaveBeenCalled();
  });

  it("refuses failed HTML matching even when enrichNoteRead retained the matching revision", async () => {
    const { invoke, request, manager } = fixture();
    manager.getNoteContentById.mockReturnValue("<div>Different body</div>");
    const result = await invoke(request);
    expect(result.structuredContent).toMatchObject({ code: "revision_conflict", committed: false });
    expect(runNativeTagsShortcut).not.toHaveBeenCalled();
  });

  it("reports post-write read inconsistency as indeterminate, never as a safe revision rejection", async () => {
    const { invoke, request, enriched } = fixture();
    const run = vi.mocked(runNativeTagsShortcut).getMockImplementation()!;
    vi.mocked(runNativeTagsShortcut).mockImplementation((input) => {
      run(input);
      vi.mocked(enrichNoteRead).mockReturnValue({ ...enriched, revision: "stale" });
    });
    const result = await invoke(request);
    expect(result.structuredContent).toEqual({ code: "verification_failed", indeterminate: true });
    expect(runNativeTagsShortcut).toHaveBeenCalledTimes(1);
  });
});
