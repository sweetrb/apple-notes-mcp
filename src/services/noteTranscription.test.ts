import type { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AudioRecordingAsset } from "@/utils/noteAudio.js";
import {
  combineStatus,
  fitTranscriptions,
  formatTranscription,
  takeDeadlineSeconds,
  transcribeNoteAudio,
} from "./noteTranscription.js";
import { PublicHelperError, type PublicHelperDeps } from "./publicHelper.js";

const NOTE = "x-coredata://S/ICNote/p1";

type Answer = Record<string, unknown> | { kill: true } | { crash: true };

/** Installed-helper deps whose spawn answers transcribe requests by audio path. */
function helperDeps(
  answers: Record<string, Answer>,
  installed = true,
  seen: Array<Record<string, unknown>> = []
): PublicHelperDeps {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    sourceSha256: sha("src"),
    binarySha256: sha("bin"),
    builtAt: "t",
    osVersion: "27",
    compiler: "swift",
  });
  return {
    env: { APPLE_NOTES_MCP_PUBLIC_HELPER_DIR: "/helper" },
    platform: "darwin",
    sourcePath: "/pkg/helper.swift",
    exists: (p) => installed || p === "/pkg/helper.swift",
    readFile: (p) =>
      Buffer.from(p.endsWith("manifest.json") ? manifest : p.endsWith(".swift") ? "src" : "bin"),
    spawn: ((_cmd: string, _args: string[], opts: { input: string; timeout: number }) => {
      const request = JSON.parse(opts.input) as { path: string };
      seen.push({ ...request, spawnTimeout: opts.timeout });
      const answer = answers[request.path];
      if (answer && "kill" in answer)
        return { status: null, signal: "SIGKILL", stdout: "", stderr: "", pid: 1, output: [] };
      if (answer && "crash" in answer) throw new TypeError("spawn exploded");
      const body = answer ?? { status: "error", code: "unsupported_audio", message: "bad" };
      return {
        status: body.status === "ok" ? 0 : 1,
        stdout: JSON.stringify(body),
        stderr: "",
        signal: null,
        pid: 1,
        output: [],
      };
    }) as unknown as typeof spawnSync,
  };
}

const ok = (transcript: string, complete = true, extra: Record<string, unknown> = {}) => ({
  status: "ok",
  transcript,
  complete,
  engine: "SpeechAnalyzer",
  durationSeconds: 7,
  ...extra,
});

const asset = (
  pk: number,
  takes: Array<{ path: string | null; duration?: number | null }>,
  uti = "com.apple.m4a-audio"
): AudioRecordingAsset => ({
  pk,
  attachmentId: `x-coredata://S/ICAttachment/p${pk}`,
  identifier: `R${pk}`,
  typeUti: uti,
  durationSeconds: takes.reduce((s, t) => s + (t.duration ?? 0), 0) || null,
  takes: takes.map((t, i) => ({
    attachmentId: `x-coredata://S/ICAttachment/p${pk * 10 + i}`,
    identifier: `T${pk}-${i}`,
    durationSeconds: t.duration ?? null,
    path: t.path,
  })),
});

describe("transcribeNoteAudio", () => {
  it("transcribes every take, joins them, and counts words", () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = transcribeNoteAudio(NOTE, {
      locale: "it-IT",
      deps: helperDeps({ "/a1": ok("uno due"), "/a2": ok("tre") }, true, seen),
      readAssets: () => [
        asset(1, [
          { path: "/a1", duration: 10 },
          { path: "/a2", duration: 2 },
        ]),
      ],
    });
    expect(result).toMatchObject({ id: NOTE, locale: "it-IT", status: "ok", recordingCount: 1 });
    const [rec] = result.recordings;
    expect(rec).toMatchObject({ status: "ok", wordCount: 3, transcript: "uno due\n\ntre" });
    expect(rec.takes.map((t) => [t.status, t.wordCount, t.engine])).toEqual([
      ["ok", 2, "SpeechAnalyzer"],
      ["ok", 1, "SpeechAnalyzer"],
    ]);
    // The helper deadline scales with duration; the kill timeout adds a grace period.
    expect(seen[0]).toMatchObject({ path: "/a1", locale: "it-IT", timeoutSeconds: 75 });
    expect(seen[0].spawnTimeout).toBe(75_000 + 30_000);
  });

  it("marks partial, indeterminate and error outcomes per take and per recording", () => {
    const result = transcribeNoteAudio(NOTE, {
      deps: helperDeps({
        "/ok": ok("fine words"),
        "/cut": ok("half", false, { stopReason: "deadline" }),
        "/empty-cut": ok("", false),
        "/killed": { kill: true },
        "/bad": { status: "error", code: "unsupported_audio", message: "no" },
        "/odd": { status: "ok" },
        "/crash": { crash: true },
      }),
      readAssets: () => [
        asset(1, [{ path: "/ok" }, { path: "/cut" }]),
        asset(2, [{ path: "/killed" }, { path: "/bad" }]),
        asset(3, [{ path: "/bad" }, { path: null }]),
        asset(4, [{ path: "/empty-cut" }]),
        asset(5, [{ path: "/odd" }, { path: "/crash" }]),
      ],
    });
    const summary = result.recordings.map((r) => [
      r.status,
      r.code ?? "-",
      r.takes.map((t) => `${t.status}:${t.code ?? "-"}`).join(","),
    ]);
    expect(summary).toEqual([
      ["partial", "incomplete", "ok:-,partial:incomplete"],
      ["indeterminate", "timeout", "indeterminate:timeout,error:unsupported_audio"],
      ["error", "unsupported_audio", "error:unsupported_audio,error:asset_unavailable"],
      ["indeterminate", "incomplete", "indeterminate:incomplete"],
      ["error", "invalid_response", "error:invalid_response,error:internal_error"],
    ]);
    expect(result.status).toBe("partial");
    expect(formatTranscription(result)).toContain("status indeterminate");
  });

  it("returns counts only when includeText is false", () => {
    const result = transcribeNoteAudio(NOTE, {
      includeText: false,
      deps: helperDeps({ "/a": ok("one two three") }),
      readAssets: () => [asset(1, [{ path: "/a" }])],
    });
    expect(result.recordings[0]).not.toHaveProperty("transcript");
    expect(result.recordings[0].wordCount).toBe(3);
    expect(formatTranscription(result)).not.toContain("one two three");
  });

  it("filters to one attachment and rejects an unknown one", () => {
    const deps = helperDeps({ "/a": ok("a"), "/b": ok("b c") });
    const assets = () => [asset(1, [{ path: "/a" }]), asset(2, [{ path: "/b" }], "public.mp3")];
    const one = transcribeNoteAudio(NOTE, {
      attachmentId: "x-coredata://S/ICAttachment/p2",
      deps,
      readAssets: assets,
    });
    expect(one.recordings.map((r) => r.identifier)).toEqual(["R2"]);
    expect(() =>
      transcribeNoteAudio(NOTE, {
        attachmentId: "x-coredata://S/ICAttachment/p9",
        deps,
        readAssets: assets,
      })
    ).toThrow(/No audio attachment/);
  });

  it("reports none, validates the locale, and needs an installed helper only when audio exists", () => {
    expect(
      transcribeNoteAudio(NOTE, { deps: helperDeps({}, false), readAssets: () => [] })
    ).toEqual({ id: NOTE, locale: "en-US", status: "none", recordingCount: 0, recordings: [] });
    expect(() =>
      transcribeNoteAudio(NOTE, { locale: "en US; rm", deps: helperDeps({}), readAssets: () => [] })
    ).toThrow(PublicHelperError);
    expect(() =>
      transcribeNoteAudio(NOTE, {
        deps: helperDeps({}, false),
        readAssets: () => [asset(1, [{ path: "/a" }])],
      })
    ).toThrow(/setup --public-helper/);
  });
});

describe("helpers", () => {
  it("scales the per-take deadline and clamps it", () => {
    expect(takeDeadlineSeconds(0)).toBe(60);
    expect(takeDeadlineSeconds(null)).toBe(960);
    expect(takeDeadlineSeconds(100)).toBe(210);
    expect(takeDeadlineSeconds(100_000)).toBe(1800);
  });

  it("combines statuses", () => {
    expect(combineStatus([])).toBe("error");
    expect(combineStatus([{ status: "ok", hasText: true }])).toBe("ok");
    expect(
      combineStatus([
        { status: "error", hasText: false },
        { status: "indeterminate", hasText: false },
      ])
    ).toBe("indeterminate");
  });

  it("shortens transcripts to fit a byte budget and leaves small results alone", () => {
    const result = transcribeNoteAudio(NOTE, {
      deps: helperDeps({ "/a": ok("word ".repeat(2000)), "/b": ok("") }),
      readAssets: () => [asset(1, [{ path: "/a" }]), asset(2, [{ path: "/b" }])],
    });
    expect(fitTranscriptions(result, 1_000_000)).toBe(result);
    const fitted = fitTranscriptions(result, 2_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(2_000);
    expect(fitted.recordings[0]).toMatchObject({ transcriptTruncated: true, wordCount: 2000 });
    expect(formatTranscription(fitted)).toContain("[truncated]");
  });

  it("formats an empty note", () => {
    expect(
      formatTranscription({
        id: NOTE,
        locale: "en-US",
        status: "none",
        recordingCount: 0,
        recordings: [],
      })
    ).toBe(`No audio attachments in note ${NOTE}.`);
  });
});
