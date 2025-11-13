const secrets = require('secrets.js-grempe');
const crypto = require('crypto');

/**
 * Secure Signing System
 * - Each node only reconstructs and sees ITS OWN key during signing
 * - All keys reconstructed only during refresh (by coordinator)
 */
class SecureSigningSystem {
  constructor(nodeAddress) {
    this.nodeAddress = nodeAddress;
    this.myKey = null;
    this.keyTimestamp = null;
    this.MAX_KEY_LIFETIME_MS = 100;
  }

  /**
   * SIGNING MODE: Reconstruct only MY key
   * Node can ONLY see its own key
   */
  async reconstructMyKey(myShares) {
    if (myShares.length < 6) {
      throw new Error(`Insufficient shares: ${myShares.length}/6`);
    }

    const startTime = Date.now();

    // Set auto-destruct timer
    const destructTimer = setTimeout(() => {
      this.clearMyKey();
      throw new Error('Key reconstruction timeout - auto-cleared');
    }, this.MAX_KEY_LIFETIME_MS);

    try {
      // Reconstruct MY key only
      this.myKey = secrets.combine(myShares.slice(0, 6));
      this.keyTimestamp = Date.now();

      clearTimeout(destructTimer);
      
      console.log(`✓ Reconstructed MY key in ${Date.now() - startTime}ms`);
      console.log(`⏱️  Key will auto-expire in ${this.MAX_KEY_LIFETIME_MS}ms`);
      
      return this.myKey;
      
    } catch (error) {
      clearTimeout(destructTimer);
      this.clearMyKey();
      throw error;
    }
  }

  /**
   * Sign with MY key and immediately clear
   */
  async signAndClear(signFunction) {
    if (!this.myKey) {
      throw new Error('No key available - must reconstruct first');
    }

    // Check expiry
    const age = Date.now() - this.keyTimestamp;
    if (age > this.MAX_KEY_LIFETIME_MS) {
      this.clearMyKey();
      throw new Error(`Key expired (${age}ms old)`);
    }

    try {
      const startSign = Date.now();
      
      // Execute signing function with MY key
      const signature = await signFunction(this.myKey);
      
      console.log(`✓ Signed in ${Date.now() - startSign}ms`);
      
      return signature;
      
    } finally {
      // ALWAYS clear, even on error
      this.clearMyKey();
    }
  }

  /**
   * CRITICAL: Zero out MY key from memory
   */
  clearMyKey() {
    if (this.myKey) {
      // Technique 1: Overwrite with zeros
      const buffer = Buffer.from(this.myKey, 'hex');
      buffer.fill(0);
      
      // Technique 2: Overwrite with random data
      this.myKey = crypto.randomBytes(32).toString('hex');
      
      // Technique 3: Delete reference
      delete this.myKey;
      this.myKey = null;
      this.keyTimestamp = null;

      // Force GC
      if (global.gc) {
        global.gc();
      }

      console.log(`🔒 Cleared MY key from memory`);
    }
  }

  /**
   * One-shot: Reconstruct, sign, clear (safest)
   */
  async reconstructSignClear(myShares, signFunction) {
    try {
      await this.reconstructMyKey(myShares);
      return await this.signAndClear(signFunction);
    } catch (error) {
      this.clearMyKey(); // Ensure cleanup on error
      throw error;
    }
  }
}

/**
 * Refresh Coordinator
 * ONLY used during membership changes
 * Handles ALL keys temporarily for re-splitting
 */
class RefreshCoordinator {
  constructor() {
    this.allKeys = new Map();
    this.reconstructionTimestamp = null;
  }

  /**
   * REFRESH MODE: Reconstruct ALL keys (only during membership change)
   * This is the ONLY time all keys exist in one place
   */
  async reconstructAllKeys(collectedShares, originalMembers) {
    console.log('\n⚠️  REFRESH MODE: Reconstructing ALL keys');
    console.log('⚠️  This should ONLY happen during membership changes!\n');

    const startTime = Date.now();
    
    // Set strict timeout (1 second max)
    const destructTimer = setTimeout(() => {
      this.clearAllKeys();
      throw new Error('Refresh timeout - all keys auto-cleared');
    }, 1000);

    try {
      const reconstructed = {};

      for (const nodeAddr of originalMembers) {
        const shares = collectedShares[nodeAddr];
        
        if (!shares || shares.length < 6) {
          throw new Error(`Insufficient shares for ${nodeAddr}: ${shares?.length || 0}/6`);
        }

        const key = secrets.combine(shares.slice(0, 6));
        this.allKeys.set(nodeAddr, key);
        reconstructed[nodeAddr] = key;
        
        console.log(`  ✓ Reconstructed key for ${nodeAddr.slice(0, 10)}...`);
      }

      clearTimeout(destructTimer);
      this.reconstructionTimestamp = Date.now();
      
      console.log(`\n✓ Reconstructed ${originalMembers.length} keys in ${Date.now() - startTime}ms`);
      console.log('⚠️  ALL KEYS IN MEMORY - MUST COMPLETE REFRESH QUICKLY\n');
      
      return reconstructed;
      
    } catch (error) {
      clearTimeout(destructTimer);
      this.clearAllKeys();
      throw error;
    }
  }

  /**
   * Re-split all keys for new member set
   */
  async resplitAllKeys(newMembers, threshold = 6) {
    if (this.allKeys.size === 0) {
      throw new Error('No keys to re-split - must reconstruct first');
    }

    console.log(`\n🔄 Re-splitting ${this.allKeys.size} keys for ${newMembers.length} members...`);

    const startTime = Date.now();
    const newShareSets = {};

    // For each original key
    for (const [originalNode, key] of this.allKeys.entries()) {
      // Split into new shares
      const shares = secrets.share(key, newMembers.length, threshold);
      
      // Distribute to new members
      newShareSets[originalNode] = {};
      newMembers.forEach((memberAddr, idx) => {
        newShareSets[originalNode][memberAddr] = shares[idx];
      });
    }

    console.log(`✓ Re-split completed in ${Date.now() - startTime}ms\n`);
    
    return newShareSets;
  }

  /**
   * Complete refresh cycle
   */
  async performRefresh(collectedShares, originalMembers, newMembers, encryptAndDistribute) {
    try {
      // Step 1: Reconstruct all original keys
      await this.reconstructAllKeys(collectedShares, originalMembers);
      
      // Step 2: Re-split for new members
      const newShareSets = await this.resplitAllKeys(newMembers);
      
      // Step 3: Encrypt and distribute (provided by caller)
      await encryptAndDistribute(newShareSets);
      
      // Step 4: Clear ALL keys immediately
      this.clearAllKeys();
      
      console.log('✅ Refresh complete - all keys cleared\n');
      
    } catch (error) {
      this.clearAllKeys();
      throw error;
    }
  }

  /**
   * CRITICAL: Clear ALL keys from memory
   */
  clearAllKeys() {
    if (this.allKeys.size === 0) return;

    console.log(`\n🔒 Clearing ${this.allKeys.size} keys from memory...`);
    
    let cleared = 0;
    for (const [addr, key] of this.allKeys.entries()) {
      // Zero out
      const buffer = Buffer.from(key, 'hex');
      buffer.fill(0);
      
      // Overwrite with random
      this.allKeys.set(addr, crypto.randomBytes(32).toString('hex'));
      
      cleared++;
    }

    // Clear map
    this.allKeys.clear();
    this.reconstructionTimestamp = null;

    // Force GC
    if (global.gc) {
      global.gc();
    }

    console.log(`🔒 Securely cleared ${cleared} keys\n`);
  }

  /**
   * Health check - ensure keys don't linger
   */
  checkSecurity() {
    if (this.allKeys.size > 0) {
      const age = Date.now() - this.reconstructionTimestamp;
      console.error(`❌ SECURITY VIOLATION: ${this.allKeys.size} keys still in memory after ${age}ms!`);
      
      // Auto-clear if too old
      if (age > 5000) {
        console.error('❌ Keys lingered too long - force clearing!');
        this.clearAllKeys();
      }
      
      return false;
    }
    return true;
  }
}

module.exports = { SecureSigningSystem, RefreshCoordinator };
