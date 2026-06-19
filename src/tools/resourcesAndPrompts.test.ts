import { describe, it, expect, vi } from "vitest";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "@/services/appleNotesManager.js";

interface CapturedResource {
  uriOrTemplate: unknown;
  cb: (uri: URL, vars: Record<string, unknown>) => { contents: { text: string }[] };
}
class FakeServer {
  resources = new Map<string, CapturedResource>();
  prompts = new Map<string, (...a: unknown[]) => { messages: { content: { text: string } }[] }>();
  resource(name: string, uriOrTemplate: unknown, cb: CapturedResource["cb"]): void {
    this.resources.set(name, { uriOrTemplate, cb });
  }
  prompt(name: string, ...rest: unknown[]): void {
    this.prompts.set(name, rest[rest.length - 1] as never);
  }
}

function fakeMgr(): AppleNotesManager {
  return {
    listAccounts: () => [{ name: "iCloud" }],
    listFolders: vi.fn(() => [{ name: "Notes" }]),
    getNotesStats: () => ({
      totalNotes: 1,
      accounts: [],
      recentlyModified: { last24h: 0, last7d: 0, last30d: 0 },
    }),
    getNoteMarkdownById: vi.fn(() => "# Hello"),
  } as unknown as AppleNotesManager;
}

describe("registerResourcesAndPrompts (#23)", () => {
  it("registers the expected resources and prompts", () => {
    const s = new FakeServer();
    registerResourcesAndPrompts(s as unknown as McpServer, fakeMgr());
    expect([...s.resources.keys()].sort()).toEqual(["accounts", "folders", "note", "stats"]);
    expect([...s.prompts.keys()].sort()).toEqual([
      "find-note",
      "new-meeting-note",
      "weekly-review",
    ]);
  });

  it("accounts/folders/stats resources return JSON", () => {
    const s = new FakeServer();
    registerResourcesAndPrompts(s as unknown as McpServer, fakeMgr());
    const acc = s.resources.get("accounts")!.cb(new URL("notes://accounts"), {});
    expect(JSON.parse(acc.contents[0].text)).toEqual({ accounts: [{ name: "iCloud" }] });
    const fol = s.resources.get("folders")!.cb(new URL("notes://folders"), {});
    expect(JSON.parse(fol.contents[0].text).accounts[0].account).toBe("iCloud");
    const st = s.resources.get("stats")!.cb(new URL("notes://stats"), {});
    expect(JSON.parse(st.contents[0].text).totalNotes).toBe(1);
  });

  it("note template resolves the id and returns markdown", () => {
    const s = new FakeServer();
    const mgr = fakeMgr();
    registerResourcesAndPrompts(s as unknown as McpServer, mgr);
    const out = s.resources.get("note")!.cb(new URL("notes://note/abc%20def"), { id: "abc%20def" });
    expect(mgr.getNoteMarkdownById).toHaveBeenCalledWith("abc def");
    expect(out.contents[0].text).toBe("# Hello");
  });

  it("prompts produce user messages including their args", () => {
    const s = new FakeServer();
    registerResourcesAndPrompts(s as unknown as McpServer, fakeMgr());
    expect(s.prompts.get("find-note")!({ topic: "taxes" }).messages[0].content.text).toMatch(
      /taxes/
    );
    expect(s.prompts.get("weekly-review")!({}).messages[0].content.text).toMatch(/last 7 days/);
    const mtg = s.prompts.get("new-meeting-note")!({ subject: "Q3 Plan", attendees: "Rob, Sam" });
    expect(mtg.messages[0].content.text).toMatch(/Q3 Plan/);
    expect(mtg.messages[0].content.text).toMatch(/Rob, Sam/);
  });
});
