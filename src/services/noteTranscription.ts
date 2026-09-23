/**
 * transcribe-note-audio: on-device transcription of a note's audio
 * attachments through the public native helper (Speech framework).
 *
 * Audio files are opened read-only by the helper. Recognition never leaves the
 * Mac: SpeechAnalyzer on macOS 26+, or SFSpeechRecognizer with on-device
 * recognition required on older systems.
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
  callPublicHelper,
  defaultPublicHelperDeps,
  inspectPublicHelper,
  PublicHelperError,
  type PublicHelperDeps,
} from "./publicHelper.js";

export const DEFAULT_TRANSCRIPTION_LOCALE = "en-US";
/** BCP-47-shaped: a 2-3 letter language, then letter/digit subtags. */
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;

/** Seconds the helper may spend on one take before returning what it has. */
export function takeDeadlineSeconds(durationSeconds: number | null): number {
  const duration = durationSeconds ?? 600;
  return Math.min(1800, Math.max(60, Math.ceil(duration * 1.5) + 60));
}

/** Grace after the helper's own deadline before the server gives up on it. */
const KILL_GRACE_MS = 30_000;

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
  /** Test seams. */
  deps?: PublicHelperDeps;
  readAssets?: (noteId: string) => AudioRecordingAsset[];
}

interface TakeOutcome {
  take: TranscribedTake;
  text: string;
}

function transcribeTake(take: AudioTake, locale: string, deps: PublicHelperDeps): TakeOutcome {
  const base: TranscribedTake = {
    attachmentId: take.attachmentId,
    identifier: take.identifier,
    status: "error",
    ...(take.durationSeconds !== null ? { durationSeconds: Math.round(take.durationSeconds) } : {}),
  };
  if (!take.path)
    return {
      take: {
        ...base,
        code: "asset_unavailable",
        message: "The audio file is not on this Mac (it may not have downloaded from iCloud yet).",
      },
      text: "",
    };
  const deadline = takeDeadlineSeconds(take.durationSeconds);
  let raw: Record<string, unknown>;
  try {
    raw = callPublicHelper(
      "transcribe",
      { path: take.path, locale, timeoutSeconds: deadline },
      deps,
      { timeoutMs: deadline * 1000 + KILL_GRACE_MS }
    );
  } catch (error) {
    const code = error instanceof PublicHelperError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : String(error);
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
  if (!parsed.success)
    return {
      take: { ...base, code: "invalid_response", message: "Unexpected helper response." },
      text: "",
    };
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

function transcribeRecording(
  asset: AudioRecordingAsset,
  locale: string,
  includeText: boolean,
  deps: PublicHelperDeps
): TranscribedRecording {
  const outcomes = asset.takes.map((take) => transcribeTake(take, locale, deps));
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
 * NoteStoreReadError; an unusable helper throws PublicHelperError once.
 */
export function transcribeNoteAudio(
  noteId: string,
  options: TranscribeOptions = {}
): NoteTranscriptionResult {
  const locale = options.locale ?? DEFAULT_TRANSCRIPTION_LOCALE;
  if (!LOCALE_PATTERN.test(locale))
    throw new PublicHelperError("invalid_request", `"${locale}" is not a BCP-47 locale.`);
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
  const recordings = assets.map((asset) =>
    transcribeRecording(asset, locale, options.includeText ?? true, deps)
  );
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
 * shortened recording. Counts and statuses are never changed.
 */
export function fitTranscriptions(
  result: NoteTranscriptionResult,
  maxBytes: number,
  measure: (r: NoteTranscriptionResult) => number = (r) => Buffer.byteLength(JSON.stringify(r))
): NoteTranscriptionResult {
  if (measure(result) <= maxBytes) return result;
  let next = result;
  for (let share = 0.5; measure(next) > maxBytes && share > 0.0001; share /= 2) {
    next = {
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
    };
  }
  return next;
}

/** Human summary: statuses and counts only, then each transcript when present. */
export function formatTranscription(result: NoteTranscriptionResult): string {
  if (result.recordingCount === 0) return `No audio attachments in note ${result.id}.`;
  const lines = [
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
