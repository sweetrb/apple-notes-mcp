/**
 * Note and Folder Identifier Bridge
 *
 * Every tool in this server addresses a note by its AppleScript id, a Core Data
 * URL such as `x-coredata://<store-uuid>/ICNote/p<N>`. Two other identifiers
 * name the same object and live in the same ZICCLOUDSYNCINGOBJECT row:
 *
 * - the Notes UUID (ZIDENTIFIER), which is stable across devices and is what
 *   `notes://showNote?identifier=` links use;
 * - the numeric Core Data key N (Z_PK), the digits after `p` in the URL.
 *
 * This module turns either form back into the canonical x-coredata id before a
 * tool handler runs, so every downstream code path keeps receiving exactly the
 * id it received before. It also reads the stable identifiers of objects the
 * server already listed, in one batched query, so list and read tools can
 * return them.
 *
 * Safety:
 * - The database is opened READ-ONLY (`sqlite3 -readonly`) through
 *   execFileSync with an argument array (no shell), as in noteMetadata.ts.
 * - Only values that match the strict UUID (hex and dashes) or numeric-key
 *   (digits) patterns reach a query, and the SQL builders re-check those
 *   patterns, so no other character can be placed in the SQL text.
 * - A numeric key or UUID resolves only to a row of the requested entity
 *   (looked up by name in Z_PRIMARYKEY), never to an attachment or another
 *   object type that shares the table.
 * - x-coredata ids never touch the database, so they keep working exactly as
 *   before when Full Disk Access is missing.
 *
 * @module utils/noteIdentifiers
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";

/** Live NoteStore location. Tests pass a fixture path instead. */
export const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** A Notes UUID: 36 characters, hex digits in 8-4-4-4-12 groups. */
export const UUID_PATTERN = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

/** A numeric Core Data key: digits only, short enough to stay a 64-bit integer. */
export const NUMERIC_KEY_PATTERN = /^\d{1,18}$/;

/** Validation message for a strict note id input. */
export const NOTE_ID_MESSAGE =
  "A canonical Apple Note ID is required (x-coredata://.../ICNote/p...), or the note's Notes UUID or numeric key";

/** Core Data entity names this bridge resolves. */
export type IdentifierEntity = "ICNote" | "ICFolder" | "ICAccount";

/** Which of the accepted id forms a value is. */
export type IdentifierForm = "uuid" | "key" | "other";

/** Classifies a value as a Notes UUID, a numeric key, or anything else. */
export function identifierForm(value: string): IdentifierForm {
  if (UUID_PATTERN.test(value)) return "uuid";
  if (NUMERIC_KEY_PATTERN.test(value)) return "key";
  return "other";
}

/** True when a value is a Notes UUID or numeric key that needs resolving. */
export function isAlternateIdentifier(value: string): boolean {
  return identifierForm(value) !== "other";
}

/** Why an identifier could not be resolved. */
export type IdentifierErrorCode = "no_fda" | "not_found" | "query_error";

/** Raised when a Notes UUID or numeric key cannot be turned into an x-coredata id. */
export class IdentifierResolutionError extends Error {
  constructor(
    public readonly code: IdentifierErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IdentifierResolutionError";
  }
}

const ENTITY_LABEL: Record<IdentifierEntity, string> = {
  ICNote: "note",
  ICFolder: "folder",
  ICAccount: "account",
};

const NO_FDA_MESSAGE =
  "Resolving a Notes UUID or numeric key reads the Notes database, which needs Full Disk Access " +
  "for the app that launches this server (System Settings > Privacy & Security > Full Disk Access, " +
  "then fully quit and relaunch it). x-coredata ids from search-notes, list-notes, or list-folders " +
  `work without it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`;

/** Normalizes a numeric key to canonical digits (no leading zeros). */
function canonicalKey(value: string): string {
  return BigInt(value).toString();
}

/** Asserts that every value matches a pattern before it enters SQL text. */
function assertAll(values: string[], pattern: RegExp, label: string): void {
  for (const value of values) {
    if (!pattern.test(value)) throw new Error(`Refusing to query with an invalid ${label}`);
  }
}

function entityClause(entity: IdentifierEntity): string {
  // The entity name is a fixed literal from IdentifierEntity, never user input.
  return `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = '${entity}')`;
}

/**
 * Builds the resolution query for numeric keys and UUIDs of one entity.
 *
 * The result is a single JSON line: `{"store": <Z_METADATA.Z_UUID>, "rows":
 * [{"pk": N, "identifier": "..."}]}`. UUIDs are matched in their given,
 * upper, and lower case because Notes stores most identifiers upper-case but
 * some lower-case; an IN list keeps the unique ZIDENTIFIER index usable.
 */
export function buildResolveSql(entity: IdentifierEntity, keys: string[], uuids: string[]): string {
  assertAll(keys, NUMERIC_KEY_PATTERN, "numeric key");
  assertAll(uuids, UUID_PATTERN, "UUID");
  const matches: string[] = [];
  if (keys.length > 0) {
    matches.push(`o.Z_PK IN (${[...new Set(keys.map(canonicalKey))].join(", ")})`);
  }
  if (uuids.length > 0) {
    const variants = new Set<string>();
    for (const uuid of uuids) {
      variants.add(uuid);
      variants.add(uuid.toUpperCase());
      variants.add(uuid.toLowerCase());
    }
    matches.push(`o.ZIDENTIFIER IN (${[...variants].map((v) => `'${v}'`).join(", ")})`);
  }
  const where = matches.length > 0 ? matches.join(" OR ") : "0";
  return (
    "SELECT json_object(" +
    "'store', (SELECT Z_UUID FROM Z_METADATA LIMIT 1), " +
    "'rows', (SELECT json_group_array(json_object('pk', o.Z_PK, 'identifier', o.ZIDENTIFIER)) " +
    "FROM ZICCLOUDSYNCINGOBJECT o " +
    `WHERE o.Z_ENT = ${entityClause(entity)} AND (${where})));`
  );
}

/**
 * Builds the batched stable-identifier lookup for objects of one entity, by
 * primary key. Notes report their folder and that folder's account; folders
 * report their parent folder and account; accounts report only themselves.
 */
export function buildLookupSql(entity: IdentifierEntity, keys: string[]): string {
  assertAll(keys, NUMERIC_KEY_PATTERN, "numeric key");
  const pks = [...new Set(keys.map(canonicalKey))];
  const inList = pks.length > 0 ? pks.join(", ") : "NULL";
  let fields = "'pk', o.Z_PK, 'identifier', o.ZIDENTIFIER";
  let joins = "";
  if (entity === "ICNote") {
    fields += ", 'folderIdentifier', f.ZIDENTIFIER, 'accountIdentifier', a.ZIDENTIFIER";
    joins =
      "LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = o.ZFOLDER " +
      "LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = f.ZOWNER ";
  } else if (entity === "ICFolder") {
    fields += ", 'parentIdentifier', p.ZIDENTIFIER, 'accountIdentifier', a.ZIDENTIFIER";
    joins =
      "LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = o.ZPARENT " +
      "LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = o.ZOWNER ";
  }
  return (
    "SELECT json_object(" +
    "'store', (SELECT Z_UUID FROM Z_METADATA LIMIT 1), " +
    `'rows', (SELECT json_group_array(json_object(${fields})) ` +
    `FROM ZICCLOUDSYNCINGOBJECT o ${joins}` +
    `WHERE o.Z_ENT = ${entityClause(entity)} AND o.Z_PK IN (${inList})));`
  );
}

interface QueryResult<Row> {
  store: string | null;
  rows: Row[];
}

/** Runs one read-only query and parses its single JSON line. */
function runJsonQuery<Row>(sql: string, dbPath: string): QueryResult<Row> {
  if (!fs.existsSync(dbPath)) throw new IdentifierResolutionError("no_fda", NO_FDA_MESSAGE);
  let out: string;
  try {
    out = execFileSync("sqlite3", ["-readonly", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? "")}`
        : String(error);
    if (detail.includes("authorization denied") || detail.includes("unable to open database")) {
      throw new IdentifierResolutionError("no_fda", NO_FDA_MESSAGE);
    }
    console.error(`Identifier query failed: ${detail}`);
    throw new IdentifierResolutionError("query_error", "Failed to read the Notes database.");
  }
  const parsed = JSON.parse(out || "{}") as { store?: string | null; rows?: Row[] | string };
  const rows = typeof parsed.rows === "string" ? (JSON.parse(parsed.rows) as Row[]) : parsed.rows;
  return { store: parsed.store ?? null, rows: rows ?? [] };
}

/** Builds the canonical AppleScript id for a row. */
export function coreDataId(store: string, entity: IdentifierEntity, pk: number | string): string {
  return `x-coredata://${store}/${entity}/p${pk}`;
}

/**
 * Resolves Notes UUIDs and numeric keys of one entity to x-coredata ids in a
 * single read-only query. Values in any other form are returned unchanged and
 * never reach the database.
 *
 * @returns a map from each input value to its x-coredata id
 * @throws IdentifierResolutionError when the database is unreadable or any
 *   UUID or key names no object of that entity
 */
export function resolveIdentifiers(
  values: string[],
  entity: IdentifierEntity,
  dbPath: string = NOTES_DB_PATH
): Map<string, string> {
  const resolved = new Map<string, string>();
  const keys: string[] = [];
  const uuids: string[] = [];
  for (const value of values) {
    const form = identifierForm(value);
    if (form === "key") keys.push(value);
    else if (form === "uuid") uuids.push(value);
    else resolved.set(value, value);
  }
  if (keys.length === 0 && uuids.length === 0) return resolved;

  const { store, rows } = runJsonQuery<{ pk: number; identifier: string | null }>(
    buildResolveSql(entity, keys, uuids),
    dbPath
  );
  if (!store) {
    throw new IdentifierResolutionError(
      "query_error",
      "The Notes database has no store UUID, so an x-coredata id cannot be built."
    );
  }
  const byKey = new Map(rows.map((row) => [String(row.pk), row]));
  const byUuid = new Map(
    rows.filter((row) => row.identifier).map((row) => [String(row.identifier).toUpperCase(), row])
  );

  const label = ENTITY_LABEL[entity];
  const missing: string[] = [];
  for (const key of keys) {
    const row = byKey.get(canonicalKey(key));
    if (row) resolved.set(key, coreDataId(store, entity, row.pk));
    else missing.push(`numeric key ${key}`);
  }
  for (const uuid of uuids) {
    const row = byUuid.get(uuid.toUpperCase());
    if (row) resolved.set(uuid, coreDataId(store, entity, row.pk));
    else missing.push(`identifier ${uuid}`);
  }
  if (missing.length > 0) {
    throw new IdentifierResolutionError(
      "not_found",
      `No ${label} found for ${missing.join(", ")}. A numeric key must belong to a ${label}, not another object type.`
    );
  }
  return resolved;
}

/** Stable identifiers for one object. Absent fields could not be read. */
export interface StableIdentifiers {
  /** The object's own Notes UUID (ZIDENTIFIER). */
  identifier?: string;
  /** For a note: its folder's Notes UUID. */
  folderIdentifier?: string;
  /** For a folder: its parent folder's Notes UUID (absent at the top level). */
  parentIdentifier?: string;
  /** For a note or folder: its account's Notes UUID. */
  accountIdentifier?: string;
}

const COREDATA_PARTS = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/(ICNote|ICFolder|ICAccount)\/p(\d{1,18})$/;

/**
 * Reads stable identifiers for already-known x-coredata ids of one entity in a
 * single read-only query. Best effort: returns an empty map when Full Disk
 * Access is missing or the query fails, so list and read tools keep working
 * without the extra fields. Ids from a different store or entity are skipped.
 */
export function lookupStableIdentifiers(
  ids: string[],
  entity: IdentifierEntity,
  dbPath: string = NOTES_DB_PATH
): Map<string, StableIdentifiers> {
  const result = new Map<string, StableIdentifiers>();
  const wanted = new Map<string, { id: string; store: string }[]>();
  for (const id of ids) {
    const match = COREDATA_PARTS.exec(id);
    if (!match || match[2] !== entity) continue;
    const pk = canonicalKey(match[3]);
    const list = wanted.get(pk) ?? [];
    list.push({ id, store: match[1] });
    wanted.set(pk, list);
  }
  if (wanted.size === 0) return result;

  let query: QueryResult<Record<string, string | number | null>>;
  try {
    query = runJsonQuery(buildLookupSql(entity, [...wanted.keys()]), dbPath);
  } catch {
    return result;
  }
  const store = query.store?.toUpperCase();
  for (const row of query.rows) {
    const fields: StableIdentifiers = {};
    for (const key of [
      "identifier",
      "folderIdentifier",
      "parentIdentifier",
      "accountIdentifier",
    ] as const) {
      const value = row[key];
      if (typeof value === "string" && value) fields[key] = value;
    }
    for (const target of wanted.get(String(row.pk)) ?? []) {
      if (target.store.toUpperCase() === store) result.set(target.id, fields);
    }
  }
  return result;
}

/**
 * Adds stable identifier fields to each item that carries an x-coredata `id`,
 * using one batched lookup. Items without a match are returned unchanged.
 */
export function withStableIdentifiers<T extends { id?: string }>(
  items: T[],
  entity: IdentifierEntity,
  dbPath: string = NOTES_DB_PATH
): Array<T & StableIdentifiers> {
  const ids = items.map((item) => item.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return items;
  const found = lookupStableIdentifiers(ids, entity, dbPath);
  if (found.size === 0) return items;
  return items.map((item) =>
    item.id && found.has(item.id) ? { ...item, ...found.get(item.id) } : item
  );
}

// =============================================================================
// Input schemas
// =============================================================================

/** Resolver signature, injectable for tests. */
export type IdentifierResolver = (
  values: string[],
  entity: IdentifierEntity
) => Map<string, string>;

const defaultResolver: IdentifierResolver = (values, entity) => resolveIdentifiers(values, entity);

/** Upper bound on an id string, matching the server's MAX.ID input bound. */
const DEFAULT_MAX_ID_LENGTH = 2000;

/** Options for the strict id schemas. */
export interface ExactIdOptions {
  /** Maximum id length (default 2000). */
  maxLength?: number;
  /** Resolver override, for tests. */
  resolver?: IdentifierResolver;
}

/** Joins an existing anchored id pattern with the UUID and numeric-key forms. */
function acceptAlternateForms(pattern: RegExp): RegExp {
  return new RegExp(
    `${pattern.source}|${UUID_PATTERN.source}|${NUMERIC_KEY_PATTERN.source}`,
    pattern.flags
  );
}

/** Resolves values inside a zod transform, turning failures into input issues. */
function resolveInSchema(
  values: string[],
  entity: IdentifierEntity,
  ctx: z.RefinementCtx,
  resolver: IdentifierResolver
): Map<string, string> | null {
  if (!values.some(isAlternateIdentifier)) return new Map(values.map((v) => [v, v]));
  try {
    return resolver(values, entity);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * A strict id input: accepts whatever `pattern` accepted before, plus a Notes
 * UUID or numeric key of `entity`, and hands the handler the x-coredata id.
 */
export function exactIdInput(
  entity: IdentifierEntity,
  pattern: RegExp,
  message: string,
  options: ExactIdOptions = {}
) {
  const resolver = options.resolver ?? defaultResolver;
  return z
    .string()
    .max(options.maxLength ?? DEFAULT_MAX_ID_LENGTH)
    .regex(acceptAlternateForms(pattern), message)
    .transform((value, ctx) => {
      const map = resolveInSchema([value], entity, ctx, resolver);
      return map ? (map.get(value) ?? value) : z.NEVER;
    });
}

/**
 * An array of strict ids resolved in one batched query, so a 500-id batch
 * costs one database read rather than 500.
 */
export function exactIdArrayInput(
  entity: IdentifierEntity,
  pattern: RegExp,
  message: string,
  options: ExactIdOptions & { maxItems?: number } = {}
) {
  const resolver = options.resolver ?? defaultResolver;
  const item = z
    .string()
    .max(options.maxLength ?? DEFAULT_MAX_ID_LENGTH)
    .regex(acceptAlternateForms(pattern), message);
  const array =
    options.maxItems === undefined ? z.array(item) : z.array(item).max(options.maxItems);
  return array.transform((values, ctx) => {
    const map = resolveInSchema(values, entity, ctx, resolver);
    return map ? values.map((value) => map.get(value) ?? value) : z.NEVER;
  });
}

/**
 * A free-form id input (no pattern today): a Notes UUID or numeric key is
 * resolved to the x-coredata id; every other value passes through unchanged,
 * exactly as before.
 */
export function looseIdTransform(
  entity: IdentifierEntity,
  resolver: IdentifierResolver = defaultResolver
) {
  return (value: string, ctx: z.RefinementCtx): string => {
    if (!isAlternateIdentifier(value)) return value;
    const map = resolveInSchema([value], entity, ctx, resolver);
    return map ? (map.get(value) ?? value) : z.NEVER;
  };
}
