import { describe, it, expect, vi, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { syntheticRichNote } from "../utils/__fixtures__/retainedRichNote.js";
// Keep the mutation implementation real; substitute only probes and dependencies.
// NATIVE_APPEND_HTML_SUBSET stays real because descriptions use that constant.
vi.mock(import("../services/backgroundNotes.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  backgroundStatus: vi.fn(() => ({ installed: false, shortcut: "Background Operations" })),
  nativeTagBridgeStatus: vi.fn(() => ({ installed: false })),
  markdownNoteStatus: vi.fn(() => ({ installed: false })),
  backgroundDependencies: vi.fn(),
}));
vi.mock(import("../utils/noteRichText.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readRichNote: vi.fn(),
}));
// The matrix probe spawns sw_vers, sqlite3, and shortcuts; keep these tests hermetic.
vi.mock(import("../services/capabilityMatrix.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCapabilityMatrix: vi.fn(() => ({
    runtimeOS: { platform: "darwin" as const, macOSVersion: "26.0", darwinRelease: "25.0.0" },
    features: {},
  })),
}));
import { registerNativeOperations, requireValidated } from "./nativeOperations.js";
import { readRichNote } from "../utils/noteRichText.js";
import {
  backgroundDependencies,
  backgroundStatus,
  markdownNoteStatus,
} from "../services/backgroundNotes.js";
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const registerTool = vi.fn();
  registerNativeOperations({ registerTool } as unknown as McpServer, {} as AppleNotesManager);
  return (name: string) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error("Tool missing");
    return item;
  };
}
describe("background capability boundaries", () => {
  it.each(["create-checklist-item", "create-checklist-items"])(
    "returns an explicit no-write refusal from the registered %s handler",
    async (name) => {
      const id = "x-coredata://ABC/ICNote/p1";
      const scopeText = "Unique project marker";
      const prefix = `Title\n${scopeText}\n`;
      const rich = syntheticRichNote(`${prefix}task\n\ufffc`, {
        items: [{ id: "1".padStart(32, "0"), text: "task", start: prefix.length, done: false }],
        objects: [
          { id: "table", type: "com.apple.notes.table", start: prefix.length + 5, length: 1 },
        ],
      });
      const snapshot = {
        id,
        title: "Title",
        hash: `sha256:${"1".repeat(64)}`,
        html: "",
        rich,
        checklist: [{ text: "task", done: false }],
      };
      const deps = {
        read: vi.fn(() => snapshot),
        candidates: vi.fn(() => [id]),
        run: vi.fn(),
      };
      vi.mocked(backgroundDependencies).mockReturnValueOnce(deps);
      if (name === "create-checklist-items") vi.mocked(readRichNote).mockReturnValueOnce(rich);
      const result = await fixture()(name)[2]({
        id,
        scopeText,
        expectedContentHash: snapshot.hash,
        ...(name === "create-checklist-item" ? { text: "new" } : { items: ["new", "next"] }),
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "validation_error", committed: false, indeterminate: false },
      });
      expect(deps.read).toHaveBeenCalledTimes(2);
      expect(deps.run).not.toHaveBeenCalled();
      if (name === "create-checklist-items")
        expect(result.structuredContent).toMatchObject({
          landed: [],
          stoppedAt: { index: 0, outcome: "not-written" },
          notAttempted: ["next"],
        });
    }
  );
  it("requires both bridges for tag replacement, but only the background bridge for removal", async () => {
    vi.mocked(backgroundStatus).mockReturnValueOnce({
      installed: true,
      shortcut: "Background Operations",
    });
    const r = await fixture()("get-capabilities")[2]({});
    expect(r.structuredContent.operations["remove-native-tags"].available).toBe(true);
    expect(r.structuredContent.operations["replace-native-tag"].available).toBe(false);
    expect(r.structuredContent.operations["replace-native-tag"].reason).toMatch(/addition phase/);
  });
  it("gates Markdown note creation on its own bridge, not Background Operations", async () => {
    vi.mocked(backgroundStatus).mockReturnValueOnce({
      installed: true,
      shortcut: "Background Operations",
    });
    const missing = await fixture()("get-capabilities")[2]({});
    expect(missing.structuredContent.markdownNoteBridgeInstalled).toBe(false);
    expect(missing.structuredContent.operations["create-note-markdown"]).toMatchObject({
      verified: true,
      available: false,
      reason: expect.stringMatching(/apple-notes-mcp setup/),
    });
    vi.mocked(markdownNoteStatus).mockReturnValueOnce({
      installed: true,
      shortcut: "Apple Notes MCP - Create Markdown Note",
    });
    const installed = await fixture()("get-capabilities")[2]({});
    expect(installed.structuredContent.bridge.installed).toBe(false);
    expect(installed.structuredContent.markdownNoteBridgeInstalled).toBe(true);
    expect(installed.structuredContent.operations["create-note-markdown"]).toMatchObject({
      verified: true,
      available: true,
    });
    expect(installed.structuredContent.operations["append-native"].available).toBe(false);
  });
  it("discloses missing setup and rejected native actions separately", async () => {
    const get = fixture();
    const r = await get("get-capabilities")[2]({});
    expect(r.structuredContent.bridge.installed).toBe(false);
    expect(r.structuredContent.operations["append-native"].available).toBe(false);
    expect(r.structuredContent.operations["append-native"].verified).toBe(true);
    expect(r.structuredContent.unavailable["set-checklist-item"]).toMatch(/unsupported features/);
  });
  it("reports live-verified Markdown block import on the Create Markdown Note bridge", async () => {
    const missing = await fixture()("get-capabilities")[2]({});
    expect(missing.structuredContent.operations["create-note-markdown-blocks"]).toMatchObject({
      implemented: true,
      verified: true,
      available: false,
      reason: expect.stringMatching(/apple-notes-mcp setup/),
    });
    vi.mocked(markdownNoteStatus).mockReturnValueOnce({
      installed: true,
      shortcut: "Apple Notes MCP - Create Markdown Note",
    });
    const r = await fixture()("get-capabilities")[2]({});
    expect(r.structuredContent.operations["create-note-markdown-blocks"]).toMatchObject({
      verified: true,
      available: true,
    });
    expect(() => requireValidated("create-note-markdown-blocks")).not.toThrow();
  });
  it("reports live-verified native creation as available with v5 installed", async () => {
    vi.mocked(backgroundStatus).mockReturnValueOnce({
      installed: true,
      shortcut: "Apple Notes MCP - Background Operations v5",
    });
    const r = await fixture()("get-capabilities")[2]({});
    expect(r.structuredContent.operations["append-native"]).toMatchObject({
      verified: true,
      available: true,
    });
    expect(r.structuredContent.operations["create-checklist-item"]).toMatchObject({
      verified: true,
      available: true,
    });
  });
  it("adds runtimeOS and the feature matrix while keeping every existing key", async () => {
    const r = await fixture()("get-capabilities")[2]({});
    expect(Object.keys(r.structuredContent)).toEqual(
      expect.arrayContaining([
        "bridge",
        "nativeTagBridgeInstalled",
        "markdownNoteBridgeInstalled",
        "mode",
        "operations",
        "unavailable",
        "runtimeOS",
        "features",
      ])
    );
    expect(r.structuredContent.runtimeOS.macOSVersion).toBe("26.0");
  });
  it("uses permissive output schemas for native tools", () => {
    expect(fixture()("append-native")[1].outputSchema.parse({ contentHash: "next" })).toMatchObject(
      {
        contentHash: "next",
      }
    );
  });
});
