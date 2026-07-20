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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppleNotesManager } from "@/services/appleNotesManager.js";
import { getSyncStatus, withSyncAwarenessSync } from "@/utils/syncDetection.js";
import { getChecklistItems, hasFullDiskAccess } from "@/utils/checklistParser.js";
import { getNoteMetadata } from "@/utils/noteMetadata.js";
import { detectChecklistAttempt } from "@/utils/contentWarnings.js";
import { parseHashtags } from "@/utils/hashtags.js";
import { stripLargeInlineImages, strippedImagesWarning } from "@/utils/inlineImages.js";
import { resolveUpdateResponseTitle } from "@/utils/updateResponseTitle.js";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";
import { loadFileConfig } from "@/services/fileConfig.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";

// Load file-based config FIRST (#24) — before anything reads APPLE_NOTES_MCP_*.
// Lets users configure the server when the host app strips the MCP env block.
loadFileConfig();

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

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
 * Creates an error MCP tool response.
 */
function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
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
      return handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
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

// =============================================================================
// Schema Definitions
// =============================================================================

/**
 * Common schema for operations requiring a note title.
 */
const noteTitleSchema = {
  title: z.string().min(1, "Note title is required").max(MAX.TITLE),
  account: z.string().max(MAX.ACCOUNT).optional().describe("Account name (defaults to iCloud)"),
};

/**
 * Common schema for operations requiring a folder name.
 */
const folderNameSchema = {
  name: z.string().min(1, "Folder name is required").max(MAX.FOLDER),
  account: z.string().max(MAX.ACCOUNT).optional().describe("Account name (defaults to iCloud)"),
};

// =============================================================================
// Note Tools
// =============================================================================

// --- create-note ---

server.registerTool(
  "create-note",
  {
    description:
      "Use when: the user wants to create a brand-new Apple Note.\nReturns: the new note's title and id — reuse the id for follow-up reads/edits.\nDo not use when: editing an existing note (use update-note).\nNote: the title is prepended as an <h1>; true Apple Notes checklists cannot be created via AppleScript (see the content field).",
    inputSchema: {
      title: z.string().min(1, "Title is required").max(MAX.TITLE),
      content: z
        .string()
        .min(1, "Content is required")
        .max(MAX.CONTENT)
        .describe(
          'Note body. AppleScript cannot create true Apple Notes checklists — `<input type="checkbox">`, checklist CSS classes, and markdown `- [ ]` lines do not render as checkable items. To produce a checklist, create the note with a plain `<ul>` or `- ` list and convert it in Notes.app with ⇧⌘L.'
        ),
      format: z
        .enum(["plaintext", "html"])
        .optional()
        .default("plaintext")
        .describe("Content format: 'plaintext' (default) or 'html' for rich formatting"),
      tags: z
        .array(z.string().max(MAX.TAG))
        .max(MAX.TAGS)
        .optional()
        .describe(
          "Returned-only metadata — NOT written to Notes.app. Apple Notes tags can't be set via AppleScript, so any values passed here are echoed back in the response but do not appear on the created note. Use #hashtags inside the content body instead (Notes.app turns those into real tags)."
        ),
      folder: z
        .string()
        .max(MAX.FOLDER)
        .optional()
        .describe("Folder to create the note in (supports nested paths like 'Work/Clients')"),
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account name (defaults to iCloud)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      folder: z.string().optional(),
      account: z.string().optional(),
    },
  },
  withErrorHandling(({ title, content, format = "plaintext", tags = [], folder, account }) => {
    const note = notesManager.createNote(title, content, tags, folder, account, format);

    if (!note) {
      return errorResponse(
        `Failed to create note "${title}". Check that Notes.app is configured and accessible.`
      );
    }

    const checklistWarning = detectChecklistAttempt(content) ?? "";
    return successResponse(`Note created: "${note.title}" [id: ${note.id}]${checklistWarning}`, {
      ok: true,
      id: note.id,
      title: note.title,
      folder,
      account,
    });
  }, "Error creating note")
);

// --- search-notes ---

server.registerTool(
  "search-notes",
  {
    description:
      "Use when: finding notes by a keyword in the title (or body with searchContent=true) and you need their ids.\nReturns: matching notes with title, folder, and id.\nDo not use when: you already have a note id (use get-note-content) or want every note (use list-notes).\nPrefer this first to obtain ids for subsequent read/update/delete/move calls.",
    inputSchema: {
      query: z.string().min(1, "Search query is required").max(MAX.QUERY),
      searchContent: z.boolean().optional().describe("Search note content instead of titles"),
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account to search in"),
      folder: z.string().max(MAX.FOLDER).optional().describe("Limit search to a specific folder"),
      modifiedSince: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 date string to filter notes modified on or after this date (e.g., '2025-01-01'). Useful for searching only recent notes in large collections."
        ),
      limit: z.number().int().positive().optional().describe("Maximum number of results to return"),
    },
    outputSchema: {
      notes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ query, searchContent = false, account, folder, modifiedSince, limit }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: notes,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("search-notes", () =>
      notesManager.searchNotes(query, searchContent, account, folder, modifiedSince, limit)
    );

    const searchType = searchContent ? "content" : "titles";
    const folderInfo = folder ? ` in folder "${folder}"` : "";
    const dateInfo = modifiedSince ? ` modified since ${modifiedSince}` : "";
    const limitInfo = limit ? ` (limit: ${limit})` : "";

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
      return successResponse(
        `No notes found matching "${query}" in ${searchType}${folderInfo}${dateInfo}${syncNote}`,
        { notes: [], count: 0 }
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
      `Found ${notes.length} notes (searched ${searchType}${folderInfo}${dateInfo}${limitInfo}):\n${noteList}${syncNote}`,
      { notes, count: notes.length }
    );
  }, "Error searching notes")
);

// --- get-note-content ---

server.registerTool(
  "get-note-content",
  {
    description:
      "Use when: reading the full body text of one known note, by id (preferred) or title.\nReturns: the note's content plus parsed hashtags.\nDo not use when: you only need metadata (get-note-details) or Markdown with checklist state (get-note-markdown).\nNote: password-protected notes must be unlocked in Notes.app first.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account name (defaults to iCloud, ignored if id is provided)"),
    },
    outputSchema: {
      title: z.string().optional(),
      content: z.string().optional(),
      hashtags: z.array(z.string()).optional(),
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
      const rawContent = notesManager.getNoteContentById(id);
      if (!rawContent) {
        return errorResponse(`Failed to read content of note "${note.title}"`);
      }
      // Cap inline base64 images so an image-heavy note cannot produce a
      // response large enough to blow the client's MCP message limit.
      const stripped = stripLargeInlineImages(rawContent);
      const content = stripped.html;
      const hashtags = parseHashtags(content);
      const warning = strippedImagesWarning(stripped);
      return successResponse(warning ? content + warning : content, {
        title: note.title,
        content,
        hashtags,
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

    const rawContent = notesManager.getNoteContent(title, account);
    if (!rawContent) {
      return errorResponse(`Failed to read content of note "${title}"`);
    }

    const stripped = stripLargeInlineImages(rawContent);
    const content = stripped.html;
    const hashtags = parseHashtags(content);
    const warning = strippedImagesWarning(stripped);
    return successResponse(warning ? content + warning : content, { title, content, hashtags });
  }, "Error retrieving note content")
);

// --- get-note-plaintext ---

server.registerTool(
  "get-note-plaintext",
  {
    description:
      "Use when: reading one note's body as plain text with no HTML, by id (preferred) or title.\nReturns: the note's plaintext exactly as Notes exposes it.\nDo not use when: you need the HTML body (get-note-content) or Markdown with checklist state (get-note-markdown).\nNote: this reads the note's native plaintext property, so it skips the HTML-to-text conversion; password-protected notes must be unlocked in Notes.app first.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account name (defaults to iCloud, ignored if id is provided)"),
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

server.registerTool(
  "get-note-by-id",
  {
    description:
      "Use when: you have a note id and need its metadata only.\nReturns: id, title, created, modified, shared, passwordProtected.\nDo not use when: you need the body text (get-note-content) or only have a title (get-note-details).",
    inputSchema: {
      id: z.string().min(1, "Note ID is required").max(MAX.ID),
    },
    outputSchema: {
      id: z.string().optional(),
      title: z.string().optional(),
      created: z.string().optional(),
      modified: z.string().optional(),
      shared: z.boolean().optional(),
      passwordProtected: z.boolean().optional(),
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
    };

    return successResponse(JSON.stringify(metadata, null, 2), metadata);
  }, "Error retrieving note")
);

// --- get-note-details ---

server.registerTool(
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
    };

    return successResponse(JSON.stringify(metadata, null, 2), metadata);
  }, "Error retrieving note details")
);

// --- show-note ---

server.registerTool(
  "show-note",
  {
    description:
      "Use when: the user wants to reveal a known note in Notes.app by id.\nReturns: confirmation that Notes.app accepted the show command.\nDo not use when: you only need note content (get-note-content) or metadata (get-note-by-id).\nNote: this opens or focuses the Notes UI.",
    inputSchema: {
      id: z.string().min(1, "Note ID is required").max(MAX.ID),
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

server.registerTool(
  "get-note-link",
  {
    description:
      "Use when: you need the notes:// deep-link URL for a note so it can be stored in a Reminders task, shared, or opened directly.\nReturns: a notes://showNote?identifier=<uuid> URL that opens the note in Notes.app on iOS and macOS.\nDo not use when: you only need the note's CoreData id (get-note-by-id) or want to reveal the note on screen (show-note).\nNote: requires macOS 12+; returns an error on older systems.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
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
          `Failed to get note link for "${note.title}". The Notes database may not be accessible — grant Full Disk Access to the app that launches the server, fully quit and relaunch, then run the doctor tool. See: ${FULL_DISK_ACCESS_GUIDE_URL}. (On macOS 12–15 this also falls back to the AppleScript note link property.)`
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
        `Failed to get note link for "${title}". The Notes database may not be accessible — grant Full Disk Access to the app that launches the server, fully quit and relaunch, then run the doctor tool. See: ${FULL_DISK_ACCESS_GUIDE_URL}. (On macOS 12–15 this also falls back to the AppleScript note link property.)`
      );
    }
    return successResponse(`Note link: ${url}`, { title, url });
  }, "Error getting note link")
);

// --- show-folder ---

server.registerTool(
  "show-folder",
  {
    description:
      "Use when: the user wants to reveal a known folder in Notes.app by id.\nReturns: confirmation that Notes.app accepted the show command.\nDo not use when: you only need the folder list (list-folders).\nNote: this opens or focuses the Notes UI. Get the id from list-folders.",
    inputSchema: {
      id: z.string().min(1, "Folder ID is required").max(MAX.ID),
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

server.registerTool(
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

server.registerTool(
  "update-note",
  {
    description:
      "Use when: changing the title and/or replacing the body of an existing note, by id (preferred) or title.\nReturns: confirmation; warns when the note is shared.\nDo not use when: creating a new note (create-note).\nSafety: newContent REPLACES the entire body — it does not append. Read the note first if you need to preserve existing text, and run list-attachments first when the note may hold files, images, scans, PDFs, or audio, since a full-body replace can drop embedded attachments. Edits to shared notes are immediately visible to all collaborators.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Current note title (use id instead when available)"),
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
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note (ignored if id is provided)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      shared: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, title, newTitle, newContent, format = "plaintext", account }) => {
    // Prefer ID-based update if provided
    if (id) {
      // Check for password protection first for better error message
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      if (note.passwordProtected) {
        return errorResponse(
          `Note "${note.title}" is password-protected and cannot be updated. Unlock it in Notes.app first.`
        );
      }
      const success = notesManager.updateNoteById(id, newTitle, newContent, format);
      if (!success) {
        return errorResponse(`Failed to update note "${note.title}"`);
      }
      const displayTitle = resolveUpdateResponseTitle(note.title, newTitle, format, newContent);
      // Add collaboration warning if note is shared
      const sharedWarning = note.shared
        ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
        : "";
      const checklistWarning = detectChecklistAttempt(newContent) ?? "";
      return successResponse(`Note updated: "${displayTitle}"${sharedWarning}${checklistWarning}`, {
        ok: true,
        id,
        title: displayTitle,
        shared: note.shared ?? false,
      });
    }

    // Fall back to title-based update
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    // Check for password protection first for better error message
    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(
        `Note "${title}" not found. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }
    if (note.passwordProtected) {
      return errorResponse(
        `Note "${title}" is password-protected and cannot be updated. Unlock it in Notes.app first.`
      );
    }

    const success = notesManager.updateNote(title, newTitle, newContent, account, format);
    if (!success) {
      return errorResponse(`Failed to update note "${title}"`);
    }

    const finalTitle = resolveUpdateResponseTitle(note.title, newTitle, format, newContent);
    // Add collaboration warning if note is shared
    const sharedWarning = note.shared
      ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
      : "";
    const checklistWarning = detectChecklistAttempt(newContent) ?? "";
    return successResponse(`Note updated: "${finalTitle}"${sharedWarning}${checklistWarning}`, {
      ok: true,
      title: finalTitle,
      shared: note.shared ?? false,
    });
  }, "Error updating note")
);

// --- append-to-note ---

server.registerTool(
  "append-to-note",
  {
    description:
      "Use when: adding content to an existing note without replacing it, by id (preferred) or title.\nReturns: confirmation with the note id and title.\nDo not use when: creating a new note (create-note) or replacing the entire body (update-note).\nSafety: reads the existing body first, concatenates, then writes back. Run list-attachments first if the note may hold embedded files — a full-body rewrite can drop attachments.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      content: z
        .string()
        .min(1, "Content to append is required")
        .max(MAX.CONTENT)
        .describe("Text to append to the note body"),
      position: z
        .enum(["after", "before"])
        .optional()
        .default("after")
        .describe(
          "Where to insert: 'after' appends to the end (default), 'before' prepends to the start"
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
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note (ignored if id is provided)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      shared: z.boolean().optional(),
    },
  },
  withErrorHandling(
    ({
      id,
      title,
      content,
      position = "after",
      separator = "\n\n",
      format = "plaintext",
      account,
    }) => {
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

      if (id) {
        const note = notesManager.getNoteById(id);
        if (!note) {
          return errorResponse(`Note with ID "${id}" not found`);
        }
        if (note.passwordProtected) {
          return errorResponse(
            `Note "${note.title}" is password-protected and cannot be updated. Unlock it in Notes.app first.`
          );
        }
        // Always read as HTML to avoid destroying rich formatting
        const existingHtml = notesManager.getNoteContentById(id);
        if (existingHtml === null || existingHtml === undefined) {
          return errorResponse(`Failed to read content of note "${note.title}"`);
        }
        // The title is stored as the first <div> of the body. Separate it so we
        // never duplicate it when writing back.
        const firstDivEnd = existingHtml.indexOf("</div>");
        const titleDiv = firstDivEnd !== -1 ? existingHtml.slice(0, firstDivEnd + 6) : "";
        const bodyHtml = firstDivEnd !== -1 ? existingHtml.slice(firstDivEnd + 6) : existingHtml;
        const newBlock = contentToHtml(content);
        const sepHtml = separatorToHtml(separator);
        const combinedBody =
          position === "before"
            ? titleDiv + newBlock + sepHtml + bodyHtml
            : titleDiv + bodyHtml + sepHtml + newBlock;
        const success = notesManager.updateNoteById(id, undefined, combinedBody, "html");
        if (!success) {
          return errorResponse(`Failed to append to note "${note.title}"`);
        }
        const sharedWarning = note.shared
          ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
          : "";
        return successResponse(`Note appended: "${note.title}"${sharedWarning}`, {
          ok: true,
          id,
          title: note.title,
          shared: note.shared ?? false,
        });
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
        return errorResponse(
          `Note "${title}" is password-protected and cannot be updated. Unlock it in Notes.app first.`
        );
      }
      // Always read as HTML to avoid destroying rich formatting
      const existingHtml = notesManager.getNoteContent(title, account);
      if (existingHtml === null || existingHtml === undefined) {
        return errorResponse(`Failed to read content of note "${title}"`);
      }
      // Separate the title <div> from the body
      const firstDivEnd = existingHtml.indexOf("</div>");
      const titleDiv = firstDivEnd !== -1 ? existingHtml.slice(0, firstDivEnd + 6) : "";
      const bodyHtml = firstDivEnd !== -1 ? existingHtml.slice(firstDivEnd + 6) : existingHtml;
      const newBlock = contentToHtml(content);
      const sepHtml = separatorToHtml(separator);
      const combinedBody =
        position === "before"
          ? titleDiv + newBlock + sepHtml + bodyHtml
          : titleDiv + bodyHtml + sepHtml + newBlock;
      const success = notesManager.updateNote(title, undefined, combinedBody, account, "html");
      if (!success) {
        return errorResponse(`Failed to append to note "${title}"`);
      }
      const sharedWarning = note.shared
        ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
        : "";
      return successResponse(`Note appended: "${title}"${sharedWarning}`, {
        ok: true,
        title,
        shared: note.shared ?? false,
      });
    },
    "Error appending to note"
  )
);

// --- delete-note ---

server.registerTool(
  "delete-note",
  {
    description:
      "Use when: permanently deleting a single note, by id (preferred) or title.\nReturns: confirmation; warns when the note was shared.\nDo not use when: deleting many notes (batch-delete-notes) or just relocating one (move-note).\nSafety: requires explicit user confirmation before deleting. Prefer search-notes/list-notes first to show the affected note id and title. Deleting a shared note removes collaborator access.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account name (defaults to iCloud, ignored if id is provided)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      wasShared: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
    // Prefer ID-based deletion if provided
    if (id) {
      // Verify note exists first for better error message
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      const success = notesManager.deleteNoteById(id);
      if (!success) {
        return errorResponse(`Failed to delete note "${note.title}"`);
      }
      // Add collaboration warning if note was shared
      const sharedWarning = note.shared
        ? "\n\n⚠️ This note was shared with collaborators. They will no longer have access."
        : "";
      return successResponse(`Note deleted: "${note.title}"${sharedWarning}`, {
        ok: true,
        id,
        title: note.title,
        wasShared: note.shared ?? false,
      });
    }

    // Fall back to title-based deletion
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    // Verify note exists first for better error message
    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(
        `Note "${title}" not found. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }

    const success = notesManager.deleteNote(title, account);
    if (!success) {
      return errorResponse(`Failed to delete note "${title}"`);
    }

    // Add collaboration warning if note was shared
    const sharedWarning = note.shared
      ? "\n\n⚠️ This note was shared with collaborators. They will no longer have access."
      : "";
    return successResponse(`Note deleted: "${title}"${sharedWarning}`, {
      ok: true,
      title,
      wasShared: note.shared ?? false,
    });
  }, "Error deleting note")
);

// --- move-note ---

server.registerTool(
  "move-note",
  {
    description:
      "Use when: moving one note to a different folder, by id (preferred) or title.\nReturns: confirmation of the note and destination folder.\nDo not use when: moving many notes (batch-move-notes).\nNote: the note is relocated in place via Notes.app's native move, preserving its id, creation date, and all attachments. The destination folder must already exist (create-folder).",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
      title: z
        .string()
        .max(MAX.TITLE)
        .optional()
        .describe("Note title (use id instead when available)"),
      folder: z.string().min(1, "Destination folder is required").max(MAX.FOLDER),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the note/folder"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      folder: z.string().optional(),
    },
  },
  withErrorHandling(({ id, title, folder, account }) => {
    // Prefer ID-based move if provided
    if (id) {
      // Verify note exists first for better error message
      const note = notesManager.getNoteById(id);
      if (!note) {
        return errorResponse(`Note with ID "${id}" not found`);
      }
      const success = notesManager.moveNoteById(id, folder, account);
      if (!success) {
        return errorResponse(
          `Failed to move note "${note.title}" to folder "${folder}". Folder may not exist.`
        );
      }
      return successResponse(`Note moved: "${note.title}" -> "${folder}"`, {
        ok: true,
        id,
        title: note.title,
        folder,
      });
    }

    // Fall back to title-based move
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    // Verify note exists first for better error message
    const note = notesManager.getNoteDetails(title, account);
    if (!note) {
      return errorResponse(
        `Note "${title}" not found. Use search-notes to find notes, then use the note's ID for reliable operations.`
      );
    }

    const success = notesManager.moveNote(title, folder, account);
    if (!success) {
      return errorResponse(
        `Failed to move note "${title}" to folder "${folder}". Folder may not exist.`
      );
    }

    return successResponse(`Note moved: "${title}" -> "${folder}"`, {
      ok: true,
      title,
      folder,
    });
  }, "Error moving note")
);

// --- list-notes ---

server.registerTool(
  "list-notes",
  {
    description:
      "Use when: enumerating notes in an account or folder; supports modifiedSince and limit for large collections.\nReturns: note titles only (no content or ids).\nDo not use when: you need content (get-note-content) or ids for follow-up edits (use search-notes).\nNote: warns if iCloud sync is active and results may be partial.",
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
    },
    outputSchema: {
      notes: z.array(z.string()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ account, folder, modifiedSince, limit }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: notes,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("list-notes", () =>
      notesManager.listNotes(account, folder, modifiedSince, limit)
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

    if (notes.length === 0) {
      return successResponse(`No notes found${location}${acct}${dateInfo}${syncNote}`, {
        notes: [],
        count: 0,
      });
    }

    const noteList = notes.map((t) => `  - ${t}`).join("\n");
    return successResponse(
      `Found ${notes.length} notes${location}${acct}${dateInfo}${limitInfo}:\n${noteList}${syncNote}`,
      { notes, count: notes.length }
    );
  }, "Error listing notes")
);

// --- get-selected-notes ---

server.registerTool(
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
    return successResponse(`Selected note(s):\n${noteList}`, { notes, count: notes.length });
  }, "Error getting selected notes")
);

// =============================================================================
// Folder Tools
// =============================================================================

// --- list-folders ---

server.registerTool(
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

    const folderList = folders.map((f) => `  - ${f.name}`).join("\n");
    return successResponse(`Found ${folders.length} folders${acct}:\n${folderList}${syncNote}`, {
      folders,
      count: folders.length,
    });
  }, "Error listing folders")
);

// --- create-folder ---

server.registerTool(
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
      account: z.string().max(MAX.ACCOUNT).optional().describe("Account name (defaults to iCloud)"),
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

server.registerTool(
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

server.registerTool(
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
      accounts,
      count: accounts.length,
    });
  }, "Error listing accounts")
);

// --- get-default-location ---

server.registerTool(
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
    return successResponse(message, { ...location });
  }, "Error getting default Notes location")
);

// =============================================================================
// Collaboration Tools
// =============================================================================

// --- list-shared-notes ---

server.registerTool(
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
      { notes: sharedNotes, count: sharedNotes.length }
    );
  }, "Error listing shared notes")
);

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- get-sync-status ---

server.registerTool(
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

server.registerTool(
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

    // Check Full Disk Access for checklist features
    const fdaAvailable = hasFullDiskAccess();
    const fdaLine = fdaAvailable
      ? "  ✓ full_disk_access: Granted (checklist features available)"
      : "  ⓘ full_disk_access: Not granted (optional — needed for get-checklist-state and checklist annotations in get-note-markdown). " +
        "In System Settings > Privacy & Security > Full Disk Access, grant access to the app that launches this server " +
        "(Claude Desktop / Terminal / iTerm2), then fully quit and relaunch it. " +
        `Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL} — run the doctor tool to verify.`;

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}\n${fdaLine}`, {
      healthy: result.healthy,
      checks: result.checks,
      fullDiskAccess: fdaAvailable,
    });
  }, "Error running health check")
);

// --- doctor ---

server.registerTool(
  "doctor",
  {
    description:
      "Use when: diagnosing setup problems (Notes.app automation permission, account state, Full Disk Access) with actionable guidance.\nReturns: a detailed report plus structured fields.\nDo not use when: you just need a quick pass/fail (health-check).\nRead-only.",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(z.object({}).passthrough()).optional(),
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

server.registerTool(
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

server.registerTool(
  "list-attachments",
  {
    description:
      "Use when: listing the attachments of one note, by id (preferred) or title.\nReturns: each attachment's name, content type, and id (use with save-attachment/fetch-attachment).\nDo not use when: you want the attachment bytes (fetch-attachment) or a file on disk (save-attachment).",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
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
      attachments: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ id, title, account }) => {
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
      return successResponse(
        `Found ${attachments.length} attachment(s) in "${note.title}":\n${attachmentList}`,
        { attachments, count: attachments.length }
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

server.registerTool(
  "batch-delete-notes",
  {
    description:
      "Use when: permanently deleting multiple notes by id in one call.\nReturns: per-id success/failure counts.\nDo not use when: deleting a single note (delete-note).\nSafety: requires explicit user confirmation; this is destructive and not undoable. Prefer search-notes/list-notes first to confirm the exact ids being deleted.",
    inputSchema: {
      ids: z
        .array(z.string().max(MAX.ID))
        .max(MAX.BATCH_IDS)
        .describe("Array of note IDs to delete"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      succeeded: z.number().optional(),
      failed: z.number().optional(),
      results: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(({ ids }) => {
    if (ids.length === 0) {
      return errorResponse("No note IDs provided");
    }

    const results = notesManager.batchDeleteNotes(ids);
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

server.registerTool(
  "batch-move-notes",
  {
    description:
      "Use when: moving multiple notes by id into one destination folder.\nReturns: per-id success/failure counts.\nDo not use when: moving a single note (move-note).\nNote: the destination folder must already exist (create-folder).",
    inputSchema: {
      ids: z.array(z.string().max(MAX.ID)).max(MAX.BATCH_IDS).describe("Array of note IDs to move"),
      folder: z.string().max(MAX.FOLDER).describe("Destination folder name"),
      account: z
        .string()
        .max(MAX.ACCOUNT)
        .optional()
        .describe("Account containing the destination folder (defaults to iCloud)"),
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

server.registerTool(
  "save-attachment",
  {
    description:
      "Use when: writing one note attachment to a file on disk.\nReturns: the saved path.\nDo not use when: you want the bytes in-memory as base64 (fetch-attachment).\nSafety: writes a file; savePath must be absolute and under the home directory, a temp dir, or /Volumes. Get the ids from list-attachments first.",
    inputSchema: {
      noteId: z
        .string()
        .min(1, "noteId is required")
        .max(MAX.ID)
        .describe("CoreData note id (from search/list)"),
      attachmentId: z
        .string()
        .min(1, "attachmentId is required")
        .max(MAX.ATTACHMENT_ID)
        .describe("Attachment id (from list-attachments)"),
      savePath: z
        .string()
        .min(1, "savePath is required")
        .max(MAX.SAVE_PATH)
        .describe("Absolute destination file path (must be under home, temp, or /Volumes)"),
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

// --- fetch-attachment ---

server.registerTool(
  "fetch-attachment",
  {
    description:
      "Use when: retrieving one note attachment's bytes inline as base64 (no file written).\nReturns: name, content type, byte count, and base64 data.\nDo not use when: you want it saved to disk (save-attachment).\nNote: get the ids from list-attachments first.",
    inputSchema: {
      noteId: z
        .string()
        .min(1, "noteId is required")
        .max(MAX.ID)
        .describe("CoreData note id (from search/list)"),
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

server.registerTool(
  "show-attachment",
  {
    description:
      "Use when: the user wants to reveal one note attachment in Notes.app.\nReturns: confirmation that Notes.app revealed the attachment.\nDo not use when: you want the bytes (fetch-attachment) or a file on disk (save-attachment).\nNote: this opens or focuses the Notes UI. Get the ids from list-attachments first.",
    inputSchema: {
      noteId: z
        .string()
        .min(1, "noteId is required")
        .max(MAX.ID)
        .describe("CoreData note id (from search/list)"),
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

server.registerTool(
  "export-notes-json",
  {
    description:
      "Use when: exporting the entire notes library as structured JSON for backup or bulk processing.\nReturns: a summary plus the full JSON of all notes, folders, and accounts.\nDo not use when: you need a single note (get-note-content) — this reads everything and can be large.\nRead-only.",
    inputSchema: {},
    outputSchema: {
      exportDate: z.string().optional(),
      version: z.string().optional(),
      accounts: z.array(z.object({}).passthrough()).optional(),
      summary: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(() => {
    const exportData = notesManager.exportNotesAsJson();
    const { summary } = exportData;

    return {
      content: [
        {
          type: "text" as const,
          text: `Exported ${summary.totalNotes} notes from ${summary.totalFolders} folders across ${summary.totalAccounts} account(s).\n\nFull JSON export:`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(exportData, null, 2),
        },
      ],
      structuredContent: { ...exportData },
    };
  }, "Error exporting notes")
);

// --- get-note-markdown ---

server.registerTool(
  "get-note-markdown",
  {
    description:
      "Use when: reading a note as Markdown, with checklist items annotated [x]/[ ] when Full Disk Access is granted.\nReturns: the note's Markdown.\nDo not use when: you need the raw HTML/plaintext body (get-note-content) or only metadata (get-note-details).\nNote: falls back to plain lists (no checkmarks) without Full Disk Access.",
    inputSchema: {
      id: z
        .string()
        .max(MAX.ID)
        .optional()
        .describe("Note ID (preferred - more reliable than title)"),
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

// --- get-checklist-state ---

server.registerTool(
  "get-checklist-state",
  {
    description:
      "Use when: reading the checked/unchecked state of a note's checklist items, by id.\nReturns: each item's text and done state plus checked/total counts.\nDo not use when: you only have a title (get the id via search-notes first) or want the full body text (get-note-content).\nNote: requires Full Disk Access; reads the NoteStore database directly.",
    inputSchema: {
      id: z
        .string()
        .min(1, "Note ID is required. Use search-notes to find the note ID first.")
        .max(MAX.ID),
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

// --- get-note-metadata (BETA) ---

server.registerTool(
  "get-note-metadata",
  {
    description:
      "[BETA] Use when: reading note metadata AppleScript cannot expose — pinned state, checklist flags, trash/recovery state, preview snippet, password hint — by id.\nReturns: a metadata object; fields vary by macOS version and are omitted when unavailable.\nDo not use when: you need the body (get-note-content) or per-item checklist state (get-checklist-state).\nNote: reads the NoteStore SQLite database read-only and requires Full Disk Access. BETA — the database schema changes between macOS releases, so some fields may be absent. Works on trashed notes that AppleScript can no longer resolve.",
    inputSchema: {
      id: z
        .string()
        .min(1, "Note ID is required. Use search-notes to find the note ID first.")
        .max(MAX.ID),
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
// are one-shot via execSync), so there's nothing to drain — but wiring SIGINT/
// SIGTERM and stdin EOF/close to a clean exit keeps behavior tidy and consistent
// with the sibling apple-mail server: when the parent kills us (signal) or the
// MCP client disconnects (stdin 'end'/'close'), exit 0 promptly instead of
// lingering as an orphan. Idempotent so multiple triggers don't double-exit.
let _shuttingDown = false;
const shutdown = (): void => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
