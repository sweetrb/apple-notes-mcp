import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { callTimeoutMs, runWithCallTimeout } from "./callTimeout.js";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

import { executeAppleScript } from "./applescript.js";
import { executeJXA } from "./jxa.js";

const mockExec = vi.mocked(execFileSync);
afterEach(() => {
  mockExec.mockReset();
  delete process.env.APPLE_NOTES_MCP_TIMEOUT_MS;
});

describe("runWithCallTimeout", () => {
  it("runs the function unchanged without an override", () => {
    expect(runWithCallTimeout(undefined, () => callTimeoutMs())).toBeUndefined();
  });

  it("exposes the override in milliseconds only inside the scope", () => {
    expect(runWithCallTimeout(12, () => callTimeoutMs())).toBe(12000);
    expect(callTimeoutMs()).toBeUndefined();
  });

  it("isolates concurrent asynchronous calls", async () => {
    const read = (seconds: number, delay: number) =>
      runWithCallTimeout(seconds, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return callTimeoutMs();
      });
    expect(await Promise.all([read(3, 20), read(9, 1)])).toEqual([3000, 9000]);
  });

  it("rejects values outside 1-120 whole seconds", () => {
    for (const bad of [0, 121, 1.5, -3])
      expect(() => runWithCallTimeout(bad, () => 1)).toThrow(/whole number from 1 to 120/);
  });
});

describe("runners honor the per-call override", () => {
  it("executeAppleScript uses it over APPLE_NOTES_MCP_TIMEOUT_MS", () => {
    process.env.APPLE_NOTES_MCP_TIMEOUT_MS = "90000";
    mockExec.mockReturnValue("ok");
    runWithCallTimeout(4, () => executeAppleScript('tell application "Notes" to return 1'));
    const [, , options] = mockExec.mock.calls[0] as [
      string,
      string[],
      { timeout: number; input: string },
    ];
    expect(options.timeout).toBeLessThanOrEqual(4000);
    expect(options.timeout).toBeGreaterThan(3000);
    expect(options.input).toContain("with timeout of 1 seconds");
  });

  it("executeAppleScript falls back to the environment outside a scope", () => {
    process.env.APPLE_NOTES_MCP_TIMEOUT_MS = "90000";
    mockExec.mockReturnValue("ok");
    executeAppleScript('tell application "Notes" to return 1');
    const [, , options] = mockExec.mock.calls[0] as [string, string[], { timeout: number }];
    expect(options.timeout).toBeGreaterThan(60000);
  });

  it("executeJXA uses it", () => {
    mockExec.mockReturnValue("ok");
    runWithCallTimeout(5, () => executeJXA("1"));
    const [, , options] = mockExec.mock.calls[0] as [string, string[], { timeout: number }];
    expect(options.timeout).toBe(5000);
  });
});
