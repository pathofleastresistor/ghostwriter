// Keeps only the newest Ghostwriter card live in a conversation.
//
// Each call to open_document mounts a new iframe in the chat and no host API unmounts the older
// ones. Left alone, every card would keep polling /api, publishing model context and offering
// editor tools. So the cards elect the newest one over a BroadcastChannel (all cards of one
// connector share a sandbox origin, so the channel reaches its siblings in this conversation) and
// every older card goes inert. The order comes from the server: open_document stamps its result
// with {createdAt, seq}, which is stored in the transcript, so a card that is mounted late
// (scrolling back through an old chat) still ranks where it was created.
//
// Pure apart from BroadcastChannel and timers, both injectable, so it is unit-tested without a host.

/** Is `other` newer than `me`? createdAt, then seq, then instance id (so the result is the same on both sides). */
export function isNewer(other, me) {
  // A server key and a client fallback key are not comparable (a client clock is always "later").
  if ((other.keySource === "server") !== (me.keySource === "server")) return false;
  if (other.orderKey !== me.orderKey) return other.orderKey > me.orderKey;
  if (other.seq != null && me.seq != null && other.seq !== me.seq) return other.seq > me.seq;
  return String(other.instanceId) > String(me.instanceId);
}

/**
 * onChange(superseded: boolean) fires when this card's state changes. Call setKey() with the tool
 * result's structuredContent, then start() once connected. If no server key arrives within
 * `waitMs`, the card uses its own clock (and only competes with other such cards).
 */
export function createElection({
  onChange,
  channelName = "ghostwriter-supersede",
  waitMs = 1000,
  Channel = typeof BroadcastChannel === "undefined" ? null : BroadcastChannel,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
} = {}) {
  let me = null; // { instanceId, orderKey, seq, keySource }
  let channel = null;
  let superseded = false;
  let fallbackTimer = null;
  let started = false;
  let serverKey = null;
  let toolId = null;
  const peers = new Map();

  const recompute = () => {
    if (!me) return;
    const next = [...peers.values()].some((p) => isNewer(p, me));
    if (next !== superseded) {
      superseded = next;
      onChange(superseded);
    }
  };

  const announce = () => {
    if (!me || !channel) return;
    channel.postMessage({ type: "hello", ...me });
    channel.postMessage({ type: "born", ...me });
  };

  const finalize = (key) => {
    me = { instanceId: toolId ?? newId(), orderKey: key.orderKey, seq: key.seq, keySource: key.keySource };
    announce();
    recompute();
  };

  const open = () => {
    if (!Channel || channel) return;
    channel = new Channel(channelName);
    channel.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object" || !me || msg.instanceId === me.instanceId) return;
      if (!Number.isFinite(msg.orderKey)) return;
      if (msg.type === "hello") channel.postMessage({ type: "born", ...me });
      peers.set(msg.instanceId, msg);
      recompute();
    };
  };

  return {
    /** The tool result that mounted this card. A server key {createdAt, seq} is used when present. */
    setKey(structured, id) {
      if (id) toolId = String(id);
      const sc = structured ?? {};
      if (!Number.isFinite(sc.createdAt)) return;
      serverKey = { orderKey: sc.createdAt, seq: Number.isFinite(sc.seq) ? sc.seq : undefined, keySource: "server" };
      if (!started) return;
      clearTimeout(fallbackTimer);
      finalize(serverKey); // also corrects a card that had already fallen back to its own clock
    },
    start(id) {
      if (started) return;
      started = true;
      if (id) toolId = String(id);
      open();
      if (serverKey) return finalize(serverKey);
      fallbackTimer = setTimeout(() => {
        if (!me) finalize({ orderKey: now(), seq: undefined, keySource: "client" });
      }, waitMs);
    },
    get superseded() {
      return superseded;
    },
    close() {
      clearTimeout(fallbackTimer);
      channel?.close();
      channel = null;
    },
  };
}
