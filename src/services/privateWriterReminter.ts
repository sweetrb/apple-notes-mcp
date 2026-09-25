/**
 * Re-mints a paragraph anchor's paragraph ID through the opt-in private
 * WRITER.
 *
 * `resolve-paragraph-anchor` with `remint: true` hands a `needs-reminting`
 * match (the paragraph was found, but its stored ID is shared or missing) to
 * whatever writer is installed with `setParagraphIdReminter`. This module is
 * that writer: it reads the note's current `revision` through the writer's
 * read-only `read_note_state`, then calls `set_paragraph_id` with the matched
 * block's index and text. The writer refuses if the note or the paragraph
 * changed in between (`revision_conflict`, `paragraph_changed`), and its own
 * read-back verifies the new ID, so nothing here re-checks the result.
 *
 * It is installed only when both writer switches are on
 * (`APPLE_NOTES_MCP_ENABLE_PRIVATE=1` and
 * `APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1`); otherwise the resolver keeps
 * reporting `writer-unavailable`. `native-set-paragraph-id`'s gates still
 * apply, including `APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1` until it is
 * live-validated, and a refusal is reported as `writer-failed`.
 *
 * @module services/privateWriterReminter
 */
import {
  setParagraphIdReminter,
  type ParagraphIdReminter,
  type RemintRequest,
} from "../utils/paragraphAnchors.js";
import {
  PrivateWriteError,
  defaultWriterDeps,
  privateWritesEnabled,
  readWriterNoteState,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { setParagraphId } from "./privateWriterParagraphs.js";

/** A reminter that gives the matched paragraph a unique ID through the writer. */
export function writerParagraphIdReminter(
  depsFactory: () => PrivateHelperDeps = () => defaultWriterDeps()
): ParagraphIdReminter {
  return async (request: RemintRequest) => {
    const deps = depsFactory();
    if (!privateWritesEnabled(deps.env))
      throw new PrivateWriteError(
        "disabled",
        "Re-minting needs APPLE_NOTES_MCP_ENABLE_PRIVATE=1 and APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1",
        false
      );
    const state = readWriterNoteState(request.noteIdentifier, deps);
    const result = setParagraphId(
      {
        identifier: request.noteIdentifier,
        blockIndex: request.blockIndex,
        expectedText: request.expectedText,
        ifRevision: state.revision,
      },
      deps
    );
    return { paragraphId: result.paragraphId };
  };
}

/**
 * Install the writer reminter when both writer switches are on, and remove
 * any installed one otherwise. Returns whether one is installed.
 */
export function installWriterParagraphIdReminter(
  env: NodeJS.ProcessEnv = process.env,
  depsFactory?: () => PrivateHelperDeps
): boolean {
  if (!privateWritesEnabled(env)) {
    setParagraphIdReminter(undefined);
    return false;
  }
  setParagraphIdReminter(writerParagraphIdReminter(depsFactory));
  return true;
}
