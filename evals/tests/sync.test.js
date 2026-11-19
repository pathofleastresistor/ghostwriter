// The editor stays in step with a server while a person types. These hold a server reply "in
// flight" and type while it is on its way: nothing typed may be lost, and the other editor's
// changes must arrive. The model is real; the editor view and the server are stand-ins.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Doc } from "../../site/model.js";
import { createSync } from "../../site/sync.js";
import { merge3 } from "../../site/merge.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P = (id, text) => ({ id, type: "paragraph", text });
const start = () => ({ title: "Plan", nodes: [P("n1", "Intro"), P("n2", "Middle"), P("n3", "End")], revision: 1, seq: { n: 9, i: 9 } });

/** A server that keeps revisions and merges stale saves, like the real one. Replies can be held. */
function fakeServer(initial) {
  let cur = JSON.parse(JSON.stringify(initial));
  const history = new Map([[cur.revision, JSON.stringify(cur)]]);
  const holds = { pull: null, push: null };
  const gate = async (kind) => {
    if (holds[kind]) await holds[kind].promise;
  };
  const save = (snap) => {
    cur = { ...snap, revision: cur.revision + 1 };
    history.set(cur.revision, JSON.stringify(cur));
  };
  return {
    get doc() {
      return cur;
    },
    /** Another editor saves directly. */
    otherEdits(mutate) {
      const next = JSON.parse(JSON.stringify(cur));
      mutate(next);
      save(next);
    },
    hold(kind) {
      let release;
      const promise = new Promise((r) => (release = r));
      holds[kind] = { promise };
      return () => {
        holds[kind] = null;
        release();
      };
    },
    transport: {
      snapshot: async () => ({ snapshot: JSON.parse(JSON.stringify(cur)) }),
      async pull(_id, since) {
        const reply = since === cur.revision ? { revision: cur.revision, changes: [] } : { revision: cur.revision, snapshot: JSON.parse(JSON.stringify(cur)) };
        await gate("pull");
        return reply;
      },
      async push(_id, base, snapshot) {
        await gate("push");
        if (base === cur.revision) {
          save(snapshot);
          return { conflict: false, revision: cur.revision };
        }
        const merged = merge3(JSON.parse(history.get(base)), snapshot, JSON.parse(JSON.stringify(cur)));
        save(merged);
        return { conflict: false, merged: true, revision: cur.revision, snapshot: JSON.parse(JSON.stringify(cur)) };
      },
    },
  };
}

function editor(server) {
  const doc = new Doc();
  const view = { locked: false, resetHistory() {}, render() {}, captureCaret: () => null };
  const states = [];
  const sync = createSync({ doc, view, tools: new Map(), transport: server.transport, onState: (s) => states.push(s), pollMs: 100000, pushMs: 15 });
  /** What the editor does when the person types into block `id`. */
  const type = (id, extra) => {
    doc.nodes.find((n) => n.id === id).text += extra;
    doc.userChanged();
  };
  const text = () => doc.nodes.map((n) => n.text).join(" / ");
  return { doc, sync, type, text, states };
}
const serverText = (server) => server.doc.nodes.map((n) => n.text).join(" / ");

describe("typing while the server is being asked something", () => {
  it("a person's typing reaches the server", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    await a.sync.open("d", await server.transport.snapshot().then((r) => r.snapshot));
    a.type("n1", " typed");
    await sleep(60);
    assert.equal(serverText(server), "Intro typed / Middle / End");
    await a.sync.close();
  });

  it("typing during a pull that returns another editor's version is not thrown away", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    await a.sync.open("d", (await server.transport.snapshot()).snapshot);
    server.otherEdits((s) => (s.nodes[2].text = "End, edited elsewhere"));
    const release = server.hold("pull");
    const pulling = a.sync.pullNow(); // asks the server; the reply is held
    a.type("n1", " typed meanwhile");
    release();
    await pulling;
    await sleep(80);
    // the held reply was stale and must not have replaced the typing; the save then merged both
    assert.equal(a.text(), "Intro typed meanwhile / Middle / End, edited elsewhere");
    assert.equal(serverText(server), "Intro typed meanwhile / Middle / End, edited elsewhere");
    await a.sync.close();
  });

  it("another editor's change arrives on its own, and is not sent back as if it were mine", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    await a.sync.open("d", (await server.transport.snapshot()).snapshot);
    server.otherEdits((s) => (s.nodes[1].text = "Middle, edited elsewhere"));
    const before = server.doc.revision;
    await a.sync.pullNow();
    assert.equal(a.text(), "Intro / Middle, edited elsewhere / End");
    await sleep(60);
    assert.equal(server.doc.revision, before, "receiving a change does not save anything");
    await a.sync.close();
  });

  it("a save that the server merged does not overwrite what was typed while it was in flight", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    await a.sync.open("d", (await server.transport.snapshot()).snapshot);
    server.otherEdits((s) => (s.nodes[2].text = "End, edited elsewhere")); // saved after a last synced
    a.type("n1", " one");
    const release = server.hold("push");
    await sleep(40); // the save for " one" goes out and is held
    a.type("n2", " two"); // typed while that save is in flight
    release();
    await sleep(120);
    const want = "Intro one / Middle two / End, edited elsewhere";
    assert.equal(a.text(), want, "the editor has everything");
    assert.equal(serverText(server), want, "and so does the server");
    await a.sync.close();
  });

  it("two editors typing at once in different places both end up with both edits", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    const b = editor(server);
    const snap = (await server.transport.snapshot()).snapshot;
    await a.sync.open("d", snap);
    await b.sync.open("d", snap);
    a.type("n1", " from A");
    b.type("n3", " from B");
    await sleep(100);
    await a.sync.pullNow();
    await b.sync.pullNow();
    await sleep(60);
    const want = "Intro from A / Middle / End from B";
    assert.equal(serverText(server), want);
    assert.equal(a.text(), want);
    assert.equal(b.text(), want);
    await a.sync.close();
    await b.sync.close();
  });

  it("typing in the same block from two editors keeps the saved version, and neither editor loses its place in the others", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    const b = editor(server);
    const snap = (await server.transport.snapshot()).snapshot;
    await a.sync.open("d", snap);
    await b.sync.open("d", snap);
    a.type("n2", " A");
    await sleep(50); // A saves first
    b.type("n2", " B"); // B started from the older version of the same block
    await sleep(100);
    await a.sync.pullNow();
    await b.sync.pullNow();
    // one of the two wins the block, both editors agree with the server, and nothing else changed
    assert.equal(a.text(), serverText(server));
    assert.equal(b.text(), serverText(server));
    assert.match(serverText(server), /^Intro \/ Middle (A|B) \/ End$/);
    await a.sync.close();
    await b.sync.close();
  });

  it("closing sends what has not been sent yet", async () => {
    const server = fakeServer(start());
    const a = editor(server);
    await a.sync.open("d", (await server.transport.snapshot()).snapshot);
    a.type("n3", " last words");
    await a.sync.close(); // before the save timer fires
    assert.equal(serverText(server), "Intro / Middle / End last words");
  });
});
