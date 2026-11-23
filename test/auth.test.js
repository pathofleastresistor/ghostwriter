// Sign-in, end to end: the website's sign-in at an OpenID Connect provider (a fake one), and an MCP
// client that registers itself, gets the person's approval and uses Ghostwriter's own tokens, the
// way Claude does. Uses the MCP SDK's own OAuth client, so discovery, registration and PKCE are real.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { startFakeIdp } from "./fake-idp.js";

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const idp = await startFakeIdp({ redirectUri: `${ORIGIN}/auth/callback` });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-auth-"));
Object.assign(process.env, {
  DATA_DIR: dir,
  PUBLIC_ORIGIN: ORIGIN,
  OIDC_ISSUER: idp.issuer,
  OIDC_CLIENT_ID: idp.clientId,
  OIDC_CLIENT_SECRET: idp.clientSecret,
  OIDC_ALLOWED_GROUPS: "admins,family",
  OIDC_ALLOWED_EMAILS: "guest@example.test",
  UNOWNED_DOCS_OWNER: "Amit@example.test",
});
// A document from before libraries: it belongs to nobody until UNOWNED_DOCS_OWNER signs in.
fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
fs.writeFileSync(path.join(dir, "docs", "oldone01.json"), JSON.stringify({ title: "From before libraries", nodes: [{ type: "paragraph", text: "Kept." }] }));

const { app } = await import("../server.js");
const { readAuthConfig } = await import("../auth/index.js");
const { redirectAllowed } = await import("../auth/provider.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");

let http;
before(async () => {
  await new Promise((r) => (http = app.listen(PORT, "127.0.0.1", r)));
});
after(async () => {
  http.close();
  await idp.close();
});

/** A browser, more or less: a cookie jar, no automatic redirects. */
function browser() {
  const jar = new Map();
  const go = async (url, init = {}) => {
    const u = new URL(url, ORIGIN);
    const headers = { ...(init.headers ?? {}) };
    if (u.origin === ORIGIN && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(u, { ...init, headers, redirect: "manual" });
    if (u.origin === ORIGIN) {
      for (const c of r.headers.getSetCookie()) {
        const [kv, ...attrs] = c.split(";");
        const i = kv.indexOf("=");
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (!v || attrs.some((a) => /max-age=0\b/i.test(a.trim()))) jar.delete(k);
        else jar.set(k, v);
      }
    }
    return r;
  };
  /** Follows redirects the way a browser would, stopping when it leaves the given origins. */
  const follow = async (url, { stopAt } = {}) => {
    url = new URL(url, ORIGIN).href;
    let r = await go(url);
    let hops = 0;
    while (r.status >= 300 && r.status < 400 && hops++ < 10) {
      const next = new URL(r.headers.get("location"), url);
      url = next.href;
      if (stopAt && url.startsWith(stopAt)) return { res: r, url };
      r = await go(url);
    }
    return { res: r, url };
  };
  return { jar, go, follow };
}

async function signIn(b, ret = "/") {
  const { res, url } = await b.follow(`/auth/login?return=${encodeURIComponent(ret)}`);
  return { res, url };
}

const apiFetch = (b, method, p, body, extra = {}) =>
  b.go(`/api${p}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });

describe("config", () => {
  const base = { OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", OIDC_ALLOWED_GROUPS: "a" };
  const read = (env, origin = "https://notes.example.com") => readAuthConfig(env, { origin, dataDir: "/tmp/x" });
  test("off when OIDC_ISSUER is not set", () => assert.equal(read({}), null));
  test("half-configured settings are an error, not silently open", () => {
    assert.throws(() => read({ OIDC_CLIENT_ID: "x" }), /OIDC_ISSUER is not/);
    assert.throws(() => read({ ...base, OIDC_ALLOWED_GROUPS: "" }), /say who may sign in/);
    assert.throws(() => read({ ...base, OIDC_CLIENT_ID: "" }), /OIDC_CLIENT_ID/);
    assert.throws(() => read(base, "http://notes.example.com"), /must be https/);
    assert.throws(() => read({ ...base, OIDC_ISSUER: "http://id.example.com" }), /https/);
  });
  test("asks for the groups scope when groups decide, and accepts an explicit open door", () => {
    assert.deepEqual(read(base).scopes, ["openid", "profile", "email", "groups"]);
    assert.equal(read({ ...base, OIDC_ALLOWED_GROUPS: "", OIDC_ALLOW_ANY_USER: "true" }).anyUser, true);
  });
});

describe("signed out", () => {
  test("the site's files and health check are public; the documents and /mcp are not", async () => {
    assert.equal((await fetch(`${ORIGIN}/healthz`)).status, 200);
    assert.equal((await fetch(`${ORIGIN}/`)).status, 200);
    assert.deepEqual(await (await fetch(`${ORIGIN}/api/session`)).json(), { auth: true, user: null, via: null, login: "/auth/login" });
    assert.equal((await fetch(`${ORIGIN}/api/docs`)).status, 401);
    const mcp = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate"), new RegExp(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));
  });

  test("advertises itself as the authorization server for /mcp, with registration and PKCE", async () => {
    const prm = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    const root = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource`)).json();
    assert.equal(root.resource, ORIGIN, "the root document names the server (RFC 9728)");
    assert.deepEqual(root.authorization_servers, [ORIGIN]);
    const as = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    // The issuer is written the same way everywhere, with no trailing slash: ChatGPT compares exactly.
    assert.equal(as.issuer, ORIGIN);
    const asSlash = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server/`)).json();
    assert.equal(asSlash.issuer, ORIGIN);
    const oidc = await fetch(`${ORIGIN}/.well-known/openid-configuration`);
    assert.equal(oidc.status, 404);
    assert.equal((await oidc.json()).error, "not_found");
    assert.equal(as.registration_endpoint, `${ORIGIN}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.ok(as.revocation_endpoint);
  });

  test("a forged view token gets nothing", async () => {
    const r = await fetch(`${ORIGIN}/api/docs`, { headers: { authorization: "Bearer eyJ1c2VyIjp7InN1YiI6IngifSwiZXhwIjo5OTk5OTk5OTk5fQ.AAAA" } });
    assert.equal(r.status, 401);
  });
});

describe("website sign-in", () => {
  test("sign in at the provider, come back to where you were, then use the API", async () => {
    const b = browser();
    const { res, url } = await signIn(b, "/#/d/abc123");
    assert.equal(url, `${ORIGIN}/#/d/abc123`, "back where the person started");
    assert.equal(res.status, 200);
    assert.ok(b.jar.has("gw_session"));
    assert.ok(![...b.jar.keys()].some((k) => k.startsWith("gw_login")), "the sign-in-in-progress cookie is gone");
    const session = await (await apiFetch(b, "GET", "/session")).json();
    assert.deepEqual(session.user, { name: "Amit", email: "amit@example.test" });
    assert.equal((await apiFetch(b, "GET", "/docs")).status, 200);
  });

  test("changes need to come from this site (CSRF): no Origin or another origin is refused", async () => {
    const b = browser();
    await signIn(b);
    assert.equal((await apiFetch(b, "POST", "/docs", { title: "x" })).status, 403);
    assert.equal((await apiFetch(b, "POST", "/docs", { title: "x" }, { origin: "https://evil.example" })).status, 403);
    const ok = await apiFetch(b, "POST", "/docs", { title: "From the site" }, { origin: ORIGIN });
    assert.equal(ok.status, 200);
  });

  test("sign out ends the session", async () => {
    const b = browser();
    await signIn(b);
    assert.equal((await apiFetch(b, "DELETE", "/session", null, { origin: ORIGIN })).status, 200);
    assert.ok(!b.jar.has("gw_session"));
    assert.equal((await apiFetch(b, "GET", "/docs")).status, 401);
  });

  test("someone the provider signs in but who is not on the list gets no session", async () => {
    const saved = idp.user;
    idp.user = { sub: "u-stranger", name: "Stranger", email: "stranger@example.test", email_verified: true, groups: ["other"] };
    try {
      const b = browser();
      const { res } = await signIn(b);
      assert.equal(res.status, 403);
      assert.match(await res.text(), /Not on the list/);
      assert.ok(!b.jar.has("gw_session"));
    } finally {
      idp.user = saved;
    }
  });

  test("an allowed email works without a group, but only if the provider verified it", async () => {
    const saved = idp.user;
    try {
      idp.user = { sub: "u-guest", name: "Guest", email: "Guest@Example.test", email_verified: true, groups: [] };
      const b = browser();
      await signIn(b);
      assert.ok(b.jar.has("gw_session"));
      idp.user = { sub: "u-guest2", name: "Guest", email: "guest@example.test", email_verified: false, groups: [] };
      const b2 = browser();
      assert.equal((await signIn(b2)).res.status, 403);
      idp.user = { sub: "u-guest3", name: "Guest", email: "guest@example.test", groups: [] };
      assert.equal((await signIn(browser())).res.status, 403, "a provider that doesn't say it verified the email");
      idp.user = { sub: "u-da", name: "DA", email: "da@example.test", email_verified: true, groups: "Domain admins" };
      assert.equal((await signIn(browser())).res.status, 403, "a groups claim given as one string is one group, not split on spaces");
    } finally {
      idp.user = saved;
    }
  });

  test("a callback that does not match the sign-in that started it is refused", async () => {
    const b = browser();
    const start = await b.go("/auth/login");
    const authorize = new URL(start.headers.get("location"));
    authorize.searchParams.set("state", "not-the-state");
    const toCallback = await fetch(authorize, { redirect: "manual" });
    const r = await b.go(toCallback.headers.get("location"));
    assert.equal(r.status, 400);
    assert.ok(!b.jar.has("gw_session"));
  });

  test("two sign-ins at once in one browser both finish", async () => {
    const b = browser();
    const a1 = await b.go("/auth/login?return=%2F%23%2Fa");
    const a2 = await b.go("/auth/login?return=%2F%23%2Fb");
    const cb = async (start) => (await fetch(start.headers.get("location"), { redirect: "manual" })).headers.get("location");
    const [c1, c2] = [await cb(a1), await cb(a2)];
    const r1 = await b.go(c1);
    const r2 = await b.go(c2);
    assert.equal(r1.headers.get("location"), "/#/a");
    assert.equal(r2.headers.get("location"), "/#/b");
  });

  test("an ID token with a bad signature is refused", async () => {
    idp.tamper = true;
    try {
      const b = browser();
      const { res } = await signIn(b);
      assert.equal(res.status, 502);
      assert.match(await res.text(), /signature/);
      assert.ok(!b.jar.has("gw_session"));
    } finally {
      idp.tamper = false;
    }
  });

  test("a userinfo hiccup is retried, and a lasting failure says so instead of 'not on the list'", async () => {
    try {
      idp.userinfoFailures = 1;
      const b = browser();
      await signIn(b);
      assert.ok(b.jar.has("gw_session"), "one failed userinfo call is retried");
      idp.userinfoFailures = 2;
      const b2 = browser();
      const { res } = await signIn(b2);
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.match(text, /couldn(&#39;|'|&#x27;)t reach your sign-in service/);
      assert.doesNotMatch(text, /Not on the list/);
      assert.ok(!b2.jar.has("gw_session"));
    } finally {
      idp.userinfoFailures = 0;
    }
  });

  test("the provider saying no is shown, not swallowed", async () => {
    idp.deny = true;
    const b = browser();
    const { res } = await signIn(b);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /The user said no/);
  });

  test("the return address can only be a path on this site", async () => {
    for (const evil of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const b = browser();
      const { url } = await signIn(b, evil);
      assert.equal(url, `${ORIGIN}/`, evil);
    }
  });
});

/* -------------------------------- MCP hosts -------------------------------- */

const APP_REDIRECT = "http://127.0.0.1:9/oauth/callback"; // never fetched: the test reads the code from the Location

/** What Claude keeps for a connector: its registration, tokens and PKCE verifier. */
function hostAuth(name = "Test Host") {
  const s = { authUrl: null };
  return {
    s,
    get redirectUrl() {
      return APP_REDIRECT;
    },
    get clientMetadata() {
      return { client_name: name, redirect_uris: [APP_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post" };
    },
    clientInformation: () => s.client,
    saveClientInformation: (c) => (s.client = c),
    tokens: () => s.tokens,
    saveTokens: (t) => (s.tokens = t),
    redirectToAuthorization: (u) => (s.authUrl = u),
    saveCodeVerifier: (v) => (s.verifier = v),
    codeVerifier: () => s.verifier,
  };
}

/** Connects like Claude: 401, register, send the person to approve, swap the code, connect. */
async function connectHost(b, provider = hostAuth()) {
  const t1 = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider });
  const c1 = new Client({ name: "host", version: "0" });
  await assert.rejects(c1.connect(t1), UnauthorizedError);
  assert.ok(provider.s.client?.client_id, "the host registered itself");
  // The person, in their browser:
  let { res, url } = await b.follow(provider.s.authUrl.href, { stopAt: APP_REDIRECT });
  if (!url.startsWith(APP_REDIRECT)) {
    assert.equal(res.status, 200, "the approval page");
    const html = await res.text();
    assert.match(html, new RegExp(`Allow ${provider.clientMetadata.client_name} to use Ghostwriter`));
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const r = await b.go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ csrf, decision: "allow" }) });
    assert.equal(r.status, 303);
    url = r.headers.get("location");
  }
  assert.ok(url.startsWith(APP_REDIRECT), url);
  const code = new URL(url).searchParams.get("code");
  await t1.finishAuth(code);
  const client = new Client({ name: "host", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider }));
  return { client, provider };
}

const tokenRequest = (form) => fetch(`${ORIGIN}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
const mcpWith = (token) =>
  fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

describe("MCP hosts (Claude, ChatGPT)", () => {
  test("adding the connector is just the URL: register, sign in, approve, use the tools", async () => {
    const b = browser();
    const { client, provider } = await connectHost(b);
    assert.ok(b.jar.has("gw_session"), "the person signed in on the way");
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "list_documents"));
    const vt = tools.find((t) => t.name === "get_view_token");
    assert.deepEqual(vt._meta.ui.visibility, ["app"], "only the editor view uses it, not the model");
    const r = await client.callTool({ name: "list_documents", arguments: {} });
    assert.ok(!r.isError);
    assert.ok(provider.s.tokens.access_token.startsWith("gwa_"));
    await client.close();
  });

  test("the editor view gets its token for /api from get_view_token, never in its (cacheable) HTML", async () => {
    const { client } = await connectHost(browser());
    const { contents } = await client.readResource({ uri: "ui://ghostwriter/v3/editor.html" });
    const boot = JSON.parse(/window\.__GHOSTWRITER__=(\{.*?\});/.exec(contents[0].text)[1]);
    assert.equal(boot.auth, true);
    assert.equal(boot.token, undefined, "hosts cache view HTML, and may share it");
    const r = await client.callTool({ name: "get_view_token", arguments: {} });
    const { token, expiresAt } = r.structuredContent;
    assert.ok(expiresAt > Date.now() / 1000 + 3000);
    for (const t of [token]) {
      const docs = await fetch(`${ORIGIN}/api/docs`, { headers: { authorization: `Bearer ${t}`, origin: "https://sandbox.example" } });
      assert.equal(docs.status, 200);
      assert.equal(docs.headers.get("access-control-allow-origin"), "*");
      // Changes from the view's sandbox are fine: a bearer token isn't sent by a browser on its own.
      const made = await fetch(`${ORIGIN}/api/docs`, { method: "POST", headers: { authorization: `Bearer ${t}`, origin: "https://sandbox.example", "content-type": "application/json" }, body: "{}" });
      assert.equal(made.status, 200);
    }
    const pre = await fetch(`${ORIGIN}/api/docs`, { method: "OPTIONS", headers: { origin: "https://sandbox.example", "access-control-request-headers": "authorization" } });
    assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);
    await client.close();
  });

  test("an app approved before is not asked about again", async () => {
    const b = browser();
    const provider = hostAuth("Remembered App");
    (await connectHost(b, provider)).client.close();
    // Its access lapses; it starts again (a fresh PKCE round) and the person is sent straight back.
    provider.s.tokens = undefined;
    const t = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider });
    await assert.rejects(new Client({ name: "h", version: "0" }).connect(t), UnauthorizedError);
    const { url } = await b.follow(provider.s.authUrl.href, { stopAt: APP_REDIRECT });
    assert.ok(url.startsWith(APP_REDIRECT) && new URL(url).searchParams.get("code"), "no approval page this time");
  });

  test("Cancel sends the app away with access_denied", async () => {
    const b = browser();
    await signIn(b);
    const provider = hostAuth("Declined App");
    await assert.rejects(new Client({ name: "h", version: "0" }).connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider })), UnauthorizedError);
    const { res, url } = await b.follow(provider.s.authUrl.href);
    assert.equal(res.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await res.text())[1];
    const r = await b.go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ csrf, decision: "deny" }) });
    const back = new URL(r.headers.get("location"));
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("code"), null);
  });

  test("the approval form only counts from this page, for this person", async () => {
    const b = browser();
    await signIn(b);
    const provider = hostAuth("Forged App");
    await assert.rejects(new Client({ name: "h", version: "0" }).connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider })), UnauthorizedError);
    const { url } = await b.follow(provider.s.authUrl.href);
    const post = (headers, csrf) => b.go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ csrf, decision: "allow" }) });
    assert.equal((await post({ origin: "https://evil.example" }, "x")).status, 403, "from another site");
    assert.equal((await post({ origin: ORIGIN }, "wrong")).status, 403, "without the page's token");
    const page = await b.go(url);
    assert.equal(page.headers.get("x-frame-options"), "DENY", "can't be framed (clickjacking)");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  test("an approval page visited signed out goes through sign-in first", async () => {
    const provider = hostAuth("Fresh App");
    await assert.rejects(new Client({ name: "h", version: "0" }).connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider })), UnauthorizedError);
    const b = browser();
    const first = await b.go(provider.s.authUrl.href);
    const consent = first.headers.get("location");
    const second = await b.go(consent);
    assert.equal(second.status, 302);
    assert.match(second.headers.get("location"), /^\/auth\/login\?return=%2Fauth%2Fconsent%2F/);
  });

  test("refresh tokens rotate, and replaying an old one ends the whole chain", async () => {
    const { client, provider } = await connectHost(browser(), hostAuth("Rotating App"));
    await client.close();
    const { client_id, client_secret } = provider.s.client;
    const first = provider.s.tokens;
    const r1 = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id, client_secret });
    assert.equal(r1.status, 200);
    const second = await r1.json();
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal((await mcpWith(second.access_token)).status, 200);
    // The old refresh token again: refused, and the new tokens stop working too.
    const replay = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id, client_secret });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
    assert.equal((await mcpWith(second.access_token)).status, 401);
    const again = await tokenRequest({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id, client_secret });
    assert.equal(again.status, 400);
  });

  test("a code works once, for the app it was issued to", async () => {
    const b = browser();
    await signIn(b);
    const provider = hostAuth("Code App");
    const t = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider });
    await assert.rejects(new Client({ name: "h", version: "0" }).connect(t), UnauthorizedError);
    const { res, url } = await b.follow(provider.s.authUrl.href);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await res.text())[1];
    const r = await b.go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ csrf, decision: "allow" }) });
    const code = new URL(r.headers.get("location")).searchParams.get("code");
    const { client_id, client_secret } = provider.s.client;
    const bad = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: "x".repeat(50), client_id, client_secret, redirect_uri: APP_REDIRECT });
    assert.equal(bad.status, 400, "wrong PKCE verifier");
    const ok = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: provider.s.verifier, client_id, client_secret, redirect_uri: APP_REDIRECT });
    assert.equal(ok.status, 200);
    const twice = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: provider.s.verifier, client_id, client_secret, redirect_uri: APP_REDIRECT });
    assert.equal(twice.status, 400);
  });

  test("disconnecting an app from the menu cuts it off at once", async () => {
    const b = browser();
    const { client, provider } = await connectHost(b, hostAuth("Disconnect Me"));
    const viewToken = (await client.callTool({ name: "get_view_token", arguments: {} })).structuredContent.token;
    assert.equal((await fetch(`${ORIGIN}/api/docs`, { headers: { authorization: `Bearer ${viewToken}` } })).status, 200);
    await client.close();
    const { apps } = await (await apiFetch(b, "GET", "/session/apps")).json();
    const app = apps.find((a) => a.name === "Disconnect Me");
    assert.ok(app);
    assert.equal(app.host, "127.0.0.1:9");
    assert.equal((await apiFetch(b, "DELETE", `/session/apps/${app.id}`)).status, 403, "needs this site's Origin");
    assert.equal((await apiFetch(b, "DELETE", `/session/apps/${app.id}`, null, { origin: ORIGIN })).status, 200);
    assert.equal((await mcpWith(provider.s.tokens.access_token)).status, 401);
    const { client_id, client_secret } = provider.s.client;
    assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: provider.s.tokens.refresh_token, client_id, client_secret })).status, 400);
    assert.equal((await fetch(`${ORIGIN}/api/docs`, { headers: { authorization: `Bearer ${viewToken}` } })).status, 401, "its editor's token stops working too");
  });

  test("revoking a token through /revoke works for the app that holds it", async () => {
    const { client, provider } = await connectHost(browser(), hostAuth("Revoker"));
    await client.close();
    const { client_id, client_secret } = provider.s.client;
    const r = await fetch(`${ORIGIN}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: provider.s.tokens.refresh_token, client_id, client_secret }) });
    assert.equal(r.status, 200);
    assert.equal((await mcpWith(provider.s.tokens.access_token)).status, 401);
  });

  test("registration refuses redirect addresses that could leak a code", async () => {
    const reg = (uris) => fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: uris }) });
    for (const bad of [["javascript:alert(1)"], ["http://evil.example/cb"], ["data:text/html,hi"], ["https://ok.example/cb#frag"]]) assert.equal((await reg(bad)).status, 400, bad[0]);
    assert.equal((await reg(["https://claude.ai/api/mcp/auth_callback"])).status, 201);
    assert.equal((await reg(["cursor://anysphere.cursor-retrieval/oauth/callback"])).status, 201, "an app's own scheme");
    assert.ok(redirectAllowed("http://localhost:33418/callback"));
  });

  test("a ChatGPT-style client (public, PKCE, resource = the server's root) gets a token that works on /mcp", async () => {
    const crypto = await import("node:crypto");
    const b = browser();
    await signIn(b);
    const redirect = "https://chatgpt.com/connector/oauth/test-callback";
    const reg = await fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const u = new URL(`${ORIGIN}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st", resource: ORIGIN })) u.searchParams.set(k, v);
    const { res, url } = await b.follow(u.href, { stopAt: redirect });
    let back = url;
    if (!back.startsWith(redirect)) {
      const csrf = /name="csrf" value="([^"]+)"/.exec(await res.text())[1];
      const r = await b.go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ csrf, decision: "allow" }) });
      back = r.headers.get("location");
    }
    const code = new URL(back).searchParams.get("code");
    assert.equal(new URL(back).searchParams.get("state"), "st");
    const tok = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirect, resource: ORIGIN });
    assert.equal(tok.status, 200);
    const t = await tok.json();
    assert.equal((await mcpWith(t.access_token)).status, 200);
    const again = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id, resource: ORIGIN });
    assert.equal(again.status, 200, "refresh with the root as resource");
  });

  test("a token is only for this server: another resource is refused at authorization", async () => {
    const b = browser();
    await signIn(b);
    const reg = await (await fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Other", redirect_uris: [APP_REDIRECT], token_endpoint_auth_method: "none" }) })).json();
    const u = new URL(`${ORIGIN}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: APP_REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://other.example/mcp", state: "s" })) u.searchParams.set(k, v);
    const r = await b.go(u.href);
    const back = new URL(r.headers.get("location"));
    assert.equal(back.searchParams.get("error"), "invalid_target");
  });

  test("tokens are kept only as hashes, in an owner-only file", async () => {
    const file = path.join(dir, "auth", "state.json");
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /gw[ar]_[A-Za-z0-9_-]{20}/);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(dir, "auth", "secret")).mode & 0o077, 0);
  });
});

describe("libraries: each person has their own documents", () => {
  const asGuest = async (fn) => {
    const saved = idp.user;
    idp.user = { sub: "u-guest-lib", name: "Guest", email: "guest@example.test", email_verified: true, groups: [] };
    try {
      return await fn();
    } finally {
      idp.user = saved;
    }
  };
  const write = (b, method, p, body) => apiFetch(b, method, p, body, { origin: ORIGIN });

  test("the documents from before libraries moved into UNOWNED_DOCS_OWNER's library, and nobody else's", async () => {
    const amit = browser();
    await signIn(amit);
    const mine = (await (await apiFetch(amit, "GET", "/docs")).json()).documents;
    assert.ok(mine.some((d) => d.id === "oldone01" && d.title === "From before libraries"));
    assert.ok(fs.existsSync(path.join(dir, "docs", fs.readdirSync(path.join(dir, "docs")).find((f) => /^u[0-9a-f]{24}$/.test(f)) ?? "-", "oldone01.json")));
    assert.ok(!fs.existsSync(path.join(dir, "docs", "oldone01.json")), "no longer in the open library");
    const theirs = await asGuest(async () => {
      const g = browser();
      await signIn(g);
      return (await (await apiFetch(g, "GET", "/docs")).json()).documents;
    });
    assert.ok(!theirs.some((d) => d.id === "oldone01"));
  });

  test("a new person starts with one sample document of their own", async () => {
    const saved = idp.user;
    idp.user = { sub: "u-fresh", name: "Fresh", email: "fresh@example.test", email_verified: true, groups: ["family"] };
    try {
      const b = browser();
      await signIn(b);
      const docs = (await (await apiFetch(b, "GET", "/docs")).json()).documents;
      assert.equal(docs.length, 1);
      assert.equal(docs[0].title, "Weekend at the lake");
    } finally {
      idp.user = saved;
    }
  });

  test("on the website, someone else's document is not found: not listed, read, saved, renamed, copied or removed", async () => {
    const amit = browser();
    await signIn(amit);
    const doc = await (await write(amit, "POST", "/docs", { title: "Amit's private plan" })).json();
    await asGuest(async () => {
      const g = browser();
      await signIn(g);
      const list = (await (await apiFetch(g, "GET", "/docs")).json()).documents;
      assert.ok(!list.some((d) => d.id === doc.id), "not listed");
      assert.equal((await apiFetch(g, "GET", `/docs/${doc.id}`)).status, 404);
      assert.equal((await apiFetch(g, "GET", `/docs/${doc.id}/pull?since=0`)).status, 404);
      assert.equal((await write(g, "POST", `/docs/${doc.id}/push`, { base: doc.revision, snapshot: doc.snapshot })).status, 404);
      assert.equal((await write(g, "PATCH", `/docs/${doc.id}`, { title: "mine now" })).status, 404);
      assert.equal((await write(g, "POST", `/docs/${doc.id}/copy`)).status, 404);
      assert.equal((await write(g, "DELETE", `/docs/${doc.id}`)).status, 404);
    });
    const still = await (await apiFetch(amit, "GET", `/docs/${doc.id}`)).json();
    assert.equal(still.title, "Amit's private plan");
    // Removing and undoing stays within the library too.
    assert.equal((await write(amit, "DELETE", `/docs/${doc.id}`)).status, 200);
    await asGuest(async () => {
      const g = browser();
      await signIn(g);
      assert.equal((await write(g, "POST", `/docs/${doc.id}/restore`)).status, 404, "someone else can't bring it back");
    });
    assert.equal((await write(amit, "POST", `/docs/${doc.id}/restore`)).status, 200);
  });

  test("over MCP, each connection sees only its person's library", async () => {
    // Registered from its own address: /register is rate-limited per address, and the suite registers many apps.
    const amitApp = hostAuth();
    const regd = await fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(amitApp.clientMetadata) });
    assert.equal(regd.status, 201);
    amitApp.s.client = await regd.json();
    const { client: amit } = await connectHost(browser(), amitApp);
    const created = await amit.callTool({ name: "create_document", arguments: { title: "Only for Amit" } });
    const id = created.structuredContent.id;
    // The same app (already registered: registration is rate-limited per address), a different person.
    const guestApp = hostAuth();
    guestApp.s.client = amitApp.s.client;
    const { client: guest } = await asGuest(() => connectHost(browser(), guestApp));
    const listed = await guest.callTool({ name: "list_documents", arguments: {} });
    assert.ok(!listed.structuredContent.documents.some((d) => d.id === id));
    for (const [name, args] of [
      ["get_document", { document_id: id }],
      ["open_document", { document_id: id }],
      ["replace_text", { document_id: id, node_id: "n1", text: "mine" }],
      ["delete_nodes", { document_id: id, node_ids: ["n1"] }],
      ["set_title", { document_id: id, title: "mine" }],
    ]) {
      const r = await guest.callTool({ name, arguments: args });
      assert.ok(r.isError, `${name} must not reach another person's document`);
      assert.match(r.content[0].text, /no document with id/);
    }
    const mine = await amit.callTool({ name: "get_document", arguments: { document_id: id } });
    assert.ok(!mine.isError);
    assert.match(JSON.stringify(mine), /Only for Amit/);
    await amit.close();
    await guest.close();
  });
});

describe("open registration can't be abused", () => {
  const reg = (body) => fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("a big registration is refused, and only the fields this server uses are kept", async () => {
    const big = await reg({ client_name: "x", redirect_uris: ["https://a.example/cb"], contacts: ["x".repeat(20000)] });
    assert.equal(big.status, 413);
    const r = await reg({ client_name: "y".repeat(500), redirect_uris: ["https://a.example/cb"], contacts: ["c@example.test"], software_statement: "zzz", tos_uri: "https://a.example/tos" });
    assert.equal(r.status, 201);
    const { client_id } = await r.json();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "auth", "state.json"), "utf8")).clients[client_id];
    assert.equal(stored.client_name.length, 100);
    for (const k of ["contacts", "software_statement", "tos_uri"]) assert.equal(stored[k], undefined, k);
  });

  test("an app's state value has a size limit", async () => {
    const c = await (await reg({ client_name: "s", redirect_uris: [APP_REDIRECT], token_endpoint_auth_method: "none" })).json();
    const u = new URL(`${ORIGIN}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: c.client_id, redirect_uri: APP_REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s".repeat(2000) })) u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: "manual" });
    assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_request");
  });

  test("a flood of registrations stops at a limit, without pushing out an app someone is approving", async () => {
    const statuses = [];
    // Each from a different address (as a proxy on this machine would say), so the per-address rate
    // limit doesn't stop it first: this checks the overall cap.
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i + 1}` }, body: JSON.stringify({ client_name: `spam ${i}`, redirect_uris: ["https://spam.example/cb"] }) });
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(400), `refused past the limit: ${statuses.join(" ")}`);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "auth", "state.json"), "utf8")).clients;
    assert.ok(Object.values(kept).some((c) => c.client_name === "Declined App"), "a recent registration is not evicted");
    assert.ok(Object.values(kept).some((c) => c.client_name === "Rotating App"), "an approved app is never evicted");
  });

  test("a client id like __proto__ is just unknown", async () => {
    const u = new URL(`${ORIGIN}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: "__proto__", redirect_uri: APP_REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: "manual" });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "invalid_client");
  });
});
