/**
 * insert-link service: turns a URL into one link paragraph, hands it to the
 * guarded append path (AppleScript for ordinary notes, the native bridge for
 * notes with native objects), then proves the result from the note's stored
 * link runs rather than from the HTML that was sent.
 *
 * Rich URL preview cards are not produced here. No public automation route
 * creates one, so this service writes text links only.
 */
import type { NoteLink } from "../utils/noteRichText.js";
import { buildLinkInsertion, verifyLinkReadback } from "../utils/linkInsert.js";
import type { InsertLinkParams, InsertLinkResult, LinkAppendOutcome } from "../types.js";

/** Collaborators insertLink needs; index.ts supplies the real ones. */
export interface LinkInsertDependencies {
  /** Decoded link runs currently stored in the note. */
  readLinks(id: string): NoteLink[];
  /**
   * Run the guarded append with HTML content. Must check the revision, write,
   * verify visible text and existing links, and throw on any failure.
   */
  append(request: {
    id: string;
    expectedContentHash: string;
    content: string;
    position: "after" | "before";
    separator: string;
    scopeText?: string;
  }): LinkAppendOutcome;
}

/** Insert one raw URL or hyperlink into an exact note and verify it by readback. */
export function insertLink(
  request: InsertLinkParams,
  deps: LinkInsertDependencies
): InsertLinkResult {
  const insertion = buildLinkInsertion(request);
  const before = deps.readLinks(request.id);
  const outcome = deps.append({
    id: request.id,
    expectedContentHash: request.expectedContentHash,
    content: insertion.html,
    position: request.position === "after-title" ? "before" : "after",
    separator: request.blankLine ? "\n\n" : "",
    scopeText: request.scopeText,
  });
  let readback;
  try {
    readback = verifyLinkReadback(before, deps.readLinks(request.id), insertion, request.url);
  } catch (error) {
    // The append itself committed; only the link proof failed. Say so, so a
    // caller does not repeat a write that already landed.
    throw new Error(
      `The text was written, but link verification failed: ${error instanceof Error ? error.message : String(error)}. Do not retry automatically.`
    );
  }
  return {
    ok: true,
    id: request.id,
    mode: request.mode,
    url: request.url,
    text: insertion.text,
    position: request.position,
    route: outcome.route,
    ...readback,
    previousContentHash: request.expectedContentHash,
    contentHash: outcome.contentHash,
  };
}
