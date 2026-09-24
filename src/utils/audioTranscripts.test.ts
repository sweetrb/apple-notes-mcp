/**
 * Tests for the stored audio transcript reader.
 *
 * Fixtures are synthetic: the encoder below builds mergeable-data blobs with
 * the same object graph Notes writes for a transcribed recording (recording ->
 * fragments list -> fragment -> ordered set of word segments), so no real
 * transcript content is ever checked in. The database tests run the generated
 * SQL through the real sqlite3 CLI against a throwaway fixture store in a temp
 * directory; the live NoteStore is never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  AudioTranscriptError,
  bodyAttachmentOrder,
  buildTranscriptSql,
  fitTranscriptsToBudget,
  formatTranscriptsText,
  joinSegments,
  parseAudioRecording,
  readAudioTranscripts,
} from "./audioTranscripts.js";
import type { AudioTranscriptsResult } from "@/types.js";

// -----------------------------------------------------------------------------
// Protobuf encoding helpers (inverse of protobuf.ts)
// -----------------------------------------------------------------------------

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
};
const vField = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const lField = (field: number, data: number[] | string | Uint8Array) => {
  const bytes = typeof data === "string" ? [...Buffer.from(data, "utf8")] : [...data];
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
};
const dField = (field: number, value: number) => {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return [...varint((field << 3) | 1), ...buf];
};

// -----------------------------------------------------------------------------
// Synthetic mergeable-data recording builder
// -----------------------------------------------------------------------------

interface Word {
  text: string;
  start?: number;
  duration?: number;
  speaker?: string;
}
interface FragmentSpec {
  identity?: string;
  words: Word[];
  /** Store the ordering pairs in this permutation of word indexes. */
  storedOrder?: number[];
}

class Graph {
  entries: number[][] = [];
  keys: string[] = [];
  types: string[] = [];
  uuids: Uint8Array[] = [];
  private index(list: string[], name: string) {
    let i = list.indexOf(name);
    if (i < 0) i = list.push(name) - 1;
    return i;
  }
  add(entry: number[]): number {
    return this.entries.push(entry) - 1;
  }
  reserve(): number {
    return this.add([]);
  }
  customMap(type: string, values: Array<[string, number[]]>): number[] {
    const items = values.flatMap(([key, objectId]) =>
      lField(3, [...vField(1, this.index(this.keys, key)), ...lField(2, objectId)])
    );
    return lField(13, [...vField(1, this.index(this.types, type)), ...items]);
  }
  string(value: string): number {
    return this.add(this.customMap("com.apple.CRDT.NSString", [["self", lField(4, value)]]));
  }
  double(value: number): number {
    return this.add(this.customMap("com.apple.CRDT.NSNumber", [["doubleValue", dField(3, value)]]));
  }
  register(target?: number): number {
    const version = lField(1, [...vField(1, 0), ...vField(2, 1)]);
    return this.add(
      lField(1, [...version, ...(target === undefined ? [] : lField(2, vField(6, target)))])
    );
  }
  uuid(): { slot: number; bytes: Uint8Array } {
    const bytes = new Uint8Array(16);
    const slot = this.uuids.length;
    bytes[0] = 0xab;
    bytes[14] = slot >> 8;
    bytes[15] = slot & 0xff;
    this.uuids.push(bytes);
    return { slot, bytes };
  }
  encode(): Buffer {
    return Buffer.from([
      ...lField(1, lField(1, [...vField(1, 0), ...vField(2, 1)])),
      ...this.entries.flatMap((e) => lField(3, e)),
      ...this.keys.flatMap((k) => lField(4, k)),
      ...this.types.flatMap((t) => lField(5, t)),
      ...this.uuids.flatMap((u) => lField(6, u)),
    ]);
  }
}

const objectRef = (idx: number) => vField(6, idx);

function recordingBlob(options: {
  fragments: FragmentSpec[];
  summary?: string;
  topLineSummary?: string;
}): Buffer {
  const g = new Graph();
  const root = g.reserve(); // recording must not be entry 0 by accident of order
  const fragmentIds = options.fragments.map((fragment) => {
    const segmentObjects = fragment.words.map((word) => {
      const values: Array<[string, number[]]> = [
        ["text", objectRef(g.register(g.string(word.text)))],
      ];
      if (word.start !== undefined)
        values.push(["timestamp", objectRef(g.register(g.double(word.start)))]);
      if (word.duration !== undefined)
        values.push(["duration", objectRef(g.register(g.double(word.duration)))]);
      if (word.speaker !== undefined)
        values.push(["speaker", objectRef(g.register(g.string(word.speaker)))]);
      return g.add(g.customMap("com.apple.notes.ICTTTranscriptSegment", values));
    });
    const ids = fragment.words.map(() => g.uuid());
    const keyObjects = ids.map((id) =>
      g.add(g.customMap("com.apple.CRDT.NSUUID", [["UUIDIndex", vField(2, id.slot)]]))
    );
    const order = fragment.storedOrder ?? fragment.words.map((_, i) => i);
    const orderingPairs = order.flatMap((i) =>
      lField(2, [...vField(1, i), ...lField(2, ids[i].bytes)])
    );
    const note = lField(1, lField(2, "\ufffc".repeat(fragment.words.length)));
    const dictionary = lField(
      2,
      ids.flatMap((_, i) =>
        lField(1, [
          ...lField(1, objectRef(keyObjects[i])),
          ...lField(2, objectRef(segmentObjects[i])),
        ])
      )
    );
    const transcript = g.add(
      lField(15, [...lField(1, [...note, ...orderingPairs]), ...dictionary])
    );
    const values: Array<[string, number[]]> = [["transcript", objectRef(transcript)]];
    if (fragment.identity) values.unshift(["identity", lField(4, fragment.identity)]);
    return g.add(g.customMap("com.apple.notes.ICTTAudioRecording.Fragment", values));
  });
  const list = g.add(
    lField(
      5,
      fragmentIds.flatMap((id) => lField(1, [...lField(2, objectRef(id))]))
    )
  );
  const noteRegister = (text?: string) =>
    g.register(text === undefined ? undefined : g.add(lField(10, lField(2, text))));
  g.entries[root] = g.customMap("com.apple.notes.ICTTAudioRecording", [
    ["identity", lField(4, "00000000-0000-4000-8000-000000000000")],
    ["fragments", objectRef(list)],
    ["summary", objectRef(noteRegister(options.summary))],
    ["topLineSummary", objectRef(noteRegister(options.topLineSummary))],
  ]);
  return g.encode();
}

const words = (...texts: string[]): Word[] =>
  texts.map((text, i) => ({ text, start: i * 0.5, duration: 0.4, speaker: "Speaker 1" }));

// -----------------------------------------------------------------------------
// Decoder
// -----------------------------------------------------------------------------

describe("parseAudioRecording", () => {
  it("decodes words, timings and speakers of a single-fragment recording", () => {
    const blob = recordingBlob({
      fragments: [
        {
          identity: "FRAG-1",
          words: [
            { text: "Alpha", start: 0.25, duration: 0.5, speaker: "Speaker 1" },
            { text: " bravo", start: 0.8, duration: 0.3, speaker: "Speaker 2" },
          ],
        },
      ],
    });
    const decoded = parseAudioRecording(blob);
    expect(decoded.fragments).toEqual([
      {
        identity: "FRAG-1",
        segments: [
          { text: "Alpha", start: 0.25, duration: 0.5, speaker: "Speaker 1" },
          { text: " bravo", start: 0.8, duration: 0.3, speaker: "Speaker 2" },
        ],
      },
    ]);
    expect(decoded.summary).toBeUndefined();
    expect(decoded.topLineSummary).toBeUndefined();
  });

  it("orders segments by their ordering index, not by storage order", () => {
    const blob = recordingBlob({
      fragments: [{ words: words("one", "two", "three"), storedOrder: [2, 0, 1] }],
    });
    expect(parseAudioRecording(blob).fragments[0].segments.map((s) => s.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("keeps multi-fragment recordings in stored fragment-list order", () => {
    const blob = recordingBlob({
      fragments: [
        { identity: "B", words: words("second", "take") },
        { identity: "A", words: words("third") },
      ],
    });
    const decoded = parseAudioRecording(blob);
    expect(decoded.fragments.map((f) => f.identity)).toEqual(["B", "A"]);
    expect(decoded.fragments.map((f) => f.segments.length)).toEqual([2, 1]);
  });

  it("reads the stored summary and top-line summary", () => {
    const blob = recordingBlob({
      fragments: [{ words: words("x") }],
      summary: "Synthetic summary line.\n",
      topLineSummary: "Top line",
    });
    const decoded = parseAudioRecording(blob);
    expect(decoded.summary).toBe("Synthetic summary line.");
    expect(decoded.topLineSummary).toBe("Top line");
  });

  it("decodes Unicode words", () => {
    const blob = recordingBlob({ fragments: [{ words: words("Привет", " 🧭", " naïve") }] });
    expect(joinSegments(parseAudioRecording(blob).fragments[0].segments)).toBe("Привет 🧭 naïve");
  });

  it("returns no fragments when the recording has none", () => {
    expect(parseAudioRecording(recordingBlob({ fragments: [] })).fragments).toEqual([]);
  });

  it("rejects unrelated bytes", () => {
    expect(() => parseAudioRecording(Buffer.from("not a recording"))).toThrow();
  });

  it("rejects a truncated recording instead of returning a partial transcript", () => {
    const blob = recordingBlob({ fragments: [{ words: words("a", "b", "c", "d") }] });
    expect(() => parseAudioRecording(blob.subarray(0, Math.floor(blob.length * 0.6)))).toThrow();
  });
});

describe("joinSegments", () => {
  it("adds spaces between bare words but not before punctuation", () => {
    expect(joinSegments([{ text: "Hello" }, { text: "," }, { text: "world" }, { text: "." }])).toBe(
      "Hello, world."
    );
  });
  it("respects words that carry their own leading space", () => {
    expect(joinSegments([{ text: "Hello" }, { text: " there" }, { text: " friend" }])).toBe(
      "Hello there friend"
    );
  });
  it("returns an empty string for no segments", () => {
    expect(joinSegments([])).toBe("");
  });
});

// -----------------------------------------------------------------------------
// Response shaping
// -----------------------------------------------------------------------------

const sampleResult = (): AudioTranscriptsResult => ({
  id: "x-coredata://STORE/ICNote/p1",
  bodyOrder: true,
  truncated: false,
  attachments: [
    {
      attachmentId: "x-coredata://STORE/ICAttachment/p2",
      identifier: "A",
      typeUti: "com.apple.m4a-audio",
      status: "ok",
      durationSeconds: 3725,
      fragmentCount: 1,
      wordCount: 400,
      text: "word ".repeat(400).trim(),
      speakers: ["Speaker 1"],
      summary: "Short summary.",
      segments: Array.from({ length: 400 }, (_, i) => ({ text: "word", start: i })),
    },
    {
      attachmentId: "x-coredata://STORE/ICAttachment/p3",
      identifier: "B",
      typeUti: "com.apple.m4a-audio",
      status: "undecodable",
      reason: "Unexpected fragment type",
    },
  ],
});

describe("fitTranscriptsToBudget", () => {
  const measure = (r: AudioTranscriptsResult) => Buffer.byteLength(JSON.stringify(r));

  it("returns the result unchanged when it already fits", () => {
    const result = sampleResult();
    expect(fitTranscriptsToBudget(result, 1_000_000, measure)).toBe(result);
  });

  it("drops segments first and marks them truncated", () => {
    const result = sampleResult();
    const withoutSegments = measure({
      ...result,
      attachments: result.attachments.map((a) => ({ ...a, segments: undefined })),
    });
    const fitted = fitTranscriptsToBudget(result, withoutSegments + 100, measure);
    expect(fitted.truncated).toBe(true);
    expect(fitted.attachments[0].segments).toBeUndefined();
    expect(fitted.attachments[0].segmentsTruncated).toBe(true);
    expect(fitted.attachments[0].text).toBe(result.attachments[0].text);
    expect(fitted.attachments[0].textTruncated).toBeUndefined();
  });

  it("then shortens transcript text until the result fits", () => {
    const fitted = fitTranscriptsToBudget(sampleResult(), 1200, measure);
    expect(measure(fitted)).toBeLessThanOrEqual(1200);
    expect(fitted.attachments[0].textTruncated).toBe(true);
    expect(fitted.attachments[0].text!.length).toBeLessThan(2000);
    expect(fitted.attachments[1].status).toBe("undecodable");
  });
});

describe("formatTranscriptsText", () => {
  it("summarizes each attachment and includes summary and text", () => {
    const text = formatTranscriptsText(sampleResult());
    expect(text).toContain("2 audio attachments in note x-coredata://STORE/ICNote/p1:");
    expect(text).toContain(
      "[1] x-coredata://STORE/ICAttachment/p2 (status ok, 1:02:05, 400 words, 1 speakers)"
    );
    expect(text).toContain("Summary: Short summary.");
    expect(text).toContain("reason: Unexpected fragment type");
  });
  it("says so when the note has no audio", () => {
    expect(
      formatTranscriptsText({ id: "n", attachments: [], bodyOrder: true, truncated: false })
    ).toBe("No audio attachments found in note n.");
  });
});

// -----------------------------------------------------------------------------
// SQL against a real sqlite3 fixture store
// -----------------------------------------------------------------------------

/** Gzipped Notes document whose attribute runs reference attachments in this order. */
function noteDocument(attachments: Array<{ id: string; type: string }>): Buffer {
  const text = "Title\n" + "\ufffc".repeat(attachments.length);
  const runs = [
    lField(5, vField(1, 6)),
    ...attachments.map((a) =>
      lField(5, [...vField(1, 1), ...lField(12, [...lField(1, a.id), ...lField(2, a.type)])])
    ),
  ].flat();
  return gzipSync(Buffer.from(lField(2, lField(3, [...lField(2, text), ...runs]))));
}

const hexLiteral = (buf: Buffer | null) => (buf ? `X'${buf.toString("hex")}'` : "NULL");

describe("readAudioTranscripts (sqlite3 fixture store)", () => {
  let dir: string;
  let dbPath: string;
  const STORE = "11111111-2222-3333-4444-555555555555";
  const noteId = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-transcripts-"));
    dbPath = join(dir, "NoteStore.sqlite");
    const first = recordingBlob({
      fragments: [{ identity: "CHILD-1", words: words("First", " recording", ".") }],
      summary: "A synthetic summary.",
    });
    const second = recordingBlob({
      fragments: [
        { identity: "CHILD-2A", words: words("Take", " one") },
        { identity: "CHILD-2B", words: words("Take", " two") },
      ],
    });
    const empty = recordingBlob({ fragments: [{ identity: "CHILD-3", words: [] }] });
    // Body order: second (AUD-2) before first (AUD-1), then an image, a
    // corrupt recording, an empty one, and a recording with no data at all.
    const body = noteDocument([
      { id: "AUD-2", type: "com.apple.m4a-audio" },
      { id: "AUD-1", type: "com.apple.m4a-audio" },
      { id: "IMG-1", type: "public.jpeg" },
      { id: "AUD-BAD", type: "com.apple.m4a-audio" },
      { id: "AUD-EMPTY", type: "com.apple.m4a-audio" },
      { id: "AUD-NULL", type: "com.apple.m4a-audio" },
    ]);
    const sql = `
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (
        Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR, ZTYPEUTI VARCHAR, ZNOTE INTEGER,
        ZPARENTATTACHMENT INTEGER, ZMERGEABLEDATA1 BLOB, ZDURATION FLOAT,
        ZNEEDSTRANSCRIPTION INTEGER, ZISPASSWORDPROTECTED INTEGER);
      CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZISPASSWORDPROTECTED) VALUES (10, 'NOTE-10', 0);
      INSERT INTO ZICNOTEDATA VALUES (1, 10, ${hexLiteral(body)});
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (11, 'AUD-1', 'com.apple.m4a-audio', 10, NULL, ${hexLiteral(first)}, 12.5, 0, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (12, 'CHILD-1', 'public.mpeg-4-audio', 10, 11, X'0a00', 12.5, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (13, 'AUD-2', 'com.apple.m4a-audio', 10, NULL, ${hexLiteral(second)}, 0.0, 0, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (14, 'CHILD-2A', 'public.mpeg-4-audio', 10, 13, NULL, 3.0, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (15, 'CHILD-2B', 'public.mpeg-4-audio', 10, 13, NULL, 4.5, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (16, 'IMG-1', 'public.jpeg', 10, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (17, 'AUD-BAD', 'com.apple.m4a-audio', 10, NULL, X'deadbeef', NULL, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (18, 'AUD-EMPTY', 'com.apple.m4a-audio', 10, NULL, ${hexLiteral(empty)}, NULL, 1, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (19, 'AUD-NULL', 'com.apple.m4a-audio', 10, NULL, NULL, NULL, 1, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (20, 'AUD-GONE', 'com.apple.m4a-audio', 10, NULL, ${hexLiteral(first)}, NULL, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZISPASSWORDPROTECTED) VALUES (30, 'NOTE-30', 1);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZISPASSWORDPROTECTED) VALUES (40, 'NOTE-40', 0);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZISPASSWORDPROTECTED) VALUES (50, 'NOTE-50', 0);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (51, 'AUD-51', 'com.apple.m4a-audio', 50, NULL, ${hexLiteral(first)}, NULL, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (52, 'AUD-52', 'public.mp3', 50, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER) VALUES (60, 'FOLDER-60');
      CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME VARCHAR);
      INSERT INTO Z_PRIMARYKEY VALUES (5, 'ICAttachment'), (9, 'ICNote'), (15, 'ICFolder');
      ALTER TABLE ZICCLOUDSYNCINGOBJECT ADD COLUMN Z_ENT INTEGER;
      UPDATE ZICCLOUDSYNCINGOBJECT SET Z_ENT = CASE
        WHEN Z_PK IN (10, 30, 40, 50) THEN 9 WHEN Z_PK = 60 THEN 15 ELSE 5 END;
    `;
    const sqlFile = join(dir, "setup.sql");
    writeFileSync(sqlFile, sql);
    execFileSync("sqlite3", [dbPath, `.read ${sqlFile}`]);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns top-level audio attachments in body order with per-attachment status", () => {
    const result = readAudioTranscripts(noteId(10), { dbPath });
    expect(result.bodyOrder).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.attachments.map((a) => [a.identifier, a.status])).toEqual([
      ["AUD-2", "ok"],
      ["AUD-1", "ok"],
      ["AUD-BAD", "undecodable"],
      ["AUD-EMPTY", "none"],
      ["AUD-NULL", "none"],
    ]);
    const [second, first, bad, empty, missing] = result.attachments;
    expect(first).toMatchObject({
      attachmentId: `x-coredata://${STORE}/ICAttachment/p11`,
      typeUti: "com.apple.m4a-audio",
      durationSeconds: 12.5,
      needsTranscription: false,
      fragmentCount: 1,
      wordCount: 3,
      text: "First recording.",
      speakers: ["Speaker 1"],
      summary: "A synthetic summary.",
    });
    expect(first.segments).toBeUndefined();
    // Parent duration is 0, so the fragment (child) durations are summed.
    expect(second).toMatchObject({ durationSeconds: 7.5, fragmentCount: 2, wordCount: 4 });
    expect(second.text).toBe("Take one\n\nTake two");
    expect(bad.reason).toBeTruthy();
    expect(empty).toMatchObject({ fragmentCount: 1, wordCount: 0, needsTranscription: true });
    expect(empty.text).toBeUndefined();
    expect(missing.fragmentCount).toBeUndefined();
  });

  it("returns word-level segments only when asked, capped per attachment", () => {
    const result = readAudioTranscripts(noteId(10), {
      dbPath,
      includeSegments: true,
      maxSegments: 3,
    });
    const second = result.attachments[0];
    expect(second.segments).toHaveLength(3);
    expect(second.segmentsTruncated).toBe(true);
    expect(second.segments!.map((s) => s.fragment)).toEqual([0, 0, 1]);
    const first = result.attachments[1];
    expect(first.segments).toEqual([
      { text: "First", start: 0, duration: 0.4, speaker: "Speaker 1" },
      { text: " recording", start: 0.5, duration: 0.4, speaker: "Speaker 1" },
      { text: ".", start: 1, duration: 0.4, speaker: "Speaker 1" },
    ]);
    expect(first.segmentsTruncated).toBeUndefined();
  });

  it("falls back to database order when the note body is unavailable", () => {
    const result = readAudioTranscripts(noteId(50), { dbPath });
    expect(result.bodyOrder).toBe(false);
    expect(result.attachments.map((a) => [a.identifier, a.status])).toEqual([
      ["AUD-51", "ok"],
      ["AUD-52", "none"],
    ]);
  });

  it("returns an empty list for a note without audio", () => {
    expect(readAudioTranscripts(noteId(40), { dbPath }).attachments).toEqual([]);
  });

  it("refuses password-protected notes", () => {
    expect(() => readAudioTranscripts(noteId(30), { dbPath })).toThrow(/password-protected/);
  });

  it("reports a missing note", () => {
    try {
      readAudioTranscripts(noteId(999), { dbPath });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AudioTranscriptError);
      expect((error as AudioTranscriptError).kind).toBe("not_found");
    }
  });

  // #194: a folder or attachment key is not a note without audio.
  it.each([60, 11])("reports the non-note key p%i as a missing note", (pk) => {
    try {
      readAudioTranscripts(noteId(pk), { dbPath });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AudioTranscriptError);
      expect((error as AudioTranscriptError).kind).toBe("not_found");
    }
  });

  it("rejects malformed ids before touching the database", () => {
    expect(() =>
      readAudioTranscripts("x-coredata://X/ICNote/p1; DROP TABLE x", { dbPath })
    ).toThrow(/Invalid note ID/);
  });

  it("reports missing required columns on an unknown schema", () => {
    const other = join(dir, "other.sqlite");
    execFileSync("sqlite3", [other, "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER);"]);
    expect(() => readAudioTranscripts(noteId(10), { dbPath: other })).toThrow(/lacks/);
  });

  it("omits optional columns the schema does not have", () => {
    const sql = buildTranscriptSql("7", new Set(["ZMERGEABLEDATA1"]));
    expect(sql).not.toContain("ZDURATION");
    expect(sql).not.toContain("ZNEEDSTRANSCRIPTION");
    expect(sql).not.toContain("ZISPASSWORDPROTECTED");
    expect(() => buildTranscriptSql("7 OR 1=1", new Set())).toThrow();
  });
});

describe("bodyAttachmentOrder", () => {
  it("lists attachment ids in body order without duplicates", () => {
    const doc = noteDocument([
      { id: "B", type: "com.apple.m4a-audio" },
      { id: "A", type: "public.jpeg" },
      { id: "B", type: "com.apple.m4a-audio" },
    ]);
    expect(bodyAttachmentOrder(doc)).toEqual(["B", "A"]);
  });
});
