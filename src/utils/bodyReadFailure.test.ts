import { describe, expect, it } from "vitest";
import {
  classifyBodyReadError,
  describeBodyReadFailure,
  formatBytes,
  largeAttachments,
} from "./bodyReadFailure.js";

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

  it("points a buffer overflow at APPLE_NOTES_MCP_MAX_BUFFER", () => {
    expect(describeBodyReadFailure("Test", "spawnSync osascript ENOBUFS", [])).toContain(
      "APPLE_NOTES_MCP_MAX_BUFFER"
    );
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
