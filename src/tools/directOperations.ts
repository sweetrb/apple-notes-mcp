import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
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
import { classifyError, CodedError, errorResult } from "../utils/errorCodes.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { attachmentCoreDataId, type AttachmentAssetRecord } from "../utils/attachmentAssets.js";
import {
  enrichNoteRead,
  linkSignature,
  readRichNote,
  richContentHash,
  type RichNote,
} from "../utils/noteRichText.js";
import {
  freezePasteboard,
  PASTEBOARD_NAME_ENV,
  pasteboardFilename,
} from "../utils/pasteboardFreeze.js";
import type { PasteboardAttachmentSource } from "../types.js";

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
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ADD_ATTACHMENT_BYTES)
      throw new Error("Attachment must be a nonempty regular file of at most 64 MiB");
    const bytes = readFileSync(descriptor);
    if (bytes.length !== stat.size)
      throw new Error("Attachment changed while it was being read; try again");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Largest file add-attachment accepts; verification must never cap lower (#243). */
const MAX_ADD_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/**
 * Whether the regular file at `path` has exactly `size` bytes with SHA-256
 * `expected`. Streams the file in chunks through one O_NOFOLLOW descriptor, so
 * it has no read cap of its own and never holds the whole file twice (#243).
 */
function fileMatches(path: string, size: number, expected: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== size) return false;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > size) return false;
      hash.update(chunk.subarray(0, read));
    }
    return total === size && hash.digest("hex") === expected;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
    "Use when: adding one local file to an exact note without replacing its body.\nReturns: the new attachment id, byte count, attachment name, and post-write content hash after exact byte verification.\nDo not use when: reading or exporting an existing attachment.\nSafety: requires a fresh rich revision, copies at most 64 MiB through a private temporary file, never retries insertion, and verifies existing content plus fetched bytes. On macOS 27 Notes' AppleScript does not list PDF attachments; with Full Disk Access the new attachment is verified through the read-only NoteStore database instead (verifiedBy: database), otherwise the outcome is reported as uncertain.",
    { id: noteId, expectedContentHash: revision, ...attachmentInput },
    (args) => attachFile(manager, args)
  );

  tool(
    "create-note-with-attachment",
    "Use when: creating a new note that holds one local file, in one call.\nReturns: the new note id plus the add-attachment result (attachment id, bytes, name, content hash).\nDo not use when: the note already exists (add-attachment).\nSafety: checks the file and filename before creating anything, creates the note through Notes.app like create-note, then attaches with the same byte verification as add-attachment. If the attachment step fails before the file is inserted, the error names the new note's id; attach to it with add-attachment instead of creating another note. If insertion started but could not be verified, the outcome is uncertain: read the note with list-attachments before attaching again.",
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
        .describe(
          "Existing folder or nested path; create it first with create-folder. A smart folder is refused before the note is created"
        ),
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
      // The note exists from here on, so no failure may report committed:
      // false: a caller that trusted it would retry and create a second note.
      const createdError = (message: string, cause: unknown) =>
        new CodedError(message, {
          code: classifyError(message, cause).code,
          committed: true,
          indeterminate: false,
        });
      let snapshot: Snapshot;
      try {
        snapshot = readSnapshot(manager, note.id);
      } catch (error) {
        const message = `${handOff}. The new note could not be read back: ${String(error)}`;
        throw createdError(message, error);
      }
      const progress = { insertionStarted: false };
      try {
        return {
          ...attachFile(
            manager,
            {
              id: note.id,
              expectedContentHash: snapshot.hash,
              path: args.path,
              filename: name,
            },
            undefined,
            progress
          ),
          title: args.title,
          folder: args.folder,
          noteCreated: true,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Before insertion nothing was attached, so add-attachment is the way
        // to finish. After it, the file may already be in the note, and a
        // second attach would duplicate it.
        if (!progress.insertionStarted) throw createdError(`${handOff}. ${detail}`, error);
        const message = `Note ${note.id} was created, but the attachment outcome is uncertain: ${detail}. Read the note (list-attachments) before attaching again, and do not create another note`;
        throw new CodedError(message, {
          code: "verification_failed",
          committed: true,
          indeterminate: true,
        });
      }
    }
  );

  tool(
    "add-attachment-from-pasteboard",
    "Use when: the user copied an image, a PDF, or a file (screenshot, Copy Image, Finder Copy) and wants it attached to an exact note.\nReturns: the add-attachment result (attachment id, bytes, name, content hash) plus source: what was taken from the pasteboard (kind, type, default filename).\nDo not use when: the pasteboard holds text (use append-to-note), several copied files (refused; use add-attachment per file), or you have a file path (use add-attachment).\nSafety: checks the note and revision before reading the pasteboard; reads nothing when macOS would show its paste alert unless allowPasteAlert is true (error pasteboardCode pasteboard_access_denied); reads the pasteboard once and freezes its bytes into a private temporary file before attaching, never writes to the pasteboard, then runs add-attachment's checks: fresh rich revision, at most 64 MiB, no insertion retry, existing content and exact bytes verified. Needs the MCP host to run in the logged-in GUI session.",
    {
      id: noteId,
      expectedContentHash: revision,
      filename: attachmentInput.filename.describe(
        'Name the attachment gets in Notes (default: the copied file\'s name, or "Pasted image.png" / "Pasted document.pdf"). Without an extension, the pasted type\'s extension is added; with one, it must match the pasted type. Same rules as add-attachment otherwise.'
      ),
      allowPasteAlert: z
        .boolean()
        .optional()
        .describe(
          "Read the pasteboard even if macOS will show its paste alert (macOS 15.4+ paste privacy). Default false: when pasting is not already always allowed, the tool reads nothing and returns pasteboardCode pasteboard_access_denied. Set true only after the user agrees to answer the alert. Never overrides a Deny setting."
        ),
    },
    ({ id, expectedContentHash, filename, allowPasteAlert }) => {
      // Check the request and the note first, so an invalid call never reads the clipboard.
      if (filename !== undefined) checkAttachmentFilename(filename);
      const before = readSnapshot(manager, id);
      if (before.hash !== expectedContentHash) throw new Error("Note revision changed");
      // A named pasteboard lets live tests run without touching the user's clipboard.
      const frozen = freezePasteboard({
        pasteboardName: process.env[PASTEBOARD_NAME_ENV]?.trim() || undefined,
        allowPasteAlert: allowPasteAlert === true,
      });
      try {
        const source: PasteboardAttachmentSource = {
          kind: frozen.kind,
          type: frozen.type,
          filename: frozen.filename,
        };
        return {
          ...attachFile(
            manager,
            {
              id,
              expectedContentHash,
              path: frozen.path,
              filename: pasteboardFilename(filename, frozen.filename),
            },
            before
          ),
          source,
        };
      } finally {
        frozen.cleanup();
      }
    }
  );
}

/** Checks a requested attachment name's form, independent of the source file. */
export function checkAttachmentFilename(filename: string): void {
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
  checkAttachmentFilename(filename);
  if (extname(filename).toLowerCase() !== extname(source).toLowerCase())
    throw new Error(
      `filename must keep the source file's extension (${extname(source) || "none"})`
    );
  return filename;
}

const UNCERTAIN = "Attachment insertion outcome uncertain; read the exact note before retrying";
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Identifiers of a note's top-level attachment rows in NoteStore, or null when
 * the database cannot be read (no Full Disk Access, or any other failure).
 */
function storedAttachmentIds(manager: AppleNotesManager, id: string): Set<string> | null {
  try {
    return new Set(
      manager
        .getAttachmentAssetsById(id)
        .attachments.filter((item) => item.parentIdentifier === null)
        .map((item) => item.identifier.toLowerCase())
    );
  } catch {
    return null;
  }
}

/**
 * Find the one attachment row this insertion added to the note in NoteStore
 * and check its media file against the source bytes (#236). Notes' AppleScript
 * on macOS 27 never lists PDF attachments, so this is the only way to see a
 * new PDF. Returns null when no new row appears; throws when a row appears but
 * its bytes cannot be verified, so the caller does not attach a duplicate.
 */
function storedInsertion(
  manager: AppleNotesManager,
  id: string,
  before: Set<string>,
  bytes: Buffer,
  returnedId: string | undefined
): { attachmentId: string; name: string | null } | null {
  let added: AttachmentAssetRecord[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) pause(250);
    try {
      added = manager
        .getAttachmentAssetsById(id)
        .attachments.filter(
          (item) => item.parentIdentifier === null && !before.has(item.identifier.toLowerCase())
        );
    } catch {
      added = [];
    }
    if (added.length === 1 && added[0].assetPaths.length > 0) break;
  }
  if (added.length === 0) return null;
  if (added.length > 1) throw new Error(UNCERTAIN);
  const row = added[0];
  const attachmentId = attachmentCoreDataId(id, row.pk);
  if (returnedId && /\/ICAttachment\/p\d+$/.test(returnedId) && returnedId !== attachmentId)
    throw new Error(UNCERTAIN);
  const expected = sha256(bytes);
  const matches = row.assetPaths.some((path) => fileMatches(path, bytes.length, expected));
  if (!matches)
    throw new Error(
      `Notes' database shows new attachment ${attachmentId} on this note, but its file bytes could not be verified; read the exact note and do not attach the file again`
    );
  return { attachmentId, name: row.filename };
}

/**
 * Insert one verified local file into an exact, unchanged note.
 *
 * `checked` is a snapshot the caller already read and compared with
 * `expectedContentHash` (add-attachment-from-pasteboard reads the note before
 * it touches the pasteboard). The revision is still compared again here and
 * re-read right before insertion.
 */
function attachFile(
  manager: AppleNotesManager,
  args: { id: string; expectedContentHash: string; path: string; filename?: string },
  checked?: Snapshot,
  progress: { insertionStarted: boolean } = { insertionStarted: false }
): Record<string, unknown> {
  const { id, expectedContentHash, path } = args;
  const name = attachmentName(path, args.filename);
  const before = checked ?? readSnapshot(manager, id);
  if (before.hash !== expectedContentHash) throw new Error("Note revision changed");
  const bytes = localAttachment(path);
  const beforeAttachments = manager.listAttachmentsById(id);
  // Taken only to verify through the database if AppleScript cannot (#236).
  const beforeStored = storedAttachmentIds(manager, id);
  const directory = mkdtempSync(join(tmpdir(), "notes-attachment-add-"));
  const temporaryFile = join(directory, name);
  try {
    writeFileSync(temporaryFile, bytes, { mode: 0o600 });
    if (readSnapshot(manager, id).hash !== before.hash) throw new Error("Note revision changed");
    let returnedId: string | undefined;
    let transportUncertain = false;
    // From here on a failure may leave the attachment in the note.
    progress.insertionStarted = true;
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
      pause(250);
      inserted = readInserted();
    }
    const persistentReturnedId = returnedId && /\/ICAttachment\/p\d+$/.test(returnedId);
    let attachmentId: string;
    let reportedName: string | null;
    let verifiedBy: "applescript" | "database" = "applescript";
    if (inserted.length === 1 && !(persistentReturnedId && returnedId !== inserted[0].id)) {
      attachmentId = inserted[0].id;
      reportedName = inserted[0].name;
      // Export Notes' copy and hash it in place. The base64 fetch path is
      // capped at APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES (25 MiB by default),
      // below the 64 MiB this tool accepts, so it cannot verify large files (#243).
      const verifyPath = join(directory, "verify", "attachment.bin");
      const saved = manager.saveAttachmentById(id, attachmentId, verifyPath);
      if (
        !saved.success ||
        !fileMatches(saved.savedPath ?? verifyPath, bytes.length, sha256(bytes))
      )
        throw new Error("Attachment bytes were not verified; read the exact note before retrying");
    } else {
      // AppleScript saw nothing usable. On macOS 27 it never lists a PDF
      // attachment, so check the read-only NoteStore database instead.
      const stored =
        inserted.length === 0 && beforeStored
          ? storedInsertion(manager, id, beforeStored, bytes, returnedId)
          : null;
      if (!stored)
        throw new Error(
          inserted.length === 0 && !beforeStored
            ? `${UNCERTAIN}. Notes' AppleScript does not list some attachments (PDFs on macOS 27); grant Full Disk Access so the server can verify through the Notes database`
            : UNCERTAIN
        );
      attachmentId = stored.attachmentId;
      reportedName = stored.name;
      verifiedBy = "database";
    }
    const nameVerified = reportedName === name;
    return {
      ok: true,
      id,
      attachmentId,
      contentHash: after.hash,
      bytes: bytes.length,
      name: reportedName,
      ...(verifiedBy === "database" ? { verifiedBy } : {}),
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
