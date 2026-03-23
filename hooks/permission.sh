#!/bin/bash
# hooks/permission.sh — Claude Code PermissionRequest hook
# Sends permission request to phone, polls for response.
# Install: copy to ~/.claude/hooks/permission.sh
INPUT=$(cat)

NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-http://localhost:7392}"
AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"
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
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
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

  RESP=$(curl -s --max-time 3 ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} "${NOTIF_SERVER}/permission/${REQ_ID}" 2>/dev/null)
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
