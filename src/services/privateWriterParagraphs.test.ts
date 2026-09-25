import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./privateWriter.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  callPrivateWriter: vi.fn(),
}));
import { PrivateWriteError, WRITER_ACTIONS, callPrivateWriter } from "./privateWriter.js";
import { setParagraphId, setParagraphIdSchema } from "./privateWriterParagraphs.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const PID = "0B6E6F46-5C9E-4F7B-9E57-7D3C9A1E2F10";
const REV = `r1:${"a".repeat(64)}`;
const REV2 = `r1:${"b".repeat(64)}`;
const URL = `applenotes://showNote?identifier=${NOTE}&paragraphID=${PID}`;
const UNVERIFIED = { env: { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" } } as never;
const base = { identifier: NOTE, blockIndex: 2, expectedText: "Heading", ifRevision: REV };

const updated = {
  status: "updated",
  changed: true,
  committed: true,
  verified: true,
  identifier: NOTE,
  blockIndex: 2,
  styleType: 1,
  paragraphId: PID,
  url: URL,
  previousParagraphId: null,
  previousParagraphIdStatus: "missing",
  revisionBefore: REV,
  revisionAfter: REV2,
  modificationDate: "2026-09-24T00:00:00.000Z",
  cloudSync: { available: true, inICloudAccount: true, uploadPending: true },
  pushScheduled: false,
  pushState: "awaiting_notes_app",
  syncHostRunning: true,
  storeKind: "copy",
};

function thrown(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    return error as PrivateWriteError;
  }
  throw new Error("expected a throw");
}

beforeEach(() => vi.clearAllMocks());

describe("setParagraphId", () => {
  it("is a write action in the writer table", () => {
    expect(WRITER_ACTIONS.set_paragraph_id).toBe("write");
  });

  it("forwards exactly the writer's fields and parses an update", () => {
    vi.mocked(callPrivateWriter).mockReturnValueOnce(updated);
    const result = setParagraphId({ ...base, paragraphId: PID.toLowerCase() }, UNVERIFIED);
    expect(result).toMatchObject({ status: "updated", url: URL });
    expect(vi.mocked(callPrivateWriter).mock.calls[0].slice(0, 2)).toEqual([
      "set_paragraph_id",
      { ...base, paragraphId: PID },
    ]);
  });

  it("omits paragraphId when minting and accepts an unchanged answer", () => {
    vi.mocked(callPrivateWriter).mockReturnValueOnce({
      ...updated,
      status: "unchanged",
      changed: false,
      committed: false,
      previousParagraphId: PID,
      previousParagraphIdStatus: "unique",
      revisionAfter: REV,
    });
    expect(setParagraphId(base, UNVERIFIED).status).toBe("unchanged");
    expect(vi.mocked(callPrivateWriter).mock.calls[0][1]).toEqual(base);
  });

  it("refuses bad input before spawning, with committed false", () => {
    for (const request of [
      { ...base, identifier: "nope" },
      { ...base, blockIndex: -1 },
      { ...base, blockIndex: 1.5 },
      { ...base, expectedText: " \ufffc " },
      { ...base, ifRevision: "r1:x" },
      { ...base, paragraphId: "nope" },
    ])
      expect(thrown(() => setParagraphId(request, UNVERIFIED))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
    expect(callPrivateWriter).not.toHaveBeenCalled();
  });

  it("needs APPLE_NOTES_MCP_ALLOW_UNVERIFIED until live-validated", () => {
    expect(thrown(() => setParagraphId(base, { env: {} } as never))).toMatchObject({
      code: "not_live_validated",
      committed: false,
    });
    expect(callPrivateWriter).not.toHaveBeenCalled();
  });

  it("treats a malformed success as indeterminate", () => {
    vi.mocked(callPrivateWriter).mockReturnValueOnce({ ...updated, url: "notes://x" });
    expect(thrown(() => setParagraphId(base, UNVERIFIED))).toMatchObject({
      code: "invalid_response",
      committed: "unknown",
    });
  });

  it("does not accept an update without sync fields or verification", () => {
    const { pushState: _pushState, ...noSync } = updated;
    void _pushState;
    expect(setParagraphIdSchema.safeParse(noSync).success).toBe(false);
    expect(setParagraphIdSchema.safeParse({ ...updated, verified: false }).success).toBe(false);
    expect(setParagraphIdSchema.safeParse(updated).success).toBe(true);
  });
});
