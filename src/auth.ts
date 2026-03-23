import type { Context, Next } from "hono";
import { getUserByApiKey, getUserById } from "./storage";

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error("ADMIN_KEY environment variable is required");
  process.exit(1);
}

// --- JWT ---

const encoder = new TextEncoder();

async function getJwtSecret(): Promise<CryptoKey> {
  const keyData = encoder.encode("claude-notif-jwt");
  const rawKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const adminBytes = encoder.encode(ADMIN_KEY);
  const signed = await crypto.subtle.sign("HMAC", rawKey, adminBytes);
  return crypto.subtle.importKey("raw", signed, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

let _jwtKey: CryptoKey | null = null;
async function jwtKey(): Promise<CryptoKey> {
  if (!_jwtKey) _jwtKey = await getJwtSecret();
  return _jwtKey;
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function signJwt(userId: string): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000) })));
  const data = `${header}.${payload}`;
  const key = await jwtKey();
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${base64url(sig)}`;
}

export async function verifyJwt(token: string): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const key = await jwtKey();
    const data = `${header}.${payload}`;
    const valid = await crypto.subtle.verify("HMAC", key, base64urlDecode(sig), encoder.encode(data));
    if (!valid) return null;
    const decoded = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    return decoded.sub || null;
  } catch {
    return null;
  }
}

// --- Auth Middleware ---

export interface AuthContext {
  userId: string | null;
  isAdmin: boolean;
}

const PUBLIC_PATHS = ["/auth/login", "/auth/register", "/vapid-public-key"];

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const path = c.req.path;

    // Static files and public paths skip auth
    if (PUBLIC_PATHS.includes(path) || path.startsWith("/sw.js") || path.startsWith("/icon.") || path.startsWith("/manifest.json")) {
      await next();
      return;
    }

    // For the root HTML page, serve without auth (login page handles it client-side)
    if (path === "/" || path === "/index.html") {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.slice(7);

    // 1. Check admin key first
    if (token === ADMIN_KEY) {
      c.set("auth", { userId: null, isAdmin: true } as AuthContext);
      await next();
      return;
    }

    // 2. Try JWT
    const jwtUserId = await verifyJwt(token);
    if (jwtUserId) {
      const user = getUserById(jwtUserId);
      if (user) {
        c.set("auth", { userId: jwtUserId, isAdmin: false } as AuthContext);
        await next();
        return;
      }
    }

    // 3. Try API key
    const apiUser = getUserByApiKey(token);
    if (apiUser) {
      c.set("auth", { userId: apiUser.id, isAdmin: false } as AuthContext);
      await next();
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}

export function getAuth(c: Context): AuthContext {
  return c.get("auth") as AuthContext;
}

export function requireUser(c: Context): string | Response {
  const auth = getAuth(c);
  if (!auth?.userId) return c.json({ error: "User required" }, 403);
  return auth.userId;
}

export function requireAdmin(c: Context): true | Response {
  const auth = getAuth(c);
  if (!auth?.isAdmin) return c.json({ error: "Admin required" }, 403);
  return true;
}
