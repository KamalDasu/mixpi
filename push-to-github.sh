#!/bin/bash
# Push MixPi to GitHub

set -e

echo "=========================================="
echo "Push MixPi to GitHub"
echo "=========================================="
echo ""

cd /home/kd923030/mixpi

# Check if remote exists
if git remote get-url origin > /dev/null 2>&1; then
    echo "✓ Remote 'origin' already configured"
    git remote -v
else
    echo "Adding GitHub remote..."
    git remote add origin https://github.com/KamalDasu/mixpi.git
fi

echo ""
echo "Current branch:"
git branch --show-current

echo ""
echo "Commits to push:"
git log --oneline -10

echo ""
echo "Ready to push to GitHub!"
echo ""
echo "Run the following command:"
echo ""
echo "  git push -u origin main"
echo ""
echo "You may be prompted for your GitHub credentials."
echo "If you have 2FA enabled, use a Personal Access Token instead of password."
echo ""
echo "To create a token:"
echo "  1. Go to: https://github.com/settings/tokens"
echo "  2. Click 'Generate new token (classic)'"
echo "  3. Select 'repo' scope"
echo "  4. Use the token as your password"
echo ""
