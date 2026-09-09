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

  it("still detects a real visible-text mismatch", () => {
    expect(comparableVisibleText("<div>Before</div>")).not.toBe(
      comparableVisibleText("<div>After</div>")
    );
  });
});
