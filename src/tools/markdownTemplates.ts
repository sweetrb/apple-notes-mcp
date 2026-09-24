/**
 * Markdown template library tools: list, show, validate, save and delete the
 * templates that `export-notes-markdown` accepts by name.
 *
 * Every tool works on inert JSON in the template library directory. None of
 * them opens Notes or its database.
 *
 * @module tools/markdownTemplates
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BUILTIN_TEMPLATE_NAMES,
  builtinTemplate,
  isBuiltinTemplate,
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  resolveTemplate,
  TemplateValidationError,
  type PortableTemplate,
} from "../utils/markdownTemplate.js";
import { readTemplateFile } from "../utils/templateAssets.js";
import { errorResult } from "../utils/errorCodes.js";
import { TemplateStore, TemplateStoreError } from "../services/templateStore.js";

type Result = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (text: string, structured: Record<string, unknown>): Result => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});

/** Turn a known failure into an error result with a stable bracketed code. */
function failure(action: string, error: unknown): Result {
  if (error instanceof TemplateValidationError)
    return errorResult(
      `Error ${action} [invalid-template]: the template is invalid:\n` +
        error.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
      error
    );
  if (error instanceof TemplateStoreError)
    return errorResult(`Error ${action} [${error.code}]: ${error.message}`, error);
  const message = error instanceof Error ? error.message : String(error);
  return errorResult(`Error ${action}: ${message}`, error);
}

const nameInput = z
  .string()
  .min(1)
  .max(64)
  .describe("Template name: a built-in (standard-markdown, obsidian) or a saved template's name");
const templateInput = z
  .union([z.record(z.unknown()), z.string().max(MAX_TEMPLATE_BYTES)])
  .optional()
  .describe("The template itself, as a JSON object or JSON text (schemaVersion 1)");
const templateFileInput = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    "Absolute path of a JSON template file ending in .json (home, a temp dir, or /Volumes; hidden paths and ~/Library outside iCloud Drive and CloudStorage refused unless the server sets APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1; symlinks refused; at most 256 KiB)"
  );

/** Template text from exactly one of an inline template or a file. */
function sourceText(args: { template?: unknown; templateFile?: string }): string {
  if ((args.template === undefined) === (args.templateFile === undefined))
    throw new Error("Provide exactly one of 'template' or 'templateFile'.");
  if (args.templateFile !== undefined) return readTemplateFile(args.templateFile);
  return typeof args.template === "string" ? args.template : JSON.stringify(args.template);
}

/** Register the template library tools. `store` is created per call by default. */
export function registerMarkdownTemplates(
  server: McpServer,
  store: () => TemplateStore = () => new TemplateStore()
) {
  const loose = z.object({}).passthrough();

  server.registerTool(
    "list-markdown-templates",
    {
      description:
        "Use when: choosing a Markdown export template, or checking which saved templates exist.\n" +
        "Returns: the built-in templates, the saved templates (name, display name, description, size, modified date), the library directory, and how many unusable files were skipped.\n" +
        "Do not use when: you need a template's rules (show-markdown-template).\n" +
        "Safety: read-only; never opens Notes.",
      inputSchema: {},
      outputSchema: loose,
      annotations: { readOnlyHint: true },
    },
    (async () => {
      try {
        const listing = store().list();
        const builtins = BUILTIN_TEMPLATE_NAMES.map((name) => ({
          name,
          description: builtinTemplate(name).description ?? "",
        }));
        return ok(
          `${builtins.length} built-in and ${listing.templates.length} saved template(s)` +
            (listing.skipped ? `; skipped ${listing.skipped} unusable file(s)` : "") +
            ".",
          { builtins, ...listing }
        );
      } catch (error) {
        return failure("listing templates", error);
      }
    }) as unknown as ToolCallback<Record<string, never>>
  );

  const showInput = {
    name: nameInput,
    expanded: z
      .boolean()
      .optional()
      .describe("Also return the fully expanded template (every rule filled from its base)"),
  };
  server.registerTool(
    "show-markdown-template",
    {
      description:
        "Use when: reading a built-in or saved template, to copy it as the start of a new one or to see what an export will do.\n" +
        "Returns: the template in its portable form (as saved, overrides only), its source, and with expanded: true every rule filled in.\n" +
        "Do not use when: listing names (list-markdown-templates).\n" +
        "Safety: read-only.",
      inputSchema: showInput,
      outputSchema: loose,
      annotations: { readOnlyHint: true },
    },
    (async ({ name, expanded }: { name: string; expanded?: boolean }) => {
      try {
        const builtin = isBuiltinTemplate(name);
        const template: PortableTemplate = builtin ? builtinTemplate(name) : store().get(name);
        const structured: Record<string, unknown> = {
          name,
          source: builtin ? "builtin" : "saved",
          template,
          ...(expanded ? { expanded: resolveTemplate(template, name) } : {}),
        };
        return ok(JSON.stringify(template, null, 2), structured);
      } catch (error) {
        return failure("showing template", error);
      }
    }) as unknown as ToolCallback<typeof showInput>
  );

  const validateInput = {
    name: nameInput.optional(),
    template: templateInput,
    templateFile: templateFileInput,
  };
  server.registerTool(
    "validate-markdown-template",
    {
      description:
        "Use when: checking a template before saving it or exporting with it.\n" +
        'Returns: valid true, or valid false with every problem as {path, message}, where path is a JSON path such as $.rules["inline.bold"].after.\n' +
        "Do not use when: you want to store it (save-markdown-template validates too).\n" +
        "Safety: read-only. Pass exactly one of name (a saved or built-in template), template (JSON object or text) or templateFile. templateFile reads only a regular .json file in home, temp or /Volumes, refusing hidden paths (~/.docker, .env) and ~/Library outside iCloud Drive and CloudStorage unless the server sets APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1; errors never quote the file.",
      inputSchema: validateInput,
      outputSchema: loose,
      annotations: { readOnlyHint: true },
    },
    (async (args: { name?: string; template?: unknown; templateFile?: string }) => {
      try {
        const given = [args.name, args.template, args.templateFile].filter(
          (value) => value !== undefined
        ).length;
        if (given !== 1)
          throw new Error("Provide exactly one of 'name', 'template' or 'templateFile'.");
        try {
          if (args.name !== undefined) {
            if (!isBuiltinTemplate(args.name)) store().get(args.name);
          } else parseTemplate(sourceText(args));
        } catch (error) {
          if (!(error instanceof TemplateValidationError)) throw error;
          return ok(
            `Invalid template (${error.errors.length} problem(s)):\n` +
              error.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
            { valid: false, errors: error.errors }
          );
        }
        return ok("The template is valid.", { valid: true, errors: [] });
      } catch (error) {
        return failure("validating template", error);
      }
    }) as unknown as ToolCallback<typeof validateInput>
  );

  const saveInput = {
    name: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Name to save under: lowercase a-z, 0-9, "-" and "_", starting with a letter or digit'
      ),
    template: templateInput,
    templateFile: templateFileInput,
    force: z
      .boolean()
      .optional()
      .describe("Replace an existing saved template of this name (default false: create-only)"),
  };
  server.registerTool(
    "save-markdown-template",
    {
      description:
        "Use when: storing a template so export-notes-markdown can use it by name.\n" +
        "Returns: name, path, bytes and whether an existing template was replaced.\n" +
        "Do not use when: exporting once (pass templateFile to export-notes-markdown instead).\n" +
        "Safety: writes one file in the template library only (APPLE_NOTES_MCP_TEMPLATE_DIR, default ~/Library/Application Support/apple-notes-mcp/templates, mode 0600). Validates first; an invalid template is refused with every JSON path. Create-only: an existing name is refused with [template-exists] unless force is true. Built-in names are reserved. templateFile follows the same read scope as validate-markdown-template.",
      inputSchema: saveInput,
      outputSchema: loose,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (async (args: { name: string; template?: unknown; templateFile?: string; force?: boolean }) => {
      try {
        const saved = store().save(args.name, sourceText(args), { force: args.force });
        return ok(
          `${saved.replaced ? "Replaced" : "Saved"} template "${args.name}" (${saved.bytes} bytes) at ${saved.path}.`,
          { name: args.name, path: saved.path, bytes: saved.bytes, replaced: saved.replaced }
        );
      } catch (error) {
        return failure("saving template", error);
      }
    }) as unknown as ToolCallback<typeof saveInput>
  );

  const deleteInput = { name: z.string().min(1).max(64).describe("Saved template to delete") };
  server.registerTool(
    "delete-markdown-template",
    {
      description:
        "Use when: removing a saved Markdown template the user no longer wants.\n" +
        "Returns: the name and the path of the removed file.\n" +
        "Do not use when: the template is built in (standard-markdown, obsidian cannot be deleted).\n" +
        "Safety: permanently removes one file from the template library; never touches Notes.",
      inputSchema: deleteInput,
      outputSchema: loose,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (async ({ name }: { name: string }) => {
      try {
        const removed = store().delete(name);
        return ok(`Deleted template "${name}" (${removed.path}).`, {
          name,
          path: removed.path,
          deleted: true,
        });
      } catch (error) {
        return failure("deleting template", error);
      }
    }) as unknown as ToolCallback<typeof deleteInput>
  );
}
