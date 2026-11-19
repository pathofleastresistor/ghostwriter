import { buildMessage, describeResult, SUGGESTIONS } from "./ask.js";
import { Doc } from "./model.js";
const DocClass = Doc;
import { LIMITS } from "./model.js";
import { buildTools, registerTools } from "./tools.js";
import { View, sound } from "./view.js";
import { createDemo } from "./demo.js";
import { createSync } from "./sync.js";
import { createApi } from "./api.js";
import { renderDocs, closeMenu } from "./home.js";
import { captureErrors, connectorUrl } from "./debuglog.js";
import { mountMenu } from "./debug.js";

captureErrors();

const $ = (s) => document.querySelector(s);

const PREF_LAYOUT = "ghostwriter:layout";
let host = null; // set when the page is shown inside an MCP host such as Claude (see host.js)
let selectedText = "";
const api = createApi();

/* ---------------------------------- screens --------------------------------- */

function screen(name) {
  document.body.dataset.screen = name;
  $("#home").hidden = name !== "home";
  $("#editor-screen").hidden = name !== "editor";
  if (name !== "home") closeMenu();
}

/** A short message at the bottom, with an optional Undo. */
let snackTimer = null;
function snack(text, undo) {
  $("#snack-text").textContent = text;
  const btn = $("#snack-undo");
  btn.hidden = !undo;
  btn.onclick = undo
    ? () => {
        hideSnack();
        undo();
      }
    : null;
  $("#snack").hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideSnack, undo ? 7000 : 4000);
}
function hideSnack() {
  clearTimeout(snackTimer);
  $("#snack").hidden = true;
}

/* -------------------------------- the document -------------------------------- */

const doc = new Doc();
doc.load({ title: "", nodes: [{ type: "paragraph", text: "" }] });

const view = new View(doc, {
  root: $("#editor"),
  onStatus: setStatus,
  onHistory: ({ undo, redo }) => {
    $("#undo").disabled = !undo;
    $("#redo").disabled = !redo;
  },
  onSelection: (sel) => showSelection(sel),
  onShape: (key) => {
    document.querySelectorAll(".tool[data-block]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.block === key)));
  },
});

/* ------------------------------- status strip ------------------------------ */

function setStatus(s) {
  const box = $("#agent-status");
  $("#status-chip").textContent = "Your agent is writing";
  box.hidden = !s;
  $("#status-text").textContent = s ? s.label : "";
}

/* What the agent can see of the person's selection, shown in the toolbar. */
let readTimer = null;
function showSelection(sel) {
  const chip = $("#sel-chip");
  if (readTimer) return; // an "agent read it" notice is showing
  const text = sel && !sel.collapsed ? sel.parts.map((p) => p.text).join(" ") : "";
  selectedText = text.trim();
  host?.changed();
  const words = text.split(/\s+/).filter(Boolean).length;
  chip.hidden = !words;
  chip.className = "polr-chip polr-chip--tag";
  chip.textContent = `Your agent can see ${words} ${words === 1 ? "word" : "words"}`;
}
function agentRead(name) {
  const chip = $("#sel-chip");
  chip.hidden = false;
  chip.className = "polr-chip polr-chip--info";
  chip.textContent = name === "get_view" ? "Your agent looked at your screen" : "Your agent read your selection";
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    readTimer = null;
    showSelection(view.lastSel);
  }, 2500);
}

function showRev() {
  $("#rev").textContent = "r" + doc.revision;
}

/* ----------------------- workspace chrome: name, counts, outline ---------------------- */

const wordsOf = (t) => (t.match(/\S+/g) ?? []).length;
function docText() {
  const parts = [doc.title];
  for (const n of doc.nodes) {
    if (n.type === "list") n.items.forEach((i) => parts.push(i.text));
    else parts.push(n.text);
  }
  return parts.join("\n");
}

function renderOutline() {
  const list = $("#outline");
  list.replaceChildren();
  const heads = doc.headings();
  $("#outline-empty").hidden = heads.length > 0;
  for (const h of heads) {
    const li = document.createElement("li");
    li.className = "l" + h.level;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = h.text || "(empty heading)";
    b.addEventListener("click", () => {
      const el = view.leaf(h.id) ?? view.blockEl(h.id);
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      view.flash(h.id);
    });
    li.append(b);
    list.append(li);
  }
}

function showChrome() {
  const name = doc.title.trim() || "Untitled document";
  document.title = (doc.title.trim() ? doc.title.trim() + " · " : "") + "Ghostwriter";
  const input = $("#docname");
  if (document.activeElement !== input) input.value = doc.title;
  const text = docText();
  const words = wordsOf(text);
  const label = `${words} ${words === 1 ? "word" : "words"}`;
  $("#stat-words").textContent = label;
  $("#stat-chars").textContent = `${text.replace(/\s/g, "").length} characters`;
  renderOutline();
}

/* The name in the app bar and the title line of the page are the same thing. */
$("#docname").addEventListener("input", (e) => {
  if (!sync.id) return;
  const t = e.target.value.replace(/\s*\n+\s*/g, " ").slice(0, LIMITS.title);
  const el = view.titleEl;
  if (el) view.setText(el, t);
  doc.title = t;
  doc.userChanged();
});
$("#docname").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    view.focusStart();
  }
});

/* ------------------------------- change log -------------------------------- */

const logEl = $("#changes");
let entrySeq = 0;

const OP_CHIP = { replaced: "polr-chip--info", inserted: "polr-chip--good", deleted: "polr-chip--danger" };

function nodeLine(d, cls) {
  const li = document.createElement("div");
  li.className = "node " + cls;
  const id = document.createElement("span");
  id.className = "id";
  id.textContent = d.id;
  li.append(id, document.createTextNode(DocClass.repr(d.type === "list_item" ? { type: "paragraph", text: d.text } : d.type === "title" ? { type: "paragraph", text: d.text || "(empty)" } : d)));
  return li;
}

function addEntry(change) {
  $("#changes-empty").hidden = true;
  const li = document.createElement("li");
  li.className = "change";
  li.dataset.entry = ++entrySeq;
  const time = new Date(change.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const head = document.createElement("button");
  head.type = "button";
  head.className = "jump";
  head.innerHTML = '<div class="meta"><span class="polr-chip"></span><span class="value"></span><span class="value"></span></div><div class="label"></div>';
  const opChip = head.querySelector(".polr-chip");
  if (OP_CHIP[change.op]) opChip.classList.add(OP_CHIP[change.op]);
  opChip.textContent = change.op;
  const [tool, when] = head.querySelectorAll(".value");
  tool.textContent = change.tool;
  when.textContent = `${time} · r${change.revision}`;
  head.querySelector(".label").textContent = change.label;
  head.title = "Show in the document";
  head.addEventListener("click", () => {
    const target = change.added[0]?.id;
    const el = target && (view.leaf(target) ?? view.blockEl(target));
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      view.flash(target);
    }
  });

  const nodes = document.createElement("div");
  nodes.className = "nodes";
  change.removed.forEach((d) => nodes.append(nodeLine(d, "old")));
  change.added.forEach((d) => nodes.append(nodeLine(d, "new")));

  li.append(head, nodes);
  logEl.prepend(li);
  while (logEl.children.length > 40) logEl.lastChild.remove();
  return li;
}

doc.subscribe((e) => {
  if (e.type === "agent-change") {
    addEntry(e.change);
    if (!railOpen()) {
      railUnseen += 1;
      showRailBadge();
    }
    view.agentChanged();
    view.play(e.change);
  }
  if (e.type === "user-change" || e.type === "agent-change" || e.type === "restored") {
    showRev();
    showChrome();
  }
});

$("#undo").addEventListener("click", () => view.undo());
$("#redo").addEventListener("click", () => view.redo());

/* --------------------------------- tools ----------------------------------- */

const tools = buildTools(doc, {
  selection: () => view.selectionInfo(),
  viewport: () => view.viewInfo(),
});
tools.forEach((t) => {
  const run = t.run;
  t.run = async (args) => {
    if (!sync.id) {
      return {
        content: [{ type: "text", text: "No document is open. Ask the person to open one from the home screen first." }],
        structuredContent: { error: "no_document" },
        isError: true,
      };
    }
    // Close any typing burst so the person's text is the undo target for this edit.
    if (!t.annotations?.readOnlyHint) view.beforeAgentEdit();
    if (t.name === "get_selection" || t.name === "get_view") agentRead(t.name);
    return run(args);
  };
});

const toolsEl = $("#tools");
tools.forEach((t) => {
  const li = document.createElement("li");
  li.innerHTML = `<span class="value"></span><span class="caption"></span>`;
  li.querySelector(".value").textContent = t.name;
  li.querySelector(".caption").textContent = t.title;
  toolsEl.append(li);
});

const reg = registerTools(tools);
const chip = $("#mcp-chip");
if (reg.supported) {
  chip.textContent = "Agent connected";
  chip.className = "polr-chip polr-chip--good";
  $("#mcp-count").textContent = `${reg.count} tools`;
  $("#mcp-text").textContent = "Your agent can read this page and edit it. Try asking it to rewrite the second bullet under Schedule. This is everything it can do here:";
} else {
  chip.textContent = "No agent connected";
  chip.className = "polr-chip polr-chip--warn";
  $("#mcp-text").textContent = "This browser can't connect an agent to the page yet (agents connect through WebMCP). You can still write here and watch the demo. This is what an agent can do here:";
}

// Handle for debugging and automated checks.
window.liveDoc = { doc, view, tools: Object.fromEntries(tools.map((t) => [t.name, t.run])) };

/* ------------------------------ the demo document ------------------------------ */

const demo = createDemo({ view, doc, tools: window.liveDoc.tools });
view.cover = () => demo.cover();

/* -------------------------------- toolbar ---------------------------------- */

document.querySelectorAll(".tool[data-block]").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  b.addEventListener("click", () => view.applyShape(b.dataset.block));
});

/* click below or around the text puts the caret at the end, like a word processor */
$(".sheet").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget && !view.locked) {
    e.preventDefault();
    view.focusEnd();
  }
});

$("#sound").addEventListener("click", (e) => {
  sound.on = !sound.on;
  e.currentTarget.setAttribute("aria-pressed", String(sound.on));
  e.currentTarget.title = "Typing sound: " + (sound.on ? "on" : "off");
});

/* ---------------------------- agent sidebar ---------------------------- */

const RAIL_KEY = "ghostwriter:rail";
let railUnseen = 0;
function setRail(open, { save = true } = {}) {
  $("#workspace").classList.toggle("rail-collapsed", !open);
  if (open) railUnseen = 0;
  showRailBadge();
  if (save) {
    try {
      localStorage.setItem(RAIL_KEY, open ? "open" : "closed");
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
}
function showRailBadge() {
  const b = $("#rail-badge");
  b.hidden = railUnseen === 0;
  b.textContent = railUnseen > 9 ? "9+" : String(railUnseen);
}
const railOpen = () => !$("#workspace").classList.contains("rail-collapsed");
let railSaved = null;
try {
  railSaved = localStorage.getItem(RAIL_KEY);
} catch {
  /* default: collapsed */
}
setRail(railSaved === "open", { save: false });

// The menu button (app bar) holds the agent panel toggle, Add to Claude and the debug panel. See debug.js.
const embedded = !!window.__GHOSTWRITER__?.embedded;
const debugMenu = mountMenu({
  button: $("#menu-btn"),
  embedded,
  connectorUrl: connectorUrl(window.__GHOSTWRITER__?.origin || location.origin),
  rail: {
    available: () => document.body.dataset.screen === "editor" && document.documentElement.dataset.display !== "inline",
    isOpen: railOpen,
    toggle: () => setRail(!railOpen()),
  },
  getInfo: debugInfo,
  ping: () => api("GET", "/docs"),
  pullNow: () => sync.pullNow(),
  say: (text) => snack(text),
});

function debugInfo() {
  const st = sync.status();
  const ctx = host?.info?.() ?? null;
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago` : "never");
  return {
    Page: {
      mode: embedded ? "inside a host (Claude)" : "browser tab",
      build: window.__GHOSTWRITER_BUILD__ || "n/a (not served by the app)",
      screen: document.body.dataset.screen,
      "api origin": window.__GHOSTWRITER__?.origin || location.origin,
      "connector url": connectorUrl(window.__GHOSTWRITER__?.origin || location.origin),
      display: document.documentElement.dataset.display || "page",
      viewport: `${innerWidth} × ${innerHeight}`,
      "agent panel": railOpen() ? "open" : "closed",
      browser: navigator.userAgent,
    },
    Document: {
      id: st.id ?? "none (list)",
      title: doc.title || "Untitled document",
      blocks: String(doc.snapshot().nodes?.length ?? 0),
      "server revision": String(st.serverRev),
      "unsaved edits": st.dirty ? "yes" : "no",
      "last pull": ago(st.lastPullAt),
      "last push": ago(st.lastPushAt),
      "last sync error": st.lastError || "none",
    },
    Host: embedded
      ? ctx
        ? { connected: "yes", version: ctx.version, capabilities: ctx.capabilities, "display mode": ctx.displayMode, "available modes": ctx.availableModes, theme: ctx.theme, platform: ctx.platform, "app tools offered": String(tools.length) }
        : { connected: "not yet (or no host answered)" }
      : { connected: "n/a (not inside a host)" },
  };
}

const tabs = [["#tab-changes", "#panel-changes"], ["#tab-tools", "#panel-tools"]];
tabs.forEach(([t, p]) =>
  $(t).addEventListener("click", () => {
    tabs.forEach(([t2, p2]) => {
      $(t2).setAttribute("aria-selected", String(t2 === t));
      $(p2).hidden = p2 !== p;
    });
  }),
);


/* ------------------------- keeping the document in step ------------------------- */
// Documents live on the server and every editor open on one stays in step with it: edits made
// elsewhere (another tab, another person, an agent) arrive within about a second, and what you
// type is saved a moment after you stop. See sync.js.

let pendingFocus = false;
let pendingDemo = false;

const sync = createSync({
      doc,
      view,
      tools: new Map(tools.map((t) => [t.name, t])),
      transport: {
        snapshot: (id) => api("GET", `/docs/${id}`),
        pull: (id, since) => api("GET", `/docs/${id}/pull?since=${since}`),
        push: (id, base, snapshot) => api("POST", `/docs/${id}/push`, { base, snapshot }),
      },
      onLoad: () => {
        showRev();
        showChrome();
        host?.changed();
      },
      onState: (text) => ($("#savestate").textContent = text || "Saved"),
      onGone: () => {
        location.hash = "#/";
        snack("That document was deleted.");
      },
});

/* ---------------------------------- home ---------------------------------- */

let docs = [];
let query = "";
let layout = "grid";
try {
  layout = localStorage.getItem(PREF_LAYOUT) === "list" ? "list" : "grid";
} catch {
  /* default */
}
let homeTimer = null;

const asRows = (list) => list.map((d) => ({ ...d, title: d.untitled ? "" : d.title }));

function drawHome() {
  renderDocs($("#docs"), { docs, query, view: layout, actions });
  $("#view-grid").setAttribute("aria-pressed", String(layout === "grid"));
  $("#view-list").setAttribute("aria-pressed", String(layout === "list"));
}

async function refreshHome({ quiet = false } = {}) {
  try {
    const next = asRows((await api("GET", "/docs")).documents);
    // Don't redraw under someone who is renaming or has a menu open, or when nothing changed.
    const busy = document.querySelector(".doc-rename") || document.querySelector(".menu");
    if (quiet && (busy || JSON.stringify(next) === JSON.stringify(docs))) return;
    docs = next;
    drawHome();
  } catch (e) {
    fail(e);
  }
}

const actions = {
  open: (id) => (location.hash = `#/d/${id}`),
  async rename(id, title) {
    try {
      await api("PATCH", `/docs/${id}`, { title });
    } catch (e) {
      snack("Could not rename that document.");
    }
    refreshHome();
  },
  async copy(id) {
    try {
      await api("POST", `/docs/${id}/copy`);
      snack("Copy created.");
    } catch (e) {
      snack("Could not copy that document.");
    }
    refreshHome();
  },
  async remove(id) {
    const name = docs.find((d) => d.id === id)?.title || "Untitled document";
    try {
      await api("DELETE", `/docs/${id}`);
    } catch (e) {
      snack("Could not remove that document.");
      return refreshHome();
    }
    refreshHome();
    snack(`"${name.length > 40 ? name.slice(0, 39) + "…" : name}" removed.`, async () => {
      try {
        await api("POST", `/docs/${id}/restore`);
      } catch {
        snack("Could not bring it back.");
      }
      refreshHome();
    });
  },
};

/* ------------------------- newer card replaced this one ------------------------- */

/** Another Ghostwriter card in this chat is newer: pause this one (no polling, no editing). */
function setSuperseded(v) {
  $("#superseded").hidden = !v;
  $("#ask-pop").hidden = true;
  if (v) {
    clearInterval(homeTimer);
    homeTimer = null;
    sync.close(); // sends anything not yet saved, then stops polling
  } else {
    route();
  }
}

/* --------------------------------- Ask AI --------------------------------- */

/** The button that sends a request to the chat. Only inside a host that accepts messages from the view. */
function mountAsk() {
  const btn = $("#ask-ai");
  if (!host?.canMessage()) return; // not inside a host (a browser tab never gets here): no button
  btn.hidden = false;
  const pop = $("#ask-pop");
  const text = $("#ask-text");
  const status = $("#ask-status");
  const sel = $("#ask-sel");
  const send = $("#ask-send");
  const chips = $("#ask-chips");
  for (const s of SUGGESTIONS) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "ask-chip";
    c.textContent = s.label;
    c.addEventListener("click", () => {
      text.value = s.text;
      text.focus();
    });
    chips.append(c);
  }
  const setOpen = (open) => {
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      status.textContent = "";
      sel.hidden = !selectedText;
      sel.textContent = selectedText ? `Selected: ${selectedText.replace(/\s+/g, " ").slice(0, 80)}` : "";
      text.focus();
    }
  };
  btn.addEventListener("click", () => setOpen(pop.hidden));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) setOpen(false);
  });
  let sending = false;
  // Not a <form>: a host's sandbox can block form submission, so this is a plain button and shortcut.
  const submit = async () => {
    if (sending) return;
    const message = buildMessage({ instruction: text.value, id: sync.id, title: doc.title, selection: selectedText });
    if (!message) {
      status.textContent = "Say what you want the AI to do.";
      return;
    }
    sending = true;
    send.disabled = true;
    status.textContent = "Sending…";
    const result = await host.ask(message); // one send per click: no retry here
    sending = false;
    send.disabled = false;
    if (result === "accepted") {
      // Done here: close the box, and leave full screen / the side panel so the chat is in view.
      text.value = "";
      setOpen(false);
      snack("Sent to the chat. You may need to allow it, or press Send there.");
      host.collapse();
    } else if (result === "unsupported") {
      btn.hidden = true; // this host cannot take messages from the editor
      setOpen(false);
      snack(describeResult(result));
    } else {
      status.textContent = describeResult(result);
    }
  };
  send.addEventListener("click", submit);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
}

async function showHome() {
  await sync.close();
  screen("home");
  host?.changed();
  document.title = "Ghostwriter";
  clearInterval(homeTimer);
  await refreshHome();
  // Other editors may add, rename or remove documents while this list is open.
  homeTimer = setInterval(() => refreshHome({ quiet: true }), 3000);
}

async function createDocument({ sample = false } = {}) {
  try {
    const made = await api("POST", "/docs", sample ? { title: "Demo: Weekend at the lake", sample: true } : { title: "" });
    pendingFocus = !sample;
    pendingDemo = sample;
    location.hash = `#/d/${made.id}`;
  } catch (e) {
    fail(e);
  }
}

$("#new-blank").addEventListener("click", () => createDocument());
$("#start-demo").addEventListener("click", () => createDocument({ sample: true }));
$("#search").addEventListener("input", (e) => {
  query = e.target.value;
  drawHome();
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.target.value = "";
    query = "";
    drawHome();
  }
});
for (const [id, value] of [["#view-grid", "grid"], ["#view-list", "list"]]) {
  $(id).addEventListener("click", () => {
    layout = value;
    try {
      localStorage.setItem(PREF_LAYOUT, value);
    } catch {
      /* not remembered */
    }
    drawHome();
  });
}

/* --------------------------------- opening ---------------------------------- */

async function openDoc(id) {
  clearInterval(homeTimer);
  try {
    await sync.open(id);
  } catch (e) {
    if (e.notFound) {
      location.hash = "#/";
      return snack("That document doesn't exist.");
    }
    return fail(e);
  }
  logEl.replaceChildren();
  $("#changes-empty").hidden = false;
  entrySeq = 0;
  screen("editor");
  if (pendingFocus) view.focusStart();
  pendingFocus = false;
  if (pendingDemo) {
    pendingDemo = false;
    try {
      await demo.play();
    } catch (e) {
      console.warn("[ghostwriter] demo stopped", e);
    }
  }
}

function fail(e) {
  snack(e.message || "Something went wrong.");
}

/* ---------------------------------- routing --------------------------------- */

function route() {
  const m = /^#\/d\/([a-z0-9]+)/.exec(location.hash);
  return m ? openDoc(m[1]) : showHome();
}
addEventListener("hashchange", route);
// In-app links ("#/", "#/d/<id>") are followed by setting the hash here. In a normal tab that is what
// the browser does anyway. Where the page is injected into a frame (an MCP host's sandbox), a bare
// fragment link would resolve against the host's address and reload the frame, so it can't be left to the browser.
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  location.hash = a.getAttribute("href");
});
// Leaving the page: send whatever has not been sent yet.
addEventListener("pagehide", () => sync.close?.());

view.render();
showRev();
route();

// Inside an MCP host (Claude) the server's view HTML sets this flag; see host.js.
if (window.__GHOSTWRITER__?.embedded) {
  import("./host.js")
    .then((m) =>
      m.connectHost({
        tools,
        isOpen: () => !!sync.id,
        openDocument: (id) => (location.hash = `#/d/${id}`),
        goHome: () => (location.hash = "#/"),
        getState: () => ({ id: sync.id, title: doc.title, selection: selectedText }),
        onSuperseded: setSuperseded,
      }),
    )
    .then((h) => {
      host = h;
      mountAsk();
    })
    .catch((e) => console.warn("[ghostwriter] no host to talk to", e));
}
