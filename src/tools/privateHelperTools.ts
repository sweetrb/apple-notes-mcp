/**
 * MCP tools for the opt-in native private helper (#181).
 *
 * - `native-helper-status`: install state, opt-in state, and the live probe.
 * - `native-note-state`: read one note's native state and change token.
 *
 * Both are READ-ONLY. The helper has no write action: write support was
 * deliberately deferred by the maintainer (#181, #204). Both tools are always
 * registered so the tool list does not change with the environment, and each
 * refuses with a machine-readable `code` when the helper is off, missing,
 * stale, or unsupported on this macOS.
 *
 * @module tools/privateHelperTools
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { CodedError, errorResult, type ErrorCode } from "../utils/errorCodes.js";
import {
  PrivateHelperError,
  defaultDeps,
  privateHelperCapabilities,
  readNoteState,
  type PrivateHelperDeps,
} from "../services/privateHelper.js";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";

const coreDataId = z.string().regex(/^x-coredata:\/\/[0-9A-F-]+\/ICNote\/p\d+$/i);
const notesUuid = z.string().regex(UUID_PATTERN);

/** Resolve the Notes UUID from either an explicit identifier or an x-coredata id. */
function resolveIdentifier(
  manager: AppleNotesManager,
  args: { identifier?: string; id?: string }
): string {
  if (args.identifier && args.id)
    throw new PrivateHelperError("invalid_request", "Pass identifier or id, not both");
  if (args.identifier) return args.identifier;
  if (!args.id) throw new PrivateHelperError("invalid_request", "identifier or id is required");
  const link = manager.getNoteLinkById(args.id);
  const match = link?.match(/identifier=([0-9A-F-]{36})$/i);
  if (!match)
    throw new PrivateHelperError(
      "not_found",
      "Could not resolve that id to a Notes UUID (needs Full Disk Access); pass identifier instead"
    );
  return match[1];
}

/** Map a helper code onto the server-wide error vocabulary (#185). */
export function envelopeCode(helperCode: string, message: string): ErrorCode {
  switch (helperCode) {
    case "not_found":
      return "not_found";
    case "timeout":
      return "timeout_indeterminate";
    case "invalid_request":
    case "invalid_json":
    case "input_too_large":
    case "unknown_action":
      return "validation_error";
    case "store_unavailable":
      return /Full Disk Access/i.test(message) ? "full_disk_access_missing" : "operation_failed";
    case "disabled":
    case "unsupported_platform":
    case "unsupported_note":
    case "private_api_unavailable":
    case "protocol_mismatch":
    case "helper_not_installed":
    case "helper_stale":
    case "helper_modified":
    case "helper_manifest_invalid":
      return "unsupported";
    default:
      return "operation_failed";
  }
}

/**
 * Route a helper failure through the shared CodedError/errorResult envelope.
 * Every action is a read, so nothing is ever committed.
 */
function helperErrorResult(error: unknown) {
  if (!(error instanceof PrivateHelperError)) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`native helper: ${message}`, error);
  }
  const message = `native helper (${error.code}): ${error.message}`;
  return errorResult(
    message,
    new CodedError(message, {
      ...error.details,
      code: envelopeCode(error.code, error.message),
      helperCode: error.code,
      committed: false,
    })
  );
}

export function registerPrivateHelperTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => PrivateHelperDeps = () => defaultDeps()
) {
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: ToolAnnotations,
    handler: (args: z.infer<z.ZodObject<S>>, deps: PrivateHelperDeps) => Record<string, unknown>
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations,
        outputSchema: z.object({ ok: z.boolean().optional() }).passthrough(),
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          const result = { ok: true, ...handler(args, depsFactory()) };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return helperErrorResult(error);
        }
      }) as unknown as ToolCallback<S>
    );
  }

  tool(
    "native-helper-status",
    "Use when: checking whether the opt-in, read-only native private helper is enabled, built, current, and working on this macOS before calling native-note-state.\n" +
      "Returns: enabled flag, installation state (path, manifest, stale/modified checks), the live probe (macOS and Notes versions, framework, store access), and per-feature availability with a machine reason.\n" +
      "Do not use when: checking the Shortcuts bridges (native-tags-status, get-capabilities).\n" +
      "Safety: read-only. The helper is read-only by design (write support was deliberately deferred by the maintainer); the probe opens the Notes store read-only and only when the helper is enabled and installed.",
    {},
    { readOnlyHint: true, openWorldHint: false },
    (_args, deps) => {
      const capabilities = privateHelperCapabilities(deps);
      return {
        ...capabilities,
        ...(capabilities.installation.ready
          ? {}
          : { setupCommand: "apple-notes-mcp setup --native-helper" }),
      };
    }
  );

  tool(
    "native-note-state",
    "Use when: you need a note's native title, modification date, folder identifier, lock/trash/shared/editable flags, or iCloud upload state as Notes' own data model reports them.\n" +
      "Returns: identifier, title, modificationDate, folderIdentifier, lock/trash/shared/editable flags, `revision` (an opaque change token; compare two reads to detect a change), and cloudSync versions.\n" +
      "Do not use when: reading note content (get-note-content, get-note-markdown).\n" +
      "Safety: read-only; the helper opens the store with Core Data's read-only option and has no write action. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1 and a built helper.",
    {
      identifier: notesUuid.optional().describe("Notes UUID (the notes://showNote identifier)"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
    },
    { readOnlyHint: true, openWorldHint: false },
    (args, deps) => ({ ...readNoteState(resolveIdentifier(manager, args), deps) })
  );
}
