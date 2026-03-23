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
