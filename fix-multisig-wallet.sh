#!/bin/bash
# Run this on nodes that show "already multisig" error

echo "Stopping node..."
./stop.sh 2>/dev/null || true

echo "Cleaning old Monero wallets..."
rm -rf ~/.monero-wallets/* 2>/dev/null || true

echo "Updating code..."
git fetch origin
git reset --hard origin/main

echo "Starting node..."
./start.sh

echo ""
echo "✓ Done. Check logs with: tail -f /root/zNode/node.log"
