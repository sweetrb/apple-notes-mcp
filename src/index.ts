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

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

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

/**
 * Creates a successful MCP tool response.
 *
 * @param message - The success message to display
 * @returns Formatted MCP response object
 */
function successResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Creates an error MCP tool response.
 *
 * @param message - The error message to display
 * @returns Formatted MCP error response object
 */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Wraps a tool handler with consistent error handling.
 *
 * @param handler - The async function to execute
 * @param errorPrefix - Prefix for error messages (e.g., "Error creating note")
 * @returns Wrapped handler with try/catch
 */
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
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
    content: z.string().min(1, "Content is required"),
    tags: z.array(z.string()).optional().describe("Tags for organization"),
  },
  withErrorHandling(({ title, content, tags = [] }) => {
    const note = notesManager.createNote(title, content, tags);

    if (!note) {
      return errorResponse(
        `Failed to create note "${title}". Check that Notes.app is configured and accessible.`
      );
    }

    return successResponse(`Note created: "${note.title}" [id: ${note.id}]`);
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
  },
  withErrorHandling(({ query, searchContent = false, account, folder }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: notes,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("search-notes", () =>
      notesManager.searchNotes(query, searchContent, account, folder)
    );

    const searchType = searchContent ? "content" : "titles";
    const folderInfo = folder ? ` in folder "${folder}"` : "";

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
        `No notes found matching "${query}" in ${searchType}${folderInfo}${syncNote}`
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
      `Found ${notes.length} notes (searched ${searchType}${folderInfo}):\n${noteList}${syncNote}`
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
      return successResponse(content);
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

    return successResponse(content);
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

    return successResponse(JSON.stringify(metadata, null, 2));
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

    return successResponse(JSON.stringify(metadata, null, 2));
  }, "Error retrieving note details")
);

// --- update-note ---

server.tool(
  "update-note",
  {
    id: z.string().optional().describe("Note ID (preferred - more reliable than title)"),
    title: z.string().optional().describe("Current note title (use id instead when available)"),
    newTitle: z.string().optional().describe("New title for the note"),
    newContent: z.string().min(1, "New content is required"),
    account: z
      .string()
      .optional()
      .describe("Account containing the note (ignored if id is provided)"),
  },
  withErrorHandling(({ id, title, newTitle, newContent, account }) => {
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
      const success = notesManager.updateNoteById(id, newTitle, newContent);
      if (!success) {
        return errorResponse(`Failed to update note "${note.title}"`);
      }
      const displayTitle = newTitle || note.title;
      // Add collaboration warning if note is shared
      const sharedWarning = note.shared
        ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
        : "";
      return successResponse(`Note updated: "${displayTitle}"${sharedWarning}`);
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

    const success = notesManager.updateNote(title, newTitle, newContent, account);
    if (!success) {
      return errorResponse(`Failed to update note "${title}"`);
    }

    const finalTitle = newTitle || title;
    // Add collaboration warning if note is shared
    const sharedWarning = note.shared
      ? "\n\n⚠️ This note is shared with collaborators. Your changes will be visible to them."
      : "";
    return successResponse(`Note updated: "${finalTitle}"${sharedWarning}`);
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
  },
  withErrorHandling(({ account, folder }) => {
    // Use sync-aware wrapper for this read operation
    const {
      result: notes,
      syncBefore,
      syncInterference,
    } = withSyncAwarenessSync("list-notes", () => notesManager.listNotes(account, folder));

    // Build context string for the response
    const location = folder ? ` in folder "${folder}"` : "";
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

    if (notes.length === 0) {
      return successResponse(`No notes found${location}${acct}${syncNote}`);
    }

    const noteList = notes.map((t) => `  - ${t}`).join("\n");
    return successResponse(
      `Found ${notes.length} notes${location}${acct}:\n${noteList}${syncNote}`
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
      return successResponse(`No folders found${acct}${syncNote}`);
    }

    const folderList = folders.map((f) => `  - ${f.name}`).join("\n");
    return successResponse(`Found ${folders.length} folders${acct}:\n${folderList}${syncNote}`);
  }, "Error listing folders")
);

// --- create-folder ---

server.tool(
  "create-folder",
  folderNameSchema,
  withErrorHandling(({ name, account }) => {
    const folder = notesManager.createFolder(name, account);

    if (!folder) {
      return errorResponse(`Failed to create folder "${name}". It may already exist.`);
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
      return successResponse("No Notes accounts found");
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} accounts:\n${accountList}`);
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
      return successResponse("No shared notes found. You have no notes shared with collaborators.");
    }

    const noteList = sharedNotes
      .map((n) => {
        const accountInfo = n.account ? ` (${n.account})` : "";
        return `  - ${n.title}${accountInfo} [id: ${n.id}]`;
      })
      .join("\n");

    return successResponse(
      `Found ${sharedNotes.length} shared note(s):\n${noteList}\n\n` +
        `⚠️ Changes to shared notes are visible to all collaborators.`
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
      return successResponse(`⚠️ Sync status unknown: ${status.error}`);
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

    return successResponse(lines.join("\n"));
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

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}`);
  }, "Error running health check")
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

    return successResponse(lines.join("\n"));
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
        return successResponse(`Note "${note.title}" has no attachments`);
      }
      const attachmentList = attachments.map((a) => `  - ${a.name} (${a.contentType})`).join("\n");
      return successResponse(
        `Found ${attachments.length} attachment(s) in "${note.title}":\n${attachmentList}`
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
      return successResponse(`Note "${title}" has no attachments`);
    }

    const attachmentList = attachments.map((a) => `  - ${a.name} (${a.contentType})`).join("\n");
    return successResponse(
      `Found ${attachments.length} attachment(s) in "${title}":\n${attachmentList}`
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

// --- export-notes-json ---

server.tool(
  "export-notes-json",
  {},
  withErrorHandling(() => {
    const exportData = notesManager.exportNotesAsJson();
    const summary = (
      exportData as { summary: { totalNotes: number; totalFolders: number; totalAccounts: number } }
    ).summary;

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
      return successResponse(markdown);
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

    return successResponse(markdown);
  }, "Error getting note as markdown")
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
const transport = new StdioServerTransport();
await server.connect(transport);
