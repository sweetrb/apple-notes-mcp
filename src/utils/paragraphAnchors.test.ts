/**
 * Paragraph anchors: matching on synthetic note bodies (moved, edited,
 * re-identified, split, duplicated and deleted paragraphs), and resolution,
 * refresh, re-minting and pruning against a throwaway fixture database through
 * the real /usr/bin/sqlite3. The live NoteStore is never touched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decodeNoteBlocks } from "./noteBlocks.js";
import { paragraphsOf, runParagraphIds, type NoteParagraphs } from "./noteParagraphs.js";
import {
  anchorFor,
  matchAnchor,
  noteByIdentifierSql,
  resolutionFor,
  resolveAnchor,
  setParagraphIdReminter,
  textFingerprint,
  textSimilarity,
} from "./paragraphAnchors.js";
import { AnchorRegistry } from "../services/anchorRegistry.js";
import {
  pruneParagraphAnchors,
  recordParagraphAnchors,
  registryLookup,
  resolveStoredAnchor,
} from "../services/paragraphAnchorOps.js";

const varint = (value: number): number[] => {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
};
const n = (field: number, value: number) => Buffer.from([...varint(field * 8), ...varint(value)]);
const b = (field: number, value: Buffer | string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes]);
};
const U = (fill: number) => {
  const h = Buffer.alloc(16, fill).toString("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** A run: text, optional paragraph style type (null = body), optional UUID fill byte. */
type Seg = [text: string, style?: number | null, id?: number];
const raw = (segs: Seg[]) => {
  const text = segs.map(([t]) => t).join("");
  const runs = segs.map(([t, style, id]) => {
    const para =
      style === undefined && id === undefined
        ? []
        : [
            b(
              2,
              Buffer.concat([
                ...(style === null || style === undefined ? [] : [n(1, style)]),
                ...(id === undefined ? [] : [b(9, Buffer.alloc(16, id))]),
              ])
            ),
          ];
    return b(5, Buffer.concat([n(1, t.length), ...para]));
  });
  return b(2, b(3, Buffer.concat([b(2, text), ...runs])));
};

const NOTE_UUID = "0A1B2C3D-0000-4000-8000-00000000000A";
const NOTE_ID = "x-coredata://STORE/ICNote/p10";
const note = (segs: Seg[], identifier: string | null = NOTE_UUID): NoteParagraphs => {
  const data = raw(segs);
  const paragraphs = paragraphsOf(decodeNoteBlocks(data), runParagraphIds(data), identifier);
  return { id: NOTE_ID, identifier, paragraphs, counts: { unique: 0, shared: 0, missing: 0 } };
};

const TITLE: Seg = ["Groceries\n", 0, 0x10];
const A: Seg = ["Alpha paragraph about apples\n", null, 0xa1];
const B: Seg = ["Bravo paragraph about bananas\n", null, 0xb2];
const C: Seg = ["Charlie paragraph about cherries\n", null, 0xc3];
const D: Seg = ["Delta paragraph about dates\n", null, 0xd4];
const base = note([TITLE, A, B, C, D]);
const CTEXT = "Charlie paragraph about cherries";
const anchorC = anchorFor(
  base,
  base.paragraphs.find((p) => p.text === CTEXT)!,
  {
    anchorId: "pa_000000000000000000000001",
    now: new Date("2026-09-24T12:00:00Z"),
  }
);
const resolve = (segs: Seg[], options = {}) => resolutionFor(anchorC, note(segs), options);

describe("anchorFor", () => {
  it("records the paragraph, its neighbours and its position", () => {
    expect(anchorC).toMatchObject({
      noteIdentifier: NOTE_UUID,
      noteId: NOTE_ID,
      paragraphId: U(0xc3),
      paragraphIdStatus: "unique",
      text: "charlie paragraph about cherries",
      fingerprint: textFingerprint("charlie paragraph about cherries"),
      prevFingerprint: textFingerprint("bravo paragraph about bananas"),
      nextFingerprint: textFingerprint("delta paragraph about dates"),
      blockIndex: 3,
      style: "body",
      createdAt: "2026-09-24T12:00:00.000Z",
    });
    const first = anchorFor(base, base.paragraphs[0], { anchorId: "x", now: new Date() });
    const last = anchorFor(base, base.paragraphs[4], { anchorId: "x", now: new Date() });
    expect(first.prevFingerprint).toBeNull();
    expect(last.nextFingerprint).toBeNull();
  });

  it("refuses a note without an identifier or a foreign paragraph", () => {
    const bare = note([TITLE, A], null);
    expect(() => anchorFor(bare, bare.paragraphs[0], { anchorId: "x", now: new Date() })).toThrow(
      /no stored identifier/
    );
    expect(() => anchorFor(base, bare.paragraphs[0], { anchorId: "x", now: new Date() })).toThrow(
      /does not belong/
    );
  });

  it("fingerprints and compares normalized text", () => {
    expect(textFingerprint("abc")).toMatch(/^[0-9a-f]{32}$/);
    expect(textSimilarity("abc", "abc")).toBe(1);
    expect(textSimilarity("", "abc")).toBe(0);
    expect(
      textSimilarity("charlie about cherries", "charlie about cherries and plums")
    ).toBeGreaterThan(0.7);
    expect(textSimilarity("charlie", "delta dates")).toBeLessThan(0.2);
    expect(textSimilarity("ab", "ab ")).toBeGreaterThan(0.5);
  });
});

describe("matching (fails closed)", () => {
  it("resolves an unchanged paragraph by its ID", () => {
    const r = resolve([TITLE, A, B, C, D]);
    expect(r).toMatchObject({
      status: "resolved",
      resolved: true,
      method: "paragraph-id",
      confidence: 1,
      needsReminting: false,
      url: `applenotes://showNote?identifier=${NOTE_UUID}&paragraphID=${U(0xc3)}`,
      changes: { textChanged: false, blockIndexChanged: false, paragraphIdChanged: false },
    });
  });

  it("follows a paragraph edited in place by its unique ID", () => {
    const r = resolve([TITLE, A, B, ["Charlie paragraph about sour cherries\n", null, 0xc3], D]);
    expect(r.status).toBe("resolved");
    expect(r.method).toBe("paragraph-id");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.confidence).toBeLessThan(1);
    expect(r.changes).toMatchObject({ textChanged: true, paragraphIdChanged: false });
    expect(r.match!.text).toBe("Charlie paragraph about sour cherries");
  });

  it("follows a moved paragraph", () => {
    const r = resolve([TITLE, C, A, B, D]);
    expect(r.status).toBe("resolved");
    expect(r.match!.blockIndex).toBe(1);
    expect(r.changes!.blockIndexChanged).toBe(true);
  });

  it("finds a paragraph whose ID changed by its exact text", () => {
    const r = resolve([TITLE, A, B, [C[0], null, 0x77], D]);
    expect(r).toMatchObject({ status: "resolved", method: "exact-text", confidence: 0.95 });
    expect(r.url).toContain(U(0x77));
    expect(r.changes!.paragraphIdChanged).toBe(true);
    // Moved as well: neighbours no longer match, so confidence drops.
    expect(resolve([TITLE, [C[0], null, 0x77], A, B, D]).confidence).toBe(0.85);
    // minConfidence applies to every step, not only the fuzzy one.
    const strict = resolve([TITLE, [C[0], null, 0x77], A, B, D], { minConfidence: 0.9 });
    expect(strict).toMatchObject({ status: "low-confidence", resolved: false });
    expect(strict.url).toBeUndefined();
  });

  it("reports needs-reminting when the paragraph lost its ID", () => {
    const r = resolve([TITLE, A, B, [C[0]], D]);
    expect(r).toMatchObject({
      status: "needs-reminting",
      needsReminting: true,
      resolved: false,
      method: "exact-text",
      match: { blockIndex: 3, paragraphId: null, paragraphIdStatus: "missing" },
    });
    expect(r.url).toBeUndefined();
    expect(r.message).toMatch(/no paragraph ID/);
  });

  it("reports needs-reminting when a split shares the ID", () => {
    // One run across two paragraphs: Notes copied the UUID onto the new one.
    const r = resolve([TITLE, A, B, [`${C[0]}and a second half\n`, null, 0xc3], D]);
    expect(r).toMatchObject({
      status: "needs-reminting",
      method: "paragraph-id",
      match: { blockIndex: 3, paragraphIdStatus: "shared", sharedWith: 1 },
    });
    expect(r.url).toBeUndefined();
  });

  it("picks the original of a duplicated paragraph only by its neighbours", () => {
    // The copy carries the same UUID; the original still sits between B and D.
    const r = resolve([TITLE, A, C, B, C, D]);
    expect(r).toMatchObject({ status: "needs-reminting", method: "paragraph-id", confidence: 0.9 });
    expect(r.match!.blockIndex).toBe(4);
  });

  it("refuses to choose between equally good duplicates", () => {
    const r = resolve([TITLE, A, B, [C[0], null, 0x71], [C[0], null, 0x72], D]);
    expect(r).toMatchObject({ status: "ambiguous", resolved: false, candidates: 2 });
    expect(r.url).toBeUndefined();
    expect(r.match).toBeUndefined();
    // Same UUID on both copies, same tie: still ambiguous.
    expect(resolve([TITLE, A, B, C, C, D]).status).toBe("ambiguous");
    // Copies with no recorded neighbour beside either are just as ambiguous.
    expect(resolve([TITLE, [C[0], null, 0x71], A, [C[0], null, 0x72]]).status).toBe("ambiguous");
    // One neighbour is enough to tell exact copies apart.
    expect(resolve([TITLE, [C[0], null, 0x71], A, [C[0], null, 0x72], D]).match!.blockIndex).toBe(
      3
    );
  });

  it("finds an edited, re-identified paragraph between its neighbours", () => {
    const r = resolve([
      TITLE,
      A,
      B,
      ["Charlie paragraph about cherries and plums\n", null, 0x78],
      D,
    ]);
    expect(r.status).toBe("resolved");
    expect(r.method).toBe("text-and-neighbours");
    expect(r.confidence).toBeGreaterThan(0.6);
    expect(r.confidence).toBeLessThan(0.8);
    expect(r.url).toContain(U(0x78));
  });

  it("honours minConfidence and reports low-confidence without a url", () => {
    const segs: Seg[] = [
      TITLE,
      A,
      B,
      ["Charlie paragraph about cherries and plums\n", null, 0x78],
      D,
    ];
    const r = resolve(segs, { minConfidence: 0.95 });
    expect(r).toMatchObject({ status: "low-confidence", resolved: false });
    expect(r.url).toBeUndefined();
    expect(r.match!.blockIndex).toBe(3);
  });

  it("refuses a fuzzy tie", () => {
    const edit = (s: string, id: number): Seg => [`${s}\n`, null, id];
    // Anchor between B and D; now two similar edits sit there, one beside each.
    const before = note([A, B, C, D]);
    const anchor = anchorFor(before, before.paragraphs[2], {
      anchorId: "x",
      now: new Date(),
    });
    const r = resolutionFor(
      anchor,
      note([
        A,
        B,
        edit("Charlie paragraph about cherries X", 0x61),
        edit("Charlie paragraph about cherries Y", 0x62),
        D,
      ])
    );
    expect(r.status).toBe("ambiguous");
  });

  it("does not mistake a neighbour for a deleted paragraph", () => {
    expect(resolve([TITLE, A, B, D])).toMatchObject({ status: "not-found", confidence: 0 });
    // Replaced by unrelated text between the same neighbours.
    expect(resolve([TITLE, A, B, ["Something else entirely\n", null, 0x79], D]).status).toBe(
      "not-found"
    );
    // Similar text next to only one neighbour scores below the default minimum.
    const lone = resolve([TITLE, A, B, ["Charlie paragraph about cherry pie\n", null, 0x7a]]);
    expect(lone).toMatchObject({ status: "low-confidence", resolved: false });
    expect(lone.url).toBeUndefined();
    // Unrelated text next to one neighbour is not a candidate at all.
    expect(resolve([TITLE, A, B, ["Unrelated words\n", null, 0x7b]]).status).toBe("not-found");
  });

  it("gives no url when the note has no identifier", () => {
    const r = resolutionFor(anchorC, note([TITLE, A, B, C, D], null));
    expect(r.status).toBe("needs-reminting");
  });

  it("matchAnchor reports indices and candidates", () => {
    expect(matchAnchor(anchorC, note([TITLE, A, B, C, D]).paragraphs)).toEqual({
      status: "matched",
      index: 3,
      method: "paragraph-id",
      confidence: 1,
    });
    expect(matchAnchor(anchorC, [])).toEqual({ status: "not-found", confidence: 0 });
  });
});

// Each resolution spawns several sqlite3 processes; allow for a busy machine.
describe("resolution against a fixture store (real sqlite3)", { timeout: 60000 }, () => {
  let dir: string;
  let db: string;
  let registry: AnchorRegistry;
  const STORE = "5A0E-8888";
  const hex = (buf: Buffer) => `X'${buf.toString("hex")}'`;
  const sql = (statements: string[]) =>
    execFileSync("/usr/bin/sqlite3", [db, statements.join("\n")]);
  const setBody = (pk: number, segs: Seg[]) =>
    sql([`UPDATE ZICNOTEDATA SET ZDATA = ${hex(gzipSync(raw(segs)))} WHERE ZNOTE = ${pk};`]);
  const stored = (pk: number, identifier: string): NoteParagraphs => {
    const data = raw([TITLE, A, B, C, D]);
    const paragraphs = paragraphsOf(decodeNoteBlocks(data), runParagraphIds(data), identifier);
    return {
      id: `x-coredata://${STORE}/ICNote/p${pk}`,
      identifier,
      paragraphs,
      counts: { unique: 0, shared: 0, missing: 0 },
    };
  };
  const anchorIn = (pk: number, identifier: string, text = CTEXT) => {
    const n = stored(pk, identifier);
    return recordParagraphAnchors(n, [n.paragraphs.find((p) => p.text === text)!], registry)[0]
      .anchor;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "paragraph-anchors-"));
    db = join(dir, "NoteStore.sqlite");
    sql([
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT, ZFOLDER INTEGER, ZOWNER INTEGER, ZFOLDERTYPE INTEGER, ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER);",
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
      "CREATE TABLE Z_METADATA (Z_UUID TEXT);",
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
      "INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote'), (7, 'ICFolder');",
      `INSERT INTO Z_METADATA VALUES ('${STORE}');`,
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZMARKEDFORDELETION) VALUES (1, 7, 'F1', 'Home', 0, 0), (2, 7, 'F2', 'Recently Deleted', 1, 0);",
      [
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZMARKEDFORDELETION, ZISPASSWORDPROTECTED) VALUES",
        `(10, 3, '${NOTE_UUID}', 'Groceries', 1, 0, 0),`,
        "(11, 3, 'bbbbbbbb-0000-4000-8000-00000000000b', 'Lower', 1, 0, 0),",
        "(12, 3, 'CCCCCCCC-0000-4000-8000-00000000000C', 'Trashed', 2, 0, 0),",
        "(13, 3, 'DDDDDDDD-0000-4000-8000-00000000000D', 'Locked', 1, 0, 1),",
        "(14, 3, 'EEEEEEEE-0000-4000-8000-00000000000E', 'Tombstone', 1, 1, 0);",
      ].join(" "),
      ...[10, 11, 12, 14].map(
        (pk) =>
          `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (${pk}, ${hex(gzipSync(raw([TITLE, A, B, C, D])))});`
      ),
      "INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (13, X'00', X'0102');",
    ]);
    registry = new AnchorRegistry(join(dir, "support", "paragraph-anchors.json"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    setParagraphIdReminter(undefined);
    setBody(10, [TITLE, A, B, C, D]);
  });

  it("builds the identifier lookup with bound values only", () => {
    const text = noteByIdentifierSql(new Set(["ZFOLDER", "ZIDENTIFIER"]));
    expect(text).toContain("CAST(@upper AS TEXT)");
    expect(text).not.toContain(NOTE_UUID);
  });

  it("resolves by identifier, including a lower-case stored identifier", () => {
    const r = resolveAnchor(anchorIn(10, NOTE_UUID), { dbPath: db });
    expect(r).toMatchObject({ status: "resolved", noteId: `x-coredata://${STORE}/ICNote/p10` });
    const lower = anchorIn(11, "BBBBBBBB-0000-4000-8000-00000000000B");
    expect(resolveAnchor(lower, { dbPath: db }).url).toBe(
      `applenotes://showNote?identifier=BBBBBBBB-0000-4000-8000-00000000000B&paragraphID=${U(0xc3)}`
    );
    registry.remove([lower.anchorId]);
  });

  it("reports deleted, trashed, locked and missing notes without matching", () => {
    const check = (identifier: string) =>
      resolveAnchor({ ...anchorC, noteIdentifier: identifier }, { dbPath: db });
    expect(check("CCCCCCCC-0000-4000-8000-00000000000C").status).toBe("note-deleted");
    expect(check("EEEEEEEE-0000-4000-8000-00000000000E").status).toBe("note-deleted");
    expect(check("DDDDDDDD-0000-4000-8000-00000000000D").status).toBe("note-unreadable");
    expect(check("FFFFFFFF-0000-4000-8000-00000000000F")).toMatchObject({
      status: "note-not-found",
      resolved: false,
    });
    expect(() => resolveAnchor(anchorC, { dbPath: join(dir, "missing.sqlite") })).toThrow(
      /Full Disk Access/
    );
  });

  it("tracks an edit and refreshes the stored anchor only when confident", async () => {
    const anchor = anchorIn(10, NOTE_UUID);
    setBody(10, [TITLE, A, B, ["Charlie paragraph about cherries and plums\n", null, 0x78], D]);
    const fuzzy = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      refresh: true,
    });
    expect(fuzzy).toMatchObject({ status: "resolved", method: "text-and-neighbours" });
    expect(fuzzy.refreshed).toBeUndefined();
    expect(fuzzy.refreshSkipped).toMatch(/below 0.8/);

    setBody(10, [TITLE, A, [C[0], null, 0x79], B, D]);
    const moved = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      refresh: true,
      now: () => new Date("2026-09-25T00:00:00Z"),
    });
    expect(moved).toMatchObject({ status: "resolved", method: "exact-text", refreshed: true });
    const saved = registry.get(anchor.anchorId);
    expect(saved).toMatchObject({
      paragraphId: U(0x79),
      blockIndex: 2,
      createdAt: anchor.createdAt,
      updatedAt: "2026-09-25T00:00:00.000Z",
    });
    // The refreshed anchor now resolves by its new ID.
    expect((await resolveStoredAnchor(anchor.anchorId, { registry, dbPath: db })).method).toBe(
      "paragraph-id"
    );
    registry.remove([anchor.anchorId]);
  });

  it("reports writer-unavailable, then uses an installed re-minting writer", async () => {
    const anchor = anchorIn(10, NOTE_UUID);
    setBody(10, [TITLE, A, B, [C[0]], D]);
    const without = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      remint: true,
    });
    expect(without).toMatchObject({
      status: "needs-reminting",
      remint: { attempted: false, reason: "writer-unavailable" },
    });

    const calls: unknown[] = [];
    setParagraphIdReminter(async (request) => {
      calls.push(request);
      setBody(10, [TITLE, A, B, [C[0], null, 0x5e], D]);
      return { paragraphId: U(0x5e) };
    });
    const healed = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      remint: true,
    });
    expect(calls).toEqual([
      {
        anchorId: anchor.anchorId,
        noteId: `x-coredata://${STORE}/ICNote/p10`,
        noteIdentifier: NOTE_UUID,
        blockIndex: 3,
        expectedText: CTEXT,
        currentParagraphId: null,
      },
    ]);
    expect(healed).toMatchObject({
      status: "resolved",
      remint: { attempted: true, paragraphId: U(0x5e) },
    });
    expect(healed.url).toContain(U(0x5e));

    setParagraphIdReminter(async () => {
      throw new Error("revision conflict");
    });
    setBody(10, [TITLE, A, B, [C[0]], D]);
    const failed = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      remint: true,
    });
    expect(failed).toMatchObject({
      status: "needs-reminting",
      remint: { attempted: true, reason: "writer-failed", message: "revision conflict" },
    });
    expect(failed.remint).not.toHaveProperty("committed");

    // A writer error's committed state is passed on, so a timeout reads as uncertain.
    setParagraphIdReminter(async () => {
      throw Object.assign(new Error("timed out"), { committed: "unknown" });
    });
    const uncertain = await resolveStoredAnchor(anchor.anchorId, {
      registry,
      dbPath: db,
      remint: true,
    });
    expect(uncertain.remint).toEqual({
      attempted: true,
      reason: "writer-failed",
      message: "timed out",
      committed: "unknown",
    });
    setBody(10, [TITLE, A, B, C, D]);
    expect(
      (await resolveStoredAnchor(anchor.anchorId, { registry, dbPath: db, remint: true })).remint
    ).toEqual({ attempted: false, reason: "not-needed" });
    registry.remove([anchor.anchorId]);
  });

  it("prunes only anchors that no longer resolve, dry run first", () => {
    const live = anchorIn(10, NOTE_UUID);
    const gone = anchorIn(10, NOTE_UUID, "Delta paragraph about dates");
    const trashed = anchorIn(12, "CCCCCCCC-0000-4000-8000-00000000000C");
    const orphan = registry.record([
      { ...live, noteIdentifier: "FFFFFFFF-0000-4000-8000-00000000000F" },
    ])[0].anchor;
    setBody(10, [TITLE, A, B, C]);

    const dry = pruneParagraphAnchors({ registry, dbPath: db });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toEqual([]);
    expect(dry.stale.map((s) => [s.anchorId, s.status]).sort()).toEqual(
      [
        [gone.anchorId, "not-found"],
        [orphan.anchorId, "note-not-found"],
      ].sort()
    );
    expect(registry.load()).toHaveLength(4);

    const applied = pruneParagraphAnchors({ registry, dbPath: db, dryRun: false });
    expect(applied.removed.sort()).toEqual([gone.anchorId, orphan.anchorId].sort());
    expect(registry.load().map((a) => a.anchorId)).toEqual([live.anchorId, trashed.anchorId]);

    // note-deleted is kept unless asked for; listed ids are removed as given.
    expect(
      pruneParagraphAnchors({ registry, dbPath: db, statuses: ["note-deleted"] }).stale
    ).toHaveLength(1);
    const byId = pruneParagraphAnchors({ registry, anchorIds: [trashed.anchorId], dryRun: false });
    expect(byId).toMatchObject({ examined: 1, removed: [trashed.anchorId] });
    expect(
      pruneParagraphAnchors({ registry, dbPath: db, noteIdentifier: NOTE_UUID.toLowerCase() })
        .examined
    ).toBe(1);
    registry.remove([live.anchorId]);
  });

  it("gives the resolver service undefined for an unknown anchor", () => {
    const anchor = anchorIn(10, NOTE_UUID);
    const lookup = registryLookup(registry, db);
    expect(lookup(anchor.anchorId)!.status).toBe("resolved");
    expect(lookup("pa_ffffffffffffffffffffffff")).toBeUndefined();
    registry.remove([anchor.anchorId]);
  });
});
