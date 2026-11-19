// Ghostwriter's own OAuth authorization server, for MCP hosts (Claude, ChatGPT, any MCP client).
//
// The MCP SDK's mcpAuthRouter provides the endpoints (/register, /authorize, /token, /revoke and the
// metadata) and their request checks, PKCE included. This file is the part the SDK leaves to the
// server: which apps exist, who approved them, and the tokens. People sign in at their own identity
// provider (see index.js), so this works with any OpenID Connect provider, including ones that do not
// let apps register themselves.
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError, AccessDeniedError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomToken, sha256, now } from "./util.js";

const MAX_CLIENTS = 100;
const UNUSED_CLIENT_TTL = 7 * 24 * 3600; // an app registered but never approved is forgotten after a week
const PENDING_TTL = 10 * 60; // time to sign in and approve
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
      const t = now();
      const approved = new Set(Object.keys(store.state.grants).map((k) => k.slice(k.indexOf(" ") + 1)));
      const unused = Object.values(store.state.clients)
        .filter((c) => !approved.has(c.client_id))
        .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
      for (const c of unused) if ((c.client_id_issued_at ?? 0) + UNUSED_CLIENT_TTL < t) store.deleteClient(c.client_id);
      const left = unused.filter((c) => store.getClient(c.client_id));
      while (Object.keys(store.state.clients).length >= MAX_CLIENTS && left.length) store.deleteClient(left.shift().client_id);
      if (Object.keys(store.state.clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError("Too many apps are connected to this server. Disconnect one first.");
      const client = {
        ...info,
        client_name: String(info.client_name ?? "").slice(0, 100) || undefined,
        client_id: info.client_id ?? randomToken(18),
        client_id_issued_at: info.client_id_issued_at ?? t,
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
