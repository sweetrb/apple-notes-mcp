/**
 * Smart folders through the opt-in private writer (#181).
 *
 * Notes stores a smart folder as an ordinary synced folder row (folder type
 * 2) that carries a query document instead of notes. There is no AppleScript
 * or Shortcuts interface for creating or editing one, so these calls go
 * through the writer, which hands every query to Notes' own query model and
 * refuses one Notes cannot store without changing its meaning.
 *
 * The read-only `list-smart-folders` tool (utils/smartFolders.ts) finds smart
 * folders and decodes their rules; this module adds:
 *
 * - `readSmartFolder`: one smart folder's writer state and `f1:` revision.
 * - `createSmartFolder`: idempotent create at an account root or inside an
 *   ordinary folder. Never inside a smart folder, matching the server's
 *   smart-folder destination guard.
 * - `updateSmartFolder`: replace one smart folder's query, guarded by its
 *   revision.
 * - `deleteSmartFolder`: dry-run plan, then an apply bound to the plan's
 *   revision. Empty smart folders only; never ordinary folders.
 *
 * Folders have no note revision, so `ifRevision` here is the folder's `f1:`
 * revision. Every write follows the writer contract in privateWriter.ts.
 *
 * @module services/privateWriterSmartFolders
 */
import { z } from "zod";
import { decodeSmartFolderQuery, type DecodedSmartQuery } from "../utils/smartFolders.js";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";
import {
  PrivateWriteError,
  SMART_FOLDERS_LIVE_VALIDATED,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

/** A query passed as a JSON string or as the parsed object. */
export type SmartFolderQueryInput = string | Record<string, unknown>;

export const FOLDER_REVISION = /^f1:[a-f0-9]{64}$/;
const FOLDER_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const FOLDER_OBJECT_ID = /^x-coredata:\/\/[0-9A-F-]+\/ICFolder\/p\d+$/i;
const MAX_QUERY_BYTES = 64 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1F\x7F-\x9F\uFFFC\u2028\u2029]/u;

const folderCloudSync = z
  .object({
    available: z.boolean(),
    inICloudAccount: z.boolean(),
    currentLocalVersion: z.number().int().optional(),
    latestVersionSyncedToCloud: z.number().int().optional(),
    uploadPending: z.boolean().optional(),
  })
  .passthrough();

export const smartFolderStateSchema = z
  .object({
    identifier: z.string(),
    objectURI: z.string(),
    title: z.string().nullable(),
    folderType: z.number().int(),
    accountIdentifier: z.string().nullable(),
    parentIdentifier: z.string().nullable(),
    queryJSON: z.string().nullable(),
    markedForDeletion: z.boolean(),
    childFolderCount: z.number().int(),
    physicalNoteCount: z.number().int(),
    titleDurability: z.enum(["stamped", "missing"]),
    parentDurability: z.enum(["stamped", "missing"]).nullable(),
    revision: z.string().regex(FOLDER_REVISION),
    cloudSync: folderCloudSync,
  })
  .passthrough();
export type SmartFolderState = z.infer<typeof smartFolderStateSchema>;

export const readSmartFolderSchema = smartFolderStateSchema
  .extend({ status: z.literal("ok"), syncHostRunning: z.boolean() })
  .passthrough();

const pushFields = {
  pushScheduled: z.literal(false),
  syncHostRunning: z.boolean(),
  pushState: z.enum(["awaiting_notes_app", "queued_for_next_launch", "not_applicable"]),
  storeKind: z.enum(["live", "copy"]),
};

const resolutionFields = {
  requestedQueryJSON: z.string(),
  queryJSON: z.string(),
  queryNormalized: z.boolean(),
  deletedWrapperAdded: z.boolean(),
  resolvedTags: z.array(
    z
      .object({
        requested: z.string(),
        standardizedContent: z.string(),
        displayText: z.string().nullable(),
        identifier: z.string().nullable(),
      })
      .passthrough()
  ),
  filterCount: z.number().int(),
  nativeQueryValidated: z.literal(true),
  nativeMinimumSupportedVersion: z.number().int(),
};

export const createSmartFolderResultSchema = smartFolderStateSchema
  .extend({
    status: z.enum(["created", "ok"]),
    changed: z.boolean(),
    existing: z.boolean(),
    committed: z.boolean(),
    ...resolutionFields,
    ...pushFields,
  })
  .passthrough();

export const updateSmartFolderResultSchema = smartFolderStateSchema
  .extend({
    status: z.enum(["updated", "ok"]),
    changed: z.boolean(),
    committed: z.boolean(),
    revisionBefore: z.string().regex(FOLDER_REVISION),
    revisionAfter: z.string().regex(FOLDER_REVISION),
    /**
     * Applied updates only: title or parent timestamps the folder already
     * lacked. The update changes the query alone and does not stamp them.
     */
    timestampsMissing: z
      .array(z.enum(["dateForLastTitleModification", "parentModificationDate"]))
      .optional(),
    ...resolutionFields,
    ...pushFields,
  })
  .passthrough();

export const deleteSmartFolderPlanSchema = smartFolderStateSchema
  .extend({
    status: z.literal("planned"),
    dryRun: z.literal(true),
    committed: z.literal(false),
  })
  .passthrough();

export const deleteSmartFolderResultSchema = smartFolderStateSchema
  .extend({
    status: z.literal("deleted"),
    dryRun: z.literal(false),
    committed: z.literal(true),
    verified: z.literal(true),
    markedForDeletion: z.literal(true),
    revisionBefore: z.string().regex(FOLDER_REVISION),
    revisionAfter: z.string().regex(FOLDER_REVISION),
    ...pushFields,
  })
  .passthrough();

function invalid(message: string): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, false);
}

/**
 * Serialize a query argument to the JSON string the writer takes. Objects
 * are stringified; strings must already hold one JSON object.
 */
export function queryText(query: SmartFolderQueryInput, field: string): string {
  let text: string;
  if (typeof query === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query);
    } catch {
      throw invalid(`${field} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw invalid(`${field} must be a JSON object`);
    text = query;
  } else {
    text = JSON.stringify(query);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_QUERY_BYTES) throw invalid(`${field} exceeds 64 KiB`);
  return text;
}

export function assertFolderTitle(title: string): void {
  if (!title.length || title.length > 256 || title.trim() !== title || CONTROL.test(title))
    throw invalid("title must be 1-256 characters with no control characters or edge whitespace");
}

export function assertFolderReference(value: string, field: string): void {
  if (!FOLDER_IDENTIFIER.test(value) && !FOLDER_OBJECT_ID.test(value))
    throw invalid(`${field} must be a folder identifier or an x-coredata folder id`);
}

function assertSmartFolderIdentifier(identifier: string): void {
  if (!UUID_PATTERN.test(identifier))
    throw invalid("identifier must be a smart folder's identifier (UUID) from list-smart-folders");
}

function assertFolderRevision(ifRevision: string | undefined): asserts ifRevision is string {
  if (!ifRevision || !FOLDER_REVISION.test(ifRevision))
    throw invalid("ifRevision must be the `revision` from native-read-smart-folder or a dry run");
}

/**
 * Adds `decoded`: the stored query read back through list-smart-folders'
 * decoder, so a caller sees the rules Notes will apply, not just JSON.
 */
function withDecoded<T extends { queryJSON: string | null }>(
  folder: T
): T & { decoded: DecodedSmartQuery } {
  return { ...folder, decoded: decodeSmartFolderQuery(folder.queryJSON) };
}

/** One smart folder's writer state and revision. Read-only. */
export function readSmartFolder(identifier: string, deps: PrivateHelperDeps = defaultWriterDeps()) {
  assertSmartFolderIdentifier(identifier);
  return withDecoded(
    parseWriterResult(
      readSmartFolderSchema,
      callPrivateWriter("read_smart_folder", { identifier }, deps),
      false
    )
  );
}

export interface CreateSmartFolderRequest {
  title: string;
  query: SmartFolderQueryInput;
  account?: string;
  parentIdentifier?: string;
  /** Folder preconditions on the smart folder's parent, checked just before the save. */
  scope?: ScopeGuard;
}

export function createSmartFolder(
  request: CreateSmartFolderRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
) {
  assertFolderTitle(request.title);
  const fields: Record<string, unknown> = {
    title: request.title,
    queryJSON: queryText(request.query, "query"),
  };
  if (request.account !== undefined && request.parentIdentifier !== undefined)
    throw invalid("Pass account or parentIdentifier, not both");
  if (request.account !== undefined) {
    if (!request.account.trim()) throw invalid("account must not be empty");
    fields.account = request.account;
  }
  if (request.parentIdentifier !== undefined) {
    assertFolderReference(request.parentIdentifier, "parentIdentifier");
    fields.parentIdentifier = request.parentIdentifier;
  }
  Object.assign(fields, writerScopeFields(request.scope));
  requireLiveValidated(SMART_FOLDERS_LIVE_VALIDATED, "native-create-smart-folder", deps.env);
  return withDecoded(
    parseWriterResult(
      createSmartFolderResultSchema,
      callPrivateWriter("create_smart_folder", fields, deps),
      true
    )
  );
}

export interface UpdateSmartFolderRequest {
  identifier: string;
  query: SmartFolderQueryInput;
  ifRevision: string;
  /** Folder preconditions on the smart folder's parent, checked just before the save. */
  scope?: ScopeGuard;
}

export function updateSmartFolder(
  request: UpdateSmartFolderRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
) {
  assertSmartFolderIdentifier(request.identifier);
  const text = queryText(request.query, "query");
  assertFolderRevision(request.ifRevision);
  requireLiveValidated(SMART_FOLDERS_LIVE_VALIDATED, "native-update-smart-folder", deps.env);
  return withDecoded(
    parseWriterResult(
      updateSmartFolderResultSchema,
      callPrivateWriter(
        "update_smart_folder",
        {
          identifier: request.identifier,
          queryJSON: text,
          ifRevision: request.ifRevision,
          ...writerScopeFields(request.scope),
        },
        deps
      ),
      true
    )
  );
}

export interface DeleteSmartFolderRequest {
  identifier: string;
  dryRun: boolean;
  ifRevision?: string;
  /** Folder preconditions on the smart folder's parent, checked just before the save. */
  scope?: ScopeGuard;
}

export function deleteSmartFolder(
  request: DeleteSmartFolderRequest,
  deps: PrivateHelperDeps = defaultWriterDeps()
): Record<string, unknown> {
  assertSmartFolderIdentifier(request.identifier);
  if (request.dryRun) {
    if (request.ifRevision !== undefined)
      throw invalid("ifRevision is only accepted with dryRun: false");
    return parseWriterResult(
      deleteSmartFolderPlanSchema,
      callPrivateWriter(
        "delete_smart_folder",
        { identifier: request.identifier, dryRun: true, ...writerScopeFields(request.scope) },
        deps,
        { dryRun: true }
      ),
      false
    );
  }
  assertFolderRevision(request.ifRevision);
  requireLiveValidated(SMART_FOLDERS_LIVE_VALIDATED, "native-delete-smart-folder", deps.env);
  return parseWriterResult(
    deleteSmartFolderResultSchema,
    callPrivateWriter(
      "delete_smart_folder",
      {
        identifier: request.identifier,
        dryRun: false,
        ifRevision: request.ifRevision,
        ...writerScopeFields(request.scope),
      },
      deps
    ),
    true
  );
}
