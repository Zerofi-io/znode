const crypto = require('crypto');
const secrets = require('secrets.js-grempe');
const ECIESEncryption = require('./ecies-encryption');
const P2PBackupNetwork = require('./p2p-backup-network');

/**
 * Cross-Cluster Backup System V2 with P2P Integration
 * 
 * Features:
 * - Direct P2P communication (no IPFS)
 * - Local encrypted storage on backup nodes
 * - Automatic rebalancing on cluster lifecycle changes
 * - 3-of-5 backup threshold
 */
class CrossClusterBackupManager {
  constructor(clusterRegistryContract, myClusterId, wallet, p2pPort = 0) {
    this.registry = clusterRegistryContract;
    this.myClusterId = myClusterId;
    this.wallet = wallet;
    this.nodeAddress = wallet.address;
    this.backupShares = new Map();
    this.ecies = null;
    this.p2pNetwork = new P2PBackupNetwork(wallet, p2pPort);
    this.BACKUP_THRESHOLD = 3;
    this.BACKUP_TOTAL = 5;
    
    // Peer multiaddr cache (eth address => libp2p multiaddr)
    this.peerAddrs = new Map();
  }

  async initialize() {
    this.ecies = new ECIESEncryption(this.wallet);
    await this.p2pNetwork.start();
  }

  async shutdown() {
    await this.p2pNetwork.stop();
  }

  /**
   * Register peer's P2P multiaddr
   */
  registerPeer(ethAddress, multiaddr) {
    this.peerAddrs.set(ethAddress, multiaddr);
    console.log(`[CrossClusterBackup] Registered peer ${ethAddress.slice(0, 10)}: ${multiaddr}`);
  }

  async startMonitoring() {
    console.log('[CrossClusterBackup] Starting monitoring for cluster lifecycle events');
    await this.rebalanceBackupShares();

    this.registry.on('ClusterConfirmed', async (clusterId, moneroAddress) => {
      console.log(`[CrossClusterBackup] New cluster detected: ${clusterId}`);
      await this.rebalanceBackupShares();
    });

    this.registry.on('ClusterStateChanged', async (clusterId, newState) => {
      if (newState === 'DEAD' || newState === 'INACTIVE') {
        console.log(`[CrossClusterBackup] Cluster died: ${clusterId}`);
        await this.rebalanceBackupShares();
        await this.p2pNetwork.deleteBackupShares(clusterId);
      }
    });

    setInterval(() => this.rebalanceBackupShares(), 6 * 60 * 60 * 1000);
  }

  async getHealthyClusters() {
    const allClusters = await this.getAllActiveClusters();
    const healthy = [];

    for (const clusterId of allClusters) {
      const state = await this.getClusterState(clusterId);
      if (state.activeNodes >= 9) {
        healthy.push({
          clusterId,
          activeNodes: state.activeNodes,
          members: state.members
        });
      }
    }

    return healthy;
  }

  async getAllActiveClusters() {
    const filter = this.registry.filters.ClusterConfirmed();
    const events = await this.registry.queryFilter(filter);
    const clusterIds = events.map(e => e.args.clusterId);
    const active = [];
    
    for (const clusterId of clusterIds) {
      const state = await this.getClusterState(clusterId);
      if (state.activeNodes >= 6) {
        active.push(clusterId);
      }
    }
    
    return active;
  }

  async getClusterState(clusterId) {
    const info = await this.registry.getClusterInfo(clusterId);
    const activeMembers = info.currentMembers.filter(addr => addr !== '0x0000000000000000000000000000000000000000');
    
    return {
      activeNodes: activeMembers.length,
      members: activeMembers,
      allNodes: info.nodes
    };
  }

  createBackupShares(primaryShares) {
    console.log('[CrossClusterBackup] Creating backup shares from primary shares');
    const backupShareSets = [];

    for (let keyIndex = 0; keyIndex < 11; keyIndex++) {
      const primarySharesForKey = primaryShares.map(nodeShares => nodeShares[keyIndex]);
      const reconstructedKey = secrets.combine(primarySharesForKey);
      const backupShares = secrets.share(reconstructedKey, this.BACKUP_TOTAL, this.BACKUP_THRESHOLD);
      backupShareSets.push(backupShares);
      
      if (Buffer.isBuffer(reconstructedKey)) {
        reconstructedKey.fill(0);
      }
    }

    const backupNodes = [];
    for (let backupIndex = 0; backupIndex < this.BACKUP_TOTAL; backupIndex++) {
      const sharesForThisBackup = backupShareSets.map(shareSet => shareSet[backupIndex]);
      backupNodes.push(sharesForThisBackup);
    }

    return backupNodes;
  }

  async distributeToOtherClusters(backupShares, otherClusters) {
    if (otherClusters.length === 0) {
      console.log('[CrossClusterBackup] No other clusters to distribute to');
      return;
    }

    console.log(`[CrossClusterBackup] Distributing ${backupShares.length} backup share sets to ${otherClusters.length} clusters`);
    const distribution = [];
    
    for (let i = 0; i < backupShares.length; i++) {
      const targetCluster = otherClusters[i % otherClusters.length];
      const randomNodeIndex = Math.floor(Math.random() * targetCluster.members.length);
      const targetNode = targetCluster.members[randomNodeIndex];
      
      distribution.push({
        backupIndex: i,
        shares: backupShares[i],
        targetCluster: targetCluster.clusterId,
        targetNode: targetNode
      });
    }

    // Send via P2P
    for (const dist of distribution) {
      await this.sendBackupToNode(dist.targetNode, dist.shares, dist.backupIndex);
      
      // Register on-chain (gas cost minimal - just address assignment)
      try {
        const tx = await this.registry.assignBackupNode(this.myClusterId, dist.targetNode);
        await tx.wait();
        console.log(`[CrossClusterBackup] Registered backup node ${dist.targetNode.slice(0, 10)} on-chain`);
      } catch (error) {
        console.error(`[CrossClusterBackup] Failed to register backup on-chain:`, error.message);
      }
    }

    this.backupShares.set(this.myClusterId, distribution);
    console.log('[CrossClusterBackup] Backup shares distributed successfully');
  }

  async sendBackupToNode(targetNodeAddress, shares, backupIndex) {
    // Encrypt shares with target node's public key
    const encryptedShares = shares.map(share => {
      return this.ecies.encryptForRecipient(share, targetNodeAddress);
    });

    // Get peer multiaddr
    const peerMultiaddr = this.peerAddrs.get(targetNodeAddress);
    if (!peerMultiaddr) {
      console.error(`[CrossClusterBackup] No P2P address for ${targetNodeAddress}`);
      // Fallback: store locally for now (peer will request later)
      await this.p2pNetwork.storeBackupShares(this.myClusterId, backupIndex, encryptedShares);
      return;
    }

    // Send via P2P
    const success = await this.p2pNetwork.sendBackupToPeer(
      peerMultiaddr,
      this.myClusterId,
      backupIndex,
      encryptedShares
    );

    if (!success) {
      console.error(`[CrossClusterBackup] Failed to send to peer, storing locally`);
      await this.p2pNetwork.storeBackupShares(this.myClusterId, backupIndex, encryptedShares);
    }
  }

  async rebalanceBackupShares() {
    console.log('[CrossClusterBackup] Rebalancing backup shares...');
    const healthyClusters = await this.getHealthyClusters();
    
    if (healthyClusters.length < 2) {
      console.log('[CrossClusterBackup] Not enough clusters for backup (need 2+), operating in standalone mode');
      return;
    }

    console.log(`[CrossClusterBackup] Found ${healthyClusters.length} healthy clusters`);
    const myCluster = healthyClusters.find(c => c.clusterId === this.myClusterId);
    
    if (!myCluster) {
      console.log('[CrossClusterBackup] My cluster not healthy, skipping backup creation');
      return;
    }

    const otherClusters = healthyClusters.filter(c => c.clusterId !== this.myClusterId);
    console.log(`[CrossClusterBackup] Ready to create backups. Will distribute to ${otherClusters.length} clusters`);
    
    await this.cleanupStaleBackups(healthyClusters);
  }

  async cleanupStaleBackups(healthyClusters) {
    const healthyClusterIds = new Set(healthyClusters.map(c => c.clusterId));
    
    // Get stored backups
    const storedBackups = await this.p2pNetwork.listStoredBackups();
    
    for (const backup of storedBackups) {
      if (!healthyClusterIds.has(backup.sourceCluster)) {
        console.log(`[CrossClusterBackup] Removing stale backup for dead cluster ${backup.sourceCluster}`);
        await this.p2pNetwork.deleteBackupShares(backup.sourceCluster);
      }
    }
  }

  async recoverFromCatastrophicFailure(remainingPrimaryShares) {
    console.log('[CrossClusterBackup] ⚠️  CATASTROPHIC FAILURE DETECTED - Attempting recovery with backup shares');
    
    // Get backup nodes from on-chain registry
    const backupNodes = await this.registry.getBackupNodes(this.myClusterId);
    
    if (backupNodes.length === 0) {
      console.log('[CrossClusterBackup] ❌ No backup nodes registered');
      return null;
    }

    console.log(`[CrossClusterBackup] Found ${backupNodes.length} backup nodes on-chain`);

    // Request backup shares via P2P
    const backupSharesCollected = await this.requestBackupSharesP2P(backupNodes);
    
    if (backupSharesCollected.length < this.BACKUP_THRESHOLD) {
      console.log(`[CrossClusterBackup] ❌ Not enough backup shares (have ${backupSharesCollected.length}, need ${this.BACKUP_THRESHOLD})`);
      return null;
    }

    console.log(`[CrossClusterBackup] ✅ Collected ${backupSharesCollected.length} backup shares`);
    const combinedShares = this.combinePrimaryAndBackup(remainingPrimaryShares, backupSharesCollected);
    console.log('[CrossClusterBackup] ✅ Successfully combined primary and backup shares for recovery');
    return combinedShares;
  }

  async requestBackupSharesP2P(backupNodes) {
    const collected = [];

    for (let i = 0; i < backupNodes.length; i++) {
      const backupNode = backupNodes[i];
      const peerMultiaddr = this.peerAddrs.get(backupNode.nodeAddress);
      
      if (!peerMultiaddr) {
        console.log(`[CrossClusterBackup] No P2P address for backup node ${backupNode.nodeAddress.slice(0, 10)}`);
        continue;
      }

      const shares = await this.p2pNetwork.requestBackupFromPeer(
        peerMultiaddr,
        this.myClusterId,
        i // backupIndex
      );

      if (shares) {
        // Decrypt shares
        const decryptedShares = shares.map(encShare => {
          return this.ecies.decrypt(encShare);
        });
        collected.push(decryptedShares);
      }

      if (collected.length >= this.BACKUP_THRESHOLD) {
        break;
      }
    }

    return collected;
  }

  combinePrimaryAndBackup(primaryShares, backupShares) {
    console.log(`[CrossClusterBackup] Combining ${primaryShares.length} primary shares + ${backupShares.length} backup shares`);
    const combinedForReconstruction = [];
    
    for (let keyIndex = 0; keyIndex < 11; keyIndex++) {
      const sharesForThisKey = [];
      
      // Add primary shares
      for (const nodeShares of primaryShares) {
        if (nodeShares && nodeShares[keyIndex]) {
          sharesForThisKey.push(nodeShares[keyIndex]);
        }
      }
      
      // Add backup shares
      const backupSharesForKey = [];
      for (const backup of backupShares) {
        if (backup && backup[keyIndex]) {
          backupSharesForKey.push(backup[keyIndex]);
        }
      }
      
      if (backupSharesForKey.length >= this.BACKUP_THRESHOLD) {
        const reconstructedFromBackup = secrets.combine(backupSharesForKey.slice(0, this.BACKUP_THRESHOLD));
        const additionalShares = secrets.share(reconstructedFromBackup, 11, 6);
        const needed = Math.max(0, 6 - sharesForThisKey.length);
        
        for (let i = 0; i < needed && i < additionalShares.length; i++) {
          sharesForThisKey.push(additionalShares[i]);
        }
        
        if (Buffer.isBuffer(reconstructedFromBackup)) {
          reconstructedFromBackup.fill(0);
        }
      }
      
      combinedForReconstruction.push(sharesForThisKey);
    }
    
    return combinedForReconstruction;
  }

  async checkIfCatastrophicFailure() {
    const myState = await this.getClusterState(this.myClusterId);
    return myState.activeNodes < 6;
  }

  getP2PNetwork() {
    return this.p2pNetwork;
  }
}

module.exports = CrossClusterBackupManager;
