#!/bin/sh
set -e
TOKEN="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"
REMOTE="https://${TOKEN}@github.com/RikL93/cmds-native.git"
git remote add github "$REMOTE" 2>/dev/null || git remote set-url github "$REMOTE"
echo "Pushing to GitHub..."
git push github main --force
echo "Done. Cleaning up token..."
rm -f "$0"
echo "push.sh removed."
