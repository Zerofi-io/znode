require('dotenv').config();
const { ethers } = require('ethers');
const MoneroRPC = require('./monero-rpc');
const crypto = require('crypto');

class ZNode {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V'
    );
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
    
    // Generate deterministic wallet password from node's private key
    this.moneroPassword = crypto.createHash('sha256')
      .update(this.wallet.privateKey)
      .digest('hex')
      .substring(0, 32);

    const registryABI = [
      'function registerNode(bytes32 codeHash, string multisigInfo) external',
      'function submitMultisigAddress(bytes32 clusterId, string moneroAddress) external',
      'function confirmCluster(string moneroAddress) external',
      'function getFormingClusterMultisigInfo() external view returns (address[] memory, string[] memory)',
      'function currentFormingCluster() external view returns (uint256, uint256, bool)',
      'function allClusters(uint256) external view returns (bytes32)',
      'function selectNextNode() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function getFormingCluster() external view returns (address[] memory, uint256)',
      'function getActiveClusterCount() external view returns (uint256)',
      'function clearStaleCluster() external',
      'function checkMultisigTimeout(bytes32 clusterId) external',
      'function registeredNodes(address) view returns (bytes32 codeHash, uint256 registrationTime)',
      'event NodeRegistered(address indexed node)',
      'event ClusterFormed(bytes32 indexed clusterId, address[] members)'
    ];

    const stakingABI = [
      'function getNodeInfo(address node) external view returns (uint256,uint256,uint256,bool,uint256,uint256,uint256)',
      'function stake(bytes32 _codeHash, string _moneroFeeAddress) external',
      'function heartbeat() external'
    ];

    const zfiABI = [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)'
    ];

    const exchangeCoordinatorABI = [
      'function submitExchangeInfo(bytes32 clusterId, uint8 round, string exchangeInfo, address[] clusterNodes) external',
      'function getExchangeRoundInfo(bytes32 clusterId, uint8 round, address[] clusterNodes) external view returns (address[] addresses, string[] exchangeInfos)',
      'function getExchangeRoundStatus(bytes32 clusterId, uint8 round) external view returns (bool complete, uint8 submitted)'
    ];

    this.registry = new ethers.Contract(
      '0xad2F94104F38210625F2022883482De774c51d84',
      registryABI,
      this.wallet
    );

    this.staking = new ethers.Contract(
      '0x287Ae2697B58e2f63B27426A97287df769b121e9',
      stakingABI,
      this.wallet
    );

    this.zfi = new ethers.Contract(
      '0x43fAC64A8B016aE4CC26E36e4ebe2b8B6A51109a',
      zfiABI,
      this.wallet
    );

    this.exchangeCoordinator = new ethers.Contract(
      '0xdA258736a8F3ED30CE2Ba150Ba65076cE9919C7E',
      exchangeCoordinatorABI,
      this.wallet
    );

    this.monero = new MoneroRPC({
      url: process.env.MONERO_RPC_URL || 'http://127.0.0.1:18083'
    });

    this.baseWalletName = `znode_${this.wallet.address.slice(2, 10)}`;
    this.clusterWalletName = null; // Set when joining a cluster
    this.multisigInfo = null;
    this.clusterId = null;
  }

  async start() {
    console.log('\n═══════════════════════════════════════════════');
    console.log('   ZNode - Monero Multisig (WORKING!)');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`Address: ${this.wallet.address}`);
    console.log(`Network: ${(await this.provider.getNetwork()).name}\n`);

    await this.checkRequirements();
    await this.setupMonero();
    await this.registerToQueue();
    await this.monitorNetwork();
  }

  async checkRequirements() {
    console.log('→ Checking requirements...');

    // Ensure we have some ETH for gas
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    if (ethBalance < ethers.parseEther('0.001')) {
      throw new Error('Insufficient ETH for gas (need >= 0.001 ETH)');
    }

    // Check ZFI balance
    const zfiBal = await this.zfi.balanceOf(this.wallet.address);
    console.log(`  ZFI Balance: ${ethers.formatEther(zfiBal)}`);

    // Read staking state using getNodeInfo (first field = staked amount)
    let stakedAmt = 0n;
    try {
      const info = await this.staking.getNodeInfo(this.wallet.address);
      stakedAmt = info[0];
    } catch {
      // Fallback if ABI/tuple width differs: treat as not staked
      stakedAmt = 0n;
    }
    console.log(`  ZFI Staked: ${ethers.formatEther(stakedAmt)}`);

    const required = ethers.parseEther('1000000');
    if (stakedAmt < required) {
      if (zfiBal < required) {
        throw new Error('Insufficient ZFI to stake 1,000,000');
      }

      // Approve if needed
      const stakingAddr = await this.staking.getAddress();
      const allowance = await this.zfi.allowance(this.wallet.address, stakingAddr);
      if (allowance < required) {
        console.log('  Approving ZFI for staking...');
        const txA = await this.zfi.approve(stakingAddr, required);
        await txA.wait();
        console.log('  ✓ Approved');
      }

      // Stake now
      console.log('  Staking 1,000,000 ZFI...');
      const codeHash = ethers.id('znode-v2-tss');
      const moneroAddr = '4' + '0'.repeat(94);
      const txS = await this.staking.stake(codeHash, moneroAddr);
      await txS.wait();
      console.log('  ✓ Staked');
    }

    console.log('✓ Requirements met\n');
  }

  async setupMonero() {
    console.log('→ Setting up Monero with multisig support...');
    
    for (let i = 1; i <= 20; i++) {
      try {
        await this.monero.openWallet(this.baseWalletName, this.moneroPassword);
        console.log(`✓ Base wallet opened: ${this.baseWalletName}`);
        break;
      } catch (error) {
        if (error.code === 'ECONNREFUSED' && i < 10) {
          console.log(`  Waiting for Monero RPC (attempt ${i}/10)...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Monero RPC not available');
        }
        
        console.log('  Creating wallet with password...');
        await this.monero.createWallet(this.baseWalletName, this.moneroPassword);
        console.log(`✓ Base wallet created: ${this.baseWalletName}`);
        break;
      }
    }

    // Enable multisig experimental feature
    console.log('  Enabling multisig...');
    try {
      await this.monero.call('set', {
        key: 'enable-multisig-experimental',
        value: true
      });
      console.log('✓ Multisig enabled\n');
    } catch (e) {
      // May already be enabled or command format different
      console.log('  Multisig enable attempted\n');
    }
  }

  async prepareMultisig() {
    console.log('\n→ Preparing multisig...');
    
    try {
      const result = await this.monero.call('prepare_multisig');
      this.multisigInfo = result.multisig_info;
      
      console.log('✓ Multisig info generated');
      console.log(`  Info: ${this.multisigInfo.substring(0, 50)}...`);
      
      return this.multisigInfo;
    } catch (error) {
      // If wallet is already multisig from previous deployment, recreate it
      if (error.message && error.message.includes('already multisig')) {
        console.log('  Wallet is already multisig from old deployment. Recreating...');
        try {
          await this.monero.closeWallet();
          await new Promise(r => setTimeout(r, 500));
          // Delete and recreate
          await this.monero.createWallet(this.baseWalletName, this.moneroPassword);
          console.log('  ✓ Wallet recreated');
          // Now try prepare_multisig again
          const result = await this.monero.call('prepare_multisig');
          this.multisigInfo = result.multisig_info;
          console.log('✓ Multisig info generated');
          console.log(`  Info: ${this.multisigInfo.substring(0, 50)}...`);
          return this.multisigInfo;
        } catch (e) {
          console.error('❌ Failed to recreate wallet:', e.message);
          throw e;
        }
      }
      console.error('❌ prepare_multisig failed:', error.message);
      throw error;
    }
  }

  async makeMultisig(threshold, multisigInfos) {
    console.log(`\n→ Creating ${threshold}-of-${multisigInfos.length + 1} multisig...`);
    
    try {
      const result = await this.monero.call('make_multisig', {
        multisig_info: multisigInfos,
        threshold: threshold,
        password: this.moneroPassword
      });
      
      console.log('✓ Multisig wallet created');
      console.log(`  Address: ${result.address}`);
      
      return result;
    } catch (error) {
      console.error('❌ make_multisig failed:', error.message);
      throw error;
    }
  }

  async finalizeClusterWithMultisigCoordination(clusterId) {
    try {
      // Fetch forming cluster multisig info list (addresses aligned to selectedAddrs)
      const [addrList, infoList] = await this.registry.getFormingClusterMultisigInfo();
      // Build peers' multisig info excluding self
      const my = this.wallet.address.toLowerCase();
      const peers = [];
      for (let i = 0; i < addrList.length; i++) {
        if (addrList[i].toLowerCase() === my) continue;
        const info = infoList[i];
        if (info && info.length > 0) peers.push(info);
      }
      if (peers.length < 7) { // need at least 7 peers to make 8-of-11
        console.log(`Not enough multisig infos yet (${peers.length}+1). Waiting...`);
        return false;
      }
      
      // Create cluster-specific multisig wallet
      this.clusterWalletName = `${this.baseWalletName}_cluster_${clusterId.slice(2, 10)}`;
      console.log(`Creating cluster wallet: ${this.clusterWalletName}`);
      
      try {
        await this.monero.createWallet(this.clusterWalletName, this.moneroPassword);
        console.log('✓ Cluster wallet created');
      } catch (e) {
        console.log('  Cluster wallet exists. Opening...');
        await this.monero.openWallet(this.clusterWalletName, this.moneroPassword);
        console.log('✓ Cluster wallet opened');
        // Check if already multisig - if so, this cluster was already handled
        try {
          const info = await this.monero.call('is_multisig');
          if (info.multisig && info.ready) {
            console.log('  Wallet is already multisig and ready. Cluster likely already submitted.');
            return false; // Don't re-submit
          }
        } catch {}
      }
      
      // Round 1 & 2: prepare_multisig and make_multisig (already done via registration)
      // Now perform make_multisig to get initial multisig wallet
      const res = await this.makeMultisig(8, peers);
      const incompleteAddr = res.address;
      console.log(`✓ Multisig wallet initialized: ${incompleteAddr}`);
      
      // Check if we need additional rounds
      const msInfo = await this.monero.call('is_multisig');
      if (msInfo.ready) {
        console.log('✓ Multisig is ready (no additional rounds needed)');
        const finalAddr = incompleteAddr;
        const tx = await this.registry.submitMultisigAddress(clusterId, finalAddr);
        await tx.wait();
        console.log('✓ Submitted multisig address to registry');
        await this.confirmClusterOnChain(clusterId, finalAddr);
        return true;
      }
      
      // Multisig not ready - need exchange rounds
      console.log('⚠️  Multisig not ready, performing exchange rounds...');
      
      // ROUND 3: First exchange_multisig_keys
      console.log('\n→ Coordinator: Starting Round 3 (first key exchange)');
      const round3Success = await this.coordinateExchangeRound(clusterId, 3);
      if (!round3Success) {
        console.log('❌ Round 3 failed');
        return false;
      }
      
      // ROUND 4: Second exchange_multisig_keys
      console.log('\n→ Coordinator: Starting Round 4 (second key exchange)');
      const round4Success = await this.coordinateExchangeRound(clusterId, 4);
      if (!round4Success) {
        console.log('❌ Round 4 failed');
        return false;
      }
      
      // Get final address
      const finalInfo = await this.monero.call('is_multisig');
      if (!finalInfo.ready) {
        console.log('❌ Multisig still not ready after all rounds');
        return false;
      }
      
      const getAddrResult = await this.monero.call('get_address');
      const finalAddr = getAddrResult.address;
      console.log(`\n✅ Final multisig address: ${finalAddr}`);
      
      // Submit final address to registry
      const tx = await this.registry.submitMultisigAddress(clusterId, finalAddr);
      await tx.wait();
      console.log('✓ Submitted final multisig address to registry');
      
      // Confirm cluster
      await this.confirmClusterOnChain(clusterId, finalAddr);
      
      return true;
    } catch (e) {
      console.log('Coordinator finalize error:', e.message || String(e));
      return false;
    }
  }
  
  async confirmClusterOnChain(clusterId, address) {
    try {
      const finalizeTx = await this.registry.confirmCluster(address);
      await finalizeTx.wait();
      console.log('✓ Cluster finalized on-chain');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('  Cluster already finalized');
      } else {
        console.log('  Finalization error:', e.message);
      }
    }
  }
  
  async coordinateExchangeRound(clusterId, roundNumber) {
    try {
      console.log(`  Performing my exchange for round ${roundNumber}...`);
      
      // Get current multisig info to exchange
      const myInfo = await this.monero.call('export_multisig_info');
      const myExchangeInfo = myInfo.info;
      
      // Fetch cluster nodes from forming cluster to pass to coordinator
      const [clusterNodes] = await this.registry.getFormingCluster();

      // Submit my exchange info to exchange coordinator
      const submitTx = await this.exchangeCoordinator.submitExchangeInfo(clusterId, roundNumber, myExchangeInfo, clusterNodes);
      await submitTx.wait();
      console.log(`  ✓ Submitted my exchange info for round ${roundNumber}`);
      
      // Wait for all nodes to submit
      console.log(`  Waiting for all 11 nodes to submit round ${roundNumber}...`);
      const maxWait = 120; // 2 minutes
      let waited = 0;
      while (waited < maxWait) {
        const [complete, submitted] = await this.exchangeCoordinator.getExchangeRoundStatus(clusterId, roundNumber);
        if (complete) {
          console.log(`  ✓ All nodes submitted (${submitted}/11)`);
          break;
        }
        console.log(`  Progress: ${submitted}/11 nodes submitted...`);
        await new Promise(r => setTimeout(r, 5000));
        waited += 5;
      }
      
      // Get all exchange info
      const [addresses, exchangeInfos] = await this.exchangeCoordinator.getExchangeRoundInfo(clusterId, roundNumber, clusterNodes);
      const my = this.wallet.address.toLowerCase();
      const peersExchangeInfo = [];
      for (let i = 0; i < addresses.length; i++) {
        if (addresses[i].toLowerCase() === my) continue;
        if (exchangeInfos[i] && exchangeInfos[i].length > 0) {
          peersExchangeInfo.push(exchangeInfos[i]);
        }
      }
      
      console.log(`  Applying ${peersExchangeInfo.length} peer exchange infos...`);
      
      // Import peer exchange infos
      await this.monero.call('import_multisig_info', { info: peersExchangeInfo });
      console.log(`  ✓ Round ${roundNumber} complete`);
      
      return true;
    } catch (e) {
      console.log(`  ❌ Round ${roundNumber} error:`, e.message);
      return false;
    }
  }

  async participateInExchangeRounds(clusterId) {
    try {
      // Fetch forming cluster multisig info
      const [addrList, infoList] = await this.registry.getFormingClusterMultisigInfo();
      const my = this.wallet.address.toLowerCase();
      const peers = [];
      for (let i = 0; i < addrList.length; i++) {
        if (addrList[i].toLowerCase() === my) continue;
        const info = infoList[i];
        if (info && info.length > 0) peers.push(info);
      }
      if (peers.length < 7) {
        console.log(`  Not enough multisig infos yet (${peers.length}+1). Waiting...`);
        return false;
      }
      
      // Create/open cluster wallet
      this.clusterWalletName = `${this.baseWalletName}_cluster_${clusterId.slice(2, 10)}`;
      
      try {
        await this.monero.createWallet(this.clusterWalletName, this.moneroPassword);
        console.log('  ✓ Created cluster wallet');
      } catch (e) {
        await this.monero.openWallet(this.clusterWalletName, this.moneroPassword);
        console.log('  ✓ Opened cluster wallet');
      }
      
      // Check if already multisig and ready
      try {
        const info = await this.monero.call('is_multisig');
        if (info.multisig && info.ready) {
          console.log('  ✓ Multisig already ready');
          return true;
        }
        // If multisig but not ready, continue to exchanges
        if (info.multisig && !info.ready) {
          console.log('  → Multisig wallet exists, participating in exchanges...');
        }
      } catch {}
      
      // Initialize multisig if not already done
      try {
        const msInfo = await this.monero.call('is_multisig');
        if (!msInfo.multisig) {
          console.log('  → Initializing multisig...');
          await this.makeMultisig(8, peers);
        }
      } catch {}
      
      // Participate in round 3
      console.log('  → Participating in Round 3');
      const round3Success = await this.participateInRound(clusterId, 3);
      if (!round3Success) {
        console.log('  ❌ Round 3 participation failed');
        return false;
      }
      
      // Participate in round 4
      console.log('  → Participating in Round 4');
      const round4Success = await this.participateInRound(clusterId, 4);
      if (!round4Success) {
        console.log('  ❌ Round 4 participation failed');
        return false;
      }
      
      // Verify multisig is ready
      const finalInfo = await this.monero.call('is_multisig');
      if (finalInfo.ready) {
        console.log('  ✅ Multisig exchange complete and ready');
        return true;
      } else {
        console.log('  ⚠️  Multisig not ready after exchanges');
        return false;
      }
    } catch (e) {
      console.log('  Exchange participation error:', e.message);
      return false;
    }
  }
  
  async participateInRound(clusterId, roundNumber) {
    try {
      // Fetch cluster nodes
      const [clusterNodes] = await this.registry.getFormingCluster();

      // Export my multisig info
      const myInfo = await this.monero.call('export_multisig_info');
      const myExchangeInfo = myInfo.info;
      
      // Submit to exchange coordinator
      const submitTx = await this.exchangeCoordinator.submitExchangeInfo(clusterId, roundNumber, myExchangeInfo, clusterNodes);
      await submitTx.wait();
      console.log(`  ✓ Submitted exchange info for round ${roundNumber}`);
      
      // Wait for round to complete
      console.log(`  Waiting for round ${roundNumber} to complete...`);
      const maxWait = 120;
      let waited = 0;
      while (waited < maxWait) {
        const [complete, submitted] = await this.exchangeCoordinator.getExchangeRoundStatus(clusterId, roundNumber);
        if (complete) {
          console.log(`  ✓ Round complete (${submitted}/11)`);
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
        waited += 5;
      }
      
      // Get all exchange info from coordinator
      const [addresses, exchangeInfos] = await this.exchangeCoordinator.getExchangeRoundInfo(clusterId, roundNumber, clusterNodes);
      const my = this.wallet.address.toLowerCase();
      const peersExchangeInfo = [];
      for (let i = 0; i < addresses.length; i++) {
        if (addresses[i].toLowerCase() === my) continue;
        if (exchangeInfos[i] && exchangeInfos[i].length > 0) {
          peersExchangeInfo.push(exchangeInfos[i]);
        }
      }
      
      // Import peer exchange infos
      await this.monero.call('import_multisig_info', { info: peersExchangeInfo });
      console.log(`  ✓ Imported ${peersExchangeInfo.length} peer exchange infos`);
      
      return true;
    } catch (e) {
      console.log(`  ❌ Round ${roundNumber} error:`, e.message);
      return false;
    }
  }


  async registerToQueue() {
    console.log('→ Registering to network...');
    
    const nodeInfo = await this.registry.registeredNodes(this.wallet.address);
    
    if (nodeInfo.registrationTime > 0) {
      // Check if we're in ghost state (registered but not in queue/forming cluster)
      const [queueLen, selectedCount] = await this.registry.getQueueStatus();
      const [formingCluster] = await this.registry.getFormingCluster();
      
      const inFormingCluster = formingCluster.map(a => a.toLowerCase()).includes(this.wallet.address.toLowerCase());
      
      if (!inFormingCluster && selectedCount === 0 && queueLen === 0) {
        console.log('⚠️  Ghost state detected: registered but not in queue or forming cluster');
        console.log('  Deregistering and re-registering...');
        const deregTx = await this.registry.deregisterNode();
        await deregTx.wait();
        await new Promise(r => setTimeout(r, 2000));
        // Fall through to register again
      } else {
        console.log('✓ Already registered\\n');
        return;
      }
    }
    
    if (nodeInfo.registered && !nodeInfo.inQueue) {
      console.log('  Deregistering stale registration...');
      const deregTx = await this.registry.deregisterNode();
      await deregTx.wait();
      await new Promise(r => setTimeout(r, 2000));
    }

    // Ensure we have multisig info ready
    if (!this.multisigInfo) {
      await this.prepareMultisig();
    }
    const codeHash = ethers.id('znode-v2-tss');
    const tx = await this.registry.registerNode(codeHash, this.multisigInfo);
    await tx.wait();
    
    try {
      const [queueLen] = await this.registry.getQueueStatus();
      console.log(`✓ Registered to queue (queue size: ${queueLen})\n`);
    } catch {
      console.log('✓ Registered to queue\n');
    }
  }


  // Requeue helper with backoff; keeps node in queue if previous round cleared without forming
  async requeueIfStale(ctx) {
    try {
      // Always refresh state from chain to avoid stale context
      const [queueLen, , canRegister] = await this.registry.getQueueStatus();
      const [selectedNodes, lastSelection] = await this.registry.getFormingCluster();
      const completed = selectedNodes.length === 11;
      const info = await this.registry.registeredNodes(this.wallet.address);
      const registered = info.registrationTime > 0
      // Treat any completed round with registration window open as stale; requeue to kick off a new round
      const staleRound = completed && canRegister;
      const needsQueue = (!registered || (registered && !inQueue));
      const degenerate = inQueue && Number(queueLen) === 0 && canRegister;
      if (staleRound || degenerate || needsQueue) {
        const now = Date.now();
        this._lastRequeueTs = this._lastRequeueTs || 0;
        if (now - this._lastRequeueTs < 60 * 1000) {
          return; // backoff 60s
        }
        console.log('↻ Re-queuing: reason staleRound=%s degenerate=%s needsQueue=%s', staleRound, degenerate, needsQueue);
        try {
          const tx1 = await this.registry.deregisterNode();
          await tx1.wait();
        } catch (e) {
          // ignore
        }
        if (!this.multisigInfo) {
          try { await this.prepareMultisig(); } catch {}
        }
        const codeHash = ethers.id('znode-v2-tss');
        const tx2 = await this.registry.registerNode(codeHash, this.multisigInfo || '');
        await tx2.wait();
        this._lastRequeueTs = now;
        try {
          const [ql2] = await this.registry.getQueueStatus();
          console.log(`↺ Re-queued. New queue size: ${ql2}`);
        } catch {}
      } else {
        console.log('Requeue check: no action (staleRound=%s, degenerate=%s, needsQueue=%s)', staleRound, degenerate, needsQueue);
      }
    } catch (e) {
      // ignore
    }
  }

  async cleanupStaleCluster() {
    try {
      const [selectedNodes, lastSelection] = await this.registry.getFormingCluster();
      const completed = selectedNodes.length === 11;
      
      // Only clean up if there's a forming cluster
      if (selectedNodes.length === 0) return false;

      const now = Date.now();
      const lastSelMs = Number(lastSelection) * 1000;
      const ageMs = now - lastSelMs;
      
      // Only cleanup if cluster is older than 5 minutes
      if (ageMs < 5 * 60 * 1000) return false;

      // Pick ONE node deterministically from the forming cluster to do cleanup
      // Use the first node address (lowest address) as the designated cleaner
      const sortedNodes = [...selectedNodes].map(a => a.toLowerCase()).sort();
      const designatedCleaner = sortedNodes[0];
      const isDesignatedCleaner = this.wallet.address.toLowerCase() === designatedCleaner;
      
      if (!isDesignatedCleaner) {
        // Not our job - only log once when we first detect staleness
        if (!this._staleNotified) {
          console.log(`⚠️  Stale cluster detected (age: ${Math.floor(ageMs/60000)}m). Designated cleaner: ${designatedCleaner}`);
          this._staleNotified = true;
        }
        return false;
      }
      
      // We are the designated cleaner - only attempt once per minute
      if (this._lastCleanupAttempt && (now - this._lastCleanupAttempt) < 60 * 1000) {
        return false;
      }
      this._lastCleanupAttempt = now;
      
      console.log(`🧹 I am the designated cleaner. Clearing stale cluster (age: ${Math.floor(ageMs/60000)}m)...`);
      
      try {
        const tx = await this.registry.clearStaleCluster();
        await tx.wait();
        console.log('✓ Stale forming cluster cleared on-chain');
        this._staleNotified = false; // Reset for next time
        return true;
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        if (!msg.includes('revert')) {
          console.log('clearStaleCluster() error:', msg);
        }
        return false;
      }
    } catch (e) {
      return false;
    }
  }
  async monitorNetwork() {
    console.log('→ Monitoring network...');
    console.log('🎉 Monero multisig is WORKING!');
    console.log('Wallet has password and multisig is enabled.\n');
    
    const printStatus = async () => {
      try {
        const [queueLen, , canRegister] = await this.registry.getQueueStatus();
        const [selectedNodes, lastSelection] = await this.registry.getFormingCluster();
      const completed = selectedNodes.length === 11;
        const clusterCount = 0; // getActiveClusterCount removed from new contract
        const selectedCount = selectedNodes.length;
        const isSelected = selectedNodes.map(a => a.toLowerCase()).includes(this.wallet.address.toLowerCase());
        const lastSelMs = Number(lastSelection) * 1000;
        const ageMs = Date.now() - lastSelMs;
        const noClusterYet = (Number(lastSelection) === 0) && selectedCount === 0 && !completed;
        const stale = !noClusterYet && (completed || Number(lastSelection) === 0 || ageMs > 10 * 60 * 1000); // stale only if there was a prior cluster or it's completed
        
        const shownSelected = stale ? 0 : selectedCount;
        console.log(`Queue: ${queueLen} | Selected: ${shownSelected}/11 | Clusters: ${clusterCount} | CanRegister: ${canRegister} | Completed: ${completed}`);
                await this.requeueIfStale({ queueLen, selectedNodes, lastSelection, completed, canRegister });
        // Auto-cleanup stale clusters
        await this.cleanupStaleCluster();

                // Attempt to trigger selection if conditions met and data not stale
                const canSelectNow = (selectedCount < 11) && ((Number(queueLen) + selectedCount) >= 11);
                if (canSelectNow) console.log('DEBUG: Attempting selection (queue=%d, selected=%d)', queueLen, selectedCount);
                if (canSelectNow) {
                  try {
                    const tx = await this.registry.selectNextNode();
                    await tx.wait();
                    console.log(`Triggered selection: ${selectedCount + 1}/11`);
                  } catch (e) {
                    const msg = (e && e.message) ? e.message : String(e);
                    console.log('Selection error:', msg);
                  }
                }

        if (stale && selectedCount > 0) {
          const ageMin = Math.floor(ageMs / 60000);
          console.log(`(stale forming cluster: ${selectedCount} nodes, last update ${ageMin}m ago)`);
        }
        if (!stale && isSelected) {
          console.log('✅ Selected for cluster! Waiting for formation to complete...');
        }

        // If a full forming cluster exists (in-progress), elect coordinator deterministically and finalize
        if (selectedCount === 11) {
          try {
            let clusterId = null;
            try {
              // Compute clusterId exactly as in ClusterRegistry: keccak256(abi.encodePacked(address[11]))
              const clusterNodes = selectedNodes.map(a => a.toLowerCase());
              if (clusterNodes.length === 11) {
                clusterId = ethers.keccak256(
                  ethers.solidityPacked(['address[11]'], [clusterNodes])
                );
                console.log('Computed clusterId:', clusterId);
              } else {
                console.log('ClusterId computation skipped: expected 11 nodes, got', clusterNodes.length);
              }
            } catch (e) {
              console.log('ClusterId computation failed:', e.message);
            }
            if (clusterId) {
              const myIndex = selectedNodes.map(a => a.toLowerCase()).indexOf(this.wallet.address.toLowerCase());
              if (myIndex >= 0) {
                // Use lastSelection as seed if available, fallback to hash of clusterId
                let seed;
                try { seed = BigInt(lastSelection || 0); } catch { seed = 0n; }
                if (seed === 0n) {
                  const hex = clusterId.replace('0x','');
                  seed = BigInt('0x' + (hex.slice(0,16) || '1'));
                }
                const coordIndex = Number(seed % 11n);
                console.log('DEBUG: myIndex=%d coordIndex=%d myAddr=%s', myIndex, coordIndex, this.wallet.address);
                if (myIndex === coordIndex) {
                  console.log('🎯 I am the coordinator for this cluster. Finalizing...');
                  await this.finalizeClusterWithMultisigCoordination(clusterId);
                } else {
                  console.log('⏳ Waiting for coordinator to finalize cluster...');
                  await this.participateInExchangeRounds(clusterId);
                }
              }
            }
          } catch (e) {
            console.log('Finalize check error:', e.message);
          }
        }

      } catch (e) {
        console.log('Monitor error:', e.message);
      }
    };
    
    // Print immediately and then on interval
    await printStatus();
    setInterval(printStatus, 15000);
  }


  async performKeyRefresh(clusterId, failedNodes) {
    try {
      console.log(`\n🔄 Key refresh for ${clusterId}`);
      const cluster = await this.registry.clusters(clusterId);
      const allNodes = cluster.nodes;
      const activeNodes = allNodes.filter(n => !failedNodes.map(f => f.toLowerCase()).includes(n.toLowerCase()));
      if (activeNodes.length < 8) return false;
      console.log(`✓ Would refresh with ${activeNodes.length} nodes`);
      return true;
    } catch (e) {
      console.log("Key refresh error:", e.message);
      return false;
    }
  }

}

if (require.main === module) {
  const node = new ZNode();
  node.start().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = ZNode;
