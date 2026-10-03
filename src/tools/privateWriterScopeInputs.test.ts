/**
 * Every private-writer tool that writes a note or a smart folder offers the
 * folder scope guards (#57); the read-only ones and native-sync-push do not.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { registerPrivateWriterTools } from "./privateWriterTools.js";
import { registerComposeNoteTool } from "./composeNoteTool.js";
import { registerPrivateWriterChecklistTools } from "./privateWriterChecklistTools.js";
import { registerPrivateWriterHighlightTools } from "./privateWriterHighlightTools.js";
import { registerPrivateWriterLinkCardTools } from "./privateWriterLinkCardTools.js";
import { registerPrivateWriterParagraphTools } from "./privateWriterParagraphTools.js";
import { registerPrivateWriterTableTools } from "./privateWriterTableTools.js";
import { registerPrivateWriterSmartFolderTools } from "./privateWriterSmartFolderTools.js";
import { registerPrivatePaperWriterTools } from "./privatePaperWriterTools.js";
import { registerPrivateWriterPurgeRepairTools } from "./privateWriterPurgeRepairTools.js";

const GUARD_KEYS = ["ifFolderId", "ifAncestorFolderId", "forbiddenAncestorFolderIds"];
const WITHOUT_GUARDS = [
  "native-writer-status",
  "native-sync-push",
  "native-checklist-state",
  "native-read-tables",
  "native-read-smart-folder",
  "native-read-paper",
];

describe("writer tool scope guards", () => {
  it("are offered by every writer tool that writes", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    const manager = {} as AppleNotesManager;
    registerPrivateWriterTools(server, manager);
    registerComposeNoteTool(server, manager);
    registerPrivateWriterChecklistTools(server, manager);
    registerPrivateWriterHighlightTools(server, manager);
    registerPrivateWriterLinkCardTools(server, manager);
    registerPrivateWriterParagraphTools(server, manager);
    registerPrivateWriterTableTools(server, manager);
    registerPrivateWriterSmartFolderTools(server);
    registerPrivatePaperWriterTools(server, manager);
    registerPrivateWriterPurgeRepairTools(server, manager);
    const tools = registerTool.mock.calls.map((c) => ({
      name: c[0] as string,
      keys: Object.keys((c[1] as { inputSchema: object }).inputSchema),
    }));
    expect(tools.length).toBeGreaterThan(15);
    for (const tool of tools) {
      if (WITHOUT_GUARDS.includes(tool.name)) {
        for (const key of GUARD_KEYS) expect(tool.keys, tool.name).not.toContain(key);
      } else {
        expect(tool.keys, tool.name).toEqual(expect.arrayContaining(GUARD_KEYS));
      }
    }
  });
});
