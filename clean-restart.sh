#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "→ Stopping services gracefully..."
./stop.sh 2>/dev/null || true
sleep 1

echo "→ Killing all node processes..."
pkill -9 -f "node.*node.js" 2>/dev/null || true

echo "→ Killing all Monero wallet RPC processes..."
pkill -9 -f monero-wallet-rpc 2>/dev/null || true

echo "→ Cleaning up stale port bindings..."
lsof -ti:18083 | xargs kill -9 2>/dev/null || true

echo "→ Removing PID files..."
rm -f node.pid monero-rpc.pid

echo "→ Clearing old logs..."
: > node.log
: > monero-rpc.log

echo "→ Removing all wallet files..."
rm -rf ~/.monero-wallets/* ~/.bitmonero/znode* ~/.monero-wallets/znode* 2>/dev/null || true
mkdir -p ~/.monero-wallets

echo "→ Waiting for cleanup to complete..."
sleep 2

echo "→ Starting fresh..."
./start.sh

echo ""
echo "✓ Clean restart complete!"
echo ""
echo "View logs: tail -f node.log"
