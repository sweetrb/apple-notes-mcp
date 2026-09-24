/**
 * Locate a note's audio recordings and their audio files, read-only.
 *
 * A Notes voice recording is a top-level attachment (UTI `com.apple.m4a-audio`)
 * whose takes are child attachments (`public.mpeg-4-audio`, linked through
 * ZPARENTATTACHMENT). Each take, like a plain attached audio file, points at an
 * ICMedia row (ZMEDIA) naming the file on disk:
 *
 *   Accounts/<account identifier>/Media/<media identifier>/<generation>/<filename>
 *
 * (older layouts omit the generation folder). The account folder comes from the
 * note's account, resolved with the same helpers `list-attachments` uses; when
 * that is unknown, each account folder is probed. Nothing here writes: the
 * database is opened read-only and files are only stat'ed and resolved.
 *
 * @module utils/noteAudio
 */
import { countWords } from "./wordCount.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NOTES_CONTAINER_DIR,
  parseNoteId,
  realInside,
  resolveAccountDir,
  safeComponent,
} from "./attachmentAssets.js";
import { assertNoteReadable, NOTE_STATE_SQL, queryNoteScoped } from "./noteStoreQuery.js";
import {
  entity,
  NOTES_DB_PATH,
  NoteStoreError,
  notTombstonedSql,
  readColumns,
} from "./noteStoreSql.js";

/** One audio file that can be transcribed. */
export interface AudioTake {
  attachmentId: string;
  identifier: string;
  durationSeconds: number | null;
  /** Absolute path of the audio file, or null when it is not on this Mac. */
  path: string | null;
}

/** One top-level audio attachment: a Notes recording with takes, or a plain audio file. */
export interface AudioRecordingAsset {
  pk: number;
  attachmentId: string;
  identifier: string;
  typeUti: string;
  durationSeconds: number | null;
  takes: AudioTake[];
}

interface MediaRef {
  identifier: string | null;
  generation: string | null;
  filename: string | null;
}

interface AudioRow {
  pk: number;
  identifier: string | null;
  uti: string;
  duration: number | null;
  media: MediaRef | null;
  children: Array<{
    pk: number;
    identifier: string | null;
    duration: number | null;
    media: MediaRef | null;
  }>;
}

/** Audio UTIs Notes stores, besides anything whose UTI names audio. */
const EXTRA_AUDIO_UTIS = [
  "public.mp3",
  "public.aiff-audio",
  "public.aifc-audio",
  "com.microsoft.waveform-audio",
];

/**
 * The audio query for one media-generation column. The column name comes from
 * a fixed allowlist; the note key is the bound `@pk` parameter. Attachments
 * marked for deletion are skipped where the schema tracks that.
 */
export function audioRowsSql(
  columns: ReadonlySet<string>,
  generationColumn: "ZGENERATION1" | "ZGENERATION" | null
): string {
  const generation = generationColumn ? `m.${generationColumn}` : "NULL";
  const media = (alias: string) =>
    `json((SELECT json_object('identifier', m.ZIDENTIFIER, 'generation', ${generation}, ` +
    `'filename', m.ZFILENAME) FROM ZICCLOUDSYNCINGOBJECT m WHERE m.Z_PK = ${alias}.ZMEDIA))`;
  const live = (alias: string) => notTombstonedSql(columns, alias);
  const utis = EXTRA_AUDIO_UTIS.map((u) => `'${u}'`).join(", ");
  // The note's account identifier names its folder under Accounts/. The link
  // column's suffix differs between macOS releases, so every ZACCOUNT* is tried.
  const accountCols = [...columns].filter((c) => /^ZACCOUNT\d*$/.test(c)).sort();
  const account = accountCols.length
    ? `SELECT (SELECT acc.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT acc WHERE acc.Z_ENT = ${entity("ICAccount")} ` +
      `AND acc.Z_PK IN (${accountCols.map((c) => `n.${c}`).join(", ")}) LIMIT 1) ` +
      "FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK = @pk;"
    : "SELECT NULL;";
  return [
    NOTE_STATE_SQL,
    "SELECT json_group_array(json_object('pk', a.Z_PK, 'identifier', a.ZIDENTIFIER, " +
      `'uti', a.ZTYPEUTI, 'duration', a.ZDURATION, 'media', ${media("a")}, ` +
      "'children', json((SELECT json_group_array(json_object('pk', c.Z_PK, " +
      `'identifier', c.ZIDENTIFIER, 'duration', c.ZDURATION, 'media', ${media("c")})) ` +
      `FROM (SELECT * FROM ZICCLOUDSYNCINGOBJECT k WHERE k.ZPARENTATTACHMENT = a.Z_PK AND ${live("k")} ` +
      "ORDER BY k.Z_PK) c)))) FROM " +
      "(SELECT * FROM ZICCLOUDSYNCINGOBJECT t WHERE t.ZNOTE = @pk AND t.ZPARENTATTACHMENT IS NULL " +
      `AND ${live("t")} AND (t.ZTYPEUTI LIKE '%audio%' OR t.ZTYPEUTI IN (${utis})) ORDER BY t.Z_PK) a;`,
    account,
  ].join("\n");
}

/**
 * The account folders to look in: the note's own when it resolves, otherwise
 * every folder under Accounts/ (an unknown account in a multi-account library).
 */
function accountDirsFor(containerDir: string, accountIdentifier: string | null): string[] {
  const own = resolveAccountDir(containerDir, accountIdentifier);
  if (own) return [own];
  let names: string[];
  try {
    names = readdirSync(join(containerDir, "Accounts")).sort();
  } catch {
    return [];
  }
  return names
    .map((name) => (safeComponent(name) ? resolveAccountDir(containerDir, name) : null))
    .filter((dir): dir is string => dir !== null);
}

/**
 * Finds a media file in the note's account folder. Returns the real path only
 * when it is a regular file that resolves inside that folder (no symlink escapes).
 */
export function resolveMediaPath(
  media: MediaRef | null,
  accountIdentifier: string | null = null,
  containerDir: string = NOTES_CONTAINER_DIR
): string | null {
  const id = safeComponent(media?.identifier);
  const filename = safeComponent(media?.filename);
  if (!id || !filename) return null;
  const generation = safeComponent(media?.generation);
  for (const dir of accountDirsFor(containerDir, accountIdentifier)) {
    const base = join(dir, "Media", id);
    const candidates = generation
      ? [join(base, generation, filename), join(base, filename)]
      : [join(base, filename)];
    for (const candidate of candidates) {
      const real = realInside(candidate, dir);
      if (real && isFile(real)) return real;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export interface ReadAudioOptions {
  dbPath?: string;
  /** The Notes group container (holds Accounts/); tests point it at a fixture tree. */
  containerDir?: string;
}

/** Reads every live top-level audio attachment of one note, in primary-key order. */
export function readAudioAssets(
  noteId: string,
  options: ReadAudioOptions = {}
): AudioRecordingAsset[] {
  const { store, pk } = parseNoteId(noteId);
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const columns = readColumns(dbPath);
  const missing = ["ZMEDIA", "ZPARENTATTACHMENT", "ZFILENAME"].filter((c) => !columns.has(c));
  if (missing.length)
    throw new NoteStoreError(
      `This macOS version's Notes database lacks ${missing.join(", ")}; audio files cannot be located.`,
      "schema"
    );
  const generation = columns.has("ZGENERATION1")
    ? "ZGENERATION1"
    : columns.has("ZGENERATION")
      ? "ZGENERATION"
      : null;
  const [stateLine, rowsLine, accountLine] = queryNoteScoped(
    audioRowsSql(columns, generation),
    pk,
    dbPath
  );
  assertNoteReadable(stateLine, noteId);
  const rows = JSON.parse(rowsLine || "[]") as AudioRow[];
  const account = accountLine?.trim() || null;
  const attachmentId = (rowPk: number) => `x-coredata://${store}/ICAttachment/p${rowPk}`;
  return rows.map((row) => {
    // A recording's audio lives in its takes; a plain audio file is its own take.
    const sources = row.children?.length
      ? row.children
      : [{ pk: row.pk, identifier: row.identifier, duration: row.duration, media: row.media }];
    const takes = sources.map((take) => ({
      attachmentId: attachmentId(take.pk),
      identifier: take.identifier ?? "",
      durationSeconds: positive(take.duration),
      path: resolveMediaPath(take.media, account, options.containerDir),
    }));
    const total = takes.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0);
    return {
      pk: row.pk,
      attachmentId: attachmentId(row.pk),
      identifier: row.identifier ?? "",
      typeUti: row.uti,
      durationSeconds: positive(row.duration) ?? positive(total),
      takes,
    };
  });
}

/** Counts words the way every other tool does; see utils/wordCount. */
export { countWords };
