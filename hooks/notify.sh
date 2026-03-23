#!/bin/bash
# hooks/notify.sh — Claude Code stop hook
# Install: copy to ~/.claude/hooks/notify.sh
# Configure in ~/.claude/settings.json (see README)
INPUT=$(cat)
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 200 | tr '\n' ' ')
MACHINE=$(hostname)

# Change this to your server's LAN IP
NOTIF_SERVER="${CLAUDE_NOTIF_SERVER:-http://localhost:7392}"

JSON=$(jq -nc --arg machine "$MACHINE" --arg summary "$SUMMARY" '{machine: $machine, summary: $summary}')

curl -s --max-time 5 -X POST "${NOTIF_SERVER}/notify" \
  -H 'Content-Type: application/json' \
  -d "$JSON" \
  > /dev/null 2>&1

exit 0
