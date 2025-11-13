#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════"
echo "     zNode Update"
echo "═══════════════════════════════════════"
echo ""

# Check for uncommitted changes
if [ -f .env ]; then
    echo "→ Backing up configuration..."
    cp .env .env.backup
fi

# Pull latest changes
echo "→ Fetching updates..."
if ! git pull origin main; then
    echo ""
    echo "ERROR: Failed to update from GitHub"
    echo "Check your internet connection or git configuration"
    exit 1
fi

# Restore .env if it was overwritten
if [ -f .env.backup ]; then
    mv .env.backup .env
fi

# Update dependencies if package.json changed
if git diff HEAD@{1} HEAD --name-only | grep -q "package.json"; then
    echo "→ Updating dependencies..."
    npm install
fi

# Restart services
echo "→ Restarting services..."
./stop.sh
sleep 2

# Start Monero RPC if script exists
if [ -f ./start-monero-rpc.sh ]; then
    ./start-monero-rpc.sh
    sleep 2
fi

./start.sh

echo ""
echo "═══════════════════════════════════════"
echo "✓ Update complete!"
echo "═══════════════════════════════════════"
echo ""
echo "View logs: tail -f node.log"
