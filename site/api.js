import { note } from "./debuglog.js";
// The only file that talks to the network, and only to this site's own /api (the documents saved
// on the server). A lint test (evals/tests/surface-lint.test.js) holds it to that: no other file
// may fetch, and every fetch here is BASE + "/api" + a path. BASE is empty on the site itself. When
// the page is shown inside an MCP host (Claude), the server's view HTML sets
// window.__GHOSTWRITER__.origin to this site's own origin, because the page is then served from
// the host's sandbox and a relative path would point at the wrong place.
const BASE = (typeof window !== "undefined" && window.__GHOSTWRITER__?.origin) || "";

export function createApi() {
  return async function api(method, url, body) {
    const json = body ? JSON.stringify(body) : undefined;
    const t0 = performance.now();
    let r;
    try {
      r = await fetch(BASE + "/api" + url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: json,
        keepalive: !!json && json.length < 60000, // lets a save sent as the page closes finish
      });
    } catch (e) {
      note("api", `${method} ${url} failed: ${e.message}`);
      throw e;
    }
    // Routine polling is left out of the log unless it fails or changes something.
    const polling = method === "GET" && /\/pull\?/.test(url);
    if (!r.ok || !polling) note("api", `${method} ${url.split("?")[0]} ${r.status} ${Math.round(performance.now() - t0)} ms`);
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).message ?? "The request failed."), { notFound: r.status === 404 });
    return r.json();
  };
}
