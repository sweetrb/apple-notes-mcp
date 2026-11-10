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
  // #325: macOS 12's `shortcuts list` has no --show-identifiers.
  it("falls back to bare names when shortcuts rejects --show-identifiers", () => {
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === "list" && args.includes("--show-identifiers"))
        throw Object.assign(new Error("Command failed"), {
          stderr: "Error: Unknown option '--show-identifiers'\nUsage: shortcuts list\n",
        });
      if (args?.[0] === "list") return `Other\n${NATIVE_TAGS_SHORTCUT}\n`;
      expect(args?.slice(0, 3)).toEqual(["run", NATIVE_TAGS_SHORTCUT, "--input-path"]);
      return "";
    });
    expect(nativeTagsStatus()).toMatchObject({
      installed: true,
      identifier: NATIVE_TAGS_SHORTCUT,
    });
    runNativeTagsShortcut({ title: "Title", scopeText: "Project example", tags: ["tag"] });
    expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.[0] === "run")).toBe(true);
  });
  it("still refuses duplicate bare names and does not retry other list failures", () => {
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.includes("--show-identifiers"))
        throw Object.assign(new Error("Command failed"), { stderr: "Unknown option" });
      return `${NATIVE_TAGS_SHORTCUT}\n${NATIVE_TAGS_SHORTCUT}\n`;
    });
    expect(nativeTagsStatus().installed).toBe(false);
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("Command failed: shortcuts list --show-identifiers"), {
        stderr: "Couldn't communicate with a helper application.",
      });
    });
    expect(() => nativeTagsStatus()).toThrow(/Command failed/);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
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
  // #172 item 5 — name the Shortcut whose first-run consent prompt is likely
  // unanswered, and carry the name and timeout code out for mutateBackground.
  it("names the Shortcut and the first-run consent fix when a run stalls", () => {
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === "list") return listed;
      throw Object.assign(new Error("spawnSync /usr/bin/shortcuts ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    });
    const run = () =>
      runNativeTagsShortcut({ title: "Title", scopeText: "Project example", tags: ["tag"] });
    expect(run).toThrow(/first-run Shortcuts consent prompt/);
    expect(run).toThrow(
      new RegExp(
        `run "${NATIVE_TAGS_SHORTCUT}" once in the foreground in Shortcuts\\.app and choose Always Allow`
      )
    );
    expect(run).toThrow(
      expect.objectContaining({ shortcut: NATIVE_TAGS_SHORTCUT, code: "ETIMEDOUT" })
    );
  });
});
