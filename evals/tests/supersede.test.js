// Only the newest Ghostwriter card in a conversation stays live. Cards share a channel; the order
// comes from the server's {createdAt, seq} key, not from when each card happened to mount.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElection, isNewer } from "../../site/supersede.js";

/** A shared in-memory channel, like BroadcastChannel across iframes of one origin (delivery is synchronous here). */
function bus() {
  const all = new Set();
  return class Channel {
    constructor() {
      all.add(this);
    }
    postMessage(data) {
      for (const c of all) if (c !== this && c.onmessage) c.onmessage({ data: structuredClone(data) });
    }
    close() {
      all.delete(this);
    }
  };
}

function card(Channel, key, id, opts = {}) {
  const states = [];
  const e = createElection({ Channel, onChange: (v) => states.push(v), newId: () => id, now: opts.now, waitMs: opts.waitMs ?? 5 });
  if (key) e.setKey(key, id);
  e.start(id);
  return { e, states };
}

describe("isNewer", () => {
  const k = (orderKey, seq, instanceId, keySource = "server") => ({ orderKey, seq, instanceId, keySource });
  it("orders by createdAt, then seq, then id", () => {
    assert.equal(isNewer(k(2, 1, "a"), k(1, 9, "b")), true);
    assert.equal(isNewer(k(1, 2, "a"), k(1, 1, "b")), true);
    assert.equal(isNewer(k(1, 1, "b"), k(1, 1, "a")), true);
    assert.equal(isNewer(k(1, 1, "a"), k(1, 1, "b")), false);
  });
  it("never compares a server key with a client clock", () => {
    assert.equal(isNewer(k(5, 1, "a", "client"), k(1, 1, "b", "server")), false);
    assert.equal(isNewer(k(1, 1, "b", "server"), k(5, 1, "a", "client")), false);
  });
});

describe("election", () => {
  it("the older card is superseded, the newer stays live, whichever mounts first", () => {
    const C = bus();
    const old = card(C, { createdAt: 100, seq: 1 }, "t1");
    const fresh = card(C, { createdAt: 200, seq: 2 }, "t2");
    assert.equal(old.e.superseded, true);
    assert.equal(fresh.e.superseded, false);
    assert.deepEqual(old.states, [true]);
    assert.deepEqual(fresh.states, []);
  });

  it("a card remounted late (scrolling back in an old chat) still ranks by its server key", () => {
    const C = bus();
    const fresh = card(C, { createdAt: 200, seq: 2 }, "t2");
    const lateOld = card(C, { createdAt: 100, seq: 1 }, "t1"); // mounts last, but is older
    assert.equal(lateOld.e.superseded, true);
    assert.equal(fresh.e.superseded, false);
  });

  it("three cards: only the newest is live", () => {
    const C = bus();
    const a = card(C, { createdAt: 1, seq: 1 }, "a");
    const b = card(C, { createdAt: 2, seq: 2 }, "b");
    const c = card(C, { createdAt: 3, seq: 3 }, "c");
    assert.deepEqual([a.e.superseded, b.e.superseded, c.e.superseded], [true, true, false]);
  });

  it("two calls in one millisecond are ordered by seq", () => {
    const C = bus();
    const a = card(C, { createdAt: 50, seq: 7 }, "a");
    const b = card(C, { createdAt: 50, seq: 8 }, "b");
    assert.deepEqual([a.e.superseded, b.e.superseded], [true, false]);
  });

  it("a card whose server key arrives late joins with it and can become live again", async () => {
    const C = bus();
    const fresh = card(C, { createdAt: 200, seq: 2 }, "t2");
    const slow = card(C, null, "t1", { now: () => Date.now(), waitMs: 5 }); // key not here yet
    await new Promise((r) => setTimeout(r, 20)); // fell back to its own clock
    assert.equal(slow.e.superseded, false, "a client key and a server key are not compared");
    slow.e.setKey({ createdAt: 100, seq: 1 }, "t1"); // the real key arrives: older than the fresh card
    assert.equal(slow.e.superseded, true);
  });

  it("ignores junk on the channel", () => {
    const C = bus();
    const a = card(C, { createdAt: 1, seq: 1 }, "a");
    const stray = new C();
    stray.postMessage(null);
    stray.postMessage({ type: "born", instanceId: "x", orderKey: "soon" });
    assert.equal(a.e.superseded, false);
  });

  it("works with no BroadcastChannel at all (the card just stays live)", () => {
    const e = createElection({ Channel: null, onChange: () => assert.fail("no change"), newId: () => "a" });
    e.setKey({ createdAt: 1, seq: 1 }, "a");
    e.start("a");
    assert.equal(e.superseded, false);
  });
});
