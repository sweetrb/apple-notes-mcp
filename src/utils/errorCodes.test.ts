import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv2020Import from "ajv/dist/2020.js";
import {
  CodedError,
  ERROR_CODES,
  classifyError,
  errorResult,
  inputValidationEnvelope,
  installSdkErrorCodes,
  sdkToolError,
  type ErrorCode,
  type ErrorEnvelope,
} from "@/utils/errorCodes.js";
import { PERMISSION_DENIED_MESSAGE } from "@/utils/applescript.js";
import { resolveIdentifiers } from "@/utils/noteIdentifiers.js";

// Real messages the server produces today, copied from their throw/return sites.
const CASES: Array<[string, ErrorEnvelope]> = [
  // not_found
  ['Note with ID "x-coredata://A/ICNote/p1" not found', { code: "not_found" }],
  [
    'Note "Plan" not found. Use search-notes to find notes, then use the note\'s ID for reliable operations.',
    { code: "not_found" },
  ],
  ["Error retrieving note: Note not found", { code: "not_found" }],
  ["This note does not contain any checklist items.", { code: "not_found" }],
  ["No data found for this note in the database.", { code: "not_found" }],
  [
    'Folder "Work" does not exist; create it with create-folder first. Nothing was created',
    { code: "not_found", committed: false, indeterminate: false },
  ],
  ["Scope is absent from exact note", { code: "not_found" }],
  // Seen live: the metadata reader's wording and Notes' curly apostrophe.
  ['No note found in the database for ID "x-coredata://A/ICNote/p1"', { code: "not_found" }],
  ['Notes got an error: Can’t get folder id "x-coredata://A/ICFolder/p1".', { code: "not_found" }],
  ["execution error: Can't get note. (-1728)", { code: "not_found" }],
  // ambiguous
  [
    "Ambiguous note selection; nothing changed",
    { code: "ambiguous", committed: false, indeterminate: false },
  ],
  ["Duplicate note IDs", { code: "ambiguous" }],
  // permission_denied
  [
    `Error listing notes: Failed to list notes: ${PERMISSION_DENIED_MESSAGE}`,
    { code: "permission_denied" },
  ],
  ["execution error: Not authorized to send Apple events (-1743)", { code: "permission_denied" }],
  // full_disk_access_missing
  [
    "Full Disk Access is required to read checklist state. Grant it in System Settings.",
    { code: "full_disk_access_missing" },
  ],
  [
    'Failed to get note link for "Plan". The Notes database may not be accessible — grant Full Disk Access to the app that launches the server.',
    { code: "full_disk_access_missing" },
  ],
  // shortcut_not_installed
  [
    'Install the supplied "Apple Notes MCP - Background Operations v5" Shortcut once; Shortcuts must list it exactly once',
    { code: "shortcut_not_installed" },
  ],
  [
    "Import the supplied Apple Notes MCP - Native Tags.shortcut in Shortcuts first",
    { code: "shortcut_not_installed" },
  ],
  // timeout_indeterminate
  [
    "Error updating note: Operation timed out after 30 seconds. Notes.app may be unresponsive or the operation involves too many notes.",
    { code: "timeout_indeterminate", indeterminate: true },
  ],
  [
    "Operation outcome uncertain; read exact note before any retry: Appended text not verified; Shortcuts timed out waiting for the bridge",
    { code: "timeout_indeterminate", indeterminate: true },
  ],
  // verification_failed
  [
    "Operation outcome uncertain; read exact note before any retry: Native checklist item not verified",
    { code: "verification_failed", indeterminate: true },
  ],
  [
    "The note accepted an update, but exact-ID readback visible text did not match. Do not retry automatically; inspect note ID x in Notes.app.",
    { code: "verification_failed", indeterminate: true, committed: true },
  ],
  [
    "The note accepted the write, but rich-link readback is not verified. Read the exact ID before retrying; do not repeat the write automatically.",
    { code: "verification_failed", indeterminate: true, committed: true },
  ],
  [
    'The update result for note "Plan" is uncertain. Read the exact ID before retrying.',
    { code: "verification_failed", indeterminate: true },
  ],
  [
    "The move may have succeeded, but exact-ID readback failed. Inspect note ID x before retrying.",
    { code: "verification_failed", indeterminate: true },
  ],
  [
    "A note may have been created, but its exact ID could not be verified. Do not retry automatically. Returned ID: x",
    { code: "verification_failed", indeterminate: true },
  ],
  [
    "Table result uncertain; native table not verified. Read the note before retrying",
    { code: "verification_failed", indeterminate: true },
  ],
  [
    'Stopped after tags ["a"]; read exact note before retry: Error: boom',
    { code: "verification_failed", indeterminate: true },
  ],
  // revision_conflict
  [
    'Note "Plan" changed after it was read. Read it again and review the newer version before retrying.',
    { code: "revision_conflict", committed: false, indeterminate: false },
  ],
  [
    "Note revision changed; read it again",
    { code: "revision_conflict", committed: false, indeterminate: false },
  ],
  [
    "Folder changed; read it again",
    { code: "revision_conflict", committed: false, indeterminate: false },
  ],
  [
    "Note or pinned state changed; read it again",
    { code: "revision_conflict", committed: false, indeterminate: false },
  ],
  [
    "Note revision changed during preflight; nothing was changed",
    { code: "revision_conflict", committed: false, indeterminate: false },
  ],
  // validation_error
  ["Either 'id' or 'title' is required", { code: "validation_error" }],
  ["No note IDs provided", { code: "validation_error" }],
  ["Invalid note ID format: abc", { code: "validation_error" }],
  [
    "Tags must contain a letter and only letters, digits, hyphens or underscores",
    { code: "validation_error" },
  ],
  ["Provide scopeText: a unique existing phrase for native append", { code: "validation_error" }],
  ["Table rows must have equal cell counts", { code: "validation_error" }],
  [
    "Error exporting notes: this page is 2.1 MB, over the 1.0 MB response limit, so it was not sent.",
    { code: "validation_error" },
  ],
  // unsupported
  [
    'Note "Plan" is password-protected and cannot be read. Unlock it in Notes.app first.',
    { code: "unsupported" },
  ],
  ["Locked notes are unavailable in background mode", { code: "unsupported" }],
  [
    'Note "Plan" has 2 attachment(s). Full-body replacement is blocked; edit it in Notes.app.',
    { code: "unsupported" },
  ],
  [
    "Installed Shortcuts refuses to sign this Notes action (unsupported features); no background fallback is enabled",
    { code: "unsupported" },
  ],
  [
    "append-native has not passed live background validation in this build; see get-capabilities",
    { code: "unsupported" },
  ],
  ["Nested lists and indented code are unsupported", { code: "unsupported" }],
  // notes_unavailable
  ["Notes.app is not responding. Try opening Notes.app manually.", { code: "notes_unavailable" }],
  [
    "Lost connection to Notes.app. The app may have crashed or been restarted.",
    { code: "notes_unavailable" },
  ],
  // operation_failed
  ['Failed to create folder "Work".', { code: "operation_failed" }],
  ["Internal error. Please report this issue.", { code: "operation_failed" }],
  ["Unknown error", { code: "operation_failed" }],
];

describe("classifyError", () => {
  it.each(CASES)("%s", (message, expected) => {
    expect(classifyError(message)).toEqual(expected);
  });

  it("covers every documented code with at least one real message", () => {
    const covered = new Set(CASES.map(([, e]) => e.code));
    expect([...covered].sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });

  it.each([
    ['Note "Meeting timed out" not found', "not_found"],
    ['Error updating note: Note "Draft uncertain" not found', "not_found"],
    ['Note "Build not verified" not found', "not_found"],
    ["Note “Lost connection to Notes” not found", "not_found"],
    ['Folder "Password-protected stuff" not found. Use list-folders', "not_found"],
  ] as const)("ignores rule words inside quoted caller data: %s", (message, code) => {
    expect(classifyError(message)).toEqual({ code });
  });

  it("honors a thrown ETIMEDOUT code even when the text does not say so", () => {
    const cause = Object.assign(new Error("spawnSync /usr/bin/shortcuts"), { code: "ETIMEDOUT" });
    expect(classifyError("Error creating note: spawnSync /usr/bin/shortcuts", cause)).toEqual({
      code: "timeout_indeterminate",
      indeterminate: true,
    });
  });

  it("classifies on the cause message when the wrapper text omits it", () => {
    expect(classifyError("Operation failed", new Error("Note not found")).code).toBe("not_found");
  });

  it("lets a CodedError override the text rules", () => {
    const cause = new CodedError("Note not found", {
      code: "verification_failed",
      committed: true,
      indeterminate: true,
    });
    expect(classifyError("Note not found", cause)).toEqual({
      code: "verification_failed",
      committed: true,
      indeterminate: true,
    });
  });
});

describe("SDK-reported errors (#190)", () => {
  const prefix =
    "MCP error -32602: Input validation error: Invalid arguments for tool get-note-blocks: ";

  it.each([
    ["Expected string, received number at id", "validation_error"],
    [
      "No note found for identifier 00000000-0000-0000-0000-000000000000. A numeric key must belong to a note, not another object type. at id",
      "not_found",
    ],
    [
      "Resolving a Notes UUID or numeric key reads the Notes database, which needs Full Disk Access at id",
      "validation_error",
    ],
    ["Failed to read the Notes database. at id", "operation_failed"],
  ] as const)("codes the input rejection %s", (detail, code) => {
    expect(sdkToolError(prefix + detail).structuredContent).toEqual({
      code,
      committed: false,
      indeterminate: false,
    });
  });

  it("recognizes the full Full Disk Access resolution message", () => {
    let message = "";
    try {
      resolveIdentifiers(["00000000-0000-0000-0000-000000000000"], "ICNote", "/nonexistent/db");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(inputValidationEnvelope(prefix + message + " at id").code).toBe(
      "full_disk_access_missing"
    );
  });

  it("classifies an uncaught handler error by its text", () => {
    expect(sdkToolError("Note not found").structuredContent).toEqual({ code: "not_found" });
  });

  it("replaces createToolError on a server that has one", () => {
    const server = { createToolError: (m: string) => ({ text: m }) };
    installSdkErrorCodes(server);
    expect(server.createToolError(prefix + "bad")).toMatchObject({
      isError: true,
      structuredContent: { code: "validation_error" },
    });
  });
});

describe("errorResult", () => {
  it("keeps the text byte-for-byte and adds the envelope", () => {
    const text = 'Note with ID "x-coredata://A/ICNote/p1" not found';
    expect(errorResult(text)).toEqual({
      content: [{ type: "text", text }],
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });
});

/**
 * The MCP TypeScript client validates structuredContent against the advertised
 * outputSchema even on error results, so every envelope shape must validate
 * against every tool's schema as advertised by the built server.
 */
describe("error envelope vs every advertised outputSchema (built server)", () => {
  const Ajv2020 =
    (Ajv2020Import as unknown as { default?: typeof Ajv2020Import }).default ?? Ajv2020Import;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "error-codes-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(__dirname, "../../build/index.js")],
        env: { ...process.env } as Record<string, string>,
      })
    );
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it("validates code, committed, and indeterminate for every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const ajv = new Ajv2020({ strict: false });
    const envelopes: ErrorEnvelope[] = (Object.keys(ERROR_CODES) as ErrorCode[]).map((code) => ({
      code,
      committed: true,
      indeterminate: true,
    }));
    const failures: string[] = [];
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} has no outputSchema`).toBeDefined();
      const validate = ajv.compile(tool.outputSchema as object);
      for (const envelope of envelopes)
        if (!validate(envelope))
          failures.push(`${tool.name}: ${envelope.code}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(failures).toEqual([]);
  });

  // #190: a call the SDK rejects before the handler runs still carries a code.
  // Neither call reaches Notes.app: the input schema refuses both.
  it("codes an input-schema rejection", async () => {
    const result = await client.callTool({ name: "get-note-blocks", arguments: { id: 42 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "validation_error",
      committed: false,
      indeterminate: false,
    });
  });

  it("keeps the code of a Notes UUID that does not resolve", async () => {
    const result = await client.callTool({
      name: "get-note-blocks",
      arguments: { id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    // not_found with Full Disk Access, full_disk_access_missing without it.
    expect(["not_found", "full_disk_access_missing"]).toContain(
      (result.structuredContent as ErrorEnvelope).code
    );
  });
});
