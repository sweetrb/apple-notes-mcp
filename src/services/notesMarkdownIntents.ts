/**
 * Whether this Mac's Notes.app still offers "Interpret as Markdown" on the
 * generic Create Note and Append to Note actions the Markdown bridges call
 * (#337).
 *
 * The bridges pass `interpretAsMarkdown: true` to `CreateNoteLinkAction`
 * (Notes MCP Markdown) and `AppendToNoteLinkAction` (Background v6's
 * `append-markdown`). On macOS 26.6.2 / Notes 4.13 those actions have no such
 * parameter, so Notes silently ignores it and saves the Markdown as literal
 * text; Markdown has its own `CreateNoteFromMarkdownLinkAction` and
 * `AppendMarkdownToNoteLinkAction` there instead. macOS 27 builds that also
 * report Notes 4.13 still carry the parameter, so the bundle version cannot
 * decide it: the App Intents metadata Notes ships can.
 *
 * Reading that metadata is a plain file read of a world-readable system file.
 * It never contacts Notes, runs a Shortcut, or raises a privacy prompt.
 *
 * Only a positive finding changes behavior: `false` means the action is listed
 * and its parameter list lacks `interpretAsMarkdown`. A missing or unreadable
 * file, or an action that is not listed at all, is `null` (unknown), and the
 * callers keep their existing behavior.
 *
 * @module services/notesMarkdownIntents
 */
import { readFileSync } from "node:fs";

export const NOTES_ACTIONS_METADATA =
  "/System/Applications/Notes.app/Contents/Resources/Metadata.appintents/extract.actionsdata";

export interface NotesMarkdownSupport {
  /** Create Note (`CreateNoteLinkAction`) accepts `interpretAsMarkdown`; null when unknown. */
  createInterpretsMarkdown: boolean | null;
  /** Append to Note (`AppendToNoteLinkAction`) accepts `interpretAsMarkdown`; null when unknown. */
  appendInterpretsMarkdown: boolean | null;
  /** Notes' dedicated Markdown actions present in this build (none of the bridges call them yet). */
  dedicatedMarkdownActions: string[];
  /** Why the result is unknown, when it is. */
  error?: string;
}

const DEDICATED_ACTIONS = ["CreateNoteFromMarkdownLinkAction", "AppendMarkdownToNoteLinkAction"];

function parameterNames(action: unknown): string[] | null {
  if (!action || typeof action !== "object") return null;
  const parameters = (action as { parameters?: unknown }).parameters;
  if (!Array.isArray(parameters)) return null;
  return parameters
    .map((p) => (p && typeof p === "object" ? (p as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === "string");
}

/** Parse Notes' extract.actionsdata JSON. Pure; never throws. */
export function parseNotesMarkdownSupport(raw: string): NotesMarkdownSupport {
  let actions: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as { actions?: unknown };
    if (!parsed || typeof parsed.actions !== "object" || parsed.actions === null)
      throw new Error("no actions table");
    actions = parsed.actions as Record<string, unknown>;
  } catch (error) {
    return {
      createInterpretsMarkdown: null,
      appendInterpretsMarkdown: null,
      dedicatedMarkdownActions: [],
      error: `could not parse Notes App Intents metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const interprets = (identifier: string): boolean | null => {
    const names = parameterNames(actions[identifier]);
    return names === null ? null : names.includes("interpretAsMarkdown");
  };
  return {
    createInterpretsMarkdown: interprets("CreateNoteLinkAction"),
    appendInterpretsMarkdown: interprets("AppendToNoteLinkAction"),
    dedicatedMarkdownActions: DEDICATED_ACTIONS.filter((id) => id in actions),
  };
}

let cached: NotesMarkdownSupport | undefined;

/**
 * Inspect the installed Notes.app once per process (Notes changes only with a
 * macOS update, which restarts the server's host). `read` is for tests.
 */
export function notesMarkdownSupport(read?: () => string): NotesMarkdownSupport {
  if (!read && cached) return cached;
  const reader = read ?? (() => readFileSync(NOTES_ACTIONS_METADATA, "utf8"));
  let result: NotesMarkdownSupport;
  if (!read && process.env.APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS === "1")
    result = {
      createInterpretsMarkdown: null,
      appendInterpretsMarkdown: null,
      dedicatedMarkdownActions: [],
      error: "detection disabled by APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS=1",
    };
  else {
    try {
      result = parseNotesMarkdownSupport(reader());
    } catch (error) {
      result = {
        createInterpretsMarkdown: null,
        appendInterpretsMarkdown: null,
        dedicatedMarkdownActions: [],
        error: `could not read ${NOTES_ACTIONS_METADATA}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!read) cached = result;
  return result;
}

/** Forget the cached probe (tests). */
export function resetNotesMarkdownSupport(): void {
  cached = undefined;
}

/** The documented workaround, shared by every refusal and warning. */
export const MARKDOWN_INTENT_WORKAROUND =
  'This Notes build has no "Interpret as Markdown" option on its Create Note / Append to Note ' +
  "actions (it offers separate Markdown actions instead), so the Markdown bridges would save the " +
  'Markdown as literal text (#337). Use markdownRoute: "html" for create-note and format: "html" ' +
  '(or format: "markdown", which this server then routes through the HTML importer) for append-native.';

/** One-line doctor / setup summary, or null when nothing is wrong or nothing is known. */
export function describeNotesMarkdownSupport(support: NotesMarkdownSupport): string | null {
  if (support.createInterpretsMarkdown !== false && support.appendInterpretsMarkdown !== false)
    return null;
  const affected = [
    support.createInterpretsMarkdown === false
      ? 'create-note format "markdown" now defaults to markdownRoute "html"'
      : null,
    support.appendInterpretsMarkdown === false
      ? 'append-native format "markdown" is sent through the HTML importer'
      : null,
  ].filter(Boolean);
  const dedicated = support.dedicatedMarkdownActions.length
    ? ` Dedicated actions present: ${support.dedicatedMarkdownActions.join(", ")}.`
    : "";
  return `${MARKDOWN_INTENT_WORKAROUND} Until a bridge built on the dedicated actions ships, ${affected.join(" and ")}.${dedicated}`;
}
