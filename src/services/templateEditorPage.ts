/**
 * The template editor's single page: inline style and script only, so it
 * loads nothing from the network. The script writes text with textContent,
 * never HTML, and sends the run token from the page URL as a Bearer header.
 *
 * @module services/templateEditorPage
 */

const EDITOR_STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1d1d1f; --muted: #6e6e73;
  --panel: #ffffff; --border: #d2d2d7; --accent: #0a66d8; --bad: #c1272d; --ok: #1f7a3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f7; --muted: #a1a1a6;
  --panel: #2c2c2e; --border: #3a3a3c; --accent: #4c9bff; --bad: #ff6b6b; --ok: #4cd07d; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px;
  border-bottom: 1px solid var(--border); background: var(--panel); }
header h1 { font-size: 15px; margin: 0 12px 0 0; }
label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); }
select, input, button, textarea { font: inherit; color: var(--fg); background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px 16px;
  height: calc(100vh - 110px); min-height: 360px; }
@media (max-width: 800px) { main { grid-template-columns: 1fr; height: auto; } }
section { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
h2 { font-size: 13px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
textarea { flex: 1; min-height: 300px; width: 100%; resize: none;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { flex: 1; margin: 0; overflow: auto; padding: 8px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px; min-height: 300px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
ul { margin: 6px 0 0; padding-left: 18px; max-height: 120px; overflow: auto; }
.bad { color: var(--bad); } .ok { color: var(--ok); } .muted { color: var(--muted); }
footer { padding: 0 16px 12px; }
`;

const EDITOR_SCRIPT = `
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, body === undefined
    ? { headers: { Authorization: "Bearer " + token } }
    : { method: "POST", headers: { Authorization: "Bearer " + token,
        "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || res.statusText);
    e.detail = data.error; throw e; }
  return data;
};
const setText = (id, text, cls) => { const el = $(id); el.textContent = text;
  el.className = cls || ""; };
const list = (id, items) => { const ul = $(id); ul.replaceChildren();
  for (const item of items) { const li = document.createElement("li");
    li.textContent = item; ul.append(li); } };
let timer;
async function refresh() {
  try {
    const out = await api("/api/preview", { template: $("json").value, sample: $("sample").value });
    if (out.valid) setText("status", "Valid template.", "ok");
    else setText("status", out.errors.length + " problem(s):", "bad");
    list("errors", out.errors.map((e) => e.path + ": " + e.message));
    list("warnings", out.warnings.map((w) => w.code + (w.attachmentId ? " (" + w.attachmentId + ")" : "")));
    $("preview").textContent = out.valid ? out.markdown : "";
  } catch (e) { setText("status", "Preview failed: " + e.message, "bad"); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };
async function load(name) {
  try {
    const out = await api("/api/template?name=" + encodeURIComponent(name));
    $("json").value = JSON.stringify(out.template, null, 2) + "\\n";
    $("name").value = out.source === "saved" ? out.name : "";
    refresh();
  } catch (e) { setText("status", "Could not open " + name + ": " + e.message, "bad"); }
}
async function save() {
  try {
    const out = await api("/api/save", { name: $("name").value.trim(),
      template: $("json").value, force: $("force").checked });
    setText("saved", (out.replaced ? "Replaced " : "Saved ") + out.name + " at " + out.path, "ok");
    $("force").checked = false;
    await fillPicker(out.name);
  } catch (e) {
    const errors = (e.detail && e.detail.errors) || [];
    setText("saved", e.message + (errors.length ? " " + errors.map((x) => x.path + ": " + x.message).join("; ") : ""), "bad");
  }
}
async function fillPicker(selected) {
  const state = await api("/api/state");
  const picker = $("picker"); picker.replaceChildren();
  const group = (label, names) => { const g = document.createElement("optgroup");
    g.label = label; for (const n of names) { const o = document.createElement("option");
      o.value = n; o.textContent = n; g.append(o); } picker.append(g); };
  group("Built-in", state.builtins);
  if (state.saved.length) group("Saved", state.saved);
  picker.value = selected;
  setText("dir", "Library: " + state.dir, "muted");
  return state;
}
(async () => {
  try {
    const state = await fillPicker("");
    const sample = $("sample");
    for (const s of state.samples) { const o = document.createElement("option");
      o.value = s.id; o.textContent = s.label; sample.append(o); }
    $("picker").value = state.initial.name;
    $("json").value = JSON.stringify(state.initial.template, null, 2) + "\\n";
    $("name").value = state.initial.source === "saved" ? state.initial.name : "";
    $("json").addEventListener("input", schedule);
    sample.addEventListener("change", refresh);
    $("picker").addEventListener("change", () => load($("picker").value));
    $("save").addEventListener("click", save);
    refresh();
  } catch (e) { setText("status", "Could not start: " + e.message, "bad"); }
})();
`;

const EDITOR_BODY = `
<header>
  <h1>Markdown template editor</h1>
  <label>Open <select id="picker"></select></label>
  <label>Preview <select id="sample"></select></label>
  <span id="dir" class="muted"></span>
</header>
<main>
  <section>
    <h2>Template JSON</h2>
    <textarea id="json" spellcheck="false" aria-label="Template JSON"></textarea>
    <div id="status" role="status"></div>
    <ul id="errors" class="bad"></ul>
  </section>
  <section>
    <h2>Markdown preview</h2>
    <pre id="preview" aria-label="Markdown preview"></pre>
    <ul id="warnings" class="muted" aria-label="Warnings"></ul>
  </section>
</main>
<footer>
  <label>Save as <input id="name" placeholder="my-template" maxlength="64" autocomplete="off"></label>
  <label><input id="force" type="checkbox"> Replace an existing template</label>
  <button id="save" type="button">Save</button>
  <span id="saved" role="status"></span>
</footer>
`;

/** The page, with `nonce` on its one style and one script element. */
export function templateEditorPage(nonce: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>Template Editor</title><style nonce="${nonce}">${EDITOR_STYLE}</style></head>` +
    `<body>${EDITOR_BODY}<script nonce="${nonce}">${EDITOR_SCRIPT}</script></body></html>`
  );
}
