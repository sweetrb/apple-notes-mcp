/**
 * Paragraph anchors: a record of where a paragraph was when it was linked,
 * and a resolver that finds it again later (read-only).
 *
 * A paragraph link carries the paragraph's stored UUID, which Notes can copy
 * (on a split) or drop (on some edits). An anchor also keeps the paragraph's
 * normalized text, a fingerprint of it, its neighbours' fingerprints and its
 * block index, so the paragraph can be found again after those changes.
 *
 * Resolution tries, in order:
 *
 * 1. the paragraph ID: a paragraph whose first run still carries the anchor's
 *    UUID and no other paragraph does. A link to that UUID opens exactly that
 *    paragraph, so this match is accepted even when the text was edited;
 * 2. the exact normalized text, with the neighbours breaking a tie;
 * 3. similar text between both recorded neighbours (or one neighbour and
 *    nearly identical text).
 *
 * Every step fails closed: two equally good candidates are reported as
 * `ambiguous`, never guessed between. A match whose UUID is now shared or
 * missing is reported as `needs-reminting` with the matched block; only a
 * writer that can set a paragraph UUID can make it linkable again, and this
 * module never writes.
 *
 * @module utils/paragraphAnchors
 */

import { createHash } from "node:crypto";
import { CodedError } from "./errorCodes.js";
import {
  normalizeParagraphText,
  ParagraphLinkError,
  paragraphUrl,
  readNoteParagraphs,
  type NoteParagraph,
  type NoteParagraphs,
  type ParagraphIdStatus,
} from "./noteParagraphs.js";
import {
  activeNoteSql,
  entity,
  NOTES_DB_PATH,
  noteIdFor,
  parseJsonLines,
  readColumns,
  runReadOnlySql,
} from "./noteStoreSql.js";

/** Anchor ids: `pa_` and 24 lowercase hex digits (96 random bits). */
export const ANCHOR_ID_PATTERN = /^pa_[0-9a-f]{24}$/;

/** A recorded paragraph anchor. */
export interface ParagraphAnchor {
  anchorId: string;
  /** The note's Notes UUID, uppercase (stable across devices). */
  noteIdentifier: string;
  /** The note's x-coredata id when recorded; a hint only, local to this Mac. */
  noteId: string | null;
  /** The paragraph UUID when recorded, or null. */
  paragraphId: string | null;
  /** The paragraph's status when recorded. */
  paragraphIdStatus: ParagraphIdStatus;
  /** Normalized paragraph text (see normalizeParagraphText). */
  text: string;
  /** Fingerprint of `text`. */
  fingerprint: string;
  /** Fingerprints of the previous and next non-empty paragraphs; null at the note's edges. */
  prevFingerprint: string | null;
  nextFingerprint: string | null;
  /** The paragraph's block index when recorded. */
  blockIndex: number;
  style: string;
  createdAt: string;
  updatedAt?: string;
}

/** How a resolution ended. Only `resolved` carries a url. */
export type AnchorStatus =
  | "resolved"
  | "needs-reminting"
  | "ambiguous"
  | "low-confidence"
  | "not-found"
  | "note-not-found"
  | "note-deleted"
  | "note-unreadable";

/** Which step matched. */
export type AnchorMethod = "paragraph-id" | "exact-text" | "text-and-neighbours";

/** The outcome of resolving one anchor. */
export interface AnchorResolution {
  anchorId: string;
  status: AnchorStatus;
  /** True only for `resolved`. */
  resolved: boolean;
  /** The current direct link, only when `resolved`. */
  url?: string;
  /** The paragraph was found but its UUID is shared or missing. */
  needsReminting: boolean;
  method?: AnchorMethod;
  /** 0 to 1; 0 when nothing was matched. */
  confidence: number;
  /** The matched paragraph (status resolved, needs-reminting or low-confidence). */
  match?: {
    blockIndex: number;
    text: string;
    paragraphId: string | null;
    paragraphIdStatus: ParagraphIdStatus;
    sharedWith?: number;
  };
  changes?: { textChanged: boolean; blockIndexChanged: boolean; paragraphIdChanged: boolean };
  /** How many paragraphs tied (status ambiguous). */
  candidates?: number;
  noteId?: string;
  message: string;
}

/** Default lowest confidence accepted as a match. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Fingerprint of normalized paragraph text: 32 hex digits of SHA-256. */
export const textFingerprint = (normalized: string): string =>
  createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);

/**
 * Similarity of two normalized strings from 0 to 1: the Dice coefficient of
 * their character trigrams (bigrams for very short text).
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const size = Math.min(a.length, b.length) < 3 ? 2 : 3;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    const padded = ` ${s} `;
    for (let i = 0; i + size <= padded.length; i++) {
      const g = padded.slice(i, i + size);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  let total = 0;
  for (const count of ga.values()) total += count;
  for (const [g, count] of gb) {
    total += count;
    shared += Math.min(count, ga.get(g) ?? 0);
  }
  return total ? (2 * shared) / total : 0;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Build an anchor for one paragraph of a note read by readNoteParagraphs.
 * The caller supplies the id and time (the registry does).
 */
export function anchorFor(
  note: NoteParagraphs,
  paragraph: NoteParagraph,
  { anchorId, now }: { anchorId: string; now: Date }
): ParagraphAnchor {
  if (!note.identifier)
    throw new CodedError("The note has no stored identifier, so no anchor can be recorded", {
      code: "unsupported",
    });
  const i = note.paragraphs.indexOf(paragraph);
  if (i < 0) throw new Error("The paragraph does not belong to this note");
  const fp = (p?: NoteParagraph) => (p ? textFingerprint(normalizeParagraphText(p.text)) : null);
  const text = normalizeParagraphText(paragraph.text);
  return {
    anchorId,
    noteIdentifier: note.identifier.toUpperCase(),
    noteId: note.id,
    paragraphId: paragraph.paragraphId,
    paragraphIdStatus: paragraph.paragraphIdStatus,
    text,
    fingerprint: textFingerprint(text),
    prevFingerprint: fp(note.paragraphs[i - 1]),
    nextFingerprint: fp(note.paragraphs[i + 1]),
    blockIndex: paragraph.blockIndex,
    style: paragraph.style,
    createdAt: now.toISOString(),
  };
}

/** Result of matching an anchor against a note's current paragraphs. */
export interface AnchorMatch {
  status: "matched" | "ambiguous" | "low-confidence" | "not-found";
  index?: number;
  method?: AnchorMethod;
  confidence: number;
  candidates?: number;
}

/**
 * Find an anchor's paragraph among a note's current non-empty paragraphs
 * (pure). See the module comment for the steps; ties are never broken by
 * position alone. A match scoring under `minConfidence`, from any step, is
 * reported as `low-confidence`.
 */
export function matchAnchor(
  anchor: ParagraphAnchor,
  paragraphs: NoteParagraph[],
  { minConfidence = DEFAULT_MIN_CONFIDENCE }: { minConfidence?: number } = {}
): AnchorMatch {
  const result = findAnchor(anchor, paragraphs);
  return result.status === "matched" && result.confidence < minConfidence
    ? { ...result, status: "low-confidence" }
    : result;
}

function findAnchor(anchor: ParagraphAnchor, paragraphs: NoteParagraph[]): AnchorMatch {
  const normalized = paragraphs.map((p) => normalizeParagraphText(p.text));
  const fps = normalized.map(textFingerprint);
  const neighbours = (i: number) =>
    Number((fps[i - 1] ?? null) === anchor.prevFingerprint) +
    Number((fps[i + 1] ?? null) === anchor.nextFingerprint);
  const all = paragraphs.map((_, i) => i);

  /** The single candidate with the most matching neighbours, if it is unique and at least one matches. */
  const byNeighbours = (candidates: number[]) => {
    const scored = candidates.map((i) => ({ i, n: neighbours(i) }));
    const best = Math.max(...scored.map((s) => s.n));
    const top = scored.filter((s) => s.n === best);
    return best > 0 && top.length === 1 ? top[0] : undefined;
  };

  // 1. Paragraph ID.
  if (anchor.paragraphId) {
    const owners = all.filter((i) => paragraphs[i].paragraphId === anchor.paragraphId);
    if (owners.length === 1 && paragraphs[owners[0]].paragraphIdStatus === "unique") {
      const i = owners[0];
      const same = fps[i] === anchor.fingerprint;
      const confidence = same
        ? 1
        : 0.8 + 0.15 * Math.max(textSimilarity(anchor.text, normalized[i]), neighbours(i) / 2);
      return { status: "matched", index: i, method: "paragraph-id", confidence: round(confidence) };
    }
    const exact = owners.filter((i) => fps[i] === anchor.fingerprint);
    if (exact.length === 1)
      return { status: "matched", index: exact[0], method: "paragraph-id", confidence: 0.95 };
    if (exact.length > 1) {
      const pick = byNeighbours(exact);
      if (pick)
        return { status: "matched", index: pick.i, method: "paragraph-id", confidence: 0.9 };
    }
  }

  // 2. Exact text.
  const exact = all.filter((i) => fps[i] === anchor.fingerprint);
  if (exact.length === 1) {
    const confidence = neighbours(exact[0]) > 0 ? 0.95 : 0.85;
    return { status: "matched", index: exact[0], method: "exact-text", confidence };
  }
  if (exact.length > 1) {
    const pick = byNeighbours(exact);
    if (pick) return { status: "matched", index: pick.i, method: "exact-text", confidence: 0.8 };
    return { status: "ambiguous", confidence: 0, candidates: exact.length };
  }

  // 3. Similar text held in place by its neighbours.
  const scored = all
    .map((i) => ({ i, sim: textSimilarity(anchor.text, normalized[i]), n: neighbours(i) }))
    .filter(({ sim, n }) => (n === 2 && sim >= 0.5) || (n === 1 && sim >= 0.8))
    .map((s) => ({ ...s, score: 0.4 * s.sim + 0.2 * s.n }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: "not-found", confidence: 0 };
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.1)
    return {
      status: "ambiguous",
      confidence: 0,
      candidates: scored.filter((s) => scored[0].score - s.score < 0.1).length,
    };
  return {
    status: "matched",
    index: scored[0].i,
    method: "text-and-neighbours",
    confidence: round(scored[0].score),
  };
}

/** Turn a match into a resolution for a note's current paragraphs. */
export function resolutionFor(
  anchor: ParagraphAnchor,
  note: Pick<NoteParagraphs, "id" | "identifier" | "paragraphs">,
  options: { minConfidence?: number } = {}
): AnchorResolution {
  const base = {
    anchorId: anchor.anchorId,
    noteId: note.id,
    needsReminting: false,
    resolved: false,
  };
  const result = matchAnchor(anchor, note.paragraphs, options);
  if (result.status === "ambiguous")
    return {
      ...base,
      status: "ambiguous",
      confidence: 0,
      candidates: result.candidates,
      message: `${result.candidates} paragraphs match the anchor equally well; refusing to guess`,
    };
  if (result.status === "not-found")
    return {
      ...base,
      status: "not-found",
      confidence: 0,
      message:
        "The anchored paragraph is no longer in the note (deleted, or edited beyond recognition)",
    };
  const p = note.paragraphs[result.index!];
  const match = {
    blockIndex: p.blockIndex,
    text: p.text,
    paragraphId: p.paragraphId,
    paragraphIdStatus: p.paragraphIdStatus,
    ...(p.sharedWith !== undefined ? { sharedWith: p.sharedWith } : {}),
  };
  const changes = {
    textChanged: textFingerprint(normalizeParagraphText(p.text)) !== anchor.fingerprint,
    blockIndexChanged: p.blockIndex !== anchor.blockIndex,
    paragraphIdChanged: p.paragraphId !== anchor.paragraphId,
  };
  const found = { ...base, method: result.method, confidence: result.confidence, match, changes };
  if (result.status === "low-confidence")
    return {
      ...found,
      status: "low-confidence",
      message: `The best candidate scored ${result.confidence}, below the minimum; refusing to link it`,
    };
  if (p.paragraphIdStatus === "unique" && note.identifier)
    return {
      ...found,
      status: "resolved",
      resolved: true,
      url: paragraphUrl(note.identifier, p.paragraphId!),
      message: `Resolved by ${result.method} (confidence ${result.confidence})`,
    };
  return {
    ...found,
    status: "needs-reminting",
    needsReminting: true,
    message:
      p.paragraphIdStatus === "shared"
        ? `Found the paragraph by ${result.method}, but its ID is shared with ${p.sharedWith} other paragraph(s); it needs a new paragraph ID before it can be linked`
        : `Found the paragraph by ${result.method}, but it has no paragraph ID; it needs one before it can be linked`,
  };
}

/**
 * SQL locating a note by its Notes UUID (bound as `@upper` and `@lower`), with
 * whether Notes shows it outside Recently Deleted and the store UUID.
 */
export function noteByIdentifierSql(columns: ReadonlySet<string>): string {
  return (
    `SELECT json_object('pk', n.Z_PK, 'active', CASE WHEN ${activeNoteSql(columns, "n", "f")} THEN 1 ELSE 0 END, ` +
    `'store', (SELECT Z_UUID FROM Z_METADATA LIMIT 1)) ` +
    `FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER ` +
    `WHERE n.Z_ENT = ${entity("ICNote")} AND n.ZIDENTIFIER IN (CAST(@upper AS TEXT), CAST(@lower AS TEXT)) ` +
    `ORDER BY n.Z_PK;`
  );
}

/**
 * Resolve one anchor against the NoteStore database (read-only), also
 * returning the note that was read. Store access errors (no Full Disk Access,
 * schema) are thrown; everything about the note or paragraph is reported in
 * the resolution.
 */
export function resolveAnchorDetailed(
  anchor: ParagraphAnchor,
  { dbPath = NOTES_DB_PATH, minConfidence }: { dbPath?: string; minConfidence?: number } = {}
): { resolution: AnchorResolution; note?: NoteParagraphs } {
  const none = { anchorId: anchor.anchorId, resolved: false, needsReminting: false, confidence: 0 };
  const columns = readColumns(dbPath);
  const rows = parseJsonLines<{ pk: number; active: number; store: string | null }>(
    runReadOnlySql(dbPath, noteByIdentifierSql(columns), {
      upper: { blob: Buffer.from(anchor.noteIdentifier.toUpperCase(), "utf8") },
      lower: { blob: Buffer.from(anchor.noteIdentifier.toLowerCase(), "utf8") },
    })
  );
  if (!rows.length || !rows[0].store)
    return {
      resolution: {
        ...none,
        status: "note-not-found",
        message: `No note with identifier ${anchor.noteIdentifier} is in the Notes database`,
      },
    };
  if (rows.length > 1)
    return {
      resolution: {
        ...none,
        status: "ambiguous",
        candidates: rows.length,
        message: `${rows.length} notes carry identifier ${anchor.noteIdentifier}; refusing to guess`,
      },
    };
  const noteId = noteIdFor(rows[0].store, rows[0].pk);
  if (!rows[0].active)
    return {
      resolution: {
        ...none,
        noteId,
        status: "note-deleted",
        message: "The note is in Recently Deleted or awaiting deletion",
      },
    };
  let note: NoteParagraphs;
  try {
    note = readNoteParagraphs({ id: noteId }, { dbPath });
  } catch (error) {
    if (error instanceof ParagraphLinkError)
      return {
        resolution: {
          ...none,
          noteId,
          status: error.reason === "not-found" ? "note-not-found" : "note-unreadable",
          message: error.message,
        },
      };
    throw error;
  }
  return { resolution: resolutionFor(anchor, note, { minConfidence }), note };
}

/** {@link resolveAnchorDetailed} without the note. */
export const resolveAnchor = (
  anchor: ParagraphAnchor,
  options: { dbPath?: string; minConfidence?: number } = {}
): AnchorResolution => resolveAnchorDetailed(anchor, options).resolution;

// --- Re-minting hook ---------------------------------------------------------

/** What a paragraph-ID writer is asked to do: give one paragraph a fresh, unique ID. */
export interface RemintRequest {
  anchorId: string;
  noteId: string;
  noteIdentifier: string;
  /** The matched block, as get-note-blocks numbers it. */
  blockIndex: number;
  /** The block's current text; a writer must refuse if it no longer matches. */
  expectedText: string;
  /** The block's current (shared or missing) paragraph ID. */
  currentParagraphId: string | null;
}

/** A writer that sets a new paragraph ID and returns it once committed. */
export type ParagraphIdReminter = (request: RemintRequest) => Promise<{ paragraphId: string }>;

let reminter: ParagraphIdReminter | undefined;

/**
 * Install (or with undefined, remove) the writer that re-mints paragraph IDs.
 * Re-minting needs a writer that can set a paragraph's stored UUID, which
 * public automation cannot do. The server installs the opt-in private
 * writer's `set_paragraph_id` when both writer switches are on
 * (src/services/privateWriterReminter.ts); otherwise none is installed.
 */
export function setParagraphIdReminter(fn: ParagraphIdReminter | undefined): void {
  reminter = fn;
}

/** The installed re-minting writer, if any. */
export function paragraphIdReminter(): ParagraphIdReminter | undefined {
  return reminter;
}
