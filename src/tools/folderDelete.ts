/**
 * Guarded deletion of one exact, empty, ordinary folder (`delete-folder-by-id`).
 *
 * The flow is plan then apply. A dry run reads the folder from Notes.app and
 * from the read-only NoteStore database, checks the caller's name, account,
 * and parent guards, refuses every folder that is not an ordinary user folder,
 * and returns a revision token over the checked state. The apply call repeats
 * every read and check, requires the token to be unchanged, and only then asks
 * Notes.app to delete the folder. The Notes.app-visible guards run again inside
 * the same AppleScript as the `delete`; the store-only guards (folder type,
 * stable identifier) run just before it. The whole guard is therefore a
 * pre-check followed by an AppleScript delete, not one atomic transaction.
 *
 * @module tools/folderDelete
 */

import { createHash } from "node:crypto";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import type { FolderAppFacts, FolderDeleteResult } from "../types.js";
import { readFolderStoreFacts, type FolderStoreFacts } from "../utils/folderStore.js";

const folderIdSchema = z
  .string()
  .max(2000)
  .regex(/^x-coredata:\/\/[0-9a-f-]+\/ICFolder\/p\d+$/i, "An exact folder ID is required");
const accountIdSchema = z
  .string()
  .max(2000)
  .regex(/^x-coredata:\/\/[0-9a-f-]+\/ICAccount\/p\d+$/i, "An exact account ID is required");
const revisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Arguments accepted by `delete-folder-by-id`. */
export interface FolderDeleteArgs {
  id: string;
  expectedName: string;
  expectedAccountId: string;
  expectedParentId?: string;
  expectedRoot?: boolean;
  dryRun: boolean;
  expectedRevision?: string;
}

/** Injectable store reader and delay, so tests never touch the live store. */
export interface FolderDeleteDeps {
  readStore: (pk: number) => FolderStoreFacts | null;
  sleep: (ms: number) => void;
}

const defaultDeps: FolderDeleteDeps = {
  readStore: (pk) => readFolderStoreFacts(pk),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/** Primary key (`pN`) of an x-coredata id. */
export function coreDataPk(id: string): number {
  const match = /\/p(\d+)$/.exec(id);
  if (!match) throw new Error(`Not an x-coredata id: ${id}`);
  return Number(match[1]);
}

/**
 * Why this folder must never be deleted through this tool, or null for an
 * ordinary user folder. Every reason is final; there is no override.
 */
export function folderDeleteRefusal(app: FolderAppFacts, store: FolderStoreFacts): string | null {
  if (store.folderType === 1 || store.identifier?.startsWith("TrashFolder-"))
    return "Refusing to delete the Recently Deleted folder";
  if (store.folderType === 2 || store.hasSmartQuery) return "Refusing to delete a smart folder";
  if (store.folderType !== 0)
    return `Refusing to delete a folder with unsupported folder type ${String(store.folderType)}`;
  if (!store.identifier)
    return "Refusing to delete a folder without a stable identifier (it cannot be verified)";
  if (store.identifier.startsWith("DefaultFolder-") || app.defaultFolderId === app.id)
    return "Refusing to delete a system or default folder";
  if (app.shared || store.sharedRecord || store.sharedAncestor)
    return "Refusing to delete a shared or collaborated folder";
  return null;
}

/** Revision token over every checked fact, in a fixed order. */
export function folderDeleteRevision(app: FolderAppFacts, store: FolderStoreFacts): string {
  const state = [
    app.id,
    store.identifier,
    app.name,
    app.accountId,
    app.parentId,
    app.defaultFolderId === app.id,
    app.shared,
    app.childFolderCount,
    app.noteCount,
    store.folderType,
    store.markedForDeletion,
    store.hasSmartQuery,
    store.sharedRecord,
    store.sharedAncestor,
    store.childFolderCount,
    store.noteCount,
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`;
}

/** Reads both views of the folder and checks guards, refusals, and emptiness. */
function checkFolder(
  manager: AppleNotesManager,
  args: FolderDeleteArgs,
  deps: FolderDeleteDeps
): { app: FolderAppFacts; store: FolderStoreFacts; identifier: string; revision: string } {
  const app = manager.readFolderForDelete(args.id);
  const store = deps.readStore(coreDataPk(args.id));
  if (!store)
    throw new Error(
      "Conflict: the folder is not in the local Notes store yet; wait for Notes to save it and plan again"
    );
  if (store.markedForDeletion) throw new Error("Conflict: the folder is already deleted");
  const expectedParentPk = app.parentId ? coreDataPk(app.parentId) : null;
  if (store.accountPk !== coreDataPk(app.accountId) || store.parentPk !== expectedParentPk)
    throw new Error(
      "Conflict: Notes.app and the local store disagree about this folder's location; wait a moment and plan again"
    );
  if (app.name !== args.expectedName) throw new Error("Conflict: the folder name changed");
  if (app.accountId !== args.expectedAccountId)
    throw new Error("Conflict: the folder is in a different account");
  if (args.expectedRoot ? app.parentId !== null : app.parentId !== args.expectedParentId)
    throw new Error("Conflict: the folder's parent changed");
  const refusal = folderDeleteRefusal(app, store);
  if (refusal) throw new Error(`Refused: ${refusal}`);
  // The store can keep a just-trashed note in its old folder for minutes.
  // When it counts more notes than Notes.app lists, ask Notes.app where each
  // of those notes is now and discount only the ones it places elsewhere.
  let storeNotes = store.noteCount;
  if (storeNotes > app.noteCount && store.noteKeys.length === storeNotes) {
    const notePrefix = args.id.replace(/\/ICFolder\/p\d+$/, "/ICNote/p");
    storeNotes -= manager.countNotesOutsideFolder(
      args.id,
      store.noteKeys.map((key) => `${notePrefix}${key}`)
    );
  }
  const children = Math.max(app.childFolderCount, store.childFolderCount);
  const notes = Math.max(app.noteCount, storeNotes);
  if (children > 0 || notes > 0)
    throw new Error(
      `Refused: the folder is not empty (${children} child folder(s), ${notes} note(s)); move or delete them first`
    );
  return {
    app,
    store,
    identifier: store.identifier as string,
    revision: folderDeleteRevision(app, { ...store, noteCount: storeNotes }),
  };
}

/**
 * Plans (dryRun true) or applies (dryRun false) a guarded folder delete.
 *
 * @throws Error whose message starts with "Conflict:" for drift, "Refused:"
 *   for a folder this tool never deletes, or describes an uncertain outcome
 */
export function runFolderDelete(
  manager: AppleNotesManager,
  args: FolderDeleteArgs,
  deps: FolderDeleteDeps = defaultDeps
): FolderDeleteResult {
  if (Boolean(args.expectedRoot) === (args.expectedParentId !== undefined))
    throw new Error("Pass exactly one of expectedParentId or expectedRoot: true");
  if (args.dryRun && args.expectedRevision)
    throw new Error("expectedRevision belongs to the apply call (dryRun: false)");
  if (!args.dryRun && !args.expectedRevision)
    throw new Error("Apply requires expectedRevision from a matching dry run");

  const checked = checkFolder(manager, args, deps);
  const base = {
    ok: true as const,
    id: args.id,
    identifier: checked.identifier,
    name: checked.app.name,
    accountId: checked.app.accountId,
    parentId: checked.app.parentId,
    folderType: 0 as const,
    childFolderCount: 0 as const,
    noteCount: 0 as const,
    revision: checked.revision,
  };
  if (args.dryRun)
    return { ...base, status: "planned", dryRun: true, committed: false, wouldDelete: true };

  if (checked.revision !== args.expectedRevision)
    throw new Error("Conflict: the folder changed since the dry run; plan again");

  const outcome = manager.deleteEmptyFolderIfUnchanged(args.id, {
    name: checked.app.name,
    parentId: checked.app.parentId,
    accountId: checked.app.accountId,
  });
  if (outcome.status === "conflict")
    throw new Error(`Conflict: the folder ${outcome.reason} changed before deletion; plan again`);
  if (outcome.status === "refused") throw new Error(`Refused: ${outcome.reason}`);
  if (outcome.status === "failed")
    throw new Error(
      `The delete outcome is uncertain (${outcome.reason}); read folder ${args.id} before retrying`
    );

  if (manager.folderExistsById(args.id))
    throw new Error(
      `The delete outcome is uncertain: Notes.app still resolves folder ${args.id}; read it before retrying`
    );
  let storeTombstoned = false;
  for (let attempt = 0; attempt < 5 && !storeTombstoned; attempt++) {
    if (attempt > 0) deps.sleep(200);
    const after = deps.readStore(coreDataPk(args.id));
    storeTombstoned = !after || after.markedForDeletion;
  }
  return {
    ...base,
    status: "deleted",
    dryRun: false,
    committed: true,
    wouldDelete: true,
    verified: true,
    storeTombstoned,
  };
}

/** Registers `delete-folder-by-id` on the MCP server. */
export function registerFolderDelete(
  server: McpServer,
  manager: AppleNotesManager,
  deps: FolderDeleteDeps = defaultDeps
) {
  const inputSchema = {
    id: folderIdSchema.describe("Exact folder id (x-coredata://…/ICFolder/pN) from list-folders"),
    expectedName: z
      .string()
      .min(1)
      .max(1000)
      .describe("Current folder name (not a path), matched case-sensitively"),
    expectedAccountId: accountIdSchema.describe(
      "Owning account id, from get-folder-by-id or list-accounts"
    ),
    expectedParentId: folderIdSchema
      .optional()
      .describe("Current parent folder id; omit and pass expectedRoot for a top-level folder"),
    expectedRoot: z
      .literal(true)
      .optional()
      .describe("Pass true when the folder sits at the account root (no parent folder)"),
    dryRun: z
      .boolean()
      .describe("true plans and returns a revision; false applies with expectedRevision"),
    expectedRevision: revisionSchema
      .optional()
      .describe("The revision returned by the dry run; required when dryRun is false"),
  };
  server.registerTool(
    "delete-folder-by-id",
    {
      description:
        "Use when: deleting one exact, empty, ordinary folder by id, with a plan-then-apply handshake.\n" +
        "Returns: a plan (status planned, wouldDelete, identity fields, zero counts, revision) or, on apply, status deleted with verified readback.\n" +
        "Do not use when: the folder holds notes or subfolders, or you only have a name or path (delete-folder).\n" +
        "Safety: requires the exact id plus expectedName, expectedAccountId, and expectedParentId or expectedRoot. Call with dryRun true, then repeat the same guards with dryRun false and expectedRevision. " +
        "Always refuses Recently Deleted, smart folders, the account's default and other system folders, shared folders, and non-empty folders; there is no override. " +
        "Not atomic: the guard is a pre-check followed by an AppleScript delete. The Notes.app-visible checks repeat inside the delete script, but folder type is read from the local store just before it. Needs Full Disk Access and fails closed without it.",
      inputSchema,
      outputSchema: z.object({ ok: z.boolean().optional() }).passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (async (args: FolderDeleteArgs) => {
      try {
        const result = runFolderDelete(manager, args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }) as unknown as ToolCallback<typeof inputSchema>
  );
}
