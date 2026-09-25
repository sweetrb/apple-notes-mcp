/**
 * Sync state and the move-in-place nudge for writer-saved changes.
 *
 * The writer saves through its own Core Data stack, and only Notes.app can
 * upload to iCloud. Observed on macOS 27.2 (TECHNICAL_NOTES.md "Private
 * writer: sync"): a running Notes.app merges the writer's save and schedules
 * the note for upload, but when it already holds that note in memory its
 * upload check reads the cached cloud state, decides "already pushed the
 * latest version", and skips it.
 *
 * The nudge makes Notes.app save the note itself without changing it: it
 * moves the note into the folder it is already in. Notes records that as a
 * folder reassignment, bumps the change count on fresh state, and uploads
 * the note with the writer's pending edits. Body, title, and modification
 * date are not touched; the writer's revision token, which covers them, is
 * compared before and after (`contentUnchanged`).
 *
 * `syncPush` (the `native-sync-push` tool) runs the same machinery for notes
 * written earlier: `status` only reads, `nudge` moves pending notes in place,
 * and `relaunch` (only with `confirm: true`) quits and reopens Notes.app so
 * its launch sweep considers every object with pending changes, including
 * folders, which cannot be moved in place.
 *
 * Every outcome is read back from Notes' own counters (`read_sync_state`).
 * `uploadRecorded` is true only when `latestVersionSyncedToCloud` has caught
 * up with `currentLocalVersion`; nothing here claims an upload it did not
 * observe.
 *
 * @module services/privateSyncNudge
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { executeAppleScript } from "../utils/applescript.js";
import {
  PrivateWriteError,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  type PrivateHelperDeps,
} from "./privateWriter.js";

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const NOTE_URI = /^x-coredata:\/\/[0-9A-F-]+\/ICNote\/p\d+$/i;
const FOLDER_URI = /^x-coredata:\/\/[0-9A-F-]+\/ICFolder\/p\d+$/i;
export const MAX_SYNC_TARGETS = 50;
export const MAX_NUDGE_WAIT_SECONDS = 180;

const objectSchema = z
  .object({
    identifier: z.string(),
    found: z.boolean(),
    reason: z.string().optional(),
    kind: z.enum(["note", "folder"]).optional(),
    objectURI: z.string().optional(),
    markedForDeletion: z.boolean().optional(),
    inICloudAccount: z.boolean().optional(),
    cloudStateAvailable: z.boolean().optional(),
    currentLocalVersion: z.number().int().optional(),
    latestVersionSyncedToCloud: z.number().int().optional(),
    uploadPending: z.boolean().optional(),
    folderIdentifier: z.string().nullable().optional(),
    folderObjectURI: z.string().nullable().optional(),
    passwordProtected: z.boolean().optional(),
    deletedOrInTrash: z.boolean().optional(),
    sharedViaICloud: z.boolean().optional(),
    revision: z.string().optional(),
  })
  .passthrough();
export type SyncObjectState = z.infer<typeof objectSchema>;

export const syncStateSchema = z
  .object({
    status: z.literal("ok"),
    objects: z.array(objectSchema),
    pendingUploadCount: z.number().int().nullable(),
    syncHostRunning: z.boolean(),
  })
  .passthrough();
export type SyncState = z.infer<typeof syncStateSchema>;

function invalid(message: string): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, false);
}

/** Validate and de-duplicate a list of note or folder UUIDs. */
export function syncTargets(identifiers: string[]): string[] {
  const unique = [...new Set(identifiers)];
  if (!unique.length || unique.length > MAX_SYNC_TARGETS)
    throw invalid(`identifiers must list 1-${MAX_SYNC_TARGETS} note or folder UUIDs`);
  for (const id of unique) if (!UUID.test(id)) throw invalid("identifiers must be Notes UUIDs");
  return unique;
}

/** Read Notes' own upload counters for up to 50 notes or folders (read-only). */
export function readSyncState(
  identifiers: string[],
  deps: PrivateHelperDeps = defaultWriterDeps()
): SyncState {
  return parseWriterResult(
    syncStateSchema,
    callPrivateWriter("read_sync_state", { identifiers: syncTargets(identifiers) }, deps),
    false
  );
}

/** Notes' own record that the current local version reached iCloud. */
export function uploadRecorded(state: SyncObjectState): boolean {
  return (
    state.found &&
    state.currentLocalVersion !== undefined &&
    state.latestVersionSyncedToCloud !== undefined &&
    state.latestVersionSyncedToCloud >= state.currentLocalVersion
  );
}

/** Why a note cannot be nudged, or null when it can. */
export function nudgeRefusal(state: SyncObjectState): string | null {
  if (!state.found) return state.reason ?? "not_found";
  if (!state.uploadPending) return "nothing_pending";
  if (state.kind !== "note") return "folders_need_relaunch";
  if (!state.inICloudAccount) return "not_icloud";
  if (state.markedForDeletion || state.deletedOrInTrash) return "deleted";
  if (state.passwordProtected) return "locked";
  if (state.sharedViaICloud) return "shared";
  if (!state.objectURI || !NOTE_URI.test(state.objectURI)) return "no_object_id";
  if (!state.folderObjectURI || !FOLDER_URI.test(state.folderObjectURI)) return "no_folder";
  return null;
}

/**
 * Moves the note into the folder it is already in, refusing if Notes.app
 * reports a different container. Both ids are validated x-coredata URIs, so
 * no caller text reaches the script.
 */
export function moveInPlaceScript(noteURI: string, folderURI: string): string {
  if (!NOTE_URI.test(noteURI) || !FOLDER_URI.test(folderURI))
    throw invalid("Refusing to build a move script from an unexpected object id");
  return [
    'tell application "Notes"',
    `  set theNote to note id "${noteURI}"`,
    "  set theFolder to container of theNote",
    `  if (id of theFolder) is not "${folderURI}" then error "container changed" number 9901`,
    "  move theNote to theFolder",
    '  return "moved"',
    "end tell",
  ].join("\n");
}

/**
 * Whether this user has a Notes.app process. `pgrep` is scoped to the
 * current user, so another logged-in user's Notes.app does not count, and
 * only its "no match" exit (1) means not running: any other failure throws
 * rather than reading as "quit".
 */
export function notesRunningForThisUser(
  run: typeof execFileSync = execFileSync,
  uid: number = process.getuid?.() ?? -1
): boolean {
  if (uid < 0)
    throw new Error("Cannot tell whose Notes.app is running: no user id on this platform");
  try {
    run("/usr/bin/pgrep", ["-x", "-u", String(uid), "Notes"], {
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if ((error as { status?: number | null }).status === 1) return false;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not check whether Notes.app is running (pgrep: ${reason})`, {
      cause: error,
    });
  }
}

/** Machine side effects of a nudge or relaunch, injectable for tests. */
export interface NudgeDeps {
  helper: PrivateHelperDeps;
  runAppleScript: (script: string) => { success: boolean; output: string; error?: string };
  /** Opens Notes.app in the background (`open -g -a Notes`); used only by relaunch. */
  launchNotes: () => void;
  /**
   * Whether this user's Notes.app process exists; used by relaunch and the
   * folder adoption check. Throws when it cannot tell.
   */
  notesRunning: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function defaultNudgeDeps(overrides: Partial<NudgeDeps> = {}): NudgeDeps {
  return {
    helper: defaultWriterDeps(),
    runAppleScript: (script) => executeAppleScript(script, { maxRetries: 1, timeoutMs: 30_000 }),
    launchNotes: () => {
      execFileSync("/usr/bin/open", ["-g", "-a", "Notes"], { timeout: 15_000 });
    },
    notesRunning: () => notesRunningForThisUser(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

export interface NudgeTargetResult {
  identifier: string;
  kind: "note" | "folder" | null;
  before: { currentLocalVersion?: number; latestVersionSyncedToCloud?: number } | null;
  after: { currentLocalVersion?: number; latestVersionSyncedToCloud?: number } | null;
  uploadPendingBefore: boolean;
  uploadRecorded: boolean;
  action: "none" | "moved_in_place" | "relaunch" | "skipped" | "failed";
  reason: string | null;
  /** For a nudged note: the writer's revision token and folder were identical before and after. */
  contentUnchanged?: boolean;
  /**
   * For a folder after a relaunch: Notes.app shows it (or, for a deleted
   * folder, no longer shows it). null when it could not be checked.
   */
  adoptedByNotesApp?: boolean | null;
  /** The folder adoption check behind `adoptedByNotesApp`. */
  adoption?: FolderAdoption;
}

function versions(state: SyncObjectState | undefined) {
  if (!state?.found) return null;
  return {
    currentLocalVersion: state.currentLocalVersion,
    latestVersionSyncedToCloud: state.latestVersionSyncedToCloud,
  };
}

export interface NudgeReport {
  syncHostRunning: boolean;
  /** Seconds actually spent watching for uploads (at most the requested wait). */
  waitedSeconds: number;
  pendingUploadCountBefore: number | null;
  pendingUploadCountAfter: number | null;
  allUploadsRecorded: boolean;
  /** Always false: the writer never uploads; see uploadRecorded per target. */
  pushScheduled: false;
  targets: NudgeTargetResult[];
  warnings: string[];
  /** The last counters read, for callers that report more (e.g. a relaunch). */
  before: SyncState;
  after: SyncState;
}

/**
 * Nudge each pending note by moving it in place, then watch Notes' counters
 * for up to `waitSeconds` (0-180). With `nudge: false` it only reads and
 * waits. Folders and notes Notes.app cannot upload are skipped with a reason.
 */
export async function nudgeInPlace(
  request: { identifiers: string[]; waitSeconds?: number; nudge?: boolean },
  deps: NudgeDeps = defaultNudgeDeps()
): Promise<NudgeReport> {
  const identifiers = syncTargets(request.identifiers);
  const act = request.nudge !== false;
  const waitSeconds = request.waitSeconds ?? (act ? 30 : 0);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_NUDGE_WAIT_SECONDS)
    throw invalid(`waitSeconds must be 0-${MAX_NUDGE_WAIT_SECONDS}`);

  const before = readSyncState(identifiers, deps.helper);
  const byId = new Map(before.objects.map((o) => [o.identifier, o]));
  const results = new Map<string, NudgeTargetResult>(
    identifiers.map((id) => {
      const state = byId.get(id);
      return [
        id,
        {
          identifier: id,
          kind: state?.kind ?? null,
          before: versions(state),
          after: null,
          uploadPendingBefore: Boolean(state?.uploadPending),
          uploadRecorded: state ? uploadRecorded(state) : false,
          action: "none",
          reason: state?.found ? null : (state?.reason ?? "not_found"),
        },
      ];
    })
  );
  const warnings: string[] = [];

  if (act && !before.syncHostRunning) {
    warnings.push(
      "Notes.app is not running, so there is nothing to nudge. Its next launch sweeps every " +
        "pending change."
    );
  } else if (act) {
    for (const id of identifiers) {
      const state = byId.get(id);
      const result = results.get(id)!;
      if (!state) continue;
      const refusal = nudgeRefusal(state);
      if (refusal) {
        if (refusal !== "nothing_pending" && state.found) {
          result.action = "skipped";
          result.reason = refusal;
        }
        continue;
      }
      const run = deps.runAppleScript(moveInPlaceScript(state.objectURI!, state.folderObjectURI!));
      if (run.success && run.output.trim() === "moved") {
        result.action = "moved_in_place";
      } else {
        result.action = "failed";
        result.reason = /9901|container changed/.test(run.error ?? "")
          ? "container_changed"
          : `applescript: ${run.error ?? run.output}`.slice(0, 300);
      }
    }
  }

  // Watch Notes' own counters until every pending target records its upload.
  const pending = () => [...results.values()].filter((r) => r.reason === null && !r.uploadRecorded);
  const start = deps.now();
  const end = start + waitSeconds * 1000;
  let after = before;
  for (let first = true; ; first = false) {
    if (!first || act) after = readSyncState(identifiers, deps.helper);
    const now = new Map(after.objects.map((o) => [o.identifier, o]));
    for (const result of results.values()) {
      const state = now.get(result.identifier);
      result.after = versions(state);
      result.uploadRecorded = state ? uploadRecorded(state) : false;
      if (result.action === "moved_in_place") {
        const was = byId.get(result.identifier);
        result.contentUnchanged =
          Boolean(was?.revision) &&
          was?.revision === state?.revision &&
          was?.folderIdentifier === state?.folderIdentifier;
      }
    }
    if (!pending().length || deps.now() >= end) break;
    await deps.sleep(2000);
  }

  const waitedSeconds = Math.round((deps.now() - start) / 1000);
  const targets = [...results.values()];
  const stillPending = targets.filter((r) => r.reason === null && !r.uploadRecorded);
  for (const r of targets)
    if (r.action === "moved_in_place" && r.contentUnchanged === false)
      warnings.push(
        `${r.identifier}: the note's revision changed while it was nudged; something else ` +
          "edited it at the same time. Read it before relying on its content."
      );
  if (stillPending.length && act)
    warnings.push(
      `${stillPending.length} target(s) still show a pending upload after ${waitedSeconds} s. ` +
        "Notes.app uploads on its own schedule; check again later."
    );
  return {
    syncHostRunning: after.syncHostRunning,
    waitedSeconds,
    pendingUploadCountBefore: before.pendingUploadCount,
    pendingUploadCountAfter: after.pendingUploadCount,
    allUploadsRecorded: stillPending.length === 0,
    pushScheduled: false,
    targets,
    warnings,
    before,
    after,
  };
}

export type SyncPushMethod = "status" | "nudge" | "relaunch";

export interface SyncPushRequest {
  identifiers: string[];
  /** status = read only; nudge (default) = move pending notes in place; relaunch = quit and reopen Notes.app. */
  method?: SyncPushMethod;
  /** Required for `relaunch`: quitting Notes.app interrupts whoever is using it. */
  confirm?: boolean;
  /** How long to watch the counters afterwards (0-180 s; default 30, or 0 for status). */
  waitSeconds?: number;
}

export type SyncPushReport = Omit<NudgeReport, "before" | "after" | "syncHostRunning"> & {
  method: SyncPushMethod;
  syncHostRunningBefore: boolean;
  syncHostRunningAfter: boolean;
  relaunched: boolean;
};

const QUIT_SCRIPT = 'tell application "Notes" to quit';
const QUIT_TIMEOUT_MS = 20_000;
/** How long a relaunch waits for Notes.app to show writer-changed folders. */
const RELAUNCH_ADOPTION_WAIT_SECONDS = 20;

async function waitForQuit(deps: NudgeDeps, timeoutMs: number): Promise<boolean> {
  const end = deps.now() + timeoutMs;
  for (;;) {
    let running: boolean;
    try {
      running = deps.notesRunning();
    } catch (error) {
      throw relaunchFailed(
        `Notes.app was asked to quit, but ${errorText(error)}. Nothing was relaunched; check Notes.app.`
      );
    }
    if (!running) return true;
    if (deps.now() >= end) return false;
    await deps.sleep(500);
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function relaunchFailed(message: string, details?: Record<string, unknown>): PrivateWriteError {
  return new PrivateWriteError("relaunch_failed", message, false, details);
}

// ---------------------------------------------------------------------------
// Folder adoption: does Notes.app show a writer-created or -changed folder?
// ---------------------------------------------------------------------------

export const MAX_ADOPTION_WAIT_SECONDS = 60;

/** A folder whose presence in Notes.app should be confirmed. */
export interface FolderAdoptionTarget {
  identifier: string;
  /** The folder's x-coredata id, which is also its AppleScript id. */
  objectURI?: string | null;
  /** Its title in the store, compared with the name Notes.app shows when given. */
  title?: string | null;
  /** A deleted folder is adopted when Notes.app no longer shows it. */
  deleted?: boolean;
}

export interface FolderAdoption {
  identifier: string;
  objectURI: string | null;
  expected: "visible" | "absent";
  /** Whether Notes.app shows a folder with that id; null when not checked. */
  visibleInNotesApp: boolean | null;
  nameInNotesApp: string | null;
  adoptedByNotesApp: boolean | null;
  /** Why it is not adopted, or not checked: name_mismatch, still_visible, not_visible, no_object_id, notes_not_running, applescript: ... */
  reason: string | null;
}

export interface FolderAdoptionReport {
  checked: boolean;
  reason: string | null;
  waitedSeconds: number;
  allAdopted: boolean;
  folders: FolderAdoption[];
}

/**
 * Read-only AppleScript that reports, for each folder id, whether Notes.app
 * shows it and its name. Every id is a validated x-coredata folder URI, so no
 * caller text reaches the script.
 */
export function folderAdoptionScript(objectURIs: string[]): string {
  for (const uri of objectURIs)
    if (!FOLDER_URI.test(uri))
      throw invalid("Refusing to build an adoption script from an unexpected folder id");
  return [
    'tell application "Notes"',
    '  set out to ""',
    `  repeat with fid in {${objectURIs.map((uri) => `"${uri}"`).join(", ")}}`,
    "    set fidText to contents of fid",
    "    try",
    "      if exists folder id fidText then",
    '        set out to out & fidText & tab & "1" & tab & (name of folder id fidText) & linefeed',
    "      else",
    '        set out to out & fidText & tab & "0" & tab & linefeed',
    "      end if",
    "    on error",
    '      set out to out & fidText & tab & "E" & tab & linefeed',
    "    end try",
    "  end repeat",
    "  return out",
    "end tell",
  ].join("\n");
}

/** Parse {@link folderAdoptionScript} output into id → visibility and name. */
export function parseFolderAdoption(
  output: string,
  objectURIs: string[]
): Map<string, { visible: boolean | null; name: string | null }> {
  const known = new Set(objectURIs);
  const found = new Map<string, { visible: boolean | null; name: string | null }>();
  let last: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const [uri, flag, ...rest] = line.split("\t");
    if (known.has(uri) && (flag === "1" || flag === "0" || flag === "E")) {
      const visible = flag === "1" ? true : flag === "0" ? false : null;
      found.set(uri, { visible, name: visible ? rest.join("\t") : null });
      last = visible ? uri : null;
    } else if (last && line.length) {
      // A folder name that itself contains a line break.
      const entry = found.get(last)!;
      entry.name = `${entry.name}\n${line}`;
    }
  }
  return found;
}

function adoptionOf(
  target: FolderAdoptionTarget,
  seen: { visible: boolean | null; name: string | null } | undefined,
  failure: string | null
): FolderAdoption {
  const objectURI = target.objectURI && FOLDER_URI.test(target.objectURI) ? target.objectURI : null;
  const expected = target.deleted ? "absent" : "visible";
  const base = { identifier: target.identifier, objectURI, expected } as const;
  if (!objectURI)
    return {
      ...base,
      visibleInNotesApp: null,
      nameInNotesApp: null,
      adoptedByNotesApp: null,
      reason: "no_object_id",
    };
  if (!seen || seen.visible === null)
    return {
      ...base,
      visibleInNotesApp: null,
      nameInNotesApp: null,
      adoptedByNotesApp: null,
      reason: failure ?? "applescript: no answer for this folder",
    };
  let adopted: boolean;
  let reason: string | null = null;
  if (expected === "absent") {
    adopted = !seen.visible;
    if (!adopted) reason = "still_visible";
  } else if (!seen.visible) {
    adopted = false;
    reason = "not_visible";
  } else if (typeof target.title === "string" && seen.name !== target.title) {
    adopted = false;
    reason = "name_mismatch";
  } else {
    adopted = true;
  }
  return {
    ...base,
    visibleInNotesApp: seen.visible,
    nameInNotesApp: seen.name,
    adoptedByNotesApp: adopted,
    reason,
  };
}

/**
 * Ask Notes.app (read-only, through AppleScript) whether it shows each
 * folder, polling for up to `waitSeconds` while any is not yet adopted. Never
 * launches Notes.app: when it is not running nothing is checked. Never
 * throws; a failure is reported per folder.
 */
export async function checkFolderAdoption(
  targets: FolderAdoptionTarget[],
  deps: NudgeDeps,
  waitSeconds = 10
): Promise<FolderAdoptionReport> {
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_ADOPTION_WAIT_SECONDS)
    throw invalid(`adoption wait must be 0-${MAX_ADOPTION_WAIT_SECONDS} seconds`);
  const notChecked = (reason: string): FolderAdoptionReport => ({
    checked: false,
    reason,
    waitedSeconds: 0,
    allAdopted: false,
    folders: targets.map((t) => adoptionOf(t, undefined, reason)),
  });
  if (!targets.length)
    return {
      checked: false,
      reason: "no_folders",
      waitedSeconds: 0,
      allAdopted: true,
      folders: [],
    };
  let running: boolean;
  try {
    running = deps.notesRunning();
  } catch (error) {
    return notChecked(errorText(error));
  }
  if (!running) return notChecked("notes_not_running");

  const uris = targets
    .map((t) => t.objectURI)
    .filter((uri): uri is string => typeof uri === "string" && FOLDER_URI.test(uri));
  const start = deps.now();
  const end = start + waitSeconds * 1000;
  let folders: FolderAdoption[] = [];
  for (;;) {
    let seen = new Map<string, { visible: boolean | null; name: string | null }>();
    let failure: string | null = null;
    if (uris.length) {
      const run = deps.runAppleScript(folderAdoptionScript([...new Set(uris)]));
      if (run.success) seen = parseFolderAdoption(run.output, uris);
      else failure = `applescript: ${run.error ?? run.output}`.slice(0, 300);
    }
    folders = targets.map((t) =>
      adoptionOf(t, t.objectURI ? seen.get(t.objectURI) : undefined, failure)
    );
    const waiting = folders.some(
      (f) => f.adoptedByNotesApp === false || (f.adoptedByNotesApp === null && f.objectURI)
    );
    if (!waiting || deps.now() >= end) break;
    await deps.sleep(1000);
  }
  return {
    checked: true,
    reason: null,
    waitedSeconds: Math.round((deps.now() - start) / 1000),
    allAdopted: folders.every((f) => f.adoptedByNotesApp === true),
    folders,
  };
}

function pushReport(
  method: SyncPushMethod,
  report: NudgeReport,
  relaunched: boolean,
  runningBefore: boolean
): SyncPushReport {
  const { before: _before, after: _after, syncHostRunning, ...rest } = report;
  void _before;
  void _after;
  return {
    method,
    syncHostRunningBefore: runningBefore,
    syncHostRunningAfter: syncHostRunning,
    relaunched,
    ...rest,
  };
}

/**
 * Get writer-saved changes uploaded after the fact, and report from Notes'
 * own counters whether they were. Never writes to the store: `nudge` is a
 * Notes.app-side move in place and `relaunch` restarts Notes.app.
 */
export async function syncPush(
  request: SyncPushRequest,
  deps: NudgeDeps = defaultNudgeDeps()
): Promise<SyncPushReport> {
  const method = request.method ?? "nudge";
  const identifiers = syncTargets(request.identifiers);
  const waitSeconds = request.waitSeconds ?? (method === "status" ? 0 : 30);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_NUDGE_WAIT_SECONDS)
    throw invalid(`waitSeconds must be 0-${MAX_NUDGE_WAIT_SECONDS}`);

  if (method !== "relaunch") {
    const report = await nudgeInPlace(
      { identifiers, waitSeconds, nudge: method === "nudge" },
      deps
    );
    if (method === "nudge" && !report.before.syncHostRunning)
      report.warnings.push("To start Notes.app now, use method relaunch with confirm: true.");
    return pushReport(method, report, false, report.before.syncHostRunning);
  }

  if (request.confirm !== true)
    throw new PrivateWriteError(
      "confirmation_required",
      "method relaunch quits and reopens Notes.app, which interrupts anyone using it. " +
        "Ask the user, then pass confirm: true.",
      false
    );
  const first = readSyncState(identifiers, deps.helper);
  if (first.syncHostRunning) {
    const quit = deps.runAppleScript(QUIT_SCRIPT);
    if (!quit.success)
      throw relaunchFailed(
        `Notes.app did not accept quit: ${quit.error ?? "unknown error"}. Nothing was relaunched.`
      );
    if (!(await waitForQuit(deps, QUIT_TIMEOUT_MS)))
      throw relaunchFailed(
        `Notes.app is still running ${QUIT_TIMEOUT_MS / 1000} s after quit (it may be showing ` +
          "a dialog). Nothing was relaunched; check Notes.app."
      );
  }
  try {
    deps.launchNotes();
  } catch (error) {
    throw relaunchFailed(
      `Notes.app ${first.syncHostRunning ? "was quit but " : ""}could not be opened: ` +
        `${error instanceof Error ? error.message : String(error)}. Open Notes.app manually.`
    );
  }

  // Watch the counters without nudging, then report against the pre-relaunch
  // state. From here on Notes.app has been restarted, so a failure must say so.
  const restarted = first.syncHostRunning ? "quit and reopened" : "opened";
  let report: NudgeReport;
  try {
    report = await nudgeInPlace({ identifiers, waitSeconds, nudge: false }, deps);
  } catch (error) {
    throw relaunchFailed(
      `Notes.app was ${restarted}, but reading the sync state afterwards failed: ` +
        `${errorText(error)}. Check again with method status; do not relaunch again.`,
      { relaunched: true, syncHostRunningBefore: first.syncHostRunning }
    );
  }
  const firstById = new Map(first.objects.map((o) => [o.identifier, o]));
  for (const target of report.targets) {
    const was = firstById.get(target.identifier);
    target.before = versions(was);
    target.uploadPendingBefore = Boolean(was?.uploadPending);
    if (target.reason === null && target.uploadPendingBefore) target.action = "relaunch";
  }
  report.pendingUploadCountBefore = first.pendingUploadCount;
  const stillPending = report.targets.filter((r) => r.reason === null && !r.uploadRecorded);
  if (stillPending.length)
    report.warnings.push(
      `${stillPending.length} target(s) still show a pending upload after ${report.waitedSeconds} s. ` +
        "Notes.app uploads on its own schedule; check again later with method status."
    );

  // Folders the writer created or changed: does the relaunched Notes.app show
  // them (and no longer show deleted ones)?
  const afterById = new Map(report.after.objects.map((o) => [o.identifier, o]));
  const folderTargets = report.targets.filter((t) => t.kind === "folder");
  if (folderTargets.length) {
    const adoption = await checkFolderAdoption(
      folderTargets.map((t) => {
        const state = afterById.get(t.identifier);
        return {
          identifier: t.identifier,
          objectURI: state?.objectURI ?? null,
          deleted: Boolean(state?.markedForDeletion),
        };
      }),
      deps,
      RELAUNCH_ADOPTION_WAIT_SECONDS
    );
    const byId = new Map(adoption.folders.map((f) => [f.identifier, f]));
    for (const target of folderTargets) {
      const folder = byId.get(target.identifier);
      target.adoption = folder;
      target.adoptedByNotesApp = folder?.adoptedByNotesApp ?? null;
    }
    const notAdopted = folderTargets.filter((t) => t.adoptedByNotesApp !== true);
    if (notAdopted.length)
      report.warnings.push(
        `${notAdopted.length} folder(s) are not confirmed in Notes.app after the relaunch ` +
          `(${notAdopted.map((t) => `${t.identifier}: ${t.adoption?.reason ?? "unknown"}`).join("; ")}).`
      );
  }
  return pushReport(method, report, true, first.syncHostRunning);
}
