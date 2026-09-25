/**
 * Sync-state reads and the move-in-place nudge. The writer is faked in
 * memory (installation files and spawn), and AppleScript, sleep, and the
 * clock are injected, so no Notes data is touched.
 */
import { describe, expect, it } from "vitest";
import type { spawnSync } from "node:child_process";
import { sha256Hex } from "./privateHelper.js";
import {
  MAX_SYNC_TARGETS,
  checkFolderAdoption,
  folderAdoptionScript,
  moveInPlaceScript,
  notesRunningForThisUser,
  parseFolderAdoption,
  nudgeInPlace,
  nudgeRefusal,
  readSyncState,
  syncPush,
  syncTargets,
  uploadRecorded,
  defaultNudgeDeps,
  type NudgeDeps,
  type SyncObjectState,
} from "./privateSyncNudge.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const FOLDER = "11111111-2222-3333-4444-555555555555";
const NOTE_URI = "x-coredata://ABCDEF01-2345/ICNote/p42";
const FOLDER_URI = "x-coredata://ABCDEF01-2345/ICFolder/p7";

function noteState(overrides: Partial<SyncObjectState> = {}): SyncObjectState {
  return {
    identifier: NOTE,
    found: true,
    kind: "note",
    objectURI: NOTE_URI,
    markedForDeletion: false,
    inICloudAccount: true,
    cloudStateAvailable: true,
    currentLocalVersion: 5,
    latestVersionSyncedToCloud: 4,
    uploadPending: true,
    folderIdentifier: FOLDER,
    folderObjectURI: FOLDER_URI,
    passwordProtected: false,
    deletedOrInTrash: false,
    sharedViaICloud: false,
    revision: "r1:" + "a".repeat(64),
    ...overrides,
  };
}

/** In-memory writer: every read_sync_state call returns the next snapshot. */
function fakeWriter(snapshots: Array<Record<string, unknown>>, requests: unknown[] = []) {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    protocolVersion: PRIVATE_WRITER_PROTOCOL,
    sourceSha256: sha256Hex("src"),
    binarySha256: sha256Hex("bin"),
    builtAt: "x",
    osVersion: "27.2",
    compiler: "clang",
  });
  let call = 0;
  const spawn = ((_bin: string, _args: string[], options: { input: string }) => {
    requests.push(JSON.parse(options.input));
    const snapshot = snapshots[Math.min(call++, snapshots.length - 1)];
    return { status: 0, stdout: JSON.stringify(snapshot), stderr: "", signal: null };
  }) as unknown as typeof spawnSync;
  const deps: PrivateHelperDeps = defaultWriterDeps({
    env: {
      APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
      APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
      APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: "/fake",
    },
    platform: "darwin",
    sourcePath: "/fake/src.m",
    exists: () => true,
    readFile: (path) =>
      Buffer.from(
        path.endsWith(WRITER_MANIFEST_NAME) ? manifest : path.endsWith(".m") ? "src" : "bin"
      ),
    spawn,
  });
  return deps;
}

function snapshot(objects: SyncObjectState[], extra: Record<string, unknown> = {}) {
  return { status: "ok", objects, pendingUploadCount: 3, syncHostRunning: true, ...extra };
}

function nudgeDeps(
  helper: PrivateHelperDeps,
  scripts: string[] = [],
  result = { success: true, output: "moved" } as {
    success: boolean;
    output: string;
    error?: string;
  }
): NudgeDeps {
  let clock = 0;
  return defaultNudgeDeps({
    helper,
    runAppleScript: (script) => {
      scripts.push(script);
      return result;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
}

describe("syncTargets and pure helpers", () => {
  it("validates and de-duplicates identifiers", () => {
    expect(syncTargets([NOTE, NOTE])).toEqual([NOTE]);
    expect(() => syncTargets([])).toThrow(PrivateWriteError);
    expect(() => syncTargets(["nope"])).toThrow(/UUIDs/);
    const many = Array.from(
      { length: MAX_SYNC_TARGETS + 1 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`
    );
    expect(() => syncTargets(many)).toThrow(/1-50/);
  });

  it("uploadRecorded needs both counters and a caught-up sync version", () => {
    expect(uploadRecorded(noteState())).toBe(false);
    expect(uploadRecorded(noteState({ latestVersionSyncedToCloud: 5 }))).toBe(true);
    expect(uploadRecorded(noteState({ currentLocalVersion: undefined }))).toBe(false);
    expect(uploadRecorded(noteState({ found: false }))).toBe(false);
  });

  it("nudgeRefusal names every reason a note cannot be nudged", () => {
    expect(nudgeRefusal(noteState())).toBeNull();
    expect(nudgeRefusal({ identifier: NOTE, found: false })).toBe("not_found");
    expect(nudgeRefusal({ identifier: NOTE, found: false, reason: "ambiguous" })).toBe("ambiguous");
    expect(nudgeRefusal(noteState({ uploadPending: false }))).toBe("nothing_pending");
    expect(nudgeRefusal(noteState({ kind: "folder" }))).toBe("folders_need_relaunch");
    expect(nudgeRefusal(noteState({ inICloudAccount: false }))).toBe("not_icloud");
    expect(nudgeRefusal(noteState({ deletedOrInTrash: true }))).toBe("deleted");
    expect(nudgeRefusal(noteState({ markedForDeletion: true }))).toBe("deleted");
    expect(nudgeRefusal(noteState({ passwordProtected: true }))).toBe("locked");
    expect(nudgeRefusal(noteState({ sharedViaICloud: true }))).toBe("shared");
    expect(nudgeRefusal(noteState({ objectURI: "bogus" }))).toBe("no_object_id");
    expect(nudgeRefusal(noteState({ folderObjectURI: null }))).toBe("no_folder");
  });

  it("moveInPlaceScript embeds only validated object ids", () => {
    const script = moveInPlaceScript(NOTE_URI, FOLDER_URI);
    expect(script).toContain(`note id "${NOTE_URI}"`);
    expect(script).toContain(`is not "${FOLDER_URI}"`);
    expect(script).toContain("move theNote to theFolder");
    expect(() => moveInPlaceScript('x" & do shell script "y', FOLDER_URI)).toThrow(
      /unexpected object id/
    );
  });
});

describe("readSyncState", () => {
  it("sends read_sync_state and validates the answer", () => {
    const requests: unknown[] = [];
    const state = readSyncState([NOTE], fakeWriter([snapshot([noteState()])], requests));
    expect(state.objects[0].uploadPending).toBe(true);
    expect(requests[0]).toEqual({ protocol: 1, action: "read_sync_state", identifiers: [NOTE] });
    expect(() => readSyncState([NOTE], fakeWriter([{ status: "ok" }]))).toThrow(
      /Unexpected writer response/
    );
  });
});

describe("nudgeInPlace", () => {
  it("moves a pending note in place and watches until the upload is recorded", async () => {
    const scripts: string[] = [];
    const helper = fakeWriter([
      snapshot([noteState()]),
      snapshot([noteState()]),
      snapshot([noteState({ latestVersionSyncedToCloud: 5, uploadPending: false })], {
        pendingUploadCount: 2,
      }),
    ]);
    const report = await nudgeInPlace({ identifiers: [NOTE] }, nudgeDeps(helper, scripts));
    expect(scripts).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({
      action: "moved_in_place",
      uploadRecorded: true,
      contentUnchanged: true,
      uploadPendingBefore: true,
    });
    expect(report).toMatchObject({
      allUploadsRecorded: true,
      pushScheduled: false,
      pendingUploadCountBefore: 3,
      pendingUploadCountAfter: 2,
      waitedSeconds: 2,
    });
    expect(report.warnings).toEqual([]);
  });

  it("warns when content changed during the nudge or the upload stays pending", async () => {
    const helper = fakeWriter([
      snapshot([noteState()]),
      snapshot([noteState({ revision: "r1:" + "f".repeat(64) })]),
    ]);
    const report = await nudgeInPlace({ identifiers: [NOTE], waitSeconds: 4 }, nudgeDeps(helper));
    expect(report.targets[0].contentUnchanged).toBe(false);
    expect(report.allUploadsRecorded).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/revision changed/);
    expect(report.warnings.join("\n")).toMatch(/still show a pending upload after 4 s/);
    expect(report.waitedSeconds).toBe(4);
  });

  it("skips targets it cannot nudge and reports failed moves", async () => {
    const other = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const helper = fakeWriter([
      snapshot([
        noteState({ passwordProtected: true }),
        { identifier: other, found: false, reason: "not_found" },
      ]),
    ]);
    const report = await nudgeInPlace(
      { identifiers: [NOTE, other], waitSeconds: 0 },
      nudgeDeps(helper)
    );
    expect(report.targets[0]).toMatchObject({ action: "skipped", reason: "locked" });
    expect(report.targets[1]).toMatchObject({ action: "none", reason: "not_found" });

    const failing = fakeWriter([snapshot([noteState()])]);
    const changed = await nudgeInPlace(
      { identifiers: [NOTE], waitSeconds: 0 },
      nudgeDeps(failing, [], { success: false, output: "", error: "container changed (9901)" })
    );
    expect(changed.targets[0]).toMatchObject({ action: "failed", reason: "container_changed" });
    const other2 = await nudgeInPlace(
      { identifiers: [NOTE], waitSeconds: 0 },
      nudgeDeps(fakeWriter([snapshot([noteState()])]), [], { success: true, output: "odd" })
    );
    expect(other2.targets[0].reason).toMatch(/^applescript: odd/);
  });

  it("does nothing but read when Notes.app is not running or nudge is false", async () => {
    const scripts: string[] = [];
    const notRunning = await nudgeInPlace(
      { identifiers: [NOTE], waitSeconds: 0 },
      nudgeDeps(fakeWriter([snapshot([noteState()], { syncHostRunning: false })]), scripts)
    );
    expect(notRunning.warnings[0]).toMatch(/not running/);
    const readOnly = await nudgeInPlace(
      { identifiers: [NOTE], nudge: false },
      nudgeDeps(fakeWriter([snapshot([noteState()])]), scripts)
    );
    expect(readOnly.waitedSeconds).toBe(0);
    expect(readOnly.targets[0].action).toBe("none");
    expect(scripts).toEqual([]);
  });

  it("rejects an out-of-range wait before reading anything", async () => {
    await expect(
      nudgeInPlace({ identifiers: [NOTE], waitSeconds: 999 }, nudgeDeps(fakeWriter([])))
    ).rejects.toThrow(/waitSeconds/);
  });

  it("has real defaults for AppleScript, sleep, and the clock", async () => {
    const real = defaultNudgeDeps();
    expect(typeof real.runAppleScript).toBe("function");
    expect(typeof real.launchNotes).toBe("function");
    expect(typeof real.notesRunning()).toBe("boolean");
    expect(real.now()).toBeGreaterThan(0);
    await expect(real.sleep(1)).resolves.toBeUndefined();
  });
});

/**
 * Relaunch deps: Notes.app quits after `quitAfterPolls` running checks and
 * runs again once launched. The folder adoption script answers `adoption`.
 */
function relaunchDeps(
  helper: PrivateHelperDeps,
  options: {
    quit?: { success: boolean; output: string; error?: string };
    quitAfterPolls?: number;
    launch?: () => void;
    adoption?: { success: boolean; output: string; error?: string };
  } = {}
) {
  const events: string[] = [];
  let polls = 0;
  let launched = false;
  const deps = nudgeDeps(helper);
  deps.runAppleScript = (script) => {
    if (script.includes("exists folder id")) {
      events.push("adoption");
      return options.adoption ?? { success: true, output: "" };
    }
    events.push(script.includes("to quit") ? "quit" : "script");
    return options.quit ?? { success: true, output: "" };
  };
  deps.notesRunning = () => launched || polls++ < (options.quitAfterPolls ?? 1);
  deps.launchNotes =
    options.launch ??
    (() => {
      launched = true;
      events.push("launch");
    });
  return { deps, events };
}

describe("syncPush", () => {
  it("status only reads and never runs a script", async () => {
    const scripts: string[] = [];
    const report = await syncPush(
      { identifiers: [NOTE], method: "status" },
      nudgeDeps(fakeWriter([snapshot([noteState()])]), scripts)
    );
    expect(scripts).toEqual([]);
    expect(report).toMatchObject({
      method: "status",
      relaunched: false,
      waitedSeconds: 0,
      pushScheduled: false,
      syncHostRunningBefore: true,
      allUploadsRecorded: false,
    });
    expect(report.targets[0]).toMatchObject({ action: "none", uploadPendingBefore: true });
    expect(report).not.toHaveProperty("before");
  });

  it("nudge (the default) moves pending notes in place", async () => {
    const scripts: string[] = [];
    const helper = fakeWriter([
      snapshot([noteState()]),
      snapshot([noteState({ latestVersionSyncedToCloud: 5, uploadPending: false })]),
    ]);
    const report = await syncPush({ identifiers: [NOTE] }, nudgeDeps(helper, scripts));
    expect(scripts).toHaveLength(1);
    expect(report.method).toBe("nudge");
    expect(report.targets[0]).toMatchObject({ action: "moved_in_place", uploadRecorded: true });
  });

  it("nudge points to relaunch when Notes.app is not running", async () => {
    const report = await syncPush(
      { identifiers: [NOTE], waitSeconds: 0 },
      nudgeDeps(fakeWriter([snapshot([noteState()], { syncHostRunning: false })]))
    );
    expect(report.warnings.join("\n")).toMatch(/method relaunch with confirm: true/);
  });

  it("validates input before reading anything", async () => {
    await expect(
      syncPush({ identifiers: [NOTE], waitSeconds: 181 }, nudgeDeps(fakeWriter([])))
    ).rejects.toThrow(/waitSeconds/);
    await expect(syncPush({ identifiers: [] }, nudgeDeps(fakeWriter([])))).rejects.toThrow(
      /identifiers/
    );
    const requests: unknown[] = [];
    await expect(
      syncPush(
        { identifiers: [NOTE], method: "relaunch" },
        nudgeDeps(fakeWriter([snapshot([noteState()])], requests))
      )
    ).rejects.toMatchObject({ code: "confirmation_required", committed: false });
    expect(requests).toEqual([]);
  });

  it("relaunch quits, reopens, and reports against the pre-relaunch counters", async () => {
    const folder = {
      ...noteState({ identifier: FOLDER, kind: "folder", objectURI: FOLDER_URI }),
    };
    const helper = fakeWriter([
      snapshot([noteState(), folder], { pendingUploadCount: 9 }),
      snapshot([noteState({ currentLocalVersion: 6 }), folder], { pendingUploadCount: 8 }),
      snapshot(
        [
          noteState({
            currentLocalVersion: 6,
            latestVersionSyncedToCloud: 6,
            uploadPending: false,
          }),
          { ...folder, latestVersionSyncedToCloud: 5, uploadPending: false },
        ],
        { pendingUploadCount: 1 }
      ),
    ]);
    const { deps, events } = relaunchDeps(helper, {
      quitAfterPolls: 2,
      adoption: { success: true, output: `${FOLDER_URI}\t1\tProjects\n` },
    });
    const report = await syncPush(
      { identifiers: [NOTE, FOLDER], method: "relaunch", confirm: true },
      deps
    );
    expect(events).toEqual(["quit", "launch", "adoption"]);
    expect(report).toMatchObject({
      method: "relaunch",
      relaunched: true,
      syncHostRunningBefore: true,
      pendingUploadCountBefore: 9,
      pendingUploadCountAfter: 1,
      allUploadsRecorded: true,
    });
    expect(report.targets[0]).toMatchObject({
      action: "relaunch",
      before: { currentLocalVersion: 5, latestVersionSyncedToCloud: 4 },
      after: { currentLocalVersion: 6, latestVersionSyncedToCloud: 6 },
      uploadRecorded: true,
    });
    expect(report.targets[1]).toMatchObject({
      kind: "folder",
      action: "relaunch",
      adoptedByNotesApp: true,
      adoption: { expected: "visible", visibleInNotesApp: true, nameInNotesApp: "Projects" },
    });
    expect(report.targets[0]).not.toHaveProperty("adoptedByNotesApp");
    expect(report.warnings).toEqual([]);
  });

  it("relaunch only opens Notes.app when it is not running, and warns on a pending upload", async () => {
    const helper = fakeWriter([snapshot([noteState()], { syncHostRunning: false })]);
    const { deps, events } = relaunchDeps(helper);
    const report = await syncPush(
      { identifiers: [NOTE], method: "relaunch", confirm: true, waitSeconds: 2 },
      deps
    );
    expect(events).toEqual(["launch"]);
    expect(report.syncHostRunningBefore).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/still show a pending upload after 2 s/);
  });

  it("relaunch reports each failure without claiming a relaunch", async () => {
    const refused = relaunchDeps(fakeWriter([snapshot([noteState()])]), {
      quit: { success: false, output: "", error: "busy" },
    });
    await expect(
      syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, refused.deps)
    ).rejects.toMatchObject({ code: "relaunch_failed", message: /did not accept quit: busy/ });
    expect(refused.events).toEqual(["quit"]);

    const stuck = relaunchDeps(fakeWriter([snapshot([noteState()])]), {
      quitAfterPolls: 1_000_000,
    });
    await expect(
      syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, stuck.deps)
    ).rejects.toThrow(/still running 20 s after quit/);
    expect(stuck.events).toEqual(["quit"]);

    const noLaunch = relaunchDeps(fakeWriter([snapshot([noteState()])]), {
      launch: () => {
        throw new Error("open failed");
      },
    });
    await expect(
      syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, noLaunch.deps)
    ).rejects.toThrow(/was quit but could not be opened: open failed/);
    const noLaunchCold = relaunchDeps(
      fakeWriter([snapshot([noteState()], { syncHostRunning: false })]),
      {
        launch: () => {
          throw "nope";
        },
      }
    );
    await expect(
      syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, noLaunchCold.deps)
    ).rejects.toThrow(/^Notes\.app could not be opened: nope/);
  });
});

describe("relaunch safety", () => {
  it("counts only this user's Notes.app and never reads a pgrep failure as quit", () => {
    const calls: unknown[][] = [];
    const ok = ((...args: unknown[]) => {
      calls.push(args);
      return Buffer.from("");
    }) as never;
    expect(notesRunningForThisUser(ok, 501)).toBe(true);
    expect(calls[0].slice(0, 2)).toEqual(["/usr/bin/pgrep", ["-x", "-u", "501", "Notes"]]);
    const noMatch = (() => {
      throw Object.assign(new Error("exit 1"), { status: 1 });
    }) as never;
    expect(notesRunningForThisUser(noMatch, 501)).toBe(false);
    const broken = (() => {
      throw Object.assign(new Error("invalid option"), { status: 2 });
    }) as never;
    expect(() => notesRunningForThisUser(broken, 501)).toThrow(/Could not check.*invalid option/);
    const timedOut = (() => {
      throw Object.assign(new Error("spawnSync ETIMEDOUT"), { status: null });
    }) as never;
    expect(() => notesRunningForThisUser(timedOut, 501)).toThrow(/Could not check/);
    expect(() => notesRunningForThisUser(ok, -1)).toThrow(/no user id/);
  });

  it("stops without launching when it cannot tell whether Notes.app quit", async () => {
    const { deps, events } = relaunchDeps(fakeWriter([snapshot([noteState()])]));
    deps.notesRunning = () => {
      throw new Error("Could not check whether Notes.app is running (pgrep: boom)");
    };
    await expect(
      syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, deps)
    ).rejects.toMatchObject({
      code: "relaunch_failed",
      committed: false,
      message: /asked to quit, but could not check.*Nothing was relaunched/,
    });
    expect(events).toEqual(["quit"]);
  });

  it("says Notes.app was already restarted when the read after the relaunch fails", async () => {
    const helper = fakeWriter([
      snapshot([noteState()]),
      { status: "error", code: "store_unavailable", message: "store went away" },
    ]);
    const { deps, events } = relaunchDeps(helper);
    const failure = syncPush({ identifiers: [NOTE], method: "relaunch", confirm: true }, deps);
    await expect(failure).rejects.toMatchObject({
      code: "relaunch_failed",
      message:
        /was quit and reopened, but reading the sync state afterwards failed: store went away.*do not relaunch again/,
      details: { relaunched: true, syncHostRunningBefore: true },
    });
    expect(events).toEqual(["quit", "launch"]);
  });

  it("warns about a folder the relaunched Notes.app does not show", async () => {
    const folder = noteState({ identifier: FOLDER, kind: "folder", objectURI: FOLDER_URI });
    const helper = fakeWriter([snapshot([folder]), snapshot([folder])]);
    const { deps } = relaunchDeps(helper, {
      adoption: { success: true, output: `${FOLDER_URI}\t0\t\n` },
    });
    const report = await syncPush(
      { identifiers: [FOLDER], method: "relaunch", confirm: true, waitSeconds: 0 },
      deps
    );
    expect(report.targets[0]).toMatchObject({
      adoptedByNotesApp: false,
      adoption: { reason: "not_visible", visibleInNotesApp: false },
    });
    expect(report.warnings.join("\n")).toMatch(/1 folder\(s\) are not confirmed.*not_visible/);
  });
});

describe("folder adoption", () => {
  const OTHER_URI = "x-coredata://ABCDEF01-2345/ICFolder/p8";
  function adoptionDeps(answers: Array<{ success: boolean; output: string; error?: string }>) {
    const scripts: string[] = [];
    const deps = nudgeDeps(fakeWriter([]));
    deps.notesRunning = () => true;
    deps.runAppleScript = (script) => {
      scripts.push(script);
      return answers[Math.min(scripts.length - 1, answers.length - 1)];
    };
    return { deps, scripts };
  }

  it("builds a read-only script from validated folder ids only", () => {
    const script = folderAdoptionScript([FOLDER_URI]);
    expect(script).toContain(`"${FOLDER_URI}"`);
    expect(script).toMatch(/exists folder id/);
    expect(script).not.toMatch(/\b(?:make|delete|move|set name)\b/);
    expect(() => folderAdoptionScript(['x" & (do shell script "id") & "'])).toThrow(
      /unexpected folder id/
    );
    expect(() => folderAdoptionScript([NOTE_URI])).toThrow(/unexpected folder id/);
  });

  it("parses visibility, names with tabs or line breaks, and per-folder errors", () => {
    const parsed = parseFolderAdoption(
      `${FOLDER_URI}\t1\tTwo\tWords\n${OTHER_URI}\t1\tLine one\nline two\nx-coredata://ABCDEF01-2345/ICFolder/p9\tE\t\n`,
      [FOLDER_URI, OTHER_URI, "x-coredata://ABCDEF01-2345/ICFolder/p9"]
    );
    expect(parsed.get(FOLDER_URI)).toEqual({ visible: true, name: "Two\tWords" });
    expect(parsed.get(OTHER_URI)).toEqual({ visible: true, name: "Line one\nline two" });
    expect(parsed.get("x-coredata://ABCDEF01-2345/ICFolder/p9")).toEqual({
      visible: null,
      name: null,
    });
  });

  it("confirms a created folder by id and title, and a deleted one by its absence", async () => {
    const { deps, scripts } = adoptionDeps([
      { success: true, output: `${FOLDER_URI}\t1\tReading\n${OTHER_URI}\t0\t\n` },
    ]);
    const report = await checkFolderAdoption(
      [
        { identifier: FOLDER, objectURI: FOLDER_URI, title: "Reading" },
        { identifier: NOTE, objectURI: OTHER_URI, deleted: true },
      ],
      deps,
      0
    );
    expect(scripts).toHaveLength(1);
    expect(report).toMatchObject({ checked: true, allAdopted: true });
    expect(report.folders.map((f) => [f.expected, f.adoptedByNotesApp])).toEqual([
      ["visible", true],
      ["absent", true],
    ]);
  });

  it("polls until Notes.app shows the folder, then reports a stale title or a lingering delete", async () => {
    const { deps, scripts } = adoptionDeps([
      { success: true, output: `${FOLDER_URI}\t0\t\n` },
      { success: true, output: `${FOLDER_URI}\t1\tReading\n` },
    ]);
    const report = await checkFolderAdoption(
      [{ identifier: FOLDER, objectURI: FOLDER_URI, title: "Reading" }],
      deps,
      10
    );
    expect(scripts).toHaveLength(2);
    expect(report.folders[0].adoptedByNotesApp).toBe(true);
    expect(report.waitedSeconds).toBe(1);

    const stale = await checkFolderAdoption(
      [{ identifier: FOLDER, objectURI: FOLDER_URI, title: "Renamed" }],
      adoptionDeps([{ success: true, output: `${FOLDER_URI}\t1\tReading\n` }]).deps,
      0
    );
    expect(stale.folders[0]).toMatchObject({
      adoptedByNotesApp: false,
      reason: "name_mismatch",
      nameInNotesApp: "Reading",
    });
    const lingering = await checkFolderAdoption(
      [{ identifier: FOLDER, objectURI: FOLDER_URI, deleted: true }],
      adoptionDeps([{ success: true, output: `${FOLDER_URI}\t1\tReading\n` }]).deps,
      0
    );
    expect(lingering.folders[0]).toMatchObject({
      adoptedByNotesApp: false,
      reason: "still_visible",
    });
  });

  it("never launches Notes.app and reports what it could not check", async () => {
    const { deps, scripts } = adoptionDeps([{ success: true, output: "" }]);
    deps.notesRunning = () => false;
    const cold = await checkFolderAdoption(
      [{ identifier: FOLDER, objectURI: FOLDER_URI }],
      deps,
      5
    );
    expect(scripts).toEqual([]);
    expect(cold).toMatchObject({ checked: false, reason: "notes_not_running", allAdopted: false });
    expect(cold.folders[0]).toMatchObject({ adoptedByNotesApp: null, reason: "notes_not_running" });

    deps.notesRunning = () => {
      throw new Error("Could not check whether Notes.app is running (pgrep: boom)");
    };
    const unknown = await checkFolderAdoption(
      [{ identifier: FOLDER, objectURI: FOLDER_URI }],
      deps,
      0
    );
    expect(unknown).toMatchObject({ checked: false, reason: /could not check/ });

    const failed = await checkFolderAdoption(
      [
        { identifier: FOLDER, objectURI: FOLDER_URI },
        { identifier: NOTE, objectURI: null },
      ],
      adoptionDeps([{ success: false, output: "", error: "Not authorized" }]).deps,
      0
    );
    expect(failed.folders).toMatchObject([
      { adoptedByNotesApp: null, reason: "applescript: Not authorized" },
      { adoptedByNotesApp: null, reason: "no_object_id" },
    ]);
    await expect(checkFolderAdoption([], deps, 0)).resolves.toMatchObject({
      checked: false,
      reason: "no_folders",
    });
    await expect(
      checkFolderAdoption([{ identifier: FOLDER, objectURI: FOLDER_URI }], deps, 61)
    ).rejects.toThrow(/0-60/);
  });
});
