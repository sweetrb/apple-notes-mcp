/**
 * Security regression against REAL Notes.app (audit finding 1, overwrite part).
 *
 * The unit test in src/utils/privateWritePaths.security.test.ts emulates
 * Notes' AppleScript `save`, so it cannot show that the real `save` replaces a
 * file that already exists. This test does it for real: it creates a note,
 * attaches an attacker-controlled file, then asks `saveAttachmentById` to save
 * that attachment over an existing file and checks whether the file survives.
 *
 * - The control test saves to a fresh path. It must pass, otherwise a failing
 *   save would make the overwrite test pass for the wrong reason.
 * - The overwrite test asserts the safe outcome. Verified on macOS 27: Notes
 *   refuses with NSCocoaErrorDomain 516 (EEXIST) and the file survives, so the
 *   overwrite suspected in the audit does not occur. The test guards against a
 *   Notes.app or tool change that would start replacing files.
 *
 * Every note it creates is deleted again; files live in a private temp dir.
 * Self-skips without a writable Notes account or with
 * APPLE_NOTES_MCP_INTEGRATION_SKIP_LIVE=1.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppleNotesManager } from "../src/services/appleNotesManager.js";

const USER_ORIGINAL = "the user's original data - must survive\n";

let mgr: AppleNotesManager;
let liveAccount: string | null = null;
let workDir: string;
const createdNotes: string[] = [];

function deleteNote(id: string) {
  return mgr.deleteNoteByIdIfUnchanged(id, mgr.getNoteContentById(id)).status;
}

beforeAll(() => {
  mgr = new AppleNotesManager();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "sec-save-overwrite-")));
  if (process.env.APPLE_NOTES_MCP_INTEGRATION_SKIP_LIVE === "1") return;
  try {
    for (const account of mgr.listAccounts()) {
      const probe = mgr.createNote("__mcp_probe__", "probe", [], undefined, account.name);
      if (!probe?.id) continue;
      if (deleteNote(probe.id) !== "deleted")
        throw new Error(`probe note ${probe.id} could not be deleted; it is still in Notes`);
      liveAccount = account.name;
      break;
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError) throw error;
    if (error instanceof Error && error.message.startsWith("probe note")) throw error;
  }
});

afterEach(() => {
  const failures: string[] = [];
  for (const id of createdNotes.splice(0)) {
    const status = deleteNote(id);
    if (status !== "deleted") failures.push(`${id} (${status})`);
  }
  if (failures.length) throw new Error(`Fixture notes left in Notes: ${failures.join(", ")}`);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A real note in Notes.app holding one real attachment with `payload` as its bytes. */
function noteWithAttachment(payload: string): { noteId: string; attachmentId: string } {
  const marker = `sec-overwrite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const note = mgr.createNote(
    `Security test ${marker}`,
    "shared note body",
    [],
    undefined,
    liveAccount!
  );
  if (!note?.id) throw new Error("Could not create the fixture note");
  createdNotes.push(note.id);

  const payloadPath = join(workDir, `${marker}.txt`);
  writeFileSync(payloadPath, payload);
  const attachmentId = mgr.addAttachmentById(note.id, mgr.getNoteContentById(note.id), payloadPath);
  return { noteId: note.id, attachmentId };
}

describe("finding 1 (live): save-attachment over an existing file", { timeout: 120_000 }, () => {
  it("control: real Notes save writes the attachment to a fresh path", (ctx) => {
    if (!liveAccount) ctx.skip();
    const payload = `ATTACKER PAYLOAD ${Date.now()}\n`;
    const { noteId, attachmentId } = noteWithAttachment(payload);
    const fresh = join(workDir, "fresh-destination.txt");

    const result = mgr.saveAttachmentById(noteId, attachmentId, fresh);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(readFileSync(fresh, "utf8")).toBe(payload);
  });

  it("does not replace a file that already exists", (ctx) => {
    if (!liveAccount) ctx.skip();
    const payload = `ATTACKER PAYLOAD ${Date.now()}\n`;
    const { noteId, attachmentId } = noteWithAttachment(payload);
    const victim = join(workDir, "victim-existing.txt");
    writeFileSync(victim, USER_ORIGINAL);

    const result = mgr.saveAttachmentById(noteId, attachmentId, victim);

    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe(USER_ORIGINAL);
    expect(result.success).toBe(false);
  });
});
