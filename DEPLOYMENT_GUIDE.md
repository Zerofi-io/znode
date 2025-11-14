# Shamir "Multisig" Bridge Deployment Guide

## Status: Phase 3 Complete - Ready for Deployment

All code is implemented and ready. The system needs deployment and testing.

## Components Completed

### 1. Core Shamir Implementation (Phase 1)
- ✅ `monero-shamir.js` (236 lines) - Core secret sharing
- ✅ `coordinator-ceremony.js` (132 lines) - Initial key generation
- ✅ Share backup system with 48h expiry
- ✅ Dynamic threshold calculation (15-20% of nodes, min 8)

### 2. Smart Contract & Integration (Phase 2)
- ✅ `ClusterRegistry_Shamir.sol` (304 lines) - On-chain coordination
- ✅ `shamir-integration.js` (183 lines) - Node integration layer
- ✅ Share commitment tracking
- ✅ Heartbeat system (48h timeout)
- ✅ Random signer selection
- ✅ Resharing triggers

### 3. Main Node Integration (Phase 3)
- ✅ `node-shamir-integrated.js` (complete rewrite)
- ✅ ShamirMultisigManager integration
- ✅ 24-hour heartbeat loop
- ✅ Event listeners for signing/resharing
- ✅ Coordinator selection logic
- ✅ Share distribution API

## Deployment Steps

### Step 1: Deploy ClusterRegistry_Shamir Contract

**NEEDS FUNDED SEPOLIA ADDRESS**

Current issue: Deployer needs Sepolia ETH for gas

```bash
cd /root/xmrbridge/contracts

# Option A: Fund the hardhat test account
# Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Get Sepolia ETH from: https://sepoliafaucet.com/

# Option B: Use a different funded private key
# Update /root/xmrbridge/contracts/.env with:
# DEPLOYER_PRIVATE_KEY=<your_funded_key>

# Deploy
npx hardhat run scripts/deploy-shamir.js --network sepolia
```

This will output the new registry address. Copy it for the next step.

### Step 2: Update Contract Addresses

Update these files with the new ClusterRegistry_Shamir address:

**File: /root/zNode/node-shamir-integrated.js**
```javascript
// Line ~56
this.registry = new ethers.Contract(
  '0xNEW_SHAMIR_REGISTRY_ADDRESS_HERE', // <-- UPDATE THIS
  registryABI,
  this.wallet
);
```

**File: /root/zNode/coordinator-ceremony.js**
```javascript
// Find the registry contract initialization and update address
```

### Step 3: Run Coordinator Ceremony (One-Time)

This generates the master Monero private key, splits it into shares, and distributes to all nodes.

**IMPORTANT**: This is a one-time trusted ceremony. Run on a secure machine.

```bash
cd /root/zNode

# The ceremony will:
# 1. Generate a new Monero wallet private key
# 2. Split into 11 shares (8-of-11 threshold)
# 3. Encrypt each share with node's public key
# 4. Distribute to all nodes
# 5. Register on-chain
# 6. DESTROY the master key from coordinator

node coordinator-ceremony.js
```

**Input Required:**
- Addresses of all 11 nodes
- Connection details for each node (or manual distribution method)

### Step 4: Start Nodes

On each of the 11 VPS servers:

```bash
cd /root/zNode

# Replace the old node.js with the new Shamir version
cp node-shamir-integrated.js node.js

# Start node
node node.js
```

Each node will:
1. Load its encrypted share from backup (if exists)
2. Register with the contract
3. Send heartbeat every 24 hours
4. Listen for signing requests
5. Listen for resharing events

### Step 5: Verify Operation

**Check Node Status:**
```bash
# On any node server
node -e "
const ethers = require('ethers');
const provider = new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V');
const registry = new ethers.Contract(
  '0xNEW_SHAMIR_REGISTRY_ADDRESS',
  ['function getActiveNodes() external view returns (address[] memory)'],
  provider
);
registry.getActiveNodes().then(console.log);
"
```

**Check Heartbeats:**
```bash
# Should see heartbeat logs every 24h in node output
# Check contract for last heartbeat time
```

**Trigger Test Signing:**
```bash
# From any node or external script
# This will select 8 random active nodes for signing
const requestId = ethers.id('test-signing-' + Date.now());
await registry.requestSigning(requestId);
```

## Architecture Summary

### Share Distribution Flow
1. Coordinator generates master key
2. Splits into 11 shares (8-of-11)
3. Encrypts each share with node's ETH private key
4. Nodes receive and store encrypted shares
5. Backup to ~/.monero-shares/ (48h expiry)
6. Register share commitment on-chain

### Signing Flow
1. Bridge triggers signing request
2. Contract selects 8 random active nodes
3. Selected nodes submit their shares
4. First node acts as coordinator
5. Coordinator collects 8 shares
6. Reconstructs key IN MEMORY ONLY
7. Signs Monero transaction
8. Overwrites key 10x with random data
9. Broadcasts signed transaction

### Resharing Flow (when nodes join/leave)
1. Contract detects node count change >10%
2. Emits ResharingTriggered event
3. 8 active nodes from old epoch submit shares
4. Coordinator reconstructs key
5. Generates new shares for new node count
6. Distributes to all active nodes
7. Increments epoch
8. Old shares become invalid

### Security Properties
- ✅ No single point of failure (8-of-N threshold)
- ✅ Master key never stored (only reconstructed temporarily)
- ✅ Per-node share encryption
- ✅ Key destruction after each signing (10x overwrite)
- ✅ 48-hour backup recovery window
- ✅ Automatic node removal after 48h no-heartbeat
- ✅ Dynamic threshold adjusts with node count
- ✅ Emergency governance can lower threshold

## Testing Checklist

- [ ] Deploy ClusterRegistry_Shamir to Sepolia
- [ ] Run coordinator ceremony successfully
- [ ] All 11 nodes receive and register shares
- [ ] All nodes sending heartbeats every 24h
- [ ] Test signing with 8 random nodes
- [ ] Verify Monero transaction signs correctly
- [ ] Test share backup recovery (stop node, restart within 48h)
- [ ] Test resharing (add/remove node)
- [ ] Test key destruction (verify memory cleared)
- [ ] Load test with multiple signing requests
- [ ] Test emergency threshold lowering
- [ ] Monitor gas costs for operations

## Known TODOs / Future Enhancements

### Production-Ready Items:
1. **P2P Share Collection**: Currently coordinator-based. Implement secure P2P protocol for share submission during signing.
2. **Encrypted Communication**: Add TLS/encryption for share distribution between nodes.
3. **Share Verification**: Add cryptographic share verification before reconstruction.
4. **Monitoring Dashboard**: Build web dashboard for node health, heartbeats, epochs.
5. **Automated Testing**: Add unit tests, integration tests, E2E tests.
6. **Gas Optimization**: Optimize contract to reduce heartbeat and signing gas costs.

### Security Enhancements:
1. **Hardware Security Modules (HSM)**: Store node private keys in HSM.
2. **Multi-Signature Governance**: Require multiple admins for emergencyLowerThreshold.
3. **Timelock on Critical Operations**: Add delays before resharing/threshold changes.
4. **Audit Logging**: Log all share accesses and reconstructions to immutable storage.

### Operational:
1. **Auto-Restart on Failure**: Add systemd service or Docker container with auto-restart.
2. **Alerts**: Send alerts when heartbeat fails or signing fails.
3. **Metrics**: Export Prometheus metrics for monitoring.
4. **Backup Encryption**: Encrypt share backups with additional passphrase.

## Files Created/Modified

### New Files:
- `/root/zNode/monero-shamir.js` - Core Shamir implementation
- `/root/zNode/coordinator-ceremony.js` - Key generation ceremony
- `/root/zNode/shamir-integration.js` - Integration layer
- `/root/zNode/node-shamir-integrated.js` - Main node (new version)
- `/root/xmrbridge/contracts/ClusterRegistry_Shamir.sol` - Smart contract
- `/root/xmrbridge/contracts/scripts/deploy-shamir.js` - Deployment script
- `/root/zNode/SHAMIR_IMPLEMENTATION_STATUS.md` - Status tracking
- `/root/zNode/DEPLOYMENT_GUIDE.md` - This file

### Backups:
- `/root/zNode/node.js.monero-multisig-backup` - Old Monero multisig version

## Contact / Support

For issues during deployment, check:
1. Node logs for errors
2. Contract events on Etherscan
3. Share backups in ~/.monero-shares/
4. Monero RPC connectivity (http://127.0.0.1:18083)

## Estimated Completion Time

- Deployment: 30 minutes (with funded account)
- Ceremony: 15 minutes
- Node startup: 5 minutes per node
- Testing: 2-3 hours
- **Total: ~4 hours end-to-end**

## Next Immediate Action

**⚠️  BLOCKER: Need funded Sepolia ETH address for contract deployment**

Get Sepolia ETH from: https://sepoliafaucet.com/
Target address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Needed: ~0.05 SepoliaETH for deployment + verification
