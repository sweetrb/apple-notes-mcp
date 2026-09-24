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
 * A second note that must still be active when `delete-note` runs: it must
 * exist, be unlocked, and sit outside Recently Deleted. With `expectedBody`
 * (the copy-then-retire guard) its body must also still match.
 */
export interface DeleteGuardNote {
  /** Exact CoreData id of the guard note. */
  id: string;
  /** Body the guard note must still have; omitted for requireActiveNoteId. */
  expectedBody?: string;
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
 * What Notes.app reports about one folder, read by exact id for guarded
 * folder deletion (`delete-folder-by-id`).
 */
export interface FolderAppFacts {
  /** Exact x-coredata folder id. */
  id: string;
  /** Current folder name (not a path). */
  name: string;
  /** Parent folder id, or null when the folder sits at an account root. */
  parentId: string | null;
  /** Owning account id. */
  accountId: string;
  /** The owning account's default folder id, when Notes.app reports one. */
  defaultFolderId: string | null;
  /** Whether the folder or any ancestor folder is shared. */
  shared: boolean;
  /** Direct child folders Notes.app lists. */
  childFolderCount: number;
  /** Notes Notes.app lists in the folder. */
  noteCount: number;
}

/**
 * Result of planning or applying `delete-folder-by-id`.
 */
export interface FolderDeleteResult {
  [key: string]: unknown;
  ok: true;
  status: "planned" | "deleted";
  dryRun: boolean;
  committed: boolean;
  wouldDelete: boolean;
  id: string;
  identifier: string;
  name: string;
  accountId: string;
  parentId: string | null;
  folderType: 0;
  childFolderCount: 0;
  noteCount: 0;
  /** Revision token over the checked state; pass it back as expectedRevision. */
  revision: string;
  /** Apply only: Notes.app no longer resolves the folder id. */
  verified?: boolean;
  /** Apply only: the local store shows the row tombstoned or gone. */
  storeTombstoned?: boolean;
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

  /**
   * Largest osascript output, in bytes, this call accepts. Defaults to
   * APPLE_NOTES_MCP_MAX_BUFFER or 64 MB. Note body reads raise it, because a
   * body carries its inline images as base64 and grows with them (#237).
   */
  maxBufferBytes?: number;
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

/**
 * Paper and classic drawing attachments with Notes' rendered raster
 * (read-only NoteStore + Notes group container). Defined next to the reader in
 * utils/paperAttachments and re-exported here with the other public types.
 */
import type { DrawingAttachment } from "@/utils/paperAttachments.js";
export type { DrawingAttachment, ImageInfo } from "@/utils/paperAttachments.js";

/** Result of exporting one drawing's rendered raster. */
export interface DrawingRasterExport {
  drawing: DrawingAttachment;
  savedPath: string;
  bytes: number;
  source: "fallback" | "preview";
  format: "png" | "jpeg";
  width: number;
  height: number;
}

/**
 * Attachment asset/preview discovery, first-image, and batch-export shapes
 * (read-only NoteStore + Notes group container). Defined next to the reader in
 * utils/attachmentAssets and re-exported here with the other public types.
 */
export type {
  AttachmentKind,
  AttachmentAssetRecord,
  NoteAttachmentAssets,
  FirstImage,
  AttachmentExportResult,
} from "@/utils/attachmentAssets.js";

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
  /**
   * Set when this note alone exceeded the export response budget and its
   * oversized inline images were replaced with text placeholders; the value is
   * how many were replaced (#162).
   */
  strippedImages?: number;
  /**
   * True when this note alone exceeded the export response budget even without
   * its large images, so `content` (and `plaintext`, if that still did not fit)
   * is returned empty. Read the note with get-note-content instead (#162).
   */
  contentOmitted?: boolean;
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
    /** Notes included in this export (this page) */
    totalNotes: number;
    totalFolders: number;
    totalAccounts: number;
  };
  /** Which slice of the library this export holds (#162) */
  page: ExportPage;
}

/**
 * Position of one export page within the whole library (#162).
 *
 * Notes are numbered 0..totalAvailable-1 in account, folder, note order, after
 * any modifiedSince filter.
 */
export interface ExportPage {
  /** Position of the first note this page considered */
  offset: number;
  /** Maximum notes this page could hold */
  limit: number;
  /** Notes in the library (after modifiedSince) */
  totalAvailable: number;
  /** Notes included in this page */
  returned: number;
  /** Offset for the next page; absent on the last page */
  nextOffset?: number;
  /** Whether notes remain after this page */
  hasMore: boolean;
  /** Whether the page closed early to stay under the response size budget */
  stoppedAtSizeLimit: boolean;
}

/**
 * Options for exportNotesAsJson (#162).
 */
export interface ExportNotesOptions {
  /** Position to start from (default 0) */
  offset?: number;
  /** Maximum notes in the page (default DEFAULT_EXPORT_PAGE_SIZE) */
  limit?: number;
  /** ISO 8601 date; only notes modified on or after it are exported */
  modifiedSince?: string;
  /** Response size budget in bytes (default exportMaxResponseBytes()) */
  maxResponseBytes?: number;
}

// =============================================================================
// Classic PencilKit drawings (public native helper)
// =============================================================================

/** sRGB color of a drawing stroke; channels 0-255, alpha 0-1. */
export interface DrawingColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** Axis-aligned rectangle in drawing coordinates (points). */
export interface DrawingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One control point of a stroke, already in drawing coordinates. */
export interface DrawingPoint {
  x: number;
  y: number;
  width: number;
  opacity: number;
  force: number;
}

/** One PencilKit stroke. */
export interface DrawingStroke {
  /** PencilKit ink identifier, e.g. "com.apple.ink.pen" or "com.apple.ink.marker". */
  inkType: string;
  color: DrawingColor;
  /** Mean control-point width. */
  width: number;
  pointCount: number;
  bounds: DrawingBounds;
  /** Control points; omitted when the caller asked for includePoints: false. */
  points?: DrawingPoint[];
  /** True when the stroke carried a non-identity transform, already applied to its points. */
  transformApplied?: boolean;
}

/** Decode outcome for one classic drawing attachment. */
export interface NoteDrawing {
  /** x-coredata attachment id. */
  attachmentId: string;
  /** Notes UUID of the attachment. */
  identifier: string;
  /** "com.apple.drawing" or "com.apple.drawing.2". */
  typeUti: string;
  /** ok = decoded; error = see code and message. */
  status: "ok" | "error";
  code?: string;
  message?: string;
  strokeCount?: number;
  bounds?: DrawingBounds;
  strokes?: DrawingStroke[];
  /** True when the helper stopped at its stroke or point limit. */
  truncated?: boolean;
  /** Standalone SVG document, when format is "svg" or "both". */
  svg?: string;
}

// =============================================================================
// On-device transcription (public native helper)
// =============================================================================

/**
 * ok = complete transcript; partial = some audio transcribed (a take failed or
 * the helper stopped at its deadline); error = nothing transcribed, with a
 * code; indeterminate = the helper did not answer in time, so the outcome is
 * unknown and a retry may succeed.
 */
export type TranscriptionStatus = "ok" | "partial" | "error" | "indeterminate";

/** One audio file (a recording take, or a plain audio attachment). */
export interface TranscribedTake {
  attachmentId: string;
  identifier: string;
  status: TranscriptionStatus;
  code?: string;
  message?: string;
  durationSeconds?: number;
  wordCount?: number;
  /** "SpeechAnalyzer" (macOS 26+) or "SFSpeechRecognizer" (older, on-device only). */
  engine?: string;
}

/** One audio attachment and its combined transcript. */
export interface TranscribedRecording {
  attachmentId: string;
  identifier: string;
  typeUti: string;
  status: TranscriptionStatus;
  code?: string;
  message?: string;
  durationSeconds?: number;
  wordCount?: number;
  /** Takes joined in stored order; omitted when includeText is false. */
  transcript?: string;
  /** True when the transcript was shortened to fit the response size limit. */
  transcriptTruncated?: boolean;
  takes: TranscribedTake[];
}

/** Result of transcribe-note-audio. */
export interface NoteTranscriptionResult {
  id: string;
  /** BCP-47 locale requested. */
  locale: string;
  /** Aggregate over recordings; "none" when the note has no audio. */
  status: TranscriptionStatus | "none";
  recordingCount: number;
  recordings: TranscribedRecording[];
}

/** Result of get-note-drawings. */
export interface NoteDrawingsResult {
  id: string;
  drawingCount: number;
  /** ok = all decoded, partial = some, error = none, none = the note has no classic drawing. */
  status: "ok" | "partial" | "error" | "none";
  drawings: NoteDrawing[];
}

// =============================================================================
// Database-Backed Listings
// =============================================================================

/** Which set of notes `list-special-notes` returns. */
export type SpecialNoteKind = "pinned" | "quick-notes" | "recently-deleted" | "locked";

/**
 * One note row from `list-special-notes`. Metadata only: no body text. Fields
 * the store cannot answer on this macOS version are null or false.
 */
export interface SpecialNoteRow {
  /** MCP note id (`x-coredata://<store>/ICNote/p<n>`). */
  id: string;
  /** The note's Notes UUID (ZIDENTIFIER). */
  identifier: string | null;
  title: string | null;
  /** Folder path in list-folders syntax, or null for a folderless note. */
  folder: string | null;
  account: string | null;
  created: string | null;
  modified: string | null;
  pinned: boolean;
  locked: boolean;
  quickNote: boolean;
  inRecentlyDeleted: boolean;
  /** A tombstone Notes has deleted and is waiting to sync away. */
  markedForDeletion: boolean;
  /** Stored preview snippet. Never returned for locked notes. */
  snippet?: string | null;
  /** Password hint, returned only by the `locked` listing when one is set. */
  passwordHint?: string;
}

/** Result of `list-special-notes`. */
export interface SpecialNotesResult {
  kind: SpecialNoteKind;
  notes: SpecialNoteRow[];
  count: number;
  /** Matching notes before `limit` was applied. */
  total: number;
  limit: number;
  /** False when this macOS version's database cannot answer the listing. */
  supported: boolean;
  /** The resolved account name when the listing was scoped to one account. */
  account?: string;
}

/** One tag in the account-wide native tag inventory. */
export interface NativeTagInventoryEntry {
  /** Display spelling (the most used one when notes spell it differently). */
  tag: string;
  /** Distinct notes that use the tag. */
  noteCount: number;
  /** Per-account note counts, keyed by account name. */
  accounts: Record<string, number>;
  /** Other spellings seen for the same tag (Notes matches tags case-insensitively). */
  spellings?: string[];
}

/** Result of `list-native-tags` in account-wide mode. */
export interface NativeTagInventory {
  inventory: NativeTagInventoryEntry[];
  tagCount: number;
  /** False when some tagged notes could not be confirmed against their body. */
  complete: boolean;
  /** Notes counted from tag objects alone because their body could not be decoded. */
  unverifiedNotes: number;
  /** The resolved account name when the inventory was scoped to one account. */
  account?: string;
}

// =============================================================================
// Stored audio transcripts (get-audio-transcripts)
// =============================================================================

/** One recognized word with its position in the recording. */
export interface TranscriptSegment {
  text: string;
  /** Seconds from the start of its fragment. */
  start?: number;
  /** Seconds. */
  duration?: number;
  speaker?: string;
  /** 0-based fragment index, present only when the recording has several fragments. */
  fragment?: number;
}

export type TranscriptStatus = "ok" | "none" | "undecodable";

/** One top-level audio attachment of a note, in body order. */
export interface AudioTranscript {
  attachmentId: string;
  identifier: string;
  typeUti: string;
  status: TranscriptStatus;
  reason?: string;
  durationSeconds?: number;
  needsTranscription?: boolean;
  fragmentCount?: number;
  wordCount?: number;
  text?: string;
  textTruncated?: boolean;
  speakers?: string[];
  summary?: string;
  topLineSummary?: string;
  segments?: TranscriptSegment[];
  segmentsTruncated?: boolean;
}

export interface AudioTranscriptsResult {
  id: string;
  attachments: AudioTranscript[];
  /** False when the body could not be parsed and attachments are in database order. */
  bodyOrder: boolean;
  /** True when segments or text were dropped to fit the response size limit. */
  truncated: boolean;
}

/** Options for AppleNotesManager.getAudioTranscripts. */
export interface AudioTranscriptOptions {
  /** Include word-level segments (default false). */
  includeSegments?: boolean;
  /** Cap on segments returned per attachment (default 2000, at most 20000). */
  maxSegments?: number;
}

/**
 * One native table read by get-note-tables, in note body order.
 *
 * `complete` is false when the table could not be decoded at all (`reason` says
 * why, and no rows are returned) or when some cells could not be decoded
 * (listed in `incompleteCells`, and `null` in `rows`). Cell text is never guessed.
 */
export interface NoteTable {
  /** 1-based position among the note's tables, in body order */
  index: number;
  /** Native attachment identifier (UUID) of the table */
  id: string;
  /** CoreData id of the table attachment, when known */
  attachmentId?: string;
  /** True only when every cell was decoded */
  complete: boolean;
  /** Why the table or some of its cells could not be decoded */
  reason?: string;
  /** Cell text by row then column, in display order; null marks an undecoded cell */
  rows?: Array<Array<string | null>>;
  /** Stable CRDT row identifiers, parallel to `rows` */
  rowIds?: string[];
  /** Stable CRDT column identifiers, parallel to each row */
  columnIds?: string[];
  /** Number of rows */
  rowCount?: number;
  /** Number of columns */
  columnCount?: number;
  /** Cells that could not be decoded (zero-based display positions) */
  incompleteCells?: Array<{ row: number; column: number; reason: string }>;
  /** GitHub-flavored Markdown rendering; the first row is the header row */
  markdown?: string;
}

/**
 * Result of reading every native table in one note.
 */
export interface NoteTablesResult {
  /** Tables in body order */
  tables: NoteTable[];
  /** True when every table and every cell was decoded */
  tableCellsComplete: boolean;
  /** All tables as Markdown in body order, separated by blank lines */
  markdown: string;
}

/**
 * How a smart folder's top-level filters combine: every filter ("all"), at
 * least one ("any"), or none of them ("none").
 */
export type SmartFolderMatch = "all" | "any" | "none";

/**
 * One decoded smart folder filter.
 *
 * `type` is the stored clause key (for example `folder`, `tag`, `checklist`,
 * `creationDateRelativeRange`), `"group"` for a nested all/any group, or
 * `"unknown"` for a clause this server does not recognize (kept verbatim in
 * `value`). `excluded` marks a negated filter.
 */
export interface SmartFolderFilter {
  type: string;
  /** Stored value of the clause */
  value?: unknown;
  /** Stored clause key, set only for `unknown` filters */
  key?: string;
  /** True when the filter is negated (an Exclude rule) */
  excluded?: boolean;
  /** Human-readable summary of the filter */
  description: string;
  /** Display name: folder title, tag display text, or attachment category */
  name?: string;
  /** CoreData id of a referenced folder (folder filters) */
  folderId?: string;
  /** ISO 8601 bounds of an absolute date range */
  from?: string;
  to?: string;
  /** How a nested group's filters combine */
  match?: "all" | "any";
  /** Filters of a nested group */
  filters?: SmartFolderFilter[];
}

/**
 * A smart folder read from the NoteStore database.
 */
export interface SmartFolder {
  /** CoreData id (x-coredata://…/ICFolder/pN) */
  id: string;
  /** Stable CloudKit identifier (ZIDENTIFIER) */
  identifier: string | null;
  name: string | null;
  account: string | null;
  /** CoreData id of the owning account */
  accountId: string | null;
  accountIdentifier: string | null;
  /** Parent folder name; null at the account root */
  parent: string | null;
  parentId: string | null;
  parentIdentifier: string | null;
  /** How the top-level filters combine; null when no query is stored */
  match: SmartFolderMatch | null;
  filters: SmartFolderFilter[];
  /** From the stored wrapper: false when Recently Deleted is excluded */
  includesRecentlyDeleted?: boolean;
  /** False when a clause was not recognized or the query could not be parsed */
  fullyDecoded: boolean;
  /** Stored query with the outer `deleted` wrapper removed */
  query: unknown;
  /** Stored query JSON, verbatim */
  rawQuery: string | null;
  /** Notes Notes.app lists in this smart folder (only when requested) */
  matchingNotes?: Array<{ title: string; id: string }>;
  /** Total notes Notes.app lists in this smart folder (only when requested) */
  matchingNoteCount?: number;
  /** Why matching notes could not be listed (only when requested) */
  matchingNotesError?: string;
}

// =============================================================================
// Query Language Types
// =============================================================================

/** A part of a note where a search phrase was found. */
export type SearchMatchLocation = "title" | "body";

/**
 * Optional per-result enrichments shared by search-notes and query-notes.
 * Both come from note text the search already decoded, or from one batched
 * read-only database query, never from a per-note AppleScript call.
 */
export interface SearchMatchDetails {
  /**
   * Where the search text occurs: "title", "body" (the text after the first
   * line), or both. Absent when the note text was not available to check
   * (locked or undecodable notes, or an AppleScript search without
   * includeWordCount) or the query has no text term. Empty when the note
   * matched only through a metadata branch such as `pinned OR x`.
   */
  matchedIn?: SearchMatchLocation[];
  /**
   * Words in the note's decoded text (includeWordCount only): whitespace-
   * delimited tokens holding a letter or digit, the same count the query-notes
   * `words:` filter uses. Null when the body is locked or unreadable.
   */
  wordCount?: number | null;
}

/**
 * One note matched by the query-notes tool.
 */
export interface QueryNotesHit extends SearchMatchDetails {
  /** CoreData note ID, accepted by get-note-content and every other id tool */
  id: string;
  /** Note title as stored in the database */
  title: string;
  /** Folder path in list-folders syntax; absent for folderless notes */
  folder?: string;
  /** Account name; absent when the folder's account cannot be resolved */
  account?: string;
  /** Last modification time, ISO 8601 (UTC) */
  modified?: string;
  /** Creation time, ISO 8601 (UTC) */
  created?: string;
  /** Short plain-text excerpt, centred on the first matched phrase when possible; empty for locked notes */
  snippet: string;
  /** Present and true when the note is password-protected */
  locked?: boolean;
}

/**
 * Result of the query-notes tool.
 */
export interface QueryNotesResult {
  /** Matching notes, most recently modified first, at most `limit` */
  notes: QueryNotesHit[];
  /** Number of notes returned */
  count: number;
  /** Number of scanned notes that matched (may exceed `count`) */
  matched: number;
  /** Number of notes examined */
  scanned: number;
  /** Notes eligible for scanning (after deleted/folderless exclusion) */
  eligible: number;
  /** Scan window applied: the most recently modified N notes */
  scanLimit: number;
  /** True when older eligible notes were outside the scan window */
  scanTruncated: boolean;
  /** Result cap applied */
  limit: number;
  /** True when more notes matched than were returned */
  truncated: boolean;
  /** Notes whose body was needed but could not be decoded (locked notes excluded) */
  unreadable: number;
}

// =============================================================================
// Link Insertion Types
// =============================================================================

/**
 * How insert-link writes a URL: `raw` shows the URL itself, `hyperlink`
 * shows a label that links to the URL.
 */
export type LinkInsertMode = "raw" | "hyperlink";

/** Where insert-link places the link paragraph. */
export type LinkInsertPosition = "end" | "after-title";

/**
 * Parameters for inserting one web or Notes link into an existing note.
 */
export interface InsertLinkParams {
  /** Exact CoreData note id */
  id: string;
  /** Revision token from get-note-content */
  expectedContentHash: string;
  /** Link destination (http, https, mailto, notes, applenotes) */
  url: string;
  /** raw (default) or hyperlink */
  mode: LinkInsertMode;
  /** Visible text for hyperlink mode */
  label?: string;
  /** Raw mode only: false writes the URL as plain text with no stored link */
  linked?: boolean;
  /** end (default) or after-title */
  position: LinkInsertPosition;
  /** Leave a blank line between existing text and the link paragraph (default true) */
  blankLine: boolean;
  /** Unique existing phrase, required when the note holds native objects */
  scopeText?: string;
}

/**
 * What the guarded append step reports back to insert-link.
 */
export interface LinkAppendOutcome {
  /** "applescript" for ordinary notes, "native" for notes with native objects */
  route: "applescript" | "native";
  /** Revision token after the write */
  contentHash: string;
}

/**
 * Result of a verified link insertion.
 */
export interface InsertLinkResult {
  ok: true;
  id: string;
  mode: LinkInsertMode;
  url: string;
  /** Visible text written (the URL in raw mode, the label in hyperlink mode) */
  text: string;
  position: LinkInsertPosition;
  route: "applescript" | "native";
  /** Whether the note stores a link attribute on the inserted text */
  linkStored: boolean;
  /** Destination read back from the note's stored links */
  storedUrl?: string;
  previousContentHash: string;
  contentHash: string;
}

/**
 * A request to export one note or one folder as a presentation document
 * (export-notes-markdown, export-notes-html). Exactly one of `id` or `folder`
 * is set.
 */
export interface NotesExportRequest {
  /** Exact CoreData note id. */
  id?: string;
  /** Folder path, as accepted by list-notes. */
  folder?: string;
  /** Account holding `folder` (defaults to Notes.app's default account). */
  account?: string;
  /** Maximum notes read from `folder`. */
  limit?: number;
  /** Absolute file to create. Create-only: an existing file is refused. */
  outputPath?: string;
  /** Absolute directory that receives copies of attachment files. */
  assetsDir?: string;
  /** Hard-wrap prose at this many columns (Markdown only; 0 disables). */
  wrap?: number;
  /**
   * HTML only: embed assets as data URLs (default true unless `assetsDir` is
   * set). False copies them to a sidecar directory.
   */
  embedAssets?: boolean;
  /** Render through this template: a built-in name or a saved template's name. */
  template?: string;
  /** Render through the template in this JSON file (exclusive with `template`). */
  templateFile?: string;
}

/** The template an export used. */
export interface NotesExportTemplateInfo {
  name: string;
  /** `builtin`, a `saved` library template, or a one-off template `file`. */
  source: "builtin" | "saved" | "file";
}

/** A problem that did not stop a templated export. */
export interface NotesExportWarning {
  /** Stable code, such as `missing_asset` or `table_decode_failed`. */
  code: string;
  noteId: string;
  attachmentId?: string;
}

/** Counts of how attachments were rendered in an export. */
export interface NotesExportAttachmentStats {
  attachments: number;
  placed: number;
  placeholders: number;
  unavailable: number;
  tables: number;
  unreadableTables: number;
  unreferenced: number;
}

/** A note that was selected but could not be exported. */
export interface NotesExportSkip {
  id: string;
  /** Stable reason code, such as `encrypted` or `not-found`. */
  code: string;
}

/** The bounded result of an export. */
export interface NotesExportReceipt {
  format: "markdown" | "html";
  /** Notes rendered into the document. */
  count: number;
  /** UTF-8 size of the document. */
  bytes: number;
  /** The document itself, only when no outputPath was given. */
  markdown?: string;
  /** Absolute path of the file written. */
  output?: string;
  /** Sidecar directory and the number of files copied into it. */
  assets?: { dir: string; files: number };
  /** HTML only: assets embedded as data URLs. */
  embedded?: number;
  stats: NotesExportAttachmentStats;
  skipped: NotesExportSkip[];
  /** Templated exports only: the template used. */
  template?: NotesExportTemplateInfo;
  /** Templated exports only: problems that did not stop the export. */
  warnings?: NotesExportWarning[];
  /** Warnings beyond the listed ones. */
  warningsOmitted?: number;
  /** Templated exports only: absolute paths of asset files written or reused. */
  assetFiles?: string[];
}

/**
 * What add-attachment-from-pasteboard took from the pasteboard.
 */
export interface PasteboardAttachmentSource {
  /** "file" = a copied file's bytes; "data" = image or PDF bytes. */
  kind: "file" | "data";
  /** Pasteboard type (UTI) that was read, e.g. "public.png" or "public.file-url". */
  type: string;
  /** Default attachment name for the pasted content, before any filename override. */
  filename: string;
}

// =============================================================================
// Database-Backed Recent Listing and Folder Tree
// =============================================================================

/** One row of `list-recent-notes`. Metadata unless a body option was requested. */
export interface RecentNoteRow {
  /** MCP note id (`x-coredata://<store>/ICNote/p<n>`). */
  id: string;
  /** The note's Notes UUID (ZIDENTIFIER). */
  identifier: string | null;
  title: string | null;
  /** Folder path in list-folders syntax, or null for a folderless note. */
  folder: string | null;
  account: string | null;
  created: string | null;
  /** Modification time in ISO 8601 (millisecond precision). */
  modified: string | null;
  /**
   * Opaque sync cursor: the exact stored modification timestamp plus the
   * note's database key. Pass it back as `since` to list only notes that sort
   * after this one. Null when the note has no modification date.
   */
  modifiedCheckpoint: string | null;
  pinned: boolean;
  locked: boolean;
  inRecentlyDeleted: boolean;
  markedForDeletion: boolean;
  /** Words in the decoded body; null when the body is locked or unavailable. */
  wordCount?: number | null;
  /** Characters (code points) in the decoded body, attachment markers excluded. */
  charCount?: number | null;
  /** Up to 180 characters: the decoded body when decoded, else the stored snippet. */
  bodyPreview?: string | null;
  /** Whether bodyPreview and the counts came from the decoded body. */
  textDecoded?: boolean;
}

/** Result of `list-recent-notes`. */
export interface RecentNotesResult {
  notes: RecentNoteRow[];
  count: number;
  limit: number;
  /**
   * Row order: `oldest-first` for a `since` query (sync), `newest-first`
   * without one (browse).
   */
  order: "oldest-first" | "newest-first";
  /**
   * True when count reached limit. With `since`, more changes may follow:
   * call again with `nextSince`. Without `since`, older notes were cut off.
   */
  saturated: boolean;
  /**
   * Cursor to pass as the next `since`. With `since`, the last returned row's
   * cursor, or the incoming boundary when nothing matched, so every call
   * advances. Without `since`, the newest row's cursor, set only when the call
   * returned every matching note. Null when there is no complete cursor.
   */
  nextSince: string | null;
  account?: string;
  folder?: string;
}

/** One node of `list-folder-tree`. */
export interface FolderTreeNode {
  /** MCP folder id (`x-coredata://<store>/ICFolder/p<n>`). */
  id: string;
  identifier: string | null;
  name: string;
  /** Full path in list-folders syntax. */
  path: string;
  kind: "folder" | "trash" | "smart";
  /** Notes directly in this folder (tombstones excluded). */
  noteCount: number;
  /** Notes in this folder and every descendant folder. */
  totalNoteCount: number;
  /** Present only when deleted folders were requested. */
  markedForDeletion?: boolean;
  children: FolderTreeNode[];
}

/** One account's folders in `list-folder-tree`. */
export interface FolderTreeAccount {
  account: string;
  identifier: string | null;
  noteCount: number;
  folders: FolderTreeNode[];
}

/** Result of `list-folder-tree`. */
export interface FolderTreeResult {
  accounts: FolderTreeAccount[];
  folderCount: number;
}
