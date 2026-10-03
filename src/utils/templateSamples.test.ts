/** The editor's built-in sample notes render cleanly through the built-in templates. */
import { describe, expect, it } from "vitest";
import { emptyStats } from "./exportRender.js";
import { builtinTemplate, resolveTemplate } from "./markdownTemplate.js";
import { renderNotesMarkdown } from "./markdownExport.js";
import { renderNotesWithTemplate } from "./templateRender.js";
import { templateSamples } from "./templateSamples.js";

describe("templateSamples", () => {
  it("has stable, unique ids and synthetic note ids", () => {
    const samples = templateSamples();
    expect(samples.map((s) => s.id)).toEqual(["structure", "inline", "attachments"]);
    for (const s of samples) expect(s.note.id).toMatch(/^x-coredata:\/\/SAMPLE\/ICNote\/p\d+$/);
  });

  it("renders every sample through standard-markdown like the fixed renderer, with no warnings", () => {
    const template = resolveTemplate(builtinTemplate("standard-markdown"));
    for (const sample of templateSamples()) {
      const out = renderNotesWithTemplate([sample.note], { stats: emptyStats() }, { template });
      expect(out.warnings).toEqual([]);
      expect(out.markdown).toBe(renderNotesMarkdown([sample.note], { stats: emptyStats() }));
    }
  });

  it("gives the obsidian template tags and dates to render", () => {
    const template = resolveTemplate(builtinTemplate("obsidian"));
    const sample = templateSamples()[2];
    const out = renderNotesWithTemplate(
      [sample.note],
      { stats: emptyStats() },
      { template, metaFor: () => sample.meta }
    );
    expect(out.markdown).toMatch(/^---\n/);
    expect(out.markdown).toContain("travel");
    expect(out.markdown).toContain("2026-01-05");
  });
});
