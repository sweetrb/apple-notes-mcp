import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
  nativeTagBridgeStatus,
  readBackgroundSnapshot,
  setNativeTag,
} from "./backgroundNotes.js";

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
