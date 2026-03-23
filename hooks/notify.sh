#!/bin/bash
# hooks/notify.sh — Claude Code stop/notification hook
# Install: copy to ~/.claude/hooks/notify.sh
# Configure in ~/.claude/settings.json (see README)
INPUT=$(cat)

# Skip if this is a re-entrant stop hook (prevents infinite loops)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"' | tr '[:upper:]' '[:lower:]')
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 200 | tr '\n' ' ')
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
