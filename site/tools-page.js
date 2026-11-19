// A review page for an app's WebMCP tools, built from the same definitions the app registers, so
// it always matches what an agent sees. No dependencies; one copy of this file lives in each app.
//
//   mountToolsPage(root, { app, url, summary, availability, boundaries, tools })
//
// `tools` are the objects handed to navigator.modelContext: name, title, description, inputSchema,
// annotations. Functions on them (run, execute) are ignored.

const CSS = `
.tp{--tp-ink:var(--ink,#16181d);--tp-muted:var(--ink-muted,#5b6270);--tp-line:var(--line,#e3e5ea);--tp-line2:var(--line-strong,#c9ccd4);
--tp-sunken:var(--sunken,#f1f2f5);--tp-surface:var(--surface,#fff);--tp-link:var(--violet-text,#4b32c3);
--tp-good-bg:var(--good-soft,#e1f5ea);--tp-good:var(--good-text,#12683c);--tp-bad-bg:var(--danger-soft,#fde6e4);--tp-bad:var(--danger-text,#9a1f15);
--tp-info-bg:var(--violet-soft,#ece8ff);--tp-info:var(--violet-text,#4b32c3);--tp-warn-bg:var(--amber,#ffd166);--tp-warn:var(--on-amber,#3a2a00);
--tp-mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
max-width:960px;margin:0 auto;display:grid;gap:36px;color:var(--tp-ink);font:400 15px/22px var(--font-sans,system-ui,-apple-system,sans-serif);text-align:left}
.tp *{box-sizing:border-box}
.tp h1,.tp h2,.tp h3,.tp p{margin:0}
.tp a{color:var(--tp-link)}
.tp-eyebrow{font:500 11px/16px var(--tp-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--tp-muted)}
.tp-head{display:grid;gap:12px}
.tp h1{font:700 40px/44px var(--font-display,var(--font-sans,system-ui,sans-serif));letter-spacing:-.02em}
.tp-lead{font-size:17px;line-height:26px;max-width:68ch}
.tp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tp-btn{font:600 13px/18px var(--font-sans,system-ui,sans-serif);height:32px;padding:0 14px;border-radius:999px;border:1.5px solid var(--tp-line2);background:var(--tp-surface);color:var(--tp-ink);cursor:pointer}
.tp-btn:hover{background:var(--tp-sunken)}
.tp-btn:focus-visible,.tp summary:focus-visible,.tp a:focus-visible{outline:2px solid var(--focus,#4b32c3);outline-offset:2px}
.tp-chip{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;background:var(--tp-sunken);color:var(--tp-ink);font:600 12px/16px var(--font-sans,system-ui,sans-serif);white-space:nowrap}
.tp-chip.ro{background:var(--tp-good-bg);color:var(--tp-good)}
.tp-chip.rw{background:var(--tp-info-bg);color:var(--tp-info)}
.tp-chip.bad{background:var(--tp-bad-bg);color:var(--tp-bad)}
.tp-chip.warn{background:var(--tp-warn-bg);color:var(--tp-warn)}
.tp-chip.plain{background:transparent;box-shadow:inset 0 0 0 1px var(--tp-line2);color:var(--tp-muted)}
.tp-facts .tp-chip{height:26px;padding:0 12px;font-size:13px}
.tp-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.tp-card{border:1px solid var(--tp-line);border-radius:16px;background:var(--tp-surface);padding:20px;display:grid;gap:10px;align-content:start}
.tp-card h2{font:700 17px/24px var(--font-display,var(--font-sans,system-ui,sans-serif))}
.tp-card ul{margin:0;padding-left:20px;display:grid;gap:6px}
.tp-section{display:grid;gap:14px}
.tp-section>h2{font:700 24px/30px var(--font-display,var(--font-sans,system-ui,sans-serif));letter-spacing:-.01em}
.tp-table{width:100%;border-collapse:collapse;border:1px solid var(--tp-line);border-radius:16px;overflow:hidden;background:var(--tp-surface);font-size:14px;line-height:20px}
.tp-table th{font:500 11px/16px var(--tp-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--tp-muted);text-align:left;padding:10px 14px;background:var(--tp-sunken)}
.tp-table td{padding:10px 14px;border-top:1px solid var(--tp-line);vertical-align:top}
.tp-table td:first-child{white-space:nowrap}
.tp-code{font:500 13px/18px var(--tp-mono)}
.tp-muted{color:var(--tp-muted)}
.tp-tool{border:1px solid var(--tp-line);border-radius:16px;background:var(--tp-surface);padding:22px;display:grid;gap:14px;scroll-margin-top:72px}
.tp-tool-head{display:grid;gap:6px}
.tp-tool h3{font:600 18px/26px var(--tp-mono);word-break:break-word}
.tp-title{font:600 15px/22px var(--font-sans,system-ui,sans-serif);color:var(--tp-muted)}
.tp-desc{max-width:78ch}
.tp-h{font:500 11px/16px var(--tp-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--tp-muted)}
.tp-params{display:grid;border:1px solid var(--tp-line);border-radius:12px;overflow:hidden}
.tp-param{display:grid;grid-template-columns:minmax(150px,230px) 1fr;gap:6px 18px;padding:10px 14px;border-top:1px solid var(--tp-line)}
.tp-param:first-child{border-top:0}
.tp-pname{display:grid;gap:2px;align-content:start;min-width:0;word-break:break-word}
.tp-pname .tp-code{color:var(--tp-ink)}
.tp-ptype{font:400 12px/16px var(--tp-mono);color:var(--tp-muted)}
.tp-req{font:600 11px/16px var(--font-sans,system-ui,sans-serif);color:var(--tp-bad)}
.tp-opt{font:400 11px/16px var(--font-sans,system-ui,sans-serif);color:var(--tp-muted)}
.tp-none{padding:10px 14px;border:1px dashed var(--tp-line2);border-radius:12px;color:var(--tp-muted)}
.tp details>summary{cursor:pointer;color:var(--tp-link);font-size:13px}
.tp pre{margin:8px 0 0;padding:12px;border-radius:12px;background:var(--tp-sunken);overflow:auto;max-height:340px;font:500 12px/17px var(--tp-mono);white-space:pre-wrap;word-break:break-word}
.tp-foot{color:var(--tp-muted);font-size:13px;line-height:19px;border-top:1px solid var(--tp-line);padding-top:16px}
@media(max-width:640px){.tp h1{font-size:30px;line-height:34px}.tp-param{grid-template-columns:1fr}.tp-table .tp-col-in,.tp-table .tp-col-do{display:none}.tp-tool{padding:16px}}
@media print{.tp-actions{display:none!important}.tp-tool,.tp-card{break-inside:avoid}.tp pre{max-height:none}.tp details:not([open])>*:not(summary){display:block}}
`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A schema as a short phrase: "integer, 1 to 3", "array of string, up to 4", "one of: a, b". */
export function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return `one of: ${s.enum.map(String).join(", ")}`;
  const alt = s.anyOf || s.oneOf;
  if (alt) return alt.map(typeOf).join(" or ");
  const t = Array.isArray(s.type) ? s.type.join(" or ") : s.type || "any";
  const bits = [];
  if (t.includes("array")) {
    bits.push(`array of ${s.items ? typeOf(s.items) : "any"}`);
    if (s.minItems != null || s.maxItems != null) bits.push(s.minItems != null && s.maxItems != null ? `${s.minItems} to ${s.maxItems} items` : s.maxItems != null ? `up to ${s.maxItems}` : `at least ${s.minItems}`);
    return bits.join(", ");
  }
  bits.push(t);
  if (s.minimum != null || s.maximum != null) bits.push(s.minimum != null && s.maximum != null ? `${s.minimum} to ${s.maximum}` : s.maximum != null ? `up to ${s.maximum}` : `at least ${s.minimum}`);
  if (s.maxLength != null) bits.push(`up to ${s.maxLength} characters`);
  if (s.additionalProperties && typeof s.additionalProperties === "object" && !s.properties) bits.push(`free-form keys of ${typeOf(s.additionalProperties)}`);
  return bits.join(", ");
}

/** Flatten an input schema into rows, with nested fields as dotted paths: choices[].section */
export function flatten(schema, prefix = "", depth = 0, out = []) {
  const props = schema && schema.properties;
  if (!props) return out;
  const required = new Set(schema.required || []);
  for (const [key, s] of Object.entries(props)) {
    const path = prefix + key;
    out.push({ path, depth, type: typeOf(s), required: required.has(key), description: (s && s.description) || "" });
    if (depth < 3) {
      if (s && s.properties) flatten(s, `${path}.`, depth + 1, out);
      else if (s && s.type === "array" && s.items && s.items.properties) flatten(s.items, `${path}[].`, depth + 1, out);
    }
  }
  return out;
}

/** What the tool says about itself. Missing is shown as missing, never guessed. */
export function accessOf(t) {
  const a = (t && t.annotations) || {};
  const chips = [];
  if (a.readOnlyHint === true) chips.push(["Read only", "ro"]);
  else if (a.readOnlyHint === false) chips.push(["Changes things", "rw"]);
  else chips.push(["Not declared", "warn"]);
  if (a.consequentialHint === true) chips.push(["Consequential", "bad"]);
  if (a.destructiveHint === true) chips.push(["Destructive", "bad"]);
  if (a.untrustedContentHint === true) chips.push(["Returns untrusted text", "plain"]);
  if (a.idempotentHint === true) chips.push(["Idempotent", "plain"]);
  return { kind: a.readOnlyHint === true ? "ro" : a.readOnlyHint === false ? "rw" : "nd", chips };
}

/** The tool's own title, or the first sentence of its description when it has none. */
export function whatItDoes(t) {
  if (t.title) return t.title;
  const first = String(t.description || "").split(/(?<=[.!?])\s/)[0];
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}...` : first;
}

const chipHtml = ([label, kind]) => `<span class="tp-chip ${kind}">${esc(label)}</span>`;
const slug = (n) => `tool-${String(n).replace(/[^a-z0-9_-]/gi, "-")}`;

/** The tool as JSON for export: only what an agent is given. */
export function toolJson(t) {
  return { name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema };
}
export const manifestJson = (m) => ({ app: m.app, url: m.url, summary: m.summary, availability: m.availability, boundaries: m.boundaries || [], generatedAt: new Date().toISOString(), tools: m.tools.map(toolJson) });

function inputsLabel(rows) {
  const top = rows.filter((r) => r.depth === 0);
  if (!top.length) return "None";
  const req = top.filter((r) => r.required).length;
  return req ? `${req} required${top.length > req ? `, ${top.length - req} optional` : ""}` : `${plural(top.length, "optional input")}`;
}

function toolHtml(t) {
  const rows = flatten(t.inputSchema);
  const { chips } = accessOf(t);
  const params = rows.length
    ? `<div class="tp-params">${rows
        .map(
          (r) => `<div class="tp-param"><div class="tp-pname" style="padding-left:${r.depth * 14}px"><span class="tp-code">${esc(r.path.split(".").pop())}</span><span class="tp-ptype">${esc(r.type)}</span>${r.depth === 0 ? (r.required ? '<span class="tp-req">Required</span>' : '<span class="tp-opt">Optional</span>') : ""}</div><div>${esc(r.description) || '<span class="tp-muted">No description.</span>'}</div></div>`,
        )
        .join("")}</div>`
    : '<div class="tp-none">Takes no inputs.</div>';
  return `<article class="tp-tool" id="${slug(t.name)}">
  <div class="tp-tool-head"><h3>${esc(t.name)}</h3>${t.title ? `<div class="tp-title">${esc(t.title)}</div>` : ""}<div class="tp-row">${chips.map(chipHtml).join("")}</div></div>
  <p class="tp-desc">${esc(t.description)}</p>
  <div class="tp-h">Inputs</div>${params}
  <details><summary>Raw definition</summary><pre>${esc(JSON.stringify(toolJson(t), null, 2))}</pre></details>
</article>`;
}

export function pageHtml(m) {
  const tools = m.tools || [];
  const access = tools.map(accessOf);
  const ro = access.filter((a) => a.kind === "ro").length;
  const rw = access.filter((a) => a.kind === "rw").length;
  const nd = access.length - ro - rw;
  const host = m.url ? m.url.replace(/^https?:\/\//, "") : "";
  const glance = tools
    .map((t, i) => {
      const rows = flatten(t.inputSchema);
      return `<tr><td><a class="tp-code" href="#${slug(t.name)}">${esc(t.name)}</a></td><td class="tp-col-do">${esc(whatItDoes(t))}</td><td>${access[i].chips.map(chipHtml).join(" ")}</td><td class="tp-col-in tp-muted">${esc(inputsLabel(rows))}</td></tr>`;
    })
    .join("");
  return `<div class="tp">
<header class="tp-head">
  <div class="tp-eyebrow">Agent tools${host ? ` · ${esc(host)}` : ""}</div>
  <h1>${esc(m.app)}: what an agent can do here</h1>
  ${m.summary ? `<p class="tp-lead">${esc(m.summary)}</p>` : ""}
  <div class="tp-row tp-facts"><span class="tp-chip">${plural(tools.length, "tool")}</span><span class="tp-chip ro">${ro} read only</span>${rw ? `<span class="tp-chip rw">${rw} change things</span>` : ""}${nd ? `<span class="tp-chip warn">${nd} not declared</span>` : ""}</div>
  <div class="tp-row tp-actions"><button class="tp-btn" type="button" data-tp="copy">Copy as JSON</button><button class="tp-btn" type="button" data-tp="download">Download JSON</button><button class="tp-btn" type="button" data-tp="print">Print</button></div>
</header>
<div class="tp-two">
  <section class="tp-card"><h2>When the tools exist</h2><p>${esc(m.availability || "While the page is open.")} They are registered with WebMCP (<span class="tp-code">navigator.modelContext</span>) by the page itself, and they go away when the person leaves it. Nothing here is reachable from outside the browser.</p></section>
  ${(m.boundaries || []).length ? `<section class="tp-card"><h2>What the agent can't do</h2><ul>${m.boundaries.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></section>` : ""}
</div>
<section class="tp-section"><h2>At a glance</h2>
  <table class="tp-table"><thead><tr><th>Tool</th><th class="tp-col-do">What it does</th><th>Access</th><th class="tp-col-in">Inputs</th></tr></thead><tbody>${glance}</tbody></table>
  ${nd ? `<p class="tp-muted">“Not declared” means the tool sets no <span class="tp-code">readOnlyHint</span>, so an agent can't tell whether it changes anything. Worth deciding per tool.</p>` : ""}
</section>
<section class="tp-section"><h2>Tools</h2>${tools.map(toolHtml).join("")}</section>
<footer class="tp-foot">Generated from the tool definitions this page registers, so it matches what an agent sees. Descriptions are written for agents, not for people, and are shown as given.${m.url ? ` · <a href="${esc(m.url)}">${esc(host)}</a>` : ""}</footer>
</div>`;
}

let styled = false;
function injectStyle() {
  if (styled || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.setAttribute("data-tools-page", "");
  el.textContent = CSS;
  document.head.appendChild(el);
  styled = true;
}

/** Render into `root`. Returns a function that removes it again. */
export function mountToolsPage(root, m) {
  injectStyle();
  const title = document.title;
  document.title = `Agent tools · ${m.app}`;
  root.innerHTML = pageHtml(m);
  const json = () => JSON.stringify(manifestJson(m), null, 2);
  const onClick = async (e) => {
    const b = e.target.closest && e.target.closest("[data-tp]");
    if (!b) return;
    const act = b.getAttribute("data-tp");
    if (act === "print") window.print();
    else if (act === "copy") {
      try {
        await navigator.clipboard.writeText(json());
        b.textContent = "Copied";
      } catch {
        b.textContent = "Copy blocked";
      }
      setTimeout(() => (b.textContent = "Copy as JSON"), 1800);
    } else if (act === "download") {
      const url = URL.createObjectURL(new Blob([json()], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${String(m.app).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-tools.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };
  root.addEventListener("click", onClick);
  // A link to #tool-name should land on that tool, also when the page is opened with the hash.
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView());
  return () => {
    root.removeEventListener("click", onClick);
    root.innerHTML = "";
    document.title = title;
  };
}
