/**
 * Tests for save-attachment / fetch-attachment manager methods (#27).
 * AppleScript is mocked; the filesystem side runs for real in a temp dir, with
 * the mock writing the file the way Notes.app's `save` would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
vi.mock("@/utils/checklistParser.js", () => ({
  getChecklistItems: vi.fn().mockReturnValue({ items: null }),
}));

import { AppleNotesManager } from "@/services/appleNotesManager.js";
import { executeAppleScript } from "@/utils/applescript.js";

const mockExec = vi.mocked(executeAppleScript);
const F = "\x1f";
let manager: AppleNotesManager;
const tmpDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  manager = new AppleNotesManager();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveAttachmentById (#27)", () => {
  it("saves to an allowed path and returns metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "anatt-"));
    tmpDirs.push(dir);
    const dest = join(dir, "photo.png");
    mockExec.mockImplementation((script: string) => {
      const m = script.match(/POSIX file "([^"]+)"/);
      if (m) writeFileSync(m[1], Buffer.from("PNGDATA"));
      return { success: true, output: ["OK", "photo.png", "public.png"].join(F) };
    });

    const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", dest);
    expect(r.success).toBe(true);
    expect(r.savedPath).toBe(dest);
    expect(r.name).toBe("photo.png");
    expect(r.contentType).toBe("public.png");
  });

  it("emits real separator characters in the OK/ERR sentinel protocol", () => {
    // Regression: `return "OK${AS_FIELD_SEP}" & ...` interpolated the
    // separator INSIDE the AppleScript string literal, so the script returned
    // the literal separator expression text ("OK(ASCII character 31)..." at
    // the time) instead of a control character. The TS split never matched
    // and every successful save was misreported as "attachment not found"
    // even though the file was written. The separator is `character id` since
    // #162: inside a Notes tell block `ASCII character` costs an Apple Event.
    mockExec.mockReturnValueOnce({ success: true, output: "" });

    manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", join(tmpdir(), "x.png"));

    const script = mockExec.mock.calls[0][0] as string;
    expect(script).not.toMatch(/"(?:OK|ERR|ERRSAVE)\((?:ASCII )?character/);
    expect(script).not.toContain("ASCII character");
    expect(script).toContain('return "OK" & (character id 31) &');
  });

  it("creates missing parent directories before invoking Notes", () => {
    // Notes' `save` does not create intermediate directories and fails with an
    // opaque error when the parent is missing.
    const dir = mkdtempSync(join(tmpdir(), "anatt-"));
    tmpDirs.push(dir);
    const dest = join(dir, "not", "yet", "created", "photo.png");
    mockExec.mockImplementation((script: string) => {
      const m = script.match(/POSIX file "([^"]+)"/);
      if (m) writeFileSync(m[1], Buffer.from("PNGDATA"));
      return { success: true, output: ["OK", "photo.png", "public.png"].join(F) };
    });

    const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", dest);
    expect(r.success).toBe(true);
    expect(r.savedPath).toBe(dest);
  });

  it("explains link-preview attachments when Notes' save raises an AppleEvent error", () => {
    mockExec.mockReturnValueOnce({
      success: true,
      output: ["ERRSAVE", "AppleEvent handler failed.", "https://example.com/app"].join(F),
    });

    const r = manager.saveAttachmentById(
      "x-coredata://A/ICNote/p1",
      "att-1",
      join(tmpdir(), "x.bin")
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("AppleEvent handler failed");
    expect(r.error).toContain("link preview");
    expect(r.error).toContain("https://example.com/app");
  });

  it("reports a plain save error without the link hint when the attachment has no URL", () => {
    mockExec.mockReturnValueOnce({
      success: true,
      output: ["ERRSAVE", "Failed saving an attachment to /nope.", "missing value"].join(F),
    });

    const r = manager.saveAttachmentById(
      "x-coredata://A/ICNote/p1",
      "att-1",
      join(tmpdir(), "x.bin")
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("Failed saving an attachment");
    expect(r.error).not.toContain("link preview");
  });

  it("rejects an unsafe destination before running AppleScript", () => {
    const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", "/etc/evil.png");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside allowed/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("surfaces 'attachment not found' from AppleScript", () => {
    const dest = join(tmpdir(), "nope.png");
    mockExec.mockReturnValue({ success: true, output: ["ERR", "attachment not found"].join(F) });
    const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "missing", dest);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("fails when Notes reports OK but no file was written", () => {
    const dest = join(tmpdir(), "ghost-" + Date.now() + ".png");
    mockExec.mockReturnValue({ success: true, output: ["OK", "x.png", "public.png"].join(F) });
    const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", dest);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no file was written/);
  });
});

describe("getAttachmentBase64ById (#27)", () => {
  it("exports to a temp file and returns base64, cleaning up", () => {
    mockExec.mockImplementation((script: string) => {
      const m = script.match(/POSIX file "([^"]+)"/);
      if (m) writeFileSync(m[1], Buffer.from("hello-bytes"));
      return { success: true, output: ["OK", "doc.pdf", "com.adobe.pdf"].join(F) };
    });

    const r = manager.getAttachmentBase64ById("x-coredata://A/ICNote/p1", "att-1");
    expect(r.success).toBe(true);
    expect(r.name).toBe("doc.pdf");
    expect(r.bytes).toBe("hello-bytes".length);
    expect(Buffer.from(r.base64 ?? "", "base64").toString()).toBe("hello-bytes");
  });

  it("returns the error when the save step fails", () => {
    mockExec.mockReturnValue({ success: false, output: "", error: "Notes not running" });
    const r = manager.getAttachmentBase64ById("x-coredata://A/ICNote/p1", "att-1");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Notes not running/);
  });
});
