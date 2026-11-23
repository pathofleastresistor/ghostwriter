import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
process.env.DATA_DIR = dir;
process.env.PUBLIC_ORIGIN = "https://notes.example.test";

const { app } = await import("../server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

let http, client, url;
before(async () => {
  await new Promise((r) => (http = app.listen(0, "127.0.0.1", r)));
  url = `http://127.0.0.1:${http.address().port}`;
  client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
});
after(async () => {
  await client.close();
  http.close();
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const data = async (name, args) => {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
};
const api = (method, p, body) =>
  fetch(`${url}/api${p}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });

// What the page does, over the same /api the website uses.
const pull = async (id, since) => (await api("GET", `/docs/${id}/pull?since=${since}`)).json();
const push = async (id, base, snapshot) => (await api("POST", `/docs/${id}/push`, { base, snapshot })).json();

test("the MCP endpoint is /mcp: POST only, and the old /mcp/<token> paths are gone", async () => {
  const get = await fetch(`${url}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const old = await fetch(`${url}/mcp/anything`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(old.status, 404);
});

test("tools: every document tool takes a document_id; library tools exist; screen tools and sync plumbing are not offered", async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_documents", "create_document", "open_document", "get_document", "replace_text", "insert_nodes", "set_title"]) assert.ok(by[n], n);
  for (const n of ["get_selection", "get_view", "replace_selection"]) assert.ok(!by[n], `${n} reads the screen; only the page can offer it`);
  assert.deepEqual(tools.filter((t) => t.name.startsWith("app_")), [], "the page syncs through /api; there are no app-only tools");
  for (const n of ["get_document", "replace_text", "insert_nodes", "delete_nodes", "set_title"]) {
    assert.ok(by[n].inputSchema.required.includes("document_id"), n);
    assert.ok(by[n].inputSchema.properties.document_id, n);
  }
  assert.ok(!(by.open_document.inputSchema.required ?? []).includes("document_id"), "no argument means the list");
});

test("directory annotations: every tool over MCP has a title, readOnlyHint, and destructiveHint on writes", async () => {
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(t.title, `${t.name} needs a title`);
    assert.ok(t.name.length <= 64, `${t.name} is too long`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", t.name);
    if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, "boolean", `${t.name} must set destructiveHint`);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(by.create_document.destructiveHint, false);
  assert.equal(by.insert_nodes.destructiveHint, false);
  assert.equal(by.delete_nodes.destructiveHint, true);
  assert.equal(by.replace_text.destructiveHint, true);
});

test("open_document carries the view, and is an entry point people can open from Claude's Artifacts page", async () => {
  const { tools } = await client.listTools();
  const open = tools.find((t) => t.name === "open_document");
  assert.equal(open._meta.ui.resourceUri, "ui://ghostwriter/v2/editor.html");
  assert.equal(open._meta["ui/resourceUri"], "ui://ghostwriter/v2/editor.html");
  assert.deepEqual(open._meta["openai/ui"], { entrypoints: [{ type: "global" }] });
  assert.ok(open.title.length <= 60 && !/claude|anthropic/i.test(open.title));
  assert.doesNotMatch(open.name, /__|\.\.|\._|_\./, "a name the entry point accepts");
  assert.ok(!open._meta.ui.visibility, "visible to the model");
});

test("open_document stamps each result with an increasing election key, so older cards can switch themselves off", async () => {
  const call = async (args) => (await client.callTool({ name: "open_document", arguments: args })).structuredContent;
  const a = await call({});
  const b = await call({});
  const c = await call({});
  for (const r of [a, b, c]) assert.ok(Number.isFinite(r.createdAt) && Number.isInteger(r.seq));
  assert.ok(b.seq > a.seq && c.seq > b.seq, "seq strictly increases");
  assert.ok(b.createdAt >= a.createdAt && c.createdAt >= b.createdAt, "createdAt never goes back");
});

test("open_document says a new card isn't needed after an edit, describing what it does rather than ordering the model", async () => {
  const { tools } = await client.listTools();
  const d = tools.find((t) => t.name === "open_document").description;
  assert.match(d, /a new card isn't needed after an edit/);
  assert.match(d, /older cards stop updating/);
  // Anthropic's directory rejects tool descriptions that tell Claude how to behave.
  assert.doesNotMatch(d, /\b(Do not|Don't|Never|Always|You must)\b/);
});

test("the view is the website's own page, with absolute URLs and the right permissions", async () => {
  const { contents } = await client.readResource({ uri: "ui://ghostwriter/v2/editor.html" });
  const c = contents[0];
  assert.match(c.mimeType, /mcp-app/);
  const site = fs.readFileSync(path.join(import.meta.dirname, "..", "site", "index.html"), "utf8");
  const origin = "https://notes.example.test";
  // same page: every element of the site's index.html is there, only the asset paths differ
  assert.equal(c.text.replace(/ *<script>window\.__GHOSTWRITER__.*?<\/script>\n/s, "").replaceAll(origin + "/", "/"), site);
  assert.match(c.text, new RegExp(`<script type="module" src="${origin}/main\\.js">`));
  assert.match(c.text, new RegExp(`<link rel="stylesheet" href="${origin}/app\\.css">`));
  assert.doesNotMatch(c.text, /(?:href|src)="\/(?!\/)/, "no asset path is left relative");
  assert.match(c.text, /window\.__GHOSTWRITER__=\{"origin":"https:\/\/notes\.example\.test","embedded":true\}/);
  assert.match(c.text, /dataset\.embedded="";document\.documentElement\.dataset\.display="inline"/, "the first paint already has the embedded layout");
  // the permissions it needs, and no more
  const ui = c._meta.ui;
  assert.deepEqual(ui.csp.connectDomains, [origin]);
  assert.deepEqual(ui.csp.resourceDomains, [origin, "https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
  assert.equal(ui.csp.frameDomains, undefined, "it embeds nothing");
  assert.equal(ui.preferredDisplayMode, "fullscreen");
  // every origin the page loads from is declared
  const hosts = new Set([...c.text.matchAll(/(?:href|src)="(https?:\/\/[^/"]+)/g)].map((m) => m[1]));
  for (const h of hosts) assert.ok(ui.csp.resourceDomains.includes(h) || h === origin, `${h} is loaded but not declared`);
});

test("the site's files, its API and the SDK can be read from the host's sandbox (CORS)", async () => {
  for (const p of ["/main.js", "/app.css", "/api/docs", "/vendor/ext-apps.js"]) {
    const r = await fetch(`${url}${p}`, { headers: { Origin: "https://abc.claudemcpcontent.com" } });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("access-control-allow-origin"), "*", p);
  }
  const pre = await fetch(`${url}/api/docs`, { method: "OPTIONS", headers: { Origin: "https://abc.claudemcpcontent.com", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods"), /PATCH/);
  assert.match(pre.headers.get("access-control-allow-headers"), /Content-Type/i);
  const sdk = await (await fetch(`${url}/vendor/ext-apps.js`)).text();
  assert.match(sdk, /export\s*\{[^}]*\bApp\b/, "the bundle exports App");
  // the MCP endpoint is not opened up the same way
  const mcp = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(mcp.headers.get("access-control-allow-origin"), null);
});

let sample;
test("a fresh library holds the sample document", async () => {
  const { documents } = await data("list_documents");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, "Weekend at the lake");
  sample = documents[0].id;
});

let mine;
test("create_document, then edit it by id; the other document is untouched", async () => {
  const c = await data("create_document", { title: "Packing list" });
  mine = c.id;
  assert.match(mine, /^[a-z0-9]{8}$/);
  await data("insert_nodes", { document_id: mine, position: "end", nodes: [{ type: "paragraph", text: "Sunscreen and towels." }] });
  const text = JSON.stringify(await data("get_document", { document_id: mine }));
  assert.match(text, /Packing list/);
  assert.match(text, /Sunscreen and towels/);
  const other = JSON.stringify(await data("get_document", { document_id: sample }));
  assert.doesNotMatch(other, /Packing list|Sunscreen and towels/);
  assert.equal((await data("list_documents")).documents.length, 2);
});

test("an untitled document is named by its first line in the list", async () => {
  const c = await data("create_document", {});
  await data("insert_nodes", { document_id: c.id, position: "end", nodes: [{ type: "paragraph", text: "Ideas for the garden bed" }] });
  const d = (await data("list_documents")).documents.find((x) => x.id === c.id);
  assert.equal(d.untitled, true);
  assert.equal(d.preview, "Ideas for the garden bed");
  assert.equal(d.title, "Untitled");
  await api("DELETE", `/docs/${c.id}`);
});

test("an unknown document id is an error that says what to do", async () => {
  const r = await call("get_document", { document_id: "nope1234" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /list_documents/);
});

test("open_document: no id means the list, an id means that document", async () => {
  const list = await data("open_document");
  assert.equal(list.view, "list");
  const one = await data("open_document", { document_id: sample });
  assert.deepEqual({ view: one.view, id: one.id }, { view: "doc", id: sample });
  assert.ok(one.title);
  assert.equal((await call("open_document", { document_id: "nope1234" })).isError, true);
});

test("a model edit is replayable per document through /pull", async () => {
  const snap = (await pull(sample, -1)).snapshot;
  await data("set_title", { document_id: sample, title: "Weekend at the cabin" });
  const got = await pull(sample, snap.revision);
  assert.equal(got.changes.length, 1);
  assert.equal(got.changes[0].tool, "set_title");
  assert.equal(got.changes[0].args.document_id, undefined, "the replayed args are the tool's own");
  assert.equal(got.revision, snap.revision + 1);
  // the other document has no changes
  const o = await pull(mine, (await pull(mine, -1)).revision);
  assert.deepEqual(o.changes, []);
});

test("the person's push is accepted at the right base", async () => {
  const cur = (await pull(sample, -1)).snapshot;
  cur.title = "Typed by hand";
  const r = await push(sample, cur.revision, cur);
  assert.equal(r.conflict, false);
  assert.ok(!r.merged);
  assert.equal((await data("get_document", { document_id: sample })).title, "Typed by hand");
});

test("a save from a stale editor is merged with what was saved meanwhile", async () => {
  const cur = (await pull(sample, -1)).snapshot;
  // Claude edits the first goal; meanwhile the person (still at the old revision) edits the Packing list.
  await data("replace_text", { document_id: sample, heading: "Goals", block: 1, text: "Claude's goal text." });
  const mine = JSON.parse(JSON.stringify(cur));
  const packing = mine.nodes.find((n) => n.type === "list" && n.items.some((i) => /Sunscreen/.test(i.text)));
  packing.items.find((i) => /Sunscreen/.test(i.text)).text = "Sunscreen, SPF 50";
  const r = await push(sample, cur.revision, mine);
  assert.equal(r.conflict, false);
  assert.equal(r.merged, true);
  const text = JSON.stringify(r.snapshot);
  assert.match(text, /Claude's goal text\./, "the other edit is kept");
  assert.match(text, /Sunscreen, SPF 50/, "my edit is kept");
  assert.equal(r.snapshot.revision, r.revision);
  assert.match(JSON.stringify(await data("get_document", { document_id: sample })), /Sunscreen, SPF 50/);
});

test("a save that started from a revision the server no longer remembers is a conflict; the saved version stands", async () => {
  const cur = (await pull(sample, -1)).snapshot;
  await data("set_title", { document_id: sample, title: "Claude was here" });
  cur.title = "too late";
  const r = await push(sample, -5, cur);
  assert.equal(r.conflict, true);
  assert.equal(r.snapshot.title, "Claude was here");
});

test("a pushed snapshot obeys the same ceilings as the tools", async () => {
  const cur = (await pull(sample, -1)).snapshot;
  cur.nodes[0].text = "x".repeat(6000);
  assert.equal((await api("POST", `/docs/${sample}/push`, { base: cur.revision, snapshot: cur })).status, 400);
});

test("the web API is open (no key), and is never cached; so is the MCP endpoint", async () => {
  const r = await api("GET", "/docs");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const mcp = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(mcp.status, 200);
});

test("the website and Claude see the same documents", async () => {
  const created = await (await api("POST", "/docs", { title: "From the website" })).json();
  // Claude finds it
  const { documents } = await data("list_documents");
  assert.ok(documents.some((d) => d.id === created.id && d.title === "From the website"));
  // Claude edits it; the website's pull replays that edit
  await data("set_title", { document_id: created.id, title: "Edited by Claude" });
  const pull = await (await api("GET", `/docs/${created.id}/pull?since=${created.revision}`)).json();
  assert.equal(pull.changes[0].tool, "set_title");
  // the website saves; Claude reads it
  const snap = (await (await api("GET", `/docs/${created.id}`)).json()).snapshot;
  snap.title = "Saved from the website";
  const pushed = await (await api("POST", `/docs/${created.id}/push`, { base: snap.revision, snapshot: snap })).json();
  assert.equal(pushed.conflict, false);
  assert.equal((await data("get_document", { document_id: created.id })).title, "Saved from the website");
  // delete from the website; gone for Claude
  assert.equal((await api("DELETE", `/docs/${created.id}`)).status, 200);
  assert.equal((await call("get_document", { document_id: created.id })).isError, true);
  assert.equal((await api("GET", `/docs/${created.id}`)).status, 404);
});

test("the home screen API: list with snippets, rename, copy, remove and undo, sample", async () => {
  const j = async (r) => r.json();
  const made = await j(await api("POST", "/docs", { title: "Trip notes" }));
  await data("insert_nodes", { document_id: made.id, position: "end", nodes: [{ type: "heading", level: 2, text: "Day one" }, { type: "paragraph", text: "Arrive and unpack." }] });
  const list = (await j(await api("GET", "/docs"))).documents;
  const row = list.find((d) => d.id === made.id);
  assert.equal(row.title, "Trip notes");
  assert.deepEqual(row.lines.map((l) => l.text), ["Day one", "Arrive and unpack."]);

  const renamed = await j(await api("PATCH", `/docs/${made.id}`, { title: "Trip to the coast" }));
  assert.equal(renamed.title, "Trip to the coast");
  assert.equal((await data("get_document", { document_id: made.id })).title, "Trip to the coast");
  assert.equal((await api("PATCH", `/docs/${made.id}`, { title: "x".repeat(300) })).status, 400);

  const copy = await j(await api("POST", `/docs/${made.id}/copy`));
  assert.equal(copy.title, "Copy of Trip to the coast");
  assert.notEqual(copy.id, made.id);
  assert.match(JSON.stringify(await data("get_document", { document_id: copy.id })), /Arrive and unpack/);

  assert.equal((await api("DELETE", `/docs/${copy.id}`)).status, 200);
  assert.equal((await api("GET", `/docs/${copy.id}`)).status, 404);
  const back = await j(await api("POST", `/docs/${copy.id}/restore`));
  assert.equal(back.title, "Copy of Trip to the coast");
  assert.equal((await api("GET", `/docs/${copy.id}`)).status, 200);
  assert.equal((await api("POST", `/docs/nope1234/restore`)).status, 404);

  const demo = await j(await api("POST", "/docs", { title: "Demo", sample: true }));
  assert.ok(demo.blocks > 3);
  for (const id of [made.id, copy.id, demo.id]) await api("DELETE", `/docs/${id}`);
});

test("the website is served at / and its tools page at /.well-known/tools", async () => {
  const home = await fetch(`${url}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Ghostwriter/);
  assert.equal((await fetch(`${url}/api.js`)).status, 200);
  assert.equal((await fetch(`${url}/.well-known/tools`)).status, 200);
  assert.equal((await fetch(`${url}/.token`)).status, 404);
  assert.equal((await fetch(`${url}/docs/${sample}.json`)).status, 404);
});

test("documents are files on disk, one per id", () => {
  const files = fs.readdirSync(path.join(dir, "docs")).filter((f) => f.endsWith(".json"));
  assert.ok(files.includes(`${sample}.json`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "docs", `${sample}.json`), "utf8")).title, "Claude was here");
});

test("the old single document becomes the first document on upgrade", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "gw-old-"));
  fs.writeFileSync(path.join(old, "doc.json"), JSON.stringify({ title: "From the old file", nodes: [{ id: "n1", type: "paragraph", text: "hi" }], revision: 7, seq: { n: 1, i: 0 } }));
  const out = execFileSync("node", ["-e", 'import("./server.js").then(m=>{const d=[...m.store.values()];console.log(d.length+"|"+d[0].doc.title+"|"+d[0].doc.revision)})'], {
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, DATA_DIR: old },
  }).toString().trim();
  assert.equal(out, "1|From the old file|7");
  assert.ok(fs.existsSync(path.join(old, "doc.json.migrated")));
});

test("removed documents can be brought back for 30 days, then they are deleted for good", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gw-purge-"));
  fs.mkdirSync(path.join(d, "docs"));
  const body = JSON.stringify({ title: "x", nodes: [{ type: "paragraph", text: "x" }] });
  for (const id of ["oldgone1", "newgone1"]) fs.writeFileSync(path.join(d, "docs", `${id}.json.deleted`), body);
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(d, "docs", "oldgone1.json.deleted"), old, old);
  execFileSync("node", ["-e", 'import("./server.js").then(()=>process.exit(0))'], { cwd: path.join(import.meta.dirname, ".."), env: { ...process.env, DATA_DIR: d } });
  assert.ok(!fs.existsSync(path.join(d, "docs", "oldgone1.json.deleted")), "removed 31 days ago: gone");
  assert.ok(fs.existsSync(path.join(d, "docs", "newgone1.json.deleted")), "removed today: can still be restored");
});

test("every deploy is identifiable and never served stale: the view carries a build id and site files revalidate", async () => {
  const { contents } = await client.readResource({ uri: "ui://ghostwriter/v2/editor.html" });
  assert.match(contents[0].text, /window\.__GHOSTWRITER_BUILD__="[0-9a-f]{8}"/);
  const res = await fetch(`${url}/main.js`);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the help and privacy pages the directory listing links to are public", async () => {
  for (const [p, must] of [["/help", /Troubleshooting/], ["/privacy", /How long we keep it/]]) {
    const r = await fetch(`${url}${p}`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, must);
    assert.match(html, /mailto:/, `${p} has a contact`);
  }
});
