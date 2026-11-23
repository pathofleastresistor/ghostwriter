// Comments: threads pinned to a span of text in one block, list item or the title.
//
// Kept beside the document, never inside it (docs/design/comments.md): the server stores them in
// <id>.comments.json, and Doc.serialize(), push, merge and published snapshots never see them. This
// file is shared by the server (the store and the tools) and the page (finding where each comment's
// text is now, to highlight it), so both resolve anchors the same way.
//
// An anchor is the quoted text plus a little context on each side and a position hint. Offsets move
// on every edit, so they are only a hint: after each change the quote is found again (resolve()).
import { ToolError } from "./model.js";

export const COMMENT_LIMITS = { body: 2000, quote: 1000, context: 32, threads: 500, messages: 100, waiting: 50, name: 60 };
export const REQUEST_KINDS = ["revise", "answer"];

const cap = (v, max, what) => {
  if (typeof v !== "string") throw new ToolError(`Error: ${what} must be text.`);
  if (v.length > max) throw new ToolError(`Error: ${what} is ${v.length} characters; the limit is ${max}.`, "too_long");
  return v;
};
/** A comment body: plain text, trimmed, never empty. Line breaks are kept (up to two in a row). */
const cleanBody = (v) => {
  const t = cap(v, COMMENT_LIMITS.body, "the comment").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) throw new ToolError("Error: the comment is empty.");
  return t;
};

/* ------------------------------- the document ------------------------------- */

/** Every place a comment can sit, in document order: the title, each block, each list item. */
export function leaves(doc) {
  const out = [{ id: "title", text: doc.title ?? "" }];
  for (const n of doc.nodes) {
    if (n.type === "list") for (const it of n.items) out.push({ id: it.id, text: it.text });
    else out.push({ id: n.id, text: n.text });
  }
  return out;
}

/** The text of one block, list item or the title; null if it is gone (or is a whole list). */
export function leafText(doc, id) {
  if (id === "title") return doc.title ?? "";
  for (const n of doc.nodes) {
    if (n.id === id) return n.type === "list" ? null : n.text;
    if (n.type === "list") {
      const it = n.items.find((i) => i.id === id);
      if (it) return it.text;
    }
  }
  return null;
}

/* --------------------------------- anchors ---------------------------------- */

const ctx = (text, start, end) => ({
  prefix: text.slice(Math.max(0, start - COMMENT_LIMITS.context), start),
  suffix: text.slice(end, end + COMMENT_LIMITS.context),
});

/** How well the text around an occurrence matches the anchor's remembered context (0..2). */
function contextScore(text, at, quote, a) {
  const before = text.slice(Math.max(0, at - a.prefix.length), at);
  const after = text.slice(at + quote.length, at + quote.length + a.suffix.length);
  const tail = (x, y) => {
    let n = 0;
    while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
    return n;
  };
  const head = (x, y) => {
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
  };
  return (a.prefix ? tail(before, a.prefix) / a.prefix.length : 1) + (a.suffix ? head(after, a.suffix) / a.suffix.length : 1);
}

const occurrences = (text, quote) => {
  const out = [];
  if (!quote) return out;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) out.push(i);
  return out;
};

/** Character bigram similarity (Dice), 0..1. */
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/** The span of `text` most like `quote`, if it is at least 0.6 alike. Lengths from 70% to 130%. */
function approximate(text, quote, hint) {
  if (quote.length < 4 || !text) return null;
  let best = null;
  const lens = new Set([quote.length, Math.round(quote.length * 0.85), Math.round(quote.length * 1.15), Math.round(quote.length * 0.7), Math.round(quote.length * 1.3)]);
  const step = Math.max(1, Math.floor(quote.length / 20));
  for (const len of lens) {
    if (len < 1 || len > text.length) continue;
    for (let s = 0; s + len <= text.length; s += step) {
      const score = similarity(quote, text.slice(s, s + len)) - Math.abs(s - hint) / (text.length * 20 + 1);
      if (!best || score > best.score) best = { start: s, end: s + len, score };
    }
  }
  if (!best || best.score < 0.6) return null;
  // Snap to word edges so the highlight doesn't start or stop mid-word.
  let { start, end } = best;
  while (start > 0 && /\S/.test(text[start - 1]) && /\S/.test(text[start])) start--;
  while (end < text.length && /\S/.test(text[end - 1]) && /\S/.test(text[end])) end++;
  return { start, end };
}

/** Make an anchor on `id`: the whole leaf, a given span, or the nth occurrence of a quote. */
export function makeAnchor(doc, { id, quote, nth, start, end }) {
  if (typeof id !== "string" || !id) throw new ToolError("Error: say which block, list item or title the comment is on (an id).");
  const text = leafText(doc, id);
  if (text === null) {
    throw new ToolError(`Error: no block, list item or title with id "${id}" that can hold a comment. A whole list can't; use one of its item ids.`, "not_found");
  }
  let s;
  let e;
  if (Number.isInteger(start) && Number.isInteger(end)) {
    if (start < 0 || end > text.length || start > end) throw new ToolError("Error: that span is outside the text.");
    s = start;
    e = end;
    if (quote && text.slice(s, e) !== quote) {
      // The span was measured on text that has changed since (the page had not saved yet): use the
      // occurrence of the quote nearest to where it was.
      const at = occurrences(text, quote).sort((x, y) => Math.abs(x - start) - Math.abs(y - start));
      if (!at.length) throw new ToolError("Error: the text there has changed. Select it again.", "quote_changed");
      s = at[0];
      e = s + quote.length;
    }
  } else if (quote) {
    cap(quote, COMMENT_LIMITS.quote, "the quote");
    const at = occurrences(text, quote);
    const k = Number.isInteger(nth) ? nth : 1;
    if (!at.length) throw new ToolError(`Error: "${quote.slice(0, 80)}" is not in that text. Quote it exactly as it appears.`, "quote_not_found");
    if (k < 1 || k > at.length) throw new ToolError(`Error: "${quote.slice(0, 80)}" appears ${at.length} times there; nth must be 1 to ${at.length}.`);
    s = at[k - 1];
    e = s + quote.length;
  } else {
    s = 0;
    e = 0;
  }
  const q = text.slice(s, e);
  if (q.length > COMMENT_LIMITS.quote) throw new ToolError(`Error: a comment can be on at most ${COMMENT_LIMITS.quote} characters of text.`, "too_long");
  return { target: id, quote: q, ...ctx(text, s, e), start: s, end: e, state: "attached", doc_revision: doc.revision };
}

/**
 * Where an anchor's text is in this version of the document. Returns a new anchor; its `state` is
 * attached (found as it was), edited (found, but it moved to another block or its words changed),
 * or detached (gone; the old quote is kept so people can still see what it was about).
 */
export function resolve(doc, a) {
  const done = (target, text, start, end, state) => ({ ...a, target, quote: text.slice(start, end), ...ctx(text, start, end), start, end, state, doc_revision: doc.revision });
  const here = leafText(doc, a.target);
  if (!a.quote) {
    // A comment on a whole block: it stays while the block does.
    if (here !== null) return { ...a, start: 0, end: 0, state: a.state === "detached" ? "attached" : a.state, doc_revision: doc.revision };
    return { ...a, state: "detached", doc_revision: doc.revision };
  }
  if (here !== null) {
    const at = occurrences(here, a.quote);
    if (at.length) {
      at.sort((x, y) => contextScore(here, y, a.quote, a) - contextScore(here, x, a.quote, a) || Math.abs(x - a.start) - Math.abs(y - a.start));
      return done(a.target, here, at[0], at[0] + a.quote.length, a.state === "detached" ? "edited" : a.state);
    }
  }
  // Not in its own block: the block was replaced, split or rewritten. Look everywhere for the exact words.
  let best = null;
  let ties = 0;
  for (const l of leaves(doc)) {
    for (const i of occurrences(l.text, a.quote)) {
      const score = contextScore(l.text, i, a.quote, a);
      if (!best || score > best.score) {
        best = { id: l.id, text: l.text, at: i, score };
        ties = 0;
      } else if (score === best.score) ties++;
    }
  }
  if (best && (ties === 0 || best.score > 0)) return done(best.id, best.text, best.at, best.at + a.quote.length, "edited");
  if (here !== null) {
    const near = approximate(here, a.quote, a.start);
    if (near) return done(a.target, here, near.start, near.end, "edited");
  }
  return { ...a, state: "detached", doc_revision: doc.revision };
}

/* --------------------------------- the store --------------------------------- */

const authorOf = (a) => {
  const kind = a?.kind === "assistant" ? "assistant" : "person";
  const name = String(a?.name ?? "").replace(/\s+/g, " ").trim().slice(0, COMMENT_LIMITS.name) || (kind === "assistant" ? "Assistant" : "You");
  return { kind, name };
};
const sameAuthor = (x, y) => x.kind === y.kind && x.name === y.name;

/** All the comments on one document. `data` is what is saved: { version, rev, seq, threads }. */
export class Comments {
  constructor(data) {
    const d = data && typeof data === "object" ? data : {};
    this.version = 1;
    this.rev = Number.isInteger(d.rev) ? d.rev : 0;
    this.seq = { c: d.seq?.c ?? 0, m: d.seq?.m ?? 0 };
    this.threads = Array.isArray(d.threads) ? d.threads : [];
  }

  serialize() {
    return { version: this.version, rev: this.rev, seq: this.seq, threads: this.threads };
  }

  bump() {
    this.rev += 1;
  }

  get(id) {
    const t = typeof id === "string" ? this.threads.find((x) => x.id === id) : undefined;
    if (!t) throw new ToolError(`Error: no comment with id "${id}" on this document. Call list_comments for the ids.`, "comment_not_found");
    return t;
  }

  message(body, author, now) {
    return { id: "m" + ++this.seq.m, author: authorOf(author), body: cleanBody(body), created_at: now, edited_at: null };
  }

  /** Start a thread. `request` ("revise" | "answer") asks the AI too. */
  add(doc, { anchor, body, author, request, now = Date.now() }) {
    if (this.threads.length >= COMMENT_LIMITS.threads) throw new ToolError(`Error: a document can hold at most ${COMMENT_LIMITS.threads} comments.`, "too_many_comments");
    if (request) this.checkWaiting(request);
    const a = makeAnchor(doc, anchor ?? {});
    const first = this.message(body, author, now);
    const t = { id: "c" + ++this.seq.c, anchor: a, status: "open", created_at: now, resolved: null, request: null, messages: [first] };
    if (request) t.request = this.newRequest(request, now);
    this.threads.push(t);
    this.bump();
    return t;
  }

  /** Every library allows at most so many waiting requests; the caller passes how many it has. */
  checkWaiting(kind, waitingInLibrary = 0) {
    if (!REQUEST_KINDS.includes(kind)) throw new ToolError('Error: a request is "revise" or "answer".');
    if (waitingInLibrary >= COMMENT_LIMITS.waiting) throw new ToolError(`Error: at most ${COMMENT_LIMITS.waiting} requests can wait for the AI at once.`, "too_many_requests");
  }

  newRequest(kind, now) {
    return { kind, status: "waiting", asked_at: now, done_at: null, handled_by: null, change: null };
  }

  reply(id, { body, author, requestDone = false, now = Date.now() }) {
    const t = this.get(id);
    if (t.messages.length >= COMMENT_LIMITS.messages) throw new ToolError(`Error: a thread can hold at most ${COMMENT_LIMITS.messages} messages.`, "too_many_comments");
    const m = this.message(body, author, now);
    t.messages.push(m);
    if (t.status === "resolved") {
      t.status = "open";
      t.resolved = null;
    }
    if (requestDone && t.request?.status === "waiting") this.finish(t, author, now);
    this.bump();
    return { thread: t, message: m };
  }

  finish(t, author, now) {
    t.request.status = "done";
    t.request.done_at = now;
    t.request.handled_by = authorOf(author);
  }

  /** Only the person who wrote a message can change it; nobody can change an assistant's. */
  edit(id, messageId, { body, author, now = Date.now() }) {
    const t = this.get(id);
    const m = t.messages.find((x) => x.id === messageId);
    if (!m) throw new ToolError(`Error: no message "${messageId}" in that thread.`, "comment_not_found");
    const who = authorOf(author);
    if (m.author.kind !== "person" || !sameAuthor(m.author, who)) throw new ToolError("Error: only the person who wrote a comment can edit it.", "forbidden");
    const b = cleanBody(body);
    if (b === m.body) return t;
    m.body = b;
    m.edited_at = now;
    this.bump();
    return t;
  }

  /** Remove one message; removing the first removes the thread. Returns what to keep for Undo. */
  remove(id, messageId) {
    const t = this.get(id);
    const at = t.messages.findIndex((x) => x.id === messageId);
    if (at < 0) throw new ToolError(`Error: no message "${messageId}" in that thread.`, "comment_not_found");
    this.bump();
    if (at === 0) {
      const index = this.threads.indexOf(t);
      this.threads.splice(index, 1);
      return { kind: "thread", thread: t, index };
    }
    const [m] = t.messages.splice(at, 1);
    return { kind: "message", thread: t.id, message: m, index: at };
  }

  /** Put back what remove() took, if its thread (for a message) is still there. */
  restore(removed) {
    if (removed.kind === "thread") {
      if (this.threads.some((x) => x.id === removed.thread.id)) return removed.thread;
      this.threads.splice(Math.min(removed.index, this.threads.length), 0, removed.thread);
    } else {
      const t = this.get(removed.thread);
      if (!t.messages.some((x) => x.id === removed.message.id)) t.messages.splice(Math.min(removed.index, t.messages.length), 0, removed.message);
    }
    this.bump();
    return removed.kind === "thread" ? removed.thread : this.get(removed.thread);
  }

  /** open | resolved. Resolving cancels a request still waiting. Nothing is removed either way. */
  setStatus(id, status, { author, now = Date.now() }) {
    if (status !== "open" && status !== "resolved") throw new ToolError('Error: status is "open" or "resolved".');
    const t = this.get(id);
    if (t.status === status) return { thread: t, cancelled: false };
    let cancelled = false;
    t.status = status;
    if (status === "resolved") {
      t.resolved = { by: authorOf(author), at: now };
      if (t.request?.status === "waiting") {
        t.request.status = "cancelled";
        cancelled = true;
      }
    } else t.resolved = null;
    this.bump();
    return { thread: t, cancelled };
  }

  /** Ask the AI on an existing thread, or cancel (kind null). A new request replaces a finished one. */
  setRequest(id, kind, { now = Date.now(), waitingInLibrary = 0 } = {}) {
    const t = this.get(id);
    if (kind === null) {
      if (t.request?.status !== "waiting") return t;
      t.request.status = "cancelled";
    } else {
      if (t.request?.status === "waiting" && t.request.kind === kind) {
        t.request.asked_at = now;
      } else {
        this.checkWaiting(kind, t.request?.status === "waiting" ? waitingInLibrary - 1 : waitingInLibrary);
        t.request = this.newRequest(kind, now);
      }
      if (t.status === "resolved") {
        t.status = "open";
        t.resolved = null;
      }
    }
    this.bump();
    return t;
  }

  /** The AI rewrote the commented text: remember before and after for Revert, finish a revise request. */
  revised(id, { before, after, revision, author, now = Date.now() }) {
    const t = this.get(id);
    if (!t.request || t.request.status !== "waiting" || t.request.kind !== "revise") t.request = { kind: "revise", status: "waiting", asked_at: now, done_at: null, handled_by: null, change: null };
    this.finish(t, author, now);
    t.request.change = { target: t.anchor.target, before, after, revision, reverted: false };
    this.bump();
    return t;
  }

  waiting() {
    return this.threads.filter((t) => t.request?.status === "waiting");
  }

  counts() {
    return {
      open: this.threads.filter((t) => t.status === "open").length,
      resolved: this.threads.filter((t) => t.status === "resolved").length,
      waiting_for_ai: this.waiting().length,
    };
  }

  /** After the document changed: find every anchor again. True if anything people can see moved. */
  reanchor(doc) {
    let visible = false;
    let any = false;
    for (const t of this.threads) {
      const next = resolve(doc, t.anchor);
      if (next.target !== t.anchor.target || next.state !== t.anchor.state || next.quote !== t.anchor.quote) visible = true;
      if (visible || next.start !== t.anchor.start || next.end !== t.anchor.end) any = true;
      t.anchor = next;
    }
    if (visible) this.bump();
    return { visible, any };
  }
}

/* ------------------------------ what a model sees ------------------------------ */

/** One thread as a tool returns it. Quotes and bodies are text people wrote, kept in their own fields. */
export function describeThread(doc, t, where = () => null) {
  const text = t.anchor.state === "detached" ? null : leafText(doc, t.anchor.target);
  return {
    comment_id: t.id,
    status: t.status,
    anchor: {
      block_id: t.anchor.state === "detached" ? null : t.anchor.target,
      location: t.anchor.state === "detached" ? "(the text was removed)" : where(t.anchor.target) ?? t.anchor.target,
      state: t.anchor.state,
      whole_block: !t.anchor.quote,
      quote: t.anchor.quote,
      ...(text !== null ? { block_text: text } : {}),
    },
    request: t.request ? { kind: t.request.kind, status: t.request.status } : null,
    ...(t.resolved ? { resolved_by: `${t.resolved.by.name} (${t.resolved.by.kind})` } : {}),
    messages: t.messages.map((m) => ({ message_id: m.id, author: `${m.author.name} (${m.author.kind})`, body: m.body, ...(m.edited_at ? { edited: true } : {}) })),
  };
}
