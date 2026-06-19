/**
 * File-based configuration loader (#24).
 *
 * Some host apps (e.g. Claude Desktop) spawn the MCP server with a scrubbed
 * environment and ignore the `env` block in their server config, so there's no
 * way to pass `APPLE_NOTES_MCP_*` settings in. This loads them from a JSON file
 * the host doesn't manage, merging into `process.env` WITHOUT overriding
 * anything already set (so an explicit env still wins).
 *
 * Only non-secret config belongs here (e.g. APPLE_NOTES_MCP_MAX_BUFFER, DEBUG).
 *
 * Path: `APPLE_NOTES_MCP_CONFIG_FILE`, else
 * `~/Library/Application Support/apple-notes-mcp/config.json`.
 *
 * @module services/fileConfig
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function fileConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_NOTES_MCP_CONFIG_FILE;
  if (override && override.trim()) return override.trim();
  return join(homedir(), "Library", "Application Support", "apple-notes-mcp", "config.json");
}

/**
 * Merge a JSON config file's string values into `env` for keys not already set.
 * Returns the keys applied. Tolerates a missing/corrupt file.
 */
export function loadFileConfig(
  env: NodeJS.ProcessEnv = process.env,
  path: string = fileConfigPath(env)
): string[] {
  const applied: string[] = [];
  try {
    if (!existsSync(path)) return applied;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return applied;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      if (env[k] === undefined || env[k] === "") {
        env[k] = v;
        applied.push(k);
      }
    }
  } catch (e) {
    console.error(`Failed to load apple-notes-mcp config file ${path}: ${String(e)}`);
  }
  return applied;
}
