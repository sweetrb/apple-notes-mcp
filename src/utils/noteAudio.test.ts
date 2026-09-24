import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNoteStoreFixture } from "./fixtures/noteStoreFixture.js";
import { audioRowsSql, countWords, readAudioAssets, resolveMediaPath } from "./noteAudio.js";
import { AttachmentStoreError } from "./attachmentAssets.js";

const STORE = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const noteId = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;

// A synthetic group container whose Accounts tree has two account folders,
// with files in the second one.
const container = realpathSync.native(mkdtempSync(join(tmpdir(), "notes-container-")));
const accounts = join(container, "Accounts");
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "notes-outside-")));
mkdirSync(join(accounts, "ACCOUNT-A"), { recursive: true });
// The same media identifier in the other account, to prove the note's account wins.
mkdirSync(join(accounts, "ACCOUNT-A", "Media", "M-3"), { recursive: true });
const otherAccountVoice = join(accounts, "ACCOUNT-A", "Media", "M-3", "voice.mp3");
writeFileSync(otherAccountVoice, "other account");
const media = (id: string, gen: string | null, file: string) => {
  const dir = gen
    ? join(accounts, "ACCOUNT-B", "Media", id, gen)
    : join(accounts, "ACCOUNT-B", "Media", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), "audio");
  return join(dir, file);
};
const take1 = media("M-1", "G1", "take1.m4a");
const take2 = media("M-2", "G2", "take2.m4a");
const plain = media("M-3", null, "voice.mp3");
// A media folder whose file is a symlink pointing outside the accounts root.
mkdirSync(join(accounts, "ACCOUNT-B", "Media", "M-4", "G4"), { recursive: true });
writeFileSync(join(outside, "secret.m4a"), "x");
symlinkSync(
  join(outside, "secret.m4a"),
  join(accounts, "ACCOUNT-B", "Media", "M-4", "G4", "escape.m4a")
);

const fixture = createNoteStoreFixture([
  { pk: 1, ent: "ICNote", account: 50 },
  { pk: 2, ent: "ICNote", locked: 1 },
  { pk: 50, ent: "ICAccount", identifier: "ACCOUNT-B" },
  // A recording with two live takes and one take marked for deletion.
  {
    pk: 10,
    ent: "ICAttachment",
    note: 1,
    uti: "com.apple.m4a-audio",
    identifier: "REC",
    duration: null,
  },
  {
    pk: 11,
    ent: "ICAttachment",
    parent: 10,
    uti: "public.mpeg-4-audio",
    identifier: "T1",
    media: 101,
    duration: 30,
  },
  {
    pk: 12,
    ent: "ICAttachment",
    parent: 10,
    uti: "public.mpeg-4-audio",
    identifier: "T2",
    media: 102,
    duration: 12.5,
  },
  {
    pk: 13,
    ent: "ICAttachment",
    parent: 10,
    uti: "public.mpeg-4-audio",
    identifier: "T3",
    media: 102,
    deleted: 1,
  },
  // A plain audio file attached directly, and one whose media is not on disk.
  {
    pk: 20,
    ent: "ICAttachment",
    note: 1,
    uti: "public.mp3",
    identifier: "MP3",
    media: 103,
    duration: 4,
  },
  {
    pk: 21,
    ent: "ICAttachment",
    note: 1,
    uti: "com.apple.m4a-audio",
    identifier: "GONE",
    media: 104,
  },
  // Not audio, and audio in another note.
  { pk: 30, ent: "ICAttachment", note: 1, uti: "public.jpeg", identifier: "IMG" },
  { pk: 31, ent: "ICAttachment", note: 2, uti: "public.mp3", identifier: "LOCKED", media: 103 },
  { pk: 101, ent: "ICMedia", identifier: "M-1", generation: "G1", filename: "take1.m4a" },
  { pk: 102, ent: "ICMedia", identifier: "M-2", generation: "G2", filename: "take2.m4a" },
  { pk: 103, ent: "ICMedia", identifier: "M-3", filename: "voice.mp3" },
  { pk: 104, ent: "ICMedia", identifier: "M-9", generation: "G9", filename: "missing.m4a" },
]);
afterAll(() => {
  fixture.cleanup();
  rmSync(container, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("readAudioAssets (real sqlite3, fixture database)", () => {
  it("returns recordings with their live takes and plain audio files, with resolved paths", () => {
    const assets = readAudioAssets(noteId(1), { dbPath: fixture.dbPath, containerDir: container });
    expect(assets.map((a) => [a.pk, a.typeUti, a.identifier, a.durationSeconds])).toEqual([
      [10, "com.apple.m4a-audio", "REC", 42.5],
      [20, "public.mp3", "MP3", 4],
      [21, "com.apple.m4a-audio", "GONE", null],
    ]);
    expect(assets[0].takes).toEqual([
      {
        attachmentId: `x-coredata://${STORE}/ICAttachment/p11`,
        identifier: "T1",
        durationSeconds: 30,
        path: take1,
      },
      {
        attachmentId: `x-coredata://${STORE}/ICAttachment/p12`,
        identifier: "T2",
        durationSeconds: 12.5,
        path: take2,
      },
    ]);
    expect(assets[1].takes).toEqual([
      {
        attachmentId: `x-coredata://${STORE}/ICAttachment/p20`,
        identifier: "MP3",
        durationSeconds: 4,
        path: plain,
      },
    ]);
    expect(assets[2].takes[0].path).toBeNull();
  });

  it("refuses locked and missing notes and malformed ids", () => {
    const opts = { dbPath: fixture.dbPath, containerDir: container };
    expect(() => readAudioAssets(noteId(2), opts)).toThrow(/password-protected/);
    expect(() => readAudioAssets(noteId(3), opts)).toThrow(/No note found/);
    expect(() => readAudioAssets("x-coredata://X/ICNote/p1'", opts)).toThrow(AttachmentStoreError);
  });

  it("works without a generation column and reports missing required columns", () => {
    const old = createNoteStoreFixture([{ pk: 1, ent: "ICNote" }]);
    try {
      execFileSync("sqlite3", [
        old.dbPath,
        "ALTER TABLE ZICCLOUDSYNCINGOBJECT DROP COLUMN ZGENERATION1;" +
          "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNOTE, ZTYPEUTI, ZIDENTIFIER, ZMEDIA, ZMARKEDFORDELETION) VALUES (5, 5, 1, 'public.mp3', 'A', 6, 0);" +
          "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME) VALUES (6, 11, 'M-3', 'voice.mp3');",
      ]);
      // This note has no account link, so every account folder is probed in order.
      const [asset] = readAudioAssets(noteId(1), { dbPath: old.dbPath, containerDir: container });
      expect(asset.takes[0].path).toBe(otherAccountVoice);
      execFileSync("sqlite3", [
        old.dbPath,
        "ALTER TABLE ZICCLOUDSYNCINGOBJECT ADD COLUMN ZGENERATION VARCHAR;",
      ]);
      expect(
        readAudioAssets(noteId(1), { dbPath: old.dbPath, containerDir: container })
      ).toHaveLength(1);
      expect(audioRowsSql(new Set(), "ZGENERATION")).toContain("m.ZGENERATION,");
      execFileSync("sqlite3", [
        old.dbPath,
        "ALTER TABLE ZICCLOUDSYNCINGOBJECT DROP COLUMN ZFILENAME;",
      ]);
      expect(() => readAudioAssets(noteId(1), { dbPath: old.dbPath })).toThrow(/lacks ZFILENAME/);
    } finally {
      old.cleanup();
    }
  });

  it("keeps caller input out of the SQL", () => {
    for (const column of ["ZGENERATION1", "ZGENERATION", null] as const) {
      const sql = audioRowsSql(new Set(["ZMARKEDFORDELETION"]), column);
      expect(sql).toContain("t.ZNOTE = @pk");
      expect(sql).toContain("COALESCE(t.ZMARKEDFORDELETION, 0) = 0");
      expect(sql).toContain("COALESCE(k.ZMARKEDFORDELETION, 0) = 0");
      expect(sql).not.toMatch(/ZNOTE = \d/);
      expect(sql.endsWith("SELECT NULL;")).toBe(true);
    }
    expect(audioRowsSql(new Set(["ZACCOUNT2", "ZACCOUNT6"]), null)).toContain(
      "acc.Z_PK IN (n.ZACCOUNT2, n.ZACCOUNT6)"
    );
  });
});

describe("resolveMediaPath", () => {
  it("rejects traversal and separators in database-supplied segments", () => {
    for (const bad of [
      { identifier: "..", generation: "G1", filename: "take1.m4a" },
      { identifier: "M-1", generation: "G1", filename: "../take1.m4a" },
      { identifier: "M-1/..", generation: "G1", filename: "take1.m4a" },
      { identifier: null, generation: null, filename: "x" },
      null,
    ])
      expect(resolveMediaPath(bad, "ACCOUNT-B", container)).toBeNull();
  });

  it("falls back to the flat layout and refuses symlinks that leave the account folder", () => {
    expect(
      resolveMediaPath(
        { identifier: "M-3", generation: "GX", filename: "voice.mp3" },
        "ACCOUNT-B",
        container
      )
    ).toBe(plain);
    expect(
      resolveMediaPath(
        { identifier: "M-4", generation: "G4", filename: "escape.m4a" },
        "ACCOUNT-B",
        container
      )
    ).toBeNull();
  });

  it("uses the note's account, and probes every account folder when it is unknown", () => {
    const voice = { identifier: "M-3", generation: null, filename: "voice.mp3" };
    expect(resolveMediaPath(voice, "ACCOUNT-A", container)).toBe(otherAccountVoice);
    expect(resolveMediaPath(voice, "ACCOUNT-B", container)).toBe(plain);
    // Unknown or unsafe account: the first account folder (sorted) holding the file.
    expect(resolveMediaPath(voice, null, container)).toBe(otherAccountVoice);
    expect(resolveMediaPath(voice, "../ACCOUNT-B", container)).toBe(otherAccountVoice);
    expect(
      resolveMediaPath(
        { identifier: "M-1", generation: "G1", filename: "take1.m4a" },
        "NOPE",
        container
      )
    ).toBe(take1);
  });

  it("returns null when the container cannot be read", () => {
    expect(
      resolveMediaPath(
        { identifier: "M-1", generation: "G1", filename: "take1.m4a" },
        null,
        join(outside, "nope")
      )
    ).toBeNull();
  });
});

describe("countWords", () => {
  it("counts runs containing letters or digits", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  Hello, world — 42 times!  ")).toBe(4);
    expect(countWords("città è bella")).toBe(3);
  });
});
