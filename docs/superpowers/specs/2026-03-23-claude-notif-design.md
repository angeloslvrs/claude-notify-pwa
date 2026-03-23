# Claude Code Push Notification Service

## Overview

A self-hosted push notification service that alerts your phone when Claude Code finishes a task on any machine. Multiple Claude Code sessions send notifications to a central server, which forwards them to your phone via Web Push.

## Architecture

```
Claude Code (machine A) --+
Claude Code (machine B) --+--> POST /notify (LAN only) --> Bun + Hono Server
Claude Code (machine C) --+                                    |
                                                               | web-push library
                                                               v
                                              Phone Browser PWA (service worker)
                                              subscribes via POST /subscribe
                                              (exposed via reverse proxy)
```

- **Server**: Bun + Hono, single `index.ts` (~100 lines)
- **PWA**: Minimal HTML + service worker for Web Push subscription and display
- **Storage**: JSON file for subscriptions and VAPID keys (no database)
- **Deployment**: Docker Compose on Proxmox

## Endpoints

| Endpoint | Method | Access | Purpose |
|---|---|---|---|
| `POST /notify` | POST | LAN only | Receives notification from Claude Code hook |
| `POST /subscribe` | POST | Public (reverse proxy) | Stores Web Push subscription |
| `DELETE /subscribe` | DELETE | Public | Removes a subscription |
| `GET /vapid-public-key` | GET | Public | Returns VAPID public key for PWA |
| `GET /` | GET | Public | Serves the PWA |

### POST /notify

Request body:
```json
{
  "machine": "macbook-pro",
  "summary": "Built push notification server"
}
```

Behavior:
- Iterates all stored subscriptions, sends Web Push to each
- Prunes expired/invalid subscriptions (410 responses)

### POST /subscribe

Request body: Standard Web Push subscription object from `pushManager.subscribe()`.

Stored in `data/subscriptions.json`.

### DELETE /subscribe

Request body:
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/..."
}
```

Removes matching subscription from storage by endpoint URL.

## PWA

### index.html
- Single-page app: title, status indicator, "Enable Notifications" button
- Fetches VAPID public key from `/vapid-public-key`
- Registers service worker, requests notification permission, subscribes to push

### sw.js (Service Worker)
- Listens for `push` events
- Displays notification with:
  - Title: machine name
  - Body: summary text
- Handles `notificationclick` to focus/open the PWA

### manifest.json
- Minimal PWA manifest for installability (add to home screen)
- `"display": "standalone"`

## VAPID Keys

- Generated once at first startup if `data/vapid.json` doesn't exist
- Persisted on Docker volume so subscriptions remain valid across restarts
- VAPID subject: configurable via `VAPID_SUBJECT` env var (e.g., `mailto:you@example.com`), required by the web-push library

## Claude Code Hook

The `Stop` hook receives JSON via stdin with the following relevant fields:
```json
{
  "last_assistant_message": "I've completed the task...",
  "session_id": "abc123",
  "cwd": "/path/to/project"
}
```

Hook configuration in `~/.claude/settings.json` (user-level) or `.claude/settings.json` (project-level):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"machine\":\"'$(hostname)'\",\"summary\":\"'$(cat | jq -r '.last_assistant_message' | head -c 200 | tr '\\n' ' ' | sed 's/\"/\\\\\"/g')'\"}' | curl -s -X POST http://<server-lan-ip>:7392/notify -H 'Content-Type: application/json' -d @-",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Alternatively, a small shell script for readability:

```bash
#!/bin/bash
# ~/.claude/hooks/notify.sh
INPUT=$(cat)
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message' | head -c 200 | tr '\n' ' ')
MACHINE=$(hostname)
curl -s --max-time 5 -X POST "http://<server-lan-ip>:7392/notify" \
  -H 'Content-Type: application/json' \
  -d "{\"machine\":\"$MACHINE\",\"summary\":\"$SUMMARY\"}" > /dev/null 2>&1
exit 0
```

- `last_assistant_message` contains Claude's final response — used as the notification summary
- `$(hostname)` auto-identifies the machine
- Summary truncated to 200 chars, newlines collapsed
- `--max-time 5` and `exit 0` ensure silent failure if server unreachable
- `timeout: 10` in hook config prevents hanging

## Docker Setup

### Dockerfile
- Base: `oven/bun:alpine`
- Copy source, install deps, expose port 7392

### docker-compose.yml
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

## File Structure

```
claude-notif/
  docker-compose.yml
  Dockerfile
  package.json
  src/
    index.ts          # Hono server
  public/
    index.html        # PWA page
    sw.js             # Service worker
    manifest.json     # PWA manifest
  data/               # Docker volume mount
    subscriptions.json
    vapid.json
```

## Tech Stack

- **Runtime**: Bun
- **Framework**: Hono
- **Push**: web-push npm package
- **Container**: Docker + Docker Compose
- **Host**: Proxmox hypervisor

## Network Access

- `/notify` endpoint: LAN/VPN only (no auth needed)
- All other endpoints: exposed via reverse proxy (public)

**LAN enforcement for `/notify`:** The reverse proxy should NOT forward requests to `/notify`. Only expose `/`, `/subscribe`, `/vapid-public-key`, and static assets. Since the Docker container only binds port 7392, `/notify` is only reachable by machines with direct LAN/VPN access to the host. The reverse proxy selectively proxies the public routes.

**HTTPS requirement:** Web Push and service workers require a secure context (HTTPS or localhost). The reverse proxy must terminate TLS. The server itself runs plain HTTP internally — TLS is handled at the proxy layer. Reverse proxy configuration (Nginx, Caddy, Traefik, etc.) is out of scope for this project but is a prerequisite for the PWA to function.

**CORS:** Not needed. The PWA is served from the same origin as the API endpoints (both go through the same reverse proxy), so all fetch requests are same-origin.

**Subscribe abuse:** Accepted risk for a personal tool. The subscriptions file is small and bounded by practical use. If needed in the future, a simple API key can be added.

## Notification Content

Each notification includes:
- **Machine name**: auto-detected via `hostname`
- **Summary**: short description of what Claude Code completed (~200 chars max)
