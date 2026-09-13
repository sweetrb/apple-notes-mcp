import { describe, expect, it, vi } from "vitest";
import { formatShortcutSetup, setupShortcuts } from "./setupShortcuts.js";

describe("Shortcut setup", () => {
  it("does not open anything when both bridges are installed", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(true, {
      status: (shortcut) => ({ shortcut, installed: true, identifier: `id-${shortcut}` }),
      exists: () => true,
      open,
      baseDirectory: "/bundle/shortcuts",
    });
    expect(report.ready).toBe(true);
    expect(open).not.toHaveBeenCalled();
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

  it("opens only missing packaged workflows after an explicit setup command", () => {
    const open = vi.fn(() => ({ ok: true }));
    const report = setupShortcuts(false, {
      status: (shortcut) => ({
        shortcut,
        installed: shortcut.includes("Native Tags"),
        identifier: shortcut.includes("Native Tags") ? "native-id" : undefined,
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
});
