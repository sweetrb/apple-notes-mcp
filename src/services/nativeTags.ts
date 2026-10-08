import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RichNote } from "../utils/noteRichText.js";
import { shortcutConsentHint } from "./shortcutConsent.js";
import { CodedError } from "../utils/errorCodes.js";

export const NATIVE_TAGS_SHORTCUT = "Apple Notes MCP - Native Tags";

/** Normalize, validate, and deduplicate native tag names supplied by a client. */
export function normalizeNativeTags(tags: string[]): string[] {
  if (!tags.length || tags.length > 100) throw new Error("Provide between 1 and 100 tags");
  return [
    ...new Set(
      tags.map((value) => {
        const tag = value.normalize("NFC").replace(/^#/, "");
        if (tag.length > 100 || !/^(?=.*\p{L})[\p{L}\p{N}_-]+$/u.test(tag))
          throw new Error(
            "Tags must contain a letter and only letters, digits, hyphens or underscores"
          );
        return tag;
      })
    ),
  ];
}

export interface NativeTagRequest {
  id: string;
  expectedContentHash: string;
  title: string;
  scopeText: string;
  tags: string[];
}

export interface NativeTagSnapshot {
  contentHash: string;
  title: string;
  plaintext: string;
  rich: RichNote;
}

export interface NativeTagDependencies {
  read: (id: string) => NativeTagSnapshot;
  candidates: (title: string, scopeText: string) => string[];
  run: (input: { title: string; scopeText: string; tags: string[] }) => void;
}

const TAG_OBJECT_TYPE = "com.apple.notes.inlinetextattachment.hashtag";
type PreservedSpan = { before: number; after: number; length: number };

/** Refuse a write when the decoder cannot account for every native range and style. */
function requirePreservationMetadata(rich: RichNote) {
  const unavailable = () => {
    throw new Error("Native object, checklist or formatting preservation metadata is unavailable");
  };
  const { objects, objectData, checklistItems, styleRuns, nativeTagObjectIds } = rich;
  if (
    !objects ||
    !objectData ||
    !checklistItems ||
    !styleRuns ||
    !nativeTagObjectIds ||
    rich.nativeObjectDataComplete !== true
  )
    return unavailable();
  const ids = new Set(rich.nativeObjectIds);
  if (
    ids.size !== rich.nativeObjectIds.length ||
    objects.length !== ids.size ||
    objectData.length !== ids.size ||
    new Set(objects.map((o) => o.id)).size !== ids.size ||
    new Set(objectData.map((o) => o.id)).size !== ids.size ||
    rich.hasNativeObjects !== Boolean(ids.size) ||
    rich.hasChecklist !== Boolean(checklistItems.length)
  )
    return unavailable();
  let objectEnd = 0;
  for (const object of objects) {
    const data = objectData.find((row) => row.id === object.id);
    if (
      !ids.has(object.id) ||
      !Number.isInteger(object.start) ||
      !Number.isInteger(object.length) ||
      object.start < objectEnd ||
      object.length < 1 ||
      object.start + object.length > rich.text.length ||
      !data ||
      data.type !== object.type ||
      !Number.isInteger(data.pk) ||
      !/^[0-9a-f]*$/iu.test(data.mergeable) ||
      (data.view !== null && !Number.isInteger(data.view)) ||
      !Object.hasOwn(data, "altText") ||
      (data.altText !== null && typeof data.altText !== "string")
    )
      return unavailable();
    objectEnd = object.start + object.length;
  }
  const mappedIds = new Set<string>();
  if (
    new Set(rich.nativeTags).size !== rich.nativeTags.length ||
    Object.keys(nativeTagObjectIds).length !== rich.nativeTags.length
  )
    return unavailable();
  for (const [tag, tagIds] of Object.entries(nativeTagObjectIds)) {
    if (!rich.nativeTags.includes(tag) || !tagIds.length) return unavailable();
    for (const id of tagIds) {
      if (
        mappedIds.has(id) ||
        !objects.some((o) => o.id === id && o.type === TAG_OBJECT_TYPE) ||
        objectData.find((o) => o.id === id)?.altText?.replace(/^#/, "") !== tag
      )
        return unavailable();
      mappedIds.add(id);
    }
  }
  if (objects.some((o) => o.type === TAG_OBJECT_TYPE && !mappedIds.has(o.id))) return unavailable();
  if (new Set(checklistItems.map((item) => item.id)).size !== checklistItems.length)
    return unavailable();
  for (const item of checklistItems) {
    const end = item.start + item.text.length;
    if (
      !item.id ||
      !Number.isInteger(item.start) ||
      item.start < 0 ||
      end > rich.text.length ||
      rich.text.slice(item.start, end) !== item.text ||
      (end < rich.text.length && rich.text[end] !== "\n")
    )
      return unavailable();
  }
  let position = 0;
  for (const run of styleRuns) {
    if (
      run.start !== position ||
      !Number.isInteger(run.length) ||
      run.length < 0 ||
      typeof run.signature !== "string" ||
      run.nativeSemantics?.complete !== true ||
      (run.length === 0 &&
        (run.nativeSemantics.unknown ||
          run.nativeSemantics.structuredParagraph ||
          run.nativeSemantics.links ||
          run.nativeSemantics.objects.length > 0))
    )
      return unavailable();
    position += run.length;
  }
  if (position !== rich.text.length) return unavailable();
  for (const link of rich.links)
    if (
      !Number.isInteger(link.start) ||
      !Number.isInteger(link.length) ||
      link.start < 0 ||
      link.length < 1 ||
      link.start + link.length > rich.text.length ||
      rich.text.slice(link.start, link.start + link.length) !== link.text
    )
      return unavailable();
}

/** Converted literals may carry visual styles, but no other native semantics. */
function plainNativeRange(rich: RichNote, start: number, length: number) {
  return rich.styleRuns!.every((run) => {
    if (run.start >= start + length || run.start + run.length <= start) return true;
    const metadata = run.nativeSemantics!;
    return (
      metadata.complete &&
      !metadata.unknown &&
      !metadata.structuredParagraph &&
      !metadata.links &&
      !metadata.objects.length
    );
  });
}

/** Align exact original text around only proven new tag conversions or end-appends. */
function preservedTextSpans(before: RichNote, after: RichNote, missing: string[]) {
  const oldIds = new Set(before.nativeObjectIds);
  const added = after.objects!.filter((o) => !oldIds.has(o.id));
  const tagsById = new Map(
    Object.entries(after.nativeTagObjectIds!).flatMap(([tag, ids]) =>
      ids.map((id) => [id, tag] as const)
    )
  );
  if (
    !added.length ||
    added.some((o) => o.type !== TAG_OBJECT_TYPE || !missing.includes(tagsById.get(o.id)!)) ||
    missing.some((tag) => !added.some((o) => tagsById.get(o.id) === tag))
  )
    return undefined;
  const spans: PreservedSpan[] = [];
  let oldPosition = 0,
    newPosition = 0,
    appended = false;
  for (const object of added) {
    const prefix = after.text.slice(newPosition, object.start);
    const remaining = before.text.slice(oldPosition);
    const length = Math.min(prefix.length, remaining.length);
    if (
      prefix.slice(0, length) !== remaining.slice(0, length) ||
      (prefix.length > length && !/^[ \n]*$/u.test(prefix.slice(length)))
    )
      return undefined;
    if (length) spans.push({ before: oldPosition, after: newPosition, length });
    oldPosition += length;
    const literal = `#${tagsById.get(object.id)!}`;
    const rendered = after.text.slice(object.start, object.start + object.length);
    if (rendered !== "\ufffc" && rendered !== literal) return undefined;
    const previous = [...before.text.slice(Math.max(0, oldPosition - 2), oldPosition)].at(-1) || "";
    const next = String.fromCodePoint(before.text.codePointAt(oldPosition + literal.length) ?? 0);
    if (oldPosition === before.text.length) appended = true;
    else if (
      before.text.startsWith(literal, oldPosition) &&
      !/[\p{L}\p{M}\p{N}_#-]/u.test(previous) &&
      !/[\p{L}\p{M}\p{N}_-]/u.test(next) &&
      plainNativeRange(before, oldPosition, literal.length)
    )
      oldPosition += literal.length;
    else return undefined;
    newPosition = object.start + object.length;
  }
  const remaining = before.text.slice(oldPosition);
  const suffix = after.text.slice(newPosition);
  if (suffix !== remaining && !(appended && !remaining && /^[ \n]*$/u.test(suffix)))
    return undefined;
  if (remaining.length)
    spans.push({ before: oldPosition, after: newPosition, length: remaining.length });
  return spans;
}

/** Every changed range is either one proven new tag attachment or a plain separator. */
function preservesAddedSemantics(before: RichNote, after: RichNote, spans: PreservedSpan[]) {
  const oldIds = new Set(before.nativeObjectIds);
  const added = after.objects!.filter((o) => !oldIds.has(o.id));
  const changed: Array<{ start: number; end: number }> = [];
  let end = 0;
  for (const span of spans) {
    if (end < span.after) changed.push({ start: end, end: span.after });
    end = span.after + span.length;
  }
  if (end < after.text.length) changed.push({ start: end, end: after.text.length });
  for (const run of after.styleRuns!) {
    if (!changed.some((range) => run.start < range.end && run.start + run.length > range.start))
      continue;
    const metadata = run.nativeSemantics!;
    if (!metadata.complete || metadata.unknown || metadata.structuredParagraph || metadata.links)
      return false;
    const object = added.find((o) => run.start === o.start && run.length === o.length);
    if (object) {
      if (
        metadata.objects.length !== 1 ||
        metadata.objects[0].id !== object.id ||
        metadata.objects[0].type !== object.type
      )
        return false;
    } else if (
      metadata.objects.length ||
      added.some((o) => run.start < o.start + o.length && run.start + run.length > o.start)
    )
      return false;
  }
  return true;
}

/** Check exact native data, checklist/link ranges and formatting through retained text spans. */
function preservesNativeContent(before: RichNote, after: RichNote, spans: PreservedSpan[]) {
  const rangeStart = (start: number, length: number) => {
    const span = spans.find((s) => start >= s.before && start + length <= s.before + s.length);
    return span && span.after + start - span.before;
  };
  for (const object of before.objects!) {
    const actual = after.objects!.find((o) => o.id === object.id);
    if (
      !actual ||
      actual.type !== object.type ||
      actual.length !== object.length ||
      actual.start !== rangeStart(object.start, object.length)
    )
      return false;
  }
  for (const object of before.objectData!) {
    const actual = after.objectData!.find((o) => o.id === object.id);
    if (
      !actual ||
      actual.pk !== object.pk ||
      actual.type !== object.type ||
      actual.mergeable !== object.mergeable ||
      actual.view !== object.view ||
      actual.altText !== object.altText
    )
      return false;
  }
  for (const tag of before.nativeTags)
    if (
      JSON.stringify(before.nativeTagObjectIds![tag]) !==
      JSON.stringify(after.nativeTagObjectIds![tag])
    )
      return false;
  if (before.checklistItems!.length !== after.checklistItems!.length) return false;
  for (const [index, item] of before.checklistItems!.entries()) {
    const actual = after.checklistItems![index];
    if (
      actual.id !== item.id ||
      actual.text !== item.text ||
      actual.done !== item.done ||
      actual.start !== rangeStart(item.start, item.text.length)
    )
      return false;
  }
  if (before.links.length !== after.links.length) return false;
  for (const [index, link] of before.links.entries()) {
    const actual = after.links[index];
    if (
      actual.text !== link.text ||
      actual.url !== link.url ||
      actual.length !== link.length ||
      actual.start !== rangeStart(link.start, link.length)
    )
      return false;
  }
  let oldIndex = 0,
    newIndex = 0;
  for (const span of spans) {
    let offset = 0;
    while (offset < span.length) {
      const oldPosition = span.before + offset,
        newPosition = span.after + offset;
      while (before.styleRuns![oldIndex].start + before.styleRuns![oldIndex].length <= oldPosition)
        oldIndex++;
      while (after.styleRuns![newIndex].start + after.styleRuns![newIndex].length <= newPosition)
        newIndex++;
      const oldRun = before.styleRuns![oldIndex],
        newRun = after.styleRuns![newIndex];
      if (
        oldRun.signature !== newRun.signature ||
        oldRun.paragraphStyle !== newRun.paragraphStyle ||
        oldRun.blockQuote !== newRun.blockQuote ||
        oldRun.highlight !== newRun.highlight
      )
        return false;
      offset += Math.min(
        span.length - offset,
        oldRun.start + oldRun.length - oldPosition,
        newRun.start + newRun.length - newPosition
      );
    }
  }
  return true;
}

/** The installed Shortcut repeats the scoped search and refuses non-unique results. */
export function addNativeTags(request: NativeTagRequest, deps: NativeTagDependencies) {
  if (!/^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i.test(request.id))
    throw new Error("An exact CoreData note ID is required");
  if (
    request.scopeText.length < 12 ||
    request.scopeText.length > 500 ||
    /[\r\n\0]/u.test(request.scopeText)
  )
    throw new Error("scopeText must be a stable, single-line project marker of 12–500 characters");
  const tags = normalizeNativeTags(request.tags);
  const before = deps.read(request.id);
  if (before.contentHash !== request.expectedContentHash)
    throw new Error("Note revision changed; read it again");
  if (before.title !== request.title || !before.plaintext.includes(request.scopeText))
    throw new Error("The exact note does not match the title and project marker");
  const missing = tags.filter((tag) => !before.rich.nativeTags.includes(tag));
  if (!missing.length)
    return { nativeTags: before.rich.nativeTags, added: [], contentHash: before.contentHash };
  requirePreservationMetadata(before.rich);
  const candidates = deps.candidates(request.title, request.scopeText);
  if (candidates.length !== 1 || candidates[0] !== request.id)
    throw new Error(
      "Shortcuts selection is ambiguous or points to a different note; nothing was changed"
    );
  const current = deps.read(request.id);
  if (current.contentHash !== request.expectedContentHash)
    throw new Error("Note revision changed during preflight; nothing was changed");
  requirePreservationMetadata(current.rich);
  let transportWarning: string | undefined;
  try {
    deps.run({ title: request.title, scopeText: request.scopeText, tags: missing });
  } catch (error) {
    transportWarning =
      error instanceof Error ? error.message : "Shortcuts completion was uncertain";
  }
  const verificationFailure = (detail?: string) =>
    new CodedError(
      (transportWarning
        ? "Shortcuts did not complete cleanly, and exact-ID tags/text/links/native-content readback was not verified."
        : "Shortcuts ran, but exact-ID tags/text/links/native-content readback was not verified.") +
        " Read the note before any retry." +
        (detail ? ` ${detail}` : "") +
        (transportWarning ? ` ${transportWarning}` : ""),
      { code: "verification_failed", indeterminate: true }
    );
  let after: NativeTagSnapshot;
  try {
    after = deps.read(request.id);
    requirePreservationMetadata(after.rich);
  } catch (error) {
    // A failed read cannot establish that the preceding write did nothing.
    // Override classifications such as revision_conflict or permission_denied.
    throw verificationFailure(error instanceof Error ? error.message : String(error));
  }
  const allTags = [...new Set([...before.rich.nativeTags, ...tags])];
  const spans = preservedTextSpans(before.rich, after.rich, missing);
  if (
    after.title !== before.title ||
    after.rich.nativeTags.length !== allTags.length ||
    allTags.some((tag) => !after.rich.nativeTags.includes(tag)) ||
    before.rich.nativeObjectIds.some((id) => !after.rich.nativeObjectIds.includes(id)) ||
    before.rich.hasChecklist !== after.rich.hasChecklist ||
    !spans ||
    !preservesAddedSemantics(before.rich, after.rich, spans) ||
    !preservesNativeContent(before.rich, after.rich, spans)
  ) {
    // Keep the transport diagnosis: it names the Shortcut and the first-run
    // consent fix, and used to be dropped right when it mattered (#172).
    throw verificationFailure();
  }
  return {
    nativeTags: after.rich.nativeTags,
    added: missing,
    contentHash: after.contentHash,
    ...(transportWarning
      ? {
          transportWarning:
            "Shortcuts completion was uncertain, but all requested native tags and preserved content were verified by exact ID.",
        }
      : {}),
  };
}

/** List installed Shortcuts as `Name (UUID)` lines. Read-only; never runs a Shortcut. */
export function listInstalledShortcuts(): string[] {
  return execFileSync("/usr/bin/shortcuts", ["list", "--show-identifiers"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).split(/\r?\n/u);
}

/** The configured Native Tags bridge name (env override or default). */
export const nativeTagsShortcutName = () =>
  process.env.APPLE_NOTES_MCP_TAGS_SHORTCUT || NATIVE_TAGS_SHORTCUT;

/** Resolve exactly one installed Native Tags Shortcut by name or UUID. */
export function nativeTagsStatus(shortcut = nativeTagsShortcutName()) {
  return resolveShortcut(listInstalledShortcuts(), shortcut);
}

/**
 * Resolve one Shortcut by exact name or UUID against `shortcuts list
 * --show-identifiers` output. Installed means exactly one match.
 */
export function resolveShortcut(lines: string[], shortcut: string) {
  const matches = lines.flatMap((line) => {
    const match = /^(.*) \(([0-9A-Fa-f-]{36})\)$/.exec(line);
    return match && (match[1] === shortcut || match[2].toLowerCase() === shortcut.toLowerCase())
      ? [{ name: match[1], identifier: match[2] }]
      : [];
  });
  return {
    shortcut,
    installed: matches.length === 1,
    identifier: matches.length === 1 ? matches[0].identifier : undefined,
  };
}

/** Invoke the installed Native Tags bridge with a private temporary request. */
export function runNativeTagsShortcut(input: { title: string; scopeText: string; tags: string[] }) {
  const status = nativeTagsStatus();
  if (!status.installed)
    throw new Error(`Import the supplied ${status.shortcut}.shortcut in Shortcuts first`);
  const directory = mkdtempSync(join(tmpdir(), "apple-notes-native-tags-"));
  try {
    const path = join(directory, "request.json");
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
    execFileSync("/usr/bin/shortcuts", ["run", status.identifier!, "--input-path", path], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // CLI output may be empty even after the Notes actions complete. Success is
    // established by the caller's exact-ID native metadata/content readback.
  } catch (error) {
    // Carry the name and timeout code out, as runBackgroundShortcut does, so
    // replace-native-tag's add phase (via mutateBackground) names this bridge.
    throw Object.assign(
      new Error(
        `Native tag operation did not complete cleanly. ${shortcutConsentHint(status.shortcut)} Do not retry automatically; read the exact note first`
      ),
      { shortcut: status.shortcut, code: (error as { code?: string } | null)?.code }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
