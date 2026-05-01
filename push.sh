#!/bin/sh
set -e
TOKEN="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"
REMOTE="https://oauth2:${TOKEN}@github.com/RikL93/cmds-native.git"
git remote remove github 2>/dev/null || true
git remote add github "$REMOTE"
echo ">>> Pushing to GitHub..."
git push github main --force
echo ">>> Done! All code pushed to https://github.com/RikL93/cmds-native.git"
rm -f "$0"
echo ">>> push.sh removed."
