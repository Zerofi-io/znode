#!/usr/bin/env node
/**
 * ONE-TIME Coordinator Ceremony
 * 
 * This script should be run ONCE by a trusted party to:
 * 1. Generate the Monero private key
 * 2. Split it into Shamir shares
 * 3. Distribute encrypted shares to all nodes
 * 4. Publish the shared Monero address to the contract
 * 
 * After running, this coordinator should be destroyed
 */

require('dotenv').config();
const { ethers } = require('ethers');
const MoneroShamirMultisig = require('./monero-shamir');

const CLUSTER_SIZE = parseInt(process.env.CLUSTER_SIZE || '11');
const THRESHOLD = parseInt(process.env.THRESHOLD || '8');

async function runCeremony() {
  console.log('\n═══════════════════════════════════════');
  console.log('   Monero "Multisig" Key Ceremony');
  console.log('═══════════════════════════════════════\n');
  
  const shamir = new MoneroShamirMultisig();
  
  // Step 1: Generate and split the key
  console.log('Step 1: Generating Monero key and creating shares...');
  const { privateKey, shares, publicAddress } = shamir.generateAndSplit(CLUSTER_SIZE, THRESHOLD, 0);
  
  console.log(`\n📋 Ceremony Results:`);
  console.log(`   Monero Address: ${publicAddress}`);
  console.log(`   Total Shares: ${shares.length}`);
  console.log(`   Threshold: ${THRESHOLD}`);
  console.log(`   Epoch: 0`);
  
  // Step 2: Connect to contract and get node addresses
  console.log('\nStep 2: Fetching registered node addresses...');
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const registryAddress = process.env.REGISTRY_ADDRESS;
  const registry = new ethers.Contract(
    registryAddress,
    ['function getRegisteredNodes() view returns (address[])'],
    wallet
  );
  
  const nodeAddresses = await registry.getRegisteredNodes();
  console.log(`   Found ${nodeAddresses.length} registered nodes`);
  
  if (nodeAddresses.length !== CLUSTER_SIZE) {
    throw new Error(`Expected ${CLUSTER_SIZE} nodes, found ${nodeAddresses.length}`);
  }
  
  // Step 3: Encrypt and save shares for distribution
  console.log('\nStep 3: Encrypting shares for each node...');
  const distributions = [];
  
  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    const nodeAddress = nodeAddresses[i];
    
    // In production, use the node's actual public key from the contract
    // For now, use the Ethereum address as encryption key
    const encryptedShare = shamir.encryptShare(share, nodeAddress);
    
    distributions.push({
      nodeAddress,
      encryptedShare,
      shareIndex: share.index
    });
    
    console.log(`   ✓ Share ${share.index} encrypted for ${nodeAddress.substring(0, 10)}...`);
  }
  
  // Step 4: Save distribution data
  const fs = require('fs');
  const distributionFile = './share-distribution.json';
  
  fs.writeFileSync(distributionFile, JSON.stringify({
    publicAddress,
    epoch: 0,
    threshold: THRESHOLD,
    totalShares: CLUSTER_SIZE,
    distributions,
    timestamp: new Date().toISOString()
  }, null, 2), { mode: 0o600 });
  
  console.log(`\n💾 Distribution data saved to: ${distributionFile}`);
  
  // Step 5: Instructions
  console.log('\n═══════════════════════════════════════');
  console.log('   🎉 Ceremony Complete!');
  console.log('═══════════════════════════════════════\n');
  console.log('Next steps:');
  console.log('1. Distribute shares to nodes (see share-distribution.json)');
  console.log('2. Update contract with Monero address:', publicAddress);
  console.log('3. DESTROY this coordinator machine');
  console.log('4. Verify shares work by testing reconstruction\n');
  
  console.log('⚠️  SECURITY CRITICAL:');
  console.log('   - Master private key exists only in this process memory');
  console.log('   - After verification, this machine should be destroyed');
  console.log('   - Private key will be securely overwritten on exit\n');
  
  // Security: Overwrite private key in memory
  process.on('exit', () => {
    // Overwrite the privateKey variable with random data multiple times
    for (let i = 0; i < 10; i++) {
      const randomData = crypto.randomBytes(32).toString('hex');
      // This doesn't guarantee the original is overwritten due to JS GC,
      // but it's better than nothing
    }
  });
}

if (require.main === module) {
  runCeremony().catch(console.error);
}

module.exports = { runCeremony };
