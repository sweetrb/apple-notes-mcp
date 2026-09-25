import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriter.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  privateWriterCapabilities: vi.fn(),
  readWriterNoteState: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
vi.mock(import("../services/privateCompose.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  composeNote: vi.fn(),
}));
import {
  PrivateWriteError,
  privateWriterCapabilities,
  readWriterNoteState,
} from "../services/privateWriter.js";
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { composeNote } from "../services/privateCompose.js";
import { blockingSleep, registerComposeNoteTool, runComposeNote } from "./composeNoteTool.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const BLOCKS = [{ type: "heading" as const, text: "H" }];
const ALLOW = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

function managerStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
    createNote: vi.fn(() => ({ id: CD })),
    ...overrides,
  } as unknown as AppleNotesManager;
}

function runtime(manager = managerStub(), env: Record<string, string> = ALLOW) {
  return { manager, deps: { env } as never, sleep: vi.fn() };
}

function caught(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateWriteError) return error;
    throw error;
  }
  throw new Error("expected a PrivateWriteError");
}

const available = () =>
  vi.mocked(privateWriterCapabilities).mockReturnValue({
    features: { composeNote: { available: true, reason: null, detail: null } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(composeNote).mockReturnValue({ status: "updated", committed: true } as never);
  vi.mocked(readWriterNoteState).mockReturnValue({ revision: REV } as never);
});

describe("compose-note append and prepend", () => {
  it("plans with dryRun and forwards the policy fields", () => {
    const r = runComposeNote(
      {
        mode: "append",
        identifier: NOTE,
        blocks: BLOCKS,
        dryRun: true,
        requireNonSystemPaper: true,
        insertBeforeHeading: { text: "Next" },
      },
      runtime()
    );
    expect(composeNote).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        mode: "append",
        paragraphs: [{ style: "heading", runs: [{ text: "H" }] }],
        dryRun: true,
        requireNonSystemPaper: true,
        insertBeforeHeading: { text: "Next" },
      },
      { env: ALLOW }
    );
    expect(r).toMatchObject({ status: "updated" });
  });

  it("applies with ifRevision, resolving an x-coredata id and echoing it", () => {
    const rt = runtime();
    const r = runComposeNote(
      { mode: "prepend", id: CD, markdown: "- [x] done\n---\n<div>", ifRevision: REV },
      rt
    );
    expect(rt.manager.getNoteLinkById).toHaveBeenCalledWith(CD);
    expect(composeNote).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        mode: "prepend",
        paragraphs: [
          { style: "checklist", checked: true, runs: [{ text: "done" }] },
          { kind: "divider" },
        ],
        ifRevision: REV,
      },
      { env: ALLOW }
    );
    expect(r).toMatchObject({
      id: CD,
      warnings: ["line 3: raw HTML block skipped"],
    });
  });

  it("returns the writer's unitStart and objectURI with the database cross-check", () => {
    vi.mocked(composeNote).mockReturnValue({
      status: "updated",
      committed: true,
      storeKind: "copy",
      unitStart: 5,
      objectURI: "x-coredata://S/ICNote/p1",
      readBack: [],
    } as never);
    const r = runComposeNote(
      { mode: "append", identifier: NOTE, blocks: BLOCKS, ifRevision: REV },
      runtime()
    );
    expect(r).toMatchObject({
      unitStart: 5,
      objectURI: "x-coredata://S/ICNote/p1",
      databaseReadBack: { checked: false },
    });
  });

  it.each([
    ["no content", { mode: "append", identifier: NOTE, dryRun: true }],
    [
      "both content forms",
      { mode: "append", identifier: NOTE, blocks: BLOCKS, markdown: "x", dryRun: true },
    ],
    [
      "create-only fields",
      { mode: "append", identifier: NOTE, blocks: BLOCKS, title: "T", dryRun: true },
    ],
    ["an unguarded apply", { mode: "append", identifier: NOTE, blocks: BLOCKS }],
    [
      "a dry run with ifRevision",
      { mode: "append", identifier: NOTE, blocks: BLOCKS, dryRun: true, ifRevision: REV },
    ],
    [
      "a heading anchor on prepend",
      {
        mode: "prepend",
        identifier: NOTE,
        blocks: BLOCKS,
        dryRun: true,
        insertBeforeHeading: { text: "x" },
      },
    ],
    [
      "Markdown with no content",
      { mode: "append", identifier: NOTE, markdown: "<div>", dryRun: true },
    ],
    [
      "a dry run with nudge",
      { mode: "append", identifier: NOTE, blocks: BLOCKS, dryRun: true, nudge: true },
    ],
    [
      // create picks its folder itself; a guard could only run after Notes made the note
      "a folder scope guard on create",
      {
        mode: "create",
        title: "T",
        blocks: BLOCKS,
        forbiddenAncestorFolderIds: ["x-coredata://8FA9FE0E-3B93/ICFolder/p1"],
      },
    ],
  ])("refuses %s before calling the helper", (_label, args) => {
    const e = caught(() => runComposeNote(args as never, runtime()));
    expect(e).toMatchObject({ code: "invalid_request", committed: false });
    expect(composeNote).not.toHaveBeenCalled();
  });
});

describe("compose-note create", () => {
  it("plans a create without touching Notes", () => {
    const rt = runtime();
    const r = runComposeNote(
      {
        mode: "create",
        title: "T",
        markdown: "# T\n- [ ] a\n> q",
        dryRun: true,
      },
      rt
    );
    expect(r).toEqual({
      status: "planned",
      dryRun: true,
      committed: false,
      mode: "create",
      paragraphs: 2,
      plan: [
        { style: "checklist", indent: 0, blockQuote: false, checked: false, runs: 1 },
        { style: "body", indent: 0, blockQuote: true, runs: 1 },
      ],
    });
    expect(rt.manager.createNote).not.toHaveBeenCalled();
    expect(privateWriterCapabilities).not.toHaveBeenCalled();
  });

  it("creates through Notes, reads a fresh revision, then composes below the title", () => {
    available();
    const rt = runtime();
    const r = runComposeNote(
      { mode: "create", title: "T", folder: "F", account: "iCloud", blocks: BLOCKS },
      rt
    );
    expect(rt.manager.createNote).toHaveBeenCalledWith("T", "", [], "F", "iCloud", "plaintext");
    expect(readWriterNoteState).toHaveBeenCalledWith(NOTE, { env: ALLOW });
    expect(composeNote).toHaveBeenCalledWith(
      { identifier: NOTE, mode: "append", paragraphs: expect.any(Array), ifRevision: REV },
      { env: ALLOW }
    );
    expect(r).toMatchObject({
      mode: "create",
      created: true,
      id: CD,
      identifier: NOTE,
      committed: true,
    });
  });

  it("waits for a new note to become visible to the database and the helper", () => {
    available();
    const link = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(`notes://showNote?identifier=${NOTE}`);
    vi.mocked(readWriterNoteState)
      .mockImplementationOnce(() => {
        throw new PrivateWriteError("not_found", "no");
      })
      .mockReturnValue({ revision: REV } as never);
    const rt = runtime(managerStub({ getNoteLinkById: link }));
    runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, rt);
    expect(rt.sleep).toHaveBeenCalledTimes(2);
  });

  it("checks the gate and the live capability before creating anything", () => {
    const rt = runtime(managerStub(), {});
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, rt))
    ).toMatchObject({
      code: "not_live_validated",
    });
    vi.mocked(privateWriterCapabilities).mockReturnValue({
      features: { composeNote: { available: false, reason: "disabled", detail: "off" } },
    } as never);
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime()))
    ).toMatchObject({ code: "disabled", committed: false });
    vi.mocked(privateWriterCapabilities).mockReturnValue({
      features: { composeNote: { available: false, reason: null, detail: null } },
    } as never);
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime())).code
    ).toBe("private_api_unavailable");
    expect(rt.manager.createNote).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing title", { mode: "create", blocks: BLOCKS }],
    ["a target note", { mode: "create", title: "T", identifier: NOTE, blocks: BLOCKS }],
    ["ifRevision", { mode: "create", title: "T", ifRevision: REV, blocks: BLOCKS }],
  ])("refuses %s", (_label, args) => {
    expect(caught(() => runComposeNote(args as never, runtime())).code).toBe("invalid_request");
  });

  it("reports a failed create with nothing created", () => {
    available();
    const e = caught(() =>
      runComposeNote(
        { mode: "create", title: "T", blocks: BLOCKS },
        runtime(managerStub({ createNote: vi.fn(() => null) }))
      )
    );
    expect(e).toMatchObject({ code: "create_failed", committed: false });
  });

  it("names the created note when its identity cannot be read", () => {
    available();
    const rt = runtime(managerStub({ getNoteLinkById: vi.fn(() => null) }));
    const e = caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, rt));
    expect(e).toMatchObject({ code: "not_found", details: { noteCreated: true, id: CD } });
    expect(rt.sleep).toHaveBeenCalledTimes(5);
  });

  it("names the created note when the compose fails, keeping its committed state", () => {
    available();
    vi.mocked(composeNote).mockImplementation(() => {
      throw new PrivateWriteError("verification_failed", "differs", true, { indeterminate: true });
    });
    const e = caught(() =>
      runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime())
    );
    expect(e).toMatchObject({
      code: "verification_failed",
      committed: true,
      details: { indeterminate: true, noteCreated: true, id: CD, identifier: NOTE },
    });
    expect(e.message).toMatch(/title only/);
  });

  it("moves the new title-only note to Recently Deleted when nothing was committed", () => {
    available();
    vi.mocked(composeNote).mockImplementation(() => {
      throw new PrivateWriteError("invalid_request", "refused by the writer", false);
    });
    const deleteNoteByIdIfUnchanged = vi.fn(() => ({ status: "deleted" }));
    const getNoteContentById = vi.fn(() => "<div><h1>T</h1></div>");
    const rt = runtime(managerStub({ deleteNoteByIdIfUnchanged, getNoteContentById }));
    const e = caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, rt));
    expect(e).toMatchObject({
      code: "invalid_request",
      committed: false,
      details: { noteCreated: true, id: CD, createdNote: "moved_to_recently_deleted" },
    });
    expect(e.message).toMatch(/moved to Recently Deleted/);
    expect(deleteNoteByIdIfUnchanged).toHaveBeenCalledWith(CD, "<div><h1>T</h1></div>");
  });

  it("keeps the new note when it changed, the delete did not happen, or the write committed", () => {
    available();
    const deleteNoteByIdIfUnchanged = vi.fn(() => ({ status: "conflict" }));
    const manager = managerStub({ deleteNoteByIdIfUnchanged, getNoteContentById: vi.fn(() => "") });
    vi.mocked(composeNote).mockImplementation(() => {
      throw new PrivateWriteError("save_failed", "no", false);
    });
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime(manager)))
        .details
    ).toMatchObject({ createdNote: "kept" });
    vi.mocked(readWriterNoteState)
      .mockReturnValueOnce({ revision: REV } as never)
      .mockReturnValueOnce({ revision: `r1:${"b".repeat(64)}` } as never);
    deleteNoteByIdIfUnchanged.mockClear();
    const changed = caught(() =>
      runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime(manager))
    );
    expect(changed.details).toMatchObject({ createdNote: "kept" });
    expect(changed.message).toMatch(/title only; id/);
    expect(deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
    vi.mocked(composeNote).mockImplementation(() => {
      throw new PrivateWriteError("timeout", "slow", "unknown");
    });
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime(manager)))
        .details
    ).toMatchObject({ createdNote: "kept" });
    expect(deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a request over the writer's input cap before creating anything", () => {
    available();
    const rt = runtime();
    const blocks = Array.from({ length: 130 }, () => ({
      type: "body" as const,
      text: "x".repeat(9_000),
    }));
    for (const dryRun of [true, false])
      expect(
        caught(() => runComposeNote({ mode: "create", title: "T", blocks, dryRun }, rt))
      ).toMatchObject({ code: "invalid_request", committed: false });
    expect(rt.manager.createNote).not.toHaveBeenCalled();
  });

  it("gives up when the helper never sees the new note", () => {
    available();
    vi.mocked(readWriterNoteState).mockImplementation(() => {
      throw new PrivateWriteError("not_found", "no");
    });
    const e = caught(() =>
      runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime())
    );
    expect(e).toMatchObject({ code: "not_found", details: { noteCreated: true } });
  });

  it("does not swallow other helper errors or non-helper exceptions", () => {
    available();
    vi.mocked(readWriterNoteState).mockImplementation(() => {
      throw new PrivateWriteError("store_unavailable", "no");
    });
    expect(
      caught(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime())).code
    ).toBe("store_unavailable");
    vi.mocked(readWriterNoteState).mockImplementation(() => {
      throw new TypeError("boom");
    });
    expect(() => runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, runtime())).toThrow(
      TypeError
    );
  });
});

describe("compose-note objects and note links", () => {
  const OTHER = "11111111-2222-3333-4444-555555555555";

  it("plans dividers and tables in a create dry run", () => {
    const r = runComposeNote(
      {
        mode: "create",
        title: "T",
        markdown: "---\n| a | b |\n|---|---|\n| 1 | 2 |",
        dryRun: true,
      },
      runtime()
    );
    expect(r.plan).toEqual([{ kind: "divider" }, { kind: "table", rows: 2, columns: 2 }]);
  });

  it("checks the object capability before creating a note with a divider or table", () => {
    vi.mocked(privateWriterCapabilities).mockReturnValue({
      features: {
        composeNote: { available: true, reason: null, detail: null },
        composeObjects: { available: false, reason: "private_api_unavailable", detail: "x" },
      },
    } as never);
    const rt = runtime();
    expect(
      caught(() =>
        runComposeNote({ mode: "create", title: "T", blocks: [{ type: "divider" }] }, rt)
      )
    ).toMatchObject({ code: "private_api_unavailable", committed: false });
    expect(rt.manager.createNote).not.toHaveBeenCalled();
    runComposeNote({ mode: "create", title: "T", blocks: BLOCKS }, rt);
    expect(rt.manager.createNote).toHaveBeenCalledTimes(1);
  });

  it("checks each distinct note-link target once before writing", () => {
    const blocks = [
      { type: "noteLink" as const, identifier: OTHER.toLowerCase(), text: "a" },
      { type: "noteLink" as const, identifier: OTHER, text: "b" },
    ];
    runComposeNote({ mode: "append", identifier: NOTE, blocks, dryRun: true }, runtime());
    expect(readWriterNoteState).toHaveBeenCalledTimes(1);
    expect(readWriterNoteState).toHaveBeenCalledWith(OTHER, { env: ALLOW });
    expect(composeNote).toHaveBeenCalledTimes(1);
  });

  it("refuses a link to a note that does not exist, and passes other errors through", () => {
    const blocks = [{ type: "noteLink" as const, identifier: OTHER, text: "a" }];
    vi.mocked(readWriterNoteState).mockImplementationOnce(() => {
      throw new PrivateWriteError("not_found", "no");
    });
    expect(
      caught(() =>
        runComposeNote({ mode: "append", identifier: NOTE, blocks, dryRun: true }, runtime())
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
    vi.mocked(readWriterNoteState).mockImplementationOnce(() => {
      throw new PrivateWriteError("disabled", "off");
    });
    expect(
      caught(() =>
        runComposeNote({ mode: "append", identifier: NOTE, blocks, dryRun: true }, runtime())
      ).code
    ).toBe("disabled");
    expect(composeNote).not.toHaveBeenCalled();
  });

  it("refuses links to trashed or locked notes, from runs and Markdown too", () => {
    const run = [
      {
        type: "body" as const,
        runs: [{ text: "a", link: `applenotes://showNote?identifier=${OTHER}` }],
      },
    ];
    vi.mocked(readWriterNoteState).mockReturnValueOnce({ deletedOrInTrash: true } as never);
    expect(
      caught(() =>
        runComposeNote({ mode: "append", identifier: NOTE, blocks: run, dryRun: true }, runtime())
      ).message
    ).toMatch(/Recently Deleted/);
    vi.mocked(readWriterNoteState).mockReturnValueOnce({ passwordProtected: true } as never);
    const markdown = `See [x](notes://showNote?identifier=${OTHER}).`;
    expect(
      caught(() =>
        runComposeNote({ mode: "append", identifier: NOTE, markdown, dryRun: true }, runtime())
      ).message
    ).toMatch(/locked/);
    expect(readWriterNoteState).toHaveBeenLastCalledWith(OTHER, { env: ALLOW });
    expect(
      caught(() =>
        runComposeNote(
          { mode: "append", identifier: NOTE, markdown: "[x](notes://other)", dryRun: true },
          runtime()
        )
      ).message
    ).toMatch(/does not name a note/);
    expect(composeNote).not.toHaveBeenCalled();
  });

  it("checks the attachment capability before creating a note with a file or link card", () => {
    vi.mocked(privateWriterCapabilities).mockReturnValue({
      features: {
        composeNote: { available: true, reason: null, detail: null },
        composeObjects: { available: true, reason: null, detail: null },
        composeAttachments: { available: false, reason: "not_live_validated", detail: "x" },
      },
    } as never);
    const rt = runtime();
    expect(
      caught(() =>
        runComposeNote(
          { mode: "create", title: "T", blocks: [{ type: "urlCard", url: "https://e.test/" }] },
          rt
        )
      )
    ).toMatchObject({ code: "not_live_validated", committed: false });
    expect(rt.manager.createNote).not.toHaveBeenCalled();
    const plan = runComposeNote(
      {
        mode: "create",
        title: "T",
        blocks: [{ type: "urlCard", url: "https://e.test/" }],
        dryRun: true,
      },
      rt
    );
    expect(plan.plan).toEqual([{ kind: "url", url: "https://e.test/" }]);
  });
});

describe("registerComposeNoteTool", () => {
  function registered() {
    const registerTool = vi.fn();
    registerComposeNoteTool(
      { registerTool } as unknown as McpServer,
      managerStub(),
      () => ({ writer: { env: ALLOW }, nudge: {} }) as never,
      vi.fn()
    );
    return registerTool.mock.calls[0];
  }

  it("registers one write tool with the plan-then-apply contract in its description", () => {
    const [name, config] = registered();
    expect(name).toBe("compose-note");
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(config.description).toMatch(/Safety:.*dryRun.*ifRevision/s);
  });

  it("returns structured results and structured errors", async () => {
    const [, , handler] = registered();
    const ok = await handler({ mode: "append", identifier: NOTE, blocks: BLOCKS, dryRun: true });
    expect(ok.structuredContent).toMatchObject({ ok: true, status: "updated" });
    const bad = await handler({ mode: "append", identifier: NOTE, blocks: BLOCKS });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "invalid_request",
      committed: false,
    });
  });

  it("nudges only after a committed write, and never hides the write on a nudge failure", async () => {
    const [, , handler] = registered();
    vi.mocked(composeNote).mockReturnValue({
      status: "updated",
      committed: true,
      identifier: NOTE,
      storeKind: "copy",
    } as never);
    vi.mocked(nudgeInPlace).mockResolvedValueOnce({
      allUploadsRecorded: true,
      targets: [],
      before: {},
      after: {},
    } as never);
    const nudged = await handler({
      mode: "append",
      identifier: NOTE,
      blocks: BLOCKS,
      ifRevision: REV,
      nudge: true,
      nudgeWaitSeconds: 5,
    });
    expect(nudged.structuredContent.sync).toEqual({
      ok: true,
      allUploadsRecorded: true,
      targets: [],
    });
    expect(vi.mocked(nudgeInPlace).mock.calls[0][0]).toEqual({
      identifiers: [NOTE],
      waitSeconds: 5,
    });
    vi.mocked(nudgeInPlace).mockRejectedValueOnce(
      new PrivateWriteError("helper_unreachable", "gone", undefined)
    );
    const failed = await handler({
      mode: "append",
      identifier: NOTE,
      blocks: BLOCKS,
      ifRevision: REV,
      nudge: true,
    });
    expect(failed.isError).toBeUndefined();
    expect(failed.structuredContent).toMatchObject({
      committed: true,
      sync: { ok: false, code: "helper_unreachable" },
    });
    const plain = await handler({
      mode: "append",
      identifier: NOTE,
      blocks: BLOCKS,
      ifRevision: REV,
    });
    expect(plain.structuredContent.sync).toBeUndefined();
    expect(nudgeInPlace).toHaveBeenCalledTimes(2);
  });

  it("maps a refused write onto the writer envelope", async () => {
    const [, , handler] = registered();
    vi.mocked(composeNote).mockImplementation(() => {
      throw new PrivateWriteError("revision_conflict", "changed", false);
    });
    const conflict = await handler({
      mode: "append",
      identifier: NOTE,
      blocks: BLOCKS,
      ifRevision: REV,
    });
    expect(conflict.structuredContent).toMatchObject({
      code: "revision_conflict",
      committed: false,
      indeterminate: false,
    });
  });

  it("uses a real blocking sleep by default", () => {
    const registerTool = vi.fn();
    registerComposeNoteTool({ registerTool } as unknown as McpServer, managerStub());
    expect(registerTool).toHaveBeenCalledTimes(1);
    const start = Date.now();
    expect(blockingSleep(20)).toBe("timed-out");
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
