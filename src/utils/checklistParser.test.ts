/**
 * Tests for the Apple Notes checklist state parser.
 *
 * These tests mock the SQLite database access and test the protobuf
 * parsing logic with realistic test fixtures.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as zlib from "zlib";
import { getChecklistItems } from "./checklistParser.js";

// Mock child_process to avoid actual database access
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null })),
}));

// Mock fs for database existence checks
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

import { execSync } from "child_process";
const mockExecSync = vi.mocked(execSync);

/**
 * Builds a minimal Apple Notes protobuf structure with checklist items.
 *
 * Structure:
 *   Document (root)
 *     field 2 (Note wrapper)
 *       field 3 (Note body)
 *         field 2 (note_text: plain text)
 *         field 5 (attribute_run) - repeated
 */
function buildChecklistProtobuf(items: Array<{ text: string; done: boolean }>): Uint8Array {
  // Helper to encode a varint
  function encodeVarint(value: number): number[] {
    const bytes: number[] = [];
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return bytes;
  }

  // Helper to encode a tag
  function encodeTag(fieldNumber: number, wireType: number): number[] {
    return encodeVarint((fieldNumber << 3) | wireType);
  }

  // Helper to wrap bytes as a length-delimited field
  function lengthDelimited(fieldNumber: number, data: Uint8Array | number[]): number[] {
    const bytes = data instanceof Uint8Array ? Array.from(data) : data;
    return [...encodeTag(fieldNumber, 2), ...encodeVarint(bytes.length), ...bytes];
  }

  // Helper to encode a varint field
  function varintField(fieldNumber: number, value: number): number[] {
    return [...encodeTag(fieldNumber, 0), ...encodeVarint(value)];
  }

  // Build the plain text: "Title\nitem1\nitem2\n..."
  const textLines = ["Checklist Note", ...items.map((i) => i.text)];
  const noteText = textLines.join("\n");
  const encoder = new TextEncoder();

  // Build attribute runs
  // First run: title line (not a checklist)
  const titleLength = textLines[0].length + 1; // +1 for \n
  const titleRun = lengthDelimited(5, [
    ...varintField(1, titleLength), // length
    // No paragraph_style with checklist — just a regular paragraph
  ]);

  // Checklist runs
  const checklistRuns: number[] = [];
  for (const item of items) {
    const runLength = item.text.length + 1; // +1 for \n (or end of text)

    // Build checklist info: field 2 = done
    const checklistInfo = lengthDelimited(5, varintField(2, item.done ? 1 : 0));

    // Build paragraph_style: field 1 = 103 (checklist), field 5 = checklist info
    const paragraphStyle = lengthDelimited(2, [...varintField(1, 103), ...checklistInfo]);

    // Build attribute run: field 1 = length, field 2 = paragraph_style
    const run = lengthDelimited(5, [...varintField(1, runLength), ...paragraphStyle]);

    checklistRuns.push(...run);
  }

  // Build note body (field 3):
  //   field 2 = note_text, field 5 = attribute_runs (already encoded above)
  const noteTextField = lengthDelimited(2, encoder.encode(noteText));
  const noteBody = lengthDelimited(3, [...noteTextField, ...titleRun, ...checklistRuns]);

  // Build note wrapper (field 2 of document)
  const noteWrapper = lengthDelimited(2, noteBody);

  return new Uint8Array(noteWrapper);
}

describe("getChecklistItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for invalid note ID format", () => {
    const result = getChecklistItems("invalid-id");
    expect(result).toBeNull();
  });

  it("returns null when database query returns empty", () => {
    mockExecSync.mockReturnValue("" as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p123");
    expect(result).toBeNull();
  });

  it("parses checklist with mixed done/undone items", () => {
    const items = [
      { text: "Buy milk", done: true },
      { text: "Walk dog", done: false },
      { text: "Send email", done: true },
    ];

    const protobuf = buildChecklistProtobuf(items);
    const compressed = zlib.gzipSync(Buffer.from(protobuf));
    const hex = Buffer.from(compressed).toString("hex").toUpperCase();

    mockExecSync.mockReturnValue((hex + "\n") as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p123");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toEqual({ text: "Buy milk", done: true });
    expect(result![1]).toEqual({ text: "Walk dog", done: false });
    expect(result![2]).toEqual({ text: "Send email", done: true });
  });

  it("parses checklist with all items unchecked", () => {
    const items = [
      { text: "Task A", done: false },
      { text: "Task B", done: false },
    ];

    const protobuf = buildChecklistProtobuf(items);
    const compressed = zlib.gzipSync(Buffer.from(protobuf));
    const hex = Buffer.from(compressed).toString("hex").toUpperCase();

    mockExecSync.mockReturnValue((hex + "\n") as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p456");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result!.every((i) => !i.done)).toBe(true);
  });

  it("parses checklist with all items checked", () => {
    const items = [
      { text: "Done 1", done: true },
      { text: "Done 2", done: true },
    ];

    const protobuf = buildChecklistProtobuf(items);
    const compressed = zlib.gzipSync(Buffer.from(protobuf));
    const hex = Buffer.from(compressed).toString("hex").toUpperCase();

    mockExecSync.mockReturnValue((hex + "\n") as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p789");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result!.every((i) => i.done)).toBe(true);
  });

  it("returns null when note has no checklist items", () => {
    // Build a protobuf with no checklist style_type
    const encoder = new TextEncoder();

    // Minimal note with just text, no checklist runs
    // Field 2 (note text) = "Just a regular note"
    const noteText = encoder.encode("Just a regular note");
    const noteTextField = [0x12, noteText.length, ...noteText]; // field 2, length-delimited

    // A non-checklist attribute run (style_type = 0, regular paragraph)
    const regularRun = [
      0x2a, // field 5, length-delimited (attribute_run)
      0x04, // length 4
      0x08,
      0x13, // field 1 (length) = 19
      0x12,
      0x00, // field 2 (paragraph_style) = empty
    ];

    const noteBody = [
      0x1a, // field 3, length-delimited
      noteTextField.length + regularRun.length,
      ...noteTextField,
      ...regularRun,
    ];

    const noteWrapper = [0x12, noteBody.length, ...noteBody]; // field 2

    const compressed = zlib.gzipSync(Buffer.from(new Uint8Array(noteWrapper)));
    const hex = Buffer.from(compressed).toString("hex").toUpperCase();

    mockExecSync.mockReturnValue((hex + "\n") as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p100");
    expect(result).toBeNull();
  });

  it("returns null when sqlite3 command fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("database is locked");
    });

    const result = getChecklistItems("x-coredata://ABC/ICNote/p123");
    expect(result).toBeNull();
  });

  it("returns null for non-gzip data", () => {
    // Return valid hex that isn't gzip
    mockExecSync.mockReturnValue("DEADBEEF\n" as never);

    const result = getChecklistItems("x-coredata://ABC/ICNote/p123");
    expect(result).toBeNull();
  });

  it("extracts correct primary key from note ID", () => {
    mockExecSync.mockReturnValue("" as never);

    getChecklistItems("x-coredata://12345-ABCDE/ICNote/p42");

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("Z_PK = 42"),
      expect.any(Object)
    );
  });
});
