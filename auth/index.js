// Optional sign-in. Off unless OIDC_ISSUER is set; then:
//
//   the website     people sign in at their own OpenID Connect provider; a session cookie follows
//   /mcp            Ghostwriter is an OAuth authorization server for MCP hosts (provider.js): an app
//                   registers itself, the person signs in at their provider and approves the app, and
//                   the app gets Ghostwriter's own tokens. Adding the connector is still just the URL.
//   /api            needs the session cookie (website) or a short-lived view token (the MCP App view,
//                   which runs on the host's origin where cookies don't reach)
//
// Who may use it is an allowlist of emails or groups from the provider, or explicitly anyone it signs in.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOidcClient, checkIssuer, OidcError } from "./oidc.js";
import { createStore } from "./store.js";
import { createProvider } from "./provider.js";
import { signer, parseCookies, cookie, addCookie, safeReturn, safeEqual, splitList, now } from "./util.js";
import { consentPage, messagePage, pageHeaders } from "./pages.js";

const DAY = 24 * 3600;

/** Reads the OIDC_* settings. Null when sign-in is off; throws with a clear message when it is half set up. */
export function readAuthConfig(env, { origin, dataDir }) {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) {
    const stray = ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ALLOWED_EMAILS", "OIDC_ALLOWED_GROUPS"].filter((k) => env[k]);
    if (stray.length) throw new Error(`${stray.join(", ")} set but OIDC_ISSUER is not. Set OIDC_ISSUER to turn sign-in on, or remove them.`);
    return null;
  }
  checkIssuer(issuer);
  const fail = (m) => {
    throw new Error(`Sign-in is misconfigured: ${m}`);
  };
  const u = new URL(origin);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) fail(`PUBLIC_ORIGIN (${origin}) must be https when sign-in is on.`);
  const clientId = env.OIDC_CLIENT_ID?.trim() || fail("OIDC_CLIENT_ID is not set.");
  let clientSecret = env.OIDC_CLIENT_SECRET?.trim() || "";
  if (!clientSecret && env.OIDC_CLIENT_SECRET_FILE) clientSecret = fs.readFileSync(env.OIDC_CLIENT_SECRET_FILE, "utf8").trim();
  const emails = splitList(env.OIDC_ALLOWED_EMAILS).map((s) => s.toLowerCase());
  const groups = splitList(env.OIDC_ALLOWED_GROUPS);
  const anyUser = /^(1|true|yes)$/i.test(env.OIDC_ALLOW_ANY_USER ?? "");
  if (!emails.length && !groups.length && !anyUser) fail("say who may sign in: OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_GROUPS, or OIDC_ALLOW_ANY_USER=true (anyone your provider signs in).");
  const groupsClaim = env.OIDC_GROUPS_CLAIM?.trim() || "groups";
  const scopes = splitList(env.OIDC_SCOPES).length ? splitList(env.OIDC_SCOPES) : ["openid", "profile", "email", ...(groups.length ? ["groups"] : [])];
  if (!scopes.includes("openid")) scopes.unshift("openid");
  const num = (k, d) => {
    const v = env[k] === undefined || env[k] === "" ? d : Number(env[k]);
    if (!Number.isFinite(v) || v <= 0) fail(`${k} must be a positive number.`);
    return v;
  };
  return {
    origin,
    dataDir: path.join(dataDir, "auth"),
    issuer,
    clientId,
    clientSecret,
    scopes,
    emails,
    groups,
    anyUser,
    groupsClaim,
    sessionTtl: Math.round(num("SESSION_DAYS", 7) * DAY),
    accessTtl: Math.round(num("OAUTH_ACCESS_MINUTES", 60) * 60),
    refreshTtl: Math.round(num("OAUTH_REFRESH_DAYS", 30) * DAY),
    secret: env.SESSION_SECRET?.trim() || "",
  };
}

/** A secret for signing cookies: SESSION_SECRET, or one made once and kept with the data. */
function loadSecret(cfg) {
  if (cfg.secret) {
    if (cfg.secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
    return cfg.secret;
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(cfg.dataDir, "secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  return fs.readFileSync(file, "utf8").trim();
}

export function createAuth(cfg, { fetchImpl } = {}) {
  const { origin } = cfg;
  const resource = `${origin}/mcp`;
  const secure = new URL(origin).protocol === "https:";
  // __Host- cookies are only accepted over https, from this exact host, for the whole site.
  const SESSION = secure ? "__Host-gw_session" : "gw_session";
  // One cookie per sign-in in progress (named by its state), so two at once (a tab signing in to the
  // site while Claude connects in another) don't cancel each other.
  const LOGIN = secure ? "__Host-gw_login_" : "gw_login_";
  const loginName = (state) => LOGIN + String(state).slice(0, 12).replace(/[^A-Za-z0-9_-]/g, "");
  const secret = loadSecret(cfg);
  const sessions = signer(secret, "session");
  const logins = signer(secret, "login");
  const views = signer(secret, "view");
  const consents = signer(secret, "consent");
  const store = createStore(cfg.dataDir);
  const oidc = createOidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: `${origin}/auth/callback`, scopes: cfg.scopes, fetchImpl });

  const emails = new Set(cfg.emails);
  const groups = new Set(cfg.groups);
  /** The allowlist, checked on every request, so changing it takes effect without anyone signing out. */
  function allowed(user) {
    if (!user?.sub) return false;
    if (cfg.anyUser) return true;
    // An email only counts when the provider says it checked it: some let people type any address.
    if (emails.size && user.email && user.emailVerified === true && emails.has(user.email.toLowerCase())) return true;
    return groups.size > 0 && Array.isArray(user.groups) && user.groups.some((g) => groups.has(g));
  }

  /** The few facts kept about a person, from the provider's claims. */
  function userFromClaims(c) {
    let g = c[cfg.groupsClaim];
    if (typeof g === "string") g = [g]; // one group; never split ("Domain Admins" is not "Admins")
    return {
      sub: String(c.sub),
      name: String(c.name || c.preferred_username || c.email || c.sub).slice(0, 200),
      email: typeof c.email === "string" ? c.email.slice(0, 320) : undefined,
      emailVerified: c.email_verified === undefined ? undefined : c.email_verified === true || c.email_verified === "true",
      // Only the groups that let the person in: keeps the session cookie small whatever the provider sends.
      groups: Array.isArray(g) ? g.filter((x) => typeof x === "string" && groups.has(x)) : [],
    };
  }

  const { provider, getPending, approve, deny } = createProvider({ store, resource, origin, accessTtl: cfg.accessTtl, refreshTtl: cfg.refreshTtl, allowed });

  /* ---------------------------------- sessions ---------------------------------- */

  function sessionUser(req) {
    const v = sessions.verify(parseCookies(req.headers.cookie)[SESSION]);
    return v && allowed(v.user) ? v.user : null;
  }
  const setSession = (res, user) => addCookie(res, cookie(SESSION, sessions.sign({ user, exp: now() + cfg.sessionTtl }), { maxAge: cfg.sessionTtl, secure }));
  const clearSession = (res) => addCookie(res, cookie(SESSION, "", { maxAge: 0, secure }));

  /**
   * For the MCP App view: proves who the person is to /api for an hour. Tied to the app whose
   * connection asked for it, so disconnecting that app ends its editor's access too.
   */
  function viewToken(user, clientId) {
    const exp = now() + 3600;
    return { token: views.sign({ user, clientId, exp }), expiresAt: exp };
  }

  /** Who is calling /api: a view token (Authorization: Bearer) or the website's session cookie. */
  function apiUser(req) {
    const h = req.headers.authorization;
    if (h) {
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      const v = m ? views.verify(m[1]) : null;
      return v && allowed(v.user) && (!v.clientId || store.getGrant(v.user.sub, v.clientId)) ? { user: v.user, via: "view" } : null;
    }
    const user = sessionUser(req);
    return user ? { user, via: "cookie" } : null;
  }

  /** A cookie-authenticated change must come from this site's own pages (CSRF). */
  function fromThisSite(req) {
    const o = req.headers.origin;
    if (o) return o === origin;
    return req.headers["sec-fetch-site"] === "same-origin";
  }

  const unauthorized = (res) => res.status(401).json({ error: "unauthorized", message: "Sign in to use Ghostwriter." });

  /** Guards /api (mounted in front of it). /api/session answers signed-out callers itself. */
  function apiGuard(req, res, next) {
    if (req.method === "OPTIONS" || req.path === "/session") return next();
    const who = apiUser(req);
    if (!who) return unauthorized(res);
    if (who.via === "cookie" && !["GET", "HEAD"].includes(req.method) && !fromThisSite(req)) return res.status(403).json({ error: "forbidden", message: "That request did not come from this site." });
    req.user = who.user;
    next();
  }

  /** /api/session: who is signed in, sign out, and the apps the person connected. */
  const session = express.Router();
  session.get("/", (req, res) => {
    const who = apiUser(req);
    res.set("Cache-Control", "no-store").json({ auth: true, user: who ? { name: who.user.name, email: who.user.email ?? null } : null, via: who?.via ?? null, login: "/auth/login" });
  });
  session.delete("/", (req, res) => {
    if (req.headers.cookie && !fromThisSite(req)) return res.status(403).json({ error: "forbidden", message: "That request did not come from this site." });
    clearSession(res);
    res.set("Cache-Control", "no-store").json({ auth: true, user: null, login: "/auth/login" });
  });
  const listApps = (sub) =>
    store
      .grantsFor(sub)
      .map((g) => {
        const c = store.getClient(g.clientId);
        let host = "";
        try {
          const u = new URL(c?.redirect_uris?.[0] ?? "");
          host = u.protocol === "https:" || u.protocol === "http:" ? u.host : u.protocol.replace(/:$/, "");
        } catch {
          /* none */
        }
        return { id: g.clientId, name: c?.client_name || "Unnamed app", host, approvedAt: g.approvedAt, lastUsed: g.lastUsed ?? null };
      })
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  session.get("/apps", (req, res) => {
    const who = apiUser(req);
    if (!who) return unauthorized(res);
    res.set("Cache-Control", "no-store").json({ apps: listApps(who.user.sub) });
  });
  session.delete("/apps/:id", (req, res) => {
    const who = apiUser(req);
    if (!who) return unauthorized(res);
    if (who.via === "cookie" && !fromThisSite(req)) return res.status(403).json({ error: "forbidden", message: "That request did not come from this site." });
    store.deleteGrant(who.user.sub, req.params.id);
    res.set("Cache-Control", "no-store").json({ apps: listApps(who.user.sub) });
  });

  /* ---------------------------- sign-in and approval ---------------------------- */

  const router = express.Router();
  // Registration is open to anyone: a small body, parsed here before the app's 1 MB JSON parser.
  router.use("/register", express.json({ limit: "8kb" }), (err, _req, res, next) => (err ? res.status(err.status ?? 400).json({ error: "invalid_client_metadata", error_description: err.status === 413 ? "The registration is too big." : "The registration is not valid JSON." }) : next()));
  const show = (res, status, html) => {
    pageHeaders(res);
    res.status(status).send(html);
  };

  router.get("/auth/login", async (req, res) => {
    const ret = safeReturn(req.query.return);
    try {
      const { url, state, nonce, verifier } = await oidc.startLogin();
      addCookie(res, cookie(loginName(state), logins.sign({ state, nonce, verifier, ret, exp: now() + 600 }), { maxAge: 600, secure }));
      res.set("Cache-Control", "no-store").redirect(302, url);
    } catch (e) {
      console.error("auth: could not start sign-in:", e.message);
      show(res, 502, messagePage("Sign-in is unavailable", "Ghostwriter could not reach its sign-in provider. Try again in a minute.", { link: `/auth/login?return=${encodeURIComponent(ret)}`, linkText: "Try again" }));
    }
  });

  router.get("/auth/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;
    const name = loginName(state ?? "");
    const pending = typeof state === "string" ? logins.verify(parseCookies(req.headers.cookie)[name]) : null;
    addCookie(res, cookie(name, "", { maxAge: 0, secure }));
    if (!pending || typeof state !== "string" || !safeEqual(state, pending.state)) {
      return show(res, 400, messagePage("Sign-in expired", "That sign-in link is old or was opened in another browser. Start again.", { link: `/auth/login?return=${encodeURIComponent(pending?.ret ?? "/")}`, linkText: "Sign in" }));
    }
    if (error) {
      return show(res, 400, messagePage("Sign-in didn't finish", `Your sign-in provider said: ${String(error_description || error).slice(0, 300)}`, { link: pending.ret }));
    }
    try {
      const claims = await oidc.finishLogin({ code: String(code ?? ""), verifier: pending.verifier, nonce: pending.nonce });
      const user = userFromClaims(claims);
      if (!allowed(user)) {
        console.warn(`auth: ${user.email ?? user.sub} signed in but is not on the allowlist`);
        return show(res, 403, messagePage("Not on the list", `You signed in as ${user.email ?? user.name}, but this Ghostwriter isn't open to that account. Ask whoever runs it to add you.`, { link: "/", linkText: "OK" }));
      }
      setSession(res, user);
      res.set("Cache-Control", "no-store").redirect(302, pending.ret);
    } catch (e) {
      console.error("auth: sign-in failed:", e.message);
      const text = e instanceof OidcError ? e.message : "Something went wrong talking to the sign-in provider.";
      show(res, 502, messagePage("Sign-in failed", text, { link: `/auth/login?return=${encodeURIComponent(pending.ret)}`, linkText: "Try again" }));
    }
  });

  const expired = () => messagePage("This request has expired", "Go back to the app you were connecting and start again.", { link: "/", linkText: "Open Ghostwriter" });
  const csrfFor = (id, user) => consents.mac(`${id} ${user.sub}`);

  router.get("/auth/consent/:id", (req, res) => {
    const p = getPending(req.params.id);
    if (!p) return show(res, 400, expired());
    const user = sessionUser(req);
    if (!user) return res.set("Cache-Control", "no-store").redirect(302, `/auth/login?return=${encodeURIComponent(`/auth/consent/${req.params.id}`)}`);
    // Approved before: no need to ask again (the person can disconnect the app from the menu).
    if (store.getGrant(user.sub, p.clientId)) return res.set("Cache-Control", "no-store").redirect(302, approve(req.params.id, user));
    show(res, 200, consentPage({ id: req.params.id, client: p.client, redirectUri: p.redirectUri, user, csrf: csrfFor(req.params.id, user) }));
  });

  router.post("/auth/consent/:id", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const p = getPending(req.params.id);
    if (!p) return show(res, 400, expired());
    const user = sessionUser(req);
    if (!user) return res.redirect(303, `/auth/login?return=${encodeURIComponent(`/auth/consent/${req.params.id}`)}`);
    if (req.headers.origin !== origin || !safeEqual(String(req.body?.csrf ?? ""), csrfFor(req.params.id, user))) {
      return show(res, 403, messagePage("That didn't work", "The approval form was not sent from this page. Go back to the app and start again."));
    }
    const to = req.body.decision === "allow" ? approve(req.params.id, user) : deny(req.params.id);
    if (!to) return show(res, 400, expired());
    res.set("Cache-Control", "no-store").redirect(303, to);
  });

  // Discovery documents. The SDK names the issuer with a trailing slash ("https://host/"), and some
  // clients (ChatGPT) compare issuers exactly and give up when the slash differs from what they
  // expect, so these are served first with the usual form, the bare origin, everywhere it appears.
  const asMetadata = { ...createOAuthMetadata({ provider, issuerUrl: new URL(origin), baseUrl: new URL(origin) }), issuer: origin };
  const discovery = (doc) => (_req, res) => res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" }).json(doc);
  router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/"], discovery(asMetadata));
  // RFC 9728: the document at a resource's well-known address names that resource. /mcp is the one
  // that needs tokens; the root names the server as a whole. Tokens for either work on /mcp.
  router.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp/"], discovery({ resource, authorization_servers: [origin], resource_name: "Ghostwriter" }));
  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/"], discovery({ resource: origin, authorization_servers: [origin], resource_name: "Ghostwriter" }));
  // Not an OpenID provider for apps (people sign in at the real one): say so in JSON, not an HTML 404.
  router.get(["/.well-known/openid-configuration", "/.well-known/openid-configuration/"], (_req, res) => res.status(404).json({ error: "not_found", error_description: "Use /.well-known/oauth-authorization-server." }));

  // The OAuth endpoints (MCP SDK). Apps that register get secrets that do not expire: they are kept
  // as long as the app stays connected.
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      baseUrl: new URL(origin),
      resourceServerUrl: new URL(resource),
      resourceName: "Ghostwriter",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  const mcpGuard = requireBearerAuth({ verifier: provider, expectedResource: new URL(resource), resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` });

  return { router, apiGuard, session, mcpGuard, viewToken, allowed, store, describe: () => `sign-in on: ${cfg.issuer} (${cfg.anyUser ? "any user" : [...cfg.emails, ...cfg.groups.map((g) => "group " + g)].join(", ")})` };
}
