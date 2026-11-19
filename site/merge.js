// Three-way merge of two edits to the same document, at the level of blocks and list items.
//
//   base   the revision both editors started from
//   mine   what the editor that is saving now made of it
//   theirs the server's current version (someone else saved since base)
//
// Blocks and list items have stable ids, so edits to different paragraphs both survive, new
// blocks from either side are kept, and a block one side deleted goes unless the other side
// changed it. When both sides changed the very same block's text, theirs (already saved) wins.
// Moving blocks around is not merged: the server's order stands.

const nodeSame = (a, b) => {
  if (a.type !== b.type) return false;
  if (a.type === "list") return !!a.ordered === !!b.ordered && a.items.length === b.items.length && a.items.every((it, i) => it.id === b.items[i].id && it.text === b.items[i].text);
  return a.text === b.text && (a.level ?? 0) === (b.level ?? 0);
};
const itemSame = (a, b) => a.text === b.text;

/** Merge two lists of things with ids. `both` decides when each side changed the same thing. */
function mergeSeq(base, mine, theirs, same, both) {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const out = [];
  for (const t of theirs) {
    const b = B.get(t.id);
    const m = M.get(t.id);
    if (!b) out.push(t); // added on the server since base
    else if (!m) {
      if (!same(t, b)) out.push(t); // I deleted it, but they edited it: keep their edit
    } else if (same(m, b)) out.push(t);
    else if (same(t, b)) out.push(m);
    else out.push(both(b, m, t));
  }
  // What I added goes in right after whatever preceded it for me.
  mine.forEach((m, k) => {
    if (B.has(m.id)) return;
    let pos = 0;
    for (let j = k - 1; j >= 0; j--) {
      const at = out.findIndex((o) => o.id === mine[j].id);
      if (at >= 0) {
        pos = at + 1;
        break;
      }
    }
    out.splice(pos, 0, m);
  });
  return out;
}

/**
 * Two editors can each create a block and give it the same new id. Give mine a fresh id when it
 * lands on one the server has already used for something else.
 */
function freshIds(base, mine, theirs, seq) {
  const taken = new Set();
  const note = (nodes) =>
    nodes.forEach((n) => {
      taken.add(n.id);
      if (n.type === "list") n.items.forEach((it) => taken.add(it.id));
    });
  note(theirs.nodes);
  const known = new Set();
  const learn = (nodes) =>
    nodes.forEach((n) => {
      known.add(n.id);
      if (n.type === "list") n.items.forEach((it) => known.add(it.id));
    });
  learn(base.nodes);
  const next = { n: seq.n, i: seq.i };
  const clash = (id) => !known.has(id) && taken.has(id);
  const nodes = mine.nodes.map((n) => {
    const copy = { ...n };
    if (clash(n.id)) copy.id = "n" + ++next.n;
    if (n.type === "list") copy.items = n.items.map((it) => (clash(it.id) ? { ...it, id: "i" + ++next.i } : it));
    return copy;
  });
  return { nodes, next };
}

/** The numeric part of the highest "n12" / "i7" style id, so new ids never repeat. */
const maxSeq = (nodes) => {
  let n = 0;
  let i = 0;
  const num = (id) => Number.parseInt(String(id).slice(1), 10) || 0;
  for (const node of nodes) {
    n = Math.max(n, num(node.id));
    if (node.type === "list") for (const it of node.items) i = Math.max(i, num(it.id));
  }
  return { n, i };
};

export function merge3(base, mine, theirs) {
  const seq = {
    n: Math.max(base.seq?.n ?? 0, mine.seq?.n ?? 0, theirs.seq?.n ?? 0),
    i: Math.max(base.seq?.i ?? 0, mine.seq?.i ?? 0, theirs.seq?.i ?? 0),
  };
  const fixed = freshIds(base, mine, theirs, seq);

  const nodes = mergeSeq(base.nodes, fixed.nodes, theirs.nodes, nodeSame, (b, m, t) => {
    if (b.type === "list" && m.type === "list" && t.type === "list") {
      return { ...t, items: mergeSeq(b.items, m.items, t.items, itemSame, (_b, _m, ti) => ti) };
    }
    return t;
  });

  const title = mine.title !== base.title && theirs.title === base.title ? mine.title : theirs.title;
  const top = maxSeq(nodes);
  return { title, nodes, seq: { n: Math.max(seq.n, fixed.next.n, top.n), i: Math.max(seq.i, fixed.next.i, top.i) } };
}
