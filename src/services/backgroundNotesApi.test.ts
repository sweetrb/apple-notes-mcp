import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AppleNotesManager } from "./appleNotesManager.js";
import type { BackgroundSnapshot } from "./backgroundNotes.js";

const mock = vi.hoisted(() => ({
  status: vi.fn(() => ({ installed: true, identifier: "11111111-1111-4111-8111-111111111111" })),
  runTags: vi.fn(),
  enrich: vi.fn(),
  readRich: vi.fn(),
  hash: vi.fn(),
  metadata: vi.fn(() => ({ metadata: { pinned: false } })),
  checklist: vi.fn(() => ({ items: [] })),
}));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("./nativeTags.js", () => ({
  nativeTagsStatus: mock.status,
  normalizeNativeTags: (tags: string[]) => tags.map((tag) => tag.replace(/^#/, "")),
  runNativeTagsShortcut: mock.runTags,
}));
vi.mock("../utils/noteRichText.js", () => ({
  enrichNoteRead: mock.enrich,
  readRichNote: mock.readRich,
  richContentHash: mock.hash,
  linkSignature: (links: Array<{ text: string; url: string }>) =>
    JSON.stringify(links.map(({ text, url }) => [text.replace(/\s+/gu, ""), url])),
  htmlLinks: () => [],
}));
vi.mock("../utils/noteMetadata.js", () => ({ getNoteMetadata: mock.metadata }));
vi.mock("../utils/checklistParser.js", () => ({ getChecklistItems: mock.checklist }));

import {
  appendNative,
  backgroundDependencies,
  createMarkdownNote,
  nativeTagBridgeStatus,
  readBackgroundSnapshot,
  setNativeTag,
} from "./backgroundNotes.js";
import { smartFolderDestinationError } from "./appleNotesManager.js";

const id = "x-coredata://ABCDEF/ICNote/p1";
const scopeText = "Unique project marker";
const request = { id, expectedContentHash: "h1", scopeText };

function snapshot(overrides: Partial<BackgroundSnapshot> = {}): BackgroundSnapshot {
  return {
    id,
    title: "Ideas",
    hash: "h1",
    html: `<div>${scopeText}</div>`,
    pinned: false,
    checklist: [],
    rich: {
      text: scopeText,
      links: [],
      nativeTags: [],
      nativeObjectIds: [],
      hasNativeObjects: false,
      hasChecklist: false,
      revision: "r1",
    },
    ...overrides,
  };
}

function managerFor(states: BackgroundSnapshot[]): AppleNotesManager {
  let index = 0;
  const current = () => states[Math.min(index, states.length - 1)];
  const manager = {
    getNoteById: vi.fn(() => ({ title: current().title, passwordProtected: false })),
    getNoteContentById: vi.fn(() => current().html),
    listAccounts: vi.fn(() => [{ name: "iCloud" }]),
    searchNotes: vi.fn(() => [
      { id, title: "Ideas", passwordProtected: false },
      { id: "other", title: "Other", passwordProtected: false },
      { id: "locked", title: "Ideas", passwordProtected: true },
      { id: "wrong-scope", title: "Ideas", passwordProtected: false },
    ]),
    getNotePlaintextById: vi.fn((noteId: string) =>
      noteId === id ? scopeText : "Different project marker"
    ),
  };
  mock.enrich.mockImplementation(() => ({ revision: current().rich.revision }));
  mock.readRich.mockImplementation(() => {
    const value = current().rich;
    index++;
    return value;
  });
  mock.hash.mockImplementation(() => states[Math.max(0, index - 1)].hash);
  mock.metadata.mockImplementation(() => ({ metadata: { pinned: current().pinned } }));
  mock.checklist.mockImplementation(() => ({ items: current().checklist }));
  return manager as unknown as AppleNotesManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.status.mockReturnValue({
    installed: true,
    identifier: "11111111-1111-4111-8111-111111111111",
  });
  vi.mocked(execFileSync).mockReturnValue("");
});
afterEach(() => vi.unstubAllEnvs());

describe("background snapshot and selection", () => {
  it("reads a guarded snapshot and exposes the native tag bridge status", () => {
    const value = snapshot({ checklist: [{ text: "Task", done: false }] });
    const manager = managerFor([value]);
    expect(readBackgroundSnapshot(manager, id)).toMatchObject({
      id,
      title: "Ideas",
      hash: "h1",
      checklist: [{ text: "Task", done: false }],
    });
    expect(nativeTagBridgeStatus()).toMatchObject({ installed: true });
  });

  it("rejects invalid, missing, locked, and concurrently changed notes", () => {
    expect(() => readBackgroundSnapshot(managerFor([snapshot()]), "not-an-id")).toThrow(/ID/);

    const missing = managerFor([snapshot()]) as unknown as {
      getNoteById: ReturnType<typeof vi.fn>;
    };
    missing.getNoteById.mockReturnValue(null);
    expect(() => readBackgroundSnapshot(missing as unknown as AppleNotesManager, id)).toThrow(
      /not found/
    );

    const locked = managerFor([snapshot()]) as unknown as {
      getNoteById: ReturnType<typeof vi.fn>;
    };
    locked.getNoteById.mockReturnValue({ title: "Ideas", passwordProtected: true });
    expect(() => readBackgroundSnapshot(locked as unknown as AppleNotesManager, id)).toThrow(
      /Locked/
    );

    const changed = managerFor([snapshot()]);
    mock.enrich.mockReturnValue({ revision: "stale" });
    expect(() => readBackgroundSnapshot(changed, id)).toThrow(/changed during read/);
  });

  it("finds only the exact unlocked note containing the scope and delegates reads", () => {
    const manager = managerFor([snapshot()]);
    const deps = backgroundDependencies(manager);
    expect(deps.candidates("Ideas", scopeText)).toEqual([id]);
    expect(deps.read(id)).toMatchObject({ id, hash: "h1" });
  });
});

describe("native append and tags", () => {
  it("appends plaintext through the guarded background path", () => {
    const before = snapshot();
    const after = snapshot({
      hash: "h2",
      html: `<div>${scopeText}</div><div><br></div><div>Added text</div>`,
      rich: { ...before.rich, text: `${scopeText}\n\nAdded text`, revision: "r2" },
    });
    expect(
      appendNative(managerFor([before, before, after]), {
        ...request,
        content: "Added text",
        format: "plaintext",
      })
    ).toMatchObject({ ok: true, contentHash: "h2" });
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });

  describe("HTML append readback with adjacent del text (#283)", () => {
    const content = "<div>one<del>two</del>three</div>";
    const before = snapshot({
      rich: {
        ...snapshot().rich,
        htmlLossyFormatting: ["highlight"],
        styleRuns: [{ start: 0, length: scopeText.length, signature: "highlight" }],
      },
    });
    const appended = (html: string, text: string) =>
      snapshot({
        hash: "h2",
        html: before.html + "<div><br></div>" + html,
        rich: { ...before.rich, text: scopeText + "\n\n" + text, revision: "r2" },
      });

    it("verifies the complete append while preserving the existing protected formatting", () => {
      const after = appended("<div>one<strike>two</strike>three</div>", "onetwothree");
      expect(
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toMatchObject({ ok: true, contentHash: "h2" });
      expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["missing struck text", "<div>onethree</div>", "onethree"],
      ["changed struck text", "<div>one<strike>Two</strike>three</div>", "oneTwothree"],
    ])("reports %s as indeterminate", (_label, html, text) => {
      const after = appended(html, text);
      expect(() =>
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toThrow(/^Operation outcome uncertain.*Appended text not verified/);
      expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    });

    it("still reports a changed prior body as indeterminate", () => {
      const after = appended("<div>one<strike>two</strike>three</div>", "onetwothree");
      after.html = after.html.replace(scopeText, "Changed project marker");
      after.rich.text = after.rich.text.replace(scopeText, "Changed project marker");
      expect(() =>
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toThrow(/^Operation outcome uncertain.*Existing note text was not preserved/);
    });
  });

  describe("HTML append readback with named character references (#283)", () => {
    // A note shaped like the report: a heading, paragraphs, a list and a
    // monospaced line, with a unique body phrase as scope. The appended HTML
    // uses named references; Notes reads them back as bare characters, in the
    // AppleScript HTML forms observed live (semicolonless &lt/&amp/&quot,
    // <font face="Courier"><tt> for monospace, <b><span> for a heading).
    const priorHtml =
      `<div><b><span style="font-size: 24px">Ideas</span></b><br></div>\n` +
      `<div>${scopeText}</div>\n<ul>\n<li>seed item</li>\n</ul>\n` +
      `<div><font face="Courier"><tt>git -C /tmp status</tt></font></div>`;
    const priorText = `Ideas\n${scopeText}\nseed item\ngit -C /tmp status`;
    const content =
      "<h2>Next steps &mdash; review</h2>" +
      "<ul><li>Ship it&hellip; then &ldquo;verify&rdquo;</li><li>a &rarr; b &amp; c &lt;d&gt;</li></ul>" +
      "<div><tt>pnpm run build &amp;&amp; echo &quot;ok&quot;</tt></div>";
    const appendedHtml =
      `<div><br></div>\n<div><b><span style="font-size: 18px">Next steps — review</span></b><br></div>\n` +
      `<ul>\n<li>Ship it… then “verify”</li>\n<li>a → b &amp c &ltd&gt</li>\n</ul>\n` +
      `<div><font face="Courier"><tt>pnpm run build &amp&amp echo &quotok&quot</tt></font></div>`;
    const appendedText =
      '\nNext steps — review\nShip it… then “verify”\na → b & c <d>\npnpm run build && echo "ok"';
    const before = snapshot({
      html: priorHtml,
      rich: { ...snapshot().rich, text: priorText },
    });

    it("verifies a complete append instead of reporting it indeterminate", () => {
      const after = snapshot({
        hash: "h2",
        html: priorHtml + "\n" + appendedHtml,
        rich: { ...before.rich, text: priorText + "\n" + appendedText, revision: "r2" },
      });
      expect(
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toMatchObject({ ok: true, contentHash: "h2" });
    });

    it("still reports an append missing part of the requested text as indeterminate", () => {
      const partialHtml = appendedHtml.replace("\n<li>a → b &amp c &ltd&gt</li>", "");
      const after = snapshot({
        hash: "h2",
        html: priorHtml + "\n" + partialHtml,
        rich: {
          ...before.rich,
          text: priorText + "\n" + appendedText.replace("\na → b & c <d>", ""),
          revision: "r2",
        },
      });
      expect(() =>
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toThrow(/^Operation outcome uncertain.*Appended text not verified/);
    });

    it("still reports a changed prior body as indeterminate", () => {
      const after = snapshot({
        hash: "h2",
        html: priorHtml.replace("seed item", "seed ITEM") + "\n" + appendedHtml,
        rich: { ...before.rich, text: priorText + "\n" + appendedText, revision: "r2" },
      });
      expect(() =>
        appendNative(managerFor([before, before, after]), { ...request, content, format: "html" })
      ).toThrow(/^Operation outcome uncertain.*Appended text not verified/);
    });
  });

  it("converts bounded Markdown to semantic HTML and rejects HTML tables", () => {
    const before = snapshot();
    const after = snapshot({
      hash: "h2",
      html: `<div>${scopeText}</div><div><br></div><h2>Added</h2>`,
      rich: { ...before.rich, text: `${scopeText}\nAdded`, revision: "r2" },
    });
    expect(
      appendNative(managerFor([before, before, after]), {
        ...request,
        content: "## Added",
        format: "markdown",
      })
    ).toMatchObject({ ok: true });
    expect(() =>
      appendNative(managerFor([before]), {
        ...request,
        content: "<table><tr><td>x</td></tr></table>",
        format: "html",
      })
    ).toThrow(/create-table/);
    // #286 — a bare table fragment (no outer <table>) used to slip past this
    // check and into validateAppendContent's now-corrected element list, so
    // it must get the same specific redirect, not a generic rejection or a
    // silent accept. Confirmed without touching the manager: the content is
    // rejected before the note is ever read.
    for (const fragment of [
      "<tbody><tr><td>x</td></tr></tbody>",
      "<tr><td>x</td></tr>",
      "<td>x</td>",
    ]) {
      const manager = managerFor([before]);
      expect(() =>
        appendNative(manager, { ...request, content: fragment, format: "html" })
      ).toThrow(/create-table/);
      expect(manager.getNoteById).not.toHaveBeenCalled();
    }
  });

  it("sends Markdown to the bridge's native Markdown import, not converted HTML (#172)", () => {
    // The bridge's "append-html" branch (Notes' HTML importer) only
    // distinguishes two heading levels and collapses <h3> to the same style
    // as <h2>. The "append-markdown" branch runs Shortcuts' native
    // Markdown-to-rich-text action instead, which preserves all three, so a
    // Markdown request must be transported as raw Markdown text on the
    // "append-markdown" operation — never as our own HTML on "append-html".
    const before = snapshot();
    const after = snapshot({
      hash: "h2",
      html: `<div>${scopeText}</div><div><br></div><h3>Added</h3>`,
      rich: { ...before.rich, text: `${scopeText}\nAdded`, revision: "r2" },
    });
    expect(
      appendNative(managerFor([before, before, after]), {
        ...request,
        content: "### Added",
        format: "markdown",
      })
    ).toMatchObject({ ok: true });
    const writeMock = vi.mocked(writeFileSync);
    const requestJson = String(writeMock.mock.calls.at(-1)?.[1]);
    const written = JSON.parse(requestJson) as { operation: string; text: string };
    expect(written.operation).toBe("append-markdown");
    expect(written.text).toContain("### Added");
    expect(written.text).not.toContain("<h3>");
  });

  it("refuses Markdown that Notes would rewrite before reading or writing the note", () => {
    const manager = managerFor([snapshot()]);
    expect(() =>
      appendNative(manager, { ...request, content: "An _emphasised_ word", format: "markdown" })
    ).toThrow(/underscores outside a word; Notes would change that text/);
    expect(manager.getNoteById).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("returns an idempotent tag result without invoking a workflow", () => {
    expect(
      setNativeTag(managerFor([snapshot()]), { ...request, tag: "old", present: false })
    ).toEqual({ ok: true, id, contentHash: "h1", changed: false });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("removes only the requested native tag object", () => {
    const before = snapshot({
      rich: {
        ...snapshot().rich,
        text: `${scopeText} #old \ufffc`,
        nativeTags: ["old"],
        nativeObjectIds: ["tag-id", "table-id"],
        nativeTagObjectIds: { old: ["tag-id"] },
        objectData: [{ id: "table-id", mergeable: "AA", view: 1 }],
      },
    });
    const after = snapshot({
      hash: "h2",
      rich: {
        ...snapshot().rich,
        text: scopeText,
        nativeObjectIds: ["table-id"],
        objectData: [{ id: "table-id", mergeable: "AA", view: 1 }],
        revision: "r2",
      },
    });
    expect(
      setNativeTag(managerFor([before, before, before, after]), {
        ...request,
        tag: "#old",
        present: false,
      })
    ).toMatchObject({
      ok: true,
      contentHash: "h2",
    });
  });

  it("adds a native tag through the dedicated tag workflow", () => {
    const before = snapshot();
    const after = snapshot({
      hash: "h2",
      rich: {
        ...before.rich,
        text: `${scopeText} \ufffc`,
        nativeTags: ["new"],
        nativeObjectIds: ["tag-id"],
        revision: "r2",
      },
    });
    expect(
      setNativeTag(managerFor([before, before, before, after]), {
        ...request,
        tag: "new",
        present: true,
      })
    ).toMatchObject({
      ok: true,
      contentHash: "h2",
    });
    expect(mock.runTags).toHaveBeenCalledWith({
      title: "Ideas",
      scopeText,
      tags: ["new"],
    });
  });
});

describe("create-note Markdown bridge (#172)", () => {
  const existing = "x-coredata://ABCDEF/ICNote/p1";
  const created = "x-coredata://ABCDEF/ICNote/p2";
  // Notes' own serialization of an imported Title, Heading, Subheading and list.
  const importedHtml =
    '<div><b><h1>Plan</h1></b><font face=".AppleSystemUIFont"><h1><br></h1></font></div>' +
    "<div><br></div><div><b><h2>Goals</h2></b></div><div><b><h3>Detail</h3></b></div>" +
    '<ul class="Apple-dash-list"><li>one</li></ul>';

  function markdownManager(
    listings: string[][],
    html = importedHtml,
    text = "Plan\n\nGoals\nDetail\none",
    readbacks: Record<string, { html: string; text: string }> = {}
  ) {
    let listing = 0;
    const read = (noteId: string) => readbacks[noteId] ?? { html, text };
    const manager = {
      listAccounts: vi.fn(() => [{ name: "iCloud", defaultFolder: "Notes" }, { name: "Local" }]),
      listNoteRefs: vi.fn(() =>
        listings[Math.min(listing++, listings.length - 1)].map((noteId) => ({
          id: noteId,
          title: "Plan",
        }))
      ),
      getNoteById: vi.fn(() => ({ title: "Plan", passwordProtected: false })),
      getNoteContentById: vi.fn((noteId: string) => read(noteId).html),
      listFolders: vi.fn(() => [
        { id: "folder-1", name: "Work", account: "iCloud" },
        { id: "folder-2", name: "Work/Clients\\/Partners", account: "iCloud" },
      ]),
      moveNoteById: vi.fn(() => true),
      assertNotSmartFolderDestination: vi.fn(),
    };
    mock.enrich.mockReturnValue({ revision: "r1" });
    mock.readRich.mockImplementation((noteId: string) => ({
      ...snapshot().rich,
      text: read(noteId).text,
      revision: "r1",
    }));
    mock.hash.mockReturnValue("h-created");
    return manager;
  }

  it("sends the title and Markdown to the Create Markdown Note bridge and verifies the new note", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    expect(
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "Work",
      })
    ).toEqual({
      ok: true,
      id: created,
      title: "Plan",
      folder: "Work",
      account: "iCloud",
      contentHash: "h-created",
      verified: true,
    });
    expect(mock.status).toHaveBeenCalledWith("Apple Notes MCP - Create Markdown Note");
    expect(vi.mocked(execFileSync).mock.calls[0][1]).toEqual(
      expect.arrayContaining(["run", "11111111-1111-4111-8111-111111111111"])
    );
    const written = JSON.parse(String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1]));
    expect(written).toMatchObject({
      operation: "create-markdown",
      text: "# Plan\n\n## Goals\n### Detail\n- one",
    });
    expect(manager.listNoteRefs).toHaveBeenCalledWith("iCloud", "Notes");
    expect(manager.moveNoteById).toHaveBeenCalledWith(created, "Work", "iCloud");
    // Only accounts with a default folder can receive the note, so only those are checked.
    expect(manager.assertNotSmartFolderDestination.mock.calls).toEqual([["Work", "iCloud"]]);
  });

  it("refuses a smart-folder destination before the bridge creates anything", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    manager.assertNotSmartFolderDestination.mockImplementation(() => {
      throw smartFolderDestinationError("Work");
    });
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals",
        folder: "Work",
      })
    ).toThrow(/^Refused: "Work" is a smart folder/);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(manager.listNoteRefs).not.toHaveBeenCalled();
    expect(manager.moveNoteById).not.toHaveBeenCalled();
  });

  it("ignores a same-named smart folder in another account (#245)", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    manager.listAccounts.mockReturnValue([
      { name: "iCloud", defaultFolder: "Notes" },
      { name: "Exchange", defaultFolder: "Inbox" },
    ]);
    manager.assertNotSmartFolderDestination.mockImplementation(
      (folder: string, account: string) => {
        if (account === "Exchange") throw smartFolderDestinationError(folder);
      }
    );
    // The Exchange default folder gains nothing; iCloud gains the new note.
    let iCloudListings = 0;
    manager.listNoteRefs.mockImplementation(((account: string) =>
      (account === "Exchange" ? [] : iCloudListings++ === 0 ? [existing] : [existing, created]).map(
        (id) => ({ id, title: "Plan" })
      )) as never);
    expect(
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "Work",
      })
    ).toMatchObject({ ok: true, id: created, account: "iCloud" });
    expect(manager.moveNoteById).toHaveBeenCalledWith(created, "Work", "iCloud");
  });

  it("still refuses when the folder is a smart folder in every account that has it", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    manager.listAccounts.mockReturnValue([
      { name: "iCloud", defaultFolder: "Notes" },
      { name: "Exchange", defaultFolder: "Inbox" },
    ]);
    manager.assertNotSmartFolderDestination.mockImplementation((folder: string) => {
      throw smartFolderDestinationError(folder);
    });
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals",
        folder: "Work",
      })
    ).toThrow(/^Refused: "Work" is a smart folder/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("escapes Markdown punctuation so the title stays literal", () => {
    const title = "1. Q4 *plan* #work";
    const manager = markdownManager(
      [[existing], [existing, created]],
      `<div><b><h1>${title}</h1></b></div><div>Body</div>`,
      `${title}\nBody`
    );
    expect(
      createMarkdownNote(manager as unknown as AppleNotesManager, { title, content: "Body" })
    ).toMatchObject({ ok: true, id: created });
    const written = JSON.parse(String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1]));
    expect(written.text).toBe("# 1\\. Q4 \\*plan\\* \\#work\n\nBody");
    expect(manager.moveNoteById).not.toHaveBeenCalled();
  });

  it("reports a flattened heading as unverified and does not move the note", () => {
    const flattened = importedHtml.replace("<h3>Detail</h3>", "<h2>Detail</h2>");
    const manager = markdownManager([[existing], [existing, created]], flattened);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "Work",
      })
    ).toThrow(
      /read note x-coredata:\/\/ABCDEF\/ICNote\/p2 before any retry: no new note verified \(.*Heading styles not verified\)/
    );
    expect(manager.moveNoteById).not.toHaveBeenCalled();
  });

  it("reports text Notes did not keep, such as a leading seed line", () => {
    const manager = markdownManager(
      [[existing], [existing, created]],
      importedHtml,
      "New note\nPlan\n\nGoals\nDetail\none"
    );
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
      })
    ).toThrow(/Note text not verified/);
  });

  it("refuses to pick a note when none or several appear", () => {
    const content = "## Goals\n### Detail\n- one";
    mock.status.mockReturnValue({
      installed: true,
      identifier: "11111111-1111-4111-8111-111111111111",
      shortcut: "Apple Notes MCP - Create Markdown Note",
    } as never);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    });
    expect(() =>
      createMarkdownNote(markdownManager([[existing]]) as unknown as AppleNotesManager, {
        title: "Plan",
        content,
      })
    ).toThrow(
      /search for the title before any retry: no new note was found in the default folder; Shortcuts timed out waiting for the "Apple Notes MCP - Create Markdown Note" Shortcut\. This may be an unanswered first-run Shortcuts consent prompt.*run "Apple Notes MCP - Create Markdown Note" once in the foreground in Shortcuts\.app and choose Always Allow/
    );
    vi.mocked(execFileSync).mockReturnValue("");
    const other = "x-coredata://ABCDEF/ICNote/p3";
    expect(() =>
      createMarkdownNote(
        markdownManager([[existing], [existing, created, other]]) as unknown as AppleNotesManager,
        { title: "Plan", content }
      )
    ).toThrow(
      "Operation outcome uncertain; read notes x-coredata://ABCDEF/ICNote/p2, x-coredata://ABCDEF/ICNote/p3 before any retry: 2 matching notes appeared"
    );
  });

  it("names every candidate when several notes appear and none verifies", () => {
    const synced = "x-coredata://ABCDEF/ICNote/p3";
    const manager = markdownManager(
      [[existing], [existing, created, synced]],
      "<div>Other</div>",
      "Other"
    );
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals",
      })
    ).toThrow(
      /^Operation outcome uncertain; read notes x-coredata:\/\/ABCDEF\/ICNote\/p2, x-coredata:\/\/ABCDEF\/ICNote\/p3 before any retry: no new note verified \(x-coredata:\/\/ABCDEF\/ICNote\/p2: Note text not verified; x-coredata:\/\/ABCDEF\/ICNote\/p3: Note text not verified\)$/
    );
  });

  it("picks the one verified note when an unrelated note lands in the default folder", () => {
    const synced = "x-coredata://ABCDEF/ICNote/p3";
    const manager = markdownManager([[existing], [existing, synced, created]], importedHtml, "", {
      [synced]: { html: "<div>Groceries</div>", text: "Groceries" },
      [created]: { html: importedHtml, text: "Plan\n\nGoals\nDetail\none" },
    });
    expect(
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
      })
    ).toMatchObject({ ok: true, id: created });
  });

  it("names the note when its readback fails after the bridge created it", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    mock.readRich.mockImplementation(() => {
      throw new Error("No Notes document data");
    });
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals",
      })
    ).toThrow(
      /Operation outcome uncertain; read note x-coredata:\/\/ABCDEF\/ICNote\/p2 before any retry: .*No Notes document data/
    );
  });

  it("names the created note when the move to its folder fails", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    manager.moveNoteById.mockReturnValue(false);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "Work",
      })
    ).toThrow(
      /read note x-coredata:\/\/ABCDEF\/ICNote\/p2 before any retry: created and verified .* not moved to "Work"; use move-note/
    );
  });

  it("names the landing account when the folder exists only in another account", () => {
    const gmail = "x-coredata://ABCDEF/ICNote/p9";
    const manager = markdownManager([[existing], [existing, created]]);
    manager.listAccounts.mockReturnValue([
      { name: "iCloud", defaultFolder: "Notes" },
      { name: "Gmail", defaultFolder: "Notes" },
    ] as never);
    let iCloudListing = 0;
    const listings = [[existing], [existing, created]];
    manager.listNoteRefs.mockImplementation(((account: string) =>
      (account === "iCloud"
        ? listings[Math.min(iCloudListing++, listings.length - 1)]
        : [gmail]
      ).map((noteId) => ({ id: noteId, title: "Plan" }))) as never);
    manager.listFolders.mockImplementation(((account: string) =>
      account === "Gmail"
        ? [{ id: "folder-9", name: "Archive", account: "Gmail" }]
        : [{ id: "folder-1", name: "Work", account: "iCloud" }]) as never);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "archive",
      })
    ).toThrow(
      'Operation outcome uncertain; read note x-coredata://ABCDEF/ICNote/p2 before any retry: created and verified in the iCloud default folder, but folder "archive" does not exist in iCloud; create it there, then use move-note with id x-coredata://ABCDEF/ICNote/p2 instead of creating the note again'
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(manager.listFolders).toHaveBeenLastCalledWith("iCloud");
    expect(manager.moveNoteById).not.toHaveBeenCalled();
  });

  it("refuses a folder that does not exist before the bridge creates anything", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals",
        folder: "Typo",
      })
    ).toThrow(
      'Folder "Typo" does not exist; create it with create-folder first. Nothing was created'
    );
    expect(manager.listNoteRefs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(manager.moveNoteById).not.toHaveBeenCalled();
  });

  it("matches an existing nested folder the way the move resolves it", () => {
    const manager = markdownManager([[existing], [existing, created]]);
    expect(
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "## Goals\n### Detail\n- one",
        folder: "work/clients\\/partners/",
      })
    ).toMatchObject({ ok: true, id: created, folder: "work/clients\\/partners/" });
    expect(manager.moveNoteById).toHaveBeenCalledWith(
      created,
      "work/clients\\/partners/",
      "iCloud"
    );
  });

  describe("block quotes, code, checklists and dividers through Notes' importer", () => {
    const content = "> quoted\n\n```\nlet a_b\n```\n\n- [ ] open\n- [x] done";
    const text = "Plan\nquoted\nlet a_b\nopen\ndone";
    const html = "<div><b><h1>Plan</h1></b></div><blockquote>quoted</blockquote><tt>let a_b</tt>";
    function importedRich(done: boolean) {
      return {
        ...snapshot().rich,
        text,
        revision: "r1",
        styleRuns: [
          { start: 0, length: 5, signature: "", paragraphStyle: 0 },
          { start: 5, length: 7, signature: "", paragraphStyle: 3, blockQuote: true },
          { start: 12, length: 8, signature: "", paragraphStyle: 4 },
          { start: 20, length: 9, signature: "", paragraphStyle: 103 },
        ],
        checklistItems: [
          { id: "a", text: "open", done: false, start: 20 },
          { id: "b", text: "done", done, start: 25 },
        ],
      };
    }

    it("sends the Markdown unchanged and verifies each native construct by readback", () => {
      const manager = markdownManager([[existing], [existing, created]], html, text);
      mock.readRich.mockImplementation(() => importedRich(true));
      expect(
        createMarkdownNote(manager as unknown as AppleNotesManager, {
          title: "Plan",
          content,
          folder: "Work",
        })
      ).toMatchObject({ ok: true, id: created, verified: true });
      const written = JSON.parse(String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1]));
      expect(written.text).toBe(`# Plan\n\n${content}`);
      expect(manager.moveNoteById).toHaveBeenCalledWith(created, "Work", "iCloud");
    });

    it("reports a checklist item whose done state Notes did not keep and does not move the note", () => {
      const manager = markdownManager([[existing], [existing, created]], html, text);
      mock.readRich.mockImplementation(() => importedRich(false));
      expect(() =>
        createMarkdownNote(manager as unknown as AppleNotesManager, {
          title: "Plan",
          content,
          folder: "Work",
        })
      ).toThrow(
        /read note .*p2 before any retry: .*Checklist items or their done state not verified/
      );
      expect(manager.moveNoteById).not.toHaveBeenCalled();
    });
  });

  it("refuses before listing or running anything when the bridge is missing or input is invalid", () => {
    const manager = markdownManager([[existing]]);
    mock.status.mockReturnValue({ installed: false, identifier: undefined } as never);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, { title: "Plan", content: "x" })
    ).toThrow(/Install the supplied/);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Two\nlines",
        content: "x",
      })
    ).toThrow(/one line/);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "| a | b |",
      })
    ).toThrow(/Markdown import supports/);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "_note_ this",
      })
    ).toThrow(/Notes would change that text/);
    expect(() =>
      createMarkdownNote(manager as unknown as AppleNotesManager, {
        title: "Plan",
        content: "snake_case_name and #decision stay literal",
        folder: "/",
      })
    ).toThrow(/folder/i);
    expect(manager.listNoteRefs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
