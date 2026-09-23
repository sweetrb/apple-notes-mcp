/**
 * Read-only Smart Folder reader.
 *
 * A Smart Folder is an ICFolder row whose ZSMARTFOLDERQUERYJSON column holds the
 * folder's stored query, for example:
 *
 * ```text
 * {"entity":"note","type":{"and":[{"deleted":false},{"or":[<clauses>]}]}}
 * ```
 *
 * The outer `and` with `{"deleted":false}` is a wrapper Notes adds to keep
 * Recently Deleted out of the results. The clause after it carries the folder's
 * visible rules: `and` is "match all", `or` is "match any". This module strips
 * the wrapper and decodes the clauses into a readable `match` plus `filters`
 * form, while also returning the stored JSON verbatim.
 *
 * Safety: the database is opened READ-ONLY (`sqlite3 -readonly`, argument array,
 * no shell) and the SQL contains no caller input at all.
 *
 * @module utils/smartFolders
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SmartFolder, SmartFolderFilter, SmartFolderMatch } from "@/types.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

const FDA_MESSAGE =
  "Full Disk Access is required to read smart folders. " +
  "In System Settings > Privacy & Security > Full Disk Access, grant access to the app " +
  "that launches this server (Claude Desktop / Terminal / iTerm2), then fully quit and " +
  `relaunch it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL} — run the doctor tool to verify.`;

/** Seconds between the Unix epoch and the Cocoa reference date (2001-01-01). */
const COCOA_EPOCH_OFFSET = 978307200;
const MAX_DEPTH = 32;

/** Built-in relative date ranges (`type` 0-5); 6 is a custom amount and unit. */
const RELATIVE_RANGES: Record<number, string> = {
  0: "today",
  1: "yesterday",
  2: "in the last 7 days",
  3: "in the last 30 days",
  4: "in the last 3 months",
  5: "in the last 12 months",
};
const CUSTOM_UNITS: Record<number, string> = {
  0: "hours",
  1: "days",
  2: "weeks",
  3: "months",
  4: "years",
};
/** Attachment categories Notes offers in the Smart Folder editor. */
const ATTACHMENT_SECTIONS: Record<number, string> = {
  1: "Photos & Videos",
  2: "Drawings",
  3: "Maps",
  4: "Websites",
  5: "Audio",
  6: "Documents",
  7: "Scans",
};

/** Lookups used to make folder and tag references readable. */
export interface SmartQueryContext {
  /** Folder identifier (ZIDENTIFIER) → CoreData id and title */
  folders?: Record<string, { id: string; title: string | null }>;
  /** Standardized tag content → display names seen in the library */
  tags?: Record<string, string[]>;
}

/** Decoded form of one stored smart folder query. */
export interface DecodedSmartQuery {
  /** How the top-level filters combine; null when the query is absent or unreadable */
  match: SmartFolderMatch | null;
  filters: SmartFolderFilter[];
  /** The stored query with the outer `deleted` wrapper removed */
  query: unknown;
  /** From the outer wrapper: false = Recently Deleted excluded, true = included */
  includesRecentlyDeleted?: boolean;
  /** False when any clause was not recognized (it is kept as an `unknown` filter) */
  fullyDecoded: boolean;
}

type Clause = Record<string, unknown>;
const isClause = (value: unknown): value is Clause =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isDeletedWrapper = (value: unknown): boolean =>
  isClause(value) && Object.keys(value).length === 1 && typeof value.deleted === "boolean";

function cocoaDate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date((value + COCOA_EPOCH_OFFSET) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class Decoder {
  fullyDecoded = true;
  constructor(private readonly context: SmartQueryContext) {}

  unknown(key: string | null, value: unknown, excluded: boolean): SmartFolderFilter {
    this.fullyDecoded = false;
    return {
      type: "unknown",
      ...(key === null ? {} : { key }),
      value,
      ...(excluded ? { excluded: true } : {}),
      description: "Unrecognized clause (see value)",
    };
  }

  /** Decode a list of sibling clauses, dropping inner `deleted` wrappers. */
  list(clauses: unknown, excluded: boolean, depth: number): SmartFolderFilter[] {
    if (!Array.isArray(clauses)) return [this.clause(clauses, excluded, depth)];
    return clauses
      .filter((clause) => !isDeletedWrapper(clause))
      .map((clause) => this.clause(clause, excluded, depth));
  }

  group(
    match: "all" | "any",
    clauses: unknown,
    excluded: boolean,
    depth: number
  ): SmartFolderFilter {
    const items = Array.isArray(clauses)
      ? clauses.filter((clause) => !isDeletedWrapper(clause))
      : [clauses];
    // A one-item group means the same as its item.
    if (items.length === 1) return this.clause(items[0], excluded, depth + 1);
    const filters = this.list(items, false, depth + 1);
    const joiner = match === "all" ? "all of" : "any of";
    return {
      type: "group",
      match,
      ...(excluded ? { excluded: true } : {}),
      filters,
      description: `${excluded ? "not " : ""}${joiner}: ${filters.map((f) => f.description).join("; ")}`,
    };
  }

  /** Mark a positively described leaf as an Exclude rule. */
  negate(filter: SmartFolderFilter): SmartFolderFilter {
    const text = filter.description;
    const negated = text.startsWith("has ")
      ? text.replace(/^has /, "does not have ")
      : text.startsWith("is ")
        ? text.replace(/^is /, "is not ")
        : text.startsWith("mentions ")
          ? text.replace(/^mentions /, "does not mention ")
          : `not ${text}`;
    return { ...filter, excluded: true, description: negated };
  }

  clause(clause: unknown, excluded: boolean, depth: number): SmartFolderFilter {
    if (depth > MAX_DEPTH || !isClause(clause)) return this.unknown(null, clause, excluded);
    const keys = Object.keys(clause);
    if (keys.length !== 1) {
      // Several keys in one object: every key must hold.
      return this.group(
        "all",
        keys.map((key) => ({ [key]: clause[key] })),
        excluded,
        depth
      );
    }
    const [key] = keys;
    const value = clause[key];
    if (key === "and" || key === "or") {
      if (!Array.isArray(value)) return this.unknown(key, value, excluded);
      return this.group(key === "and" ? "all" : "any", value, excluded, depth);
    }
    if (key === "not") return this.clause(value, !excluded, depth + 1);
    const leaf = this.leaf(key, value, excluded);
    if (!leaf) return this.unknown(key, value, excluded);
    return excluded && !leaf.excluded ? this.negate(leaf) : leaf;
  }

  /**
   * Decode one leaf clause. Boolean flags describe their own negation (an
   * excluded `pinned: true` reads "is not pinned"); other leaves are described
   * positively and negated by the caller.
   */
  leaf(key: string, value: unknown, excluded: boolean): SmartFolderFilter | null {
    const flag = (description: string, negative: string): SmartFolderFilter | null =>
      typeof value === "boolean"
        ? {
            type: key,
            value,
            ...(excluded ? { excluded: true } : {}),
            description: value !== excluded ? description : negative,
          }
        : null;
    switch (key) {
      case "checklist":
        return flag("has a checklist", "has no checklist");
      case "checklistInProgress":
        return flag("has an unfinished checklist", "has no unfinished checklist");
      case "checklistCompleted":
        return flag("has a completed checklist", "has no completed checklist");
      case "attachment":
        return flag("has attachments", "has no attachments");
      case "pinned":
        return flag("is pinned", "is not pinned");
      case "systemPaper":
        return flag("is a Quick Note", "is not a Quick Note");
      case "passwordProtected":
        return flag("is locked", "is not locked");
      case "shared":
        return flag("is shared", "is not shared");
      case "mention":
        return flag("mentions anyone", "mentions no one");
      case "tagged":
        return flag("has any tag", "has no tags");
      case "attachmentSection": {
        if (typeof value !== "number" || !ATTACHMENT_SECTIONS[value]) return null;
        return {
          type: key,
          value,
          name: ATTACHMENT_SECTIONS[value],
          description: `has ${ATTACHMENT_SECTIONS[value]} attachments`,
        };
      }
      case "tag": {
        if (typeof value !== "string") return null;
        const names = this.context.tags?.[value] ?? [];
        const name = names.length === 1 ? names[0] : undefined;
        return {
          type: key,
          value,
          ...(name ? { name } : {}),
          description: `has tag #${name ?? value}`,
        };
      }
      case "folder": {
        if (typeof value !== "string") return null;
        const folder = this.context.folders?.[value];
        return {
          type: key,
          value,
          ...(folder ? { folderId: folder.id } : {}),
          ...(folder?.title ? { name: folder.title } : {}),
          description: folder?.title
            ? `is in folder "${folder.title}"`
            : `is in folder ${value}${folder ? "" : " (not found)"}`,
        };
      }
      case "sharedParticipant":
      case "mentionParticipant":
        return typeof value === "string"
          ? {
              type: key,
              value,
              description:
                key === "sharedParticipant"
                  ? `is shared with participant ${value}`
                  : `mentions participant ${value}`,
            }
          : null;
      case "creationDateRelativeRange":
      case "modificationDateRelativeRange": {
        if (!isClause(value) || typeof value.type !== "number") return null;
        const verb = key.startsWith("creation") ? "created" : "edited";
        if (value.type === 6) {
          const amount = value.customAmount;
          const unit = typeof value.customUnit === "number" ? CUSTOM_UNITS[value.customUnit] : null;
          if (typeof amount !== "number" || !unit) return null;
          return {
            type: key,
            value,
            description: `${verb} in the last ${amount} ${unit}`,
          };
        }
        const range = RELATIVE_RANGES[value.type];
        return range ? { type: key, value, description: `${verb} ${range}` } : null;
      }
      case "creationDateRange":
      case "modificationDateRange": {
        if (!isClause(value)) return null;
        const from = cocoaDate(value.fromDate);
        const to = cocoaDate(value.toDate);
        if (!from || !to) return null;
        const verb = key.startsWith("creation") ? "created" : "edited";
        return {
          type: key,
          value,
          from,
          to,
          description: `${verb} between ${from} and ${to}`,
        };
      }
      default:
        return null;
    }
  }
}

/**
 * Decode one stored smart folder query into `match` and `filters`.
 *
 * Unknown clauses are kept verbatim as `{type: "unknown"}` filters and make
 * `fullyDecoded` false; nothing is dropped or reinterpreted.
 */
export function decodeSmartFolderQuery(
  raw: string | null,
  context: SmartQueryContext = {}
): DecodedSmartQuery {
  if (raw === null || raw.trim() === "") {
    return { match: null, filters: [], query: null, fullyDecoded: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { match: null, filters: [], query: raw, fullyDecoded: false };
  }
  const decoder = new Decoder(context);
  const type = isClause(parsed) ? parsed.type : undefined;
  if (!isClause(type)) {
    return {
      match: null,
      filters: [decoder.unknown(null, parsed, false)],
      query: parsed,
      fullyDecoded: false,
    };
  }

  // Strip the outer wrapper: {"and": [{"deleted": <bool>}, <clause>, ...]}.
  let includesRecentlyDeleted: boolean | undefined;
  let inner: unknown[] = [type];
  if (Object.keys(type).length === 1 && Array.isArray(type.and)) {
    const wrapper = type.and.find(isDeletedWrapper) as Clause | undefined;
    if (wrapper) {
      includesRecentlyDeleted = wrapper.deleted as boolean;
      inner = type.and.filter((clause) => !isDeletedWrapper(clause));
    }
  }
  const query = inner.length === 1 ? inner[0] : { and: inner };

  let match: SmartFolderMatch = "all";
  let filters: SmartFolderFilter[];
  const only = inner.length === 1 && isClause(inner[0]) ? inner[0] : undefined;
  const onlyKey = only && Object.keys(only).length === 1 ? Object.keys(only)[0] : undefined;
  if (only && onlyKey === "and" && Array.isArray(only.and)) {
    filters = decoder.list(only.and, false, 1);
  } else if (only && onlyKey === "or" && Array.isArray(only.or)) {
    match = "any";
    filters = decoder.list(only.or, false, 1);
  } else if (
    only &&
    onlyKey === "not" &&
    isClause(only.not) &&
    Object.keys(only.not).length === 1 &&
    Array.isArray(only.not.or)
  ) {
    match = "none";
    filters = decoder.list(only.not.or, false, 1);
  } else {
    filters = decoder.list(inner, false, 1);
  }
  return {
    match,
    filters,
    query,
    ...(includesRecentlyDeleted === undefined ? {} : { includesRecentlyDeleted }),
    fullyDecoded: decoder.fullyDecoded,
  };
}

/**
 * One read-only transaction. No caller input reaches this SQL. Entity numbers
 * are looked up by name in Z_PRIMARYKEY rather than assumed.
 */
export const SMART_FOLDERS_SQL = `BEGIN;
SELECT Z_UUID FROM Z_METADATA;
SELECT json_group_array(json_object(
  'pk', f.Z_PK,
  'identifier', f.ZIDENTIFIER,
  'title', f.ZTITLE2,
  'folderType', f.ZFOLDERTYPE,
  'query', f.ZSMARTFOLDERQUERYJSON,
  'parentPk', p.Z_PK,
  'parentIdentifier', p.ZIDENTIFIER,
  'parentTitle', p.ZTITLE2,
  'accountPk', a.Z_PK,
  'accountIdentifier', a.ZIDENTIFIER,
  'accountName', a.ZNAME))
FROM ZICCLOUDSYNCINGOBJECT f
LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = f.ZPARENT
LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = f.ZOWNER
WHERE f.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICFolder')
  AND (f.ZFOLDERTYPE = 2 OR f.ZSMARTFOLDERQUERYJSON IS NOT NULL)
  AND COALESCE(f.ZMARKEDFORDELETION, 0) = 0;
SELECT json_group_object(ZIDENTIFIER, json_object('pk', Z_PK, 'title', ZTITLE2))
FROM ZICCLOUDSYNCINGOBJECT
WHERE Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICFolder')
  AND ZIDENTIFIER IS NOT NULL;
SELECT json_group_array(json_object('standardized', ZSTANDARDIZEDCONTENT, 'display', ZDISPLAYTEXT))
FROM ZICCLOUDSYNCINGOBJECT
WHERE Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICHashtag')
  AND ZSTANDARDIZEDCONTENT IS NOT NULL
  AND COALESCE(ZMARKEDFORDELETION, 0) = 0;
COMMIT;`;

/** Columns the SQL above needs; checked first so an old schema fails clearly. */
export const REQUIRED_COLUMNS = [
  "ZIDENTIFIER",
  "ZTITLE2",
  "ZFOLDERTYPE",
  "ZSMARTFOLDERQUERYJSON",
  "ZPARENT",
  "ZOWNER",
  "ZNAME",
  "ZMARKEDFORDELETION",
  "ZSTANDARDIZEDCONTENT",
  "ZDISPLAYTEXT",
];

interface SmartFolderRow {
  pk: number;
  identifier: string | null;
  title: string | null;
  folderType: number | null;
  query: string | null;
  parentPk: number | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  accountPk: number | null;
  accountIdentifier: string | null;
  accountName: string | null;
}

/**
 * Turn the four result sets of {@link SMART_FOLDERS_SQL} into smart folders.
 * Exported so tests can run the real SQL against a fixture database.
 */
export function buildSmartFolders(output: string): SmartFolder[] {
  const lines = output.trim().split("\n");
  if (lines.length < 4) throw new Error("Unexpected smart folder query output");
  const [storeUuid, rowsJson, foldersJson, tagsJson] = lines;
  if (!/^[0-9A-F-]+$/i.test(storeUuid)) throw new Error("Unexpected Notes store identifier");
  const coreDataId = (entity: string, pk: number) => `x-coredata://${storeUuid}/${entity}/p${pk}`;

  const rows = JSON.parse(rowsJson) as SmartFolderRow[];
  const folderRows = JSON.parse(foldersJson || "{}") as Record<
    string,
    { pk: number; title: string | null }
  >;
  const tagRows = JSON.parse(tagsJson || "[]") as Array<{
    standardized: string;
    display: string | null;
  }>;

  const folders: SmartQueryContext["folders"] = {};
  for (const [identifier, row] of Object.entries(folderRows)) {
    folders[identifier] = { id: coreDataId("ICFolder", row.pk), title: row.title };
  }
  const tags: Record<string, string[]> = {};
  for (const tag of tagRows) {
    if (!tag.display) continue;
    const names = (tags[tag.standardized] ||= []);
    if (!names.includes(tag.display)) names.push(tag.display);
  }

  return rows
    .map((row): SmartFolder => {
      const decoded = decodeSmartFolderQuery(row.query, { folders, tags });
      return {
        id: coreDataId("ICFolder", row.pk),
        identifier: row.identifier,
        name: row.title,
        account: row.accountName,
        accountId: row.accountPk === null ? null : coreDataId("ICAccount", row.accountPk),
        accountIdentifier: row.accountIdentifier,
        parent: row.parentTitle,
        parentId: row.parentPk === null ? null : coreDataId("ICFolder", row.parentPk),
        parentIdentifier: row.parentIdentifier,
        match: decoded.match,
        filters: decoded.filters,
        ...(decoded.includesRecentlyDeleted === undefined
          ? {}
          : { includesRecentlyDeleted: decoded.includesRecentlyDeleted }),
        fullyDecoded: decoded.fullyDecoded,
        query: decoded.query,
        rawQuery: row.query,
      };
    })
    .sort(
      (a, b) =>
        (a.account ?? "").localeCompare(b.account ?? "") ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id)
    );
}

/** Result of {@link readSmartFolders}, with error classification. */
export interface SmartFoldersResult {
  folders: SmartFolder[] | null;
  error?: "no_fda" | "unsupported_schema" | "query_error";
  message?: string;
}

function runSqlite(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-readonly", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Read every smart folder from the NoteStore database, read-only.
 *
 * @param dbPath - Database to read (defaults to the live NoteStore; tests pass a fixture)
 */
export function readSmartFolders(dbPath: string = NOTES_DB_PATH): SmartFoldersResult {
  if (!fs.existsSync(dbPath)) return { folders: null, error: "no_fda", message: FDA_MESSAGE };
  try {
    const columns = new Set(
      runSqlite(dbPath, "SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');")
        .trim()
        .split("\n")
    );
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length) {
      return {
        folders: null,
        error: "unsupported_schema",
        message: `This Notes database does not have the columns smart folders need (${missing.join(", ")}).`,
      };
    }
    return { folders: buildSmartFolders(runSqlite(dbPath, SMART_FOLDERS_SQL)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("authorization denied") || message.includes("unable to open database")) {
      return { folders: null, error: "no_fda", message: FDA_MESSAGE };
    }
    console.error(`Failed to read smart folders: ${message}`);
    return { folders: null, error: "query_error", message: "Failed to read smart folders." };
  }
}
