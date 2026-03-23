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

```
Claude Code hook --> POST /notify (LAN) --> Server --> Web Push --> Phone PWA
```
