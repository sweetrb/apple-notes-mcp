import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import type { FolderAppFacts } from "../types.js";
import type { FolderStoreFacts } from "../utils/folderStore.js";
import { CodedError } from "../utils/errorCodes.js";
import {
  coreDataPk,
  folderDeleteRefusal,
  folderDeleteRevision,
  registerFolderDelete,
  runFolderDelete,
  type FolderDeleteArgs,
  type FolderDeleteDeps,
} from "./folderDelete.js";

const S = "x-coredata://ABC";
const id = `${S}/ICFolder/p12`;
const parentId = `${S}/ICFolder/p2`;
const accountId = `${S}/ICAccount/p1`;

const appFacts = (over: Partial<FolderAppFacts> = {}): FolderAppFacts => ({
  id,
  name: "Old",
  parentId,
  accountId,
  defaultFolderId: `${S}/ICFolder/p3`,
  shared: false,
  childFolderCount: 0,
  noteCount: 0,
  ...over,
});

const storeFacts = (over: Partial<FolderStoreFacts> = {}): FolderStoreFacts => ({
  pk: 12,
  identifier: "UUID-12",
  folderType: 0,
  markedForDeletion: false,
  parentPk: 2,
  accountPk: 1,
  hasSmartQuery: false,
  sharedRecord: false,
  sharedAncestor: false,
  childFolderCount: 0,
  noteCount: 0,
  noteKeys: [],
  ...over,
});

let manager: {
  readFolderForDelete: ReturnType<typeof vi.fn>;
  deleteEmptyFolderIfUnchanged: ReturnType<typeof vi.fn>;
  folderExistsById: ReturnType<typeof vi.fn>;
  countNotesOutsideFolder: ReturnType<typeof vi.fn>;
};
let deps: FolderDeleteDeps & {
  readStore: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  manager = {
    readFolderForDelete: vi.fn(() => appFacts()),
    deleteEmptyFolderIfUnchanged: vi.fn(() => ({ status: "deleted" })),
    folderExistsById: vi.fn(() => false),
    countNotesOutsideFolder: vi.fn(() => 0),
  };
  deps = { readStore: vi.fn(() => storeFacts()), sleep: vi.fn() };
});

const run = (args: Partial<FolderDeleteArgs> = {}) =>
  runFolderDelete(
    manager as unknown as AppleNotesManager,
    {
      id,
      expectedName: "Old",
      expectedAccountId: accountId,
      expectedParentId: parentId,
      dryRun: true,
      ...args,
    },
    deps
  );

const plannedRevision = () => folderDeleteRevision(appFacts(), storeFacts());

describe("folder delete planning", () => {
  it("plans without mutating and returns a revision", () => {
    const plan = run();
    expect(plan).toMatchObject({
      ok: true,
      status: "planned",
      dryRun: true,
      committed: false,
      wouldDelete: true,
      identifier: "UUID-12",
      parentId,
      accountId,
      folderType: 0,
      childFolderCount: 0,
      noteCount: 0,
    });
    expect(plan.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.revision).toBe(plannedRevision());
    expect(manager.deleteEmptyFolderIfUnchanged).not.toHaveBeenCalled();
  });

  it("accepts expectedRoot for a top-level folder", () => {
    manager.readFolderForDelete.mockReturnValue(appFacts({ parentId: null }));
    deps.readStore.mockReturnValue(storeFacts({ parentPk: null }));
    expect(run({ expectedParentId: undefined, expectedRoot: true }).parentId).toBeNull();
  });

  it.each([
    [{ expectedParentId: undefined }, /exactly one/],
    [{ expectedRoot: true }, /exactly one/],
    [{ expectedRevision: "sha256:" + "0".repeat(64) }, /apply call/],
    [{ dryRun: false }, /requires expectedRevision/],
  ] as Array<[Partial<FolderDeleteArgs>, RegExp]>)("rejects invalid arguments %o", (args, re) => {
    expect(() => run(args)).toThrow(re);
    expect(manager.readFolderForDelete).not.toHaveBeenCalled();
  });

  it.each([
    [{ expectedName: "old" }, /name changed/],
    [{ expectedAccountId: `${S}/ICAccount/p9` }, /different account/],
    [{ expectedParentId: `${S}/ICFolder/p9` }, /parent changed/],
    [{ expectedParentId: undefined, expectedRoot: true }, /parent changed/],
  ] as Array<[Partial<FolderDeleteArgs>, RegExp]>)("reports guard drift %o", (args, re) => {
    expect(() => run(args)).toThrow(re);
  });

  it("fails closed when the store has no row, a tombstone, or a different location", () => {
    deps.readStore.mockReturnValueOnce(null);
    expect(() => run()).toThrow(/not in the local Notes store/);
    deps.readStore.mockReturnValueOnce(storeFacts({ markedForDeletion: true }));
    expect(() => run()).toThrow(/already deleted/);
    deps.readStore.mockReturnValueOnce(storeFacts({ parentPk: 99 }));
    expect(() => run()).toThrow(/disagree/);
    deps.readStore.mockReturnValueOnce(storeFacts({ accountPk: 99 }));
    expect(() => run()).toThrow(/disagree/);
  });

  it.each([
    [{}, { folderType: 1 }, /Recently Deleted/],
    [{}, { identifier: "TrashFolder-CloudKit" }, /Recently Deleted/],
    [{}, { folderType: 2 }, /smart folder/],
    [{}, { hasSmartQuery: true }, /smart folder/],
    [{}, { folderType: 3 }, /unsupported folder type 3/],
    [{}, { folderType: null }, /unsupported folder type null/],
    [{}, { identifier: null }, /stable identifier/],
    [{}, { identifier: "DefaultFolder-CloudKit" }, /system or default/],
    [{ defaultFolderId: id }, {}, /system or default/],
    [{ shared: true }, {}, /shared/],
    [{}, { sharedRecord: true }, /shared/],
    [{}, { sharedAncestor: true }, /shared/],
  ] as Array<[Partial<FolderAppFacts>, Partial<FolderStoreFacts>, RegExp]>)(
    "refuses a protected folder %#",
    (app, store, re) => {
      manager.readFolderForDelete.mockReturnValue(appFacts(app));
      deps.readStore.mockReturnValue(storeFacts(store));
      expect(() => run()).toThrow(re);
      expect(folderDeleteRefusal(appFacts(app), storeFacts(store))).toMatch(re);
    }
  );

  it.each([
    [{ childFolderCount: 1 }, {}],
    [{ noteCount: 2 }, {}],
    [{}, { childFolderCount: 1 }],
    [{}, { noteCount: 1 }],
  ] as Array<[Partial<FolderAppFacts>, Partial<FolderStoreFacts>]>)(
    "refuses a non-empty folder with no override %#",
    (app, store) => {
      manager.readFolderForDelete.mockReturnValue(appFacts(app));
      deps.readStore.mockReturnValue(storeFacts(store));
      expect(() => run()).toThrow(/not empty/);
    }
  );

  it("discounts store-counted notes that Notes.app already places elsewhere", () => {
    deps.readStore.mockReturnValue(storeFacts({ noteCount: 1, noteKeys: [44] }));
    manager.countNotesOutsideFolder.mockReturnValue(1);
    const plan = run();
    expect(plan.status).toBe("planned");
    expect(manager.countNotesOutsideFolder).toHaveBeenCalledWith(id, [`${S}/ICNote/p44`]);
    expect(plan.revision).toBe(plannedRevision());
  });

  it("keeps refusing when Notes.app still places the store's note in the folder", () => {
    deps.readStore.mockReturnValue(storeFacts({ noteCount: 1, noteKeys: [44] }));
    expect(() => run()).toThrow(/1 note/);
  });

  it("does not cross-check when the store returned a truncated key list", () => {
    deps.readStore.mockReturnValue(storeFacts({ noteCount: 60, noteKeys: [1, 2] }));
    expect(() => run()).toThrow(/60 note/);
    expect(manager.countNotesOutsideFolder).not.toHaveBeenCalled();
  });

  it("returns no refusal for an ordinary folder", () => {
    expect(folderDeleteRefusal(appFacts(), storeFacts())).toBeNull();
  });

  it("changes the revision when any checked fact changes", () => {
    const base = plannedRevision();
    expect(folderDeleteRevision(appFacts({ name: "New" }), storeFacts())).not.toBe(base);
    expect(folderDeleteRevision(appFacts(), storeFacts({ identifier: "UUID-X" }))).not.toBe(base);
  });

  it("parses x-coredata primary keys", () => {
    expect(coreDataPk(id)).toBe(12);
    expect(() => coreDataPk("nope")).toThrow(/x-coredata/);
  });
});

describe("folder delete apply", () => {
  const apply = (over: Partial<FolderDeleteArgs> = {}) =>
    run({ dryRun: false, expectedRevision: plannedRevision(), ...over });

  it("deletes with in-script guards and verifies readback", () => {
    deps.readStore
      .mockReturnValueOnce(storeFacts())
      .mockReturnValueOnce(storeFacts())
      .mockReturnValueOnce(storeFacts({ markedForDeletion: true }));
    expect(apply()).toMatchObject({
      status: "deleted",
      committed: true,
      verified: true,
      storeTombstoned: true,
    });
    expect(manager.deleteEmptyFolderIfUnchanged).toHaveBeenCalledWith(id, {
      name: "Old",
      parentId,
      accountId,
    });
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("reports storeTombstoned false when the store lags", () => {
    expect(apply().storeTombstoned).toBe(false);
    expect(deps.sleep).toHaveBeenCalledTimes(4);
  });

  it("treats a vanished store row as tombstoned", () => {
    deps.readStore.mockReturnValueOnce(storeFacts()).mockReturnValueOnce(null);
    expect(apply().storeTombstoned).toBe(true);
  });

  it("refuses a stale revision without deleting", () => {
    expect(() => apply({ expectedRevision: "sha256:" + "1".repeat(64) })).toThrow(
      /changed since the dry run/
    );
    expect(manager.deleteEmptyFolderIfUnchanged).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "conflict", reason: "name" }, /folder name changed before deletion/],
    [{ status: "refused", reason: "folder has notes" }, /Refused: folder has notes/],
    [{ status: "failed", reason: "timeout" }, /uncertain \(timeout\)/],
  ])("maps the in-script outcome %o", (outcome, re) => {
    manager.deleteEmptyFolderIfUnchanged.mockReturnValue(outcome);
    expect(() => apply()).toThrow(re);
    expect(manager.folderExistsById).not.toHaveBeenCalled();
  });

  it("reports an uncertain outcome when Notes.app still resolves the folder", () => {
    manager.folderExistsById.mockReturnValue(true);
    expect(() => apply()).toThrow(/still resolves/);
  });

  // #219: after Notes.app accepted the delete, a failed check must not escape
  // as a plain error with no outcome.
  it("reports a throwing existence readback as uncertain", () => {
    manager.folderExistsById.mockImplementation(() => {
      throw new Error("Notes.app is not responding");
    });
    let thrown: unknown;
    try {
      apply();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodedError);
    expect((thrown as CodedError).envelope).toEqual({
      code: "verification_failed",
      indeterminate: true,
    });
    expect((thrown as Error).message).toMatch(/accepted the delete, but the readback failed/);
  });

  it("reports storeTombstoned false when the tombstone read throws", () => {
    deps.readStore.mockReturnValueOnce(storeFacts()).mockImplementation(() => {
      throw new Error("database is locked");
    });
    expect(apply()).toMatchObject({ status: "deleted", committed: true, storeTombstoned: false });
  });
});

describe("delete-folder-by-id registration", () => {
  it("registers a destructive tool that states it is not atomic", async () => {
    const registerTool = vi.fn();
    registerFolderDelete(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager,
      deps
    );
    const [name, config, handler] = registerTool.mock.calls[0];
    expect(name).toBe("delete-folder-by-id");
    expect(config.description).toContain(
      "Not atomic: the guard is a pre-check followed by an AppleScript delete"
    );
    expect(config.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });

    const ok = await handler({
      id,
      expectedName: "Old",
      expectedAccountId: accountId,
      expectedParentId: parentId,
      dryRun: true,
    });
    expect(ok.structuredContent).toMatchObject({ status: "planned" });
    expect(JSON.parse(ok.content[0].text).revision).toBe(plannedRevision());

    manager.readFolderForDelete.mockImplementation(() => {
      throw new Error("Folder not found");
    });
    const failed = await handler({
      id,
      expectedName: "Old",
      expectedAccountId: accountId,
      expectedParentId: parentId,
      dryRun: true,
    });
    expect(failed).toMatchObject({ isError: true, structuredContent: { code: "not_found" } });
    expect(failed.content[0].text).toBe("Folder not found");

    manager.readFolderForDelete.mockImplementation(() => {
      throw "plain";
    });
    const plain = await handler({
      id,
      expectedName: "Old",
      expectedAccountId: accountId,
      expectedParentId: parentId,
      dryRun: true,
    });
    expect(plain.content[0].text).toBe("plain");
  });

  it("returns stable error codes for conflict, refusal, uncertainty, and missing Full Disk Access", async () => {
    const registerTool = vi.fn();
    registerFolderDelete(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager,
      deps
    );
    const handler = registerTool.mock.calls[0][2];
    const args = {
      id,
      expectedName: "Old",
      expectedAccountId: accountId,
      expectedParentId: parentId,
      dryRun: true,
    };

    const conflict = await handler({ ...args, expectedName: "Other" });
    expect(conflict.content[0].text).toMatch(/^Conflict: /);
    expect(conflict.structuredContent).toEqual({ code: "revision_conflict", committed: false });

    manager.readFolderForDelete.mockReturnValue(appFacts({ childFolderCount: 1 }));
    const refused = await handler(args);
    expect(refused.content[0].text).toMatch(/^Refused: /);
    expect(refused.structuredContent).toEqual({ code: "unsupported", committed: false });
    manager.readFolderForDelete.mockReturnValue(appFacts());

    const invalid = await handler({ ...args, expectedRoot: true });
    expect(invalid.structuredContent).toEqual({ code: "validation_error", committed: false });

    const planned = await handler(args);
    manager.folderExistsById.mockReturnValue(true);
    const uncertain = await handler({
      ...args,
      dryRun: false,
      expectedRevision: planned.structuredContent.revision,
    });
    expect(uncertain.structuredContent).toEqual({
      code: "verification_failed",
      indeterminate: true,
    });

    deps.readStore.mockImplementation(() => {
      throw new Error(
        "Full Disk Access is required to verify folder type and contents before deleting."
      );
    });
    const noFda = await handler(args);
    expect(noFda.structuredContent).toMatchObject({ code: "full_disk_access_missing" });
  });
});
