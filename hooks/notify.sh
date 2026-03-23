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

AUTH_KEY="${CLAUDE_NOTIF_KEY:-}"

curl -s --max-time 5 -X POST "${NOTIF_SERVER}/notify" \
  -H 'Content-Type: application/json' \
  ${AUTH_KEY:+-H "Authorization: Bearer $AUTH_KEY"} \
  -d "$JSON" \
  > /dev/null 2>&1

exit 0
