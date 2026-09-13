import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import {
  enrichNoteRead,
  linkSignature,
  readRichNote,
  richContentHash,
  type RichNote,
} from "../utils/noteRichText.js";

const noteId = z.string().regex(/^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);

interface Snapshot {
  id: string;
  title: string;
  body: string;
  hash: string;
  rich: RichNote;
}

function readSnapshot(manager: AppleNotesManager, id: string): Snapshot {
  const note = manager.getNoteById(id);
  if (!note) throw new Error("Note not found");
  if (note.passwordProtected) throw new Error("Locked notes cannot receive attachments");
  const body = manager.getNoteContentById(id);
  if (!body) throw new Error("Note content is unavailable");
  const enriched = enrichNoteRead(id, body);
  const rich = readRichNote(id);
  if (!enriched.complete || enriched.revision !== rich.revision)
    throw new Error("Native metadata changed during read; read the note again");
  return { id, title: note.title, body, rich, hash: richContentHash(body, enriched) };
}

function assertExistingContentPreserved(before: Snapshot, after: Snapshot) {
  if (before.id !== after.id || before.title !== after.title)
    throw new Error("Note identity changed");
  const tidy = (text: string) => text.replace(/\r\n/g, "\n").replace(/[\s\ufffc]+$/gu, "");
  if (!tidy(after.rich.text).startsWith(tidy(before.rich.text)))
    throw new Error("Existing note text was not preserved");
  if (
    linkSignature(before.rich.links) !==
    linkSignature(after.rich.links.slice(0, before.rich.links.length))
  )
    throw new Error("Existing links were not preserved");
  if (before.rich.nativeObjectIds.some((id) => !after.rich.nativeObjectIds.includes(id)))
    throw new Error("Existing native object was lost");
  if (before.rich.nativeTags.some((tag) => !after.rich.nativeTags.includes(tag)))
    throw new Error("Existing native tag was lost");
  for (const item of before.rich.checklistItems || []) {
    const actual = after.rich.checklistItems?.find((current) => current.id === item.id);
    if (!actual || actual.text !== item.text || actual.done !== item.done)
      throw new Error("Existing checklist item identity or state changed");
  }
  for (const object of before.rich.objectData || []) {
    const actual = after.rich.objectData?.find((current) => current.id === object.id);
    if (!actual || actual.mergeable !== object.mergeable || actual.view !== object.view)
      throw new Error("Existing native object content or presentation changed");
  }
}

function localAttachment(path: string): Buffer {
  if (!isAbsolute(path)) throw new Error("An absolute local file path is required");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024)
      throw new Error("Attachment must be a nonempty regular file of at most 64 MiB");
    const bytes = readFileSync(descriptor);
    if (bytes.length !== stat.size)
      throw new Error("Attachment changed while it was being read; try again");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Register exact-ID folder and attachment operations on the MCP server. */
export function registerDirectOperations(server: McpServer, manager: AppleNotesManager) {
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown>,
    readOnly = false
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema: z.object({ ok: z.boolean().optional() }).passthrough(),
        annotations: { readOnlyHint: readOnly },
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

  tool(
    "get-folder-by-id",
    "Use when: reading the exact folder name and parent before a guarded rename.\nReturns: folder id, current name, and parent id.\nDo not use when: listing folders by path (list-folders).\nSafety: read-only.",
    { id: z.string().max(2000) },
    ({ id }) => manager.getFolderById(id),
    true
  );

  tool(
    "rename-folder",
    "Use when: renaming one previously read folder in place.\nReturns: the unchanged folder id, new name, and parent id after readback.\nDo not use when: creating, moving, or deleting a folder.\nSafety: requires the expected current name and parent; refuses stale metadata and sibling conflicts.",
    {
      id: z.string().max(2000),
      expectedName: z.string().max(1000),
      expectedParentId: z.string().max(2000),
      newName: z.string().min(1).max(1000),
    },
    (args) => ({
      ok: true,
      ...manager.renameFolderById(args.id, args.expectedName, args.expectedParentId, args.newName),
    })
  );

  tool(
    "add-attachment",
    "Use when: adding one local file to an exact note without replacing its body.\nReturns: the new attachment id, byte count, and post-write content hash after exact byte verification.\nDo not use when: reading or exporting an existing attachment.\nSafety: requires a fresh rich revision, copies at most 64 MiB through a private temporary file, never retries insertion, and verifies existing content plus fetched bytes.",
    { id: noteId, expectedContentHash: revision, path: z.string().min(1).max(4096) },
    ({ id, expectedContentHash, path }) => {
      const before = readSnapshot(manager, id);
      if (before.hash !== expectedContentHash) throw new Error("Note revision changed");
      const bytes = localAttachment(path);
      const beforeAttachments = manager.listAttachmentsById(id);
      const directory = mkdtempSync(join(tmpdir(), "notes-attachment-add-"));
      const temporaryFile = join(directory, basename(path));
      try {
        writeFileSync(temporaryFile, bytes, { mode: 0o600 });
        if (readSnapshot(manager, id).hash !== before.hash)
          throw new Error("Note revision changed");
        let returnedId: string | undefined;
        let transportUncertain = false;
        try {
          returnedId = manager.addAttachmentById(id, before.body, temporaryFile);
        } catch {
          transportUncertain = true;
        }
        const after = readSnapshot(manager, id);
        assertExistingContentPreserved(before, after);
        const readInserted = () =>
          [
            ...new Map(manager.listAttachmentsById(id).map((item) => [item.id, item])).values(),
          ].filter((item) => !beforeAttachments.some((existing) => existing.id === item.id));
        let inserted = readInserted();
        for (
          let attempt = 0;
          attempt < 4 && (inserted.length !== 1 || (returnedId && returnedId !== inserted[0].id));
          attempt++
        ) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          inserted = readInserted();
        }
        const persistentReturnedId = returnedId && /\/ICAttachment\/p\d+$/.test(returnedId);
        if (inserted.length !== 1 || (persistentReturnedId && returnedId !== inserted[0].id))
          throw new Error(
            "Attachment insertion outcome uncertain; read the exact note before retrying"
          );
        const attachmentId = inserted[0].id;
        const fetched = manager.getAttachmentBase64ById(id, attachmentId);
        const actual =
          typeof fetched.base64 === "string" ? Buffer.from(fetched.base64, "base64") : null;
        if (
          !actual ||
          createHash("sha256").update(actual).digest("hex") !==
            createHash("sha256").update(bytes).digest("hex")
        )
          throw new Error(
            "Attachment bytes were not verified; read the exact note before retrying"
          );
        return {
          ok: true,
          id,
          attachmentId,
          contentHash: after.hash,
          bytes: bytes.length,
          ...(transportUncertain
            ? {
                transportWarning:
                  "Transport was uncertain; exact bytes and prior content were verified",
              }
            : {}),
        };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
}
