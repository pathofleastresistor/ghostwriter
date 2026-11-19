import { note } from "./debuglog.js";
// The only file that talks to the network, and only to this site's own /api (the documents saved
// on the server). A lint test (evals/tests/surface-lint.test.js) holds it to that: no other file
// may fetch, and every fetch here is BASE + "/api" + a path. BASE is empty on the site itself. When
// the page is shown inside an MCP host (Claude), the server's view HTML sets
// window.__GHOSTWRITER__.origin to this site's own origin, because the page is then served from
// the host's sandbox and a relative path would point at the wrong place.
//
// Sign-in (optional, server side): on the website the session cookie goes with each same-origin
// request on its own. Inside a host, cookies don't reach the sandbox, so the view sends a short-lived
// token instead, which it gets from the server through the host (setTokenSource, host.js). The first
// request waits for that, briefly.
const BASE = (typeof window !== "undefined" && window.__GHOSTWRITER__?.origin) || "";
const NEEDS_TOKEN = typeof window !== "undefined" && !!window.__GHOSTWRITER__?.embedded && !!window.__GHOSTWRITER__?.auth;
let token = null;
let tokenSource = null; // async () => a fresh token, or null
let refreshing = null;
let sourceReady;
const sourceSet = new Promise((r) => (sourceReady = r));

/** Inside a host: where to get a token, at first and whenever the one we have is refused. */
export function setTokenSource(fn) {
  tokenSource = fn;
  sourceReady();
}

/** Inside a host with sign-in on: a token before the first request (or give up after a while). */
async function firstToken() {
  if (!NEEDS_TOKEN || token) return;
  await Promise.race([sourceSet, new Promise((r) => setTimeout(r, 8000))]);
  if (!token) await freshToken();
}

async function freshToken() {
  if (!tokenSource) return null;
  // One refresh at a time, however many requests were refused together.
  refreshing ??= tokenSource()
    .then((t) => (token = t || null))
    .catch(() => null)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

/** options.onUnauthorized(): called when the server says the person needs to sign in. */
export function createApi({ onUnauthorized } = {}) {
  return async function api(method, url, body) {
    const json = body ? JSON.stringify(body) : undefined;
    const t0 = performance.now();
    const send = async () => {
      const headers = body ? { "Content-Type": "application/json" } : {};
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        return await fetch(BASE + "/api" + url, {
          method,
          headers,
          body: json,
          keepalive: !!json && json.length < 60000, // lets a save sent as the page closes finish
        });
      } catch (e) {
        note("api", `${method} ${url} failed: ${e.message}`);
        throw e;
      }
    };
    await firstToken();
    let r = await send();
    if (r.status === 401 && tokenSource && (await freshToken())) r = await send();
    // Routine polling is left out of the log unless it fails or changes something.
    const polling = method === "GET" && /\/pull\?/.test(url);
    if (!r.ok || !polling) note("api", `${method} ${url.split("?")[0]} ${r.status} ${Math.round(performance.now() - t0)} ms`);
    if (r.status === 401) onUnauthorized?.();
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).message ?? "The request failed."), { notFound: r.status === 404, unauthorized: r.status === 401 });
    return r.json();
  };
}
