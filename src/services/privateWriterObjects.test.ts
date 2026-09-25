/**
 * Source contract for guards in the private writer's object actions (section
 * chips, tables, link cards, checklists, highlights, Paper, smart folders).
 * Each case pins a refusal or a read-back check that the copy-store scripts
 * exercise against real data, so a later edit cannot drop it silently.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./privateHelper.js";
import { WRITER_SOURCE_RELATIVE } from "./privateWriter.js";

const SOURCE = readFileSync(join(packageRoot(__dirname), WRITER_SOURCE_RELATIVE), "utf8");

/** The body of `static <type> <name>(...) { ... }`, by brace matching. */
function body(name: string): string {
  // The definition, not a forward declaration: the signature ends in "{".
  const start = SOURCE.search(new RegExp(`^static [^\\n;]*\\b${name}\\([^;{]*\\)\\s*\\{`, "m"));
  expect(start, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SOURCE.indexOf("{", start); i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    if (SOURCE[i] === "}" && --depth === 0) return SOURCE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("private writer object guards", () => {
  it("never matches an attachment row whose identifier is not a string", () => {
    // [nil caseInsensitiveCompare:] is NSOrderedSame, so a nil identifier
    // would otherwise match any lookup.
    expect(body("InlineAttachmentNamed")).toMatch(
      /\[candidate isKindOfClass:\[NSString class\]\] &&\s*\[candidate caseInsensitiveCompare:identifier\]/
    );
    expect(body("ResolveTableTarget")).toMatch(
      /\[candidate isKindOfClass:\[NSString class\]\] &&\s*\[candidate caseInsensitiveCompare:tableIdentifier\]/
    );
  });

  it("merges overlapping chip removals and copies only the paragraph style", () => {
    const handler = body("HandleAddSectionLink");
    expect(handler).toMatch(/MergedRemovalRanges\(cleared, sourceBefore\.string\)/);
    expect(handler).toMatch(/for \(NSValue \*value in removals\.reverseObjectEnumerator\)/);
    expect(handler).not.toMatch(/attributesAtIndex:/);
    expect(body("MergedRemovalRanges")).toMatch(/NSUnionRange\(last, range\)/);
  });

  it("puts a link card after the anchor's own newline and checks its line style", () => {
    expect(body("CardInsertionIndex")).toMatch(/if \(end < text\.length\) return end \+ 1;/);
    expect(body("CardInsertion")).toMatch(/defaultParagraphStyle/);
    expect(body("HandleAddURLCard")).toMatch(/CardLineIsBody\(persisted, glyphAt\)/);
    expect(body("CardLineIsBody")).toMatch(/StyleValueOf\(style\) != kStyleBody/);
  });

  it("refuses a checklist identity shared by more than one line", () => {
    expect(body("HandleSetChecklistItem")).toMatch(
      /if \(ItemSpansLines\(body\.string, item\)\)\s*Fail\(@"ambiguous_target"/
    );
  });

  it("refuses highlight matches that split a composed character", () => {
    expect(body("HighlightTargets")).toMatch(/rangeOfComposedCharacterSequencesForRange:/);
  });

  it("reports whether the planned write could run on highlight and link-card dry runs", () => {
    expect(body("HandleSetHighlight")).toMatch(/WriteAvailability\(FeatureHighlight\)/);
    expect(body("HandleAddURLCard")).toMatch(/WriteAvailability\(FeatureLinkCard\)/);
    expect(body("WriteAvailability")).toMatch(/MissingForFeature\(feature\)/);
  });

  it("prunes an orphan table only when every glyph is identified and nothing else changes", () => {
    const handler = body("HandlePruneOrphanTable");
    expect(handler).toMatch(/UnidentifiedAttachmentGlyphs\(BodyAttributedString\(target\.note\)\)/);
    expect(handler).toMatch(
      /RequireExpectedChanges\(target\.context, @\[ target\.note, target\.attachment \], \[NSSet set\]\);\s*SaveOrFail\(target\.context\);/
    );
    expect(handler).toMatch(/else if \(!attachment\)\s*verifyDetail = /);
  });

  it("checks that an added drawing is the only change to the note text", () => {
    const handler = body("HandleAddPaper");
    expect(handler).toMatch(/GlyphCountFor\(persisted, attachmentId\) != 1/);
    expect(handler).toMatch(/PaperBodyKeptExceptGlyph\(/);
  });

  it("probes the account deletion flag and does not stamp timestamps on a query update", () => {
    expect(SOURCE).toMatch(/\{"ICAccount", "identifier,name,markedForDeletion"\}/);
    const update = body("HandleUpdateSmartFolder");
    expect(update).not.toMatch(/setValue:\[NSDate date\]/);
    expect(update).toMatch(/response\[@"timestampsMissing"\] = timestampsMissing;/);
  });
});
