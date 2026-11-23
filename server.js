// Ghostwriter as an MCP App: the website, plus a thin layer for MCP hosts such as Claude.
//
//   /                         the website (site/): home, editor, and /api
//   POST /mcp                 Streamable HTTP MCP endpoint (stateless)
//   /auth/*, /authorize, ...  optional sign-in (auth/): off unless OIDC_ISSUER is set. Off, everything
//                             is open (a public prototype); on, the site, /api and /mcp need sign-in.
//   /vendor/ext-apps.js       the MCP Apps SDK's browser bundle, served from here for the view
//   GET  /healthz             liveness
//
// The MCP App's view IS the website: resources/read returns site/index.html with its asset URLs made
// absolute (viewHtml below), so Claude's sandbox loads and runs the site's own JavaScript, and the
// page keeps using the same /api. Nothing is bundled or copied; a deploy of the site is a deploy of
// the app. The page's host.js (loaded only inside a host) adds what a host can do.
//
// Model-facing tools: the same ones the page registers for an agent in the browser (site/tools.js),
// run here against the document named by `document_id`, plus list/create/open. They work whether or
// not the view is open; an open view picks up their edits as they happen (the page polls /api).
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Doc, SEED, ToolError, LIMITS } from "./site/model.js";
import { buildTools } from "./site/tools.js";
import { merge3 } from "./site/merge.js";
import { readAuthConfig, createAuth } from "./auth/index.js";

const DATA = process.env.DATA_DIR ?? path.join(import.meta.dirname, "data");
const PORT = Number(process.env.PORT ?? 3010);
const UI_URI = "ui://ghostwriter/v2/editor.html";
const SITE = path.join(import.meta.dirname, "site");
// Where the website is reachable from outside. The view's assets and API calls point here.
const ORIGIN = (process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const SDK_FILE = path.join(import.meta.dirname, "node_modules", "@modelcontextprotocol", "ext-apps", "dist", "src", "app-with-deps.js");
const MAX_DOCS = 200;

fs.mkdirSync(path.join(DATA, "docs"), { recursive: true });

// Optional sign-in (see auth/index.js). Null when OIDC_ISSUER is not set: everything stays open.
const auth = (() => {
  const cfg = readAuthConfig(process.env, { origin: ORIGIN, dataDir: DATA });
  return cfg ? createAuth(cfg) : null;
})();

/* ------------------------------ document store ----------------------------- */

// Libraries. Without sign-in there is one library, open to anyone (owner ""), kept in data/docs.
// With sign-in on, every person has their own library, kept in data/docs/<owner>/, where <owner>
// is a hash of the provider's subject id. Nobody can see, open or change another person's documents:
// every lookup below takes the caller's owner, and a document in someone else's library is "not found".
const ID_RE = /^[a-z0-9]{6,16}$/;
const OWNER_RE = /^u[0-9a-f]{24}$/;
const docsDir = path.join(DATA, "docs");
/** id -> { id, owner, doc, log: [{rev, kind, tool?, args?}], updated }. Ids are unique across libraries. */
const store = new Map();
const ownerDir = (owner) => (owner ? path.join(docsDir, owner) : docsDir);
/** The library a signed-in person owns. */
const ownerKey = (sub) => "u" + crypto.createHash("sha256").update(`ghostwriter-owner:${sub}`).digest("hex").slice(0, 24);
// With sign-in on, the documents from before libraries (data/docs/*.json) belong to nobody. Set
// UNOWNED_DOCS_OWNER to your email and they move into your library the first time you sign in
// (only when your provider says that email is verified).
const UNOWNED_OWNER = (process.env.UNOWNED_DOCS_OWNER ?? "").trim().toLowerCase();

const newId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 8; i++) id += abc[crypto.randomInt(abc.length)];
    if (!store.has(id)) return id;
  }
};

function loadEntry(id, data, updated, owner = "") {
  const doc = new Doc();
  doc.load(data);
  const entry = { id, owner, doc, log: [], updated, history: new Map() };
  remember(entry);
  store.set(id, entry);
}

/** Keep the last revisions of a document: a stale save is merged against the one it started from. */
const HISTORY_MAX = 40;
function remember(e) {
  e.history.set(e.doc.revision, JSON.stringify(e.doc.serialize()));
  while (e.history.size > HISTORY_MAX) e.history.delete(e.history.keys().next().value);
}

function persist(entry) {
  const file = path.join(ownerDir(entry.owner), entry.id + ".json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(entry.doc.serialize()));
  fs.renameSync(file + ".tmp", file);
}

// Load what is on disk: the open library, then each person's. The old single-document file becomes the first document.
function loadDir(owner) {
  const dir = ownerDir(owner);
  for (const f of fs.readdirSync(dir)) {
    const id = f.replace(/\.json$/, "");
    if (!f.endsWith(".json") || !ID_RE.test(id)) continue;
    try {
      loadEntry(id, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), fs.statSync(path.join(dir, f)).mtimeMs, owner);
    } catch (e) {
      console.error("skipping unreadable document", f, e.message);
    }
  }
}
loadDir("");
for (const d of fs.readdirSync(docsDir, { withFileTypes: true })) if (d.isDirectory() && OWNER_RE.test(d.name)) loadDir(d.name);
const legacy = path.join(DATA, "doc.json");
if (store.size === 0 && fs.existsSync(legacy)) {
  const id = newId();
  loadEntry(id, JSON.parse(fs.readFileSync(legacy, "utf8")), fs.statSync(legacy).mtimeMs);
  persist(store.get(id));
  fs.renameSync(legacy, legacy + ".migrated");
}
// The open library starts with a sample document. With sign-in on, each person's does (libraryOf).
if (!auth && store.size === 0) {
  const id = newId();
  loadEntry(id, SEED, Date.now());
  persist(store.get(id));
}

/**
 * The library a caller may use: "" without sign-in, otherwise the signed-in person's own. The first
 * time someone arrives, their library is made with a sample document in it (and, for the owner named
 * by UNOWNED_DOCS_OWNER, the documents from before libraries).
 */
function libraryOf(user) {
  if (!auth) return "";
  if (!user?.sub) throw new ToolError("Error: sign in to use Ghostwriter.", "unauthorized");
  const owner = ownerKey(user.sub);
  const dir = ownerDir(owner);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const claims = UNOWNED_OWNER && user.emailVerified === true && user.email?.toLowerCase() === UNOWNED_OWNER;
    const moved = claims ? claimUnowned(owner) : 0;
    if (!moved) {
      const id = newId();
      loadEntry(id, SEED, Date.now(), owner);
      persist(store.get(id));
    }
  }
  return owner;
}

/** Moves the open library's documents (and its removed ones, for undo) into one person's library. */
function claimUnowned(owner) {
  let n = 0;
  for (const f of fs.readdirSync(docsDir)) {
    const id = f.replace(/\.json(\.deleted)?$/, "");
    if (!/\.json(\.deleted)?$/.test(f) || !ID_RE.test(id)) continue;
    fs.renameSync(path.join(docsDir, f), path.join(ownerDir(owner), f));
    const e = store.get(id);
    if (e && e.owner === "") {
      e.owner = owner;
      n++;
    }
  }
  if (n) console.log(`moved ${n} documents from before libraries into their owner's library`);
  return n;
}

const words = (d) => {
  let n = (d.title.match(/\S+/g) ?? []).length;
  for (const node of d.nodes) {
    if (node.type === "list") for (const it of node.items) n += (it.text.match(/\S+/g) ?? []).length;
    else n += (node.text.match(/\S+/g) ?? []).length;
  }
  return n;
};

/** The first line of text, for naming a document that has no title. */
const preview = (d) => {
  for (const n of d.nodes) {
    const t = (n.type === "list" ? n.items[0]?.text : n.text)?.trim();
    if (t) return t.length > 60 ? t.slice(0, 59) + "…" : t;
  }
  return "";
};

const summarize = (e) => ({ id: e.id, title: e.doc.title || "Untitled", untitled: !e.doc.title.trim(), preview: preview(e.doc), words: words(e.doc), blocks: e.doc.nodes.length, revision: e.doc.revision, updated: e.updated });
/** For the web app's home screen: also the first lines of text, for the thumbnails. */
const lines = (d, max = 8) => {
  const out = [];
  for (const n of d.nodes) {
    if (out.length >= max) break;
    if (n.type === "list") {
      for (const it of n.items.slice(0, 3)) if (it.text.trim()) out.push({ type: "item", text: it.text.slice(0, 160) });
    } else if (n.text.trim()) out.push({ type: n.type, text: n.text.slice(0, 160) });
  }
  return out.slice(0, max);
};
const summarizeFull = (e) => ({ ...summarize(e), lines: lines(e.doc) });
const entriesOf = (owner) => [...store.values()].filter((e) => e.owner === owner);
const listDocs = (owner) => entriesOf(owner).map(summarize).sort((a, b) => b.updated - a.updated);

/** A document in this library. One in another library is "not found", exactly like one that doesn't exist. */
function getEntry(owner, id) {
  const e = typeof id === "string" ? store.get(id) : undefined;
  if (!e || e.owner !== owner) throw new ToolError(`Error: no document with id "${id}". Call list_documents for the ids, or create_document to start a new one.`, "not_found");
  return e;
}

function createDoc(owner, title, { sample = false } = {}) {
  if (entriesOf(owner).length >= MAX_DOCS) throw new ToolError(`Error: the library holds at most ${MAX_DOCS} documents.`, "too_many");
  const t = String(title ?? "").replace(/\s*\n+\s*/g, " ").trim();
  if (t.length > LIMITS.title) throw new ToolError(`Error: the title is ${t.length} characters; the limit is ${LIMITS.title}.`, "too_long");
  const id = newId();
  loadEntry(id, sample ? { ...SEED, title: t || SEED.title } : { title: t, nodes: [{ type: "paragraph", text: "" }] }, Date.now(), owner);
  persist(store.get(id));
  return store.get(id);
}

function copyDoc(owner, id) {
  const src = getEntry(owner, id);
  if (entriesOf(owner).length >= MAX_DOCS) throw new ToolError(`Error: the library holds at most ${MAX_DOCS} documents.`, "too_many");
  const copy = src.doc.snapshot();
  copy.title = `Copy of ${copy.title.trim() || "Untitled document"}`.slice(0, LIMITS.title);
  copy.revision = 1;
  const nid = newId();
  loadEntry(nid, copy, Date.now(), owner);
  persist(store.get(nid));
  return store.get(nid);
}

function renameDoc(owner, id, title) {
  const e = getEntry(owner, id);
  const t = String(title ?? "").replace(/\s*\n+\s*/g, " ").trim();
  if (t.length > LIMITS.title) throw new ToolError(`Error: the title is ${t.length} characters; the limit is ${LIMITS.title}.`, "too_long");
  const snap = e.doc.snapshot();
  snap.title = t;
  e.doc.load({ ...snap, revision: e.doc.revision + 1 });
  pushLog(e, { kind: "push" });
  touch(e);
  return e;
}

/** Undo a removal: the file was only renamed, so bring it back. */
function restoreDoc(owner, id) {
  if (!ID_RE.test(id)) throw new ToolError("Error: not a document id.", "not_found");
  if (store.has(id)) return getEntry(owner, id);
  const gone = path.join(ownerDir(owner), id + ".json.deleted");
  if (!fs.existsSync(gone)) throw new ToolError(`Error: there is no removed document with id "${id}".`, "not_found");
  loadEntry(id, JSON.parse(fs.readFileSync(gone, "utf8")), Date.now(), owner);
  fs.renameSync(gone, path.join(ownerDir(owner), id + ".json"));
  return store.get(id);
}

function removeDoc(owner, id) {
  const e = getEntry(owner, id);
  store.delete(id);
  fs.renameSync(path.join(ownerDir(owner), id + ".json"), path.join(ownerDir(owner), id + ".json.deleted"));
  return e;
}

const touch = (e) => {
  e.updated = Date.now();
  remember(e);
  persist(e);
};

const LOG_MAX = 200;
function pushLog(e, entry) {
  e.log.push({ rev: e.doc.revision, ...entry });
  while (e.log.length > LOG_MAX) e.log.shift();
}

/** What changed in one document since a revision, as replayable tool calls, or a snapshot. */
function pullDoc(owner, id, since) {
  const e = getEntry(owner, id);
  const doc = e.doc;
  if (since === doc.revision) return { revision: doc.revision, changes: [] };
  if (!Number.isInteger(since) || since < 0) return { revision: doc.revision, snapshot: doc.snapshot() };
  const after = e.log.filter((x) => x.rev > since);
  const contiguous = after.length === doc.revision - since && after.every((x) => x.kind === "tool");
  if (contiguous) return { revision: doc.revision, changes: after.map((x) => ({ tool: x.tool, args: x.args, rev: x.rev })) };
  return { revision: doc.revision, snapshot: doc.snapshot() };
}

/** The person's edits replace the document, if nothing changed on the server meanwhile. */
function pushDoc(owner, id, base, snapshot) {
  const e = getEntry(owner, id);
  const mine = validateSnapshot(snapshot);
  if (base === e.doc.revision) {
    e.doc.load({ ...mine, revision: e.doc.revision + 1 });
    pushLog(e, { kind: "push" });
    touch(e);
    return { conflict: false, revision: e.doc.revision };
  }
  // Someone else saved since this editor last synced. Merge its edits with theirs, if we still
  // have the revision it started from; otherwise the saved version stands.
  const started = e.history.get(base);
  if (!started) return { conflict: true, revision: e.doc.revision, snapshot: e.doc.snapshot() };
  const merged = validateSnapshot(merge3(JSON.parse(started), mine, e.doc.snapshot()));
  e.doc.load({ ...merged, revision: e.doc.revision + 1 });
  pushLog(e, { kind: "push" });
  touch(e);
  return { conflict: false, merged: true, revision: e.doc.revision, snapshot: e.doc.snapshot() };
}

/** A pushed snapshot is untrusted input like any tool call: same ceilings as the tools. */
function validateSnapshot(s) {
  const bad = (m) => {
    throw new ToolError(`Error: ${m}`);
  };
  if (!s || typeof s !== "object" || !Array.isArray(s.nodes) || !s.seq) bad("the document is malformed.");
  if (s.nodes.length > LIMITS.docNodes) bad("the document has too many blocks.");
  const str = (v, max) => typeof v === "string" && v.length <= max;
  if (!str(s.title ?? "", LIMITS.title)) bad("the title is too long.");
  for (const n of s.nodes) {
    if (!n || !["heading", "paragraph", "quote", "list"].includes(n.type) || typeof n.id !== "string") bad("a block is malformed.");
    if (n.type === "list") {
      if (!Array.isArray(n.items) || n.items.length > LIMITS.items) bad("a list is malformed.");
      for (const it of n.items) if (typeof it?.id !== "string" || !str(it.text, LIMITS.item)) bad("a list item is malformed.");
    } else if (!str(n.text, n.type === "heading" ? LIMITS.heading : LIMITS.text)) bad("a block's text is too long.");
  }
  return { title: s.title ?? "", nodes: s.nodes, seq: { n: Number(s.seq.n) || 0, i: Number(s.seq.i) || 0 } };
}

// One call at a time: tools mutate shared documents.
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

/* --------------------------------- tools ---------------------------------- */

// The selection and viewport tools read the person's screen, which the server can't see.
// The editor tells Claude what is selected, as context, instead.
const SCREEN_ONLY = new Set(["get_selection", "get_view", "replace_selection"]);
const template = buildTools(new Doc()).filter((d) => !SCREEN_ONLY.has(d.name));
const docToolNames = new Set(template.map((d) => d.name));

const READ = { readOnlyHint: true, openWorldHint: false, consequentialHint: false, untrustedContentHint: true };
// Creating a document only adds one; nothing already there is changed.
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, consequentialHint: false, untrustedContentHint: true };
const documentId = { type: "string", maxLength: 16, description: "Which document. Ids come from list_documents (or create_document)." };

/** The website's tool definitions with a document_id added to each. */
const docTools = template.map((d) => ({
  ...d,
  inputSchema: {
    ...d.inputSchema,
    properties: { document_id: documentId, ...d.inputSchema.properties },
    required: ["document_id", ...(d.inputSchema.required ?? [])],
  },
  description: d.description + " Pass document_id.",
}));

// The tool that opens the view. "openai/ui" entry points let people open the app from Claude's
// Artifacts page without asking Claude, so every argument is optional and no argument means the list.
const uiMeta = { ui: { resourceUri: UI_URI }, "ui/resourceUri": UI_URI, "openai/ui": { entrypoints: [{ type: "global" }] } };
const ok = (text, structured) => ({ content: [{ type: "text", text }], structuredContent: structured });

const extraTools = [
  {
    name: "list_documents",
    title: "List documents",
    description: "Lists the documents in the library with their ids, titles, word counts and when they were last changed (newest first). Call this to find a document before reading or editing it.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: async (_args, owner) => {
      const docs = listDocs(owner);
      const lines = docs.map((d) => `${d.id}  "${d.title}"  ${d.words} words  changed ${new Date(d.updated).toISOString()}`);
      return ok(`${docs.length} documents (newest first):\n${lines.join("\n")}`, { documents: docs });
    },
  },
  {
    name: "create_document",
    title: "Create a document",
    description: "Creates a new, empty document and returns its id. Then fill it with insert_nodes, or open it for the person with open_document.",
    inputSchema: { type: "object", properties: { title: { type: "string", maxLength: LIMITS.title, description: "The document's title. May be empty." } } },
    annotations: ADD,
    run: async ({ title }, owner) => {
      const e = createDoc(owner, title);
      return ok(`Created document ${e.id} ("${e.doc.title || "Untitled"}"). It has one empty paragraph.`, summarize(e));
    },
  },
  {
    name: "open_document",
    title: "Ghostwriter",
    description:
      "Shows the Ghostwriter editor to the person in a new card, so they can read and edit while you work. With a document_id it shows that document; without one it shows the list of documents. Call it when the person asks to see or reopen the editor, or to show a different document. Do not call it again after each edit: your edits appear live in the card they already have, and every call adds another card to the conversation (older cards switch themselves off, only the newest stays live). You cannot tell whether an earlier card is still on screen, so if the person says they cannot see it or it looks blank or stuck, call it again rather than assuming it is open. You do not need the editor to read or edit documents: the other tools work either way.",
    inputSchema: { type: "object", properties: { document_id: { ...documentId, description: "Optional. Omit to show the document list." } } },
    annotations: READ,
    _meta: uiMeta,
    run: async ({ document_id }, owner) => {
      // The election key: stored in the transcript with this result, so the cards in a conversation
      // agree on which one is newest however late each is mounted (see site/supersede.js).
      const key = nextViewKey();
      if (document_id === undefined) {
        const docs = listDocs(owner);
        return ok(`Showed the editor on the list of ${docs.length} documents. The person chooses which to open. Call open_document again any time to show it again.`, { view: "list", count: docs.length, ...key });
      }
      const e = getEntry(owner, document_id);
      const s = summarize(e);
      return ok(`Showed the editor on "${s.title}" (${e.id}, ${s.blocks} blocks). Use get_document with document_id "${e.id}" to read it. Call open_document again any time to show it again.`, { view: "doc", id: e.id, title: s.title, ...key });
    },
  },
];

/** {createdAt, seq}: createdAt is wall-clock; seq is strictly increasing within this process, so two calls in one millisecond (or after a clock step back) still order. */
let viewSeq = 0;
let lastViewAt = 0;
function nextViewKey() {
  lastViewAt = Math.max(Date.now(), lastViewAt);
  return { createdAt: lastViewAt, seq: ++viewSeq };
}

const allTools = [...docTools, ...extraTools];

/**
 * With sign-in on: the editor view (not the model) calls this through the host to get a token for
 * /api. It is the person's own MCP connection asking, so the token is theirs; it lasts an hour.
 */
const viewTokenTool = {
  name: "get_view_token",
  title: "Editor session",
  description: "Used by the Ghostwriter editor view to load documents. Not for the assistant.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false, consequentialHint: false },
  _meta: { ui: { visibility: ["app"] } },
  run: async (extra) => {
    const user = extra?.authInfo?.extra?.user;
    if (!user) return { content: [{ type: "text", text: "Not signed in." }], isError: true };
    const { token, expiresAt } = auth.viewToken(user, extra.authInfo.clientId);
    return { content: [{ type: "text", text: "Editor session ready." }], structuredContent: { token, expiresAt } };
  },
};
const toolByName = new Map(allTools.map((t) => [t.name, t]));

/** Runs one tool call for a person (their user, or none without sign-in). Document tools are rebuilt against the named document each time. */
async function runTool(name, args, user) {
  const def = toolByName.get(name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  return serial(async () => {
    try {
      const owner = libraryOf(user);
      if (!docToolNames.has(name)) return await def.run(args, owner);
      const { document_id, ...rest } = args;
      const e = getEntry(owner, document_id);
      const bound = buildTools(e.doc).find((t) => t.name === name);
      const before = e.doc.revision;
      const result = await bound.run(rest);
      // A model edit is one that moved the revision by exactly one; the editor can replay it.
      if (!result.isError && e.doc.revision !== before) {
        pushLog(e, e.doc.revision === before + 1 ? { kind: "tool", tool: name, args: rest } : { kind: "push" });
        touch(e);
      }
      return result;
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `Error: ${err?.message ?? "the action failed."}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });
}

/* ----------------------------------- the view ----------------------------------- */

/**
 * The view is the website's own index.html. Its asset paths ("/main.js") are made absolute so they
 * load from this site when the page is shown in a host's sandbox, and a small script tells the page
 * it is embedded and where home is. Read on every call, so the view is always the deployed site.
 */
/** A short id of the deployed site files, so a card can say which build it is running. */
function siteBuild() {
  const h = crypto.createHash("sha1");
  for (const f of fs.readdirSync(SITE).sort()) {
    const full = path.join(SITE, f);
    if (fs.statSync(full).isFile()) h.update(f).update(fs.readFileSync(full));
  }
  return h.digest("hex").slice(0, 8);
}
const BUILD = siteBuild();

export function viewHtml(origin = ORIGIN) {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const absolute = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${origin}/`);
  // Set before anything paints, so the first frame already has the embedded layout (inline until the host says otherwise).
  const boot = `<script>window.__GHOSTWRITER__=${JSON.stringify({ origin, embedded: true, ...(auth ? { auth: true } : {}) }).replace(/</g, "\\u003c")};window.__GHOSTWRITER_BUILD__=${JSON.stringify(BUILD)};document.documentElement.dataset.embedded="";document.documentElement.dataset.display="inline";</script>`;
  if (!absolute.includes("</head>")) throw new Error("site/index.html has no </head>");
  return absolute.replace("</head>", `  ${boot}\n</head>`);
}

/* ------------------------------- MCP server ------------------------------- */

function makeServer() {
  const server = new Server({ name: "ghostwriter", version: "0.2.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...allTools, ...(auth ? [viewTokenTool] : [])].map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: d.inputSchema,
      annotations: d.annotations,
      ...(d._meta ? { _meta: d._meta } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
    if (auth && req.params.name === viewTokenTool.name) return viewTokenTool.run(extra);
    return runTool(req.params.name, req.params.arguments ?? {}, extra?.authInfo?.extra?.user);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: UI_URI, name: "Ghostwriter editor", mimeType: RESOURCE_MIME_TYPE }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== UI_URI) throw new Error(`Unknown resource: ${req.params.uri}`);
    return {
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          // With sign-in on, the view needs a token for /api (cookies don't reach the host's sandbox). It
          // is not put in this HTML, which hosts cache and may share; the view asks for one through the
          // host with get_view_token (site/host.js).
          text: viewHtml(),
          _meta: {
            ui: {
              // The view loads the site's own scripts and styles and calls its /api, so only this
              // origin (and the font host the site already uses) is declared.
              csp: { connectDomains: [ORIGIN], resourceDomains: [ORIGIN, "https://fonts.googleapis.com", "https://fonts.gstatic.com"] },
              prefersBorder: true,
              // Claude-only: open in the side panel where there is one (a document is the thing the
              // person and Claude work on together). Elsewhere it stays an inline card.
              preferredDisplayMode: "fullscreen",
            },
          },
        },
      ],
    };
  });

  return server;
}

/* ---------------------------------- HTTP ---------------------------------- */

const app = express();
app.disable("x-powered-by");
// Behind a reverse proxy, the client's address (for rate limits on sign-in endpoints) comes from
// X-Forwarded-For. By default only a proxy on this machine is trusted; behind one on another address
// (a Docker network, say) set TRUST_PROXY to it, e.g. "uniquelocal" or its IP.
app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback");
// Documents can be big; /register (open to anyone when sign-in is on) gets its own 8 KB parser in auth/.
const json = express.json({ limit: "1mb" });
app.use((req, res, next) => (req.path === "/register" ? next() : json(req, res, next)));

// The view is served from the host's sandbox, so the site's files and API are fetched cross-origin.
// Everything here is public (no cookies, no credentials), so any origin may read it.
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// The MCP Apps SDK, for the page to load when it is shown in a host (host.js imports it).
app.get("/vendor/ext-apps.js", (_req, res) => {
  res.type("text/javascript").set("Cache-Control", "public, max-age=3600").send(fs.readFileSync(SDK_FILE));
});

// Sign-in pages, the OAuth endpoints and their metadata (only when sign-in is on).
if (auth) app.use(auth.router);

const mcpGuard = auth ? auth.mcpGuard : (_req, _res, next) => next();
app.all("/mcp", mcpGuard, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("mcp error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// The website's editor. Without sign-in it is open on purpose (a public prototype): anyone who can
// reach the site can read, edit and remove documents, and so can anyone who adds the /mcp connector.
// With sign-in on, auth.apiGuard in front of it lets only signed-in, allowed people through.
const api = express.Router();
api.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
if (auth) api.use("/session", auth.session);
else api.get("/session", (_req, res) => res.json({ auth: false, user: null }));
/** Runs fn with the caller's library (the open one without sign-in) and sends what it returns. */
const send = (req, res, fn) =>
  serial(async () => {
    try {
      res.json(fn(libraryOf(req.user)));
    } catch (e) {
      if (e instanceof ToolError) return res.status(e.code === "not_found" ? 404 : e.code === "unauthorized" ? 401 : 400).json({ error: e.code, message: e.message });
      console.error("api error", e);
      res.status(500).json({ error: "error", message: "Something went wrong." });
    }
  });
const listFull = (owner) => ({ documents: entriesOf(owner).map(summarizeFull).sort((a, b) => b.updated - a.updated) });
api.get("/docs", (req, res) => send(req, res, listFull));
api.post("/docs", (req, res) =>
  send(req, res, (owner) => {
    const e = createDoc(owner, req.body?.title, { sample: req.body?.sample === true });
    return { ...summarize(e), snapshot: e.doc.snapshot() };
  }),
);
api.post("/docs/:id/copy", (req, res) => send(req, res, (owner) => summarizeFull(copyDoc(owner, req.params.id))));
api.post("/docs/:id/restore", (req, res) => send(req, res, (owner) => summarizeFull(restoreDoc(owner, req.params.id))));
api.patch("/docs/:id", (req, res) => send(req, res, (owner) => summarizeFull(renameDoc(owner, req.params.id, req.body?.title))));
api.get("/docs/:id", (req, res) =>
  send(req, res, (owner) => {
    const e = getEntry(owner, req.params.id);
    return { ...summarize(e), snapshot: e.doc.snapshot() };
  }),
);
api.delete("/docs/:id", (req, res) => send(req, res, (owner) => (removeDoc(owner, req.params.id), listFull(owner))));
api.get("/docs/:id/pull", (req, res) => send(req, res, (owner) => pullDoc(owner, req.params.id, Number.parseInt(req.query.since ?? "-1", 10))));
api.post("/docs/:id/push", (req, res) => send(req, res, (owner) => pushDoc(owner, req.params.id, req.body?.base, req.body?.snapshot)));
app.use("/api", ...(auth ? [auth.apiGuard] : []), api);

// The website itself, so one app answers the whole domain.
app.use(express.static(SITE, { extensions: ["html"], dotfiles: "allow", setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const HOST = process.env.HOST ?? "127.0.0.1";
  app.listen(PORT, HOST, () => {
    console.log(`ghostwriter listening on ${HOST}:${PORT} with ${store.size} documents; ${auth ? auth.describe() : "sign-in off (open to anyone who can reach it)"}`);
    console.log("MCP endpoint path: /mcp");
  });
}

export { app, store };
