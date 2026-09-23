/**
 * Pure helpers for the insert-link tool: URL policy, the HTML block written to
 * Notes, and the before/after link comparison that proves a link was stored.
 *
 * Notes keeps a link as an attribute on a run of body text (the decoded
 * protobuf `links` that `readRichNote` returns), so verification compares
 * those decoded runs rather than trusting the HTML that was sent.
 */
import { linkSignature, type NoteLink } from "./noteRichText.js";
import type { LinkInsertMode } from "../types.js";

/** Longest URL accepted. Notes has no documented limit; this bounds the AppleScript literal. */
export const MAX_LINK_URL_LENGTH = 4096;
/** Longest hyperlink label accepted. */
export const MAX_LINK_LABEL_LENGTH = 2000;

/**
 * Schemes the rich-text reader can restore and verify. Anything else would
 * fail readback (`htmlLinks` refuses it), so it is refused before writing.
 */
const LINK_SCHEMES = /^(?:https?:\/\/[^/?#\s]+|mailto:[^\s]|notes:\/\/[^\s]|applenotes:[^\s])/i;

/**
 * Validate one link destination. Returns the URL unchanged or throws with a
 * message naming the rule it broke.
 */
export function validateLinkUrl(url: string): string {
  if (!url) throw new Error("Link URL is required");
  if (url.length > MAX_LINK_URL_LENGTH)
    throw new Error(`Link URL is longer than ${MAX_LINK_URL_LENGTH} characters`);
  if (Array.from(url).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
    throw new Error("Link URL cannot contain spaces, line breaks or control characters");
  if (/[<>"]/u.test(url)) throw new Error('Link URL cannot contain <, > or "');
  if (!LINK_SCHEMES.test(url))
    throw new Error(
      "Link URL must be an absolute http(s) URL with a host, or a mailto:, notes:// or applenotes: link"
    );
  return url;
}

/**
 * Validate a hyperlink label: one line of visible text.
 */
export function validateLinkLabel(label: string): string {
  if (!label.trim()) throw new Error("Hyperlink label must contain visible text");
  if (label.length > MAX_LINK_LABEL_LENGTH)
    throw new Error(`Hyperlink label is longer than ${MAX_LINK_LABEL_LENGTH} characters`);
  if (Array.from(label).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error("Hyperlink label must be one line without control characters");
  return label;
}

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeHref = (url: string) => escapeText(url).replace(/"/g, "&quot;");

/** What to insert and what the readback must show afterwards. */
export interface LinkInsertion {
  /** One `<div>` paragraph written to Notes. */
  html: string;
  /** Visible text of that paragraph. */
  text: string;
  /** The link run expected in the decoded body, or null for an unlinked raw URL. */
  link: { text: string; url: string } | null;
}

/**
 * Build the paragraph for a link.
 *
 * - `raw`, `linked` (default): the URL is its own visible text and carries a
 *   stored link attribute, so it is clickable on every device.
 * - `raw`, not `linked`: the URL is plain text with no stored link. Notes may
 *   still detect and underline it when displaying the note, but nothing is
 *   stored, so readers of the note body see ordinary text.
 * - `hyperlink`: `label` is the visible text and carries the link.
 */
export function buildLinkInsertion(request: {
  mode: LinkInsertMode;
  url: string;
  label?: string;
  linked?: boolean;
}): LinkInsertion {
  const url = validateLinkUrl(request.url);
  if (request.mode === "hyperlink") {
    if (request.label === undefined) throw new Error("Hyperlink mode requires a label");
    if (request.linked === false)
      throw new Error("linked=false applies to raw mode only; a hyperlink is always linked");
    const label = validateLinkLabel(request.label);
    return {
      html: `<div><a href="${escapeHref(url)}">${escapeText(label)}</a></div>`,
      text: label,
      link: { text: label, url },
    };
  }
  if (request.label !== undefined)
    throw new Error("A label applies to hyperlink mode only; raw mode shows the URL itself");
  if (request.linked === false)
    return { html: `<div>${escapeText(url)}</div>`, text: url, link: null };
  return {
    html: `<div><a href="${escapeHref(url)}">${escapeText(url)}</a></div>`,
    text: url,
    link: { text: url, url },
  };
}

/** Count decoded link runs whose label and destination match `expected`. */
export function countMatchingLinks(
  links: Array<{ text: string; url: string }>,
  expected: { text: string; url: string }
): number {
  const wanted = linkSignature([expected]);
  return links.filter((link) => linkSignature([link]) === wanted).length;
}

/** Count decoded link runs pointing at `url` (bare http origins compare with or without "/"). */
export function countLinksTo(links: Array<{ text: string; url: string }>, url: string): number {
  const wanted = linkSignature([{ text: "x", url }]);
  return links.filter((link) => linkSignature([{ text: "x", url: link.url }]) === wanted).length;
}

/** Outcome of comparing the note's decoded links before and after an insert. */
export interface LinkReadback {
  /** Whether Notes stored a link attribute for the inserted text. */
  linkStored: boolean;
  /** Stored destination read back from the note, when a link was stored. */
  storedUrl?: string;
}

/**
 * Prove the insert from the decoded links. A linked insert must add exactly
 * one run with the expected label and destination and leave every earlier
 * link in place. An unlinked raw URL reports whether Notes stored a link to it
 * anyway, rather than guessing.
 */
export function verifyLinkReadback(
  before: NoteLink[],
  after: NoteLink[],
  insertion: LinkInsertion,
  url: string
): LinkReadback {
  for (const link of before) {
    if (countMatchingLinks(after, link) < countMatchingLinks(before, link))
      throw new Error("An existing link changed during the insert; read the note before retrying");
  }
  if (insertion.link) {
    const added =
      countMatchingLinks(after, insertion.link) - countMatchingLinks(before, insertion.link);
    if (added !== 1)
      throw new Error(
        "The inserted link was not found in the note's stored links; read the note before retrying"
      );
    const stored = after.filter(
      (link) => linkSignature([link]) === linkSignature([insertion.link!])
    );
    return { linkStored: true, storedUrl: stored[stored.length - 1].url };
  }
  const gained = countLinksTo(after, url) - countLinksTo(before, url);
  return gained > 0
    ? {
        linkStored: true,
        storedUrl: after.filter((link) => countLinksTo([link], url) === 1).pop()!.url,
      }
    : { linkStored: false };
}
