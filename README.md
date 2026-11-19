# Ghostwriter

A small document editor, in the spirit of Google Docs, that you and your AI assistant edit **together**. Documents live on a server, so any number of editors can be open on the same document and stay in step, and an AI assistant can read and edit it while you watch: its edits are typed out on the page, old text erased and new text typed in.

It runs three ways from one codebase:

- **A website.** Home screen with all your documents (start one, search, rename, copy, remove with undo) and an editor with a toolbar, outline and page.
- **An MCP server** at `/mcp`. Any MCP client can list, read and edit documents with ordinary tools.
- **An MCP App** for Claude and ChatGPT. The editor itself appears inside the chat, in the conversation or in a side panel, and the assistant edits the document you are looking at. The "app" is the website, not a rebuilt copy.

The page also describes itself to a browser-based agent through [WebMCP](https://webmachinelearning.github.io/webmcp/) where the browser supports it.

## Quick start

```sh
npm install
npm start            # http://localhost:3010
```

Or with Docker (documents are kept in `./data`):

```sh
docker compose up -d --build
```

| Setting | Default | What it is |
| --- | --- | --- |
| `PORT` | `3010` | Port to listen on |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Interface to listen on |
| `DATA_DIR` | `./data` | Where documents are stored (`docs/<id>.json`) |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` | The address the site is reachable at **from a browser**. The MCP App view loads its files and calls its API from here, so set it to your real public address (for example `https://notes.example.com`) when you connect Claude or ChatGPT. |

## Connect an assistant

1. Make the server reachable over HTTPS at a public address and set `PUBLIC_ORIGIN` to it. (Claude and ChatGPT need a URL they can reach; `localhost` only works for the plain website.)
2. Add `https://<your address>/mcp` as a custom connector: in Claude, Customize > Connectors; in ChatGPT, developer mode > Apps. The site's menu has an "Add to Claude" link that builds the address for you.
3. In a chat, ask the assistant to open Ghostwriter.

> **There is no sign-in.** Anyone who can reach the site or `/mcp` can read, edit and remove every document. That is fine for a personal prototype on a private network or behind your own access control (a VPN, a reverse proxy with auth). Do not put anything private in it on the open internet.

## Tools

`list_documents`, `create_document`, `open_document`, `get_document`, `get_section`, `find_nodes`, `replace_text`, `replace_nodes`, `insert_nodes`, `insert_list_items`, `delete_nodes`, `set_title`. Inside the app view the assistant also gets `editor_*` tools that work on the open document, including what you have selected. Edit tools take an optional `expected_revision` and return the nodes they removed and added. Every tool declares whether it is read-only, and document text is marked as untrusted so it is never treated as instructions.

## How it works

- `server.js`: Express and the MCP SDK. Stores documents, serves the website and `/api`, and the MCP endpoint (stateless).
- `site/`: the website, plain ES modules with no build step. `model.js` (the document), `tools.js` (the tools), `merge.js` (three-way merge by block id), `sync.js` (polling and saving), `view.js` (the editor), `host.js` (what only matters inside a chat app).
- Two editors on one document are merged on the server by block id; the person's cursor stays put when someone else's change arrives.
- The MCP App view is `site/index.html` with its asset paths made absolute, plus a small boot script. A deploy of the site is a deploy of the app.

More detail for contributors is in [CLAUDE.md](CLAUDE.md).

## Tests

```sh
npm test                 # server tests and site tests, no network, no API key
npm run evals:selftest   # the eval harness checks itself
npm run e2e              # a real browser and a stand-in chat host (needs Chrome)
```

`npm run evals` runs scenarios against a real model and needs an Anthropic API key (see [evals/README.md](evals/README.md)); it costs money and is never run by CI.

## Limits

Light theme only. Plain-text blocks only (no bold or italic). Concurrent edits to the very same paragraph keep the one saved first. Undo is per editor and starts over when another editor's change arrives.

## License

MIT. See [LICENSE](LICENSE).
