# Multi-Tenant Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tenant auth with SQLite storage, invite codes, JWT/API key auth, and admin panel to claude-notif.

**Architecture:** SQLite via `bun:sqlite` replaces JSON files. New `auth.ts` handles JWT + middleware. `storage.ts` full rewrite for user-scoped CRUD. `index.ts` full rewrite with auth middleware on all routes. PWA gets login/register/settings/admin views.

**Tech Stack:** Bun, Hono, web-push, bun:sqlite (built-in), crypto.subtle (built-in)

**Spec:** `docs/superpowers/specs/2026-03-23-claude-notif-multitenancy-design.md`

---

## File Structure

```
src/
  storage.ts    # REWRITE: SQLite DB init, user/subscription/history/invite CRUD
  auth.ts       # NEW: JWT sign/verify, password hash, auth middleware for Hono
  index.ts      # REWRITE: auth middleware, auth routes, admin routes, user-scoped routes
public/
  index.html    # REWRITE: login/register, settings, admin panel + existing views
  sw.js         # NO CHANGE
  manifest.json # NO CHANGE
hooks/
  notify.sh     # MODIFY: add Authorization header
  permission.sh # MODIFY: add Authorization header
docker-compose.yml # MODIFY: add ADMIN_KEY env var
```

---

### Task 1: SQLite Storage Layer

**Files:**
- Modify: `src/storage.ts` (full rewrite)

- [ ] **Step 1: Rewrite storage.ts**

Replace the entire file with:

```typescript
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import webpush from "web-push";

const DATA_DIR = "./data";
const DB_PATH = `${DATA_DIR}/claude-notif.db`;
const VAPID_PATH = `${DATA_DIR}/vapid.json`;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// --- DB Init ---

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

let _db: Database;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA foreign_keys=ON");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        api_key TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT UNIQUE NOT NULL,
        keys_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        machine TEXT NOT NULL,
        project TEXT,
        summary TEXT,
        event TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        max_uses INTEGER,
        use_count INTEGER DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
  return _db;
}

export async function initStorage() {
  await ensureDataDir();
  getDb();
}

// --- VAPID Keys (still JSON file, shared across users) ---

export async function loadVapidKeys(subject: string): Promise<VapidKeys> {
  await ensureDataDir();
  if (existsSync(VAPID_PATH)) {
    return JSON.parse(await Bun.file(VAPID_PATH).text());
  }
  const keys = webpush.generateVAPIDKeys();
  const vapid: VapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  await Bun.write(VAPID_PATH, JSON.stringify(vapid, null, 2));
  return vapid;
}

// --- Users ---

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  api_key: string;
  created_at: string;
}

export interface UserRow extends User {
  password_hash: string;
  role: string;
}

export function createUser(id: string, username: string, passwordHash: string, apiKey: string): User {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO users (id, username, password_hash, display_name, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, username, passwordHash, username, apiKey, now]
  );
  return { id, username, display_name: username, api_key: apiKey, created_at: now };
}

export function getUserByUsername(username: string): UserRow | null {
  return getDb().query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
}

export function getUserByApiKey(apiKey: string): User | null {
  return getDb().query("SELECT id, username, display_name, api_key, created_at FROM users WHERE api_key = ?").get(apiKey) as User | null;
}

export function getUserById(id: string): User | null {
  return getDb().query("SELECT id, username, display_name, api_key, created_at FROM users WHERE id = ?").get(id) as User | null;
}

export function listUsers(): Omit<User, "api_key">[] {
  return getDb().query("SELECT id, username, display_name, created_at FROM users ORDER BY created_at DESC").all() as Omit<User, "api_key">[];
}

export function deleteUser(id: string) {
  getDb().run("DELETE FROM users WHERE id = ?", [id]);
}

// --- Subscriptions (user-scoped) ---

export function addSubscription(userId: string, endpoint: string, keysJson: string) {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT OR IGNORE INTO subscriptions (user_id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?)",
    [userId, endpoint, keysJson, now]
  );
}

export function removeSubscription(userId: string, endpoint: string) {
  getDb().run("DELETE FROM subscriptions WHERE user_id = ? AND endpoint = ?", [userId, endpoint]);
}

export function getSubscriptionsForUser(userId: string): { endpoint: string; keys: any }[] {
  const rows = getDb().query("SELECT endpoint, keys_json FROM subscriptions WHERE user_id = ?").all(userId) as { endpoint: string; keys_json: string }[];
  return rows.map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json) }));
}

export function removeExpiredSubscriptions(endpoints: string[]) {
  if (endpoints.length === 0) return;
  const placeholders = endpoints.map(() => "?").join(",");
  getDb().run(`DELETE FROM subscriptions WHERE endpoint IN (${placeholders})`, endpoints);
}

// --- History (user-scoped) ---

export interface HistoryEntry {
  id: string;
  timestamp: string;
  machine: string;
  project: string;
  summary: string;
  event: string;
  count: number;
}

export function addHistoryEntry(userId: string, entry: { id: string; machine: string; project: string; summary: string; event: string; count: number }) {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO history (id, user_id, machine, project, summary, event, count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [entry.id, userId, entry.machine, entry.project || "", entry.summary, entry.event, entry.count, now]
  );
  // Cap at 50 per user
  getDb().run(
    "DELETE FROM history WHERE user_id = ? AND id NOT IN (SELECT id FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50)",
    [userId, userId]
  );
}

export function getHistory(userId: string): HistoryEntry[] {
  const rows = getDb().query(
    "SELECT id, created_at, machine, project, summary, event, count FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(userId) as { id: string; created_at: string; machine: string; project: string; summary: string; event: string; count: number }[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.created_at,
    machine: r.machine,
    project: r.project,
    summary: r.summary,
    event: r.event,
    count: r.count,
  }));
}

export function clearHistory(userId: string) {
  getDb().run("DELETE FROM history WHERE user_id = ?", [userId]);
}

// --- Invite Codes ---

export interface InviteCode {
  id: string;
  code: string;
  max_uses: number | null;
  use_count: number;
  created_at: string;
}

export function createInviteCode(id: string, code: string, maxUses: number | null, createdBy: string): InviteCode {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO invite_codes (id, code, max_uses, use_count, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    [id, code, maxUses, createdBy, now]
  );
  return { id, code, max_uses: maxUses, use_count: 0, created_at: now };
}

export function getInviteByCode(code: string): InviteCode | null {
  return getDb().query("SELECT id, code, max_uses, use_count, created_at FROM invite_codes WHERE code = ?").get(code) as InviteCode | null;
}

export function incrementInviteUse(id: string) {
  getDb().run("UPDATE invite_codes SET use_count = use_count + 1 WHERE id = ?", [id]);
}

export function listInviteCodes(): InviteCode[] {
  return getDb().query("SELECT id, code, max_uses, use_count, created_at FROM invite_codes ORDER BY created_at DESC").all() as InviteCode[];
}

export function deleteInviteCode(id: string) {
  getDb().run("DELETE FROM invite_codes WHERE id = ?", [id]);
}
```

- [ ] **Step 2: Verify compilation**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun build src/storage.ts --no-bundle --outdir /tmp/check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/storage.ts
git commit -m "feat: rewrite storage layer to SQLite with user-scoped CRUD"
```

---

### Task 2: Auth Module

**Files:**
- Create: `src/auth.ts`

- [ ] **Step 1: Write auth.ts**

```typescript
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
```

- [ ] **Step 2: Verify compilation**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun build src/auth.ts --no-bundle --outdir /tmp/check`
Expected: No errors (may warn about missing ADMIN_KEY at runtime, that's fine)

- [ ] **Step 3: Commit**

```bash
git add src/auth.ts
git commit -m "feat: add auth module with JWT, API key, and admin key middleware"
```

---

### Task 3: Server Rewrite

**Files:**
- Modify: `src/index.ts` (full rewrite)

- [ ] **Step 1: Rewrite index.ts**

Replace the entire file with:

```typescript
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import webpush from "web-push";
import {
  initStorage,
  loadVapidKeys,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  deleteUser,
  addSubscription,
  removeSubscription,
  getSubscriptionsForUser,
  removeExpiredSubscriptions,
  addHistoryEntry,
  getHistory,
  clearHistory,
  createInviteCode,
  getInviteByCode,
  incrementInviteUse,
  listInviteCodes,
  deleteInviteCode,
} from "./storage";
import { authMiddleware, getAuth, requireUser, requireAdmin, signJwt } from "./auth";

const app = new Hono();

const PORT = 7392;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:test@example.com";
const DEBOUNCE_MS = 5000;

// Initialize
await initStorage();
const vapidKeys = await loadVapidKeys(VAPID_SUBJECT);
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
console.log(`VAPID public key: ${vapidKeys.publicKey}`);

// Auth middleware
app.use("*", authMiddleware());

// --- Helpers ---

async function sendPushToUser(userId: string, payload: string, urgency: "high" | "normal") {
  const subs = getSubscriptionsForUser(userId);
  const expired: string[] = [];
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600, urgency });
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          expired.push(sub.endpoint);
        } else {
          console.error(`Push failed for ${sub.endpoint}:`, err?.message);
        }
      }
    })
  );
  if (expired.length > 0) removeExpiredSubscriptions(expired);
}

// --- Debounce (user-scoped) ---

interface PendingNotification {
  userId: string;
  machine: string;
  project: string;
  summary: string;
  event: string;
  agent_id: string;
  agent_type: string;
}

const debounceBuffers = new Map<string, PendingNotification[]>();
const debounceTimers = new Map<string, Timer>();

async function flushDebounce(key: string) {
  const buffer = debounceBuffers.get(key);
  debounceTimers.delete(key);
  debounceBuffers.delete(key);
  if (!buffer || buffer.length === 0) return;

  const { userId, machine, project } = buffer[0];
  const title = project ? `${machine} · ${project}` : machine;
  let body: string;
  const count = buffer.length;

  if (count === 1) {
    body = buffer[0].summary || "Task completed";
  } else {
    const main = buffer.find((n) => !n.agent_id);
    body = main?.summary ? `${count} tasks completed — ${main.summary}` : `${count} tasks completed`;
  }

  const payload = JSON.stringify({ title, body, event: "stop" });
  addHistoryEntry(userId, { id: crypto.randomUUID(), machine, project, summary: body, event: "stop", count });
  await sendPushToUser(userId, payload, "normal");
}

// --- Permission state (in-memory, user-scoped) ---

interface PendingPermission {
  id: string;
  userId: string;
  machine: string;
  project: string;
  tool_name: string;
  tool_summary: string;
  permission_suggestions: any[];
  status: "pending" | "answered";
  decision?: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingPermissions) {
    if (now - p.timestamp > 120_000) pendingPermissions.delete(id);
  }
}, 30_000);

// === AUTH ROUTES (public) ===

app.post("/auth/register", async (c) => {
  const { username, password, invite_code } = await c.req.json();
  if (!username || !password || !invite_code) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const invite = getInviteByCode(invite_code);
  if (!invite) return c.json({ error: "Invalid invite code" }, 400);
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
    return c.json({ error: "Invite code exhausted" }, 400);
  }

  if (getUserByUsername(username)) {
    return c.json({ error: "Username taken" }, 409);
  }

  const id = crypto.randomUUID();
  const passwordHash = await Bun.password.hash(password);
  const apiKey = crypto.randomUUID().replace(/-/g, "");
  const user = createUser(id, username, passwordHash, apiKey);
  incrementInviteUse(invite.id);
  const token = await signJwt(id);

  return c.json({ token, api_key: apiKey, user });
});

app.post("/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const userRow = getUserByUsername(username);
  if (!userRow) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await Bun.password.verify(password, userRow.password_hash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = await signJwt(userRow.id);
  return c.json({
    token,
    api_key: userRow.api_key,
    user: { id: userRow.id, username: userRow.username, display_name: userRow.display_name, api_key: userRow.api_key, created_at: userRow.created_at },
  });
});

app.get("/auth/me", (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;
  const user = getUserById(userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({ user });
});

// === ADMIN ROUTES ===

app.get("/admin/invites", (c) => {
  const admin = requireAdmin(c);
  if (admin !== true) return admin;
  return c.json(listInviteCodes());
});

app.post("/admin/invites", async (c) => {
  const admin = requireAdmin(c);
  if (admin !== true) return admin;
  let maxUses: number | null = null;
  try {
    const data = await c.req.json();
    maxUses = data.max_uses ?? null;
  } catch {}
  const id = crypto.randomUUID();
  const code = crypto.randomUUID().slice(0, 8);
  const invite = createInviteCode(id, code, maxUses, "admin");
  return c.json(invite);
});

app.delete("/admin/invites/:id", (c) => {
  const admin = requireAdmin(c);
  if (admin !== true) return admin;
  deleteInviteCode(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/admin/users", (c) => {
  const admin = requireAdmin(c);
  if (admin !== true) return admin;
  return c.json(listUsers());
});

app.delete("/admin/users/:id", (c) => {
  const admin = requireAdmin(c);
  if (admin !== true) return admin;
  deleteUser(c.req.param("id"));
  return c.json({ ok: true });
});

// === USER ROUTES ===

app.get("/vapid-public-key", (c) => c.json({ publicKey: vapidKeys.publicKey }));

app.post("/subscribe", async (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;
  const sub = await c.req.json();
  if (!sub?.endpoint || !sub?.keys) return c.json({ error: "Invalid subscription" }, 400);
  addSubscription(userId, sub.endpoint, JSON.stringify(sub.keys));
  return c.json({ ok: true });
});

app.delete("/subscribe", async (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;
  const { endpoint } = await c.req.json();
  if (!endpoint) return c.json({ error: "Missing endpoint" }, 400);
  removeSubscription(userId, endpoint);
  return c.json({ ok: true });
});

app.post("/notify", async (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;

  const body = await c.req.json();
  const { machine, project, summary, event, agent_id, agent_type } = body;
  if (!machine) return c.json({ error: "Missing machine" }, 400);

  const eventType = (event || "stop").toLowerCase();

  if (eventType === "notification") {
    const title = project ? `${machine} · ${project} · Waiting` : `${machine} · Waiting`;
    const payload = JSON.stringify({ title, body: summary || "Waiting for input", event: "notification" });
    addHistoryEntry(userId, { id: crypto.randomUUID(), machine, project: project || "", summary: summary || "Waiting for input", event: "notification", count: 1 });
    await sendPushToUser(userId, payload, "high");
    return c.json({ ok: true, immediate: true });
  }

  const key = `${userId}:${machine}:${project || "unknown"}`;
  const pending: PendingNotification = { userId, machine, project: project || "", summary: summary || "Task completed", event: eventType, agent_id: agent_id || "", agent_type: agent_type || "" };

  if (!debounceBuffers.has(key)) debounceBuffers.set(key, []);
  debounceBuffers.get(key)!.push(pending);

  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => flushDebounce(key), DEBOUNCE_MS));

  return c.json({ ok: true, debounced: true });
});

app.get("/history", (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;
  return c.json(getHistory(userId));
});

app.delete("/history", (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;
  clearHistory(userId);
  return c.json({ ok: true });
});

// === PERMISSION ROUTES ===

app.post("/permission", async (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;

  const body = await c.req.json();
  const { id, machine, project, tool_name, tool_summary, permission_suggestions } = body;
  if (!id || !tool_name) return c.json({ error: "Missing required fields" }, 400);

  pendingPermissions.set(id, {
    id, userId, machine: machine || "", project: project || "",
    tool_name, tool_summary: tool_summary || tool_name,
    permission_suggestions: permission_suggestions || [],
    status: "pending", timestamp: Date.now(),
  });

  const title = project ? `${machine} · ${project}` : machine || "Claude Code";
  const payload = JSON.stringify({ title, body: tool_summary || tool_name, event: "permission", permissionId: id });
  await sendPushToUser(userId, payload, "high");

  return c.json({ ok: true, id });
});

app.get("/permission/:id", (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;

  const id = c.req.param("id");
  const p = pendingPermissions.get(id);
  if (!p || p.userId !== userId) return c.json({ error: "Not found or expired" }, 404);

  if (p.status === "answered") {
    const resp: any = { status: "answered", decision: p.decision };
    if (p.decision === "always" && p.permission_suggestions.length > 0) {
      resp.permission_suggestions = p.permission_suggestions;
    }
    return c.json(resp);
  }
  return c.json({ status: "pending", tool_name: p.tool_name, tool_summary: p.tool_summary, machine: p.machine, project: p.project });
});

app.post("/permission/:id/respond", async (c) => {
  const userId = requireUser(c);
  if (typeof userId !== "string") return userId;

  const id = c.req.param("id");
  const { decision } = await c.req.json();
  const p = pendingPermissions.get(id);
  if (!p || p.userId !== userId) return c.json({ error: "Not found or expired" }, 404);
  if (p.status === "answered") return c.json({ error: "Already answered" }, 409);

  p.status = "answered";
  p.decision = decision;
  return c.json({ ok: true });
});

// === STATIC FILES ===

app.use("/*", serveStatic({ root: "./public" }));

// === START ===

export default { port: PORT, fetch: app.fetch };
console.log(`Server running on http://localhost:${PORT}`);
```

- [ ] **Step 2: Verify compilation**

Run: `export PATH="$HOME/.bun/bin:$PATH" && ADMIN_KEY=test bun build src/index.ts --no-bundle --outdir /tmp/check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: rewrite server with auth middleware, admin routes, user-scoped endpoints"
```

---

### Task 4: PWA — Auth Views + Admin Panel

**Files:**
- Modify: `public/index.html` (full rewrite)

This is the largest task. The HTML adds: login/register view, settings section with API key, admin panel, and wraps all existing fetch calls with auth headers.

- [ ] **Step 1: Rewrite index.html**

The new HTML is very long (~750 lines). The subagent should read the plan's spec at `docs/superpowers/specs/2026-03-23-claude-notif-multitenancy-design.md` sections "PWA Changes" and the current `public/index.html` for the Liquid Glass CSS variables and design language. The key additions:

**HTML structure:**
```
#authView (shown when no token in localStorage)
  - Tab bar: Login | Register
  - Login form: username, password
  - Register form: invite code, username, password
  - Error message area

#mainView (shown after auth)
  - Status card + subscribe button (existing)
  - Settings section: display name, API key (tap to copy), logout button
  - History list (existing, now sends auth header)
  - Clear history button (existing)

#adminView (shown when admin key in localStorage)
  - Invite codes list + generate button
  - Users list + revoke button
  - Back to main button

#permissionView (existing, unchanged)
```

**JavaScript changes:**
- `getToken()` helper returns JWT from localStorage
- `authFetch(url, opts)` wrapper adds `Authorization: Bearer <token>` to all API calls
- `init()` checks for token in localStorage, calls `GET /auth/me` to verify, shows login if invalid
- Login/register forms call `/auth/login` and `/auth/register`, store token + api_key
- Settings section shows api_key with copy-to-clipboard
- Admin panel: enter admin key via prompt, stored separately in localStorage as `adminKey`
- Admin fetches use `adminKey` as Bearer token

**CSS additions:**
- `.auth-form` — glass card with form fields
- `.tab-bar` — login/register tab switcher
- `.input-field` — glass-styled text input
- `.settings-section` — glass card below subscribe button
- `.api-key` — monospace, tap-to-copy style
- `.admin-section` — glass cards for invite/user lists

The subagent implementing this MUST write the complete file (~750 lines). It should:
1. Read current `public/index.html` for the full Liquid Glass CSS and existing JS patterns
2. Read the spec at `docs/superpowers/specs/2026-03-23-claude-notif-multitenancy-design.md` sections "PWA Changes"
3. Keep ALL existing CSS variables, glass classes, history rendering, and permission prompt code
4. Add the auth views, settings section, and admin panel following the structure above
5. Wrap all `fetch()` calls with the `authFetch()` helper that adds the Authorization header from localStorage

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add auth views, settings, and admin panel to PWA"
```

---

### Task 5: Hook Scripts — Add Auth Header

**Files:**
- Modify: `hooks/notify.sh`
- Modify: `hooks/permission.sh`

- [ ] **Step 1: Update notify.sh**

Add auth header. Replace the curl block (lines 50-53) with:

```bash
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"

curl -s --max-time 5 -X POST "${NOTIF_SERVER}/notify" \
  -H 'Content-Type: application/json' \
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
  -d "$JSON" \
  > /dev/null 2>&1
```

Note: `${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"}` is a bash parameter expansion that only adds the header if AUTH_KEY is non-empty.

- [ ] **Step 2: Update permission.sh**

Add auth header to both the POST and poll GET curls. Add after line 7 (`NOTIF_SERVER=...`):

```bash
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"
AUTH_HEADER=""
if [ -n "$AUTH_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $AUTH_KEY"
fi
```

Then update the POST curl (line 36-38) to include `-H "$AUTH_HEADER"` if set:

```bash
RESULT=$(curl -s --max-time 5 -X POST "${NOTIF_SERVER}/permission" \
  -H 'Content-Type: application/json' \
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
  -d "$POST_JSON" 2>/dev/null)
```

And the poll GET curl (line 51):

```bash
  RESP=$(curl -s --max-time 3 ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} "${NOTIF_SERVER}/permission/${REQ_ID}" 2>/dev/null)
```

- [ ] **Step 3: Commit**

```bash
git add hooks/notify.sh hooks/permission.sh
git commit -m "feat: add API key auth header to hook scripts"
```

---

### Task 6: Docker Compose — Add ADMIN_KEY

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add ADMIN_KEY env var**

Replace entire file:

```yaml
services:
  claude-notif:
    build: .
    ports:
      - "7392:7392"
    volumes:
      - ./data:/app/data
    environment:
      - VAPID_SUBJECT=mailto:you@example.com
      - ADMIN_KEY=your-secret-admin-key
    restart: unless-stopped
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add ADMIN_KEY env var to docker-compose"
```

---

### Task 7: Deploy Hooks + Settings

- [ ] **Step 1: Copy hooks to ~/.claude/hooks/**

Run:
```bash
cp hooks/notify.sh ~/.claude/hooks/notify.sh
cp hooks/permission.sh ~/.claude/hooks/permission.sh
```

- [ ] **Step 2: Add CLAUDE_NOTIF_KEY to settings.json env block**

In `~/.claude/settings.json`, add `CLAUDE_NOTIF_KEY` to the `env` object. The value will be set after registering a user — for now use a placeholder or leave empty:

```json
"CLAUDE_NOTIF_KEY": ""
```

This will be updated after the first user registers and gets their API key.

---

### Task 8: Smoke Test

- [ ] **Step 1: Start server**

Run: `export PATH="$HOME/.bun/bin:$PATH" && ADMIN_KEY=test-admin-key bun run src/index.ts &`
Expected: `Server running on http://localhost:7392`

- [ ] **Step 2: Test admin — create invite code**

Run: `curl -s -X POST http://localhost:7392/admin/invites -H 'Authorization: Bearer test-admin-key' -H 'Content-Type: application/json' -d '{"max_uses":5}'`
Expected: JSON with `id`, `code` (8 chars), `max_uses: 5`

- [ ] **Step 3: Register a user**

Run (replace CODE with the code from step 2):
```bash
curl -s -X POST http://localhost:7392/auth/register -H 'Content-Type: application/json' -d '{"username":"angelo","password":"test123","invite_code":"CODE"}'
```
Expected: JSON with `token`, `api_key`, `user`

- [ ] **Step 4: Test auth/me with JWT**

Run (replace TOKEN with token from step 3):
```bash
curl -s http://localhost:7392/auth/me -H 'Authorization: Bearer TOKEN'
```
Expected: `{"user":{"id":"...","username":"angelo",...}}`

- [ ] **Step 5: Test notify with API key**

Run (replace APIKEY with api_key from step 3):
```bash
curl -s -X POST http://localhost:7392/notify -H 'Authorization: Bearer APIKEY' -H 'Content-Type: application/json' -d '{"machine":"test","project":"my-api","summary":"Test notification","event":"stop"}'
```
Expected: `{"ok":true,"debounced":true}`

- [ ] **Step 6: Test notify without auth fails**

Run: `curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test","summary":"No auth"}'`
Expected: `{"error":"Unauthorized"}` with 401

- [ ] **Step 7: Test admin list users**

Run: `curl -s http://localhost:7392/admin/users -H 'Authorization: Bearer test-admin-key'`
Expected: Array with one user (angelo)

- [ ] **Step 8: Test history (user-scoped)**

Run: `sleep 6 && curl -s http://localhost:7392/history -H 'Authorization: Bearer TOKEN'`
Expected: Array with one debounced history entry

- [ ] **Step 9: Kill server and clean up**

Run: `kill %1 2>/dev/null; rm -rf data/`
