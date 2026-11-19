// Editor view. The whole document is ONE contenteditable canvas, so selection,
// typing, Enter, Backspace and clipboard behave like a normal word processor.
// After every edit the DOM is read back into the node model (`sync`), which the
// WebMCP tools also use. Agent edits are applied to the model first and then
// replayed on screen as a typewriter: old text erased, new text typed in.


// The app bar and toolbar stay on screen above the page, the status bar below it.
const CHROME_TOP = 104;
const CHROME_BOTTOM = 28;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Hidden tabs throttle timers to about 1 a second, which would make the replay crawl
// and keep the page locked. Nobody is watching, so apply the edit without the show.
const sleep = (ms) => (reduced() || document.hidden ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

try {
  document.execCommand("defaultParagraphSeparator", false, "p");
} catch {
  /* older browsers */
}

const SHAPES = {
  paragraph: { type: "paragraph" },
  heading: { type: "heading", level: 2 },
  subheading: { type: "heading", level: 3 },
  bullets: { type: "list", ordered: false },
  numbers: { type: "list", ordered: true },
  quote: { type: "quote" },
};

const isList = (el) => el.tagName === "UL" || el.tagName === "OL";
const leavesOf = (b) => (isList(b) ? [...b.children] : [b]);

function shapeOf(el) {
  switch (el.tagName) {
    case "UL": return "bullets";
    case "OL": return "numbers";
    case "H1":
    case "H2": return "heading";
    case "H3": return "subheading";
    case "BLOCKQUOTE": return "quote";
    default: return "paragraph";
  }
}

/* ------------------------------- typing sound ------------------------------ */

let audio = null;
export const sound = { on: false };
function tick(strong = false) {
  if (!sound.on) return;
  try {
    audio ??= new AudioContext();
    const len = strong ? 0.05 : 0.018;
    const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audio.createBufferSource();
    const gain = audio.createGain();
    gain.gain.value = strong ? 0.18 : 0.07;
    src.buffer = buf;
    src.connect(gain).connect(audio.destination);
    src.start();
  } catch {
    /* audio is optional */
  }
}

/* --------------------------------- the view -------------------------------- */

export class View {
  constructor(doc, { root, onStatus, onHistory, onShape, onSelection }) {
    this.doc = doc;
    this.root = root;
    this.onStatus = onStatus ?? (() => {});
    this.onHistory = onHistory ?? (() => {});
    this.onShape = onShape ?? (() => {});
    this.onSelection = onSelection ?? (() => {});
    this.lastSel = null;
    this.queue = [];
    this.running = false;
    this.locked = false;
    this.pendingFlash = [];
    this.past = [];
    this.future = [];
    this.burst = false;
    this.burstTimer = null;
    this.committed = this.snapStr();
    this.committedCaret = null;
    this.root.contentEditable = "true";
    this.root.spellcheck = true;
    this.bind();
  }

  /* ------------------------------- rendering ------------------------------- */

  tagFor(node) {
    if (node.type === "heading") return "h" + node.level;
    if (node.type === "list") return node.ordered ? "ol" : "ul";
    return node.type === "quote" ? "blockquote" : "p";
  }

  decorate(el, node) {
    if (node.type === "list") {
      el.className = "blk blk-list";
      el.dataset.blockId = node.id;
      return;
    }
    el.className = "blk blk-" + node.type + (node.type === "heading" ? " lvl-" + node.level : "");
    el.dataset.id = el.dataset.blockId = node.id;
    el.dataset.ph = node.type === "heading" ? "Heading" : node.type === "quote" ? "Quote" : "Write something";
  }

  setText(el, text) {
    el.textContent = text;
    if (!text) el.append(document.createElement("br")); // keeps an empty block tall and focusable
  }

  get titleEl() {
    return this.root.querySelector(":scope > [data-title]");
  }

  buildTitle(text) {
    const el = document.createElement("h1");
    el.className = "blk blk-title";
    el.dataset.title = "";
    el.dataset.id = "title";
    el.dataset.ph = "Untitled";
    this.setText(el, text);
    return el;
  }

  /** Builds the DOM for a node. With `empty`, text is left blank so it can be typed in. */
  buildBlock(node, { empty = false } = {}) {
    const el = document.createElement(this.tagFor(node));
    this.decorate(el, node);
    if (node.type === "list") node.items.forEach((it) => el.append(this.buildItem(it, empty)));
    else this.setText(el, empty ? "" : node.text);
    return el;
  }

  buildItem(item, empty = false) {
    const li = document.createElement("li");
    li.dataset.id = item.id;
    this.setText(li, empty ? "" : item.text);
    return li;
  }

  render(focus) {
    if (!this.doc.nodes.length) this.doc.nodes.push(this.doc.makeNode({ type: "paragraph", text: "" }));
    const frag = document.createDocumentFragment();
    frag.append(this.buildTitle(this.doc.title));
    this.doc.nodes.forEach((n) => frag.append(this.buildBlock(n)));
    this.root.replaceChildren(frag);
    this.lastSel = null;
    this.paintRemembered();
    this.onSelection(null);
    this.updateEmpty();
    if (focus && this.leaf(focus.id)) this.focusLeaf(focus.id, focus.offset);
  }

  updateEmpty() {
    const n = this.doc.nodes;
    this.root.classList.toggle("is-empty", n.length === 1 && n[0].type === "paragraph" && !n[0].text);
  }

  leaf(id) {
    return this.root.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }

  blockEl(id) {
    return this.root.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
  }

  /* ------------------------------ selection tools ----------------------------- */

  textOf(el) {
    return el.textContent.replace(/[\n ]/g, " ");
  }

  offsetIn(leaf, node, off) {
    const r = document.createRange();
    r.selectNodeContents(leaf);
    try {
      r.setEnd(node, off);
    } catch {
      return 0;
    }
    return r.toString().length;
  }

  pointIn(leaf, offset) {
    const w = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
    let n;
    let left = offset;
    let last = null;
    while ((n = w.nextNode())) {
      last = n;
      if (left <= n.data.length) return [n, left];
      left -= n.data.length;
    }
    return last ? [last, last.data.length] : [leaf, 0];
  }

  setSelection(startLeaf, so, endLeaf = startLeaf, eo = so) {
    const r = document.createRange();
    r.setStart(...this.pointIn(startLeaf, so));
    r.setEnd(...this.pointIn(endLeaf, eo));
    this.root.focus({ preventScroll: true });
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  focusLeaf(id, offset = 0) {
    const el = this.leaf(id);
    if (el) this.setSelection(el, offset);
  }

  focusStart() {
    const first = this.root.querySelector("[data-id]");
    if (first) this.setSelection(first, 0);
  }

  focusEnd() {
    const all = this.root.querySelectorAll("[data-id]");
    const last = all[all.length - 1];
    if (last) this.setSelection(last, last.textContent.length);
  }

  captureCaret() {
    const s = getSelection();
    if (!s.rangeCount || !this.root.contains(s.anchorNode)) return null;
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    const leaf = el?.closest("[data-id]");
    if (!leaf || !this.root.contains(leaf)) return null;
    return { id: leaf.dataset.id, offset: this.offsetIn(leaf, s.anchorNode, s.anchorOffset) };
  }

  /** Top-level blocks touched by the current selection. */
  selectedBlocks() {
    const s = getSelection();
    if (!s.rangeCount || !this.root.contains(s.anchorNode)) return [];
    const range = s.getRangeAt(0);
    const blocks = [...this.root.children].filter((c) => !c.hasAttribute("data-title") && range.intersectsNode(c));
    if (blocks.length > 1 && !range.collapsed) {
      // A triple-click ends at the start of the next block; don't count it.
      const last = blocks[blocks.length - 1];
      const pre = document.createRange();
      pre.setStart(last, 0);
      pre.setEnd(range.endContainer, range.endOffset);
      if (pre.toString() === "") blocks.pop();
    }
    return blocks;
  }

  /* ------------------------------- DOM -> model ------------------------------- */

  /** Replace an element with another, moving its content and keeping a collapsed caret. */
  swap(old, neu) {
    const s = getSelection();
    const caret = s.rangeCount && s.isCollapsed && s.anchorNode === old ? s.anchorOffset : null;
    neu.append(...old.childNodes);
    old.replaceWith(neu);
    if (caret !== null) {
      const r = document.createRange();
      r.setStart(neu, Math.min(caret, neu.childNodes.length));
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
    }
    return neu;
  }

  /** Strip any inline markup the browser added, keeping only plain text. */
  flatten(el) {
    const kids = el.children;
    if (!kids.length) {
      if (!el.textContent) this.setText(el, "");
      return;
    }
    if (kids.length === 1 && kids[0].tagName === "BR" && !el.textContent) return;
    const caret = this.captureCaret();
    this.setText(el, this.textOf(el));
    if (caret && caret.id === el.dataset.id) this.setSelection(el, caret.offset);
  }

  /**
   * The title is the first block of the canvas. Keep exactly one, first, as an h1,
   * and hand back any copies the browser made when the title was split.
   */
  normalizeTitle() {
    const root = this.root;
    const cands = [...root.children].filter((c) => c.hasAttribute("data-title"));
    let t = cands.find((c) => c.textContent.length) ?? cands[0];
    const losers = new Set(cands.filter((c) => c !== t));
    losers.forEach((l) => {
      l.removeAttribute("data-title");
      l.removeAttribute("data-id");
      l.removeAttribute("data-block-id");
      l.className = "";
    });
    if (!t) {
      t = this.buildTitle("");
      root.prepend(t);
    } else {
      if (t.tagName !== "H1") {
        const neu = document.createElement("h1");
        neu.dataset.title = "";
        t = this.swap(t, neu);
      }
      t.className = "blk blk-title";
      t.dataset.id = "title";
      t.dataset.ph = "Untitled";
      if (root.firstElementChild !== t) {
        const caret = this.captureCaret();
        root.prepend(t);
        if (caret?.id === "title") this.setSelection(t, caret.offset);
      }
    }
    this.flatten(t);
    this.doc.title = this.textOf(t);
    return losers;
  }

  /**
   * Read the canvas back into the model. The browser does the editing; this
   * normalises what it produced: unknown wrappers become paragraphs, split
   * blocks get fresh ids, inline formatting is dropped.
   */
  sync() {
    const root = this.root;
    const els = [];
    const titleLosers = this.normalizeTitle();
    for (const child of [...root.childNodes]) {
      if (child === this.titleEl) continue;
      if (child.nodeType === 3) {
        if (!child.data.trim()) {
          child.remove();
          continue;
        }
        const p = document.createElement("p");
        child.replaceWith(p);
        p.append(child);
        els.push(p);
        continue;
      }
      if (child.nodeType !== 1 || child.tagName === "BR") {
        child.remove();
        continue;
      }
      let el = child;
      if (!/^(H[1-3]|P|BLOCKQUOTE|UL|OL)$/.test(el.tagName)) {
        el = this.swap(el, document.createElement(/^H[4-6]$/.test(el.tagName) ? "h3" : "p"));
      }
      if (isList(el)) {
        for (const c of [...el.childNodes]) {
          if (c.nodeType === 1 && c.tagName === "LI") continue;
          if (c.nodeType === 3 && c.data.trim()) {
            const li = document.createElement("li");
            c.replaceWith(li);
            li.append(c);
          } else if (c.nodeType === 1 && c.tagName !== "BR") this.swap(c, document.createElement("li"));
          else c.remove();
        }
        if (!el.children.length) {
          el.remove();
          continue;
        }
      }
      els.push(el);
    }

    // Split blocks copy their id. The original keeps it (preferring the half with text).
    const idOf = (el) => (isList(el) ? el.dataset.blockId : el.dataset.id);
    const owners = new Map();
    const claim = (el, nonEmpty) => {
      const id = idOf(el);
      if (!id) return;
      const cur = owners.get(id);
      if (!cur || (!cur.nonEmpty && nonEmpty)) owners.set(id, { el, nonEmpty });
    };
    els.forEach((el) => {
      if (isList(el)) {
        claim(el, el.textContent.length > 0);
        [...el.children].forEach((li) => claim(li, li.textContent.length > 0));
      } else claim(el, el.textContent.length > 0);
    });

    const nodes = [];
    for (let i = 0; i < els.length; i++) {
      let el = els[i];
      if (isList(el)) {
        const id = owners.get(idOf(el))?.el === el ? idOf(el) : this.doc.newId("n");
        const items = [...el.children].map((li) => {
          const own = owners.get(li.dataset.id)?.el === li;
          const iid = li.dataset.id && own ? li.dataset.id : this.doc.newId("i");
          li.dataset.id = iid;
          this.flatten(li);
          return { id: iid, text: this.textOf(li) };
        });
        const node = { id, type: "list", ordered: el.tagName === "OL", items };
        this.decorate(el, node);
        nodes.push(node);
        continue;
      }
      const dup = titleLosers.has(el) || (idOf(el) && owners.get(idOf(el))?.el !== el);
      const id = idOf(el) && !dup ? idOf(el) : this.doc.newId("n");
      let type = el.tagName === "BLOCKQUOTE" ? "quote" : /^H/.test(el.tagName) ? "heading" : "paragraph";
      // Pressing Enter at the end of a heading or quote starts a normal paragraph.
      if (dup && type !== "paragraph" && (!el.textContent || titleLosers.has(el))) {
        el = this.swap(el, document.createElement("p"));
        type = "paragraph";
      }
      this.flatten(el);
      const node = { id, type, text: this.textOf(el) };
      if (type === "heading") node.level = Number(el.tagName[1]) || 2;
      this.decorate(el, node);
      nodes.push(node);
    }

    if (!nodes.length) {
      const node = this.doc.makeNode({ type: "paragraph", text: "" });
      const el = this.buildBlock(node);
      root.append(el);
      nodes.push(node);
      if (!this.captureCaret()) this.setSelection(this.titleEl, this.titleEl.textContent.length);
    }
    this.doc.nodes = nodes;
    this.updateEmpty();
  }

  /* ------------------------------ user editing ----------------------------- */

  bind() {
    const root = this.root;

    root.addEventListener("beforeinput", (e) => {
      if (this.locked) return e.preventDefault();
      const t = e.inputType;
      if (t.startsWith("format") || t === "insertFromDrop" || t === "deleteByDrag") return e.preventDefault();
      if (t === "insertLineBreak") {
        e.preventDefault();
        document.execCommand("insertParagraph");
      } else if (t === "historyUndo") {
        e.preventDefault();
        this.undo();
      } else if (t === "historyRedo") {
        e.preventDefault();
        this.redo();
      }
    });

    root.addEventListener("input", () => {
      if (this.locked) return;
      this.sync();
      this.shortcut();
      this.noteChange();
    });

    root.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if (mod && !e.altKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
      } else if (mod && ["b", "i", "u"].includes(e.key.toLowerCase())) {
        e.preventDefault(); // plain text only
      }
    });

    root.addEventListener("paste", (e) => {
      e.preventDefault();
      if (this.locked) return;
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r/g, "");
      text.split(/\n+/).forEach((line, i) => {
        if (i > 0) document.execCommand("insertParagraph");
        if (line) document.execCommand("insertText", false, line);
      });
    });

    const copy = (e) => {
      e.preventDefault();
      e.clipboardData.setData("text/plain", getSelection().toString());
    };
    root.addEventListener("copy", copy);
    root.addEventListener("cut", (e) => {
      copy(e);
      if (!this.locked) document.execCommand("delete");
    });
    root.addEventListener("drop", (e) => e.preventDefault());

    document.addEventListener("selectionchange", () => {
      const s = getSelection();
      if (!s.rangeCount || !root.contains(s.anchorNode)) return;
      // Remember what the person last had selected, so an agent can still read it
      // after they click away from the document.
      if (!this.locked) {
        this.lastSel = this.readSelection();
        this.onSelection(this.lastSel);
      }
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => {
        const keys = new Set(this.selectedBlocks().map(shapeOf));
        this.onShape(keys.size === 1 ? [...keys][0] : null);
      });
    });
    root.addEventListener("focusin", () => this.paintRemembered());
    root.addEventListener("focusout", () => this.paintRemembered());
  }

  /* ----------------------- selection, as the agent sees it ----------------------- */

  allLeaves() {
    return [...this.root.querySelectorAll("[data-id]")];
  }

  /** The live selection as one entry per block or list item it touches, with character offsets. */
  readSelection() {
    const s = getSelection();
    if (!s.rangeCount || !this.root.contains(s.anchorNode) || !this.root.contains(s.focusNode)) return null;
    const r = s.getRangeAt(0);
    const parts = [];
    for (const l of this.allLeaves()) {
      if (!r.intersectsNode(l)) continue;
      const lr = document.createRange();
      lr.selectNodeContents(l);
      if (r.compareBoundaryPoints(Range.START_TO_START, lr) > 0) lr.setStart(r.startContainer, r.startOffset);
      if (r.compareBoundaryPoints(Range.END_TO_END, lr) < 0) lr.setEnd(r.endContainer, r.endOffset);
      const text = lr.toString().replace(/[\n\u00a0]/g, " ");
      if (!r.collapsed && !text) continue;
      const start = this.offsetIn(l, lr.startContainer, lr.startOffset);
      parts.push({ id: l.dataset.id, text, start, end: start + text.length, leafText: this.textOf(l) });
    }
    if (!parts.length) return null;
    return { collapsed: r.collapsed, parts, at: Date.now() };
  }

  /** Does a remembered selection still describe the current text? */
  selectionValid(sel) {
    return sel.parts.every((p) => {
      const leaf = this.leaf(p.id);
      return leaf && this.textOf(leaf).slice(p.start, p.end) === p.text;
    });
  }

  /** Live selection if there is one, otherwise the last one the person made. */
  selectionInfo() {
    const live = this.readSelection();
    if (live) return { ...live, source: "live" };
    const sel = this.lastSel;
    if (!sel) return null;
    if (!this.selectionValid(sel)) return { stale: true };
    return { ...sel, source: "remembered" };
  }

  /** Blocks currently on screen, top to bottom. */
  viewInfo() {
    const visible = [];
    for (const el of this.root.children) {
      const r = el.getBoundingClientRect();
      if (r.bottom > CHROME_TOP && r.top < innerHeight - CHROME_BOTTOM) visible.push(el.dataset.blockId || el.dataset.id);
    }
    return { visible, focused: document.activeElement === this.root };
  }

  /** Keep a remembered selection visible after focus leaves the document. */
  paintRemembered() {
    if (!("highlights" in CSS)) return;
    CSS.highlights.delete("remembered");
    const sel = this.lastSel;
    if (!sel || sel.collapsed || document.activeElement === this.root || !this.selectionValid(sel)) return;
    const first = sel.parts[0];
    const last = sel.parts[sel.parts.length - 1];
    const a = this.leaf(first.id);
    const b = this.leaf(last.id);
    if (!a || !b) return;
    const r = document.createRange();
    r.setStart(...this.pointIn(a, first.start));
    r.setEnd(...this.pointIn(b, last.end));
    CSS.highlights.set("remembered", new Highlight(r));
  }

  /** Markdown-style shortcuts typed at the start of a paragraph. */
  shortcut() {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return;
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    const block = el?.closest(".blk");
    if (!block || block.parentElement !== this.root || block.tagName !== "P") return;
    const m = block.textContent.replace(/ /g, " ").match(/^(#{1,3}|-|\*|1\.|>) $/);
    if (!m) return;
    const tok = m[1];
    const key = tok[0] === "#" ? (tok.length === 3 ? "subheading" : "heading") : tok === "-" || tok === "*" ? "bullets" : tok === "1." ? "numbers" : "quote";
    this.setText(block, "");
    this.setSelection(block, 0);
    this.applyShape(key, block);
  }

  /** Convert the blocks in the selection (or one given block) to another block type. */
  applyShape(key, only) {
    if (this.locked) return;
    const blocks = only ? [only] : this.selectedBlocks();
    if (!blocks.length) return;
    this.flushBurst();

    const old = blocks.flatMap(leavesOf);
    const s = getSelection();
    let cap = null;
    if (s.rangeCount && this.root.contains(s.anchorNode)) {
      const r = s.getRangeAt(0);
      const at = (node, off) => {
        const el = node.nodeType === 1 ? node : node.parentElement;
        const leaf = el?.closest("[data-id]");
        return leaf && old.includes(leaf) ? { i: old.indexOf(leaf), o: this.offsetIn(leaf, node, off) } : null;
      };
      const lastLeaf = old[old.length - 1];
      cap = {
        a: at(r.startContainer, r.startOffset) ?? { i: 0, o: 0 },
        b: at(r.endContainer, r.endOffset) ?? { i: old.length - 1, o: lastLeaf.textContent.length },
      };
    }

    const rows = old.map((l) => ({ id: l.dataset.id, text: this.textOf(l), item: l.tagName === "LI" }));
    // Pressing the active type again turns it back into plain paragraphs.
    const same = blocks.every((b) => shapeOf(b) === key) && key !== "paragraph";
    const spec = same ? SHAPES.paragraph : SHAPES[key];
    let nodes;
    if (spec.type === "list") {
      nodes = [
        {
          id: blocks[0].dataset.blockId,
          type: "list",
          ordered: spec.ordered,
          items: rows.map((r) => ({ id: r.item ? r.id : this.doc.newId("i"), text: r.text })),
        },
      ];
    } else {
      nodes = rows.map((r) => ({ id: r.item ? this.doc.newId("n") : r.id, type: spec.type, level: spec.level, text: r.text }));
    }

    const els = nodes.map((n) => this.buildBlock(n));
    blocks[0].before(...els);
    blocks.forEach((b) => b.remove());
    this.sync();
    if (cap) {
      const fresh = els.flatMap(leavesOf);
      const A = fresh[Math.min(cap.a.i, fresh.length - 1)];
      const B = fresh[Math.min(cap.b.i, fresh.length - 1)];
      if (A && B) this.setSelection(A, cap.a.o, B, cap.b.o);
    }
    this.noteChange();
  }

  /* --------------------------------- history --------------------------------- */

  snapStr() {
    return JSON.stringify(this.doc.snapshot());
  }

  emitHistory() {
    this.onHistory({ undo: this.past.length > 0, redo: this.future.length > 0 });
  }

  /** A user change. Typing within 700ms of the last keystroke is one undo step. */
  noteChange() {
    if (!this.burst) {
      this.past.push({ snap: this.committed, caret: this.committedCaret });
      if (this.past.length > 200) this.past.shift();
      this.future.length = 0;
      this.burst = true;
      this.emitHistory();
    }
    clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => this.flushBurst(), 700);
    this.doc.userChanged();
  }

  flushBurst() {
    clearTimeout(this.burstTimer);
    this.burst = false;
    this.committed = this.snapStr();
    this.committedCaret = this.captureCaret();
  }

  /** Called when an agent tool is about to write, so the pre-edit state is the undo target. */
  beforeAgentEdit() {
    this.flushBurst();
  }

  /** An agent change has just been applied to the model. */
  agentChanged() {
    this.past.push({ snap: this.committed, caret: null });
    this.future.length = 0;
    this.committed = this.snapStr();
    this.emitHistory();
  }

  resetHistory() {
    this.past = [];
    this.future = [];
    this.burst = false;
    clearTimeout(this.burstTimer);
    this.committed = this.snapStr();
    this.emitHistory();
  }

  restoreEntry(e) {
    this.doc.restore(JSON.parse(e.snap));
    this.committed = this.snapStr();
    this.render(e.caret);
    if (!e.caret) this.root.blur();
    this.emitHistory();
  }

  undo() {
    if (this.locked) return;
    this.flushBurst();
    const e = this.past.pop();
    if (!e) return;
    this.future.push({ snap: this.committed, caret: this.captureCaret() });
    this.restoreEntry(e);
  }

  redo() {
    if (this.locked) return;
    this.flushBurst();
    const e = this.future.pop();
    if (!e) return;
    this.past.push({ snap: this.committed, caret: this.captureCaret() });
    this.restoreEntry(e);
  }

  /* ----------------------------- agent animation ---------------------------- */

  /** Queue the on-screen replay of a change that is already applied to the model. */
  play(change) {
    if (!this.locked) this.caretBefore = this.captureCaret();
    this.queue.push(change);
    this.root.classList.remove("is-empty"); // the empty-document placeholder must not sit over text being typed
    this.setLocked(true);
    if (!this.running) this.drain();
  }

  setLocked(v) {
    this.locked = v;
    this.root.contentEditable = v ? "false" : "true";
    this.root.classList.toggle("is-writing", v);
  }

  async drain() {
    this.running = true;
    while (this.queue.length) {
      const change = this.queue.shift();
      try {
        for (const job of change.jobs) await this.runJob(job, change);
      } catch (e) {
        console.warn("[ghostwriter] animation skipped", e);
      }
    }
    this.running = false;
    this.status(null);
    this.setLocked(false);
    // Rebuild from the model so the screen is exactly the document, then flash what changed.
    const flash = this.pendingFlash;
    this.pendingFlash = [];
    this.render(this.caretBefore);
    this.caretBefore = null;
    flash.forEach((id) => this.flash(id));
  }

  status(change) {
    this.onStatus(change ? { label: change.label, tool: change.tool } : null);
  }

  flash(id) {
    const el = this.leaf(id) ?? this.blockEl(id);
    if (!el) return;
    el.classList.remove("just-edited");
    void el.offsetWidth;
    el.classList.add("just-edited");
    setTimeout(() => el.classList.remove("just-edited"), 6500);
  }

  remember(...ids) {
    this.pendingFlash.push(...ids);
  }

  async reveal(el) {
    if (!el || reduced() || document.hidden) return;
    // On phones the agent panel sits over the bottom of the screen; centre the edit above it.
    const cover = this.cover?.() ?? 0;
    const usable = innerHeight - CHROME_BOTTOM - cover;
    const r = el.getBoundingClientRect();
    if (r.top < CHROME_TOP + 24 || r.bottom > usable - 24) {
      const top = scrollY + r.top - Math.max(CHROME_TOP + 24, usable / 2 - r.height / 2);
      scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      await sleep(420);
    }
  }

  async runJob(job, change) {
    this.status(change);
    switch (job.kind) {
      case "title": {
        const el = this.titleEl;
        if (!el) return;
        await this.reveal(el);
        await this.retype(el, job.oldText, job.newText);
        return;
      }
      case "text": {
        const el = this.leaf(job.targetId);
        if (!el) return;
        await this.reveal(el);
        await this.retype(el, job.oldText, job.newText);
        if (job.level) el.className = el.className.replace(/lvl-\d/, "lvl-" + job.level);
        this.remember(job.targetId);
        return;
      }
      case "replace": {
        const els = job.removed.map((n) => this.blockEl(n.id)).filter(Boolean);
        await this.reveal(els[0]);
        await this.eraseBlocks(job.removed);
        const anchor = job.afterId ? this.blockEl(job.afterId) : null;
        const ref = els[0]?.nextSibling ?? null;
        els.forEach((e) => e.remove());
        await this.typeBlocks(job.added, anchor, ref);
        return;
      }
      case "insert": {
        const anchor = job.afterId ? this.blockEl(job.afterId) : null;
        await this.typeBlocks(job.added, anchor, undefined);
        return;
      }
      case "insert_items": {
        const list = this.blockEl(job.listId);
        if (!list) return;
        await this.reveal(list);
        let after = job.afterItemId ? this.leaf(job.afterItemId) : null;
        for (const it of job.added) {
          const li = this.buildItem(it, true);
          if (after) after.after(li);
          else list.prepend(li);
          after = li;
          li.classList.add("tw-type");
          await this.type(li, it.text);
          li.classList.remove("tw-type");
          await sleep(120);
          tick(true);
        }
        this.remember(...job.added.map((i) => i.id));
        return;
      }
      case "delete_items": {
        for (const it of job.items) {
          const li = this.leaf(it.id);
          if (!li) continue;
          await this.reveal(li);
          li.classList.add("tw-erase");
          await this.erase(li, it.text);
          li.remove();
        }
        return;
      }
      case "delete": {
        await this.reveal(this.blockEl(job.removed[0].id));
        await this.eraseBlocks(job.removed, true);
        return;
      }
    }
  }

  /** In place: erase the old text, then type the new text into the same element. */
  async retype(el, oldText, newText) {
    // When most of the text is unchanged, erase and retype only the part that differs.
    const min = Math.min(oldText.length, newText.length);
    let p = 0;
    while (p < min && oldText[p] === newText[p]) p++;
    p = oldText.lastIndexOf(" ", p - 1) + 1; // back up to a word start
    let q = 0;
    while (q < min - p && oldText[oldText.length - 1 - q] === newText[newText.length - 1 - q]) q++;
    while (q > 0 && oldText[oldText.length - q] !== " ") q--; // tail starts at a word boundary
    if (p + q >= 12) {
      const head = document.createTextNode(oldText.slice(0, p));
      const tail = document.createTextNode(oldText.slice(oldText.length - q));
      const mid = document.createElement("span");
      el.replaceChildren(head, mid, tail);
      mid.classList.add("tw-erase");
      await this.erase(mid, oldText.slice(p, oldText.length - q));
      mid.classList.replace("tw-erase", "tw-type");
      await this.type(mid, newText.slice(p, newText.length - q));
      mid.classList.remove("tw-type");
      tick(true);
      return;
    }
    el.classList.add("tw-erase");
    await this.erase(el, oldText);
    el.classList.replace("tw-erase", "tw-type");
    await this.type(el, newText);
    el.classList.remove("tw-type");
    tick(true);
  }

  async eraseBlocks(nodes, remove = false) {
    for (const n of nodes) {
      const block = this.blockEl(n.id);
      if (!block) continue;
      const leaves = n.type === "list" ? n.items.map((i) => [this.leaf(i.id), i.text]) : [[block, n.text]];
      block.classList.add("tw-erase");
      for (const [el, text] of leaves) if (el) await this.erase(el, text);
      if (remove) {
        block.classList.add("collapse");
        await sleep(180);
        block.remove();
      }
    }
  }

  async typeBlocks(nodes, anchor, ref) {
    let prev = anchor;
    for (const n of nodes) {
      const el = this.buildBlock(n, { empty: true });
      if (prev) prev.after(el);
      else if (ref) ref.before(el);
      else if (this.titleEl) this.titleEl.after(el); // the start of the body is below the title
      else this.root.prepend(el);
      prev = el;
      el.classList.add("tw-type", "arrive");
      await this.reveal(el);
      const leaves = n.type === "list" ? n.items.map((i) => [this.leaf(i.id), i.text]) : [[el, n.text]];
      for (const [leaf, text] of leaves) {
        if (leaf) await this.type(leaf, text);
        tick(true);
        await sleep(90);
      }
      el.classList.remove("tw-type");
      this.remember(n.id, ...(n.items ?? []).map((i) => i.id));
    }
  }

  caretEl() {
    const c = document.createElement("span");
    c.className = "tw-caret";
    c.setAttribute("aria-hidden", "true");
    return c;
  }

  async erase(el, text, input = false) {
    const total = text.length;
    if (!total) return;
    const steps = Math.min(total, 50);
    const chunk = Math.ceil(total / steps);
    if (input) {
      for (let n = total; n > 0; n -= chunk) {
        el.value = text.slice(0, Math.max(0, n - chunk));
        tick();
        await sleep(14);
      }
      return;
    }
    const node = document.createTextNode(text);
    const caret = this.caretEl();
    el.replaceChildren(node, caret);
    for (let n = total; n > 0; n -= chunk) {
      node.data = text.slice(0, Math.max(0, n - chunk));
      tick();
      await sleep(12);
    }
    await sleep(90);
    caret.remove();
  }

  async type(el, text, input = false) {
    const total = text.length;
    const budget = Math.min(2600, Math.max(260, total * 26));
    const chunk = Math.max(1, Math.ceil((total * 9) / budget));
    const base = (budget / Math.max(1, total)) * chunk;
    if (input) {
      el.value = "";
      for (let n = 0; n < total; n += chunk) {
        el.value = text.slice(0, n + chunk);
        tick();
        await sleep(Math.max(12, base));
      }
      return;
    }
    const node = document.createTextNode("");
    const caret = this.caretEl();
    el.replaceChildren(node, caret);
    for (let n = 0; n < total; n += chunk) {
      node.data = text.slice(0, n + chunk);
      tick();
      const last = text[Math.min(total - 1, n + chunk - 1)];
      const jitter = 0.6 + Math.random() * 0.8;
      const pause = /[.,;:!?]/.test(last) ? base * 4 : 0;
      await sleep(Math.max(6, base * jitter + pause));
    }
    await sleep(120);
    caret.remove();
  }
}
