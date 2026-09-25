import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriter.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  privateWriterCapabilities: vi.fn(),
  appendPlainText: vi.fn(),
  editNote: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
  syncPush: vi.fn(),
}));
import { PrivateHelperError } from "../services/privateHelper.js";
import { nudgeInPlace, syncPush } from "../services/privateSyncNudge.js";
import {
  PrivateWriteError,
  appendPlainText,
  editNote,
  privateWriterCapabilities,
} from "../services/privateWriter.js";
import { ERROR_CODES } from "../utils/errorCodes.js";
import {
  defaultWriterToolDeps,
  nudgeAfterWrite,
  registerPrivateWriterTools,
  writerEnvelopeCode,
  writerErrorResult,
} from "./privateWriterTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";

function fixture(link: string | null = `notes://showNote?identifier=${NOTE}`) {
  const registerTool = vi.fn();
  const manager = { getNoteLinkById: vi.fn(() => link) } as unknown as AppleNotesManager;
  registerPrivateWriterTools({ registerTool } as unknown as McpServer, manager, () => ({
    writer: {} as never,
    nudge: {} as never,
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error(`missing ${name}`);
    return item[2](args);
  };
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  const names = () => registerTool.mock.calls.map((c) => c[0]);
  return { call, config, names };
}

beforeEach(() => vi.clearAllMocks());

describe("private writer tools", () => {
  it("registers the status tool and the demonstration write", () => {
    const { config, names } = fixture();
    expect(names()).toEqual([
      "native-writer-status",
      "native-append-plain-text",
      "native-sync-push",
      "native-edit-note",
    ]);
    expect(config("native-sync-push").description).toMatch(/requires confirm: true/);
    // relaunch quits Notes.app, so the tool as a whole is marked destructive.
    expect(config("native-sync-push").annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(config("native-edit-note").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(config("native-edit-note").description).toMatch(/dryRun: true.*revisionBefore/s);
    expect(config("native-writer-status").annotations.readOnlyHint).toBe(true);
    const append = config("native-append-plain-text");
    expect(append.annotations.readOnlyHint).toBe(false);
    expect(append.description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
    expect(append.description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
  });

  it("status adds the writer setup command while it is not installed", async () => {
    vi.mocked(privateWriterCapabilities).mockReturnValueOnce({
      installation: { ready: false },
    } as never);
    const r = await fixture().call("native-writer-status", {});
    expect(r.structuredContent).toMatchObject({
      ok: true,
      setupCommand: "apple-notes-mcp setup --native-writer",
    });
    vi.mocked(privateWriterCapabilities).mockReturnValueOnce({
      installation: { ready: true },
    } as never);
    const ready = await fixture().call("native-writer-status", {});
    expect(ready.structuredContent.setupCommand).toBeUndefined();
  });

  it("appends by identifier or resolved id, without a nudge by default", async () => {
    vi.mocked(appendPlainText).mockReturnValue({ status: "updated", committed: true } as never);
    const r = await fixture().call("native-append-plain-text", {
      id: CD,
      text: "x",
      ifRevision: REV,
    });
    expect(r.structuredContent).toMatchObject({ ok: true, committed: true });
    expect(vi.mocked(appendPlainText).mock.calls[0][0]).toEqual({
      identifier: NOTE,
      text: "x",
      ifRevision: REV,
    });
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("nudges after a verified write when asked, and never hides the write on a nudge failure", async () => {
    vi.mocked(appendPlainText).mockReturnValue({ status: "updated", committed: true } as never);
    vi.mocked(nudgeInPlace).mockResolvedValueOnce({
      allUploadsRecorded: true,
      targets: [],
      before: {},
      after: {},
    } as never);
    const r = await fixture().call("native-append-plain-text", {
      identifier: NOTE,
      text: "x",
      ifRevision: REV,
      nudge: true,
      nudgeWaitSeconds: 5,
    });
    expect(r.structuredContent.sync).toEqual({ ok: true, allUploadsRecorded: true, targets: [] });
    expect(vi.mocked(nudgeInPlace).mock.calls[0][0]).toEqual({
      identifiers: [NOTE],
      waitSeconds: 5,
    });
    vi.mocked(nudgeInPlace).mockRejectedValueOnce(
      new PrivateWriteError("helper_unreachable", "gone", undefined)
    );
    const failed = await fixture().call("native-append-plain-text", {
      identifier: NOTE,
      text: "x",
      ifRevision: REV,
      nudge: true,
    });
    expect(failed.isError).toBeUndefined();
    expect(failed.structuredContent).toMatchObject({
      committed: true,
      sync: { ok: false, code: "helper_unreachable" },
    });
  });

  it("native-sync-push passes its arguments through and reports a refused relaunch", async () => {
    vi.mocked(syncPush).mockResolvedValueOnce({
      method: "status",
      allUploadsRecorded: true,
      pushScheduled: false,
      targets: [],
    } as never);
    const r = await fixture().call("native-sync-push", { identifiers: [NOTE], method: "status" });
    expect(r.structuredContent).toMatchObject({ ok: true, method: "status", pushScheduled: false });
    expect(vi.mocked(syncPush).mock.calls[0][0]).toEqual({
      identifiers: [NOTE],
      method: "status",
    });
    vi.mocked(syncPush).mockRejectedValueOnce(
      new PrivateWriteError("confirmation_required", "ask first", false)
    );
    const refused = await fixture().call("native-sync-push", {
      identifiers: [NOTE],
      method: "relaunch",
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "confirmation_required",
      committed: false,
    });
  });

  it("plans and applies edits with the resolved identifier, nudging only a committed apply", async () => {
    const operations = [
      { op: "replace", selector: { text: "Draft" }, replacement: { text: "Final" } },
    ];
    vi.mocked(editNote).mockReturnValueOnce({ status: "planned", revisionBefore: REV } as never);
    const plan = await fixture().call("native-edit-note", {
      id: CD,
      dryRun: true,
      operations,
      nudge: true,
    });
    expect(vi.mocked(editNote).mock.calls[0][0]).toEqual({
      identifier: NOTE,
      dryRun: true,
      ifRevision: undefined,
      requireNonSystemPaper: undefined,
      operations,
    });
    expect(plan.structuredContent).toEqual({ ok: true, status: "planned", revisionBefore: REV });
    expect(nudgeInPlace).not.toHaveBeenCalled();

    vi.mocked(editNote).mockReturnValueOnce({ status: "updated", committed: true } as never);
    vi.mocked(nudgeInPlace).mockResolvedValueOnce({
      allUploadsRecorded: true,
      targets: [],
    } as never);
    const applied = await fixture().call("native-edit-note", {
      identifier: NOTE,
      dryRun: false,
      ifRevision: REV,
      requireNonSystemPaper: true,
      operations,
      nudge: true,
    });
    expect(vi.mocked(editNote).mock.calls[1][0]).toMatchObject({
      ifRevision: REV,
      requireNonSystemPaper: true,
    });
    expect(applied.structuredContent.sync).toMatchObject({ ok: true, allUploadsRecorded: true });

    vi.mocked(editNote).mockImplementationOnce(() => {
      throw new PrivateWriteError("mixed_formatting", "mixed", false, { operationIndex: 0 });
    });
    const refused = await fixture().call("native-edit-note", {
      identifier: NOTE,
      dryRun: false,
      ifRevision: REV,
      operations,
    });
    expect(refused.structuredContent).toMatchObject({
      helperCode: "mixed_formatting",
      committed: false,
      indeterminate: false,
      operationIndex: 0,
    });
  });

  it("validates edit input with the declared schema", () => {
    const edit = fixture().config("native-edit-note").inputSchema;
    expect(edit.operations.safeParse([]).success).toBe(false);
    expect(
      edit.operations.safeParse([{ op: "set_title", replacement: { text: "T" } }]).success
    ).toBe(true);
    expect(edit.dryRun.safeParse(undefined).success).toBe(false);
    expect(edit.ifRevision.safeParse("sha256:abc").success).toBe(false);
  });

  it("refuses identifier plus id, and an id that cannot be resolved", async () => {
    const both = await fixture().call("native-append-plain-text", {
      identifier: NOTE,
      id: CD,
      text: "x",
      ifRevision: REV,
    });
    expect(both.structuredContent).toMatchObject({ code: "validation_error", committed: false });
    const unresolved = await fixture(null).call("native-append-plain-text", {
      id: CD,
      text: "x",
      ifRevision: REV,
    });
    expect(unresolved.structuredContent.code).toBe("not_found");
  });
});

describe("writerErrorResult", () => {
  it("carries committed false, committed true, and indeterminate outcomes", () => {
    const conflict = writerErrorResult(
      new PrivateWriteError("revision_conflict", "changed", false, { currentRevision: REV })
    );
    expect(conflict.structuredContent).toEqual({
      code: "revision_conflict",
      helperCode: "revision_conflict",
      committed: false,
      indeterminate: false,
      currentRevision: REV,
    });
    const verify = writerErrorResult(new PrivateWriteError("verification_failed", "x", true));
    expect(verify.structuredContent).toMatchObject({
      code: "verification_failed",
      committed: true,
      indeterminate: true,
    });
    const timeout = writerErrorResult(new PrivateWriteError("timeout", "slow", "unknown"));
    expect(timeout.structuredContent).toMatchObject({
      code: "timeout_indeterminate",
      indeterminate: true,
    });
    expect(timeout.structuredContent.committed).toBeUndefined();
    const read = writerErrorResult(new PrivateHelperError("not_found", "no"));
    expect(read.structuredContent).toMatchObject({ code: "not_found", committed: false });
    const plain = writerErrorResult(new Error("boom"));
    expect(plain.content[0].text).toBe("native writer: boom");
    expect(writerErrorResult("str").content[0].text).toBe("native writer: str");
  });

  it("maps writer codes onto the documented vocabulary", () => {
    for (const code of [
      "revision_conflict",
      "verification_failed",
      "writes_disabled",
      "not_live_validated",
      "ambiguous",
      "confirmation_required",
      "relaunch_failed",
      "ambiguous_target",
      "save_failed",
      "timeout",
    ])
      expect(Object.keys(ERROR_CODES)).toContain(writerEnvelopeCode(code, ""));
    expect(writerEnvelopeCode("writes_disabled", "")).toBe("unsupported");
    expect(writerEnvelopeCode("ambiguous", "")).toBe("ambiguous");
    expect(writerEnvelopeCode("ambiguous_target", "")).toBe("ambiguous");
    expect(writerEnvelopeCode("match_count_mismatch", "")).toBe("validation_error");
    // An apply whose request or replacement file differs from the dry run.
    expect(writerEnvelopeCode("plan_mismatch", "")).toBe("revision_conflict");
    expect(writerEnvelopeCode("unsupported_attachment", "")).toBe("unsupported");
  });
});

describe("nudgeAfterWrite and defaults", () => {
  it("reports a non-helper failure as internal_error", async () => {
    vi.mocked(nudgeInPlace).mockRejectedValueOnce("weird");
    expect(await nudgeAfterWrite(NOTE, undefined, {} as never)).toEqual({
      ok: false,
      code: "internal_error",
      message: "weird",
    });
  });

  it("builds writer deps that share one writer between the write and the nudge", () => {
    const deps = defaultWriterToolDeps();
    expect(deps.nudge.helper).toBe(deps.writer);
    expect(deps.writer.sourcePath).toMatch(/apple-notes-private-writer\.m$/);
  });
});
