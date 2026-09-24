import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runWithCallTimeout } from "./callTimeout.js";
import { classifyError } from "./errorCodes.js";
import {
  freezePasteboard,
  MAX_PASTEBOARD_BYTES,
  PASTEBOARD_DATA_TYPES,
  PASTEBOARD_FREEZE_JXA,
  PasteboardError,
  pasteboardFilename,
  pasteboardTimeoutMs,
} from "./pasteboardFreeze.js";

/**
 * These tests run the REAL JXA program against private, uniquely named
 * pasteboards, so the user's general pasteboard is never read or changed.
 */
const PREFIX = `apple-notes-mcp-test-${process.pid}-${Date.now()}`;
const names: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "pasteboard-test-"));

/** Fill a named pasteboard with one file-URL item per path (several copied files). */
function fillFiles(paths: string[]): string {
  const name = `${PREFIX}-${names.length}`;
  names.push(name);
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  pb.clearContents;
  var urls = [];
  for (var i = 1; i < argv.length; i++) urls.push($.NSURL.fileURLWithPath(argv[i]));
  pb.writeObjects($(urls));
  return String(pb.changeCount);
}`,
    name,
    ...paths,
  ]);
  return name;
}

/** Fill a named pasteboard: entries are [type, hex bytes] or ["file-url", path]. */
function fill(entries: Array<[string, string]>): string {
  const name = `${PREFIX}-${names.length}`;
  names.push(name);
  const script = `
ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  pb.clearContents;
  var entries = JSON.parse(argv[1]);
  var item = $.NSPasteboardItem.alloc.init;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i][0] === "file-url") {
      item.setStringForType($.NSURL.fileURLWithPath(entries[i][1]).absoluteString, "public.file-url");
    } else {
      var data = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[2 + i], 0);
      item.setDataForType(data, entries[i][0]);
    }
  }
  pb.writeObjects($([item]));
  return String(pb.changeCount);
}`;
  const base64 = entries.map(([type, value]) =>
    type === "file-url" ? "" : Buffer.from(value, "hex").toString("base64")
  );
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
    name,
    JSON.stringify(entries),
    ...base64,
  ]);
  return name;
}

afterAll(() => {
  for (const name of names)
    execFileSync("osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); function run(argv) { $.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally; }',
      name,
    ]);
  rmSync(scratch, { recursive: true, force: true });
}, 60_000);

// A real 1x1 PNG and a few bytes that stand in for TIFF.
const PNG =
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201" +
  "5b7e5d830000000049454e44ae426082";

// Each case spawns osascript several times; allow for a loaded machine.
describe("freezePasteboard (real JXA, private named pasteboards)", { timeout: 60_000 }, () => {
  it("freezes image bytes, preferring PNG over TIFF, into a private file", () => {
    const name = fill([
      ["public.tiff", "4d4d002a"],
      ["public.png", PNG],
    ]);
    const frozen = freezePasteboard({ pasteboardName: name });
    try {
      expect(frozen).toMatchObject({
        kind: "data",
        type: "public.png",
        filename: "Pasted image.png",
      });
      expect(readFileSync(frozen.path).toString("hex")).toBe(PNG);
      expect(frozen.bytes).toBe(PNG.length / 2);
      expect(statSync(frozen.path).mode & 0o077).toBe(0);
    } finally {
      frozen.cleanup();
    }
    expect(existsSync(frozen.path)).toBe(false);
  });

  it("takes a PDF under a default document name", () => {
    const name = fill([["com.adobe.pdf", Buffer.from("%PDF-1.4 synthetic").toString("hex")]]);
    const frozen = freezePasteboard({ pasteboardName: name });
    try {
      expect(frozen).toMatchObject({
        kind: "data",
        type: "com.adobe.pdf",
        filename: "Pasted document.pdf",
      });
      expect(readFileSync(frozen.path, "utf8")).toBe("%PDF-1.4 synthetic");
    } finally {
      frozen.cleanup();
    }
  });

  it("prefers the PDF over a raster preview of it (#238)", () => {
    const name = fill([
      ["public.png", PNG],
      ["com.adobe.pdf", Buffer.from("%PDF-1.4 with preview").toString("hex")],
    ]);
    const frozen = freezePasteboard({ pasteboardName: name });
    try {
      expect(frozen).toMatchObject({ kind: "data", type: "com.adobe.pdf" });
      expect(readFileSync(frozen.path, "utf8")).toBe("%PDF-1.4 with preview");
    } finally {
      frozen.cleanup();
    }
  });

  it("refuses several image items instead of attaching the first (#238)", () => {
    const name = `${PREFIX}-${names.length}`;
    names.push(name);
    execFileSync("osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  pb.clearContents;
  var items = [];
  for (var i = 0; i < 2; i++) {
    var item = $.NSPasteboardItem.alloc.init;
    item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(argv[1], 0), "public.png");
    items.push(item);
  }
  pb.writeObjects($(items));
  return String(pb.changeCount);
}`,
      name,
      Buffer.from(PNG, "hex").toString("base64"),
    ]);
    try {
      freezePasteboard({ pasteboardName: name });
      expect.unreachable();
    } catch (e) {
      expect((e as PasteboardError).code).toBe("multiple_items");
      expect((e as PasteboardError).envelope).toMatchObject({ count: 2 });
    }
  });

  it("copies a copied file's bytes, keeping its name", () => {
    const source = join(scratch, "synthetic report.txt");
    writeFileSync(source, "synthetic file contents");
    const name = fill([["file-url", source]]);
    const frozen = freezePasteboard({ pasteboardName: name });
    try {
      expect(frozen).toMatchObject({
        kind: "file",
        type: "public.file-url",
        filename: "synthetic report.txt",
      });
      expect(frozen.path).not.toBe(source);
      expect(readFileSync(frozen.path, "utf8")).toBe("synthetic file contents");
    } finally {
      frozen.cleanup();
    }
  });

  it("refuses a copied symlink, text-only contents, and an empty pasteboard", () => {
    const target = join(scratch, "target.txt");
    const link = join(scratch, "link.txt");
    writeFileSync(target, "x");
    symlinkSync(target, link);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as PasteboardError).code;
      }
      return "none";
    };
    expect(code(() => freezePasteboard({ pasteboardName: fill([["file-url", link]]) }))).toBe(
      "file_unreadable"
    );
    // A copied FIFO is refused without blocking the event loop on open.
    const fifo = join(scratch, "pipe.txt");
    execFileSync("mkfifo", [fifo]);
    expect(code(() => freezePasteboard({ pasteboardName: fill([["file-url", fifo]]) }))).toBe(
      "file_unreadable"
    );
    expect(
      code(() =>
        freezePasteboard({
          pasteboardName: fill([["public.utf8-plain-text", Buffer.from("hi").toString("hex")]]),
        })
      )
    ).toBe("unsupported_content");
    expect(code(() => freezePasteboard({ pasteboardName: fill([]) }))).toBe("pasteboard_empty");
  });

  it("refuses several copied files instead of attaching the first", () => {
    const first = join(scratch, "first.txt");
    const second = join(scratch, "second.txt");
    writeFileSync(first, "1");
    writeFileSync(second, "2");
    try {
      freezePasteboard({ pasteboardName: fillFiles([first, second]) });
      expect.unreachable();
    } catch (e) {
      expect((e as PasteboardError).code).toBe("multiple_files");
      expect((e as PasteboardError).envelope).toMatchObject({ count: 2 });
    }
  });
});

/**
 * Runs the constant JXA program in Node against a fake AppKit bridge, so the
 * access check, item scan, and error replies are exercised off macOS too.
 */
describe("PASTEBOARD_FREEZE_JXA logic (fake AppKit bridge)", () => {
  interface FakeItem {
    types: string[];
    strings?: Record<string, string>;
  }
  interface FakeBoard {
    accessBehavior?: number;
    items: FakeItem[];
    data?: Record<string, string>;
  }
  const nil = { isNil: () => true };
  const run = (board: FakeBoard, allowAlert = false, name = "") => {
    const calls: string[] = [];
    const types = [...new Set(board.items.flatMap((item) => item.types))];
    const pb = {
      isNil: () => false,
      respondsToSelector: (selector: string) =>
        selector === "accessBehavior" && board.accessBehavior !== undefined,
      get accessBehavior() {
        calls.push("accessBehavior");
        return board.accessBehavior;
      },
      get changeCount() {
        calls.push("changeCount");
        return 7;
      },
      get types() {
        calls.push("types");
        return types;
      },
      get pasteboardItems() {
        calls.push("pasteboardItems");
        return {
          isNil: () => false,
          count: board.items.length,
          objectAtIndex: (i: number) => ({
            types: board.items[i].types,
            stringForType: (type: string) => {
              calls.push(`stringForType:${type}`);
              return board.items[i].strings?.[type];
            },
          }),
        };
      },
      dataForType: (type: string) => {
        calls.push(`dataForType:${type}`);
        const text = board.data?.[type];
        if (text === undefined) return nil;
        return {
          isNil: () => false,
          length: text.length,
          writeToFileAtomically: () => true,
        };
      },
    };
    const $ = {
      NSPasteboard: {
        generalPasteboard: pb,
        pasteboardWithName: () => pb,
      },
      NSURL: {
        URLWithString: (value: string) => ({
          isNil: () => false,
          isFileURL: value.startsWith("file://"),
          path: decodeURIComponent(value.slice("file://".length)),
        }),
      },
    };
    const ObjC = {
      import: () => undefined,
      unwrap: (value: unknown) => value,
      deepUnwrap: (value: unknown) => value,
    };
    const main = new Function("ObjC", "$", `${PASTEBOARD_FREEZE_JXA}\nreturn run;`)(ObjC, $) as (
      argv: string[]
    ) => string;
    const prefs = JSON.stringify(PASTEBOARD_DATA_TYPES.map((t) => [t.type, t.ext]));
    const reply = JSON.parse(
      main(["/private-dir", name, String(MAX_PASTEBOARD_BYTES), prefs, allowAlert ? "1" : "0"])
    );
    return { reply, calls };
  };
  const png: FakeBoard = { items: [{ types: ["public.png"] }], data: { "public.png": "abc" } };

  it("reads nothing but accessBehavior when macOS would show the paste alert", () => {
    for (const accessBehavior of [0, 1, 99]) {
      const { reply, calls } = run({ ...png, accessBehavior });
      expect(reply).toEqual({ status: "error", code: "pasteboard_access_denied", accessBehavior });
      expect(calls).toEqual(["accessBehavior"]);
    }
  });

  it("never reads under alwaysDeny, even when the alert was accepted", () => {
    const { reply, calls } = run({ ...png, accessBehavior: 3 }, true);
    expect(reply).toMatchObject({ code: "pasteboard_access_denied", accessBehavior: 3 });
    expect(calls).toEqual(["accessBehavior"]);
  });

  it("reads under alwaysAllow, with the alert accepted, or where the API does not exist", () => {
    for (const [accessBehavior, allow] of [
      [2, false],
      [0, true],
      [1, true],
      [undefined, false],
    ] as const) {
      const { reply } = run({ ...png, accessBehavior }, allow);
      expect(reply).toMatchObject({ status: "ok", kind: "data", type: "public.png" });
    }
  });

  it("skips the access check on a named pasteboard", () => {
    const { reply, calls } = run({ ...png, accessBehavior: 0 }, false, "test-board");
    expect(reply).toMatchObject({ status: "ok", kind: "data" });
    expect(calls).not.toContain("accessBehavior");
  });

  it("refuses several copied files before reading any of them", () => {
    const { reply, calls } = run({
      accessBehavior: 2,
      items: [
        { types: ["public.file-url"], strings: { "public.file-url": "file:///tmp/a.txt" } },
        { types: ["public.file-url"], strings: { "public.file-url": "file:///tmp/b.txt" } },
        { types: ["public.utf8-plain-text"] },
      ],
    });
    expect(reply).toEqual({ status: "error", code: "multiple_files", count: 2 });
    expect(calls.some((call) => call.startsWith("dataForType"))).toBe(false);
  });

  it("refuses several image or PDF items before reading any of them (#238)", () => {
    const { reply, calls } = run({
      accessBehavior: 2,
      items: [
        { types: ["public.png", "public.tiff"] },
        { types: ["public.jpeg"] },
        { types: ["public.utf8-plain-text"] },
      ],
      data: { "public.png": "abc", "public.jpeg": "def" },
    });
    expect(reply).toEqual({ status: "error", code: "multiple_items", count: 2 });
    expect(calls.some((call) => call.startsWith("dataForType"))).toBe(false);
  });

  it("takes the PDF when one item offers a PDF and a raster preview (#238)", () => {
    const { reply } = run({
      accessBehavior: 2,
      items: [{ types: ["public.png", "com.adobe.pdf"] }],
      data: { "public.png": "abc", "com.adobe.pdf": "%PDF" },
    });
    expect(reply).toMatchObject({ status: "ok", kind: "data", type: "com.adobe.pdf" });
  });

  it("takes one copied file from whichever item carries it", () => {
    const { reply } = run({
      accessBehavior: 2,
      items: [
        { types: ["public.utf8-plain-text"] },
        {
          types: ["public.file-url"],
          strings: { "public.file-url": "file:///tmp/My%20Report.pdf" },
        },
      ],
    });
    expect(reply).toEqual({
      status: "ok",
      kind: "file",
      type: "public.file-url",
      path: "/tmp/My Report.pdf",
    });
  });

  it("lists the pasteboard types when nothing is supported", () => {
    const { reply } = run({
      accessBehavior: 2,
      items: [{ types: ["public.utf8-plain-text", "public.html"] }],
    });
    expect(reply).toEqual({
      status: "error",
      code: "unsupported_content",
      types: ["public.utf8-plain-text", "public.html"],
    });
  });
});

describe("freezePasteboard error mapping (stubbed osascript)", () => {
  const code = (runJxa: (args: string[]) => string, allowPasteAlert?: boolean) => {
    try {
      freezePasteboard({ runJxa, allowPasteAlert });
    } catch (e) {
      return (e as PasteboardError).code;
    }
    return "none";
  };

  it("passes the directory, pasteboard name, limit, and type preferences as argv", () => {
    let seen: string[] = [];
    code((args) => {
      seen = args;
      return '{"status":"error","code":"pasteboard_empty"}';
    });
    expect(seen[1]).toBe("");
    expect(seen[2]).toBe(String(MAX_PASTEBOARD_BYTES));
    expect(JSON.parse(seen[3])).toEqual(PASTEBOARD_DATA_TYPES.map((t) => [t.type, t.ext]));
    expect(existsSync(seen[0])).toBe(false);
    expect(seen[4]).toBe("0");
    expect(PASTEBOARD_FREEZE_JXA).toContain("function run(argv)");
    code((args) => {
      seen = args;
      return '{"status":"error","code":"pasteboard_empty"}';
    }, true);
    expect(seen[4]).toBe("1");
  });

  it("reports access denial with the behavior and a permission_denied envelope", () => {
    const error = (reply: string) => {
      try {
        freezePasteboard({ runJxa: () => reply });
      } catch (e) {
        return e as PasteboardError;
      }
      throw new Error("expected a refusal");
    };
    const ask = error('{"status":"error","code":"pasteboard_access_denied","accessBehavior":0}');
    expect(ask.code).toBe("pasteboard_access_denied");
    expect(ask.message).toMatch(/allowPasteAlert: true/);
    expect(classifyError(ask.message, ask)).toEqual({
      code: "permission_denied",
      pasteboardCode: "pasteboard_access_denied",
      accessBehavior: "default",
      committed: false,
    });
    const deny = error('{"status":"error","code":"pasteboard_access_denied","accessBehavior":3}');
    expect(deny.envelope).toMatchObject({ accessBehavior: "alwaysDeny" });
    expect(deny.message).not.toMatch(/allowPasteAlert/);
    expect(
      error('{"status":"error","code":"pasteboard_access_denied"}').envelope.accessBehavior
    ).toBe("unknown");
  });

  it("names the count of copied files and the unsupported types", () => {
    const error = (reply: string) => {
      try {
        freezePasteboard({ runJxa: () => reply });
      } catch (e) {
        return e as PasteboardError;
      }
      throw new Error("expected a refusal");
    };
    const many = error('{"status":"error","code":"multiple_files","count":3}');
    expect(many.message).toMatch(/holds 3 copied files/);
    expect(many.envelope).toMatchObject({
      code: "validation_error",
      pasteboardCode: "multiple_files",
      count: 3,
      committed: false,
    });
    const images = error('{"status":"error","code":"multiple_items","count":2}');
    expect(images.message).toMatch(/holds 2 images or PDFs/);
    expect(images.envelope).toMatchObject({
      code: "validation_error",
      pasteboardCode: "multiple_items",
      count: 2,
      committed: false,
    });
    const text = error(
      '{"status":"error","code":"unsupported_content","types":["public.utf8-plain-text","public.rtf"]}'
    );
    expect(text.message).toContain("Pasteboard types found: public.utf8-plain-text, public.rtf.");
    expect(text.message).toMatch(/PNG, JPEG, HEIC, GIF, TIFF/);
    expect(text.envelope).toMatchObject({ types: ["public.utf8-plain-text", "public.rtf"] });
  });

  it("reports an osascript timeout separately from an unreachable pasteboard", () => {
    expect(
      code(() => {
        throw Object.assign(new Error("spawnSync osascript ETIMEDOUT"), { code: "ETIMEDOUT" });
      })
    ).toBe("pasteboard_timeout");
  });

  it("takes its timeout from the per-call override, then the env knob, then 30 s", () => {
    vi.stubEnv("APPLE_NOTES_MCP_TIMEOUT_MS", "");
    try {
      expect(pasteboardTimeoutMs()).toBe(30_000);
      expect(runWithCallTimeout(5, () => pasteboardTimeoutMs())).toBe(5_000);
      vi.stubEnv("APPLE_NOTES_MCP_TIMEOUT_MS", "45000");
      expect(pasteboardTimeoutMs()).toBe(45_000);
      expect(runWithCallTimeout(5, () => pasteboardTimeoutMs())).toBe(5_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps osascript failures, bad replies, and unknown codes to pasteboard_unavailable", () => {
    expect(
      code(() => {
        throw new Error("no window server");
      })
    ).toBe("pasteboard_unavailable");
    expect(code(() => "not json")).toBe("pasteboard_unavailable");
    expect(code(() => '{"status":"error","code":"weird"}')).toBe("pasteboard_unavailable");
    expect(code(() => '{"status":"error","code":"too_large","bytes":1}')).toBe("too_large");
    expect(code(() => '{"status":"error","code":"pasteboard_changed"}')).toBe("pasteboard_changed");
  });

  it("refuses a data path outside its private directory", () => {
    expect(
      code(() => '{"status":"ok","kind":"data","type":"public.png","path":"/etc/hosts"}')
    ).toBe("write_failed");
  });

  it("labels unknown data types generically and completes requested names", () => {
    const frozen = freezePasteboard({
      runJxa: (args) => {
        writeFileSync(join(args[0], "pasteboard.bin"), "x");
        return JSON.stringify({
          status: "ok",
          kind: "data",
          type: "com.example.other",
          path: join(args[0], "pasteboard.bin"),
        });
      },
    });
    expect(frozen.filename).toBe("Pasted item.bin");
    frozen.cleanup();
    expect(pasteboardFilename(undefined, "a.png")).toBeUndefined();
    expect(pasteboardFilename("Photo", "a.png")).toBe("Photo.png");
    expect(pasteboardFilename("Photo.PNG", "a.png")).toBe("Photo.PNG");
    // A mismatched extension is passed through for add-attachment to refuse.
    expect(pasteboardFilename("Photo.jpg", "a.png")).toBe("Photo.jpg");
    expect(pasteboardFilename("Photo", "noext")).toBe("Photo");
  });
});
