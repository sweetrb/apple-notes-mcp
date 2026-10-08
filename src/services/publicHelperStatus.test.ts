import { describe, expect, it, vi } from "vitest";
vi.mock("./publicHelper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publicHelper.js")>()),
  inspectPublicHelper: vi.fn(),
  callPublicHelper: vi.fn(),
}));
import { callPublicHelper, inspectPublicHelper } from "./publicHelper.js";
import type { PublicHelperInstallation } from "./publicHelper.js";
import { probePublicHelperStatus } from "./publicHelperStatus.js";

function fixtures() {
  const installation = {
    ready: true,
    reason: null,
    detail: null,
    manifest: { sourceSha256: "source-digest" },
  } as PublicHelperInstallation;
  const hello = {
    status: "ok",
    protocolVersion: 1,
    sourceSha256: "source-digest",
    actions: ["hello", "decode_drawing", "transcribe", "speech_status"],
  };
  const speech = { status: "ok", speechAuthorization: "notDetermined", requiresGrant: false };
  const inspect = vi.fn(() => installation);
  const call = vi.fn((action: "hello" | "speech_status"): Record<string, unknown> =>
    action === "hello" ? hello : speech
  );
  return { installation, hello, speech, inspect, call };
}

describe("non-prompting public helper diagnostics", () => {
  it("bounds default diagnostic calls and supplies no note, media, or download context", () => {
    const f = fixtures();
    vi.mocked(inspectPublicHelper).mockReturnValueOnce(f.installation);
    vi.mocked(callPublicHelper).mockReturnValueOnce(f.hello).mockReturnValueOnce(f.speech);
    expect(probePublicHelperStatus().ready).toBe(true);
    expect(vi.mocked(callPublicHelper).mock.calls).toEqual([
      ["hello", {}, undefined, { timeoutMs: 3000 }],
      ["speech_status", {}, undefined, { timeoutMs: 3000 }],
    ]);
  });

  it("checks integrity, protocol and speech without processing media or requesting access", () => {
    const f = fixtures();
    const result = probePublicHelperStatus(f);
    expect(result).toMatchObject({
      ready: true,
      reason: null,
      speech: {
        verified: true,
        authorization: "notDetermined",
        requiresGrant: false,
      },
    });
    expect(f.call.mock.calls).toEqual([["hello"], ["speech_status"]]);
    expect(result.speech.detail).toContain("model availability");
  });

  it.each([
    "helper_not_installed",
    "helper_stale",
    "helper_modified",
    "helper_manifest_invalid",
  ] as const)("never launches a helper whose inspection reports %s", (reason) => {
    const f = fixtures();
    f.installation.ready = false;
    f.installation.reason = reason;
    expect(probePublicHelperStatus(f)).toMatchObject({
      ready: false,
      reason,
      speech: { verified: false },
    });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("refuses an incompatible protocol or source digest before speech inspection", () => {
    for (const change of [{ protocolVersion: 2 }, { sourceSha256: "other-source" }]) {
      const f = fixtures();
      Object.assign(f.hello, change);
      expect(probePublicHelperStatus(f)).toMatchObject({ ready: false, reason: "helper_stale" });
      expect(f.call.mock.calls).toEqual([["hello"]]);
    }
  });

  it("refuses an incomplete helper action contract", () => {
    const f = fixtures();
    f.hello.actions = ["hello", "decode_drawing"];
    expect(probePublicHelperStatus(f)).toMatchObject({
      ready: false,
      reason: "helper_action_missing",
    });
    expect(f.call.mock.calls).toEqual([["hello"]]);
  });

  it("reports invalid and unreachable handshakes without claiming readiness", () => {
    const f = fixtures();
    f.call.mockReturnValueOnce({ status: "ok" });
    expect(probePublicHelperStatus(f).reason).toBe("invalid_response");
    f.call.mockImplementationOnce(() => {
      throw new Error("timed out");
    });
    expect(probePublicHelperStatus(f)).toMatchObject({
      ready: false,
      reason: "helper_unreachable",
    });
  });

  it.each([
    { status: "ok", speechAuthorization: "unknown", requiresGrant: false },
    { status: "ok", speechAuthorization: "authorized" },
    { status: "ok", speechAuthorization: "authorized", requiresGrant: "false" },
  ])("keeps unknown speech status unverified without disabling drawing decode", (speech) => {
    const f = fixtures();
    f.call.mockImplementation((action) => (action === "hello" ? f.hello : speech));
    expect(probePublicHelperStatus(f)).toMatchObject({
      ready: true,
      speech: {
        verified: false,
        authorization: null,
        requiresGrant: null,
      },
    });
  });

  it("keeps speech call failures explicit without retrying or prompting", () => {
    const f = fixtures();
    f.call.mockImplementation((action) => {
      if (action === "speech_status") throw new Error("speech status unavailable");
      return f.hello;
    });
    expect(probePublicHelperStatus(f)).toMatchObject({
      ready: true,
      speech: {
        verified: false,
        detail: "speech status unavailable",
      },
    });
    expect(f.call).toHaveBeenCalledTimes(2);
  });
});
