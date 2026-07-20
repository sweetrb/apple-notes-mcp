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

import type {
  Note,
  Folder,
  Account,
  DefaultLocation,
  HealthCheckResult,
  HealthCheckItem,
  NotesStats,
  AccountStats,
  FolderStats,
  ScopeWarning,
  Attachment,
  NotesExport,
  ExportedAccount,
  ExportedFolder,
  ExportedNote,
} from "@/types.js";
import { BULK_LIST_MUTATION_ERROR, executeAppleScript } from "@/utils/applescript.js";
import { getChecklistItems, type ChecklistItem } from "@/utils/checklistParser.js";
import {
  assertSafeSavePath,
  readFileBase64Capped,
  fileSize,
  makeTempDir,
  cleanupTempDir,
  ensureParentDir,
} from "@/utils/attachmentFs.js";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import TurndownService from "turndown";

// =============================================================================
// Result delimiters (#18)
//
// AppleScript output is delimited with ASCII control characters that cannot
// appear in user-entered note titles, folder names, or body text — unlike the
// old printable "|||" / "," / "ITEM" tokens, which collide with ordinary
// content (a note titled "Groceries, etc." used to split into phantom notes).
//   FIELD_SEP  (US, \x1f) separates fields within a record
//   RECORD_SEP (RS, \x1e) separates records within a list
// In AppleScript these are emitted via `ASCII character 31 / 30`.
// =============================================================================
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const AS_FIELD_SEP = "(ASCII character 31)";
const AS_RECORD_SEP = "(ASCII character 30)";

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
 * Escapes already-HTML content for embedding in AppleScript string literals.
 *
 * Unlike escapeForAppleScript(), this function is designed for content that
 * is already HTML (e.g., from getNoteContent()). It only escapes the
 * AppleScript string delimiter (double quotes) and handles backslashes,
 * without re-encoding HTML entities.
 *
 * @param htmlContent - HTML content from Notes.app
 * @returns Content safe for AppleScript string embedding
 *
 * @example
 * escapeHtmlForAppleScript('<div>Hello "World"</div>')
 * // Returns: <div>Hello \"World\"</div>
 */
export function escapeHtmlForAppleScript(htmlContent: string): string {
  if (!htmlContent) {
    return "";
  }

  // For already-HTML content, we only need to:
  // 1. Escape backslashes for AppleScript (\ → \\)
  // 2. Escape double quotes for AppleScript (" → \")
  //
  // We do NOT re-encode HTML entities since content is already HTML from Notes.app
  return htmlContent.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escapes a plain (non-HTML) string for safe embedding in an AppleScript string literal.
 *
 * Use this for folder names, account names, and other metadata that Apple Notes
 * stores as plain text — NOT for note body content (use escapeForAppleScript instead).
 * HTML-encoding ampersands here would produce `folder "R&amp;D"`, which Apple Notes
 * would fail to match against the real folder named "R&D".
 *
 * @param text - Plain string (folder name, account name, etc.)
 * @returns String safe for AppleScript string embedding
 */
export function escapePlainStringForAppleScript(text: string): string {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// =============================================================================
// Input Validation & Sanitization
// =============================================================================

/** Maximum allowed length for note titles */
const MAX_TITLE_LENGTH = 2000;

/** Maximum allowed length for note content (5 MB of text) */
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

/** Maximum allowed length for folder names/paths */
const MAX_FOLDER_PATH_LENGTH = 1000;

/** Maximum allowed length for account names */
const MAX_ACCOUNT_LENGTH = 200;

/** Maximum nesting depth for folder paths */
const MAX_FOLDER_DEPTH = 20;

/**
 * Validates and constrains string input length.
 *
 * @param value - The input string
 * @param maxLength - Maximum allowed length
 * @param label - Human-readable label for error messages
 * @returns The validated string
 * @throws Error if input exceeds maximum length
 */
function validateLength(value: string, maxLength: number, label: string): string {
  if (value.length > maxLength) {
    throw new Error(
      `${label} exceeds maximum length of ${maxLength} characters (got ${value.length})`
    );
  }
  return value;
}

/**
 * Sanitizes a CoreData ID for safe embedding in AppleScript.
 *
 * CoreData IDs follow the pattern: x-coredata://UUID/ICNote/pNNN
 * This function validates the format and escapes the value for AppleScript.
 *
 * @param id - CoreData URL identifier
 * @returns Escaped ID safe for AppleScript string embedding
 * @throws Error if ID format is invalid
 */
export function sanitizeId(id: string): string {
  // CoreData IDs should match: x-coredata://hex-hex-hex-hex-hex/ICEntity/pDigits
  // or temp-timestamp-counter format from generateFallbackId()
  const coreDataPattern = /^x-coredata:\/\/[0-9A-Fa-f-]+\/IC[A-Za-z]+\/p\d+$/;
  const tempIdPattern = /^temp-\d+-\d+$/;
  if (!coreDataPattern.test(id) && !tempIdPattern.test(id)) {
    throw new Error(
      `Invalid note ID format: "${id.substring(0, 80)}". Expected CoreData URL (x-coredata://...) or temp ID.`
    );
  }
  // Even with validation, escape for defense-in-depth
  return escapeForAppleScript(id);
}

/**
 * Sanitizes an account name for safe embedding in AppleScript.
 *
 * @param account - Account name string
 * @returns Escaped account name safe for AppleScript string embedding
 */
function sanitizeAccountName(account: string): string {
  validateLength(account, MAX_ACCOUNT_LENGTH, "Account name");
  return escapePlainStringForAppleScript(account);
}

/**
 * Counter for generating unique fallback IDs within the same millisecond.
 */
let fallbackIdCounter = 0;

/**
 * Generates a unique fallback ID when AppleScript doesn't return a valid ID.
 *
 * This creates a temporary ID that's unique within this session. Format:
 * "temp-{timestamp}-{counter}"
 *
 * @returns A unique temporary ID string
 *
 * @example
 * generateFallbackId() // Returns: "temp-1704067200000-0"
 * generateFallbackId() // Returns: "temp-1704067200000-1"
 */
export function generateFallbackId(): string {
  return `temp-${Date.now()}-${fallbackIdCounter++}`;
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
  const s = appleScriptDate.trim();

  // Locale-independent numeric form emitted by our producers (#25): "Y-M-D-H-m-s"
  // built from AppleScript date components, so it never depends on the system's
  // date-format locale (the old `date as text` form did, silently falling back
  // to "now" on non-US Macs).
  const numeric = s.match(/^(\d{1,5})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/);
  if (numeric) {
    const [, y, mo, d, h, mi, se] = numeric;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    return isNaN(dt.getTime()) ? new Date() : dt;
  }

  // Legacy en-US verbose form: "date Saturday, December 27, 2025 at 3:44:02 PM".
  // Remove the "date " prefix if present
  const withoutPrefix = s.replace(/^date\s+/, "");

  // Replace " at " with a space for standard date parsing
  // "Saturday, December 27, 2025 at 3:44:02 PM" ->
  // "Saturday, December 27, 2025 3:44:02 PM"
  const normalized = withoutPrefix.replace(" at ", " ");

  // Attempt to parse - JavaScript's Date constructor handles this format
  const parsed = new Date(normalized);

  // Return parsed date if valid, otherwise current date as fallback
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Generates AppleScript code that creates a date variable with the given values.
 *
 * This approach is locale-independent, unlike `date "M/D/YYYY"` coercion which
 * depends on the system's date format settings and would fail on non-US locales.
 *
 * @param date - JavaScript Date object
 * @param varName - AppleScript variable name to assign (default: "thresholdDate")
 * @returns AppleScript code that sets up the date variable
 *
 * @example
 * buildAppleScriptDateVar(new Date("2025-06-15T00:00:00"))
 * // Returns multi-line AppleScript that sets thresholdDate to June 15, 2025 midnight
 */
export function buildAppleScriptDateVar(date: Date, varName: string = "thresholdDate"): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const timeInSeconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

  return [
    `set ${varName} to current date`,
    // Reset day to 1 BEFORE assigning month: AppleScript date components roll
    // over, so setting month to (say) June while the variable still holds the
    // 31st inherited from `current date` produces July 1 (June 31 doesn't
    // exist), and the day assignment below then lands in the wrong month.
    // Day 1 exists in every month, so year/month can never roll over. (#86)
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${year}`,
    `set month of ${varName} to ${month}`,
    `set day of ${varName} to ${day}`,
    `set time of ${varName} to ${timeInSeconds}`,
  ].join("\n");
}

/**
 * Builds a locale-independent AppleScript expression that renders a date variable
 * as "Y-M-D-H-m-s" from its numeric components (#25), parsed by
 * {@link parseAppleScriptDate}. Avoids `(someDate as text)`, whose format depends
 * on the system locale.
 *
 * @param v - name of an AppleScript variable already holding a date
 */
export function asDatePartsExpr(v: string): string {
  return (
    `((year of ${v}) as text) & "-" & ((month of ${v}) as integer as text) & "-" & ` +
    `((day of ${v}) as text) & "-" & ((hours of ${v}) as text) & "-" & ` +
    `((minutes of ${v}) as text) & "-" & ((seconds of ${v}) as text)`
  );
}

/**
 * Normalizes an optional AppleScript text field: trims it and converts the
 * literal "missing value" (what `URL of a as text` yields when the property is
 * unset) to undefined, so callers never see the sentinel string as data.
 *
 * @param field - raw field text from the AppleScript record, if any
 */
function normalizeAppleScriptText(field: string | undefined): string | undefined {
  const trimmed = field?.trim();
  return trimmed && trimmed !== "missing value" ? trimmed : undefined;
}

/**
 * Parsed note properties from AppleScript output.
 */
interface ParsedNoteProperties {
  title: string;
  id: string;
  created: Date;
  modified: Date;
  shared: boolean;
  passwordProtected: boolean;
}

/**
 * Parses AppleScript note properties output into structured data.
 *
 * AppleScript returns note properties in a format like:
 * "title, id, date DayName, Month Day, Year at Time, date..., bool, bool"
 *
 * Dates contain commas, so we use regex to extract them safely.
 *
 * @param output - Raw AppleScript output string
 * @returns Parsed properties, or null if format is invalid
 */
export function parseNotePropertiesOutput(output: string): ParsedNoteProperties | null {
  // Fields are control-char delimited (#18): title, id, created, modified,
  // shared, passwordProtected — robust against commas in titles, unlike the
  // old comma/regex parsing.
  const parts = output.split(FIELD_SEP);
  if (parts.length < 6) {
    console.error("Unexpected response format: expected 6 delimited note properties");
    return null;
  }
  const [title, id, createdStr, modifiedStr, sharedStr, ppStr] = parts;

  return {
    title: title.trim(),
    id: id.trim(),
    created: createdStr?.trim() ? parseAppleScriptDate(createdStr.trim()) : new Date(),
    modified: modifiedStr?.trim() ? parseAppleScriptDate(modifiedStr.trim()) : new Date(),
    shared: sharedStr?.trim() === "true",
    passwordProtected: ppStr?.trim() === "true",
  };
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
 * Splits a folder path on unescaped `/` separators.
 *
 * Folder names may contain literal slashes (e.g., "Spain/Portugal 2023").
 * In path strings these are escaped as `\/`. This function splits only on
 * unescaped `/` and restores the literal slashes in each segment.
 *
 * @param folderPath - Folder path with `/` as hierarchy separator and `\/` for literal slashes
 * @returns Array of folder name segments
 */
export function splitFolderPath(folderPath: string): string[] {
  // Split on `/` that is NOT preceded by `\`
  // We use a negative lookbehind to avoid splitting on escaped slashes
  const parts = folderPath.split(/(?<!\\)\//);
  // Unescape `\/` → `/` in each segment
  return parts.map((p) => p.replace(/\\\//g, "/")).filter((p) => p.length > 0);
}

/**
 * Escapes literal slashes in a folder name for use in path strings.
 *
 * @param name - Raw folder name (may contain `/`)
 * @returns Folder name with `/` escaped as `\/`
 */
function escapeFolderName(name: string): string {
  return name.replace(/\//g, "\\/");
}

/**
 * Builds an AppleScript folder reference from a path string.
 *
 * Converts a folder path like "Work/Clients/Omnia" into the nested
 * AppleScript syntax: `folder "Omnia" of folder "Clients" of folder "Work"`.
 *
 * A simple folder name like "Work" returns `folder "Work"`.
 * Literal slashes in folder names must be escaped as `\/` (e.g., "Travel/Spain\/Portugal").
 *
 * @param folderPath - Folder name or slash-separated path (e.g., "Work/Clients")
 * @returns AppleScript folder reference string
 */
export function buildFolderReference(folderPath: string): string {
  validateLength(folderPath, MAX_FOLDER_PATH_LENGTH, "Folder path");
  const parts = splitFolderPath(folderPath);
  if (parts.length > MAX_FOLDER_DEPTH) {
    throw new Error(
      `Folder path exceeds maximum nesting depth of ${MAX_FOLDER_DEPTH} (got ${parts.length})`
    );
  }
  if (parts.length === 0) {
    throw new Error("Folder path is empty");
  }
  // Build inside-out: last part is innermost, first part is outermost
  return parts
    .reverse()
    .map((part) => `folder "${escapePlainStringForAppleScript(part)}"`)
    .join(" of ");
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
  const safeAccount = sanitizeAccountName(scope.account);
  return `
    tell application "Notes"
      tell account "${safeAccount}"
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

/**
 * Queries the local Notes SQLite database for the sync identifier of a note,
 * then returns the notes://showNote?identifier=<uuid> deep-link URL.
 *
 * The Notes SDEF on macOS 26+ does not expose a `note link` AppleScript
 * property, so we fall back to reading ZIDENTIFIER from the CoreData store
 * directly. ZIDENTIFIER has been stable in ZICCLOUDSYNCINGOBJECT since
 * macOS 10.11 and is the same UUID that the `notes://` URL scheme uses.
 *
 * The CoreData URL encodes the SQLite primary key as the numeric suffix after
 * `p` (e.g. `x-coredata://uuid/ICNote/p50338` → Z_PK = 50338).
 *
 * @param coreDataId - CoreData URL from getNoteById (e.g. x-coredata://…/p123)
 * @returns notes://showNote?identifier=<uuid> or null on any failure
 */
function getNoteLinkFromDB(coreDataId: string): string | null {
  const match = coreDataId.match(/\/p(\d+)$/);
  if (!match) return null;
  const pk = parseInt(match[1], 10);

  const dbPath = join(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
  if (!existsSync(dbPath)) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean }
      ) => {
        prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?")
        .get(pk);
      const identifier = row?.ZIDENTIFIER as string | undefined;
      return identifier ? `notes://showNote?identifier=${identifier}` : null;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("getNoteLinkFromDB: failed to query Notes database:", err);
    return null;
  }
}

// =============================================================================
// Result Parsing Utilities
// =============================================================================

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

  /**
   * Checks if a note is password-protected by its ID.
   *
   * Password-protected notes cannot have their content read or modified
   * via AppleScript when locked. This method allows checking before
   * attempting operations that would fail.
   *
   * @param id - CoreData URL identifier for the note
   * @returns true if the note is password-protected, false otherwise
   */
  isNotePasswordProtectedById(id: string): boolean {
    const note = this.getNoteById(id);
    return note?.passwordProtected === true;
  }

  /**
   * Checks if a note is password-protected by its title.
   *
   * @param title - Exact title of the note
   * @param account - Account to search in (defaults to iCloud)
   * @returns true if the note is password-protected, false otherwise
   */
  isNotePasswordProtected(title: string, account?: string): boolean {
    const note = this.getNoteDetails(title, account);
    return note?.passwordProtected === true;
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
   * @param content - Body content (plain text that will be HTML-escaped, or raw HTML when format is "html")
   * @param tags - Optional tags (stored in returned object, not used by Notes.app)
   * @param folder - Optional folder name to create the note in
   * @param account - Account to use (defaults to iCloud)
   * @param format - Content format: "plaintext" escapes and wraps in div tags (default), "html" uses content as-is
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
   *
   * // Create with HTML formatting (no need for <h1> — title is auto-prepended)
   * const html = manager.createNote("Report", "<p>Details here</p>",
   *   [], undefined, undefined, "html");
   * ```
   */
  createNote(
    title: string,
    content: string,
    tags: string[] = [],
    folder?: string,
    account?: string,
    format: "plaintext" | "html" = "plaintext"
  ): Note | null {
    validateLength(title, MAX_TITLE_LENGTH, "Note title");
    validateLength(content, MAX_CONTENT_LENGTH, "Note content");
    const targetAccount = this.resolveAccount(account);

    // Build body HTML: title as <h1>, content follows.
    // We set only 'body' (not 'name') to avoid title duplication —
    // Notes.app auto-uses the first line of body as the note's display title.
    const htmlTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const bodyContent =
      format === "html"
        ? content
        : content
            .replace(/&/g, "&amp;")
            .replace(/\\/g, "&#92;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>")
            .replace(/\t/g, "<br>");

    const safeBody = escapeHtmlForAppleScript(`<h1>${htmlTitle}</h1>${bodyContent}`);

    // Build the AppleScript command
    let createCommand: string;

    if (folder) {
      // Create note in specific folder (supports nested paths like "Work/Clients")
      // Note: We avoid `set newNote` + `return id of newNote` because AppleScript
      // fails to resolve the note reference in deeply nested folder contexts (-1728).
      // The implicit return from `make new note` includes the ID which we parse.
      const folderRef = buildFolderReference(folder);
      createCommand = `make new note at ${folderRef} with properties {body:"${safeBody}"}`;
    } else {
      // Create note in default location
      createCommand = `
        set newNote to make new note with properties {body:"${safeBody}"}
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

    // Extract the CoreData ID from the response.
    // AppleScript's `id of newNote` yields an object specifier of the form
    // "note id x-coredata://<uuid>/ICNote/pN" — with a literal "note id " prefix.
    // Strip that prefix so we return the bare x-coredata:// URL that the id
    // validator and downstream tools (get-note-content, update-note) accept.
    const rawOutput = result.output.trim();
    const noteId = extractCoreDataId(rawOutput, "note") || rawOutput;

    // Return a Note object representing the created note with real ID
    const now = new Date();
    return {
      id: noteId || generateFallbackId(), // Use real ID, fallback to unique temp ID
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
   * the body text instead. Optionally filter to a specific folder.
   *
   * @param query - Text to search for
   * @param searchContent - If true, search note bodies; if false, search titles
   * @param account - Account to search in (defaults to iCloud)
   * @param folder - Optional folder to limit search to
   * @param modifiedSince - Optional ISO 8601 date string to filter notes modified on or after this date
   * @param limit - Optional maximum number of results to return (default: no limit)
   * @returns Array of matching notes (with minimal metadata)
   *
   * @example
   * ```typescript
   * // Search by title
   * const meetingNotes = manager.searchNotes("meeting");
   *
   * // Search in note content
   * const projectRefs = manager.searchNotes("Project Alpha", true);
   *
   * // Search within a specific folder
   * const workNotes = manager.searchNotes("deadline", false, "iCloud", "Work");
   *
   * // Search only recently modified notes
   * const recentNotes = manager.searchNotes("todo", true, undefined, undefined, "2025-01-01");
   *
   * // Search with a result limit
   * const topResults = manager.searchNotes("project", false, undefined, undefined, undefined, 10);
   * ```
   */
  searchNotes(
    query: string,
    searchContent: boolean = false,
    account?: string,
    folder?: string,
    modifiedSince?: string,
    limit?: number
  ): Note[] {
    const targetAccount = this.resolveAccount(account);
    const safeQuery = escapePlainStringForAppleScript(query);
    const safeLimit = limit !== undefined && limit > 0 ? Math.floor(limit) : undefined;

    // Build the where clause based on search type
    // AppleScript uses 'name' for title and 'body' for content
    const whereParts: string[] = [];

    if (searchContent) {
      whereParts.push(`body contains "${safeQuery}"`);
    } else {
      whereParts.push(`name contains "${safeQuery}"`);
    }

    // Add date filter if specified (uses locale-safe date variable)
    let dateSetup = "";
    if (modifiedSince) {
      const date = new Date(modifiedSince);
      if (!isNaN(date.getTime())) {
        dateSetup = buildAppleScriptDateVar(date) + "\n";
        whereParts.push(`modification date >= thresholdDate`);
      }
    }

    const whereClause = whereParts.join(" and ");

    // Build the notes source - either all notes or notes in a specific folder
    const notesSource = folder ? `notes of ${buildFolderReference(folder)}` : "notes";

    // Build the limit logic for the repeat loop
    // Note: The limit only reduces iteration over already-matched results from the whose clause,
    // not the query itself. It controls output size, not AppleScript query performance.
    const limitCheck =
      safeLimit !== undefined
        ? `
          if (count of resultList) >= ${safeLimit} then exit repeat`
        : "";

    // Get names, IDs, folder, and real timestamps for each matching note.
    // Notes.app can return the same CoreData note more than once when asking
    // an account for all notes, so dedupe on note ID before adding results.
    const searchCommand = `
      ${dateSetup}set matchingNotes to ${notesSource} where ${whereClause}
      set resultList to {}
      set seenIds to {}
      repeat with n in matchingNotes
        try
          set noteName to name of n
          set noteId to id of n
          if seenIds does not contain noteId then
            set end of seenIds to noteId
            try
              set noteCreated to creation date of n
              set createdParts to ${asDatePartsExpr("noteCreated")}
            on error
              set createdParts to ""
            end try
            try
              set noteModified to modification date of n
              set modifiedParts to ${asDatePartsExpr("noteModified")}
            on error
              set modifiedParts to ""
            end try
            try
              set noteFolder to name of container of n
            on error
              set noteFolder to "Notes"
            end try
            set end of resultList to noteName & ${AS_FIELD_SEP} & noteId & ${AS_FIELD_SEP} & noteFolder & ${AS_FIELD_SEP} & createdParts & ${AS_FIELD_SEP} & modifiedParts${limitCheck}
          end if
        end try
      end repeat
      set AppleScript's text item delimiters to ${AS_RECORD_SEP}
      return resultList as text
    `;
    const script = buildAccountScopedScript({ account: targetAccount }, searchCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      // Surface the failure (#19) — an empty array would look like "no matches".
      throw new Error(`Failed to search notes for "${query}": ${result.error ?? "unknown error"}`);
    }

    // Handle empty results
    if (!result.output.trim()) {
      return [];
    }

    // Parse the control-char-delimited output (#18): fields by FIELD_SEP, records by RECORD_SEP.
    const items = result.output.split(RECORD_SEP);

    const notes: Note[] = [];
    const seenIds = new Set<string>();
    for (const item of items) {
      const [title, id, folder, created, modified] = item.split(FIELD_SEP);
      if (!title?.trim()) continue;
      const noteId = id?.trim() || generateFallbackId();
      if (seenIds.has(noteId)) continue;
      seenIds.add(noteId);
      notes.push({
        id: noteId,
        title: title.trim(),
        content: "", // Not fetched in search
        tags: [] as string[],
        created: parseAppleScriptDate(created ?? ""),
        modified: parseAppleScriptDate(modified ?? ""),
        folder: folder?.trim(),
        account: targetAccount,
      });
    }
    return notes;
  }

  /**
   * Retrieves the HTML content of a note by its title.
   *
   * Note: Password-protected notes will fail with an AppleScript error.
   * Callers should check for password protection beforehand using
   * getNoteDetails() or isNotePasswordProtected().
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
    const safeTitle = escapePlainStringForAppleScript(title);

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
   * Note: Password-protected notes will fail with an AppleScript error.
   * Callers should check for password protection beforehand using
   * getNoteById() or isNotePasswordProtectedById().
   *
   * @param id - CoreData URL identifier for the note
   * @returns HTML content of the note, or empty string if not found
   */
  getNoteContentById(id: string): string {
    const safeId = sanitizeId(id);
    // Note IDs work at the application level, not scoped to account
    const getCommand = `get body of note id "${safeId}"`;
    const script = buildAppLevelScript(getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get content of note with ID "${id}":`, result.error);
      return "";
    }

    return result.output;
  }

  /**
   * Retrieves the plain-text content of a note by its exact title.
   *
   * Reads the note's `plaintext` property, which Notes derives from the body
   * with all HTML markup removed. This is the text Notes itself exposes, so it
   * is more faithful than converting the HTML body and skips the markup
   * round-trip entirely.
   *
   * @param title - Exact title of the note
   * @param account - Account to search in (defaults to iCloud)
   * @returns Plain-text content of the note, or empty string if not found
   */
  getNotePlaintext(title: string, account?: string): string {
    const targetAccount = this.resolveAccount(account);
    const safeTitle = escapePlainStringForAppleScript(title);

    const getCommand = `get plaintext of note "${safeTitle}"`;
    const script = buildAccountScopedScript({ account: targetAccount }, getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get plaintext of note "${title}":`, result.error);
      return "";
    }

    return result.output;
  }

  /**
   * Retrieves the plain-text content of a note by its CoreData ID.
   *
   * Reads the read-only `plaintext` property (the body with HTML removed). More
   * reliable than getNotePlaintext() because IDs are unique across accounts.
   *
   * Note: Password-protected notes will fail with an AppleScript error. Callers
   * should check for password protection beforehand using getNoteById().
   *
   * @param id - CoreData URL identifier for the note
   * @returns Plain-text content of the note, or empty string if not found
   */
  getNotePlaintextById(id: string): string {
    const safeId = sanitizeId(id);
    const getCommand = `get plaintext of note id "${safeId}"`;
    const script = buildAppLevelScript(getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get plaintext of note with ID "${id}":`, result.error);
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
    const safeId = sanitizeId(id);
    // Note IDs work at the application level, not scoped to account
    const getCommand = `
      set n to note id "${safeId}"
      set cd to creation date of n
      set md to modification date of n
      set noteProps to {name of n, id of n, ${asDatePartsExpr("cd")}, ${asDatePartsExpr("md")}, (shared of n as text), (password protected of n as text)}
      set AppleScript's text item delimiters to ${AS_FIELD_SEP}
      return noteProps as text
    `;
    const script = buildAppLevelScript(getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get note with ID "${id}":`, result.error);
      return null;
    }

    // Parse the AppleScript output using the shared helper
    const parsed = parseNotePropertiesOutput(result.output);
    if (!parsed) {
      return null;
    }

    return {
      id: parsed.id,
      title: parsed.title,
      content: "", // Not fetched to keep response small
      tags: [],
      created: parsed.created,
      modified: parsed.modified,
      shared: parsed.shared,
      passwordProtected: parsed.passwordProtected,
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
    const safeTitle = escapePlainStringForAppleScript(title);

    // Fetch multiple properties at once
    const getCommand = `
      set n to note "${safeTitle}"
      set cd to creation date of n
      set md to modification date of n
      set noteProps to {name of n, id of n, ${asDatePartsExpr("cd")}, ${asDatePartsExpr("md")}, (shared of n as text), (password protected of n as text)}
      set AppleScript's text item delimiters to ${AS_FIELD_SEP}
      return noteProps as text
    `;
    const script = buildAccountScopedScript({ account: targetAccount }, getCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get details for note "${title}":`, result.error);
      return null;
    }

    // Parse the AppleScript output using the shared helper
    const parsed = parseNotePropertiesOutput(result.output);
    if (!parsed) {
      return null;
    }

    return {
      id: parsed.id,
      title: parsed.title,
      content: "", // Not fetched
      tags: [],
      created: parsed.created,
      modified: parsed.modified,
      shared: parsed.shared,
      passwordProtected: parsed.passwordProtected,
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
    const safeTitle = escapePlainStringForAppleScript(title);

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
    const safeId = sanitizeId(id);
    const deleteCommand = `delete note id "${safeId}"`;
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
   * When format is 'html', newTitle is ignored — the caller must include
   * the title in the HTML content.
   *
   * Note: Password-protected notes will fail with an AppleScript error.
   * Callers should check for password protection beforehand using
   * getNoteDetails() or isNotePasswordProtected().
   *
   * @param title - Current title of the note to update
   * @param newTitle - New title (optional, keeps existing if not provided; ignored in html format)
   * @param newContent - New content for the note body
   * @param account - Account containing the note (defaults to iCloud)
   * @param format - Content format: "plaintext" wraps in div tags (default), "html" uses content as-is
   * @returns true if update succeeded, false otherwise
   */
  updateNote(
    title: string,
    newTitle: string | undefined,
    newContent: string,
    account?: string,
    format: "plaintext" | "html" = "plaintext"
  ): boolean {
    if (newTitle) validateLength(newTitle, MAX_TITLE_LENGTH, "Note title");
    validateLength(newContent, MAX_CONTENT_LENGTH, "Note content");
    const targetAccount = this.resolveAccount(account);
    const safeCurrentTitle = escapePlainStringForAppleScript(title);

    let fullBody: string;
    if (format === "html") {
      // HTML mode: content is the complete body, escaped only for AppleScript string
      fullBody = escapeHtmlForAppleScript(newContent);
    } else {
      // Plaintext mode: wrap title + content in <div> tags (existing behavior)
      const effectiveTitle = newTitle || title;
      const safeEffectiveTitle = escapeForAppleScript(effectiveTitle);
      const safeContent = escapeForAppleScript(newContent);
      fullBody = `<div>${safeEffectiveTitle}</div><div>${safeContent}</div>`;
    }

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
   * When format is 'html', newTitle is ignored — the caller must include
   * the title in the HTML content.
   *
   * Note: Password-protected notes will fail with an AppleScript error.
   * Callers should check for password protection beforehand using
   * getNoteById() or isNotePasswordProtectedById().
   *
   * @param id - CoreData URL identifier for the note
   * @param newTitle - New title (optional, keeps existing if not provided; ignored in html format)
   * @param newContent - New content for the note body
   * @param format - Content format: "plaintext" wraps in div tags (default), "html" uses content as-is
   * @returns true if update succeeded, false otherwise
   */
  updateNoteById(
    id: string,
    newTitle: string | undefined,
    newContent: string,
    format: "plaintext" | "html" = "plaintext"
  ): boolean {
    if (newTitle) validateLength(newTitle, MAX_TITLE_LENGTH, "Note title");
    validateLength(newContent, MAX_CONTENT_LENGTH, "Note content");
    let fullBody: string;
    if (format === "html") {
      // HTML mode: content is the complete body, escaped only for AppleScript string
      fullBody = escapeHtmlForAppleScript(newContent);
    } else {
      // Plaintext mode: wrap title + content in <div> tags (existing behavior)
      // Get the note to retrieve current title if newTitle not provided
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
      fullBody = `<div>${safeEffectiveTitle}</div><div>${safeContent}</div>`;
    }

    const safeId = sanitizeId(id);
    const updateCommand = `set body of note id "${safeId}" to "${fullBody}"`;
    const script = buildAppLevelScript(updateCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to update note with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Builds the AppleScript body for a bulk note listing.
   *
   * Names, ids, and (when date-filtering) modification dates are fetched as
   * whole-list Apple Events instead of two events per note; per-note round
   * trips scale linearly and push large libraries past client tool timeouts
   * (#86). The lists are separate snapshots of a live, syncing collection, so
   * every script guards that they are the same length before zipping them by
   * index — a mid-listing mutation would otherwise silently mispair names and
   * ids (grow) or read past the end of a list (shrink). On mismatch the
   * script raises BULK_LIST_MUTATION_ERROR, which executeAppleScript treats
   * as retryable, re-running the whole script on a fresh snapshot. A length
   * check cannot see an exactly-offsetting delete+create landing in the
   * milliseconds between two fetches; that residual window is accepted —
   * closing it would cost an extra whole-list fetch per listing.
   *
   * @param folderRef - Optional AppleScript folder reference to scope to
   * @param dateSetup - AppleScript defining thresholdDate; enables date filtering
   * @param sliceLimit - Fetch only the first N notes (mutually exclusive with
   *   dateSetup: a date filter must scan every note's date). The script then
   *   returns the total note count as a leading record so the caller can
   *   detect a dedup shortfall and fall back to a full fetch.
   */
  private buildBulkListCommand(opts: {
    folderRef?: string;
    dateSetup?: string;
    sliceLimit?: number;
  }): string {
    const { folderRef, dateSetup, sliceLimit } = opts;
    const fullSource = folderRef ? `notes of ${folderRef}` : "notes";
    const countGuard = (listVar: string) =>
      `if (count of ${listVar}) is not (count of noteNames) then error "${BULK_LIST_MUTATION_ERROR}"`;

    if (sliceLimit !== undefined) {
      // Bounded, unfiltered listing: fetch only the first sliceLimit notes so
      // small limits stay O(limit) instead of O(library). The slice range is
      // clamped to the live count, but the collection can still shrink between
      // the count and the fetch — Notes then raises -1719 "Invalid index"
      // (empirically; -1728 "no such object" guards the same class), which is
      // remapped to the retryable mutation error. Every other error number
      // (AppleEvent timeout -1712, lost connection, permissions) is rethrown
      // unchanged so its honest message and mapping survive. (#86)
      const slicedSource = folderRef
        ? `(notes 1 thru fetchCount of ${folderRef})`
        : `(notes 1 thru fetchCount)`;
      return `
        set totalCount to count of ${fullSource}
        set fetchCount to ${sliceLimit}
        if fetchCount > totalCount then set fetchCount to totalCount
        set resultList to {}
        if fetchCount > 0 then
          try
            set noteNames to name of ${slicedSource}
            set noteIds to id of ${slicedSource}
          on error errMsg number errNum
            if errNum is -1719 or errNum is -1728 then
              error "${BULK_LIST_MUTATION_ERROR}"
            else
              error errMsg number errNum
            end if
          end try
          ${countGuard("noteIds")}
          repeat with i from 1 to count of noteNames
            set end of resultList to (item i of noteNames) & ${AS_FIELD_SEP} & (item i of noteIds)
          end repeat
        end if
        set AppleScript's text item delimiters to ${AS_RECORD_SEP}
        return (totalCount as text) & ${AS_RECORD_SEP} & (resultList as text)
      `;
    }

    // Full fetch, optionally date-filtered. The date comparison happens in a
    // local AppleScript loop over bulk-fetched modification dates instead of
    // a whose clause: Notes evaluates whose filters per-note server-side,
    // which is as slow as per-note Apple Events. Comparing dates as dates
    // also sidesteps locale issues text coercion would introduce. (#86)
    const dateFetch = dateSetup
      ? `set noteDates to modification date of ${fullSource}\n        `
      : "";
    const dateCountGuard = dateSetup ? `${countGuard("noteDates")}\n        ` : "";
    const dateGuardOpen = dateSetup
      ? `if (item i of noteDates) >= thresholdDate then\n            `
      : "";
    const dateGuardClose = dateSetup ? `\n          end if` : "";
    return `
        ${dateSetup ?? ""}set noteNames to name of ${fullSource}
        set noteIds to id of ${fullSource}
        ${dateFetch}${countGuard("noteIds")}
        ${dateCountGuard}set resultList to {}
        repeat with i from 1 to count of noteNames
          ${dateGuardOpen}set end of resultList to (item i of noteNames) & ${AS_FIELD_SEP} & (item i of noteIds)${dateGuardClose}
        end repeat
        set AppleScript's text item delimiters to ${AS_RECORD_SEP}
        return resultList as text
      `;
  }

  /**
   * Parses bulk listing output into deduplicated note titles.
   *
   * Duplicate CoreData references are deduped by id; the limit is applied
   * after dedup so duplicates never count against it.
   */
  private parseBulkListOutput(output: string, safeLimit?: number): string[] {
    if (!output.trim()) return [];
    const seenIds = new Set<string>();
    const titles: string[] = [];
    for (const item of output.split(RECORD_SEP)) {
      const [title, id] = item.split(FIELD_SEP);
      if (!title?.trim()) continue;
      const noteId = id?.trim() || generateFallbackId();
      if (seenIds.has(noteId)) continue;
      seenIds.add(noteId);
      titles.push(title.trim());
      if (safeLimit !== undefined && titles.length >= safeLimit) break;
    }
    return titles;
  }

  /**
   * Lists all notes in an account, optionally filtered by folder, date, and limit.
   *
   * @param account - Account to list notes from (defaults to iCloud)
   * @param folder - Optional folder to filter by
   * @param modifiedSince - Optional ISO 8601 date string to filter notes modified on or after this date
   * @param limit - Optional maximum number of results to return (default: no limit)
   * @returns Array of note titles
   */
  listNotes(account?: string, folder?: string, modifiedSince?: string, limit?: number): string[] {
    const targetAccount = this.resolveAccount(account);
    const safeLimit = limit !== undefined && limit > 0 ? Math.floor(limit) : undefined;
    const folderRef = folder ? buildFolderReference(folder) : undefined;

    let dateSetup: string | undefined;
    if (modifiedSince) {
      const date = new Date(modifiedSince);
      if (!isNaN(date.getTime())) {
        dateSetup = buildAppleScriptDateVar(date) + "\n";
      }
    }

    // Bounded, unfiltered listings fetch only the first safeLimit notes. If
    // dedup dropped duplicate references from the slice (leaving fewer than
    // safeLimit titles while more notes exist), fall back to the full fetch
    // below so the limit semantics match the unsliced path exactly. (#86)
    if (safeLimit !== undefined && !dateSetup) {
      const script = buildAccountScopedScript(
        { account: targetAccount },
        this.buildBulkListCommand({ folderRef, sliceLimit: safeLimit })
      );
      const result = executeAppleScript(script);
      if (!result.success) {
        throw new Error(`Failed to list notes: ${result.error ?? "unknown error"}`);
      }
      const sepIdx = result.output.indexOf(RECORD_SEP);
      const header = sepIdx === -1 ? result.output : result.output.slice(0, sepIdx);
      const totalCount = Number.parseInt(header.trim(), 10);
      const records = sepIdx === -1 ? "" : result.output.slice(sepIdx + 1);
      const titles = this.parseBulkListOutput(records, safeLimit);
      // A malformed header (NaN) also falls through to the full fetch.
      if (!Number.isNaN(totalCount) && (titles.length >= safeLimit || totalCount <= safeLimit)) {
        return titles;
      }
    }

    const script = buildAccountScopedScript(
      { account: targetAccount },
      this.buildBulkListCommand({ folderRef, dateSetup })
    );
    const result = executeAppleScript(script);
    if (!result.success) {
      throw new Error(`Failed to list notes: ${result.error ?? "unknown error"}`);
    }
    return this.parseBulkListOutput(result.output, safeLimit);
  }

  /**
   * Lists all shared (collaborative) notes across all accounts.
   *
   * Returns notes that are shared with other users. These notes require
   * extra caution when modifying or deleting as changes affect collaborators.
   *
   * @returns Array of Note objects for all shared notes
   *
   * @example
   * ```typescript
   * const shared = manager.listSharedNotes();
   * console.log(`You have ${shared.length} shared notes`);
   * ```
   */
  listSharedNotes(): Note[] {
    const sharedNotes: Note[] = [];

    // Query each account for shared notes
    const accounts = this.listAccounts();

    for (const account of accounts) {
      // Use delimited output to avoid fragile comma-based parsing.
      // Format: name|||id|||createdDate|||modifiedDate|||shared|||passwordProtected
      const script = buildAccountScopedScript(
        { account: account.name },
        `
        set resultList to {}
        repeat with n in notes
          if shared of n is true then
            set cd to creation date of n
            set md to modification date of n
            set end of resultList to (name of n) & ${AS_FIELD_SEP} & (id of n) & ${AS_FIELD_SEP} & ${asDatePartsExpr("cd")} & ${AS_FIELD_SEP} & ${asDatePartsExpr("md")} & ${AS_FIELD_SEP} & (shared of n as text) & ${AS_FIELD_SEP} & (password protected of n as text)
          end if
        end repeat
        set AppleScript's text item delimiters to ${AS_RECORD_SEP}
        return resultList as text
        `
      );

      const result = executeAppleScript(script);

      if (!result.success) {
        console.error(`Failed to list shared notes for ${account.name}:`, result.error);
        continue;
      }

      const output = result.output.trim();
      if (!output) {
        continue;
      }

      // Parse control-char-delimited output (#18): fields by FIELD_SEP, records by RECORD_SEP.
      const items = output.split(RECORD_SEP);

      for (const item of items) {
        const parts = item.split(FIELD_SEP);
        if (parts.length >= 6) {
          const title = parts[0].trim();
          const id = parts[1].trim();
          const createdStr = parts[2].trim();
          const modifiedStr = parts[3].trim();
          const shared = parts[4].trim() === "true";
          const passwordProtected = parts[5].trim() === "true";

          sharedNotes.push({
            id,
            title,
            content: "",
            tags: [],
            created: parseAppleScriptDate(createdStr),
            modified: parseAppleScriptDate(modifiedStr),
            account: account.name,
            shared,
            passwordProtected,
          });
        }
      }
    }

    return sharedNotes;
  }

  // ===========================================================================
  // Folder Operations
  // ===========================================================================

  /**
   * Lists all folders in an account with full hierarchical paths.
   *
   * Each folder's `name` field contains the full path (e.g., "Work/Clients/Omnia")
   * so that duplicate folder names (e.g., multiple "Archive" folders) are
   * distinguishable and can be used directly in other operations.
   *
   * @param account - Account to list folders from (defaults to iCloud)
   * @returns Array of Folder objects with path-based names
   */
  listFolders(account?: string): Folder[] {
    const targetAccount = this.resolveAccount(account);

    // Get each folder's ID, name, parent ID, and shared state in a single AppleScript call.
    // Using IDs enables correct tree building even with duplicate folder names.
    const listCommand = `
      set folderList to {}
      set allFolders to every folder
      repeat with f in allFolders
        set fRef to contents of f
        set cRef to container of fRef
        set parentId to ""
        if class of cRef is folder then
          set parentId to id of cRef
        end if
        set sharedFlag to shared of fRef as text
        set end of folderList to (id of fRef) & ${AS_FIELD_SEP} & (name of fRef) & ${AS_FIELD_SEP} & parentId & ${AS_FIELD_SEP} & sharedFlag
      end repeat
      set AppleScript's text item delimiters to ${AS_RECORD_SEP}
      return folderList as text
    `;
    const script = buildAccountScopedScript({ account: targetAccount }, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      throw new Error(`Failed to list folders: ${result.error ?? "unknown error"}`);
    }

    if (!result.output.trim()) {
      return [];
    }

    const recordSeparator = result.output.includes(RECORD_SEP) ? RECORD_SEP : "\n";
    const entries = result.output.split(recordSeparator).map((line) => {
      const parts = line.includes(FIELD_SEP) ? line.split(FIELD_SEP) : line.split("\t");
      return {
        id: (parts[0] || "").trim(),
        name: (parts[1] || "").trim(),
        parentId: (parts[2] || "").trim(),
        shared: (parts[3] || "").trim().toLowerCase() === "true",
      };
    });

    // Build an ID-to-entry map for efficient parent lookups
    const byId = new Map(entries.map((e) => [e.id, e]));

    // Build full path by walking up the parent chain using unique IDs
    // Build full path by walking up the parent chain using unique IDs.
    // Literal slashes in folder names are escaped as `\/` so they don't
    // collide with the `/` path separator.
    const buildPath = (entry: { id: string; name: string; parentId: string }): string => {
      const safeName = escapeFolderName(entry.name);
      if (!entry.parentId) return safeName;
      const parent = byId.get(entry.parentId);
      if (parent) {
        return buildPath(parent) + "/" + safeName;
      }
      return safeName;
    };

    return entries.map((entry) => ({
      id: entry.id,
      name: buildPath(entry),
      account: targetAccount,
      shared: entry.shared,
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
    const parts = splitFolderPath(name);

    if (parts.length === 0) {
      console.error(`Invalid folder name: "${name}"`);
      return null;
    }

    // Create each segment of the path, checking existence first to avoid duplicates.
    // For "A/B/C": ensure "A" exists, then "A/B", then "A/B/C".
    for (let i = 0; i < parts.length; i++) {
      const currentPath = parts
        .slice(0, i + 1)
        .map((p) => escapeFolderName(p))
        .join("/");
      const currentRef = buildFolderReference(currentPath);

      // Check if this folder already exists
      const checkScript = buildAccountScopedScript(
        { account: targetAccount },
        `return id of ${currentRef}`
      );
      const checkResult = executeAppleScript(checkScript);
      if (checkResult.success) {
        // Folder exists, move to next segment
        continue;
      }

      // Folder doesn't exist — create it
      const segmentName = escapePlainStringForAppleScript(parts[i]);
      let createCommand: string;

      if (i === 0) {
        createCommand = `make new folder with properties {name:"${segmentName}"}`;
      } else {
        const parentPath = parts
          .slice(0, i)
          .map((p) => escapeFolderName(p))
          .join("/");
        const parentRef = buildFolderReference(parentPath);
        createCommand = `make new folder at ${parentRef} with properties {name:"${segmentName}"}`;
      }

      const script = buildAccountScopedScript({ account: targetAccount }, createCommand);
      const result = executeAppleScript(script);

      if (!result.success) {
        console.error(`Failed to create folder "${name}":`, result.error);
        return null;
      }
    }

    // Get the ID of the final (deepest) folder
    const fullRef = buildFolderReference(name);
    const idScript = buildAccountScopedScript(
      { account: targetAccount },
      `return id of ${fullRef}`
    );
    const idResult = executeAppleScript(idScript);
    const folderId = idResult.success ? extractCoreDataId(idResult.output, "folder") : "";

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

    const deleteCommand = `delete ${buildFolderReference(name)}`;
    const script = buildAccountScopedScript({ account: targetAccount }, deleteCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to delete folder "${name}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Moves a note to a different folder, looked up by title.
   *
   * Uses Notes.app's native `move` command (the same one `batchMoveNotes`
   * uses), which relocates the note in place — preserving its identity, id,
   * creation date, AND all embedded attachments (files/images/PDFs/scans/audio).
   * The previous copy-then-delete implementation rebuilt the note from its body
   * HTML, which silently dropped attachments and reset the note's identity.
   *
   * The note is resolved to its id first (titles can be duplicated), then moved
   * by id so the title-based and id-based paths share the same native move.
   *
   * @param title - Title of the note to move
   * @param destinationFolder - Name of the folder to move to (must already exist)
   * @param account - Account containing the note (defaults to iCloud)
   * @returns true if the move succeeded, false otherwise
   */
  moveNote(title: string, destinationFolder: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);

    // Resolve the note's id first (titles can be duplicated), then delegate to
    // the id-based native move so both paths preserve attachments + identity.
    const originalNote = this.getNoteDetails(title, targetAccount);

    if (!originalNote) {
      console.error(`Cannot move note "${title}": note not found`);
      return false;
    }

    return this.moveNoteById(originalNote.id, destinationFolder, targetAccount);
  }

  /**
   * Moves a note to a different folder by its CoreData ID.
   *
   * Uses Notes.app's native `move <noteRef> to <destFolder>` command — the same
   * one `batchMoveNotes` uses — which relocates the note in place, preserving its
   * id, creation date, and all embedded attachments. (The old copy-then-delete
   * approach rebuilt the note from body HTML and silently lost attachments.)
   *
   * @param id - CoreData URL identifier for the note
   * @param destinationFolder - Name of the folder to move to (must already exist)
   * @param account - Account containing the destination folder (defaults to iCloud)
   * @returns true if the move succeeded, false otherwise
   */
  moveNoteById(id: string, destinationFolder: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeId = sanitizeId(id);
    const safeAccount = sanitizeAccountName(targetAccount);
    // buildFolderReference validates the destination path; a malformed folder is
    // a precondition error, so let it throw. The destination folder must already
    // exist — Notes.app's `move` does not create it.
    const destFolderRef = `${buildFolderReference(destinationFolder)} of account "${safeAccount}"`;

    const moveCommand = `
      set destFolder to ${destFolderRef}
      set noteRef to note id "${safeId}"
      move noteRef to destFolder
    `;
    const script = buildAppLevelScript(moveCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(
        `Cannot move note to "${destinationFolder}" (folder may not exist):`,
        result.error
      );
      return false;
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
    // Coerce account records to text with control-char delimiters so names
    // containing commas or tabs can't split into phantom accounts (#18).
    const listCommand = `
      set resultList to {}
      repeat with a in accounts
        set aRef to contents of a
        set defaultFolderId to ""
        set defaultFolderName to ""
        try
          set fRef to default folder of aRef
          set defaultFolderId to id of fRef
          set defaultFolderName to name of fRef
        end try
        set upgradedFlag to upgraded of aRef as text
        set end of resultList to (id of aRef) & ${AS_FIELD_SEP} & (name of aRef) & ${AS_FIELD_SEP} & upgradedFlag & ${AS_FIELD_SEP} & defaultFolderId & ${AS_FIELD_SEP} & defaultFolderName
      end repeat
      set AppleScript's text item delimiters to ${AS_RECORD_SEP}
      return resultList as text
    `;
    const script = buildAppLevelScript(listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      throw new Error(`Failed to list accounts: ${result.error ?? "unknown error"}`);
    }

    return result.output
      .split(RECORD_SEP)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((item) => {
        const parts = item.split(FIELD_SEP);
        if (parts.length === 1) {
          return { name: parts[0].trim() };
        }
        return {
          id: (parts[0] || "").trim(),
          name: (parts[1] || "").trim(),
          upgraded: (parts[2] || "").trim().toLowerCase() === "true",
          defaultFolderId: (parts[3] || "").trim() || undefined,
          defaultFolder: (parts[4] || "").trim() || undefined,
        };
      });
  }

  /**
   * Gets the default account and folder used by Notes.app for new notes.
   *
   * @returns Default account and folder metadata
   */
  getDefaultLocation(): DefaultLocation {
    const command = `
      set aRef to default account
      set fRef to default folder of aRef
      return (id of aRef) & ${AS_FIELD_SEP} & (name of aRef) & ${AS_FIELD_SEP} & (upgraded of aRef as text) & ${AS_FIELD_SEP} & (id of fRef) & ${AS_FIELD_SEP} & (name of fRef) & ${AS_FIELD_SEP} & (shared of fRef as text)
    `;
    const result = executeAppleScript(buildAppLevelScript(command));

    if (!result.success) {
      throw new Error(`Failed to get default Notes location: ${result.error ?? "unknown error"}`);
    }

    const parts = result.output.split(FIELD_SEP);
    if (parts.length < 6) {
      throw new Error(`Failed to parse default Notes location: ${result.output}`);
    }

    const accountName = (parts[1] || "").trim();
    return {
      account: {
        id: (parts[0] || "").trim(),
        name: accountName,
        upgraded: (parts[2] || "").trim().toLowerCase() === "true",
        defaultFolderId: (parts[3] || "").trim(),
        defaultFolder: (parts[4] || "").trim(),
      },
      folder: {
        id: (parts[3] || "").trim(),
        name: (parts[4] || "").trim(),
        account: accountName,
        shared: (parts[5] || "").trim().toLowerCase() === "true",
      },
    };
  }

  /**
   * Lists the currently selected Notes in the Notes.app UI.
   *
   * @returns Array of selected notes, or an empty array when nothing is selected
   */
  getSelectedNotes(): Note[] {
    const command = `
      set selectedNotes to selection
      set noteList to {}
      repeat with n in selectedNotes
        set nRef to contents of n
        set createdDate to creation date of nRef
        set modifiedDate to modification date of nRef
        set createdParts to ${asDatePartsExpr("createdDate")}
        set modifiedParts to ${asDatePartsExpr("modifiedDate")}
        set folderName to ""
        set accountName to ""
        try
          set fRef to container of nRef
          set folderName to name of fRef
          set aRef to container of fRef
          set accountName to name of aRef
        end try
        set end of noteList to (id of nRef) & ${AS_FIELD_SEP} & (name of nRef) & ${AS_FIELD_SEP} & createdParts & ${AS_FIELD_SEP} & modifiedParts & ${AS_FIELD_SEP} & (shared of nRef as text) & ${AS_FIELD_SEP} & (password protected of nRef as text) & ${AS_FIELD_SEP} & folderName & ${AS_FIELD_SEP} & accountName
      end repeat
      set AppleScript's text item delimiters to ${AS_RECORD_SEP}
      return noteList as text
    `;
    const result = executeAppleScript(buildAppLevelScript(command));

    if (!result.success) {
      throw new Error(`Failed to get selected notes: ${result.error ?? "unknown error"}`);
    }

    if (!result.output.trim()) {
      return [];
    }

    return result.output
      .split(RECORD_SEP)
      .filter((s) => s.trim())
      .map((item) => {
        const parts = item.split(FIELD_SEP);
        return {
          id: (parts[0] || "").trim(),
          title: (parts[1] || "").trim(),
          content: "",
          tags: [],
          created: parseAppleScriptDate((parts[2] || "").trim()),
          modified: parseAppleScriptDate((parts[3] || "").trim()),
          shared: (parts[4] || "").trim().toLowerCase() === "true",
          passwordProtected: (parts[5] || "").trim().toLowerCase() === "true",
          folder: (parts[6] || "").trim() || undefined,
          account: (parts[7] || "").trim() || undefined,
        };
      });
  }

  /**
   * Reveals a note in the Notes.app UI by ID.
   *
   * @param id - CoreData URL identifier for the note
   * @param separately - Whether to open the note in a separate window
   * @returns true if Notes.app accepted the show command
   */
  showNoteById(id: string, separately: boolean = false): boolean {
    const safeId = sanitizeId(id);
    const separatelyClause = separately ? " separately true" : "";
    const result = executeAppleScript(
      buildAppLevelScript(`show note id "${safeId}"${separatelyClause}`)
    );

    if (!result.success) {
      console.error(`Failed to show note with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Returns the notes:// deep-link URL for a note by its CoreData ID.
   *
   * Primary path: queries the Notes SQLite database for ZIDENTIFIER, which
   * is the UUID used in the notes://showNote?identifier= URL scheme. This
   * is more reliable than the AppleScript `note link` property, which is
   * absent from the Notes SDEF on macOS 26+.
   *
   * Fallback: AppleScript `note link` property (macOS 12–15).
   *
   * @param id - CoreData URL identifier for the note
   * @returns notes://showNote?identifier=<uuid> string, or null on failure
   */
  getNoteLinkById(id: string): string | null {
    const note = this.getNoteById(id);
    if (!note) return null;
    if (note.passwordProtected) return null;

    // Primary: SQLite lookup — works on all macOS versions
    const sqliteLink = getNoteLinkFromDB(id);
    if (sqliteLink) return sqliteLink;

    // Fallback: AppleScript 'note link' (present on macOS 12–15)
    const safeId = sanitizeId(id);
    const result = executeAppleScript(
      buildAppLevelScript(`return note link of (note id "${safeId}")`)
    );
    if (result.success && result.output.trim()) {
      return result.output.trim();
    }

    console.error(`Failed to get note link for ID "${id}":`, result.error);
    return null;
  }

  /**
   * Returns the notes:// deep-link URL for a note by title.
   *
   * @param title - Exact note title
   * @param account - Account to search in (defaults to iCloud)
   * @returns notes://showNote?identifier=<uuid> string, or null on failure
   */
  getNoteLink(title: string, account?: string): string | null {
    const note = this.getNoteDetails(title, account);
    if (!note) return null;
    return this.getNoteLinkById(note.id);
  }

  /**
   * Reveals a folder in the Notes.app UI by its id.
   *
   * Wraps the Notes `show` command, which the scripting dictionary exposes for
   * folders as well as notes. This opens or focuses the Notes UI on the folder.
   *
   * @param id - CoreData identifier for the folder (from list-folders)
   * @param separately - Open in a separate window when supported by Notes.app
   * @returns true if Notes.app accepted the show command, false otherwise
   */
  showFolderById(id: string, separately: boolean = false): boolean {
    const safeId = sanitizeId(id);
    const separatelyClause = separately ? " separately true" : "";
    const result = executeAppleScript(
      buildAppLevelScript(`show folder id "${safeId}"${separatelyClause}`)
    );

    if (!result.success) {
      console.error(`Failed to show folder with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Reveals an account in the Notes.app UI by its id.
   *
   * Wraps the Notes `show` command, which the scripting dictionary exposes for
   * accounts as well as notes. This opens or focuses the Notes UI on the account.
   *
   * @param id - CoreData identifier for the account (from list-accounts)
   * @param separately - Open in a separate window when supported by Notes.app
   * @returns true if Notes.app accepted the show command, false otherwise
   */
  showAccountById(id: string, separately: boolean = false): boolean {
    const safeId = sanitizeId(id);
    const separatelyClause = separately ? " separately true" : "";
    const result = executeAppleScript(
      buildAppLevelScript(`show account id "${safeId}"${separatelyClause}`)
    );

    if (!result.success) {
      console.error(`Failed to show account with ID "${id}":`, result.error);
      return false;
    }

    return true;
  }

  /**
   * Reveals an attachment in the Notes.app UI.
   *
   * Attachments are elements of a note, so they cannot be referenced at the
   * application level by id alone. This resolves the attachment within its note
   * (the same lookup used by save-attachment) and then runs the Notes `show`
   * command on it, opening or focusing the Notes UI on the attachment.
   *
   * @param noteId - CoreData identifier for the note containing the attachment
   * @param attachmentId - id of the attachment (from list-attachments)
   * @param separately - Open in a separate window when supported by Notes.app
   * @returns true if Notes.app revealed the attachment, false otherwise
   */
  showAttachmentById(noteId: string, attachmentId: string, separately: boolean = false): boolean {
    const safeNoteId = sanitizeId(noteId);
    const safeAttId = escapePlainStringForAppleScript(attachmentId);
    const separatelyClause = separately ? " separately true" : "";

    const script = `
      tell application "Notes"
        set theNote to note id "${safeNoteId}"
        set theAttachment to missing value
        repeat with a in attachments of theNote
          if (id of a as text) is "${safeAttId}" then
            set theAttachment to a
            exit repeat
          end if
        end repeat
        if theAttachment is missing value then
          return "ERR" & ${AS_FIELD_SEP} & "attachment not found"
        end if
        show theAttachment${separatelyClause}
        return "OK"
      end tell
    `;

    const result = executeAppleScript(script);
    if (!result.success) {
      console.error(
        `Failed to show attachment "${attachmentId}" on note "${noteId}":`,
        result.error
      );
      return false;
    }
    if ((result.output ?? "").trim().startsWith("ERR")) {
      console.error(`Attachment "${attachmentId}" not found on note "${noteId}"`);
      return false;
    }
    return true;
  }

  // ===========================================================================
  // Health Check
  // ===========================================================================

  /**
   * Performs a health check on Notes.app accessibility and functionality.
   *
   * This method verifies:
   * - Notes.app is installed and accessible
   * - AppleScript automation permissions are granted
   * - At least one account is available
   * - Basic list operations work
   *
   * Use this to diagnose connection issues or verify setup.
   *
   * @returns HealthCheckResult with overall status and individual check details
   *
   * @example
   * ```typescript
   * const health = manager.healthCheck();
   * if (!health.healthy) {
   *   console.log("Issues found:");
   *   health.checks.filter(c => !c.passed).forEach(c => console.log(`- ${c.message}`));
   * }
   * ```
   */
  healthCheck(): HealthCheckResult {
    const checks: HealthCheckItem[] = [];

    // Check 1: Notes.app is accessible
    const appCheck = executeAppleScript('tell application "Notes" to return "ok"');
    if (appCheck.success && appCheck.output === "ok") {
      checks.push({
        name: "notes_app",
        passed: true,
        message: "Notes.app is accessible",
      });
    } else {
      const errorHint = appCheck.error?.includes("not authorized")
        ? " (check Automation permissions in System Settings > Privacy & Security > Automation)"
        : "";
      checks.push({
        name: "notes_app",
        passed: false,
        message: `Notes.app is not accessible${errorHint}`,
      });
      // If Notes.app isn't accessible, skip other checks
      return { healthy: false, checks };
    }

    // Check 2: AppleScript permissions (can we execute commands?)
    const permCheck = executeAppleScript('tell application "Notes" to get name of account 1');
    if (permCheck.success) {
      checks.push({
        name: "permissions",
        passed: true,
        message: "AppleScript automation permissions granted",
      });
    } else {
      const isPermError =
        permCheck.error?.includes("not authorized") || permCheck.error?.includes("not permitted");
      checks.push({
        name: "permissions",
        passed: !isPermError,
        message: isPermError
          ? "AppleScript permissions denied. Grant access in System Settings > Privacy & Security > Automation"
          : `Permission check returned: ${permCheck.error}`,
      });
      if (isPermError) {
        return { healthy: false, checks };
      }
    }

    // Check 3: At least one account accessible
    const accounts = this.listAccounts();
    if (accounts.length > 0) {
      const accountNames = accounts.map((a) => a.name).join(", ");
      checks.push({
        name: "accounts",
        passed: true,
        message: `Found ${accounts.length} account(s): ${accountNames}`,
      });
    } else {
      checks.push({
        name: "accounts",
        passed: false,
        message: "No Notes accounts found. Set up an account in Notes.app first.",
      });
      return { healthy: false, checks };
    }

    // Check 4: Basic operations work (list notes in default account)
    const defaultAccount = accounts[0]?.name || "iCloud";
    const notes = this.listNotes(defaultAccount);
    // Even 0 notes is fine - we just want to verify the operation works
    checks.push({
      name: "operations",
      passed: true,
      message: `Basic operations working (${notes.length} note(s) in ${defaultAccount})`,
    });

    const allPassed = checks.every((c) => c.passed);
    return { healthy: allPassed, checks };
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Gets comprehensive statistics about notes across all accounts.
   *
   * Returns total note counts, per-account breakdowns, folder statistics,
   * and counts of recently modified notes.
   *
   * @returns NotesStats object with comprehensive statistics
   *
   * @example
   * ```typescript
   * const stats = manager.getNotesStats();
   * console.log(`Total notes: ${stats.totalNotes}`);
   * console.log(`Modified today: ${stats.recentlyModified.last24h}`);
   * ```
   */
  getNotesStats(): NotesStats {
    const accounts = this.listAccounts();
    const accountStats: AccountStats[] = [];
    const warnings: ScopeWarning[] = [];
    let totalNotes = 0;

    // Collect stats per account with ONE bounded script per account (#20/#26):
    // count notes server-side per folder instead of fetching every note's name
    // (unbounded) via a listNotes call per folder (N+1 osascript spawns).
    //
    // Per-account failures degrade gracefully (#19): a single unreachable or
    // locked account is recorded as a coverage warning and skipped, rather than
    // discarding the stats for every healthy account. Only a total wipeout
    // (no account readable) is escalated to a thrown error below.
    for (const account of accounts) {
      const countScript = buildAccountScopedScript(
        { account: account.name },
        `
        set out to ""
        repeat with fldr in folders
          set out to out & (name of fldr) & ${AS_FIELD_SEP} & (count of notes of fldr) & ${AS_RECORD_SEP}
        end repeat
        return out
        `
      );
      const res = executeAppleScript(countScript);
      if (!res.success) {
        warnings.push({ scope: account.name, reason: res.error ?? "unknown error" });
        continue;
      }

      const folderStats: FolderStats[] = [];
      let accountTotal = 0;
      for (const rec of res.output.split(RECORD_SEP)) {
        if (!rec.trim()) continue;
        const [fname, cnt] = rec.split(FIELD_SEP);
        const noteCount = parseInt((cnt ?? "").trim(), 10) || 0;
        accountTotal += noteCount;
        folderStats.push({ name: (fname ?? "").trim(), noteCount });
      }

      totalNotes += accountTotal;
      accountStats.push({
        name: account.name,
        totalNotes: accountTotal,
        folderCount: folderStats.length,
        folders: folderStats,
      });
    }

    // If every account failed, there is no data to report — surface the error
    // (#19) rather than returning a deceptively empty stats object.
    if (accounts.length > 0 && accountStats.length === 0) {
      throw new Error(
        `Failed to read folder stats for any of ${accounts.length} account(s): ${warnings
          .map((w) => `${w.scope} (${w.reason})`)
          .join("; ")}`
      );
    }

    // Get recently modified notes counts. A failure here is non-fatal — record a
    // coverage warning and report zeros, flagged as not-covered (#19), instead of
    // passing off fake zero activity as real.
    const recent = this.getRecentlyModifiedCounts();
    if (recent.error) {
      warnings.push({ scope: "recent-activity", reason: recent.error });
    }

    // scopes = each account + the recent-activity scan
    const scanned = accounts.length + 1;
    const covered = scanned - warnings.length;

    return {
      totalNotes,
      accounts: accountStats,
      recentlyModified: recent.counts,
      coverage: {
        complete: warnings.length === 0,
        scanned,
        covered,
        warnings,
      },
    };
  }

  /**
   * Helper to get counts of recently modified notes.
   */
  private getRecentlyModifiedCounts(): {
    counts: { last24h: number; last7d: number; last30d: number };
    error?: string;
  } {
    // Count server-side with locale-safe date variables (#20/#25): instead of
    // streaming every note's modification date to JS (unbounded, ENOBUFS-prone,
    // locale-fragile), let AppleScript count matches via a `whose` filter — three
    // counts per account, regardless of library size.
    const now = new Date();
    const d1 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const script = `
      tell application "Notes"
        ${buildAppleScriptDateVar(d1, "d1")}
        ${buildAppleScriptDateVar(d7, "d7")}
        ${buildAppleScriptDateVar(d30, "d30")}
        set c1 to 0
        set c7 to 0
        set c30 to 0
        repeat with acct in accounts
          set c1 to c1 + (count of (notes of acct whose modification date >= d1))
          set c7 to c7 + (count of (notes of acct whose modification date >= d7))
          set c30 to c30 + (count of (notes of acct whose modification date >= d30))
        end repeat
        return (c1 as text) & ${AS_FIELD_SEP} & (c7 as text) & ${AS_FIELD_SEP} & (c30 as text)
      end tell
    `;

    const result = executeAppleScript(script);
    if (!result.success) {
      // Non-fatal (#19): report the error to the caller so it becomes a coverage
      // warning, with zeroed counts, instead of throwing away the whole stats
      // result or passing off fake zero activity as real.
      return {
        counts: { last24h: 0, last7d: 0, last30d: 0 },
        error: result.error ?? "unknown error",
      };
    }

    const parts = result.output.trim().split(FIELD_SEP);
    const toInt = (s: string | undefined): number => {
      const n = parseInt((s ?? "").trim(), 10);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      counts: { last24h: toInt(parts[0]), last7d: toInt(parts[1]), last30d: toInt(parts[2]) },
    };
  }

  // ===========================================================================
  // Attachments
  // ===========================================================================

  /**
   * Lists attachments for a note by its ID.
   *
   * Returns metadata about each attachment including name and content type.
   * Note: The position within the note cannot be determined via AppleScript.
   *
   * @param id - CoreData URL identifier for the note
   * @returns Array of Attachment objects, or empty array if none found
   *
   * @example
   * ```typescript
   * const attachments = manager.listAttachmentsById("x-coredata://ABC/ICNote/p123");
   * attachments.forEach(a => console.log(`${a.name}: ${a.contentType}`));
   * ```
   */
  listAttachmentsById(id: string): Attachment[] {
    const safeId = sanitizeId(id);

    const script = `
      tell application "Notes"
        set theNote to note id "${safeId}"
        set attachmentList to {}
        repeat with a in attachments of theNote
          set attachId to id of a
          set attachName to name of a
          set attachContentId to content identifier of a
          set attachUrl to ""
          try
            set attachUrl to URL of a as text
          end try
          set createdDate to creation date of a
          set modifiedDate to modification date of a
          set createdParts to ${asDatePartsExpr("createdDate")}
          set modifiedParts to ${asDatePartsExpr("modifiedDate")}
          set sharedFlag to shared of a as text
          set end of attachmentList to attachId & ${AS_FIELD_SEP} & attachName & ${AS_FIELD_SEP} & attachContentId & ${AS_FIELD_SEP} & attachUrl & ${AS_FIELD_SEP} & createdParts & ${AS_FIELD_SEP} & modifiedParts & ${AS_FIELD_SEP} & sharedFlag
        end repeat
        set output to ""
        repeat with recordItem in attachmentList
          set output to output & recordItem & ${AS_RECORD_SEP}
        end repeat
        return output
      end tell
    `;

    const result = executeAppleScript(script);
    if (!result.success || !result.output) {
      if (result.error) {
        console.error(`Failed to list attachments for note ID "${id}":`, result.error);
      }
      return [];
    }

    // Parse the results
    const attachments: Attachment[] = [];
    const items = result.output.split(RECORD_SEP).filter((s) => s.trim());

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length >= 3) {
        attachments.push({
          id: parts[0].trim(),
          name: parts[1].trim(),
          contentType: parts[2].trim(),
          contentId: parts[2].trim() || undefined,
          url: normalizeAppleScriptText(parts[3]),
          created: parts[4] ? parseAppleScriptDate(parts[4].trim()) : undefined,
          modified: parts[5] ? parseAppleScriptDate(parts[5].trim()) : undefined,
          shared: parts[6] ? parts[6].trim().toLowerCase() === "true" : undefined,
        });
      }
    }

    return attachments;
  }

  /**
   * Lists attachments for a note by its title.
   *
   * @param title - Title of the note
   * @param account - Account containing the note (defaults to iCloud)
   * @returns Array of Attachment objects, or empty array if none found
   */
  listAttachments(title: string, account?: string): Attachment[] {
    const targetAccount = this.resolveAccount(account);
    const safeAccount = escapePlainStringForAppleScript(targetAccount);
    const safeTitle = escapePlainStringForAppleScript(title);

    const script = `
      tell application "Notes"
        tell account "${safeAccount}"
          set theNote to note "${safeTitle}"
        set attachmentList to {}
        repeat with a in attachments of theNote
          set attachId to id of a
          set attachName to name of a
          set attachContentId to content identifier of a
          set attachUrl to ""
          try
            set attachUrl to URL of a as text
          end try
          set createdDate to creation date of a
          set modifiedDate to modification date of a
          set createdParts to ${asDatePartsExpr("createdDate")}
          set modifiedParts to ${asDatePartsExpr("modifiedDate")}
          set sharedFlag to shared of a as text
          set end of attachmentList to attachId & ${AS_FIELD_SEP} & attachName & ${AS_FIELD_SEP} & attachContentId & ${AS_FIELD_SEP} & attachUrl & ${AS_FIELD_SEP} & createdParts & ${AS_FIELD_SEP} & modifiedParts & ${AS_FIELD_SEP} & sharedFlag
        end repeat
          set output to ""
          repeat with recordItem in attachmentList
            set output to output & recordItem & ${AS_RECORD_SEP}
          end repeat
          return output
        end tell
      end tell
    `;

    const result = executeAppleScript(script);
    if (!result.success || !result.output) {
      if (result.error) {
        console.error(`Failed to list attachments for note "${title}":`, result.error);
      }
      return [];
    }

    // Parse the results
    const attachments: Attachment[] = [];
    const items = result.output.split(RECORD_SEP).filter((s) => s.trim());

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length >= 3) {
        attachments.push({
          id: parts[0].trim(),
          name: parts[1].trim(),
          contentType: parts[2].trim(),
          contentId: parts[2].trim() || undefined,
          url: normalizeAppleScriptText(parts[3]),
          created: parts[4] ? parseAppleScriptDate(parts[4].trim()) : undefined,
          modified: parts[5] ? parseAppleScriptDate(parts[5].trim()) : undefined,
          shared: parts[6] ? parts[6].trim().toLowerCase() === "true" : undefined,
        });
      }
    }

    return attachments;
  }

  /**
   * Saves a single attachment of a note (identified by attachment id) to a file
   * on disk via Notes.app's AppleScript `save` (#27).
   *
   * @param noteId - CoreData URL identifier for the note
   * @param attachmentId - id of the attachment (from list-attachments)
   * @param savePath - absolute destination file path (within home / temp / /Volumes)
   * @returns { success, savedPath?, name?, contentType?, error? }
   */
  saveAttachmentById(
    noteId: string,
    attachmentId: string,
    savePath: string
  ): { success: boolean; savedPath?: string; name?: string; contentType?: string; error?: string } {
    let abs: string;
    try {
      abs = assertSafeSavePath(savePath);
      // Notes' `save` does not create intermediate directories and fails with
      // an opaque error when the parent is missing, so create it up front.
      ensureParentDir(abs);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    const safeNoteId = sanitizeId(noteId);
    const safeAttId = escapePlainStringForAppleScript(attachmentId);
    const safePath = escapePlainStringForAppleScript(abs);

    const script = `
      tell application "Notes"
        set theNote to note id "${safeNoteId}"
        set theAttachment to missing value
        repeat with a in attachments of theNote
          if (id of a as text) is "${safeAttId}" then
            set theAttachment to a
            exit repeat
          end if
        end repeat
        if theAttachment is missing value then
          return "ERR" & ${AS_FIELD_SEP} & "attachment not found"
        end if
        set attachUrl to ""
        try
          set attachUrl to URL of theAttachment as text
        end try
        try
          save theAttachment in (POSIX file "${safePath}")
        on error errMsg
          return "ERRSAVE" & ${AS_FIELD_SEP} & errMsg & ${AS_FIELD_SEP} & attachUrl
        end try
        return "OK" & ${AS_FIELD_SEP} & (name of theAttachment) & ${AS_FIELD_SEP} & (content identifier of theAttachment)
      end tell
    `;

    const result = executeAppleScript(script);
    if (!result.success) {
      return { success: false, error: result.error ?? "unknown error" };
    }
    const parts = (result.output ?? "").trim().split(FIELD_SEP);
    if (parts[0] === "ERRSAVE") {
      const saveErr = (parts[1]?.trim() || "unknown error").replace(/\.$/, "");
      const rawUrl = parts[2]?.trim();
      const attachUrl = rawUrl && rawUrl !== "missing value" ? rawUrl : undefined;
      // Link-preview attachments (a pasted URL's rich preview) have no file
      // payload; Notes' `save` raises "AppleEvent handler failed" for them.
      const linkHint = attachUrl
        ? ` This attachment appears to be a link preview (URL: ${attachUrl}) rather than a file, and link previews have no file payload to save.`
        : "";
      return {
        success: false,
        error: `Notes could not save this attachment: ${saveErr}.${linkHint}`,
      };
    }
    if (parts[0] !== "OK") {
      return { success: false, error: parts[1]?.trim() || "attachment not found" };
    }
    if (!existsSync(abs) || fileSize(abs) === 0) {
      return { success: false, error: `Notes reported success but no file was written to ${abs}` };
    }
    return {
      success: true,
      savedPath: abs,
      name: parts[1]?.trim(),
      contentType: parts[2]?.trim(),
    };
  }

  /**
   * Fetches a note attachment as base64 (#27). Exports to a private temp file,
   * reads it, then deletes the temp copy.
   *
   * @param noteId - CoreData URL identifier for the note
   * @param attachmentId - id of the attachment
   * @returns { success, name?, contentType?, base64?, bytes?, error? }
   */
  getAttachmentBase64ById(
    noteId: string,
    attachmentId: string
  ): {
    success: boolean;
    name?: string;
    contentType?: string;
    base64?: string;
    bytes?: number;
    error?: string;
  } {
    const dir = makeTempDir();
    try {
      const dest = `${dir}/attachment.bin`;
      const saved = this.saveAttachmentById(noteId, attachmentId, dest);
      if (!saved.success || !saved.savedPath) {
        return { success: false, error: saved.error };
      }
      // readFileBase64Capped checks the file size BEFORE reading and throws if it
      // exceeds APPLE_NOTES_MCP_MAX_ATTACHMENT_BYTES — the throw is caught below
      // and the temp dir is still cleaned up in `finally`.
      const base64 = readFileBase64Capped(saved.savedPath);
      return {
        success: true,
        name: saved.name,
        contentType: saved.contentType,
        base64,
        bytes: fileSize(saved.savedPath),
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Result of a batch operation on a single item.
   */
  private createBatchResult(
    id: string,
    success: boolean,
    error?: string
  ): { id: string; success: boolean; error?: string } {
    return error ? { id, success, error } : { id, success };
  }

  /**
   * Deletes multiple notes by their IDs.
   *
   * Each deletion is attempted independently; failures don't stop other deletions.
   * Returns results for each note indicating success or failure.
   *
   * @param ids - Array of CoreData URL identifiers for notes to delete
   * @returns Array of results with id, success status, and optional error message
   *
   * @example
   * ```typescript
   * const results = manager.batchDeleteNotes([
   *   "x-coredata://ABC/ICNote/p1",
   *   "x-coredata://ABC/ICNote/p2"
   * ]);
   * results.forEach(r => {
   *   if (r.success) console.log(`Deleted ${r.id}`);
   *   else console.log(`Failed to delete ${r.id}: ${r.error}`);
   * });
   * ```
   */
  batchDeleteNotes(ids: string[]): { id: string; success: boolean; error?: string }[] {
    if (ids.length === 0) return [];

    // Collapse the whole batch into ONE osascript spawn (#26): a single
    // app-level script loops over every id, with a per-id `try` so one bad note
    // can't abort the rest. The old path spawned 3 processes per note
    // (getNoteById + isNotePasswordProtectedById + deleteNoteById) — i.e. 3N
    // spawns for N notes. This is one spawn total, with the same per-item
    // isolation and result semantics.
    const results: { id: string; success: boolean; error?: string }[] = new Array(ids.length);
    const runnable: { index: number; safe: string }[] = [];

    ids.forEach((id, i) => {
      try {
        runnable.push({ index: i, safe: sanitizeId(id) });
      } catch (e) {
        results[i] = this.createBatchResult(
          id,
          false,
          e instanceof Error ? e.message : "Invalid note ID"
        );
      }
    });

    if (runnable.length > 0) {
      const idList = runnable.map((r) => `"${r.safe}"`).join(", ");
      const script = buildAppLevelScript(`
        set out to ""
        repeat with rawId in {${idList}}
          set theId to (rawId as text)
          set noteRef to missing value
          try
            set noteRef to note id theId
          end try
          if noteRef is missing value then
            set out to out & "missing" & ${AS_RECORD_SEP}
          else
            set isPw to false
            try
              set isPw to (password protected of noteRef)
            end try
            if isPw then
              set out to out & "pw" & ${AS_RECORD_SEP}
            else
              try
                delete noteRef
                set out to out & "ok" & ${AS_RECORD_SEP}
              on error
                set out to out & "fail" & ${AS_RECORD_SEP}
              end try
            end if
          end if
        end repeat
        return out
      `);
      const res = executeAppleScript(script);

      if (!res.success) {
        // Whole-batch failure (e.g. Notes.app not responding): can't isolate,
        // so mark every runnable note as failed with the underlying error.
        for (const r of runnable) {
          results[r.index] = this.createBatchResult(
            ids[r.index],
            false,
            res.error ?? "Batch delete failed"
          );
        }
      } else {
        const statuses = res.output
          .split(RECORD_SEP)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        runnable.forEach((r, k) => {
          results[r.index] = this.mapBatchStatus(ids[r.index], statuses[k], "delete");
        });
      }
    }

    return results;
  }

  /**
   * Maps a per-item status token emitted by a batch AppleScript loop to a
   * BatchResult, preserving the human-readable error messages of the original
   * per-note implementation. See {@link batchDeleteNotes} / {@link batchMoveNotes}.
   */
  private mapBatchStatus(
    id: string,
    status: string | undefined,
    op: "delete" | "move"
  ): { id: string; success: boolean; error?: string } {
    switch (status) {
      case "ok":
        return this.createBatchResult(id, true);
      case "pw":
        return this.createBatchResult(id, false, "Note is password-protected");
      case "missing":
        return this.createBatchResult(id, false, "Note not found");
      case "fail":
        return this.createBatchResult(
          id,
          false,
          op === "delete" ? "Deletion failed" : "Move failed"
        );
      default:
        return this.createBatchResult(id, false, "Unknown error");
    }
  }

  /**
   * Moves multiple notes to a folder by their IDs.
   *
   * Each move is attempted independently; failures don't stop other moves.
   * Returns results for each note indicating success or failure.
   *
   * @param ids - Array of CoreData URL identifiers for notes to move
   * @param folder - Destination folder name
   * @param account - Account containing the folder (defaults to iCloud)
   * @returns Array of results with id, success status, and optional error message
   *
   * @example
   * ```typescript
   * const results = manager.batchMoveNotes(
   *   ["x-coredata://ABC/ICNote/p1", "x-coredata://ABC/ICNote/p2"],
   *   "Archive"
   * );
   * ```
   */
  batchMoveNotes(
    ids: string[],
    folder: string,
    account?: string
  ): { id: string; success: boolean; error?: string }[] {
    if (ids.length === 0) return [];

    // Collapse the whole batch into ONE osascript spawn (#26). The old path
    // spawned 5+ processes per note (getNoteById + isNotePasswordProtectedById +
    // moveNoteById's copy-then-delete fan-out). This uses the native `move`
    // command — which preserves the note's identity and metadata rather than
    // copy+delete — inside a single app-level loop with per-id `try` isolation.
    const targetAccount = this.resolveAccount(account);
    const safeAccount = sanitizeAccountName(targetAccount);
    // buildFolderReference validates the (single, shared) destination path; a
    // malformed folder is a precondition error for the whole call, so let it throw.
    const destFolderRef = `${buildFolderReference(folder)} of account "${safeAccount}"`;

    const results: { id: string; success: boolean; error?: string }[] = new Array(ids.length);
    const runnable: { index: number; safe: string }[] = [];

    ids.forEach((id, i) => {
      try {
        runnable.push({ index: i, safe: sanitizeId(id) });
      } catch (e) {
        results[i] = this.createBatchResult(
          id,
          false,
          e instanceof Error ? e.message : "Invalid note ID"
        );
      }
    });

    if (runnable.length > 0) {
      const idList = runnable.map((r) => `"${r.safe}"`).join(", ");
      const script = buildAppLevelScript(`
        set destFolder to ${destFolderRef}
        set out to ""
        repeat with rawId in {${idList}}
          set theId to (rawId as text)
          set noteRef to missing value
          try
            set noteRef to note id theId
          end try
          if noteRef is missing value then
            set out to out & "missing" & ${AS_RECORD_SEP}
          else
            set isPw to false
            try
              set isPw to (password protected of noteRef)
            end try
            if isPw then
              set out to out & "pw" & ${AS_RECORD_SEP}
            else
              try
                move noteRef to destFolder
                set out to out & "ok" & ${AS_RECORD_SEP}
              on error
                set out to out & "fail" & ${AS_RECORD_SEP}
              end try
            end if
          end if
        end repeat
        return out
      `);
      const res = executeAppleScript(script);

      if (!res.success) {
        // Whole-batch failure (e.g. destination folder unresolved, Notes not
        // responding): can't isolate, so fail every runnable note.
        for (const r of runnable) {
          results[r.index] = this.createBatchResult(
            ids[r.index],
            false,
            res.error ?? "Batch move failed"
          );
        }
      } else {
        const statuses = res.output
          .split(RECORD_SEP)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        runnable.forEach((r, k) => {
          results[r.index] = this.mapBatchStatus(ids[r.index], statuses[k], "move");
        });
      }
    }

    return results;
  }

  // ===========================================================================
  // Export Operations
  // ===========================================================================

  /**
   * Export structure for a single note.
   */
  private exportNote(note: Note, content: string): ExportedNote {
    return {
      id: note.id,
      title: note.title,
      content: content,
      plaintext: this.htmlToPlaintext(content),
      folder: note.folder || "Notes",
      account: note.account || "iCloud",
      created: note.created.toISOString(),
      modified: note.modified.toISOString(),
      shared: note.shared || false,
      passwordProtected: note.passwordProtected || false,
    };
  }

  /**
   * Simple HTML to plaintext conversion for export.
   */
  private htmlToPlaintext(html: string): string {
    // Convert block/line breaks to newlines first.
    let text = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/p>/gi, "\n");

    // Strip any remaining tags, looping until the string stabilizes. A single
    // pass can leave residue when removing one tag re-forms another (e.g.
    // "<<i>>"), so we repeat until there are no more matches — the recognized
    // fix for CodeQL js/incomplete-multi-character-sanitization.
    let prev: string;
    do {
      prev = text;
      text = text.replace(/<[^>]*>/g, "");
    } while (text !== prev);

    return (
      text
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#92;/g, "\\")
        // Decode &amp; LAST so an encoded entity like "&amp;lt;" round-trips to the
        // literal "&lt;" instead of being double-unescaped to "<".
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }

  /**
   * Exports all notes as a JSON structure for backup/migration.
   *
   * Exports complete note data including:
   * - Metadata (id, title, dates, flags)
   * - Content (HTML and plaintext)
   * - Organization (folder, account)
   *
   * Note: Password-protected notes are included with metadata only (no content).
   *
   * @returns JSON-serializable export object
   *
   * @example
   * ```typescript
   * const snapshot = manager.exportNotesAsJson();
   * fs.writeFileSync('notes-backup.json', JSON.stringify(snapshot, null, 2));
   * ```
   */
  exportNotesAsJson(): NotesExport {
    const accounts = this.listAccounts();
    const exportData: NotesExport = {
      exportDate: new Date().toISOString(),
      version: "1.0",
      accounts: [],
      summary: { totalNotes: 0, totalFolders: 0, totalAccounts: accounts.length },
    };

    for (const account of accounts) {
      const folders = this.listFolders(account.name);
      const accountData: ExportedAccount = {
        name: account.name,
        folders: [],
      };

      for (const folder of folders) {
        const folderData: ExportedFolder = {
          name: folder.name,
          notes: [],
        };

        // Get all note titles in this folder
        const noteTitles = this.listNotes(account.name, folder.name);

        for (const title of noteTitles) {
          // Get note details
          const note = this.getNoteDetails(title, account.name);
          if (!note) continue;

          // Skip password-protected notes' content but include metadata
          let content = "";
          if (!note.passwordProtected) {
            content = this.getNoteContent(title, account.name);
          }

          folderData.notes.push(this.exportNote(note, content));
          exportData.summary.totalNotes++;
        }

        accountData.folders.push(folderData);
        exportData.summary.totalFolders++;
      }

      exportData.accounts.push(accountData);
    }

    return exportData;
  }

  // ===========================================================================
  // Markdown Conversion
  // ===========================================================================

  /**
   * Turndown service instance for HTML to Markdown conversion.
   * Configured for Apple Notes HTML quirks.
   * Initialized lazily on first use.
   */
  private turndownService!: TurndownService;

  /**
   * Initialize the Turndown service with Apple Notes-specific rules.
   */
  private initTurndownService(): void {
    if (this.turndownService) return;

    this.turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });

    // Handle Apple Notes-specific HTML patterns
    // Notes.app uses <div> instead of <p> for paragraphs
    this.turndownService.addRule("notesDivs", {
      filter: "div",
      replacement: (content: string) => {
        return content + "\n";
      },
    });
  }

  /**
   * Converts HTML content to Markdown.
   *
   * @param html - HTML content from Notes.app
   * @returns Markdown formatted content
   */
  private htmlToMarkdown(html: string): string {
    this.initTurndownService();
    return this.turndownService.turndown(html).trim();
  }

  /**
   * Enriches markdown with checklist state from the NoteStore database.
   *
   * Apple Notes checklists appear as plain list items in the AppleScript HTML
   * output. This method reads the protobuf data to get done/undone state and
   * annotates matching list items with [x] or [ ] prefixes.
   *
   * Fails silently (returns original markdown) if the database is inaccessible
   * or the note has no checklists.
   *
   * @param markdown - The base markdown content
   * @param checklistItems - Checklist items with done state
   * @returns Markdown with checklist annotations
   */
  private enrichMarkdownWithChecklists(markdown: string, checklistItems: ChecklistItem[]): string {
    if (checklistItems.length === 0) return markdown;

    // Build a map of checklist text → done state
    const checklistMap = new Map<string, boolean>();
    for (const item of checklistItems) {
      checklistMap.set(item.text.trim(), item.done);
    }

    // Replace matching list items with checkbox syntax
    const lines = markdown.split("\n");
    const enriched = lines.map((line) => {
      // Match markdown list items: "- text" or "* text"
      const listMatch = line.match(/^(\s*[-*])\s+(.+)$/);
      if (!listMatch) return line;

      const [, prefix, text] = listMatch;
      const done = checklistMap.get(text.trim());
      if (done === undefined) return line;

      // Remove from map so duplicate text lines aren't all converted
      checklistMap.delete(text.trim());
      return `${prefix} ${done ? "[x]" : "[ ]"} ${text}`;
    });

    return enriched.join("\n");
  }

  /**
   * Gets note content as Markdown by title.
   *
   * If the note contains checklists and the NoteStore database is accessible
   * (Full Disk Access required), checklist items will be annotated with
   * [x] (done) or [ ] (undone) prefixes.
   *
   * @param title - Exact title of the note
   * @param account - Account containing the note (defaults to iCloud)
   * @returns Markdown content, or empty string if not found
   *
   * @example
   * ```typescript
   * const md = manager.getNoteMarkdown("Shopping List");
   * console.log(md); // "# Shopping List\n\n- [x] Eggs\n- [ ] Milk"
   * ```
   */
  getNoteMarkdown(title: string, account?: string): string {
    const html = this.getNoteContent(title, account);
    if (!html) return "";
    let markdown = this.htmlToMarkdown(html);

    // Try to enrich with checklist state (requires note ID)
    const note = this.getNoteDetails(title, account);
    if (note?.id) {
      const result = getChecklistItems(note.id);
      if (result.items) {
        markdown = this.enrichMarkdownWithChecklists(markdown, result.items);
      }
    }

    return markdown;
  }

  /**
   * Gets note content as Markdown by ID.
   *
   * This is more reliable than getNoteMarkdown() because IDs are unique
   * across all accounts, while titles can be duplicated.
   *
   * If the note contains checklists and the NoteStore database is accessible
   * (Full Disk Access required), checklist items will be annotated with
   * [x] (done) or [ ] (undone) prefixes.
   *
   * @param id - CoreData URL identifier for the note
   * @returns Markdown content, or empty string if not found
   */
  getNoteMarkdownById(id: string): string {
    const html = this.getNoteContentById(id);
    if (!html) return "";
    let markdown = this.htmlToMarkdown(html);

    // Try to enrich with checklist state
    const result = getChecklistItems(id);
    if (result.items) {
      markdown = this.enrichMarkdownWithChecklists(markdown, result.items);
    }

    return markdown;
  }
}
