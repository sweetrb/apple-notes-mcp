/**
 * Doc-truth guards — the docs must describe the software that actually exists.
 *
 * Two defects shipped in one week that nothing mechanical could have caught, because
 * nothing ever compared a doc to reality:
 *
 *   1. Every backslash-escaping instruction in the **published** README was wrong (four
 *      backslashes where two were correct) while CLAUDE.md said the opposite — two files
 *      inside one repo contradicting each other, and the shipped one was the wrong one.
 *   2. "Default account is iCloud" survived in CLAUDE.md after the code stopped assuming
 *      that name. The behaviour moved; the sentence describing it did not.
 *
 * `claudeMdEscaping.test.ts` / `readmeEscaping.test.ts` made the escaping *examples*
 * executable. These two guards go after the other half of the surface:
 *
 *   A. every documented example is real — every ```json fence in README.md, CLAUDE.md and
 *      docs/*.md parses as JSON, and every APPLE_*_MCP_* environment variable named in
 *      those docs exists under src/.
 *   B. the README's `## Tool Reference` documents *exactly* the tool surface the built
 *      server advertises over the wire — no undocumented tool, no phantom tool.
 *
 * PLACEMENT (this is where the previous two guards went wrong — twice a guard was written
 * that never ran in CI). `vitest.config.ts` includes `src/**\/*.test.ts` and is what
 * `pnpm test` / `pnpm run test:coverage` execute, which is what the REQUIRED branch
 * protection contexts `test (22)` / `test (24)` run. This file therefore lives in `src/`.
 * The `integration` context runs a different config and is not required — nothing here
 * may depend on it.
 *
 * Guard B reads the truth from the **built server** (`build/index.js`, initialize →
 * tools/list) rather than by regexing `src/index.ts`, because the wire is the contract a
 * user actually sees. There is deliberately NO skip-if-`build/`-is-missing branch — that
 * is how a guard passes vacuously forever. `build/index.js` is git-tracked (it is what npm
 * and marketplace users run), so it exists at checkout, and package.json's `prepare`
 * script rebuilds it during CI's `pnpm install --frozen-lockfile`, before the test step.
 * If it is ever absent, this file fails, which is the correct outcome.
 *
 * No Notes.app, no network, no TCC: reading files and a `tools/list` round-trip only.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

const REPO = resolve(__dirname, "..");
const SERVER = resolve(REPO, "build/index.js");

/** README.md, CLAUDE.md and every docs/*.md, as repo-relative paths. */
function docFiles(): string[] {
  const docs = readdirSync(resolve(REPO, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `docs/${f}`);
  return ["README.md", "CLAUDE.md", ...docs];
}

const read = (rel: string): string => readFileSync(resolve(REPO, rel), "utf8");

interface Fence {
  file: string;
  line: number;
  lang: string;
  body: string;
}

/**
 * Every fenced block in a markdown file, with its info string and 1-based opening line.
 * Handles indented fences (fences nested in list items) and longer-than-three run lengths,
 * so a block cannot dodge the guard by being indented.
 */
function fences(rel: string): Fence[] {
  const lines = read(rel).split("\n");
  const found: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^(\s*)(`{3,})(.*)$/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const [, indent, ticks, info] = open;
    const closer = new RegExp(`^\\s{0,${indent.length}}\`{${ticks.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    found.push({
      file: rel,
      line: i + 1,
      lang: info.trim().split(/\s+/)[0].toLowerCase(),
      body: body.join("\n"),
    });
    i = j + 1;
  }
  return found;
}

describe("Guard A — every documented example is real", () => {
  it("every fenced ```json block in README.md, CLAUDE.md and docs/*.md parses as JSON", () => {
    const blocks = docFiles().flatMap((f) => fences(f).filter((b) => b.lang === "json"));

    // Vacuity floor. A ```json fence that is a deliberate FRAGMENT must be retagged
    // ```jsonc / ```text — honestly not-JSON — never allowlisted; but retagging
    // *everything* is how this guard would become decorative, so an empty set fails.
    expect(
      blocks.length,
      "no ```json fences found in README.md, CLAUDE.md or docs/*.md — either the docs lost " +
        "all their JSON examples or every fence was retagged away from `json`, and this " +
        "guard is now checking nothing"
    ).toBeGreaterThan(0);

    for (const block of blocks) {
      try {
        JSON.parse(block.body);
      } catch (err) {
        throw new Error(
          `${block.file}:${block.line} — a \`\`\`json example does not parse as JSON, so a ` +
            `user who copies it gets a syntax error: ${(err as Error).message}\n` +
            "If the block is a deliberate fragment rather than a whole document, retag the " +
            "fence ```jsonc or ```text instead of leaving it mislabelled.\n---\n" +
            block.body +
            "\n---"
        );
      }
    }
  });

  it("every APPLE_*_MCP_* environment variable named in the docs exists under src/", () => {
    // Trailing `[A-Z0-9_]*` is intentionally allowed to be empty so that a family prefix
    // written in prose (`APPLE_NOTES_MCP_*`) is CAPTURED and judged, not silently skipped.
    const ENV_RE = /APPLE_[A-Z0-9]+_MCP_[A-Z0-9_]*/g;

    const tokensIn = (text: string): string[] => [...text.matchAll(ENV_RE)].map((m) => m[0]);

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = resolve(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });

    const srcTokens = new Set(
      walk(resolve(REPO, "src")).flatMap((f) => tokensIn(readFileSync(f, "utf8")))
    );

    const documented = new Map<string, string[]>();
    for (const rel of docFiles()) {
      for (const token of tokensIn(read(rel))) {
        const where = documented.get(token) ?? [];
        if (!where.includes(rel)) where.push(rel);
        documented.set(token, where);
      }
    }

    expect(
      documented.size,
      "no APPLE_*_MCP_* environment variables found anywhere in README.md, CLAUDE.md or " +
        "docs/*.md — the Configuration section documents several, so finding none means " +
        "this guard is scanning nothing"
    ).toBeGreaterThan(0);

    const srcList = [...srcTokens].sort();
    for (const [token, where] of [...documented].sort()) {
      if (srcTokens.has(token)) continue;

      // A family prefix used as a name in prose (`APPLE_NOTES_MCP_*` → `APPLE_NOTES_MCP_`)
      // is legitimate exactly when it is a STRICT prefix of a real variable. Judged
      // structurally — nothing about this repo's current variable names is hardcoded.
      if (token.endsWith("_") && srcList.some((real) => real !== token && real.startsWith(token))) {
        continue;
      }

      throw new Error(
        `${where.join(", ")} document(s) the environment variable \`${token}\`, which does not ` +
          "appear anywhere under src/. Either the knob was renamed or deleted and the docs " +
          "still advertise it, or it is a typo. Variables the code actually reads: " +
          srcList.join(", ")
      );
    }
  });
});

describe("Guard B — the README Tool Reference matches the advertised tool surface", () => {
  /** Tool names the built server advertises over stdio: initialize → tools/list. */
  function advertisedTools(): string[] {
    expect(
      existsSync(SERVER),
      `${SERVER} is missing. It is git-tracked (it is the bundle npm users run) and ` +
        "package.json's `prepare` script rebuilds it during `pnpm install`, so it must be " +
        "present before tests run. This guard deliberately has no skip branch: a doc guard " +
        "that quietly no-ops when its source of truth is absent passes forever and proves " +
        "nothing. Run `pnpm run build`."
    ).toBe(true);

    const request =
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "docs-truth-guard", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n";

    const proc = spawnSync(process.execPath, [SERVER], {
      input: request,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const detail = `exit=${proc.status} signal=${proc.signal} stderr=${(proc.stderr || "").slice(-2000)}`;

    let tools: Array<{ name: string }> | undefined;
    for (const line of (proc.stdout || "").split("\n")) {
      if (!line.trim()) continue;
      let msg: { id?: number; result?: { tools?: Array<{ name: string }> } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 2 && msg.result?.tools) tools = msg.result.tools;
    }

    expect(
      tools,
      `the built server did not answer tools/list — cannot check the docs against a tool ` +
        `surface that was never obtained (${detail})`
    ).toBeTruthy();
    expect(
      (tools as Array<{ name: string }>).length,
      `the built server advertised zero tools (${detail})`
    ).toBeGreaterThan(0);

    return (tools as Array<{ name: string }>).map((t) => t.name).sort();
  }

  /**
   * Tool names documented in `## Tool Reference` ONLY. The rest of the README names tools
   * in prose, workflows and cross-links, so scanning the whole file would mask exactly the
   * drift this guard exists to catch (a tool "documented" by a passing mention).
   *
   * Entries are `#### \`tool-name\`` headings; a trailing annotation such as `(BETA)` is
   * part of the heading, not of the name.
   */
  function documentedTools(): string[] {
    const readme = read("README.md");
    const heading = "\n## Tool Reference\n";
    const start = readme.indexOf(heading);
    expect(
      start,
      "README.md has no `## Tool Reference` section — that section IS the tool documentation, " +
        "so its absence is a failure, not an excuse to skip the check"
    ).toBeGreaterThanOrEqual(0);

    const rest = readme.slice(start + heading.length);
    const end = rest.search(/\n## /);
    const section = end === -1 ? rest : rest.slice(0, end);

    const names = [...section.matchAll(/^#### `([^`\n]+)`/gm)].map((m) => m[1]);

    expect(
      names.length,
      "README.md's `## Tool Reference` section documents no tools (expected `#### `tool-name`` " +
        "headings) — an empty section must fail rather than trivially satisfy an equality check"
    ).toBeGreaterThan(0);

    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `README.md's Tool Reference documents the same tool twice: ${dupes}`).toEqual([]);

    return [...names].sort();
  }

  it("no advertised tool is missing from the README Tool Reference", () => {
    const advertised = advertisedTools();
    const documented = new Set(documentedTools());
    const undocumented = advertised.filter((name) => !documented.has(name));

    expect(
      undocumented,
      `the server advertises ${undocumented.length} tool(s) that README.md's Tool Reference ` +
        `never documents: ${undocumented.join(", ")}. A tool shipped without docs is a tool ` +
        "users cannot discover — add a `#### `<name>`` entry."
    ).toEqual([]);
  }, 60_000);

  it("no tool documented in the README Tool Reference is absent from the server", () => {
    const advertised = new Set(advertisedTools());
    const phantom = documentedTools().filter((name) => !advertised.has(name));

    expect(
      phantom,
      `README.md's Tool Reference documents ${phantom.length} tool(s) the server does not ` +
        `advertise: ${phantom.join(", ")}. Either the tool was renamed or removed and the docs ` +
        "were not updated, or the name is a typo — a documented tool that does not exist sends " +
        "every caller into a -32602."
    ).toEqual([]);
  }, 60_000);
});
