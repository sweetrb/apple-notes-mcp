import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeNotesMarkdownSupport,
  notesMarkdownSupport,
  parseNotesMarkdownSupport,
  resetNotesMarkdownSupport,
} from "./notesMarkdownIntents.js";

const params = (...names: string[]) => names.map((name) => ({ name, title: { key: name } }));
const metadata = (actions: Record<string, unknown>) => JSON.stringify({ version: 1, actions });

// Shapes taken from Notes 4.13's extract.actionsdata: macOS 27.2.1 still lists
// interpretAsMarkdown on the generic actions; macOS 26.6.2 (#337) drops it and
// adds dedicated Markdown actions.
const macOS27 = metadata({
  CreateNoteLinkAction: { parameters: params("name", "contents", "folder", "interpretAsMarkdown") },
  AppendToNoteLinkAction: {
    parameters: params(
      "operation",
      "entity",
      "text",
      "section",
      "ignoreWhitespace",
      "interpretAsMarkdown"
    ),
  },
});
const macOS26_6 = metadata({
  CreateNoteLinkAction: { parameters: params("name", "contents", "folder") },
  AppendToNoteLinkAction: { parameters: params("entity", "text") },
  CreateNoteFromMarkdownLinkAction: { parameters: params("name", "markdownContents", "folder") },
  AppendMarkdownToNoteLinkAction: { parameters: params("entity", "markdownText") },
});

afterEach(() => resetNotesMarkdownSupport());

describe("parseNotesMarkdownSupport (#337)", () => {
  it("reports Interpret as Markdown where the generic actions still take it", () => {
    expect(parseNotesMarkdownSupport(macOS27)).toEqual({
      createInterpretsMarkdown: true,
      appendInterpretsMarkdown: true,
      dedicatedMarkdownActions: [],
    });
    expect(describeNotesMarkdownSupport(parseNotesMarkdownSupport(macOS27))).toBeNull();
  });

  it("reports its absence and the dedicated actions on macOS 26.6.2", () => {
    const support = parseNotesMarkdownSupport(macOS26_6);
    expect(support).toEqual({
      createInterpretsMarkdown: false,
      appendInterpretsMarkdown: false,
      dedicatedMarkdownActions: [
        "CreateNoteFromMarkdownLinkAction",
        "AppendMarkdownToNoteLinkAction",
      ],
    });
    const text = describeNotesMarkdownSupport(support)!;
    expect(text).toMatch(/markdownRoute: "html"/);
    expect(text).toMatch(/create-note format "markdown" now defaults to markdownRoute "html"/);
    expect(text).toMatch(/append-native format "markdown" is sent through the HTML importer/);
    expect(text).toMatch(/CreateNoteFromMarkdownLinkAction, AppendMarkdownToNoteLinkAction/);
  });

  it("treats an unlisted action or a malformed file as unknown, never as missing", () => {
    expect(parseNotesMarkdownSupport(metadata({}))).toMatchObject({
      createInterpretsMarkdown: null,
      appendInterpretsMarkdown: null,
    });
    expect(
      parseNotesMarkdownSupport(metadata({ CreateNoteLinkAction: { parameters: "x" } }))
    ).toMatchObject({ createInterpretsMarkdown: null });
    for (const raw of ["not json", "null", JSON.stringify({ actions: null })]) {
      const support = parseNotesMarkdownSupport(raw);
      expect(support).toMatchObject({
        createInterpretsMarkdown: null,
        appendInterpretsMarkdown: null,
      });
      expect(support.error).toMatch(/could not parse/);
      expect(describeNotesMarkdownSupport(support)).toBeNull();
    }
  });

  it("names only the affected path when one action still interprets Markdown", () => {
    const text = describeNotesMarkdownSupport({
      createInterpretsMarkdown: true,
      appendInterpretsMarkdown: false,
      dedicatedMarkdownActions: [],
    })!;
    expect(text).toMatch(/append-native/);
    expect(text).not.toMatch(/now defaults to markdownRoute/);
    expect(text).not.toMatch(/Dedicated actions present/);
  });
});

describe("notesMarkdownSupport", () => {
  it("reads injected metadata and reports a read failure as unknown", () => {
    expect(notesMarkdownSupport(() => macOS26_6).createInterpretsMarkdown).toBe(false);
    const failed = notesMarkdownSupport(() => {
      throw new Error("ENOENT");
    });
    expect(failed.createInterpretsMarkdown).toBeNull();
    expect(failed.error).toMatch(/could not read .*extract\.actionsdata: ENOENT/);
  });

  it("is disabled by APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS=1 and caches the default probe", () => {
    vi.stubEnv("APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS", "1");
    const first = notesMarkdownSupport();
    expect(first.error).toMatch(/disabled/);
    expect(notesMarkdownSupport()).toBe(first);
    vi.unstubAllEnvs();
  });

  it("reads the installed Notes metadata by default without throwing", () => {
    vi.stubEnv("APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS", "");
    const support = notesMarkdownSupport();
    expect(Array.isArray(support.dedicatedMarkdownActions)).toBe(true);
    vi.unstubAllEnvs();
  });
});
