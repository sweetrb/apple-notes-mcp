import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { nativeTagsStatus, NATIVE_TAGS_SHORTCUT, runNativeTagsShortcut } from "./nativeTags.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const shortcutId = "11111111-1111-4111-8111-111111111111";
const listed = `${NATIVE_TAGS_SHORTCUT} (${shortcutId})\n`;
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("Shortcuts native-tag transport", () => {
  it("requires an exact installed Shortcut name", () => {
    vi.mocked(execFileSync).mockReturnValue(`${NATIVE_TAGS_SHORTCUT} copy (${shortcutId})\n`);
    expect(nativeTagsStatus().installed).toBe(false);
    expect(() =>
      runNativeTagsShortcut({ title: "Notes", scopeText: "Project example", tags: ["tag"] })
    ).toThrow(/Import/);
    expect(vi.mocked(execFileSync).mock.calls.every((call) => call[1]?.[0] === "list")).toBe(true);
  });
  it("refuses duplicate names and supports selecting an installed UUID", () => {
    vi.mocked(execFileSync).mockReturnValue(
      listed + listed.replace(shortcutId, "22222222-2222-4222-8222-222222222222")
    );
    expect(nativeTagsStatus().installed).toBe(false);
    expect(nativeTagsStatus(shortcutId)).toMatchObject({ installed: true, identifier: shortcutId });
  });
  it("passes text as JSON in a private temporary file, never shell code, and removes it", () => {
    const input = { title: '$(do-not-run) "title"', scopeText: "Project example", tags: ["дроп"] };
    let path = "";
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === "list") return listed;
      expect(args?.slice(0, 3)).toEqual(["run", shortcutId, "--input-path"]);
      path = String(args?.[3]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(input);
      expect(args).toHaveLength(4);
      return "";
    });
    runNativeTagsShortcut(input);
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });
  it("cleans request files and discloses uncertainty on a timeout", () => {
    {
      let path = "";
      vi.mocked(execFileSync).mockImplementation((_file, args) => {
        if (args?.[0] === "list") return listed;
        path = String(args?.[3]);
        throw new Error("ETIMEDOUT");
      });
      expect(() =>
        runNativeTagsShortcut({ title: "Title", scopeText: "Project example", tags: ["tag"] })
      ).toThrow(/Do not retry/);
      expect(path).not.toBe("");
      expect(existsSync(path)).toBe(false);
    }
  });
});
