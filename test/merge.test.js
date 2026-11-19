import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3 } from "../site/merge.js";

const P = (id, text) => ({ id, type: "paragraph", text });
const L = (id, items) => ({ id, type: "list", ordered: false, items: items.map(([i, t]) => ({ id: i, text: t })) });
const doc = (title, nodes, n = 20, i = 20) => ({ title, nodes, seq: { n, i } });
const texts = (d) => d.nodes.map((n) => (n.type === "list" ? n.items.map((x) => x.text).join("|") : n.text));

const base = doc("Plan", [P("n1", "Intro"), P("n2", "Middle"), P("n3", "End")]);

test("edits to different paragraphs both survive", () => {
  const mine = doc("Plan", [P("n1", "Intro, edited by me"), P("n2", "Middle"), P("n3", "End")]);
  const theirs = doc("Plan", [P("n1", "Intro"), P("n2", "Middle"), P("n3", "End, edited by them")]);
  assert.deepEqual(texts(merge3(base, mine, theirs)), ["Intro, edited by me", "Middle", "End, edited by them"]);
});

test("the same paragraph edited on both sides: the saved one (theirs) wins", () => {
  const mine = doc("Plan", [P("n1", "mine"), P("n2", "Middle"), P("n3", "End")]);
  const theirs = doc("Plan", [P("n1", "theirs"), P("n2", "Middle"), P("n3", "End")]);
  assert.deepEqual(texts(merge3(base, mine, theirs)), ["theirs", "Middle", "End"]);
});

test("blocks added on both sides are both kept, in place", () => {
  const mine = doc("Plan", [P("n1", "Intro"), P("n4", "mine, after intro"), P("n2", "Middle"), P("n3", "End")], 21);
  const theirs = doc("Plan", [P("n1", "Intro"), P("n2", "Middle"), P("n3", "End"), P("n5", "theirs, at the end")], 22);
  const m = merge3(base, mine, theirs);
  assert.deepEqual(texts(m), ["Intro", "mine, after intro", "Middle", "End", "theirs, at the end"]);
  assert.ok(m.seq.n >= 22);
});

test("two new blocks that picked the same id both survive with different ids", () => {
  const mine = doc("Plan", [...base.nodes, P("n21", "mine")], 21);
  const theirs = doc("Plan", [...base.nodes, P("n21", "theirs")], 21);
  const m = merge3(base, mine, theirs);
  assert.deepEqual(texts(m).slice(3).sort(), ["mine", "theirs"]);
  assert.equal(new Set(m.nodes.map((n) => n.id)).size, m.nodes.length, "ids stay unique");
  assert.ok(m.seq.n >= 22, "the counter moved past the new id");
});

test("a block I deleted goes, unless they edited it", () => {
  const mine = doc("Plan", [P("n1", "Intro"), P("n3", "End")]);
  const untouched = doc("Plan", base.nodes);
  assert.deepEqual(texts(merge3(base, mine, untouched)), ["Intro", "End"]);
  const edited = doc("Plan", [P("n1", "Intro"), P("n2", "Middle, edited by them"), P("n3", "End")]);
  assert.deepEqual(texts(merge3(base, mine, edited)), ["Intro", "Middle, edited by them", "End"]);
});

test("a block they deleted stays deleted when I did not touch it", () => {
  const mine = doc("Plan", [P("n1", "Intro, mine"), P("n2", "Middle"), P("n3", "End")]);
  const theirs = doc("Plan", [P("n1", "Intro"), P("n3", "End")]);
  assert.deepEqual(texts(merge3(base, mine, theirs)), ["Intro, mine", "End"]);
});

test("list items merge by item", () => {
  const b = doc("Packing", [L("n1", [["i1", "towels"], ["i2", "sunscreen"], ["i3", "books"]])]);
  const mine = doc("Packing", [L("n1", [["i1", "towels"], ["i2", "sunscreen SPF 50"], ["i3", "books"]])]);
  const theirs = doc("Packing", [L("n1", [["i1", "towels"], ["i2", "sunscreen"], ["i3", "books"], ["i9", "snacks"]])]);
  assert.deepEqual(texts(merge3(b, mine, theirs)), ["towels|sunscreen SPF 50|books|snacks"]);
});

test("a list item I added and one they added both stay", () => {
  const b = doc("Packing", [L("n1", [["i1", "towels"]])]);
  const mine = doc("Packing", [L("n1", [["i1", "towels"], ["i2", "mine"]])]);
  const theirs = doc("Packing", [L("n1", [["i1", "towels"], ["i3", "theirs"]])]);
  const m = merge3(b, mine, theirs);
  assert.deepEqual(m.nodes[0].items.map((x) => x.text).sort(), ["mine", "theirs", "towels"]);
});

test("the title: mine if only I changed it, theirs otherwise", () => {
  assert.equal(merge3(base, doc("Mine", base.nodes), doc("Plan", base.nodes)).title, "Mine");
  assert.equal(merge3(base, doc("Plan", base.nodes), doc("Theirs", base.nodes)).title, "Theirs");
  assert.equal(merge3(base, doc("Mine", base.nodes), doc("Theirs", base.nodes)).title, "Theirs");
});

test("nothing changed on my side: the result is theirs", () => {
  const theirs = doc("Plan", [P("n1", "Intro"), P("n2", "Middle, edited"), P("n3", "End")]);
  assert.deepEqual(texts(merge3(base, base, theirs)), texts(theirs));
});

test("does not change its inputs", () => {
  const mine = doc("Plan", [...base.nodes, P("n21", "mine")], 21);
  const theirs = doc("Plan", [...base.nodes, P("n21", "theirs")], 21);
  const copies = JSON.stringify([base, mine, theirs]);
  merge3(base, mine, theirs);
  assert.equal(JSON.stringify([base, mine, theirs]), copies);
});
