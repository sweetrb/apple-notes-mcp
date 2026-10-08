/**
 * Non-prompting public-helper diagnostics shared by the feature matrix and
 * doctor. `hello` and `speech_status` never open Notes, transcribe audio,
 * download a speech model, or request permission.
 */
import { z } from "zod";
import {
  PUBLIC_HELPER_PROTOCOL,
  callPublicHelper,
  inspectPublicHelper,
  publicHelloSchema,
  type PublicHelperInstallation,
} from "./publicHelper.js";

export type SpeechAuthorization = "authorized" | "denied" | "restricted" | "notDetermined";

export interface PublicHelperStatus {
  /** The installed digests and live protocol/action handshake both passed. */
  ready: boolean;
  reason: string | null;
  detail: string | null;
  actions: string[];
  speech: {
    authorization: SpeechAuthorization | null;
    requiresGrant: boolean | null;
    /** False when speech_status was not run or returned an invalid response. */
    verified: boolean;
    detail: string | null;
  };
}

export interface PublicHelperStatusDeps {
  inspect: () => PublicHelperInstallation;
  call: (action: "hello" | "speech_status") => Record<string, unknown>;
}

const speechStatusSchema = z.object({
  status: z.literal("ok"),
  speechAuthorization: z.enum(["authorized", "denied", "restricted", "notDetermined"]),
  requiresGrant: z.boolean(),
});

/** Explicit unknown status for injected/older probes that did not inspect the helper. */
export function unprobedPublicHelperStatus(): PublicHelperStatus {
  return {
    ready: false,
    reason: "not_probed",
    detail: "The public native helper has not been checked.",
    actions: [],
    speech: { authorization: null, requiresGrant: null, verified: false, detail: "Not probed." },
  };
}

/** Inspect one current helper, then make only bounded, non-prompting status calls. */
export function probePublicHelperStatus(
  deps: PublicHelperStatusDeps = {
    inspect: inspectPublicHelper,
    call: (action) => callPublicHelper(action, {}, undefined, { timeoutMs: 3000 }),
  }
): PublicHelperStatus {
  const result = unprobedPublicHelperStatus();
  try {
    const installed = deps.inspect();
    if (!installed.ready) return { ...result, reason: installed.reason, detail: installed.detail };
    const hello = publicHelloSchema.safeParse(deps.call("hello"));
    if (!hello.success)
      return {
        ...result,
        reason: "invalid_response",
        detail: "The helper returned an invalid handshake.",
      };
    if (
      hello.data.protocolVersion !== PUBLIC_HELPER_PROTOCOL ||
      hello.data.sourceSha256 !== installed.manifest?.sourceSha256
    )
      return {
        ...result,
        reason: "helper_stale",
        detail: "The helper handshake does not match the installed protocol and source.",
      };
    result.actions = hello.data.actions;
    const missing = ["decode_drawing", "transcribe", "speech_status"].filter(
      (action) => !result.actions.includes(action)
    );
    if (missing.length)
      return {
        ...result,
        reason: "helper_action_missing",
        detail: `The helper does not advertise: ${missing.join(", ")}.`,
      };
    result.ready = true;
    result.reason = null;
    result.detail =
      "Installed digests, protocol, and required actions verified; no drawing or audio was processed.";
  } catch (error) {
    return {
      ...result,
      reason: "helper_unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const speech = speechStatusSchema.safeParse(deps.call("speech_status"));
    if (!speech.success) {
      result.speech.detail = "The helper returned an unknown or invalid Speech Recognition status.";
    } else {
      result.speech = {
        authorization: speech.data.speechAuthorization,
        requiresGrant: speech.data.requiresGrant,
        verified: true,
        detail:
          "Permission status only; locale support and model availability are checked when transcription is requested.",
      };
    }
  } catch (error) {
    result.speech.detail = error instanceof Error ? error.message : String(error);
  }
  return result;
}
