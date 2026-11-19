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

> **Sign-in is off by default.** Then anyone who can reach the site or `/mcp` can read, edit and remove every document. That is fine for a personal prototype on a private network. To put it on the open internet, turn on [sign-in](#sign-in-optional).

## Sign-in (optional)

Point Ghostwriter at your own OpenID Connect provider (Authelia, Keycloak, Authentik, Zitadel, Okta, Google, Microsoft Entra...) and it asks people to sign in there:

- **The website** shows a sign-in screen. Signing in sends you to your provider and back; the session lasts a week.
- **Claude, ChatGPT and other MCP clients** still connect with just the URL. Ghostwriter acts as an OAuth server for them: the app registers itself, you sign in at your provider, approve the app on Ghostwriter's own page, and the app gets Ghostwriter's tokens. Your provider never has to know about Claude or ChatGPT, and it does not need to support dynamic client registration.
- **The editor inside the chat** gets a short-lived token from that connection.
- **Connected apps** in the menu lists the apps you approved, with a Disconnect button that cuts each one off at once.

Everyone who can sign in shares one library of documents.

### Set it up

1. Serve Ghostwriter over **https** and set `PUBLIC_ORIGIN` to that address.
2. At your provider, create a **confidential** OpenID Connect client for Ghostwriter:
   - redirect URI: `https://<your address>/auth/callback` (the only one; MCP apps register with Ghostwriter, not with the provider)
   - grant type authorization code, PKCE (S256) required or allowed, client authentication `client_secret_basic` or `client_secret_post`
   - scopes `openid profile email`, plus `groups` if you let people in by group
3. Set these, for example in `.env` next to `docker-compose.yml`:

| Setting | Required | What it is |
| --- | --- | --- |
| `OIDC_ISSUER` | yes | Your provider's issuer URL, for example `https://auth.example.com`. Setting it turns sign-in on. |
| `OIDC_CLIENT_ID` | yes | The client you created. |
| `OIDC_CLIENT_SECRET` or `OIDC_CLIENT_SECRET_FILE` | for a confidential client | Its secret, or a file holding it. |
| `OIDC_ALLOWED_GROUPS` | one of these three | Groups whose members may sign in (comma-separated), from the `groups` claim. |
| `OIDC_ALLOWED_EMAILS` | | Email addresses that may sign in. Only counted when the provider says the email is verified (`email_verified: true`); otherwise use groups. |
| `OIDC_ALLOW_ANY_USER` | | `true`: anyone your provider signs in. Only for a provider that is itself limited to your people. |
| `OIDC_GROUPS_CLAIM` | no | Claim that lists groups. Default `groups`. |
| `OIDC_SCOPES` | no | Scopes to ask for. Default `openid profile email`, plus `groups` when groups decide. |
| `SESSION_DAYS` | no | Website session length. Default 7. |
| `OAUTH_ACCESS_MINUTES` / `OAUTH_REFRESH_DAYS` | no | Lifetime of an app's access token (default 60) and of its sign-in (default 30 days; then the person signs in again). |
| `SESSION_SECRET` | no | Signs cookies and editor tokens. Default: a random one made once and kept in `DATA_DIR/auth/secret`. |
| `TRUST_PROXY` | behind a proxy | Which proxies' `X-Forwarded-For` to trust, so the sign-in endpoints' rate limits see real addresses ([Express's setting](https://expressjs.com/en/guide/behind-proxies.html)). Default `loopback` (a proxy on the same machine). Behind a proxy in another container, set its address or network, for example `uniquelocal`, and don't publish Ghostwriter's own port. |

Ghostwriter refuses to start if sign-in is half set up (an issuer but no allowlist, or http on a public address), rather than starting open.

4. Restart, then in Claude or ChatGPT remove the old connector and add `https://<your address>/mcp` again. It asks you to sign in and approve.

Provider notes:
- **Authelia**: add a client under `identity_providers.oidc.clients` with `public: false`, `require_pkce: true`, `pkce_challenge_method: S256`, `token_endpoint_auth_method: client_secret_basic`, the redirect URI above and the scopes above. Groups come from lldap or your users file; use `OIDC_ALLOWED_GROUPS`.
- **Google**: create an OAuth client of type "Web application" and use `OIDC_ISSUER=https://accounts.google.com` with `OIDC_ALLOWED_EMAILS` (Google has no groups claim).
- **Keycloak**: the issuer is `https://<host>/realms/<realm>`. Add a "groups" client scope with a group membership mapper (full group path off) to use `OIDC_ALLOWED_GROUPS`.

### What is kept, and good to know

- `DATA_DIR/auth/state.json` (owner-only): apps that registered, who approved which, and tokens **as hashes** only. Back it up with the documents. `DATA_DIR/auth/secret` signs cookies; deleting it signs everyone out.
- Removing someone from the allowlist (or the group) takes effect for new sign-ins at once. A session already open, or an app already connected, keeps the groups it had when the person signed in: up to `SESSION_DAYS` for the website and `OAUTH_REFRESH_DAYS` for apps. Disconnect the app or shorten those to make it quicker. Changing the allowlist settings themselves applies at once.
- Signing out of Ghostwriter does not sign you out of your provider, so signing in again may be one click.

## Tools

`list_documents`, `create_document`, `open_document`, `get_document`, `get_section`, `find_nodes`, `replace_text`, `replace_nodes`, `insert_nodes`, `insert_list_items`, `delete_nodes`, `set_title`. Inside the app view the assistant also gets `editor_*` tools that work on the open document, including what you have selected. Edit tools take an optional `expected_revision` and return the nodes they removed and added. Every tool declares whether it is read-only, and document text is marked as untrusted so it is never treated as instructions.

## How it works

- `server.js`: Express and the MCP SDK. Stores documents, serves the website and `/api`, and the MCP endpoint (stateless).
- `auth/`: optional sign-in. `oidc.js` (signing in at your provider), `provider.js` (the OAuth server for MCP apps, on the MCP SDK's router), `store.js`, `pages.js` (the approval page), `index.js` (settings, sessions, guards).
- `site/`: the website, plain ES modules with no build step. `model.js` (the document), `tools.js` (the tools), `merge.js` (three-way merge by block id), `sync.js` (polling and saving), `view.js` (the editor), `host.js` (what only matters inside a chat app).
- Two editors on one document are merged on the server by block id; the person's cursor stays put when someone else's change arrives.
- The MCP App view is `site/index.html` with its asset paths made absolute, plus a small boot script. A deploy of the site is a deploy of the app.

More detail for contributors is in [CLAUDE.md](CLAUDE.md).

## Tests

```sh
npm test                 # server tests and site tests, no network, no API key
npm run evals:selftest   # the eval harness checks itself
npm run e2e              # a real browser and a stand-in chat host (needs Chrome)
npm run e2e:auth         # the same with sign-in on, against a stand-in provider
```

`npm run evals` runs scenarios against a real model and needs an Anthropic API key (see [evals/README.md](evals/README.md)); it costs money and is never run by CI.

## Limits

Light theme only. Plain-text blocks only (no bold or italic). Concurrent edits to the very same paragraph keep the one saved first. Undo is per editor and starts over when another editor's change arrives.

## License

MIT. See [LICENSE](LICENSE).
