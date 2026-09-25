import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./privateWriter.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  callPrivateWriter: vi.fn(),
  readWriterNoteState: vi.fn(),
}));
import {
  PrivateWriteError,
  callPrivateWriter,
  readWriterNoteState,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import {
  installWriterParagraphIdReminter,
  writerParagraphIdReminter,
} from "./privateWriterReminter.js";
import { paragraphIdReminter, setParagraphIdReminter } from "../utils/paragraphAnchors.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const PID = "0B6E6F46-5C9E-4F7B-9E57-7D3C9A1E2F10";
const REV = `r1:${"a".repeat(64)}`;
const REV2 = `r1:${"b".repeat(64)}`;
const ON = {
  APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
  APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
};
const UNVERIFIED = { ...ON, APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };
const deps = (env: Record<string, string>) => () => ({ env }) as unknown as PrivateHelperDeps;

const request = {
  anchorId: "pa_0123456789abcdef",
  noteId: "x-coredata://STORE/ICNote/p10",
  noteIdentifier: NOTE,
  blockIndex: 3,
  expectedText: "Charlie paragraph",
  currentParagraphId: null,
};

const common = {
  identifier: NOTE,
  blockIndex: 3,
  styleType: 0,
  paragraphId: PID,
  url: `applenotes://showNote?identifier=${NOTE}&paragraphID=${PID}`,
  revisionBefore: REV,
};

const updated = {
  ...common,
  status: "updated",
  changed: true,
  committed: true,
  verified: true,
  previousParagraphId: null,
  previousParagraphIdStatus: "missing",
  revisionAfter: REV2,
  modificationDate: null,
  cloudSync: { available: true, inICloudAccount: true, uploadPending: true },
  pushScheduled: false,
  pushState: "awaiting_notes_app",
  syncHostRunning: true,
  storeKind: "copy",
};

const unchanged = {
  ...common,
  status: "unchanged",
  changed: false,
  committed: false,
  previousParagraphId: PID,
  previousParagraphIdStatus: "unique",
  revisionAfter: REV,
};

/** set_paragraph_id answers `setResult`; any other writer action is unexpected. */
function writer(setResult: unknown = updated) {
  vi.mocked(callPrivateWriter).mockImplementation(((action: string) => {
    if (action === "set_paragraph_id") return setResult;
    throw new Error(`unexpected action ${action}`);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readWriterNoteState).mockReturnValue({ identifier: NOTE, revision: REV } as never);
});
afterEach(() => setParagraphIdReminter(undefined));

describe("writer paragraph-ID reminter", () => {
  it("is installed only when both writer switches are on", () => {
    expect(installWriterParagraphIdReminter({})).toBe(false);
    expect(paragraphIdReminter()).toBeUndefined();
    expect(installWriterParagraphIdReminter({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })).toBe(false);
    expect(paragraphIdReminter()).toBeUndefined();
    expect(installWriterParagraphIdReminter(ON)).toBe(true);
    expect(paragraphIdReminter()).toBeTypeOf("function");
    // With the switches off again, it is removed.
    expect(installWriterParagraphIdReminter({})).toBe(false);
    expect(paragraphIdReminter()).toBeUndefined();
  });

  it("reads a fresh revision, then sets the matched block's ID with it", async () => {
    writer();
    const result = await writerParagraphIdReminter(deps(UNVERIFIED))(request);
    expect(result).toEqual({ paragraphId: PID });
    expect(vi.mocked(readWriterNoteState).mock.calls.map((call) => call[0])).toEqual([NOTE]);
    const calls = vi.mocked(callPrivateWriter).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(["set_paragraph_id"]);
    expect(calls[0][1]).toEqual({
      identifier: NOTE,
      blockIndex: 3,
      expectedText: "Charlie paragraph",
      ifRevision: REV,
    });
  });

  it("returns the existing ID when the writer finds it already unique", async () => {
    writer(unchanged);
    expect(await writerParagraphIdReminter(deps(UNVERIFIED))(request)).toEqual({
      paragraphId: PID,
    });
  });

  it("refuses without both switches at call time and calls nothing", async () => {
    writer();
    await expect(writerParagraphIdReminter(deps({}))(request)).rejects.toMatchObject({
      code: "disabled",
      committed: false,
    });
    expect(readWriterNoteState).not.toHaveBeenCalled();
    expect(callPrivateWriter).not.toHaveBeenCalled();
  });

  it("keeps native-set-paragraph-id's live-validation gate", async () => {
    writer();
    await expect(writerParagraphIdReminter(deps(ON))(request)).rejects.toThrow(
      /APPLE_NOTES_MCP_ALLOW_UNVERIFIED/
    );
    expect(readWriterNoteState).toHaveBeenCalledTimes(1);
    expect(callPrivateWriter).not.toHaveBeenCalled();
  });

  it("passes the writer's refusal through with its committed state", async () => {
    vi.mocked(callPrivateWriter).mockImplementation(() => {
      throw new PrivateWriteError("paragraph_changed", "The paragraph changed", false);
    });
    await expect(writerParagraphIdReminter(deps(UNVERIFIED))(request)).rejects.toMatchObject({
      code: "paragraph_changed",
      committed: false,
    });
  });
});
