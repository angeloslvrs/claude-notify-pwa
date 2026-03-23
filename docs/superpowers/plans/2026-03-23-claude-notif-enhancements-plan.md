# Claude Notif Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add debounce grouping, notification history, multi-event hooks, project context, and urgency levels to claude-notif.

**Architecture:** Enhance existing server with in-memory debounce map, history persistence in JSON, richer hook payloads. All changes to existing files — no new files.

**Tech Stack:** Bun, Hono, web-push (unchanged)

**Spec:** `docs/superpowers/specs/2026-03-23-claude-notif-enhancements-design.md`

---

## File Structure (modifications only)

```
src/
  storage.ts              # ADD: history read/write/clear functions, HistoryEntry interface
  index.ts                # REWRITE: debounce logic, new /history endpoints, enhanced /notify
public/
  sw.js                   # MODIFY: event-aware notification formatting
  index.html              # MODIFY: add history view and clear button
hooks/
  notify.sh               # REWRITE: extract event, project, agent_id, agent_type
```

---

### Task 1: Enhanced Hook Script

**Files:**
- Modify: `hooks/notify.sh`

- [ ] **Step 1: Rewrite notify.sh**

Replace the entire file with:

```bash
#!/bin/bash
# hooks/notify.sh — Claude Code stop/notification hook
# Install: copy to ~/.claude/hooks/notify.sh
# Configure in ~/.claude/settings.json (see README)
INPUT=$(cat)

# Skip if this is a re-entrant stop hook (prevents infinite loops)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"' | tr '[:upper:]' '[:lower:]')
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 200 | tr '\n' ' ')
MACHINE=$(hostname)
PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' | xargs basename)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')

NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-http://localhost:7392}"

JSON=$(jq -nc \
  --arg machine "$MACHINE" \
  --arg project "$PROJECT" \
  --arg summary "$SUMMARY" \
  --arg event "$EVENT" \
  --arg agent_id "$AGENT_ID" \
  --arg agent_type "$AGENT_TYPE" \
  '{machine: $machine, project: $project, summary: $summary, event: $event, agent_id: $agent_id, agent_type: $agent_type}')

curl -s --max-time 5 -X POST "${NOTIF_SERVER}/notify" \
  -H 'Content-Type: application/json' \
  -d "$JSON" \
  > /dev/null 2>&1

exit 0
```

- [ ] **Step 2: Verify it parses correctly**

Run: `echo '{"hook_event_name":"Stop","last_assistant_message":"Test msg","cwd":"/Users/test/my-project","agent_id":"abc","agent_type":"general","stop_hook_active":false}' | bash hooks/notify.sh`
Expected: Silent exit (curl fails since server isn't running, but no errors from jq)

- [ ] **Step 3: Commit**

```bash
git add hooks/notify.sh
git commit -m "feat: enhance hook script with event, project, and agent fields"
```

---

### Task 2: Storage — History Functions

**Files:**
- Modify: `src/storage.ts` (append new functions after existing code)

- [ ] **Step 1: Add history interface and functions to storage.ts**

Append after the existing `removeSubscription` function (after line 62):

```typescript

// --- History ---

const HISTORY_PATH = `${DATA_DIR}/history.json`;
const MAX_HISTORY = 50;

export interface HistoryEntry {
  id: string;
  timestamp: string;
  machine: string;
  project: string;
  summary: string;
  event: string;
  count: number;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  await ensureDataDir();
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(await Bun.file(HISTORY_PATH).text());
  } catch {
    return [];
  }
}

export async function addHistoryEntry(entry: HistoryEntry) {
  const history = await loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  await Bun.write(HISTORY_PATH, JSON.stringify(history, null, 2));
}

export async function clearHistory() {
  await ensureDataDir();
  await Bun.write(HISTORY_PATH, "[]");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun build src/storage.ts --no-bundle --outdir /tmp/check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/storage.ts
git commit -m "feat: add history storage functions"
```

---

### Task 3: Server — Debounce + History + Enhanced /notify

**Files:**
- Modify: `src/index.ts` (full rewrite)

- [ ] **Step 1: Rewrite src/index.ts**

Replace the entire file with:

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun build src/index.ts --no-bundle --outdir /tmp/check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add debounce, history endpoints, and urgency-based routing"
```

---

### Task 4: Service Worker — Event-Aware Formatting

**Files:**
- Modify: `public/sw.js`

- [ ] **Step 1: Rewrite sw.js**

Replace the entire file with:

```javascript
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Claude Code";
  const isWaiting = data.event === "notification";
  const options = {
    body: data.body || "Task completed",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: isWaiting ? "claude-notif-waiting" : "claude-notif",
    renotify: true,
    requireInteraction: isWaiting,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
```

Key changes:
- Reads `data.event` to detect "notification" (waiting) events
- Uses different `tag` so waiting notifications don't replace stop notifications
- `requireInteraction: true` for waiting events so they persist until tapped

- [ ] **Step 2: Commit**

```bash
git add public/sw.js
git commit -m "feat: event-aware notification formatting in service worker"
```

---

### Task 5: PWA — History View

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Rewrite index.html**

Replace the entire file with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Notif</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#e94560">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
    }
    .container {
      max-width: 480px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }
    header {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    header p { color: #aaa; font-size: 0.85rem; }
    .status {
      margin: 1rem 0;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.9rem;
      text-align: center;
    }
    .status.pending { background: #2d2d44; color: #aaa; }
    .status.subscribed { background: #1b3a2d; color: #6fcf97; }
    .status.error { background: #3a1b1b; color: #f07070; }
    .actions { text-align: center; margin-bottom: 2rem; }
    button {
      background: #e94560;
      color: white;
      border: none;
      padding: 0.6rem 1.5rem;
      border-radius: 8px;
      font-size: 0.9rem;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.secondary {
      background: #2d2d44;
      color: #aaa;
      font-size: 0.8rem;
      padding: 0.4rem 1rem;
    }
    h2 {
      font-size: 1.1rem;
      margin-bottom: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .history-list { list-style: none; }
    .history-item {
      background: #16213e;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
    }
    .history-item .meta {
      font-size: 0.75rem;
      color: #888;
      margin-bottom: 0.25rem;
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .history-item .summary {
      font-size: 0.85rem;
      color: #ccc;
      line-height: 1.4;
    }
    .badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
    }
    .badge.machine { background: #2d2d44; color: #7ec8e3; }
    .badge.project { background: #2d2d44; color: #b8b8d1; }
    .badge.waiting { background: #3a2a1b; color: #f0a070; }
    .badge.count { background: #2a1b3a; color: #c070f0; }
    .empty { text-align: center; color: #555; padding: 2rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Claude Notif</h1>
      <p>Push notifications from Claude Code</p>
    </header>
    <div id="status" class="status pending">Checking status...</div>
    <div class="actions">
      <button id="btn" disabled>Enable Notifications</button>
    </div>
    <h2>History</h2>
    <ul class="history-list" id="historyList">
      <li class="empty">Loading...</li>
    </ul>
    <div class="actions" id="clearWrap" style="display:none">
      <button class="secondary" id="clearBtn">Clear History</button>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const btnEl = document.getElementById("btn");
    const historyList = document.getElementById("historyList");
    const clearBtn = document.getElementById("clearBtn");
    const clearWrap = document.getElementById("clearWrap");

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = "status " + cls;
    }

    // --- Subscription ---

    async function init() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("Push notifications not supported in this browser", "error");
        return;
      }

      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();

      if (sub) {
        setStatus("Subscribed and receiving notifications", "subscribed");
        btnEl.textContent = "Unsubscribe";
        btnEl.disabled = false;
        btnEl.onclick = () => unsubscribe(reg, sub);
      } else {
        setStatus("Not subscribed", "pending");
        btnEl.textContent = "Enable Notifications";
        btnEl.disabled = false;
        btnEl.onclick = () => subscribe(reg);
      }

      loadHistory();
    }

    async function subscribe(reg) {
      btnEl.disabled = true;
      try {
        const resp = await fetch("/vapid-public-key");
        const { publicKey } = await resp.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await fetch("/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
        setStatus("Subscribed and receiving notifications", "subscribed");
        btnEl.textContent = "Unsubscribe";
        btnEl.disabled = false;
        btnEl.onclick = () => unsubscribe(reg, sub);
      } catch (err) {
        setStatus("Failed to subscribe: " + err.message, "error");
        btnEl.disabled = false;
      }
    }

    async function unsubscribe(reg, sub) {
      btnEl.disabled = true;
      try {
        await sub.unsubscribe();
        await fetch("/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        setStatus("Unsubscribed", "pending");
        btnEl.textContent = "Enable Notifications";
        btnEl.disabled = false;
        btnEl.onclick = () => subscribe(reg);
      } catch (err) {
        setStatus("Failed to unsubscribe: " + err.message, "error");
        btnEl.disabled = false;
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }

    // --- History ---

    async function loadHistory() {
      try {
        const resp = await fetch("/history");
        const entries = await resp.json();
        renderHistory(entries);
      } catch {
        historyList.innerHTML = '<li class="empty">Failed to load history</li>';
      }
    }

    function renderHistory(entries) {
      if (entries.length === 0) {
        historyList.innerHTML = '<li class="empty">No notifications yet</li>';
        clearWrap.style.display = "none";
        return;
      }
      clearWrap.style.display = "";
      historyList.innerHTML = entries.map((e) => {
        const time = new Date(e.timestamp).toLocaleString();
        const badges = [
          `<span class="badge machine">${esc(e.machine)}</span>`,
          e.project ? `<span class="badge project">${esc(e.project)}</span>` : "",
          e.event === "notification" ? '<span class="badge waiting">waiting</span>' : "",
          e.count > 1 ? `<span class="badge count">${e.count} tasks</span>` : "",
        ].filter(Boolean).join("");
        return `<li class="history-item">
          <div class="meta">${badges} <span>${time}</span></div>
          <div class="summary">${esc(e.summary)}</div>
        </li>`;
      }).join("");
    }

    function esc(s) {
      const d = document.createElement("div");
      d.textContent = s || "";
      return d.innerHTML;
    }

    clearBtn.onclick = async () => {
      await fetch("/history", { method: "DELETE" });
      loadHistory();
    };

    init();
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add notification history view to PWA"
```

---

### Task 6: Update Hook on This Machine + Settings

**Files:**
- Modify: `~/.claude/hooks/notify.sh` (copy from project)
- Modify: `~/.claude/settings.json` (add Notification hook)

- [ ] **Step 1: Copy updated hook script**

Run: `cp hooks/notify.sh ~/.claude/hooks/notify.sh`

- [ ] **Step 2: Add Notification hook to settings.json**

In `~/.claude/settings.json`, the `Notification` key already exists in `hooks` with existing entries. Append a new object to the end of the `Notification` array:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "~/.claude/hooks/notify.sh",
      "timeout": 10
    }
  ]
}
```

If the `Notification` key does not exist in `hooks`, create it as a new array with this single entry.

- [ ] **Step 3: Commit project files**

```bash
git add -A
git commit -m "chore: finalize enhancements"
```

---

### Task 7: Smoke Test

No files created. Verifies everything works end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run src/index.ts &`
Expected: `Server running on http://localhost:7392`

- [ ] **Step 2: Test stop event with project context (debounced)**

Run: `curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-mac","project":"my-api","summary":"Built the API","event":"stop"}'`
Expected: `{"ok":true,"debounced":true}`

- [ ] **Step 3: Wait 6 seconds, then check history**

Run: `sleep 6 && curl -s http://localhost:7392/history | jq '.[0]'`
Expected: Entry with `machine: "test-mac"`, `project: "my-api"`, `count: 1`

- [ ] **Step 4: Test notification event (immediate, high urgency)**

Run: `curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-mac","project":"my-api","summary":"Permission needed","event":"notification"}'`
Expected: `{"ok":true,"immediate":true}`

- [ ] **Step 5: Test debounce grouping (rapid fire)**

Run:
```bash
curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-mac","project":"my-api","summary":"Subagent 1","event":"stop","agent_id":"a1","agent_type":"general"}'
curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-mac","project":"my-api","summary":"Subagent 2","event":"stop","agent_id":"a2","agent_type":"general"}'
curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-mac","project":"my-api","summary":"Main task done","event":"stop"}'
```
Expected: All return `{"ok":true,"debounced":true}`. After 5 seconds, one collapsed notification sent.

- [ ] **Step 6: Verify collapsed history entry**

Run: `sleep 6 && curl -s http://localhost:7392/history | jq '.[0]'`
Expected: Entry with `count: 3`, summary containing "3 tasks completed"

- [ ] **Step 7: Test clear history**

Run: `curl -s -X DELETE http://localhost:7392/history && curl -s http://localhost:7392/history`
Expected: `{"ok":true}` then `[]`

- [ ] **Step 8: Test hook script**

Run: `echo '{"hook_event_name":"Stop","last_assistant_message":"Test from hook","cwd":"/Users/test/my-project","stop_hook_active":false}' | CLAUDE_NOTIF_SERVER=http://localhost:7392 ./hooks/notify.sh`
Expected: Silent exit. Server receives notification for project "my-project".

- [ ] **Step 9: Kill server**

Run: `kill %1 2>/dev/null`

- [ ] **Step 10: Commit any fixes**

```bash
git add -A
git commit -m "fix: smoke test fixes" # only if changes were needed
```
