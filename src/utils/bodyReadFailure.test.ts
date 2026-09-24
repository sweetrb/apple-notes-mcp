import { describe, expect, it } from "vitest";
import {
  classifyBodyReadError,
  describeBodyReadFailure,
  formatBytes,
  largeAttachments,
} from "./bodyReadFailure.js";
import { noteBodyMaxBuffer, outputOverflowMessage } from "./applescript.js";

const TIMEOUT =
  "Operation timed out after 30 seconds. Notes.app may be unresponsive or the operation involves too many notes.";
const MB = 1024 * 1024;

describe("classifyBodyReadError", () => {
  it("recognizes the runner timeout, an AppleEvent timeout, and a buffer overflow", () => {
    expect(classifyBodyReadError(TIMEOUT)).toBe("timeout");
    expect(classifyBodyReadError("Notes got an error: AppleEvent timed out.")).toBe("timeout");
    expect(classifyBodyReadError("spawnSync osascript ENOBUFS")).toBe("buffer");
    expect(classifyBodyReadError("Not found: note id x")).toBe("other");
    expect(classifyBodyReadError(undefined)).toBe("other");
  });

  it("recognizes the runner's own overflow error as a size limit, not a timeout", () => {
    // What executeAppleScript reports once osascript prints more than the cap.
    expect(classifyBodyReadError(outputOverflowMessage(64 * MB))).toBe("buffer");
    expect(classifyBodyReadError(outputOverflowMessage(noteBodyMaxBuffer()))).toBe("buffer");
    expect(classifyBodyReadError(outputOverflowMessage(50))).toBe("buffer");
    expect(classifyBodyReadError("Cannot create a string (ERR_STRING_TOO_LONG)")).toBe("buffer");
  });
});

describe("largeAttachments", () => {
  it("lists attachments at or over the threshold, children included, largest first", () => {
    const found = largeAttachments([
      { filename: "small.png", fileSize: MB },
      { filename: "scan.tiff", fileSize: 36 * MB },
      { title: "Gallery", children: [{ filename: "page.jpg", fileSize: 6 * MB }] },
      { filename: "unknown" },
    ]);
    expect(found).toEqual([
      { name: "scan.tiff", bytes: 36 * MB },
      { name: "page.jpg", bytes: 6 * MB },
    ]);
  });

  it("formats sizes", () => {
    expect(formatBytes(36 * MB)).toBe("36.0 MB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(12)).toBe("12 bytes");
  });
});

describe("describeBodyReadFailure", () => {
  it("names the large attachment and the timeout remedy", () => {
    const text = describeBodyReadFailure("Test", TIMEOUT, [
      { filename: "scan.tiff", fileSize: 36 * MB },
    ]);
    expect(text).toMatch(/^Failed to read content of note "Test": Operation timed out/);
    expect(text).toContain("scan.tiff, 36.0 MB");
    expect(text).toContain("timeoutSeconds");
    expect(text).toContain("delete-note needs a successful read");
  });

  it("still explains a timeout when the attachments could not be read", () => {
    const text = describeBodyReadFailure("Test", TIMEOUT, undefined);
    expect(text).toContain("base64");
    expect(text).toContain("timeoutSeconds");
  });

  it("explains a body over the read cap as a size limit that retrying cannot fix", () => {
    const overflow = outputOverflowMessage(noteBodyMaxBuffer());
    const text = describeBodyReadFailure("Test", overflow, [
      { filename: "scan.tiff", fileSize: 400 * MB },
    ]);
    expect(text.startsWith(`Failed to read content of note "Test": ${overflow}\n\n`)).toBe(true);
    expect(text).toContain("scan.tiff, 400.0 MB");
    expect(text).toContain("will not help");
    expect(text).toContain("delete-note needs a successful read");
    // None of the timeout explanation or its remedy.
    expect(text).not.toMatch(
      /in time|timeout allows|Retry with a longer|APPLE_NOTES_MCP_TIMEOUT_MS/
    );
  });

  it("keeps the cap's own remedy when the general cap overflowed", () => {
    const text = describeBodyReadFailure("Test", outputOverflowMessage(64 * MB), undefined);
    expect(text).toContain("Raise APPLE_NOTES_MCP_MAX_BUFFER");
    expect(text).toContain("base64");
    expect(text).not.toContain("Retry with a longer");
  });

  it("treats a raw ENOBUFS the same way", () => {
    const text = describeBodyReadFailure("Test", "spawnSync osascript ENOBUFS", []);
    expect(text).toContain("will not help");
    expect(text).not.toContain("Retry with a longer");
  });

  it("keeps other failures to the plain message", () => {
    expect(describeBodyReadFailure("Test", "Not found: note id x", [])).toBe(
      'Failed to read content of note "Test": Not found: note id x'
    );
    expect(describeBodyReadFailure("Test", undefined, undefined)).toBe(
      'Failed to read content of note "Test"'
    );
  });
});
