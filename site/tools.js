// WebMCP tools. The page describes itself to the person's own agent; the agent
// supplies the judgment about which nodes to touch and sends back replacements.
import { LIMITS, ToolError } from "./model.js";

// What a tool says about itself. Every tool sets readOnlyHint to true or false, so a strict agent
// can classify it without guessing. None can reach outside this page, and none sends, buys or
// publishes anything, so none is consequential. Document text is written by people (and can be
// pasted from anywhere), so what comes back is untrusted text, never instructions.
const READ = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true };
const WRITE = { readOnlyHint: false, consequentialHint: false, untrustedContentHint: true };

const nodeSpec = {
  type: "object",
  description: "A document node. Plain text only.",
  properties: {
    type: { type: "string", enum: ["heading", "paragraph", "list", "quote"] },
    text: { type: "string", maxLength: LIMITS.text, description: `Text for heading, paragraph and quote nodes. At most ${LIMITS.text} characters (${LIMITS.heading} for a heading).` },
    level: { type: "integer", minimum: 1, maximum: 3, description: "Heading level. Defaults to 2." },
    items: { type: "array", maxItems: LIMITS.items, items: { type: "string", maxLength: LIMITS.item }, description: "Item texts for list nodes." },
    ordered: { type: "boolean", description: "List nodes only. True for a numbered list." },
  },
  required: ["type"],
};

const rev = {
  type: "integer",
  description: "Optional. The revision you last read. If the document has changed since, the call fails so you can re-read first.",
};

export function buildTools(doc, ctx = {}) {
  const wrap = (name, fn) => async (args) => {
    try {
      return fn(args ?? {});
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `Error: ${e?.message ?? "the action failed unexpectedly."}`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: { error: e?.code ?? "tool_failed", message },
        isError: true,
      };
    }
  };

  // Some agent clients only show `content`, so the data goes in the text too, not just structuredContent.
  const ok = (summary, data, { omit = [] } = {}) => {
    const shown = Object.fromEntries(Object.entries(data).filter(([k]) => !omit.includes(k)));
    return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(shown, null, 1)}` }], structuredContent: data };
  };

  const edited = (change, extra = {}) =>
    ok(change.label + `. The document is now at revision ${change.revision}.`, {
      revision: change.revision,
      removed: change.removed,
      added: change.added,
      ...extra,
    });

  const mutate = (name, fn) =>
    wrap(name, (a) => {
      doc.checkRevision(a.expected_revision);
      return edited(fn(a));
    });

  /** Where a node, list item or the title sits, in words the agent can reuse. */
  const where = (id) => {
    if (id === "title") return { type: "title", location: "the title" };
    const loc = doc.locate(id);
    if (!loc) return { type: "unknown", location: "(removed)" };
    if (loc.kind === "item") {
      const d = doc.describeItem(loc);
      return { type: "list_item", list_id: d.list_id, index: d.index, location: d.location, section: d.section };
    }
    const d = doc.describe(loc.node);
    return { type: d.type, location: d.location, section: d.section, ...(d.level ? { level: d.level } : {}) };
  };

  const noSelection = (extra = {}) =>
    ok(
      "Nothing is selected and the cursor is not in the document. Ask the person to select the text they mean, or use get_document.",
      { selected: false, revision: doc.revision, ...extra },
    );

  const defs = [
    {
      name: "get_document",
      title: "Read the document",
      description:
        "Returns the whole document as structured nodes: title, outline of headings, and every block with a stable id, type, text, section and a human location such as 'paragraph 2 in \"Schedule\"'. Lists carry per-item ids and 1-based indexes. Returns the ids and text in the result text itself. Call this first, then use the ids with the editing tools (or edit by location with replace_text).",
      inputSchema: { type: "object", properties: {} },
      annotations: READ,
      activity: () => "Reading the document",
      run: wrap("get_document", () => {
        const o = doc.overview();
        const lines = o.blocks.map((b) => `${b.id} ${b.location}: ${b.type === "list" ? b.items.map((i) => `[${i.id}] ${i.text}`).join(" | ") : b.text}`);
        return ok(`Revision ${o.revision}: "${o.title}" with ${o.blocks.length} blocks and ${o.outline.length} headings. Ids and text follow, in document order.\n${lines.join("\n")}`, o, { omit: ["markdown", "outline"] });
      }),
    },
    {
      name: "get_selection",
      title: "Read what the person has selected",
      description:
        "Returns the text the person has selected in the document, or their cursor position when nothing is selected, so a request like 'make this friendlier' or 'add a line after this' needs no description of where 'this' is. Each part gives the node or list item id, its location, the selected text, character offsets (start inclusive, end exclusive) and the full block_text, plus a little context before and after. source is 'live' while they still have it selected, or 'remembered' if they have clicked away since. If nothing is selected, say so and ask them to select the text, or fall back to get_document.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ,
      activity: () => "Reading your selection",
      run: wrap("get_selection", () => {
        const info = ctx.selection?.();
        if (!info) return noSelection();
        if (info.stale) return noSelection({ stale: true, note: "The earlier selection no longer matches the text, because the document changed." });
        const parts = info.parts.map((p) => ({ id: p.id, ...where(p.id), text: p.text, start: p.start, end: p.end, block_text: p.leafText }));
        const first = info.parts[0];
        const last = info.parts[info.parts.length - 1];
        const base = {
          revision: doc.revision,
          source: info.source,
          ...(info.source === "remembered" ? { age_seconds: Math.round((Date.now() - info.at) / 1000) } : {}),
        };
        if (info.collapsed) {
          const c = parts[0];
          return ok(`Nothing is selected. The cursor is in ${c.location} at character ${c.start} (${info.source}). Text there: "${c.block_text.slice(0, 160)}"`, {
            ...base,
            selected: false,
            cursor: { id: c.id, offset: c.start, ...where(c.id), block_text: c.block_text },
          });
        }
        const text = parts.map((p) => p.text).join("\n");
        const shown = text.length > 200 ? text.slice(0, 200) + "…" : text;
        const span = parts.length === 1 ? parts[0].location : `${parts.length} blocks starting at ${parts[0].location}`;
        return ok(`Selected ${text.length} characters in ${span} (${info.source}): "${shown}"`, {
          ...base,
          selected: true,
          text,
          parts,
          context: { before: first.leafText.slice(Math.max(0, first.start - 80), first.start), after: last.leafText.slice(last.end, last.end + 80) },
        });
      }),
    },
    {
      name: "get_view",
      title: "Read what is on screen",
      description: "Returns the ids and locations of the blocks currently visible in the person's window, top to bottom, and whether the document has keyboard focus. Useful for 'the paragraph I'm looking at' or 'the section below'.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ,
      activity: () => "Looking at your screen",
      run: wrap("get_view", () => {
        const v = ctx.viewport?.() ?? { visible: [], focused: false };
        const visible = v.visible.map((id) => ({ id, ...where(id) }));
        return ok(`${visible.length} blocks are visible${visible.length ? `, from ${visible[0].location} to ${visible[visible.length - 1].location}` : ""}.`, {
          revision: doc.revision,
          editor_focused: v.focused,
          visible,
        });
      }),
    },
    {
      name: "get_section",
      title: "Read one section",
      description:
        "Returns the blocks under one heading, up to the next heading of the same or higher level. Pass the heading text (case-insensitive) or its id. Includes last_block_id, which is handy for adding content at the end of the section.",
      inputSchema: {
        type: "object",
        properties: { heading: { type: "string", maxLength: LIMITS.ref, description: "Heading text or heading id." } },
        required: ["heading"],
      },
      annotations: READ,
      activity: (a) => `Reading section "${a.heading}"`,
      run: wrap("get_section", (a) => {
        const s = doc.section(a.heading);
        const lines = s.blocks.map((b) => `${b.id} ${b.location}: ${b.type === "list" ? b.items.map((i) => `[${i.id}] ${i.text}`).join(" | ") : b.text}`);
        return ok(`Section "${s.heading}" (heading id ${s.heading_id}, last block id ${s.last_block_id}) has ${s.blocks.length} blocks at revision ${s.revision}.\n${lines.join("\n")}`, s, { omit: ["blocks"] });
      }),
    },
    {
      name: "find_nodes",
      title: "Search the document",
      description: "Case-insensitive text search across blocks and list items. Returns matching blocks with ids. List results include matched_item_ids.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: LIMITS.query },
          type: { type: "string", enum: ["heading", "paragraph", "list", "quote"], description: "Optional. Only search this node type." },
        },
        required: ["query"],
      },
      annotations: READ,
      activity: (a) => `Searching for "${a.query}"`,
      run: wrap("find_nodes", (a) => {
        const r = doc.find(a.query, a.type);
        const ids = r.matches.map((m) => `${m.id} (${m.location}${m.matched_item_ids ? `, items ${m.matched_item_ids.join(" ")}` : ""})`).join("; ");
        return ok(`${r.count} ${r.count === 1 ? "match" : "matches"} for "${a.query}"${r.count ? `: ${ids}` : ""}.`, r);
      }),
    },
    {
      name: "replace_text",
      title: "Rewrite one block or list item",
      description:
        "Replaces the text of a single heading, paragraph, quote or list item, keeping its id. Identify the target either by id, or without any prior read by location: heading (text or id) plus block (1-based position among the non-heading blocks under that heading) and optionally item (1-based list item) and type. Examples: {heading:'Goals', block:1, text:'…'} rewrites the first block under Goals; {heading:'Schedule', block:1, item:2, text:'…'} rewrites the second bullet. Omit block to rewrite the heading itself. The result returns the old and new node.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: LIMITS.ref, description: "Node id (n…) or list item id (i…). Use this or the location fields." },
          heading: { type: "string", maxLength: LIMITS.ref, description: "Location: heading text or id. Use 'opening' for content before the first heading." },
          block: { type: "integer", minimum: 1, maximum: LIMITS.docNodes, description: "Location: 1-based position under the heading, counting non-heading blocks (or only those of `type`)." },
          type: { type: "string", enum: ["paragraph", "list", "quote"], description: "Location: only count blocks of this type." },
          item: { type: "integer", minimum: 1, maximum: LIMITS.docNodes, description: "Location: 1-based list item within the block." },
          text: { type: "string", maxLength: LIMITS.text, description: `The complete new text. At most ${LIMITS.text} characters (${LIMITS.item} for a list item, ${LIMITS.heading} for a heading).` },
          expected_revision: rev,
        },
        required: ["text"],
      },
      annotations: WRITE,
      activity: (a) => `Rewriting ${a.id ?? `${a.heading ?? "opening"} block ${a.block ?? ""}`}`,
      run: mutate("replace_text", (a) => {
        let id = a.id;
        if (!id) {
          if (a.heading == null && a.block == null) throw new ToolError("Error: pass an id, or a location: heading and block (and item for list items).");
          id = doc.resolveLocation(a).id;
        }
        return doc.replaceText("replace_text", id, a.text);
      }),
    },
    {
      name: "replace_selection",
      title: "Replace the selected text",
      description:
        "Replaces exactly the text the person has selected (see get_selection) with new text, leaving the rest of that block untouched. Works when the selection is inside one block or list item, including after they have clicked away. If it spans several blocks, use replace_text on each id from get_selection. Pass expected_text, the selection you read, to be sure it has not changed. The result returns the old and new node.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: LIMITS.text, description: "The text that replaces the selection." },
          expected_text: { type: "string", maxLength: LIMITS.text, description: "Optional. The selected text you read. The call fails if the selection is now different." },
          expected_revision: rev,
        },
        required: ["text"],
      },
      annotations: WRITE,
      activity: () => "Rewriting your selection",
      run: wrap("replace_selection", (a) => {
        doc.checkRevision(a.expected_revision);
        const info = ctx.selection?.();
        if (!info || info.stale || info.collapsed) {
          throw new ToolError("Error: there is no selected text to replace. Call get_selection first, or ask the person to select the text they mean.", "no_selection");
        }
        if (info.parts.length !== 1) {
          throw new ToolError(`Error: the selection spans ${info.parts.length} blocks, and replace_selection handles one. Use replace_text on each id from get_selection, or replace_nodes.`);
        }
        const p = info.parts[0];
        if (a.expected_text !== undefined && a.expected_text !== p.text) {
          throw new ToolError(`Error: the selection is now "${p.text.slice(0, 120)}", not what you read. Call get_selection again.`, "selection_changed");
        }
        const full = p.leafText.slice(0, p.start) + a.text + p.leafText.slice(p.end);
        const change = p.id === "title" ? doc.setTitle("replace_selection", full) : doc.replaceText("replace_selection", p.id, full);
        return edited(change);
      }),
    },
    {
      name: "replace_nodes",
      title: "Replace blocks with new blocks",
      description:
        "Swaps one or more existing top-level nodes for a new set of nodes, placed where the first replaced node was. Use it to restructure, for example turning a paragraph into a list, splitting a paragraph in two, or rewriting a section body. The result returns the old set and the new set.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", maxItems: LIMITS.ids, items: { type: "string", maxLength: LIMITS.ref }, minItems: 1, description: "Ids of the top-level nodes to replace." },
          nodes: { type: "array", maxItems: LIMITS.nodes, items: nodeSpec, minItems: 1, description: "The replacement nodes, in order." },
          expected_revision: rev,
        },
        required: ["ids", "nodes"],
      },
      annotations: WRITE,
      activity: (a) => `Replacing ${a.ids?.length ?? 0} block(s)`,
      run: mutate("replace_nodes", (a) => doc.replaceNodes("replace_nodes", a.ids, a.nodes)),
    },
    {
      name: "insert_nodes",
      title: "Insert new blocks",
      description:
        "Adds new nodes. position is 'start' or 'end' of the document, 'after' or 'before' a node id given as target, or 'end_of_section' with a heading id or heading text as target.",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "string", enum: ["start", "end", "after", "before", "end_of_section"] },
          target: { type: "string", maxLength: LIMITS.ref, description: "Node id for after/before. Heading id or text for end_of_section. Not needed for start/end." },
          nodes: { type: "array", maxItems: LIMITS.nodes, items: nodeSpec, minItems: 1 },
          expected_revision: rev,
        },
        required: ["position", "nodes"],
      },
      annotations: WRITE,
      activity: (a) => `Inserting ${a.nodes?.length ?? 0} block(s)`,
      run: mutate("insert_nodes", (a) => doc.insertNodes("insert_nodes", a.position, a.target, a.nodes)),
    },
    {
      name: "insert_list_items",
      title: "Add items to a list",
      description: "Adds items to an existing list, after a given item or at the start or end (default end).",
      inputSchema: {
        type: "object",
        properties: {
          list_id: { type: "string", maxLength: LIMITS.ref },
          items: { type: "array", maxItems: LIMITS.items, items: { type: "string", maxLength: LIMITS.item }, minItems: 1 },
          after_item_id: { type: "string", maxLength: LIMITS.ref, description: "Optional. Insert after this item id." },
          position: { type: "string", enum: ["start", "end"], description: "Used when after_item_id is not given. Defaults to end." },
          expected_revision: rev,
        },
        required: ["list_id", "items"],
      },
      annotations: WRITE,
      activity: (a) => `Adding ${a.items?.length ?? 0} item(s) to ${a.list_id}`,
      run: mutate("insert_list_items", (a) => doc.insertListItems("insert_list_items", a.list_id, a.items, a.after_item_id, a.position)),
    },
    {
      name: "delete_nodes",
      title: "Delete blocks or list items",
      description:
        "Deletes top-level nodes and/or individual list items by id. A list whose items are all deleted is removed. The result returns what was removed.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", maxItems: LIMITS.ids, items: { type: "string", maxLength: LIMITS.ref }, minItems: 1 },
          expected_revision: rev,
        },
        required: ["ids"],
      },
      annotations: { ...WRITE, destructiveHint: true },
      activity: (a) => `Deleting ${a.ids?.length ?? 0} item(s)`,
      run: mutate("delete_nodes", (a) => doc.deleteNodes("delete_nodes", a.ids)),
    },
    {
      name: "set_title",
      title: "Set the document title",
      description: "Replaces the document title.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", maxLength: LIMITS.title }, expected_revision: rev },
        required: ["title"],
      },
      annotations: WRITE,
      activity: () => "Retitling the document",
      run: mutate("set_title", (a) => doc.setTitle("set_title", a.title)),
    },
  ];
  return defs;
}

/* ------------------------------ registration ------------------------------ */

export function getModelContext() {
  return document.modelContext ?? navigator.modelContext ?? null;
}

/**
 * Registers every tool with WebMCP when the browser supports it. Returns
 * { supported, count, dispose }. The site works without WebMCP; the person can
 * still type in the document.
 */
export function registerTools(defs, { onCall } = {}) {
  const mc = getModelContext();
  if (!mc || typeof mc.registerTool !== "function") return { supported: false, count: 0, dispose() {} };
  const ctrl = new AbortController();
  let count = 0;
  defs.forEach((d) => {
    const descriptor = {
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: d.inputSchema,
      annotations: d.annotations,
      execute: async (args) => {
        onCall?.(d, args ?? {});
        return d.run(args);
      },
    };
    try {
      // Chrome's implementation returns nothing; the spec says a promise. Ignore the value.
      mc.registerTool(descriptor, { signal: ctrl.signal });
      count++;
    } catch (e) {
      console.warn("[ghostwriter] could not register", d.name, e);
    }
  });
  return { supported: true, count, dispose: () => ctrl.abort() };
}
