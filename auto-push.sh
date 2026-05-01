#!/bin/sh
# Loopt continu en pusht elke 10 minuten nieuwe commits naar GitHub.
# Draait als Replit workflow "Auto GitHub Sync".

REPO="https://github.com/RikL93/cmds-native.git"
INTERVAL=600  # seconden

while true; do
  if [ -z "$GITHUB_TOKEN" ]; then
    echo "[auto-push] GITHUB_TOKEN ontbreekt — wachten..."
    sleep 30
    continue
  fi

  REMOTE="https://oauth2:${GITHUB_TOKEN}@github.com/RikL93/cmds-native.git"
  git remote remove github 2>/dev/null || true
  git remote add github "$REMOTE" 2>/dev/null || true

  OUTPUT=$(git push github main 2>&1)
  TIMESTAMP=$(date '+%H:%M:%S')

  if echo "$OUTPUT" | grep -q "Everything up-to-date"; then
    echo "[$TIMESTAMP] Geen nieuwe commits."
  else
    echo "[$TIMESTAMP] Gepusht naar $REPO"
    echo "$OUTPUT" | tail -5
  fi

  sleep "$INTERVAL"
done
