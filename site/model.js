// Document model: the single source of truth. The editor view and the WebMCP
// tools both go through this, so what the agent sees is what the person sees.
//
// Node shapes (plain text only):
//   heading   { id, type, level 1-3, text }
//   paragraph { id, type, text }
//   quote     { id, type, text }
//   list      { id, type, ordered, items: [{ id, text }] }

export const TYPES = ["heading", "paragraph", "list", "quote"];

export class ToolError extends Error {
  constructor(message, code = "invalid_request") {
    super(message);
    this.code = code;
  }
}

/**
 * How much a tool call may carry. Every free-text field and list has a ceiling: an unbounded
 * field is also a way to push a lot of text through a tool. The tool schemas advertise the same
 * numbers (tools.js), and these checks enforce them whatever an agent does with the schema.
 */
export const LIMITS = { title: 200, heading: 200, text: 5000, item: 500, items: 100, nodes: 50, ids: 100, query: 200, ref: 200, docNodes: 1000 };

const cap = (v, max, what) => {
  if (typeof v !== "string") throw new ToolError(`Error: ${what} must be text.`);
  if (v.length > max) throw new ToolError(`Error: ${what} is ${v.length} characters; the limit is ${max}.`, "too_long");
  return v;
};
const capList = (a, max, what) => {
  if (!Array.isArray(a)) throw new ToolError(`Error: ${what} must be a list.`);
  if (a.length > max) throw new ToolError(`Error: ${what} has ${a.length} entries; the limit is ${max}.`, "too_long");
  return a;
};
const capIndex = (n, what) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > LIMITS.docNodes) throw new ToolError(`Error: ${what} must be a whole number from 1 to ${LIMITS.docNodes}.`);
  return v;
};

const clean = (t) => String(t ?? "").replace(/\s*\n+\s*/g, " ");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export const SEED = {
  title: "Weekend at the lake",
  nodes: [
    { type: "paragraph", text: "We are driving up Friday after work and heading home Sunday afternoon. This page is the plan, and it changes often." },
    { type: "heading", level: 2, text: "Goals" },
    { type: "paragraph", text: "Rest, swim, and cook one proper dinner. Nobody checks email." },
    { type: "heading", level: 2, text: "Schedule" },
    {
      type: "list",
      items: [
        "Friday: leave by 5:30 pm and stop for groceries in Issaquah",
        "Saturday: paddleboards in the morning, long lunch, nap",
        "Saturday evening: grill the salmon and eat on the dock",
        "Sunday: pack up, last swim, home by 4 pm",
      ],
    },
    { type: "heading", level: 2, text: "Packing" },
    { type: "list", items: ["Dog bowls and Gus's food", "Sunscreen", "Board games", "Two extra towels"] },
    { type: "heading", level: 2, text: "Notes" },
    { type: "quote", text: "The water is coldest in the morning, so plan the swim after lunch." },
    { type: "paragraph", text: "The cabin has no dishwasher. Bring dish soap." },
  ],
};

export class Doc {
  constructor() {
    this.title = "";
    this.nodes = [];
    this.revision = 1;
    this.seq = { n: 0, i: 0 };
    this.subs = new Set();
  }

  /* ----------------------------- lifecycle ------------------------------ */

  load(data) {
    this.title = clean(data.title ?? "");
    this.revision = data.revision ?? 1;
    this.seq = data.seq ?? { n: 0, i: 0 };
    if (data.seq) {
      this.nodes = data.nodes;
    } else {
      this.nodes = data.nodes.map((s) => this.makeNode(s));
    }
  }

  serialize() {
    return { title: this.title, nodes: this.nodes, revision: this.revision, seq: this.seq };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.serialize()));
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(event) {
    this.subs.forEach((fn) => fn(event));
  }

  newId(kind) {
    return kind + ++this.seq[kind];
  }

  bump() {
    this.revision += 1;
  }

  /* ------------------------------- nodes -------------------------------- */

  makeNode(spec) {
    if (!spec || typeof spec !== "object") throw new ToolError("Error: each node must be an object with a type.");
    const type = spec.type;
    if (!TYPES.includes(type)) {
      throw new ToolError(`Error: unknown node type "${type}". Use heading, paragraph, list or quote.`);
    }
    if (type === "list") {
      const items = spec.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new ToolError("Error: a list node needs a non-empty items array of strings.");
      }
      capList(items, LIMITS.items, "a list's items");
      const texts = items.map((t) => clean(cap(typeof t === "object" && t ? t.text : t, LIMITS.item, "a list item")));
      return { id: this.newId("n"), type, ordered: !!spec.ordered, items: texts.map((text) => ({ id: this.newId("i"), text })) };
    }
    if (typeof spec.text !== "string") throw new ToolError(`Error: a ${type} node needs a text string.`);
    cap(spec.text, type === "heading" ? LIMITS.heading : LIMITS.text, `a ${type}'s text`);
    const node = { id: this.newId("n"), type, text: clean(spec.text) };
    if (type === "heading") node.level = clamp(Math.round(Number(spec.level ?? 2)) || 2, 1, 3);
    return node;
  }

  /** Builds several nodes. If any is refused, no id has been used up by the others. */
  makeNodes(specs) {
    const seq = { ...this.seq };
    try {
      return specs.map((s) => this.makeNode(s));
    } catch (e) {
      this.seq = seq;
      throw e;
    }
  }

  locate(id) {
    for (let index = 0; index < this.nodes.length; index++) {
      const node = this.nodes[index];
      if (node.id === id) return { kind: "node", node, index };
      if (node.type === "list") {
        const itemIndex = node.items.findIndex((it) => it.id === id);
        if (itemIndex >= 0) return { kind: "item", node, index, item: node.items[itemIndex], itemIndex };
      }
    }
    return null;
  }

  mustNode(id, what = "node") {
    const loc = this.locate(id);
    if (!loc) throw new ToolError(`Error: no ${what} with id "${id}". Call get_document for current ids.`, "not_found");
    if (loc.kind === "item") {
      throw new ToolError(`Error: "${id}" is a list item. Pass its list id "${loc.node.id}", or use replace_text / delete_nodes / insert_list_items for items.`);
    }
    return loc;
  }

  /** Where each top-level node sits: its section heading and its ordinal among siblings of that type. */
  placement() {
    const map = new Map();
    let section = null;
    const counts = {};
    this.nodes.forEach((node) => {
      if (node.type === "heading") {
        section = node.text;
        Object.keys(counts).forEach((k) => delete counts[k]);
        map.set(node.id, { section: node.text, ordinal: 0 });
        return;
      }
      counts[node.type] = (counts[node.type] ?? 0) + 1;
      map.set(node.id, { section, ordinal: counts[node.type] });
    });
    return map;
  }

  /** A node as the agent sees it. */
  describe(node, placement = this.placement()) {
    const p = placement.get(node.id) ?? { section: null, ordinal: 0 };
    const where = p.section ? `in "${p.section}"` : "in the opening";
    let location;
    if (node.type === "heading") location = `heading "${node.text}"`;
    else location = `${node.type} ${p.ordinal} ${where}`;
    const out = { id: node.id, type: node.type, location, section: p.section };
    if (node.type === "heading") {
      out.level = node.level;
      out.text = node.text;
    } else if (node.type === "list") {
      out.ordered = node.ordered;
      out.items = node.items.map((it, i) => ({ id: it.id, index: i + 1, text: it.text }));
    } else {
      out.text = node.text;
    }
    return out;
  }

  describeItem(loc, placement = this.placement()) {
    const listDesc = this.describe(loc.node, placement);
    return {
      id: loc.item.id,
      type: "list_item",
      list_id: loc.node.id,
      index: loc.itemIndex + 1,
      location: `item ${loc.itemIndex + 1} of ${listDesc.location}`,
      section: listDesc.section,
      text: loc.item.text,
    };
  }

  /** One-line plain rendering of a described node, used in the change log. */
  static repr(d) {
    if (d.type === "heading") return "#".repeat(d.level) + " " + d.text;
    if (d.type === "list") return d.items.map((it, i) => (d.ordered ? `${i + 1}. ` : "- ") + it.text).join("\n");
    if (d.type === "quote") return "> " + d.text;
    return d.text;
  }

  toMarkdown() {
    const lines = [];
    if (this.title) lines.push("# " + this.title, "");
    this.nodes.forEach((n) => {
      const d = this.describe(n);
      lines.push(n.type === "heading" ? "#".repeat(n.level + (this.title ? 1 : 0)) + " " + n.text : Doc.repr(d), "");
    });
    return lines.join("\n").trim();
  }

  /* ------------------------------- reads -------------------------------- */

  overview() {
    const placement = this.placement();
    return {
      title: this.title,
      revision: this.revision,
      outline: this.nodes
        .filter((n) => n.type === "heading")
        .map((n) => ({ id: n.id, level: n.level, text: n.text })),
      blocks: this.nodes.map((n) => this.describe(n, placement)),
      markdown: this.toMarkdown(),
    };
  }

  headings() {
    return this.nodes.filter((n) => n.type === "heading");
  }

  /** Resolve a heading by id or by its text. */
  resolveHeading(ref) {
    cap(ref, LIMITS.ref, "a heading reference");
    const heads = this.headings();
    const available = heads.map((h) => `"${h.text}" (${h.id})`).join(", ") || "none yet";
    const byId = heads.find((h) => h.id === ref);
    if (byId) return byId;
    const matches = heads.filter((h) => norm(h.text) === norm(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ToolError(`Error: ${matches.length} headings are titled "${ref}". Pass a heading id instead: ${matches.map((h) => h.id).join(", ")}.`, "ambiguous");
    }
    const partial = heads.filter((h) => norm(h.text).includes(norm(ref)));
    if (partial.length === 1) return partial[0];
    throw new ToolError(`Error: no heading matches "${ref}". Headings: ${available}.`, "not_found");
  }

  /** Index range [start, end) of a section: its heading through the node before the next heading of equal or higher rank. */
  sectionRange(heading) {
    const start = this.nodes.indexOf(heading);
    let end = start + 1;
    while (end < this.nodes.length) {
      const n = this.nodes[end];
      if (n.type === "heading" && n.level <= heading.level) break;
      end++;
    }
    return [start, end];
  }

  section(ref) {
    const heading = this.resolveHeading(ref);
    const [start, end] = this.sectionRange(heading);
    const placement = this.placement();
    const blocks = this.nodes.slice(start, end).map((n) => this.describe(n, placement));
    return { heading: heading.text, heading_id: heading.id, revision: this.revision, blocks, last_block_id: this.nodes[end - 1].id };
  }

  /**
   * Resolve "block N under heading X" (optionally "item M" of a list) to an id, so an
   * agent can edit without a prior read. N counts the non-heading blocks directly under
   * the heading, or only those of `type` when given. heading "opening" means before the first heading.
   */
  resolveLocation({ heading, block, type, item }) {
    let start;
    let name;
    if (heading != null) cap(heading, LIMITS.ref, "heading");
    if (block != null) capIndex(block, "block");
    if (item != null) capIndex(item, "item");
    if (heading && !this.headings().some((h) => norm(h.text) === norm(heading) || h.id === heading) && norm(heading) === "opening") heading = null;
    if (heading) {
      const h = this.resolveHeading(heading);
      start = this.nodes.indexOf(h) + 1;
      name = `"${h.text}"`;
      if (block == null) return { id: h.id, label: `heading ${name}` };
    } else {
      start = 0;
      name = "the opening";
    }
    let end = start;
    while (end < this.nodes.length && this.nodes[end].type !== "heading") end++;
    const pool = this.nodes.slice(start, end).filter((n) => !type || n.type === type);
    const n = pool[Number(block) - 1];
    if (!n) {
      throw new ToolError(`Error: ${name} has ${pool.length} ${type ?? "non-heading"} block(s); block ${block} does not exist. Call get_section to see them.`, "not_found");
    }
    if (item != null) {
      if (n.type !== "list") throw new ToolError(`Error: block ${block} under ${name} is a ${n.type}, not a list, so it has no items.`);
      const it = n.items[Number(item) - 1];
      if (!it) throw new ToolError(`Error: that list has ${n.items.length} item(s); item ${item} does not exist.`, "not_found");
      return { id: it.id, label: `item ${item} of ${n.type} ${block} under ${name}` };
    }
    return { id: n.id, label: `${n.type} ${block} under ${name}` };
  }

  find(query, type) {
    cap(query, LIMITS.query, "the query");
    const q = norm(query);
    if (!q) throw new ToolError("Error: query must not be empty.");
    const placement = this.placement();
    const hits = [];
    this.nodes.forEach((n) => {
      if (type && n.type !== type) return;
      if (n.type === "list") {
        const matching = n.items.filter((it) => norm(it.text).includes(q));
        if (matching.length) {
          const d = this.describe(n, placement);
          d.matched_item_ids = matching.map((it) => it.id);
          hits.push(d);
        }
      } else if (norm(n.text).includes(q)) {
        hits.push(this.describe(n, placement));
      }
    });
    return { query, revision: this.revision, count: hits.length, matches: hits };
  }

  /* ------------------------------ mutations ------------------------------ */

  checkRoom(extra) {
    if (this.nodes.length + extra > LIMITS.docNodes) {
      throw new ToolError(`Error: the document can hold at most ${LIMITS.docNodes} blocks.`, "too_long");
    }
  }

  checkRevision(expected) {
    if (expected !== undefined && expected !== null && expected !== this.revision) {
      throw new ToolError(
        `Error: the document changed since you read it (now revision ${this.revision}, you sent ${expected}). Call get_document or get_section again, then retry.`,
        "stale_revision",
      );
    }
  }

  record(tool, op, label, removed, added, jobs) {
    this.bump();
    const change = { tool, op, label, removed, added, jobs, revision: this.revision, at: Date.now() };
    this.emit({ type: "agent-change", change });
    return change;
  }

  setTitle(tool, title) {
    cap(title, LIMITS.title, "the title");
    const old = this.title;
    this.title = clean(title);
    return this.record(tool, "replaced", "Retitled the document", [{ id: "title", type: "title", text: old, location: "title" }], [{ id: "title", type: "title", text: this.title, location: "title" }], [
      { kind: "title", oldText: old, newText: this.title },
    ]);
  }

  replaceText(tool, id, text) {
    cap(id, LIMITS.ref, "the id");
    const loc = this.locate(id);
    if (!loc) throw new ToolError(`Error: no node or list item with id "${id}". Call get_document for current ids.`, "not_found");
    cap(text, loc.kind === "item" ? LIMITS.item : loc.node.type === "heading" ? LIMITS.heading : LIMITS.text, "the text");
    const placement = this.placement();
    if (loc.kind === "item") {
      const before = this.describeItem(loc, placement);
      loc.item.text = clean(text);
      const after = this.describeItem(loc, placement);
      return this.record(tool, "replaced", `Rewrote ${before.location}`, [before], [after], [
        { kind: "text", targetId: id, oldText: before.text, newText: after.text },
      ]);
    }
    if (loc.node.type === "list") {
      throw new ToolError(`Error: "${id}" is a list. Pass one of its item ids to replace_text, or use replace_nodes to rewrite the whole list.`);
    }
    const before = this.describe(loc.node, placement);
    loc.node.text = clean(text);
    const after = this.describe(loc.node, placement);
    return this.record(tool, "replaced", `Rewrote ${before.location}`, [before], [after], [
      { kind: "text", targetId: id, oldText: before.text, newText: after.text },
    ]);
  }

  replaceNodes(tool, ids, specs) {
    if (!Array.isArray(ids) || ids.length === 0) throw new ToolError("Error: ids must list at least one node id.");
    if (!Array.isArray(specs) || specs.length === 0) throw new ToolError("Error: nodes must contain at least one replacement node. To remove content use delete_nodes.");
    capList(ids, LIMITS.ids, "ids");
    capList(specs, LIMITS.nodes, "nodes");
    ids.forEach((i) => cap(i, LIMITS.ref, "an id"));
    const locs = [...new Set(ids)].map((id) => this.mustNode(id));
    locs.sort((a, b) => a.index - b.index);
    const placement = this.placement();
    const removed = locs.map((l) => this.describe(l.node, placement));
    const first = locs[0].index;
    const afterId = first > 0 ? this.nodes[first - 1].id : null;
    const removedNodes = locs.map((l) => JSON.parse(JSON.stringify(l.node)));

    const only = locs.length === 1 && specs.length === 1 ? locs[0].node : null;
    const reuse =
      only && only.type !== "list" && only.type === specs[0].type && typeof specs[0].text === "string";

    let added;
    if (reuse) {
      cap(specs[0].text, only.type === "heading" ? LIMITS.heading : LIMITS.text, `a ${only.type}'s text`);
      const oldText = only.text;
      only.text = clean(specs[0].text);
      if (only.type === "heading" && specs[0].level != null) only.level = clamp(Math.round(Number(specs[0].level)) || only.level, 1, 3);
      added = [this.describe(only, placement)];
      return this.record(tool, "replaced", `Rewrote ${removed[0].location}`, removed, added, [
        { kind: "text", targetId: only.id, oldText, newText: only.text, level: only.level },
      ]);
    }

    const fresh = this.makeNodes(specs);
    this.checkRoom(fresh.length - locs.length);
    const drop = new Set(locs.map((l) => l.node.id));
    this.nodes = this.nodes.filter((n) => !drop.has(n.id));
    this.nodes.splice(first, 0, ...fresh);
    const p2 = this.placement();
    added = fresh.map((n) => this.describe(n, p2));
    return this.record(tool, "replaced", `Replaced ${removed.length} ${removed.length === 1 ? "block" : "blocks"} starting at ${removed[0].location}`, removed, added, [
      { kind: "replace", removed: removedNodes, added: JSON.parse(JSON.stringify(fresh)), afterId },
    ]);
  }

  insertNodes(tool, position, target, specs) {
    if (!Array.isArray(specs) || specs.length === 0) throw new ToolError("Error: nodes must contain at least one node to insert.");
    capList(specs, LIMITS.nodes, "nodes");
    if (target != null) cap(target, LIMITS.ref, "target");
    this.checkRoom(specs.length);
    let index;
    let label;
    switch (position) {
      case "start":
        index = 0;
        label = "the start of the document";
        break;
      case "end":
        index = this.nodes.length;
        label = "the end of the document";
        break;
      case "after":
      case "before": {
        if (!target) throw new ToolError(`Error: position "${position}" needs a target node id.`);
        const loc = this.mustNode(target);
        index = position === "after" ? loc.index + 1 : loc.index;
        label = `${position} ${this.describe(loc.node).location}`;
        break;
      }
      case "end_of_section": {
        if (!target) throw new ToolError('Error: position "end_of_section" needs a target heading id or heading text.');
        const heading = this.resolveHeading(target);
        index = this.sectionRange(heading)[1];
        label = `the end of "${heading.text}"`;
        break;
      }
      default:
        throw new ToolError('Error: position must be one of start, end, after, before, end_of_section.');
    }
    const fresh = this.makeNodes(specs);
    const afterId = index > 0 ? this.nodes[index - 1].id : null;
    this.nodes.splice(index, 0, ...fresh);
    const placement = this.placement();
    const added = fresh.map((n) => this.describe(n, placement));
    return this.record(tool, "inserted", `Added ${fresh.length} ${fresh.length === 1 ? "block" : "blocks"} at ${label}`, [], added, [
      { kind: "insert", added: JSON.parse(JSON.stringify(fresh)), afterId },
    ]);
  }

  insertListItems(tool, listId, items, afterItemId, position) {
    const loc = this.mustNode(listId, "list");
    if (loc.node.type !== "list") throw new ToolError(`Error: "${listId}" is a ${loc.node.type}, not a list. Use insert_nodes to add a new list.`);
    if (!Array.isArray(items) || items.length === 0) throw new ToolError("Error: items must contain at least one string.");
    capList(items, LIMITS.items, "items");
    items.forEach((t) => cap(typeof t === "object" && t ? t.text : t, LIMITS.item, "a list item"));
    if (loc.node.items.length + items.length > LIMITS.docNodes) throw new ToolError(`Error: a list can hold at most ${LIMITS.docNodes} items.`, "too_long");
    let at;
    if (afterItemId) {
      const i = loc.node.items.findIndex((it) => it.id === afterItemId);
      if (i < 0) throw new ToolError(`Error: "${afterItemId}" is not an item of list "${listId}".`, "not_found");
      at = i + 1;
    } else {
      at = position === "start" ? 0 : loc.node.items.length;
    }
    const fresh = items.map((t) => ({ id: this.newId("i"), text: clean(typeof t === "object" && t ? t.text : t) }));
    const afterItem = at > 0 ? loc.node.items[at - 1].id : null;
    loc.node.items.splice(at, 0, ...fresh);
    const placement = this.placement();
    const listDesc = this.describe(loc.node, placement);
    const added = fresh.map((it, k) => ({
      id: it.id,
      type: "list_item",
      list_id: listId,
      index: at + k + 1,
      location: `item ${at + k + 1} of ${listDesc.location}`,
      section: listDesc.section,
      text: it.text,
    }));
    return this.record(tool, "inserted", `Added ${fresh.length} ${fresh.length === 1 ? "item" : "items"} to ${listDesc.location}`, [], added, [
      { kind: "insert_items", listId, added: JSON.parse(JSON.stringify(fresh)), afterItemId: afterItem },
    ]);
  }

  deleteNodes(tool, ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new ToolError("Error: ids must list at least one node or item id.");
    capList(ids, LIMITS.ids, "ids");
    ids.forEach((i) => cap(i, LIMITS.ref, "an id"));
    const unique = [...new Set(ids)];
    const placement = this.placement();
    const removed = [];
    const nodeIds = new Set();
    const itemHits = [];
    unique.forEach((id) => {
      const loc = this.locate(id);
      if (!loc) throw new ToolError(`Error: no node or list item with id "${id}". Call get_document for current ids.`, "not_found");
      if (loc.kind === "node") nodeIds.add(id);
      else itemHits.push(loc);
    });

    const jobs = [];
    // Items inside a list that is itself being deleted go with the list.
    const itemsToDelete = itemHits.filter((l) => !nodeIds.has(l.node.id));
    const byList = new Map();
    itemsToDelete.forEach((l) => {
      if (!byList.has(l.node.id)) byList.set(l.node.id, []);
      byList.get(l.node.id).push(l);
    });

    byList.forEach((locs, listId) => {
      const list = locs[0].node;
      if (locs.length >= list.items.length) {
        nodeIds.add(listId); // every item goes, so the list goes
        return;
      }
      locs.forEach((l) => removed.push(this.describeItem(l, placement)));
      jobs.push({ kind: "delete_items", items: locs.map((l) => ({ id: l.item.id, text: l.item.text })) });
      const gone = new Set(locs.map((l) => l.item.id));
      list.items = list.items.filter((it) => !gone.has(it.id));
    });

    const doomed = this.nodes.filter((n) => nodeIds.has(n.id));
    if (doomed.length) {
      removed.unshift(...doomed.map((n) => this.describe(n, placement)));
      jobs.push({ kind: "delete", removed: JSON.parse(JSON.stringify(doomed)) });
      this.nodes = this.nodes.filter((n) => !nodeIds.has(n.id));
    }
    return this.record(tool, "deleted", `Removed ${removed.length} ${removed.length === 1 ? "block or item" : "blocks and items"}`, removed, [], jobs);
  }

  /* ----------------------------- user edits ------------------------------ */

  /** Called by the editor for the person's own typing. Not logged as an agent change. */
  userChanged() {
    this.bump();
    this.emit({ type: "user-change" });
  }

  restore(snapshot) {
    const rev = this.revision;
    const seq = { ...this.seq };
    this.load(snapshot);
    this.seq = seq; // never reuse an id the agent may still hold
    this.revision = rev + 1;
    this.emit({ type: "restored" });
  }
}
