#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
    echo "═══════════════════════════════════════"
    echo "ERROR: Configuration not found"
    echo "═══════════════════════════════════════"
    echo ""
    echo "First time setup? Run:"
    echo "  sudo ./setup.sh"
    echo ""
    echo "Or create .env manually:"
    echo "  cp .env.example .env"
    echo "  nano .env"
    exit 1
fi

# Check if already running
if [ -f node.pid ] && kill -0 $(cat node.pid) 2>/dev/null; then
    echo "zNode is already running (PID: $(cat node.pid))"
    echo "Stop it first with: ./stop.sh"
    exit 1
fi

# Ensure Monero wallet RPC is running first
if [ ! -f monero-rpc.pid ] || ! kill -0 $(cat monero-rpc.pid) 2>/dev/null; then
    ./start-monero-rpc.sh || {
      echo "Failed to start Monero Wallet RPC. Check monero-rpc.log"
      exit 1
    }
fi

nohup node node.js > node.log 2>&1 &
PID=$!
echo $PID > node.pid

echo "✓ zNode started (PID: $PID)"
echo ""
echo "View logs: tail -f $SCRIPT_DIR/node.log"
echo "Stop node: $SCRIPT_DIR/stop.sh"
