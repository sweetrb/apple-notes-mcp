import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleNotesManager, buildFolderReference, splitFolderPath } from "./appleNotesManager.js";
import { nativeTagsStatus, normalizeNativeTags, runNativeTagsShortcut } from "./nativeTags.js";
import { shortcutConsentHint } from "./shortcutConsent.js";
import {
  enrichNoteRead,
  readRichNote,
  richContentHash,
  linkSignature,
  htmlLinks,
  type RichNote,
} from "../utils/noteRichText.js";
import { getNoteMetadata } from "../utils/noteMetadata.js";
import { getChecklistItems } from "../utils/checklistParser.js";
import {
  appendMarkdownHtml,
  renderMarkdown,
  usesMarkdownBlocks,
  withoutMarkdownCode,
  type MarkdownBlockExpectations,
} from "../utils/appendMarkdown.js";
import { comparableVisibleText } from "../utils/noteRevision.js";
import { callTimeoutMs } from "../utils/callTimeout.js";

export const BACKGROUND_SHORTCUT = "Apple Notes MCP - Background Operations v5";
/** The configured background-operations bridge name (env override or default). */
export const backgroundShortcutName = () =>
  process.env.APPLE_NOTES_MCP_BACKGROUND_SHORTCUT || BACKGROUND_SHORTCUT;
/** Report whether the configured background-operations bridge is installed uniquely. */
export const backgroundStatus = () => nativeTagsStatus(backgroundShortcutName());
/** Report whether the dedicated native-tag bridge is installed uniquely. */
export const nativeTagBridgeStatus = () => nativeTagsStatus();
export const MARKDOWN_NOTE_SHORTCUT = "Apple Notes MCP - Create Markdown Note";
/** The configured create-from-Markdown bridge name (env override or default). */
export const markdownShortcutName = () =>
  process.env.APPLE_NOTES_MCP_MARKDOWN_SHORTCUT || MARKDOWN_NOTE_SHORTCUT;
/** Report whether the create-from-Markdown bridge is installed uniquely. */
export const markdownNoteStatus = () => nativeTagsStatus(markdownShortcutName());
export type BackgroundOperation =
  | "append-text"
  | "append-markdown"
  | "append-html"
  | "create-checklist-item"
  | "set-pinned"
  | "add-tag"
  | "remove-tag";
export interface BackgroundInput {
  id: string;
  expectedContentHash: string;
  scopeText: string;
}
export interface BackgroundSnapshot {
  id: string;
  title: string;
  hash: string;
  html: string;
  rich: RichNote;
  pinned?: boolean;
  checklist: Array<{ text: string; done: boolean }>;
}
/** Read the exact note state used to guard and verify a native background mutation. */
export function readBackgroundSnapshot(manager: AppleNotesManager, id: string): BackgroundSnapshot {
  if (!/^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i.test(id))
    throw new Error("Exact note ID required");
  const note = manager.getNoteById(id);
  if (!note) throw new Error("Note not found");
  if (note.passwordProtected) throw new Error("Locked notes are unavailable in background mode");
  const html = manager.getNoteContentById(id);
  const enriched = enrichNoteRead(id, html);
  const rich = readRichNote(id);
  if (enriched.revision !== rich.revision)
    throw new Error("Note changed during read; read it again");
  return {
    id,
    title: note.title,
    hash: richContentHash(html, enriched),
    html,
    rich,
    pinned: getNoteMetadata(id).metadata?.pinned,
    checklist: getChecklistItems(id).items || [],
  };
}

/**
 * Elements the native append path accepts, sorted so the error text below reads
 * as a checkable list.
 *
 * The bridge hands this HTML to Notes itself, so the constraint is what Notes
 * can render, not what the bundled Shortcut can parse. `tt` and `code` are the
 * monospace spans `skills/apple-notes/SKILL.md` tells callers to use for paths
 * and commands, and `span` is how Notes stores its own headings — reading a
 * heading back and appending it verbatim used to be rejected (#164). Everything
 * here survives `comparableVisibleText`, which is what verifies the readback.
 */
export const NATIVE_APPEND_ELEMENTS = [
  "a",
  "b",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "i",
  "li",
  "ol",
  "p",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
] as const;

/**
 * The only inline style the native path accepts, and the only one Notes emits
 * for text it created itself: `<span style="font-size: 18px">` around a heading.
 * Anything else (colour, font family, background) is still refused.
 */
const NATIVE_APPEND_SPAN_STYLE = /^font-size\s*:\s*\d{1,3}(?:\.\d+)?(?:px|pt)\s*;?$/i;

/** One sentence naming the HTML the native append path accepts, for tool text and errors. */
export const NATIVE_APPEND_HTML_SUBSET =
  `Native append accepts ${NATIVE_APPEND_ELEMENTS.map((e) => `<${e}>`).join(" ")}, ` +
  `with href on <a> and a font-size style on <span> as the only attributes; ` +
  `everything else needs update-note.`;

/**
 * Markdown that `appendMarkdownHtml` passes through as literal text but Notes'
 * importer consumes, so an appended or created note could never match the
 * expected readback. Verified against Notes on macOS 27: `_x_`/`__x__` emphasis,
 * backslash escapes, entity references, setext underlines, indented block
 * markers, `1)` lists, closing `#`s, and formatting inside link labels.
 */
const UNDERSCORES_OUTSIDE_A_WORD = "underscores outside a word";
const UNMODELED_MARKDOWN: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/mu, UNDERSCORES_OUTSIDE_A_WORD],
  [/\\[!-/:-@[-`{-~]/m, "backslash escapes"],
  [/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/im, "character references"],
  [/^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,})[ \t]*$/m, "underline or rule lines"],
  [/^ {1,3}(?:#|[-+*][ \t]|\d+[.)][ \t])/m, "indented headings or list items"],
  [/^\d+\)[ \t]/m, "`1)` lists"],
  [/^#{1,3}[ \t].*[ \t]#+[ \t]*$/m, "closing # sequences"],
  [/\[[^\]\n]*[*_][^\]\n]*\]\(/m, "formatting inside link labels"],
];

/**
 * Validate imported rich text conservatively. No external image fetching or embedded code.
 *
 * `blocks` is for Notes' own Markdown importer (create-note): fenced code and
 * inline code spans are literal there, so they are left out of the syntax
 * checks, and a bare `---` line is a divider rather than a refused rule line.
 */
export function validateAppendContent(
  content: string,
  format: "plaintext" | "html" | "markdown",
  options: { blocks?: boolean } = {}
) {
  if (!content || content.length > 1024 * 1024 || content.includes("\0"))
    throw new Error("Invalid append content (limit 1 MiB)");
  if (format === "html") {
    const allowed = new Set<string>(NATIVE_APPEND_ELEMENTS);
    for (const tag of content.matchAll(/<\/?\s*([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
      const name = tag[1].toLowerCase();
      if (!allowed.has(name))
        throw new Error(`Unsupported HTML element: <${name}>. ${NATIVE_APPEND_HTML_SUBSET}`);
      let attrs = tag[2].replace(/\/$/, "").trim();
      if (name === "a")
        attrs = attrs.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (_s, _q: string, url: string) => {
          if (
            !/^(https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url) ||
            Array.from(url).some((c) => c.charCodeAt(0) < 33)
          )
            throw new Error("Unsupported link URL");
          return "";
        });
      if (name === "span")
        attrs = attrs.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (_s, _q: string, style: string) => {
          if (!NATIVE_APPEND_SPAN_STYLE.test(style.trim()))
            throw new Error(
              `Unsupported <span> style: ${style.trim().slice(0, 80)}. ` +
                `Native append accepts font-size only, as in <span style="font-size: 18px">.`
            );
          return "";
        });
      if (attrs.trim())
        throw new Error(`Unsupported HTML attributes on <${name}>. ${NATIVE_APPEND_HTML_SUBSET}`);
    }
    if (/<!--|<!|<\?|<[^>]*$/u.test(content)) throw new Error("Unsupported HTML markup");
  }
  if (format === "markdown") {
    const checked = options.blocks
      ? withoutMarkdownCode(content).replace(/^---[ \t]*$/gm, "")
      : content;
    if (/!\[|<\/?[a-z]|\]\(\s*(?:javascript|data|file):/i.test(checked))
      throw new Error("Markdown images, raw HTML and local/executable links are unsupported");
    // CommonMark never forms emphasis inside an inline link destination, so a
    // URL such as https://example.com/_next/static is kept literal. Strip the
    // destinations of the links appendMarkdownHtml recognizes before the
    // underscore test only; every other pattern still sees the full content.
    const withoutLinkDestinations = checked.replace(/(\[[^\]\n]+\])\([^()\s]+\)/g, "$1()");
    for (const [pattern, name] of UNMODELED_MARKDOWN)
      if (pattern.test(name === UNDERSCORES_OUTSIDE_A_WORD ? withoutLinkDestinations : checked))
        throw new Error(
          `Markdown cannot use ${name}; Notes would change that text, so the result could not be verified`
        );
  }
}

/** Invoke an installed bridge (by default Background Operations) with a private temporary JSON request. */
export function runBackgroundShortcut(
  input: Record<string, string>,
  status: ReturnType<typeof nativeTagsStatus> = backgroundStatus()
) {
  if (!status.installed)
    throw new Error(
      `Install the supplied "${status.shortcut}" Shortcut once; Shortcuts must list it exactly once`
    );
  const directory = mkdtempSync(join(tmpdir(), "apple-notes-background-"));
  try {
    const file = join(directory, "request.json");
    // Missing dictionary keys can otherwise prompt inside Shortcuts.
    writeFileSync(
      file,
      JSON.stringify({
        operation: "",
        title: "",
        scopeText: "",
        text: "",
        objectId: "",
        objectName: "",
        change: "",
        otherTitle: "",
        otherScope: "",
        tag: "",
        size: "",
        ...input,
      }),
      { mode: 0o600 }
    );
    try {
      execFileSync("/usr/bin/shortcuts", ["run", status.identifier!, "--input-path", file], {
        encoding: "utf8",
        timeout: callTimeoutMs() ?? 60000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // Carry the Shortcut's name out with the failure. `mutateBackground`
      // reports it, so a stalled run says what it was waiting on instead of a
      // bare "Shortcuts timed out" that names nothing to go and approve (#164).
      throw Object.assign(error as Error, { shortcut: status.shortcut });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface BackgroundDependencies {
  read: (id: string) => BackgroundSnapshot;
  candidates: (title: string, scope: string) => string[];
  run: (input: Record<string, string>) => void;
}
/** Bind production note reads, candidate selection, and Shortcut execution. */
export function backgroundDependencies(manager: AppleNotesManager): BackgroundDependencies {
  return {
    read: (id) => readBackgroundSnapshot(manager, id),
    run: runBackgroundShortcut,
    candidates: (title, scope) =>
      manager.listAccounts().flatMap((account) =>
        manager
          .searchNotes(title, false, account.name)
          .filter(
            (note) =>
              note.title === title &&
              !note.passwordProtected &&
              manager.getNotePlaintextById(note.id).includes(scope)
          )
          .map((note) => note.id)
      ),
  };
}

/** Verify that a native mutation retained all unrelated rich note content. */
export function assertPreserved(
  before: BackgroundSnapshot,
  after: BackgroundSnapshot,
  options: { append?: boolean; tagChange?: string } = {}
) {
  if (before.id !== after.id || before.title !== after.title)
    throw new Error("Note identity changed");
  const tidy = (s: string) => s.replace(/\r\n/g, "\n").replace(/[\s\ufffc]+$/gu, "");
  let oldText = tidy(before.rich.text),
    newText = tidy(after.rich.text);
  if (options.tagChange) {
    const escaped = options.tagChange.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strip = (s: string) =>
      s
        .replace(new RegExp(`#${escaped}(?![\\p{L}\\p{N}_-])`, "gu"), "")
        .replace(/[\s\ufffc]/gu, "");
    oldText = strip(oldText);
    newText = strip(newText);
  }
  if (options.append ? !newText.startsWith(oldText) : newText !== oldText)
    throw new Error("Existing note text was not preserved");
  const links = options.append
    ? after.rich.links.slice(0, before.rich.links.length)
    : after.rich.links;
  if (linkSignature(before.rich.links) !== linkSignature(links))
    throw new Error("Existing links were not preserved");
  if (
    !options.tagChange &&
    before.rich.nativeObjectIds.some((id) => !after.rich.nativeObjectIds.includes(id))
  )
    throw new Error("Existing native object was lost");
  if (
    JSON.stringify(before.checklist) !==
    JSON.stringify(
      options.append ? after.checklist.slice(0, before.checklist.length) : after.checklist
    )
  )
    throw new Error("Existing checklist items changed");
  for (const item of before.rich.checklistItems || []) {
    const actual = after.rich.checklistItems?.find((current) => current.id === item.id);
    if (!actual || actual.text !== item.text || actual.done !== item.done)
      throw new Error("Existing checklist item identity or state changed");
  }
  if (
    before.rich.nativeTags
      .filter((t) => t !== options.tagChange)
      .some((t) => !after.rich.nativeTags.includes(t))
  )
    throw new Error("Existing native tag was lost");
  const allowedRemoved = options.tagChange
    ? before.rich.nativeTagObjectIds?.[options.tagChange] || []
    : [];
  for (const object of before.rich.objectData || []) {
    if (allowedRemoved.includes(object.id)) continue;
    const actual = after.rich.objectData?.find((o) => o.id === object.id);
    if (!actual || actual.mergeable !== object.mergeable || actual.view !== object.view)
      throw new Error("Existing native object content or presentation changed");
  }
  if (!options.tagChange && before.rich.styleRuns && after.rich.styleRuns) {
    const end = before.rich.text.trimEnd().length;
    for (const oldRun of before.rich.styleRuns)
      for (const newRun of after.rich.styleRuns) {
        const overlapStart = Math.max(oldRun.start, newRun.start);
        const overlapEnd = Math.min(
          end,
          oldRun.start + oldRun.length,
          newRun.start + newRun.length
        );
        if (
          overlapStart < overlapEnd &&
          /[^\s\ufffc]/u.test(before.rich.text.slice(overlapStart, overlapEnd)) &&
          oldRun.signature !== newRun.signature
        )
          throw new Error("Existing rich formatting changed");
      }
  }
}

/** Describe a failed or stalled bridge run for an uncertain-outcome message. */
function describeTransportFailure(error: unknown): string {
  const detail = error as {
    code?: string;
    stderr?: string | Buffer;
    message?: string;
    shortcut?: string;
  };
  // Name the bridge, so an unapproved or missing Shortcut is identified by the
  // exact string Shortcuts.app shows rather than guessed at (#164).
  const named = detail?.shortcut ? `the "${detail.shortcut}" Shortcut` : "the background Shortcut";
  // A timeout is how an unanswered first-run consent prompt presents: the
  // headless run cannot show it, so it waits out the transport timeout (#172).
  return detail?.code === "ETIMEDOUT"
    ? `Shortcuts timed out waiting for ${named}. ${shortcutConsentHint(detail.shortcut)}`
    : `${named} failed: ${String(detail?.stderr || detail?.message || "no output")
        .trim()
        .slice(0, 400)}`;
}

/** Run one guarded native mutation and verify its outcome by exact-ID readback. */
export function mutateBackground(
  request: BackgroundInput,
  operation: BackgroundOperation,
  data: Record<string, string>,
  verify: (before: BackgroundSnapshot, after: BackgroundSnapshot) => void,
  deps: BackgroundDependencies
) {
  if (
    request.scopeText.length < 12 ||
    request.scopeText.length > 500 ||
    /[\r\n\0]/u.test(request.scopeText)
  )
    throw new Error("Use a distinctive existing single-line scope of 12–500 characters");
  const before = deps.read(request.id);
  if (before.hash !== request.expectedContentHash)
    throw new Error("Note revision changed; read it again");
  if (!before.rich.text.includes(request.scopeText))
    throw new Error("Scope is absent from exact note");
  const candidates = deps.candidates(before.title, request.scopeText);
  if (candidates.length !== 1 || candidates[0] !== request.id)
    throw new Error("Ambiguous note selection; nothing changed");
  if (deps.read(request.id).hash !== before.hash)
    throw new Error("Note revision changed during preflight");
  let transportUncertain = false;
  let transportMessage = "";
  try {
    deps.run({ ...data, operation, title: before.title, scopeText: request.scopeText });
  } catch (error) {
    transportUncertain = true;
    transportMessage = describeTransportFailure(error);
  }
  const after = deps.read(request.id);
  try {
    verify(before, after);
  } catch (error) {
    throw new Error(
      `Operation outcome uncertain; read exact note before any retry: ${error instanceof Error ? error.message : "readback failed"}${transportMessage ? "; " + transportMessage : ""}`
    );
  }
  return {
    ok: true,
    id: request.id,
    previousContentHash: before.hash,
    contentHash: after.hash,
    ...(transportUncertain
      ? {
          transportWarning:
            "Transport was uncertain; exact-ID readback verified the requested result",
        }
      : {}),
  };
}

/** Verify every link requested in appended HTML appears after existing links. */
export function assertAppendedHtmlLinks(
  previousCount: number,
  links: Array<{ text: string; url: string }>,
  html: string
) {
  const remaining = links.slice(previousCount);
  for (const expected of htmlLinks(html)) {
    // htmlLinks omits layout whitespace; native ranges retain it. Compare using
    // the same character-to-URL signature as normal guarded HTML writes.
    const index = remaining.findIndex(
      (link) => linkSignature([link]) === linkSignature([expected])
    );
    if (index < 0) throw new Error("Appended HTML link not verified");
    remaining.splice(index, 1);
  }
}

/** Verify that an append retained the old body and added the expected visible text. */
export function assertAppendedVisibleText(beforeHtml: string, afterHtml: string, expected: string) {
  const before = comparableVisibleText(beforeHtml);
  const after = comparableVisibleText(afterHtml);
  if (!after.startsWith(before)) throw new Error("Appended text not verified");
  const suffix = after.slice(before.length).replace(/\s+/gu, " ").trim();
  const wanted = expected.replace(/\s+/gu, " ").trim();
  if (!suffix || !suffix.includes(wanted)) throw new Error("Appended text not verified");
}

/** Append plaintext, bounded Markdown, or semantic HTML through the native bridge. */
export function appendNative(
  manager: AppleNotesManager,
  request: BackgroundInput & { content: string; format: "plaintext" | "html" | "markdown" }
): ReturnType<typeof mutateBackground> {
  validateAppendContent(request.content, request.format);
  if (request.format === "html" && /<table\b/i.test(request.content))
    throw new Error("Use create-table for verified native table insertion");
  // Markdown is sent to the bridge's dedicated "append-markdown" branch, which
  // runs Shortcuts' native Markdown-to-rich-text action, instead of being
  // converted to our own HTML subset and routed through "append-html" first.
  // Notes' HTML importer (the "append-html" path) only distinguishes two
  // heading levels and silently renders `<h3>` the same as `<h2>` — Heading,
  // not Subheading — while its Markdown importer preserves all three (#172).
  // appendMarkdownHtml() is still run for its validation of the bounded
  // Markdown subset and to compute the expected visible text/links for
  // readback verification; its HTML is no longer sent to Notes.
  const markdownHtml = request.format === "markdown" ? appendMarkdownHtml(request.content) : null;
  const op =
    request.format === "plaintext"
      ? "append-text"
      : request.format === "markdown"
        ? "append-markdown"
        : "append-html";
  const text =
    request.format === "html" ? "<div><br></div>" + request.content : "\n\n" + request.content;
  return mutateBackground(
    request,
    op,
    { text },
    (before, after) => {
      assertPreserved(before, after, { append: true });
      const verifyHtml = markdownHtml ?? request.content;
      const expected =
        request.format === "plaintext" ? request.content : comparableVisibleText(verifyHtml);
      if (expected) assertAppendedVisibleText(before.html, after.html, expected);
      if (request.format === "html" || request.format === "markdown")
        assertAppendedHtmlLinks(before.rich.links.length, after.rich.links, verifyHtml);
    },
    backgroundDependencies(manager)
  );
}

/** Add or remove one native tag while preserving unrelated note objects. */
export function setNativeTag(
  manager: AppleNotesManager,
  request: BackgroundInput & { tag: string; present: boolean }
) {
  const tag = normalizeNativeTags([request.tag])[0];
  const initial = readBackgroundSnapshot(manager, request.id);
  if (initial.hash !== request.expectedContentHash)
    throw new Error("Note revision changed; read it again");
  if (initial.rich.nativeTags.includes(tag) === request.present)
    return { ok: true, id: request.id, contentHash: initial.hash, changed: false };
  const deps = backgroundDependencies(manager);
  // Keep additions on the independently verified Native Tags bridge. Its
  // Repeat Item binding works with Create Tag on this macOS; the generic
  // background bridge's Action Output binding did not pass live creation.
  if (request.present)
    deps.run = ({ title, scopeText }) => runNativeTagsShortcut({ title, scopeText, tags: [tag] });
  return mutateBackground(
    request,
    request.present ? "add-tag" : "remove-tag",
    { tag },
    (before, after) => {
      assertPreserved(before, after, { tagChange: tag });
      if (after.rich.nativeTags.includes(tag) !== request.present)
        throw new Error("Native tag state not verified");
      // Other native objects must be retained; only this tag's attachment may disappear.
      const removed = before.rich.nativeObjectIds.filter(
        (id) => !after.rich.nativeObjectIds.includes(id)
      );
      const allowed = request.present ? [] : before.rich.nativeTagObjectIds?.[tag] || [];
      if (removed.some((id) => !allowed.includes(id)))
        throw new Error("Unrelated native object was lost");
    },
    deps
  );
}

/** Backslash-escape ASCII punctuation so Notes' Markdown importer keeps the text literal. */
const literalMarkdown = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, "\\$&");

/** Non-empty heading levels in document order. Notes follows each heading with an empty one. */
export function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .filter((match) => comparableVisibleText(match[2]))
    .map((match) => Number(match[1]));
}

/** Type identifier Notes stores for a native divider line. */
export const DIVIDER_UTI = "com.apple.notes.inlinetextattachment.dividerline";

/**
 * Verify, by readback, that Notes' Markdown importer produced every native block
 * construct the Markdown asked for, and no stray one: block-quote text, monospaced
 * code text, checklist items with their done state, divider count, and
 * highlighted inline-code text. Text is compared with whitespace collapsed.
 */
export function assertMarkdownBlocks(rich: RichNote, expected: MarkdownBlockExpectations) {
  const tidy = (s: string) => s.replace(/[\s￼]+/gu, " ").trim();
  const runs = rich.styleRuns || [];
  const styledText = (matches: (run: (typeof runs)[number]) => boolean) => {
    let out = "",
      previous = false;
    for (const run of runs) {
      const hit = matches(run);
      if (hit) out += (previous ? "" : " ") + rich.text.slice(run.start, run.start + run.length);
      previous = hit;
    }
    return tidy(out);
  };
  if (styledText((run) => run.blockQuote === true) !== tidy(expected.quotes.join(" ")))
    throw new Error("Block quotes not verified");
  if (styledText((run) => run.paragraphStyle === 4) !== tidy(expected.code.join(" ")))
    throw new Error("Monospaced code blocks not verified");
  if (styledText((run) => run.highlight === true) !== tidy(expected.highlights.join(" ")))
    throw new Error("Inline code highlights not verified");
  const items = (rich.checklistItems || []).map((item) => ({
    text: tidy(item.text),
    done: item.done,
  }));
  const wanted = expected.checklist.map((item) => ({ text: tidy(item.text), done: item.done }));
  if (JSON.stringify(items) !== JSON.stringify(wanted))
    throw new Error("Checklist items or their done state not verified");
  if ((rich.objects || []).filter((o) => o.type === DIVIDER_UTI).length !== expected.dividers)
    throw new Error("Dividers not verified");
}

export interface MarkdownNoteRequest {
  title: string;
  content: string;
  folder?: string;
}

/**
 * Create a note from bounded Markdown with Notes' own importer, so `#`/`##`/`###`
 * become real Title/Heading/Subheading styles with no seed line (#172).
 *
 * The bridge always creates in the iCloud account's default folder, the only
 * place Notes interprets Markdown, and returns no usable identity. The new note
 * is the one note added to the accounts' default folders during the run whose
 * exact-ID readback verifies; only then is it moved to the requested folder.
 */
export function createMarkdownNote(
  manager: AppleNotesManager,
  request: MarkdownNoteRequest,
  run: (
    input: Record<string, string>,
    status: ReturnType<typeof nativeTagsStatus>
  ) => void = runBackgroundShortcut
) {
  if (/[\r\n\0]/u.test(request.title)) throw new Error("A Markdown note title must be one line");
  validateAppendContent(request.content, "markdown", { blocks: true });
  const { html: bodyHtml, expect: blockExpectations } = renderMarkdown(request.content, {
    blocks: true,
  });
  const checkBlocks = usesMarkdownBlocks(request.content);
  if (request.folder) buildFolderReference(request.folder);
  const expectedText = `${request.title} ${comparableVisibleText(bodyHtml)}`
    .replace(/\s+/gu, " ")
    .trim();
  const expectedLevels = [1, ...headingLevels(bodyHtml)].join();
  const status = markdownNoteStatus();
  if (!status.installed)
    throw new Error(
      `Install the supplied "${status.shortcut}" Shortcut once; Shortcuts must list it exactly once`
    );
  // Compare parsed folder segments case-insensitively, as AppleScript does.
  const segments = (path: string) =>
    JSON.stringify(splitFolderPath(path).map((part) => part.toLocaleLowerCase()));
  if (request.folder) {
    // moveNoteById needs an existing folder, so check before the bridge creates
    // anything.
    const wanted = segments(request.folder);
    const accounts = manager.listAccounts().filter((account) => account.defaultFolder);
    if (
      !accounts.some((account) =>
        manager.listFolders(account.name).some((folder) => segments(folder.name) === wanted)
      )
    )
      throw new Error(
        `Folder "${request.folder}" does not exist; create it with create-folder first. Nothing was created`
      );
    // The bridge creates before it moves, so refuse a smart folder now, while
    // nothing exists yet, rather than at the move.
    for (const account of accounts)
      manager.assertNotSmartFolderDestination(request.folder, account.name);
  }
  const defaultFolderNotes = () =>
    new Map(
      manager
        .listAccounts()
        .flatMap((account) =>
          account.defaultFolder
            ? manager
                .listNoteRefs(account.name, account.defaultFolder)
                .map((note) => [note.id, account.name] as const)
            : []
        )
    );
  const before = defaultFolderNotes();
  let transportMessage = "";
  try {
    run(
      {
        operation: "create-markdown",
        text: `# ${literalMarkdown(request.title)}\n\n${request.content}`,
      },
      status
    );
  } catch (error) {
    transportMessage = describeTransportFailure(error);
  }
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // From here a note may exist, so every failure names the candidates (or says
  // to search) instead of surfacing a bare error that invites a duplicate retry.
  let candidates: string[] = [];
  try {
    const created = [...defaultFolderNotes()].filter(([noteId]) => !before.has(noteId));
    candidates = created.map(([noteId]) => noteId);
    const failures: string[] = [];
    const verified = created.flatMap(([noteId, account]) => {
      try {
        const note = readBackgroundSnapshot(manager, noteId);
        if (note.rich.text.replace(/[\s\ufffc]+/gu, " ").trim() !== expectedText)
          throw new Error("Note text not verified");
        if (headingLevels(note.html).join() !== expectedLevels)
          throw new Error("Heading styles not verified");
        assertAppendedHtmlLinks(0, note.rich.links, bodyHtml);
        if (checkBlocks) assertMarkdownBlocks(note.rich, blockExpectations);
        return [{ id: noteId, account, note }];
      } catch (error) {
        failures.push(`${noteId}: ${reason(error)}`);
        return [];
      }
    });
    if (verified.length !== 1)
      throw new Error(
        verified.length
          ? `${verified.length} matching notes appeared (${verified.map((v) => v.id).join(", ")})`
          : created.length
            ? `no new note verified (${failures.join("; ")})`
            : "no new note was found in the default folder"
      );
    const { id, account } = verified[0];
    candidates = [id];
    let { note } = verified[0];
    if (request.folder) {
      // The pre-check accepts a folder from any account, but the note always
      // lands in one account and moves within it, so name that mismatch rather
      // than reporting a generic move failure.
      const wanted = segments(request.folder);
      if (!manager.listFolders(account).some((folder) => segments(folder.name) === wanted))
        throw new Error(
          `created and verified in the ${account} default folder, but folder "${request.folder}" does not exist in ${account}; create it there, then use move-note with id ${id} instead of creating the note again`
        );
      if (!manager.moveNoteById(id, request.folder, account))
        throw new Error(
          `created and verified in the ${account} default folder, but not moved to "${request.folder}"; use move-note instead of creating it again`
        );
      note = readBackgroundSnapshot(manager, id);
    }
    return {
      ok: true,
      id,
      title: request.title,
      folder: request.folder,
      account,
      contentHash: note.hash,
      verified: true,
      ...(transportMessage
        ? {
            transportWarning:
              "Transport was uncertain; exact-ID readback verified the requested result",
          }
        : {}),
    };
  } catch (error) {
    throw new Error(
      `Operation outcome uncertain; ${candidates.length ? `read ${candidates.length === 1 ? "note" : "notes"} ${candidates.join(", ")}` : "search for the title"} before any retry: ${reason(error)}${transportMessage ? `; ${transportMessage}` : ""}`
    );
  }
}
