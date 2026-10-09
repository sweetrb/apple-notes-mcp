/** Print setup instructions for Gemini Spark's macOS Local MCP form. */
export const GEMINI_SPARK_LOCAL_MCP = {
  serverName: "Apple Notes",
  description: "Read, search, create, edit, organize, and export Apple Notes on this Mac.",
  command: "npx -y apple-notes-mcp",
} as const;

export const GEMINI_SPARK_SETUP_USAGE = "Usage: apple-notes-mcp setup --gemini-spark [--help]";

interface SetupOutput {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** This guide neither probes Notes nor edits any client configuration or permissions. */
export function formatGeminiSparkSetup(): string {
  return [
    "Gemini Spark on macOS: Local MCP",
    "Requires a Gemini macOS build with Local MCP in Connected Apps > + Custom.",
    "Select Local MCP and enter:",
    "",
    `Server Name: ${GEMINI_SPARK_LOCAL_MCP.serverName}`,
    `Description: ${GEMINI_SPARK_LOCAL_MCP.description}`,
    `Command: ${GEMINI_SPARK_LOCAL_MCP.command}`,
    "",
    "Keep Sandbox settings at Default initially. If startup fails, inspect Show Logs",
    "and review the specific launcher or filesystem access it needs.",
    "Sandbox access and macOS Automation / Full Disk Access are separate permissions.",
    "Click Next, review the tools and permissions, and complete the connection yourself.",
    "Verify tool discovery with get-capabilities in Gemini; use doctor for Notes diagnostics.",
    "",
    "This command only prints instructions; a successful exit does not verify a connection.",
    "Cloud MCP needs a hosted MCP URL. This server provides local stdio only.",
  ].join("\n");
}

/** Refuse mixed setup targets before any effectful setup command can run. */
export function runGeminiSparkSetup(
  args: string[],
  output: SetupOutput = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }
): number {
  if (
    args.filter((arg) => arg === "--gemini-spark").length !== 1 ||
    args.some((arg) => arg !== "--gemini-spark" && arg !== "--help") ||
    args.filter((arg) => arg === "--help").length > 1
  ) {
    output.err(
      `${GEMINI_SPARK_SETUP_USAGE}\nThis print-only guide cannot be combined with other setup options.\n`
    );
    return 2;
  }
  output.out(`${formatGeminiSparkSetup()}\n`);
  return 0;
}
