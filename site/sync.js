// Keeps a local Doc and its editor view in step with a document held on a server.
//
//  - Edits made elsewhere (Claude, through the server) are fetched with transport.pull and replayed
//    on the local copy as the same tool calls, so the typewriter animation and undo work as usual.
//  - Edits made here (typing, or an agent using this page's own tools) are sent with transport.push
//    a moment after they stop. If the server's copy moved on first, the server's version wins.
//
// transport = { snapshot(id), pull(id, since), push(id, base, snapshot) }, each returning plain data.

import { merge3 } from "./merge.js";

export function createSync({ doc, view, tools, transport, onLoad = () => {}, onState = () => {}, onGone = () => {}, pollMs = 1000, pushMs = 500 }) {
  let id = null;
  let serverRev = 0;
  let dirty = false;
  let pushing = false;
  let pulling = false;
  let replaying = false;
  let pushTimer = null;
  let pollTimer = null;
  let unsubscribe = null;
  // Counts every local change and every save. A reply from the server that was asked for before
  // the latest one is stale: applying it would throw away what has been typed since.
  let epoch = 0;
  // For the debug panel.
  let lastPullAt = 0;
  let lastPushAt = 0;
  let lastError = "";

  /** Show a version from the server. With `caret`, the person's cursor stays where it was. */
  function load(snapshot, caret) {
    clearTimeout(pushTimer);
    pushTimer = null;
    dirty = false;
    doc.load(snapshot);
    serverRev = snapshot.revision;
    view.resetHistory();
    view.render(caret);
    onLoad();
  }

  function markDirty() {
    epoch++;
    dirty = true;
    onState("Editing…");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, pushMs);
  }

  /**
   * The server answered a save with a version that includes other editors' changes, but the person
   * kept typing while it was on its way. Lay what they typed since on top of the server's version.
   */
  function rebase(sent, serverSnap) {
    const rebased = merge3(sent, doc.snapshot(), serverSnap);
    const caret = view.captureCaret();
    doc.load({ ...rebased, revision: serverSnap.revision });
    serverRev = serverSnap.revision;
    view.resetHistory();
    view.render(caret);
    onLoad();
    dirty = true; // still not saved: the next save carries it
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, pushMs);
  }

  async function push() {
    pushTimer = null;
    if (!id || pushing || !dirty) return;
    pushing = true;
    dirty = false;
    epoch++;
    const mine = id;
    const sent = doc.snapshot();
    const startedAt = epoch;
    try {
      const res = await transport.push(mine, serverRev, sent);
      lastPushAt = Date.now();
      lastError = "";
      if (mine !== id) return;
      const typedSince = epoch !== startedAt;
      if (res.conflict || res.merged) {
        // Someone else saved meanwhile. The server combined both (or, if this editor was too far
        // behind to merge, kept the saved version). Show that, with the cursor where it was.
        if (typedSince) rebase(sent, res.snapshot);
        else load(res.snapshot, view.captureCaret());
        onState(res.conflict ? "The document changed elsewhere, so your last change was replaced" : "Saved, with changes from another editor");
      } else {
        serverRev = res.revision;
        doc.revision = serverRev;
        onState(typedSince ? "Editing…" : "Saved");
      }
    } catch (e) {
      lastError = `save failed: ${e.message}`;
      dirty = true;
      onState("Not saved. Retrying…");
      pushTimer = setTimeout(push, 3000);
    } finally {
      pushing = false;
      if (dirty && !pushTimer) pushTimer = setTimeout(push, pushMs);
    }
  }

  async function pull() {
    if (!id || pulling || pushing || dirty || view.locked) return;
    pulling = true;
    const mine = id;
    const askedAt = epoch;
    try {
      const res = await transport.pull(mine, serverRev);
      lastPullAt = Date.now();
      lastError = "";
      if (mine !== id || epoch !== askedAt || dirty || pushing) return; // stale: try again next time
      if (res.snapshot) return load(res.snapshot, view.captureCaret());
      for (const c of res.changes ?? []) {
        const tool = tools.get(c.tool);
        const { expected_revision, ...args } = c.args ?? {};
        doc.revision = c.rev - 1;
        replaying = true;
        try {
          await tool.run(args); // emits "agent-change", which the page animates
        } finally {
          replaying = false;
        }
        if (doc.revision !== c.rev) return load((await transport.pull(mine, -1)).snapshot);
      }
      serverRev = res.revision;
    } catch (e) {
      // Deleted somewhere else while it was open: tell the page so it can go back to the list.
      if (e.notFound || /no document with id/i.test(e.message ?? "")) {
        if (mine === id) onGone();
      } else {
        lastError = `pull failed: ${e.message}`;
        console.warn("[ghostwriter] pull failed", e);
      }
    } finally {
      pulling = false;
    }
  }

  return {
    get id() {
      return id;
    },
    get dirty() {
      return dirty;
    },
    /** Open a document: fetch it, show it, and start keeping it in step. */
    async open(docId, snapshot) {
      await this.close();
      const snap = snapshot ?? (await transport.snapshot(docId)).snapshot;
      id = docId;
      unsubscribe = doc.subscribe((e) => {
        if (e.type === "user-change" || e.type === "restored" || (e.type === "agent-change" && !replaying)) markDirty();
      });
      load(snap);
      onState("");
      pollTimer = setInterval(pull, pollMs);
    },
    /** Stop syncing. Anything not yet sent is sent first. */
    async close() {
      clearInterval(pollTimer);
      clearTimeout(pushTimer);
      unsubscribe?.();
      unsubscribe = null;
      if (id && dirty) {
        try {
          await transport.push(id, serverRev, doc.snapshot());
        } catch {
          /* nothing more to do */
        }
      }
      id = null;
      dirty = false;
    },
    pullNow: pull,
    /** What the debug panel shows. */
    status: () => ({ id, serverRev, dirty, pushing, pulling, lastPullAt, lastPushAt, lastError }),
  };
}
