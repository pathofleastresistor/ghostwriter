// The Comments panel and the highlights in the page (docs/design/comments.md).
//
// Comments are kept on the server beside the document. This file shows them: a card per thread in the
// side panel, and the commented text tinted in the page with the CSS Custom Highlight API, so the
// editable page itself is never changed (typing, sync and the typewriter replay don't see them).
// Where each comment's text is now is worked out here from the live document with the same code the
// server uses (comments.js), so highlights follow the person's typing before it is even saved.
//
// Everything people wrote goes on the page with textContent. Nothing here moves on its own: no
// animation, no transitions, and scrolling to a comment is instant.
import { resolve, leafText, COMMENT_LIMITS } from "./comments.js";

const HAS_HIGHLIGHTS = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const DRAFT_KEY = "ghostwriter:comment-draft:";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const button = (text, onclick, cls = "c-btn", attrs = {}) => el("button", { type: "button", class: cls, text, onclick, ...attrs });

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * deps: { api, doc, view, sync, snack(text, undo?), host() (null on the website), openPanel(), isPanelOpen(),
 *         onCounts(counts) }
 */
export function createComments({ api, doc, view, sync, snack, host, openPanel, onCounts = () => {} }) {
  const $ = (s) => document.querySelector(s);
  const listEl = $("#c-list");
  const newEl = $("#c-new");
  const live = $("#c-live");
  const hereChip = $("#here-chip");

  let docId = null;
  let data = { rev: -1, threads: [] };
  let filter = "open";
  let focused = null; // thread id
  let editing = null; // { tid, mid }
  let draft = null; // { anchor, text }
  let busy = false;
  const replies = new Map(); // tid -> text being written
  const showChange = new Set();
  let positions = new Map(); // tid -> { id, start, end, whole } in the live text
  let lastHere = "";

  /* ------------------------------ talking to /api ------------------------------ */

  const path = (p = "") => `/docs/${docId}/comments${p}`;
  async function call(method, p, body, { quiet = false } = {}) {
    if (!docId || busy) return null;
    busy = true;
    try {
      const res = await api(method, path(p), body);
      if (res?.threads) set(res);
      return res;
    } catch (e) {
      if (!quiet) snack(e.message || "That didn't work. Try again.");
      return null;
    } finally {
      busy = false;
    }
  }
  async function fetchAll() {
    if (!docId) return;
    try {
      const mine = docId;
      const res = await api("GET", path());
      if (mine === docId) set(res);
    } catch {
      /* tried again on the next poll */
    }
  }
  function set(res) {
    data = { rev: res.rev, threads: res.threads ?? [] };
    onCounts(counts());
    paint();
    render();
  }

  const counts = () => ({
    open: data.threads.filter((t) => t.status === "open").length,
    waiting: data.threads.filter((t) => t.request?.status === "waiting").length,
  });

  /* -------------------------------- highlights -------------------------------- */

  /** Where each thread's text is in the document as it is on screen now. */
  function locate() {
    const next = new Map();
    for (const t of data.threads) {
      const a = resolve(doc, t.anchor);
      if (a.state === "detached") continue;
      const text = leafText(doc, a.target) ?? "";
      next.set(t.id, a.quote ? { id: a.target, start: a.start, end: a.end, whole: false, quote: a.quote } : { id: a.target, start: 0, end: text.length, whole: true, quote: text });
    }
    positions = next;
  }

  function rangeFor(p) {
    const leaf = view.leaf(p.id);
    if (!leaf) return null;
    const r = document.createRange();
    try {
      r.setStart(...view.pointIn(leaf, p.start));
      r.setEnd(...view.pointIn(leaf, p.end));
    } catch {
      return null;
    }
    return r;
  }

  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paintNow();
    });
  }
  function paintNow() {
    locate();
    document.querySelectorAll(".c-mark").forEach((m) => m.classList.remove("c-mark", "c-mark-focus"));
    if (HAS_HIGHLIGHTS) {
      CSS.highlights.delete("gw-comment");
      CSS.highlights.delete("gw-comment-focus");
    }
    if (!docId) return;
    const plain = [];
    const strong = [];
    for (const t of data.threads) {
      if (t.status !== "open") continue;
      const p = positions.get(t.id);
      if (!p) continue;
      if (HAS_HIGHLIGHTS) {
        const r = rangeFor(p.whole || p.end > p.start ? p : { ...p, end: p.start });
        if (r && !r.collapsed) (t.id === focused ? strong : plain).push(r);
      }
      // No Custom Highlight API: mark the block in the margin instead (outside the text).
      if (!HAS_HIGHLIGHTS || p.whole || p.end === p.start) {
        const leaf = view.leaf(p.id);
        if (leaf) leaf.classList.add("c-mark", ...(t.id === focused ? ["c-mark-focus"] : []));
      }
    }
    if (HAS_HIGHLIGHTS) {
      if (plain.length) CSS.highlights.set("gw-comment", new Highlight(...plain));
      if (strong.length) CSS.highlights.set("gw-comment-focus", new Highlight(...strong));
    }
    here();
  }

  /** The open threads whose text holds the caret. */
  function threadsAtCaret() {
    const c = view.captureCaret();
    if (!c) return [];
    return data.threads.filter((t) => {
      if (t.status !== "open") return false;
      const p = positions.get(t.id);
      return p && p.id === c.id && (p.whole || (c.offset >= p.start && c.offset <= p.end));
    });
  }

  /** The chip in the toolbar row, and one announcement for screen readers, when the caret is on commented text. */
  function here() {
    const at = threadsAtCaret();
    const key = at.map((t) => t.id).join(",");
    hereChip.hidden = !at.length;
    if (at.length) hereChip.textContent = `${at.length} ${at.length === 1 ? "comment" : "comments"} here`;
    if (key && key !== lastHere) live.textContent = `Commented text, ${at.length} ${at.length === 1 ? "thread" : "threads"}. ${isMac ? "Command" : "Control"}+Alt+J to open.`;
    lastHere = key;
  }

  /* ----------------------------------- panel ----------------------------------- */

  const shown = () =>
    data.threads.filter((t) => (filter === "all" ? true : filter === "waiting" ? t.request?.status === "waiting" : t.status === filter));

  /** Document order, with comments whose text was removed at the end. */
  function ordered(list) {
    const order = new Map();
    let i = 0;
    order.set("title", i++);
    for (const n of doc.nodes) {
      order.set(n.id, i++);
      if (n.type === "list") for (const it of n.items) order.set(it.id, i++);
    }
    const key = (t) => {
      const p = positions.get(t.id);
      return p ? order.get(p.id) * 1e5 + p.start : 1e12 + t.created_at / 1e3;
    };
    return [...list].sort((a, b) => key(a) - key(b));
  }

  /** Keep what someone is typing, and where, across a redraw. */
  function snapshotFocus() {
    const a = document.activeElement;
    if (!a || !listEl.contains(a) || !a.dataset.key) return null;
    return { key: a.dataset.key, start: a.selectionStart ?? null, end: a.selectionEnd ?? null };
  }
  function restoreFocus(f) {
    if (!f) return;
    const e = listEl.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
    if (!e) return;
    e.focus({ preventScroll: true });
    if (f.start !== null && e.setSelectionRange) e.setSelectionRange(f.start, f.end);
  }

  function render() {
    const f = snapshotFocus();
    locate();
    document.querySelectorAll(".c-filter").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
    const list = ordered(shown());
    $("#comments-empty").hidden = list.length > 0 || !!draft;
    $("#comments-empty").textContent = data.threads.length
      ? filter === "waiting"
        ? "No comments are waiting for the AI."
        : filter === "resolved"
          ? "No resolved comments."
          : "No open comments."
      : `No comments yet. Select some text and press Comment (${isMac ? "⌘" : "Ctrl+"}⌥M), or comment on the paragraph your cursor is in.`;
    const attached = list.filter((t) => positions.has(t.id));
    const removed = list.filter((t) => !positions.has(t.id));
    const kids = attached.map(card);
    if (removed.length) kids.push(el("h3", { class: "c-group", text: "Text removed" }), ...removed.map(card));
    listEl.replaceChildren(...kids);
    renderDraft();
    restoreFocus(f);
  }

  function quoteLine(t) {
    const p = positions.get(t.id);
    const q = p ? p.quote : t.anchor.quote;
    const words = q ? clip(q.replace(/\s+/g, " "), 90) : "(the whole block)";
    if (!p) return el("div", { class: "c-quote c-quote-gone" }, el("span", { class: "c-gone", text: "Text removed" }), el("span", { text: words }));
    return el("button", { type: "button", class: "c-quote", title: "Show it in the document", onclick: () => jump(t.id) }, el("span", { text: words }));
  }

  function card(t) {
    const p = positions.get(t.id);
    const heading = el("h3", { class: "sr-only", id: `c-h-${t.id}`, text: `Comment on: ${clip((p?.quote ?? t.anchor.quote) || "the whole block", 60)}` });
    const art = el("article", { class: "c-card" + (t.id === focused ? " is-focused" : "") + (t.status === "resolved" ? " is-resolved" : ""), "data-id": t.id, tabindex: "-1", "aria-labelledby": `c-h-${t.id}` });
    art.append(heading, quoteLine(t));

    const msgs = el("ol", { class: "c-msgs" });
    t.messages.forEach((m, i) => msgs.append(message(t, m, i)));
    art.append(msgs);

    const req = requestRow(t, p);
    if (req) art.append(req);
    if (t.status === "resolved") art.append(el("p", { class: "c-note", text: `Resolved by ${t.resolved?.by?.name ?? "someone"} ${t.resolved ? ago(t.resolved.at) : ""}` }));
    art.append(replyBox(t));
    art.addEventListener("click", (e) => {
      if (e.target.closest("button, textarea, a")) return;
      setFocused(t.id);
    });
    return art;
  }

  function message(t, m, i) {
    const mine = m.author.kind === "person";
    const li = el("li", { class: "c-msg" + (m.author.kind === "assistant" ? " is-ai" : "") });
    const head = el(
      "div",
      { class: "c-meta" },
      el("strong", { text: m.author.name }),
      m.author.kind === "assistant" ? el("span", { class: "polr-chip polr-chip--tag c-ai", text: "AI" }) : null,
      el("span", { class: "c-time", title: new Date(m.created_at).toLocaleString(), text: ago(m.created_at) }),
      m.edited_at ? el("span", { class: "c-time", text: "edited" }) : null,
    );
    li.append(head);
    if (editing && editing.tid === t.id && editing.mid === m.id) {
      const ta = el("textarea", { class: "c-input", rows: "3", maxlength: String(COMMENT_LIMITS.body), "aria-label": "Edit comment", "data-key": `edit-${t.id}-${m.id}` });
      ta.value = editing.text ?? m.body;
      ta.addEventListener("input", () => (editing.text = ta.value));
      const save = async () => {
        const body = ta.value;
        if (body.trim() === m.body) return cancelEdit();
        if (await call("PATCH", `/${t.id}/messages/${m.id}`, { body })) {
          editing = null;
          render();
        }
      };
      const cancelEdit = () => {
        editing = null;
        render();
        art(t.id)?.focus();
      };
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelEdit();
        }
      });
      li.append(ta, el("div", { class: "c-row" }, button("Save", save, "polr-btn polr-btn--primary btn-xs"), button("Cancel", cancelEdit, "polr-btn polr-btn--ghost btn-xs")));
      queueMicrotask(() => ta.focus());
      return li;
    }
    li.append(el("p", { class: "c-body", text: m.body }));
    const acts = el("div", { class: "c-acts" });
    if (mine) acts.append(button("Edit", () => ((editing = { tid: t.id, mid: m.id }), render()), "c-link", { "aria-label": `Edit ${i === 0 ? "comment" : "reply"}` }));
    acts.append(button("Delete", () => remove(t, m, i), "c-link", { "aria-label": i === 0 ? "Delete comment and its replies" : "Delete reply" }));
    li.append(acts);
    return li;
  }

  const art = (id) => listEl.querySelector(`.c-card[data-id="${CSS.escape(id)}"]`);

  function requestRow(t, p) {
    const r = t.request;
    if (!r || r.status === "cancelled") return null;
    const row = el("div", { class: "c-req" });
    if (r.status === "waiting") {
      row.append(el("span", { class: "polr-chip polr-chip--warn", text: `Waiting for AI: ${r.kind}` }));
      const h = host();
      if (h?.canMessage()) {
        row.append(el("p", { class: "c-note", text: "Your assistant picks it up from the chat." }), el("div", { class: "c-row" }, button("Send to chat", () => sendToChat(t), "polr-btn polr-btn--secondary btn-xs"), button("Cancel request", () => call("PATCH", `/${t.id}`, { request: null }), "c-link")));
      } else {
        const copy = button(
          "Copy",
          async () => {
            try {
              await navigator.clipboard.writeText("Handle my Ghostwriter comments.");
              snack("Copied. Paste it into your chat with your assistant.");
            } catch {
              snack('Say "Handle my Ghostwriter comments" to your assistant.');
            }
          },
          "c-link",
          { "aria-label": "Copy a message for your assistant" },
        );
        row.append(el("p", { class: "c-note", text: 'Your assistant sees this the next time you ask it to "handle my Ghostwriter comments". Nothing runs until then.' }), el("div", { class: "c-row" }, copy, button("Cancel request", () => call("PATCH", `/${t.id}`, { request: null }), "c-link")));
      }
      return row;
    }
    // Done.
    if (r.kind === "revise" && r.change) {
      row.append(el("span", { class: "polr-chip polr-chip--good", text: r.change.reverted ? "AI revision reverted" : `${r.handled_by?.name ?? "The AI"} revised this` }));
      if (!r.change.reverted) {
        const open = showChange.has(t.id);
        const now = p ? p.quote : null;
        const canRevert = now !== null && now === r.change.after;
        row.append(
          el(
            "div",
            { class: "c-row" },
            button(open ? "Hide change" : "Show change", () => (open ? showChange.delete(t.id) : showChange.add(t.id), render()), "c-link", { "aria-expanded": String(open) }),
            button("Revert", () => revert(t), "c-link", canRevert ? {} : { disabled: true, title: "The text has changed since; undo it by hand." }),
          ),
        );
        if (!canRevert) row.append(el("p", { class: "c-note", text: "The text has changed since, so Revert is off. Undo it by hand." }));
        if (open) row.append(el("div", { class: "c-diff" }, el("p", { class: "node old", text: r.change.before || "(nothing)" }), el("p", { class: "node new", text: r.change.after || "(nothing)" })));
      }
    } else {
      row.append(el("span", { class: "polr-chip polr-chip--good", text: `${r.handled_by?.name ?? "The AI"} answered` }));
    }
    return row;
  }

  function replyBox(t) {
    const wrap = el("div", { class: "c-reply" });
    const ta = el("textarea", { class: "c-input", rows: "1", maxlength: String(COMMENT_LIMITS.body), placeholder: t.status === "resolved" ? "Reply to reopen" : "Reply", "aria-label": "Reply", "data-key": `reply-${t.id}` });
    ta.value = replies.get(t.id) ?? "";
    ta.addEventListener("input", () => replies.set(t.id, ta.value));
    const send = async (request) => {
      const body = ta.value.trim();
      if (!body && !request) return ta.focus();
      const res = await call("POST", `/${t.id}/replies`, { body, ...(request ? { request } : {}) });
      if (!res) return;
      replies.delete(t.id);
      render();
      if (request) afterAsk(t.id, request);
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send(null);
      }
    });
    const status = t.status === "resolved" ? button("Reopen", () => call("PATCH", `/${t.id}`, { status: "open" }), "polr-btn polr-btn--ghost btn-xs") : button("Resolve", () => resolveThread(t), "polr-btn polr-btn--ghost btn-xs", { title: "Resolve: hide it from the open list. It can be reopened." });
    wrap.append(
      ta,
      el(
        "div",
        { class: "c-row" },
        button("Reply", () => send(null), "polr-btn polr-btn--primary btn-xs"),
        askButtons((kind) => send(kind)),
        el("span", { class: "grow" }),
        status,
      ),
    );
    return wrap;
  }

  function askButtons(onAsk) {
    return el(
      "span",
      { class: "c-ask", role: "group", "aria-label": "Ask the AI" },
      button("Ask AI to revise", () => onAsk("revise"), "polr-btn polr-btn--secondary btn-xs", { title: "Ask your AI to rewrite the commented text" }),
      button("Ask AI to answer", () => onAsk("answer"), "polr-btn polr-btn--secondary btn-xs", { title: "Ask your AI to reply here" }),
    );
  }

  /* ---------------------------------- actions ---------------------------------- */

  async function resolveThread(t) {
    const res = await call("PATCH", `/${t.id}`, { status: "resolved" });
    if (!res) return;
    snack(res.cancelled ? "Resolved. Its AI request was cancelled." : "Resolved.", () => call("PATCH", `/${t.id}`, { status: "open" }));
  }

  async function remove(t, m, i) {
    const res = await call("DELETE", `/${t.id}/messages/${m.id}`);
    if (!res) return;
    snack(i === 0 ? "Comment deleted." : "Reply deleted.", () => call("POST", "/restore", { undo: res.undo }));
  }

  async function revert(t) {
    await sync.flush();
    const res = await call("POST", `/${t.id}/revert`);
    if (res) {
      snack("Reverted.");
      sync.pullNow();
    }
  }

  async function sendToChat(t) {
    const h = host();
    if (!h?.canMessage()) return;
    const kind = t.request?.kind ?? "revise";
    const text = `In my Ghostwriter document "${clip((doc.title || "Untitled document").replace(/\s+/g, " "), 120)}" (document_id: ${docId}): please handle comment ${t.id} (${kind === "revise" ? "revise the commented text" : "answer in a reply"}).\n\nUse the Ghostwriter tools (list_comments) to read it.`;
    const result = await h.ask(text);
    if (result === "accepted") snack("Sent to the chat. You may need to allow it, or press Send there.");
    else if (result === "unsupported") snack("This chat can't take messages from the editor. Ask your assistant to handle your Ghostwriter comments.");
    else snack("The chat didn't take it. Try Send to chat again in a moment.");
  }

  function afterAsk(tid, kind) {
    const t = data.threads.find((x) => x.id === tid);
    if (!t) return;
    if (host()?.canMessage()) sendToChat(t);
    else snack(`Asked the AI to ${kind}. Your assistant sees it the next time you ask it to handle your Ghostwriter comments.`);
  }

  function setFocused(id, { scroll = false } = {}) {
    focused = id;
    listEl.querySelectorAll(".c-card").forEach((c) => c.classList.toggle("is-focused", c.dataset.id === id));
    paint();
    if (scroll) art(id)?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  /** Show a thread's text in the page. */
  function jump(id) {
    setFocused(id);
    const p = positions.get(id);
    const leaf = p && view.leaf(p.id);
    if (leaf) {
      leaf.scrollIntoView({ block: "center", behavior: "auto" });
      if (!view.locked) view.setSelection(leaf, p.whole ? 0 : p.start);
    }
  }

  /** Open the thread(s) at the caret in the panel. */
  function openAtCaret() {
    const at = threadsAtCaret();
    if (!at.length) return false;
    if (filter !== "open" && filter !== "all") filter = "open";
    openPanel();
    render();
    setFocused(at[0].id, { scroll: true });
    art(at[0].id)?.focus();
    return true;
  }

  /* ---------------------------------- new comment ---------------------------------- */

  let returnCaret = null;

  /** Comment on the selection, or on the whole block the caret is in. */
  function start() {
    if (!docId) return;
    const info = view.selectionInfo();
    if (!info || info.stale || !info.parts?.length) {
      snack("Put the cursor in a paragraph or select some text first.");
      return;
    }
    const part = info.parts[0];
    if (!part.id || leafText(doc, part.id) === null) {
      snack("A comment goes on a paragraph, heading, quote, list item or the title.");
      return;
    }
    returnCaret = view.captureCaret();
    const anchor = info.collapsed || !part.text.trim() ? { id: part.id } : { id: part.id, quote: part.text.slice(0, COMMENT_LIMITS.quote), start: part.start, end: part.start + Math.min(part.text.length, COMMENT_LIMITS.quote) };
    draft = { anchor, text: draft?.text ?? "" };
    saveDraft();
    if (filter !== "open" && filter !== "all") filter = "open";
    openPanel();
    render();
    newEl.querySelector("textarea")?.focus();
  }

  function saveDraft() {
    try {
      if (draft && docId) localStorage.setItem(DRAFT_KEY + docId, JSON.stringify(draft));
      else if (docId) localStorage.removeItem(DRAFT_KEY + docId);
    } catch {
      /* not remembered */
    }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY + docId) ?? "null");
      draft = d && typeof d.text === "string" && d.anchor?.id ? d : null;
    } catch {
      draft = null;
    }
  }

  function cancelDraft() {
    draft = null;
    saveDraft();
    render();
    if (returnCaret && !view.locked) view.focusLeaf(returnCaret.id, returnCaret.offset);
  }

  function renderDraft() {
    if (!draft) return newEl.replaceChildren();
    const a = draft.anchor;
    const words = a.quote ? clip(a.quote.replace(/\s+/g, " "), 90) : clip((leafText(doc, a.id) ?? "").replace(/\s+/g, " "), 90) || "(the whole block)";
    const ta = el("textarea", { class: "c-input", rows: "3", maxlength: String(COMMENT_LIMITS.body), placeholder: "Add a comment", "aria-label": "New comment", "data-key": "new" });
    ta.value = draft.text;
    ta.addEventListener("input", () => {
      draft.text = ta.value;
      saveDraft();
    });
    const submit = async (request) => {
      if (!ta.value.trim()) {
        ta.focus();
        return snack("Write the comment first.");
      }
      await sync.flush(); // the server needs the text as it is on screen
      const res = await call("POST", "", { anchor: draft.anchor, body: ta.value, ...(request ? { request } : {}) });
      if (!res) return;
      draft = null;
      saveDraft();
      render();
      setFocused(res.created, { scroll: true });
      if (request) afterAsk(res.created, request);
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit(null);
      } else if (e.key === "Escape" && !ta.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        cancelDraft();
      }
    });
    newEl.replaceChildren(
      el(
        "article",
        { class: "c-card c-draft", "aria-label": "New comment" },
        el("div", { class: "c-quote c-quote-static" }, el("span", { text: words })),
        ta,
        el("div", { class: "c-row" }, button("Comment", () => submit(null), "polr-btn polr-btn--primary btn-xs"), askButtons((k) => submit(k)), el("span", { class: "grow" }), button("Cancel", cancelDraft, "polr-btn polr-btn--ghost btn-xs")),
      ),
    );
  }

  /* ----------------------------------- wiring ----------------------------------- */

  document.querySelectorAll(".c-filter").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter;
      render();
    }),
  );
  hereChip.addEventListener("click", () => openAtCaret());

  // Alt+Up / Alt+Down move between threads in the panel; Enter on a thread shows its text.
  $("#comments").addEventListener("keydown", (e) => {
    const cardEl = e.target.closest?.(".c-card[data-id]");
    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const cards = [...listEl.querySelectorAll(".c-card[data-id]")];
      if (!cards.length) return;
      e.preventDefault();
      const at = cardEl ? cards.indexOf(cardEl) : -1;
      const next = cards[Math.max(0, Math.min(cards.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      setFocused(next.dataset.id);
      next.focus();
    } else if (e.key === "Enter" && cardEl && e.target === cardEl) {
      e.preventDefault();
      jump(cardEl.dataset.id);
    } else if (e.key === "Escape" && !e.target.matches("textarea")) {
      const c = returnCaret ?? view.captureCaret();
      if (c && !view.locked) view.focusLeaf(c.id, c.offset);
    }
  });

  // Ctrl+Alt+M (Cmd+Option+M on a Mac): comment. Ctrl+Alt+J: open the comment at the caret.
  addEventListener("keydown", (e) => {
    if (!docId || !(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return;
    if (e.code === "KeyM") {
      e.preventDefault();
      start();
    } else if (e.code === "KeyJ") {
      e.preventDefault();
      if (!openAtCaret()) snack("There's no comment where the cursor is.");
    }
  });
  document.addEventListener("selectionchange", () => {
    if (docId) here();
  });
  doc.subscribe((e) => {
    if (e.type === "user-change" || e.type === "agent-change" || e.type === "restored") paint();
  });

  return {
    /** A document was opened: load its comments. */
    async open(id) {
      docId = id;
      data = { rev: -1, threads: [] };
      focused = null;
      editing = null;
      replies.clear();
      showChange.clear();
      loadDraft();
      onCounts(counts());
      render();
      await fetchAll();
    },
    close() {
      docId = null;
      data = { rev: -1, threads: [] };
      draft = null;
      onCounts(counts());
      paintNow();
      listEl.replaceChildren();
      newEl.replaceChildren();
      hereChip.hidden = true;
    },
    /** Each poll says the comments' revision; fetch them when it moved. */
    pulled(res) {
      if (docId && Number.isInteger(res?.comments_rev) && res.comments_rev !== data.rev && !busy) fetchAll();
    },
    rendered: () => paint(),
    start,
    openAtCaret,
    counts,
    waiting: () => data.threads.filter((t) => t.request?.status === "waiting").map((t) => `${t.id} (${t.request.kind})`),
  };
}
