# Claude Notif — Multi-Tenant Auth

## Overview

Add multi-tenant authentication to claude-notif: self-registration with invite codes, per-user subscriptions/history/notifications, API key auth for hooks, JWT auth for PWA, admin panel for managing invite codes and users.

## Data Model (SQLite)

Storage moves from JSON files to SQLite via `bun:sqlite` (built-in, zero deps). Single database at `data/claude-notif.db`.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  api_key TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine TEXT NOT NULL,
  project TEXT,
  summary TEXT,
  event TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER,
  use_count INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- `password_hash`: bcrypt via `Bun.password.hash()` / `Bun.password.verify()`
- `api_key`: random 32-char hex, generated at registration
- `role`: `"user"` only (admin is identified by `ADMIN_KEY` env var, not a user row)
- VAPID keys stay in `data/vapid.json` (shared across all users)
- History capped at 50 entries per user (on insert, delete oldest beyond 50)
- History `created_at` field maps to `timestamp` in the API response (for PWA backward compat)
- Invite codes: 8-char alphanumeric (`crypto.randomUUID().slice(0, 8)`) — short enough to type

## Auth Model

Three authentication mechanisms:

| Who | How | Used for |
|---|---|---|
| Admin | `Authorization: Bearer <ADMIN_KEY>` (env var) | Admin API + admin UI |
| User (hooks) | `Authorization: Bearer <api_key>` | `/notify`, `/permission` |
| User (PWA) | Username + password → JWT in localStorage | Subscribe, history, permission prompt |

### JWT

- Signed with HMAC-SHA256 using `crypto.subtle` (built-in)
- Secret: `HMAC-SHA256(key="claude-notif-jwt", message=ADMIN_KEY)` — deterministic, derived from admin key
- Payload: `{sub: userId, iat: timestamp}`
- No expiry (personal tool, can add later)
- Stored in localStorage, sent as `Authorization: Bearer <token>`

### Middleware

Every route except `/auth/login`, `/auth/register`, `/vapid-public-key`, and static files requires auth. The middleware:

1. Reads `Authorization: Bearer <token>` header
2. Checks if token matches `ADMIN_KEY` → sets `{userId: null, isAdmin: true}` (checked first to avoid collision with API keys)
3. Tries to verify as JWT → extracts `{userId, isAdmin: false}`
4. If not JWT, tries to match as API key → looks up user → `{userId, isAdmin: false}`
5. If none match → 401

Attaches `{userId, isAdmin}` to Hono request context.

**`ADMIN_KEY` is required.** If not set, the server logs an error and exits on startup.

## Endpoints

### Auth (no auth required)

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `POST /auth/register` | POST | `{username, password, invite_code}` | `{token, api_key, user}` |
| `POST /auth/login` | POST | `{username, password}` | `{token, api_key, user}` |
| `GET /auth/me` | GET (JWT) | — | `{user}` or 401 |

`user` object shape: `{id, username, display_name, api_key, created_at}`

`GET /auth/me` is used when the PWA loads with an existing JWT in localStorage — verifies the token is still valid and the user hasn't been revoked. If 401, PWA clears localStorage and shows login screen.

Registration:
1. Validate invite code exists, `use_count < max_uses` (or `max_uses` is null)
2. Check username not taken
3. Hash password with `Bun.password.hash()`
4. Generate API key (`crypto.randomUUID().replace(/-/g, "")` — 32 hex chars)
5. Create user row
6. Increment invite code `use_count`
7. Return JWT + API key + user info

### Admin (requires ADMIN_KEY)

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /admin/invites` | GET | List all invite codes (id, code, max_uses, use_count, created_at) |
| `POST /admin/invites` | POST | Create invite code. Body: `{max_uses}` (null = unlimited). Returns `{id, code}` |
| `DELETE /admin/invites/:id` | DELETE | Delete invite code |
| `GET /admin/users` | GET | List all users (id, username, display_name, created_at) |
| `DELETE /admin/users/:id` | DELETE | Revoke user — deletes user + their subscriptions + their history |

### Existing Endpoints (now user-scoped)

| Endpoint | Auth | Scoping change |
|---|---|---|
| `POST /notify` | API key | Pushes only to that user's subscriptions. Debounce keyed by `userId:machine:project` (not just `machine:project`) |
| `POST /permission` | API key | Creates request tied to that user, pushes to their subscriptions |
| `GET /permission/:id` | API key | Only accessible by the user who created it |
| `POST /permission/:id/respond` | JWT | User responding via PWA (must match permission owner) |
| `POST /subscribe` | JWT | Subscription stored under that user |
| `DELETE /subscribe` | JWT | Only deletes that user's subscription |
| `GET /history` | JWT | Returns only that user's history |
| `DELETE /history` | JWT | Clears only that user's history |
| `GET /vapid-public-key` | None | Unchanged (public) |

## PWA Changes

### Login/Register Screen

Shown when no token in localStorage. Two tabs: "Login" and "Register".

**Register tab:** Invite code + username + password fields. On success, stores JWT + API key in localStorage, shows main view.

**Login tab:** Username + password. On success, stores JWT + API key in localStorage, shows main view.

Both use the Liquid Glass design language.

### Settings Section

Shown below the subscribe button on the main view:
- Display name (editable — future enhancement, read-only for now)
- API key with tap-to-copy (this is what users put in Claude Code config)
- Logout button (clears localStorage, shows login screen)

### Admin Panel

Accessible via an "Admin" link that only appears when the admin key is stored in localStorage. The admin enters their key once via a prompt.

Shows:
- **Invite codes:** List with code, uses/max, delete button. "Generate" button with max_uses prompt.
- **Users:** List with username, created date, revoke button.

Liquid Glass design, same visual language as rest of PWA.

**Admin is not a user.** The admin key grants access to the admin panel only — the admin cannot subscribe to notifications or have history. If you (the admin) also want notifications, register as a normal user with an invite code and use that user's API key in your hooks. The admin key is separate.

### Permission State

Pending permission requests remain **in-memory** (same as v2). They are ephemeral and do not need SQLite storage. The in-memory `Map` stores the `userId` on each pending permission so scoping works correctly. The `sendPushToAll` function is replaced by a `sendPushToUser(userId, payload, urgency)` function that only sends to that user's subscriptions.

### Reverse Proxy

All endpoints are now behind auth, so there is no need for the LAN-only distinction from v2. The reverse proxy can forward everything to port 7392. Auth handles access control.

## Hook Script Changes

### notify.sh

Add auth header to curl call:

```bash
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"
AUTH_HEADER=""
if [ -n "$AUTH_KEY" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer $AUTH_KEY\""
fi
```

Applied to the curl command.

### permission.sh

Same pattern — add `Authorization: Bearer $CLAUDE_NOTIF_KEY` to all curl calls (the POST and the poll GETs).

### User Setup

Users add to `~/.claude/settings.json` env block:
```json
"CLAUDE_NOTIF_KEY": "their-api-key-from-pwa"
```

API key is shown in the PWA settings section after login. User copies it once.

## Docker Changes

### docker-compose.yml

Add `ADMIN_KEY` env var:

```yaml
environment:
  - VAPID_SUBJECT=mailto:you@example.com
  - ADMIN_KEY=your-secret-admin-key
```

## Migration

1. On first startup, if `data/claude-notif.db` doesn't exist, create tables
2. VAPID keys stay in `data/vapid.json` (unchanged)
3. Existing `subscriptions.json` and `history.json` are ignored (clean slate)
4. **Breaking change:** Users must re-register and re-subscribe after deploying this version

## Files

| File | Change |
|---|---|
| `src/storage.ts` | Full rewrite — SQLite CRUD for users, subscriptions, history, invites |
| `src/auth.ts` | New — JWT sign/verify, password hash/verify, auth middleware |
| `src/index.ts` | Full rewrite — auth middleware, admin routes, user-scoped routes, login/register |
| `public/index.html` | Add login/register screen, settings section, admin panel |
| `public/sw.js` | No change |
| `public/manifest.json` | No change |
| `hooks/notify.sh` | Add `Authorization: Bearer $CLAUDE_NOTIF_KEY` header |
| `hooks/permission.sh` | Add `Authorization: Bearer $CLAUDE_NOTIF_KEY` header |
| `docker-compose.yml` | Add `ADMIN_KEY` env var |
