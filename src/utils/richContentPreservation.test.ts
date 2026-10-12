import { describe, expect, it } from "vitest";
import {
  assertRetainedRichContent,
  requirePreservationMetadata,
} from "./richContentPreservation.js";
import {
  plainRichNote,
  syntheticRichNote,
  plainSemantics,
} from "./__fixtures__/retainedRichNote.js";
import type { RichNote } from "./noteRichText.js";

const TAG = "com.apple.notes.inlinetextattachment.hashtag";
function fixture() {
  const text = "😀Plan\t \nlink link\nTask\n\ufffc \ufffc \ufffc\n";
  const objects = [
    { id: "a", type: TAG, tag: "alpha", start: text.indexOf("\ufffc"), length: 1 },
    { id: "table", type: "com.apple.notes.table", start: text.indexOf("\ufffc") + 2, length: 1 },
    { id: "b", type: TAG, tag: "beta", start: text.indexOf("\ufffc") + 4, length: 1 },
  ];
  const before = syntheticRichNote(text, {
    objects,
    items: [{ id: "11".repeat(16), text: "Task", done: false, start: text.indexOf("Task") }],
    links: [
      { start: text.indexOf("link"), length: 4, text: "link", url: "https://example.test/a" },
    ],
  });
  return { before, after: structuredClone(before) };
}

describe("retained native content, using generated public-decoder snapshots", () => {
  it("accepts an unchanged fully accounted rich body", () => {
    const { before, after } = fixture();
    expect(() => assertRetainedRichContent(before, after)).not.toThrow();
  });
  it("refuses an unbacked object replacement character even with otherwise complete metadata", () => {
    const rich = plainRichNote("Title\n\ufffc");
    expect(rich.nativeObjectDataComplete).toBe(true);
    expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
  });
  it("refuses an orphan placeholder after a backed native object", () => {
    const rich = syntheticRichNote("Title\n\ufffc\n\ufffc", {
      objects: [{ id: "table", type: "com.apple.notes.table", start: 6, length: 1 }],
    });
    expect(rich.nativeObjectDataComplete).toBe(true);
    expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
  });
  it.each([1, 2])("accepts repeated attachment references with later run length %s", (length) => {
    const rich = syntheticRichNote("Image\ufffc" + "\ufffc".repeat(length), {
      objects: [
        { id: "png", type: "public.png", start: 5, length: 1 },
        { id: "png", type: "public.png", start: 6, length },
      ],
    });
    // The public decoder deduplicates the identity; the native store has one row.
    rich.objectData = rich.objectData!.slice(0, 1);
    expect(rich.objects).toHaveLength(1);
    expect(rich.styleRuns!.slice(-2).map((run) => run.nativeSemantics!.objects[0].id)).toEqual([
      "png",
      "png",
    ]);
    expect(() => requirePreservationMetadata(rich)).not.toThrow();
  });
  it.each(["earlier", "later", "length"] as const)(
    "refuses a summary that differs from its first native reference: %s",
    (change) => {
      const rich = syntheticRichNote("Image\ufffc\ufffc", {
        objects: [5, 6].map((start) => ({ id: "png", type: "public.png", start, length: 1 })),
      });
      rich.objectData = rich.objectData!.slice(0, 1);
      if (change === "earlier") rich.objects![0].start--;
      if (change === "later") rich.objects![0].start++;
      if (change === "length") rich.objects![0].length++;
      expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
    }
  );
  it("accepts an inline tag backed by its textual range", () => {
    const rich = syntheticRichNote("#alpha", {
      objects: [{ id: "tag", type: TAG, tag: "alpha", start: 0, length: 6 }],
    });
    expect(() => requirePreservationMetadata(rich)).not.toThrow();
  });
  it.each(["id", "type"] as const)("refuses placeholder backing with the wrong %s", (key) => {
    const rich = syntheticRichNote("\ufffc", {
      objects: [{ id: "table", type: "com.apple.notes.table", start: 0, length: 1 }],
    });
    rich.styleRuns![0].nativeSemantics!.objects[0][key] = "different";
    expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
  });
  it.each(["id", "type"] as const)("refuses contradictory later attachment %s backing", (key) => {
    const rich = syntheticRichNote("Image\ufffc\ufffc", {
      objects: [5, 6].map((start) => ({ id: "png", type: "public.png", start, length: 1 })),
    });
    rich.objectData = rich.objectData!.slice(0, 1);
    rich.styleRuns!.at(-1)!.nativeSemantics!.objects[0][key] = "different";
    expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
  });
  it("refuses a semantic reference missing from the native summary and payload sets", () => {
    const rich = plainRichNote("ordinary text");
    rich.styleRuns![0].nativeSemantics!.objects = [{ id: "unexpected", type: "file" }];
    expect(() => requirePreservationMetadata(rich)).toThrow(/placement preservation metadata/);
  });
  it.each([
    [
      "a style signature",
      (rich: RichNote) => {
        rich.styleRuns![0].signature = "changed";
      },
    ],
    [
      "paragraph style",
      (rich: RichNote) => {
        rich.styleRuns![0].paragraphStyle = 1;
      },
    ],
    [
      "block quote",
      (rich: RichNote) => {
        rich.styleRuns![0].blockQuote = true;
      },
    ],
    [
      "highlight",
      (rich: RichNote) => {
        rich.styleRuns![0].highlight = true;
      },
    ],
    [
      "whitespace styling",
      (rich: RichNote) => {
        rich.styleRuns!.find(
          (run) => rich.text.slice(run.start, run.start + run.length) === " "
        )!.signature = "changed";
      },
    ],
    [
      "a link's exact range",
      (rich: RichNote) => {
        rich.links[0].start += 5;
      },
    ],
    [
      "a link's raw URL",
      (rich: RichNote) => {
        rich.links[0].url += "#changed";
      },
    ],
    [
      "todo identity",
      (rich: RichNote) => {
        rich.checklistItems![0].id = "22".repeat(16);
      },
    ],
    [
      "todo state",
      (rich: RichNote) => {
        rich.checklistItems![0].done = true;
      },
    ],
    [
      "object order/range",
      (rich: RichNote) => {
        rich.objects![0].start += 2;
        rich.objects!.sort((a, b) => a.start - b.start);
      },
    ],
    [
      "object bytes",
      (rich: RichNote) => {
        rich.objectData![1].mergeable = "ff";
      },
    ],
    [
      "object row identity",
      (rich: RichNote) => {
        rich.objectData![1].pk++;
      },
    ],
    [
      "object view",
      (rich: RichNote) => {
        rich.objectData![1].view = 2;
      },
    ],
    [
      "object raw label",
      (rich: RichNote) => {
        rich.objectData![1].altText = "changed";
      },
    ],
    [
      "tag backing identity",
      (rich: RichNote) => {
        rich.nativeTagObjectIds!.alpha = ["b"];
      },
    ],
  ] as const)("rejects changed %s", (_name, change) => {
    const { before, after } = fixture();
    change(after);
    expect(() => assertRetainedRichContent(before, after)).toThrow();
  });
  it.each(["😀Plan\t \n", "😀Plan  \n", "😀Plan\t \r\n"])(
    "never normalizes original whitespace: %j",
    (text) => {
      expect(() =>
        assertRetainedRichContent(plainRichNote(text), plainRichNote(text.trimEnd()), {
          kind: "append",
        })
      ).toThrow(/whitespace/);
    }
  );
  it("accepts complete equivalent split runs and rejects missing run coverage", () => {
    const before = plainRichNote("alpha beta"),
      after = structuredClone(before);
    const run = after.styleRuns![0];
    after.styleRuns = [
      { ...run, length: 6 },
      { ...run, start: 6, length: 4 },
    ];
    expect(() => assertRetainedRichContent(before, after)).not.toThrow();
    after.styleRuns.pop();
    expect(() => assertRetainedRichContent(before, after)).toThrow(/metadata/);
  });
  it("accepts end-append while requiring retained ranges and payloads", () => {
    const before = plainRichNote("😀Text\t \n"),
      after = plainRichNote(before.text + "new\n");
    expect(() => assertRetainedRichContent(before, after, { kind: "append" })).not.toThrow();
    expect(() => assertRetainedRichContent(before, after)).toThrow(/text/);
  });
  it("refuses new semantic objects inside retained text", () => {
    const retained = { id: "retained", type: "file", start: 4, length: 1 };
    const before = syntheticRichNote("Text\ufffc\n", { objects: [retained] });
    const after = syntheticRichNote(before.text, {
      objects: [{ id: "unexpected", type: "file", start: 0, length: 1 }, retained],
    });
    expect(() => requirePreservationMetadata(before)).not.toThrow();
    expect(() => requirePreservationMetadata(after)).not.toThrow();
    expect(() => assertRetainedRichContent(before, after, { kind: "append" })).toThrow(
      /identity or placement/
    );
  });
  it("allows only exact mapped tag removal, preserving later object coordinates and row identity", () => {
    const { before } = fixture();
    const removed = before.objects![0];
    const text =
      before.text.slice(0, removed.start) + before.text.slice(removed.start + removed.length);
    const after = syntheticRichNote(text, {
      objects: before.objects!.slice(1).map((object) => ({
        ...object,
        start: object.start - 1,
        ...(object.id === "b" ? { tag: "beta" } : {}),
      })),
      items: before.checklistItems,
      links: before.links,
    });
    after.objectData = before.objectData!.slice(1);
    expect(() =>
      assertRetainedRichContent(before, after, { kind: "remove-tag", tag: "alpha" })
    ).not.toThrow();
    const extraTrim = structuredClone(after);
    extraTrim.text = extraTrim.text.trimEnd();
    expect(() =>
      assertRetainedRichContent(before, extraTrim, { kind: "remove-tag", tag: "alpha" })
    ).toThrow();
  });
  it("projects todo text and start through only a removed native pill", () => {
    const id = "33".repeat(16),
      text = "Task \ufffc left\nNext\n";
    const before = syntheticRichNote(text, {
      objects: [{ id: "tag", type: TAG, tag: "alpha", start: 5, length: 1 }],
      items: [{ id, text: "Task \ufffc left", done: false, start: 0 }],
    });
    const after = syntheticRichNote("Task  left\nNext\n", {
      items: [{ id, text: "Task  left", done: false, start: 0 }],
    });
    expect(() =>
      assertRetainedRichContent(before, after, { kind: "remove-tag", tag: "alpha" })
    ).not.toThrow();
    after.checklistItems![0].done = true;
    expect(() =>
      assertRetainedRichContent(before, after, { kind: "remove-tag", tag: "alpha" })
    ).toThrow(/checklist/);
  });
  it("refuses deletion of a matching textual hashtag without native backing", () => {
    expect(() =>
      assertRetainedRichContent(plainRichNote("#alpha text"), plainRichNote(" text"), {
        kind: "remove-tag",
        tag: "alpha",
      })
    ).toThrow(/tag/);
  });
  it.each(["signature", "delete", "insert"])("checks zero-length formatting: %s", (change) => {
    const before = plainRichNote("text"),
      after = structuredClone(before);
    before.styleRuns!.unshift({
      start: 0,
      length: 0,
      signature: "empty-bold",
      nativeSemantics: plainSemantics(),
    });
    after.styleRuns = structuredClone(before.styleRuns);
    if (change === "signature") after.styleRuns![0].signature = "empty-plain";
    if (change === "delete") after.styleRuns!.shift();
    if (change === "insert")
      after.styleRuns!.unshift({ ...after.styleRuns![0], signature: "extra" });
    expect(() => assertRetainedRichContent(before, after)).toThrow(/zero-length/);
  });
  it.each(["objects", "objectData", "styleRuns", "checklistItems", "nativeTagObjectIds"] as const)(
    "fails closed without %s metadata",
    (key) => {
      const { before } = fixture();
      delete before[key];
      expect(() => requirePreservationMetadata(before)).toThrow(/metadata/);
    }
  );
});
