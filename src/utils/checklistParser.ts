/**
 * Apple Notes Checklist State Parser
 *
 * Reads checklist done/undone state by querying the NoteStore SQLite database
 * and decoding the protobuf-encoded note content. This bypasses the AppleScript
 * limitation where `body of note` strips checklist state information.
 *
 * Data flow:
 * 1. Query NoteStore.sqlite for the gzipped protobuf blob (ZICNOTEDATA.ZDATA)
 * 2. Decompress with gzip
 * 3. Decode protobuf to extract text and attribute runs
 * 4. Walk attribute runs to identify checklist items and their done state
 *
 * Protobuf field path:
 *   Document (root) → field 2 (Note) → field 3 (Note body)
 *     → field 2 (note_text: plain text)
 *     → field 5 (attribute_run: repeated styling runs)
 *       → field 1 (length)
 *       → field 2 (paragraph_style)
 *         → field 1 (style_type: 103 = checklist)
 *         → field 5 (checklist)
 *           → field 2 (done: 0 = unchecked, 1 = checked)
 *
 * @module utils/checklistParser
 * @see https://github.com/sweetrb/apple-notes-mcp/issues/2
 */

import { execSync } from "child_process";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  decodeMessage,
  getField,
  getFields,
  varintValue,
  stringValue,
  embeddedMessage,
} from "@/utils/protobuf.js";

/** Style type value for checklist items in Apple Notes protobuf format. */
const CHECKLIST_STYLE_TYPE = 103;

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/**
 * A single checklist item with its text and done state.
 */
export interface ChecklistItem {
  /** The text content of the checklist item */
  text: string;
  /** Whether the item is checked (done) */
  done: boolean;
}

/**
 * Result from getChecklistItems with specific error classification.
 */
export interface ChecklistResult {
  /** Checklist items, or null on failure */
  items: ChecklistItem[] | null;
  /** Error type for actionable messaging */
  error?: "no_fda" | "no_checklists" | "invalid_id" | "parse_error";
  /** Human-readable error message */
  message?: string;
}

/**
 * Checks whether the NoteStore database is accessible (Full Disk Access).
 *
 * @returns true if the database file exists and can be read
 */
export function hasFullDiskAccess(): boolean {
  try {
    if (!fs.existsSync(NOTES_DB_PATH)) return false;
    // Try to open the database with a simple query
    execSync(`sqlite3 -readonly "${NOTES_DB_PATH}" "SELECT 1;"`, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Queries the NoteStore SQLite database for a note's raw ZDATA blob.
 *
 * Uses the note's CoreData identifier to find the corresponding protobuf data.
 * The identifier is extracted from the full CoreData URL format:
 *   x-coredata://DEVICE-UUID/ICNote/pXXXX → pXXXX
 *
 * @param noteId - CoreData URL identifier (e.g., "x-coredata://ABC/ICNote/p123")
 * @returns Object with hex data or error classification
 */
function queryNoteData(noteId: string): { hex: string | null; error?: "no_fda" | "invalid_id" } {
  // Extract the primary key suffix (e.g., "p123" from "x-coredata://ABC/ICNote/p123")
  const pkMatch = noteId.match(/\/p(\d+)$/);
  if (!pkMatch) {
    console.error(`Invalid note ID format: ${noteId}`);
    return { hex: null, error: "invalid_id" };
  }
  const pk = pkMatch[1];

  // Query for the gzipped protobuf data, output as hex for safe transport
  const query = `SELECT hex(nd.ZDATA) FROM ZICNOTEDATA nd JOIN ZICCLOUDSYNCINGOBJECT n ON nd.ZNOTE = n.Z_PK WHERE n.Z_PK = ${pk};`;

  try {
    const result = execSync(`sqlite3 -readonly "${NOTES_DB_PATH}" "${query}"`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const hex = result.trim();
    if (!hex) return { hex: null };

    return { hex };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to query NoteStore database: ${message}`);

    // Detect Full Disk Access denial
    if (message.includes("authorization denied") || message.includes("unable to open database")) {
      return { hex: null, error: "no_fda" };
    }

    return { hex: null };
  }
}

/**
 * Converts a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Extracts checklist items from a protobuf-encoded note.
 *
 * Navigates the protobuf structure:
 *   Document → Note (field 2) → Note body (field 3)
 *     → note_text (field 2): plain text with \n line separators
 *     → attribute_run (field 5): repeated, sequential styling runs
 *
 * Walks attribute runs sequentially, tracking character position in the plain
 * text. When a run has style_type == 103 (checklist), extracts the line text
 * and done state.
 *
 * @param data - Decompressed protobuf bytes
 * @returns Array of checklist items, or null if parsing fails
 */
function parseChecklistFromProtobuf(data: Uint8Array): ChecklistItem[] | null {
  try {
    // Document root
    const docFields = decodeMessage(data);

    // Field 2 = Note (Version/Document wrapper)
    const noteWrapper = getField(docFields, 2);
    const noteWrapperFields = embeddedMessage(noteWrapper);
    if (!noteWrapperFields) return null;

    // Field 3 = Note body (the actual content)
    const noteBody = getField(noteWrapperFields, 3);
    const noteBodyFields = embeddedMessage(noteBody);
    if (!noteBodyFields) return null;

    // Field 2 = note_text (plain text content)
    const noteTextField = getField(noteBodyFields, 2);
    const noteText = stringValue(noteTextField);
    if (!noteText) return null;

    // Field 5 = attribute_run (repeated)
    const attributeRuns = getFields(noteBodyFields, 5);
    if (attributeRuns.length === 0) return null;

    // Split text into lines for mapping
    const lines = noteText.split("\n");

    // Walk attribute runs, tracking position in the text
    const items: ChecklistItem[] = [];
    let charPos = 0;
    // Track which lines we've already added (multiple runs can cover the same line)
    const seenLines = new Set<number>();

    for (const run of attributeRuns) {
      const runFields = embeddedMessage(run);
      if (!runFields) continue;

      // Field 1 = length (character count this run covers)
      const lengthField = getField(runFields, 1);
      const runLength = varintValue(lengthField) ?? 0;

      // Field 2 = paragraph_style
      const paragraphStyle = getField(runFields, 2);
      const styleFields = embeddedMessage(paragraphStyle);

      if (styleFields) {
        // Field 1 = style_type
        const styleType = varintValue(getField(styleFields, 1));

        if (styleType === CHECKLIST_STYLE_TYPE) {
          // Field 5 = checklist info
          const checklistField = getField(styleFields, 5);
          const checklistFields = embeddedMessage(checklistField);

          // Field 2 = done (0 = unchecked, 1 = checked)
          const done = checklistFields ? (varintValue(getField(checklistFields, 2)) ?? 0) : 0;

          // Find which line this position corresponds to
          let lineStart = 0;
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const lineEnd = lineStart + lines[lineIdx].length;
            if (charPos >= lineStart && charPos < lineEnd + 1 && !seenLines.has(lineIdx)) {
              seenLines.add(lineIdx);
              items.push({
                text: lines[lineIdx],
                done: done === 1,
              });
              break;
            }
            lineStart = lineEnd + 1; // +1 for the \n
          }
        }
      }

      charPos += runLength;
    }

    return items;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse protobuf checklist data: ${message}`);
    return null;
  }
}

/**
 * Gets the checklist state for a note by its CoreData ID.
 *
 * This reads directly from the NoteStore SQLite database, bypassing
 * AppleScript's limitation of stripping checklist state from `body of note`.
 *
 * Requires Full Disk Access to read the Notes database.
 *
 * @param noteId - CoreData URL identifier (e.g., "x-coredata://ABC/ICNote/p123")
 * @returns Structured result with items, error type, and message
 */
export function getChecklistItems(noteId: string): ChecklistResult {
  // Query the database for raw note data
  const { hex: hexData, error: queryError } = queryNoteData(noteId);

  if (queryError === "invalid_id") {
    return {
      items: null,
      error: "invalid_id",
      message: `Invalid note ID format: "${noteId}". Expected format: x-coredata://UUID/ICNote/pNNN`,
    };
  }

  if (queryError === "no_fda") {
    return {
      items: null,
      error: "no_fda",
      message:
        "Full Disk Access is required to read checklist state. " +
        "Grant access in System Settings > Privacy & Security > Full Disk Access, " +
        "then add and restart this application.",
    };
  }

  if (!hexData) {
    return {
      items: null,
      error: "no_checklists",
      message: "No data found for this note in the database.",
    };
  }

  // Convert hex to bytes and decompress
  const compressedData = hexToBytes(hexData);
  let decompressed: Buffer;
  try {
    decompressed = zlib.gunzipSync(compressedData);
  } catch {
    console.error("Failed to decompress note data — may not be gzip format");
    return {
      items: null,
      error: "parse_error",
      message: "Failed to decompress note data.",
    };
  }

  // Parse protobuf and extract checklist items
  const items = parseChecklistFromProtobuf(new Uint8Array(decompressed));
  if (!items || items.length === 0) {
    return {
      items: null,
      error: "no_checklists",
      message: "This note does not contain any checklist items.",
    };
  }

  return { items };
}
