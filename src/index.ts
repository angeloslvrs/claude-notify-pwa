import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import webpush from "web-push";
import {
  loadVapidKeys,
  loadSubscriptions,
  saveSubscriptions,
  addSubscription,
  removeSubscription,
  loadHistory,
  addHistoryEntry,
  clearHistory,
  type HistoryEntry,
} from "./storage";

const app = new Hono();

const PORT = 7392;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:test@example.com";
const DEBOUNCE_MS = 5000;

// Initialize VAPID on startup
const vapidKeys = await loadVapidKeys(VAPID_SUBJECT);
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

console.log(`VAPID public key: ${vapidKeys.publicKey}`);

// --- Debounce state ---

interface PendingNotification {
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

  const { machine, project } = buffer[0];
  const title = project ? `${machine} · ${project}` : machine;

  let body: string;
  let count = buffer.length;

  if (count === 1) {
    body = buffer[0].summary || "Task completed";
  } else {
    // Find the main (non-subagent) summary if available
    const main = buffer.find((n) => !n.agent_id);
    body = main?.summary
      ? `${count} tasks completed — ${main.summary}`
      : `${count} tasks completed`;
  }

  const payload = JSON.stringify({ title, body, event: "stop" });

  // Record in history
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    machine,
    project,
    summary: body,
    event: "stop",
    count,
  };
  await addHistoryEntry(entry);

  // Send push
  await sendPushToAll(payload, "normal");
}

async function sendPushToAll(payload: string, urgency: "high" | "normal") {
  const subs = await loadSubscriptions();
  const expired: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, {
          TTL: 3600,
          urgency,
        });
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          expired.push(sub.endpoint);
        } else {
          console.error(`Push failed for ${sub.endpoint}:`, err?.message);
        }
      }
    })
  );

  if (expired.length > 0) {
    const remaining = subs.filter((s) => !expired.includes(s.endpoint));
    await saveSubscriptions(remaining);
  }
}

// --- API Routes ---

app.get("/vapid-public-key", (c) => {
  return c.json({ publicKey: vapidKeys.publicKey });
});

app.post("/subscribe", async (c) => {
  const sub = await c.req.json();
  if (!sub?.endpoint || !sub?.keys) {
    return c.json({ error: "Invalid subscription" }, 400);
  }
  await addSubscription(sub);
  return c.json({ ok: true });
});

app.delete("/subscribe", async (c) => {
  const { endpoint } = await c.req.json();
  if (!endpoint) {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.post("/notify", async (c) => {
  const body = await c.req.json();
  const { machine, project, summary, event, agent_id, agent_type } = body;
  if (!machine) {
    return c.json({ error: "Missing machine" }, 400);
  }

  const eventType = (event || "stop").toLowerCase();

  // Notification events (waiting for input) bypass debounce — push immediately
  if (eventType === "notification") {
    const title = project
      ? `${machine} · ${project} · Waiting`
      : `${machine} · Waiting`;
    const payload = JSON.stringify({
      title,
      body: summary || "Waiting for input",
      event: "notification",
    });

    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      machine,
      project: project || "",
      summary: summary || "Waiting for input",
      event: "notification",
      count: 1,
    };
    await addHistoryEntry(entry);
    await sendPushToAll(payload, "high");

    return c.json({ ok: true, immediate: true });
  }

  // Stop events go through debounce
  const key = `${machine}:${project || "unknown"}`;
  const pending: PendingNotification = {
    machine,
    project: project || "",
    summary: summary || "Task completed",
    event: eventType,
    agent_id: agent_id || "",
    agent_type: agent_type || "",
  };

  if (!debounceBuffers.has(key)) {
    debounceBuffers.set(key, []);
  }
  debounceBuffers.get(key)!.push(pending);

  // Reset timer
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => flushDebounce(key), DEBOUNCE_MS));

  return c.json({ ok: true, debounced: true });
});

// --- History ---

app.get("/history", async (c) => {
  const history = await loadHistory();
  return c.json(history);
});

app.delete("/history", async (c) => {
  await clearHistory();
  return c.json({ ok: true });
});

// --- Static Files (PWA) ---

app.use("/*", serveStatic({ root: "./public" }));

// --- Start ---

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`Server running on http://localhost:${PORT}`);
