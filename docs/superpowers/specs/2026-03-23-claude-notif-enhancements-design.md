# Claude Notif Enhancements

## Overview

Enhance the existing claude-notif push notification service with: richer notification payloads (project context, event type), server-side debounce for subagent grouping, notification history with PWA UI, multi-event hooks (Stop + Notification), and urgency levels.

## Claude Code Hook Stdin Fields

Claude Code provides these fields via stdin JSON for hook events (documented in Claude Code hooks reference):

| Field | Stop | Notification | Description |
|---|---|---|---|
| `hook_event_name` | `"Stop"` | `"Notification"` | Event type |
| `last_assistant_message` | Claude's final response | Notification message text | Summary content |
| `cwd` | Working directory | Working directory | Project path |
| `session_id` | Session ID | Session ID | Session identifier |
| `agent_id` | Subagent ID or absent | N/A | Present for subagent Stop events |
| `agent_type` | Agent type or absent | N/A | Present for subagent Stop events |
| `stop_hook_active` | Boolean | N/A | Prevents infinite loops |

For `Notification` events, `last_assistant_message` contains the notification text (e.g., "Waiting for permission to edit file.ts"). If absent, fallback to "Waiting for input".

## Enhanced Notification Payload

The hook script sends richer data to the server:

```json
{
  "machine": "macbook-pro",
  "project": "claude-notif",
  "summary": "Built the push notification endpoint...",
  "event": "stop",
  "agent_id": null,
  "agent_type": null
}
```

- `project`: last path component of `cwd` from the hook stdin JSON
- `event`: `"stop"` or `"notification"`, derived from `hook_event_name`
- `agent_id`/`agent_type`: populated for subagent Stop events, empty otherwise

## Hook Script

Single `notify.sh` handles both `Stop` and `Notification` events:

```bash
INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"' | tr '[:upper:]' '[:lower:]')
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 200 | tr '\n' ' ')
MACHINE=$(hostname)
PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' | xargs basename)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
```

Uses `jq` to construct JSON payload (no string escaping issues).

### Settings.json

Add the hook to the `Notification` event (same script as Stop):

```json
"Notification": [
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
```

## Server-Side Debounce

In-memory debounce for collapsing rapid-fire notifications from subagents.

### Mechanism

1. Notification arrives at `POST /notify`
2. If `event` is `"notification"` (waiting for input): **bypass debounce**, push immediately with `urgency: high`
3. If `event` is `"stop"`: store in `Map<machine:project, PendingNotification[]>` (keyed by machine + project to avoid collapsing unrelated projects on the same machine)
4. Start or reset a 5-second timer for that machine:project key
5. When timer fires, flush the buffer:
   - **1 notification**: send as-is — title: "machine · project", body: summary
   - **Multiple notifications**: collapse — title: "machine · project", body: "N tasks completed" with the main (non-subagent) summary if available

### State

- In-memory `Map` only, not persisted
- If server restarts mid-debounce, at most one collapsed notification is lost

## Notification History

### Storage

`data/history.json` — array of last 50 entries, newest first.

```json
{
  "id": "uuid",
  "timestamp": "2026-03-23T15:30:00Z",
  "machine": "macbook-pro",
  "project": "my-api",
  "summary": "Built the push notification endpoint",
  "event": "stop",
  "count": 1
}
```

- Written after debounce flush (collapsed groups are one entry with `count > 1`)
- Capped at 50 entries; oldest dropped when full

### Endpoints

| Endpoint | Method | Access | Purpose |
|---|---|---|---|
| `GET /history` | GET | Public (reverse proxy) | Returns history array |
| `DELETE /history` | DELETE | Public (reverse proxy) | Clears history |

History may contain summaries of Claude's work. Accepted risk for a personal tool (same rationale as `/subscribe`).

## Push Notification Format

### Stop events (normal urgency)

- **Title:** `machine · project` (e.g., "macbook-pro · my-api")
- **Body:** summary text (truncated to 200 chars)
- **Urgency:** `normal` (Web Push protocol `Urgency` header, passed via `web-push` library's `options.urgency` field)

### Notification events (high urgency)

- **Title:** `machine · project · Waiting`
- **Body:** summary text
- **Urgency:** `high` (Web Push protocol `Urgency` header — may break through Do Not Disturb on some devices)

### Collapsed notifications

- **Title:** `machine · project`
- **Body:** "N tasks completed" with main agent summary if available

## PWA Changes

### History View

Accessible from a "History" link on the main page. Displays:

- List of past notifications with timestamps
- Machine name badges
- Project name
- Summary text
- Count badge for collapsed entries
- "Clear history" button at bottom

### Service Worker

Updated to handle urgency and format notifications based on event type.

## Files Modified

| File | Change |
|---|---|
| `hooks/notify.sh` (project-local, copied to `~/.claude/hooks/notify.sh` for use) | Extract event, project, agent_id, agent_type. Send all fields. |
| `src/index.ts` | Accept new fields. Route notification events to immediate push. Route stop events through debounce. Add /history endpoints. |
| `src/storage.ts` | Add history read/write/clear functions. |
| `public/sw.js` | Handle urgency, format title based on event type. |
| `public/index.html` | Add history view and clear button. |

All changes are modifications to existing files. `src/storage.ts` already exists from the initial implementation.
