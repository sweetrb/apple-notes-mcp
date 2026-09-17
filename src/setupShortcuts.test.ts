import { describe, expect, it, vi } from "vitest";
import { formatShortcutSetup, OPTIONAL_BRIDGE_NOTE, setupShortcuts } from "./setupShortcuts.js";

const MARKDOWN = "Create Markdown Note";

describe("Shortcut setup", () => {
  it("does not open anything when all bridges are installed", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(true, {
      status: (shortcut) => ({ shortcut, installed: true, identifier: `id-${shortcut}` }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
    });
    expect(report.ready).toBe(true);
    expect(open).not.toHaveBeenCalled();
    // #172 item 5 — installed is not consented; setup is where to say so.
    expect(formatShortcutSetup(report)).toMatch(
      /once in the foreground in Shortcuts\.app and choose Always Allow/
    );
  });

  it("check-only mode reports missing bridges without opening UI", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(true, {
      status: (shortcut) => ({ shortcut, installed: false, identifier: undefined }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
    });
    expect(report.ready).toBe(false);
    expect(report.items.every((item) => !item.opened)).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(formatShortcutSetup(report)).toContain("apple-notes-mcp setup");
  });

  it("is ready with only the two required bridges and lists the optional one's status", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(true, {
      status: (shortcut) => ({
        shortcut,
        installed: !shortcut.includes(MARKDOWN),
        identifier: shortcut.includes(MARKDOWN) ? undefined : `id-${shortcut}`,
      }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
      osRelease: () => "25.0.0",
    });
    expect(report.ready).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(report.items.filter((item) => item.optional).map((item) => item.name)).toEqual([
      "Apple Notes MCP - Create Markdown Note",
    ]);
    const text = formatShortcutSetup(report);
    expect(text).toContain(
      `✗ Apple Notes MCP - Create Markdown Note: not installed ${OPTIONAL_BRIDGE_NOTE}`
    );
    expect(OPTIONAL_BRIDGE_NOTE).toBe(
      "(optional — needed only for create-note format: markdown, macOS 26+)"
    );
    expect(text).toContain("Both required Shortcut bridges are installed.");
    expect(text).not.toContain("Run `apple-notes-mcp setup` to open missing workflows.");
  });

  it("stays not ready when a required bridge is missing, whatever the optional bridge's state", () => {
    const report = setupShortcuts(true, {
      status: (shortcut) => ({
        shortcut,
        installed: !shortcut.includes("Native Tags"),
        identifier: shortcut.includes("Native Tags") ? undefined : "id",
      }),
      exists: () => true,
      open: vi.fn(() => ({ ok: true })),
      baseDirectory: "/bundle/shortcuts",
    });
    expect(report.ready).toBe(false);
    expect(formatShortcutSetup(report)).toContain(
      `✓ Apple Notes MCP - Create Markdown Note (id) ${OPTIONAL_BRIDGE_NOTE}`
    );
  });

  it("does not let an optional bridge's inspection error degrade readiness", () => {
    const report = setupShortcuts(true, {
      status: (shortcut) => {
        if (shortcut.includes(MARKDOWN)) throw new Error("shortcuts list failed");
        return { shortcut, installed: true, identifier: "id" };
      },
      exists: () => true,
      open: vi.fn(() => ({ ok: true })),
      baseDirectory: "/bundle/shortcuts",
    });
    expect(report.ready).toBe(true);
  });

  it("opens only missing packaged workflows after an explicit setup command", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(false, {
      status: (shortcut) => ({
        shortcut,
        installed: !shortcut.includes("Background Operations"),
        identifier: shortcut.includes("Background Operations") ? undefined : "native-id",
      }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatch(/Background Operations v5\.shortcut$/);
    expect(report.items.find((item) => item.opened)?.name).toContain("Background Operations");
    expect(formatShortcutSetup(report)).toContain("confirm “Add Shortcut”");
  });

  it("opens a missing optional bridge on macOS 26 or later", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(false, {
      status: (shortcut) => ({
        shortcut,
        installed: !shortcut.includes(MARKDOWN),
        identifier: shortcut.includes(MARKDOWN) ? undefined : "id",
      }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
      osRelease: () => "25.0.0",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatch(/Create Markdown Note\.shortcut$/);
    expect(report.ready).toBe(true);
    expect(formatShortcutSetup(report)).toContain(
      `→ Apple Notes MCP - Create Markdown Note: confirm “Add Shortcut” in macOS ${OPTIONAL_BRIDGE_NOTE}`
    );
  });

  it("skips a missing optional bridge before macOS 26 and still opens required ones", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(false, {
      status: (shortcut) => ({
        shortcut,
        installed: shortcut.includes("Native Tags"),
        identifier: shortcut.includes("Native Tags") ? "id" : undefined,
      }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
      osRelease: () => "24.6.0",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatch(/Background Operations v5\.shortcut$/);
    const markdown = report.items.find((item) => item.optional);
    expect(markdown).toMatchObject({
      installed: false,
      opened: false,
      skipped: "requires macOS 26 or later (this Mac reports Darwin 24.6.0)",
    });
    expect(markdown?.error).toBeUndefined();
    expect(report.ready).toBe(false);
    expect(formatShortcutSetup(report)).toContain(
      `– Apple Notes MCP - Create Markdown Note: skipped, requires macOS 26 or later (this Mac reports Darwin 24.6.0) ${OPTIONAL_BRIDGE_NOTE}`
    );
  });
});
