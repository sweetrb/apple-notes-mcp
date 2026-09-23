/**
 * Test support: builds a small synthetic NoteStore-shaped SQLite database with
 * the real `sqlite3` binary, so the production SQL runs unmodified against it.
 * Only the tables and columns the read-only queries touch are created. All
 * rows are synthetic.
 *
 * @module utils/noteStoreFixture
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureRow {
  pk: number;
  ent: "ICNote" | "ICAttachment" | "ICMedia" | "ICAccount";
  note?: number | null;
  uti?: string | null;
  identifier?: string | null;
  /** Hex of ZMERGEABLEDATA1. */
  dataHex?: string | null;
  locked?: number;
  deleted?: number;
  parent?: number | null;
  media?: number | null;
  account?: number | null;
  generation?: string | null;
  filename?: string | null;
  duration?: number | null;
}

const ENTITIES = { ICAccount: 14, ICAttachment: 5, ICMedia: 11, ICNote: 12 } as const;

const sqlText = (value: string | null | undefined) =>
  value === null || value === undefined ? "NULL" : `'${value.replace(/'/g, "''")}'`;
const sqlNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? "NULL" : String(value);

/** Creates the fixture database and returns its path plus a cleanup function. */
export function createNoteStoreFixture(rows: FixtureRow[]): {
  dbPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "notestore-fixture-"));
  const dbPath = join(dir, "NoteStore.sqlite");
  const statements = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);",
    ...Object.entries(ENTITIES).map(
      ([name, ent]) => `INSERT INTO Z_PRIMARYKEY VALUES (${ent}, '${name}', 0, 0);`
    ),
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZNOTE INTEGER, " +
      "ZTYPEUTI VARCHAR, ZIDENTIFIER VARCHAR, ZMERGEABLEDATA1 BLOB, ZISPASSWORDPROTECTED INTEGER, " +
      "ZMARKEDFORDELETION INTEGER, ZPARENTATTACHMENT INTEGER, ZMEDIA INTEGER, ZACCOUNT6 INTEGER, " +
      "ZGENERATION1 VARCHAR, ZFILENAME VARCHAR, ZDURATION FLOAT);",
    ...rows.map(
      (r) =>
        "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (" +
        [
          r.pk,
          ENTITIES[r.ent],
          sqlNumber(r.note),
          sqlText(r.uti),
          sqlText(r.identifier),
          r.dataHex ? `X'${r.dataHex}'` : "NULL",
          r.locked ?? 0,
          r.deleted ?? 0,
          sqlNumber(r.parent),
          sqlNumber(r.media),
          sqlNumber(r.account),
          sqlText(r.generation),
          sqlText(r.filename),
          sqlNumber(r.duration),
        ].join(", ") +
        ");"
    ),
  ];
  execFileSync("sqlite3", [dbPath, statements.join("\n")], { stdio: "pipe" });
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
