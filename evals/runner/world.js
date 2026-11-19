// A fresh document and the real tools for one scenario. The tools are built by the same function the page uses,
// so what an agent is tested against is what a real agent is offered. The only stand-ins are the two things that
// need a browser: what the person has selected, and what is on screen.
import { createHash } from "node:crypto";
import { Doc, SEED } from "../../site/model.js";
import { buildTools } from "../../site/tools.js";

/** The document as flat text by id, so a before and after can be compared. */
export function flatten(doc) {
  const texts = {};
  const order = [];
  for (const n of doc.nodes) {
    order.push(n.id);
    if (n.type === "list") {
      texts[n.id] = n.ordered ? "[numbered list]" : "[bulleted list]";
      for (const it of n.items) {
        order.push(it.id);
        texts[it.id] = it.text;
      }
    } else texts[n.id] = n.text;
  }
  return { title: doc.title, order, texts };
}

function setText(doc, id, text) {
  if (id === "title") return void (doc.title = text);
  const loc = doc.locate(id);
  if (!loc) throw new Error(`scenario: nothing with id ${id} in the document`);
  if (loc.kind === "item") loc.item.text = text;
  else loc.node.text = text;
}

/** What the page would report for a selection, computed from the document so it cannot drift from it. */
function selectionFor(doc, sel) {
  const loc = doc.locate(sel.id);
  if (!loc) throw new Error(`scenario: nothing with id ${sel.id} to select in`);
  const leafText = loc.kind === "item" ? loc.item.text : loc.node.text;
  const start = leafText.indexOf(sel.text);
  if (start < 0) throw new Error(`scenario: "${sel.text}" is not in ${sel.id}`);
  return { collapsed: false, parts: [{ id: sel.id, text: sel.text, start, end: start + sel.text.length, leafText }], source: "live", at: Date.now() };
}

export function makeWorld(scenario) {
  const doc = new Doc();
  doc.load(structuredClone(scenario.start?.doc ?? SEED));
  for (const [id, text] of Object.entries(scenario.start?.patches ?? {})) setText(doc, id, text);
  // Edits the person already made, applied the way the page applies them: straight to the document.
  for (const step of scenario.start?.setup ?? []) {
    setText(doc, step.id, step.text);
    doc.userChanged();
  }
  const selection = scenario.start?.selection;
  const tools = buildTools(doc, {
    selection: () => (selection ? selectionFor(doc, selection) : null),
    viewport: () => ({ visible: doc.nodes.slice(0, 8).map((n) => n.id), focused: true }),
  });
  return { doc, tools, start: flatten(doc), startMarkdown: doc.toMarkdown() };
}

/** What an agent is shown of the tools, and a hash so a result can be tied to a version of them. */
export function toolSurface(tools) {
  const defs = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
  return { hash: hash(defs), tools: defs.map((d) => d.name), hashes: Object.fromEntries(defs.map((d) => [d.name, hash(d)])) };
}
