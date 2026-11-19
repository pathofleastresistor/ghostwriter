// The person's account, when the server has sign-in on: the apps they connected (Claude, ChatGPT...)
// with a way to disconnect each, from the app bar menu. Everything goes on the page as text.

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const when = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never");

/** options: { api, say(text) }. Opens the panel; returns a function that closes it. */
export function openApps({ api, say }) {
  document.querySelector(".apps-panel")?.remove();
  const panel = h("section", "debug apps-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Connected apps");
  const head = h("div", "debug-head");
  const close = h("button", "tool tool-sm", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close connected apps");
  head.append(h("h2", "debug-title", "Connected apps"), h("span", "grow"), close);
  const body = h("div", "debug-body");
  const intro = h("p", "caption apps-intro", "Apps you allowed to use Ghostwriter as you. Disconnecting one signs it out at once; it can ask again later.");
  const list = h("ul", "apps-list");
  body.append(intro, list);
  panel.append(head, body);
  document.body.append(panel);

  const done = () => {
    panel.remove();
    removeEventListener("keydown", esc);
  };
  const esc = (e) => e.key === "Escape" && done();
  addEventListener("keydown", esc);
  close.addEventListener("click", done);

  function draw(apps) {
    list.replaceChildren();
    if (!apps.length) list.append(h("li", "caption apps-empty", "No apps are connected."));
    for (const a of apps) {
      const li = h("li", "apps-item");
      const text = h("div", "apps-text");
      text.append(h("div", "apps-name", a.name), h("div", "caption", `${a.host ? a.host + " · " : ""}allowed ${when(a.approvedAt)} · last used ${when(a.lastUsed)}`));
      const b = h("button", "polr-btn polr-btn--secondary btn-sm", "Disconnect");
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          draw((await api("DELETE", `/session/apps/${encodeURIComponent(a.id)}`)).apps);
          say(`${a.name} disconnected.`);
        } catch (e) {
          b.disabled = false;
          say(e.message || "Could not disconnect it.");
        }
      });
      li.append(text, b);
      list.append(li);
    }
  }

  list.append(h("li", "caption apps-empty", "Loading…"));
  api("GET", "/session/apps")
    .then((r) => draw(r.apps))
    .catch((e) => {
      list.replaceChildren(h("li", "caption apps-empty", e.message || "Could not load the list."));
    });
  close.focus();
  return done;
}
