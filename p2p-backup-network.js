const fs = require('fs').promises;
const path = require('path');

/**
 * P2P Backup Network using libp2p
 * Handles direct peer-to-peer backup share transfer
 * 
 * Note: libp2p v1.0+ requires ESM, so we use dynamic import
 */
class P2PBackupNetwork {
  constructor(wallet, port = 0) {
    this.wallet = wallet;
    this.nodeAddress = wallet.address || wallet;
    this.port = port;
    this.node = null;
    this.backupStoragePath = path.join(__dirname, 'backup_shares', this.nodeAddress);
    this.libp2pModule = null;
    
    // Protocol IDs
    this.PROTOCOL_BACKUP_REQUEST = '/xmrbridge/backup/request/1.0.0';
  }

  /**
   * Initialize libp2p node with dynamic import
   */
  async start() {
    console.log(`[P2P] Starting node for ${this.nodeAddress.slice(0, 10)}...`);
    
    try {
      // Dynamic import for ESM modules
      const [{ createLibp2p }, { tcp }, { mplex }, { noise }] = await Promise.all([
        import('libp2p'),
        import('@libp2p/tcp'),
        import('@libp2p/mplex'),
        import('@chainsafe/libp2p-noise')
      ]);

      this.node = await createLibp2p({
        addresses: {
          listen: [`/ip4/0.0.0.0/tcp/${this.port}`]
        },
        transports: [tcp()],
        streamMuxers: [mplex()],
        connectionEncryption: [noise()],
      });

      await this.node.start();
      
      // Setup protocol handlers
      await this.node.handle(this.PROTOCOL_BACKUP_REQUEST, this.handleBackupRequest.bind(this));
      
      console.log(`[P2P] Node started with ID: ${this.node.peerId.toString()}`);
      console.log(`[P2P] Listening on:`);
      this.node.getMultiaddrs().forEach(addr => {
        console.log(`  ${addr.toString()}`);
      });

      // Ensure backup storage directory exists
      await fs.mkdir(this.backupStoragePath, { recursive: true });
    } catch (error) {
      console.error('[P2P] Failed to start:', error.message);
      throw error;
    }
  }

  async stop() {
    if (this.node) {
      await this.node.stop();
      console.log('[P2P] Node stopped');
    }
  }

  async connectToPeer(peerMultiaddr) {
    try {
      await this.node.dial(peerMultiaddr);
      console.log(`[P2P] Connected to peer: ${peerMultiaddr}`);
      return true;
    } catch (error) {
      console.error(`[P2P] Failed to connect to ${peerMultiaddr}:`, error.message);
      return false;
    }
  }

  async storeBackupShares(sourceCluster, backupIndex, encryptedShares) {
    const filename = `${sourceCluster}_backup${backupIndex}.json`;
    const filepath = path.join(this.backupStoragePath, filename);
    
    const backupData = {
      sourceCluster,
      backupIndex,
      shares: encryptedShares,
      timestamp: Date.now(),
      nodeAddress: this.nodeAddress
    };

    await fs.writeFile(filepath, JSON.stringify(backupData, null, 2));
    console.log(`[P2P] Stored backup shares for cluster ${sourceCluster} (index ${backupIndex})`);
  }

  async retrieveBackupShares(sourceCluster, backupIndex) {
    try {
      const filename = `${sourceCluster}_backup${backupIndex}.json`;
      const filepath = path.join(this.backupStoragePath, filename);
      
      const data = await fs.readFile(filepath, 'utf8');
      const backupData = JSON.parse(data);
      
      console.log(`[P2P] Retrieved backup shares for cluster ${sourceCluster} (index ${backupIndex})`);
      return backupData.shares;
    } catch (error) {
      console.error(`[P2P] Failed to retrieve backup shares:`, error.message);
      return null;
    }
  }

  async sendBackupToPeer(peerMultiaddr, sourceCluster, backupIndex, encryptedShares) {
    try {
      const connection = await this.node.dial(peerMultiaddr);
      const stream = await connection.newStream(this.PROTOCOL_BACKUP_REQUEST);
      
      const message = {
        type: 'STORE_BACKUP',
        sourceCluster,
        backupIndex,
        shares: encryptedShares,
        timestamp: Date.now()
      };

      const messageBytes = Buffer.from(JSON.stringify(message));
      await stream.sink([messageBytes]);
      
      console.log(`[P2P] Sent backup shares to peer ${peerMultiaddr}`);
      return true;
    } catch (error) {
      console.error(`[P2P] Failed to send backup to peer:`, error.message);
      return false;
    }
  }

  async requestBackupFromPeer(peerMultiaddr, sourceCluster, backupIndex) {
    try {
      const connection = await this.node.dial(peerMultiaddr);
      const stream = await connection.newStream(this.PROTOCOL_BACKUP_REQUEST);
      
      const request = {
        type: 'REQUEST_BACKUP',
        sourceCluster,
        backupIndex,
        requester: this.nodeAddress
      };

      const requestBytes = Buffer.from(JSON.stringify(request));
      await stream.sink([requestBytes]);

      const response = await this.readStream(stream);
      const responseData = JSON.parse(response.toString());

      if (responseData.success) {
        console.log(`[P2P] Received backup shares from peer ${peerMultiaddr}`);
        return responseData.shares;
      } else {
        console.error(`[P2P] Peer returned error: ${responseData.error}`);
        return null;
      }
    } catch (error) {
      console.error(`[P2P] Failed to request backup from peer:`, error.message);
      return null;
    }
  }

  async handleBackupRequest({ stream }) {
    try {
      const data = await this.readStream(stream);
      const message = JSON.parse(data.toString());

      console.log(`[P2P] Received message type: ${message.type}`);

      if (message.type === 'STORE_BACKUP') {
        await this.storeBackupShares(
          message.sourceCluster,
          message.backupIndex,
          message.shares
        );

        const ack = { success: true };
        await stream.sink([Buffer.from(JSON.stringify(ack))]);

      } else if (message.type === 'REQUEST_BACKUP') {
        const shares = await this.retrieveBackupShares(
          message.sourceCluster,
          message.backupIndex
        );

        const response = shares 
          ? { success: true, shares }
          : { success: false, error: 'Backup not found' };

        await stream.sink([Buffer.from(JSON.stringify(response))]);
      }
    } catch (error) {
      console.error('[P2P] Error handling backup request:', error);
      const errorResponse = { success: false, error: error.message };
      await stream.sink([Buffer.from(JSON.stringify(errorResponse))]);
    }
  }

  async readStream(stream) {
    const chunks = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk.subarray());
    }
    return Buffer.concat(chunks);
  }

  getMultiaddrs() {
    return this.node ? this.node.getMultiaddrs().map(addr => addr.toString()) : [];
  }

  getPeerId() {
    return this.node ? this.node.peerId.toString() : null;
  }

  async listStoredBackups() {
    try {
      const files = await fs.readdir(this.backupStoragePath);
      const backups = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filepath = path.join(this.backupStoragePath, file);
          const data = await fs.readFile(filepath, 'utf8');
          const backup = JSON.parse(data);
          backups.push({
            sourceCluster: backup.sourceCluster,
            backupIndex: backup.backupIndex,
            timestamp: backup.timestamp
          });
        }
      }

      return backups;
    } catch (error) {
      console.error('[P2P] Error listing backups:', error);
      return [];
    }
  }

  async deleteBackupShares(sourceCluster) {
    try {
      const files = await fs.readdir(this.backupStoragePath);
      let deleted = 0;

      for (const file of files) {
        if (file.startsWith(sourceCluster)) {
          const filepath = path.join(this.backupStoragePath, file);
          await fs.unlink(filepath);
          deleted++;
        }
      }

      console.log(`[P2P] Deleted ${deleted} backup files for cluster ${sourceCluster}`);
      return deleted;
    } catch (error) {
      console.error('[P2P] Error deleting backups:', error);
      return 0;
    }
  }
}

module.exports = P2PBackupNetwork;
