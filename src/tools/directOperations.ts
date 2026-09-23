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
import { basename, extname, isAbsolute, join } from "node:path";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  exactIdInput,
  lookupStableIdentifiers,
  looseIdTransform,
  NOTE_ID_MESSAGE,
} from "../utils/noteIdentifiers.js";
import { errorResult } from "../utils/errorCodes.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import {
  enrichNoteRead,
  linkSignature,
  readRichNote,
  richContentHash,
  type RichNote,
} from "../utils/noteRichText.js";

// Accepts the x-coredata id as before, plus the note's Notes UUID or numeric
// Core Data key, resolved to the x-coredata id before the handler runs.
const noteId = exactIdInput(
  "ICNote",
  /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i,
  NOTE_ID_MESSAGE
);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Free-form folder id as before; a Notes UUID or numeric key resolves to the
// folder's x-coredata id (never to a note or attachment).
const folderId = z.string().max(2000).transform(looseIdTransform("ICFolder"));

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
  // `complete` is false for any note that holds a native object, and a note
  // always holds one after an attachment lands. Attaching never rewrites the
  // body, so require only a consistent metadata revision, as the native
  // background writes do; assertExistingContentPreserved checks the objects.
  if (enriched.revision !== rich.revision)
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
          return errorResult(error instanceof Error ? error.message : String(error), error);
        }
      }) as unknown as ToolCallback<S>
    );
  }

  tool(
    "get-folder-by-id",
    "Use when: reading the exact folder name, parent, and account before a guarded rename or delete-folder-by-id.\nReturns: folder id, current name, parent id, accountId, and isRoot (true when the folder sits at the account root; pass expectedRoot: true to delete-folder-by-id then, otherwise parentId as expectedParentId).\nDo not use when: listing folders by path (list-folders).\nSafety: read-only.",
    { id: folderId },
    ({ id }) => {
      const folder = manager.getFolderById(id);
      return { ...folder, ...lookupStableIdentifiers([folder.id], "ICFolder").get(folder.id) };
    },
    true
  );

  tool(
    "rename-folder",
    "Use when: renaming one previously read folder in place.\nReturns: the unchanged folder id, new name, and parent id after readback.\nDo not use when: creating, moving, or deleting a folder.\nSafety: requires the expected current name and parent; refuses stale metadata and sibling conflicts.",
    {
      id: folderId,
      expectedName: z.string().max(1000),
      expectedParentId: z.string().max(2000),
      newName: z.string().min(1).max(1000),
    },
    (args) => ({
      ok: true,
      ...manager.renameFolderById(args.id, args.expectedName, args.expectedParentId, args.newName),
    })
  );

  const attachmentInput = {
    path: z.string().min(1).max(4096).describe("Absolute path of the local file to attach"),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Name the attachment gets in Notes instead of the source file's name. One path component with the source file's extension; no slash, colon, or control characters, and no leading dot."
      ),
  };

  tool(
    "add-attachment",
    "Use when: adding one local file to an exact note without replacing its body.\nReturns: the new attachment id, byte count, attachment name, and post-write content hash after exact byte verification.\nDo not use when: reading or exporting an existing attachment.\nSafety: requires a fresh rich revision, copies at most 64 MiB through a private temporary file, never retries insertion, and verifies existing content plus fetched bytes.",
    { id: noteId, expectedContentHash: revision, ...attachmentInput },
    (args) => attachFile(manager, args)
  );

  tool(
    "create-note-with-attachment",
    "Use when: creating a new note that holds one local file, in one call.\nReturns: the new note id plus the add-attachment result (attachment id, bytes, name, content hash).\nDo not use when: the note already exists (add-attachment).\nSafety: checks the file and filename before creating anything, creates the note through Notes.app like create-note, then attaches with the same byte verification as add-attachment. If the attachment step fails after the note exists, the error names the new note's id; attach to it with add-attachment instead of creating another note.",
    {
      title: z
        .string()
        .min(1)
        .max(2000)
        .refine((s) => !/[\r\n\0]/u.test(s), "One-line title"),
      content: z
        .string()
        .min(1)
        .max(1024 * 1024)
        .optional()
        .describe("Optional plain-text body placed above the attachment"),
      folder: z
        .string()
        .max(1000)
        .optional()
        .describe("Existing folder or nested path; create it first with create-folder"),
      account: z.string().max(200).optional().describe("Account name; defaults to Notes' default"),
      ...attachmentInput,
    },
    (args) => {
      // Refuse a bad file or name before a note exists.
      const name = attachmentName(args.path, args.filename);
      localAttachment(args.path);
      const note = manager.createNote(
        args.title,
        args.content ?? "",
        [],
        args.folder,
        args.account,
        "plaintext"
      );
      if (!note)
        throw new Error(
          `Failed to create note "${args.title}". Check that the folder and account exist (list-folders, list-accounts); nothing was attached`
        );
      const handOff = `Note ${note.id} was created; attach to it with add-attachment instead of creating another note`;
      let snapshot: Snapshot;
      try {
        snapshot = readSnapshot(manager, note.id);
      } catch (error) {
        throw new Error(`${handOff}. The new note could not be read back: ${String(error)}`);
      }
      try {
        return {
          ...attachFile(manager, {
            id: note.id,
            expectedContentHash: snapshot.hash,
            path: args.path,
            filename: name,
          }),
          title: args.title,
          folder: args.folder,
          noteCreated: true,
        };
      } catch (error) {
        throw new Error(`${handOff}. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Validate an attachment name override and return the name Notes will show.
 * Notes names a file attachment after the file it received, so the override is
 * applied by naming the private temporary copy. Keeping the source extension
 * keeps the file type Notes infers from the name consistent with the bytes.
 */
export function attachmentName(path: string, filename?: string): string {
  const source = basename(path);
  if (filename === undefined) return source;
  if (Buffer.byteLength(filename, "utf8") > 255)
    throw new Error("filename must be at most 255 bytes");
  if (
    filename !== filename.trim() ||
    filename === "" ||
    filename.startsWith(".") ||
    /[/:\\\p{Cc}]/u.test(filename)
  )
    throw new Error(
      "filename must be one path component with no slash, colon, backslash, control character, leading dot, or surrounding spaces"
    );
  if (extname(filename).toLowerCase() !== extname(source).toLowerCase())
    throw new Error(
      `filename must keep the source file's extension (${extname(source) || "none"})`
    );
  return filename;
}

/** Insert one verified local file into an exact, unchanged note. */
function attachFile(
  manager: AppleNotesManager,
  args: { id: string; expectedContentHash: string; path: string; filename?: string }
): Record<string, unknown> {
  const { id, expectedContentHash, path } = args;
  const name = attachmentName(path, args.filename);
  const before = readSnapshot(manager, id);
  if (before.hash !== expectedContentHash) throw new Error("Note revision changed");
  const bytes = localAttachment(path);
  const beforeAttachments = manager.listAttachmentsById(id);
  const directory = mkdtempSync(join(tmpdir(), "notes-attachment-add-"));
  const temporaryFile = join(directory, name);
  try {
    writeFileSync(temporaryFile, bytes, { mode: 0o600 });
    if (readSnapshot(manager, id).hash !== before.hash) throw new Error("Note revision changed");
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
      [...new Map(manager.listAttachmentsById(id).map((item) => [item.id, item])).values()].filter(
        (item) => !beforeAttachments.some((existing) => existing.id === item.id)
      );
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
      throw new Error("Attachment bytes were not verified; read the exact note before retrying");
    const nameVerified = inserted[0].name === name;
    return {
      ok: true,
      id,
      attachmentId,
      contentHash: after.hash,
      bytes: bytes.length,
      name: inserted[0].name,
      ...(args.filename === undefined
        ? {}
        : {
            filenameVerified: nameVerified,
            ...(nameVerified
              ? {}
              : {
                  filenameWarning:
                    "The attachment and its bytes were verified, but Notes reports a different name",
                }),
          }),
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
