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
 * (older layouts omit the generation folder). The account folder is found by
 * probing the account directories that exist, so no account-column mapping is
 * needed. Nothing here writes: the database is opened read-only and files are
 * only stat'ed and resolved.
 *
 * @module utils/noteAudio
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  assertNoteReadable,
  NOTE_ACCOUNTS_PATH,
  NOTE_STATE_SQL,
  NOTE_STORE_PATH,
  NoteStoreReadError,
  parseNoteObjectId,
  queryNoteStore,
} from "./noteStoreQuery.js";

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

const COLUMNS_SQL = "SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');";

/**
 * The audio query for one media-generation column. The column name comes from
 * a fixed allowlist; the note key is the bound `:pk` parameter.
 */
export function audioRowsSql(generationColumn: "ZGENERATION1" | "ZGENERATION" | null): string {
  const generation = generationColumn ? `m.${generationColumn}` : "NULL";
  const media = (alias: string) =>
    `json((SELECT json_object('identifier', m.ZIDENTIFIER, 'generation', ${generation}, ` +
    `'filename', m.ZFILENAME) FROM ZICCLOUDSYNCINGOBJECT m WHERE m.Z_PK = ${alias}.ZMEDIA))`;
  const live = "COALESCE(ZMARKEDFORDELETION, 0) = 0";
  const utis = EXTRA_AUDIO_UTIS.map((u) => `'${u}'`).join(", ");
  return [
    NOTE_STATE_SQL,
    "SELECT json_group_array(json_object('pk', a.Z_PK, 'identifier', a.ZIDENTIFIER, " +
      `'uti', a.ZTYPEUTI, 'duration', a.ZDURATION, 'media', ${media("a")}, ` +
      "'children', json((SELECT json_group_array(json_object('pk', c.Z_PK, " +
      `'identifier', c.ZIDENTIFIER, 'duration', c.ZDURATION, 'media', ${media("c")})) ` +
      `FROM (SELECT * FROM ZICCLOUDSYNCINGOBJECT WHERE ZPARENTATTACHMENT = a.Z_PK AND ${live} ` +
      "ORDER BY Z_PK) c)))) FROM " +
      "(SELECT * FROM ZICCLOUDSYNCINGOBJECT WHERE ZNOTE = :pk AND ZPARENTATTACHMENT IS NULL " +
      `AND ${live} AND (ZTYPEUTI LIKE '%audio%' OR ZTYPEUTI IN (${utis})) ORDER BY Z_PK) a;`,
  ].join("\n");
}

/** A single path segment from the database: no separators, no dot segments. */
function safeSegment(value: string | null): value is string {
  return (
    !!value && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0")
  );
}

/**
 * Finds a media file under the accounts root. Returns the real path only when
 * it is a regular file that resolves inside the root (no symlink escapes).
 */
export function resolveMediaPath(
  media: MediaRef | null,
  accountsRoot: string = NOTE_ACCOUNTS_PATH
): string | null {
  if (!media || !safeSegment(media.identifier) || !safeSegment(media.filename)) return null;
  let root: string;
  let accounts: string[];
  try {
    root = realpathSync.native(accountsRoot);
    accounts = readdirSync(root);
  } catch {
    return null;
  }
  for (const account of accounts.filter(safeSegment)) {
    const base = join(root, account, "Media", media.identifier);
    const candidates = safeSegment(media.generation)
      ? [join(base, media.generation, media.filename), join(base, media.filename)]
      : [join(base, media.filename)];
    for (const candidate of candidates) {
      try {
        const real = realpathSync.native(candidate);
        if (real.startsWith(root + sep) && statSync(real).isFile()) return real;
      } catch {
        // not in this account folder
      }
    }
  }
  return null;
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export interface ReadAudioOptions {
  dbPath?: string;
  accountsRoot?: string;
}

/** Reads every live top-level audio attachment of one note, in primary-key order. */
export function readAudioAssets(
  noteId: string,
  options: ReadAudioOptions = {}
): AudioRecordingAsset[] {
  const { store, pk } = parseNoteObjectId(noteId);
  const dbPath = options.dbPath ?? NOTE_STORE_PATH;
  const columns = new Set(queryNoteStore(COLUMNS_SQL, {}, dbPath).map((l) => l.trim()));
  const missing = ["ZMEDIA", "ZPARENTATTACHMENT", "ZFILENAME"].filter((c) => !columns.has(c));
  if (missing.length)
    throw new NoteStoreReadError(
      "query_error",
      `This macOS version's Notes database lacks ${missing.join(", ")}; audio files cannot be located.`
    );
  const generation = columns.has("ZGENERATION1")
    ? "ZGENERATION1"
    : columns.has("ZGENERATION")
      ? "ZGENERATION"
      : null;
  const [stateLine, rowsLine] = queryNoteStore(audioRowsSql(generation), { pk }, dbPath);
  assertNoteReadable(stateLine, noteId);
  const rows = JSON.parse(rowsLine || "[]") as AudioRow[];
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
      path: resolveMediaPath(take.media, options.accountsRoot),
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

/** Counts words the way a reader would: whitespace-separated runs that contain a letter or digit. */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
