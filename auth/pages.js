// The few pages sign-in shows itself: the approval page an app sends the person to, and errors.
// Rendered on the server from fixed markup; every value from a person, an app or a provider is escaped.
import { escapeHtml as e } from "./util.js";

const STYLE = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--ground, #f3f4f7); color: var(--ink, #12151c); font: 400 16px/24px var(--font-sans, system-ui, sans-serif); }
  main { box-sizing: border-box; width: min(440px, calc(100vw - 32px)); margin: 32px 0; padding: 32px; background: var(--surface, #fff); border: 1px solid var(--line, #d8dbe4); border-radius: 14px; box-shadow: var(--shadow-card); }
  .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 24px; font: 700 18px/24px var(--font-display, system-ui, sans-serif); }
  .logo { box-sizing: border-box; display: flex; align-items: flex-end; gap: 3px; width: 28px; height: 28px; padding: 5px; border-radius: 8px; background: var(--ink, #12151c); }
  .logo i { display: block; flex: 1; border-radius: 2px; background: var(--accent, #d4430a); }
  .logo i:nth-child(1) { height: 60%; }
  .logo i:nth-child(2) { height: 100%; background: var(--amber, #f2b705); }
  .logo i:nth-child(3) { height: 40%; background: var(--violet, #5b3fd1); }
  h1 { margin: 0 0 12px; font: 600 22px/28px var(--font-display, system-ui, sans-serif); overflow-wrap: anywhere; }
  p { margin: 0 0 12px; color: var(--ink-muted, #555c6e); overflow-wrap: anywhere; }
  .who { margin: 16px 0; padding: 12px 16px; border-radius: 8px; background: var(--ground, #f3f4f7); font-size: 14px; line-height: 20px; }
  .who b { color: var(--ink, #12151c); font-weight: 600; }
  .row { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; flex-wrap: wrap; }
  .row form { margin: 0; }
  button, .btn { min-height: 44px; padding: 0 20px; border-radius: 8px; font: 600 15px/20px var(--font-sans, system-ui, sans-serif); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
  .primary { border: 1px solid var(--accent, #d4430a); background: var(--accent, #d4430a); color: var(--on-accent, #fff); }
  .secondary { border: 1px solid var(--line-strong, #6b7285); background: var(--surface, #fff); color: var(--ink, #12151c); }
  button:focus-visible, .btn:focus-visible { outline: 2px solid var(--focus, #2b57e0); outline-offset: 2px; }
  code { font: 500 13px/20px var(--font-mono, monospace); }
`;

export function page(title, body) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="robots" content="noindex">
  <title>${e(title)} · Ghostwriter</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <link rel="stylesheet" href="/polr.css">
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <div class="brand"><span class="logo" aria-hidden="true"><i></i><i></i><i></i></span>Ghostwriter</div>
    ${body}
  </main>
</body>
</html>`;
}

/** Headers for every sign-in page: no framing (clickjacking), no caching, no scripts at all. */
export function pageHeaders(res) {
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  });
}

export function consentPage({ id, client, redirectUri, user, csrf }) {
  const name = client.client_name || "An app";
  let where = redirectUri;
  try {
    const u = new URL(redirectUri);
    where = u.protocol === "https:" || u.protocol === "http:" ? u.host : u.protocol.replace(/:$/, "") + " (an app on your device)";
  } catch {
    /* shown as is */
  }
  return page(
    "Allow access",
    `<h1>Allow ${e(name)} to use Ghostwriter?</h1>
    <p>It will be able to read, edit, create and remove documents in this Ghostwriter, as you.</p>
    <div class="who">Signed in as <b>${e(user.name || user.email || user.sub)}</b>${user.email && user.name !== user.email ? `<br>${e(user.email)}` : ""}<br>After you choose, you go back to <b>${e(where)}</b>.</div>
    <p>Only allow apps you added yourself. You can disconnect it later from Ghostwriter's menu.</p>
    <div class="row">
      <form method="post" action="/auth/consent/${e(id)}"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="decision" value="deny"><button class="secondary" type="submit">Cancel</button></form>
      <form method="post" action="/auth/consent/${e(id)}"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="decision" value="allow"><button class="primary" type="submit" autofocus>Allow</button></form>
    </div>`,
  );
}

export function messagePage(title, text, { link = "/", linkText = "Back to Ghostwriter" } = {}) {
  return page(title, `<h1>${e(title)}</h1><p>${e(text)}</p><div class="row"><a class="btn secondary" href="${e(link)}">${e(linkText)}</a></div>`);
}
