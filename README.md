# Claude Notif

Push notification bridge for Claude Code. Get notified on your phone when tasks complete or permissions are needed, and respond to permission requests without touching the terminal.

## User Setup

If someone is already hosting a Claude Notif server for you, this is all you need to do.

**Prerequisites:** `jq` and `curl` must be installed on your machine.

### 1. Register and subscribe

Open the server URL on your phone's browser. Register with the invite code you were given, then tap "Enable Notifications." Add the page to your home screen for a native app experience.

After registration, the app shows your **API key**. Copy it -- you need it for step 3.

### 2. Download the hooks

Save the two hook scripts from this repo to your Claude config directory:

```bash
curl -o ~/.claude/hooks/notify.sh https://raw.githubusercontent.com/angeloslvrs/claude-notify-pwa/main/hooks/notify.sh
curl -o ~/.claude/hooks/permission.sh https://raw.githubusercontent.com/angeloslvrs/claude-notify-pwa/main/hooks/permission.sh
chmod +x ~/.claude/hooks/notify.sh ~/.claude/hooks/permission.sh
```

### 3. Configure Claude Code

Add the server URL and your API key as environment variables, and register the hooks. Merge the following into `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_NOTIF_SERVER": "http://<server-address>:7392",
    "CLAUDE_NOTIF_KEY": "<your-api-key>"
  },
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
    ],
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
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/permission.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

### 4. Test it

Run any Claude Code task. When it finishes, you should get a push notification on your phone. To test permissions, have Claude Code attempt a tool that requires approval and respond from the app.

---

## How It Works

```
Claude Code hook --> POST /notify or /permission (LAN) --> Bun server --> Web Push --> PWA on phone
```

Two hooks handle different events:

- **notify.sh** -- Fires on `Stop` and `Notification` events. Strips markdown from the assistant's last message, truncates it, and sends it as a push notification. Stop events are debounced server-side (5s window) to collapse subagent noise into a single notification.
- **permission.sh** -- Fires on `PermissionRequest` events. Sends the tool name and summary to the server, then polls for up to 60 seconds. You respond on your phone (Allow / Always Allow / Deny) and the hook relays the decision back to Claude Code.

Notifications include machine hostname and project name for context.

## Features

- Push notifications for task completion and permission requests
- Remote permission approval from your phone (allow, always allow, deny)
- Server-side debounce collapses rapid subagent completions
- Notification history (last 50 per user)
- Multi-tenant with invite-code registration
- Three auth tiers: admin key (env), JWT (PWA sessions), API key (hooks)
- Installable PWA with offline support

## Hosting Your Own Server

Everything below is for people who want to run their own instance.

### Requirements

- Docker (or Bun >= 1.0 for local dev)
- A reverse proxy that terminates TLS (the PWA requires HTTPS for service workers)

### 1. Deploy

```bash
git clone <repo-url> && cd claude-notif
```

Edit `docker-compose.yml`:

```yaml
environment:
  - VAPID_SUBJECT=mailto:you@example.com
  - ADMIN_KEY=<generate-a-secret>
```

```bash
docker compose up -d --build
```

The server listens on port 7392. SQLite data is persisted to `./data/`.

### 2. Configure your reverse proxy

Expose the PWA over HTTPS. The `/notify` and `/permission` endpoints should stay LAN-only -- they are called by hooks on the same network and do not need public exposure.

Endpoints to proxy publicly:

```
/                     PWA static files
/auth/*               Registration and login
/vapid-public-key     VAPID key for push subscription
/subscribe            Push subscription management
/history              Notification history
/permission/*/respond Permission responses from PWA
```

### 3. Create an account

Open the PWA in your phone's browser. Register with an invite code (generate one via the admin panel or the API with your `ADMIN_KEY`).

Generate an invite code:

```bash
curl -X POST http://<server>:7392/admin/invites \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json"
```

After registration, the PWA will show your API key. Save it -- you need it for the hooks.

Add the PWA to your home screen for a native app experience.

### 4. Install the hooks

Copy the hook scripts:

```bash
cp hooks/notify.sh ~/.claude/hooks/notify.sh
cp hooks/permission.sh ~/.claude/hooks/permission.sh
chmod +x ~/.claude/hooks/notify.sh ~/.claude/hooks/permission.sh
```

Set environment variables. Add to your shell profile or `~/.claude/settings.json` under `env`:

```bash
export CLAUDE_NOTIF_SERVER=http://<server-lan-ip>:7392
export CLAUDE_NOTIF_KEY=<your-api-key>
```

Register the hooks in `~/.claude/settings.json`:

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
    ],
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
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/permission.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

### 5. Test it

Run any Claude Code task. When it finishes, you should get a push notification. To test permissions, have Claude Code attempt a tool that requires approval.

## API

All authenticated endpoints accept either `Authorization: Bearer <api_key>` or a JWT cookie.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | none | Register with invite code |
| POST | `/auth/login` | none | Login, returns JWT + API key |
| GET | `/auth/me` | user | Current user info |
| GET | `/vapid-public-key` | none | VAPID public key for push subscription |
| POST | `/subscribe` | user | Register push subscription |
| DELETE | `/subscribe` | user | Remove push subscription |
| POST | `/notify` | user | Send notification (used by hooks) |
| GET | `/history` | user | Notification history |
| DELETE | `/history` | user | Clear history |
| POST | `/permission` | user | Create permission request (used by hooks) |
| GET | `/permission/:id` | user | Poll permission status |
| POST | `/permission/:id/respond` | user | Respond to permission request |
| GET | `/admin/invites` | admin | List invite codes |
| POST | `/admin/invites` | admin | Create invite code |
| DELETE | `/admin/invites/:id` | admin | Delete invite code |
| GET | `/admin/users` | admin | List users |
| DELETE | `/admin/users/:id` | admin | Delete user |

## Development

```bash
bun install
bun run dev    # starts with --watch
```

## Project Structure

```
src/
  index.ts       Server, routes, debounce logic, permission state
  storage.ts     SQLite schema and CRUD operations
  auth.ts        JWT signing/verification, auth middleware
public/
  index.html     PWA frontend
  sw.js          Service worker (push handling, permission deep links)
hooks/
  notify.sh      Stop/Notification hook
  permission.sh  PermissionRequest hook with polling
```

## License

MIT
