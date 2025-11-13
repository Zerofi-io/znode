#!/bin/bash
# Start Monero Wallet RPC in background with daemon fallbacks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting Monero Wallet RPC..."

# Idempotency: if running, exit
if [ -f monero-rpc.pid ] && kill -0 "$(cat monero-rpc.pid)" 2>/dev/null; then
  echo "Monero RPC already running (PID: $(cat monero-rpc.pid))"
  exit 0
fi

# Clean up stale port binding
if lsof -ti:18083 >/dev/null 2>&1; then
  echo "Port 18083 in use, cleaning up..."
  lsof -ti:18083 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

mkdir -p ~/.monero-wallets

# Hardcoded public Monero daemon nodes with fallbacks
NODES=(
  "xmr-node.cakewallet.com:18081"
  "node.monerodevs.org:18089"
  "node.c3pool.com:18081"
  "node.moneroworld.com:18089"
)

choose_node() {
  for node in "${NODES[@]}"; do
    host="${node%%:*}"
    port="${node##*:}"
    # Try simple height endpoint to verify daemon is reachable
    if curl -s --max-time 3 "http://$host:$port/get_height" | grep -q 'height'; then
      echo "$node"
      return 0
    fi
  done
  return 1
}

DAEMON_ADDR=$(choose_node || true)
if [ -z "${DAEMON_ADDR:-}" ]; then
  echo "ERROR: Could not reach any Monero daemon nodes. Check network connectivity."
  exit 1
fi

echo "Using daemon: $DAEMON_ADDR"

nohup monero-wallet-rpc \
  --daemon-address "$DAEMON_ADDR" \
  --rpc-bind-port 18083 \
  --rpc-bind-ip 127.0.0.1 \
  --wallet-dir ~/.monero-wallets \
  --disable-rpc-login \
  --log-level 1 \
  > monero-rpc.log 2>&1 &

echo $! > monero-rpc.pid
sleep 1

# Verify it started
if ! kill -0 "$(cat monero-rpc.pid)" 2>/dev/null; then
  echo "ERROR: Monero RPC failed to start. Check monero-rpc.log"
  rm -f monero-rpc.pid
  exit 1
fi

echo "✓ Monero RPC started (PID: $(cat monero-rpc.pid))"
