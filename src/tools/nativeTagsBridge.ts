import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { addNativeTags, nativeTagsStatus, runNativeTagsShortcut } from "../services/nativeTags.js";
import { enrichNoteRead, readRichNote, richContentHash } from "../utils/noteRichText.js";

const noteId = z.string().regex(/^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Register native tag status and mutation tools on the MCP server. */
export function registerNativeTagsBridge(server: McpServer, manager: AppleNotesManager) {
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown>
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema: z.object({ ok: z.boolean().optional() }).passthrough(),
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          const result = handler(args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      }) as unknown as ToolCallback<S>
    );
  }

  const read = (id: string) => {
    const note = manager.getNoteById(id);
    if (!note) throw new Error("Note not found");
    if (note.passwordProtected) throw new Error("Locked notes cannot receive native tags");
    const body = manager.getNoteContentById(id);
    if (!body) throw new Error("Note content is unavailable");
    const enriched = enrichNoteRead(id, body);
    const rich = readRichNote(id);
    if (!enriched.complete || enriched.revision !== rich.revision)
      throw new Error("Native metadata changed during read; read the note again");
    return {
      contentHash: richContentHash(body, enriched),
      title: note.title,
      plaintext: manager.getNotePlaintextById(id),
      rich,
    };
  };

  tool(
    "native-tags-status",
    "Use when: checking whether the Native Tags Shortcut is installed before a tag write.\nReturns: the configured Shortcut name, unique installed identifier, and installed state.\nDo not use when: listing tags on notes (list-native-tags).\nSafety: read-only; installation does not by itself prove Notes permission or a successful live mutation.",
    {},
    () => nativeTagsStatus()
  );

  tool(
    "add-native-tags",
    "Use when: adding real clickable Apple Notes tags to one exact, freshly read note.\nReturns: verified native tags, additions, and the post-write content hash.\nDo not use when: textual #hashtags are sufficient or the note cannot be selected uniquely by its existing title and scope text.\nSafety: requires exact ID, fresh revision, and a distinctive existing scope phrase; verifies original text, links, and native objects after the Shortcut runs and never retries automatically.",
    {
      id: noteId,
      expectedContentHash: revision,
      scopeText: z.string().min(12).max(500),
      tags: z.array(z.string().min(1).max(101)).min(1).max(100),
    },
    ({ id, expectedContentHash, scopeText, tags }) => {
      const initial = read(id);
      const result = addNativeTags(
        { id, expectedContentHash, scopeText, tags, title: initial.title },
        {
          read,
          candidates: (title, scope) =>
            manager.listAccounts().flatMap((account) =>
              manager
                .searchNotes(title, false, account.name)
                .filter(
                  (note) =>
                    !note.passwordProtected &&
                    manager
                      .getNotePlaintextById(note.id)
                      .toLocaleLowerCase()
                      .includes(scope.toLocaleLowerCase())
                )
                .map((note) => note.id)
            ),
          run: runNativeTagsShortcut,
        }
      );
      return { ok: true, id, ...result };
    }
  );
}
