// The home screen: start a document, find one, and manage them (rename, copy, remove).
// Everything a person wrote (titles, snippets) goes on the page as text, never as markup.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export const displayName = (d) => d.title || "Untitled document";

/** Does a document match what was typed in the search box? */
export function matches(d, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return displayName(d).toLowerCase().includes(needle) || d.lines.some((l) => l.text.toLowerCase().includes(needle));
}

/**
 * Draws the document grid or list into `root` and wires its actions.
 * actions: open(id), rename(id, title), copy(id), remove(id). The caller re-renders after a change.
 */
export function renderDocs(root, { docs, query = "", view = "grid", actions }) {
  closeMenu();
  root.replaceChildren();
  root.classList.toggle("as-list", view === "list");
  const shown = docs.filter((d) => matches(d, query));
  if (!docs.length) {
    root.append(el("p", "caption docs-empty", "No documents yet. Start a blank one above."));
    return;
  }
  if (!shown.length) {
    root.append(el("p", "caption docs-empty", `No documents match "${query.trim()}".`));
    return;
  }
  for (const d of shown) root.append(card(d, actions));
}

function card(d, actions) {
  const item = el("article", "doc-card");
  item.dataset.id = d.id;

  const open = el("a", "doc-open");
  open.href = `#/d/${d.id}`;
  open.setAttribute("aria-label", `Open ${displayName(d)}`);
  const thumb = el("div", "doc-thumb");
  thumb.setAttribute("aria-hidden", "true");
  const page = el("div", "doc-thumb-page");
  if (d.title) page.append(el("div", "t-title", d.title));
  for (const l of d.lines) page.append(el("div", "t-" + l.type, l.type === "item" ? "• " + l.text : l.text));
  thumb.append(page);
  open.append(thumb);

  const foot = el("div", "doc-foot");
  const ico = el("span", "doc-ico");
  ico.setAttribute("aria-hidden", "true");
  ico.append(svgDoc());
  const text = el("div", "doc-meta");
  const name = el("span", "doc-name", displayName(d));
  name.title = displayName(d);
  text.append(name, el("span", "caption", `Edited ${ago(d.updated)}`));
  const more = el("button", "tool doc-more");
  more.type = "button";
  more.setAttribute("aria-label", `More actions for ${displayName(d)}`);
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.append(svgDots());
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(more, d, item, actions);
  });
  foot.append(ico, text, more);

  item.append(open, foot);
  return item;
}

/* ------------------------------- the actions menu ------------------------------- */

let menu = null;
let menuOwner = null;

export function closeMenu() {
  if (!menu) return;
  menu.remove();
  menuOwner?.setAttribute("aria-expanded", "false");
  menu = null;
  menuOwner = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", menuKeys, true);
}
const outside = (e) => {
  if (menu && !menu.contains(e.target) && e.target !== menuOwner && !menuOwner?.contains(e.target)) closeMenu();
};
const menuKeys = (e) => {
  if (!menu) return;
  const items = [...menu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    const back = menuOwner;
    closeMenu();
    back?.focus();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    items[(i + 1) % items.length].focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    items[(i - 1 + items.length) % items.length].focus();
  } else if (e.key === "Tab") closeMenu();
};

function toggleMenu(button, d, item, actions) {
  if (menuOwner === button) return closeMenu();
  closeMenu();
  menu = el("div", "menu");
  menu.setAttribute("role", "menu");
  menuOwner = button;
  button.setAttribute("aria-expanded", "true");
  const entries = [
    ["Open", () => actions.open(d.id)],
    ["Rename", () => startRename(item, d, actions)],
    ["Make a copy", () => actions.copy(d.id)],
    ["Remove", () => actions.remove(d.id), "danger"],
  ];
  for (const [label, run, cls] of entries) {
    const b = el("button", "menu-item" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      closeMenu();
      run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = button.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${Math.round(r.bottom + 4 + scrollY)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + scrollX)}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", menuKeys, true);
  menu.querySelector("button").focus();
}

/** Rename in place: Enter or leaving the box saves, Escape cancels. */
function startRename(item, d, actions) {
  const name = item.querySelector(".doc-name");
  const input = el("input", "doc-rename");
  input.type = "text";
  input.value = d.title;
  input.placeholder = "Untitled document";
  input.maxLength = 200;
  input.setAttribute("aria-label", "Document name");
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== d.title) actions.rename(d.id, input.value);
    else input.replaceWith(name);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

/* ----------------------------------- icons ----------------------------------- */

function svg(inner, size = 18) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.5");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  for (const d of inner) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}
const svgDoc = () => svg(["M7 3h7l5 5v13H7z", "M14 3v5h5M10 13h6M10 17h6"]);
const svgDots = () => svg(["M12 6.5h.01M12 12h.01M12 17.5h.01"], 20);
