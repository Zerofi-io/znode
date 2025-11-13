const secrets = require('secrets.js-grempe');
const { ethers } = require('ethers');

class TSSManager {
  constructor(wallet, registry, provider, clusterId) {
    this.wallet = wallet;
    this.registry = registry;
    this.provider = provider;
    this.clusterId = clusterId;
  }

  /**
   * Split a private key into shares using Shamir Secret Sharing
   * @param {string} privateKey - Hex string of the private key
   * @param {number} totalShares - Total number of shares to create (11)
   * @param {number} threshold - Minimum shares needed to reconstruct (6)
   * @returns {Array<string>} Array of hex-encoded shares
   */
  splitKey(privateKey, totalShares = 11, threshold = 6) {
    // Remove 0x prefix if present
    const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    
    // Convert to shares (secrets.js expects hex string)
    const shares = secrets.share(cleanKey, totalShares, threshold);
    
    return shares; // Array of hex strings
  }

  /**
   * Reconstruct a private key from shares
   * @param {Array<string>} shares - Array of hex-encoded shares (minimum 6)
   * @returns {string} Reconstructed private key (hex string)
   */
  reconstructKey(shares) {
    if (shares.length < 6) {
      throw new Error(`Need at least 6 shares, got ${shares.length}`);
    }
    
    const reconstructed = secrets.combine(shares);
    return reconstructed;
  }

  /**
   * Encrypt data with a public key (ECIES-style using eth_encrypt standard)
   * @param {string} data - Data to encrypt
   * @param {string} recipientAddress - Ethereum address of recipient
   * @returns {string} Encrypted data as hex string
   */
  async encryptForRecipient(data, recipientAddress) {
    // Simple encryption: We'll use a symmetric approach where we derive
    // a shared secret from ECDH between our private key and their public key
    
    // For production, you'd want to use proper ECIES implementation
    // For now, we'll use a simple encryption scheme
    
    // Convert data to hex if not already
    const dataHex = Buffer.from(data).toString('hex');
    
    // Create a simple encryption by XORing with address-derived key
    // NOTE: This is NOT secure - replace with proper ECIES in production
    const key = ethers.keccak256(ethers.toUtf8Bytes(recipientAddress + this.wallet.address));
    const keyBytes = Buffer.from(key.slice(2), 'hex');
    const dataBytes = Buffer.from(dataHex, 'hex');
    
    const encrypted = Buffer.alloc(dataBytes.length);
    for (let i = 0; i < dataBytes.length; i++) {
      encrypted[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    
    return encrypted.toString('hex');
  }

  /**
   * Decrypt data encrypted for this node
   * @param {string} encryptedHex - Encrypted data as hex string
   * @param {string} senderAddress - Ethereum address of sender
   * @returns {string} Decrypted data
   */
  decryptFromSender(encryptedHex, senderAddress) {
    // Reverse of encryption
    const key = ethers.keccak256(ethers.toUtf8Bytes(this.wallet.address + senderAddress));
    const keyBytes = Buffer.from(key.slice(2), 'hex');
    const encryptedBytes = Buffer.from(encryptedHex, 'hex');
    
    const decrypted = Buffer.alloc(encryptedBytes.length);
    for (let i = 0; i < encryptedBytes.length; i++) {
      decrypted[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    
    return Buffer.from(decrypted.toString('hex'), 'hex').toString();
  }

  /**
   * After multisig creation, split this node's key and distribute shares
   * @param {string} moneroPrivateKey - This node's Monero private spend key
   * @param {Array<string>} clusterAddresses - All 11 node addresses in cluster
   */
  async distributeShares(moneroPrivateKey, clusterAddresses) {
    console.log('  Splitting key into 11 shares (6-of-11 threshold)...');
    
    // Split the key
    const shares = this.splitKey(moneroPrivateKey, 11, 6);
    
    console.log('  Encrypting shares for each node...');
    
    // Create a mapping: address => encrypted share
    const encryptedShares = {};
    
    for (let i = 0; i < clusterAddresses.length; i++) {
      const recipientAddr = clusterAddresses[i];
      const share = shares[i];
      
      // Encrypt this share for the recipient
      const encrypted = await this.encryptForRecipient(share, recipientAddr);
      encryptedShares[recipientAddr] = encrypted;
    }
    
    // Encode all encrypted shares as a single blob
    const sharesBlob = JSON.stringify(encryptedShares);
    
    if (!sharesBlob || sharesBlob === '{}') {
      throw new Error('encryptedShares is empty!');
    }
    
    const sharesBlobBytes = Buffer.from(sharesBlob, 'utf8');
    const sharesBlobHex = '0x' + sharesBlobBytes.toString('hex');
    
    console.log('  Blob size:', sharesBlobBytes.length, 'bytes');
    
    console.log('  Submitting shares to contract...');
    console.log('  sharesBlobHex type:', typeof sharesBlobHex);
    console.log('  sharesBlobHex length:', sharesBlobHex ? sharesBlobHex.length : 0);
    
    if (!sharesBlobHex || typeof sharesBlobHex !== 'string' || !sharesBlobHex.startsWith('0x')) {
      throw new Error('Invalid sharesBlobHex: ' + JSON.stringify(sharesBlobHex).slice(0, 100));
    }
    
    // Submit to contract
    // Ensure sharesBlobHex is treated as bytes, not options object
    const tx = await this.registry.submitSharesForEpoch(
      this.clusterId,
      0,
      sharesBlobHex
    );
    await tx.wait();
    
    console.log('✓ Shares distributed on-chain');
  }

  /**
   * Fetch and decrypt all shares intended for this node
   * @param {Array<string>} clusterAddresses - All node addresses in cluster
   * @returns {Object} Map of nodeAddress => decrypted share
   */
  async fetchMyShares(clusterAddresses) {
    console.log('  Fetching shares from contract...');
    
    const myShares = {};
    
    for (const senderAddr of clusterAddresses) {
      try {
        // Get shares submitted by this sender
        const sharesBlobHex = await this.registry.getNodeShares(this.clusterId, senderAddr);
        
        if (!sharesBlobHex || sharesBlobHex === '0x') {
          console.log(`  No shares from ${senderAddr.slice(0, 10)}... yet`);
          continue;
        }
        
        // Decode the blob
        const sharesBlob = Buffer.from(sharesBlobHex.slice(2), 'hex').toString();
        const encryptedShares = JSON.parse(sharesBlob);
        
        // Find our encrypted share
        const myEncryptedShare = encryptedShares[this.wallet.address];
        
        if (!myEncryptedShare) {
          console.log(`  No share for us from ${senderAddr.slice(0, 10)}...`);
          continue;
        }
        
        // Decrypt it
        const decryptedShare = this.decryptFromSender(myEncryptedShare, senderAddr);
        myShares[senderAddr] = decryptedShare;
        
      } catch (error) {
        console.log(`  Error fetching from ${senderAddr.slice(0, 10)}...: ${error.message}`);
      }
    }
    
    console.log(`✓ Retrieved ${Object.keys(myShares).length} shares`);
    return myShares;
  }

  /**
   * Reconstruct a specific node's key from shares
   * @param {string} targetNodeAddress - Address of node whose key to reconstruct
   * @param {Array<string>} clusterAddresses - All node addresses
   * @returns {string} Reconstructed private key
   */
  async reconstructNodeKey(targetNodeAddress, clusterAddresses) {
    console.log(`  Reconstructing key for ${targetNodeAddress.slice(0, 10)}...`);
    
    const shares = [];
    
    // Fetch shares from all nodes for the target node
    for (const senderAddr of clusterAddresses) {
      try {
        const sharesBlobHex = await this.registry.getNodeShares(this.clusterId, senderAddr);
        
        if (!sharesBlobHex || sharesBlobHex === '0x') continue;
        
        const sharesBlob = Buffer.from(sharesBlobHex.slice(2), 'hex').toString();
        const encryptedShares = JSON.parse(sharesBlob);
        
        const encryptedShare = encryptedShares[targetNodeAddress];
        if (!encryptedShare) continue;
        
        // We can't decrypt this (it's encrypted for targetNode), but if WE are collecting
        // shares to reconstruct, it means we have access through our own shares
        // This is a simplified model - in reality, each node would provide their share
        // of the target node's key
        
        // For now, skip this complexity and assume we're reconstructing from our own shares
        
      } catch (error) {
        // Skip
      }
    }
    
    // Simplified: In production, you'd coordinate with other nodes to collect shares
    throw new Error('Key reconstruction requires coordination - not yet implemented');
  }
}

module.exports = TSSManager;
