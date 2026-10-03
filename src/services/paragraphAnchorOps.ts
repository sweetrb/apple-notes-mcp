/**
 * Operations the anchor tools and the resolver service share: record anchors
 * for paragraphs just read, resolve a stored anchor (optionally refreshing it
 * or asking an installed writer to re-mint its paragraph ID), and prune stale
 * anchors. Notes data is only read; the registry file is the only thing
 * written.
 *
 * @module services/paragraphAnchorOps
 */
import type { NoteParagraph, NoteParagraphs } from "../utils/noteParagraphs.js";
import {
  anchorFor,
  paragraphIdReminter,
  resolveAnchorDetailed,
  type AnchorResolution,
  type AnchorStatus,
  type ParagraphAnchor,
} from "../utils/paragraphAnchors.js";
import { AnchorRegistry } from "./anchorRegistry.js";

/** Most anchors one call records. */
export const MAX_ANCHORS_PER_CALL = 500;

/** Record (or reuse) an anchor for each paragraph of a note just read. */
export function recordParagraphAnchors(
  note: NoteParagraphs,
  paragraphs: NoteParagraph[],
  registry: AnchorRegistry = new AnchorRegistry(),
  now: Date = new Date()
): Array<{ anchor: ParagraphAnchor; created: boolean }> {
  const candidates = paragraphs
    .slice(0, MAX_ANCHORS_PER_CALL)
    .map((p) => anchorFor(note, p, { anchorId: "", now }));
  return candidates.length ? registry.record(candidates) : [];
}

/** Resolution plus what happened to the stored anchor. */
export interface StoredResolution extends AnchorResolution {
  /** true: the stored anchor now describes the matched paragraph as it is now. */
  refreshed?: boolean;
  refreshSkipped?: string;
  remint?: {
    attempted: boolean;
    paragraphId?: string;
    reason?: "writer-unavailable" | "not-needed" | "writer-failed";
    message?: string;
    /** From a failed writer call: false means nothing was written; "unknown" means read the note before retrying. */
    committed?: boolean | "unknown";
  };
}

/** Lowest confidence at which a refresh rewrites the stored anchor. */
export const REFRESH_MIN_CONFIDENCE = 0.8;

/**
 * Resolve a stored anchor. With `refresh`, a confident match (0.8 or more)
 * updates the stored text, neighbours, block index and paragraph ID so later
 * edits are tracked from here. With `remint`, a `needs-reminting` match is
 * passed to the installed paragraph-ID writer, if any, and resolved again.
 */
export async function resolveStoredAnchor(
  anchorId: string,
  {
    registry = new AnchorRegistry(),
    dbPath,
    minConfidence,
    refresh = false,
    remint = false,
    now = () => new Date(),
  }: {
    registry?: AnchorRegistry;
    dbPath?: string;
    minConfidence?: number;
    refresh?: boolean;
    remint?: boolean;
    now?: () => Date;
  } = {}
): Promise<StoredResolution> {
  const anchor = registry.get(anchorId);
  let { resolution, note } = resolveAnchorDetailed(anchor, { dbPath, minConfidence });
  const out: StoredResolution = { ...resolution };

  if (remint) {
    const writer = paragraphIdReminter();
    if (resolution.status !== "needs-reminting")
      out.remint = { attempted: false, reason: "not-needed" };
    else if (!writer)
      out.remint = {
        attempted: false,
        reason: "writer-unavailable",
        message:
          "Re-minting a paragraph ID needs a writer that can set it; none is installed in this server",
      };
    else {
      try {
        const { paragraphId } = await writer({
          anchorId,
          noteId: resolution.noteId!,
          noteIdentifier: anchor.noteIdentifier,
          blockIndex: resolution.match!.blockIndex,
          expectedText: resolution.match!.text,
          currentParagraphId: resolution.match!.paragraphId,
        });
        ({ resolution, note } = resolveAnchorDetailed(anchor, { dbPath, minConfidence }));
        Object.assign(out, resolution, { remint: { attempted: true, paragraphId } });
      } catch (error) {
        const committed = (error as { committed?: unknown } | null)?.committed;
        out.remint = {
          attempted: true,
          reason: "writer-failed",
          message: error instanceof Error ? error.message : String(error),
          ...(typeof committed === "boolean" || committed === "unknown" ? { committed } : {}),
        };
      }
    }
  }

  if (refresh) {
    if (!out.match || !note || !["resolved", "needs-reminting"].includes(out.status))
      out.refreshSkipped = "nothing was matched";
    else if (out.confidence < REFRESH_MIN_CONFIDENCE)
      out.refreshSkipped = `confidence ${out.confidence} is below ${REFRESH_MIN_CONFIDENCE}`;
    else {
      const paragraph = note.paragraphs.find((p) => p.blockIndex === out.match!.blockIndex)!;
      const fresh = anchorFor(note, paragraph, { anchorId, now: now() });
      registry.replace({ ...fresh, updatedAt: fresh.createdAt });
      out.refreshed = true;
    }
  }
  return out;
}

/** Statuses that mean an anchor can no longer be resolved. */
export const DEFAULT_PRUNE_STATUSES: AnchorStatus[] = ["not-found", "note-not-found"];

/**
 * Find (and unless `dryRun`, remove) anchors whose resolution status is in
 * `statuses`, or exactly the anchors in `anchorIds` when given.
 */
export function pruneParagraphAnchors({
  registry = new AnchorRegistry(),
  dbPath,
  anchorIds,
  noteIdentifier,
  statuses = DEFAULT_PRUNE_STATUSES,
  dryRun = true,
}: {
  registry?: AnchorRegistry;
  dbPath?: string;
  anchorIds?: string[];
  noteIdentifier?: string;
  statuses?: AnchorStatus[];
  dryRun?: boolean;
} = {}): {
  dryRun: boolean;
  examined: number;
  stale: Array<{ anchorId: string; status: AnchorStatus | "listed"; message: string }>;
  removed: string[];
} {
  let anchors = registry.load();
  if (noteIdentifier)
    anchors = anchors.filter((a) => a.noteIdentifier === noteIdentifier.toUpperCase());
  let stale: Array<{ anchorId: string; status: AnchorStatus | "listed"; message: string }>;
  if (anchorIds) {
    const wanted = new Set(anchorIds);
    stale = anchors
      .filter((a) => wanted.has(a.anchorId))
      .map((a) => ({ anchorId: a.anchorId, status: "listed" as const, message: "Listed by id" }));
  } else {
    const wanted = new Set(statuses);
    stale = [];
    for (const anchor of anchors) {
      const r = resolveAnchorDetailed(anchor, { dbPath }).resolution;
      if (wanted.has(r.status))
        stale.push({ anchorId: anchor.anchorId, status: r.status, message: r.message });
    }
  }
  const removed = dryRun || !stale.length ? [] : registry.remove(stale.map((s) => s.anchorId));
  return { dryRun, examined: anchorIds ? stale.length : anchors.length, stale, removed };
}

/**
 * The resolver service's lookup: a stored anchor's resolution, or undefined
 * when no anchor has that id. Store errors are thrown.
 */
export function registryLookup(
  registry: AnchorRegistry = new AnchorRegistry(),
  dbPath?: string
): (anchorId: string) => AnchorResolution | undefined {
  return (anchorId) => {
    const anchor = registry.load().find((a) => a.anchorId === anchorId);
    return anchor ? resolveAnchorDetailed(anchor, { dbPath }).resolution : undefined;
  };
}
