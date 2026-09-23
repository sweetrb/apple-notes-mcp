#!/usr/bin/env node
/**
 * Apple Notes MCP Server
 *
 * A Model Context Protocol (MCP) server that provides AI assistants
 * with the ability to interact with Apple Notes on macOS.
 *
 * This server exposes tools for:
 * - Creating, reading, updating, and deleting notes
 * - Organizing notes into folders
 * - Searching notes by title or content
 * - Managing multiple accounts (iCloud, Gmail, Exchange, etc.)
 *
 * Architecture:
 * - Tool definitions are declarative (schema + handler)
 * - The AppleNotesManager class handles all AppleScript operations
 * - Error handling is consistent across all tools
 *
 * @module apple-notes-mcp
 * @see https://modelcontextprotocol.io
 */

import { createRequire } from "module";
import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AppleNotesManager,
  DEFAULT_EXPORT_PAGE_SIZE,
  exportMaxResponseBytes,
} from "@/services/appleNotesManager.js";
import { getSyncStatus, withSyncAwarenessSync } from "@/utils/syncDetection.js";
import { getChecklistItems, hasFullDiskAccess } from "@/utils/checklistParser.js";
import { getNoteMetadata } from "@/utils/noteMetadata.js";
import {
  listSpecialNotes,
  nativeTagInventory,
  quickNoteFlag,
  SPECIAL_LIMIT,
} from "@/utils/noteListings.js";
import { NoteStoreError } from "@/utils/noteStoreSql.js";
import type { DeleteGuardNote, FolderTreeNode, SpecialNoteKind } from "@/types.js";
import { folderTree, listRecentNotes, RECENT_LIMIT } from "@/utils/noteRecentList.js";
import {
  exactIdArrayInput,
  exactIdInput,
  lookupStableIdentifiers,
  looseIdTransform,
  NOTE_ID_MESSAGE,
  withStableIdentifiers,
  type StableIdentifiers,
} from "@/utils/noteIdentifiers.js";
import { detectChecklistAttempt } from "@/utils/contentWarnings.js";
import { parseHashtags } from "@/utils/hashtags.js";
import { stripLargeInlineImages, strippedImagesWarning } from "@/utils/inlineImages.js";
import { resolveUpdateResponseTitle } from "@/utils/updateResponseTitle.js";
import { resolveSearchLimit, describeSearchLimit } from "@/utils/searchLimit.js";
import { describeSearchScope } from "@/utils/searchScope.js";
import {
  contentSearchFailureHint,
  describeContentScan,
  searchContentViaDatabase,
  type ContentSearchSource,
  type SearchContentDbResult,
} from "@/utils/searchContentDb.js";
import { NoteQueryError } from "@/utils/noteQuery.js";
import {
  NoteQueryStoreError,
  QUERY_RESULTS,
  QUERY_SCAN,
  queryNotes,
} from "@/utils/noteQueryStore.js";
import type { QueryNotesResult } from "@/types.js";
import { runDoctor, formatDoctorReport, fdaRemediation } from "@/tools/doctor.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";
import { loadFileConfig } from "@/services/fileConfig.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import { withJsonSchema2020_12 } from "@/utils/jsonSchemaDialect.js";
import { errorResult } from "@/utils/errorCodes.js";
import { createShutdown } from "@/utils/shutdown.js";
import { comparableVisibleText } from "@/utils/noteRevision.js";
import { CALL_TIMEOUT_SECONDS, runWithCallTimeout } from "@/utils/callTimeout.js";
import { readAllowedTextFile } from "@/utils/attachmentFs.js";
import {
  appendMarkdownHtml,
  countTaskItems,
  stripDuplicateTitleHeading,
  usesMarkdownBlocks,
} from "@/utils/appendMarkdown.js";
import {
  enrichNoteRead,
  richContentHash,
  assertLinkedWrite,
  htmlLinks,
  linkSignature,
  type RichRead,
  readRichNote,
} from "@/utils/noteRichText.js";
import { parseNoteTable } from "@/utils/noteTables.js";
import type { DrawingAttachment } from "@/types.js";
import { attachmentCoreDataId, selectFirstImage } from "@/utils/attachmentAssets.js";
import type { AttachmentAssetRecord, FirstImage, NoteAttachmentAssets } from "@/types.js";
import {
  AudioTranscriptError,
  DEFAULT_MAX_SEGMENTS,
  MAX_SEGMENTS_LIMIT,
  fitTranscriptsToBudget,
  formatTranscriptsText,
} from "@/utils/audioTranscripts.js";
import type { AudioTranscriptsResult } from "@/types.js";
import {
  blocksMaxResponseBytes,
  NoteBlocksError,
  pageNoteBlocks,
  readNoteBlocks,
} from "@/utils/noteBlocks.js";
import { pageParagraphs, paragraphLink, readNoteParagraphs } from "@/utils/noteParagraphs.js";
import { describeNoteStructure, readNoteStructure } from "@/utils/noteStructure.js";
import { classifyBodyReadError, describeBodyReadFailure } from "@/utils/bodyReadFailure.js";
import { describeLinkInventory, listNoteLinks } from "@/utils/noteLinkInventory.js";
import { MAX_LINK_LABEL_LENGTH, MAX_LINK_URL_LENGTH } from "@/utils/linkInsert.js";
import { insertLink } from "@/services/linkInsert.js";
import {
  exportNotesHtml,
  exportNotesMarkdown,
  MAX_FOLDER_EXPORT_LIMIT,
  NotesExportError,
} from "@/services/notesExport.js";
import { registerDirectOperations } from "@/tools/directOperations.js";
import { registerFolderDelete } from "@/tools/folderDelete.js";
import { registerSvgAnalysis } from "@/tools/svgAnalysis.js";
import {
  hasScopeGuard,
  MAX_FORBIDDEN_FOLDERS,
  SCOPE_FOLDER_ID,
  scopeConflictMessage,
  type ScopeGuard,
} from "@/utils/scopeGuard.js";
import { registerNativeTagsBridge } from "@/tools/nativeTagsBridge.js";
import {
  registerNativeOperations,
  requireValidated,
  VERIFIED_BACKGROUND,
} from "@/tools/nativeOperations.js";
import {
  appendNative,
  createMarkdownNote,
  NATIVE_APPEND_HTML_SUBSET,
} from "@/services/backgroundNotes.js";
import { formatShortcutSetup, setupShortcuts } from "@/setupShortcuts.js";
import { buildPublicHelper, formatPublicHelperBuild } from "@/services/publicHelper.js";
import { formatNoteDrawings, getNoteDrawings } from "@/services/noteDrawings.js";
import { buildPrivateHelper, formatHelperBuild } from "@/services/privateHelperBuild.js";
import { registerPrivateHelperTools } from "@/tools/privateHelperTools.js";

// Load file-based config FIRST (#24) — before anything reads APPLE_NOTES_MCP_*.
// Lets users configure the server when the host app strips the MCP env block.
loadFileConfig();

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

if (process.argv[2] === "setup" && process.argv.slice(3).includes("--public-helper")) {
  // Compile the public native helper (PencilKit) from the packaged source.
  const report = buildPublicHelper(process.argv.slice(3).includes("--check"));
  process.stdout.write(formatPublicHelperBuild(report) + "\n");
  process.exit(report.ok ? 0 : 1);
}
if (process.argv[2] === "setup" && process.argv.slice(3).includes("--native-helper")) {
  // Opt-in private helper: compiled locally from the packaged source (#181).
  const report = buildPrivateHelper(process.argv.slice(3).includes("--check"));
  process.stdout.write(formatHelperBuild(report) + "\n");
  process.exit(report.ok ? 0 : 1);
}
if (process.argv[2] === "setup") {
  const report = setupShortcuts(process.argv.slice(3).includes("--check"));
  process.stdout.write(formatShortcutSetup(report) + "\n");
  process.exit(report.ready || !report.checkOnly ? 0 : 1);
}
// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Notes operations.
 */
const server = new McpServer({
  name: "apple-notes",
  version,
  description: "MCP server for managing Apple Notes - create, search, update, and organize notes",
});

/**
 * Singleton instance of the Apple Notes manager.
 * Handles all AppleScript execution and note operations.
 */
const notesManager = new AppleNotesManager();
registerDirectOperations(server, notesManager);
registerFolderDelete(server, notesManager);
registerSvgAnalysis(server);
registerNativeTagsBridge(server, notesManager);
registerNativeOperations(server, notesManager);
registerPrivateHelperTools(server, notesManager);

// =============================================================================
// Response Helpers
// =============================================================================

interface ToolResponse {
  content: { type: "text"; text: string; [k: string]: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * Creates a successful MCP tool response. Pass `structured` to attach typed JSON
 * (`structuredContent`) alongside the human-readable text so agents can consume
 * results without parsing prose (#21).
 */
function successResponse(message: string, structured?: Record<string, unknown>): ToolResponse {
  const res: ToolResponse = { content: [{ type: "text" as const, text: message }] };
  if (structured) res.structuredContent = structured;
  return res;
}

/**
 * Creates an error MCP tool response. The text is `message`, unchanged;
 * `structuredContent` carries a stable machine-readable `code` (plus
 * `committed`/`indeterminate` when a write's outcome is known or uncertain),
 * classified centrally in utils/errorCodes. Pass the thrown `cause` when there
 * is one so its own code (e.g. ETIMEDOUT) is honored.
 */
function errorResponse(message: string, cause?: unknown): ToolResponse {
  return errorResult(message, cause);
}

/**
 * Wraps a tool handler with consistent error handling.
 */
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ToolResponse,
  errorPrefix: string
) {
  return async (params: T): Promise<ToolResponse> => {
    try {
      // Tools that declare timeoutSeconds run every automation step under it;
      // zod strips the key from every other tool's params.
      const seconds = params.timeoutSeconds;
      return runWithCallTimeout(typeof seconds === "number" ? seconds : undefined, () =>
        handler(params)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`, error);
    }
  };
}

// =============================================================================
// Input Bounds
// =============================================================================

/**
 * Upper bounds on string/array inputs (#validation). Zod's `.min(1)` rejected
 * empty input but nothing capped the maximum, so a caller could pass an
 * arbitrarily large string/array straight through to AppleScript. These mirror
 * the limits the AppleNotesManager already enforces internally (title 2000,
 * content 5 MB, folder path 1000, account 200) and add sane caps for the rest,
 * so oversized input is rejected at the schema boundary with a clear message.
 */
const MAX = {
  TITLE: 2000,
  CONTENT: 5 * 1024 * 1024,
  FOLDER: 1000,
  ACCOUNT: 200,
  QUERY: 2000,
  ID: 2000,
  SAVE_PATH: 4096,
  ATTACHMENT_ID: 2000,
  TAG: 200,
  TAGS: 100,
  BATCH_IDS: 500,
} as const;

/**
 * Largest file create-note reads through contentPath. Matches the bounded
 * Markdown import limit, which is the tighter of the two content paths.
 */
const MAX_CONTENT_FILE_BYTES = 1024 * 1024;

// =============================================================================
// Schema Definitions
// =============================================================================

/**
 * Common schema for operations requiring a note title.
 */
const noteTitleSchema = {
  title: z.string().min(1, "Note title is required").max(MAX.TITLE),
  account: z
    .string()
    .max(MAX.ACCOUNT)
    .optional()
    .describe(
      "Account name (defaults to Notes.app's default account; exact or unique-prefix match)"
    ),
};

/** The AppleScript note id pattern every exact-ID tool has always accepted. */
const NOTE_COREDATA_ID = /^x-coredata:\/\/[0-9A-Fa-f-]+\/ICNote\/p\d+$/;
/** Kept short: it repeats in every note-id field of tools/list. */
const NOTE_ID_FORMS = "x-coredata id, Notes UUID, or numeric key";

/**
 * Exact note id. Accepts the x-coredata id as before, plus the note's Notes
 * UUID or numeric Core Data key, which the schema resolves to the x-coredata
 * id before the handler runs (see utils/noteIdentifiers.ts).
 */
const noteIdInput = exactIdInput("ICNote", NOTE_COREDATA_ID, NOTE_ID_MESSAGE, {
  maxLength: MAX.ID,
}).describe(`Exact note ID returned by search-notes, list-notes, or create-note: ${NOTE_ID_FORMS}`);

/** A batch of exact note ids, resolved in one database read. */
const noteIdArrayInput = exactIdArrayInput("ICNote", NOTE_COREDATA_ID, NOTE_ID_MESSAGE, {
  maxLength: MAX.ID,
  maxItems: MAX.BATCH_IDS,
});

/**
 * Free-form note id (the title-or-id tools never validated its shape). A
 * Notes UUID or numeric key is resolved to the x-coredata id; anything else
 * passes through unchanged.
 */
const looseNoteId = (base: z.ZodString) => base.max(MAX.ID).transform(looseIdTransform("ICNote"));

/** Free-form folder id; a Notes UUID or numeric key resolves to the x-coredata id. */
const looseFolderId = (base: z.ZodString) =>
  base.max(MAX.ID).transform(looseIdTransform("ICFolder"));

/** Output fields carrying a note's stable identifiers (present with Full Disk Access). */
const noteIdentifierOutput = {
  identifier: z.string().optional(),
  folderIdentifier: z.string().optional(),
  accountIdentifier: z.string().optional(),
};

/**
 * Stable identifiers for one note (Notes UUID, folder and account UUIDs), read
 * in one query. Empty when Full Disk Access is missing, so callers can spread
 * it unconditionally.
 */
function noteIdentifiers(id: string): StableIdentifiers {
  return lookupStableIdentifiers([id], "ICNote").get(id) ?? {};
}

const expectedContentHashInput = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expectedContentHash must come from get-note-content")
  .describe(
    "Revision token returned by get-note-content for this exact ID. The mutation stops if the note changed since that read."
  );

const SCOPE_FOLDER_ID_MESSAGE =
  "An exact folder id is required: x-coredata://.../ICFolder/p..., Notes UUID, or numeric key (from list-folders)";

/**
 * Exact folder id for the scope guards. Accepts the x-coredata id plus the
 * folder's Notes UUID or numeric key, resolved to the x-coredata form before
 * the handler runs (like every other exact id field).
 */
const scopeFolderIdInput = exactIdInput("ICFolder", SCOPE_FOLDER_ID, SCOPE_FOLDER_ID_MESSAGE, {
  maxLength: MAX.ID,
});

/**
 * Optional folder preconditions shared by update-note, append-to-note,
 * delete-note, and move-note. They are re-checked inside the write's own
 * AppleScript, immediately before the write.
 */
const scopeGuardInputs = {
  ifFolderId: scopeFolderIdInput
    .optional()
    .describe(
      "Precondition: the note must currently be in exactly this folder (id from list-folders). Re-checked immediately before the write."
    ),
  ifAncestorFolderId: scopeFolderIdInput
    .optional()
    .describe(
      "Precondition: the note must be inside this folder or any of its subfolders. Re-checked immediately before the write."
    ),
  forbiddenAncestorFolderIds: exactIdArrayInput(
    "ICFolder",
    SCOPE_FOLDER_ID,
    SCOPE_FOLDER_ID_MESSAGE,
    {
      maxLength: MAX.ID,
      maxItems: MAX_FORBIDDEN_FOLDERS,
    }
  )
    .optional()
    .describe(
      "Precondition: the note must not be inside any of these folders or their subfolders (for move-note, neither may the destination). Re-checked immediately before the write."
    ),
};

/** Collects the scope preconditions from a tool's arguments. */
function scopeFrom(args: {
  ifFolderId?: string;
  ifAncestorFolderId?: string;
  forbiddenAncestorFolderIds?: string[];
}): ScopeGuard {
  return {
    ifFolderId: args.ifFolderId,
    ifAncestorFolderId: args.ifAncestorFolderId,
    forbiddenAncestorFolderIds: args.forbiddenAncestorFolderIds,
  };
}

const timeoutSecondsInput = z
  .number()
  .int()
  .min(CALL_TIMEOUT_SECONDS.min)
  .max(CALL_TIMEOUT_SECONDS.max)
  .optional()
  .describe(
    `Per-call timeout in seconds (${CALL_TIMEOUT_SECONDS.min}-${CALL_TIMEOUT_SECONDS.max}) for each Notes.app automation step this call runs, overriding APPLE_NOTES_MCP_TIMEOUT_MS. A timed-out write is uncertain, not failed: read the note by id before any retry.`
  );

type ExactNoteSnapshot = {
  note: NonNullable<ReturnType<AppleNotesManager["getNoteById"]>>;
  body: string;
  contentHash: string;
  rich: RichRead;
};

/**
 * Reads the complete current body and metadata for one exact Apple Note.
 * Mutations use this snapshot for revision checks and human-readable errors;
 * the manager repeats the body comparison atomically inside the write script.
 */
function readExactNoteSnapshot(id: string): ExactNoteSnapshot | { error: string } {
  const note = notesManager.getNoteById(id);
  if (!note) return { error: `Note with ID "${id}" not found` };
  if (note.passwordProtected) {
    return {
      error: `Note "${note.title}" is password-protected and cannot be changed. Unlock it in Notes.app first.`,
    };
  }
  const { body, error } = notesManager.readNoteBodyById(id);
  if (!body) {
    // The read comes before any write, so a failure here changed nothing.
    const reason = bodyReadFailureMessage(id, note.title, error);
    return { error: `${reason}${error ? "\n\nNothing was changed." : ""}` };
  }
  const rich = enrichNoteRead(id, body);
  return { note, body, rich, contentHash: richContentHash(body, rich) };
}

/**
 * Error text for a failed body read. When the read timed out or overflowed the
 * output buffer, the note's attachment sizes are looked up in the NoteStore
 * database (needs Full Disk Access; skipped quietly without it) so the message
 * can name an oversized image as the likely cause (#237).
 */
function bodyReadFailureMessage(id: string, title: string, error: string | undefined): string {
  let attachments;
  if (classifyBodyReadError(error) !== "other") {
    try {
      attachments = readNoteStructure(id, { includeText: false }).attachments;
    } catch {
      attachments = undefined;
    }
  }
  return describeBodyReadFailure(title, error, attachments);
}

/** Notes.app accepted a delete event but the note stayed in its folder. */
const NOT_DELETED_MESSAGE =
  "Notes.app accepted the delete, but the note is still in its original folder, so it was not moved to Recently Deleted. Nothing was deleted; read the note again before retrying.";

/**
 * Notes.app could not report the note's folder, so whether it is in Recently
 * Deleted (where a delete is permanent) cannot be ruled out (#198).
 */
function containerUnknownMessage(title: string): string {
  return `Could not read which folder note "${title}" is in, so it may already be in Recently Deleted, where deleting it would remove it permanently. Nothing was deleted. Retry in a moment; if it keeps failing, quit and reopen Notes.app, then retry.`;
}

/** The note is already in Recently Deleted, where a delete is permanent (#198). */
function inRecentlyDeletedMessage(title: string): string {
  return `Note "${title}" is already in Recently Deleted, where deleting it would remove it permanently. Nothing was deleted. Remove it from Recently Deleted in Notes.app if that is intended.`;
}

function revisionConflictMessage(title: string): string {
  return `Note "${title}" changed after it was read. Read it again and review the newer version before retrying.`;
}

/** delete-note's guard-note arguments (copy-then-retire). */
interface DeleteGuardArgs {
  id: string;
  guardNoteId?: string;
  expectedGuardContentHash?: string;
  requireActiveNoteId?: string;
}

/** Guard notes ready for the delete script, with a label per entry for messages. */
type PreparedDeleteGuards = {
  guards: DeleteGuardNote[];
  labels: string[];
  guardContentHash?: string;
};

/**
 * Refuses a Quick Note as a guard note. The flag lives only in the database,
 * so this needs Full Disk Access. A note the database does not have yet (a
 * copy made seconds ago) passes: it was not made as a Quick Note, and the
 * delete script still proves it exists, is unlocked, is outside Recently
 * Deleted, and, for guardNoteId, still has the verified body.
 */
function quickNoteGuardRefusal(label: string, id: string): string | null {
  let quick: boolean | null;
  try {
    quick = quickNoteFlag(id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof NoteStoreError && error.kind === "no_fda") {
      return `${label} note cannot be checked: the delete-note guard needs Full Disk Access to rule out a Quick Note. Nothing was deleted. ${detail}`;
    }
    return `${label} note could not be checked (${detail}). Nothing was deleted.`;
  }
  return quick
    ? `${label} note is a Quick Note; a guard must be an ordinary note. Nothing was deleted.`
    : null;
}

/**
 * Pre-checks delete-note's guard notes and collects them for the delete
 * script, which repeats the live checks immediately before the delete.
 */
function prepareDeleteGuards(args: DeleteGuardArgs): PreparedDeleteGuards | { error: string } {
  const { id, guardNoteId, expectedGuardContentHash, requireActiveNoteId } = args;
  if ((guardNoteId === undefined) !== (expectedGuardContentHash === undefined)) {
    return { error: "Pass guardNoteId and expectedGuardContentHash together." };
  }
  if (guardNoteId === id || requireActiveNoteId === id) {
    return { error: "A guard note must be a different note from the one being deleted." };
  }
  if (guardNoteId !== undefined && guardNoteId === requireActiveNoteId) {
    return { error: "requireActiveNoteId repeats guardNoteId; pass only guardNoteId." };
  }

  const prepared: PreparedDeleteGuards = { guards: [], labels: [] };
  if (guardNoteId !== undefined) {
    const refusal = quickNoteGuardRefusal("Guard", guardNoteId);
    if (refusal) return { error: refusal };
    const guard = readExactNoteSnapshot(guardNoteId);
    if ("error" in guard) return { error: `Guard note: ${guard.error}` };
    if (guard.contentHash !== expectedGuardContentHash) {
      return {
        error: `Guard note "${guard.note.title}" changed after it was read. Verify the copy again before retiring the original. Nothing was deleted.`,
      };
    }
    prepared.guards.push({ id: guardNoteId, expectedBody: guard.body });
    prepared.labels.push("Guard");
    prepared.guardContentHash = guard.contentHash;
  }
  if (requireActiveNoteId !== undefined) {
    const refusal = quickNoteGuardRefusal("Required active", requireActiveNoteId);
    if (refusal) return { error: refusal };
    const active = notesManager.getNoteById(requireActiveNoteId);
    if (!active)
      return { error: `Required active note with ID "${requireActiveNoteId}" not found.` };
    if (active.passwordProtected) {
      return { error: `Required active note "${active.title}" is password-protected.` };
    }
    prepared.guards.push({ id: requireActiveNoteId });
    prepared.labels.push("Required active");
  }
  return prepared;
}

/**
 * Common schema for operations requiring a folder name.
 */
const folderNameSchema = {
  name: z.string().min(1, "Folder name is required").max(MAX.FOLDER),
  account: z
    .string()
    .max(MAX.ACCOUNT)
    .optional()
    .describe(
      "Account name (defaults to Notes.app's default account; exact or unique-prefix match)"
    ),
};

// =============================================================================
// Note Tools
// =============================================================================

// --- create-note ---

/**
 * Register a tool, advertising its `outputSchema` as PERMISSIVE.
 *
 * The MCP **client** validates a result's `structuredContent` against the JSON
 * Schema the server advertised — not against the server's own zod object. A
 * bare zod raw shape renders as `additionalProperties: false`, so a payload
 * carrying any field the schema didn't enumerate is rejected client-side with
 * `-32602 … data must NOT have additional properties`, discarding a result the
 * handler produced correctly. The server never sees it, because zod's own parse
 * silently *strips* unknown keys rather than failing — which is why the
 * registerTool/outputSchema migration's "all fields optional, no `.strict()`"
 * was believed to be permissive. It covered optionality; it did not cover
 * undeclared keys.
 *
 * `.passthrough()` advertises `additionalProperties: true`, which is the
 * contract that migration intended: a declared field documents the shape, an
 * undeclared one is carried through instead of nuking the whole result. This is
 * not hypothetical — it took down `get-mail-stats` in the sibling
 * apple-mail-mcp (sweetrb/apple-mail-mcp#135), where every tool was likewise
 * advertising `additionalProperties: false` and the one tool whose payload
 * carried an undeclared key failed on every call. Enforced for every tool here
 * by the outputSchema contract test.
 */
function registerTool<
  OutputArgs extends z.ZodRawShape,
  InputArgs extends undefined | z.ZodRawShape = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool {
  const { outputSchema, ...rest } = config;
  return server.registerTool(
    name,
    outputSchema ? { ...rest, outputSchema: z.object(outputSchema).passthrough() } : rest,
    cb
  );
}

registerTool(
  "create-note",
  {
    description:
      "Use when: the user wants to create a brand-new Apple Note.\nReturns: the new note's title and id — reuse the id for follow-up reads/edits.\nDo not use when: editing an existing note (use update-note).\nNote: the title is prepended as an <h1>; true Apple Notes checklists cannot be created via AppleScript (see the content field). A 'folder' must already exist — create-folder first (it is idempotent), since this tool does not create it.",
    inputSchema: {
      title: z.string().min(1, "Title is required").max(MAX.TITLE),
      content: z
        .string()
        .min(1, "Content is required")
        .max(MAX.CONTENT)
        .optional()
        .describe(
          'Note body; required unless contentPath is given (pass exactly one). In plaintext and HTML, AppleScript cannot create true Apple Notes checklists — `<input type="checkbox">`, checklist CSS classes, and markdown `- [ ]` lines do not render as checkable items; create a plain `<ul>` or `- ` list and convert it in Notes.app with ⇧⌘L. With format "markdown" (markdownRoute "shortcut"), `- [ ]`/`- [x]` lines, `>` block quotes, ``` fenced code, `---` dividers and `inline code` (which Notes renders as a highlight, not monospace) become native styles (see create-note-markdown-blocks in get-capabilities).'
        ),
      contentPath: z
        .string()
        .min(1)
        .max(MAX.SAVE_PATH)
        .optional()
        .describe(
          `Absolute path of a local UTF-8 file to use as the body instead of content (pass exactly one). The same locations save-attachment may write to are allowed (home, temp, /Volumes); symbolic links and non-regular files are refused. Limit ${MAX_CONTENT_FILE_BYTES} bytes.`
        ),
      format: z
        .enum(["plaintext", "html", "markdown"])
        .optional()
        .default("plaintext")
        .describe(
          "Content format: 'plaintext' (default), 'html' for rich formatting, or 'markdown'. Markdown whose first line is exactly `# <title>` (same case and spacing) has that line and one blank line after it removed, since the title is supplied separately."
        ),
      markdownRoute: z
        .enum(["shortcut", "html"])
        .optional()
        .default("shortcut")
        .describe(
          "How format 'markdown' is imported. 'shortcut' (default) uses the Create Markdown Note Shortcut for real Title/Heading/Subheading styles (iCloud only, no tags; see get-capabilities). 'html' is the fallback when that Shortcut is not installed or the note is outside iCloud: it converts the same bounded Markdown subset to HTML and creates the note through AppleScript in any account, rendering `- [ ]` / `- [x]` task items as ordinary list rows that start with a visible ☐ / ☑ character — not native, checkable checklist items — refusing block quotes, fenced code and inline code, and keeping a `---` line as literal text."
        ),
      tags: z
        .array(z.string().max(MAX.TAG))
        .max(MAX.TAGS)
        .optional()
        .describe(
          "Returned-only metadata — NOT written to Notes.app. Apple Notes tags can't be set via AppleScript, so any values passed here are echoed back in the response but do not appear on the created note. Use #hashtags in the body for searchable text; this does not create native tag objects. Native tags need the Notes Shortcuts action. Refused with format 'markdown': add tags afterwards with add-native-tags."
        ),
      folder: z
        .string()
        .max(MAX.FOLDER)
        .optional()
        .describe(
          "Folder to create the note in (supports nested paths like 'Work/Clients'). The folder must already exist — this tool does not create it; call create-folder first, which is idempotent and creates intermediate segments."
        ),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account name (defaults to the account Notes.app itself reports as default). Matched exactly, or by a unique prefix; an ambiguous prefix is refused. Must be an account Notes.app already has configured — see list-accounts."
        ),
      timeoutSeconds: timeoutSecondsInput,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      folder: z.string().optional(),
      account: z.string().optional(),
      contentHash: z.string().optional(),
      verified: z.boolean().optional(),
      strippedDuplicateTitle: z.boolean().optional(),
      taskItemsRendered: z.number().optional(),
    },
  },
  withErrorHandling((params) => {
    const {
      title,
      contentPath,
      format = "plaintext",
      markdownRoute = "shortcut",
      tags = [],
      folder,
      account,
    } = params;
    if ((params.content === undefined) === (contentPath === undefined))
      return errorResponse("Provide exactly one of content or contentPath");
    let content =
      params.content ?? readAllowedTextFile(contentPath as string, MAX_CONTENT_FILE_BYTES);
    if (format !== "markdown" && markdownRoute !== "shortcut")
      return errorResponse('markdownRoute applies to format "markdown" only');
    let strippedDuplicateTitle = false;
    if (format === "markdown") {
      const stripped = stripDuplicateTitleHeading(content, title);
      strippedDuplicateTitle = stripped.stripped;
      content = stripped.content;
      if (!content.trim())
        return errorResponse(
          "The Markdown holds only the title heading; add body content, or use format 'plaintext' for a title-only note"
        );
    }
    const titleNote = strippedDuplicateTitle ? { strippedDuplicateTitle: true } : {};
    if (format === "markdown" && markdownRoute === "html") {
      const taskItemsRendered = countTaskItems(content);
      const html = appendMarkdownHtml(content, { taskGlyphs: true });
      const note = notesManager.createNote(title, html, tags, folder, account, "html");
      if (!note)
        return errorResponse(
          `Failed to create note "${title}". Check that the folder and account exist (list-folders, list-accounts) and that this server has Automation access (run the doctor tool).`
        );
      const createdBody = notesManager.getNoteContentById(note.id);
      if (!notesManager.getNoteById(note.id) || !createdBody)
        return errorResponse(
          `A note may have been created, but its exact ID could not be verified. Do not retry automatically. Returned ID: ${note.id}`
        );
      const glyphNote = taskItemsRendered
        ? ` ${taskItemsRendered} task item(s) were rendered as visible ☐ / ☑ text, not native checklist items.`
        : "";
      return successResponse(
        `Note created from Markdown: "${note.title}" [id: ${note.id}]${glyphNote}`,
        {
          ok: true,
          id: note.id,
          title: note.title,
          folder,
          account,
          contentHash: richContentHash(createdBody, enrichNoteRead(note.id, createdBody)),
          verified: true,
          taskItemsRendered,
          ...titleNote,
        }
      );
    }
    if (format === "markdown") {
      if (account)
        return errorResponse(
          "Markdown notes are created in the iCloud account, the only one where Notes interprets Markdown; omit account"
        );
      // The bridge cannot attach tags, and silently dropping them would report
      // success for a note the caller did not ask for.
      if (tags.length)
        return errorResponse(
          'tags are not supported with format "markdown"; create the note without tags, then add them with add-native-tags using the returned id'
        );
      requireValidated("create-note-markdown");
      // Block quotes, fenced code, checklist items, dividers and inline code
      // have their own gate, so they can be withdrawn without the rest.
      if (usesMarkdownBlocks(content)) requireValidated("create-note-markdown-blocks");
      const result = createMarkdownNote(notesManager, { title, content, folder });
      return successResponse(`Note created from Markdown: "${title}" [id: ${result.id}]`, {
        ...result,
        ...titleNote,
      });
    }
    const note = notesManager.createNote(title, content, tags, folder, account, format);

    if (!note) {
      // The overwhelmingly common cause is a folder or account Notes doesn't
      // have — createNote addresses them directly and never creates them — so
      // name that before sending the caller on a permissions hunt.
      const target = folder
        ? ` Most often the folder "${folder}" does not exist: run list-folders to check, then create-folder to create it (it is idempotent and creates intermediate segments).`
        : account
          ? ` Most often the account "${account}" is not configured in Notes.app: run list-accounts to check the exact name.`
          : "";
      return errorResponse(
        `Failed to create note "${title}".${target} Otherwise check that Notes.app is running and this server has Automation access (run the doctor tool).`
      );
    }

    // A creation response is not enough: verify that the returned identity is
    // a real, readable Apple Note before advertising it for future writes.
    const created = notesManager.getNoteById(note.id);
    const createdBody = notesManager.getNoteContentById(note.id);
    if (!created || !createdBody) {
      return errorResponse(
        `A note may have been created, but its exact ID could not be verified. Do not retry automatically. Returned ID: ${note.id}`
      );
    }
    const contentHash = richContentHash(createdBody, enrichNoteRead(note.id, createdBody));

    const checklistWarning = detectChecklistAttempt(content) ?? "";
    return successResponse(`Note created: "${note.title}" [id: ${note.id}]${checklistWarning}`, {
      ok: true,
      id: note.id,
      title: note.title,
      folder,
      account,
      contentHash,
      verified: true,
    });
  }, "Error creating note")
);

// --- search-notes ---

registerTool(
  "search-notes",
  {
    description:
      "Use when: finding notes by a keyword in the title (or body with searchContent=true) and you need their ids.\nReturns: matching notes with title, folder, and id; `source` says whether a body search read the Notes database or fell back to AppleScript.\nDo not use when: you already have a note id (use get-note-content), want every note (use list-notes), or need boolean or metadata filters (use query-notes).\nPrefer this first to obtain ids for subsequent read/update/delete/move calls.\nNote: with Full Disk Access, body search reads the Notes database (fast; the most recent 5000 notes, Recently Deleted excluded); without it, it falls back to AppleScript, which scans every body and can time out on broad terms.",
    inputSchema: {
      query: z.string().min(1, "Search query is required").max(MAX.QUERY),
      searchContent: z
        .boolean()
        .optional()
        .describe(
          "Search note content (title line included) instead of titles. Uses the Notes database when Full Disk Access is available, else AppleScript"
        ),
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account to search in"),
      folder: z.string().max(MAX.FOLDER).optional().describe("Limit search to a specific folder"),
      modifiedSince: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 date string to filter notes modified on or after this date (e.g., '2025-01-01'). Useful for searching only recent notes in large collections."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of results to return. Defaults to 50 — a broad query reads several properties per match via AppleScript, so an unbounded search can time out. Pass a higher value to see more; the applied limit is disclosed in the response."
        ),
    },
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      source: z.enum(["database", "applescript"]).optional(),
      scanTruncated: z.boolean().optional(),
    },
  },
  withErrorHandling(({ query, searchContent = false, account, folder, modifiedSince, limit }) => {
    // Default the result cap so a broad query returns useful results instead of a
    // timeout error: search-notes reads several properties per match via AppleScript
    // (~200ms/note), so an unbounded search over hundreds of matches exceeds the 30s
    // budget (#100). The applied cap is disclosed below so truncation is visible.
    const effectiveLimit = resolveSearchLimit(limit);
    const limitWasDefault = limit === undefined;

    // Body search: prefer the NoteStore database. AppleScript's `body contains`
    // makes Notes.app scan every body before the limit applies, so a broad term
    // times out even with the default cap (#100). Any database failure (no Full
    // Disk Access, unknown schema) falls back to the AppleScript path.
    let source: ContentSearchSource | undefined;
    let dbScan: SearchContentDbResult["scan"] | undefined;
    let dbUnavailable: NoteQueryStoreError["kind"] | undefined;
    const runSearch = () => {
      if (searchContent) {
        try {
          const db = searchContentViaDatabase({
            query,
            account: notesManager.searchAccountScope(account),
            folder,
            modifiedSince,
            limit: effectiveLimit,
          });
          source = "database";
          dbScan = db.scan;
          return db.notes;
        } catch (error) {
          if (!(error instanceof NoteQueryStoreError)) throw error;
          dbUnavailable = error.kind;
        }
        source = "applescript";
      }
      try {
        return notesManager.searchNotes(
          query,
          searchContent,
          account,
          folder,
          modifiedSince,
          effectiveLimit
        );
      } catch (error) {
        if (!searchContent || !(error instanceof Error)) throw error;
        throw new Error(contentSearchFailureHint(error.message, dbUnavailable));
      }
    };

    // Use sync-aware wrapper for this read operation
    const {
      result: notes,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("search-notes", runSearch);

    const searchType = searchContent
      ? source === "database"
        ? "content via the Notes database"
        : "content"
      : "titles";
    const sourceFields = source ? { source } : {};
    const scanFields = dbScan ? { scanTruncated: dbScan.scanTruncated } : {};
    const scanNote = describeContentScan(dbScan);
    const folderInfo = folder ? ` in folder "${folder}"` : "";
    const dateInfo = modifiedSince ? ` modified since ${modifiedSince}` : "";
    const { info: limitInfo, truncationNote } = describeSearchLimit(
      effectiveLimit,
      limitWasDefault,
      notes.length
    );

    // Build sync warning if needed
    const syncWarnings: string[] = [];
    if (syncBefore.syncDetected) {
      syncWarnings.push(`⚠️ iCloud sync was active during search.`);
    }
    if (syncInterference) {
      syncWarnings.push(`⚠️ Sync activity detected - results may be incomplete.`);
    }
    const syncNote = syncWarnings.length > 0 ? `\n\n${syncWarnings.join(" ")}` : "";

    if (notes.length === 0) {
      // Disclose a title-only search on the empty result: bodies were never read, so a
      // bare `{"notes":[],"count":0}` reads as "no such note exists" for a term that may
      // appear in dozens of note bodies.
      const scopeHint = describeSearchScope(searchContent, notes.length);
      return successResponse(
        `No notes found matching "${query}" in ${searchType}${folderInfo}${dateInfo}${scopeHint}${scanNote}${syncNote}`,
        { notes: [], count: 0, ...sourceFields, ...scanFields }
      );
    }

    // Format each note with ID and folder info, highlighting Recently Deleted
    const noteList = notes
      .map((n) => {
        const idSuffix = n.id ? ` [id: ${n.id}]` : "";
        if (n.folder === "Recently Deleted") {
          return `  - ${n.title} [DELETED]${idSuffix}`;
        } else if (n.folder) {
          return `  - ${n.title} (${n.folder})${idSuffix}`;
        }
        return `  - ${n.title}${idSuffix}`;
      })
      .join("\n");

    return successResponse(
      `Found ${notes.length} notes (searched ${searchType}${folderInfo}${dateInfo}${limitInfo}):\n${noteList}${truncationNote}${scanNote}${syncNote}`,
      {
        notes: withStableIdentifiers(notes, "ICNote"),
        count: notes.length,
        ...sourceFields,
        ...scanFields,
      }
    );
  }, "Error searching notes")
);

// --- query-notes ---

registerTool(
  "query-notes",
  {
    description:
      "Use when: finding notes with a boolean expression over text and metadata — e.g. `folder:Work has:checklist -checklist:done`, `(title:invoice OR tag:finance) modified:>=2026-07-01`, `pinned words:>250`. Reads the Notes database directly, so it is fast and can match title OR body in one call.\n" +
      'Syntax: bare words and "quoted phrases" match title or body (case-insensitive substring); fields title:, body:, text:, folder:, account:, tag: (values may be quoted, e.g. folder:"Work Projects"); facets has:link|attachment|checklist|drawing|image|video|audio|pdf|table|scan|tag; checklist:open|done; flags pinned, locked, shared (or is:pinned); words:>250 and created:/modified: with =, >, >=, <, <= and YYYY-MM-DD local dates. AND is implicit; OR, NOT, leading -, and parentheses are supported; operators are case-insensitive and a quoted "and" searches the literal word.\n' +
      "Returns: matching notes (most recently modified first) with id, title, folder, account, modified date, and snippet, plus scan/match counts. Ids work with get-note-content and every other id-based tool.\n" +
      "Do not use when: Full Disk Access is unavailable (use search-notes). Scans the most recent scanLimit notes (default 500); raise it for older notes.\n" +
      "Safety: read-only; never writes the database. Excludes Recently Deleted and folderless notes unless includeDeleted is true. Locked notes match on title and metadata only; body predicates never match them.",
    inputSchema: {
      query: z
        .string()
        .min(1, "A query expression is required")
        .max(MAX.QUERY)
        .describe(
          'Boolean query expression, e.g. `folder:"Work Projects" has:checklist -checklist:done`'
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(QUERY_RESULTS.MAX)
        .optional()
        .describe(
          `Maximum notes to return (default ${QUERY_RESULTS.DEFAULT}, max ${QUERY_RESULTS.MAX}). The response reports how many matched in total.`
        ),
      scanLimit: z
        .number()
        .int()
        .positive()
        .max(QUERY_SCAN.MAX)
        .optional()
        .describe(
          `How many of the most recently modified notes to examine (default ${QUERY_SCAN.DEFAULT}, max ${QUERY_SCAN.MAX}). The response says when older notes were left unscanned.`
        ),
      includeDeleted: z
        .boolean()
        .optional()
        .describe(
          "Also scan notes in Recently Deleted, notes pending deletion, and folderless notes (default false)"
        ),
    },
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      matched: z.number().optional(),
      scanned: z.number().optional(),
      eligible: z.number().optional(),
      scanLimit: z.number().optional(),
      scanTruncated: z.boolean().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      unreadable: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ query, limit, scanLimit, includeDeleted }) => {
    let result: QueryNotesResult;
    try {
      result = queryNotes(query, { limit, scanLimit, includeDeleted });
    } catch (error) {
      if (error instanceof NoteQueryError || error instanceof NoteQueryStoreError) {
        return errorResponse(
          error instanceof NoteQueryError ? `Invalid query: ${error.message}` : error.message
        );
      }
      throw error;
    }

    const scope =
      `scanned ${result.scanned} of ${result.eligible} notes` +
      (result.scanTruncated
        ? `, the most recent ${result.scanLimit}; pass a higher scanLimit to include older notes`
        : "");
    const notes: string[] = [];
    if (result.truncated) {
      notes.push(
        `ℹ️ ${result.matched} notes matched; showing the first ${result.count}. Pass a higher limit or narrow the query.`
      );
    }
    if (result.unreadable > 0) {
      notes.push(
        `⚠️ ${result.unreadable} note bodies could not be decoded, so body predicates did not match them.`
      );
    }
    const footer = notes.length ? `\n\n${notes.join("\n")}` : "";

    if (result.count === 0) {
      return successResponse(`No notes matched (${scope}).${footer}`, { ...result });
    }
    const lines = result.notes
      .map((n) => {
        const where = [n.account, n.folder].filter(Boolean).join(" / ");
        const snippet = n.snippet ? `\n      ${n.snippet}` : "";
        return `  - ${n.title}${where ? ` (${where})` : ""}${n.locked ? " [locked]" : ""} [id: ${n.id}]${snippet}`;
      })
      .join("\n");
    return successResponse(
      `Found ${result.matched} matching notes (${scope}):\n${lines}${footer}`,
      { ...result }
    );
  }, "Error querying notes")
);

// --- get-note-content ---

registerTool(
  "get-note-content",
  {
    description:
      "Use when: reading the full body text of one known note, by id (preferred) or title.\nReturns: the exact note id, content, contentHash revision token, parsed hashtags, nativeTags, restored links, richContentComplete/writable, and strippedImages/truncated when the body was capped. Read the warning when writable is false.\nDo not use when: you only need metadata (get-note-details) or Markdown with checklist state (get-note-markdown).\nNote: password-protected notes must be unlocked in Notes.app first.\nSafety: inline images larger than APPLE_NOTES_MCP_MAX_INLINE_IMAGE_BYTES (default 256 KB) are replaced with '[inline image omitted: ...]' text placeholders, so the returned body is lossy whenever truncated is true. Mutations refuse attachment-bearing notes; edit those in Notes.app. Notes.app returns images inside the body as base64, so a note with a very large image can time out; the error then names the cause, and a larger timeoutSeconds gives the read more time.",
    inputSchema: {
      id: looseNoteId(z.string())
        .optional()
        .describe(`Note ID (preferred - more reliable than title): ${NOTE_ID_FORMS}`),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account name (defaults to Notes.app's default account; exact or unique-prefix match, ignored if id is provided)"
        ),
      timeoutSeconds: timeoutSecondsInput,
    },
    outputSchema: {
      id: z.string().optional(),
      ...noteIdentifierOutput,
      title: z.string().optional(),
      content: z.string().optional(),
      contentHash: z.string().optional(),
      hashtags: z.array(z.string()).optional(),
      nativeTags: z.array(z.string()).optional(),
      links: z
        .array(
          z.object({ start: z.number(), length: z.number(), text: z.string(), url: z.string() })
        )
        .optional(),
      richContentComplete: z.boolean().optional(),
      writable: z.boolean().optional(),
      warning: z.string().optional(),
      /** Number of oversized inline images replaced with text placeholders. */
      strippedImages: z.number().optional(),
      /** True when content is lossy — see strippedImages. Never write a truncated body back. */
      truncated: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
    // Prefer ID-based lookup if provided
    if (id) {
      // Check for password protection first for better error message
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      if (note.passwordProtected) {
        return errorResponse(
          `Note "${note.title}" is password-protected and cannot be read. Unlock it in Notes.app first.`
        );
      }
      const { body: rawContent, error: readError } = notesManager.readNoteBodyById(id);
      if (!rawContent) {
        return errorResponse(bodyReadFailureMessage(id, note.title, readError));
      }
      // Cap inline base64 images so an image-heavy note cannot produce a
      // response large enough to blow the client's MCP message limit.
      const rich = enrichNoteRead(id, rawContent);
      const stripped = stripLargeInlineImages(rich.content);
      const content = stripped.html;
      const hashtags = parseHashtags(content);
      const warning = [strippedImagesWarning(stripped), rich.warning].filter(Boolean).join("\n\n");
      return successResponse(warning ? content + warning : content, {
        id,
        ...noteIdentifiers(id),
        title: note.title,
        content,
        contentHash: richContentHash(rawContent, rich),
        links: rich.links,
        nativeTags: rich.nativeTags,
        richContentComplete: rich.complete,
        writable: rich.writable && stripped.strippedCount === 0,
        supportedOperations: {
          fullBodyReplace: rich.writable && stripped.strippedCount === 0,
          nativeAppendImplemented: VERIFIED_BACKGROUND.has("append-native"),
          requiresShortcut: !rich.writable,
        },
        warning: rich.warning,
        hashtags,
        strippedImages: stripped.strippedCount,
        truncated: stripped.strippedCount > 0,
      });
    }

    // Fall back to title-based lookup
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    // Check for password protection first for better error message
    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(`Note "${title}" not found`);
    }
    if (note.passwordProtected) {
      return errorResponse(
        `Note "${title}" is password-protected and cannot be read. Unlock it in Notes.app first.`
      );
    }

    const { body: rawContent, error: readError } = notesManager.readNoteBodyById(note.id);
    if (!rawContent) {
      return errorResponse(bodyReadFailureMessage(note.id, title, readError));
    }

    const rich = enrichNoteRead(note.id, rawContent);
    const stripped = stripLargeInlineImages(rich.content);
    const content = stripped.html;
    const hashtags = parseHashtags(content);
    const warning = [strippedImagesWarning(stripped), rich.warning].filter(Boolean).join("\n\n");
    return successResponse(warning ? content + warning : content, {
      id: note.id,
      ...noteIdentifiers(note.id),
      title,
      content,
      contentHash: richContentHash(rawContent, rich),
      links: rich.links,
      nativeTags: rich.nativeTags,
      richContentComplete: rich.complete,
      writable: rich.writable && stripped.strippedCount === 0,
      supportedOperations: {
        fullBodyReplace: rich.writable && stripped.strippedCount === 0,
        nativeAppendImplemented: VERIFIED_BACKGROUND.has("append-native"),
        requiresShortcut: !rich.writable,
      },
      warning: rich.warning,
      hashtags,
      strippedImages: stripped.strippedCount,
      truncated: stripped.strippedCount > 0,
    });
  }, "Error retrieving note content")
);

// --- get-note-plaintext ---

registerTool(
  "get-note-plaintext",
  {
    description:
      "Use when: reading one note's body as plain text with no HTML, by id (preferred) or title.\nReturns: the note's plaintext exactly as Notes exposes it.\nDo not use when: you need the HTML body (get-note-content) or Markdown with checklist state (get-note-markdown).\nNote: this reads the note's native plaintext property, so it skips the HTML-to-text conversion; password-protected notes must be unlocked in Notes.app first.",
    inputSchema: {
      id: looseNoteId(z.string())
        .optional()
        .describe(`Note ID (preferred - more reliable than title): ${NOTE_ID_FORMS}`),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account name (defaults to Notes.app's default account; exact or unique-prefix match, ignored if id is provided)"
        ),
    },
    outputSchema: {
      title: z.string().optional(),
      plaintext: z.string().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
    // Prefer ID-based lookup if provided
    if (id) {
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      if (note.passwordProtected) {
        return errorResponse(
          `Note "${note.title}" is password-protected and cannot be read. Unlock it in Notes.app first.`
        );
      }
      const plaintext = notesManager.getNotePlaintextById(id);
      if (!plaintext) {
        return errorResponse(`Failed to read plaintext of note "${note.title}"`);
      }
      return successResponse(plaintext, { title: note.title, plaintext });
    }

    // Fall back to title-based lookup
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(`Note "${title}" not found`);
    }
    if (note.passwordProtected) {
      return errorResponse(
        `Note "${title}" is password-protected and cannot be read. Unlock it in Notes.app first.`
      );
    }

    const plaintext = notesManager.getNotePlaintext(title, account);
    if (!plaintext) {
      return errorResponse(`Failed to read plaintext of note "${title}"`);
    }

    return successResponse(plaintext, { title, plaintext });
  }, "Error retrieving note plaintext")
);

// --- get-note-by-id ---

registerTool(
  "get-note-by-id",
  {
    description:
      "Use when: you have a note id and need its metadata only.\nReturns: id, title, created, modified, shared, passwordProtected.\nDo not use when: you need the body text (get-note-content) or only have a title (get-note-details).",
    inputSchema: {
      id: looseNoteId(z.string().min(1, "Note ID is required")).describe(
        `Note ID: ${NOTE_ID_FORMS}`
      ),
    },
    outputSchema: {
      id: z.string().optional(),
      title: z.string().optional(),
      created: z.string().optional(),
      modified: z.string().optional(),
      shared: z.boolean().optional(),
      passwordProtected: z.boolean().optional(),
      ...noteIdentifierOutput,
    },
  },
  withErrorHandling(({ id }) => {
    const note = notesManager.getNoteById(id);

    if (!note) {
      return errorResponse(`Note with ID "${id}" not found`);
    }

    // Return structured metadata as JSON
    const metadata = {
      id: note.id,
      title: note.title,
      created: note.created.toISOString(),
      modified: note.modified.toISOString(),
      shared: note.shared,
      passwordProtected: note.passwordProtected,
      ...noteIdentifiers(note.id),
    };

    return successResponse(JSON.stringify(metadata, null, 2), metadata);
  }, "Error retrieving note")
);

// --- get-note-details ---

registerTool(
  "get-note-details",
  {
    description:
      "Use when: you have a note title (not an id) and need its metadata.\nReturns: id, title, created, modified, shared, passwordProtected, account.\nDo not use when: you have an id (get-note-by-id) or need the body text (get-note-content).\nUse the returned id for reliable follow-up operations.",
    inputSchema: noteTitleSchema,
    outputSchema: {
      id: z.string().optional(),
      title: z.string().optional(),
      created: z.string().optional(),
      modified: z.string().optional(),
      shared: z.boolean().optional(),
      passwordProtected: z.boolean().optional(),
      account: z.string().optional(),
      ...noteIdentifierOutput,
    },
  },
  withErrorHandling(({ title, account }) => {
    const note = notesManager.getNoteDetails(title, account);

    if (!note) {
      return errorResponse(`Note "${title}" not found`);
    }

    // Return structured metadata as JSON
    const metadata = {
      id: note.id,
      title: note.title,
      created: note.created.toISOString(),
      modified: note.modified.toISOString(),
      shared: note.shared,
      passwordProtected: note.passwordProtected,
      account: note.account,
      ...noteIdentifiers(note.id),
    };

    return successResponse(JSON.stringify(metadata, null, 2), metadata);
  }, "Error retrieving note details")
);

// --- show-note ---

registerTool(
  "show-note",
  {
    description:
      "Use when: the user wants to reveal a known note in Notes.app by id.\nReturns: confirmation that Notes.app accepted the show command.\nDo not use when: you only need note content (get-note-content) or metadata (get-note-by-id).\nNote: this opens or focuses the Notes UI.",
    inputSchema: {
      id: looseNoteId(z.string().min(1, "Note ID is required")).describe(
        `Note ID: ${NOTE_ID_FORMS}`
      ),
      separately: z
        .boolean()
        .optional()
        .describe("Open in a separate note window when supported by Notes.app"),
    },
    outputSchema: {
      id: z.string().optional(),
      separately: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, separately = false }) => {
    const success = notesManager.showNoteById(id, separately);
    if (!success) {
      return errorResponse(`Failed to show note with ID "${id}"`);
    }
    return successResponse(`Shown note with ID "${id}" in Notes.app`, { id, separately });
  }, "Error showing note")
);

// --- get-note-link ---

registerTool(
  "get-note-link",
  {
    description:
      "Use when: you need the notes:// deep-link URL for a note so it can be stored in a Reminders task, shared, or opened directly.\nReturns: a notes://showNote?identifier=<uuid> URL that opens the note in Notes.app on iOS and macOS.\nDo not use when: you only need the note's CoreData id (get-note-by-id) or want to reveal the note on screen (show-note).\nNote: the primary path reads the note's identifier from the Notes database, so it needs Full Disk Access for the Node binary running this server; macOS 12-15 can fall back to the AppleScript 'note link' property, which macOS 26+ no longer exposes. Password-protected notes cannot be linked.",
    inputSchema: {
      id: looseNoteId(z.string())
        .optional()
        .describe(`Note ID (preferred - more reliable than title): ${NOTE_ID_FORMS}`),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note (ignored if id is provided)"),
    },
    outputSchema: {
      id: z.string().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
    if (id) {
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      if (note.passwordProtected) {
        return errorResponse(
          `Note "${note.title}" is password-protected. Unlock it in Notes.app first.`
        );
      }
      const url = notesManager.getNoteLinkById(id);
      if (!url) {
        return errorResponse(
          `Failed to get note link for "${note.title}". The Notes database may not be accessible — grant Full Disk Access to the Node binary running the server (or the terminal that launches it), fully quit and relaunch, then run the doctor tool. See: ${FULL_DISK_ACCESS_GUIDE_URL}. (On macOS 12–15 this also falls back to the AppleScript note link property.)`
        );
      }
      return successResponse(`Note link: ${url}`, { id, title: note.title, url });
    }

    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(
        `Note "${title}" not found. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }
    if (note.passwordProtected) {
      return errorResponse(`Note "${title}" is password-protected. Unlock it in Notes.app first.`);
    }
    const url = notesManager.getNoteLink(title, account);
    if (!url) {
      return errorResponse(
        `Failed to get note link for "${title}". The Notes database may not be accessible — grant Full Disk Access to the Node binary running the server (or the terminal that launches it), fully quit and relaunch, then run the doctor tool. See: ${FULL_DISK_ACCESS_GUIDE_URL}. (On macOS 12–15 this also falls back to the AppleScript note link property.)`
      );
    }
    return successResponse(`Note link: ${url}`, { title, url });
  }, "Error getting note link")
);

// --- show-folder ---

registerTool(
  "show-folder",
  {
    description:
      "Use when: the user wants to reveal a known folder in Notes.app by id.\nReturns: confirmation that Notes.app accepted the show command.\nDo not use when: you only need the folder list (list-folders).\nNote: this opens or focuses the Notes UI. Get the id from list-folders.",
    inputSchema: {
      id: looseFolderId(z.string().min(1, "Folder ID is required")).describe(
        "Folder ID from list-folders: x-coredata id, Notes UUID, or numeric key"
      ),
      separately: z
        .boolean()
        .optional()
        .describe("Open in a separate window when supported by Notes.app"),
    },
    outputSchema: {
      id: z.string().optional(),
      separately: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, separately = false }) => {
    const success = notesManager.showFolderById(id, separately);
    if (!success) {
      return errorResponse(`Failed to show folder with ID "${id}"`);
    }
    return successResponse(`Shown folder with ID "${id}" in Notes.app`, { id, separately });
  }, "Error showing folder")
);

// --- show-account ---

registerTool(
  "show-account",
  {
    description:
      "Use when: the user wants to reveal a known account in Notes.app by id.\nReturns: confirmation that Notes.app accepted the show command.\nDo not use when: you only need the account list (list-accounts).\nNote: this opens or focuses the Notes UI. Get the id from list-accounts.",
    inputSchema: {
      id: z.string().min(1, "Account ID is required").max(MAX.ID),
      separately: z
        .boolean()
        .optional()
        .describe("Open in a separate window when supported by Notes.app"),
    },
    outputSchema: {
      id: z.string().optional(),
      separately: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, separately = false }) => {
    const success = notesManager.showAccountById(id, separately);
    if (!success) {
      return errorResponse(`Failed to show account with ID "${id}"`);
    }
    return successResponse(`Shown account with ID "${id}" in Notes.app`, { id, separately });
  }, "Error showing account")
);

// --- update-note ---

registerTool(
  "get-native-objects",
  {
    description:
      "Use when: inspecting native objects, checklist identities, or tables in one exact note.\nReturns: native object IDs and ranges, checklist IDs and state, actual native tags, decoded tables, and the current rich content hash.\nDo not use when: you only need the note body (get-note-content) or AppleScript attachment metadata (list-attachments).\nSafety: read-only; requires Full Disk Access and reports incomplete table metadata instead of guessing.",
    inputSchema: { id: noteIdInput },
    outputSchema: {
      id: z.string().optional(),
      contentHash: z.string().optional(),
      objects: z.array(z.record(z.unknown())).optional(),
      checklistItems: z.array(z.record(z.unknown())).optional(),
      nativeTags: z.array(z.string()).optional(),
      tables: z.array(z.record(z.unknown())).optional(),
      tableCellsComplete: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id }) => {
    const note = notesManager.getNoteById(id);
    if (!note) return errorResponse(`Note with ID "${id}" not found`);
    const body = notesManager.getNoteContentById(id);
    if (!body) return errorResponse(`Failed to read content of note "${note.title}"`);
    const rich = readRichNote(id);
    const tables: Array<Record<string, unknown>> = (rich.objectData || [])
      .filter((object) => object.type?.includes("table"))
      .map((object) => {
        try {
          return {
            id: object.id,
            attachmentId: id.replace(/ICNote\/p\d+$/, `ICAttachment/p${object.pk}`),
            complete: true,
            ...parseNoteTable(Buffer.from(object.mergeable, "hex")),
          };
        } catch (error) {
          return { id: object.id, complete: false, reason: String(error) };
        }
      });
    for (const object of rich.objects || []) {
      if (object.type.includes("table") && !tables.some((table) => table.id === object.id)) {
        tables.push({
          id: object.id,
          complete: false,
          reason: "Native table metadata is unavailable",
        });
      }
    }
    const richRead: RichRead = {
      content: body,
      links: rich.links,
      nativeTags: rich.nativeTags,
      complete: true,
      writable: !rich.hasNativeObjects && !rich.hasChecklist,
      revision: rich.revision,
    };
    return successResponse("Native objects read from the exact note", {
      id,
      contentHash: richContentHash(body, richRead),
      objects: rich.objects,
      checklistItems: rich.checklistItems,
      nativeTags: rich.nativeTags,
      tables,
      tableCellsComplete: tables.every((table) => table.complete),
    });
  }, "Error reading native objects")
);

// --- get-note-tables ---

registerTool(
  "get-note-tables",
  {
    description:
      "Use when: reading the native tables in one exact note as data or Markdown.\nReturns: every table in body order as GitHub-flavored Markdown (first row as header) plus JSON rows with stable row/column ids, and tableCellsComplete.\nDo not use when: you need the whole note (get-note-markdown / get-note-content) or native object ranges and checklist ids (get-native-objects).\nSafety: read-only; reads the NoteStore database and requires Full Disk Access. A cell that cannot be decoded is null in rows, listed in incompleteCells, and marked [undecoded cell] in Markdown; it is never guessed. Cell text only: links and styling inside cells are not rendered.",
    inputSchema: { id: noteIdInput },
    outputSchema: {
      id: z.string().optional(),
      tables: z.array(z.record(z.unknown())).optional(),
      tableCount: z.number().optional(),
      tableCellsComplete: z.boolean().optional(),
      markdown: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id }) => {
    // Database-only path: the metadata read classifies missing notes and
    // Full Disk Access failures before the rich-text read is attempted.
    const { metadata, message } = getNoteMetadata(id);
    if (!metadata) return errorResponse(message || `Failed to read note "${id}"`);
    if (metadata.passwordProtected) {
      return errorResponse(
        `Note "${id}" is password-protected; its tables are encrypted. Unlock it in Notes.app first.`
      );
    }
    const result = notesManager.getNoteTablesById(id);
    const count = result.tables.length;
    const summary =
      count === 0
        ? "This note has no native tables."
        : `${count} table(s)${result.tableCellsComplete ? "" : " (some content could not be decoded; see tables[].reason)"}:\n\n${result.markdown}`;
    return successResponse(summary, {
      id,
      tables: result.tables as unknown as Array<Record<string, unknown>>,
      tableCount: count,
      tableCellsComplete: result.tableCellsComplete,
      markdown: result.markdown,
    });
  }, "Error reading note tables")
);

// --- get-note-blocks ---

registerTool(
  "get-note-blocks",
  {
    description:
      "Use when: you need a note's structure, not just its text: paragraph styles (title, heading, subheading, body, monospaced, bulleted/dashed/numbered list, checklist with done state), indent, alignment, block quote, inline formatting (bold, italic, underline, strikethrough, superscript, subscript, color, highlight, links) and attachment positions, by exact id.\nReturns: one page of blocks in body order (default 500, stopped early under APPLE_NOTES_MCP_BLOCKS_MAX_BYTES, default 4 MB), whole-note summary counts, undecodedFields, and page info; while page.hasMore is true, call again with offset set to page.nextOffset. Offsets and lengths count UTF-16 code units.\nDo not use when: you want the editable HTML body (get-note-content) or Markdown (get-note-markdown).\nSafety: read-only; decodes the NoteStore database directly and requires Full Disk Access. Password-protected notes are refused. Link URLs are returned as stored; linkSafe is false for schemes other than http(s), notes, applenotes and mailto.",
    inputSchema: {
      id: noteIdInput,
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of the first block to return (default 0); use page.nextOffset"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Maximum blocks to return (default 500, max 5000)"),
    },
    outputSchema: {
      id: z.string().optional(),
      textLength: z.number().optional(),
      blocks: z.array(z.record(z.unknown())).optional(),
      page: z.record(z.unknown()).optional(),
      summary: z.record(z.unknown()).optional(),
      undecodedFields: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id, offset, limit }) => {
    let page;
    try {
      page = pageNoteBlocks(readNoteBlocks(id), { offset, limit });
    } catch (error) {
      if (!(error instanceof NoteBlocksError)) throw error;
      const hint =
        error.code === "no-full-disk-access"
          ? ` Grant Full Disk Access to the Node binary running this server (run the doctor tool for its path): ${FULL_DISK_ACCESS_GUIDE_URL}`
          : "";
      return errorResponse(`Error reading note blocks [${error.code}]: ${error.message}${hint}`);
    }
    const { summary } = page;
    const styles = Object.entries(summary.styles)
      .map(([style, count]) => `${style} ${count}`)
      .join(", ");
    return successResponse(
      `Decoded ${summary.blocks} blocks (${styles || "none"}); returned ${page.page.returned} from offset ${page.page.offset}` +
        (page.page.hasMore ? `; more available at offset ${page.page.nextOffset}` : "") +
        ".",
      { id, ...page }
    );
  }, "Error reading note blocks")
);

// --- list-note-paragraphs / get-paragraph-link ---

const paragraphNoteSelector = {
  id: noteIdInput.optional().describe(`Exact note ID (${NOTE_ID_FORMS}); give id or title`),
  title: z
    .string()
    .min(1)
    .max(MAX.TITLE)
    .optional()
    .describe("Exact note title; must match one note unless folder narrows it"),
  folder: z
    .string()
    .min(1)
    .max(MAX.FOLDER)
    .optional()
    .describe("With title only: the note's folder name or full path as list-folders shows it"),
};

registerTool(
  "list-note-paragraphs",
  {
    description:
      "Use when: you need a note's paragraphs with their style and stored paragraph ID, for example to choose one to link to.\nReturns: one page of non-empty paragraphs in body order, each with blockIndex (as in get-note-blocks), text, style, paragraphId, paragraphIdStatus (unique, shared, missing) and, only when unique, a direct applenotes:// url that opens that paragraph; plus counts per status and page info (call again with offset set to page.nextOffset while page.hasMore is true).\nDo not use when: you need inline formatting (get-note-blocks).\nSafety: read-only; reads the NoteStore database directly and requires Full Disk Access. Paragraph IDs repeat often (Notes copies them when a paragraph is split), so shared IDs get no url. Title lookups ignore Recently Deleted. Password-protected notes are refused.",
    inputSchema: {
      ...paragraphNoteSelector,
      linkableOnly: z
        .boolean()
        .optional()
        .describe("Return only paragraphs that have a direct url (default false)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of the first paragraph to return (default 0); use page.nextOffset"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Maximum paragraphs to return (default 500, max 5000)"),
    },
    outputSchema: {
      id: z.string().optional(),
      identifier: z.string().nullable().optional(),
      counts: z.record(z.unknown()).optional(),
      paragraphs: z.array(z.record(z.unknown())).optional(),
      page: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id, title, folder, linkableOnly, offset, limit }) => {
    const note = readNoteParagraphs({ id, title, folder });
    const page = pageParagraphs(note.paragraphs, {
      offset,
      limit,
      linkableOnly,
      maxBytes: blocksMaxResponseBytes(),
    });
    const { unique, shared, missing } = note.counts;
    return successResponse(
      `${note.paragraphs.length} paragraphs: ${unique} linkable, ${shared} with a shared ID, ${missing} without an ID; returned ${page.page.returned} from offset ${page.page.offset}` +
        (page.page.hasMore ? `; more at offset ${page.page.nextOffset}` : "") +
        ".",
      { id: note.id, identifier: note.identifier, counts: note.counts, ...page }
    );
  }, "Error listing paragraphs")
);

registerTool(
  "get-paragraph-link",
  {
    description:
      "Use when: you need a link that opens Notes at one paragraph (for example a heading) of a note.\nReturns: a direct applenotes://showNote?identifier=<note>&paragraphID=<paragraph> url and the selected paragraph, only when that paragraph's stored ID is present and appears in no other paragraph of the note. Otherwise an error whose structuredContent.reason says why: paragraph-id-shared, paragraph-id-missing, no-match, ambiguous-paragraph (pass occurrence or a longer snippet), occurrence-out-of-range, ambiguous-note, encrypted.\nDo not use when: you want a link to the whole note (get-note-link).\nSafety: read-only; never creates or changes a paragraph ID, so a paragraph without a unique ID cannot be linked. Requires Full Disk Access. A later edit in Notes can replace the ID and break the link.",
    inputSchema: {
      ...paragraphNoteSelector,
      contains: z
        .string()
        .min(1)
        .max(MAX.CONTENT)
        .optional()
        .describe(
          "Snippet of the paragraph (case, spacing and Unicode width are ignored); give one of contains, match, blockIndex"
        ),
      match: z
        .string()
        .min(1)
        .max(MAX.CONTENT)
        .optional()
        .describe("The whole paragraph text, compared the same way"),
      blockIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("The paragraph's blockIndex from list-note-paragraphs"),
      occurrence: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which match to use (1-based) when contains or match hits several paragraphs"),
    },
    outputSchema: {
      url: z.string().optional(),
      id: z.string().optional(),
      identifier: z.string().nullable().optional(),
      paragraph: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id, title, folder, contains, match, blockIndex, occurrence }) => {
    const note = readNoteParagraphs({ id, title, folder });
    const result = paragraphLink(note, { contains, match, blockIndex, occurrence });
    return successResponse(`Paragraph link: ${result.url}`, {
      url: result.url,
      id: note.id,
      identifier: note.identifier,
      paragraph: { ...result.paragraph },
    });
  }, "No paragraph link")
);

// --- get-note-structure ---

registerTool(
  "get-note-structure",
  {
    description:
      "Use when: you want one read-only overview of a note by exact id: decoded text, a block summary, every link with its kind (inline hyperlink, rich link card, native note link, native section link, with target note and paragraph UUIDs when the URL carries them), native tags, attachments with the same kind, body order and preview list-attachments reports (gallery and recording children nested), and metadata: deepLink, isShared, isLocked, isPinned, inRecentlyDeleted, lastViewed, wordCount, charCount, attachmentCount, checklistTotal/checklistDone, hasDrawing, firstImage.\nReturns: the structure object. For a password-protected note, metadata and attachment rows only (bodyDecoded false, body-derived fields null). lastViewed is null with lastViewedStatus never-viewed, not-recorded, malformed or unsupported when Notes holds no real view date.\nDo not use when: you need per-paragraph formatting (get-note-blocks) or the editable HTML body (get-note-content).\nSafety: read-only; reads the NoteStore database and the Notes data folder directly and requires Full Disk Access. Link URLs are returned as stored; check linkSafe before emitting them into HTML.",
    inputSchema: {
      id: noteIdInput,
      includeText: z
        .boolean()
        .optional()
        .describe(
          "Include the decoded note text (default true). Text over APPLE_NOTES_MCP_BLOCKS_MAX_BYTES is omitted with textOmitted: true"
        ),
    },
    outputSchema: {
      id: z.string().optional(),
      identifier: z.string().nullable().optional(),
      deepLink: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      folder: z.string().nullable().optional(),
      account: z.string().nullable().optional(),
      inRecentlyDeleted: z.boolean().optional(),
      isShared: z.boolean().nullable().optional(),
      isLocked: z.boolean().optional(),
      isPinned: z.boolean().nullable().optional(),
      lastViewed: z.string().nullable().optional(),
      lastViewedStatus: z.string().optional(),
      bodyDecoded: z.boolean().optional(),
      bodyError: z.string().optional(),
      text: z.string().optional(),
      textOmitted: z.boolean().optional(),
      textLength: z.number().nullable().optional(),
      wordCount: z.number().nullable().optional(),
      charCount: z.number().nullable().optional(),
      blockSummary: z.record(z.unknown()).nullable().optional(),
      links: z.array(z.record(z.unknown())).optional(),
      linkCounts: z.record(z.unknown()).optional(),
      linksComplete: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      attachments: z.array(z.record(z.unknown())).optional(),
      attachmentCount: z.number().optional(),
      checklistTotal: z.number().nullable().optional(),
      checklistDone: z.number().nullable().optional(),
      hasDrawing: z.boolean().optional(),
      firstImage: z.record(z.unknown()).nullable().optional(),
      undecodedFields: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id, includeText }) => {
    // noteIdInput has already resolved a UUID or numeric key to the
    // canonical x-coredata id, the only form readNoteStructure accepts.
    const structure = readNoteStructure(id, {
      includeText: includeText ?? true,
      maxTextBytes: blocksMaxResponseBytes(),
    });
    return successResponse(describeNoteStructure(structure), { ...structure });
  }, "Error reading note structure")
);

// --- list-note-links ---

registerTool(
  "list-note-links",
  {
    description:
      "Use when: you need the links in one note (by exact id) or across a folder (with its subfolders by default), an account, or the whole library, with each link's kind: inline (a hyperlink on text), card (a rich link preview), note (a native link chip to another note) or section (a native link chip to a heading or paragraph).\nReturns: one page of links, newest-modified note first, each with its URL, label, linkSafe, target note and paragraph UUIDs for Notes deep links, card previewPath, and its source noteId, note title, folder path (as list-folders prints it) and account; plus per-kind counts and page info (call again with offset set to page.nextOffset while page.hasMore is true).\nDo not use when: you want one note's full structure (get-note-structure) or its formatting (get-note-blocks).\nSafety: read-only; reads the NoteStore database directly and requires Full Disk Access. Inline links need every body in scope decoded, so they are included only with includeInline (default true for id, false for a folder, account or library scan). Recently Deleted is skipped unless the note is requested by id.",
    inputSchema: {
      id: noteIdInput.optional().describe("One exact note ID (do not combine with account/folder)"),
      account: z
        .string()
        .min(1)
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account name (exact or unique-prefix match)"),
      folder: z
        .string()
        .min(1)
        .max(MAX.FOLDER)
        .optional()
        .describe(
          "Folder name or path as list-folders prints it, such as Work/Clients (escape a literal slash as \\/)"
        ),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe("With folder, also list notes in its subfolders (default true)"),
      includeInline: z
        .boolean()
        .optional()
        .describe(
          "Also decode note bodies for inline hyperlinks (slower). Default true for id, false otherwise"
        ),
      kinds: z
        .array(z.enum(["inline", "card", "note", "section"]))
        .max(4)
        .optional()
        .describe("Only these link kinds"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of the first link to return (default 0); use page.nextOffset"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum links to return (default 200, max 2000)"),
    },
    outputSchema: {
      scope: z.record(z.unknown()).optional(),
      inlineIncluded: z.boolean().optional(),
      notesInScope: z.number().optional(),
      notesWithoutBody: z.number().optional(),
      counts: z.record(z.unknown()).optional(),
      links: z.array(z.record(z.unknown())).optional(),
      page: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(
    ({ id, account, folder, includeSubfolders, includeInline, kinds, offset, limit }) => {
      const result = listNoteLinks({
        id,
        account,
        folder,
        includeSubfolders,
        includeInline,
        kinds,
        offset,
        limit,
        maxBytes: blocksMaxResponseBytes(),
      });
      return successResponse(describeLinkInventory(result), { ...result });
    },
    "Error listing note links"
  )
);

registerTool(
  "list-native-tags",
  {
    description:
      "Use when: listing actual native Notes tags, either in one folder (pass folder) or as an account-wide inventory with note counts (omit folder; account then optionally narrows it, else every account is counted).\nReturns: folder mode maps each tag to exact matching note IDs, plus completeness and per-note errors; inventory mode returns each tag with noteCount and per-account counts, sorted by count.\nDo not use when: searching textual #hashtags in note bodies (search-notes).\nSafety: read-only; requires Full Disk Access and discloses partial reads.",
    inputSchema: {
      account: z
        .string()
        .min(1)
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account name (exact or unique prefix). Folder mode: defaults to Notes.app's default account. Inventory mode: omit to count every account."
        ),
      folder: z
        .string()
        .min(1)
        .max(MAX.FOLDER)
        .optional()
        .describe("Folder to list tags in. Omit for the account-wide inventory with counts."),
    },
    outputSchema: {
      tags: z.record(z.array(z.string())).optional(),
      complete: z.boolean().optional(),
      errors: z.record(z.string()).optional(),
      inventory: z
        .array(
          z
            .object({
              tag: z.string(),
              noteCount: z.number(),
              accounts: z.record(z.number()),
              spellings: z.array(z.string()).optional(),
            })
            .passthrough()
        )
        .optional(),
      tagCount: z.number().optional(),
      unverifiedNotes: z.number().optional(),
      account: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ account, folder }) => {
    if (!folder) {
      const result = nativeTagInventory({ account });
      const scope = result.account ? ` in ${result.account}` : " across all accounts";
      const lines = result.inventory.map(
        (entry) => `  - ${entry.tag}: ${entry.noteCount} note${entry.noteCount === 1 ? "" : "s"}`
      );
      const partial = result.complete
        ? ""
        : `\n\n${result.unverifiedNotes} note(s) could not be checked against their body (locked or unreadable) and were counted from tag objects alone.`;
      return successResponse(
        `${result.tagCount} native tag${result.tagCount === 1 ? "" : "s"}${scope}` +
          (lines.length ? `:\n${lines.join("\n")}` : ".") +
          partial,
        result as unknown as Record<string, unknown>
      );
    }
    const tags: Record<string, string[]> = {};
    const errors: Record<string, string> = {};
    for (const note of notesManager.listNoteRefs(account, folder)) {
      try {
        for (const tag of readRichNote(note.id).nativeTags) (tags[tag] ||= []).push(note.id);
      } catch {
        errors[note.id] = "Native metadata unavailable";
      }
    }
    return successResponse("Native tags read from the requested folder", {
      tags,
      complete: Object.keys(errors).length === 0,
      errors,
    });
  }, "Error listing native tags")
);

registerTool(
  "update-note",
  {
    description:
      "Use when: replacing the body of one exact Apple Note after reading it by id.\nReturns: exact id, new content hash, and visible-text readback verification.\nDo not use when: you only have a title, the note changed since the read, or the note has attachments.\nSafety: requires the exact note id and expectedContentHash from get-note-content. The server checks rich metadata revision, atomically checks the AppleScript body, blocks native objects/checklists, and verifies actual link destinations after saving. Optional ifFolderId, ifAncestorFolderId, and forbiddenAncestorFolderIds are re-checked inside the same AppleScript as the write. Preserve returned HTML links unless allowLinkChanges is explicitly requested. Notes.app normalizes HTML, so rich formatting is not claimed as byte-identical.",
    inputSchema: {
      id: noteIdInput,
      expectedContentHash: expectedContentHashInput,
      allowLinkChanges: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set true only when the user explicitly intends to remove, relabel or change existing links. Defaults to preserving all links."
        ),
      newTitle: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe(
          "New title for plaintext updates. Ignored when format is 'html'; include the visible title as the first line of newContent instead."
        ),
      newContent: z
        .string()
        .min(1, "New content is required")
        .max(MAX.CONTENT)
        .describe(
          "New note body. AppleScript cannot produce true Apple Notes checklists; checkbox inputs and `- [ ]` markdown do not render as checkable items. Use a plain list and convert in Notes.app with ⇧⌘L."
        ),
      format: z
        .enum(["plaintext", "html"])
        .optional()
        .default("plaintext")
        .describe("Content format: 'plaintext' (default) or 'html' for rich formatting"),
      timeoutSeconds: timeoutSecondsInput,
      ...scopeGuardInputs,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      shared: z.boolean().optional(),
      previousContentHash: z.string().optional(),
      contentHash: z.string().optional(),
      verifiedVisibleText: z.boolean().optional(),
    },
  },
  withErrorHandling(
    ({
      id,
      expectedContentHash,
      newTitle,
      newContent,
      format = "plaintext",
      allowLinkChanges = false,
      ...scopeArgs
    }) => {
      const snapshot = readExactNoteSnapshot(id);
      if ("error" in snapshot) return errorResponse(snapshot.error);
      if (snapshot.contentHash !== expectedContentHash) {
        return errorResponse(revisionConflictMessage(snapshot.note.title));
      }

      assertLinkedWrite(snapshot.rich, newContent, format, allowLinkChanges);

      // This preflight gives a clear count. The manager repeats the attachment
      // check inside the same AppleScript as the write to close the race window.
      const attachments = notesManager.listAttachmentsById(id);
      if (attachments.length > 0) {
        return errorResponse(
          `Note "${snapshot.note.title}" has ${attachments.length} attachment(s). Full-body replacement is blocked; edit it in Notes.app.`
        );
      }

      const result = notesManager.updateNoteByIdIfUnchanged(
        id,
        snapshot.note.title,
        snapshot.body,
        newTitle,
        newContent,
        format,
        snapshot.rich.revision,
        scopeFrom(scopeArgs)
      );
      if (result.status === "conflict") {
        return errorResponse(revisionConflictMessage(snapshot.note.title));
      }
      if (result.status === "scope_conflict") {
        return errorResponse(scopeConflictMessage(result.reason));
      }
      if (result.status === "attachments") {
        return errorResponse(
          `Note "${snapshot.note.title}" gained an attachment before saving. No content was replaced.`
        );
      }
      if (result.status !== "updated") {
        return errorResponse(
          `The update result for note "${snapshot.note.title}" is uncertain. Read the exact ID before retrying.`
        );
      }

      const readback = notesManager.getNoteContentById(id);
      const richReadback = enrichNoteRead(id, readback || "");
      const contentHash = readback ? richContentHash(readback, richReadback) : "";
      if (
        !richReadback.complete ||
        linkSignature(richReadback.links) !== linkSignature(htmlLinks(result.writtenBody))
      ) {
        return errorResponse(
          "The note accepted the write, but rich-link readback is not verified. Read the exact ID before retrying; do not repeat the write automatically."
        );
      }
      if (
        !readback ||
        comparableVisibleText(readback) !== comparableVisibleText(result.writtenBody)
      ) {
        return errorResponse(
          `The note accepted an update, but exact-ID readback visible text did not match. Do not retry automatically; inspect note ID ${id} in Notes.app.`
        );
      }

      const displayTitle = resolveUpdateResponseTitle(
        snapshot.note.title,
        newTitle,
        format,
        newContent
      );
      const sharedWarning = snapshot.note.shared
        ? "\n\n⚠️ This note is shared with collaborators. Your changes are visible to them."
        : "";
      const checklistWarning = detectChecklistAttempt(newContent) ?? "";
      return successResponse(
        `Note updated; visible text verified: "${displayTitle}" [id: ${id}]${sharedWarning}${checklistWarning}`,
        {
          ok: true,
          id,
          title: displayTitle,
          shared: snapshot.note.shared ?? false,
          previousContentHash: expectedContentHash,
          contentHash,
          verifiedVisibleText: true,
        }
      );
    },
    "Error updating note"
  )
);

/** Arguments for the guarded append shared by append-to-note and insert-link. */
interface GuardedAppendArgs {
  id: string;
  expectedContentHash: string;
  content: string;
  position?: "after" | "before";
  separator?: string;
  format?: "plaintext" | "html";
  scopeText?: string;
  /**
   * HTML placed between the body and the new block on the AppleScript route,
   * overriding the separator conversion. The native route ignores it and
   * still requires the default separator.
   */
  htmlSeparator?: string;
  ifFolderId?: string;
  ifAncestorFolderId?: string;
  forbiddenAncestorFolderIds?: string[];
}

/**
 * Revision-checked append to one exact note. Ordinary notes are rewritten
 * through AppleScript with visible-text and link readback; notes holding
 * native objects go through the native end-append bridge. Returns the tool
 * response; `onRoute` learns which route ran before the write starts.
 */
function guardedAppend(
  {
    id,
    expectedContentHash,
    content,
    position = "after",
    separator = "\n\n",
    format = "plaintext",
    scopeText,
    htmlSeparator,
    ...scopeArgs
  }: GuardedAppendArgs,
  onRoute?: (route: "applescript" | "native") => void
): ToolResponse {
  // Helper: convert new content to HTML block(s) and separator to HTML.
  // Notes stores its body as HTML; reading plaintext and writing back as
  // plaintext would destroy <b>/<i>/etc. formatting and duplicate the
  // title (plaintext includes the title as the first line, and the
  // plaintext write path prepends it again).  We always read as HTML,
  // split off the title <div>, convert the new content to HTML if needed,
  // and write back as HTML.
  const contentToHtml = (text: string): string => {
    if (format === "html") return text;
    // Plaintext: each line becomes a <div> (empty lines become <div><br></div>)
    return text
      .split("\n")
      .map((line) => {
        const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<div>${escaped || "<br>"}</div>`;
      })
      .join("");
  };
  const separatorToHtml = (sep: string): string => {
    if (format === "html") return sep;
    if (sep === "\n\n") return "<div><br></div>";
    // Arbitrary plaintext separator: escape and wrap
    const escaped = sep.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div>${escaped}</div>`;
  };

  const snapshot = readExactNoteSnapshot(id);
  if ("error" in snapshot) return errorResponse(snapshot.error);
  if (snapshot.contentHash !== expectedContentHash) {
    return errorResponse(revisionConflictMessage(snapshot.note.title));
  }
  if (!snapshot.rich.writable) {
    if (separator !== "\n\n")
      return errorResponse("Native append supports the default blank-line separator only");
    if (position !== "after") return errorResponse("Native append supports the end of a note only");
    if (!scopeText)
      return errorResponse("Provide scopeText: a unique existing phrase for native append");
    if (!VERIFIED_BACKGROUND.has("append-native"))
      return errorResponse("Native append has not passed live validation; see get-capabilities");
    // Native append runs through Shortcuts, so the scope check is a
    // separate read just before it rather than part of the write.
    const nativeScope = scopeFrom(scopeArgs);
    if (hasScopeGuard(nativeScope)) {
      const reason = notesManager.checkNoteScope(id, nativeScope);
      if (reason) return errorResponse(scopeConflictMessage(reason));
    }
    onRoute?.("native");
    const result = appendNative(notesManager, {
      id,
      expectedContentHash,
      scopeText,
      content,
      format,
    });
    return successResponse("Native append verified without replacing existing objects", result);
  }
  onRoute?.("applescript");
  const attachments = notesManager.listAttachmentsById(id);
  if (attachments.length > 0) {
    return errorResponse(
      `Note "${snapshot.note.title}" has ${attachments.length} attachment(s). Append is blocked because it rewrites the full body; edit it in Notes.app.`
    );
  }

  assertLinkedWrite(snapshot.rich, snapshot.rich.content, "html");

  // Separate the title <div> from the body
  const firstDivEnd = snapshot.rich.content.indexOf("</div>");
  const titleDiv = firstDivEnd !== -1 ? snapshot.rich.content.slice(0, firstDivEnd + 6) : "";
  const bodyHtml =
    firstDivEnd !== -1 ? snapshot.rich.content.slice(firstDivEnd + 6) : snapshot.rich.content;
  const newBlock = contentToHtml(content);
  const sepHtml = htmlSeparator ?? separatorToHtml(separator);
  const combinedBody =
    position === "before"
      ? titleDiv + newBlock + sepHtml + bodyHtml
      : titleDiv + bodyHtml + sepHtml + newBlock;

  const result = notesManager.updateNoteByIdIfUnchanged(
    id,
    snapshot.note.title,
    snapshot.body,
    undefined,
    combinedBody,
    "html",
    snapshot.rich.revision,
    scopeFrom(scopeArgs)
  );
  if (result.status === "conflict") {
    return errorResponse(revisionConflictMessage(snapshot.note.title));
  }
  if (result.status === "scope_conflict") {
    return errorResponse(scopeConflictMessage(result.reason));
  }
  if (result.status === "attachments") {
    return errorResponse(
      `Note "${snapshot.note.title}" gained an attachment before saving. No content was appended.`
    );
  }
  if (result.status !== "updated") {
    return errorResponse(
      `The append result for note "${snapshot.note.title}" is uncertain. Read the exact ID before retrying.`
    );
  }

  const readback = notesManager.getNoteContentById(id);
  const richReadback = enrichNoteRead(id, readback || "");
  const contentHash = readback ? richContentHash(readback, richReadback) : "";
  if (
    !richReadback.complete ||
    linkSignature(richReadback.links) !== linkSignature(htmlLinks(result.writtenBody))
  ) {
    return errorResponse(
      "The note accepted the write, but rich-link readback is not verified. Read the exact ID before retrying; do not repeat the write automatically."
    );
  }
  if (!readback || comparableVisibleText(readback) !== comparableVisibleText(result.writtenBody)) {
    return errorResponse(
      `The note accepted an append, but exact-ID readback visible text did not match. Do not retry automatically; inspect note ID ${id} in Notes.app.`
    );
  }
  const sharedWarning = snapshot.note.shared
    ? "\n\n⚠️ This note is shared with collaborators. Your changes are visible to them."
    : "";
  return successResponse(
    `Note appended; visible text verified: "${snapshot.note.title}"${sharedWarning}`,
    {
      ok: true,
      id,
      title: snapshot.note.title,
      shared: snapshot.note.shared ?? false,
      previousContentHash: expectedContentHash,
      contentHash,
      verifiedVisibleText: true,
    }
  );
}

// --- append-to-note ---

registerTool(
  "append-to-note",
  {
    description:
      "Use when: adding content to one exact note after reading it by id.\nReturns: exact id, new content hash, and visible-text readback verification.\nDo not use when: you only have a title or the note changed since the read.\nSafety: protected native-object notes use native end-append with scopeText; ordinary notes retain guarded HTML editing. Optional ifFolderId, ifAncestorFolderId, and forbiddenAncestorFolderIds are re-checked inside the write AppleScript for ordinary notes, and as a separate read just before a native append. Notes.app normalizes HTML, so rich formatting is not claimed as byte-identical.\nNative-append HTML subset (protected notes only; ordinary notes accept any HTML Notes.app renders): " +
      NATIVE_APPEND_HTML_SUBSET +
      " Native append also requires scopeText, the default blank-line separator and position 'after'.",
    inputSchema: {
      id: noteIdInput,
      expectedContentHash: expectedContentHashInput,
      content: z
        .string()
        .min(1, "Content to append is required")
        .max(MAX.CONTENT)
        .describe("Text to append to the note body"),
      scopeText: z
        .string()
        .min(12)
        .max(500)
        .optional()
        .describe("Existing unique phrase required for native append to protected notes"),
      position: z
        .enum(["after", "before"])
        .optional()
        .default("after")
        .describe(
          "Where to insert: 'after' appends to the end (default); 'before' inserts directly below the note's title line, so the title stays first"
        ),
      separator: z
        .string()
        .max(20)
        .optional()
        .default("\n\n")
        .describe("String placed between existing content and new content (default: two newlines)"),
      format: z
        .enum(["plaintext", "html"])
        .optional()
        .default("plaintext")
        .describe("Format of the content being appended: 'plaintext' (default) or 'html'"),
      timeoutSeconds: timeoutSecondsInput,
      ...scopeGuardInputs,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      shared: z.boolean().optional(),
      previousContentHash: z.string().optional(),
      contentHash: z.string().optional(),
      verifiedVisibleText: z.boolean().optional(),
    },
  },
  withErrorHandling((args) => guardedAppend(args), "Error appending to note")
);

// --- insert-link ---

registerTool(
  "insert-link",
  {
    description:
      "Use when: adding one web, mail or Notes link to an exact note, either as the raw URL (mode 'raw') or as label text that links to the URL (mode 'hyperlink').\nReturns: exact id, the route used, whether Notes stored a link on the inserted text, the stored destination read back from the note, and the new content hash.\nDo not use when: linking to another note by id (insert-note-link fetches its real deep link), or you want a rich URL preview card (not available: no public automation route creates one).\nSafety: same guards as append-to-note (fresh expectedContentHash, attachment block, existing links must survive). Notes with native objects use native end-append and need scopeText; there only position 'end' with a blank line is supported. The link is placed in its own paragraph at the end or directly after the title; placing it inside an existing paragraph is not supported.",
    inputSchema: {
      id: noteIdInput,
      expectedContentHash: expectedContentHashInput,
      url: z
        .string()
        .min(1, "url is required")
        .max(MAX_LINK_URL_LENGTH)
        .describe(
          "Link destination: absolute http(s) URL with a host, or a mailto:, notes:// or applenotes: link. No spaces."
        ),
      mode: z
        .enum(["raw", "hyperlink"])
        .optional()
        .default("raw")
        .describe(
          "'raw' (default) shows the URL itself; 'hyperlink' shows `label` linking to the URL"
        ),
      label: z
        .string()
        .max(MAX_LINK_LABEL_LENGTH)
        .optional()
        .describe("Visible text for mode 'hyperlink' (required there, refused in raw mode)"),
      linked: z
        .boolean()
        .optional()
        .describe(
          "Raw mode only. true (default) stores a real link on the URL text. false writes plain text with no stored link; Notes may still detect it when displaying, and the result reports linkStored."
        ),
      position: z
        .enum(["end", "after-title"])
        .optional()
        .default("end")
        .describe("'end' (default) or 'after-title' (first paragraph below the title)"),
      blankLine: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Leave a blank line between existing text and the link paragraph (default true; native-object notes require true)"
        ),
      scopeText: z
        .string()
        .min(12)
        .max(500)
        .optional()
        .describe("Existing unique phrase; required only for notes with native objects"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      mode: z.string().optional(),
      url: z.string().optional(),
      text: z.string().optional(),
      position: z.string().optional(),
      route: z.string().optional(),
      linkStored: z.boolean().optional(),
      storedUrl: z.string().optional(),
      previousContentHash: z.string().optional(),
      contentHash: z.string().optional(),
    },
  },
  withErrorHandling((args) => {
    const result = insertLink(
      {
        ...args,
        mode: args.mode ?? "raw",
        position: args.position ?? "end",
        blankLine: args.blankLine ?? true,
      },
      {
        readLinks: (noteId) => readRichNote(noteId).links,
        append: (request) => {
          let route: "applescript" | "native" = "applescript";
          const response = guardedAppend(
            {
              ...request,
              format: "html",
              htmlSeparator: request.separator ? "<div><br></div>" : "",
            },
            (r) => (route = r)
          );
          if (response.isError) throw new Error(response.content[0].text);
          return { route, contentHash: String(response.structuredContent?.contentHash ?? "") };
        },
      }
    );
    const stored = result.linkStored
      ? `stored link to ${result.storedUrl}`
      : "no stored link (plain text)";
    return successResponse(
      `Link inserted (${result.mode}, ${result.position}, ${result.route}); ${stored}`,
      { ...result }
    );
  }, "Error inserting link")
);

// --- delete-note ---

registerTool(
  "delete-note",
  {
    description:
      "Use when: moving one exact note to Recently Deleted after reading and reviewing it.\nReturns: confirmation with the exact id.\nDo not use when: you only have a title or the note changed since review.\nSafety: requires id and expectedContentHash from get-note-content. The body comparison and delete happen in one AppleScript, so a newer edit is preserved. Refuses a note already in Recently Deleted, where a delete would be permanent. Optional ifFolderId, ifAncestorFolderId, and forbiddenAncestorFolderIds are re-checked inside that AppleScript too. Copy-then-retire: pass guardNoteId and expectedGuardContentHash (the verified copy's contentHash) to delete only while the copy still has that revision, is unlocked, is outside Recently Deleted, and is not a Quick Note; requireActiveNoteId requires the same of a second note without fingerprinting it. The guard needs Full Disk Access to rule out a Quick Note. The copy's body, lock state, and folder are checked again inside the delete AppleScript, but the pair is not one transaction.",
    inputSchema: {
      id: noteIdInput,
      expectedContentHash: expectedContentHashInput,
      guardNoteId: noteIdInput
        .optional()
        .describe(
          "A second note (usually the verified copy) that must still match expectedGuardContentHash, be unlocked, stay outside Recently Deleted, and not be a Quick Note. Needs Full Disk Access"
        ),
      expectedGuardContentHash: expectedContentHashInput
        .optional()
        .describe("get-note-content contentHash of guardNoteId; required with guardNoteId"),
      requireActiveNoteId: noteIdInput
        .optional()
        .describe(
          "A second note that must still exist, be unlocked, stay outside Recently Deleted, and not be a Quick Note. Its content is not fingerprinted. Needs Full Disk Access"
        ),
      timeoutSeconds: timeoutSecondsInput,
      ...scopeGuardInputs,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      wasShared: z.boolean().optional(),
      previousContentHash: z.string().optional(),
      guardNoteId: z.string().optional(),
      guardContentHash: z.string().optional(),
      requireActiveNoteId: z.string().optional(),
    },
  },
  withErrorHandling(
    ({
      id,
      expectedContentHash,
      guardNoteId,
      expectedGuardContentHash,
      requireActiveNoteId,
      ...scopeArgs
    }) => {
      // Guard notes are checked first, so the delete note's revision read is the
      // last step before the delete script.
      const prepared = prepareDeleteGuards({
        id,
        guardNoteId,
        expectedGuardContentHash,
        requireActiveNoteId,
      });
      if ("error" in prepared) return errorResponse(prepared.error);

      const snapshot = readExactNoteSnapshot(id);
      if ("error" in snapshot) return errorResponse(snapshot.error);
      if (snapshot.contentHash !== expectedContentHash) {
        return errorResponse(revisionConflictMessage(snapshot.note.title));
      }

      const result = notesManager.deleteNoteByIdIfUnchanged(
        id,
        snapshot.body,
        scopeFrom(scopeArgs),
        prepared.guards
      );
      if (result.status === "guard-conflict") {
        return errorResponse(
          `${prepared.labels[result.index]} note changed just before the delete. Nothing was deleted; verify it again before retrying.`
        );
      }
      if (result.status === "guard-inactive") {
        return errorResponse(
          `${prepared.labels[result.index]} note is no longer active (${result.reason}). Nothing was deleted.`
        );
      }
      if (result.status === "conflict") {
        return errorResponse(revisionConflictMessage(snapshot.note.title));
      }
      if (result.status === "scope_conflict") {
        return errorResponse(scopeConflictMessage(result.reason));
      }
      if (result.status === "in-recently-deleted") {
        return errorResponse(inRecentlyDeletedMessage(snapshot.note.title));
      }
      if (result.status === "container-unknown") {
        return errorResponse(containerUnknownMessage(snapshot.note.title));
      }
      if (result.status === "not-deleted") {
        return errorResponse(NOT_DELETED_MESSAGE);
      }
      if (result.status !== "deleted") {
        return errorResponse(
          `The delete result for note "${snapshot.note.title}" is uncertain. Inspect exact ID ${id} before retrying.`
        );
      }

      const sharedWarning = snapshot.note.shared
        ? "\n\n⚠️ This note was shared with collaborators. They will no longer have access."
        : "";
      return successResponse(
        `Note moved to Recently Deleted: "${snapshot.note.title}"${sharedWarning}`,
        {
          ok: true,
          id,
          title: snapshot.note.title,
          wasShared: snapshot.note.shared ?? false,
          previousContentHash: expectedContentHash,
          ...(guardNoteId ? { guardNoteId, guardContentHash: prepared.guardContentHash } : {}),
          ...(requireActiveNoteId ? { requireActiveNoteId } : {}),
        }
      );
    },
    "Error deleting note"
  )
);

// --- move-note ---

registerTool(
  "move-note",
  {
    description:
      "Use when: moving one exact note to a different folder by id.\nReturns: confirmation and exact-ID readback.\nDo not use when: you only have a title or want to move many notes (batch-move-notes).\nNote: Notes.app's native move preserves the note id, creation date, body, and attachments. The destination folder must already exist. Optional ifFolderId, ifAncestorFolderId, and forbiddenAncestorFolderIds (which also covers the destination) are re-checked inside the move AppleScript.",
    inputSchema: {
      id: noteIdInput,
      folder: z.string().min(1, "Destination folder is required").max(MAX.FOLDER),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note/folder"),
      timeoutSeconds: timeoutSecondsInput,
      ...scopeGuardInputs,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      folder: z.string().optional(),
      verified: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, folder, account, ...scopeArgs }) => {
    const note = notesManager.getNoteById(id);
    if (!note) {
      return errorResponse(`Note with ID "${id}" not found`);
    }
    const success = notesManager.moveNoteById(id, folder, account, scopeFrom(scopeArgs));
    if (!success) {
      return errorResponse(
        `Failed to move note "${note.title}" to folder "${folder}". Folder may not exist.`
      );
    }
    const readback = notesManager.getNoteById(id);
    if (!readback || readback.id !== id) {
      return errorResponse(
        `The move may have succeeded, but exact-ID readback failed. Inspect note ID ${id} before retrying.`
      );
    }
    return successResponse(`Note moved and verified: "${readback.title}" -> "${folder}"`, {
      ok: true,
      id,
      title: readback.title,
      folder,
      verified: true,
    });
  }, "Error moving note")
);

// --- list-notes ---

registerTool(
  "list-notes",
  {
    description:
      "Use when: enumerating notes in an account or folder; supports modifiedSince and limit for large collections.\nReturns: each note's title and id (ids are safe to use for follow-up reads/edits even when titles are duplicated — see search-notes for keyword-based lookup instead).\nDo not use when: you need content (get-note-content), or date order, incremental sync cursors, or word counts (list-recent-notes).\nNote: excludes notes in Recently Deleted unless includeRecentlyDeleted is true, which flags them inRecentlyDeleted. Warns if iCloud sync is active and results may be partial.",
    inputSchema: {
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account to list notes from"),
      folder: z.string().max(MAX.FOLDER).optional().describe("Filter to specific folder"),
      modifiedSince: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 date string to filter notes modified on or after this date (e.g., '2025-01-01'). Useful for listing only recent notes in large collections."
        ),
      limit: z.number().int().positive().optional().describe("Maximum number of notes to return"),
      includeRecentlyDeleted: z
        .boolean()
        .optional()
        .describe(
          "Also list notes in Recently Deleted, each flagged inRecentlyDeleted (default false)"
        ),
    },
    outputSchema: {
      notes: z
        .array(
          z.object({
            title: z.string(),
            id: z.string(),
            inRecentlyDeleted: z.boolean().optional(),
            identifier: z.string().optional(),
            folderIdentifier: z.string().optional(),
            accountIdentifier: z.string().optional(),
          })
        )
        .optional(),
      count: z.number().optional(),
      excludedRecentlyDeleted: z.number().optional(),
    },
  },
  withErrorHandling(({ account, folder, modifiedSince, limit, includeRecentlyDeleted }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: { refs: notes, excludedRecentlyDeleted },
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("list-notes", () =>
      notesManager.listNoteRefsDetailed(
        account,
        folder,
        modifiedSince,
        limit,
        includeRecentlyDeleted ?? false
      )
    );

    // Build context string for the response
    const location = folder ? ` in folder "${folder}"` : "";
    const acct = account ? ` (${account})` : "";
    const dateInfo = modifiedSince ? ` modified since ${modifiedSince}` : "";
    const limitInfo = limit ? ` (limit: ${limit})` : "";

    // Build sync warning if needed
    const syncWarnings: string[] = [];
    if (syncBefore.syncDetected) {
      syncWarnings.push(`⚠️ iCloud sync was active.`);
    }
    if (syncInterference) {
      syncWarnings.push(`Results may be incomplete.`);
    }
    const syncNote = syncWarnings.length > 0 ? `\n\n${syncWarnings.join(" ")}` : "";
    const trashNote =
      excludedRecentlyDeleted > 0
        ? `\n\nSkipped ${excludedRecentlyDeleted} note(s) in Recently Deleted; pass includeRecentlyDeleted: true to list them.`
        : "";
    const trashData = excludedRecentlyDeleted > 0 ? { excludedRecentlyDeleted } : {};

    if (notes.length === 0) {
      return successResponse(`No notes found${location}${acct}${dateInfo}${trashNote}${syncNote}`, {
        notes: [],
        count: 0,
        ...trashData,
      });
    }

    const noteList = notes
      .map((n) => `  - ${n.title}${n.inRecentlyDeleted ? " [RECENTLY DELETED]" : ""} [id: ${n.id}]`)
      .join("\n");
    return successResponse(
      `Found ${notes.length} notes${location}${acct}${dateInfo}${limitInfo}:\n${noteList}${trashNote}${syncNote}`,
      { notes: withStableIdentifiers(notes, "ICNote"), count: notes.length, ...trashData }
    );
  }, "Error listing notes")
);

// --- get-selected-notes ---

registerTool(
  "get-selected-notes",
  {
    description:
      "Use when: the user asks what note(s) are currently selected in Notes.app.\nReturns: selected note metadata with ids for follow-up operations.\nDo not use when: searching all notes (search-notes) or listing a folder (list-notes).\nNote: reads Notes.app UI selection; it may be empty if Notes is closed or no note is selected.",
    inputSchema: {},
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(() => {
    const notes = notesManager.getSelectedNotes();
    if (notes.length === 0) {
      return successResponse("No notes are currently selected in Notes.app", {
        notes: [],
        count: 0,
      });
    }

    const noteList = notes.map((n) => `  - ${n.title} [id: ${n.id}]`).join("\n");
    return successResponse(`Selected note(s):\n${noteList}`, {
      notes: withStableIdentifiers(notes, "ICNote"),
      count: notes.length,
    });
  }, "Error getting selected notes")
);

// =============================================================================
// Folder Tools
// =============================================================================

// --- list-folders ---

registerTool(
  "list-folders",
  {
    description:
      "Use when: listing all folders, with full nested paths, for an account.\nReturns: folder names/paths.\nDo not use when: listing notes (list-notes).\nNote: warns if iCloud sync is active.",
    inputSchema: {
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account to list folders from"),
    },
    outputSchema: {
      folders: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ account }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: folders,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("list-folders", () => notesManager.listFolders(account));
    const acct = account ? ` (${account})` : "";

    // Build sync warning if needed
    const syncWarnings: string[] = [];
    if (syncBefore.syncDetected) {
      syncWarnings.push(`⚠️ iCloud sync was active.`);
    }
    if (syncInterference) {
      syncWarnings.push(`Results may be incomplete.`);
    }
    const syncNote = syncWarnings.length > 0 ? `\n\n${syncWarnings.join(" ")}` : "";

    if (folders.length === 0) {
      return successResponse(`No folders found${acct}${syncNote}`, { folders: [], count: 0 });
    }

    // Label with the account name Notes.app actually resolved to, not the one
    // that was asked for — a unique prefix like "robert" resolves to the full
    // "robert.b.sweet@gmail.com", and echoing the request would hide that (#128).
    const resolvedAcct = folders[0]?.account ? ` (${folders[0].account})` : acct;
    const folderList = folders.map((f) => `  - ${f.name}`).join("\n");
    return successResponse(
      `Found ${folders.length} folders${resolvedAcct}:\n${folderList}${syncNote}`,
      {
        folders: withStableIdentifiers(folders, "ICFolder"),
        count: folders.length,
      }
    );
  }, "Error listing folders")
);

// --- list-smart-folders ---

registerTool(
  "list-smart-folders",
  {
    description:
      'Use when: listing Smart Folders and the rules that define them.\nReturns: each smart folder\'s name, ids, account, and parent, its rules decoded as match ("all"/"any"/"none") plus filters (each with a readable description), the stored query with the outer deleted wrapper removed, and the raw stored query JSON. With includeMatchingNotes, also the notes Notes.app currently shows in each folder.\nDo not use when: listing ordinary folders (list-folders) or searching notes (search-notes).\nSafety: read-only; reads the NoteStore database and requires Full Disk Access. includeMatchingNotes asks Notes.app (Automation permission) for each folder\'s current contents rather than re-evaluating the rules. Unrecognized rules are kept as "unknown" filters and set fullyDecoded false.',
    inputSchema: {
      includeMatchingNotes: z
        .boolean()
        .optional()
        .describe(
          "Also list the notes Notes.app currently shows in each smart folder (default false)"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum matching notes returned per folder (default 50; count is always total)"),
    },
    outputSchema: {
      smartFolders: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      fullyDecoded: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ includeMatchingNotes = false, limit }) => {
    const folders = notesManager.listSmartFolders({ includeMatchingNotes, limit });
    const fullyDecoded = folders.every((folder) => folder.fullyDecoded);
    if (folders.length === 0) {
      return successResponse("No smart folders found.", {
        smartFolders: [],
        count: 0,
        fullyDecoded,
      });
    }
    const lines = folders.map((folder) => {
      const joiner = folder.match === "any" ? " OR " : " AND ";
      const rules = folder.filters.map((filter) => filter.description).join(joiner);
      const prefix = folder.match === "none" ? "none of: " : "";
      const where = [folder.account, folder.parent].filter(Boolean).join(" / ");
      const matches =
        folder.matchingNoteCount !== undefined
          ? ` [${folder.matchingNoteCount} note(s)]`
          : folder.matchingNotesError
            ? ` [notes unavailable: ${folder.matchingNotesError}]`
            : "";
      return `  - ${folder.name ?? "(untitled)"}${where ? ` (${where})` : ""}: ${prefix}${rules || "(no rules)"}${matches}`;
    });
    return successResponse(
      `Found ${folders.length} smart folder(s):\n${lines.join("\n")}${
        fullyDecoded ? "" : '\n\nSome rules were not recognized; see filters of type "unknown".'
      }`,
      {
        smartFolders: folders as unknown as Array<Record<string, unknown>>,
        count: folders.length,
        fullyDecoded,
      }
    );
  }, "Error listing smart folders")
);

// --- create-folder ---

registerTool(
  "create-folder",
  {
    description:
      "Use when: creating a folder, including nested paths like 'Work/Clients' (intermediate folders are created, existing ones skipped).\nReturns: confirmation.\nDo not use when: creating a note (create-note).",
    inputSchema: {
      name: z
        .string()
        .min(1, "Folder name is required")
        .max(MAX.FOLDER)
        .describe(
          'Folder name or nested path separated by "/". E.g., "Retro Tech/PC/CPUs" creates all intermediate folders. Existing segments are skipped.'
        ),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account name (defaults to Notes.app's default account; exact or unique-prefix match)"
        ),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      folder: z.string().optional(),
    },
  },
  withErrorHandling(({ name, account }) => {
    const folder = notesManager.createFolder(name, account);

    if (!folder) {
      return errorResponse(`Failed to create folder "${name}".`);
    }

    return successResponse(`Folder created: "${folder.name}"`, {
      ok: true,
      folder: folder.name,
    });
  }, "Error creating folder")
);

// --- delete-folder ---

registerTool(
  "delete-folder",
  {
    description:
      "Use when: deleting an existing folder by name or nested path.\nReturns: confirmation.\nDo not use when: deleting a note (delete-note).\nSafety: requires explicit user confirmation. Deletion fails if the folder still contains notes — list or move those notes first.",
    inputSchema: folderNameSchema,
    outputSchema: {
      ok: z.boolean().optional(),
      folder: z.string().optional(),
    },
  },
  withErrorHandling(({ name, account }) => {
    const success = notesManager.deleteFolder(name, account);

    if (!success) {
      return errorResponse(
        `Failed to delete folder "${name}". Folder may not exist or may contain notes.`
      );
    }

    return successResponse(`Folder deleted: "${name}"`, { ok: true, folder: name });
  }, "Error deleting folder")
);

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

registerTool(
  "list-accounts",
  {
    description:
      "Use when: discovering which Notes accounts exist (iCloud, Gmail, Exchange, etc.) before targeting one.\nReturns: account names.\nDo not use when: you already know the account, or are working by note id (ids are account-independent).",
    inputSchema: {},
    outputSchema: {
      accounts: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(() => {
    const accounts = notesManager.listAccounts();

    if (accounts.length === 0) {
      return successResponse("No Notes accounts found", { accounts: [], count: 0 });
    }

    const accountList = accounts
      .map((a) => {
        const defaultFolder = a.defaultFolder ? ` (default folder: ${a.defaultFolder})` : "";
        const upgraded = a.upgraded === undefined ? "" : `, upgraded: ${a.upgraded ? "yes" : "no"}`;
        return `  - ${a.name}${defaultFolder}${upgraded}`;
      })
      .join("\n");
    return successResponse(`Found ${accounts.length} accounts:\n${accountList}`, {
      accounts: withStableIdentifiers(accounts, "ICAccount"),
      count: accounts.length,
    });
  }, "Error listing accounts")
);

// --- get-default-location ---

registerTool(
  "get-default-location",
  {
    description:
      "Use when: discovering where Notes.app will create new notes by default.\nReturns: default account and default folder metadata.\nDo not use when: you already have an explicit account/folder target.",
    inputSchema: {},
    outputSchema: {
      account: z.object({}).passthrough().optional(),
      folder: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(() => {
    const location = notesManager.getDefaultLocation();
    const message =
      `Default account: ${location.account.name} [id: ${location.account.id}]\n` +
      `Default folder: ${location.folder.name} [id: ${location.folder.id}]`;
    const [account] = withStableIdentifiers([location.account], "ICAccount");
    const [folder] = withStableIdentifiers([location.folder], "ICFolder");
    return successResponse(message, { account, folder });
  }, "Error getting default Notes location")
);

// =============================================================================
// Collaboration Tools
// =============================================================================

// --- list-shared-notes ---

registerTool(
  "list-shared-notes",
  {
    description:
      "Use when: finding notes shared with collaborators.\nReturns: shared notes with title, account, and id.\nDo not use when: searching all notes (search-notes).\nNote: edits or deletes to these notes affect all collaborators.",
    inputSchema: {},
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(() => {
    const sharedNotes = notesManager.listSharedNotes();

    if (sharedNotes.length === 0) {
      return successResponse(
        "No shared notes found. You have no notes shared with collaborators.",
        { notes: [], count: 0 }
      );
    }

    const noteList = sharedNotes
      .map((n) => {
        const accountInfo = n.account ? ` (${n.account})` : "";
        return `  - ${n.title}${accountInfo} [id: ${n.id}]`;
      })
      .join("\n");

    return successResponse(
      `Found ${sharedNotes.length} shared note(s):\n${noteList}\n\n` +
        `⚠️ Changes to shared notes are visible to all collaborators.`,
      { notes: withStableIdentifiers(sharedNotes, "ICNote"), count: sharedNotes.length }
    );
  }, "Error listing shared notes")
);

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- get-sync-status ---

registerTool(
  "get-sync-status",
  {
    description:
      "Use when: checking whether iCloud sync is in progress before trusting read results.\nReturns: sync active/idle, pending upload count, and seconds since last change.\nDo not use when: you need note data — this is a read-only diagnostics tool.",
    inputSchema: {},
    outputSchema: {
      syncDetected: z.boolean().optional(),
      pendingUpload: z.number().optional(),
      secondsSinceLastChange: z.number().optional(),
      recentActivity: z.boolean().optional(),
      warning: z.string().optional(),
      error: z.string().optional(),
    },
  },
  withErrorHandling(() => {
    const status = getSyncStatus();

    if (status.error) {
      return successResponse(`⚠️ Sync status unknown: ${status.error}`, { ...status });
    }

    const lines: string[] = [];

    if (status.syncDetected) {
      lines.push("🔄 iCloud Sync: ACTIVE");
      lines.push("");
      if (status.pendingUpload > 0) {
        lines.push(`  • ${status.pendingUpload} item(s) pending upload`);
      }
      if (status.recentActivity) {
        lines.push(`  • Database modified ${status.secondsSinceLastChange}s ago`);
      }
      lines.push("");
      lines.push("⚠️ Note: Operations may return incomplete results during sync.");
    } else {
      lines.push("✓ iCloud Sync: Idle");
      lines.push("");
      lines.push(`  Last activity: ${status.secondsSinceLastChange}s ago`);
    }

    return successResponse(lines.join("\n"), { ...status });
  }, "Error checking sync status")
);

// --- health-check ---

registerTool(
  "health-check",
  {
    description:
      "Use when: a quick check that Notes.app is reachable and (optionally) Full Disk Access is granted for checklist features.\nReturns: pass/fail per check.\nDo not use when: you need detailed, actionable setup diagnostics (use doctor).\nRead-only.",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(z.object({}).passthrough()).optional(),
      fullDiskAccess: z.boolean().optional(),
    },
  },
  withErrorHandling(() => {
    const result = notesManager.healthCheck();

    const statusIcon = result.healthy ? "✓" : "✗";
    const statusText = result.healthy ? "All checks passed" : "Issues detected";

    const checkLines = result.checks
      .map((c) => {
        const icon = c.passed ? "✓" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      })
      .join("\n");

    // Check Full Disk Access — needed by every tool that reads NoteStore.sqlite.
    const fdaAvailable = hasFullDiskAccess();
    const fdaLine = fdaAvailable
      ? "  ✓ full_disk_access: Granted (Notes database readable — checklist state, note metadata, note links, sync detail)"
      : "  ⓘ full_disk_access: Not granted — get-checklist-state, get-note-metadata, and the checklist annotations in " +
        "get-note-markdown won't work; get-note-link fails on macOS 26+ (macOS 12-15 falls back to AppleScript); " +
        "get-sync-status cannot see pending uploads. The rest of the server is pure AppleScript and is unaffected. " +
        fdaRemediation();

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}\n${fdaLine}`, {
      healthy: result.healthy,
      checks: result.checks,
      fullDiskAccess: fdaAvailable,
    });
  }, "Error running health check")
);

// --- doctor ---

registerTool(
  "doctor",
  {
    description:
      "Use when: diagnosing setup problems (Notes.app automation permission, account state, Full Disk Access) with actionable guidance.\nReturns: a detailed report plus structured fields, including runtimeOS and the same OS-version-aware features matrix as get-capabilities.\nDo not use when: you just need a quick pass/fail (health-check).\nRead-only.",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(z.object({}).passthrough()).optional(),
      runtimeOS: z.object({}).passthrough().optional(),
      features: z.record(z.string(), z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(() => {
    // Richer than health-check: Notes.app permission, account state, and Full
    // Disk Access with actionable messages + structuredContent (#22).
    const report = runDoctor(notesManager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "Error running doctor")
);

// --- get-notes-stats ---

registerTool(
  "get-notes-stats",
  {
    description:
      "Use when: summarizing the library — total notes, per-account/folder counts, and recent activity.\nReturns: aggregate statistics; flags partial coverage when some scopes were unreadable.\nDo not use when: you need individual notes (list-notes/search-notes).\nRead-only.",
    inputSchema: {},
    outputSchema: {
      totalNotes: z.number().optional(),
      accounts: z.array(z.object({}).passthrough()).optional(),
      recentlyModified: z.object({}).passthrough().optional(),
      coverage: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(() => {
    const stats = notesManager.getNotesStats();

    // Format the output
    const lines: string[] = [];
    lines.push(`📊 Notes Statistics`);
    lines.push(`═══════════════════`);
    lines.push(`Total notes: ${stats.totalNotes}`);
    lines.push(``);

    // Per-account breakdown
    lines.push(`📁 By Account:`);
    for (const account of stats.accounts) {
      lines.push(`  ${account.name}: ${account.totalNotes} notes, ${account.folderCount} folders`);
      for (const folder of account.folders) {
        if (folder.noteCount > 0) {
          lines.push(`    - ${folder.name}: ${folder.noteCount}`);
        }
      }
    }
    lines.push(``);

    // Recently modified
    lines.push(`📅 Recently Modified:`);
    lines.push(`  Last 24 hours: ${stats.recentlyModified.last24h}`);
    lines.push(`  Last 7 days: ${stats.recentlyModified.last7d}`);
    lines.push(`  Last 30 days: ${stats.recentlyModified.last30d}`);

    // Partial-coverage diagnostics (#19): if some scopes couldn't be read, say so
    // explicitly so the numbers above aren't mistaken for a complete picture.
    if (!stats.coverage.complete) {
      lines.push(``);
      lines.push(
        `⚠️  Partial results: read ${stats.coverage.covered}/${stats.coverage.scanned} scopes. Counts above exclude:`
      );
      for (const w of stats.coverage.warnings) {
        lines.push(`  - ${w.scope}: ${w.reason}`);
      }
    }

    return successResponse(lines.join("\n"), { ...stats });
  }, "Error getting notes statistics")
);

// --- list-attachments ---

/** Public view of one attachment's discovered files (ids in the AppleScript format). */
function attachmentAssetView(noteId: string, record: AttachmentAssetRecord) {
  return {
    attachmentId: attachmentCoreDataId(noteId, record.pk),
    identifier: record.identifier,
    uti: record.uti,
    kind: record.kind,
    parentIdentifier: record.parentIdentifier,
    bodyIndex: record.bodyIndex,
    assetPaths: record.assetPaths,
    previewPath: record.previewPath,
    paths: record.paths,
  };
}

/** Public view of the lead visual. */
function firstImageView(noteId: string, first: FirstImage | null) {
  if (!first) return null;
  const { pk, ...rest } = first;
  return { attachmentId: attachmentCoreDataId(noteId, pk), ...rest };
}

registerTool(
  "list-attachments",
  {
    description:
      "Use when: listing the attachments of one note, by id (preferred) or title. With includePaths, also where each attachment's files are on disk; with firstImage, only the note's lead visual.\nReturns: each attachment's name, content type, and id (use with save-attachment/fetch-attachment). includePaths adds identifier, uti, kind, bodyIndex, assetPaths (the attachment's own files), previewPath (Notes' largest rendered thumbnail, always an image file), and paths. firstImage returns {firstImage, orderSource}: the first image in body order even when its asset has not downloaded (path null), else the first scan or drawing, else null.\nDo not use when: you want the attachment bytes (fetch-attachment) or files on disk (save-attachment, export-attachments).\nNote: includePaths and firstImage need the note id and Full Disk Access; they read NoteStore and the Notes data folder read-only. Treat the returned paths as local data: copy files out with export-attachments rather than handing raw paths on.",
    inputSchema: {
      id: looseNoteId(z.string())
        .optional()
        .describe(`Note ID (preferred - more reliable than title): ${NOTE_ID_FORMS}`),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note (ignored if id is provided)"),
      includePaths: z
        .boolean()
        .optional()
        .describe(
          "Add on-disk assetPaths, previewPath, and paths to each attachment (requires id and Full Disk Access)"
        ),
      firstImage: z
        .boolean()
        .optional()
        .describe(
          "Return only the note's lead visual in body order instead of the list (requires id and Full Disk Access)"
        ),
    },
    outputSchema: {
      attachments: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      firstImage: z.object({}).passthrough().nullable().optional(),
      orderSource: z.enum(["body", "creation"]).optional(),
      pathsError: z.string().optional(),
    },
  },
  withErrorHandling(({ id, title, account, includePaths = false, firstImage = false }) => {
    if ((includePaths || firstImage) && !id) {
      return errorResponse("includePaths and firstImage require the note 'id'");
    }
    if (firstImage && id) {
      const assets = notesManager.getAttachmentAssetsById(id);
      const first = firstImageView(id, selectFirstImage(assets));
      const text = first
        ? `Lead visual: ${first.kind} attachment ${first.attachmentId} (${first.path ? "asset on disk" : first.previewPath ? "preview only" : "not downloaded"}; order from ${assets.orderSource}).`
        : "This note has no image, scan, or drawing attachment.";
      return successResponse(text, { firstImage: first, orderSource: assets.orderSource });
    }

    // Prefer ID-based lookup if provided
    if (id) {
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      const attachments = notesManager.listAttachmentsById(id);
      if (attachments.length === 0) {
        return successResponse(`Note "${note.title}" has no attachments`, {
          attachments: [],
          count: 0,
        });
      }
      const attachmentList = attachments.map((a) => `  - ${a.name} (${a.contentType})`).join("\n");
      if (!includePaths) {
        return successResponse(
          `Found ${attachments.length} attachment(s) in "${note.title}":\n${attachmentList}`,
          { attachments, count: attachments.length }
        );
      }
      let assets: NoteAttachmentAssets;
      try {
        assets = notesManager.getAttachmentAssetsById(id);
      } catch (error) {
        const pathsError = error instanceof Error ? error.message : String(error);
        return successResponse(
          `Found ${attachments.length} attachment(s) in "${note.title}" (paths unavailable: ${pathsError}):\n${attachmentList}`,
          { attachments, count: attachments.length, pathsError }
        );
      }
      const byPk = new Map(assets.attachments.map((r) => [r.pk, r]));
      let onDisk = 0;
      const enriched = attachments.map((a) => {
        const pk = Number(/\/ICAttachment\/p(\d+)$/.exec(a.id)?.[1]);
        const record = byPk.get(pk);
        if (!record) return a;
        if (record.paths.length > 0) onDisk++;
        const children = assets.attachments
          .filter((c) => c.parentIdentifier === record.identifier)
          .map((c) => attachmentAssetView(id, c));
        return {
          ...a,
          ...attachmentAssetView(id, record),
          ...(children.length ? { children } : {}),
        };
      });
      return successResponse(
        `Found ${attachments.length} attachment(s) in "${note.title}" (${onDisk} with files on disk; order from ${assets.orderSource}):\n${attachmentList}`,
        { attachments: enriched, count: attachments.length, orderSource: assets.orderSource }
      );
    }

    // Fall back to title-based lookup
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(
        `Note "${title}" not found. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }

    const attachments = notesManager.listAttachments(title, account);
    if (attachments.length === 0) {
      return successResponse(`Note "${title}" has no attachments`, { attachments: [], count: 0 });
    }

    const attachmentList = attachments.map((a) => `  - ${a.name} (${a.contentType})`).join("\n");
    return successResponse(
      `Found ${attachments.length} attachment(s) in "${title}":\n${attachmentList}`,
      { attachments, count: attachments.length }
    );
  }, "Error listing attachments")
);

// --- batch-delete-notes ---

registerTool(
  "batch-delete-notes",
  {
    description:
      "Use when: moving several reviewed notes to Recently Deleted.\nReturns: per-note success or conflict.\nDo not use when: deleting a single note.\nSafety: every entry requires an exact id and the content hash from get-note-content. Any note changed since review is preserved and reported as a conflict. A note already in Recently Deleted is refused, since deleting it there would be permanent.",
    inputSchema: {
      notes: z
        .array(
          z.object({
            id: noteIdInput,
            expectedContentHash: expectedContentHashInput,
          })
        )
        .max(MAX.BATCH_IDS)
        .describe(`Reviewed note IDs and revision tokens to delete (max ${MAX.BATCH_IDS})`),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      succeeded: z.number().optional(),
      failed: z.number().optional(),
      results: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(({ notes }) => {
    if (notes.length === 0) {
      return errorResponse("No reviewed notes provided");
    }

    // Guard each note independently. The manager performs the decisive body
    // comparison and delete atomically for each exact ID.
    const results = notes.map(({ id, expectedContentHash }) => {
      const snapshot = readExactNoteSnapshot(id);
      if ("error" in snapshot) return { id, success: false, error: snapshot.error };
      if (snapshot.contentHash !== expectedContentHash) {
        return { id, success: false, error: revisionConflictMessage(snapshot.note.title) };
      }
      const result = notesManager.deleteNoteByIdIfUnchanged(id, snapshot.body);
      if (result.status === "deleted") return { id, success: true };
      if (result.status === "conflict") {
        return { id, success: false, error: revisionConflictMessage(snapshot.note.title) };
      }
      if (result.status === "in-recently-deleted") {
        return { id, success: false, error: inRecentlyDeletedMessage(snapshot.note.title) };
      }
      if (result.status === "container-unknown") {
        return { id, success: false, error: containerUnknownMessage(snapshot.note.title) };
      }
      if (result.status === "not-deleted")
        return { id, success: false, error: NOT_DELETED_MESSAGE };
      return { id, success: false, error: "Delete result uncertain; inspect this exact ID" };
    });
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    const lines: string[] = [`Batch delete: ${succeeded} succeeded, ${failed} failed`];

    if (failed > 0) {
      lines.push("\nFailures:");
      for (const result of results.filter((r) => !r.success)) {
        lines.push(`  - ${result.id}: ${result.error}`);
      }
    }

    return succeeded > 0
      ? successResponse(lines.join("\n"), {
          ok: failed === 0,
          succeeded,
          failed,
          results,
        })
      : errorResponse(lines.join("\n"));
  }, "Error performing batch delete")
);

// --- batch-move-notes ---

registerTool(
  "batch-move-notes",
  {
    description:
      "Use when: moving multiple notes by id into one destination folder.\nReturns: per-id success/failure counts after destination-folder verification.\nDo not use when: moving a single note (move-note).\nSafety: each moved note's actual container ID is compared with the destination folder ID before success is reported. The destination folder must already exist (create-folder).",
    inputSchema: {
      ids: noteIdArrayInput.describe(
        `Array of note IDs to move (max ${MAX.BATCH_IDS} per request)`
      ),
      folder: z
        .string()
        .max(MAX.FOLDER)
        .describe(
          'Destination folder name or nested path (e.g. "Work/Clients"). Must already exist — create-folder first.'
        ),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe(
          "Account containing the destination folder (defaults to Notes.app's default account; exact or unique-prefix match)"
        ),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      folder: z.string().optional(),
      succeeded: z.number().optional(),
      failed: z.number().optional(),
      results: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(({ ids, folder, account }) => {
    if (ids.length === 0) {
      return errorResponse("No note IDs provided");
    }

    const results = notesManager.batchMoveNotes(ids, folder, account);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    const lines: string[] = [`Batch move to "${folder}": ${succeeded} succeeded, ${failed} failed`];

    if (failed > 0) {
      lines.push("\nFailures:");
      for (const result of results.filter((r) => !r.success)) {
        lines.push(`  - ${result.id}: ${result.error}`);
      }
    }

    return succeeded > 0
      ? successResponse(lines.join("\n"), {
          ok: failed === 0,
          folder,
          succeeded,
          failed,
          results,
        })
      : errorResponse(lines.join("\n"));
  }, "Error performing batch move")
);

// --- save-attachment ---

registerTool(
  "save-attachment",
  {
    description:
      "Use when: writing one note attachment to a file on disk.\nReturns: the saved path.\nDo not use when: you want the bytes in-memory as base64 (fetch-attachment).\nSafety: writes a file; savePath must be absolute and under the home directory, a temp dir, or /Volumes, and not inside the Notes data folder. Get the ids from list-attachments first.",
    inputSchema: {
      noteId: looseNoteId(z.string().min(1, "noteId is required")).describe(
        `Note id (from search/list): ${NOTE_ID_FORMS}`
      ),
      attachmentId: z
        .string()
        .min(1, "attachmentId is required")
        .max(MAX.ATTACHMENT_ID)
        .describe("Attachment id (from list-attachments)"),
      savePath: z
        .string()
        .min(1, "savePath is required")
        .max(MAX.SAVE_PATH)
        .describe(
          "Absolute destination file path (must be under home, temp, or /Volumes; never inside the Notes data folder)"
        ),
    },
    outputSchema: {
      savedPath: z.string().optional(),
      name: z.string().optional(),
      contentType: z.string().optional(),
    },
  },
  withErrorHandling(({ noteId, attachmentId, savePath }) => {
    const r = notesManager.saveAttachmentById(noteId, attachmentId, savePath);
    if (!r.success) {
      return errorResponse(`Failed to save attachment: ${r.error ?? "unknown error"}`);
    }
    return successResponse(`Saved "${r.name ?? "attachment"}" to ${r.savedPath}`, {
      savedPath: r.savedPath,
      name: r.name,
      contentType: r.contentType,
    });
  }, "Error saving attachment")
);

// --- list-paper-attachments / export-paper-image ---

/** Public view of one drawing (AppleScript-format id, no raw pk). */
function drawingView(noteId: string, d: DrawingAttachment) {
  const { pk, raster, ...rest } = d;
  return {
    attachmentId: attachmentCoreDataId(noteId, pk),
    ...rest,
    raster: raster
      ? { source: raster.source, format: raster.format, width: raster.width, height: raster.height }
      : null,
  };
}

registerTool(
  "list-paper-attachments",
  {
    description:
      "Use when: finding the Paper drawings (com.apple.paper) and classic drawings in one note, and whether Notes has a rendered image of each.\nReturns: per drawing its attachmentId, identifier, uti, kind (paper or drawing), handwritingSummary (Notes' recognized handwriting text, or null), bundlePresent, fallbackImagePath, previewPath, and raster {source, format, width, height} (the validated image export-paper-image would copy, or null).\nDo not use when: you want every attachment (list-attachments) or the image file itself (export-paper-image).\nSafety: read-only; reads NoteStore and the Notes data folder without opening Notes.app and requires Full Disk Access. Strokes are not decoded: Notes' Paper bundle has no public reader, so the raster is Notes' own rendering.",
    inputSchema: { id: noteIdInput },
    outputSchema: {
      attachments: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id }) => {
    const drawings = notesManager.listPaperAttachmentsById(id).map((d) => drawingView(id, d));
    if (drawings.length === 0) {
      return successResponse("This note has no Paper or drawing attachments.", {
        attachments: [],
        count: 0,
      });
    }
    const lines = drawings.map(
      (d) =>
        `  - ${d.kind} ${d.attachmentId}: ${d.raster ? `${d.raster.format.toUpperCase()} ${d.raster.width}x${d.raster.height} (${d.raster.source})` : "no rendered image on disk"}${d.handwritingSummary ? "; handwriting text stored" : ""}`
    );
    return successResponse(
      `Found ${drawings.length} Paper or drawing attachment(s):\n${lines.join("\n")}`,
      { attachments: drawings, count: drawings.length }
    );
  }, "Error listing Paper attachments")
);

registerTool(
  "export-paper-image",
  {
    description:
      "Use when: saving Notes' rendered image of a Paper drawing or classic drawing to a file.\nReturns: savedPath, format (png or jpeg), width, height, bytes, source (fallback: Notes' full rendering; preview: its largest thumbnail, used only when no full rendering exists), and the drawing's attachmentId and handwritingSummary.\nDo not use when: the attachment is a photo or file (save-attachment or export-attachments).\nSafety: writes one new file; savePath must be absolute, under the home directory, a temp dir, or /Volumes, outside the Notes data folder, must not exist yet, and must end in the image's extension (.png, or .jpg/.jpeg). The image header is validated before and after copying. Pass attachmentId (from list-paper-attachments) when the note has more than one drawing. Requires Full Disk Access; Notes.app is not opened.",
    inputSchema: {
      noteId: noteIdInput,
      savePath: z
        .string()
        .min(1, "savePath is required")
        .max(MAX.SAVE_PATH)
        .describe(
          "Absolute path for the new image file (.png, or .jpg/.jpeg for a JPEG rendering)"
        ),
      attachmentId: z
        .string()
        .max(MAX.ATTACHMENT_ID)
        .optional()
        .describe(
          "Drawing to export (attachmentId or identifier from list-paper-attachments); required when the note has more than one"
        ),
    },
    outputSchema: {
      savedPath: z.string().optional(),
      format: z.enum(["png", "jpeg"]).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      bytes: z.number().optional(),
      source: z.enum(["fallback", "preview"]).optional(),
      attachmentId: z.string().optional(),
      identifier: z.string().optional(),
      kind: z.enum(["paper", "drawing"]).optional(),
      handwritingSummary: z.string().nullable().optional(),
    },
  },
  withErrorHandling(({ noteId, savePath, attachmentId }) => {
    const r = notesManager.exportPaperImageById(noteId, savePath, attachmentId);
    return successResponse(
      `Saved ${r.format.toUpperCase()} ${r.width}x${r.height} (${r.bytes} bytes, ${r.source === "fallback" ? "Notes' full rendering" : "largest preview"}) to ${r.savedPath}`,
      {
        savedPath: r.savedPath,
        format: r.format,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        source: r.source,
        attachmentId: attachmentCoreDataId(noteId, r.drawing.pk),
        identifier: r.drawing.identifier,
        kind: r.drawing.kind,
        handwritingSummary: r.drawing.handwritingSummary,
      }
    );
  }, "Error exporting Paper image")
);

// --- export-attachments ---

registerTool(
  "export-attachments",
  {
    description:
      'Use when: copying every file attachment of one note (or only its lead visual) into a directory on disk.\nReturns: per attachment its id, kind, exportedTo, and exportedKind: "asset" for the real file, "preview" when the asset never downloaded and only Notes\' rendered thumbnail was available, or null when nothing was on disk.\nDo not use when: exporting one attachment to an exact path (save-attachment) or reading bytes inline (fetch-attachment).\nSafety: writes files; exportDir must be absolute and under the home directory, a temp dir, or /Volumes, and not inside the Notes data folder. Existing files are never replaced: name collisions get -2, -3, ... suffixes. Reads NoteStore and the Notes data folder read-only; requires Full Disk Access. Notes.app is not opened.',
    inputSchema: {
      noteId: noteIdInput,
      exportDir: z
        .string()
        .min(1, "exportDir is required")
        .max(MAX.SAVE_PATH)
        .describe("Absolute destination directory (created if missing; home, temp, or /Volumes)"),
      firstImageOnly: z
        .boolean()
        .optional()
        .describe("Export only the note's lead visual (see list-attachments firstImage)"),
    },
    outputSchema: {
      exportDir: z.string().optional(),
      exported: z.number().optional(),
      previews: z.number().optional(),
      skipped: z.number().optional(),
      failed: z.number().optional(),
      results: z.array(z.object({}).passthrough()).optional(),
      firstImage: z.object({}).passthrough().nullable().optional(),
    },
  },
  withErrorHandling(({ noteId, exportDir, firstImageOnly = false }) => {
    const r = notesManager.exportAttachmentsById(noteId, exportDir, firstImageOnly);
    const results = r.results.map(({ pk, ...rest }) => ({
      attachmentId: attachmentCoreDataId(noteId, pk),
      ...rest,
    }));
    const exported = results.filter((x) => x.exportedKind !== null).length;
    const previews = results.filter((x) => x.exportedKind === "preview").length;
    const failed = results.filter((x) => x.error).length;
    const skipped = results.length - exported - failed;
    const structured: Record<string, unknown> = {
      exportDir: r.exportDir,
      exported,
      previews,
      skipped,
      failed,
      results,
    };
    if (firstImageOnly) {
      structured.firstImage = firstImageView(noteId, r.firstImage ?? null);
      if (!r.firstImage) {
        return successResponse(
          "This note has no image, scan, or drawing attachment; nothing was exported.",
          structured
        );
      }
    }
    return successResponse(
      `Exported ${exported} file(s) to ${r.exportDir} (${previews} preview-only, ${skipped} with nothing on disk, ${failed} failed).`,
      structured
    );
  }, "Error exporting attachments")
);

// --- fetch-attachment ---

registerTool(
  "fetch-attachment",
  {
    description:
      "Use when: retrieving one note attachment's bytes inline as base64 (no file written).\nReturns: name, content type, byte count, and base64 data.\nDo not use when: you want it saved to disk (save-attachment).\nNote: get the ids from list-attachments first.",
    inputSchema: {
      noteId: looseNoteId(z.string().min(1, "noteId is required")).describe(
        `Note id (from search/list): ${NOTE_ID_FORMS}`
      ),
      attachmentId: z
        .string()
        .min(1, "attachmentId is required")
        .max(MAX.ATTACHMENT_ID)
        .describe("Attachment id (from list-attachments)"),
    },
    outputSchema: {
      name: z.string().optional(),
      contentType: z.string().optional(),
      bytes: z.number().optional(),
      base64: z.string().optional(),
    },
  },
  withErrorHandling(({ noteId, attachmentId }) => {
    const r = notesManager.getAttachmentBase64ById(noteId, attachmentId);
    if (!r.success || !r.base64) {
      return errorResponse(`Failed to fetch attachment: ${r.error ?? "unknown error"}`);
    }
    return successResponse(
      `Fetched "${r.name ?? "attachment"}" (${r.contentType ?? "unknown type"}, ${r.bytes ?? 0} bytes) as base64.`,
      { name: r.name, contentType: r.contentType, bytes: r.bytes, base64: r.base64 }
    );
  }, "Error fetching attachment")
);

// --- show-attachment ---

registerTool(
  "show-attachment",
  {
    description:
      "Use when: the user wants to reveal one note attachment in Notes.app.\nReturns: confirmation that Notes.app revealed the attachment.\nDo not use when: you want the bytes (fetch-attachment) or a file on disk (save-attachment).\nNote: this opens or focuses the Notes UI. Get the ids from list-attachments first.",
    inputSchema: {
      noteId: looseNoteId(z.string().min(1, "noteId is required")).describe(
        `Note id (from search/list): ${NOTE_ID_FORMS}`
      ),
      attachmentId: z
        .string()
        .min(1, "attachmentId is required")
        .max(MAX.ATTACHMENT_ID)
        .describe("Attachment id (from list-attachments)"),
      separately: z
        .boolean()
        .optional()
        .describe("Open in a separate window when supported by Notes.app"),
    },
    outputSchema: {
      noteId: z.string().optional(),
      attachmentId: z.string().optional(),
      separately: z.boolean().optional(),
    },
  },
  withErrorHandling(({ noteId, attachmentId, separately = false }) => {
    const success = notesManager.showAttachmentById(noteId, attachmentId, separately);
    if (!success) {
      return errorResponse(`Failed to show attachment "${attachmentId}" on note "${noteId}"`);
    }
    return successResponse(`Shown attachment "${attachmentId}" in Notes.app`, {
      noteId,
      attachmentId,
      separately,
    });
  }, "Error showing attachment")
);

// --- export-notes-json ---

/**
 * Bytes set aside for everything in an export response that is not a note:
 * the account/folder skeleton, summary, page info, and the prose text block.
 */
const EXPORT_RESPONSE_OVERHEAD_BYTES = 64 * 1024;

const formatMegabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

registerTool(
  "export-notes-json",
  {
    description:
      "Use when: exporting notes as structured JSON for backup, migration, or bulk processing.\nReturns: one page of notes (default 50) with metadata, HTML content, and plaintext, grouped by account and folder, plus page info; while page.hasMore is true, call again with offset set to page.nextOffset.\nDo not use when: you need one note (get-note-content) or only titles and ids (list-notes).\nNote: a page stops early to stay under the response size limit (APPLE_NOTES_MCP_EXPORT_MAX_BYTES, default 8 MB), and a note too large on its own comes back with strippedImages or contentOmitted set. Read-only.",
    inputSchema: {
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "0-based position to start from, counting notes in account, folder, note order (default 0). Pass the previous page's page.nextOffset."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe(
          `Maximum notes in this page (default ${DEFAULT_EXPORT_PAGE_SIZE}). A page holds fewer when it reaches the response size limit; lower it if your client caps tool output.`
        ),
      modifiedSince: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 date string; export only notes modified on or after this date (e.g., '2025-01-01'). Keep the same value while paging."
        ),
    },
    outputSchema: {
      exportDate: z.string().optional(),
      version: z.string().optional(),
      accounts: z.array(z.object({}).passthrough()).optional(),
      summary: z.object({}).passthrough().optional(),
      page: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(({ offset, limit, modifiedSince }) => {
    const maxResponseBytes = exportMaxResponseBytes();
    const exportData = notesManager.exportNotesAsJson({
      offset,
      limit,
      modifiedSince,
      maxResponseBytes: Math.max(1, maxResponseBytes - EXPORT_RESPONSE_OVERHEAD_BYTES),
    });
    const { summary, page } = exportData;

    const since = modifiedSince ? ` modified since ${modifiedSince}` : "";
    const lines = [
      `Exported ${summary.totalNotes} of ${page.totalAvailable} notes${since} (offset ${page.offset}, limit ${page.limit}) from ${summary.totalFolders} folders across ${summary.totalAccounts} account(s).`,
    ];
    if (page.hasMore) {
      lines.push(
        `More notes remain: call export-notes-json again with offset ${page.nextOffset}${modifiedSince ? " and the same modifiedSince" : ""}.` +
          (page.stoppedAtSizeLimit
            ? ` This page stopped early to stay under the ${formatMegabytes(maxResponseBytes)} response limit.`
            : "")
      );
    }
    const degraded = exportData.accounts
      .flatMap((a) => a.folders.flatMap((f) => f.notes))
      .filter((n) => n.strippedImages || n.contentOmitted);
    if (degraded.length > 0) {
      lines.push(
        `Too large to return whole, so oversized inline images were replaced (strippedImages) or the body was left out (contentOmitted): ${degraded.map((n) => n.id).join(", ")}. Read these with get-note-content, and their files with list-attachments and save-attachment.`
      );
    }

    const response: ToolResponse = {
      content: [
        {
          type: "text" as const,
          text: `${lines.join("\n")}\n\nFull JSON export:`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(exportData, null, 2),
        },
      ],
      structuredContent: { ...exportData },
    };

    // Last line of defence (#162): the manager budgets notes by an upper-bound
    // estimate, but never hand the transport a message the client would drop
    // the connection over — say so instead.
    const responseBytes = Buffer.byteLength(JSON.stringify(response));
    if (responseBytes > maxResponseBytes) {
      return errorResponse(
        `Error exporting notes: this page is ${formatMegabytes(responseBytes)}, over the ${formatMegabytes(maxResponseBytes)} response limit, so it was not sent. Call export-notes-json again with offset ${page.offset} and a smaller limit (for example ${Math.max(1, Math.floor(page.returned / 2))}), or raise APPLE_NOTES_MCP_EXPORT_MAX_BYTES if your MCP client accepts larger messages.`
      );
    }
    return response;
  }, "Error exporting notes")
);

// --- get-note-markdown ---

registerTool(
  "get-note-markdown",
  {
    description:
      "Use when: reading a note as Markdown, with checklist items annotated [x]/[ ] when Full Disk Access is granted.\nReturns: the note's Markdown.\nDo not use when: you need the raw HTML/plaintext body (get-note-content) or only metadata (get-note-details).\nNote: falls back to plain lists (no checkmarks) without Full Disk Access.",
    inputSchema: {
      id: looseNoteId(z.string())
        .optional()
        .describe(`Note ID (preferred - more reliable than title): ${NOTE_ID_FORMS}`),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note (ignored if id is provided)"),
    },
    outputSchema: {
      markdown: z.string().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
    // Prefer ID-based lookup if provided
    if (id) {
      const markdown = notesManager.getNoteMarkdownById(id);
      if (!markdown) {
        return errorResponse(`Note with ID "${id}" not found or has no content`);
      }
      return successResponse(markdown, { markdown });
    }

    // Fall back to title-based lookup
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const markdown = notesManager.getNoteMarkdown(title, account);
    if (!markdown) {
      return errorResponse(
        `Note "${title}" not found or has no content. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }

    return successResponse(markdown, { markdown });
  }, "Error getting note as markdown")
);

// --- export-notes-markdown ---

const exportPathInput = (what: string) =>
  z
    .string()
    .min(1)
    .max(MAX.SAVE_PATH)
    .optional()
    .describe(
      `${what} (absolute; under home, a temp dir, or /Volumes; never inside the Notes library)`
    );

const exportStatsSchema = z.object({
  attachments: z.number(),
  placed: z.number(),
  placeholders: z.number(),
  unavailable: z.number(),
  tables: z.number(),
  unreadableTables: z.number(),
  unreferenced: z.number(),
});

registerTool(
  "export-notes-markdown",
  {
    description:
      "Use when: exporting one note (by exact id) or a folder's notes as one Markdown document rendered from the decoded note body: headings, bulleted/dashed/numbered lists with indent, checklists with state, block quotes, monospaced blocks, bold/italic/strikethrough/underline/highlight, links, tables, and attachments in body order.\nReturns: the Markdown inline (capped by APPLE_NOTES_MCP_EXPORT_MAX_BYTES), or with outputPath a receipt {format, count, bytes, output}; plus attachment counts and skipped notes (for example password-protected ones).\nDo not use when: you need the legacy HTML-converted Markdown of one note (get-note-markdown) or a restorable backup (export-notes-json). A folder document separates notes with '---' and is a presentation format, not something to import back.\nSafety: read-only against Notes; requires Full Disk Access. outputPath is create-only (an existing file is refused with [output_exists]); assetsDir copies attachment files without replacing existing ones (collisions get -2, -3 suffixes). Without assetsDir, attachments render as labeled placeholders.",
    inputSchema: {
      id: noteIdInput.optional(),
      folder: z
        .string()
        .min(1)
        .max(MAX.FOLDER)
        .optional()
        .describe("Folder path to export instead of one note (nested paths use '/')"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account holding the folder (defaults to Notes.app's default account)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FOLDER_EXPORT_LIMIT)
        .optional()
        .describe(
          `Maximum notes read from the folder (default 100, max ${MAX_FOLDER_EXPORT_LIMIT})`
        ),
      outputPath: exportPathInput("File to create for the Markdown"),
      assetsDir: exportPathInput("Directory that receives copies of attachment files"),
      wrap: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe("Hard-wrap prose at this many columns (0 or omitted: no wrapping)"),
    },
    outputSchema: {
      format: z.string().optional(),
      count: z.number().optional(),
      bytes: z.number().optional(),
      markdown: z.string().optional(),
      output: z.string().optional(),
      assets: z.object({ dir: z.string(), files: z.number() }).optional(),
      stats: exportStatsSchema.optional(),
      skipped: z.array(z.object({ id: z.string(), code: z.string() })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  withErrorHandling((request) => {
    let receipt;
    try {
      receipt = exportNotesMarkdown(request, {
        listNoteRefs: (account, folder, since, limit) =>
          notesManager.listNoteRefs(account, folder, since, limit),
        // The document travels twice (text and structuredContent).
        maxInlineBytes: Math.floor(exportMaxResponseBytes() / 2) - 64 * 1024,
      });
    } catch (error) {
      if (!(error instanceof NotesExportError || error instanceof NoteBlocksError)) throw error;
      const hint =
        error.code === "no-full-disk-access"
          ? ` Grant Full Disk Access to the Node binary running this server (run the doctor tool for its path): ${FULL_DISK_ACCESS_GUIDE_URL}`
          : "";
      return errorResponse(`Error exporting Markdown [${error.code}]: ${error.message}${hint}`);
    }
    const skipped = receipt.skipped.length ? `; skipped ${receipt.skipped.length}` : "";
    if (receipt.output)
      return successResponse(
        `Wrote ${receipt.count} note(s) as Markdown (${receipt.bytes} bytes) to ${receipt.output}` +
          (receipt.assets
            ? `; copied ${receipt.assets.files} asset file(s) to ${receipt.assets.dir}`
            : "") +
          `${skipped}.`,
        { ...receipt }
      );
    return successResponse(receipt.markdown ?? "", { ...receipt });
  }, "Error exporting Markdown")
);

// --- export-notes-html ---

registerTool(
  "export-notes-html",
  {
    description:
      "Use when: exporting one note (by exact id) or a folder's notes as one standalone HTML file rendered from the decoded note body, with semantic tables and images, drawings, scans, audio, files and link cards in body order.\nReturns: a receipt {format, count, bytes, output} plus embedded or sidecar asset counts, attachment counts and skipped notes. The HTML itself is never returned inline.\nDo not use when: you want Markdown (export-notes-markdown) or a restorable backup (export-notes-json). A folder document is a presentation format, not something to import back.\nSafety: read-only against Notes; requires Full Disk Access. outputPath is required and create-only ([output_exists] if it exists). Assets are embedded as data URLs (each up to 10 MiB) unless embedAssets is false, which copies them to a sidecar directory (assetsDir, default <output stem>.assets) with relative URLs and never replaces existing files. No file: URLs or Notes library paths are written; missing assets show a visible unavailable marker.",
    inputSchema: {
      id: noteIdInput.optional(),
      folder: z
        .string()
        .min(1)
        .max(MAX.FOLDER)
        .optional()
        .describe("Folder path to export instead of one note (nested paths use '/')"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account holding the folder (defaults to Notes.app's default account)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FOLDER_EXPORT_LIMIT)
        .optional()
        .describe(
          `Maximum notes read from the folder (default 100, max ${MAX_FOLDER_EXPORT_LIMIT})`
        ),
      outputPath: z
        .string()
        .min(1)
        .max(MAX.SAVE_PATH)
        .describe(
          "HTML file to create (absolute; under home, a temp dir, or /Volumes; never inside the Notes library)"
        ),
      embedAssets: z
        .boolean()
        .optional()
        .describe("Embed assets as data URLs (default true). False writes a sidecar directory"),
      assetsDir: exportPathInput(
        "Sidecar directory when embedAssets is false (default <stem>.assets)"
      ),
    },
    outputSchema: {
      format: z.string().optional(),
      count: z.number().optional(),
      bytes: z.number().optional(),
      output: z.string().optional(),
      assets: z.object({ dir: z.string(), files: z.number() }).optional(),
      embedded: z.number().optional(),
      stats: exportStatsSchema.optional(),
      skipped: z.array(z.object({ id: z.string(), code: z.string() })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  withErrorHandling((request) => {
    let receipt;
    try {
      receipt = exportNotesHtml(request, {
        listNoteRefs: (account, folder, since, limit) =>
          notesManager.listNoteRefs(account, folder, since, limit),
        maxInlineBytes: 0,
      });
    } catch (error) {
      if (!(error instanceof NotesExportError || error instanceof NoteBlocksError)) throw error;
      const hint =
        error.code === "no-full-disk-access"
          ? ` Grant Full Disk Access to the Node binary running this server (run the doctor tool for its path): ${FULL_DISK_ACCESS_GUIDE_URL}`
          : "";
      return errorResponse(`Error exporting HTML [${error.code}]: ${error.message}${hint}`);
    }
    const assets = receipt.assets
      ? `; copied ${receipt.assets.files} asset file(s) to ${receipt.assets.dir}`
      : `; embedded ${receipt.embedded ?? 0} asset(s)`;
    const skipped = receipt.skipped.length ? `; skipped ${receipt.skipped.length}` : "";
    return successResponse(
      `Wrote ${receipt.count} note(s) as HTML (${receipt.bytes} bytes) to ${receipt.output}${assets}${skipped}.`,
      { ...receipt }
    );
  }, "Error exporting HTML")
);

// --- get-checklist-state ---

registerTool(
  "get-checklist-state",
  {
    description:
      "Use when: reading the checked/unchecked state of a note's checklist items, by id.\nReturns: each item's text and done state plus checked/total counts.\nDo not use when: you only have a title (get the id via search-notes first) or want the full body text (get-note-content).\nNote: requires Full Disk Access; reads the NoteStore database directly.",
    inputSchema: {
      id: looseNoteId(
        z.string().min(1, "Note ID is required. Use search-notes to find the note ID first.")
      ).describe(`Note ID: ${NOTE_ID_FORMS}`),
    },
    outputSchema: {
      items: z.array(z.object({}).passthrough()).optional(),
      checked: z.number().optional(),
      total: z.number().optional(),
    },
  },
  withErrorHandling(({ id }) => {
    // Verify the note exists and is accessible
    const note = notesManager.getNoteById(id);
    if (!note) {
      return errorResponse(`Note with ID "${id}" not found`);
    }
    if (note.passwordProtected) {
      return errorResponse(
        `Note "${note.title}" is password-protected and cannot be read. Unlock it in Notes.app first.`
      );
    }

    const result = getChecklistItems(id);
    if (!result.items) {
      return errorResponse(result.message || "Failed to read checklist state.");
    }

    const summary = result.items
      .map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text}`)
      .join("\n");
    const checked = result.items.filter((i) => i.done).length;

    return successResponse(
      `Checklist for "${note.title}" (${checked}/${result.items.length} done):\n${summary}`,
      { items: result.items, checked, total: result.items.length }
    );
  }, "Error reading checklist state")
);

// --- get-audio-transcripts ---

registerTool(
  "get-audio-transcripts",
  {
    description:
      "Use when: reading the transcript (and summary, if any) that Notes already computed for the audio recordings in one note, by id.\nReturns: one entry per top-level audio attachment in body order, with attachmentId, durationSeconds, status (ok, none when no transcript is stored, or undecodable with a reason), joined transcript text, wordCount, speakers and summary when stored, and optional word-level segments.\nDo not use when: you need the audio file itself (save-attachment) or the note body (get-note-content). This tool does not transcribe; it only reads what Notes stored.\nSafety: read-only; requires Full Disk Access and reads the NoteStore database. Password-protected notes are refused. Large responses drop segments first, then shorten text, to stay under APPLE_NOTES_MCP_EXPORT_MAX_BYTES.",
    inputSchema: {
      id: noteIdInput,
      includeSegments: z
        .boolean()
        .optional()
        .describe(
          "Also return word-level segments (text, start and duration in seconds, speaker). Default false."
        ),
      maxSegments: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEGMENTS_LIMIT)
        .optional()
        .describe(
          `Cap on segments returned per attachment when includeSegments is true (default ${DEFAULT_MAX_SEGMENTS}).`
        ),
    },
    outputSchema: {
      id: z.string().optional(),
      attachments: z.array(z.object({}).passthrough()).optional(),
      bodyOrder: z.boolean().optional(),
      truncated: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ id, includeSegments, maxSegments }) => {
    let result: AudioTranscriptsResult;
    try {
      result = notesManager.getAudioTranscripts(id, { includeSegments, maxSegments });
    } catch (error) {
      if (error instanceof AudioTranscriptError) return errorResponse(error.message);
      throw error;
    }
    const toResponse = (r: AudioTranscriptsResult): ToolResponse =>
      successResponse(formatTranscriptsText(r), { ...r });
    const fitted = fitTranscriptsToBudget(result, exportMaxResponseBytes(), (r) =>
      Buffer.byteLength(JSON.stringify(toResponse(r)))
    );
    return toResponse(fitted);
  }, "Error reading audio transcripts")
);

// --- get-note-metadata (BETA) ---

registerTool(
  "get-note-metadata",
  {
    description:
      "[BETA] Use when: reading note metadata AppleScript cannot expose — pinned state, checklist flags, trash/recovery state, preview snippet, password hint — by id.\nReturns: a metadata object; fields vary by macOS version and are omitted when unavailable.\nDo not use when: you need the body (get-note-content) or per-item checklist state (get-checklist-state).\nNote: reads the NoteStore SQLite database read-only and requires Full Disk Access. BETA — the database schema changes between macOS releases, so some fields may be absent. Works on trashed notes that AppleScript can no longer resolve.",
    inputSchema: {
      id: looseNoteId(
        z.string().min(1, "Note ID is required. Use search-notes to find the note ID first.")
      ).describe(`Note ID: ${NOTE_ID_FORMS}`),
    },
    outputSchema: {
      pinned: z.boolean().optional(),
      hasChecklist: z.boolean().optional(),
      hasChecklistInProgress: z.boolean().optional(),
      recoveringFromTrash: z.boolean().optional(),
      passwordProtected: z.boolean().optional(),
      passwordHint: z.string().optional(),
      snippet: z.string().optional(),
      widgetSnippet: z.string().optional(),
      smartFolderQuery: z.string().optional(),
    },
  },
  withErrorHandling(({ id }) => {
    // No AppleScript existence pre-check: reading straight from the database lets
    // this resolve trashed/recovering notes that `note id ...` can no longer find.
    const { metadata, message } = getNoteMetadata(id);
    if (!metadata) {
      return errorResponse(message || `Failed to read metadata for note "${id}"`);
    }

    const keys = Object.keys(metadata);
    const summary =
      keys.length === 0
        ? `No additional metadata is available for note "${id}" on this macOS version.`
        : keys.map((k) => `${k}: ${String((metadata as Record<string, unknown>)[k])}`).join("\n");

    return successResponse(summary, metadata as Record<string, unknown>);
  }, "Error reading note metadata")
);

// --- list-special-notes ---

const SPECIAL_KIND_LABEL: Record<SpecialNoteKind, string> = {
  pinned: "pinned notes",
  "quick-notes": "Quick Notes",
  "recently-deleted": "notes in Recently Deleted",
  locked: "password-protected notes",
};

registerTool(
  "list-special-notes",
  {
    description:
      "Use when: listing pinned notes, Quick Notes, notes in Recently Deleted, or password-protected (locked) notes — sets AppleScript cannot enumerate.\nReturns: metadata rows newest first (id, identifier, title, folder path, account, created, modified, and pinned/locked/quickNote/inRecentlyDeleted flags; snippet except for locked notes; passwordHint for kind locked), plus total before limit. supported is false when this macOS version's database cannot answer that kind.\nDo not use when: you need note content (get-note-content) or a folder listing (list-notes).\nNote: reads the NoteStore SQLite database read-only and requires Full Disk Access. Pinned and Quick Notes listings cover notes in folders outside Recently Deleted; the locked listing includes trashed and folderless locked notes, flagged as such. Never reads locked note bodies.",
    inputSchema: {
      kind: z
        .enum(["pinned", "quick-notes", "recently-deleted", "locked"])
        .describe("Which set of notes to list"),
      account: z
        .string()
        .min(1)
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Only this account (exact or unique-prefix name). Omit for every account."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(SPECIAL_LIMIT.MAX)
        .optional()
        .describe(`Maximum notes to return (default ${SPECIAL_LIMIT.DEFAULT})`),
    },
    outputSchema: {
      kind: z.string().optional(),
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      supported: z.boolean().optional(),
      account: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ kind, account, limit }) => {
    const result = listSpecialNotes({ kind, account, limit });
    const label = SPECIAL_KIND_LABEL[kind];
    const structured = result as unknown as Record<string, unknown>;
    if (!result.supported) {
      return successResponse(
        `This macOS version's Notes database does not record ${label}.`,
        structured
      );
    }
    const scope = result.account ? ` in ${result.account}` : "";
    if (result.count === 0) return successResponse(`No ${label}${scope}.`, structured);
    const lines = result.notes.map(
      (row) =>
        `  - ${row.title ?? "(untitled)"}${row.folder ? ` (${row.folder})` : ""} [id: ${row.id}]`
    );
    const more =
      result.total > result.count
        ? `\n\nShowing ${result.count} of ${result.total}; pass a higher limit to see more.`
        : "";
    return successResponse(
      `Found ${result.total} ${label}${scope}:\n${lines.join("\n")}${more}`,
      structured
    );
  }, "Error listing notes")
);

// --- get-note-drawings (public native helper) ---

registerTool(
  "get-note-drawings",
  {
    description:
      "Use when: reading the strokes of a note's classic PencilKit drawings (com.apple.drawing / com.apple.drawing.2 attachments), by note id, as JSON or SVG.\nReturns: per drawing its attachment id, status (ok/error with a code), stroke count, bounds, and strokes (ink type, sRGB color, width, points) and/or a standalone SVG document; overall status ok/partial/error/none.\nDo not use when: the drawing is a modern Paper sketch (com.apple.paper is not decoded here) or you want the attachment file itself (save-attachment).\nNote: read-only. Needs Full Disk Access and the public native helper built once with `apple-notes-mcp setup --public-helper` (compiled locally with PencilKit; no Notes writes).",
    inputSchema: {
      id: noteIdInput,
      format: z
        .enum(["json", "svg", "both"])
        .optional()
        .describe(
          '"json" (default) returns strokes, "svg" returns SVG documents, "both" returns both'
        ),
      includePoints: z
        .boolean()
        .optional()
        .describe(
          "Include per-point x/y/width/opacity/force in JSON strokes (default true). SVG output always uses the points."
        ),
    },
    outputSchema: {
      id: z.string().optional(),
      drawingCount: z.number().optional(),
      status: z.string().optional(),
      drawings: z.array(z.object({}).passthrough()).optional(),
      pointsOmitted: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, format, includePoints }) => {
    let result = getNoteDrawings(id, { format, includePoints });
    let pointsOmitted = false;
    // Stroke points dominate the payload. Past the response budget, drop them
    // (SVG and stroke summaries stay) rather than fail the whole read.
    if (
      Buffer.byteLength(JSON.stringify(result)) > exportMaxResponseBytes() &&
      includePoints !== false &&
      format !== "svg"
    ) {
      result = getNoteDrawings(id, { format, includePoints: false });
      pointsOmitted = true;
    }
    const text =
      formatNoteDrawings(result) +
      (pointsOmitted
        ? "\nStroke points were omitted to stay under the response size limit (APPLE_NOTES_MCP_EXPORT_MAX_BYTES)."
        : "");
    return successResponse(text, {
      ...result,
      ...(pointsOmitted ? { pointsOmitted } : {}),
    } as unknown as Record<string, unknown>);
  }, "Error reading drawings")
);

// --- list-recent-notes ---

registerTool(
  "list-recent-notes",
  {
    description:
      "Use when: syncing notes incrementally from the Notes database, or listing notes by modification date. Pass since (a modifiedCheckpoint cursor or ISO 8601) to page through changes oldest first; omit it for the newest notes first.\nReturns: metadata rows (id, identifier, title, folder path, account, created, modified, modifiedCheckpoint, pinned, locked, inRecentlyDeleted, markedForDeletion), plus optional wordCount/charCount (wordCounts) and bodyPreview/textDecoded (bodyPreview); order, saturated, and nextSince drive sync.\nDo not use when: you need full content (get-note-content) or keyword search (search-notes).\nNote: read-only NoteStore access; requires Full Disk Access. Sync rule: store nextSince and pass it as the next since; every since call advances, and saturated true means more changes may follow, so call again. For a first full sync start from since 1970-01-01. The cursor can miss edits iCloud delivers later with an older timestamp from another device, and deletions are invisible unless includeDeleted is true.",
    inputSchema: {
      account: z
        .string()
        .min(1)
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Only this account (exact or unique-prefix name). Omit for every account."),
      folder: z
        .string()
        .min(1)
        .max(MAX.FOLDER)
        .optional()
        .describe(
          "Only notes directly in this folder: full path (list-folders syntax) or a unique name"
        ),
      since: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "Return notes after this point, oldest first: a modifiedCheckpoint cursor from a row or nextSince, or an ISO 8601 date (local midnight) or date-time (local unless it has an offset), meaning modified strictly after it"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(RECENT_LIMIT.MAX)
        .optional()
        .describe(`Maximum notes to return (default ${RECENT_LIMIT.DEFAULT})`),
      includeDeleted: z
        .boolean()
        .optional()
        .describe(
          "Also return notes in Recently Deleted, notes awaiting deletion, and folderless notes (default false)"
        ),
      wordCounts: z
        .boolean()
        .optional()
        .describe(
          "Decode each body for wordCount and charCount; null when the body is locked or not available (default false)"
        ),
      bodyPreview: z
        .boolean()
        .optional()
        .describe(
          "Add bodyPreview (180 characters: decoded body with wordCounts, else the stored snippet) and textDecoded"
        ),
    },
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      limit: z.number().optional(),
      order: z.string().optional(),
      saturated: z.boolean().optional(),
      nextSince: z.string().nullable().optional(),
      account: z.string().optional(),
      folder: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling((params) => {
    const result = listRecentNotes(params);
    const syncing = result.order === "oldest-first";
    const scope = [
      result.folder ? ` in folder "${result.folder}"` : "",
      result.account ? ` (${result.account})` : "",
      params.since ? ` modified after ${params.since}` : "",
    ].join("");
    const lines = result.notes.map(
      (row) => `  - ${row.title ?? "(untitled)"} — ${row.modified ?? "no date"} [id: ${row.id}]`
    );
    let tail = "";
    if (syncing && result.nextSince) {
      tail = result.saturated
        ? `\n\nMore changes may follow: call again with since ${result.nextSince}.`
        : `\n\nCaught up. Next since: ${result.nextSince}`;
    } else if (result.saturated) {
      tail = `\n\nLimit reached: older notes were not listed. Page with since to reach them.`;
    } else if (result.nextSince) {
      tail = `\n\nNext since: ${result.nextSince}`;
    }
    return successResponse(
      (result.count
        ? `${result.count} notes${scope}, ${syncing ? "oldest" : "newest"} first:\n${lines.join("\n")}`
        : `No notes${scope}.`) + tail,
      result as unknown as Record<string, unknown>
    );
  }, "Error listing recent notes")
);

// --- list-folder-tree ---

registerTool(
  "list-folder-tree",
  {
    description:
      "Use when: you need the folder hierarchy with note counts, per account, in one read.\nReturns: accounts, each with nested folders (id, identifier, name, path, kind folder/smart/trash, noteCount direct, totalNoteCount including subfolders, children) and the account's noteCount.\nDo not use when: you only need folder paths (list-folders) or notes (list-notes, list-recent-notes).\nNote: read-only NoteStore access; requires Full Disk Access. includeDeleted adds folders awaiting deletion (markedForDeletion) and folders whose account is gone.",
    inputSchema: {
      account: z
        .string()
        .min(1)
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Only this account (exact or unique-prefix name). Omit for every account."),
      includeDeleted: z
        .boolean()
        .optional()
        .describe("Include folders marked for deletion (default false)"),
    },
    outputSchema: {
      accounts: z.array(z.object({}).passthrough()).optional(),
      folderCount: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(({ account, includeDeleted }) => {
    const result = folderTree({ account, includeDeleted });
    const lines: string[] = [];
    const walk = (nodes: FolderTreeNode[], depth: number) => {
      for (const node of nodes) {
        const counts =
          node.totalNoteCount === node.noteCount
            ? `${node.noteCount}`
            : `${node.noteCount}, ${node.totalNoteCount} with subfolders`;
        lines.push(`${"  ".repeat(depth + 1)}- ${node.name} (${counts})`);
        walk(node.children, depth + 1);
      }
    };
    for (const entry of result.accounts) {
      lines.push(`${entry.account}: ${entry.noteCount} notes`);
      walk(entry.folders, 0);
    }
    return successResponse(
      `${result.folderCount} folders:\n${lines.join("\n")}`,
      result as unknown as Record<string, unknown>
    );
  }, "Error listing folder tree")
);

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Initialize and start the MCP server.
 *
 * The server uses stdio transport for communication with MCP clients.
 * This is the standard transport for CLI-based MCP servers.
 */
// Register read-only resources and workflow prompts (#23).
registerResourcesAndPrompts(server, notesManager);

// Defense-in-depth: an unhandled rejection or a stray EventEmitter "error" must
// never take down this long-lived MCP server. EPIPE on stdout means the MCP
// client disconnected — exit cleanly rather than crash.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") process.exit(0);
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// Graceful shutdown. This server holds no persistent resources (AppleScript runs
// are one-shot via execSync), so the only thing to drain is stdout — and wiring SIGINT/
// SIGTERM and stdin EOF/close to a clean exit keeps behavior tidy and consistent
// with the sibling apple-mail server: when the parent kills us (signal) or the
// MCP client disconnects (stdin 'end'/'close'), exit 0 promptly instead of
// lingering as an orphan. Idempotent so multiple triggers don't double-exit.
// Pending stdout is drained first (bounded), so a response larger than the pipe
// buffer isn't truncated when the client closes stdin right after a request.
const shutdown = createShutdown(process.stdout, () => process.exit(0));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

// Wrapped so every tools/list payload declares JSON Schema 2020-12: the SDK
// stamps draft-07 on every emitted inputSchema/outputSchema, which current MCP
// clients reject outright. See @/utils/jsonSchemaDialect.js.
const transport = withJsonSchema2020_12(new StdioServerTransport());
await server.connect(transport);
