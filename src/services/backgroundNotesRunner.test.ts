import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { BACKGROUND_SHORTCUT, runBackgroundShortcut } from "./backgroundNotes.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const shortcutId = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("background transport", () => {
  it.each([false, true])("cleans private input after timeout=%s without retry", (timeout) => {
    let path = "";
    let runs = 0;
    const text = "$(do-not-run) `literal` Кириллица 🧭";
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === "list") return `${BACKGROUND_SHORTCUT} (${shortcutId})\n`;
      runs++;
      expect(args?.slice(0, 3)).toEqual(["run", shortcutId, "--input-path"]);
      path = String(args?.[3]);
      const descriptor = openSync(path, "r");
      try {
        expect(fstatSync(descriptor).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(descriptor, "utf8"))).toMatchObject({
          text,
          tag: "",
          change: "",
        });
      } finally {
        closeSync(descriptor);
      }
      if (timeout) throw new Error("ETIMEDOUT");
      return "";
    });
    const run = () => runBackgroundShortcut({ operation: "append-text", text });
    if (timeout) expect(run).toThrow("ETIMEDOUT");
    else run();
    expect(runs).toBe(1);
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });
  // #248 — a bridge that ran nothing ends in "…_REFUSED" and exits 0.
  it("turns a REFUSED bridge output into a refusal error, and accepts DONE", () => {
    let output = "APPLE_NOTES_BACKGROUND_V5_REFUSED\n";
    vi.mocked(execFileSync).mockImplementation((_file, args) =>
      args?.[0] === "list" ? `${BACKGROUND_SHORTCUT} (${shortcutId})\n` : output
    );
    expect(() => runBackgroundShortcut({ operation: "append-html", text: "x" })).toThrow(
      expect.objectContaining({
        refused: true,
        shortcut: BACKGROUND_SHORTCUT,
        message: expect.stringMatching(/Find Notes step did not find exactly one note/),
      })
    );
    output = "APPLE_NOTES_BACKGROUND_V5_DONE\n";
    expect(() => runBackgroundShortcut({ operation: "append-html", text: "x" })).not.toThrow();
  });
  it("refuses to run without an exact installed bridge, naming the Shortcut to install", () => {
    vi.mocked(execFileSync).mockReturnValue(`${BACKGROUND_SHORTCUT} copy (${shortcutId})\n`);
    expect(() => runBackgroundShortcut({ text: "hello" })).toThrow(
      new RegExp(`Install the supplied "${BACKGROUND_SHORTCUT}" Shortcut`)
    );
    expect(vi.mocked(execFileSync).mock.calls.every((call) => call[1]?.[0] === "list")).toBe(true);
  });
  // #164 — a stalled run used to report a bare "Shortcuts timed out", naming
  // nothing for the caller to go and approve in Shortcuts.app.
  it("carries the Shortcut name out with a transport failure", () => {
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[0] === "list") return `${BACKGROUND_SHORTCUT} (${shortcutId})\n`;
      throw Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" });
    });
    expect(() => runBackgroundShortcut({ text: "hello" })).toThrow(
      expect.objectContaining({ code: "ETIMEDOUT", shortcut: BACKGROUND_SHORTCUT })
    );
  });
});
