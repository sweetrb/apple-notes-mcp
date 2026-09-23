import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IN_TRASH_MESSAGE,
  runGuardedNoteDelete,
  trashFolderIdsFor,
  type GuardSnapshot,
  type GuardedDeleteArgs,
  type GuardedDeleteDeps,
} from "./guardedDelete.js";

const S = "x-coredata://ABC";
const A = `${S}/ICNote/p10`;
const B = `${S}/ICNote/p11`;
const C = `${S}/ICNote/p12`;
const hash = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const snap = (title: string, n: number, shared = false): GuardSnapshot => ({
  note: { title, shared },
  body: `<div>${title}</div>`,
  contentHash: hash(n),
});

let deps: {
  readSnapshot: ReturnType<typeof vi.fn>;
  deleteIfUnchanged: ReturnType<typeof vi.fn>;
  readTrashFolderPks: ReturnType<typeof vi.fn>;
  readIsQuickNote: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  const snaps: Record<string, GuardSnapshot> = {
    [A]: snap("Original", 1, true),
    [B]: snap("Copy", 2),
    [C]: snap("Destination", 3),
  };
  deps = {
    readSnapshot: vi.fn((id: string) => snaps[id] ?? { error: "Note not found" }),
    deleteIfUnchanged: vi.fn(() => ({ status: "deleted" })),
    readTrashFolderPks: vi.fn(() => [5]),
    readIsQuickNote: vi.fn(() => false),
  };
});

const run = (args: Partial<GuardedDeleteArgs> = {}) =>
  runGuardedNoteDelete(deps as unknown as GuardedDeleteDeps, {
    id: A,
    expectedContentHash: hash(1),
    ...args,
  });

describe("plain guarded delete", () => {
  it("deletes with the trash check on by default and no permanent flag", () => {
    expect(run()).toEqual({
      ok: true,
      id: A,
      title: "Original",
      wasShared: true,
      previousContentHash: hash(1),
      permanent: false,
    });
    expect(deps.deleteIfUnchanged).toHaveBeenCalledWith(A, "<div>Original</div>", {
      allowPermanent: false,
      trashFolderIds: [`${S}/ICFolder/p5`],
      activeNotes: [],
    });
    expect(deps.readIsQuickNote).not.toHaveBeenCalled();
  });

  it("refuses a note in Recently Deleted unless permanent is true", () => {
    deps.deleteIfUnchanged.mockReturnValue({ status: "in_trash" });
    expect(run()).toEqual({ error: IN_TRASH_MESSAGE });
    deps.deleteIfUnchanged.mockReturnValue({ status: "deleted", permanent: true });
    expect(run({ permanent: true })).toMatchObject({ ok: true, permanent: true });
    expect(deps.deleteIfUnchanged.mock.calls[1][2]).toMatchObject({ allowPermanent: true });
  });

  it("reports read errors, stale revisions, conflicts, and uncertain outcomes", () => {
    expect(run({ id: `${S}/ICNote/p99` })).toEqual({ error: "Note not found" });
    expect(run({ expectedContentHash: hash(9) })).toMatchObject({ error: /changed after/ });
    deps.deleteIfUnchanged.mockReturnValueOnce({ status: "conflict" });
    expect(run()).toMatchObject({ error: /changed after/ });
    deps.deleteIfUnchanged.mockReturnValueOnce({ status: "failed" });
    expect(run()).toMatchObject({ error: /uncertain/ });
  });

  it("still deletes when the store is unreadable, relying on the in-script checks", () => {
    deps.readTrashFolderPks.mockImplementation(() => {
      throw new Error("Full Disk Access is required");
    });
    expect(run()).toMatchObject({ ok: true });
    expect(deps.deleteIfUnchanged.mock.calls[0][2].trashFolderIds).toEqual([]);
  });

  it("builds no trash ids for a malformed note id", () => {
    expect(trashFolderIdsFor("nope", deps as unknown as GuardedDeleteDeps)).toEqual([]);
    expect(deps.readTrashFolderPks).not.toHaveBeenCalled();
  });
});

describe("copy-then-retire guard", () => {
  it("re-reads both revisions and passes the guard body into the delete script", () => {
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      ok: true,
      guardNoteId: B,
      guardContentHash: hash(2),
    });
    expect(deps.readSnapshot.mock.calls.map((call) => call[0])).toEqual([A, B]);
    expect(deps.readIsQuickNote).toHaveBeenCalledWith(11);
    expect(deps.deleteIfUnchanged.mock.calls[0][2].activeNotes).toEqual([
      { id: B, expectedBody: "<div>Copy</div>" },
    ]);
    // Store reads happen before the revision reads.
    expect(deps.readIsQuickNote.mock.invocationCallOrder[0]).toBeLessThan(
      deps.readSnapshot.mock.invocationCallOrder[0]
    );
  });

  it.each([
    [{ guardNoteId: B }, /together/],
    [{ expectedGuardContentHash: hash(2) }, /together/],
    [{ guardNoteId: A, expectedGuardContentHash: hash(1) }, /different note/],
    [{ requireActiveNoteId: A }, /different note/],
    [
      { guardNoteId: B, expectedGuardContentHash: hash(2), requireActiveNoteId: B },
      /repeats guardNoteId/,
    ],
  ] as Array<[Partial<GuardedDeleteArgs>, RegExp]>)("rejects %o", (args, re) => {
    expect(run(args)).toMatchObject({ error: re });
    expect(deps.deleteIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a stale, missing, or locked guard without deleting", () => {
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(7) })).toMatchObject({
      error: /Guard note "Copy" changed/,
    });
    expect(
      run({ guardNoteId: `${S}/ICNote/p98`, expectedGuardContentHash: hash(2) })
    ).toMatchObject({ error: "Guard note: Note not found" });
    expect(deps.deleteIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a Quick Note guard, a guard missing from the store, and an unreadable store", () => {
    deps.readIsQuickNote.mockReturnValueOnce(true);
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      error: /Guard note is a Quick Note/,
    });
    deps.readIsQuickNote.mockReturnValueOnce(null);
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      error: /not in the local Notes store/,
    });
    deps.readIsQuickNote.mockImplementationOnce(() => {
      throw new Error("Full Disk Access is required");
    });
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      error: /could not be checked: Full Disk Access/,
    });
    deps.readIsQuickNote.mockImplementationOnce(() => {
      throw "plain";
    });
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      error: /could not be checked: plain/,
    });
    expect(deps.deleteIfUnchanged).not.toHaveBeenCalled();
  });

  it("maps in-script guard failures to the right label", () => {
    deps.deleteIfUnchanged.mockReturnValueOnce({ status: "guard_conflict", index: 0 });
    expect(run({ guardNoteId: B, expectedGuardContentHash: hash(2) })).toMatchObject({
      error: /^Guard note changed just before the delete/,
    });
    deps.deleteIfUnchanged.mockReturnValueOnce({
      status: "guard_inactive",
      index: 1,
      reason: "locked",
    });
    expect(
      run({ guardNoteId: B, expectedGuardContentHash: hash(2), requireActiveNoteId: C })
    ).toMatchObject({ error: /^Required active note is no longer active \(locked\)/ });
    deps.deleteIfUnchanged.mockReturnValueOnce({ status: "guard_conflict", index: 5 });
    expect(run()).toMatchObject({ error: /^Guard note changed/ });
    deps.deleteIfUnchanged.mockReturnValueOnce({
      status: "guard_inactive",
      index: 5,
      reason: "missing",
    });
    expect(run()).toMatchObject({ error: /^Guard note is no longer active/ });
  });
});

describe("require-active guard", () => {
  it("checks the destination's state without fingerprinting its content", () => {
    expect(run({ requireActiveNoteId: C })).toMatchObject({ ok: true, requireActiveNoteId: C });
    expect(deps.deleteIfUnchanged.mock.calls[0][2].activeNotes).toEqual([{ id: C }]);
    expect(deps.readIsQuickNote).toHaveBeenCalledWith(12);
  });

  it("refuses a missing or Quick Note destination", () => {
    expect(run({ requireActiveNoteId: `${S}/ICNote/p97` })).toMatchObject({
      error: "Required active note: Note not found",
    });
    deps.readIsQuickNote.mockReturnValueOnce(true);
    expect(run({ requireActiveNoteId: C })).toMatchObject({
      error: /Required active note is a Quick Note/,
    });
  });
});
