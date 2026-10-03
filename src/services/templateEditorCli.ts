/**
 * `apple-notes-mcp templates edit [name] [options]`: start the local template
 * editor, print its address, and run until Ctrl-C or the idle timeout.
 *
 * @module services/templateEditorCli
 */
import { readExportNote, readExportNoteMeta } from "../utils/noteExportData.js";
import { findTailnetAddress } from "../utils/localServer.js";
import {
  DEFAULT_EDITOR_IDLE_MS,
  startTemplateEditor,
  type EditorNote,
  type TemplateEditorHandle,
  type TemplateEditorOptions,
} from "./templateEditor.js";

export const TEMPLATES_USAGE = `Usage: apple-notes-mcp templates edit [name] [options]

Open a local web editor for Markdown export templates. The editor validates
and previews as you type, against built-in sample notes, and saves into the
template library (create-only unless you tick "replace").

  name                 Template to open: standard-markdown, obsidian, or a saved name
  --port N             Port to listen on (default: a free port)
  --idle-minutes N     Stop after N minutes without a request (default 30; 0: never)
  --note ID            Also preview one real note (x-coredata://.../ICNote/pN), read-only
  --tailnet            Listen on this Mac's Tailscale address instead of 127.0.0.1,
                       so other devices on your tailnet can open the editor.
                       Anyone on the tailnet who has the printed URL can save templates.

Every request needs the per-run token in the printed URL. Press Ctrl-C to stop.
`;

export interface TemplatesEditArgs {
  name?: string;
  port?: number;
  idleMinutes: number;
  noteId?: string;
  tailnet: boolean;
}

/** Parse `templates ...` arguments (argv after "templates"). Throws on a bad argument. */
export function parseTemplatesArgs(argv: string[]): TemplatesEditArgs | "help" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return "help";
  const [command, ...rest] = argv;
  if (command !== "edit") throw new Error(`Unknown templates command "${command}".`);
  const args: TemplatesEditArgs = {
    idleMinutes: DEFAULT_EDITOR_IDLE_MS / 60000,
    tailnet: false,
  };
  const number = (flag: string, value: string | undefined, max: number): number => {
    if (value === undefined || !/^\d+$/.test(value) || Number(value) > max)
      throw new Error(`${flag} needs a whole number from 0 to ${max}.`);
    return Number(value);
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--port") args.port = number(arg, rest[++i], 65535);
    else if (arg === "--idle-minutes") args.idleMinutes = number(arg, rest[++i], 24 * 60);
    else if (arg === "--note") {
      const id = rest[++i];
      if (!id || !/^x-coredata:\/\/[^/\s]+\/ICNote\/p[0-9]{1,18}$/.test(id))
        throw new Error("--note needs a note id such as x-coredata://…/ICNote/p123.");
      args.noteId = id;
    } else if (arg === "--tailnet") args.tailnet = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    else if (args.name === undefined) args.name = arg;
    else throw new Error(`Unexpected argument "${arg}".`);
  }
  return args;
}

export interface TemplatesCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  start?: (options: TemplateEditorOptions) => Promise<TemplateEditorHandle>;
  tailnetAddress?: () => { address: string; interface: string } | undefined;
  readNote?: (id: string) => EditorNote;
  /** Registers a stop handler for Ctrl-C and SIGTERM; returns an unregister. */
  onSignal?: (stop: () => void) => () => void;
}

const editorSignals = (stop: () => void) => {
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
};

/** Run `templates ...`. Resolves with the process exit code once the editor stops. */
export async function runTemplatesCommand(
  argv: string[],
  deps: TemplatesCliDeps = {}
): Promise<number> {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  let args: TemplatesEditArgs | "help";
  try {
    args = parseTemplatesArgs(argv);
  } catch (error) {
    err(`${(error as Error).message}\n\n${TEMPLATES_USAGE}`);
    return 2;
  }
  if (args === "help") {
    out(TEMPLATES_USAGE);
    return 0;
  }

  let host = "127.0.0.1";
  if (args.tailnet) {
    const found = (deps.tailnetAddress ?? findTailnetAddress)();
    if (!found) {
      err(
        "No Tailscale address found (no 100.64.0.0/10 IPv4 address on this Mac). " +
          "Connect Tailscale first, or run without --tailnet.\n"
      );
      return 1;
    }
    host = found.address;
  }

  let handle: TemplateEditorHandle;
  try {
    const note = args.noteId
      ? (
          deps.readNote ??
          ((id: string) => ({ note: readExportNote(id), meta: readExportNoteMeta(id) }))
        )(args.noteId)
      : undefined;
    handle = await (deps.start ?? startTemplateEditor)({
      host,
      port: args.port,
      idleMs: args.idleMinutes * 60000,
      name: args.name,
      note,
    });
  } catch (error) {
    err(`Could not start the template editor: ${(error as Error).message}\n`);
    return 1;
  }

  out(`Template editor: ${handle.url}\n`);
  if (args.tailnet)
    err(
      `Listening on the tailnet address ${handle.host}. Any device on your tailnet that has ` +
        "this URL can read and save templates. Keep the URL private.\n"
    );
  err(
    args.idleMinutes > 0
      ? `Press Ctrl-C to stop. Stops by itself after ${args.idleMinutes} idle minute(s).\n`
      : "Press Ctrl-C to stop.\n"
  );
  const unregister = (deps.onSignal ?? editorSignals)(() => void handle.close());
  const reason = await handle.closed;
  unregister();
  err(
    reason === "idle"
      ? "Template editor stopped after the idle timeout.\n"
      : "Template editor stopped.\n"
  );
  return 0;
}
