/**
 * Executable doc examples — CLAUDE.md's backslash-escaping section.
 *
 * CLAUDE.md is the contract we hand to agents driving this server, and nothing
 * ever checked its examples against its own rules. This repo shipped a Windows
 * path example telling callers to send `\\\\`, which by the escaping table three
 * lines above it decodes to a literal DOUBLE backslash — wrong, and wrong for a
 * long time, because prose can't fail CI. These tests make it fail CI:
 *
 *   a. the "You want | Send in JSON parameter" table is self-consistent —
 *      JSON-decoding each right-hand cell yields exactly the left-hand cell
 *   b. every "Correct" example decodes to its documented `→ arrives as:` result
 *   c. every "Incorrect" example really is incorrect — it either fails to parse
 *      as JSON or decodes to something other than a correct example's result
 *
 * Reads CLAUDE.md from disk only; no server boot, no Notes.app, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const CLAUDE_MD = resolve(__dirname, "../CLAUDE.md");
const SECTION_HEADING = "## Critical: Backslash Escaping";

/** The escaping section only — so an unrelated `**Correct**` elsewhere in the doc is not swept in. */
function escapingSection(): string {
  const doc = readFileSync(CLAUDE_MD, "utf8");
  const start = doc.indexOf(SECTION_HEADING);
  expect(start, `CLAUDE.md is missing the "${SECTION_HEADING}" section`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Decode a documented JSON-parameter payload the way the MCP transport would. */
function decodeCell(cell: string): string {
  return JSON.parse(`"${cell}"`) as string;
}

const stripCode = (cell: string): string => cell.replace(/^`/, "").replace(/`$/, "");

/**
 * Matches a labelled example: the bold "Correct"/"Incorrect" line, the fenced
 * block under it, and the single line immediately after the closing fence
 * (where the `→ arrives as:` annotation must live).
 */
const EXAMPLE_RE =
  /\*\*(Correct|Incorrect)\b([^*\n]*)\*\*\s*\n```[a-zA-Z]*\n([\s\S]*?)\n```[ \t]*\n(.*)/g;

/** Pulls the `content: "…"` / `body: "…"` JSON string literal out of a fenced example. */
const LITERAL_RE = /\b(?:content|body)\s*:\s*("(?:[^"\\]|\\.)*")/;

interface Example {
  kind: "Correct" | "Incorrect";
  label: string;
  literal: string;
  annotation: string;
}

function examples(): Example[] {
  const section = escapingSection();
  const found: Example[] = [];
  for (const m of section.matchAll(EXAMPLE_RE)) {
    const [, kind, labelRest, body, nextLine] = m;
    const literal = LITERAL_RE.exec(body)?.[1];
    expect(
      literal,
      `the ${kind} example "${labelRest.trim()}" has no content:/body: string literal in its fenced block`
    ).toBeTruthy();
    found.push({
      kind: kind as Example["kind"],
      label: labelRest.trim(),
      literal: literal as string,
      annotation: nextLine.trim(),
    });
  }
  return found;
}

describe("CLAUDE.md backslash-escaping section is executable", () => {
  it("the escaping table is self-consistent — each 'send' cell decodes to its 'you want' cell", () => {
    const rows = escapingSection()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim())
      )
      // Drop the header and the |---|---| separator.
      .filter(([want]) => want !== "You want" && !/^:?-{3,}:?$/.test(want));

    expect(rows.length, "no rows found in the escaping table").toBeGreaterThan(0);

    for (const [want, send] of rows) {
      const wanted = stripCode(want);
      const sent = stripCode(send);
      expect(
        decodeCell(sent),
        `table row is self-contradictory: sending \`${sent}\` does not produce \`${wanted}\``
      ).toBe(wanted);
    }
  });

  it("every 'Correct' example decodes to its documented '→ arrives as:' result", () => {
    const correct = examples().filter((e) => e.kind === "Correct");
    expect(
      correct.length,
      "no annotated Correct examples found — a doc rewrite must not silently drop the " +
        "`→ arrives as:` annotations and leave this test vacuously passing"
    ).toBeGreaterThan(0);

    for (const example of correct) {
      const annotated = /^→ arrives as: `(.*)`$/.exec(example.annotation);
      expect(
        annotated,
        `the Correct example "${example.label}" needs a machine-readable result on the line ` +
          "immediately after its closing fence, exactly: → arrives as: `<literal text>` " +
          `(found: ${JSON.stringify(example.annotation)})`
      ).toBeTruthy();

      expect(
        decodeCell(example.literal.slice(1, -1)),
        `the Correct example "${example.label}" does not deliver what it claims: ` +
          `${example.literal} arrives as something other than the documented result`
      ).toBe((annotated as RegExpExecArray)[1]);
    }
  });

  it("every 'Incorrect' example really is incorrect", () => {
    const all = examples();
    const correctResults = new Set(
      all.filter((e) => e.kind === "Correct").map((e) => decodeCell(e.literal.slice(1, -1)))
    );
    const incorrect = all.filter((e) => e.kind === "Incorrect");
    expect(incorrect.length, "no Incorrect examples found in the escaping section").toBeGreaterThan(
      0
    );

    for (const example of incorrect) {
      let decoded: string | undefined;
      try {
        decoded = decodeCell(example.literal.slice(1, -1));
      } catch {
        // Unparseable as JSON — genuinely broken, which is the point.
        continue;
      }
      expect(
        correctResults.has(decoded),
        `the example "${example.label}" is labelled incorrect, but ${example.literal} ` +
          "parses cleanly and produces the same result as a Correct example — a doc that " +
          "calls a working string a failure teaches the wrong lesson"
      ).toBe(false);
    }
  });
});
