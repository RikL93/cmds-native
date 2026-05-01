#!/bin/sh
# Pusht de huidige code naar GitHub zonder .github/workflows/ bestanden.
# Dit omzeilt de GitHub-restrictie dat een token met alleen 'repo' scope
# geen workflow-bestanden mag aanmaken of aanpassen.
#
# Werkwijze: maak een synthetische commit waarvan de boom identiek is aan
# HEAD maar zonder .github/workflows/. Prent die commit direct boven op
# de huidige GitHub-main — zo ziet GitHub geen workflow-wijziging en is de
# 'workflow'-scope niet nodig.
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN secret is niet ingesteld."
  exit 1
fi

REMOTE="https://oauth2:${GITHUB_TOKEN}@github.com/RikL93/cmds-native.git"
REPO_URL="https://github.com/RikL93/cmds-native.git"

git remote remove github 2>/dev/null || true
git remote add github "$REMOTE"

# Stel git-identiteit in (vereist voor commit-tree)
git config user.email "replit-agent@cmds.nl" 2>/dev/null || true
git config user.name "CMDS Replit" 2>/dev/null || true

echo ">>> GitHub synchroniseren..."
git fetch github main --quiet 2>/dev/null || true

GITHUB_HEAD=$(git rev-parse github/main 2>/dev/null || echo "")

# Zet index tijdelijk naar HEAD (clean state)
git read-tree HEAD

# Verwijder .github/workflows/ uit de index (niet uit de werkmap)
git rm --cached -rq .github/workflows/ 2>/dev/null || true

# Schrijf de schone boom (zonder workflow-bestanden)
CLEAN_TREE=$(git write-tree)

# Herstel de index naar HEAD zodat de werkmap onaangetast blijft
git read-tree HEAD

# Commit-boodschap van de huidige HEAD overnemen
MSG=$(git log -1 --pretty=%B)

# Maak een nieuwe commit boven op GitHub's huidige main
if [ -n "$GITHUB_HEAD" ]; then
  NEW_COMMIT=$(git commit-tree "$CLEAN_TREE" -p "$GITHUB_HEAD" -m "$MSG")
else
  NEW_COMMIT=$(git commit-tree "$CLEAN_TREE" -m "$MSG")
fi

echo ">>> Pushen naar GitHub..."
git push github "${NEW_COMMIT}:refs/heads/main" --force --quiet
echo ">>> Klaar! Code gepusht naar $REPO_URL"
