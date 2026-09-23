/**
 * Shared read-only NoteStore plumbing for the database-backed listing tools.
 *
 * Every call opens the live store with `sqlite3 -readonly` through
 * execFileSync and an argument array (no shell). SQL text is built only from
 * fixed fragments and column names confirmed by PRAGMA table_info. Values are
 * bound with the sqlite3 shell's `.parameter set`, and only in forms that
 * cannot carry SQL: a validated integer, an IEEE-754 double rebuilt from its
 * 16 hex digits, or a hex blob literal.
 *
 * Schema differences between macOS releases are handled by feature detection:
 * an optional column that is missing becomes SQL NULL (or a neutral default)
 * instead of an error.
 *
 * @module utils/noteStoreSql
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { escapeFolderName } from "@/services/appleNotesManager.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";

/** Default location of the live NoteStore database. */
export const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Core Data stores dates as seconds since 2001-01-01T00:00:00Z. */
export const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

export const STORE_FDA_MESSAGE =
  "Full Disk Access is required to read the Notes database. " +
  "In System Settings > Privacy & Security > Full Disk Access, grant access to the Node binary running this server " +
  "(required under Claude Desktop) or the terminal that launches it, then fully quit and " +
  `relaunch it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL} — run the doctor tool to verify.`;

/** Raised for conditions a tool reports verbatim. */
export class NoteStoreError extends Error {
  constructor(
    message: string,
    public readonly kind: "no_fda" | "schema" | "invalid_input" | "query_error"
  ) {
    super(message);
    this.name = "NoteStoreError";
  }
}

/** A value bound through `.parameter set`. Only forms that cannot carry SQL. */
export type BoundValue =
  { int: number } | { double: number } | { blob: Uint8Array } | { doubleBits: string };

/** Big-endian IEEE-754 bits of a finite double, as 16 lowercase hex digits. */
export function doubleToHex(value: number): string {
  if (!Number.isFinite(value)) throw new NoteStoreError("Not a finite number", "invalid_input");
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString("hex");
}

/** Inverse of {@link doubleToHex}; rejects anything but 16 hex digits of a finite double. */
export function hexToDouble(hex: string): number {
  if (!/^[0-9a-f]{16}$/i.test(hex))
    throw new NoteStoreError("Invalid double bits", "invalid_input");
  const value = Buffer.from(hex, "hex").readDoubleBE();
  if (!Number.isFinite(value)) throw new NoteStoreError("Invalid double bits", "invalid_input");
  return value;
}

/** Renders one bound value as a single `.parameter set` token. */
function renderValue(value: BoundValue): string {
  if ("int" in value) {
    if (!Number.isSafeInteger(value.int)) {
      throw new NoteStoreError("Bound integer out of range", "invalid_input");
    }
    return String(value.int);
  }
  if ("blob" in value) return `x'${Buffer.from(value.blob).toString("hex")}'`;
  // Re-encode from a parsed double so only canonical hex reaches sqlite3.
  const double = "double" in value ? value.double : hexToDouble(value.doubleBits);
  return `ieee754_from_blob(x'${doubleToHex(double)}')`;
}

/**
 * Runs one read-only sqlite3 invocation and returns stdout. Named parameters
 * are bound before the SQL runs; parameter names are fixed identifiers chosen
 * by the caller, never user input.
 */
export function runReadOnlySql(
  dbPath: string,
  sql: string,
  params: Record<string, BoundValue> = {}
): string {
  if (!fs.existsSync(dbPath)) throw new NoteStoreError(STORE_FDA_MESSAGE, "no_fda");
  const args = ["-readonly"];
  const names = Object.keys(params);
  if (names.length) args.push("-cmd", ".parameter init");
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]*$/i.test(name)) {
      throw new NoteStoreError(`Invalid parameter name ${name}`, "invalid_input");
    }
    args.push("-cmd", `.parameter set @${name} ${renderValue(params[name])}`);
  }
  args.push(dbPath, sql);
  try {
    return execFileSync("sqlite3", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message)) {
      throw new NoteStoreError(STORE_FDA_MESSAGE, "no_fda");
    }
    console.error(`Notes database query failed: ${message}`);
    throw new NoteStoreError("Failed to query the Notes database.", "query_error");
  }
}

/** Parses sqlite3 output made of one `json_object(...)` per line. */
export function parseJsonLines<T>(output: string): T[] {
  const rows: T[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new NoteStoreError("Unexpected Notes database response.", "query_error");
    }
  }
  return rows;
}

/** Column names present on ZICCLOUDSYNCINGOBJECT in this store. */
export function readColumns(dbPath: string): Set<string> {
  const out = runReadOnlySql(
    dbPath,
    "SELECT json_object('name', name) FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');"
  );
  return new Set(parseJsonLines<{ name: string }>(out).map((row) => row.name));
}

/** Throws a schema error naming any required column this store lacks. */
export function requireColumns(columns: ReadonlySet<string>, required: string[], tool: string) {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new NoteStoreError(
      `This macOS version's Notes database lacks columns ${tool} needs (${missing.join(", ")}).`,
      "schema"
    );
  }
}

/** `alias.column` when the column exists, else the fallback SQL expression. */
export function col(
  columns: ReadonlySet<string>,
  alias: string,
  name: string,
  fallback = "NULL"
): string {
  return columns.has(name) ? `${alias}.${name}` : fallback;
}

/** Subquery for an entity's Z_ENT, looked up rather than hard-coded. */
export function entity(
  name: "ICNote" | "ICFolder" | "ICAccount" | "ICHashtag" | "ICAttachment" | "ICInlineAttachment"
): string {
  return `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME='${name}')`;
}

/**
 * Account reference for a row. Each entity keeps its account in a different
 * numbered ZACCOUNTn column, and the numbering changes between releases, so
 * every present ZACCOUNT column is coalesced; callers join the result against
 * ICAccount rows, which discards a column that belongs to another relation.
 */
export function accountRef(columns: ReadonlySet<string>, alias: string): string {
  const refs = [...columns]
    .filter((name) => /^ZACCOUNT\d*$/.test(name))
    .sort()
    .map((name) => `${alias}.${name}`);
  if (!refs.length) return "NULL";
  return refs.length === 1 ? refs[0] : `COALESCE(${refs.join(", ")})`;
}

/**
 * Predicate: folder alias `f` is a Recently Deleted folder. ZFOLDERTYPE 1 marks
 * it where the column exists; the folder identifier prefix covers stores
 * without that column.
 */
export function trashFolderSql(columns: ReadonlySet<string>, f: string): string {
  const parts: string[] = [];
  if (columns.has("ZFOLDERTYPE")) parts.push(`COALESCE(${f}.ZFOLDERTYPE, 0) = 1`);
  if (columns.has("ZIDENTIFIER")) parts.push(`COALESCE(${f}.ZIDENTIFIER, '') LIKE 'TrashFolder%'`);
  return parts.length ? `(${parts.join(" OR ")})` : "0";
}

/** Predicate: row alias is not marked for deletion (a tombstone awaiting sync). */
export function notTombstonedSql(columns: ReadonlySet<string>, alias: string): string {
  return columns.has("ZMARKEDFORDELETION") ? `COALESCE(${alias}.ZMARKEDFORDELETION, 0) = 0` : "1";
}

/**
 * Predicate for a note Notes.app shows outside Recently Deleted: it has a
 * folder, that folder is not Recently Deleted, and neither the note nor the
 * folder is a tombstone. Folderless rows (common for abandoned Quick Note
 * drafts) are excluded because Notes.app never shows them.
 */
export function activeNoteSql(columns: ReadonlySet<string>, n: string, f: string): string {
  return [
    `${n}.ZFOLDER IS NOT NULL`,
    `${f}.Z_PK IS NOT NULL`,
    notTombstonedSql(columns, n),
    notTombstonedSql(columns, f),
    `NOT ${trashFolderSql(columns, f)}`,
  ].join(" AND ");
}

/** Converts a Core Data timestamp to ISO 8601, or null. */
export function coreDataToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const date = new Date(CORE_DATA_EPOCH_MS + seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The MCP note id for a primary key in a store. */
export function noteIdFor(storeUuid: string, pk: number): string {
  return `x-coredata://${storeUuid}/ICNote/p${pk}`;
}

/** One account row. */
export interface StoreAccount {
  pk: number;
  name: string;
  identifier: string | null;
}

/** One folder row. */
export interface StoreFolder {
  pk: number;
  name: string | null;
  identifier: string | null;
  parent: number | null;
  account: number | null;
  folderType: number | null;
  trash: number;
  tombstoned: number;
}

/** Store identity, accounts, and folders read in one transaction. */
export interface StoreContext {
  uuid: string;
  accounts: StoreAccount[];
  folders: StoreFolder[];
}

/** Reads the store UUID, accounts, and folders (including deleted ones). */
export function readStoreContext(dbPath: string, columns: ReadonlySet<string>): StoreContext {
  const sql = [
    "BEGIN;",
    "SELECT json_object('k', 'meta', 'uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1));",
    `SELECT json_object('k', 'account', 'pk', a.Z_PK, 'name', ${col(columns, "a", "ZNAME")}, ` +
      `'identifier', ${col(columns, "a", "ZIDENTIFIER")}) ` +
      `FROM ZICCLOUDSYNCINGOBJECT a WHERE a.Z_ENT = ${entity("ICAccount")} AND ${notTombstonedSql(columns, "a")};`,
    `SELECT json_object('k', 'folder', 'pk', f.Z_PK, 'name', ${col(columns, "f", "ZTITLE2")}, ` +
      `'identifier', ${col(columns, "f", "ZIDENTIFIER")}, 'parent', ${col(columns, "f", "ZPARENT")}, ` +
      `'account', ${col(columns, "f", "ZOWNER", accountRef(columns, "f"))}, ` +
      `'folderType', ${col(columns, "f", "ZFOLDERTYPE")}, 'trash', ${trashFolderSql(columns, "f")}, ` +
      `'tombstoned', NOT ${notTombstonedSql(columns, "f")}) ` +
      `FROM ZICCLOUDSYNCINGOBJECT f WHERE f.Z_ENT = ${entity("ICFolder")};`,
    "COMMIT;",
  ].join(" ");
  const rows = parseJsonLines<{ k: string } & Record<string, unknown>>(runReadOnlySql(dbPath, sql));
  const meta = rows.find((row) => row.k === "meta");
  if (typeof meta?.uuid !== "string" || !meta.uuid) {
    throw new NoteStoreError("The Notes database has no store identifier.", "schema");
  }
  return {
    uuid: meta.uuid,
    accounts: rows
      .filter((row) => row.k === "account")
      .map((row) => ({
        pk: row.pk as number,
        name: typeof row.name === "string" ? row.name : "",
        identifier: (row.identifier as string | null) ?? null,
      })),
    folders: rows
      .filter((row) => row.k === "folder")
      .map((row) => ({
        pk: row.pk as number,
        name: (row.name as string | null) ?? null,
        identifier: (row.identifier as string | null) ?? null,
        parent: (row.parent as number | null) ?? null,
        account: (row.account as number | null) ?? null,
        folderType: (row.folderType as number | null) ?? null,
        trash: row.trash ? 1 : 0,
        tombstoned: row.tombstoned ? 1 : 0,
      })),
  };
}

/**
 * Full folder paths in list-folders syntax: nested names joined by `/`, with a
 * literal `/` inside a name escaped as `\/` by the same escapeFolderName the
 * list-folders tool uses. Missing or cyclic parents end the
 * walk, so a damaged hierarchy still yields a path.
 */
export function folderPaths(folders: StoreFolder[]): Map<number, string> {
  const byPk = new Map(folders.map((folder) => [folder.pk, folder]));
  const paths = new Map<number, string>();
  for (const folder of folders) {
    const segments: string[] = [];
    const seen = new Set<number>();
    let current: StoreFolder | undefined = folder;
    while (current && !seen.has(current.pk)) {
      seen.add(current.pk);
      segments.unshift(escapeFolderName(current.name ?? ""));
      current = current.parent !== null ? byPk.get(current.parent) : undefined;
    }
    paths.set(folder.pk, segments.join("/"));
  }
  return paths;
}

/**
 * Resolves an account name the way the AppleScript tools do: an exact
 * (case-insensitive) name first, then a unique prefix.
 */
export function resolveAccountName(accounts: StoreAccount[], name: string): StoreAccount {
  const wanted = name.trim().toLocaleLowerCase();
  const exact = accounts.filter((account) => account.name.toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const prefix = accounts.filter((account) => account.name.toLocaleLowerCase().startsWith(wanted));
  if (exact.length === 0 && prefix.length === 1) return prefix[0];
  const names = accounts.map((account) => account.name).join(", ");
  throw new NoteStoreError(
    exact.length > 1 || prefix.length > 1
      ? `Account "${name}" is ambiguous. Accounts: ${names}.`
      : `No account named "${name}". Accounts: ${names}.`,
    "invalid_input"
  );
}
