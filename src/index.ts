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
import { detectChecklistAttempt } from "@/utils/contentWarnings.js";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
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
// Schema Definitions
// =============================================================================

/**
 * Common schema for operations requiring a note title.
 */
const noteTitleSchema = {
  title: z.string().min(1, "Note title is required"),
  account: z.string().optional().describe("Account name (defaults to iCloud)"),
};

/**
 * Common schema for operations requiring a folder name.
 */
const folderNameSchema = {
  name: z.string().min(1, "Folder name is required"),
  account: z.string().optional().describe("Account name (defaults to iCloud)"),
};

// =============================================================================
// Note Tools
// =============================================================================

// --- create-note ---

server.tool(
  "create-note",
  {
    title: z.string().min(1, "Title is required"),
    content: z
      .string()
      .min(1, "Content is required")
      .describe(
        'Note body. AppleScript cannot create true Apple Notes checklists — `<input type="checkbox">`, checklist CSS classes, and markdown `- [ ]` lines do not render as checkable items. To produce a checklist, create the note with a plain `<ul>` or `- ` list and convert it in Notes.app with ⇧⌘L.'
      ),
    format: z
      .enum(["plaintext", "html"])
      .optional()
      .default("plaintext")
      .describe("Content format: 'plaintext' (default) or 'html' for rich formatting"),
    tags: z.array(z.string()).optional().describe("Tags for organization"),
    folder: z
      .string()
      .optional()
      .describe("Folder to create the note in (supports nested paths like 'Work/Clients')"),
    account: z.string().optional().describe("Account name (defaults to iCloud)"),
  },
  withErrorHandling(({ title, content, format = "plaintext", tags = [], folder, account }) => {
    const note = notesManager.createNote(title, content, tags, folder, account, format);

    if (!note) {
      return errorResponse(
        `Failed to create note "${title}". Check that Notes.app is configured and accessible.`
      );
    }

    const checklistWarning = detectChecklistAttempt(content) ?? "";
    return successResponse(`Note created: "${note.title}" [id: ${note.id}]${checklistWarning}`);
  }, "Error creating note")
);

// --- search-notes ---

server.tool(
  "search-notes",
  {
    query: z.string().min(1, "Search query is required"),
    searchContent: z.boolean().optional().describe("Search note content instead of titles"),
    account: z.string().optional().describe("Account to search in"),
    folder: z.string().optional().describe("Limit search to a specific folder"),
    modifiedSince: z
      .string()
      .optional()
      .describe(
        "ISO 8601 date string to filter notes modified on or after this date (e.g., '2025-01-01'). Useful for searching only recent notes in large collections."
      ),
    limit: z.number().int().positive().optional().describe("Maximum number of results to return"),
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

server.tool(
  "get-note-content",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Note title (use id instead when available)"),
    account: z
      .string()
      .optional()
      .describe("Account name (defaults to iCloud, ignored if id is provided)"),
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
      const content = notesManager.getNoteContentById(id);
      if (!content) {
        return errorResponse(`Failed to read content of note "${note.title}"`);
      }
      return successResponse(content, { title: note.title, content });
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

    const content = notesManager.getNoteContent(title, account);
    if (!content) {
      return errorResponse(`Failed to read content of note "${title}"`);
    }

    return successResponse(content, { title, content });
  }, "Error retrieving note content")
);

// --- get-note-by-id ---

server.tool(
  "get-note-by-id",
  {
    id: z.string().min(1, "Note ID is required"),
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

server.tool(
  "get-note-details",
  noteTitleSchema,
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

// --- update-note ---

server.tool(
  "update-note",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Current note title (use id instead when available)"),
    newTitle: z.string().optional().describe("New title for the note"),
    newContent: z
      .string()
      .min(1, "New content is required")
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
      .optional()
      .describe("Account containing the note (ignored if id is provided)"),
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
      const displayTitle = newTitle || note.title;
      // Add collaboration warning if note is shared
      const sharedWarning = note.shared
        ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
        : "";
      const checklistWarning = detectChecklistAttempt(newContent) ?? "";
      return successResponse(`Note updated: "${displayTitle}"${sharedWarning}${checklistWarning}`);
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

    const finalTitle = newTitle || title;
    // Add collaboration warning if note is shared
    const sharedWarning = note.shared
      ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
      : "";
    const checklistWarning = detectChecklistAttempt(newContent) ?? "";
    return successResponse(`Note updated: "${finalTitle}"${sharedWarning}${checklistWarning}`);
  }, "Error updating note")
);

// --- delete-note ---

server.tool(
  "delete-note",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Note title (use id instead when available)"),
    account: z
      .string()
      .optional()
      .describe("Account name (defaults to iCloud, ignored if id is provided)"),
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
      return successResponse(`Note deleted: "${note.title}"${sharedWarning}`);
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
    return successResponse(`Note deleted: "${title}"${sharedWarning}`);
  }, "Error deleting note")
);

// --- move-note ---

server.tool(
  "move-note",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Note title (use id instead when available)"),
    folder: z.string().min(1, "Destination folder is required"),
    account: z.string().optional().describe("Account containing the note/folder"),
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
      return successResponse(`Note moved: "${note.title}" -> "${folder}"`);
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

    return successResponse(`Note moved: "${title}" -> "${folder}"`);
  }, "Error moving note")
);

// --- list-notes ---

server.tool(
  "list-notes",
  {
    account: z.string().optional().describe("Account to list notes from"),
    folder: z.string().optional().describe("Filter to specific folder"),
    modifiedSince: z
      .string()
      .optional()
      .describe(
        "ISO 8601 date string to filter notes modified on or after this date (e.g., '2025-01-01'). Useful for listing only recent notes in large collections."
      ),
    limit: z.number().int().positive().optional().describe("Maximum number of notes to return"),
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

// =============================================================================
// Folder Tools
// =============================================================================

// --- list-folders ---

server.tool(
  "list-folders",
  {
    account: z.string().optional().describe("Account to list folders from"),
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

server.tool(
  "create-folder",
  {
    name: z
      .string()
      .min(1, "Folder name is required")
      .describe(
        'Folder name or nested path separated by "/". E.g., "Retro Tech/PC/CPUs" creates all intermediate folders. Existing segments are skipped.'
      ),
    account: z.string().optional().describe("Account name (defaults to iCloud)"),
  },
  withErrorHandling(({ name, account }) => {
    const folder = notesManager.createFolder(name, account);

    if (!folder) {
      return errorResponse(`Failed to create folder "${name}".`);
    }

    return successResponse(`Folder created: "${folder.name}"`);
  }, "Error creating folder")
);

// --- delete-folder ---

server.tool(
  "delete-folder",
  folderNameSchema,
  withErrorHandling(({ name, account }) => {
    const success = notesManager.deleteFolder(name, account);

    if (!success) {
      return errorResponse(
        `Failed to delete folder "${name}". Folder may not exist or may contain notes.`
      );
    }

    return successResponse(`Folder deleted: "${name}"`);
  }, "Error deleting folder")
);

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

server.tool(
  "list-accounts",
  {},
  withErrorHandling(() => {
    const accounts = notesManager.listAccounts();

    if (accounts.length === 0) {
      return successResponse("No Notes accounts found", { accounts: [], count: 0 });
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} accounts:\n${accountList}`, {
      accounts,
      count: accounts.length,
    });
  }, "Error listing accounts")
);

// =============================================================================
// Collaboration Tools
// =============================================================================

// --- list-shared-notes ---

server.tool(
  "list-shared-notes",
  {},
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

server.tool(
  "get-sync-status",
  {},
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

server.tool(
  "health-check",
  {},
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
      : "  ⓘ full_disk_access: Not granted (optional — needed for get-checklist-state and checklist annotations in get-note-markdown). Grant in System Settings > Privacy & Security > Full Disk Access.";

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}\n${fdaLine}`);
  }, "Error running health check")
);

// --- doctor ---

server.tool(
  "doctor",
  {},
  withErrorHandling(() => {
    // Richer than health-check: Notes.app permission, account state, and Full
    // Disk Access with actionable messages + structuredContent (#22).
    const report = runDoctor(notesManager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "Error running doctor")
);

// --- get-notes-stats ---

server.tool(
  "get-notes-stats",
  {},
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

    return successResponse(lines.join("\n"), { ...stats });
  }, "Error getting notes statistics")
);

// --- list-attachments ---

server.tool(
  "list-attachments",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Note title (use id instead when available)"),
    account: z
      .string()
      .optional()
      .describe("Account containing the note (ignored if id is provided)"),
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

server.tool(
  "batch-delete-notes",
  {
    ids: z.array(z.string()).describe("Array of note IDs to delete"),
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

    return succeeded > 0 ? successResponse(lines.join("\n")) : errorResponse(lines.join("\n"));
  }, "Error performing batch delete")
);

// --- batch-move-notes ---

server.tool(
  "batch-move-notes",
  {
    ids: z.array(z.string()).describe("Array of note IDs to move"),
    folder: z.string().describe("Destination folder name"),
    account: z
      .string()
      .optional()
      .describe("Account containing the destination folder (defaults to iCloud)"),
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

    return succeeded > 0 ? successResponse(lines.join("\n")) : errorResponse(lines.join("\n"));
  }, "Error performing batch move")
);

// --- save-attachment ---

server.tool(
  "save-attachment",
  {
    noteId: z.string().min(1, "noteId is required").describe("CoreData note id (from search/list)"),
    attachmentId: z
      .string()
      .min(1, "attachmentId is required")
      .describe("Attachment id (from list-attachments)"),
    savePath: z
      .string()
      .min(1, "savePath is required")
      .describe("Absolute destination file path (must be under home, temp, or /Volumes)"),
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

server.tool(
  "fetch-attachment",
  {
    noteId: z.string().min(1, "noteId is required").describe("CoreData note id (from search/list)"),
    attachmentId: z
      .string()
      .min(1, "attachmentId is required")
      .describe("Attachment id (from list-attachments)"),
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

// --- export-notes-json ---

server.tool(
  "export-notes-json",
  {},
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

server.tool(
  "get-note-markdown",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Note title (use id instead when available)"),
    account: z
      .string()
      .optional()
      .describe("Account containing the note (ignored if id is provided)"),
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

server.tool(
  "get-checklist-state",
  {
    id: z.string().min(1, "Note ID is required. Use search-notes to find the note ID first."),
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

const transport = new StdioServerTransport();
await server.connect(transport);
