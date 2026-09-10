import { describe, expect, it } from "vitest";
import { comparableVisibleText, hashNoteContent } from "./noteRevision.js";

describe("hashNoteContent", () => {
  it("returns the same revision for identical note bodies", () => {
    expect(hashNoteContent("<div>Same</div>")).toBe(hashNoteContent("<div>Same</div>"));
  });

  it("changes when any note content changes", () => {
    expect(hashNoteContent("<div>Before</div>")).not.toBe(hashNoteContent("<div>After</div>"));
  });

  it("uses a compact sha256 token", () => {
    expect(hashNoteContent("body")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("comparableVisibleText", () => {
  it("treats Notes HTML rewrites with the same visible text as equivalent", () => {
    const submitted = "<div>Hello <b>safe</b> world</div>";
    const normalized = '<div><span style="font-weight: bold">Hello safe world</span><br></div>';

    expect(comparableVisibleText(normalized)).toBe(comparableVisibleText(submitted));
  });

  it("does not claim to verify rich-formatting semantics", () => {
    const linked = '<div><a href="https://example.com">Open</a></div>';
    const unlinked = "<div>Open</div>";

    // Callers expose this result as verifiedVisibleText, never as a full HTML
    // verification. Notes.app is free to normalize its stored markup.
    expect(comparableVisibleText(linked)).toBe(comparableVisibleText(unlinked));
  });

  it("decodes common entities before comparing visible text", () => {
    expect(comparableVisibleText("<div>A &amp; B&nbsp;&#39;test&#39;</div>")).toBe("A & B 'test'");
  });

  it("decodes numeric character references in either radix", () => {
    // Not reachable through the named-entity cases above: &#39; is consumed by
    // the &apos; rule before the numeric rules run, so the decimal and hex
    // decoders are only exercised by code points that have no named form.
    // Notes.app emits these for em dashes and accented text, and a false
    // mismatch here would report a successful write as unverified.
    expect(comparableVisibleText("<div>caf&#233; &#8212; ok</div>")).toBe("café — ok");
    expect(comparableVisibleText("<div>caf&#xE9; &#x2014; ok</div>")).toBe("café — ok");
  });

  it("does not invent a space at an inline-tag boundary (#145)", () => {
    // Notes.app MERGES adjacent same-style inline runs on save — verified
    // against Notes.app 2026-09-10, where `<b>merge</b><b>me</b>` read back as
    // `<b>mergeme</b>`. Inserting a space per tag made the written side
    // normalise to "merge me" and the readback to "mergeme", so update-note
    // reported a readback mismatch for a write that had actually succeeded.
    const written = "<div><b>merge</b><b>me</b></div>";
    const readback = "<div><b>mergeme</b><br></div>";

    expect(comparableVisibleText(written)).toBe("mergeme");
    expect(comparableVisibleText(readback)).toBe("mergeme");
    expect(comparableVisibleText(written)).toBe(comparableVisibleText(readback));
  });

  it("keeps inline runs of DIFFERENT styles equivalent across normalisation", () => {
    // Notes leaves these unmerged, so both sides must agree either way.
    expect(comparableVisibleText("<div><b>alpha</b><i>beta</i></div>")).toBe("alphabeta");
    expect(comparableVisibleText("<div><b>alpha</b><i>beta</i><br></div>")).toBe("alphabeta");
  });

  it("still separates words at BLOCK boundaries", () => {
    // The allow-list is inline-only: block tags must keep separating, or two
    // paragraphs would silently compare equal to one run-on word.
    expect(comparableVisibleText("<div>one</div><div>two</div>")).toBe("one two");
    expect(comparableVisibleText("<p>one</p><p>two</p>")).toBe("one two");
    expect(comparableVisibleText("<ul><li>one</li><li>two</li></ul>")).toBe("one two");
    expect(comparableVisibleText("<div>one<br>two</div>")).toBe("one two");
    // An unknown tag is not on the allow-list, so it still separates.
    expect(comparableVisibleText("<div>one<unknown-tag>two</unknown-tag></div>")).toBe("one two");
  });

  it("does not let the inline allow-list match a longer tag name", () => {
    // `\b` guards the prefix: <bdo>/<summary> must not be eaten as <b>/<s>.
    expect(comparableVisibleText("<div>one<bdo>two</bdo></div>")).toBe("one two");
    expect(comparableVisibleText("<div>one<summary>two</summary></div>")).toBe("one two");
  });

  it("still detects a real visible-text mismatch", () => {
    expect(comparableVisibleText("<div>Before</div>")).not.toBe(
      comparableVisibleText("<div>After</div>")
    );
  });
});
