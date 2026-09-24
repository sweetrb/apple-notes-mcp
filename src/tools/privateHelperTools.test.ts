import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateHelper.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  privateHelperCapabilities: vi.fn(),
  readNoteState: vi.fn(),
}));
import {
  PrivateHelperError,
  privateHelperCapabilities,
  readNoteState,
} from "../services/privateHelper.js";
import { ERROR_CODES } from "../utils/errorCodes.js";
import { envelopeCode, registerPrivateHelperTools } from "./privateHelperTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";

function fixture(link: string | null = `notes://showNote?identifier=${NOTE}`) {
  const registerTool = vi.fn();
  const manager = { getNoteLinkById: vi.fn(() => link) } as unknown as AppleNotesManager;
  registerPrivateHelperTools(
    { registerTool } as unknown as McpServer,
    manager,
    () => ({}) as never
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error(`missing ${name}`);
    return item[2](args);
  };
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  const names = () => registerTool.mock.calls.map((c) => c[0]);
  return { call, config, manager, names };
}

beforeEach(() => vi.clearAllMocks());

describe("private helper tools", () => {
  it("registers only the two read-only tools, and says so", () => {
    const { config, names } = fixture();
    expect(names()).toEqual(["native-helper-status", "native-note-state"]);
    for (const name of names()) {
      expect(config(name).annotations.readOnlyHint).toBe(true);
      expect(config(name).description).toMatch(/Safety: read-only/);
    }
    expect(config("native-helper-status").description).toMatch(/deliberately deferred/);
    expect(names()).not.toContain("native-append-plain-text");
  });

  it("status adds the setup command while the helper is not installed", async () => {
    vi.mocked(privateHelperCapabilities).mockReturnValueOnce({
      enabled: true,
      readOnly: true,
      installation: { ready: false } as never,
      probe: null,
      features: {} as never,
    });
    const r = await fixture().call("native-helper-status", {});
    expect(r.structuredContent).toMatchObject({
      ok: true,
      readOnly: true,
      setupCommand: "apple-notes-mcp setup --native-helper",
    });
    vi.mocked(privateHelperCapabilities).mockReturnValueOnce({
      enabled: true,
      readOnly: true,
      installation: { ready: true } as never,
      probe: null,
      features: {} as never,
    });
    const ready = await fixture().call("native-helper-status", {});
    expect(ready.structuredContent.setupCommand).toBeUndefined();
  });

  it("reads note state by identifier or by resolving an x-coredata id", async () => {
    vi.mocked(readNoteState).mockReturnValue({ revision: REV } as never);
    const { call, manager } = fixture();
    await call("native-note-state", { identifier: NOTE });
    expect(readNoteState).toHaveBeenLastCalledWith(NOTE, {});
    await call("native-note-state", { id: CD });
    expect(manager.getNoteLinkById).toHaveBeenCalledWith(CD);
    expect(readNoteState).toHaveBeenLastCalledWith(NOTE, {});
  });

  it("refuses ambiguous, missing, or unresolvable note references", async () => {
    const both = await fixture().call("native-note-state", { identifier: NOTE, id: CD });
    expect(both.structuredContent).toMatchObject({
      code: "validation_error",
      helperCode: "invalid_request",
    });
    const none = await fixture().call("native-note-state", {});
    expect(none.structuredContent).toMatchObject({ code: "validation_error" });
    const unresolved = await fixture(null).call("native-note-state", { id: CD });
    expect(unresolved.isError).toBe(true);
    expect(unresolved.structuredContent).toMatchObject({
      code: "not_found",
      helperCode: "not_found",
    });
    expect(readNoteState).not.toHaveBeenCalled();
  });

  it("reports helper errors through the shared CodedError envelope", async () => {
    vi.mocked(readNoteState).mockImplementation(() => {
      throw new PrivateHelperError("helper_stale", "rebuild it", { hint: "x" });
    });
    const r = await fixture().call("native-note-state", { identifier: NOTE });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("native helper (helper_stale): rebuild it");
    expect(r.structuredContent).toEqual({
      code: "unsupported",
      helperCode: "helper_stale",
      committed: false,
      hint: "x",
    });
  });

  it("wraps unexpected failures through the classifier", async () => {
    vi.mocked(privateHelperCapabilities).mockImplementationOnce(() => {
      throw new Error("kaboom");
    });
    const r = await fixture().call("native-helper-status", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("native helper: kaboom");
    expect(r.structuredContent).toEqual({ code: "operation_failed" });
  });

  it("maps every helper code into the documented vocabulary", () => {
    const codes = [
      "not_found",
      "timeout",
      "invalid_request",
      "invalid_json",
      "input_too_large",
      "unknown_action",
      "store_unavailable",
      "disabled",
      "unsupported_platform",
      "unsupported_note",
      "private_api_unavailable",
      "protocol_mismatch",
      "helper_not_installed",
      "helper_stale",
      "helper_modified",
      "helper_manifest_invalid",
      "helper_unreachable",
      "invalid_response",
      "read_only_violation",
      "internal_error",
    ];
    for (const code of codes) expect(Object.keys(ERROR_CODES)).toContain(envelopeCode(code, ""));
    expect(envelopeCode("store_unavailable", "Grant Full Disk Access")).toBe(
      "full_disk_access_missing"
    );
    expect(envelopeCode("store_unavailable", "open failed")).toBe("operation_failed");
    // A read-only helper timeout wrote nothing, so it is not indeterminate (#204).
    expect(envelopeCode("timeout", "")).toBe("operation_failed");
    expect(envelopeCode("helper_crashed", "")).toBe("operation_failed");
  });

  it("uses the real dependencies when none are injected", async () => {
    vi.mocked(privateHelperCapabilities).mockReturnValueOnce({
      enabled: false,
      readOnly: true,
      installation: { ready: true } as never,
      probe: null,
      features: {} as never,
    });
    const registerTool = vi.fn();
    registerPrivateHelperTools({ registerTool } as unknown as McpServer, {} as AppleNotesManager);
    await registerTool.mock.calls.find((c) => c[0] === "native-helper-status")![2]({});
    const deps = vi.mocked(privateHelperCapabilities).mock.calls[0][0]!;
    expect(deps.platform).toBe(process.platform);
    expect(deps.sourcePath).toMatch(/apple-notes-private-helper\.m$/);
  });

  it("validates tool input with the declared schemas", () => {
    const schema = fixture().config("native-note-state").inputSchema;
    expect(schema.identifier.safeParse("nope").success).toBe(false);
    expect(schema.identifier.safeParse(NOTE).success).toBe(true);
    expect(schema.id.safeParse(CD).success).toBe(true);
  });
});
