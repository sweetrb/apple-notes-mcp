import type { RichNote } from "./noteRichText.js";

const TAG_OBJECT_TYPE = "com.apple.notes.inlinetextattachment.hashtag";

/** Refuse a write when the decoder cannot account for every native range and style. */
export function requirePreservationMetadata(rich: RichNote) {
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

export type PreservedSpan = { before: number; after: number; length: number };
export type RetainedContentChange =
  { kind: "unchanged" } | { kind: "append" } | { kind: "remove-tag"; tag: string };

/** Empty runs still carry stored formatting; compare them at projected retained boundaries. */
export function assertZeroLengthFormatting(
  before: RichNote,
  after: RichNote,
  spans: PreservedSpan[]
) {
  const oldEmpty = before
    .styleRuns!.filter((run) => run.length === 0)
    .map((run) => {
      const span = spans.find(
        (span) => run.start >= span.before && run.start <= span.before + span.length
      );
      if (!span) throw new Error("Zero-length formatting falls inside the requested removal");
      return { ...run, start: span.after + run.start - span.before };
    });
  const newEmpty = after.styleRuns!.filter(
    (run) =>
      run.length === 0 &&
      spans.some((span) => run.start >= span.after && run.start <= span.after + span.length)
  );
  if (JSON.stringify(oldEmpty) !== JSON.stringify(newEmpty))
    throw new Error("Existing zero-length formatting metadata changed");
}

/** Project the original body through only the requested native tag's exact ranges. */
function retainedSpans(before: RichNote, after: RichNote, change: RetainedContentChange) {
  if (change.kind !== "remove-tag") {
    if (change.kind === "append" ? !after.text.startsWith(before.text) : after.text !== before.text)
      throw new Error("Existing note text or whitespace was not preserved");
    return {
      spans: [{ before: 0, after: 0, length: before.text.length }],
      removed: new Set<string>(),
    };
  }
  const removed = new Set(before.nativeTagObjectIds![change.tag]);
  if (!removed.size || after.nativeTags.includes(change.tag))
    throw new Error("Native tag removal was not verified");
  const spans: PreservedSpan[] = [];
  let position = 0,
    output = "";
  for (const object of before.objects!.filter((object) => removed.has(object.id))) {
    const text = before.text.slice(object.start, object.start + object.length);
    if (text !== "\ufffc" && text !== `#${change.tag}`)
      throw new Error("Native tag removal range is unsupported");
    const prefix = before.text.slice(position, object.start);
    spans.push({ before: position, after: output.length, length: prefix.length });
    output += prefix;
    position = object.start + object.length;
  }
  spans.push({ before: position, after: output.length, length: before.text.length - position });
  output += before.text.slice(position);
  if (after.text !== output)
    throw new Error("Existing note text or whitespace was not preserved around the removed tag");
  return { spans, removed };
}

/** Preserve every original UTF-16 range; end-appends and exact native tag removal are explicit. */
export function assertRetainedRichContent(
  before: RichNote,
  after: RichNote,
  change: RetainedContentChange = { kind: "unchanged" }
) {
  requirePreservationMetadata(before);
  requirePreservationMetadata(after);
  const { spans, removed } = retainedSpans(before, after, change);
  const rangeStart = (start: number, length: number) => {
    const span = spans.find(
      (span) => start >= span.before && start + length <= span.before + span.length
    );
    return span && span.after + start - span.before;
  };
  const retainedIds = before.nativeObjectIds.filter((id) => !removed.has(id));
  if (
    retainedIds.some((id) => !after.nativeObjectIds.includes(id)) ||
    [...removed].some((id) => after.nativeObjectIds.includes(id)) ||
    (change.kind !== "append" && after.nativeObjectIds.length !== retainedIds.length) ||
    (change.kind === "append" &&
      after.objects!.some(
        (object) => !retainedIds.includes(object.id) && object.start < before.text.length
      ))
  )
    throw new Error("Existing native object identity or placement changed");
  for (const object of before.objects!.filter((object) => !removed.has(object.id))) {
    const actual = after.objects!.find((current) => current.id === object.id)!;
    if (
      actual.type !== object.type ||
      actual.length !== object.length ||
      actual.start !== rangeStart(object.start, object.length)
    )
      throw new Error("Existing native object range changed");
    const oldData = before.objectData!.find((row) => row.id === object.id)!,
      newData = after.objectData!.find((row) => row.id === object.id)!;
    if (
      oldData.pk !== newData.pk ||
      oldData.type !== newData.type ||
      oldData.mergeable !== newData.mergeable ||
      oldData.view !== newData.view ||
      oldData.altText !== newData.altText
    )
      throw new Error("Existing native object payload changed");
  }
  const tags = before.nativeTags.filter(
    (tag) => change.kind !== "remove-tag" || tag !== change.tag
  );
  if (
    tags.some(
      (tag) =>
        JSON.stringify(before.nativeTagObjectIds![tag]) !==
        JSON.stringify(after.nativeTagObjectIds![tag])
    ) ||
    (change.kind !== "append" && after.nativeTags.length !== tags.length)
  )
    throw new Error("Existing native tag identities changed");
  const links =
    change.kind === "append"
      ? after.links.filter((link) => link.start < before.text.length)
      : after.links;
  if (
    links.length !== before.links.length ||
    before.links.some((link, index) => {
      const actual = links[index];
      return (
        actual.text !== link.text ||
        actual.url !== link.url ||
        actual.length !== link.length ||
        actual.start !== rangeStart(link.start, link.length)
      );
    })
  )
    throw new Error("Existing links or their ranges were not preserved");
  const items =
    change.kind === "append"
      ? after.checklistItems!.filter((item) => item.start < before.text.length)
      : after.checklistItems!;
  if (
    items.length !== before.checklistItems!.length ||
    before.checklistItems!.some((item, index) => {
      const actual = items[index];
      const retained = spans
        .flatMap((span) => {
          const start = Math.max(item.start, span.before),
            end = Math.min(item.start + item.text.length, span.before + span.length);
          return start < end ? [before.text.slice(start, end)] : [];
        })
        .join("");
      const startSpan = spans.find(
        (span) => item.start >= span.before && item.start <= span.before + span.length
      );
      const start = startSpan && startSpan.after + item.start - startSpan.before;
      return (
        actual.id !== item.id ||
        actual.text !== retained ||
        actual.done !== item.done ||
        actual.start !== start
      );
    })
  )
    throw new Error("Existing checklist item identity, state or range changed");
  for (const span of spans) {
    let offset = 0,
      oldIndex = 0,
      newIndex = 0;
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
        throw new Error("Existing rich formatting changed");
      offset += Math.min(
        span.length - offset,
        oldRun.start + oldRun.length - oldPosition,
        newRun.start + newRun.length - newPosition
      );
    }
  }
  assertZeroLengthFormatting(before, after, spans);
}
