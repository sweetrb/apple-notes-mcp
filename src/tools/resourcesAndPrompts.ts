/**
 * MCP resources & prompts for apple-notes (#23).
 *
 * Resources expose read-only views agents can attach as context without a tool
 * round-trip (accounts, folders, stats, and a note-by-id template). Prompts are
 * reusable starting points for common Notes workflows.
 *
 * @module tools/resourcesAndPrompts
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "@/services/appleNotesManager.js";

const json = (uri: URL, data: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

export function registerResourcesAndPrompts(server: McpServer, manager: AppleNotesManager): void {
  // --- Resources ---
  server.resource("accounts", "notes://accounts", (uri) =>
    json(uri, { accounts: manager.listAccounts() })
  );

  server.resource("folders", "notes://folders", (uri) => {
    const data = manager
      .listAccounts()
      .map((a) => ({ account: a.name, folders: manager.listFolders(a.name) }));
    return json(uri, { accounts: data });
  });

  server.resource("stats", "notes://stats", (uri) => json(uri, manager.getNotesStats()));

  server.resource(
    "note",
    new ResourceTemplate("notes://note/{id}", { list: undefined }),
    (uri, variables) => {
      const id = decodeURIComponent(String(variables.id));
      const markdown = manager.getNoteMarkdownById(id);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown || "(not found)" }],
      };
    }
  );

  // --- Prompts ---
  server.prompt(
    "find-note",
    "Search Apple Notes for a topic and summarize the best match",
    { topic: z.string().describe("What to search for") },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Search my Apple Notes for "${topic}" with the search-notes tool (set searchContent: true). Open the most relevant result with get-note-content and give me a concise summary plus its note id.`,
          },
        },
      ],
    })
  );

  server.prompt("weekly-review", "Review notes changed recently and surface follow-ups", () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Use get-notes-stats to see how many notes changed in the last 7 days, then search-notes (searchContent: true, modifiedSince: the date 7 days ago) to list them. Summarize the themes and call out any open action items or checklists I should follow up on.",
        },
      },
    ],
  }));

  server.prompt(
    "new-meeting-note",
    "Draft and create a structured meeting note",
    {
      subject: z.string().describe("Meeting subject"),
      attendees: z.string().optional().describe("Comma-separated attendees"),
      folder: z.string().optional().describe("Target folder"),
    },
    ({ subject, attendees, folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Create an Apple Note titled "${subject}" ${
              folder ? `in folder "${folder}" ` : ""
            }using create-note (format: html). Include sections for Attendees${
              attendees ? ` (${attendees})` : ""
            }, Agenda, Discussion, and Action Items. Render Action Items as a plain bulleted list and remind me I can convert it to a checklist in Notes with ⇧⌘L.`,
          },
        },
      ],
    })
  );
}
