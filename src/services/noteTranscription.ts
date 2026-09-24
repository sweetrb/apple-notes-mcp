/**
 * transcribe-note-audio: on-device transcription of a note's audio
 * attachments through the public native helper (Speech framework).
 *
 * Audio files are opened read-only by the helper. Recognition never leaves the
 * Mac: SpeechAnalyzer on macOS 26+, or SFSpeechRecognizer with on-device
 * recognition required on older systems. The helper never asks for Speech
 * Recognition access and never downloads a speech model unless the caller
 * opts in with `downloadAssets`.
 *
 * Each take runs in an asynchronous child process, so the server keeps
 * answering other requests. The whole call has one time budget
 * (`maxSeconds`), and cancelling the MCP request kills the running helper.
 *
 * @module services/noteTranscription
 */
import { z } from "zod";
import type {
  NoteTranscriptionResult,
  TranscribedRecording,
  TranscribedTake,
  TranscriptionStatus,
} from "@/types.js";
import {
  countWords,
  readAudioAssets,
  type AudioRecordingAsset,
  type AudioTake,
} from "@/utils/noteAudio.js";
import {
  callPublicHelperAsync,
  defaultPublicHelperDeps,
  inspectPublicHelper,
  PublicHelperError,
  type PublicHelperDeps,
} from "./publicHelper.js";

export const DEFAULT_TRANSCRIPTION_LOCALE = "en-US";
/** BCP-47-shaped: a 2-3 letter language, then letter/digit subtags. */
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;

/** Total time one call may spend across all takes, in seconds. */
export const TRANSCRIBE_MAX_SECONDS = { default: 900, min: 30, max: 3600 } as const;

/** Seconds the helper may spend on one take before returning what it has. */
export function takeDeadlineSeconds(durationSeconds: number | null): number {
  const duration = durationSeconds ?? 600;
  return Math.min(1800, Math.max(60, Math.ceil(duration * 1.5) + 60));
}

/** Grace after the helper's own deadline before the server gives up on it. */
const KILL_GRACE_MS = 30_000;
/** Budget kept back from a take's helper deadline so the kill still lands inside the call's budget. */
const BUDGET_MARGIN_MS = 10_000;
/** The helper's own minimum deadline; a take with less budget left is not started. */
const MIN_TAKE_SECONDS = 5;

/**
 * Helper codes that hold for every take in the call (the host app's Speech
 * Recognition access, the locale's model, the Mac's support). After the first
 * one, the remaining takes reuse it instead of starting the helper again.
 */
const CALL_WIDE_CODES: ReadonlySet<string> = new Set([
  "permission_required",
  "permission_not_requested",
  "asset_unavailable",
  "unsupported_locale",
  "speech_unavailable",
]);

const helperTranscriptSchema = z.object({
  status: z.literal("ok"),
  transcript: z.string(),
  complete: z.boolean(),
  stopReason: z.string().optional(),
  engine: z.string().optional(),
  durationSeconds: z.number().optional(),
});

export interface TranscribeOptions {
  locale?: string;
  /** Only this top-level audio attachment (x-coredata ICAttachment id). */
  attachmentId?: string;
  /** Include transcript text (default true). false returns statuses and counts only. */
  includeText?: boolean;
  /**
   * Let macOS download the locale's on-device speech model when it is missing
   * (default false: the take returns `asset_unavailable` at once).
   */
  downloadAssets?: boolean;
  /** Total time budget for the call in seconds (default 900, 30 to 3600). */
  maxSeconds?: number;
  /** Aborting (the MCP request was cancelled) kills the running helper and rejects. */
  signal?: AbortSignal;
  /** Test seams. */
  deps?: PublicHelperDeps;
  readAssets?: (noteId: string) => AudioRecordingAsset[];
  now?: () => number;
}

interface TakeOutcome {
  take: TranscribedTake;
  text: string;
}

/** Per-call state shared by every take: the fixed request fields, the budget, and a call-wide failure. */
interface CallContext {
  locale: string;
  downloadAssets: boolean;
  deps: PublicHelperDeps;
  signal?: AbortSignal;
  now: () => number;
  deadlineAt: number;
  maxSeconds: number;
  callWide: { code: string; message: string } | null;
}

async function transcribeTake(take: AudioTake, ctx: CallContext): Promise<TakeOutcome> {
  const base: TranscribedTake = {
    attachmentId: take.attachmentId,
    identifier: take.identifier,
    status: "error",
    ...(take.durationSeconds !== null ? { durationSeconds: Math.round(take.durationSeconds) } : {}),
  };
  const failed = (code: string, message: string): TakeOutcome => ({
    take: { ...base, code, message },
    text: "",
  });
  if (!take.path)
    return failed(
      "asset_unavailable",
      "The audio file is not on this Mac (it may not have downloaded from iCloud yet)."
    );
  if (ctx.callWide) return failed(ctx.callWide.code, ctx.callWide.message);
  const remainingMs = ctx.deadlineAt - ctx.now();
  const deadline = Math.min(
    takeDeadlineSeconds(take.durationSeconds),
    Math.floor((remainingMs - BUDGET_MARGIN_MS) / 1000)
  );
  if (deadline < MIN_TAKE_SECONDS)
    return failed(
      "time_limit",
      `Not started: the call's ${ctx.maxSeconds}-second limit was reached. ` +
        "Transcribe this recording on its own with attachmentId, or raise maxSeconds."
    );
  let raw: Record<string, unknown>;
  try {
    raw = await callPublicHelperAsync(
      "transcribe",
      {
        path: take.path,
        locale: ctx.locale,
        timeoutSeconds: deadline,
        downloadAssets: ctx.downloadAssets,
      },
      ctx.deps,
      { timeoutMs: Math.min(deadline * 1000 + KILL_GRACE_MS, remainingMs), signal: ctx.signal }
    );
  } catch (error) {
    const code = error instanceof PublicHelperError ? error.code : "internal_error";
    // A cancelled request has no one to answer; stop the whole call.
    if (code === "aborted") throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (CALL_WIDE_CODES.has(code)) ctx.callWide = { code, message };
    return {
      take: {
        ...base,
        // A timeout means the helper was killed mid-run: the outcome is unknown.
        status: code === "timeout" ? "indeterminate" : "error",
        code,
        message,
      },
      text: "",
    };
  }
  const parsed = helperTranscriptSchema.safeParse(raw);
  if (!parsed.success) return failed("invalid_response", "Unexpected helper response.");
  const { transcript, complete, stopReason, engine, durationSeconds } = parsed.data;
  const text = transcript.trim();
  return {
    take: {
      ...base,
      status: complete ? "ok" : text ? "partial" : "indeterminate",
      ...(complete ? {} : { code: "incomplete", message: stopReason ?? "stopped early" }),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      wordCount: countWords(text),
      ...(engine ? { engine } : {}),
    },
    text,
  };
}

/** Combines per-part statuses: all ok, some text, nothing but unknowns, or failure. */
export function combineStatus(
  parts: Array<{ status: TranscriptionStatus; hasText: boolean }>
): TranscriptionStatus {
  if (parts.length && parts.every((p) => p.status === "ok")) return "ok";
  if (parts.some((p) => p.hasText)) return "partial";
  if (parts.some((p) => p.status === "indeterminate")) return "indeterminate";
  return "error";
}

async function transcribeRecording(
  asset: AudioRecordingAsset,
  includeText: boolean,
  ctx: CallContext
): Promise<TranscribedRecording> {
  // Takes run one after another: the budget and call-wide failures carry over.
  const outcomes: TakeOutcome[] = [];
  for (const take of asset.takes) outcomes.push(await transcribeTake(take, ctx));
  const transcript = outcomes
    .map((o) => o.text)
    .filter(Boolean)
    .join("\n\n");
  const status = combineStatus(
    outcomes.map((o) => ({ status: o.take.status, hasText: o.text.length > 0 }))
  );
  const firstProblem = outcomes.find((o) => o.take.status !== "ok")?.take;
  return {
    attachmentId: asset.attachmentId,
    identifier: asset.identifier,
    typeUti: asset.typeUti,
    status,
    ...(status !== "ok" && firstProblem?.code
      ? { code: firstProblem.code, message: firstProblem.message }
      : {}),
    ...(asset.durationSeconds !== null
      ? { durationSeconds: Math.round(asset.durationSeconds) }
      : {}),
    wordCount: countWords(transcript),
    ...(includeText ? { transcript } : {}),
    takes: outcomes.map((o) => o.take),
  };
}

/**
 * Transcribes every audio attachment in the note (or one, with attachmentId).
 * Per-recording failures do not fail the call. Note-level problems throw
 * NoteStoreError or a coded error; an unusable helper throws PublicHelperError
 * once; a cancelled request rejects with PublicHelperError code `aborted`.
 */
export async function transcribeNoteAudio(
  noteId: string,
  options: TranscribeOptions = {}
): Promise<NoteTranscriptionResult> {
  const locale = options.locale ?? DEFAULT_TRANSCRIPTION_LOCALE;
  if (!LOCALE_PATTERN.test(locale))
    throw new PublicHelperError("invalid_request", `"${locale}" is not a BCP-47 locale.`);
  const maxSeconds = options.maxSeconds ?? TRANSCRIBE_MAX_SECONDS.default;
  if (
    !Number.isInteger(maxSeconds) ||
    maxSeconds < TRANSCRIBE_MAX_SECONDS.min ||
    maxSeconds > TRANSCRIBE_MAX_SECONDS.max
  )
    throw new PublicHelperError(
      "invalid_request",
      `maxSeconds must be a whole number from ${TRANSCRIBE_MAX_SECONDS.min} to ${TRANSCRIBE_MAX_SECONDS.max}.`
    );
  const deps = options.deps ?? defaultPublicHelperDeps();
  let assets = (options.readAssets ?? ((id: string) => readAudioAssets(id)))(noteId);
  if (options.attachmentId) {
    assets = assets.filter((a) => a.attachmentId === options.attachmentId);
    if (assets.length === 0)
      throw new PublicHelperError(
        "attachment_not_found",
        `No audio attachment ${options.attachmentId} in note ${noteId}.`
      );
  }
  const empty = { id: noteId, locale, recordingCount: 0, recordings: [] };
  if (assets.length === 0) return { ...empty, status: "none" };
  const install = inspectPublicHelper(deps);
  if (!install.ready)
    throw new PublicHelperError(install.reason ?? "helper_not_installed", install.detail ?? "");
  const now = options.now ?? Date.now;
  const ctx: CallContext = {
    locale,
    downloadAssets: options.downloadAssets ?? false,
    deps,
    signal: options.signal,
    now,
    deadlineAt: now() + maxSeconds * 1000,
    maxSeconds,
    callWide: null,
  };
  const recordings: TranscribedRecording[] = [];
  for (const asset of assets)
    recordings.push(await transcribeRecording(asset, options.includeText ?? true, ctx));
  return {
    ...empty,
    status: combineStatus(
      recordings.map((r) => ({ status: r.status, hasText: (r.wordCount ?? 0) > 0 }))
    ),
    recordingCount: recordings.length,
    recordings,
  };
}

/**
 * Shortens transcripts evenly until `measure` fits `maxBytes`, marking each
 * shortened recording. Counts and statuses are never changed. Pass a `measure`
 * of the whole tool response: the transcripts travel in both the text and the
 * structured content. When even empty transcripts do not fit, the transcripts
 * are dropped and `responseOversized` is set, so the caller can tell.
 */
export function fitTranscriptions(
  result: NoteTranscriptionResult,
  maxBytes: number,
  measure: (r: NoteTranscriptionResult) => number = (r) => Buffer.byteLength(JSON.stringify(r))
): NoteTranscriptionResult {
  if (measure(result) <= maxBytes) return result;
  const shorten = (share: number): NoteTranscriptionResult => ({
    ...result,
    recordings: result.recordings.map((r) =>
      r.transcript
        ? {
            ...r,
            transcript: r.transcript.slice(0, Math.floor(r.transcript.length * share)),
            transcriptTruncated: true,
          }
        : r
    ),
  });
  let next = result;
  for (let share = 0.5; measure(next) > maxBytes && share > 0.0001; share /= 2) {
    next = shorten(share);
  }
  if (measure(next) > maxBytes) next = { ...shorten(0), responseOversized: true };
  return next;
}

/** Human summary: statuses and counts only, then each transcript when present. */
export function formatTranscription(result: NoteTranscriptionResult): string {
  if (result.recordingCount === 0) return `No audio attachments in note ${result.id}.`;
  const lines = [
    ...(result.responseOversized
      ? [
          "The transcripts were dropped: even without them the response exceeds APPLE_NOTES_MCP_EXPORT_MAX_BYTES. Transcribe one recording at a time with attachmentId.",
        ]
      : []),
    `${result.recordingCount} audio attachment${result.recordingCount === 1 ? "" : "s"} in note ${result.id} (${result.status}, locale ${result.locale}):`,
  ];
  result.recordings.forEach((r, i) => {
    const facts = [
      `status ${r.status}`,
      ...(r.durationSeconds !== undefined ? [`${r.durationSeconds} s`] : []),
      `${r.wordCount ?? 0} words`,
      ...(r.takes.length > 1 ? [`${r.takes.length} takes`] : []),
      ...(r.code ? [`${r.code}: ${r.message}`] : []),
    ];
    lines.push("", `[${i + 1}] ${r.attachmentId} (${facts.join(", ")})`);
    if (r.transcript)
      lines.push(r.transcriptTruncated ? `${r.transcript} [truncated]` : r.transcript);
  });
  return lines.join("\n");
}
