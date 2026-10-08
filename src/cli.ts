/**
 * Validate the executable's command line before setup or MCP startup can run.
 * Parsing is pure: help and invalid options must never import Shortcuts, build
 * a helper, open System Settings, or connect an MCP transport.
 */
export type SetupTarget =
  "shortcuts" | "public-helper" | "native-helper" | "permissions-window" | "permissions";

export type CliCommand =
  | { kind: "mcp" }
  | { kind: "help"; topic: "main" | "setup" }
  | { kind: "version" }
  | { kind: "setup"; target: SetupTarget; args: string[]; checkOnly: boolean }
  | { kind: "templates" | "anchors"; args: string[] };

export const CLI_USAGE = `Usage: apple-notes-mcp [command]

With no arguments, run the local MCP server over stdio.

Commands:
  setup [options]       Install or inspect Shortcuts and optional native helpers
  templates [options]   Manage the local Markdown template editor (templates --help)
  anchors [options]     Run the optional paragraph anchor resolver (anchors --help)
  --help, -h            Show this help without running setup or the MCP server
  --version, -v         Print the installed package version

Run apple-notes-mcp setup --help for supported setup options.
`;

export const SETUP_USAGE = `Usage: apple-notes-mcp setup [target] [options]

Targets (choose at most one; default: packaged Shortcuts):
  --public-helper       Build and install the public drawing/speech helper
  --native-helper       Build and install the opt-in read-only private helper
  --permissions-window Build and install the optional permission checklist window
  --permissions         Check permissions; does not grant them

Options for every target:
  --check               Inspect only; do not install or import anything
  --help, -h            Show this help without performing any checks

Options only with --permissions:
  --once                Print one report and exit
  --json                Print the report as JSON
  --open                Open System Settings panes for missing grants
  --window              Show the checklist in the installed optional window
  --probe-automation    Send a read-only Apple event (may show a consent prompt)

--check and SSH sessions suppress the Automation probe. Without an explicit
--probe-automation, Automation is unverified. Helper installation requires
Apple developer tools; setup never silently grants macOS permissions.
`;

const SETUP_TARGETS = new Map<string, SetupTarget>([
  ["--public-helper", "public-helper"],
  ["--native-helper", "native-helper"],
  ["--permissions-window", "permissions-window"],
  ["--permissions", "permissions"],
]);
const PERMISSION_OPTIONS = new Set([
  "--once",
  "--json",
  "--open",
  "--window",
  "--probe-automation",
]);

/** Reject unsupported or mixed setup options before selecting an effectful route. */
export function parseSetupArgs(args: readonly string[]): CliCommand {
  let target: SetupTarget = "shortcuts";
  let selected = false;
  for (const arg of args) {
    const next = SETUP_TARGETS.get(arg);
    if (next) {
      if (selected && target !== next)
        throw new Error("Choose only one setup target. Run each target separately.");
      target = next;
      selected = true;
    } else if (!["--check", "--help", "-h"].includes(arg) && !PERMISSION_OPTIONS.has(arg)) {
      throw new Error(`Unknown setup option "${arg}".`);
    }
  }
  for (const arg of args) {
    if (PERMISSION_OPTIONS.has(arg) && target !== "permissions")
      throw new Error(`${arg} requires setup --permissions.`);
  }
  if (args.includes("--help") || args.includes("-h")) return { kind: "help", topic: "setup" };
  return { kind: "setup", target, args: [...args], checkOnly: args.includes("--check") };
}

/** Parse argv after the executable; templates and anchors retain their own parsers. */
export function parseCliArgs(args: readonly string[]): CliCommand {
  if (!args.length) return { kind: "mcp" };
  const [command, ...rest] = args;
  if (command === "setup") return parseSetupArgs(rest);
  if (command === "templates" || command === "anchors") return { kind: command, args: rest };
  if (["--help", "-h", "help", "--version", "-v"].includes(command)) {
    if (rest.length) throw new Error(`Unexpected argument "${rest[0]}" after ${command}.`);
    return command === "--version" || command === "-v"
      ? { kind: "version" }
      : { kind: "help", topic: "main" };
  }
  throw new Error(`Unknown command or option "${command}".`);
}
