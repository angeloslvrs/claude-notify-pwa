# Claude Notif v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign PWA with Liquid Glass aesthetic, add permission round-trip (Allow/Always from phone), clean up notification formatting.

**Architecture:** UI-only changes (HTML/CSS/manifest) are independent from the permission system (new hook + server endpoints + SW changes). Tasks ordered so each produces a working commit.

**Tech Stack:** Bun, Hono, web-push (unchanged)

**Spec:** `docs/superpowers/specs/2026-03-23-claude-notif-v2-design.md`

---

## File Structure

```
public/
  index.html              # REWRITE: Liquid Glass design + permission prompt page
  sw.js                   # MODIFY: handle permission notifications, open /?permission=id
  manifest.json           # MODIFY: short_name → "CC"
hooks/
  notify.sh               # MODIFY: add markdown stripping + smart truncation
  permission.sh           # NEW: PermissionRequest hook with polling
src/
  index.ts                # MODIFY: add /permission endpoints + pending request map
```

---

### Task 1: Manifest + Notification Formatting

**Files:**
- Modify: `public/manifest.json`
- Modify: `hooks/notify.sh`

- [ ] **Step 1: Update manifest.json short_name**

Replace entire file:

```json
{
  "name": "Claude Notif",
  "short_name": "CC",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#0a84ff",
  "icons": [
    {
      "src": "/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    }
  ]
}
```

- [ ] **Step 2: Update notify.sh with markdown stripping and smart truncation**

Replace entire file:

```bash
#!/bin/bash
# hooks/notify.sh — Claude Code stop/notification hook
# Install: copy to ~/.claude/hooks/notify.sh
INPUT=$(cat)

# Skip re-entrant stop hooks
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"' | tr '[:upper:]' '[:lower:]')
RAW=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

# Strip markdown: backticks, headers, bold/italic, links, blockquotes, list markers
# Note: macOS sed requires -E for extended regex
CLEAN=$(echo "$RAW" | sed -E \
  -e 's/```[^`]*```//g' \
  -e 's/`([^`]*)`/\1/g' \
  -e 's/^#{1,6} //g' \
  -e 's/\*\*([^*]*)\*\*/\1/g' \
  -e 's/\*([^*]*)\*/\1/g' \
  -e 's/__([^_]*)__/\1/g' \
  -e 's/_([^_]*)_/\1/g' \
  -e 's/\[([^]]*)\]\([^)]*\)/\1/g' \
  -e 's/^> //g' \
  -e 's/^- //g' \
  -e 's/^[0-9]+\. //g' \
  | tr '\n' ' ' | sed 's/  */ /g' | sed 's/^ *//;s/ *$//')

# Smart truncation: first sentence, cap at 200 chars
SUMMARY=$(echo "$CLEAN" | sed 's/\. .*/\./' | head -c 200)

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

- [ ] **Step 3: Test markdown stripping**

Run: `echo '{"hook_event_name":"Stop","last_assistant_message":"I **built** the `push` endpoint. It works great.","cwd":"/Users/test/my-project","stop_hook_active":false}' | bash hooks/notify.sh`
Expected: Silent exit. (To verify stripping, temporarily add `echo "$SUMMARY"` before the curl line)

- [ ] **Step 4: Commit**

```bash
git add public/manifest.json hooks/notify.sh
git commit -m "feat: update manifest short_name to CC, add markdown stripping to notify hook"
```

---

### Task 2: Liquid Glass PWA Redesign

**Files:**
- Modify: `public/index.html` (full rewrite)

- [ ] **Step 1: Rewrite index.html with Liquid Glass design**

Replace entire file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Claude Notif</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0a84ff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #000000;
      --glass: rgba(255,255,255,0.06);
      --glass-border: rgba(255,255,255,0.1);
      --glass-hover: rgba(255,255,255,0.1);
      --text: #f5f5f7;
      --text-secondary: rgba(255,255,255,0.5);
      --text-tertiary: rgba(255,255,255,0.35);
      --green: #30d158;
      --blue: #0a84ff;
      --red: #ff453a;
      --orange: #ff9f0a;
      --cyan: #64d2ff;
      --separator: rgba(255,255,255,0.06);
      --radius: 14px;
      --radius-sm: 10px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      letter-spacing: -0.01em;
    }
    .container {
      max-width: 480px;
      margin: 0 auto;
      padding: 3rem 1.25rem 2rem;
      padding-top: max(3rem, env(safe-area-inset-top));
    }
    header { text-align: center; margin-bottom: 1.75rem; }
    h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.03em; }
    header p { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.2rem; }
    .glass {
      background: var(--glass);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
    }
    .status-card {
      padding: 0.85rem 1rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.active { background: var(--green); box-shadow: 0 0 8px rgba(48,209,88,0.4); }
    .status-dot.inactive { background: var(--text-tertiary); }
    .status-text { font-size: 0.85rem; color: var(--text-secondary); }
    .actions { text-align: center; margin-bottom: 2rem; }
    button {
      font-family: inherit;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
      -webkit-tap-highlight-color: transparent;
    }
    .btn-primary {
      background: var(--glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      color: var(--blue);
      padding: 0.65rem 1.75rem;
      border-radius: 12px;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .btn-primary:active { background: var(--glass-hover); }
    .btn-primary:disabled { color: var(--text-tertiary); }
    .btn-secondary {
      background: transparent;
      color: var(--text-tertiary);
      padding: 0.5rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 0.8rem;
    }
    .btn-secondary:active { background: var(--glass); }
    .btn-allow {
      background: rgba(48,209,88,0.15);
      color: var(--green);
      padding: 0.85rem 2rem;
      border-radius: 14px;
      font-size: 1rem;
      font-weight: 600;
      flex: 1;
    }
    .btn-always {
      background: rgba(10,132,255,0.15);
      color: var(--blue);
      padding: 0.85rem 2rem;
      border-radius: 14px;
      font-size: 1rem;
      font-weight: 600;
      flex: 1;
    }
    .section-header {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.6rem;
      padding-left: 0.25rem;
    }
    .history-list { list-style: none; }
    .history-group {
      overflow: hidden;
      margin-bottom: 0.75rem;
    }
    .history-item {
      padding: 0.75rem 1rem;
    }
    .history-item + .history-item {
      border-top: 1px solid var(--separator);
    }
    .history-meta {
      display: flex;
      gap: 0.4rem;
      align-items: center;
      margin-bottom: 0.3rem;
      flex-wrap: wrap;
    }
    .history-summary {
      font-size: 0.82rem;
      color: rgba(255,255,255,0.6);
      line-height: 1.4;
    }
    .badge {
      display: inline-block;
      padding: 0.1rem 0.45rem;
      border-radius: 5px;
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .badge-machine { background: rgba(100,210,255,0.12); color: var(--cyan); }
    .badge-project { background: var(--glass); color: var(--text-secondary); }
    .badge-waiting { background: rgba(255,159,10,0.12); color: var(--orange); }
    .badge-count { background: rgba(175,130,255,0.12); color: #af82ff; }
    .history-time {
      font-size: 0.65rem;
      color: var(--text-tertiary);
      margin-left: auto;
    }
    .empty {
      text-align: center;
      color: var(--text-tertiary);
      padding: 2.5rem 1rem;
      font-size: 0.85rem;
    }
    .clear-wrap { text-align: center; margin-top: 1rem; }

    /* Permission prompt */
    #permissionView { display: none; }
    #permissionView.active { display: block; }
    #mainView.hidden { display: none; }
    .permission-card {
      padding: 1.5rem;
      text-align: center;
    }
    .permission-card .tool-label {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }
    .permission-card .tool-action {
      font-size: 1.1rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.3rem;
    }
    .permission-card .tool-context {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-bottom: 1.5rem;
    }
    .permission-buttons {
      display: flex;
      gap: 0.75rem;
    }
    .permission-status {
      font-size: 0.9rem;
      color: var(--green);
      padding: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Claude Notif</h1>
      <p>Push notifications from Claude Code</p>
    </header>

    <!-- Main View -->
    <div id="mainView">
      <div class="status-card glass" id="statusCard">
        <div class="status-dot inactive" id="statusDot"></div>
        <span class="status-text" id="statusText">Checking...</span>
      </div>
      <div class="actions">
        <button class="btn-primary" id="btn" disabled>Enable Notifications</button>
      </div>
      <div class="section-header">History</div>
      <ul class="history-list" id="historyList">
        <li class="empty">Loading...</li>
      </ul>
      <div class="clear-wrap" id="clearWrap" style="display:none">
        <button class="btn-secondary" id="clearBtn">Clear History</button>
      </div>
    </div>

    <!-- Permission Prompt View -->
    <div id="permissionView">
      <div class="permission-card glass" id="permissionCard">
        <div class="tool-label" id="permToolLabel">Permission Request</div>
        <div class="tool-action" id="permToolAction">Loading...</div>
        <div class="tool-context" id="permToolContext"></div>
        <div class="permission-buttons" id="permButtons">
          <button class="btn-allow" onclick="respondPermission('allow')">Allow</button>
          <button class="btn-always" onclick="respondPermission('always')">Always</button>
        </div>
        <div class="permission-status" id="permStatus" style="display:none"></div>
      </div>
    </div>
  </div>

  <script>
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const btnEl = document.getElementById("btn");
    const historyList = document.getElementById("historyList");
    const clearBtn = document.getElementById("clearBtn");
    const clearWrap = document.getElementById("clearWrap");
    const mainView = document.getElementById("mainView");
    const permissionView = document.getElementById("permissionView");

    let currentPermissionId = null;

    // --- Check for permission prompt ---
    const params = new URLSearchParams(window.location.search);
    const permId = params.get("permission");
    if (permId) {
      showPermissionView(permId);
    }

    function setStatus(text, active) {
      statusText.textContent = text;
      statusDot.className = "status-dot " + (active ? "active" : "inactive");
    }

    // --- Subscription ---
    async function init() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("Push not supported", false);
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        setStatus("Receiving notifications", true);
        btnEl.textContent = "Unsubscribe";
        btnEl.disabled = false;
        btnEl.onclick = () => unsubscribe(reg, sub);
      } else {
        setStatus("Not subscribed", false);
        btnEl.textContent = "Enable Notifications";
        btnEl.disabled = false;
        btnEl.onclick = () => subscribe(reg);
      }
      if (!permId) loadHistory();
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
        setStatus("Receiving notifications", true);
        btnEl.textContent = "Unsubscribe";
        btnEl.disabled = false;
        btnEl.onclick = () => unsubscribe(reg, sub);
      } catch (err) {
        setStatus("Subscribe failed: " + err.message, false);
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
        setStatus("Not subscribed", false);
        btnEl.textContent = "Enable Notifications";
        btnEl.disabled = false;
        btnEl.onclick = () => subscribe(reg);
      } catch (err) {
        setStatus("Unsubscribe failed: " + err.message, false);
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
        historyList.innerHTML = '<li class="empty">Failed to load</li>';
      }
    }

    function renderHistory(entries) {
      if (!entries.length) {
        historyList.innerHTML = '<li class="empty">No notifications yet</li>';
        clearWrap.style.display = "none";
        return;
      }
      clearWrap.style.display = "";
      historyList.innerHTML = entries.map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
        const badges = [
          '<span class="badge badge-machine">' + esc(e.machine) + "</span>",
          e.project ? '<span class="badge badge-project">' + esc(e.project) + "</span>" : "",
          e.event === "notification" ? '<span class="badge badge-waiting">waiting</span>' : "",
          e.count > 1 ? '<span class="badge badge-count">' + e.count + " tasks</span>" : "",
        ].filter(Boolean).join("");
        return '<li class="history-item"><div class="history-meta">' +
          badges + '<span class="history-time">' + time + "</span></div>" +
          '<div class="history-summary">' + esc(e.summary) + "</div></li>";
      }).join("");
      // Wrap all items in a glass group
      historyList.innerHTML = '<div class="history-group glass">' + historyList.innerHTML + "</div>";
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

    // --- Permission Prompt ---
    async function showPermissionView(id) {
      currentPermissionId = id;
      mainView.classList.add("hidden");
      permissionView.classList.add("active");

      try {
        const resp = await fetch("/permission/" + id);
        if (!resp.ok) throw new Error("expired");
        const data = await resp.json();
        if (data.status === "answered") {
          showPermissionResult("Already responded");
          return;
        }
        document.getElementById("permToolLabel").textContent = data.tool_name || "Permission Request";
        document.getElementById("permToolAction").textContent = data.tool_summary || data.tool_name;
        document.getElementById("permToolContext").textContent =
          (data.machine || "") + (data.project ? " · " + data.project : "");
      } catch {
        showPermissionResult("Permission request expired");
      }
    }

    async function respondPermission(decision) {
      const btns = document.getElementById("permButtons");
      btns.style.display = "none";
      try {
        await fetch("/permission/" + currentPermissionId + "/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        showPermissionResult(decision === "always" ? "Always allowed" : "Allowed");
      } catch {
        showPermissionResult("Failed to respond");
      }
    }

    function showPermissionResult(msg) {
      const btns = document.getElementById("permButtons");
      const status = document.getElementById("permStatus");
      btns.style.display = "none";
      status.style.display = "";
      status.textContent = msg;
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    }

    init();
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: Liquid Glass PWA redesign with permission prompt page"
```

---

### Task 3: Service Worker — Permission Support

**Files:**
- Modify: `public/sw.js`

- [ ] **Step 1: Rewrite sw.js**

Replace entire file:

```javascript
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Claude Code";
  const isWaiting = data.event === "notification";
  const isPermission = data.event === "permission";

  const options = {
    body: data.body || "Task completed",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { event: data.event, permissionId: data.permissionId || null },
    tag: isPermission ? "claude-notif-permission"
       : isWaiting ? "claude-notif-waiting"
       : "claude-notif",
    renotify: true,
    requireInteraction: isWaiting || isPermission,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.permissionId
    ? "/?permission=" + data.permissionId
    : "/";

  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      // If PWA is open, navigate it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "navigate" in client) {
          return client.navigate(url).then(() => client.focus());
        }
      }
      return clients.openWindow(url);
    })
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add public/sw.js
git commit -m "feat: service worker handles permission notifications with deep linking"
```

---

### Task 4: Server — Permission Endpoints

**Files:**
- Modify: `src/index.ts` (add permission routes and state)

- [ ] **Step 1: Add permission state and endpoints to index.ts**

Add the following AFTER the history routes (after line 202 `app.delete("/history"...`) and BEFORE the static files middleware:

```typescript

// --- Permission Round-Trip ---

interface PendingPermission {
  id: string;
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

// Auto-expire old entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingPermissions) {
    if (now - p.timestamp > 120_000) pendingPermissions.delete(id);
  }
}, 30_000);

app.post("/permission", async (c) => {
  const body = await c.req.json();
  const { id, machine, project, tool_name, tool_summary, permission_suggestions } = body;
  if (!id || !tool_name) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  const pending: PendingPermission = {
    id,
    machine: machine || "",
    project: project || "",
    tool_name,
    tool_summary: tool_summary || tool_name,
    permission_suggestions: permission_suggestions || [],
    status: "pending",
    timestamp: Date.now(),
  };
  pendingPermissions.set(id, pending);

  // Send push notification
  const title = project ? `${machine} · ${project}` : machine || "Claude Code";
  const payload = JSON.stringify({
    title,
    body: tool_summary || tool_name,
    event: "permission",
    permissionId: id,
  });
  await sendPushToAll(payload, "high");

  return c.json({ ok: true, id });
});

app.get("/permission/:id", (c) => {
  const id = c.req.param("id");
  const p = pendingPermissions.get(id);
  if (!p) {
    return c.json({ error: "Not found or expired" }, 404);
  }
  if (p.status === "answered") {
    const resp: any = { status: "answered", decision: p.decision };
    if (p.decision === "always" && p.permission_suggestions.length > 0) {
      resp.permission_suggestions = p.permission_suggestions;
    }
    return c.json(resp);
  }
  return c.json({
    status: "pending",
    tool_name: p.tool_name,
    tool_summary: p.tool_summary,
    machine: p.machine,
    project: p.project,
  });
});

app.post("/permission/:id/respond", async (c) => {
  const id = c.req.param("id");
  const { decision } = await c.req.json();
  const p = pendingPermissions.get(id);
  if (!p) {
    return c.json({ error: "Not found or expired" }, 404);
  }
  if (p.status === "answered") {
    return c.json({ error: "Already answered" }, 409);
  }
  p.status = "answered";
  p.decision = decision;
  return c.json({ ok: true });
});
```

- [ ] **Step 2: Verify it compiles**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun build src/index.ts --no-bundle --outdir /tmp/check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add permission round-trip endpoints with auto-expiry"
```

---

### Task 5: Permission Hook Script

**Files:**
- Create: `hooks/permission.sh`

- [ ] **Step 1: Write permission.sh**

```bash
#!/bin/bash
# hooks/permission.sh — Claude Code PermissionRequest hook
# Sends permission request to phone, polls for response.
# Install: copy to ~/.claude/hooks/permission.sh
INPUT=$(cat)

NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-http://localhost:7392}"
MACHINE=$(hostname)
PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' | xargs basename)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {}')
PERM_SUGGESTIONS=$(echo "$INPUT" | jq -c '.permission_suggestions // []')

# Format tool summary
case "$TOOL_NAME" in
  Edit)   TOOL_SUMMARY="Edit $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Write)  TOOL_SUMMARY="Write $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Read)   TOOL_SUMMARY="Read $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Bash)   TOOL_SUMMARY="Run: $(echo "$TOOL_INPUT" | jq -r '.command // empty' | head -c 100)" ;;
  *)      TOOL_SUMMARY="$TOOL_NAME" ;;
esac

# Generate unique ID
REQ_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# POST permission request to server
POST_JSON=$(jq -nc \
  --arg id "$REQ_ID" \
  --arg machine "$MACHINE" \
  --arg project "$PROJECT" \
  --arg tool_name "$TOOL_NAME" \
  --arg tool_summary "$TOOL_SUMMARY" \
  --argjson permission_suggestions "$PERM_SUGGESTIONS" \
  '{id: $id, machine: $machine, project: $project, tool_name: $tool_name, tool_summary: $tool_summary, permission_suggestions: $permission_suggestions}')

RESULT=$(curl -s --max-time 5 -X POST "${NOTIF_SERVER}/permission" \
  -H 'Content-Type: application/json' \
  -d "$POST_JSON" 2>/dev/null)

# If POST failed, fall through to terminal prompt
if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  exit 0
fi

# Poll for response (60s max, every 2s)
ELAPSED=0
while [ $ELAPSED -lt 60 ]; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))

  RESP=$(curl -s --max-time 3 "${NOTIF_SERVER}/permission/${REQ_ID}" 2>/dev/null)
  STATUS=$(echo "$RESP" | jq -r '.status // empty')

  if [ "$STATUS" = "answered" ]; then
    DECISION=$(echo "$RESP" | jq -r '.decision // empty')

    if [ "$DECISION" = "always" ]; then
      # Include permission_suggestions for persistence
      SUGGESTIONS=$(echo "$RESP" | jq -c '.permission_suggestions // []')
      if [ "$SUGGESTIONS" != "[]" ] && [ -n "$SUGGESTIONS" ]; then
        jq -nc --argjson perms "$SUGGESTIONS" '{
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              updatedPermissions: $perms
            }
          }
        }'
        exit 0
      fi
    fi

    # Allow (one-time) or always without suggestions
    jq -nc '{
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow"
        }
      }
    }'
    exit 0
  fi
done

# Timeout — fall through to terminal prompt
exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x hooks/permission.sh`

- [ ] **Step 3: Commit**

```bash
git add hooks/permission.sh
git commit -m "feat: add permission hook script with polling round-trip"
```

---

### Task 6: Deploy Hooks + Settings

**Files:**
- Modify: `~/.claude/hooks/notify.sh` (copy from project)
- Modify: `~/.claude/hooks/permission.sh` (copy from project)
- Modify: `~/.claude/settings.json` (add PermissionRequest hook)

- [ ] **Step 1: Copy hooks**

Run:
```bash
cp hooks/notify.sh ~/.claude/hooks/notify.sh
cp hooks/permission.sh ~/.claude/hooks/permission.sh
```

- [ ] **Step 2: Add PermissionRequest hook to settings.json**

In `~/.claude/settings.json`, find the `"PermissionRequest"` key inside `"hooks"`. It's an array that already has existing entries (e.g., `claude-island-state.py`). Append the following object as a new element at the END of that array (after the last `}` and before the closing `]`):

```json
,
{
  "hooks": [
    {
      "type": "command",
      "command": "~\/.claude\/hooks\/permission.sh",
      "timeout": 70
    }
  ]
}
```

The backslash escaping of `/` matches the existing JSON style in the file. If the `PermissionRequest` key does not exist, create it as a new array with this single entry.

**Note:** The reverse proxy must also forward `/permission/*/respond` to port 7392 for the PWA to send responses. This is a manual deployment step.

- [ ] **Step 3: Commit project files**

```bash
git add -A
git commit -m "chore: finalize v2 enhancements"
```

---

### Task 7: Smoke Test

- [ ] **Step 1: Start server**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run src/index.ts &`
Expected: `Server running on http://localhost:7392`

- [ ] **Step 2: Verify Liquid Glass UI**

Run: `curl -s http://localhost:7392/ | grep "backdrop-filter"`
Expected: Match found (confirms Liquid Glass CSS is served)

- [ ] **Step 3: Test permission flow — create request**

Run: `curl -s -X POST http://localhost:7392/permission -H 'Content-Type: application/json' -d '{"id":"test-perm-1","machine":"test-mac","project":"my-api","tool_name":"Edit","tool_summary":"Edit src/index.ts"}'`
Expected: `{"ok":true,"id":"test-perm-1"}`

- [ ] **Step 4: Test permission flow — poll (pending)**

Run: `curl -s http://localhost:7392/permission/test-perm-1`
Expected: `{"status":"pending","tool_name":"Edit","tool_summary":"Edit src/index.ts","machine":"test-mac","project":"my-api"}`

- [ ] **Step 5: Test permission flow — respond**

Run: `curl -s -X POST http://localhost:7392/permission/test-perm-1/respond -H 'Content-Type: application/json' -d '{"decision":"allow"}'`
Expected: `{"ok":true}`

- [ ] **Step 6: Test permission flow — poll (answered)**

Run: `curl -s http://localhost:7392/permission/test-perm-1`
Expected: `{"status":"answered","decision":"allow"}`

- [ ] **Step 7: Test expired permission**

Run: `curl -s http://localhost:7392/permission/nonexistent`
Expected: `{"error":"Not found or expired"}` with 404

- [ ] **Step 8: Test notify still works (stop event)**

Run: `curl -s -X POST http://localhost:7392/notify -H 'Content-Type: application/json' -d '{"machine":"test","project":"my-api","summary":"Test **with** \`markdown\`","event":"stop"}'`
Expected: `{"ok":true,"debounced":true}`

- [ ] **Step 9: Test hook script**

Run: `echo '{"hook_event_name":"Stop","last_assistant_message":"I **built** the \`endpoint\`. It works.","cwd":"/Users/test/proj","stop_hook_active":false}' | CLAUDE_NOTIF_SERVER=http://localhost:7392 ./hooks/notify.sh`
Expected: Silent exit

- [ ] **Step 10: Kill server and clean up**

Run: `kill %1 2>/dev/null; rm -rf data/`
