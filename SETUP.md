# Claude Notif — Setup Guide

Get push notifications from Claude Code on your phone. Alerts you when tasks finish, and lets you approve/deny permission requests remotely.

## 1. Register on the PWA

1. Open **https://notify.geloflix.com** on your phone
2. Tap **Register** tab
3. Enter your invite code, pick a username and password
4. After registering, tap **Enable Notifications** to subscribe to push
5. Add to home screen for an app-like experience (Share → Add to Home Screen)

## 2. Copy Your API Key

In the PWA, your **API key** is shown in the Settings section. Tap it to copy. You'll need this for step 3.

## 3. Install Hook Scripts

Create two files on your machine:

### `~/.claude/hooks/notify.sh`

```bash
#!/bin/bash
INPUT=$(cat)

STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"' | tr '[:upper:]' '[:lower:]')
RAW=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

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

SUMMARY=$(echo "$CLEAN" | sed 's/\. .*/\./' | head -c 200)

MACHINE=$(hostname)
PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' | xargs basename)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')

NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-https://notify.geloflix.com}"
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"

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
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
  -d "$JSON" \
  > /dev/null 2>&1

exit 0
```

### `~/.claude/hooks/permission.sh`

```bash
#!/bin/bash
INPUT=$(cat)

NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-https://notify.geloflix.com}"
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"
MACHINE=$(hostname)
PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' | xargs basename)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {}')
PERM_SUGGESTIONS=$(echo "$INPUT" | jq -c '.permission_suggestions // []')

case "$TOOL_NAME" in
  Edit)   TOOL_SUMMARY="Edit $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Write)  TOOL_SUMMARY="Write $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Read)   TOOL_SUMMARY="Read $(echo "$TOOL_INPUT" | jq -r '.file_path // empty')" ;;
  Bash)   TOOL_SUMMARY="Run: $(echo "$TOOL_INPUT" | jq -r '.command // empty' | head -c 100)" ;;
  *)      TOOL_SUMMARY="$TOOL_NAME" ;;
esac

REQ_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

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
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
  -d "$POST_JSON" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  exit 0
fi

ELAPSED=0
while [ $ELAPSED -lt 60 ]; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))

  RESP=$(curl -s --max-time 3 ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} "${NOTIF_SERVER}/permission/${REQ_ID}" 2>/dev/null)
  STATUS=$(echo "$RESP" | jq -r '.status // empty')

  if [ "$STATUS" = "answered" ]; then
    DECISION=$(echo "$RESP" | jq -r '.decision // empty')

    if [ "$DECISION" = "deny" ]; then
      jq -nc '{
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Denied from phone"
          }
        }
      }'
      exit 0
    fi

    if [ "$DECISION" = "always" ]; then
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

exit 0
```

Make both executable:

```bash
chmod +x ~/.claude/hooks/notify.sh ~/.claude/hooks/permission.sh
```

## 4. Configure Claude Code

Add the following to your `~/.claude/settings.json`. If the file already has a `hooks` or `env` section, merge these in.

### Environment variables

Add to the `"env"` object (replace `YOUR_API_KEY` with the key from step 2):

```json
{
  "env": {
    "CLAUDE_NOTIF_SERVER": "https://notify.geloflix.com",
    "CLAUDE_NOTIF_KEY": "YOUR_API_KEY"
  }
}
```

### Hooks

Add to the `"hooks"` object:

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
            "timeout": 70
          }
        ]
      }
    ]
  }
}
```

## 5. Prerequisites

Your machine needs `jq` and `curl` installed:

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt install jq curl

# Check they work
jq --version && curl --version
```

## 6. Test It

Start a new Claude Code session and ask it to do something. When it finishes, you should get a push notification on your phone.

To test the permission flow, ask Claude to do something that requires permission (like editing a file). You'll get a notification you can tap to Allow/Deny from your phone.

## What You Get

- Push notification when Claude Code finishes a task
- Push notification when Claude is waiting for input
- Permission requests on your phone (Allow / Always allow in project / Deny)
- Notification history in the PWA
- Subagent notifications collapsed (won't spam you)
