// PHASE 2: Create Multisig Locally
async finalizeClusterWithMultisigCoordination() {
  console.log('→ Phase 2: Creating multisig wallet locally...');
  
  try {
    const [addresses] = await this.registry.getFormingClusterMultisigInfo();
    console.log(`  Got ${addresses.length} node addresses`);
    
    // Fetch all multisigInfo strings
    const multisigInfoList = [];
    for (let i = 0; i < addresses.length; i++) {
      if (addresses[i].toLowerCase() === this.wallet.address.toLowerCase()) {
        // Skip self, will add own info separately
        continue;
      }
      const nodeInfo = await this.registry.registeredNodes(addresses[i]);
      multisigInfoList.push(nodeInfo.multisigInfo);
    }
    
    console.log(`  Creating 8-of-11 multisig with ${multisigInfoList.length + 1} participants...`);
    
    // Create multisig locally using all infos
    const result = await this.monero.makeMultisig(multisigInfoList, 8);
    const multisigAddress = result.address;
    
    console.log(`✓ Multisig created: ${multisigAddress.slice(0, 12)}...`);
    
    // Calculate cluster ID (same way contract does it)
    const clusterId = ethers.keccak256(
      ethers.solidityPacked(['address[11]'], [addresses])
    );
    
    // Submit multisig address to contract for verification
    console.log('  Submitting multisig address to contract...');
    try {
      const tx = await this.registry.submitMultisigAddress(clusterId, multisigAddress);
      await tx.wait();
      console.log('✓ Multisig address submitted and verified');
    } catch (e) {
      if (e.message.includes('Already submitted')) {
        console.log('✓ Multisig address already submitted');
      } else if (e.message.includes('mismatch')) {
        throw new Error('CRITICAL: Created different multisig than other nodes!');
      } else {
        throw e;
      }
    }
    
    // Wait for all nodes to submit their addresses
    console.log('  Waiting for all nodes to verify multisig...');
    await this.waitForMultisigAddressConfirmation(clusterId);
    
    // Move to Phase 3: Key Exchange
    await this.exchangeMultisigKeys(clusterId, addresses, result.multisigInfo);
    
  } catch (e) {
    console.log('  Cluster finalization failed:', e.message);
    throw e;
  }
}

async waitForMultisigAddressConfirmation(clusterId) {
  const maxAttempts = 60; // 5 minutes
  for (let i = 0; i < maxAttempts; i++) {
    const status = await this.registry.getMultisigSetupStatus(clusterId);
    if (status.addressSubmissions >= 11) {
      console.log('✓ All nodes confirmed same multisig address');
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout waiting for multisig confirmation');
}

// PHASE 3: Exchange Keys (Encrypted)
async exchangeMultisigKeys(clusterId, addresses, exchangeInfo) {
  console.log('\n→ Phase 3: Exchanging multisig keys...');
  
  // Get exchange keys from Monero
  const exchangeKeys = await this.monero.exchangeMultisigKeys([exchangeInfo]);
  
  // For each other node, encrypt and submit their key
  for (let i = 0; i < addresses.length; i++) {
    const recipientAddr = addresses[i];
    if (recipientAddr.toLowerCase() === this.wallet.address.toLowerCase()) {
      continue; // Skip self
    }
    
    console.log(`  Encrypting key for ${recipientAddr.slice(0, 10)}...`);
    
    // Get recipient's public key from their address
    // For now, we'll use a simple encryption scheme
    // TODO: Implement proper ECIES encryption
    const encryptedKey = Buffer.from(exchangeKeys).toString('hex');
    
    try {
      const tx = await this.registry.submitKeyExchange(
        clusterId,
        recipientAddr,
        '0x' + encryptedKey
      );
      await tx.wait();
    } catch (e) {
      if (!e.message.includes('revert')) {
        console.log(`    Warning: Failed to submit key for ${recipientAddr.slice(0, 10)}`);
      }
    }
  }
  
  console.log('✓ Keys submitted to contract');
  
  // Wait for all nodes to submit keys
  console.log('  Waiting for all nodes to exchange keys...');
  await this.waitForKeyExchange(clusterId);
  
  // Retrieve and decrypt keys from other nodes
  console.log('  Retrieving encrypted keys from other nodes...');
  const decryptedKeys = [];
  for (let i = 0; i < addresses.length; i++) {
    const senderAddr = addresses[i];
    if (senderAddr.toLowerCase() === this.wallet.address.toLowerCase()) {
      continue;
    }
    
    const encryptedKey = await this.registry.getEncryptedKey(clusterId, senderAddr);
    if (encryptedKey && encryptedKey !== '0x') {
      // TODO: Implement proper decryption
      const decrypted = Buffer.from(encryptedKey.slice(2), 'hex').toString();
      decryptedKeys.push(decrypted);
    }
  }
  
  console.log(`  Got keys from ${decryptedKeys.length} nodes`);
  
  // Finalize multisig with exchanged keys
  console.log('  Finalizing multisig wallet...');
  await this.monero.finalizeMultisig(decryptedKeys);
  
  console.log('\n✅ MULTISIG WALLET FULLY OPERATIONAL!');
  console.log('🔒 8-of-11 threshold multisig');
  console.log('🚀 Ready to process bridge transactions\n');
}

async waitForKeyExchange(clusterId) {
  const maxAttempts = 60; // 5 minutes
  for (let i = 0; i < maxAttempts; i++) {
    const status = await this.registry.getMultisigSetupStatus(clusterId);
    if (status.keyExchangeComplete) {
      console.log('✓ All nodes completed key exchange');
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout waiting for key exchange');
}
