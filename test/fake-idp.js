// A stand-in OpenID Connect provider for tests: discovery, JWKS, authorize (no login page: whoever
// `idp.user` is "signed in"), token (PKCE and client secret checked), userinfo. Like Authelia, it
// keeps groups out of the ID token and returns them from userinfo.
import http from "node:http";
import crypto from "node:crypto";

const b64 = (b) => Buffer.from(b).toString("base64url");

export async function startFakeIdp({ port = 0, clientId = "gw-test", clientSecret = "s3cret-for-tests", redirectUri } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const codes = new Map();
  const access = new Map();
  const idp = {
    user: { sub: "u-amit", name: "Amit", email: "amit@example.test", email_verified: true, groups: ["admins"] },
    deny: false, // answer the next authorize with access_denied
    tamper: false, // sign ID tokens with the wrong key
    calls: [],
    clientId,
    clientSecret,
  };

  const sign = (claims, key = privateKey) => {
    const h = b64(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
    const p = b64(JSON.stringify(claims));
    return `${h}.${p}.${b64(crypto.sign("sha256", Buffer.from(`${h}.${p}`), key))}`;
  };
  const body = async (req) => {
    let s = "";
    for await (const c of req) s += c;
    return new URLSearchParams(s);
  };
  const json = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    idp.calls.push(url.pathname);
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        userinfo_endpoint: `${idp.issuer}/userinfo`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || (redirectUri && q.get("redirect_uri") !== redirectUri)) return json(res, 400, { error: "invalid_request" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "PKCE required" });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("state", q.get("state"));
      if (idp.deny) {
        idp.deny = false;
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "The user said no");
      } else {
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge"), nonce: q.get("nonce"), redirect: q.get("redirect_uri"), user: { ...idp.user }, scope: q.get("scope") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = await body(req);
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const [id, secret] = basic ? Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent) : [f.get("client_id"), f.get("client_secret")];
      if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
      const c = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      if (!c || c.redirect !== f.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
      const challenge = b64(crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest());
      if (challenge !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
      const t = Math.floor(Date.now() / 1000);
      const { groups, ...idClaims } = c.user;
      const key = idp.tamper ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : privateKey;
      const id_token = sign({ iss: idp.issuer, aud: clientId, iat: t, exp: t + 300, nonce: c.nonce, ...idClaims }, key);
      const at = crypto.randomBytes(16).toString("hex");
      access.set(at, c.user);
      return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 300, id_token });
    }
    if (url.pathname === "/userinfo") {
      if (idp.userinfoFailures > 0) {
        idp.userinfoFailures--;
        return json(res, 503, { error: "temporarily_unavailable" });
      }
      const u = access.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!u) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, u);
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise((r) => server.close(r));
  return idp;
}
