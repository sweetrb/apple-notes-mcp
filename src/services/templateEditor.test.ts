/**
 * The template editor's HTTP server, exercised for real on 127.0.0.1 with an
 * ephemeral port and a temporary template library. Every server started here
 * is closed in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTemplateEditor, type TemplateEditorHandle } from "./templateEditor.js";
import { TemplateStore } from "./templateStore.js";
import { builtinTemplate } from "../utils/markdownTemplate.js";
import { templateSamples } from "../utils/templateSamples.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

/** A raw request, so tests control Host, Origin and every other header. */
function send(
  editor: TemplateEditorHandle,
  {
    method = "GET",
    path = "/",
    headers = {},
    body,
  }: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: editor.port,
        method,
        path,
        headers: { Host: `127.0.0.1:${editor.port}`, Connection: "close", ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
            json: () => JSON.parse(text),
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let dir: string;
let store: TemplateStore;
const open: TemplateEditorHandle[] = [];
const start = async (options: Parameters<typeof startTemplateEditor>[0] = {}) => {
  const editor = await startTemplateEditor({ store, ...options });
  open.push(editor);
  return editor;
};
const auth = (editor: TemplateEditorHandle) => ({ Authorization: `Bearer ${editor.token}` });
const post = (editor: TemplateEditorHandle, path: string, value: unknown, extra = {}) =>
  send(editor, {
    method: "POST",
    path,
    headers: {
      ...auth(editor),
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${editor.port}`,
      ...extra,
    },
    body: JSON.stringify(value),
  });
const standardText = () => JSON.stringify(builtinTemplate("standard-markdown"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "template-editor-"));
  store = new TemplateStore(join(dir, "templates"));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((editor) => editor.close()));
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("listening", () => {
  it("binds 127.0.0.1 on an ephemeral port and prints a token URL", async () => {
    const editor = await start();
    expect(editor.host).toBe("127.0.0.1");
    expect(editor.port).toBeGreaterThan(0);
    expect(editor.token).toMatch(/^[0-9a-f]{64}$/);
    expect(editor.url).toBe(`http://127.0.0.1:${editor.port}/?token=${editor.token}`);
  });

  it("uses a new token each run", async () => {
    const a = await start();
    const b = await start();
    expect(a.token).not.toBe(b.token);
    expect(a.port).not.toBe(b.port);
  });

  it("refuses to open a saved template that does not exist", async () => {
    await expect(start({ name: "missing" })).rejects.toThrow(/No saved template/);
  });

  it("close() stops accepting connections and resolves closed", async () => {
    const editor = await start();
    await editor.close();
    await expect(editor.closed).resolves.toBe("closed");
    await expect(send(editor, { headers: auth(editor) })).rejects.toThrow();
  });
});

describe("token", () => {
  it("rejects a request without the token", async () => {
    const editor = await start();
    const reply = await send(editor, { path: "/api/state" });
    expect(reply.status).toBe(401);
    expect(reply.json().error.code).toBe("unauthorized");
    expect(reply.body).not.toContain(editor.token);
  });

  it("rejects a wrong token of the right length", async () => {
    const editor = await start();
    const wrong = editor.token.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    expect((await send(editor, { path: `/?token=${wrong}` })).status).toBe(401);
    expect(
      (await send(editor, { path: "/api/state", headers: { Authorization: `Bearer ${wrong}` } }))
        .status
    ).toBe(401);
  });

  it("accepts the token in the query or as a Bearer header", async () => {
    const editor = await start();
    expect((await send(editor, { path: `/?token=${editor.token}` })).status).toBe(200);
    expect((await send(editor, { path: "/api/state", headers: auth(editor) })).status).toBe(200);
  });

  it("gates POST too", async () => {
    const editor = await start();
    const reply = await post(
      editor,
      "/api/save",
      { name: "x", template: standardText() },
      {
        Authorization: "Bearer nope",
      }
    );
    expect(reply.status).toBe(401);
    expect(store.list().templates).toEqual([]);
  });
});

describe("origin and host checks", () => {
  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const editor = await start();
    const reply = await send(editor, {
      path: `/?token=${editor.token}`,
      headers: { Host: `evil.example:${editor.port}` },
    });
    expect(reply.status).toBe(421);
  });

  it("rejects a cross-origin request even with the token", async () => {
    const editor = await start();
    const reply = await send(editor, {
      path: "/api/state",
      headers: { ...auth(editor), Origin: "http://evil.example" },
    });
    expect(reply.status).toBe(403);
    expect(reply.json().error.code).toBe("cross-origin");
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects Sec-Fetch-Site cross-site", async () => {
    const editor = await start();
    const reply = await send(editor, {
      path: `/?token=${editor.token}`,
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(reply.status).toBe(403);
  });

  it("rejects a POST without the editor's Origin", async () => {
    const editor = await start();
    const reply = await send(editor, {
      method: "POST",
      path: "/api/save",
      headers: { ...auth(editor), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", template: standardText() }),
    });
    expect(reply.status).toBe(403);
    expect(store.list().templates).toEqual([]);
  });

  it("rejects a form-encoded POST (what a cross-site form can send)", async () => {
    const editor = await start();
    const reply = await post(
      editor,
      "/api/save",
      {},
      {
        "Content-Type": "application/x-www-form-urlencoded",
      }
    );
    expect(reply.status).toBe(415);
  });

  it("rejects an oversized body", async () => {
    const editor = await start();
    const reply = await post(editor, "/api/preview", { template: "x".repeat(600 * 1024) });
    expect(reply.status).toBe(413);
  });
});

describe("page", () => {
  it("serves one self-contained page with a nonce CSP", async () => {
    const editor = await start();
    const reply = await send(editor, { path: `/?token=${editor.token}` });
    expect(reply.headers["content-type"]).toMatch(/^text\/html/);
    const csp = String(reply.headers["content-security-policy"]);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(reply.body).toContain(`<script nonce="${nonce}">`);
    expect(reply.body).not.toMatch(/\bsrc=|<link\b|https?:\/\//);
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-frame-options"]).toBe("DENY");
    expect(reply.body).not.toContain(editor.token);
  });

  it("uses a fresh nonce per page load", async () => {
    const editor = await start();
    const a = await send(editor, { path: `/?token=${editor.token}` });
    const b = await send(editor, { path: `/?token=${editor.token}` });
    expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
  });

  it("404s an unknown path", async () => {
    const editor = await start();
    expect((await send(editor, { path: "/nope", headers: auth(editor) })).status).toBe(404);
  });
});

describe("api", () => {
  it("reports state: built-ins, saved templates, samples and the initial template", async () => {
    store.save("mine", standardText());
    const editor = await start({ name: "mine" });
    const state = (await send(editor, { path: "/api/state", headers: auth(editor) })).json();
    expect(state.builtins).toEqual(["standard-markdown", "obsidian"]);
    expect(state.saved).toEqual(["mine"]);
    expect(state.samples.map((s: { id: string }) => s.id)).toEqual([
      "structure",
      "inline",
      "attachments",
    ]);
    expect(state.initial).toMatchObject({ name: "mine", source: "saved" });
  });

  it("opens a template by name", async () => {
    const editor = await start();
    const reply = await send(editor, {
      path: "/api/template?name=obsidian",
      headers: auth(editor),
    });
    expect(reply.json()).toMatchObject({ name: "obsidian", source: "builtin" });
    const missing = await send(editor, { path: "/api/template?name=zzz", headers: auth(editor) });
    expect(missing.status).toBe(404);
  });

  it("previews a valid template against a sample", async () => {
    const editor = await start();
    const reply = (
      await post(editor, "/api/preview", { template: standardText(), sample: "structure" })
    ).json();
    expect(reply.valid).toBe(true);
    expect(reply.markdown).toContain("# Weekly Plan");
    expect(reply.markdown).toContain("- [x] Done task");
  });

  it("previews through the obsidian template with sample metadata", async () => {
    const editor = await start();
    const reply = (
      await post(editor, "/api/preview", {
        template: JSON.stringify(builtinTemplate("obsidian")),
        sample: "attachments",
      })
    ).json();
    expect(reply.valid).toBe(true);
    expect(reply.markdown.startsWith("---\n")).toBe(true);
    expect(reply.markdown).toContain("travel");
  });

  it("returns validation problems with JSON paths instead of a preview", async () => {
    const editor = await start();
    const bad = await post(editor, "/api/preview", {
      template: JSON.stringify({ schemaVersion: 1, rules: { "block.nope": { mode: "wrap" } } }),
    });
    expect(bad.status).toBe(200);
    const body = bad.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0].path).toContain("block.nope");
    expect(body.markdown).toBe("");

    const syntax = (await post(editor, "/api/preview", { template: "{ nope" })).json();
    expect(syntax.valid).toBe(false);
    expect(syntax.errors[0].message).toMatch(/not valid JSON/);
  });

  it("refuses an unknown sample, and the real note unless one was given", async () => {
    const editor = await start();
    for (const sample of ["zzz", "note"]) {
      const reply = await post(editor, "/api/preview", { template: standardText(), sample });
      expect(reply.status).toBe(400);
    }
  });

  it("previews a caller-supplied note when one was given", async () => {
    const real = templateSamples()[1];
    const editor = await start({
      note: { note: { ...real.note, title: "Real" }, meta: real.meta },
    });
    const state = (await send(editor, { path: "/api/state", headers: auth(editor) })).json();
    expect(state.samples.at(-1)).toEqual({ id: "note", label: "Note: Real" });
    const reply = (
      await post(editor, "/api/preview", { template: standardText(), sample: "note" })
    ).json();
    expect(reply.markdown).toContain("**Bold**");
  });

  it("saves through the template store, create-only unless force", async () => {
    const editor = await start();
    const first = await post(editor, "/api/save", {
      name: "notes-vault",
      template: standardText(),
    });
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({ name: "notes-vault", replaced: false });
    expect(JSON.parse(readFileSync(first.json().path, "utf8")).schemaVersion).toBe(1);

    const again = await post(editor, "/api/save", {
      name: "notes-vault",
      template: standardText(),
    });
    expect(again.status).toBe(409);
    expect(again.json().error.code).toBe("template-exists");

    const forced = await post(editor, "/api/save", {
      name: "notes-vault",
      template: standardText(),
      force: true,
    });
    expect(forced.json().replaced).toBe(true);
  });

  it("refuses reserved names, bad names and invalid templates", async () => {
    const editor = await start();
    const reserved = await post(editor, "/api/save", {
      name: "obsidian",
      template: standardText(),
    });
    expect(reserved.json().error.code).toBe("reserved-name");
    const badName = await post(editor, "/api/save", { name: "../x", template: standardText() });
    expect(badName.json().error.code).toBe("invalid-name");
    const invalid = await post(editor, "/api/save", {
      name: "ok",
      template: '{"schemaVersion":2}',
    });
    expect(invalid.status).toBe(422);
    expect(invalid.json().error.errors.length).toBeGreaterThan(0);
    expect(store.list().templates).toEqual([]);
  });

  it("does not leak internal error details", async () => {
    writeFileSync(join(dir, "templates"), "not a directory");
    const editor = await startTemplateEditor({ store });
    open.push(editor);
    const reply = await send(editor, { path: "/api/state", headers: auth(editor) });
    expect(reply.status).toBe(500);
    expect(reply.json().error).toEqual({
      code: "internal-error",
      message: "The editor could not complete the request.",
    });
  });
});

describe("idle shutdown", () => {
  it("closes itself after the idle period with no requests", async () => {
    const editor = await start({ idleMs: 50 });
    await expect(editor.closed).resolves.toBe("idle");
    await expect(send(editor, { headers: auth(editor) })).rejects.toThrow();
  });

  it("each authorized request restarts the idle timer", async () => {
    const editor = await start({ idleMs: 300 });
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 150));
      expect((await send(editor, { path: "/api/state", headers: auth(editor) })).status).toBe(200);
    }
    await expect(editor.closed).resolves.toBe("idle");
  });

  it("idleMs 0 never closes on its own", async () => {
    const editor = await start({ idleMs: 0 });
    const winner = await Promise.race([
      editor.closed,
      new Promise((r) => setTimeout(() => r("still open"), 100)),
    ]);
    expect(winner).toBe("still open");
  });
});
