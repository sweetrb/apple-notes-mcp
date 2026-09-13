import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleNotesManager } from "./appleNotesManager.js";
import { nativeTagsStatus, normalizeNativeTags, runNativeTagsShortcut } from "./nativeTags.js";
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
import { appendMarkdownHtml } from "../utils/appendMarkdown.js";
import { comparableVisibleText } from "../utils/noteRevision.js";

export const BACKGROUND_SHORTCUT = "Apple Notes MCP - Background Operations v5";
/** Report whether the configured background-operations bridge is installed uniquely. */
export const backgroundStatus = () =>
  nativeTagsStatus(process.env.APPLE_NOTES_MCP_BACKGROUND_SHORTCUT || BACKGROUND_SHORTCUT);
/** Report whether the dedicated native-tag bridge is installed uniquely. */
export const nativeTagBridgeStatus = () => nativeTagsStatus();
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

/** Validate imported rich text conservatively. No external image fetching or embedded code. */
export function validateAppendContent(content: string, format: "plaintext" | "html" | "markdown") {
  if (!content || content.length > 1024 * 1024 || content.includes("\0"))
    throw new Error("Invalid append content (limit 1 MiB)");
  if (format === "html") {
    const allowed = new Set([
      "div",
      "p",
      "br",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "del",
      "h1",
      "h2",
      "h3",
      "ul",
      "ol",
      "li",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
    ]);
    for (const tag of content.matchAll(/<\/?\s*([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
      if (!allowed.has(tag[1].toLowerCase()))
        throw new Error(`Unsupported HTML element: ${tag[1]}`);
      let attrs = tag[2].replace(/\/$/, "").trim();
      if (tag[1].toLowerCase() === "a")
        attrs = attrs.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (_s, _q: string, url: string) => {
          if (
            !/^(https?:\/\/|notes:\/\/|applenotes:|mailto:)/i.test(url) ||
            Array.from(url).some((c) => c.charCodeAt(0) < 33)
          )
            throw new Error("Unsupported link URL");
          return "";
        });
      if (attrs.trim())
        throw new Error(
          "Unsupported HTML attributes; use semantic formatting and explicit blank paragraphs"
        );
    }
    if (/<!--|<!|<\?|<[^>]*$/u.test(content)) throw new Error("Unsupported HTML markup");
  }
  if (format === "markdown" && /!\[|<\/?[a-z]|\]\(\s*(?:javascript|data|file):/i.test(content))
    throw new Error("Markdown images, raw HTML and local/executable links are unsupported");
}

/** Invoke the installed background bridge with a private temporary JSON request. */
export function runBackgroundShortcut(input: Record<string, string>) {
  const status = backgroundStatus();
  if (!status.installed)
    throw new Error("Install the supplied Background Operations shortcut once");
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
    execFileSync("/usr/bin/shortcuts", ["run", status.identifier!, "--input-path", file], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const detail = error as { code?: string; stderr?: string | Buffer; message?: string };
    transportMessage =
      detail?.code === "ETIMEDOUT"
        ? "Shortcuts timed out; check for an interactive parameter or permission request"
        : String(detail?.stderr || detail?.message || "Shortcuts failed")
            .trim()
            .slice(0, 500);
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
  if (request.format === "markdown")
    return appendNative(manager, {
      ...request,
      content: appendMarkdownHtml(request.content),
      format: "html",
    });
  if (request.format === "html" && /<table\b/i.test(request.content))
    throw new Error("Use create-table for verified native table insertion");
  const op =
    request.format === "plaintext"
      ? "append-text"
      : request.format === "html"
        ? "append-html"
        : "append-markdown";
  const text =
    request.format === "html" ? "<div><br></div>" + request.content : "\n\n" + request.content;
  return mutateBackground(
    request,
    op,
    { text },
    (before, after) => {
      assertPreserved(before, after, { append: true });
      const expected =
        request.format === "html"
          ? comparableVisibleText(request.content)
          : request.format === "plaintext"
            ? request.content
            : null;
      if (expected) assertAppendedVisibleText(before.html, after.html, expected);
      if (request.format === "html")
        assertAppendedHtmlLinks(before.rich.links.length, after.rich.links, request.content);
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
