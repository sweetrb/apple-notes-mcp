/**
 * `compose-note`: structured, natively styled writes through the opt-in
 * private WRITER.
 *
 * - append / prepend: one guarded insert into an existing note. Plan with
 *   `dryRun: true`, then apply the identical content with the plan's
 *   `revisionBefore` as `ifRevision`.
 * - create: Notes.app creates the note (AppleScript, so Notes owns the new
 *   record and schedules its upload), then the writer appends the composed
 *   content below the title under a revision guard read immediately after.
 *
 * Registered next to the other writer tools (tools/privateWriterTools.ts)
 * through {@link registerWriterTool}, so it shares their error envelope and
 * the optional post-write sync nudge.
 *
 * @module tools/composeNoteTool
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "node:path";
import { z } from "zod";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import { MAX_NUDGE_WAIT_SECONDS } from "../services/privateSyncNudge.js";
import {
  PrivateWriteError,
  privateWriterCapabilities,
  readWriterNoteState,
  type PrivateHelperDeps,
} from "../services/privateWriter.js";
import {
  assertComposeWritesAllowed,
  assertWriterRequestSize,
  blockSchema,
  blocksToParagraphs,
  composeNote,
  crossCheckWithDatabase,
  isObject,
  markdownToBlocks,
  notesLinkTargets,
  type WireEntry,
} from "../services/privateCompose.js";
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

export const composeNoteInput = {
  mode: z
    .enum(["create", "append", "prepend"])
    .describe("create a new note, append at the end, or prepend below the title"),
  identifier: notesUuid.optional().describe("append/prepend: target Notes UUID"),
  id: coreDataId.optional().describe("append/prepend: x-coredata note id, resolved to a UUID"),
  title: z.string().min(1).max(1000).optional().describe("create: the new note's title"),
  folder: z.string().min(1).optional().describe("create: existing folder (nested paths allowed)"),
  account: z.string().min(1).optional().describe("create: account name"),
  blocks: z
    .array(blockSchema)
    .min(1)
    .max(2000)
    .optional()
    .describe("Ordered content blocks. Give exactly one of blocks or markdown."),
  markdown: z
    .string()
    .min(1)
    .max(200_000)
    .optional()
    .describe(
      "Markdown to import natively: # and ## headings, ### subheadings, lists, - [ ]/- [x] checklists, > quotes, fenced code, --- dividers, pipe tables, **bold**, *italic*, ~~strike~~, <u>underline</u>, links; an image alone on a line becomes a file (absolute path) or link card (http URL)"
    ),
  ifRevision: revisionToken
    .optional()
    .describe("append/prepend apply: revisionBefore from an identical dry run"),
  dryRun: z.boolean().optional().describe("Validate and plan without writing"),
  requireNonSystemPaper: z
    .boolean()
    .optional()
    .describe("append/prepend: refuse a Quick Note target; repeat in plan and apply"),
  insertBeforeHeading: z
    .object({
      text: z.string().min(1).max(1000),
      occurrence: z.number().int().min(1).optional().describe("1-based; default 1"),
      expectedCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Exact number of equal Heading paragraphs; default 1"),
    })
    .strict()
    .optional()
    .describe("append only: insert before one exact Heading-style paragraph instead of at the end"),
  // append/prepend only: create picks its folder itself, so a guard there would
  // only be checked after Notes.app had already made the note.
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
};

type ComposeArgs = z.infer<z.ZodObject<typeof composeNoteInput>>;

export interface ComposeRuntime {
  manager: AppleNotesManager;
  deps: PrivateHelperDeps;
  /** Blocking wait between identity lookups after a create; injectable for tests. */
  sleep: (ms: number) => void;
}

function invalid(message: string): PrivateWriteError {
  return new PrivateWriteError("invalid_request", message, false);
}

/** The wire paragraphs for the request, plus any Markdown import warnings. */
function contentFor(args: ComposeArgs): { paragraphs: WireEntry[]; warnings: string[] } {
  if ((args.blocks === undefined) === (args.markdown === undefined))
    throw invalid("Give exactly one of blocks or markdown");
  if (args.blocks) return { paragraphs: blocksToParagraphs(args.blocks), warnings: [] };
  const imported = markdownToBlocks(args.markdown as string, args.title);
  if (!imported.blocks.length) throw invalid("The Markdown produced no content");
  return { paragraphs: blocksToParagraphs(imported.blocks), warnings: imported.warnings };
}

function checkModeFields(args: ComposeArgs): void {
  const present = (keys: Array<keyof ComposeArgs>) => keys.filter((k) => args[k] !== undefined);
  if (args.dryRun && args.nudge) throw invalid("A dry run does not take nudge");
  if (args.mode === "create") {
    const extra = present([
      "identifier",
      "id",
      "ifRevision",
      "requireNonSystemPaper",
      "insertBeforeHeading",
      "ifFolderId",
      "ifAncestorFolderId",
      "forbiddenAncestorFolderIds",
    ]);
    if (extra.length) throw invalid(`create does not take ${extra.join(", ")}`);
    if (!args.title?.trim()) throw invalid("create requires a title");
    return;
  }
  const extra = present(["title", "folder", "account"]);
  if (extra.length) throw invalid(`${args.mode} does not take ${extra.join(", ")}`);
  if (args.insertBeforeHeading && args.mode !== "append")
    throw invalid("insertBeforeHeading is valid only in append mode");
  if (args.dryRun && args.ifRevision) throw invalid("A dry run does not take ifRevision");
  if (!args.dryRun && !args.ifRevision)
    throw invalid("Applying requires ifRevision: run the identical request with dryRun first");
}

const UUID_IN_LINK = /identifier=([0-9A-F-]{36})$/i;

/**
 * Every link to a note (a noteLink block, or any `notes:` or `applenotes:`
 * link in a run or in Markdown) must name a note the writer can read that is
 * neither in Recently Deleted nor locked, so a typo never becomes a dead link.
 * Read-only; one lookup per distinct target.
 */
function assertNoteLinkTargets(paragraphs: WireEntry[], deps: PrivateHelperDeps): void {
  const targets = new Set<string>();
  for (const { link, target } of notesLinkTargets(paragraphs)) {
    if (!target)
      throw invalid(`The Notes link ${link} does not name a note (showNote?identifier=)`);
    targets.add(target);
  }
  for (const target of targets) {
    let state: ReturnType<typeof readWriterNoteState>;
    try {
      state = readWriterNoteState(target, deps);
    } catch (error) {
      if (error instanceof PrivateWriteError && error.code === "not_found")
        throw invalid(`Link target ${target} is not a note in this library`);
      throw error;
    }
    if (state.deletedOrInTrash)
      throw invalid(`Link target ${target} is in Recently Deleted or marked for deletion`);
    if (state.passwordProtected) throw invalid(`Link target ${target} is a locked note`);
  }
}

/**
 * Add the independent NoteStore read-back to an applied (not planned)
 * compose, including the requested text of each paragraph.
 */
function withDatabaseCheck(
  result: ReturnType<typeof composeNote>,
  paragraphs: WireEntry[]
): Record<string, unknown> {
  if (result.status !== "updated") return result;
  return {
    ...result,
    databaseReadBack: crossCheckWithDatabase(result, undefined, paragraphs),
  };
}

/** Placeholders the length of a real identifier and revision, for size checks. */
const PLACEHOLDER_IDENTIFIER = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_REVISION = `r1:${"0".repeat(64)}`;

/**
 * After a create-mode compose failed with nothing committed, move the new
 * note (title only, and ours) to Recently Deleted, but only when the writer
 * still sees exactly the revision it read right after the create and Notes
 * still holds the body read just before the delete. Returns what happened.
 */
function discardCreatedNote(
  manager: AppleNotesManager,
  id: string,
  identifier: string,
  revision: string,
  deps: PrivateHelperDeps
): "moved_to_recently_deleted" | "kept" {
  try {
    if (readWriterNoteState(identifier, deps).revision !== revision) return "kept";
    const body = manager.getNoteContentById(id);
    return manager.deleteNoteByIdIfUnchanged(id, body).status === "deleted"
      ? "moved_to_recently_deleted"
      : "kept";
  } catch {
    return "kept";
  }
}

/** Retry a lookup that can briefly lag Notes.app's save of a new note. */
function poll<T>(attempt: () => T | null, sleep: (ms: number) => void): T | null {
  for (let i = 0; i < 5; i++) {
    const value = attempt();
    if (value) return value;
    sleep(300);
  }
  return null;
}

function createAndCompose(
  args: ComposeArgs,
  paragraphs: WireEntry[],
  runtime: ComposeRuntime
): Record<string, unknown> {
  const { manager, deps, sleep } = runtime;
  // Check everything that could refuse the compose BEFORE creating a note:
  // the gates, the writer features the content needs, and the request size
  // (blocksToParagraphs already applied every content and character rule).
  assertComposeWritesAllowed(deps.env);
  assertWriterRequestSize({
    identifier: PLACEHOLDER_IDENTIFIER,
    mode: "append",
    paragraphs,
    ifRevision: PLACEHOLDER_REVISION,
  });
  const features = privateWriterCapabilities(deps).features;
  const kinds = new Set(paragraphs.filter(isObject).map((p) => p.kind));
  const needed = [features.composeNote];
  if (kinds.has("divider") || kinds.has("table")) needed.push(features.composeObjects);
  if (kinds.has("file") || kinds.has("url")) needed.push(features.composeAttachments);
  for (const capability of needed)
    if (!capability.available)
      throw new PrivateWriteError(
        capability.reason || "private_api_unavailable",
        capability.detail || "compose is unavailable",
        false
      );
  const note = manager.createNote(
    args.title as string,
    "",
    [],
    args.folder,
    args.account,
    "plaintext"
  );
  if (!note)
    throw new PrivateWriteError(
      "create_failed",
      "Notes.app did not create the note (check that the folder and account exist)",
      false
    );
  const created = { noteCreated: true, id: note.id };
  const identifier = poll(
    () => manager.getNoteLinkById(note.id)?.match(UUID_IN_LINK)?.[1] ?? null,
    sleep
  );
  if (!identifier)
    throw new PrivateWriteError(
      "not_found",
      "The note was created, but its Notes UUID could not be read (needs Full Disk Access). " +
        "The note holds only its title; delete it or retry with mode append.",
      false,
      created
    );
  let revision: string | null = null;
  try {
    const state = poll(() => {
      try {
        return readWriterNoteState(identifier, deps);
      } catch (error) {
        if (error instanceof PrivateWriteError && error.code === "not_found") return null;
        throw error;
      }
    }, sleep);
    if (!state)
      throw new PrivateWriteError("not_found", "The writer cannot see the new note yet", false);
    revision = state.revision;
    const result = composeNote(
      { identifier, mode: "append", paragraphs, ifRevision: state.revision },
      deps
    );
    return {
      ...withDatabaseCheck(result, paragraphs),
      mode: "create",
      created: true,
      id: note.id,
      identifier,
    };
  } catch (error) {
    if (!(error instanceof PrivateWriteError)) throw error;
    // Nothing was written into the new note: it holds only its title, and it
    // is ours, so move it to Recently Deleted rather than leave a stray note.
    const createdNote =
      error.committed === false && revision
        ? discardCreatedNote(manager, note.id, identifier, revision, deps)
        : "kept";
    const outcome =
      createdNote === "moved_to_recently_deleted"
        ? `the new note ${note.id} was moved to Recently Deleted`
        : `the note was created with its title only; id ${note.id}, identifier ${identifier}`;
    throw new PrivateWriteError(error.code, `${error.message} (${outcome})`, error.committed, {
      ...error.details,
      ...created,
      identifier,
      createdNote,
    });
  }
}

/** Run one compose-note request. Throws PrivateWriteError on every refusal. */
export function runComposeNote(
  args: ComposeArgs,
  runtime: ComposeRuntime
): Record<string, unknown> {
  checkModeFields(args);
  const { paragraphs, warnings } = contentFor(args);
  assertNoteLinkTargets(paragraphs, runtime.deps);
  const extra = warnings.length ? { warnings } : {};
  if (args.mode === "create") {
    if (args.dryRun) {
      assertWriterRequestSize({
        identifier: PLACEHOLDER_IDENTIFIER,
        mode: "append",
        paragraphs,
        ifRevision: PLACEHOLDER_REVISION,
      });
      return {
        status: "planned",
        dryRun: true,
        committed: false,
        mode: "create",
        paragraphs: paragraphs.length,
        plan: paragraphs.map((p) =>
          isObject(p)
            ? {
                kind: p.kind,
                ...(p.kind === "table" ? { rows: p.rows.length, columns: p.rows[0].length } : {}),
                ...(p.kind === "file"
                  ? { path: p.path, filename: p.filename ?? basename(p.path) }
                  : {}),
                ...(p.kind === "url" ? { url: p.url } : {}),
              }
            : {
                style: p.style,
                indent: p.indent ?? 0,
                blockQuote: p.blockQuote ?? false,
                ...(p.checked !== undefined ? { checked: p.checked } : {}),
                runs: p.runs.length,
              }
        ),
        ...extra,
      };
    }
    return { ...createAndCompose(args, paragraphs, runtime), ...extra };
  }
  const identifier = resolveIdentifier(runtime.manager, args);
  const result = composeNote(
    {
      identifier,
      mode: args.mode,
      paragraphs,
      ...(args.dryRun ? { dryRun: true } : { ifRevision: args.ifRevision }),
      ...(args.requireNonSystemPaper ? { requireNonSystemPaper: true } : {}),
      ...(args.insertBeforeHeading ? { insertBeforeHeading: args.insertBeforeHeading } : {}),
      scope: scopeGuardFrom(args),
    },
    runtime.deps
  );
  return {
    ...withDatabaseCheck(result, paragraphs),
    ...(args.id ? { id: args.id } : {}),
    ...extra,
  };
}

export const blockingSleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function registerComposeNoteTool(
  server: McpServer,
  manager: AppleNotesManager,
  depsFactory: () => WriterToolDeps = defaultWriterToolDeps,
  sleep: (ms: number) => void = blockingSleep
) {
  registerWriterTool(
    server,
    depsFactory,
    "compose-note",
    "Use when: writing natively formatted content to Apple Notes in one step through the private writer: headings, subheadings, body paragraphs with bold/italic/underline/strikethrough/link/highlight/color runs, bulleted/dashed/numbered lists with indent, checklists with checked state, block quotes, monospaced blocks, native dividers, native tables, local files and rich link cards placed in order, and links to other notes. Modes: create (new note in a folder), append (end of a note, or before one exact heading), prepend (directly below the title). Accepts a block list or Markdown.\n" +
      "Returns: plan (dryRun) or committed/verified flags, revisionBefore/revisionAfter, unitStart and objectURI (where the written paragraphs begin), readBack (each written paragraph's persisted style, indent, quote, checklist state, and run attributes), databaseReadBack (the same paragraphs decoded independently from NoteStore.sqlite), objects (each created divider, table, file with its size and SHA-256, or link card), frozenAttachments (existing attachments proven unchanged), sync state (pushScheduled is always false; pushState, cloudSync), and with nudge: true a `sync` report.\n" +
      "Do not use when: the writer is not enabled (check native-writer-status), the target is locked, shared, trashed, still downloading, or has no title line.\n" +
      "Safety: writes to the Notes database through unsupported private API. Requires APPLE_NOTES_MCP_ENABLE_PRIVATE=1, APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1, and a built writer (setup --native-writer). append/prepend: run with dryRun: true, then send the IDENTICAL request with ifRevision set to the plan's revisionBefore; any change in between refuses with nothing written. Every paragraph, table cell, card URL, and file's bytes is verified in a fresh read and checked against the request; existing attachments are fingerprinted before and after and any change refuses (attachment_drift, nothing written). Files follow add-attachment's rules (absolute path, regular file, at most 64 MiB; at most 20 files and cards). A link to a note must name an existing note that is not locked or in Recently Deleted. A timeout is indeterminate (indeterminate: true): read native-note-state before retrying. create checks every limit first, then makes the note through Notes.app; if the compose then fails with nothing written, the unchanged title-only note is moved to Recently Deleted (createdNote), otherwise the error names it. Not yet live-validated, so writes also require APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1.",
    composeNoteInput,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args, deps) => {
      const result = runComposeNote(args, { manager, deps: deps.writer, sleep });
      if (!args.nudge || result.status !== "updated") return result;
      return {
        ...result,
        sync: await nudgeAfterWrite(String(result.identifier), args.nudgeWaitSeconds, deps.nudge),
      };
    }
  );
}
