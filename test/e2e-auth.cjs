// End-to-end check with sign-in on, in a real browser: a stand-in identity provider, the real server,
// the website (sign in, work, connected apps, sign out), and the MCP App view inside a test host whose
// MCP connection signed in the way Claude does, including the view renewing a token it can't use.
// Run: node test/e2e-auth.cjs [screenshot-dir]
const { chromium } = require("playwright-core");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const shots = process.argv[2] ?? os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3013;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = "http://127.0.0.1:3014";
const APP_REDIRECT = `${HOST}/oauth/callback`;

/** Waits for the server to answer, rather than a fixed sleep. */
async function up(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error(`${url} never came up`);
}

(async () => {
  const { startFakeIdp } = await import("./fake-idp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const esbuild = await import("esbuild");

  const idp = await startFakeIdp({ redirectUri: `${ORIGIN}/auth/callback` });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-e2e-auth-"));
  const server = spawn("node", ["server.js"], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), PUBLIC_ORIGIN: ORIGIN, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_ALLOWED_GROUPS: "admins" },
    stdio: "inherit",
  });
  await up(`${ORIGIN}/healthz`);

  // ---- the MCP connection, signed in the way Claude does it (the person's part done with fetch) ----
  const s = {};
  const authProvider = {
    get redirectUrl() {
      return APP_REDIRECT;
    },
    get clientMetadata() {
      return { client_name: "Claude (test)", redirect_uris: [APP_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post" };
    },
    clientInformation: () => s.client,
    saveClientInformation: (c) => (s.client = c),
    tokens: () => s.tokens,
    saveTokens: (t) => (s.tokens = t),
    redirectToAuthorization: (u) => (s.authUrl = u),
    saveCodeVerifier: (v) => (s.verifier = v),
    codeVerifier: () => s.verifier,
  };
  const t1 = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider });
  await new Client({ name: "x", version: "0" }).connect(t1).then(
    () => assert.fail("connected without signing in"),
    (e) => assert.ok(e instanceof UnauthorizedError, e.message),
  );
  const jar = [];
  const go = async (url, init = {}) => {
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...(url.startsWith(ORIGIN) && jar.length ? { cookie: jar.join("; ") } : {}) } });
    if (url.startsWith(ORIGIN)) for (const c of r.headers.getSetCookie()) if (!/Max-Age=0/i.test(c)) jar.push(c.split(";")[0]);
    return r;
  };
  let url = s.authUrl.href;
  let r;
  for (;;) {
    r = await go(url);
    const loc = r.headers.get("location");
    if (!loc) break;
    url = new URL(loc, url).href;
    if (url.startsWith(APP_REDIRECT)) break;
  }
  if (!url.startsWith(APP_REDIRECT)) {
    const csrf = /name="csrf" value="([^"]+)"/.exec(await r.text())[1];
    const ok = await go(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ csrf, decision: "allow" }) });
    url = ok.headers.get("location");
  }
  await t1.finishAuth(new URL(url).searchParams.get("code"));
  const client = new Client({ name: "claude-stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name} failed: ${res.content?.[0]?.text}`);
    return res;
  };
  console.log("ok  an MCP client connects with just the URL: registers, the person signs in and approves");

  // ---- the test host, as in e2e.cjs, but its view starts with a token the server won't take ----
  const bundle = await esbuild.build({ entryPoints: [path.join(root, "test/host/host.js")], bundle: true, format: "esm", write: false, platform: "browser", logLevel: "silent" });
  const hostJs = bundle.outputFiles[0].text;
  const hostHtml = fs.readFileSync(path.join(root, "test/host/index.html"), "utf8");
  const viewTokenCalls = [];
  const host = http.createServer(async (req, res) => {
    if (req.url === "/call") {
      let body = "";
      for await (const c of req) body += c;
      const { name, arguments: a } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      const result = await client.callTool({ name, arguments: a });
      if (name === "get_view_token") {
        viewTokenCalls.push(Date.now());
        // The first token is one the server won't take (as if it had expired): the view has to renew it.
        if (viewTokenCalls.length === 1) result.structuredContent = { ...result.structuredContent, token: "stale.token" };
      }
      return res.end(JSON.stringify(result));
    }
    if (req.url === "/view") {
      const { contents } = await client.readResource({ uri: "ui://ghostwriter/v2/editor.html" });
      assert.doesNotMatch(contents[0].text, /"token"/, "no token in the view's HTML (hosts cache it)");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ text: contents[0].text, meta: contents[0]._meta }));
    }
    if (req.url === "/host.js") return res.setHeader("content-type", "text/javascript"), res.end(hostJs);
    res.setHeader("content-type", "text/html");
    res.end(hostHtml);
  });
  await new Promise((ok) => host.listen(3014, "127.0.0.1", ok));

  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const problems = [];
  const watch = (p) => {
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource.*(404|401)/.test(m.text()) && problems.push(m.text()));
    p.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  };
  let failed = false;
  try {
    // ---- 1. The website ----
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const site = await ctx.newPage();
    watch(site);
    await site.goto(`${ORIGIN}/`);
    await site.locator("#signin").waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await site.locator("#home").isHidden(), true, "no documents before signing in");
    await site.screenshot({ path: path.join(shots, "auth-1-signin.png") });
    console.log("ok  signed out, the site shows a sign-in screen and no documents");

    await site.locator("#signin-btn").click();
    await site.locator("#home").waitFor({ state: "visible", timeout: 10000 });
    await site.locator(".doc-card", { hasText: "Weekend at the lake" }).waitFor();
    assert.equal(new URL(site.url()).origin, ORIGIN);
    console.log("ok  Sign in goes to the provider and comes back to the documents");

    await site.locator("#new-blank").click();
    await site.locator("#editor-screen").waitFor({ state: "visible" });
    await site.keyboard.type("Private notes", { delay: 15 });
    await site.keyboard.press("Enter");
    await site.keyboard.type("Only signed-in people see this.", { delay: 15 });
    await sleep(1800);
    const docs = (await call("list_documents")).structuredContent.documents;
    const mine = docs.find((d) => d.title === "Private notes");
    assert.ok(mine, "the document was saved");
    console.log("ok  signed in, the person can write; it is saved (and Claude, signed in, sees it)");

    // the menu: connected apps (Claude is there) and sign out
    await site.locator("#menu-btn").click();
    await site.locator(".menu-item", { hasText: "Connected apps" }).click();
    await site.locator(".apps-name", { hasText: "Claude (test)" }).waitFor({ timeout: 5000 });
    await site.screenshot({ path: path.join(shots, "auth-2-apps.png") });
    console.log("ok  the menu lists connected apps, with Claude in it");
    await site.locator(".apps-panel button[aria-label='Close connected apps']").click();

    // sign out from the editor: back to the sign-in screen; an old page can't keep working
    await site.locator("#menu-btn").click();
    await site.locator(".menu-item", { hasText: "Sign out" }).click();
    await site.locator("#signin").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await site.locator("#editor-screen").isHidden(), true);
    const after = await site.evaluate(() => fetch("/api/docs").then((r) => r.status));
    assert.equal(after, 401);
    console.log("ok  Sign out returns to the sign-in screen, and the API refuses the old page");

    // signing in again returns to where the person was
    await site.goto(`${ORIGIN}/#/d/${mine.id}`);
    await site.locator("#signin-btn").click();
    await site.locator("#editor").getByText("Only signed-in people see this.").waitFor({ timeout: 10000 });
    console.log("ok  signing in from a document's link comes back to that document");

    // ---- 2. The MCP App view in a host, starting with a token it can't use ----
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    watch(page);
    await page.goto(`${HOST}/`);
    await page.waitForFunction(() => window.__ready);
    const frame = page.frameLocator("#app");
    await page.evaluate(() => window.__openApp({}));
    await frame.locator(".doc-card", { hasText: "Private notes" }).waitFor({ timeout: 10000 });
    assert.ok(viewTokenCalls.length >= 2, `the view got a token through the host, and renewed the one that didn't work (${viewTokenCalls.length} calls)`);
    assert.equal(await frame.locator("#signin").isHidden(), true);
    console.log("ok  the view gets its token through the host, renews one the server refuses, and shows the documents");

    await frame.locator(".doc-open", { hasText: "Private notes" }).click();
    await frame.locator("#editor").getByText("Only signed-in people see this.").waitFor({ timeout: 8000 });
    await call("replace_text", { document_id: mine.id, block: 1, text: "Claude edited this, signed in." });
    await frame.locator("#editor").getByText("Claude edited this, signed in.").waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(shots, "auth-3-view.png") });
    console.log("ok  in the view, Claude's edits show up live with sign-in on");

    // the menu inside a host has no account items (the host's connection is the sign-in)
    await frame.locator("#menu-btn").click();
    assert.equal(await frame.locator(".menu-item", { hasText: "Sign out" }).count(), 0);
    await page.keyboard.press("Escape");

    assert.deepEqual(problems, [], "no console errors: " + problems.join(" | "));
    console.log("ok  no console errors");
  } catch (e) {
    failed = true;
    console.error("FAIL", e);
  } finally {
    await browser.close();
    host.close();
    await client.close();
    server.kill();
    await idp.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
