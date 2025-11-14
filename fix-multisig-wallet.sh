#!/bin/bash
# Run this on nodes that show "already multisig" error

echo "Force stopping all processes..."
pkill -9 -f monero-wallet-rpc 2>/dev/null || true
pkill -9 -f "node.*node.js" 2>/dev/null || true
sleep 3

echo "Cleaning old Monero wallets..."
rm -rf ~/.monero-wallets/* 2>/dev/null || true

echo "Updating code..."
git fetch origin
git reset --hard origin/main

echo "Starting node..."
./start.sh

echo ""
echo "✓ Done. Check logs with: tail -f /root/zNode/node.log"
