import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

type Answer = Record<string, unknown> | { kill: true } | { crash: true } | { hang: true };

/**
 * A fake child process: it reads the request from stdin, then answers by audio
 * path. `kill` exits on a signal, `hang` never answers until it is killed.
 */
function fakeSpawn(
  answers: Record<string, Answer>,
  seen: Array<Record<string, unknown>>,
  killed: string[]
): typeof spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stdin: EventEmitter & { end: (input: string) => void };
      kill: (signal: string) => boolean;
    };
    child.stdout = new EventEmitter();
    let path = "";
    const close = (status: number | null, signal: string | null) =>
      queueMicrotask(() => child.emit("close", status, signal));
    child.kill = (signal: string) => {
      killed.push(`${path}:${signal}`);
      close(null, signal);
      return true;
    };
    const stdin = new EventEmitter() as EventEmitter & { end: (input: string) => void };
    stdin.end = (input: string) => {
      const request = JSON.parse(input) as { path: string };
      path = request.path;
      seen.push(request);
      const answer = answers[request.path];
      if (answer && "hang" in answer) return;
      if (answer && "kill" in answer) return close(null, "SIGKILL");
      if (answer && "crash" in answer) {
        queueMicrotask(() => child.emit("error", new Error("spawn exploded")));
        return;
      }
      const body = answer ?? { status: "error", code: "unsupported_audio", message: "bad" };
      child.stdout.emit("data", Buffer.from(JSON.stringify(body)));
      close(body.status === "ok" ? 0 : 1, null);
    };
    child.stdin = stdin;
    return child;
  }) as unknown as typeof spawn;
}

/** Installed-helper deps whose async spawn answers transcribe requests by audio path. */
function helperDeps(
  answers: Record<string, Answer>,
  installed = true,
  seen: Array<Record<string, unknown>> = [],
  killed: string[] = []
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
    spawn: (() => {
      throw new Error("transcription must not use spawnSync");
    }) as never,
    spawnAsync: fakeSpawn(answers, seen, killed),
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
  it("transcribes every take, joins them, and counts words", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await transcribeNoteAudio(NOTE, {
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
    // The helper deadline scales with duration; no model download unless asked.
    expect(seen[0]).toMatchObject({
      path: "/a1",
      locale: "it-IT",
      timeoutSeconds: 75,
      downloadAssets: false,
    });
  });

  it("marks partial, indeterminate and error outcomes per take and per recording", async () => {
    const result = await transcribeNoteAudio(NOTE, {
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
      ["error", "helper_crashed", "error:helper_crashed,error:unsupported_audio"],
      ["error", "unsupported_audio", "error:unsupported_audio,error:asset_unavailable"],
      ["indeterminate", "incomplete", "indeterminate:incomplete"],
      ["error", "invalid_response", "error:invalid_response,error:helper_unreachable"],
    ]);
    expect(result.status).toBe("partial");
    expect(formatTranscription(result)).toContain("status indeterminate");
  });

  it("returns counts only when includeText is false", async () => {
    const result = await transcribeNoteAudio(NOTE, {
      includeText: false,
      deps: helperDeps({ "/a": ok("one two three") }),
      readAssets: () => [asset(1, [{ path: "/a" }])],
    });
    expect(result.recordings[0]).not.toHaveProperty("transcript");
    expect(result.recordings[0].wordCount).toBe(3);
    expect(formatTranscription(result)).not.toContain("one two three");
  });

  it("filters to one attachment and rejects an unknown one", async () => {
    const deps = helperDeps({ "/a": ok("a"), "/b": ok("b c") });
    const assets = () => [asset(1, [{ path: "/a" }]), asset(2, [{ path: "/b" }], "public.mp3")];
    const one = await transcribeNoteAudio(NOTE, {
      attachmentId: "x-coredata://S/ICAttachment/p2",
      deps,
      readAssets: assets,
    });
    expect(one.recordings.map((r) => r.identifier)).toEqual(["R2"]);
    await expect(
      transcribeNoteAudio(NOTE, {
        attachmentId: "x-coredata://S/ICAttachment/p9",
        deps,
        readAssets: assets,
      })
    ).rejects.toThrow(/No audio attachment/);
  });

  it("reports none, validates the locale and budget, and needs an installed helper only when audio exists", async () => {
    await expect(
      transcribeNoteAudio(NOTE, { deps: helperDeps({}, false), readAssets: () => [] })
    ).resolves.toEqual({
      id: NOTE,
      locale: "en-US",
      status: "none",
      recordingCount: 0,
      recordings: [],
    });
    await expect(
      transcribeNoteAudio(NOTE, { locale: "en US; rm", deps: helperDeps({}), readAssets: () => [] })
    ).rejects.toThrow(PublicHelperError);
    for (const maxSeconds of [29, 3601, 60.5])
      await expect(
        transcribeNoteAudio(NOTE, { maxSeconds, deps: helperDeps({}), readAssets: () => [] })
      ).rejects.toThrow(/maxSeconds must be/);
    await expect(
      transcribeNoteAudio(NOTE, {
        deps: helperDeps({}, false),
        readAssets: () => [asset(1, [{ path: "/a" }])],
      })
    ).rejects.toThrow(/setup --public-helper/);
  });
});

describe("permission and model assets", () => {
  it("stops at the first permission_required and reuses it for every later take", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const denied = {
      status: "error",
      code: "permission_required",
      message: "Allow the app in System Settings > Privacy & Security > Speech Recognition",
    };
    const result = await transcribeNoteAudio(NOTE, {
      deps: helperDeps({ "/a": denied, "/b": ok("never asked") }, true, seen),
      readAssets: () => [asset(1, [{ path: "/a" }, { path: "/b" }]), asset(2, [{ path: "/b" }])],
    });
    // The helper ran once; the other two takes were answered without spawning it.
    expect(seen.map((r) => r.path)).toEqual(["/a"]);
    expect(result.status).toBe("error");
    expect(result.recordings.flatMap((r) => r.takes.map((t) => t.code))).toEqual([
      "permission_required",
      "permission_required",
      "permission_required",
    ]);
    expect(result.recordings[0].message).toMatch(/Privacy & Security > Speech Recognition/);
  });

  it("passes downloadAssets only when the caller opts in", async () => {
    const missing = {
      status: "error",
      code: "asset_unavailable",
      message: "not installed; retry with downloadAssets: true",
    };
    const seen: Array<Record<string, unknown>> = [];
    const refused = await transcribeNoteAudio(NOTE, {
      deps: helperDeps({ "/a": missing, "/b": missing }, true, seen),
      readAssets: () => [asset(1, [{ path: "/a" }, { path: "/b" }])],
    });
    expect(refused.recordings[0].code).toBe("asset_unavailable");
    expect(seen).toHaveLength(1);
    expect(seen[0].downloadAssets).toBe(false);

    const optedIn: Array<Record<string, unknown>> = [];
    const downloaded = await transcribeNoteAudio(NOTE, {
      downloadAssets: true,
      deps: helperDeps({ "/a": ok("bonjour") }, true, optedIn),
      readAssets: () => [asset(1, [{ path: "/a" }])],
    });
    expect(downloaded.status).toBe("ok");
    expect(optedIn[0].downloadAssets).toBe(true);
  });
});

describe("abort and the total time cap", () => {
  it("kills the running helper when the request is aborted", async () => {
    const killed: string[] = [];
    const controller = new AbortController();
    const pending = transcribeNoteAudio(NOTE, {
      signal: controller.signal,
      deps: helperDeps({ "/slow": { hang: true }, "/next": ok("x") }, true, [], killed),
      readAssets: () => [asset(1, [{ path: "/slow" }, { path: "/next" }])],
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(killed).toEqual(["/slow:SIGKILL"]);
  });

  it("never starts the helper for an already aborted request", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await expect(
      transcribeNoteAudio(NOTE, {
        signal: AbortSignal.abort(),
        deps: helperDeps({ "/a": ok("x") }, true, seen),
        readAssets: () => [asset(1, [{ path: "/a" }])],
      })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
  });

  it("shares one budget across takes and skips takes once it runs out", async () => {
    let clock = 0;
    const seen: Array<Record<string, unknown>> = [];
    // Each take "takes" 25 s of the 60 s budget.
    const deps = helperDeps({ "/a": ok("one"), "/b": ok("two"), "/c": ok("three") }, true, seen);
    const inner = deps.spawnAsync!;
    deps.spawnAsync = ((...args: Parameters<typeof spawn>) => {
      clock += 25_000;
      return inner(...args);
    }) as typeof spawn;
    const result = await transcribeNoteAudio(NOTE, {
      maxSeconds: 60,
      now: () => clock,
      deps,
      readAssets: () => [
        asset(1, [
          { path: "/a", duration: 600 },
          { path: "/b", duration: 600 },
        ]),
        asset(2, [{ path: "/c", duration: 600 }]),
      ],
    });
    // Take deadlines shrink to what is left minus a 10 s margin: 50 s, then 25 s.
    expect(seen.map((r) => [r.path, r.timeoutSeconds])).toEqual([
      ["/a", 50],
      ["/b", 25],
    ]);
    expect(result.recordings[0].status).toBe("ok");
    expect(result.recordings[1]).toMatchObject({ status: "error", code: "time_limit" });
    expect(result.recordings[1].message).toMatch(/60-second limit/);
    expect(result.status).toBe("partial");
  });

  it("kills a take that outlives its share of the budget and reports it indeterminate", async () => {
    vi.useFakeTimers();
    try {
      const killed: string[] = [];
      const seen: Array<Record<string, unknown>> = [];
      let started = false;
      const pending = transcribeNoteAudio(NOTE, {
        maxSeconds: 30,
        // 15 s of the 30 s budget are gone when the take starts: a 5 s helper
        // deadline, and the server's kill lands when the remaining 15 s run out.
        now: () => (started ? 15_000 : ((started = true), 0)),
        deps: helperDeps({ "/slow": { hang: true } }, true, seen, killed),
        readAssets: () => [asset(1, [{ path: "/slow" }])],
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(killed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(seen[0].timeoutSeconds).toBe(5);
      expect(killed).toEqual(["/slow:SIGKILL"]);
      expect(result.recordings[0]).toMatchObject({ status: "indeterminate", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
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

  it("shortens transcripts to fit a byte budget and leaves small results alone", async () => {
    const result = await transcribeNoteAudio(NOTE, {
      deps: helperDeps({ "/a": ok("word ".repeat(2000)), "/b": ok("") }),
      readAssets: () => [asset(1, [{ path: "/a" }]), asset(2, [{ path: "/b" }])],
    });
    expect(fitTranscriptions(result, 1_000_000)).toBe(result);
    const fitted = fitTranscriptions(result, 2_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(2_000);
    expect(fitted.recordings[0]).toMatchObject({ transcriptTruncated: true, wordCount: 2000 });
    expect(formatTranscription(fitted)).toContain("[truncated]");
  });

  it("fits a measure that counts the transcript twice, and flags a response that cannot fit (#231)", async () => {
    const result = await transcribeNoteAudio(NOTE, {
      deps: helperDeps({ "/a": ok("word ".repeat(2000)) }),
      readAssets: () => [asset(1, [{ path: "/a" }])],
    });
    // The tool sends the transcript in the text summary and in structuredContent.
    const twice = (r: typeof result) =>
      Buffer.byteLength(formatTranscription(r)) + Buffer.byteLength(JSON.stringify(r));
    const fitted = fitTranscriptions(result, 6_000, twice);
    expect(twice(fitted)).toBeLessThanOrEqual(6_000);
    expect(fitted.responseOversized).toBeUndefined();
    const hopeless = fitTranscriptions(result, 100, twice);
    expect(hopeless.responseOversized).toBe(true);
    expect(hopeless.recordings[0]).toMatchObject({ transcript: "", transcriptTruncated: true });
    expect(hopeless.recordings[0].wordCount).toBe(2000);
    expect(formatTranscription(hopeless)).toMatch(/transcripts were dropped/);
  });

  it("reuses permission_not_requested for every later take like permission_required", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await transcribeNoteAudio(NOTE, {
      deps: helperDeps(
        {
          "/a": { status: "error", code: "permission_not_requested", message: "never asked" },
          "/b": ok("unused"),
        },
        true,
        seen
      ),
      readAssets: () => [asset(1, [{ path: "/a" }]), asset(2, [{ path: "/b" }])],
    });
    expect(seen).toHaveLength(1);
    expect(result.recordings.map((r) => r.code)).toEqual([
      "permission_not_requested",
      "permission_not_requested",
    ]);
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
