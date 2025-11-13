#!/bin/bash
cd "$(dirname "$0")"

# Stop zNode
if [ -f node.pid ]; then
    PID=$(cat node.pid)
    if kill $PID 2>/dev/null; then
        echo "✓ zNode stopped (PID: $PID)"
        rm node.pid
    else
        echo "Process $PID not found"
        rm node.pid
    fi
else
    echo "No zNode PID file found"
fi

# Stop Monero RPC
if [ -f monero-rpc.pid ]; then
    PID=$(cat monero-rpc.pid)
    if kill $PID 2>/dev/null; then
        echo "✓ Monero RPC stopped (PID: $PID)"
        rm monero-rpc.pid
    else
        echo "Process $PID not found"
        rm monero-rpc.pid
    fi
else
    echo "No Monero RPC PID file found"
fi
