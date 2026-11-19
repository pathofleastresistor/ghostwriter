# Ghostwriter: notes for contributors and coding agents

A Node app (Express + the MCP SDK, no build step) that serves a document editor three ways: a **website** at `/`, an open JSON **API** at `/api`, and an **MCP server** at `/mcp` whose app (the "view" Claude or ChatGPT shows) **is the website itself**. See README.md for what it is and how to run it.

## Layout
- `server.js`: documents (`data/docs/<id>.json`, atomic writes), the HTTP routes, the MCP server, and `viewHtml()`.
- `site/`: the front end, plain ES modules served as they are. `model.js`, `tools.js` and `merge.js` are also imported by the server, so there is one copy.
- `test/`: server tests (`*.test.js`), the browser test `e2e.cjs`, and a stand-in MCP Apps host (`test/host/`).
- `evals/`: site tests (`evals/tests`), and a harness that scores a real model on editing scenarios (`evals/proposed`).

## The MCP App is a thin wrapper (do not grow it)
- `resources/read` for `ui://ghostwriter/v2/editor.html` returns `site/index.html` with its asset paths made absolute (`viewHtml()`), plus a boot script that sets `window.__GHOSTWRITER__ = {origin, embedded: true}`. The host's sandbox then loads the site's own scripts from `PUBLIC_ORIGIN` and the page calls the same `/api`. Nothing is rebuilt for the host.
- The resource declares only what it needs (`_meta.ui.csp`: `connectDomains: [origin]`, `resourceDomains: [origin, fonts]`), `prefersBorder`, and `preferredDisplayMode: "fullscreen"` (a Claude extension: open in the side panel where there is one).
- The resource URI is versioned (`/v2/`). Hosts cache a view by URI, so change it when the view's shape changes and tell people to refresh the connector's tools. Site files are served `Cache-Control: no-store` (a CDN in front otherwise keeps old code for hours). The view's boot script also sets `window.__GHOSTWRITER_BUILD__`, shown in the debug panel.
- CORS: the view runs on the host's sandbox origin, so `/api`, the site files and `/vendor/ext-apps.js` send `Access-Control-Allow-Origin: *` (all public, no credentials). `/mcp` does not.
- `site/host.js` loads only when embedded. It offers the page's tools to the assistant as `editor_*` app tools, opens the document `open_document` names, reports the open document and selection with `updateModelContext`, handles inline/side-panel layout, asks for the side panel (a new card in a host that does not need a click, or the first click otherwise), and powers the **Ask AI** button.
- **Ask AI** (`site/ask.js`) sends a message to the chat with `app.sendMessage`. Hosts differ in what they declare, so the button is offered in any host and withdrawn if a send shows `ui/message` is unsupported. It is a plain button, not a `<form>`: a host's sandbox can block form submission. Hosts may show the message for the person to allow or send, and a result with no error does not mean the person agreed.
- **Newest card wins** (`site/supersede.js`): each `open_document` call mounts another card and nothing unmounts the old ones. `open_document` stamps its result with `{createdAt, seq}`; cards elect the newest over a `BroadcastChannel`, and older cards pause (no polling, no tools, no context, no messages).
- Server tools work with or without the view. The `open_document` description tells the model to call it when the person wants the editor, not after every edit.

## Sync and merging
`site/sync.js` polls `GET /api/docs/:id/pull`, replays the assistant's tool calls locally (typewriter), and pushes the person's typing with `POST .../push` (base revision). The server keeps the last 40 revisions per document in memory and three-way merges a stale push by block id (`site/merge.js`). The client ignores a reply that arrived after the person typed again (epoch guard) and restores the cursor after a remote load.

## Commands
- `npm test`: server and site tests. `npm run evals:selftest`: the harness checks itself.
- `npm run e2e`: a real server on port 3011, the test host on 3012, the site in Chrome (set `CHROME` if Chrome is not at `/usr/bin/google-chrome`). Screenshots go to the directory you pass.
- `docker compose up -d --build`: build and run on port 3010.

## Rules
- Open on purpose: no sign-in, no secrets in the repo. Keep it that way; if auth is added it should be optional.
- Network confinement: only `site/api.js` may call `fetch` (a lint test enforces it).
- Tools never reach outside the page or server, never send, buy or publish anything, and mark document text as untrusted.
- Browser files must not use `<form>` submission, which hosts can block.
