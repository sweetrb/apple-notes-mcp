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
   * Application-level tags supplied at create time.
   *
   * This is a pass-through convenience field: Apple Notes does NOT store these
   * in any scriptable property. Apple's own "tags" are inline `#hashtag` tokens
   * typed into the note body — surface those with `parseHashtags` (the
   * `get-note-content` tool returns them as `hashtags` in its structuredContent).
   * See docs/APPLESCRIPT-LIMITATIONS.md and issue #29.
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

  /**
   * Whether the folder is shared with collaborators.
   */
  shared?: boolean;
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

  /**
   * Unique identifier for the account.
   */
  id?: string;

  /**
   * Whether the account has been upgraded to the modern Notes format.
   */
  upgraded?: boolean;

  /**
   * Name of the account's default folder.
   */
  defaultFolder?: string;

  /**
   * Unique identifier for the account's default folder.
   */
  defaultFolderId?: string;
}

/**
 * The default Notes location for newly created notes.
 */
export interface DefaultLocation {
  /** Default account used by Notes.app */
  account: Account;

  /** Default folder inside the default account */
  folder: Folder;
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
   * Maximum execution time in milliseconds for the complete operation,
   * including retries and retry delays.
   *
   * If the operation takes longer than this, execution is aborted
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
   * Defaults to 2 (one retry).
   *
   * Mutation safety:
   * Mutating operations override this to 1 because a timed-out write may have
   * completed in Notes.app before the response was lost.
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
 *   contentType: "cid:1A2B3C@icloud.apple.com"
 * };
 * ```
 */
export interface Attachment {
  /** Unique identifier for the attachment */
  id: string;

  /**
   * Filename of the attachment. Empty when Notes reports no name and no content
   * identifier is available — never the literal string "missing value".
   */
  name: string;

  /**
   * Content identifier of the attachment, e.g. "cid:1A2B3C@icloud.apple.com".
   *
   * Despite the field name this is NOT a UTI — Notes' AppleScript dictionary
   * exposes no MIME type or UTI for attachments, so this mirrors {@link contentId}.
   * Kept for backwards compatibility with existing consumers.
   */
  contentType: string;

  /** Content-id URL used in the note's HTML body. */
  contentId?: string;

  /** URL represented by URL/link attachments, when available. */
  url?: string;

  /** Timestamp when the attachment was created. */
  created?: Date;

  /** Timestamp when the attachment was last modified. */
  modified?: Date;

  /** Whether the attachment is shared with collaborators. */
  shared?: boolean;
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
/**
 * A scope (account, folder set, or activity scan) that could not be read during
 * a multi-scope operation. Lets callers tell a genuine empty result apart from a
 * partial failure. See issue #19.
 */
export interface ScopeWarning {
  /** What couldn't be read — an account name, or a label like "recent-activity". */
  scope: string;

  /** Why it failed (AppleScript error text). */
  reason: string;
}

/**
 * Coverage report for an operation that scans several independent scopes. When
 * `complete` is false the result is partial: the data for the listed `warnings`
 * scopes is missing or zeroed, not genuinely empty.
 */
export interface Coverage {
  /** True when every scanned scope was read successfully. */
  complete: boolean;

  /** Number of scopes attempted. */
  scanned: number;

  /** Number of scopes successfully read. */
  covered: number;

  /** Per-scope failures; empty when `complete` is true. */
  warnings: ScopeWarning[];
}

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

  /**
   * Coverage diagnostics (#19). If `coverage.complete` is false, one or more
   * accounts (or the recent-activity scan) could not be read, and the numbers
   * above reflect only the scopes that succeeded.
   */
  coverage: Coverage;
}

// =============================================================================
// Export Types
// =============================================================================

/**
 * Exported note data structure.
 */
export interface ExportedNote {
  /** Unique identifier */
  id: string;
  /** Note title */
  title: string;
  /** HTML content (empty for password-protected notes) */
  content: string;
  /** Plain text content (extracted from HTML) */
  plaintext: string;
  /** Folder containing the note */
  folder: string;
  /** Account containing the note */
  account: string;
  /** Creation timestamp (ISO 8601) */
  created: string;
  /** Last modification timestamp (ISO 8601) */
  modified: string;
  /** Whether note is shared with collaborators */
  shared: boolean;
  /** Whether note is password protected */
  passwordProtected: boolean;
}

/**
 * Exported folder data structure.
 */
export interface ExportedFolder {
  /** Folder name */
  name: string;
  /** Notes in this folder */
  notes: ExportedNote[];
}

/**
 * Exported account data structure.
 */
export interface ExportedAccount {
  /** Account name (e.g., "iCloud") */
  name: string;
  /** Folders in this account */
  folders: ExportedFolder[];
}

/**
 * Complete export data structure.
 *
 * @example
 * ```typescript
 * const export: NotesExport = {
 *   exportDate: "2025-01-01T12:00:00.000Z",
 *   version: "1.0",
 *   accounts: [...],
 *   summary: { totalNotes: 100, totalFolders: 10, totalAccounts: 2 }
 * };
 * ```
 */
export interface NotesExport {
  /** ISO 8601 timestamp of when export was created */
  exportDate: string;
  /** Export format version */
  version: string;
  /** All accounts with their folders and notes */
  accounts: ExportedAccount[];
  /** Summary statistics */
  summary: {
    totalNotes: number;
    totalFolders: number;
    totalAccounts: number;
  };
}
