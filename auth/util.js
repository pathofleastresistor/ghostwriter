// Small building blocks for sign-in: signed values, random tokens, cookies, HTML escaping.
import crypto from "node:crypto";

export const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Signs and checks small JSON values (cookies, view tokens) with HMAC-SHA256. Each purpose gets its
 * own key derived from the secret, so a value signed for one purpose is never accepted for another.
 */
export function signer(secret, purpose) {
  const key = crypto.createHmac("sha256", secret).update("ghostwriter:" + purpose).digest();
  const mac = (s) => b64url(crypto.createHmac("sha256", key).update(s).digest());
  return {
    /** `value` should carry `exp` (seconds since the epoch). */
    sign(value) {
      const body = b64url(JSON.stringify(value));
      return `${body}.${mac(body)}`;
    },
    /** The value, or null if it is malformed, forged or expired. */
    verify(token) {
      if (typeof token !== "string" || token.length > 8192) return null;
      const dot = token.indexOf(".");
      if (dot < 1) return null;
      const body = token.slice(0, dot);
      if (!safeEqual(token.slice(dot + 1), mac(body))) return null;
      let value;
      try {
        value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (!value || typeof value !== "object" || typeof value.exp !== "number" || value.exp < Date.now() / 1000) return null;
      return value;
    },
    /** A MAC of a string, for binding a form to a session (CSRF). */
    mac,
  };
}

export const now = () => Math.floor(Date.now() / 1000);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* a cookie we did not set */
      }
    }
  }
  return out;
}

export function cookie(name, value, { maxAge, path = "/", secure, sameSite = "Lax" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", `SameSite=${sameSite}`];
  if (secure) parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

/** Adds a Set-Cookie header without dropping ones already set on this response. */
export function addCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), value]);
}

/** Only a path on this site: "/x", never "//host", "/\\host" or a full URL. Anything else is "/". */
export function safeReturn(value) {
  const s = typeof value === "string" ? value : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(s) || s.length > 2000) return "/";
  return s;
}

export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const splitList = (v) =>
  String(v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
