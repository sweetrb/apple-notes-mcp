/**
 * Checklist tools on the opt-in private WRITER.
 *
 * - `native-checklist-state`: read a note's native checklist items with their
 *   todo identifiers, done state, and the note's revision token (read-only).
 * - `native-set-checklist-item`: check or uncheck one item by todo identifier,
 *   guarded by `ifRevision`, verified by a fresh read-back, and optionally
 *   followed by the move-in-place sync nudge.
 *
 * Both go through the writer, so both need APPLE_NOTES_MCP_ENABLE_PRIVATE=1
 * and APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1. They share the envelope in
 * privateWriterTools.ts.
 *
 * @module tools/privateWriterChecklistTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import {
  TODO_IDENTIFIER,
  readNativeChecklist,
  setChecklistItem,
} from "../services/privateWriterChecklist.js";
import {
  coreDataId,
  defaultWriterToolDeps,
  notesUuid,
  nudgeAfterWrite,
  registerWriterTool,
  resolveIdentifier,
  revisionToken,
  type WriterToolDeps,
} from "./privateWriterTools.js";
import { scopeGuardFrom, writerScopeGuardInput } from "../services/privateWriterScope.js";

export function registerPrivateWriterChecklistTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-checklist-state",
    "Use when: you need a note's native checklist items with their stable todo identifiers and done state, and the note's revision token, before native-set-checklist-item.\n" +
      "Returns: items (todoIdentifier as 32 hex digits, uuid, index, done, text, line and styled-character offsets, contiguous/consistent flags), total, checked, and `revision` (pass it as ifRevision).\n" +
      "Do not use when: the writer is off; get-checklist-state and get-native-objects read the same state from the database without it.\n" +
      "Safety: read-only; the writer opens the store with Core Data's read-only option. Runs through the private writer, so it needs APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, and a built writer (setup --native-writer).",
    {
      identifier: notesUuid.optional().describe("Notes UUID (the notes://showNote identifier)"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
    },
    { readOnlyHint: true, openWorldHint: false },
    (args, deps) => ({ ...readNativeChecklist(resolveIdentifier(manager, args), deps.writer) })
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-set-checklist-item",
    "Use when: checking or unchecking one existing Apple Notes checklist item, addressed by its todo identifier (native-checklist-state todoIdentifier, or get-native-objects checklistItems id). Shortcuts cannot do this.\n" +
      "Returns: status (updated, or unchanged when the item already had that state and nothing was written), committed, persistedDone (re-read from a fresh Core Data stack), previousDone, index, revisionBefore/revisionAfter, sync state (pushScheduled is always false), and with nudge: true a `sync` report of the move-in-place nudge.\n" +
      "Do not use when: adding checklist items (create-checklist-item), or the note is locked, shared, trashed, or still downloading.\n" +
      "Safety: writes to the Notes database through unsupported private API, changing only that item's done bit. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer, and a fresh `revision` as ifRevision; refuses on any change since, on an identifier that matches no item (not_found), and on one found in two places (ambiguous_target). A timeout is indeterminate (indeterminate: true): read native-checklist-state before any retry. Not yet live-validated, so it also requires APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      todoIdentifier: z
        .string()
        .regex(TODO_IDENTIFIER)
        .describe("The checklist item's todo identifier: 32 hex digits, or the same UUID dashed"),
      done: z.boolean().describe("true to check the item, false to uncheck it"),
      ifRevision: revisionToken.describe(
        "The `revision` from native-checklist-state or native-note-state for this note"
      ),
      ...writerScopeGuardInput(),
      nudge: z
        .boolean()
        .optional()
        .describe(
          "After a verified change, ask Notes.app to upload the note by moving it into its own folder (default false; skipped when nothing was written)"
        ),
      nudgeWaitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_NUDGE_WAIT_SECONDS)
        .optional()
        .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = setChecklistItem(
        {
          identifier,
          todoIdentifier: args.todoIdentifier,
          done: args.done,
          ifRevision: args.ifRevision,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge || !result.committed) return { ...result };
      return {
        ...result,
        sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );
}
