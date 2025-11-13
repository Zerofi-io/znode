#!/bin/bash
# Install patched Monero wallet RPC binary

echo "Installing patched Monero wallet RPC..."

# Backup original
if [ -f /usr/local/bin/monero-wallet-rpc ]; then
  cp /usr/local/bin/monero-wallet-rpc /usr/local/bin/monero-wallet-rpc.original
  echo "✓ Backed up original binary"
fi

# Install patched version
cp $(dirname "$0")/monero-wallet-rpc-patched /usr/local/bin/monero-wallet-rpc
chmod +x /usr/local/bin/monero-wallet-rpc

echo "✓ Patched binary installed"
monero-wallet-rpc --version
echo ""
echo "Now restart the node with: ./clean-restart.sh"
