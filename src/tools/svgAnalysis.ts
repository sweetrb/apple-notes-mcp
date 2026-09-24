/**
 * `analyze-svg`: standalone, non-mutating SVG preflight.
 *
 * Reads one local SVG file and reports whether it converts cleanly into
 * editable monoline strokes, which visible losses the conversion needs, and a
 * digest that binds that exact result. It opens no Notes data and makes no
 * network request. See utils/svgAnalyzer.ts for the analysis itself.
 *
 * @module tools/svgAnalysis
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowedSaveRoots, readAllowedFile } from "../utils/attachmentFs.js";
import { CodedError, errorResult } from "../utils/errorCodes.js";
import { SVG_LIMITS, SvgError, analyzeSvgBuffer } from "../utils/svgAnalyzer.js";

export interface SvgAnalysisArgs {
  path: string;
  includeDrawing?: boolean;
}

/**
 * Run the analysis for one tool call. Throws CodedError on refusal.
 *
 * The file is read under the same policy as `create-note`'s `contentPath` and
 * `add-attachment`'s `path` (see readAllowedFile): a regular file in home,
 * temp or /Volumes, never a symlink, with hidden paths and `~/Library` outside
 * iCloud Drive and `~/Library/CloudStorage` refused unless
 * APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1.
 */
export function runSvgAnalysis(
  args: SvgAnalysisArgs,
  roots: string[] = allowedSaveRoots()
): Record<string, unknown> {
  let source: Buffer;
  try {
    source = readAllowedFile(args.path, SVG_LIMITS.maxSourceBytes, { roots, label: "SVG file" });
  } catch (error) {
    throw new CodedError((error as Error).message, {
      code: "validation_error",
      svgCode: "svg_file_invalid",
    });
  }
  try {
    const result = analyzeSvgBuffer(source);
    return {
      ...result.analysis,
      ...(args.includeDrawing ? { drawing: result.drawing } : {}),
    };
  } catch (error) {
    if (error instanceof SvgError)
      throw new CodedError(`SVG refused (${error.code}): ${error.message}`, {
        code: "validation_error",
        svgCode: error.code,
        ...(error.location ? { location: error.location } : {}),
      });
    throw error;
  }
}

export function registerSvgAnalysis(server: McpServer) {
  const inputSchema = {
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        `Absolute path of one .svg file (home, temp, or /Volumes; not a hidden path or ~/Library outside iCloud Drive and CloudStorage; not a symbolic link; at most ${SVG_LIMITS.maxSourceBytes} bytes of UTF-8)`
      ),
    includeDrawing: z
      .boolean()
      .optional()
      .describe(
        "Also return the normalized drawing (strokes with sRGB color, width and points). Off by default: it can be large."
      ),
  };
  server.registerTool(
    "analyze-svg",
    {
      description:
        "Use when: checking whether an SVG file can be represented as editable monoline strokes, and what that conversion would approximate or drop.\n" +
        "Returns: classification (safe, lossy, unsupported), importable, defaultWriteAllowed, requiredLosses (geometry-approximation, paint-approximation, drop-content), issues with element locations, counts and work budgets, the source SHA-256, and analysisDigest, a SHA-256 over the canonical analysis and normalized drawing. includeDrawing adds the drawing.\n" +
        "Do not use when: you want to attach the SVG file itself to a note (add-attachment).\n" +
        "Safety: read-only and local. Opens no Notes data and makes no network request. Reads only a regular file in home, temp or /Volumes, refusing hidden paths (~/.ssh, .env) and ~/Library outside iCloud Drive and CloudStorage unless the server sets APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS=1; a file whose root element is not <svg> is refused without quoting it. Scripts, event handlers, style elements, animation, DOCTYPE/entities and external resources are refused with svgCode svg_unsafe; malformed files with svg_invalid; oversized work with svg_complexity_limit.",
      inputSchema,
      outputSchema: z.object({ classification: z.string().optional() }).passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (async (args: SvgAnalysisArgs) => {
      try {
        const result = runSvgAnalysis(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), error);
      }
    }) as unknown as ToolCallback<typeof inputSchema>
  );
}
