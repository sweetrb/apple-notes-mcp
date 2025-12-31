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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppleNotesManager } from "@/services/appleNotesManager.js";

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Notes operations.
 */
const server = new McpServer({
  name: "apple-notes",
  version: "1.2.7",
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
    const notes = notesManager.searchNotes(query, searchContent, account, folder);
    const searchType = searchContent ? "content" : "titles";
    const folderInfo = folder ? ` in folder "${folder}"` : "";

    if (notes.length === 0) {
      return successResponse(`No notes found matching "${query}" in ${searchType}${folderInfo}`);
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
      `Found ${notes.length} notes (searched ${searchType}${folderInfo}):\n${noteList}`
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
      return successResponse(`Note updated: "${displayTitle}"`);
    }

    // Fall back to title-based update
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
        `Note "${title}" is password-protected and cannot be updated. Unlock it in Notes.app first.`
      );
    }

    const success = notesManager.updateNote(title, newTitle, newContent, account);
    if (!success) {
      return errorResponse(`Failed to update note "${title}"`);
    }

    const finalTitle = newTitle || title;
    return successResponse(`Note updated: "${finalTitle}"`);
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
      const success = notesManager.deleteNoteById(id);
      if (!success) {
        return errorResponse(`Failed to delete note with ID "${id}". Note may not exist.`);
      }
      return successResponse(`Note deleted (by ID)`);
    }

    // Fall back to title-based deletion
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const success = notesManager.deleteNote(title, account);
    if (!success) {
      return errorResponse(`Failed to delete note "${title}". Note may not exist.`);
    }

    return successResponse(`Note deleted: "${title}"`);
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
      const success = notesManager.moveNoteById(id, folder, account);
      if (!success) {
        return errorResponse(
          `Failed to move note with ID "${id}" to folder "${folder}". Note or folder may not exist.`
        );
      }
      return successResponse(`Note moved to "${folder}" (by ID)`);
    }

    // Fall back to title-based move
    if (!title) {
      return errorResponse("Either 'id' or 'title' is required");
    }

    const success = notesManager.moveNote(title, folder, account);
    if (!success) {
      return errorResponse(
        `Failed to move note "${title}" to folder "${folder}". Note or folder may not exist.`
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
    const notes = notesManager.listNotes(account, folder);

    // Build context string for the response
    const location = folder ? ` in folder "${folder}"` : "";
    const acct = account ? ` (${account})` : "";

    if (notes.length === 0) {
      return successResponse(`No notes found${location}${acct}`);
    }

    const noteList = notes.map((t) => `  - ${t}`).join("\n");
    return successResponse(`Found ${notes.length} notes${location}${acct}:\n${noteList}`);
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
    const folders = notesManager.listFolders(account);
    const acct = account ? ` (${account})` : "";

    if (folders.length === 0) {
      return successResponse(`No folders found${acct}`);
    }

    const folderList = folders.map((f) => `  - ${f.name}`).join("\n");
    return successResponse(`Found ${folders.length} folders${acct}:\n${folderList}`);
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
// Diagnostics Tools
// =============================================================================

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
