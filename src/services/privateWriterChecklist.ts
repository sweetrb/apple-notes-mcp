/**
 * Native checklist toggling through the opt-in private WRITER.
 *
 * Shortcuts cannot change a checklist item's done state, so this is the only
 * write path for it. The writer finds the one checklist item whose ICTTTodo
 * identity matches, rewrites only its done bit through the note's CRDT, and
 * re-reads the item from a fresh Core Data stack (`persistedDone`). The
 * item's identity, text, indentation, and every other attribute are kept.
 *
 * Checklist identifiers are the 16 bytes of the item's todo UUID written as 32
 * lowercase hex digits, the same `id` get-native-objects reports in
 * `checklistItems`. The writer's read-only `read_checklist` action lists them
 * with the note's revision token.
 *
 * @module services/privateWriterChecklist
 */
import { z } from "zod";
import {
  CHECKLIST_TOGGLE_LIVE_VALIDATED,
  PrivateWriteError,
  assertNoteIdentifier,
  assertRevision,
  callPrivateWriter,
  defaultWriterDeps,
  parseWriterResult,
  requireLiveValidated,
  writeSyncFields,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { writerScopeFields, type ScopeGuard } from "./privateWriterScope.js";

/** 32 hex digits, or the same UUID with dashes. */
export const TODO_IDENTIFIER =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const revision = z.string().regex(/^r1:[a-f0-9]{64}$/);

export const checklistItemSchema = z
  .object({
    todoIdentifier: z.string().regex(/^[0-9a-f]{32}$/),
    uuid: z.string(),
    index: z.number().int().nonnegative(),
    done: z.boolean(),
    /** The line holding the item's first non-newline character. */
    text: z.string(),
    lineStart: z.number().int().nonnegative(),
    lineLengthUTF16: z.number().int().nonnegative(),
    /** The exact characters whose style carries this todo (may start with a borrowed newline). */
    styledStart: z.number().int().nonnegative(),
    styledLengthUTF16: z.number().int().positive(),
    /** false when the identifier appears in more than one place; the toggle refuses it. */
    contiguous: z.boolean(),
    /** false when the item's runs disagree on the done bit; a toggle rewrites all of them. */
    consistent: z.boolean(),
  })
  .passthrough();

export const checklistStateSchema = z
  .object({
    status: z.literal("ok"),
    identifier: z.string(),
    revision,
    items: z.array(checklistItemSchema),
    total: z.number().int().nonnegative(),
    checked: z.number().int().nonnegative(),
  })
  .passthrough();
export type NativeChecklistState = z.infer<typeof checklistStateSchema>;

export const setChecklistResultSchema = z
  .object({
    status: z.enum(["updated", "unchanged"]),
    committed: z.boolean(),
    verified: z.literal(true),
    identifier: z.string(),
    todoIdentifier: z.string().regex(/^[0-9a-f]{32}$/),
    index: z.number().int().nonnegative(),
    done: z.boolean(),
    previousDone: z.boolean(),
    persistedDone: z.boolean(),
    revisionBefore: revision,
    revisionAfter: revision,
    modificationDate: z.string().nullable(),
    ...writeSyncFields,
  })
  .passthrough();
export type SetChecklistResult = z.infer<typeof setChecklistResultSchema>;

/** A todo identifier; a refusal here never reaches the writer. */
export function assertTodoIdentifier(todoIdentifier: string): void {
  if (!TODO_IDENTIFIER.test(todoIdentifier))
    throw new PrivateWriteError(
      "invalid_request",
      "todoIdentifier must be 32 hex digits (get-native-objects checklistItems id) or a UUID",
      false
    );
}

/** Read every native checklist item of one note, with its todo identity and done state. */
export function readNativeChecklist(
  identifier: string,
  deps: PrivateHelperDeps = defaultWriterDeps()
): NativeChecklistState {
  assertNoteIdentifier(identifier);
  return parseWriterResult(
    checklistStateSchema,
    callPrivateWriter("read_checklist", { identifier }, deps),
    false
  );
}

/**
 * Check or uncheck one existing checklist item. A no-op (`status:
 * "unchanged"`, `committed: false`) when the item already has the requested
 * state.
 */
export function setChecklistItem(
  request: {
    identifier: string;
    todoIdentifier: string;
    done: boolean;
    ifRevision: string;
    scope?: ScopeGuard;
  },
  deps: PrivateHelperDeps = defaultWriterDeps()
): SetChecklistResult {
  assertNoteIdentifier(request.identifier);
  assertTodoIdentifier(request.todoIdentifier);
  if (typeof request.done !== "boolean")
    throw new PrivateWriteError("invalid_request", "done must be true or false", false);
  assertRevision(request.ifRevision, "native-checklist-state or native-note-state");
  const scope = writerScopeFields(request.scope);
  requireLiveValidated(CHECKLIST_TOGGLE_LIVE_VALIDATED, "native-set-checklist-item", deps.env);
  return parseWriterResult(
    setChecklistResultSchema,
    callPrivateWriter(
      "set_checklist_item",
      {
        identifier: request.identifier,
        todoIdentifier: request.todoIdentifier.toLowerCase(),
        done: request.done,
        ifRevision: request.ifRevision,
        ...scope,
      },
      deps
    ),
    true
  );
}
