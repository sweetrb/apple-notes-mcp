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
import { AppleNotesManager } from "../services/appleNotesManager.js";
import { executeAppleScript } from "../utils/applescript.js";
const mockExec = vi.mocked(executeAppleScript);
const F = "\x1f";
let manager;
const tmpDirs = [];
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
        mockExec.mockImplementation((script) => {
            const m = script.match(/POSIX file "([^"]+)"/);
            if (m)
                writeFileSync(m[1], Buffer.from("PNGDATA"));
            return { success: true, output: ["OK", "photo.png", "public.png"].join(F) };
        });
        const r = manager.saveAttachmentById("x-coredata://A/ICNote/p1", "att-1", dest);
        expect(r.success).toBe(true);
        expect(r.savedPath).toBe(dest);
        expect(r.name).toBe("photo.png");
        expect(r.contentType).toBe("public.png");
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
        mockExec.mockImplementation((script) => {
            const m = script.match(/POSIX file "([^"]+)"/);
            if (m)
                writeFileSync(m[1], Buffer.from("hello-bytes"));
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
