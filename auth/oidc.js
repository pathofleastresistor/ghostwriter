// Ghostwriter as an OpenID Connect client of the person's own identity provider (Authelia, Keycloak,
// Google...): discovery, the authorization code flow with PKCE, and ID token checks. Node's own
// crypto verifies the signature, so there is no JWT library.
import crypto from "node:crypto";
import { b64url, now } from "./util.js";

const DISCOVERY_TTL = 60 * 60 * 1000;
const SKEW = 120; // seconds of clock difference tolerated between this server and the provider

/** The issuer must be https, except on this machine (for development and tests). */
export function checkIssuer(issuer) {
  let u;
  try {
    u = new URL(issuer);
  } catch {
    throw new Error(`OIDC_ISSUER is not a URL: ${issuer}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("OIDC_ISSUER must be an https address.");
  if (u.search || u.hash) throw new Error("OIDC_ISSUER must not have a query or fragment.");
}

// Signature algorithms accepted on ID tokens, as Node's crypto.verify needs them.
const ALGS = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  PS384: { hash: "sha384", padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
  PS512: { hash: "sha512", padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363" },
  EdDSA: { hash: null },
};

export class OidcError extends Error {}

export function createOidcClient({ issuer, clientId, clientSecret, redirectUri, scopes, fetchImpl = fetch }) {
  checkIssuer(issuer);
  const base = issuer.replace(/\/+$/, "");
  let meta = null;
  let metaAt = 0;
  let jwks = null;
  let jwksAt = 0;

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OidcError(`${new URL(url).pathname} answered ${r.status} with something that is not JSON.`);
    }
    if (!r.ok) throw new OidcError(`${new URL(url).pathname} answered ${r.status}: ${body.error_description || body.error || "error"}`);
    return body;
  }

  async function metadata() {
    if (meta && Date.now() - metaAt < DISCOVERY_TTL) return meta;
    const m = await getJson(`${base}/.well-known/openid-configuration`);
    // The provider must say it is the issuer it was asked about (OpenID Connect Discovery 4.3).
    if (m.issuer !== issuer && m.issuer !== base && m.issuer.replace(/\/+$/, "") !== base) throw new OidcError(`The provider says its issuer is ${m.issuer}, not ${issuer}.`);
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (!m[k]) throw new OidcError(`The provider's discovery document has no ${k}.`);
    meta = m;
    metaAt = Date.now();
    return m;
  }

  async function keys(force = false) {
    if (jwks && !force && Date.now() - jwksAt < DISCOVERY_TTL) return jwks;
    const m = await metadata();
    jwks = (await getJson(m.jwks_uri)).keys ?? [];
    jwksAt = Date.now();
    return jwks;
  }

  /** Where to send the person, plus what to keep until they come back. */
  async function startLogin() {
    const m = await metadata();
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const u = new URL(m.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(" "), state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    return { url: u.href, state, nonce, verifier };
  }

  async function verifyIdToken(idToken, nonce) {
    const parts = String(idToken).split(".");
    if (parts.length !== 3) throw new OidcError("The ID token is malformed.");
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    } catch {
      throw new OidcError("The ID token is malformed.");
    }
    const alg = ALGS[header.alg];
    if (!alg) throw new OidcError(`The ID token is signed with ${header.alg}, which is not accepted.`);
    const pick = (list) => list.filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig") && (!k.alg || k.alg === header.alg));
    let candidates = pick(await keys());
    if (!candidates.length) candidates = pick(await keys(true)); // the provider may have rotated its keys
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], "base64url");
    const good = candidates.some((jwk) => {
      try {
        const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
        const opts = { key, ...(alg.padding ? { padding: alg.padding, saltLength: alg.saltLength } : {}), ...(alg.dsaEncoding ? { dsaEncoding: alg.dsaEncoding } : {}) };
        return crypto.verify(alg.hash, data, opts, sig);
      } catch {
        return false;
      }
    });
    if (!good) throw new OidcError("The ID token's signature does not check out.");

    const m = await metadata();
    const t = now();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== m.issuer) throw new OidcError("The ID token is from a different issuer.");
    if (!aud.includes(clientId)) throw new OidcError("The ID token is for a different client.");
    if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new OidcError("The ID token was issued to a different party.");
    if (typeof claims.exp !== "number" || claims.exp + SKEW < t) throw new OidcError("The ID token has expired.");
    if (typeof claims.iat === "number" && claims.iat - SKEW > t) throw new OidcError("The ID token is from the future: check the clocks.");
    if (claims.nonce !== nonce) throw new OidcError("The ID token does not match this sign-in.");
    if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("The ID token names no user.");
    return claims;
  }

  /** Swaps the code for tokens, checks the ID token, and returns who signed in. */
  async function finishLogin({ code, verifier, nonce }) {
    const m = await metadata();
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const methods = m.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (!clientSecret) form.set("client_id", clientId);
    else if (methods.includes("client_secret_basic")) headers.authorization = "Basic " + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
    else {
      form.set("client_id", clientId);
      form.set("client_secret", clientSecret);
    }
    const tokens = await getJson(m.token_endpoint, { method: "POST", headers, body: form });
    if (!tokens.id_token) throw new OidcError("The provider sent no ID token. Is the openid scope allowed for this client?");
    const claims = await verifyIdToken(tokens.id_token, nonce);
    // Providers often keep groups and email out of the ID token; userinfo has them. If userinfo can't be
    // read, the allowlist would see someone with no email or groups and turn them away as "not on the
    // list", which sends them looking for the wrong fix. So try twice, then say it was the connection.
    let info = {};
    if (m.userinfo_endpoint && tokens.access_token) {
      const read = () => getJson(m.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } });
      try {
        info = await read().catch(() => read());
      } catch (e) {
        console.error("auth: could not read userinfo:", e.message);
        throw new OidcError("Ghostwriter couldn't reach your sign-in service to read your account details. Try again in a minute.");
      }
      if (info.sub !== claims.sub) info = {}; // must be the same person (OpenID Connect Core 5.3.2)
    }
    return { ...info, ...claims };
  }

  return { metadata, startLogin, finishLogin };
}
