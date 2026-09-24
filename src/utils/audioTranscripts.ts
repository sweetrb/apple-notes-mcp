/**
 * Read-only access to the transcripts Notes stores for audio recordings.
 *
 * When Notes transcribes a recording it keeps the result on the audio
 * attachment's row (UTI `com.apple.m4a-audio`) in
 * `ZICCLOUDSYNCINGOBJECT.ZMERGEABLEDATA1`. The blob is plain (not gzipped)
 * protobuf in the same CRDT "mergeable data" family as native tables
 * (see noteTables.ts): a root with object entries (field 3), a key-name table
 * (4), a type-name table (5) and a UUID table (6).
 *
 * Object graph (verified on macOS 27 recordings; see TECHNICAL_NOTES.md):
 *   ICTTAudioRecording (custom map)
 *     fragments -> list of ICTTAudioRecording.Fragment (custom map)
 *       identity   -> the child `public.mpeg-4-audio` attachment's identifier
 *       transcript -> ordered set (entry field 15) of ICTTTranscriptSegment
 *         text / speaker -> register -> NSString { self: string }
 *         timestamp / duration -> register -> NSNumber { doubleValue: fixed64 }
 *     summary, topLineSummary -> register -> topotext note (entry field 10)
 *
 * One segment is one recognized word. Fragments (appended takes) are
 * concatenated in stored list order. Every recording seen live had exactly one
 * fragment, so multi-fragment ordering is covered by synthetic fixtures only.
 *
 * Safety: the database is opened read-only (`sqlite3 -readonly`, argument
 * array, no shell). The only dynamic SQL value is the note primary key, which
 * is constrained to digits before it reaches a query.
 *
 * @module utils/audioTranscripts
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeMessage,
  embeddedMessage,
  fixed64Double,
  getField,
  getFields,
  stringValue,
  varintValue,
  type ProtoField,
} from "./protobuf.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "./docsUrls.js";
import type {
  AudioTranscript,
  AudioTranscriptOptions,
  AudioTranscriptsResult,
  TranscriptSegment,
} from "@/types.js";

const NOTES_DB_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Default and ceiling for word-level segments returned per attachment. */
export const DEFAULT_MAX_SEGMENTS = 2000;
export const MAX_SEGMENTS_LIMIT = 20000;

/** Decoded content of one recording's mergeable data. */
export interface DecodedRecording {
  fragments: Array<{ identity?: string; segments: TranscriptSegment[] }>;
  summary?: string;
  topLineSummary?: string;
}

export class AudioTranscriptError extends Error {
  constructor(
    public readonly kind: "invalid_id" | "not_found" | "locked" | "no_fda" | "query_error",
    message: string
  ) {
    super(message);
    this.name = "AudioTranscriptError";
  }
}

// -----------------------------------------------------------------------------
// Mergeable-data decoding
// -----------------------------------------------------------------------------

type Fields = ProtoField[];
const decode = (bytes: Uint8Array): Fields => decodeMessage(bytes, { keepFixed: true });
const sub = (f: Fields, n: number): Fields | undefined => {
  const bytes = getField(f, n)?.value;
  return bytes instanceof Uint8Array ? decode(bytes) : undefined;
};
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
};
const many = (f: Fields, n: number): Fields[] =>
  getFields(f, n).map((field) => {
    if (!(field.value instanceof Uint8Array)) throw new Error("Invalid nested entry");
    return decode(field.value);
  });

/**
 * Decodes one audio attachment's ZMERGEABLEDATA1 blob. Throws on any
 * structural surprise so callers can report the recording as undecodable
 * instead of returning a partial transcript as if it were whole.
 */
export function parseAudioRecording(data: Uint8Array): DecodedRecording {
  const root = decode(data);
  const entries = many(root, 3);
  if (entries.length === 0) throw new Error("No mergeable objects");
  if (entries.length > 2_000_000) throw new Error("Recording too large");
  const keys = getFields(root, 4).map((f) => stringValue(f) ?? "");
  const types = getFields(root, 5).map((f) => stringValue(f) ?? "");
  const uuids = getFields(root, 6).map((f) =>
    f.value instanceof Uint8Array ? Buffer.from(f.value).toString("hex") : ""
  );
  const uuidSlot = new Map<string, number>();
  uuids.forEach((uuid, i) => {
    if (uuid && !uuidSlot.has(uuid)) uuidSlot.set(uuid, i);
  });

  const entry = (index: number): Fields => {
    const value = entries[index];
    if (!value) throw new Error("Invalid object reference");
    return value;
  };
  /** Custom-map entry (field 13): its type name and key -> ObjectID fields. */
  const customMap = (e: Fields): { type: string; values: Map<string, Fields> } | undefined => {
    const map = sub(e, 13);
    if (!map) return undefined;
    const values = new Map<string, Fields>();
    for (const item of many(map, 3)) {
      const key = keys[need(varintValue(getField(item, 1)), "map key")];
      const value = sub(item, 2);
      if (key !== undefined && value) values.set(key, value);
    }
    return { type: types[need(varintValue(getField(map, 1)), "map type")] ?? "", values };
  };
  const objectIndex = (id: Fields | undefined): number | undefined =>
    id ? varintValue(getField(id, 6)) : undefined;
  /** Follows a register-latest (entry field 1) to the object its value points to. */
  const registerTarget = (id: Fields | undefined): Fields | undefined => {
    const index = objectIndex(id);
    if (index === undefined) return undefined;
    const register = sub(entry(index), 1);
    if (!register) return undefined;
    const target = objectIndex(sub(register, 2));
    return target === undefined ? undefined : entry(target);
  };
  /** Resolves a register holding an NSString or NSNumber to a primitive. */
  const registerPrimitive = (id: Fields | undefined): string | number | undefined => {
    const target = registerTarget(id);
    const map = target && customMap(target);
    if (!map) return undefined;
    const self = map.values.get("self");
    if (self) return stringValue(getField(self, 4));
    const double = map.values.get("doubleValue");
    if (double) return fixed64Double(getField(double, 3));
    const integer = map.values.get("integerValue");
    if (integer) return varintValue(getField(integer, 2));
    return undefined;
  };
  /** Resolves a register holding a topotext note (entry field 10) to its string. */
  const registerNoteText = (id: Fields | undefined): string | undefined => {
    const target = registerTarget(id);
    const note = target && sub(target, 10);
    const text = note && stringValue(getField(note, 2));
    return text?.replace(/\n+$/u, "") || undefined;
  };

  const recordings = entries
    .map((e) => customMap(e))
    .filter((m) => m?.type === "com.apple.notes.ICTTAudioRecording");
  if (recordings.length !== 1) throw new Error("Expected exactly one audio recording object");
  const recording = recordings[0]!;

  const fragments: DecodedRecording["fragments"] = [];
  const fragmentList = objectIndex(recording.values.get("fragments"));
  if (fragmentList !== undefined) {
    const list = need(sub(entry(fragmentList), 5), "fragment list");
    for (const item of many(list, 1)) {
      const fragment = customMap(entry(need(objectIndex(sub(item, 2)), "fragment reference")));
      if (fragment?.type !== "com.apple.notes.ICTTAudioRecording.Fragment")
        throw new Error("Unexpected fragment type");
      const identity = stringValue(getField(fragment.values.get("identity") ?? [], 4));
      const segments: TranscriptSegment[] = [];
      const transcriptRef = objectIndex(fragment.values.get("transcript"));
      if (transcriptRef !== undefined) {
        const set = sub(entry(transcriptRef), 15);
        if (!set) throw new Error("Unsupported transcript container");
        // Dictionary: NSUUID key object -> segment object.
        const bySlot = new Map<number, number>();
        for (const element of many(sub(set, 2) ?? [], 1)) {
          const keyMap = customMap(entry(need(objectIndex(sub(element, 1)), "segment key")));
          const slot = varintValue(getField(keyMap?.values.get("UUIDIndex") ?? [], 2));
          const value = objectIndex(sub(element, 2));
          if (slot === undefined || value === undefined) throw new Error("Invalid segment key");
          bySlot.set(slot, value);
        }
        // Ordering array: {index, uuid} pairs; stored sorted, sorted again defensively.
        const ordering = many(need(sub(set, 1), "transcript ordering"), 2)
          .map((pair) => ({
            index: need(varintValue(getField(pair, 1)), "segment index"),
            uuid: getField(pair, 2)?.value,
          }))
          .sort((a, b) => a.index - b.index);
        for (const { uuid } of ordering) {
          if (!(uuid instanceof Uint8Array)) throw new Error("Invalid segment UUID");
          const slot = uuidSlot.get(Buffer.from(uuid).toString("hex"));
          const segmentIndex = slot === undefined ? undefined : bySlot.get(slot);
          if (segmentIndex === undefined) throw new Error("Unresolved transcript segment");
          const segment = customMap(entry(segmentIndex));
          if (segment?.type !== "com.apple.notes.ICTTTranscriptSegment")
            throw new Error("Unexpected segment type");
          const text = registerPrimitive(segment.values.get("text"));
          if (typeof text !== "string") throw new Error("Segment without text");
          const start = registerPrimitive(segment.values.get("timestamp"));
          const duration = registerPrimitive(segment.values.get("duration"));
          const speaker = registerPrimitive(segment.values.get("speaker"));
          segments.push({
            text,
            ...(typeof start === "number" ? { start } : {}),
            ...(typeof duration === "number" ? { duration } : {}),
            ...(typeof speaker === "string" && speaker ? { speaker } : {}),
          });
        }
      }
      fragments.push({ ...(identity ? { identity } : {}), segments });
    }
  }
  const summary = registerNoteText(recording.values.get("summary"));
  const topLineSummary = registerNoteText(recording.values.get("topLineSummary"));
  return {
    fragments,
    ...(summary ? { summary } : {}),
    ...(topLineSummary ? { topLineSummary } : {}),
  };
}

/** Joins word segments into readable text: spaces between words, none before punctuation. */
export function joinSegments(segments: ReadonlyArray<{ text: string }>): string {
  let out = "";
  for (const { text } of segments) {
    if (!text) continue;
    const glue =
      !out || /\s$/u.test(out) || /^\s/u.test(text) || /^[.,!?;:%)\]}…'’]/u.test(text) ? "" : " ";
    out += glue + text;
  }
  return out.trim();
}

// -----------------------------------------------------------------------------
// Database read
// -----------------------------------------------------------------------------

/** Parses the note ID into its store UUID and primary key (digits only). */
export function parseNoteId(noteId: string): { store: string; pk: string } {
  const match = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d+)$/.exec(noteId);
  if (!match) {
    throw new AudioTranscriptError(
      "invalid_id",
      `Invalid note ID format: "${noteId}". Expected format: x-coredata://UUID/ICNote/pNNN`
    );
  }
  return { store: match[1], pk: match[2] };
}

const AUDIO_UTI_SQL = "(a.ZTYPEUTI LIKE '%audio%' OR a.ZTYPEUTI IN ('public.mp3'))";

/**
 * Builds the single read-only SQL script for one note. `pk` must be digits
 * (parseNoteId guarantees it); optional columns are included only when present.
 */
export function buildTranscriptSql(pk: string, available: ReadonlySet<string>): string {
  if (!/^\d+$/.test(pk)) throw new Error("Invalid primary key");
  const optional = (column: string, key: string, alias = "a") =>
    available.has(column) ? `, '${key}', ${alias}.${column}` : "";
  const locked = available.has("ZISPASSWORDPROTECTED")
    ? "COALESCE(n.ZISPASSWORDPROTECTED, 0)"
    : "0";
  // Only a note row counts: every entity shares this table, so a folder or
  // attachment key would otherwise read as a note without audio.
  const isNote = `n.Z_PK = ${pk} AND n.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')`;
  return [
    "BEGIN;",
    // Every statement yields exactly one row, so output lines stay positional.
    `SELECT json_object('found', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT n WHERE ${isNote}), ` +
      `'locked', (SELECT ${locked} FROM ZICCLOUDSYNCINGOBJECT n WHERE ${isNote}));`,
    `SELECT COALESCE((SELECT hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE = ${pk} LIMIT 1), '');`,
    "SELECT json_group_array(json_object(" +
      "'pk', a.Z_PK, 'identifier', a.ZIDENTIFIER, 'uti', a.ZTYPEUTI, " +
      "'data', hex(a.ZMERGEABLEDATA1)" +
      optional("ZDURATION", "duration") +
      optional("ZNEEDSTRANSCRIPTION", "needsTranscription") +
      ", 'fragments', json((SELECT json_group_array(json_object('identifier', c.ZIDENTIFIER" +
      optional("ZDURATION", "duration", "c") +
      ")) FROM ZICCLOUDSYNCINGOBJECT c WHERE c.ZPARENTATTACHMENT = a.Z_PK))" +
      `)) FROM ZICCLOUDSYNCINGOBJECT a WHERE a.ZNOTE = ${pk} AND a.ZPARENTATTACHMENT IS NULL AND ${AUDIO_UTI_SQL};`,
    "COMMIT;",
  ].join("\n");
}

const REQUIRED_COLUMNS = [
  "ZMERGEABLEDATA1",
  "ZPARENTATTACHMENT",
  "ZTYPEUTI",
  "ZNOTE",
  "ZIDENTIFIER",
];

function runSqlite(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-readonly", dbPath, sql], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

interface AudioRow {
  pk: number;
  identifier: string;
  uti: string;
  data: string;
  duration?: number | null;
  needsTranscription?: number | null;
  fragments: Array<{ identifier: string; duration?: number | null }>;
}

/** Attachment identifiers in body order, from the gzipped note document. */
export function bodyAttachmentOrder(gzipped: Uint8Array): string[] {
  const doc = decodeMessage(gunzipSync(gzipped, { maxOutputLength: 64 * 1024 * 1024 }));
  const body = embeddedMessage(getField(embeddedMessage(getField(doc, 2)) ?? [], 3));
  if (!body) throw new Error("Unsupported Notes document structure");
  const ids: string[] = [];
  for (const run of getFields(body, 5)) {
    const attachment = embeddedMessage(getField(embeddedMessage(run) ?? [], 12));
    const id = attachment && stringValue(getField(attachment, 1));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface ReadTranscriptOptions extends AudioTranscriptOptions {
  /** Override for tests; defaults to the live NoteStore. */
  dbPath?: string;
}

/** Reads every top-level audio attachment's stored transcript for one note. */
export function readAudioTranscripts(
  noteId: string,
  options: ReadTranscriptOptions = {}
): AudioTranscriptsResult {
  const { store, pk } = parseNoteId(noteId);
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const maxSegments = Math.min(
    Math.max(1, Math.floor(options.maxSegments ?? DEFAULT_MAX_SEGMENTS)),
    MAX_SEGMENTS_LIMIT
  );
  let lines: string[];
  try {
    const available = new Set(
      runSqlite(dbPath, "SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
    const missing = REQUIRED_COLUMNS.filter((c) => !available.has(c));
    if (missing.length)
      throw new AudioTranscriptError(
        "query_error",
        `This macOS version's Notes database lacks ${missing.join(", ")}; stored transcripts cannot be read.`
      );
    lines = runSqlite(dbPath, buildTranscriptSql(pk, available)).split("\n");
  } catch (error) {
    if (error instanceof AudioTranscriptError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message))
      throw new AudioTranscriptError(
        "no_fda",
        "Full Disk Access is required to read stored transcripts. Grant it to the Node binary " +
          `running this server (or the terminal that launches it), then fully quit and relaunch it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL}`
      );
    throw new AudioTranscriptError("query_error", "Failed to read the Notes database.");
  }
  const [noteLine = "{}", bodyLine = "", rowsLine = "[]"] = lines;
  const note = JSON.parse(noteLine || "{}") as { found?: number; locked?: number | null };
  if (!note.found)
    throw new AudioTranscriptError(
      "not_found",
      `No note found in the database for ID "${noteId}".`
    );
  if (note.locked)
    throw new AudioTranscriptError(
      "locked",
      "This note is password-protected; its transcripts are encrypted and cannot be read."
    );
  const rows = JSON.parse(rowsLine || "[]") as AudioRow[];

  let order: string[] | undefined;
  try {
    if (/^[0-9A-F]+$/i.test(bodyLine.trim()))
      order = bodyAttachmentOrder(Buffer.from(bodyLine.trim(), "hex"));
  } catch {
    order = undefined;
  }
  const ordered = order
    ? order.flatMap((id) => rows.filter((row) => row.identifier === id))
    : [...rows].sort((a, b) => a.pk - b.pk);

  const attachments = ordered.map((row) => describeRow(row, store, options, maxSegments));
  return { id: noteId, attachments, bodyOrder: Boolean(order), truncated: false };
}

function describeRow(
  row: AudioRow,
  store: string,
  options: ReadTranscriptOptions,
  maxSegments: number
): AudioTranscript {
  const childDurations = (row.fragments ?? [])
    .map((f) => f.duration)
    .filter((d): d is number => typeof d === "number" && d > 0);
  const durationSeconds =
    typeof row.duration === "number" && row.duration > 0
      ? row.duration
      : childDurations.length
        ? childDurations.reduce((a, b) => a + b, 0)
        : undefined;
  const base: AudioTranscript = {
    attachmentId: `x-coredata://${store}/ICAttachment/p${row.pk}`,
    identifier: row.identifier,
    typeUti: row.uti,
    status: "none",
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(typeof row.needsTranscription === "number"
      ? { needsTranscription: row.needsTranscription === 1 }
      : {}),
  };
  if (!row.data) return base;
  let recording: DecodedRecording;
  try {
    recording = parseAudioRecording(Buffer.from(row.data, "hex"));
  } catch (error) {
    return {
      ...base,
      status: "undecodable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const multi = recording.fragments.length > 1;
  const all = recording.fragments.flatMap((fragment, i) =>
    fragment.segments.map((s) => (multi ? { ...s, fragment: i } : s))
  );
  const text = recording.fragments
    .map((f) => joinSegments(f.segments))
    .filter(Boolean)
    .join("\n\n");
  const speakers = [...new Set(all.flatMap((s) => (s.speaker ? [s.speaker] : [])))];
  return {
    ...base,
    status: all.length ? "ok" : "none",
    fragmentCount: recording.fragments.length,
    wordCount: all.length,
    ...(text ? { text } : {}),
    ...(speakers.length ? { speakers } : {}),
    ...(recording.summary ? { summary: recording.summary } : {}),
    ...(recording.topLineSummary ? { topLineSummary: recording.topLineSummary } : {}),
    ...(options.includeSegments && all.length
      ? {
          segments: all.slice(0, maxSegments),
          ...(all.length > maxSegments ? { segmentsTruncated: true } : {}),
        }
      : {}),
  };
}

/**
 * Shrinks a result until `measure` fits `maxBytes`: first drops word-level
 * segments, then shortens transcript text evenly. Marks what it removed.
 */
export function fitTranscriptsToBudget(
  result: AudioTranscriptsResult,
  maxBytes: number,
  measure: (r: AudioTranscriptsResult) => number
): AudioTranscriptsResult {
  if (measure(result) <= maxBytes) return result;
  let next: AudioTranscriptsResult = {
    ...result,
    truncated: true,
    attachments: result.attachments.map((a) => {
      if (!a.segments) return a;
      const rest: AudioTranscript = { ...a, segmentsTruncated: true };
      delete rest.segments;
      return rest;
    }),
  };
  for (let share = 0.5; measure(next) > maxBytes && share > 0.0001; share /= 2) {
    next = {
      ...next,
      attachments: next.attachments.map((a) => {
        const original = result.attachments.find((o) => o.attachmentId === a.attachmentId);
        if (!original?.text) return a;
        const keep = Math.floor(original.text.length * share);
        return { ...a, text: original.text.slice(0, keep), textTruncated: true };
      }),
    };
  }
  return next;
}

const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
};

/** Human-readable rendering of a transcripts result for the text content block. */
export function formatTranscriptsText(result: AudioTranscriptsResult): string {
  const count = result.attachments.length;
  if (count === 0) return `No audio attachments found in note ${result.id}.`;
  const lines = [`${count} audio attachment${count === 1 ? "" : "s"} in note ${result.id}:`];
  result.attachments.forEach((a, i) => {
    const facts = [
      `status ${a.status}`,
      ...(a.durationSeconds !== undefined ? [clock(a.durationSeconds)] : []),
      ...(a.wordCount !== undefined ? [`${a.wordCount} words`] : []),
      ...(a.fragmentCount && a.fragmentCount > 1 ? [`${a.fragmentCount} fragments`] : []),
      ...(a.speakers?.length ? [`${a.speakers.length} speakers`] : []),
      ...(a.reason ? [`reason: ${a.reason}`] : []),
    ];
    lines.push("", `[${i + 1}] ${a.attachmentId} (${facts.join(", ")})`);
    if (a.summary) lines.push(`Summary: ${a.summary}`);
    if (a.text) lines.push(a.textTruncated ? `${a.text} [truncated]` : a.text);
  });
  if (result.truncated)
    lines.push(
      "",
      "Some segments or text were left out to stay under the response size limit (APPLE_NOTES_MCP_EXPORT_MAX_BYTES)."
    );
  return lines.join("\n");
}
