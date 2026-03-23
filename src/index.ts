import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import webpush from "web-push";
import {
  loadVapidKeys,
  loadSubscriptions,
  saveSubscriptions,
  addSubscription,
  removeSubscription,
} from "./storage";

const app = new Hono();

const PORT = 7392;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:test@example.com";

const vapidKeys = await loadVapidKeys(VAPID_SUBJECT);
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

console.log(`VAPID public key: ${vapidKeys.publicKey}`);

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
  const { machine, summary } = await c.req.json();
  if (!machine) {
    return c.json({ error: "Missing machine" }, 400);
  }

  const payload = JSON.stringify({
    title: machine,
    body: summary || "Task completed",
  });

  const subs = await loadSubscriptions();
  const expired: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600 });
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

  return c.json({ ok: true, sent: subs.length - expired.length, pruned: expired.length });
});

app.use("/*", serveStatic({ root: "./public" }));

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`Server running on http://localhost:${PORT}`);
