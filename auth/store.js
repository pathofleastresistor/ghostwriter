// What sign-in keeps on disk, in DATA_DIR/auth/state.json (owner-only file):
//   clients  apps that registered themselves (OAuth dynamic client registration)
//   grants   which person approved which app: grants[sub][client_id]
//   tokens   access and refresh tokens, by SHA-256 hash (the tokens themselves are never stored)
//   used     hashes of refresh tokens already swapped, to catch a stolen one being replayed
// Authorization codes and sign-ins in progress live a few minutes and are kept in memory only.
import fs from "node:fs";
import path from "node:path";
import { now } from "./util.js";

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "state.json");
  let state = { clients: {}, grants: {}, tokens: {}, used: {} };
  if (fs.existsSync(file)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
      console.error(`auth: ${file} is unreadable (${e.message}); starting with no connected apps.`);
    }
  }

  function prune() {
    const t = now();
    for (const [h, tok] of Object.entries(state.tokens)) if (tok.exp < t) delete state.tokens[h];
    for (const [h, u] of Object.entries(state.used)) if (!(u?.exp >= t)) delete state.used[h];
  }

  function save() {
    prune();
    fs.writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }

  return {
    state,
    save,
    getClient: (id) => (typeof id === "string" && Object.hasOwn(state.clients, id) ? state.clients[id] : undefined),
    putClient(c) {
      state.clients[c.client_id] = c;
      save();
    },
    deleteClient(id) {
      delete state.clients[id];
      for (const g of Object.values(state.grants)) delete g[id];
      for (const [h, tok] of Object.entries(state.tokens)) if (tok.clientId === id) delete state.tokens[h];
      save();
    },
    getGrant(sub, clientId) {
      return Object.hasOwn(state.grants, sub) && Object.hasOwn(state.grants[sub], clientId) ? state.grants[sub][clientId] : undefined;
    },
    putGrant(sub, clientId, grant) {
      if (!Object.hasOwn(state.grants, sub)) Object.defineProperty(state.grants, sub, { value: {}, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(state.grants[sub], clientId, { value: grant, enumerable: true, writable: true, configurable: true });
      save();
    },
    /** Every app some person approved. */
    approvedClients: () => new Set(Object.values(state.grants).flatMap((g) => Object.keys(g))),
    /** Forgets an approval and every token issued under it. */
    deleteGrant(sub, clientId) {
      if (Object.hasOwn(state.grants, sub)) delete state.grants[sub][clientId];
      for (const [h, tok] of Object.entries(state.tokens)) if (tok.sub === sub && tok.clientId === clientId) delete state.tokens[h];
      save();
    },
    grantsFor: (sub) => (Object.hasOwn(state.grants, sub) ? Object.entries(state.grants[sub]).map(([clientId, g]) => ({ clientId, ...g })) : []),
    getToken: (hash) => (Object.hasOwn(state.tokens, hash) ? state.tokens[hash] : undefined),
    putTokens(entries) {
      for (const [hash, tok] of entries) state.tokens[hash] = tok;
      save();
    },
    /** Removes one refresh token and remembers it was used, until it would have expired. */
    spendRefresh(hash) {
      const tok = state.tokens[hash];
      delete state.tokens[hash];
      if (tok) state.used[hash] = { family: tok.family, exp: tok.exp };
    },
    usedRefresh: (hash) => (Object.hasOwn(state.used, hash) ? state.used[hash] : undefined),
    revokeFamily(family) {
      for (const [h, tok] of Object.entries(state.tokens)) if (tok.family === family) delete state.tokens[h];
      save();
    },
    touchGrant(sub, clientId) {
      const g = Object.hasOwn(state.grants, sub) ? state.grants[sub][clientId] : undefined;
      if (g) g.lastUsed = now();
    },
  };
}
