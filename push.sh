#!/bin/sh
set -e
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN secret is niet ingesteld."
  exit 1
fi
REMOTE="https://oauth2:${GITHUB_TOKEN}@github.com/RikL93/cmds-native.git"
git remote remove github 2>/dev/null || true
git remote add github "$REMOTE"
echo ">>> Pushing to GitHub..."
git push github main --force
echo ">>> Done! Code gepusht naar https://github.com/RikL93/cmds-native.git"
