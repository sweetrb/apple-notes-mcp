/**
 * Executable doc examples — README.md's backslash-escaping section.
 *
 * README.md is listed in package.json `files[]`, so it ships in the npm tarball;
 * CLAUDE.md does not. The escaping guard that landed alongside this file's sibling
 * (`claudeMdEscaping.test.ts`) checked CLAUDE.md only — the file that does NOT ship —
 * while the file that DOES ship carried a wrong instruction of exactly the class the
 * guard was written to catch:
 *
 *     - Windows paths: `C:\Users\` → `C:\\\\Users\\\\` in JSON
 *
 * Four backslashes in a JSON string literal decode to TWO literal backslashes, so that
 * line produced `C:\\Users\\`, not `C:\Users\`. README.md and CLAUDE.md contradicted
 * each other inside one repo, and the shipped one was the wrong one.
 *
 * These tests hold README.md to the same standard as CLAUDE.md:
 *
 *   a. every "common patterns" bullet is self-consistent — JSON-decoding the documented
 *      payload yields exactly the documented plain text (this is the assertion that
 *      catches the bug above)
 *   b. every worked ```json example decodes to its documented `→ arrives as:` result —
 *      the block is parsed as JSON, not regexed, so the decoding is the transport's own
 *   c. neither doc reintroduces a Windows example — these servers are macOS-only
 *
 * Reads the docs from disk only; no server boot, no Notes.app, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const README = resolve(__dirname, "../README.md");
const CLAUDE_MD = resolve(__dirname, "../CLAUDE.md");
const README_HEADING = "### Backslash Escaping (Important for AI Agents)";
const CLAUDE_HEADING = "## Critical: Backslash Escaping";
const PATTERNS_MARKER = "**Common patterns requiring escaping:**";

/**
 * The escaping section only, so an unrelated fenced block elsewhere in the doc is not
 * swept in. Ends at the next heading of the same or higher level, or at a `---` rule.
 */
function section(file: string, heading: string): string {
  const doc = readFileSync(file, "utf8");
  const start = doc.indexOf(heading);
  expect(start, `${file} is missing the "${heading}" section`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = doc.slice(start + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} |\\n---\\n`));
  return end === -1 ? rest : rest.slice(0, end);
}

const readmeSection = (): string => section(README, README_HEADING);

/** Decode a documented JSON-parameter payload the way the MCP transport would. */
function decodeLiteral(literal: string): string {
  return JSON.parse(`"${literal}"`) as string;
}

/** ``- <label>: `<plain>` → `<json>` in JSON`` */
const PATTERN_RE = /^- ([^:\n]+): `(.+?)` → `(.+?)` in JSON$/;

/** A fenced JSON payload plus the single line immediately after its closing fence. */
const JSON_EXAMPLE_RE = /```json\n([\s\S]*?)\n```[ \t]*\n(.*)/g;

const ANNOTATION_RE = /^→ arrives as: `(.*)`$/;

describe("README.md backslash-escaping section is executable", () => {
  it("every 'common patterns' bullet is self-consistent — the JSON form decodes to the plain form", () => {
    const body = readmeSection();
    const at = body.indexOf(PATTERNS_MARKER);
    expect(
      at,
      `README.md's escaping section is missing "${PATTERNS_MARKER}"`
    ).toBeGreaterThanOrEqual(0);

    const bullets: string[] = [];
    for (const raw of body.slice(at + PATTERNS_MARKER.length).split("\n")) {
      const line = raw.trim();
      if (line === "") {
        if (bullets.length > 0) break;
        continue;
      }
      if (!line.startsWith("- ")) break;
      bullets.push(line);
    }

    expect(
      bullets.length,
      `no bullets found under "${PATTERNS_MARKER}" — a doc rewrite must not silently drop ` +
        "them and leave this test vacuously passing"
    ).toBeGreaterThan(0);

    for (const bullet of bullets) {
      const m = PATTERN_RE.exec(bullet);
      expect(
        m,
        "escaping bullet is not in the machine-checkable form " +
          "``- <label>: `<plain>` → `<json>` in JSON``, so nothing verifies it: " +
          JSON.stringify(bullet)
      ).toBeTruthy();

      const [, label, want, send] = m as RegExpExecArray;
      let decoded: string;
      try {
        decoded = decodeLiteral(send);
      } catch (err) {
        throw new Error(
          `README.md escaping bullet ${JSON.stringify(bullet)} tells callers to send ` +
            `\`${send}\`, which is not a valid JSON string body: ${(err as Error).message}`
        );
      }
      expect(
        decoded,
        `README.md escaping bullet ${JSON.stringify(bullet)} is self-contradictory: ` +
          `"${label.trim()}" says to send \`${send}\`, but that JSON string literal decodes ` +
          `to ${JSON.stringify(decoded)}, not \`${want}\``
      ).toBe(want);
    }
  });

  it("every worked JSON example decodes to its documented '→ arrives as:' result", () => {
    const found = [...readmeSection().matchAll(JSON_EXAMPLE_RE)];
    expect(
      found.length,
      "no fenced json worked examples found in README.md's escaping section — a doc rewrite " +
        "must not silently drop them and leave this test vacuously passing"
    ).toBeGreaterThan(0);

    for (const [, block, nextLine] of found) {
      const payload = JSON.parse(block) as Record<string, unknown>;
      const field = "content" in payload ? "content" : "body";
      const value = payload[field];
      expect(
        typeof value,
        `the worked example ${JSON.stringify(block)} has no string content:/body: field to check`
      ).toBe("string");

      const annotated = ANNOTATION_RE.exec(nextLine.trim());
      expect(
        annotated,
        "a worked example needs a machine-readable result on the line immediately after its " +
          "closing fence, exactly: → arrives as: `<literal text>` " +
          `(found: ${JSON.stringify(nextLine.trim())})`
      ).toBeTruthy();

      expect(
        value,
        `the worked example ${JSON.stringify(payload.title)} does not deliver what it claims: ` +
          `its ${field} field decodes to ${JSON.stringify(value)}, not the documented result`
      ).toBe((annotated as RegExpExecArray)[1]);
    }
  });

  it("neither doc reintroduces a Windows example — these servers are macOS-only", () => {
    const sections: Array<[string, string]> = [
      ["README.md", readmeSection()],
      ["CLAUDE.md", section(CLAUDE_MD, CLAUDE_HEADING)],
    ];

    for (const [name, text] of sections) {
      expect(
        /windows|[A-Za-z]:\\/i.test(text),
        `${name}'s backslash-escaping section carries a Windows example. Apple Notes runs ` +
          "only on macOS, so a Windows path teaches nothing here and is how the wrong " +
          "four-backslash instruction survived review — use the shell escaped-space, regex " +
          "or literal-double-backslash examples instead."
      ).toBe(false);
    }
  });
});
