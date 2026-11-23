// The menu in the app bar: the agent panel toggle, "Add to Claude", and a debug panel that shows what
// the page is doing (connection, document, sync, host) and a log of recent events.
//
// Everything is put on the page as text (textContent); nothing here builds HTML from data.

import { note, list, clear, subscribe, formatReport, claudeInstallLink, reachableFromClaude } from "./debuglog.js";

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * options: {
 *   button,                     the app bar button that opens the menu
 *   embedded,                   true inside Claude: no "Add to Claude" there, it is already there
 *   connectorUrl,               this site's MCP endpoint, for Add to Claude
 *   getInfo(),                  { section: { label: value } } for the panel and the copied report
 *   rail: { available(), isOpen(), toggle() },   the agent panel
 *   ping(),                     async: resolves when the server answered
 *   pullNow(),                  ask the sync for changes now
 *   say(text),                  a short message at the bottom of the page
 *   account: { user(), apps(), signOut() }   optional: when the server has sign-in on and someone is signed in
 * }
 */
export function mountMenu(options) {
  const { button, embedded, connectorUrl, getInfo, rail, ping, pullNow, say, account } = options;
  let menu = null;
  let panel = null;
  let stopLog = null;
  let tick = null;

  /* --------------------------------- the menu --------------------------------- */

  const closeMenu = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
  };
  const outside = (e) => {
    if (menu && !menu.contains(e.target) && !button.contains(e.target)) closeMenu();
  };
  const keys = (e) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll("button:not([aria-disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      closeMenu();
      button.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") closeMenu();
  };

  function openMenu() {
    closeMenu();
    menu = h("div", "menu menu-main");
    menu.setAttribute("role", "menu");
    button.setAttribute("aria-expanded", "true");
    const add = (label, run, { hint, checked } = {}) => {
      const b = h("button", "menu-item", label);
      b.type = "button";
      b.setAttribute("role", checked == null ? "menuitem" : "menuitemcheckbox");
      if (checked != null) b.setAttribute("aria-checked", String(checked));
      if (hint) b.append(h("span", "menu-hint", hint));
      b.addEventListener("click", () => {
        closeMenu();
        run();
      });
      menu.append(b);
    };
    const sep = () => menu.append(h("div", "menu-sep"));

    if (rail.available()) {
      add("Side panel", rail.toggle, { checked: rail.isOpen(), hint: rail.isOpen() ? "On" : "Off" });
      sep();
    }
    if (!embedded) {
      add("Add to Claude", addToClaude);
      add("Copy connector URL", copyConnector);
      add("Help", () => window.open("/help", "_blank", "noopener"));
      add("Privacy", () => window.open("/privacy", "_blank", "noopener"));
      sep();
    }
    add("Debug info", openPanel);
    add("Copy diagnostics", copyReport);
    const user = account?.user();
    if (user) {
      sep();
      add("Connected apps", account.apps);
      add("Sign out", account.signOut, { hint: user.name.length > 18 ? user.name.slice(0, 17) + "…" : user.name });
    }

    document.body.append(menu);
    const r = button.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 4 + scrollY)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + scrollX)}px`;
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys, true);
    menu.querySelector("button").focus();
  }

  button.addEventListener("click", () => (menu ? closeMenu() : openMenu()));

  /* ------------------------------- Add to Claude ------------------------------- */

  function addToClaude() {
    if (!reachableFromClaude(connectorUrl)) return say("Claude can only reach an https address. Open the public site to add it.");
    note("app", "Opened the Add to Claude link");
    window.open(claudeInstallLink(connectorUrl), "_blank", "noopener");
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      say(done);
    } catch {
      say("The browser did not allow copying. Select the text and copy it yourself.");
    }
  }
  const copyConnector = () => copyText(connectorUrl, "Connector URL copied.");
  const copyReport = () => copyText(formatReport(getInfo()), "Diagnostics copied.");

  /* ------------------------------- the debug panel ------------------------------- */

  function closePanel() {
    clearInterval(tick);
    stopLog?.();
    panel?.remove();
    panel = null;
    stopLog = null;
  }

  function openPanel() {
    if (panel) return;
    panel = h("section", "debug");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Debug info");

    const head = h("div", "debug-head");
    head.append(h("h2", "debug-title", "Debug"));
    const grow = h("span", "grow");
    const close = h("button", "tool tool-sm", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close debug info");
    close.addEventListener("click", closePanel);
    head.append(grow, close);

    const body = h("div", "debug-body");
    const facts = h("div", "debug-facts");

    // actions
    const actions = h("div", "debug-actions");
    const act = (label, run) => {
      const b = h("button", "polr-btn polr-btn--secondary btn-sm", label);
      b.type = "button";
      b.addEventListener("click", run);
      actions.append(b);
    };
    act("Test server", async () => {
      const t0 = performance.now();
      try {
        await ping();
        say(`Server answered in ${Math.round(performance.now() - t0)} ms.`);
      } catch (e) {
        say(`Server did not answer: ${e.message}`);
      }
      draw();
    });
    act("Pull now", async () => {
      await pullNow?.();
      draw();
    });
    act("Copy report", copyReport);
    act("Clear log", clear);

    const log = h("ol", "debug-log");
    log.setAttribute("aria-label", "Recent events");
    body.prepend(facts);
    body.append(actions, h("h3", "debug-sub", "Log"), log);
    panel.append(head, body);
    document.body.append(panel);

    function draw() {
      if (!panel) return;
      const info = getInfo();
      facts.replaceChildren();
      for (const [section, rows] of Object.entries(info)) {
        facts.append(h("h3", "debug-sub", section));
        const dl = h("dl", "debug-dl");
        for (const [k, v] of Object.entries(rows)) {
          dl.append(h("dt", null, k), h("dd", null, String(v)));
        }
        facts.append(dl);
      }
    }
    const line = (e) => {
      const li = h("li", "debug-line debug-" + e.kind);
      li.append(h("span", "debug-time", new Date(e.at).toISOString().slice(11, 19)), h("span", "debug-kind", e.kind), h("span", "debug-text", e.text));
      return li;
    };
    const fill = () => log.replaceChildren(...list().slice(-80).reverse().map(line));
    fill();
    stopLog = subscribe((e) => (e ? log.prepend(line(e)) : fill()));
    draw();
    tick = setInterval(draw, 1000);
    close.focus();
  }

  // Ctrl+Shift+D (or Cmd+Shift+D) opens the panel from the keyboard.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      panel ? closePanel() : openPanel();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel && !menu) closePanel();
  });

  return { closeMenu, openPanel, closePanel };
}
