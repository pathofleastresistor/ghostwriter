// A small in-memory log for the debug menu: what the page did (API calls, host events) and what
// went wrong (errors, warnings). Nothing here leaves the page. Nothing talks to the network.
//

const MAX = 200;
const entries = [];
const subs = new Set();
let captured = false;

/** Add a line. kind is a short label: "api", "host", "error", "warn", "sync", "app". */
export function note(kind, text) {
  const e = { at: Date.now(), kind, text: String(text ?? "").slice(0, 400) };
  entries.push(e);
  if (entries.length > MAX) entries.shift();
  for (const fn of subs) fn(e);
  return e;
}

export const list = () => entries.slice();
export const clear = () => {
  entries.length = 0;
  for (const fn of subs) fn(null);
};
/** Call fn for every new line (and with null when the log is cleared). Returns a function that stops it. */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Start recording uncaught errors and console warnings/errors. Safe to call more than once. */
export function captureErrors() {
  if (captured || typeof window === "undefined") return;
  captured = true;
  window.addEventListener("error", (e) => note("error", `${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => note("error", `Unhandled: ${e.reason?.message ?? e.reason}`));
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      note(level === "error" ? "error" : "warn", args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : safeJson(a))).join(" "));
      original(...args);
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The link that opens Claude's "Add custom connector" dialog with the name and URL filled in. */
export function claudeInstallLink(connectorUrl, name = "Ghostwriter") {
  const q = new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl });
  // URLSearchParams writes spaces as "+"; Claude's docs show percent-encoding.
  return "https://claude.ai/customize/connectors?" + q.toString().replace(/\+/g, "%20");
}

/** The MCP endpoint of a site: its origin plus /mcp. */
export const connectorUrl = (origin) => String(origin).replace(/\/+$/, "") + "/mcp";

/** Claude's servers must reach it, so it has to be https (a local address will not work). */
export const reachableFromClaude = (url) => /^https:\/\//.test(url);

const time = (t) => new Date(t).toISOString().slice(11, 23);

/** The plain-text report the menu copies. info is { section: { label: value } }. */
export function formatReport(info, lines = entries) {
  const out = ["Ghostwriter diagnostics", new Date().toISOString(), ""];
  for (const [section, rows] of Object.entries(info)) {
    out.push(`[${section}]`);
    for (const [k, v] of Object.entries(rows)) out.push(`${k}: ${v}`);
    out.push("");
  }
  out.push(`[log: last ${Math.min(lines.length, 60)} of ${lines.length}]`);
  for (const l of lines.slice(-60)) out.push(`${time(l.at)} ${l.kind.padEnd(5)} ${l.text}`);
  return out.join("\n");
}
