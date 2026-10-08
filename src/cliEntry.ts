/**
 * The executable's first dependency: finish pure CLI exits before evaluating
 * any runtime module, loading user configuration, or constructing stores.
 */
import { createRequire } from "node:module";
import { CLI_USAGE, SETUP_USAGE, parseCliArgs, type CliCommand } from "./cli.js";

let parsed: CliCommand;
try {
  parsed = parseCliArgs(process.argv.slice(2));
} catch (error) {
  const usage = process.argv[2] === "setup" ? SETUP_USAGE : CLI_USAGE;
  process.stderr.write(`${(error as Error).message}\n\n${usage}`);
  process.exit(2);
}
export const command = parsed;

if (command.kind === "help") {
  process.stdout.write(command.topic === "setup" ? SETUP_USAGE : CLI_USAGE);
  process.exit(0);
}

// Read only package metadata; help and invalid arguments never need it.
const require = createRequire(import.meta.url);
export const { version } = require("../package.json") as { version: string };
if (command.kind === "version") {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
