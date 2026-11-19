// The page shows text that people (and agents) wrote. It must only ever put that text on the page as text.
// These read the source of what ships, so a change that starts building HTML from document text fails here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "site");
const files = readdirSync(PUBLIC).filter((f) => f.endsWith(".js"));
const source = (f) => readFileSync(join(PUBLIC, f), "utf8");

/** A string that is fixed in the source: quotes or backticks, with nothing interpolated into it. */
const fixed = (expr) => /^(["'])(?:(?!\1)[^\\]|\\.)*\1$/s.test(expr.trim()) || /^`[^`$]*`$/s.test(expr.trim()) || /^`(?:[^`$\\]|\\.)*`$/s.test(expr.trim());

describe("the page never builds markup from document text", () => {
  it("only assigns fixed strings to innerHTML and outerHTML", () => {
    for (const f of files.filter((f) => f !== "tools-page.js")) {
      for (const m of source(f).matchAll(/\.(innerHTML|outerHTML)\s*=\s*([^;]+);/gs)) {
        assert.ok(fixed(m[2]), `${f}: ${m[1]} is assigned something that is not a fixed string: ${m[2].trim().slice(0, 80)}`);
      }
    }
  });

  // The tools review page builds its HTML from the app's own tool definitions, never from the document.
  // It is held to a narrower rule: the only HTML it sets is the page it builds, and it escapes what it puts in.
  it("keeps the tools review page to its one reviewed pattern", () => {
    const s = source("tools-page.js");
    const sets = [...s.matchAll(/\.(innerHTML|outerHTML)\s*=\s*([^;]+);/gs)].map((m) => m[2].trim());
    assert.deepEqual(sets.sort(), ['""', "pageHtml(m)"]);
    assert.match(s, /const esc = \(s\) => String\(s \?\? ""\)\.replace\(\/\[&<>"'\]\/g/);
    // every value that goes into a template there is escaped, or is one of the page's own pieces of markup
    const start = s.indexOf("function toolHtml");
    const body = s.slice(start, s.indexOf("export function mountToolsPage"));
    assert.ok(start > 0 && body.length > 200, "could not find the page builders");
    const bare = [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim()).filter((e) => !/^(esc\(|chips\.map\(chipHtml\)|chipHtml|rows\b|slug\(|r\.depth|access|summary)/.test(e));
    assert.deepEqual(bare.filter((e) => /\bm\.|\bt\.|\bh\./.test(e) && !/esc\(/.test(e)), [], "a value from the tool definitions is put into HTML without esc()");
  });

  it("never uses insertAdjacentHTML, document.write, eval or new Function", () => {
    for (const f of files) {
      const s = source(f);
      for (const pattern of [/insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*["']on/i, /\.srcdoc\s*=/]) {
        assert.doesNotMatch(s, pattern, `${f}: ${pattern}`);
      }
    }
  });

  it("puts document text on the page with textContent", () => {
    // The places that show text a person or an agent wrote.
    assert.match(source("view.js"), /el\.textContent = text/);
    assert.match(source("main.js"), /\.textContent = change\.label/);
  });
});

describe("what the page loads", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");

  it("runs one script, from this site, and no inline script", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /src="\/main\.js"/);
    assert.equal(scripts[0][2].trim(), "");
  });

  it("has no inline event handlers", () => {
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });

  it("only reaches out to the font host, and imports only this site's own modules", () => {
    const hosts = new Set([...html.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts].sort(), ["fonts.googleapis.com", "fonts.gstatic.com"]);
    for (const f of files) {
      for (const m of source(f).matchAll(/from\s+["']([^"']+)["']/g)) assert.match(m[1], /^\.\//, `${f} imports ${m[1]}`);
      if (f === "api.js") continue; // the one reviewed exception, held to its own rule below
      assert.doesNotMatch(source(f), /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/, `${f} talks to the network`);
    }
  });

  // Saved documents live on the server the page came from. That is the only network access, and it
  // is confined to one file that may only call a relative /api path (never another host).
  it("lets only api.js talk to the network, and only to this site's /api", () => {
    const s = source("api.js");
    const calls = [...s.matchAll(/\bfetch\s*\(([^,)]*)/g)].map((m) => m[1].trim());
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.match(c, /^BASE\s*\+\s*"\/api"\s*\+\s*\w+$/, `api.js fetches ${c}`);
    assert.doesNotMatch(s, /XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//);
    // BASE is nothing, or the origin the server's own view HTML set; never a value from anywhere else
    assert.match(s, /const BASE = \(typeof window !== "undefined" && window\.__GHOSTWRITER__\?\.origin\) \|\| "";/);
  });
});
