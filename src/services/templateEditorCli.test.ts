/**
 * `templates edit` argument handling and lifecycle, with the server, the
 * tailnet lookup, the note reader and the signal hook injected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseTemplatesArgs,
  runTemplatesCommand,
  type TemplatesCliDeps,
} from "./templateEditorCli.js";
import type { TemplateEditorHandle, TemplateEditorOptions } from "./templateEditor.js";
import { templateSamples } from "../utils/templateSamples.js";

function fakeEditor(reason: "idle" | "closed" = "closed") {
  let resolve!: (r: "idle" | "closed") => void;
  const closed = new Promise<"idle" | "closed">((r) => (resolve = r));
  const handle: TemplateEditorHandle = {
    url: "http://127.0.0.1:4321/?token=t",
    host: "127.0.0.1",
    port: 4321,
    token: "t",
    closed,
    close: vi.fn(async () => resolve(reason)),
  };
  return handle;
}

function harness(extra: Partial<TemplatesCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const started: TemplateEditorOptions[] = [];
  const editor = fakeEditor();
  const deps: TemplatesCliDeps = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    start: async (options) => {
      started.push(options);
      return editor;
    },
    // Stop right away, as if the user pressed Ctrl-C.
    onSignal: (stop) => {
      queueMicrotask(stop);
      return () => {};
    },
    ...extra,
  };
  return { out, err, started, editor, deps };
}

describe("parseTemplatesArgs", () => {
  it("parses edit and its options", () => {
    expect(
      parseTemplatesArgs([
        "edit",
        "mine",
        "--port",
        "8123",
        "--idle-minutes",
        "5",
        "--note",
        "x-coredata://ABC-123/ICNote/p42",
        "--tailnet",
      ])
    ).toEqual({
      name: "mine",
      port: 8123,
      idleMinutes: 5,
      noteId: "x-coredata://ABC-123/ICNote/p42",
      tailnet: true,
    });
    expect(parseTemplatesArgs(["edit"])).toEqual({ idleMinutes: 30, tailnet: false });
  });

  it("returns help for no command or --help", () => {
    expect(parseTemplatesArgs([])).toBe("help");
    expect(parseTemplatesArgs(["edit", "--help"])).toBe("help");
  });

  it("rejects bad input", () => {
    expect(() => parseTemplatesArgs(["serve"])).toThrow(/Unknown templates command/);
    expect(() => parseTemplatesArgs(["edit", "--port", "70000"])).toThrow(/--port/);
    expect(() => parseTemplatesArgs(["edit", "--port"])).toThrow(/--port/);
    expect(() => parseTemplatesArgs(["edit", "--note", "p42"])).toThrow(/--note/);
    expect(() => parseTemplatesArgs(["edit", "--bogus"])).toThrow(/Unknown option/);
    expect(() => parseTemplatesArgs(["edit", "a", "b"])).toThrow(/Unexpected argument/);
  });
});

describe("runTemplatesCommand", () => {
  it("prints usage for help and exits 0 without starting", async () => {
    const h = harness();
    expect(await runTemplatesCommand(["--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(/Usage: apple-notes-mcp templates edit/);
    expect(h.started).toEqual([]);
  });

  it("exits 2 with usage on a bad argument", async () => {
    const h = harness();
    expect(await runTemplatesCommand(["edit", "--nope"], h.deps)).toBe(2);
    expect(h.err.join("")).toMatch(/Unknown option --nope/);
  });

  it("starts on loopback, prints the URL, and stops on the signal", async () => {
    const h = harness();
    expect(await runTemplatesCommand(["edit", "obsidian", "--idle-minutes", "2"], h.deps)).toBe(0);
    expect(h.started[0]).toMatchObject({ host: "127.0.0.1", idleMs: 120000, name: "obsidian" });
    expect(h.out).toEqual(["Template editor: http://127.0.0.1:4321/?token=t\n"]);
    expect(h.editor.close).toHaveBeenCalled();
    expect(h.err.join("")).toMatch(/Template editor stopped\./);
    // The token appears only in the one URL line on stdout.
    expect(h.err.join("")).not.toContain("token=");
  });

  it("--tailnet binds the Tailscale address and warns about exposure", async () => {
    const h = harness({ tailnetAddress: () => ({ address: "100.101.1.2", interface: "utun4" }) });
    expect(await runTemplatesCommand(["edit", "--tailnet"], h.deps)).toBe(0);
    expect(h.started[0].host).toBe("100.101.1.2");
    expect(h.err.join("")).toMatch(/Any device on your tailnet/);
  });

  it("--tailnet refuses when there is no Tailscale address", async () => {
    const h = harness({ tailnetAddress: () => undefined });
    expect(await runTemplatesCommand(["edit", "--tailnet"], h.deps)).toBe(1);
    expect(h.started).toEqual([]);
    expect(h.err.join("")).toMatch(/No Tailscale address found/);
  });

  it("reads the named note once and passes it to the editor", async () => {
    const sample = templateSamples()[0];
    const readNote = vi.fn(() => ({ note: sample.note, meta: sample.meta }));
    const h = harness({ readNote });
    await runTemplatesCommand(["edit", "--note", "x-coredata://A/ICNote/p7"], h.deps);
    expect(readNote).toHaveBeenCalledTimes(1);
    expect(readNote).toHaveBeenCalledWith("x-coredata://A/ICNote/p7");
    expect(h.started[0].note?.note).toBe(sample.note);
  });

  it("exits 1 when the editor cannot start", async () => {
    const h = harness({
      start: async () => {
        throw new Error('No saved template named "x".');
      },
    });
    expect(await runTemplatesCommand(["edit", "x"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/Could not start the template editor/);
  });

  it("reports an idle stop", async () => {
    const editor = fakeEditor("idle");
    const h = harness({ start: async () => editor });
    await runTemplatesCommand(["edit"], h.deps);
    expect(h.err.join("")).toMatch(/idle timeout/);
  });
});
