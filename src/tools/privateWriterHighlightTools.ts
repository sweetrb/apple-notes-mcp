/**
 * Highlight tool on the opt-in private WRITER.
 *
 * `native-highlight-text` applies or removes Notes' highlight on every exact
 * occurrence of a literal string (`scope: "text"`, with a count guard) or on
 * the whole body after the title (`scope: "note"`), with a dry run, an
 * `ifRevision` compare-and-swap, a fresh read-back, and the optional
 * move-in-place sync nudge. Both scopes send the writer's `set_highlight`
 * action. It shares the envelope in privateWriterTools.ts.
 *
 * @module tools/privateWriterHighlightTools
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_SCOPES,
  MAX_HIGHLIGHT_RANGES,
  MAX_MATCH_UTF16,
  setHighlight,
  type HighlightTarget,
} from "../services/privateWriterHighlight.js";
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

/** Build the writer target from the tool arguments, refusing mixed scopes. */
function highlightTarget(args: {
  scope?: (typeof HIGHLIGHT_SCOPES)[number];
  match?: string;
  expectedCount?: number;
}): HighlightTarget {
  if (args.scope === "note") {
    if (args.match !== undefined || args.expectedCount !== undefined)
      throw new PrivateWriteError(
        "invalid_request",
        'match and expectedCount apply only to scope "text"; omit them with scope "note"',
        false
      );
    return { scope: "note" };
  }
  if (args.match === undefined)
    throw new PrivateWriteError("invalid_request", 'match is required with scope "text"', false);
  return { scope: "text", match: args.match, expectedCount: args.expectedCount };
}

export function registerPrivateWriterHighlightTools(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps
) {
  registerWriterTool(
    server,
    depsFactory,
    "native-highlight-text",
    'Use when: applying or removing Notes\' highlight (the purple, pink, orange, mint, and blue highlight colors) on exact text in one note (scope "text", the default) or on the whole note body after the title (scope "note"). AppleScript and Shortcuts cannot set it.\n' +
      "Returns: status (planned for a dry run, unchanged when every target range already has that state, updated), rangeCount, characterCount (UTF-16 units targeted), a per-range plan with current runs (dry run or no-op) or the stored runs re-read after the write (`ranges`), for scope note `skipped` (titleUTF16, attachmentGlyphs, highlightedAttachmentGlyphs), hasEmphasis (Notes' derived flag), revisionBefore/revisionAfter, sync state (pushScheduled is always false), and with nudge: true a `sync` report.\n" +
      "Do not use when: the text spans paragraphs (use scope note for the whole body), or you need bold, italic, or text color.\n" +
      "Safety: writes to the Notes database through unsupported private API, changing only the highlight attribute of the target characters. Scope text: `match` is literal and case-sensitive; the call refuses (match_count_mismatch, nothing written) unless it occurs exactly `expectedCount` times. Scope note: takes no match or expectedCount; it covers everything after the title paragraph except attachment glyphs (images, files, tables, drawings, inline tags), whose contents it never changes, and refuses with nothing_to_highlight when nothing is left. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, a built writer, and a fresh `revision` from native-note-state as ifRevision (optional for dryRun). Verifies every highlight run in the note by re-reading it in a new Core Data stack. A timeout is indeterminate (indeterminate: true). Writes are not yet live-validated, so they also require APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1; dryRun does not.",
    {
      identifier: notesUuid.optional().describe("Notes UUID"),
      id: coreDataId.optional().describe("x-coredata note id; resolved to a UUID via the database"),
      scope: z
        .enum(HIGHLIGHT_SCOPES)
        .optional()
        .describe(
          "text (default): every occurrence of `match`; note: the whole body after the title, skipping attachments"
        ),
      match: z
        .string()
        .min(1)
        .max(MAX_MATCH_UTF16)
        .optional()
        .describe(
          "Exact, case-sensitive text to highlight, within one paragraph. Required for scope text; refused for scope note"
        ),
      color: z
        .enum([...HIGHLIGHT_COLORS, "none"])
        .describe("Highlight color, or none to remove the highlight"),
      expectedCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_HIGHLIGHT_RANGES)
        .optional()
        .describe(
          "Scope text only: how many times `match` must occur (default 1); every occurrence is changed"
        ),
      ifRevision: revisionToken
        .optional()
        .describe("The `revision` from native-note-state; required unless dryRun is true"),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Report the target ranges, character count, and current highlight without writing"
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
      const result = setHighlight(
        {
          identifier,
          target: highlightTarget(args),
          color: args.color,
          ifRevision: args.ifRevision,
          dryRun: args.dryRun,
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
