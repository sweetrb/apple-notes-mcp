/**
 * A local web editor for Markdown export templates
 * (`apple-notes-mcp templates edit`).
 *
 * One HTTP server serves one self-contained page (no external scripts, styles
 * or fonts) and a small JSON API. The page edits template JSON; every edit is
 * validated by {@link parseTemplate} and rendered by
 * {@link renderNotesWithTemplate} against the built-in sample notes, or against
 * one real note the user named on the command line, read once, read-only.
 * Saving goes through {@link TemplateStore.save}, so it is create-only unless
 * the user ticks "replace".
 *
 * Exposure rules:
 * - Binds 127.0.0.1 by default (the `--tailnet` caller passes a Tailscale
 *   address instead). Port 0 picks a free port.
 * - A random per-run token is required on every request, as `?token=` or
 *   `Authorization: Bearer`, compared in constant time. It is never logged.
 * - The Host header must name the bound address, which stops DNS rebinding.
 * - A request with an Origin or Sec-Fetch-Site from another site is refused.
 *   POST also needs the page's own Origin and a JSON content type, so a form
 *   post from another page cannot reach the API.
 * - Responses carry a strict Content-Security-Policy with a per-run nonce,
 *   no-referrer (the token is in the URL), and no-store.
 * - The server closes after an idle period with no requests.
 *
 * The editor never writes to Notes. The only file it writes is a saved
 * template in the template library.
 *
 * @module services/templateEditor
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { emptyStats } from "../utils/exportRender.js";
import {
  bearerToken,
  crossOriginRefusal,
  hostAuthority,
  newServerToken,
  tokenMatches,
} from "../utils/localServer.js";
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
import type { ExportNote } from "../utils/noteExportData.js";
import { renderNotesWithTemplate, type NoteTemplateMeta } from "../utils/templateRender.js";
import { templateSamples } from "../utils/templateSamples.js";
import { TemplateStore, TemplateStoreError } from "./templateStore.js";
import { templateEditorPage } from "./templateEditorPage.js";

/** Default idle period before the editor shuts itself down. */
export const DEFAULT_EDITOR_IDLE_MS = 30 * 60 * 1000;

/** Largest request body accepted: a template at the size cap, JSON-escaped, plus fields. */
const MAX_EDITOR_BODY_BYTES = MAX_TEMPLATE_BYTES * 2 + 4096;

/** A real note to preview against, loaded once by the caller (read-only). */
export interface EditorNote {
  note: ExportNote;
  meta: NoteTemplateMeta;
}

export interface TemplateEditorOptions {
  /** Address to bind. Default 127.0.0.1. */
  host?: string;
  /** Port to bind; 0 (default) picks a free one. */
  port?: number;
  /** Close after this many milliseconds without a request. 0 disables. */
  idleMs?: number;
  /** Template to open: a built-in or saved name. Default standard-markdown. */
  name?: string;
  /** Template library. Default: the configured library directory. */
  store?: TemplateStore;
  /** A real note to offer as a preview source. */
  note?: EditorNote;
  /** Fixed token (tests). Default: 32 random bytes as hex. */
  token?: string;
}

export type EditorCloseReason = "idle" | "closed";

export interface TemplateEditorHandle {
  /** The address to open, token included. Treat it as a secret. */
  url: string;
  host: string;
  port: number;
  token: string;
  /** Resolves once the server has closed, with why. */
  closed: Promise<EditorCloseReason>;
  /** Stop the server and drop every open connection. */
  close(): Promise<void>;
}

class EditorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: Array<{ path: string; message: string }>
  ) {
    super(message);
  }
}

/** The editor prefers the Authorization header over `?token=`. */
function editorPresentedToken(req: IncomingMessage, url: URL): string | undefined {
  return bearerToken(req)?.trim() ?? url.searchParams.get("token") ?? undefined;
}

const CROSS_ORIGIN_MESSAGE = {
  "cross-site": "Cross-site requests are refused.",
  "foreign-origin": "Cross-origin requests are refused.",
  "missing-origin": "POST requires the editor's own Origin.",
} as const;

async function readEditorJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type))
    throw new EditorHttpError(415, "unsupported-media-type", "Send JSON (application/json).");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_EDITOR_BODY_BYTES)
      throw new EditorHttpError(413, "too-large", "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EditorHttpError(400, "bad-request", "Request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new EditorHttpError(400, "bad-request", "Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

const editorStringField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string")
    throw new EditorHttpError(400, "bad-request", `"${key}" must be a string.`);
  return value;
};

/** Start the editor. Resolves once the server is listening. */
export async function startTemplateEditor(
  options: TemplateEditorOptions = {}
): Promise<TemplateEditorHandle> {
  const host = options.host ?? "127.0.0.1";
  const idleMs = options.idleMs ?? DEFAULT_EDITOR_IDLE_MS;
  const store = options.store ?? new TemplateStore();
  const token = options.token ?? newServerToken();
  const samples = templateSamples();

  const initialName = options.name ?? "standard-markdown";
  const initial: PortableTemplate = isBuiltinTemplate(initialName)
    ? builtinTemplate(initialName)
    : store.get(initialName);
  const initialSource = isBuiltinTemplate(initialName) ? "builtin" : "saved";

  let origin = "";
  let hostHeader = "";
  let idleTimer: NodeJS.Timeout | undefined;
  let closeReason: EditorCloseReason = "closed";
  const sockets = new Set<Socket>();

  const loadTemplate = (name: string) => {
    if (isBuiltinTemplate(name))
      return { name, source: "builtin", template: builtinTemplate(name) };
    return { name, source: "saved", template: store.get(name) };
  };

  const state = () => {
    const listing = store.list();
    return {
      builtins: BUILTIN_TEMPLATE_NAMES,
      saved: listing.templates.map((t) => t.name),
      dir: listing.dir,
      samples: [
        ...samples.map((s) => ({ id: s.id, label: s.label })),
        ...(options.note ? [{ id: "note", label: `Note: ${options.note.note.title}` }] : []),
      ],
      initial: { name: initialName, source: initialSource, template: initial },
    };
  };

  const preview = (body: Record<string, unknown>) => {
    const text = editorStringField(body, "template");
    const sampleId = typeof body.sample === "string" ? body.sample : samples[0].id;
    const source =
      sampleId === "note" && options.note ? options.note : samples.find((s) => s.id === sampleId);
    if (!source) throw new EditorHttpError(400, "bad-request", `Unknown sample "${sampleId}".`);
    let portable: PortableTemplate;
    try {
      portable = parseTemplate(text);
    } catch (error) {
      if (error instanceof TemplateValidationError)
        return { valid: false, errors: error.errors, markdown: "", warnings: [] };
      throw error;
    }
    const result = renderNotesWithTemplate(
      [source.note],
      { stats: emptyStats() },
      {
        template: resolveTemplate(portable),
        exportStem: "preview",
        metaFor: () => source.meta,
      }
    );
    return { valid: true, errors: [], markdown: result.markdown, warnings: result.warnings };
  };

  const save = (body: Record<string, unknown>) => {
    const name = editorStringField(body, "name");
    const text = editorStringField(body, "template");
    const force = body.force === true;
    try {
      const saved = store.save(name, text, { force });
      return { name, path: saved.path, bytes: saved.bytes, replaced: saved.replaced };
    } catch (error) {
      if (error instanceof TemplateValidationError)
        throw new EditorHttpError(
          422,
          "invalid-template",
          "The template is invalid.",
          error.errors
        );
      if (error instanceof TemplateStoreError && error.code === "template-exists")
        throw new EditorHttpError(
          409,
          error.code,
          `A template named "${name}" already exists. Tick "Replace an existing template" to replace it.`
        );
      if (error instanceof TemplateStoreError)
        throw new EditorHttpError(400, error.code, error.message);
      throw error;
    }
  };

  const send = (
    res: ServerResponse,
    status: number,
    type: string,
    body: string,
    extra: Record<string, string> = {}
  ) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      ...extra,
    });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs > 0)
      idleTimer = setTimeout(() => {
        closeReason = "idle";
        void close();
      }, idleMs);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Host first: a rebound DNS name reaches this socket with a foreign Host.
    if (req.headers.host !== hostHeader)
      throw new EditorHttpError(421, "wrong-host", "Unexpected Host header.");
    const url = new URL(req.url ?? "/", origin);
    if (!tokenMatches(editorPresentedToken(req, url), token))
      throw new EditorHttpError(401, "unauthorized", "Missing or wrong token.");
    const refusal = crossOriginRefusal(req, origin, req.method === "POST");
    if (refusal) throw new EditorHttpError(403, "cross-origin", CROSS_ORIGIN_MESSAGE[refusal]);
    touch();

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /": {
        const nonce = randomBytes(16).toString("base64");
        return send(res, 200, "text/html; charset=utf-8", templateEditorPage(nonce), {
          "Content-Security-Policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; " +
            "frame-ancestors 'none'",
        });
      }
      case "GET /api/state":
        return sendJson(res, 200, state());
      case "GET /api/template": {
        const name = url.searchParams.get("name") ?? "";
        try {
          return sendJson(res, 200, loadTemplate(name));
        } catch (error) {
          if (error instanceof TemplateStoreError)
            throw new EditorHttpError(404, error.code, error.message);
          if (error instanceof TemplateValidationError)
            throw new EditorHttpError(
              422,
              "invalid-template",
              "The saved template is invalid.",
              error.errors
            );
          throw error;
        }
      }
      case "POST /api/preview":
        return sendJson(res, 200, preview(await readEditorJson(req)));
      case "POST /api/save":
        return sendJson(res, 200, save(await readEditorJson(req)));
      default:
        throw new EditorHttpError(404, "not-found", "Not found.");
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const http =
        error instanceof EditorHttpError
          ? error
          : new EditorHttpError(
              500,
              "internal-error",
              "The editor could not complete the request."
            );
      if (!res.headersSent)
        sendJson(res, http.status, {
          error: {
            code: http.code,
            message: http.message,
            ...(http.errors ? { errors: http.errors } : {}),
          },
        });
      else res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let resolveClosed!: (reason: EditorCloseReason) => void;
  const closed = new Promise<EditorCloseReason>((resolve) => (resolveClosed = resolve));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      if (idleTimer) clearTimeout(idleTimer);
      server.close(() => {
        resolveClosed(closeReason);
        resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: options.port ?? 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const authority = hostAuthority(host, port);
  origin = `http://${authority}`;
  hostHeader = authority;
  touch();

  return { url: `${origin}/?token=${token}`, host, port, token, closed, close };
}
