/**
 * Apple Notes Manager
 *
 * A comprehensive service for managing Apple Notes through AppleScript.
 * This module provides a clean TypeScript interface over the Notes.app
 * AppleScript dictionary, handling all the complexity of script generation,
 * text escaping, and result parsing.
 *
 * Architecture:
 * - Text escaping is handled by dedicated helper functions
 * - AppleScript generation uses template builders for consistency
 * - All public methods return typed results (no raw strings)
 * - Error handling is consistent across all operations
 *
 * @module services/appleNotesManager
 */

import type { Note, Folder, Account } from "@/types.js";
import { executeAppleScript } from "@/utils/applescript.js";

// =============================================================================
// Text Processing Utilities
// =============================================================================

/**
 * Escapes text for safe embedding in AppleScript string literals.
 *
 * AppleScript strings use double quotes, so we need to escape:
 * 1. Double quotes (") - escaped as \"
 * 2. Backslashes (\) - already handled by shell escaping
 *
 * Additionally, since our AppleScript is passed through the shell via
 * `osascript -e '...'`, we need to handle single quotes in the content.
 *
 * Finally, Apple Notes uses HTML internally, so we convert control
 * characters to their HTML equivalents.
 *
 * @param text - Raw text to escape
 * @returns Text safe for AppleScript string embedding
 *
 * @example
 * escapeForAppleScript("Hello \"World\"")
 * // Returns: Hello \"World\"
 *
 * escapeForAppleScript("Line 1\nLine 2")
 * // Returns: Line 1<br>Line 2
 */
export function escapeForAppleScript(text: string): string {
  // Guard against null/undefined - return empty string
  if (!text) {
    return "";
  }

  // Content goes inside AppleScript double-quoted strings: body:"content here"
  // Within double-quoted AppleScript strings, we need to escape:
  // 1. Backslashes (\ → \\) - AppleScript escape character
  // 2. Double quotes (" → \") - String delimiter
  // Single quotes do NOT need escaping in double-quoted AppleScript strings.

  // Step 1: Encode HTML ampersands FIRST (before adding any HTML entities)
  let escaped = text.replace(/&/g, "&amp;");

  // Step 2: Encode backslashes as HTML entities
  // This avoids AppleScript escaping issues since Notes stores HTML
  // Must happen AFTER ampersand encoding (so &#92; doesn't become &amp;#92;)
  // and BEFORE double-quote escaping (so \" doesn't become &#92;")
  escaped = escaped.replace(/\\/g, "&#92;");

  // Step 3: Escape double quotes for AppleScript strings
  // The backslash in \" is for AppleScript, not content, so it's added AFTER
  // backslash encoding to avoid being HTML-encoded
  escaped = escaped.replace(/"/g, '\\"');

  // Step 4: Convert control characters to HTML for Notes.app
  // - Newlines (\n) to <br> tags
  // - Tabs (\t) to <br> tags (better than &nbsp; for readability)
  escaped = escaped.replace(/\n/g, "<br>");
  escaped = escaped.replace(/\t/g, "<br>");

  return escaped;
}

/**
 * Converts AppleScript date representation to JavaScript Date.
 *
 * AppleScript returns dates in a verbose format like:
 * "date Saturday, December 27, 2025 at 3:44:02 PM"
 *
 * This function extracts the parseable portion and converts it
 * to a JavaScript Date object.
 *
 * @param appleScriptDate - Date string from AppleScript
 * @returns Parsed Date, or current date if parsing fails
 *
 * @example
 * parseAppleScriptDate("date Saturday, December 27, 2025 at 3:44:02 PM")
 * // Returns: Date object for Dec 27, 2025 3:44:02 PM
 */
export function parseAppleScriptDate(appleScriptDate: string): Date {
  // Remove the "date " prefix if present
  const withoutPrefix = appleScriptDate.replace(/^date\s+/, "");

  // Replace " at " with a space for standard date parsing
  // "Saturday, December 27, 2025 at 3:44:02 PM" ->
  // "Saturday, December 27, 2025 3:44:02 PM"
  const normalized = withoutPrefix.replace(" at ", " ");

  // Attempt to parse - JavaScript's Date constructor handles this format
  const parsed = new Date(normalized);

  // Return parsed date if valid, otherwise current date as fallback
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

// =============================================================================
// AppleScript Template Builders
// =============================================================================

/**
 * Configuration for targeting a specific Notes account.
 * Used by script builders to scope operations.
 */
interface AccountScope {
  /** Account name (e.g., "iCloud", "Gmail") */
  account: string;
}

/**
 * Builds an AppleScript command wrapped in account context.
 *
 * Most Notes.app operations need to be scoped to an account:
 * ```applescript
 * tell application "Notes"
 *   tell account "iCloud"
 *     -- command here
 *   end tell
 * end tell
 * ```
 *
 * This builder generates that wrapper structure.
 *
 * @param scope - Account to target
 * @param command - The AppleScript command to execute
 * @returns Complete AppleScript ready for execution
 */
function buildAccountScopedScript(scope: AccountScope, command: string): string {
  return `
    tell application "Notes"
      tell account "${scope.account}"
        ${command}
      end tell
    end tell
  `;
}

/**
 * Builds an AppleScript command at the application level.
 *
 * Some operations (like listing accounts) don't need account scoping:
 * ```applescript
 * tell application "Notes"
 *   -- command here
 * end tell
 * ```
 *
 * @param command - The AppleScript command to execute
 * @returns Complete AppleScript ready for execution
 */
function buildAppLevelScript(command: string): string {
  return `
    tell application "Notes"
      ${command}
    end tell
  `;
}

// =============================================================================
// Result Parsing Utilities
// =============================================================================

/**
 * Parses a comma-separated list from AppleScript output.
 *
 * AppleScript often returns lists as comma-separated strings:
 * "Note 1, Note 2, Note 3"
 *
 * This function splits and cleans the output.
 *
 * @param output - Raw AppleScript output
 * @returns Array of trimmed, non-empty strings
 */
function parseCommaSeparatedList(output: string): string[] {
  return output
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Extracts a CoreData ID from AppleScript output.
 *
 * Notes.app uses CoreData URLs as unique identifiers:
 * "note id x-coredata://ABC123-DEF456/ICNote/p789"
 *
 * This function extracts the ID portion.
 *
 * @param output - AppleScript output containing an ID reference
 * @param prefix - The object type prefix (e.g., "note", "folder")
 * @returns Extracted ID or empty string
 */
function extractCoreDataId(output: string, prefix: string): string {
  const pattern = new RegExp(`${prefix} id ([^\\s]+)`);
  const match = output.match(pattern);
  return match ? match[1] : "";
}

// =============================================================================
// Apple Notes Manager Class
// =============================================================================

/**
 * Manages interactions with Apple Notes via AppleScript.
 *
 * This class provides a high-level TypeScript interface for all
 * Notes.app operations. It handles:
 *
 * - Note CRUD operations (create, read, update, delete)
 * - Note organization (folders, moving between folders)
 * - Multi-account support (iCloud, Gmail, Exchange, etc.)
 * - Search functionality (by title or content)
 *
 * All operations are synchronous since they rely on AppleScript
 * execution via osascript. Error handling is consistent: methods
 * return null/false/empty-array on failure rather than throwing.
 *
 * @example
 * ```typescript
 * const notes = new AppleNotesManager();
 *
 * // Create a note in the default (iCloud) account
 * const note = notes.createNote("Shopping List", "Eggs, Milk, Bread");
 *
 * // Search across all notes
 * const results = notes.searchNotes("shopping", true); // searches content
 *
 * // Work with a different account
 * const gmailNotes = notes.listNotes("Gmail");
 * ```
 */
export class AppleNotesManager {
  /**
   * Default account used when no account is specified.
   * iCloud is the primary account for most Apple Notes users.
   */
  private readonly defaultAccount = "iCloud";

  /**
   * Resolves the account to use for an operation.
   * Falls back to default if not specified.
   */
  private resolveAccount(account?: string): string {
    return account || this.defaultAccount;
  }

  // ===========================================================================
  // Note Operations
  // ===========================================================================

  /**
   * Creates a new note in Apple Notes.
   *
   * The note is created with the specified title and content. If a folder
   * is specified, the note is created in that folder; otherwise it goes
   * to the account's default location.
   *
   * @param title - Display title for the note
   * @param content - Body content (plain text, will be HTML-escaped)
   * @param tags - Optional tags (stored in returned object, not used by Notes.app)
   * @param folder - Optional folder name to create the note in
   * @param account - Account to use (defaults to iCloud)
   * @returns Created Note object with metadata, or null on failure
   *
   * @example
   * ```typescript
   * // Simple note creation
   * const note = manager.createNote("Meeting Notes", "Discussed Q4 plans");
   *
   * // Create in a specific folder
   * const work = manager.createNote("Task List", "1. Review PR", [], "Work");
   *
   * // Create in a different account
   * const gmail = manager.createNote("Draft", "...", [], undefined, "Gmail");
   * ```
   */
  createNote(
    title: string,
    content: string,
    tags: string[] = [],
    folder?: string,
    account?: string
  ): Note | null {
    const targetAccount = this.resolveAccount(account);

    // Escape content for AppleScript embedding
    const safeTitle = escapeForAppleScript(title);
    const safeContent = escapeForAppleScript(content);

    // Build the AppleScript command
    // Notes.app uses 'name' for the title and 'body' for content
    // We capture the ID of the newly created note
    let createCommand: string;

    if (folder) {
      // Create note in specific folder
      const safeFolder = escapeForAppleScript(folder);
      createCommand = `
        set newNote to make new note at folder "${safeFolder}" with properties {name:"${safeTitle}", body:"${safeContent}"}
        return id of newNote
      `;
    } else {
      // Create note in default location
      createCommand = `
        set newNote to make new note with properties {name:"${safeTitle}", body:"${safeContent}"}
        return id of newNote
      `;
    }

    // Execute the script
    const script = buildAccountScopedScript({ account: targetAccount }, createCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to create note "${title}":`, result.error);
      return null;
    }

    // Extract the CoreData ID from the response
    const noteId = result.output.trim();

    // Return a Note object representing the created note with real ID
    const now = new Date();
    return {
      id: noteId || Date.now().toString(), // Use real ID, fallback to timestamp
      title,
      content,
      tags,
      created: now,
      modified: now,
      folder,
      account: targetAccount,
    };
  }

  /**
   * Searches for notes matching a query.
   *
   * By default, searches note titles. Set searchContent=true to search
   * the body text instead.
   *
   * @param query - Text to search for
   * @param searchContent - If true, search note bodies; if false, search titles
   * @param account - Account to search in (defaults to iCloud)
   * @returns Array of matching notes (with minimal metadata)
   *
   * @example
   * ```typescript
   * // Search by title
   * const meetingNotes = manager.searchNotes("meeting");
   *
   * // Search in note content
   * const projectRefs = manager.searchNotes("Project Alpha", true);
   * ```
   */
  searchNotes(query: string, searchContent: boolean = false, account?: string): Note[] {
    const targetAccount = this.resolveAccount(account);
    const safeQuery = escapeForAppleScript(query);

    // Build the where clause based on search type
    // AppleScript uses 'name' for title and 'body' for content
    const whereClause = searchContent
      ? `body contains "${safeQuery}"`
      : `name contains "${safeQuery}"`;

    // Get names, IDs, and folder for each matching note
    // We use a repeat loop to get all properties, separated by a delimiter
    // Note: Some notes may have inaccessible containers, so we wrap in try/on error
    const searchCommand = `
      set matchingNotes to notes where ${whereClause}
      set resultList to {}
      repeat with n in matchingNotes
        try
          set noteName to name of n
          set noteId to id of n
          set noteFolder to name of container of n
          set end of resultList to noteName & "|||" & noteId & "|||" & noteFolder
        on error
          try
            set noteName to name of n
            set noteId to id of n
            set end of resultList to noteName & "|||" & noteId & "|||" & "Notes"
          end try
        end try
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return resultList as text
    `;
    const script = buildAccountScopedScript({ account: targetAccount }, searchCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to search notes for "${query}":`, result.error);
      return [];
    }

    // Handle empty results
    if (!result.output.trim()) {
      return [];
    }

    // Parse the delimited output: "name|||id|||folder|||ITEM|||name|||id|||folder..."
    const items = result.output.split("|||ITEM|||");

    const notes: Note[] = [];
    for (const item of items) {
      const [title, id, folder] = item.split("|||");
      if (!title?.trim()) continue;
      notes.push({
        id: id?.trim() || Date.now().toString(), // Use real ID, fallback to timestamp
        title: title.trim(),
        content: "", // Not fetched in search
        tags: [] as string[],
        created: new Date(),
        modified: new Date(),
        folder: folder?.trim(),
        account: targetAccount,
      });
    }
    return notes;
  }

  /**
   * Retrieves the HTML content of a note by its title.
   *
   * @param title - Exact title of the note
   * @param account - Account to search in (defaults to iCloud)
   * @returns HTML content of the note, or empty string if not found
   *
   * @example
   * ```typescript
   * const content = manager.getNoteContent("Shopping List");
   * if (content) {
   *   console.log("Note found:", content);
   * }
   * ```
   */
  getNoteContent(title: string, account?: string): string {
    const targetAccount = this.resolveAccount(account);
    const safeTitle = escapeForAppleScript(title);

    // Retrieve the body property of the note
    const getCommand = `get body of note "${safeTitle}"`;
    const script = buildAccountScopedScript({ account: targetAccount }, getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get content of note "${title}":`, result.error);
      return "";
    }

    return result.output;
  }

  /**
   * Retrieves the HTML content of a note by its CoreData ID.
   *
   * This is more reliable than getNoteContent() because IDs are unique
   * across all accounts, while titles can be duplicated.
   *
   * @param id - CoreData URL identifier for the note
   * @returns HTML content of the note, or empty string if not found
   */
  getNoteContentById(id: string): string {
    // Note IDs work at the application level, not scoped to account
    const getCommand = `get body of note id "${id}"`;
    const script = buildAppLevelScript(getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get content of note with ID "${id}":`, result.error);
      return "";
    }

    return result.output;
  }

  /**
   * Retrieves a note by its unique CoreData ID.
   *
   * Each note has a unique ID in the format:
   * "x-coredata://DEVICE-UUID/ICNote/pXXXX"
   *
   * This method fetches the note and its metadata using this ID.
   *
   * @param id - CoreData URL identifier for the note
   * @returns Note object with metadata, or null if not found
   */
  getNoteById(id: string): Note | null {
    // Note IDs work at the application level, not scoped to account
    const getCommand = `
      set n to note id "${id}"
      set noteProps to {name of n, id of n, creation date of n, modification date of n, shared of n, password protected of n}
      return noteProps
    `;
    const script = buildAppLevelScript(getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get note with ID "${id}":`, result.error);
      return null;
    }

    // Parse the complex output
    // AppleScript returns: "title, id, date DayName, Month Day, Year at Time, date..., bool, bool"
    // Dates contain commas, so we can't use simple CSV parsing
    const output = result.output;

    // Extract dates using regex - they start with "date " and end before the next comma-space-lowercase
    // Pattern matches: "date Saturday, December 27, 2025 at 3:44:02 PM"
    const dateMatches =
      output.match(/date [A-Z][^,]*(?:, [A-Z][^,]*)* at \d+:\d+:\d+ [AP]M/g) || [];

    // Extract title (everything before the first comma)
    const firstComma = output.indexOf(",");
    if (firstComma === -1) {
      console.error("Unexpected response format when getting note by ID");
      return null;
    }
    const extractedTitle = output.substring(0, firstComma).trim();

    // Extract ID (between first and second comma)
    const afterTitle = output.substring(firstComma + 1);
    const secondComma = afterTitle.indexOf(",");
    if (secondComma === -1) {
      console.error("Unexpected response format when getting note by ID");
      return null;
    }
    const extractedId = afterTitle.substring(0, secondComma).trim();

    // Extract boolean values from the end (shared, passwordProtected)
    // They appear as ", true" or ", false" at the end
    const boolPattern = /, (true|false), (true|false)$/;
    const boolMatch = output.match(boolPattern);
    const shared = boolMatch ? boolMatch[1] === "true" : false;
    const passwordProtected = boolMatch ? boolMatch[2] === "true" : false;

    return {
      id: extractedId,
      title: extractedTitle,
      content: "", // Not fetched to keep response small
      tags: [],
      created: dateMatches[0] ? parseAppleScriptDate(dateMatches[0]) : new Date(),
      modified: dateMatches[1] ? parseAppleScriptDate(dateMatches[1]) : new Date(),
      shared,
      passwordProtected,
    };
  }

  /**
   * Retrieves detailed metadata for a note by title.
   *
   * Similar to getNoteContent but returns structured metadata
   * including creation date, modification date, and sharing status.
   *
   * @param title - Exact title of the note
   * @param account - Account to search in (defaults to iCloud)
   * @returns Note object with full metadata, or null if not found
   */
  getNoteDetails(title: string, account?: string): Note | null {
    const targetAccount = this.resolveAccount(account);
    const safeTitle = escapeForAppleScript(title);

    // Fetch multiple properties at once
    const getCommand = `
      set n to note "${safeTitle}"
      set noteProps to {name of n, id of n, creation date of n, modification date of n, shared of n, password protected of n}
      return noteProps
    `;
    const script = buildAccountScopedScript({ account: targetAccount }, getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get details for note "${title}":`, result.error);
      return null;
    }

    // Parse the complex output
    // The output contains embedded date objects that complicate simple CSV parsing
    const output = result.output;

    // Extract dates using regex (they have a recognizable format)
    const dateMatches = output.match(/date [^,]+/g) || [];

    // Extract title and ID from the beginning
    const firstComma = output.indexOf(",");
    const extractedTitle = output.substring(0, firstComma).trim();
    const afterTitle = output.substring(firstComma + 1);
    const secondComma = afterTitle.indexOf(",");
    const extractedId = afterTitle.substring(0, secondComma).trim();

    return {
      id: extractedId,
      title: extractedTitle,
      content: "", // Not fetched
      tags: [],
      created: dateMatches[0] ? parseAppleScriptDate(dateMatches[0]) : new Date(),
      modified: dateMatches[1] ? parseAppleScriptDate(dateMatches[1]) : new Date(),
      shared: output.includes("true"),
      passwordProtected: false, // Difficult to parse reliably
      account: targetAccount,
    };
  }

  /**
   * Deletes a note by its title.
   *
   * Note: This permanently deletes the note. It may be recoverable
   * from the "Recently Deleted" folder in Notes.app.
   *
   * @param title - Exact title of the note to delete
   * @param account - Account containing the note (defaults to iCloud)
   * @returns true if deletion succeeded, false otherwise
   */
  deleteNote(title: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeTitle = escapeForAppleScript(title);

    const deleteCommand = `delete note "${safeTitle}"`;
    const script = buildAccountScopedScript({ account: targetAccount }, deleteCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to delete note "${title}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Deletes a note by its CoreData ID.
   *
   * This is more reliable than deleteNote() because IDs are unique
   * across all accounts, while titles can be duplicated.
   *
   * @param id - CoreData URL identifier for the note
   * @returns true if deletion succeeded, false otherwise
   */
  deleteNoteById(id: string): boolean {
    const deleteCommand = `delete note id "${id}"`;
    const script = buildAppLevelScript(deleteCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to delete note with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Updates an existing note's content and optionally its title.
   *
   * Apple Notes derives the title from the first line of the body,
   * so updating content also allows title changes. If newTitle is
   * not provided, the original title is preserved.
   *
   * @param title - Current title of the note to update
   * @param newTitle - New title (optional, keeps existing if not provided)
   * @param newContent - New content for the note body
   * @param account - Account containing the note (defaults to iCloud)
   * @returns true if update succeeded, false otherwise
   */
  updateNote(
    title: string,
    newTitle: string | undefined,
    newContent: string,
    account?: string
  ): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeCurrentTitle = escapeForAppleScript(title);

    // Determine the effective title (new or keep existing)
    const effectiveTitle = newTitle || title;
    const safeEffectiveTitle = escapeForAppleScript(effectiveTitle);
    const safeContent = escapeForAppleScript(newContent);

    // Apple Notes uses HTML body; first <div> becomes the title
    const fullBody = `<div>${safeEffectiveTitle}</div><div>${safeContent}</div>`;

    const updateCommand = `set body of note "${safeCurrentTitle}" to "${fullBody}"`;
    const script = buildAccountScopedScript({ account: targetAccount }, updateCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to update note "${title}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Updates an existing note by its CoreData ID.
   *
   * This is more reliable than updateNote() because IDs are unique,
   * while titles can be duplicated.
   *
   * @param id - CoreData URL identifier for the note
   * @param newTitle - New title (optional, keeps existing if not provided)
   * @param newContent - New content for the note body
   * @returns true if update succeeded, false otherwise
   */
  updateNoteById(id: string, newTitle: string | undefined, newContent: string): boolean {
    // First get the current title if newTitle is not provided
    let effectiveTitle = newTitle;
    if (!effectiveTitle) {
      const note = this.getNoteById(id);
      if (!note) {
        console.error(`Cannot update note: note with ID "${id}" not found`);
        return false;
      }
      effectiveTitle = note.title;
    }

    const safeEffectiveTitle = escapeForAppleScript(effectiveTitle);
    const safeContent = escapeForAppleScript(newContent);

    // Apple Notes uses HTML body; first <div> becomes the title
    const fullBody = `<div>${safeEffectiveTitle}</div><div>${safeContent}</div>`;

    const updateCommand = `set body of note id "${id}" to "${fullBody}"`;
    const script = buildAppLevelScript(updateCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to update note with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Lists all notes in an account, optionally filtered by folder.
   *
   * @param account - Account to list notes from (defaults to iCloud)
   * @param folder - Optional folder to filter by
   * @returns Array of note titles
   */
  listNotes(account?: string, folder?: string): string[] {
    const targetAccount = this.resolveAccount(account);

    // Build command based on whether folder filter is specified
    let listCommand: string;

    if (folder) {
      const safeFolder = escapeForAppleScript(folder);
      listCommand = `get name of notes of folder "${safeFolder}"`;
    } else {
      listCommand = `get name of notes`;
    }

    const script = buildAccountScopedScript({ account: targetAccount }, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error("Failed to list notes:", result.error);
      return [];
    }

    return parseCommaSeparatedList(result.output);
  }

  // ===========================================================================
  // Folder Operations
  // ===========================================================================

  /**
   * Lists all folders in an account.
   *
   * @param account - Account to list folders from (defaults to iCloud)
   * @returns Array of Folder objects
   */
  listFolders(account?: string): Folder[] {
    const targetAccount = this.resolveAccount(account);

    // Get folder names (simpler than getting full objects)
    const listCommand = `get name of folders`;
    const script = buildAccountScopedScript({ account: targetAccount }, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error("Failed to list folders:", result.error);
      return [];
    }

    // Convert names to Folder objects
    const names = parseCommaSeparatedList(result.output);

    return names.map((name) => ({
      id: "", // Would require additional query to get
      name,
      account: targetAccount,
    }));
  }

  /**
   * Creates a new folder in an account.
   *
   * @param name - Name for the new folder
   * @param account - Account to create folder in (defaults to iCloud)
   * @returns Created Folder object, or null on failure
   */
  createFolder(name: string, account?: string): Folder | null {
    const targetAccount = this.resolveAccount(account);
    const safeName = escapeForAppleScript(name);

    const createCommand = `make new folder with properties {name:"${safeName}"}`;
    const script = buildAccountScopedScript({ account: targetAccount }, createCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to create folder "${name}":`, result.error);
      return null;
    }

    // Extract the folder ID from the response
    const folderId = extractCoreDataId(result.output, "folder");

    return {
      id: folderId,
      name,
      account: targetAccount,
    };
  }

  /**
   * Deletes a folder from an account.
   *
   * Note: This may fail if the folder contains notes.
   *
   * @param name - Name of the folder to delete
   * @param account - Account containing the folder (defaults to iCloud)
   * @returns true if deletion succeeded, false otherwise
   */
  deleteFolder(name: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeName = escapeForAppleScript(name);

    const deleteCommand = `delete folder "${safeName}"`;
    const script = buildAccountScopedScript({ account: targetAccount }, deleteCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to delete folder "${name}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Moves a note to a different folder.
   *
   * Since AppleScript doesn't support direct note moves, this operation:
   * 1. Retrieves the source note's content
   * 2. Creates a new note with that content in the destination folder
   * 3. Deletes the original note (only if copy succeeded)
   *
   * This ensures the note is never lost - if the copy fails, the
   * original remains untouched. If only the delete fails, the note
   * exists in the new location (success is still returned).
   *
   * @param title - Title of the note to move
   * @param destinationFolder - Name of the folder to move to
   * @param account - Account containing the note (defaults to iCloud)
   * @returns true if move succeeded (or copy succeeded but delete failed)
   */
  moveNote(title: string, destinationFolder: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);

    // Step 1: Get the original note's ID first (before creating a copy with the same title)
    const originalNote = this.getNoteDetails(title, targetAccount);

    if (!originalNote) {
      console.error(`Cannot move note "${title}": note not found`);
      return false;
    }

    // Step 2: Retrieve the original note's content
    const originalContent = this.getNoteContent(title, targetAccount);

    if (!originalContent) {
      console.error(`Cannot move note "${title}": failed to retrieve content`);
      return false;
    }

    // Step 3: Create a copy in the destination folder
    // We need to escape the HTML content for AppleScript embedding
    const safeFolder = escapeForAppleScript(destinationFolder);
    const safeContent = originalContent.replace(/"/g, '\\"').replace(/'/g, "'\\''");

    const createCommand = `make new note at folder "${safeFolder}" with properties {body:"${safeContent}"}`;
    const script = buildAccountScopedScript({ account: targetAccount }, createCommand);
    const copyResult = executeAppleScript(script);

    if (!copyResult.success) {
      console.error(
        `Cannot move note "${title}": failed to create in destination folder:`,
        copyResult.error
      );
      return false;
    }

    // Step 4: Delete the original by ID (not by title, since there are now two notes with the same title)
    const deleteCommand = `delete note id "${originalNote.id}"`;
    const deleteScript = buildAppLevelScript(deleteCommand);
    const deleteResult = executeAppleScript(deleteScript);

    if (!deleteResult.success) {
      // The note was copied successfully but we couldn't delete the original.
      // This is still a partial success - the note exists in the new location.
      console.error(
        `Note "${title}" was copied to "${destinationFolder}" but original could not be deleted:`,
        deleteResult.error
      );
      return true;
    }

    return true;
  }

  /**
   * Moves a note to a different folder by its CoreData ID.
   *
   * This is more reliable than moveNote() because IDs are unique,
   * while titles can be duplicated.
   *
   * @param id - CoreData URL identifier for the note
   * @param destinationFolder - Name of the folder to move to
   * @param account - Account containing the destination folder (defaults to iCloud)
   * @returns true if move succeeded (or copy succeeded but delete failed)
   */
  moveNoteById(id: string, destinationFolder: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);

    // Step 1: Retrieve the original note's content by ID
    const originalContent = this.getNoteContentById(id);

    if (!originalContent) {
      console.error(`Cannot move note: note with ID "${id}" not found`);
      return false;
    }

    // Step 2: Create a copy in the destination folder
    const safeFolder = escapeForAppleScript(destinationFolder);
    const safeContent = originalContent.replace(/"/g, '\\"').replace(/'/g, "'\\''");

    const createCommand = `make new note at folder "${safeFolder}" with properties {body:"${safeContent}"}`;
    const script = buildAccountScopedScript({ account: targetAccount }, createCommand);
    const copyResult = executeAppleScript(script);

    if (!copyResult.success) {
      console.error(`Cannot move note: failed to create in destination folder:`, copyResult.error);
      return false;
    }

    // Step 3: Delete the original by ID
    const deleteCommand = `delete note id "${id}"`;
    const deleteScript = buildAppLevelScript(deleteCommand);
    const deleteResult = executeAppleScript(deleteScript);

    if (!deleteResult.success) {
      console.error(
        `Note was copied to "${destinationFolder}" but original could not be deleted:`,
        deleteResult.error
      );
      return true; // Partial success - note exists in new location
    }

    return true;
  }

  // ===========================================================================
  // Account Operations
  // ===========================================================================

  /**
   * Lists all available Notes accounts.
   *
   * Common accounts include iCloud, Gmail, Exchange, and other
   * email providers configured on the Mac.
   *
   * @returns Array of Account objects
   */
  listAccounts(): Account[] {
    const listCommand = `get name of accounts`;
    const script = buildAppLevelScript(listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error("Failed to list accounts:", result.error);
      return [];
    }

    // Convert names to Account objects
    const names = parseCommaSeparatedList(result.output);

    return names.map((name) => ({ name }));
  }
}
