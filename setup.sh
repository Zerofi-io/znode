#!/bin/bash
set -e

# Get script directory and cd to it
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════"
echo "     zNode Setup - XMR Bridge"
echo "═══════════════════════════════════════"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root: sudo ./setup.sh"
    exit 1
fi

# Verify all required files exist
echo "→ Verifying installation..."
REQUIRED_FILES=(
    "node.js"
    "monero-rpc.js"
    "tss.js"
    "start.sh"
    "stop.sh"
    "start-monero-rpc.sh"
)

MISSING_FILES=()
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        MISSING_FILES+=("$file")
    fi
done

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo "⚠ Missing files detected: ${MISSING_FILES[*]}"
    echo "→ Fixing installation..."
    if [ -d .git ]; then
        git fetch origin
        git reset --hard origin/main
        echo "✓ Repository fixed"
    else
        echo "ERROR: Not a git repository. Please re-clone:"
        echo "  git clone https://github.com/Zerofi-io/znode.git"
        exit 1
    fi
fi

# Update package list
echo "→ Updating system packages..."
apt-get update -qq

# Check Node.js version and install/upgrade if needed
REQUIRED_NODE_VERSION=20
CURRENT_NODE_VERSION=0

if command -v node &> /dev/null; then
    CURRENT_NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
fi

if [ "$CURRENT_NODE_VERSION" -lt "$REQUIRED_NODE_VERSION" ]; then
    if [ "$CURRENT_NODE_VERSION" -eq 0 ]; then
        echo "→ Installing Node.js 20..."
    else
        echo "→ Upgrading Node.js from v$CURRENT_NODE_VERSION to v20..."
    fi
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    echo "✓ Node.js $(node -v) installed"
else
    echo "✓ Node.js $(node -v) already installed"
fi

# Install required packages
echo "→ Installing system dependencies..."
apt-get install -y bzip2 wget curl build-essential

# Install Monero CLI if needed
if ! command -v monero-wallet-rpc &> /dev/null; then
    echo "→ Installing Monero CLI..."
    wget -q https://downloads.getmonero.org/cli/monero-linux-x64-v0.18.4.3.tar.bz2
    tar -xf monero-linux-x64-v0.18.4.3.tar.bz2
    mv monero-x86_64-linux-gnu-v0.18.4.3/monero-wallet-rpc /usr/local/bin/
    rm -rf monero-*
    chmod +x /usr/local/bin/monero-wallet-rpc
fi

# Install npm dependencies
echo "→ Installing Node.js dependencies..."
if ! npm install; then
    echo ""
    echo "ERROR: npm install failed"
    echo "Check the error above and try again"
    exit 1
fi

# Get private key
echo ""
echo "═══════════════════════════════════════"
echo "Enter your Sepolia wallet private key:"
echo "(starts with 0x, followed by 64 characters)"
echo "═══════════════════════════════════════"
read -s PRIVATE_KEY
echo ""

# Validate private key format
if [[ ! $PRIVATE_KEY =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: Invalid private key format"
    echo "Must be 0x followed by 64 hex characters"
    echo "Example: 0x1234567890abcdef..."
    exit 1
fi

# Get RPC URL (optional)
echo ""
echo "═══════════════════════════════════════"
echo "Enter RPC URL (optional):"
echo "(Press Enter to use default)"
echo "═══════════════════════════════════════"
read RPC_URL
echo ""

# Use default if empty
if [ -z "$RPC_URL" ]; then
    RPC_URL="https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V"
    echo "Using default RPC endpoint"
fi

# Create .env file in script directory
cat > "$SCRIPT_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
RPC_URL=$RPC_URL
EOL
chmod 600 "$SCRIPT_DIR/.env"

echo "✓ Configuration saved to $SCRIPT_DIR/.env"
echo ""
echo "Starting zNode..."
# Start Monero RPC
if ./start-monero-rpc.sh; then
    sleep 2
    echo "✓ Monero RPC started"
else
    echo "ERROR: Failed to start Monero RPC"
    exit 1
fi
echo ""

# Start the node
if ./start.sh; then
    echo ""
    echo "═══════════════════════════════════════"
    echo "✓ zNode is running!"
    echo "═══════════════════════════════════════"
    echo ""
    echo "Commands:"
    echo "  View logs:  tail -f node.log"
    echo "  Stop node:  ./stop.sh"
    echo "  Restart:    ./stop.sh && ./start.sh"
    echo ""
else
    echo ""
    echo "ERROR: Failed to start node"
    echo "Check node.log for details: tail -f node.log"
    exit 1
fi
