/**
 * Integration tests for apple-notes-mcp
 *
 * These run against REAL Apple Notes — no mocks. They exercise the full stack:
 * AppleNotesManager → AppleScript → Notes.app.
 *
 * Prerequisites for the live portion:
 *   - macOS with Notes.app and at least one writable account
 *   - Automation permission granted to the process running the tests
 *
 * The live block self-skips when no writable account is found (e.g. CI runners
 * where Notes.app has no signed-in account), so this suite is safe to run
 * anywhere. The schema/path-safety blocks need no Notes.app and always run.
 *
 * Run via: npm run test:integration   (or npm run test:all for unit + integration)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { homedir } from "os";
import { AppleNotesManager } from "../src/services/appleNotesManager.js";
import { assertSafeSavePath } from "../src/utils/attachmentFs.js";
import { parseHashtags } from "../src/utils/hashtags.js";

let mgr: AppleNotesManager;
// Name of an account we were able to create (and delete) a note in. null => the
// live tests below skip themselves.
let liveAccount: string | null = null;

beforeAll(() => {
  mgr = new AppleNotesManager();
  try {
    for (const account of mgr.listAccounts()) {
      try {
        const probe = mgr.createNote("__mcp_probe__", "probe", [], undefined, account.name);
        if (probe?.id) {
          mgr.deleteNoteById(probe.id);
          liveAccount = account.name;
          break;
        }
      } catch {
        // account not writable — try the next one
      }
    }
  } catch {
    // Notes.app unavailable — every live test will skip
  }
});

// ===========================================================================
// Path safety — pure, no Notes.app interaction (always runs)
// ===========================================================================

describe("attachment path safety", () => {
  it("accepts an absolute path under the home directory", () => {
    expect(() => assertSafeSavePath(resolve(homedir(), "mcp-int-file.bin"))).not.toThrow();
  });

  it("accepts an absolute path under /tmp", () => {
    expect(() => assertSafeSavePath("/tmp/mcp-int-file.bin")).not.toThrow();
  });

  it("rejects a path outside the allowed roots", () => {
    expect(() => assertSafeSavePath("/etc/passwd")).toThrow();
  });

  it("rejects a relative path", () => {
    expect(() => assertSafeSavePath("relative/file.txt")).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() => assertSafeSavePath("")).toThrow();
  });
});

// ===========================================================================
// Hashtag parsing — pure (always runs)
// ===========================================================================

describe("hashtag parsing", () => {
  it("extracts inline hashtags from an HTML body", () => {
    expect(parseHashtags("<div>Plan #q3 and #launch</div>")).toEqual(["q3", "launch"]);
  });
});

// ===========================================================================
// Live Notes.app operations (self-skips when no writable account)
// ===========================================================================

describe("live Notes.app operations", { timeout: 120_000 }, () => {
  it("lists at least one account", (ctx) => {
    if (!liveAccount) ctx.skip();
    expect(mgr.listAccounts().length).toBeGreaterThan(0);
  });

  it("reports a health-check result", (ctx) => {
    if (!liveAccount) ctx.skip();
    const health = mgr.healthCheck();
    expect(health).toHaveProperty("healthy");
    expect(Array.isArray(health.checks)).toBe(true);
  });

  it("creates, reads, surfaces hashtags, and deletes a note", (ctx) => {
    if (!liveAccount) ctx.skip();
    const marker = `mcp-int-${Date.now()}`;
    const created = mgr.createNote(
      `Integration ${marker}`,
      `<div>integration body ${marker} #mcp #integration</div>`,
      [],
      undefined,
      liveAccount!,
      "html"
    );
    expect(created).not.toBeNull();
    expect(created!.id).toMatch(/^x-coredata:\/\//);

    try {
      const content = mgr.getNoteContentById(created!.id);
      expect(content).toContain(marker);
      const tags = parseHashtags(content);
      expect(tags).toContain("mcp");
      expect(tags).toContain("integration");
    } finally {
      expect(mgr.deleteNoteById(created!.id)).toBe(true);
    }
  });

  it("finds a freshly created note via search, then cleans it up", (ctx) => {
    if (!liveAccount) ctx.skip();
    const marker = `mcp-search-${Date.now()}`;
    const created = mgr.createNote(`Search ${marker}`, "find me", [], undefined, liveAccount!);
    expect(created).not.toBeNull();

    try {
      const hits = mgr.searchNotes(marker, false, liveAccount!);
      const hit = hits.find((n) => n.title.includes(marker));
      expect(hit).toBeDefined();

      const details = mgr.getNoteById(hit!.id);
      expect(details).not.toBeNull();
      expect(hit!.created).toEqual(details!.created);
      expect(hit!.modified).toEqual(details!.modified);
    } finally {
      expect(mgr.deleteNoteById(created!.id)).toBe(true);
    }
  });

  it("returns stats with a complete coverage report on a healthy library", (ctx) => {
    if (!liveAccount) ctx.skip();
    const stats = mgr.getNotesStats();
    expect(stats).toHaveProperty("coverage");
    expect(stats.coverage.complete).toBe(true);
    expect(stats.coverage.covered).toBe(stats.coverage.scanned);
  });
});
