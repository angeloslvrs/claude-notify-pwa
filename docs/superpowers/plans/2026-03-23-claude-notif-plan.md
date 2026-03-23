# Claude Code Push Notification Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Web Push notification server that alerts your phone when Claude Code finishes a task on any machine.

**Architecture:** Bun + Hono server with a web-push library. PWA with service worker subscribes to push. Claude Code stop hook curls the server. Docker Compose for deployment.

**Tech Stack:** Bun, Hono, web-push, Docker, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-23-claude-notif-design.md`

---

## File Structure

```
claude-notif/
  package.json              # Dependencies: hono, web-push, @types/web-push
  tsconfig.json             # Bun TypeScript config
  src/
    index.ts                # Hono server — all routes, VAPID init, push sending
    storage.ts              # Read/write subscriptions.json and vapid.json
  public/
    index.html              # PWA — subscribe button, status display
    sw.js                   # Service worker — push event handler
    manifest.json           # PWA manifest for installability
    icon.svg                # App icon for PWA and notifications
  docker-compose.yml        # Single service, port 7392, volume mount
  Dockerfile                # oven/bun:alpine, install deps, serve
  hooks/
    notify.sh               # Claude Code stop hook script
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "claude-notif",
  "version": "1.0.0",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts"
  },
  "dependencies": {
    "hono": "^4",
    "web-push": "^3"
  },
  "devDependencies": {
    "@types/web-push": "^3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `bun install`
Expected: `node_modules` created, `bun.lock` generated

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json bun.lock
git commit -m "feat: scaffold project with hono and web-push deps"
```

---

### Task 2: Storage Layer

**Files:**
- Create: `src/storage.ts`

This module handles reading/writing `data/subscriptions.json` and `data/vapid.json`. All file I/O is isolated here.

- [ ] **Step 1: Write storage module**

```typescript
// src/storage.ts
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import webpush from "web-push";

const DATA_DIR = "./data";
const SUBS_PATH = `${DATA_DIR}/subscriptions.json`;
const VAPID_PATH = `${DATA_DIR}/vapid.json`;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type PushSubscription = webpush.PushSubscription;

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function loadVapidKeys(subject: string): Promise<VapidKeys> {
  await ensureDataDir();
  if (existsSync(VAPID_PATH)) {
    return JSON.parse(await Bun.file(VAPID_PATH).text());
  }
  const keys = webpush.generateVAPIDKeys();
  const vapid: VapidKeys = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  await Bun.write(VAPID_PATH, JSON.stringify(vapid, null, 2));
  return vapid;
}

export async function loadSubscriptions(): Promise<PushSubscription[]> {
  await ensureDataDir();
  if (!existsSync(SUBS_PATH)) return [];
  try {
    return JSON.parse(await Bun.file(SUBS_PATH).text());
  } catch {
    return [];
  }
}

export async function saveSubscriptions(subs: PushSubscription[]) {
  await ensureDataDir();
  await Bun.write(SUBS_PATH, JSON.stringify(subs, null, 2));
}

export async function addSubscription(sub: PushSubscription) {
  const subs = await loadSubscriptions();
  // Avoid duplicates by endpoint
  if (subs.some((s) => s.endpoint === sub.endpoint)) return;
  subs.push(sub);
  await saveSubscriptions(subs);
}

export async function removeSubscription(endpoint: string) {
  const subs = await loadSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  await saveSubscriptions(filtered);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun build src/storage.ts --no-bundle --outdir /tmp/check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/storage.ts
git commit -m "feat: add storage layer for subscriptions and VAPID keys"
```

---

### Task 3: Hono Server

**Files:**
- Create: `src/index.ts`

All routes: `/notify`, `/subscribe`, `/vapid-public-key`, and static file serving for the PWA.

- [ ] **Step 1: Write the server**

```typescript
// src/index.ts
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

// Initialize VAPID on startup
const vapidKeys = await loadVapidKeys(VAPID_SUBJECT);
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

console.log(`VAPID public key: ${vapidKeys.publicKey}`);

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

  // Prune expired subscriptions
  if (expired.length > 0) {
    const remaining = subs.filter((s) => !expired.includes(s.endpoint));
    await saveSubscriptions(remaining);
  }

  return c.json({ ok: true, sent: subs.length - expired.length, pruned: expired.length });
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

Run: `bun build src/index.ts --no-bundle --outdir /tmp/check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Hono server with notify, subscribe, and static routes"
```

---

### Task 4: PWA — Service Worker

**Files:**
- Create: `public/sw.js`

Handles incoming push events and notification clicks.

- [ ] **Step 1: Write the service worker**

```javascript
// public/sw.js
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Claude Code";
  const options = {
    body: data.body || "Task completed",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: "claude-notif",
    renotify: true,
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

- [ ] **Step 2: Commit**

```bash
git add public/sw.js
git commit -m "feat: add service worker for push notifications"
```

---

### Task 5: PWA — HTML and Manifest

**Files:**
- Create: `public/index.html`
- Create: `public/manifest.json`

- [ ] **Step 1: Create icon as inline SVG data URI**

Since we need an icon for the PWA manifest and notifications, create a simple SVG icon and reference it. Create `public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" fill="none">
  <rect width="192" height="192" rx="40" fill="#e94560"/>
  <path d="M96 40c-30.9 0-56 25.1-56 56 0 18.7 9.2 35.2 23.3 45.4L60 160l20.3-8.1C85.3 154 90.5 155 96 155c30.9 0 56-25.1 56-56s-25.1-56-56-56z" fill="white" opacity="0.9"/>
  <circle cx="76" cy="92" r="8" fill="#e94560"/>
  <circle cx="96" cy="92" r="8" fill="#e94560"/>
  <circle cx="116" cy="92" r="8" fill="#e94560"/>
</svg>
```

Update `manifest.json` icons to use SVG (no PNG generation needed):

- [ ] **Step 2: Write manifest.json**

```json
{
  "name": "Claude Notif",
  "short_name": "ClaudeNotif",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#e94560",
  "icons": [
    {
      "src": "/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    }
  ]
}
```

- [ ] **Step 2: Write index.html**

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
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .status {
      margin: 1.5rem 0;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .status.pending { background: #2d2d44; color: #aaa; }
    .status.subscribed { background: #1b3a2d; color: #6fcf97; }
    .status.error { background: #3a1b1b; color: #f07070; }
    button {
      background: #e94560;
      color: white;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude Notif</h1>
    <p>Push notifications from Claude Code</p>
    <div id="status" class="status pending">Checking status...</div>
    <button id="btn" disabled>Enable Notifications</button>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const btnEl = document.getElementById("btn");

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = "status " + cls;
    }

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

    init();
  </script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/manifest.json public/icon.svg
git commit -m "feat: add PWA with subscribe/unsubscribe UI and icon"
```

---

### Task 6: Docker Setup

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM oven/bun:alpine AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
EXPOSE 7392
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 2: Write docker-compose.yml**

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
    restart: unless-stopped
```

- [ ] **Step 3: Write .dockerignore**

```
node_modules
data
.git
docs
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: add Docker setup for deployment"
```

---

### Task 7: Claude Code Hook Script

**Files:**
- Create: `hooks/notify.sh`

- [ ] **Step 1: Write the hook script**

```bash
#!/bin/bash
# hooks/notify.sh — Claude Code stop hook
# Install: copy to ~/.claude/hooks/notify.sh
# Configure in ~/.claude/settings.json (see README)
INPUT=$(cat)
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 200 | tr '\n' ' ')
MACHINE=$(hostname)

# Change this to your server's LAN IP
NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-http://localhost:7392}"

JSON=$(jq -nc --arg machine "$MACHINE" --arg summary "$SUMMARY" '{machine: $machine, summary: $summary}')

curl -s --max-time 5 -X POST "${NOTIF_SERVER}/notify" \
  -H 'Content-Type: application/json' \
  -d "$JSON" \
  > /dev/null 2>&1

exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x hooks/notify.sh`

- [ ] **Step 3: Commit**

```bash
git add hooks/notify.sh
git commit -m "feat: add Claude Code stop hook script"
```

---

### Task 8: Manual Smoke Test

No files created. This verifies everything works end-to-end locally.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Expected: `Server running on http://localhost:7392` and VAPID key printed

- [ ] **Step 2: Verify static serving**

Run: `curl -s http://localhost:7392/ | head -5`
Expected: HTML response starting with `<!DOCTYPE html>`

- [ ] **Step 3: Verify VAPID key endpoint**

Run: `curl -s http://localhost:7392/vapid-public-key`
Expected: `{"publicKey":"B..."}`

- [ ] **Step 4: Test notify endpoint (no subscribers)**

Run: `curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test-machine","summary":"Hello from test"}'`
Expected: `{"ok":true,"sent":0,"pruned":0}`

- [ ] **Step 5: Verify data directory was created**

Run: `ls data/`
Expected: `subscriptions.json  vapid.json` (or just `vapid.json` if no subscriptions yet)

- [ ] **Step 6: Test hook script locally**

Run: `echo '{"last_assistant_message":"Test notification from hook"}' | CLAUDE_NOTIF_SERVER=http://localhost:7392 ./hooks/notify.sh`
Expected: No output (silent), server logs the notification

- [ ] **Step 7: Commit any fixes if needed, then final commit**

```bash
git add -A
git commit -m "chore: finalize project for deployment"
```

---

### Task 9: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# Claude Notif

Push notifications from Claude Code to your phone via Web Push.

## Quick Start

1. **Deploy:**
   ```bash
   # Edit docker-compose.yml to set VAPID_SUBJECT to your email
   docker compose up -d --build
   ```

2. **Subscribe on your phone:**
   - Open `https://your-domain.com` in your phone's browser
   - Tap "Enable Notifications"
   - Add to home screen for app-like experience

3. **Configure Claude Code hook:**

   Copy `hooks/notify.sh` to `~/.claude/hooks/notify.sh` and set your server IP:
   ```bash
   export CLAUDE_NOTIF_SERVER=http://<your-server-lan-ip>:7392
   ```

   Add to `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "~/.claude/hooks/notify.sh",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

## Development

```bash
bun install
bun run dev
```

## Reverse Proxy

The PWA requires HTTPS (service workers need a secure context). Configure your reverse proxy to:
- Terminate TLS
- Forward `/`, `/subscribe`, `/vapid-public-key` to port 7392
- Do NOT forward `/notify` (keep it LAN-only)

## Architecture

Claude Code hook --> POST /notify (LAN) --> Server --> Web Push --> Phone PWA
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions"
```
