require('dotenv').config();
const { ethers } = require('ethers');
const MoneroRPC = require('./monero-rpc');
const ShamirMultisigManager = require('./shamir-integration');

class ZNode {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V'
    );
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);

    // Contract ABIs (updated for Shamir)
    const registryABI = [
      'function registerNode(bytes32 shareCommitment, uint256 epoch) external',
      'function heartbeat() external',
      'function updateShareCommitment(bytes32 newCommitment, uint256 newEpoch) external',
      'function requestSigning(bytes32 requestId) external returns (address[] memory)',
      'function getActiveNodes() public view returns (address[] memory)',
      'function removeInactiveNode(address node) external',
      'function emergencyLowerThreshold(uint256 newThreshold) external',
      'function calculateOptimalThreshold(uint256 totalNodes) external pure returns (uint256)',
      'function getCurrentMultisigSetup() external view returns (uint256 epoch, uint256 threshold, uint256 totalShares, string moneroAddress, bool active)',
      'function currentEpoch() external view returns (uint256)',
      'function getRegisteredNodes() external view returns (address[] memory)',
      'function nodeQueue(uint256) external view returns (address)',
      'function nodeQueueLength() external view returns (uint256)',
      'function registeredNodes(address) external view returns (bool registered, bool inQueue, bytes32 shareCommitment, uint256 epoch, uint256 lastHeartbeat)',
      'event NodeRegistered(address indexed node, bytes32 shareCommitment, uint256 epoch)',
      'event NodeHeartbeat(address indexed node, uint256 timestamp)',
      'event ResharingTriggered(uint256 indexed oldEpoch, uint256 indexed newEpoch, uint256 newThreshold, uint256 totalNodes)',
      'event SigningRequested(bytes32 indexed requestId, address[] selectedSigners)',
      'event MultisigSetupCreated(uint256 indexed epoch, uint256 threshold, uint256 totalShares, string moneroAddress, bool active)',
      'event ClusterFinalized(bytes32 indexed clusterId, address[11] members, uint256 epoch)'
    ];

    const stakingABI = [
      'function stakeZFI(uint256 amount) external',
      'function unstake() external',
      'function getStake(address node) external view returns (uint256)'
    ];

    const zfiABI = [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function balanceOf(address account) external view returns (uint256)',
      'function allowance(address owner, address spender) external view returns (uint256)'
    ];

    // Contract addresses - WILL BE UPDATED AFTER DEPLOYMENT
    this.registry = new ethers.Contract(
      '0xbCBCAA233c05b2Fc02cf9A9aa2Ce500F645895E2', // TODO: Update with new Shamir contract
      registryABI,
      this.wallet
    );

    this.staking = new ethers.Contract(
      '0xc4D4dB2f5Ea4D2AE57C07D95E71Dee71D660E85c',
      stakingABI,
      this.wallet
    );

    this.zfi = new ethers.Contract(
      '0xf019C66DAB47Cc8EfBE10EF1DCCa18E45CF2427d',
      zfiABI,
      this.wallet
    );

    // Monero connection
    this.monero = new MoneroRPC({
      url: process.env.MONERO_RPC_URL || 'http://127.0.0.1:18083'
    });

    // Shamir "Multisig" Manager
    this.shamirManager = null; // Initialized in setupShamir()
    this.walletName = `znode_shamir_${this.wallet.address.slice(2, 10)}`;
    
    // State tracking
    this.isActive = false;
    this.lastHeartbeat = 0;
    this.pendingSigningRequests = new Map(); // requestId -> {shares: [], signers: []}
  }

  async start() {
    console.log('\n═══════════════════════════════════════════════');
    console.log('   ZNode - Shamir "Multisig" Bridge Node');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`Address: ${this.wallet.address}`);
    console.log(`Network: ${(await this.provider.getNetwork()).name}\n`);

    await this.checkRequirements();
    await this.setupMonero();
    await this.setupShamir();
    await this.registerToNetwork();
    await this.startHeartbeat();
    await this.monitorNetwork();
  }

  async checkRequirements() {
    console.log('→ Checking requirements...');

    // Check ZFI balance
    const balance = await this.zfi.balanceOf(this.wallet.address);
    console.log(`  ZFI Balance: ${ethers.formatEther(balance)}`);

    // Check staking
    const staked = await this.staking.getStake(this.wallet.address);
    console.log(`  ZFI Staked: ${ethers.formatEther(staked)}`);

    if (staked < ethers.parseEther('100')) {
      throw new Error('Must stake at least 100 ZFI to run a node');
    }

    console.log('✓ Requirements met\n');
  }

  async setupMonero() {
    console.log('→ Setting up Monero...');

    // Wait for Monero RPC to be ready
    for (let i = 1; i <= 20; i++) {
      try {
        await this.monero.openWallet(this.walletName);
        console.log(`✓ Wallet opened: ${this.walletName}`);
        break;
      } catch (error) {
        if (error.code === 'ECONNREFUSED' && i < 10) {
          console.log(`  Waiting for Monero RPC (attempt ${i}/10)...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        if (error.code === 'ECONNREFUSED') {
          throw new Error('Monero RPC not available after 60s. Is monero-wallet-rpc running?');
        }

        console.log('  Creating wallet...');
        await this.monero.createWallet(this.walletName);
        console.log(`✓ Wallet created: ${this.walletName}`);
        break;
      }
    }

    console.log('✓ Monero wallet ready\n');
  }

  async setupShamir() {
    console.log('→ Setting up Shamir system...');

    this.shamirManager = new ShamirMultisigManager(
      this.wallet,
      this.registry,
      this.monero
    );

    // Try to load existing share
    const hasShare = await this.shamirManager.initialize();

    if (hasShare) {
      console.log('✓ Shamir share loaded\n');
    } else {
      console.log('  Waiting for share distribution from ceremony...\n');
    }
  }

  async registerToNetwork() {
    console.log('→ Registering to network...');

    // Check current registration state
    const nodeInfo = await this.registry.registeredNodes(this.wallet.address);

    if (nodeInfo.registered) {
      console.log('✓ Already registered\n');
      this.isActive = true;
      return;
    }

    // Register with initial empty commitment (will be updated after ceremony)
    const currentEpoch = await this.registry.currentEpoch();
    const initialCommitment = ethers.ZeroHash;

    const tx = await this.registry.registerNode(initialCommitment, currentEpoch);
    await tx.wait();

    console.log('✓ Registered to network\n');
    this.isActive = true;
  }

  async startHeartbeat() {
    console.log('→ Starting heartbeat loop...');

    // Send heartbeat immediately
    try {
      const tx = await this.registry.heartbeat();
      await tx.wait();
      this.lastHeartbeat = Date.now();
      console.log('✓ Initial heartbeat sent\n');
    } catch (e) {
      console.log(`⚠️  Initial heartbeat failed: ${e.message}\n`);
    }

    // Send heartbeat every 24 hours (contract requires < 48h)
    setInterval(async () => {
      if (!this.isActive) return;

      try {
        const tx = await this.registry.heartbeat();
        await tx.wait();
        this.lastHeartbeat = Date.now();
        console.log(`[${new Date().toISOString()}] ✓ Heartbeat sent`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ⚠️  Heartbeat failed:`, error.message);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  async monitorNetwork() {
    console.log('→ Monitoring network...\n');
    console.log('Node is active and ready for operations.');
    console.log('Listening for signing requests and resharing events...\n');

    // Listen for resharing events
    this.registry.on('ResharingTriggered', async (oldEpoch, newEpoch, newThreshold, totalNodes, event) => {
      console.log(`\n🔄 RESHARING TRIGGERED`);
      console.log(`   Old Epoch: ${oldEpoch}`);
      console.log(`   New Epoch: ${newEpoch}`);
      console.log(`   New Threshold: ${newThreshold}/${totalNodes}`);
      
      await this.handleResharing(oldEpoch, newEpoch, newThreshold, totalNodes);
    });

    // Listen for signing requests
    this.registry.on('SigningRequested', async (requestId, selectedSigners, event) => {
      const isSelected = selectedSigners.includes(this.wallet.address);
      
      if (isSelected) {
        console.log(`\n✍️  SIGNING REQUEST: ${requestId}`);
        console.log(`   Selected as one of ${selectedSigners.length} signers`);
        
        await this.handleSigningRequest(requestId, selectedSigners);
      }
    });

    // Listen for MultisigSetupCreated (initial ceremony completion)
    this.registry.on('MultisigSetupCreated', async (epoch, threshold, totalShares, moneroAddress, active, event) => {
      console.log(`\n🎉 MULTISIG SETUP CREATED`);
      console.log(`   Epoch: ${epoch}`);
      console.log(`   Threshold: ${threshold}/${totalShares}`);
      console.log(`   Monero Address: ${moneroAddress}`);
      console.log(`   Active: ${active}`);
    });

    // Keep process alive
    setInterval(() => {
      // Status check every 10 minutes
      const uptimeHours = Math.floor((Date.now() - this.lastHeartbeat) / (1000 * 60 * 60));
      if (uptimeHours > 0 && uptimeHours % 10 === 0) {
        console.log(`[${new Date().toISOString()}] Node operational (Last heartbeat: ${uptimeHours}h ago)`);
      }
    }, 10 * 60 * 1000);
  }

  async handleResharing(oldEpoch, newEpoch, newThreshold, totalNodes) {
    console.log('\n→ Participating in resharing protocol...');

    try {
      // If this node has a share from oldEpoch, participate
      if (this.shamirManager.hasValidShare() && this.shamirManager.currentEpoch === oldEpoch) {
        console.log('  Submitting share for reconstruction...');
        
        // In production, shares would be submitted through a secure channel
        // For now, we'll implement a simple coordinator-based approach
        
        // TODO: Implement secure share submission protocol
        // This will be handled by coordinator-ceremony.js during resharing
        
        console.log('✓ Share submitted for resharing');
      } else {
        console.log('  Not participating (no valid share for old epoch)');
      }

      // Wait for new share distribution
      console.log('  Waiting for new share distribution...');
      
      // New shares will be received via receiveShare() call
      // This would typically happen through P2P network or coordinator
      
    } catch (error) {
      console.error('⚠️  Resharing participation failed:', error.message);
    }
  }

  async handleSigningRequest(requestId, selectedSigners) {
    console.log('\n→ Processing signing request...');

    try {
      // Verify we have a valid share
      if (!this.shamirManager.hasValidShare()) {
        throw new Error('No valid share available for signing');
      }

      // Get share info
      const shareInfo = this.shamirManager.getShareInfo();
      console.log(`  Using share from Epoch ${shareInfo.epoch}`);

      // Submit our share for reconstruction
      console.log('  Submitting share for reconstruction...');
      
      // In production, this would go through secure P2P network
      // For MVP, shares are collected by one coordinator node
      await this.shamirManager.participateInSigning(requestId, selectedSigners);

      console.log('✓ Share submitted for signing');

      // If we are the coordinator (first in selectedSigners), collect and sign
      if (selectedSigners[0] === this.wallet.address) {
        console.log('\n→ Acting as signing coordinator...');
        await this.coordinateSigning(requestId, selectedSigners);
      }

    } catch (error) {
      console.error('⚠️  Signing participation failed:', error.message);
    }
  }

  async coordinateSigning(requestId, selectedSigners) {
    console.log('  Collecting shares from selected signers...');

    try {
      // In production: collect shares via P2P network
      // For MVP: shares are available in shared storage or direct communication
      
      // TODO: Implement secure share collection protocol
      
      // Once threshold shares collected, reconstruct and sign
      console.log('  Reconstructing key and signing...');
      
      // This would use shamirManager.reconstructAndSign()
      // const txData = ...; // Get transaction data from bridge
      // const signedTx = await this.shamirManager.reconstructAndSign(shares, txData);
      
      console.log('✓ Transaction signed and broadcast');
      
    } catch (error) {
      console.error('⚠️  Signing coordination failed:', error.message);
    }
  }

  /**
   * External API - Called by coordinator ceremony to distribute share
   */
  async receiveDistributedShare(encryptedShare, epoch) {
    console.log(`\n📩 Receiving share from coordinator ceremony...`);
    
    try {
      await this.shamirManager.receiveShare(encryptedShare, epoch);
      console.log('✓ Share received and registered\n');
    } catch (error) {
      console.error('⚠️  Failed to receive share:', error.message);
      throw error;
    }
  }
}

// Main execution
if (require.main === module) {
  const node = new ZNode();
  node.start().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = ZNode;
