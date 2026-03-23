# Claude Notif v2 — iOS Native + Permission Actions

## Overview

Four enhancements: Liquid Glass PWA redesign, cleaner notification formatting, manifest short_name change, and permission round-trip (Allow/Always) via in-app prompt page.

## 1. PWA Redesign — Liquid Glass

### Visual Style

- Background: subtle gradient with blur layers
- Panels: `background: rgba(255,255,255,0.06)` + `backdrop-filter: blur(40px)` + thin `rgba(255,255,255,0.1)` borders
- Typography: SF Pro via `-apple-system`, tight letter-spacing (`-0.02em`)
- Colors: iOS system palette
  - Green: `#30d158`
  - Blue: `#0a84ff`
  - Red: `#ff453a`
  - Orange: `#ff9f0a`
  - Cyan: `#64d2ff`
- Border radius: 14-16px for panels, 12px for buttons
- Status: green dot + text in frosted glass pill
- History: grouped list with frosted glass background, thin separators
- Badges: translucent colored backgrounds matching iOS system colors

### manifest.json

Change `short_name` from `"ClaudeNotif"` to `"CC"`. This controls the "from X" text iOS shows on notifications.

## 2. Notification Formatting

### Summary Cleanup (hook script)

Applied in `notify.sh` before sending to server:

1. Strip markdown: remove backticks, `#`, `*`, `_`, `[]()` links, `>` blockquotes, `-` list markers
2. Smart truncation: first sentence (split on `. ` or `.\n`), cap at 200 chars
3. No code formatting artifacts in any notification

### Notification Titles

- Stop events: `machine · project`
- Notification events: `machine · project · Waiting`
- Permission events: `machine · project` (body describes the tool action)

## 3. Permission Round-Trip

### iOS Limitation

iOS Safari does NOT support notification action buttons (`actions` property in `showNotification`). Instead, tapping the permission notification opens the PWA to an in-app permission prompt page.

### New Endpoints

| Endpoint | Method | Access | Purpose |
|---|---|---|---|
| `POST /permission` | POST | LAN only | Hook sends permission request, server returns `{id}` |
| `GET /permission/:id` | GET | LAN only | Hook polls for user response |
| `POST /permission/:id/respond` | POST | Public (reverse proxy) | PWA page sends user decision |

**Reverse proxy update required:** The reverse proxy must also forward `/permission/*/respond` to port 7392 in addition to the existing public routes (`/`, `/subscribe`, `/vapid-public-key`, `/history`). The `/permission` POST and GET endpoints remain LAN-only (not proxied).

### Push Notification Payload

Server sends this via `webpush.sendNotification()`:

```json
{
  "title": "macbook-pro · my-api",
  "body": "Edit src/index.ts",
  "event": "permission",
  "permissionId": "req_uuid"
}
```

The service worker uses `event: "permission"` to distinguish from stop/notification events. On `notificationclick`, it opens the PWA at `/?permission=req_uuid`.

### Permission Prompt Page

When the PWA loads with a `?permission=<id>` query param:

1. PWA fetches `GET /permission/:id` to get request details (tool_name, tool_summary)
2. Displays a Liquid Glass card with:
   - Tool action: "Edit src/index.ts"
   - Machine/project context
   - Two buttons: **Allow** (green) and **Always** (blue)
3. User taps a button → PWA POSTs to `/permission/:id/respond`
4. Page shows confirmation ("Allowed" / "Always allowed"), then returns to main view

If the permission has already expired or been answered, the page shows "Permission request expired" and returns to main view.

### Hook Script: `hooks/permission.sh`

Separate from `notify.sh` — blocking/polling behavior vs fire-and-forget.

**Input (stdin from Claude Code):**
```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Edit",
  "tool_input": {"file_path": "src/index.ts", ...},
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{"toolName": "Edit", "ruleContent": "src/index.ts"}],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ],
  "cwd": "/Users/angelo/Documents/fun-stuff/claude-notif",
  "session_id": "abc123"
}
```

**Flow:**

1. Hook reads stdin, extracts `tool_name`, `tool_input`, `permission_suggestions`, `cwd`
2. Generates UUID via `uuidgen`
3. Formats tool summary (see Section 4)
4. POSTs to `POST /permission` with `--max-time 5`. If POST fails, exit 0 (fall through to terminal):
   ```json
   {
     "id": "req_uuid",
     "machine": "macbook-pro",
     "project": "my-api",
     "tool_name": "Edit",
     "tool_summary": "Edit src/index.ts",
     "permission_suggestions": [...]
   }
   ```
5. Server stores pending request in memory, sends push notification
6. Hook polls `GET /permission/:id` every 2 seconds with `--max-time 3` per request
7. Poll response schema:
   - Pending: `{"status": "pending"}`
   - Answered: `{"status": "answered", "decision": "allow"}` or `{"status": "answered", "decision": "always", "permission_suggestions": [...]}`
8. On "answered" response, hook outputs JSON to stdout:

**Allow (one-time):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

**Always (persist rule) — uses the first entry from permission_suggestions:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        {
          "type": "addRules",
          "rules": [{"toolName": "Edit", "ruleContent": "src/index.ts"}],
          "behavior": "allow",
          "destination": "localSettings"
        }
      ]
    }
  }
}
```

The `permission_suggestions` array is stored server-side with the request and returned in the poll response when "always" is chosen. The first entry is used.

### Timeout Behavior

- Hook polls for 60 seconds max
- Each poll request has `--max-time 3`
- If no response after 60s: hook exits with no output (exit code 0)
- Claude Code falls back to its normal interactive terminal permission prompt
- User is never locked out
- If initial POST to `/permission` fails (server unreachable): exit 0 immediately

### Server State

- In-memory `Map<id, {request, response, timestamp}>`
- Entries auto-expire after 120 seconds (checked lazily on access)
- No persistence needed — permission requests are ephemeral

### Service Worker Changes

- In the `push` event handler: detect `event: "permission"` in payload
- For permission notifications: use tag `"claude-notif-permission"`, `requireInteraction: true`
- In `notificationclick` handler: if notification data has `permissionId`, open PWA at `/?permission=<id>` instead of just `/`

### Settings.json

Add `permission.sh` to `PermissionRequest` hook:
```json
{
  "hooks": [
    {
      "type": "command",
      "command": "~/.claude/hooks/permission.sh",
      "timeout": 70
    }
  ]
}
```

Appended to the existing `PermissionRequest` array. Hook timeout set to 70s (above the 60s poll timeout).

## 4. Tool Summary Formatting

The hook script formats `tool_input` into a human-readable summary for the notification body:

- `Edit`: "Edit {file_path}"
- `Write`: "Write {file_path}"
- `Bash`: "Run: {command}" (truncated to 100 chars)
- `Read`: "Read {file_path}"
- Other: "{tool_name}"

Done in `permission.sh` via `jq`.

## Files

| File | Change |
|---|---|
| `public/index.html` | Full rewrite — Liquid Glass design + permission prompt page |
| `public/sw.js` | Handle `event: "permission"` in push, open PWA with permission ID on click |
| `public/manifest.json` | Change `short_name` to "CC" |
| `hooks/notify.sh` | Add markdown stripping + smart truncation to summary |
| `hooks/permission.sh` | New file — PermissionRequest hook with polling |
| `src/index.ts` | Add `/permission` endpoints, pending request map, auto-expiry |
| `~/.claude/settings.json` | Add `permission.sh` to PermissionRequest hook |
