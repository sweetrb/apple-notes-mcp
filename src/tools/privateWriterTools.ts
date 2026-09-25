/**
 * MCP tools for the opt-in private WRITER (a separate layer over #181/#204).
 *
 * - `native-writer-status`: both switches, the writer's installation and
 *   checksum state, and its live probe.
 * - `native-append-plain-text`: the foundation's demonstration write, guarded
 *   by a revision token (compare-and-swap), verified by a fresh read-back,
 *   and optionally followed by the move-in-place sync nudge.
 * - `native-sync-push`: the nudge (or a confirmed Notes.app relaunch) on its
 *   own, for writer-saved changes Notes.app has not uploaded yet.
 * - `native-edit-note`: literal in-place edits resolved against one native
 *   snapshot. A dry run (the writer's read-only plan_edit) returns the plan
 *   and `revisionBefore`; the apply (edit_note) must pass it back as
 *   `ifRevision`, and its read-back proves that text, formatting, and
 *   attachments outside the edited ranges did not change. Only an explicit
 *   attachment selector may replace (with text or a new file), remove, or
 *   edit beside one attachment; every other attachment is then proven
 *   unchanged. It also trims redundant empty paragraphs (trim_blank_lines),
 *   appends inline runs to one paragraph (append_to_paragraph), and replaces
 *   a checklist (replace_checklist).
 *
 * The read-only tools (`native-helper-status`, `native-note-state`) stay in
 * privateHelperTools.ts and never reach the writer. Every tool here is always
 * registered so the tool list does not change with the environment; each
 * refuses with a machine-readable `code` plus the raw `helperCode` when a
 * switch is off or the writer is missing, stale, or unsupported. Write
 * failures carry `committed` (false: nothing saved; true: saved but not
 * verified) or `indeterminate: true` (read the note before any retry).
 *
 * Feature modules register their own writer tools through
 * {@link registerWriterTool} so they share this envelope.
 *
 * @module tools/privateWriterTools
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { PrivateHelperError } from "../services/privateHelper.js";
import {
  MAX_NUDGE_WAIT_SECONDS,
  MAX_SYNC_TARGETS,
  defaultNudgeDeps,
  nudgeInPlace,
  syncPush,
  type NudgeDeps,
} from "../services/privateSyncNudge.js";
import {
  PrivateWriteError,
  WRITER_SETUP_COMMAND,
  appendPlainText,
  defaultWriterDeps,
  editNote,
  editOperationsSchema,
  planDigestToken,
  privateWriterCapabilities,
  type PrivateHelperDeps,
} from "../services/privateWriter.js";
import {
  CodedError,
  errorResult,
  type ErrorCode,
  type ErrorEnvelope,
} from "../utils/errorCodes.js";
import { UUID_PATTERN } from "../utils/noteIdentifiers.js";
import { envelopeCode, resolveIdentifier } from "./privateHelperTools.js";
import { scopeGuardFrom, writerScopeGuardInput } from "../services/privateWriterScope.js";

export const coreDataId = z.string().regex(/^x-coredata:\/\/[0-9A-F-]+\/ICNote\/p\d+$/i);
export const notesUuid = z.string().regex(UUID_PATTERN);
export const revisionToken = z.string().regex(/^r1:[a-f0-9]{64}$/);
export { resolveIdentifier };

/** Map a writer code onto the server-wide error vocabulary (#185). */
export function writerEnvelopeCode(helperCode: string, message: string): ErrorCode {
  switch (helperCode) {
    case "revision_conflict":
    case "scope_conflict": // the note is no longer where the guard requires
    case "paragraph_changed": // the selected paragraph moved or changed since it was listed
    case "attachment_conflict":
    case "plan_mismatch": // the request or a replacement file differs from the dry run (ifPlanDigest)
      return "revision_conflict";
    case "unsupported_attachment":
      return "unsupported";
    case "unsupported_folder":
    case "query_not_representable":
      return "unsupported";
    case "invalid_query":
      return "validation_error";
    case "tag_not_found":
    case "scope_folder_not_found":
      return "not_found";
    case "folder_exists":
      return "validation_error";
    case "verification_failed":
      return "verification_failed";
    case "writes_disabled":
    case "not_live_validated":
      return "unsupported";
    case "ambiguous":
    case "ambiguous_target":
    case "ambiguous_paragraph":
      return "ambiguous";
    case "confirmation_required":
    case "match_count_mismatch":
    case "nothing_to_highlight":
      return "validation_error";
    default:
      // SVG refusals from native-add-paper (svg_unsafe, svg_analysis_required, ...)
      // happen before the writer runs.
      if (helperCode.startsWith("svg_")) return "validation_error";
      return envelopeCode(helperCode, message);
  }
}

/**
 * Route a writer failure through the shared CodedError/errorResult envelope,
 * carrying the writer's own `committed` answer.
 */
export function writerErrorResult(error: unknown) {
  if (!(error instanceof PrivateHelperError)) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`native writer: ${message}`, error);
  }
  const committed = error instanceof PrivateWriteError ? error.committed : undefined;
  const message = `native writer (${error.code}): ${error.message}`;
  const envelope: ErrorEnvelope = {
    ...error.details,
    // The read-only helper's mapping calls a timeout operation_failed, since
    // its actions only read. A writer timeout during a write can leave a save
    // behind, so it stays timeout_indeterminate.
    code:
      error.code === "timeout" && committed === "unknown"
        ? "timeout_indeterminate"
        : writerEnvelopeCode(error.code, error.message),
    helperCode: error.code,
  };
  if (committed === "unknown") {
    envelope.indeterminate = true;
  } else if (committed !== undefined) {
    envelope.committed = committed;
    // Saved but not confirmed by read-back: still uncertain for the caller.
    envelope.indeterminate = committed === true;
  } else {
    // Reads and pre-spawn refusals never write.
    envelope.committed = false;
  }
  return errorResult(message, new CodedError(message, envelope));
}

/**
 * Register one writer-backed tool. The handler may be async; its result is
 * returned as `{ ok: true, ...result }` in text and structuredContent.
 */
export function registerWriterTool<S extends z.ZodRawShape, D>(
  server: McpServer,
  depsFactory: () => D,
  name: string,
  description: string,
  inputSchema: S,
  annotations: ToolAnnotations,
  handler: (
    args: z.infer<z.ZodObject<S>>,
    deps: D
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
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
        const result = { ok: true, ...(await handler(args, depsFactory())) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return writerErrorResult(error);
      }
    }) as unknown as ToolCallback<S>
  );
}

export interface WriterToolDeps {
  writer: PrivateHelperDeps;
  nudge: NudgeDeps;
}

export function defaultWriterToolDeps(): WriterToolDeps {
  const writer = defaultWriterDeps();
  return { writer, nudge: defaultNudgeDeps({ helper: writer }) };
}

export function registerPrivateWriterTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-writer-status",
    "Use when: checking whether the opt-in private WRITER is enabled, built, current, and working before any native write tool (native-append-plain-text and the other native-* write tools).\n" +
      "Returns: enabled and writesEnabled flags, the writer's installation state (path, manifest, stale/modified checks), its live probe, and per-feature availability with a machine reason (disabled, writes_disabled, helper_not_installed, helper_stale, not_live_validated, ...).\n" +
      "Do not use when: you only need reads (native-helper-status covers the read-only helper).\n" +
      "Safety: read-only. The probe opens the Notes store read-only, and only when both switches are on and the writer is installed.",
    {},
    { readOnlyHint: true, openWorldHint: false },
    (_args, deps) => {
      const capabilities = privateWriterCapabilities(deps.writer);
      return {
        ...capabilities,
        ...(capabilities.installation.ready ? {} : { setupCommand: WRITER_SETUP_COMMAND }),
      };
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-append-plain-text",
    "Use when: appending plain text paragraphs to one exact note through Notes' own data model, with a compare-and-swap guard. This is the private-writer path, distinct from append-native (Shortcuts) and append-to-note (AppleScript HTML rewrite).\n" +
      "Returns: committed/verified flags, revisionBefore/revisionAfter, the new modification date, and sync state: pushScheduled (always false; the writer cannot upload), pushState, cloudSync versions, and with nudge: true a `sync` report of the move-in-place nudge (uploadRecorded per target).\n" +
      "Do not use when: the note is locked, shared, trashed, or still downloading, or you need formatting (text is appended as plain body paragraphs).\n" +
      "Safety: writes to the Notes database through unsupported private API. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer (setup --native-writer), and a fresh `revision` from native-note-state as ifRevision; refuses on any change since. Verifies by re-reading in a new Core Data stack. A timeout is indeterminate (indeterminate: true): read native-note-state before any retry. Not yet live-validated, so it also requires APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      text: z
        .string()
        .min(1)
        .max(50_000)
        .describe(
          "Plain text to append. \\n starts a new paragraph; no \\r or control characters."
        ),
      ifRevision: revisionToken.describe(
        "The `revision` returned by native-note-state for this note"
      ),
      ...writerScopeGuardInput(),
      nudge: z
        .boolean()
        .optional()
        .describe(
          "After a verified write, ask Notes.app to upload the note by moving it into its own folder (default false)"
        ),
      nudgeWaitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_NUDGE_WAIT_SECONDS)
        .optional()
        .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = appendPlainText(
        {
          identifier,
          text: args.text,
          ifRevision: args.ifRevision,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge) return { ...result };
      return {
        ...result,
        sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-sync-push",
    "Use when: a note or folder changed through the private writer earlier (native-append-plain-text and the other native write tools, without nudge or with a nudge that timed out) still shows cloudSync.uploadPending, and you want Notes.app to upload it, or just to check whether it has.\n" +
      "Returns: per target, Notes' own version counters before and after, uploadRecorded (true only when Notes recorded the current version as synced to iCloud), the action taken, and a skip reason; the library-wide pendingUploadCount before and after; warnings. pushScheduled is always false: only Notes.app uploads.\n" +
      "Do not use when: the change was made through AppleScript or Shortcuts tools (Notes.app uploads those itself), or right after a native write that already ran with nudge: true and reported uploadRecorded.\n" +
      'Safety: never writes to the Notes database. method "status" is read-only. "nudge" (default) makes Notes.app save each pending note by moving it into the folder it is already in: no text, title, or modification date changes, and the writer\'s revision token is compared before and after (contentUnchanged). It skips locked, shared, trashed, and non-iCloud notes, and folders. "relaunch" quits and reopens Notes.app so its launch sweep uploads everything pending, folders included; it interrupts anyone using Notes and requires confirm: true after asking the user. After a relaunch, each folder target reports adoptedByNotesApp: whether the reopened Notes.app shows it (or, for a deleted folder, no longer shows it), read through AppleScript. If reading the state after the relaunch fails, the error says Notes.app was already restarted; check with method status rather than relaunching again. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, and a built writer (setup --native-writer).',
    {
      identifiers: z
        .array(notesUuid)
        .min(1)
        .max(MAX_SYNC_TARGETS)
        .describe("Notes UUIDs of the notes or folders to check (from native-note-state etc.)"),
      method: z
        .enum(["status", "nudge", "relaunch"])
        .optional()
        .describe(
          "status = read only; nudge (default) = in-place Notes.app save; relaunch = quit and reopen Notes.app"
        ),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for relaunch, after the user agreed to Notes.app being quit"),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_NUDGE_WAIT_SECONDS)
        .optional()
        .describe("Seconds to watch the counters afterwards (default 30; 0 for status)"),
    },
    // destructiveHint: method relaunch quits Notes.app, interrupting whoever uses
    // it. Annotations are per tool, so the most disruptive mode sets it.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args, deps) => ({ ...(await syncPush(args, deps.nudge)) })
  );

  registerWriterTool(
    server,
    depsFactory,
    "native-edit-note",
    "Use when: changing selected text inside one existing note in place while everything outside the edited ranges (attachments, tables, checklist state, paragraph styles, inline formatting) stays untouched: replace literal text (with expectedCount and occurrence) with plain text or formatted runs (bold, italic, underline, strikethrough, link, highlight, color), insert paragraphs (checklist rows checked or not) before or after a paragraph matched by its exact text, by style and position (for example the 2nd subheading), or by the attachment it holds, add inline runs such as a link at the end of one exact paragraph (append_to_paragraph), replace a note's checklist with new items (replace_checklist), delete a paragraph or list row, retitle, replace, remove, or add text beside one named attachment, or swap it for a new image or PDF file (selector kind 'attachment' with identifier, id, or ordinal from get-note-structure or list-attachments), or trim redundant empty paragraphs (runs of blank lines, trailing blank lines, or blank lines around one paragraph). Always run twice: dryRun: true to get the plan, revisionBefore, and planDigest, then the IDENTICAL request with dryRun: false, ifRevision set to that revisionBefore, and ifPlanDigest set to that planDigest.\n" +
      "Returns: per-operation matched counts and target ranges (a trim lists every empty paragraph it would remove by paragraphIndex, style, and blankUTF16; replace_checklist lists removedItems with their text and checked state), lengthBefore/lengthAfter, unchangedUTF16, wouldChange, titleChanged, attachmentGlyphs, attachmentSpans, revisionBefore, and planDigest. removedAttachments (identifiers the plan takes out of the body) and replacementFiles (name, type, size, SHA-256 of each file that replaces an attachment). An apply also returns committed/verified, revisionAfter, `preservation` (what the read-back proved: formatting outside the edits, the attachment glyph sequence, every untargeted attachment row unchanged, each replacement file's bytes, and the state of each removed attachment's row), sync state (pushScheduled is always false; pushState, cloudSync), and with nudge: true a `sync` report of the move-in-place nudge.\n" +
      "Do not use when: replacing a whole note (update-note), appending (native-append-plain-text, append-native), or the note is locked, shared, trashed, or still downloading. Matching is literal and case-sensitive, never crosses a line break, and never splits a character. Only an attachment selector touches an attachment, and only the one it names (all of its glyphs); inline objects (hashtags, mentions, note links) are never selectable.\n" +
      "Safety: a dry run is read-only and never writes a file. Applying writes through unsupported private API and requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer (setup --native-writer), and, until live-validated, APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1. Refuses with a code and commits nothing on: revision_conflict (note changed since the dry run, or plan_mismatch: the request or a replacement file differs from the dry run's planDigest), match_count_mismatch, mixed_formatting (plain text over mixed formatting; pass replacement.runs), conflicting_operations, title_invariant, unsupported_selection, unsupported_attachment, unexpected_side_effect. A failed apply removes any attachment it created. Each apply is verified by re-reading in a new Core Data stack; verification_failed means committed: true and indeterminate. A timeout is indeterminate: read native-note-state before any retry.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      dryRun: z
        .boolean()
        .describe("true: plan only and return revisionBefore. false: apply; requires ifRevision"),
      ifRevision: revisionToken
        .optional()
        .describe("The revisionBefore of an identical dry run (required when dryRun is false)"),
      ifPlanDigest: planDigestToken
        .optional()
        .describe(
          "The planDigest of the identical dry run (recommended on apply; refuses with plan_mismatch if the request or a replacement file changed)"
        ),
      requireNonSystemPaper: z
        .boolean()
        .optional()
        .describe("Refuse Quick Notes; repeat it in both the dry run and the apply"),
      ...writerScopeGuardInput(),
      operations: editOperationsSchema.describe(
        "Applied together against one snapshot. ops: replace {selector:{text, scope?, match?, occurrence?}|{kind:'attachment', identifier|id|ordinal, position?:'self'|'before'|'after'}, replacement:{text}|{runs}|{file, filename?}}, delete_paragraph {selector:{text, scope?, occurrence?}|{kind:'blank', style, occurrence?}|{kind:'attachment', identifier|id|ordinal}}, insert_after/insert_before {anchor:{text, scope?, occurrence?}|{kind:'style', style, occurrence?}|{kind:'attachment', identifier|id|ordinal}, blocks:[{type, text|runs, checked?}]}, append_to_paragraph {anchor (as for inserts), runs}, replace_checklist {select?:'block'|'all', containing?, occurrence?, items:[{text|runs, checked, indent?}], expectedCount?}, set_title {replacement:{text}|{runs}}, trim_blank_lines {mode:'runs'|'end'|'around', keep?, anchor? (around only: {text, scope?, occurrence?}|{kind:'style', style, occurrence?}, must name one paragraph), side?:'before'|'after'|'both', expectedCount?}. A run is {text, bold?, italic?, underline?, strikethrough?, link? (http, https, mailto, tel, notes, applenotes), highlight? (purple, pink, orange, mint, blue), color? (#RRGGBB)}; its formatting replaces the replaced text's inline formatting. An attachment replace with position 'self' and text '' removes that attachment from the body, and with {file, filename?} (an absolute path to an image or PDF of at most 64 MiB in home, temp, or /Volumes) puts a new attachment in its place in the same save; 'before'/'after' insert the text inline beside it. delete_paragraph with an attachment selector removes the attachment's own paragraph, which must hold nothing else; deleting the last paragraph leaves the previous paragraph's line break. ordinal counts the note's attachments in body order. append_to_paragraph adds the runs at the end of the anchor paragraph, on the same line (put a leading space in the first run). replace_checklist replaces one contiguous run of checklist rows (the one holding a row whose text equals containing, the occurrence-th, or the only one) or, with select 'all', every checklist row; all other text and attachments stay. expectedCount (default 1) must equal the full match count; occurrence picks one of them and may not exceed it. For replace_checklist, expectedCount is optional and counts replaced rows. For trim_blank_lines, expectedCount is optional and counts removed paragraphs; only whitespace-only title, heading, subheading, or body paragraphs are removed (never the title paragraph, list, checklist, monospaced, or attachment rows), keep (0 to 10) is how many of each run stay (default 1 for runs, 0 otherwise)."
      ),
      nudge: z
        .boolean()
        .optional()
        .describe(
          "After a verified apply, ask Notes.app to upload the note by moving it into its own folder (default false)"
        ),
      nudgeWaitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_NUDGE_WAIT_SECONDS)
        .optional()
        .describe("With nudge: how long to watch Notes' upload counters (default 30)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args, deps) => {
      const identifier = resolveIdentifier(manager, args);
      const result = editNote(
        {
          identifier,
          dryRun: args.dryRun,
          ifRevision: args.ifRevision,
          ifPlanDigest: args.ifPlanDigest,
          requireNonSystemPaper: args.requireNonSystemPaper,
          operations: args.operations,
          scope: scopeGuardFrom(args),
        },
        deps.writer
      );
      if (!args.nudge || result.status !== "updated") return { ...result };
      return {
        ...result,
        sync: await nudgeAfterWrite(identifier, args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );
}

/**
 * The post-write nudge. A failure here never hides the committed write: it
 * is reported inside `sync` instead of failing the tool.
 */
export async function nudgeAfterWrite(
  identifier: string | string[],
  waitSeconds: number | undefined,
  deps: NudgeDeps
): Promise<Record<string, unknown>> {
  const identifiers = Array.isArray(identifier) ? identifier : [identifier];
  try {
    const report = await nudgeInPlace({ identifiers, waitSeconds }, deps);
    const { before: _before, after: _after, ...rest } = report;
    void _before;
    void _after;
    return { ok: true, ...rest };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof PrivateHelperError ? error.code : "internal_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
