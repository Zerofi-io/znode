/**
 * Key Ownership Manager
 * Tracks which node owns which Monero multisig key
 */
class KeyOwnershipManager {
  constructor() {
    // Map: keyIndex → currentOwnerAddress
    this.keyOwnership = new Map();
    
    // Map: nodeAddress → keyIndex
    this.nodeToKey = new Map();
    
    // Original 11 Monero multisig keys (never change)
    this.TOTAL_KEYS = 11;
  }

  /**
   * Initialize ownership for original 11 nodes
   */
  initializeOwnership(originalNodes) {
    if (originalNodes.length !== this.TOTAL_KEYS) {
      throw new Error(`Expected ${this.TOTAL_KEYS} nodes, got ${originalNodes.length}`);
    }

    for (let i = 0; i < this.TOTAL_KEYS; i++) {
      this.keyOwnership.set(i, originalNodes[i]);
      this.nodeToKey.set(originalNodes[i], i);
    }

    console.log(`✓ Initialized ownership: ${this.TOTAL_KEYS} keys → ${this.TOTAL_KEYS} nodes`);
  }

  /**
   * Transfer key ownership when node leaves/joins
   * @param {string} leavingNode - Node that's leaving
   * @param {string} joiningNode - Node that's joining
   */
  transferKey(leavingNode, joiningNode) {
    // Find which key the leaving node owns
    const keyIndex = this.nodeToKey.get(leavingNode);
    
    if (keyIndex === undefined) {
      throw new Error(`Node ${leavingNode} doesn't own any key`);
    }

    // Transfer ownership
    this.keyOwnership.set(keyIndex, joiningNode);
    this.nodeToKey.delete(leavingNode);
    this.nodeToKey.set(joiningNode, keyIndex);

    console.log(`🔄 Key ${keyIndex} transferred: ${leavingNode.slice(0, 10)}... → ${joiningNode.slice(0, 10)}...`);
    
    return keyIndex;
  }

  /**
   * Get the key index owned by a node
   */
  getKeyForNode(nodeAddress) {
    const keyIndex = this.nodeToKey.get(nodeAddress);
    if (keyIndex === undefined) {
      throw new Error(`Node ${nodeAddress} doesn't own any key`);
    }
    return keyIndex;
  }

  /**
   * Get the node that owns a specific key
   */
  getNodeForKey(keyIndex) {
    const owner = this.keyOwnership.get(keyIndex);
    if (!owner) {
      throw new Error(`Key ${keyIndex} has no owner`);
    }
    return owner;
  }

  /**
   * Get ownership status
   */
  getOwnershipMap() {
    const map = {};
    for (const [keyIndex, owner] of this.keyOwnership.entries()) {
      map[`Key_${keyIndex}`] = owner;
    }
    return map;
  }

  /**
   * Verify all keys are owned
   */
  verifyAllKeysOwned() {
    const ownedKeys = new Set(this.keyOwnership.keys());
    const missingKeys = [];

    for (let i = 0; i < this.TOTAL_KEYS; i++) {
      if (!ownedKeys.has(i)) {
        missingKeys.push(i);
      }
    }

    if (missingKeys.length > 0) {
      throw new Error(`Keys without owners: ${missingKeys.join(', ')}`);
    }

    return true;
  }

  /**
   * Get active signing nodes (for 8-of-11 multisig)
   * Returns the nodes that should sign (those with keys)
   */
  getSigningNodes() {
    const signingNodes = [];
    
    // Get all nodes that own keys
    for (const [keyIndex, owner] of this.keyOwnership.entries()) {
      signingNodes.push({
        node: owner,
        keyIndex: keyIndex
      });
    }

    return signingNodes;
  }

  /**
   * For a specific node, get which key it should reconstruct during signing
   */
  getMyKeyIndex(myNodeAddress) {
    return this.getKeyForNode(myNodeAddress);
  }

  /**
   * Export ownership state (for persistence/contract storage)
   */
  exportState() {
    return {
      keyOwnership: Array.from(this.keyOwnership.entries()),
      nodeToKey: Array.from(this.nodeToKey.entries()),
      timestamp: Date.now()
    };
  }

  /**
   * Import ownership state
   */
  importState(state) {
    this.keyOwnership = new Map(state.keyOwnership);
    this.nodeToKey = new Map(state.nodeToKey);
    console.log(`✓ Imported ownership: ${this.keyOwnership.size} keys assigned`);
  }

  /**
   * Pretty print ownership
   */
  printOwnership() {
    console.log('\n📋 Current Key Ownership:');
    console.log('='.repeat(70));
    
    for (let i = 0; i < this.TOTAL_KEYS; i++) {
      const owner = this.keyOwnership.get(i);
      const status = owner ? `→ ${owner.slice(0, 10)}...${owner.slice(-6)}` : '→ UNASSIGNED';
      console.log(`  Key_${i.toString().padStart(2, ' ')} ${status}`);
    }
    
    console.log('='.repeat(70) + '\n');
  }
}

/**
 * Integration with RefreshCoordinator
 * Handles ownership transfer during membership changes
 */
class RefreshWithOwnership {
  constructor(refreshCoordinator, ownershipManager) {
    this.refreshCoordinator = refreshCoordinator;
    this.ownershipManager = ownershipManager;
  }

  /**
   * Perform refresh with key ownership transfer
   */
  async performRefreshWithTransfer(collectedShares, leavingNode, joiningNode, originalMembers, newMembers) {
    console.log('\n🔄 Starting Refresh with Key Ownership Transfer');
    console.log('='.repeat(70));
    
    // 1. Transfer key ownership
    const transferredKeyIndex = this.ownershipManager.transferKey(leavingNode, joiningNode);
    console.log(`\n✓ Key ${transferredKeyIndex} ownership transferred`);
    
    // 2. Print new ownership
    this.ownershipManager.printOwnership();
    
    // 3. Perform normal refresh (reconstruct, re-split, distribute)
    await this.refreshCoordinator.performRefresh(
      collectedShares,
      originalMembers,
      newMembers,
      async (newShareSets) => {
        // Add ownership info to distribution
        console.log('\n📤 Distributing shares with ownership info...');
        
        for (const newNode of newMembers) {
        if (!this.ownershipManager.nodeToKey.has(newNode)) continue;
          const keyIndex = this.ownershipManager.getKeyForNode(newNode);
          console.log(`   ${newNode.slice(0, 10)}... → owns Key_${keyIndex}`);
        }
        
        // Actual distribution would happen here
        // Each node receives shares of ALL keys, but knows which one is "theirs"
      }
    );
    
    console.log('\n✅ Refresh with transfer complete!');
    console.log(`   - Key ${transferredKeyIndex}: ${leavingNode.slice(0, 10)}... → ${joiningNode.slice(0, 10)}...`);
    console.log(`   - All shares re-split for ${newMembers.length} nodes`);
    console.log('='.repeat(70) + '\n');
  }

  /**
   * Get shares node should use for signing
   * Node gets shares of ALL keys, but only reconstructs its OWN
   */
  getMySigningShares(myNodeAddress, allMyShares) {
    const myKeyIndex = this.ownershipManager.getMyKeyIndex(myNodeAddress);
    
    console.log(`\n🔐 Node ${myNodeAddress.slice(0, 10)}... preparing to sign`);
    console.log(`   My key: Key_${myKeyIndex}`);
    console.log(`   I have shares of all ${this.ownershipManager.TOTAL_KEYS} keys`);
    console.log(`   But will only reconstruct Key_${myKeyIndex}\n`);
    
    // Return only the shares for MY key
    return {
      myKeyIndex: myKeyIndex,
      myShares: allMyShares[myKeyIndex],
      message: `I own Key_${myKeyIndex}, will not reconstruct others`
    };
  }
}

module.exports = { KeyOwnershipManager, RefreshWithOwnership };
