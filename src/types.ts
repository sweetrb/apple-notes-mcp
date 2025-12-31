/**
 * Type Definitions for Apple Notes MCP Server
 *
 * This module contains all TypeScript interfaces and types used throughout
 * the Apple Notes MCP server. These types model:
 *
 * - Apple Notes data structures (notes, folders, accounts)
 * - AppleScript execution results
 * - MCP tool parameters
 *
 * @module types
 */

// =============================================================================
// Apple Notes Data Models
// =============================================================================

/**
 * Represents a note in Apple Notes.
 *
 * Notes are the primary data type in Notes.app. Each note has:
 * - A title (derived from the first line of content)
 * - HTML-formatted body content
 * - Timestamps for creation and modification
 * - Optional organization (folders, tags)
 * - Optional metadata (sharing status, password protection)
 *
 * @example
 * ```typescript
 * const note: Note = {
 *   id: "x-coredata://12345/ICNote/p100",
 *   title: "Shopping List",
 *   content: "<div>Shopping List</div><div>- Eggs</div>",
 *   tags: ["personal"],
 *   created: new Date("2025-01-15"),
 *   modified: new Date("2025-01-20"),
 *   folder: "Groceries",
 *   account: "iCloud"
 * };
 * ```
 */
export interface Note {
  /**
   * Unique identifier for the note.
   *
   * This is a CoreData URL in the format:
   * "x-coredata://DEVICE-UUID/ICNote/pXXXX"
   *
   * Note: When creating notes, this may be a temporary timestamp ID
   * until the actual CoreData ID is retrieved.
   */
  id: string;

  /**
   * Display title of the note.
   *
   * In Notes.app, the title is derived from the first line of the note body.
   * Changing the title changes the first line of content.
   */
  title: string;

  /**
   * HTML-formatted body content of the note.
   *
   * Notes.app stores content as HTML. Common elements include:
   * - `<div>` for paragraphs
   * - `<br>` for line breaks
   * - `<b>`, `<i>` for formatting
   * - `<ul>`, `<ol>`, `<li>` for lists
   */
  content: string;

  /**
   * User-defined tags for organization.
   *
   * Note: Apple Notes doesn't natively support tags in its UI,
   * but this field can be used for application-level organization.
   */
  tags: string[];

  /**
   * Timestamp when the note was created.
   */
  created: Date;

  /**
   * Timestamp when the note was last modified.
   *
   * This updates automatically when content changes.
   */
  modified: Date;

  /**
   * Whether the note is shared with other users.
   *
   * Shared notes can be collaborated on via iCloud.
   */
  shared?: boolean;

  /**
   * Whether the note is password protected.
   *
   * Password-protected notes require authentication to view.
   * They cannot be read or modified via AppleScript when locked.
   */
  passwordProtected?: boolean;

  /**
   * Name of the folder containing the note.
   *
   * If undefined, the note is in the account's default location.
   */
  folder?: string;

  /**
   * Name of the account containing the note.
   *
   * Common values: "iCloud", "Gmail", "Exchange"
   */
  account?: string;
}

/**
 * Represents a folder in Apple Notes.
 *
 * Folders provide hierarchical organization for notes within an account.
 * Each account has a default "Notes" folder plus any user-created folders.
 *
 * @example
 * ```typescript
 * const folder: Folder = {
 *   id: "x-coredata://12345/ICFolder/p50",
 *   name: "Work Projects",
 *   account: "iCloud"
 * };
 * ```
 */
export interface Folder {
  /**
   * Unique identifier for the folder.
   *
   * This is a CoreData URL similar to note IDs.
   * May be empty if not retrieved from a detailed query.
   */
  id: string;

  /**
   * Display name of the folder.
   */
  name: string;

  /**
   * Name of the account containing the folder.
   */
  account: string;
}

/**
 * Represents a Notes account.
 *
 * Notes.app can sync with multiple account types:
 * - iCloud (default, most common)
 * - Gmail (via IMAP)
 * - Exchange
 * - Other IMAP providers
 *
 * Each account has its own set of folders and notes.
 *
 * @example
 * ```typescript
 * const account: Account = {
 *   name: "iCloud"
 * };
 * ```
 */
export interface Account {
  /**
   * Display name of the account.
   *
   * This matches what appears in Notes.app's sidebar.
   */
  name: string;
}

// =============================================================================
// AppleScript Execution
// =============================================================================

/**
 * Options for AppleScript execution.
 *
 * Allows customization of execution behavior per operation.
 *
 * @example
 * ```typescript
 * // Use longer timeout for complex operations
 * const result = executeAppleScript(script, { timeoutMs: 60000 });
 * ```
 */
export interface AppleScriptOptions {
  /**
   * Maximum execution time in milliseconds.
   *
   * If the script takes longer than this, execution is aborted
   * and an error is returned. Defaults to 30000 (30 seconds).
   *
   * Recommended values:
   * - Simple queries (get single note): 10000
   * - List operations: 30000
   * - Complex searches on large collections: 60000
   */
  timeoutMs?: number;

  /**
   * Maximum number of retry attempts for transient failures.
   *
   * When set to a value > 1, the executor will retry on transient
   * errors (timeout, "not responding") with exponential backoff.
   * Defaults to 1 (no retries).
   *
   * Recommended values:
   * - Simple operations: 1 (no retry)
   * - Critical operations: 3
   */
  maxRetries?: number;

  /**
   * Initial delay between retries in milliseconds.
   *
   * Uses exponential backoff: delay doubles after each attempt.
   * Defaults to 1000 (1 second).
   *
   * With default settings and maxRetries=3:
   * - Attempt 1: immediate
   * - Attempt 2: 1s delay
   * - Attempt 3: 2s delay
   */
  retryDelayMs?: number;
}

/**
 * Result from executing an AppleScript command.
 *
 * AppleScript commands are executed via the `osascript` command-line tool.
 * This interface wraps the result in a structured format for easy handling.
 *
 * @example
 * ```typescript
 * // Successful result
 * const success: AppleScriptResult = {
 *   success: true,
 *   output: "Note 1, Note 2, Note 3"
 * };
 *
 * // Failed result
 * const failure: AppleScriptResult = {
 *   success: false,
 *   output: "",
 *   error: "Can't get note \"Missing\""
 * };
 * ```
 */
export interface AppleScriptResult {
  /**
   * Whether the script executed successfully.
   *
   * True if osascript returned exit code 0.
   */
  success: boolean;

  /**
   * Output from the script (stdout).
   *
   * Contains the result value for successful queries,
   * or empty string on failure.
   */
  output: string;

  /**
   * Error message if execution failed.
   *
   * Contains parsed error message from osascript stderr.
   * Undefined on successful execution.
   */
  error?: string;
}

// =============================================================================
// MCP Tool Parameters
// =============================================================================

/**
 * Parameters for the create-note tool.
 */
export interface CreateNoteParams {
  /** Title for the new note */
  title: string;

  /** Body content of the note */
  content: string;

  /** Optional tags for organization */
  tags?: string[];

  /** Optional folder to create the note in */
  folder?: string;

  /** Account to use (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the search-notes tool.
 */
export interface SearchParams {
  /** Text to search for */
  query: string;

  /** If true, search note content; if false, search titles only */
  searchContent?: boolean;

  /** Account to search in (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for tools that retrieve a note by title.
 *
 * Used by: get-note-content, get-note-details, delete-note
 */
export interface GetNoteParams {
  /** Exact title of the note */
  title: string;

  /** Account to search in (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the get-note-by-id tool.
 */
export interface GetNoteByIdParams {
  /** CoreData URL identifier for the note */
  id: string;
}

/**
 * Parameters for the delete-note tool.
 */
export interface DeleteNoteParams {
  /** Exact title of the note to delete */
  title: string;

  /** Account containing the note (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the update-note tool.
 */
export interface UpdateNoteParams {
  /** Current title of the note to update */
  title: string;

  /** New title for the note (optional, keeps existing if not provided) */
  newTitle?: string;

  /** New content for the note body */
  newContent: string;

  /** Account containing the note (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the list-notes tool.
 */
export interface ListNotesParams {
  /** Account to list notes from (defaults to iCloud) */
  account?: string;

  /** Filter to notes in a specific folder */
  folder?: string;
}

/**
 * Parameters for folder operations.
 *
 * Used by: create-folder, delete-folder
 */
export interface FolderParams {
  /** Name of the folder */
  name: string;

  /** Account for the folder (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the list-folders tool.
 */
export interface ListFoldersParams {
  /** Account to list folders from (defaults to iCloud) */
  account?: string;
}

/**
 * Parameters for the move-note tool.
 */
export interface MoveNoteParams {
  /** Title of the note to move */
  title: string;

  /** Name of the destination folder */
  folder: string;

  /** Account containing the note (defaults to iCloud) */
  account?: string;
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Individual check result in a health check.
 */
export interface HealthCheckItem {
  /** Name of the check */
  name: string;

  /** Whether the check passed */
  passed: boolean;

  /** Details about the check result */
  message: string;
}

/**
 * Result of a health check operation.
 *
 * Provides detailed status of Notes.app accessibility and functionality.
 *
 * @example
 * ```typescript
 * const result: HealthCheckResult = {
 *   healthy: true,
 *   checks: [
 *     { name: "notes_app", passed: true, message: "Notes.app is accessible" },
 *     { name: "permissions", passed: true, message: "AppleScript permissions granted" },
 *     { name: "accounts", passed: true, message: "Found 2 accounts" }
 *   ]
 * };
 * ```
 */
export interface HealthCheckResult {
  /** Whether all checks passed */
  healthy: boolean;

  /** Individual check results */
  checks: HealthCheckItem[];
}

// =============================================================================
// Attachments
// =============================================================================

/**
 * Represents an attachment in a note.
 *
 * Attachments can be images, files, or other media embedded in a note.
 * Note: The exact position within the note cannot be determined via AppleScript.
 *
 * @example
 * ```typescript
 * const attachment: Attachment = {
 *   id: "x-coredata://ABC/ICAttachment/p1",
 *   name: "photo.jpg",
 *   contentType: "public.jpeg"
 * };
 * ```
 */
export interface Attachment {
  /** Unique identifier for the attachment */
  id: string;

  /** Filename of the attachment */
  name: string;

  /** UTI (Uniform Type Identifier) of the attachment, e.g., "public.jpeg" */
  contentType: string;
}

// =============================================================================
// Notes Statistics
// =============================================================================

/**
 * Statistics for notes per folder.
 */
export interface FolderStats {
  /** Folder name */
  name: string;

  /** Number of notes in the folder */
  noteCount: number;
}

/**
 * Statistics for notes per account.
 */
export interface AccountStats {
  /** Account name */
  name: string;

  /** Total number of notes in the account */
  totalNotes: number;

  /** Number of folders in the account */
  folderCount: number;

  /** Notes per folder */
  folders: FolderStats[];
}

/**
 * Overall statistics about the Notes database.
 *
 * @example
 * ```typescript
 * const stats: NotesStats = {
 *   totalNotes: 150,
 *   accounts: [
 *     { name: "iCloud", totalNotes: 120, folderCount: 5, folders: [...] },
 *     { name: "Gmail", totalNotes: 30, folderCount: 2, folders: [...] }
 *   ],
 *   recentlyModified: { last24h: 5, last7d: 20, last30d: 45 }
 * };
 * ```
 */
export interface NotesStats {
  /** Total number of notes across all accounts */
  totalNotes: number;

  /** Statistics per account */
  accounts: AccountStats[];

  /** Count of recently modified notes */
  recentlyModified: {
    /** Notes modified in the last 24 hours */
    last24h: number;
    /** Notes modified in the last 7 days */
    last7d: number;
    /** Notes modified in the last 30 days */
    last30d: number;
  };
}
