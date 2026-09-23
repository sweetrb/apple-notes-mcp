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
import { afterAll, describe, expect, it } from "vitest";
import {
  freezePasteboard,
  MAX_PASTEBOARD_BYTES,
  PASTEBOARD_DATA_TYPES,
  PASTEBOARD_FREEZE_JXA,
  PasteboardError,
  pasteboardFilename,
} from "./pasteboardFreeze.js";

/**
 * These tests run the REAL JXA program against private, uniquely named
 * pasteboards, so the user's general pasteboard is never read or changed.
 */
const PREFIX = `apple-notes-mcp-test-${process.pid}-${Date.now()}`;
const names: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "pasteboard-test-"));

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
    expect(
      code(() =>
        freezePasteboard({
          pasteboardName: fill([["public.utf8-plain-text", Buffer.from("hi").toString("hex")]]),
        })
      )
    ).toBe("unsupported_content");
    expect(code(() => freezePasteboard({ pasteboardName: fill([]) }))).toBe("pasteboard_empty");
  });
});

describe("freezePasteboard error mapping (stubbed osascript)", () => {
  const code = (runJxa: (args: string[]) => string) => {
    try {
      freezePasteboard({ runJxa });
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
    expect(PASTEBOARD_FREEZE_JXA).toContain("function run(argv)");
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
