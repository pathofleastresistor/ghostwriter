// Ghostwriter's own OAuth authorization server, for MCP hosts (Claude, ChatGPT, any MCP client).
//
// The MCP SDK's mcpAuthRouter provides the endpoints (/register, /authorize, /token, /revoke and the
// metadata) and their request checks, PKCE included. This file is the part the SDK leaves to the
// server: which apps exist, who approved them, and the tokens. People sign in at their own identity
// provider (see index.js), so this works with any OpenID Connect provider, including ones that do not
// let apps register themselves.
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidTargetError, InvalidTokenError, AccessDeniedError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomToken, sha256, now } from "./util.js";

const MAX_CLIENTS = 100; // in all
const MAX_UNAPPROVED = 20; // registered but not (yet) approved by anyone
const UNUSED_CLIENT_TTL = 24 * 3600; // an app nobody approved is forgotten after a day
const YOUNG_CLIENT = 15 * 60; // ...but never while someone may still be signing in to approve it
const PENDING_TTL = 10 * 60; // time to sign in and approve
const MAX_PENDING = 500;
const MAX_STATE = 1024; // the app's own "state" value, echoed back to it
const CODE_TTL = 60;
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where an app may be sent back to: https, http on this machine (native apps), or an app's own scheme. */
export function redirectAllowed(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return !BAD_SCHEMES.has(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/**
 * deps: { store, resource (string, this server's /mcp URL), origin, accessTtl, refreshTtl (seconds),
 *         allowed(user) }
 */
export function createProvider({ store, resource, origin, accessTtl, refreshTtl, allowed }) {
  const pending = new Map(); // id -> authorization request waiting for sign-in and approval
  const codes = new Map(); // sha256(code) -> what the code stands for

  const sweep = () => {
    const t = now();
    for (const [k, v] of pending) if (v.exp < t) pending.delete(k);
    for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
  };

  /** The resource a token is for. Clients may name this server or its /mcp endpoint; anything else is refused. */
  function resourceFor(requested) {
    if (!requested) return resource;
    const r = String(requested).replace(/#.*$/, "").replace(/\/+$/, "");
    if (r === resource || r === origin) return resource;
    throw new InvalidTargetError("This server only issues tokens for " + resource);
  }

  const clientsStore = {
    getClient: (id) => store.getClient(id),
    registerClient(info) {
      const uris = info.redirect_uris ?? [];
      if (!uris.length) throw new InvalidClientMetadataError("redirect_uris is required.");
      if (uris.length > 10) throw new InvalidClientMetadataError("At most 10 redirect_uris.");
      for (const u of uris) if (!redirectAllowed(u)) throw new InvalidClientMetadataError(`Not an allowed redirect_uri: ${u}. Use https, http on localhost, or an app's own scheme.`);
      if ((info.grant_types ?? ["authorization_code"]).some((g) => !["authorization_code", "refresh_token"].includes(g))) throw new InvalidClientMetadataError("Only the authorization_code and refresh_token grants are supported.");
      // Room for this one: drop apps nobody approved, oldest first.
      for (const u of uris) if (u.length > 500) throw new InvalidClientMetadataError("redirect_uri is too long.");
      const method = info.token_endpoint_auth_method ?? "client_secret_basic";
      if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) throw new InvalidClientMetadataError("token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.");
      // Forget apps nobody approved after a day. Spam can't push out an app someone is approving
      // right now: young ones are kept, and a new registration is refused instead.
      const t = now();
      const approved = store.approvedClients();
      const unapproved = () =>
        Object.values(store.state.clients)
          .filter((c) => !approved.has(c.client_id))
          .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
      for (const c of unapproved()) if ((c.client_id_issued_at ?? 0) + UNUSED_CLIENT_TTL < t) store.deleteClient(c.client_id);
      for (const c of unapproved()) {
        if (unapproved().length < MAX_UNAPPROVED && Object.keys(store.state.clients).length < MAX_CLIENTS) break;
        if ((c.client_id_issued_at ?? 0) + YOUNG_CLIENT > t) break;
        store.deleteClient(c.client_id);
      }
      if (unapproved().length >= MAX_UNAPPROVED || Object.keys(store.state.clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError("Too many apps are waiting to be connected. Try again later.");
      // Keep only what this server uses, each capped: registration is open to anyone.
      const str = (v, max) => (typeof v === "string" && v.length ? v.slice(0, max) : undefined);
      const client = {
        client_id: info.client_id ?? randomToken(18),
        client_id_issued_at: info.client_id_issued_at ?? t,
        client_secret: info.client_secret,
        client_secret_expires_at: info.client_secret_expires_at,
        client_name: str(info.client_name, 100),
        client_uri: str(info.client_uri, 300),
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: info.grant_types ?? ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      store.putClient(client);
      return client;
    },
  };

  function issue({ clientId, user, scopes, resource: res, family, familyExp }) {
    const t = now();
    const access = "gwa_" + randomToken(32);
    const refresh = "gwr_" + randomToken(32);
    const refreshExp = Math.min(familyExp, t + refreshTtl);
    const common = { clientId, sub: user.sub, user, scopes, resource: res, family };
    store.putTokens([
      [sha256(access), { ...common, type: "access", exp: t + accessTtl }],
      [sha256(refresh), { ...common, type: "refresh", exp: refreshExp, familyExp }],
    ]);
    return { access_token: access, token_type: "Bearer", expires_in: accessTtl, refresh_token: refresh, ...(scopes.length ? { scope: scopes.join(" ") } : {}) };
  }

  /** Is this approval still good: the app still approved and the person still let in? */
  const stillAllowed = (tok) => !!store.getGrant(tok.sub, tok.clientId) && allowed(tok.user);

  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    // Step 1: the app sends the person here. Park the request and go to the approval page, which
    // signs the person in first if needed (index.js).
    async authorize(client, params, res) {
      sweep();
      if (params.state !== undefined && String(params.state).length > MAX_STATE) throw new InvalidRequestError("state is too long.");
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value); // oldest first
      const id = randomToken(18);
      pending.set(id, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes ?? [],
        resource: resourceFor(params.resource),
        exp: now() + PENDING_TTL,
      });
      res.redirect(302, `${origin}/auth/consent/${id}`);
    },

    async challengeForAuthorizationCode(client, code) {
      const c = codes.get(sha256(code));
      if (!c || c.clientId !== client.client_id || c.exp < now()) throw new InvalidGrantError("The authorization code is not valid.");
      return c.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requested) {
      const key = sha256(code);
      const c = codes.get(key);
      codes.delete(key); // single use, whatever happens next
      if (!c || c.clientId !== client.client_id || c.exp < now()) throw new InvalidGrantError("The authorization code is not valid.");
      if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
      if (requested !== undefined && resourceFor(requested) !== c.resource) throw new InvalidTargetError("The resource does not match the authorization request.");
      if (!store.getGrant(c.user.sub, c.clientId) || !allowed(c.user)) throw new InvalidGrantError("Access was withdrawn.");
      return issue({ clientId: c.clientId, user: c.user, scopes: c.scopes, resource: c.resource, family: randomToken(12), familyExp: now() + refreshTtl });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, requested) {
      const key = sha256(refreshToken);
      const tok = store.getToken(key);
      if (!tok) {
        // A refresh token that was already swapped is being used again: one of the two copies is
        // stolen. End the whole chain so neither works (OAuth 2.1 refresh token rotation).
        const used = store.usedRefresh(key);
        if (used) store.revokeFamily(used.family);
        throw new InvalidGrantError("The refresh token is not valid.");
      }
      if (tok.type !== "refresh" || tok.clientId !== client.client_id || tok.exp < now()) throw new InvalidGrantError("The refresh token is not valid.");
      if (requested !== undefined && resourceFor(requested) !== tok.resource) throw new InvalidTargetError("The resource does not match.");
      if (scopes?.some((s) => !tok.scopes.includes(s))) throw new InvalidGrantError("A refresh cannot add scopes.");
      store.spendRefresh(key);
      if (!stillAllowed(tok)) {
        store.revokeFamily(tok.family);
        throw new InvalidGrantError("Access was withdrawn. Connect again.");
      }
      return issue({ clientId: tok.clientId, user: tok.user, scopes: scopes ?? tok.scopes, resource: tok.resource, family: tok.family, familyExp: tok.familyExp });
    },

    async verifyAccessToken(token) {
      const tok = typeof token === "string" ? store.getToken(sha256(token)) : undefined;
      if (!tok || tok.type !== "access" || tok.exp < now()) throw new InvalidTokenError("The access token is not valid.");
      if (!stillAllowed(tok)) throw new InvalidTokenError("Access was withdrawn.");
      store.touchGrant(tok.sub, tok.clientId);
      return { token, clientId: tok.clientId, scopes: tok.scopes, expiresAt: tok.exp, resource: new URL(tok.resource), extra: { user: tok.user } };
    },

    async revokeToken(client, { token }) {
      const tok = store.getToken(sha256(token));
      if (tok && tok.clientId === client.client_id) store.revokeFamily(tok.family);
    },
  };

  /* ---------- the approval step, driven by the consent page in index.js ---------- */

  function getPending(id) {
    sweep();
    const p = typeof id === "string" ? pending.get(id) : undefined;
    if (!p) return null;
    const client = store.getClient(p.clientId);
    return client ? { ...p, client } : null;
  }

  /** The person said yes: remember it, and send them back to the app with a code. */
  function approve(id, user) {
    const p = getPending(id);
    if (!p) return null;
    pending.delete(id);
    const prev = store.getGrant(user.sub, p.clientId);
    store.putGrant(user.sub, p.clientId, { approvedAt: prev?.approvedAt ?? now(), lastUsed: now() });
    const code = randomToken(32);
    if (codes.size >= MAX_PENDING) codes.delete(codes.keys().next().value);
    codes.set(sha256(code), { clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, scopes: p.scopes, resource: p.resource, user, exp: now() + CODE_TTL });
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", code);
    if (p.state !== undefined) u.searchParams.set("state", p.state);
    return u.href;
  }

  /** The person said no (or is not allowed): back to the app with an error. */
  function deny(id, description = "The person declined.") {
    const p = getPending(id);
    if (!p) return null;
    pending.delete(id);
    const err = new AccessDeniedError(description);
    const u = new URL(p.redirectUri);
    u.searchParams.set("error", err.errorCode);
    u.searchParams.set("error_description", description);
    if (p.state !== undefined) u.searchParams.set("state", p.state);
    return u.href;
  }

  return { provider, getPending, approve, deny };
}
