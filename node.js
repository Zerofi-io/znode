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
      'function submitExchangeInfo(bytes32 clusterId, uint8 round, string exchangeInfo) external',
      'function getExchangeRoundInfo(bytes32 clusterId, uint8 round) external view returns (address[] addresses, string[] exchangeInfos)',
      'function getExchangeRoundStatus(bytes32 clusterId, uint8 round) external view returns (bool complete, uint8 submitted)',
      'function getFormingClusterMultisigInfo() external view returns (address[] memory, string[] memory)',
      'function currentFormingCluster() external view returns (uint256, uint256, bool)',
      'function allClusters(uint256) external view returns (bytes32)',
      'function selectNextNode() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function getFormingCluster() external view returns (address[] memory, uint256, bool)',
      'function getActiveClusterCount() external view returns (uint256)',
      'function clearStaleCluster() external',
      'function checkMultisigTimeout(bytes32 clusterId) external',
      'function registeredNodes(address) view returns (bool registered, bytes32 codeHash, string multisigInfo, uint256 registeredAt, bool inQueue, uint256 multisigSubmittedBlock)',
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

    this.registry = new ethers.Contract(
      '0xbCBCAA233c05b2Fc02cf9A9aa2Ce500F645895E2',
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

  async exchangeMultisigKeys(multisigInfos, password) {
    console.log(`\\n→ Exchanging multisig keys (${multisigInfos.length} peers)...`);
    
    try {
      const result = await this.monero.call('exchange_multisig_keys', {
        multisig_info: multisigInfos,
        password: password || this.moneroPassword
      });
      
      console.log('✓ Keys exchanged');
      if (result.address) {
        console.log(`  Address: ${result.address}`);
      }
      
      return result;
    } catch (error) {
      console.error('❌ exchange_multisig_keys failed:', error.message);
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
      console.log('\\n→ Coordinator: Starting Round 3 (first key exchange)');
      const round3Success = await this.coordinateExchangeRound(clusterId, 3);
      if (!round3Success) {
        console.log('❌ Round 3 failed');
        return false;
      }
      
      // ROUND 4: Second exchange_multisig_keys
      console.log('\\n→ Coordinator: Starting Round 4 (second key exchange)');
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
      console.log(`\\n✅ Final multisig address: ${finalAddr}`);
      
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
      
      // Submit my exchange info
      const submitTx = await this.registry.submitExchangeInfo(clusterId, roundNumber, myExchangeInfo);
      await submitTx.wait();
      console.log(`  ✓ Submitted my exchange info for round ${roundNumber}`);
      
      // Wait for all nodes to submit
      console.log(`  Waiting for all 11 nodes to submit round ${roundNumber}...`);
      const maxWait = 120; // 2 minutes
      let waited = 0;
      while (waited < maxWait) {
        const [complete, submitted] = await this.registry.getExchangeRoundStatus(clusterId, roundNumber);
        if (complete) {
          console.log(`  ✓ All nodes submitted (${submitted}/11)`);
          break;
        }
        console.log(`  Progress: ${submitted}/11 nodes submitted...`);
        await new Promise(r => setTimeout(r, 5000));
        waited += 5;
      }
      
      // Get all exchange info
      const [addresses, exchangeInfos] = await this.registry.getExchangeRoundInfo(clusterId, roundNumber);
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
  async participateInExchangeRounds(clusterId) {    try {      // Open cluster wallet      this.clusterWalletName = `${this.baseWalletName}_cluster_${clusterId.slice(2, 10)}`;            try {        await this.monero.openWallet(this.clusterWalletName, this.moneroPassword);      } catch (e) {        console.log('  ⚠️  Cluster wallet not found, cannot participate in exchange');        return false;      }            // Check if multisig is already ready      const msInfo = await this.monero.call('is_multisig');      if (msInfo.ready) {        console.log('  ✓ Multisig already ready');        return true;      }            // Participate in round 3      console.log('\n→ Participating in Round 3');      const round3Success = await this.participateInRound(clusterId, 3);      if (!round3Success) {        console.log('  ❌ Round 3 participation failed');        return false;      }            // Participate in round 4      console.log('\n→ Participating in Round 4');      const round4Success = await this.participateInRound(clusterId, 4);      if (!round4Success) {        console.log('  ❌ Round 4 participation failed');        return false;      }            // Verify multisig is ready      const finalInfo = await this.monero.call('is_multisig');      if (finalInfo.ready) {        console.log('\n✅ Multisig exchange complete and ready');        return true;      } else {        console.log('  ⚠️  Multisig not ready after exchanges');        return false;      }    } catch (e) {      console.log('  Exchange participation error:', e.message);      return false;    }  }    async participateInRound(clusterId, roundNumber) {    try {      // Export my multisig info      const myInfo = await this.monero.call('export_multisig_info');      const myExchangeInfo = myInfo.info;            // Submit to registry      const submitTx = await this.registry.submitExchangeInfo(clusterId, roundNumber, myExchangeInfo);      await submitTx.wait();      console.log(`  ✓ Submitted exchange info for round ${roundNumber}`);            // Wait for round to complete      console.log(`  Waiting for round ${roundNumber} to complete...`);      const maxWait = 120;      let waited = 0;      while (waited < maxWait) {        const [complete, submitted] = await this.registry.getExchangeRoundStatus(clusterId, roundNumber);        if (complete) {          console.log(`  ✓ Round complete (${submitted}/11)`);          break;        }        await new Promise(r => setTimeout(r, 5000));        waited += 5;      }            // Get all exchange info from registry      const [addresses, exchangeInfos] = await this.registry.getExchangeRoundInfo(clusterId, roundNumber);      const my = this.wallet.address.toLowerCase();      const peersExchangeInfo = [];      for (let i = 0; i < addresses.length; i++) {        if (addresses[i].toLowerCase() === my) continue;        if (exchangeInfos[i] && exchangeInfos[i].length > 0) {          peersExchangeInfo.push(exchangeInfos[i]);        }      }            // Import peer exchange infos      await this.monero.call('import_multisig_info', { info: peersExchangeInfo });      console.log(`  ✓ Imported ${peersExchangeInfo.length} peer exchange infos`);            return true;    } catch (e) {      console.log(`  ❌ Round ${roundNumber} error:`, e.message);      return false;    }  }\
  async registerToQueue() {
    console.log('→ Registering to network...');
    
    const nodeInfo = await this.registry.registeredNodes(this.wallet.address);
    
    if (nodeInfo.registered && nodeInfo.inQueue) {
      console.log('✓ Already registered\n');
      return;
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
      const [selectedNodes, lastSelection, completed] = await this.registry.getFormingCluster();
      const info = await this.registry.registeredNodes(this.wallet.address);
      const registered = (info.registered !== undefined) ? info.registered : info[0];
      const inQueue = (info.inQueue !== undefined) ? info.inQueue : info[4];
      const selectedCount = selectedNodes.length;
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
      const [selectedNodes, lastSelection, completed] = await this.registry.getFormingCluster();
      // Only clean up a fully-selected, completed forming cluster that never produced a real cluster
      if (!completed || selectedNodes.length !== 11) {
        this._staleClusterStart = null;
        return false;
      }
      let clusterId = null;
      try {
        const [idx] = await this.registry.currentFormingCluster();
        clusterId = await this.registry.allClusters(idx);
      } catch {
        try { clusterId = await this.registry.getDepositCluster(); } catch {}
      }
      if (clusterId) {
        // A real cluster exists; nothing to clean up
        this._staleClusterStart = null;
        return false;
      }

      const now = Date.now();
      const lastSelMs = Number(lastSelection) * 1000;
      const ageMs = now - lastSelMs;

      // Initialize stale tracking and per-node jitter the first time we notice this stale cluster
      if (!this._staleClusterStart) {
        // If cluster already >10m old, trigger base cleanup window immediately; otherwise start timer now
        if (ageMs > 10 * 60 * 1000) {
          this._staleClusterStart = now - (10 * 60 * 1000 + 1000); // backdated to trigger now
        } else {
          this._staleClusterStart = now;
        }

        // Deterministic jitter per node to avoid all nodes attempting cleanup at once
        const JITTER_WINDOW_MS = 5 * 60 * 1000; // spread attempts over 5 minutes
        try {
          const addrHex = this.wallet.address.toLowerCase().replace('0x', '') || '1';
          const addrNum = BigInt('0x' + addrHex);
          this._cleanupJitterMs = Number(addrNum % BigInt(JITTER_WINDOW_MS));
        } catch {
          // Fallback to pseudo-random jitter if BigInt parsing fails for some reason
          this._cleanupJitterMs = Math.floor(Math.random() * JITTER_WINDOW_MS);
        }
        this._lastCleanupAttempt = 0;

        const baseDelay = 10 * 60 * 1000; // minimum stale time before any cleanup attempt
        const jitter = this._cleanupJitterMs || 0;
        const totalDelayMin = Math.ceil((baseDelay + jitter) / 60000);
        const jitterMin = Math.floor(jitter / 60000);
        console.log(`⚠️  Stale cluster detected (age: ${Math.floor(ageMs/60000)}m). ` +
                    `${ageMs > 10*60*1000 ? 'Triggering cleanup window...' : 'Starting cleanup timer with jitter...'}`);
        console.log(`🕒 This node will attempt stale cleanup in ~${totalDelayMin}m (base=10m + jitter≈${jitterMin}m).`);
      }

      const staleDuration = now - this._staleClusterStart;
      const baseDelay = 10 * 60 * 1000; // minimum stale time before any cleanup attempt
      const jitter = this._cleanupJitterMs || 0;
      const effectiveDelay = baseDelay + jitter;

      // Not yet time for this node to attempt cleanup
      if (staleDuration < effectiveDelay) {
        const remaining = Math.ceil((effectiveDelay - staleDuration) / 60000);
        if (staleDuration % 120000 < 15000) {
          console.log(`⏳ Stale cluster: ${remaining}m (including jitter) until this node attempts auto-cleanup`);
        }
        return false;
      }

      // Prevent constant retries - only attempt once per 5 minutes per node
      if (this._lastCleanupAttempt && (now - this._lastCleanupAttempt) < 5 * 60 * 1000) {
        return false;
      }
      this._lastCleanupAttempt = now;

      console.log(`🧹 Auto-cleanup: cluster stale for ${Math.floor(staleDuration/60000)}m. ` +
                  'Requesting on-chain stale cleanup from this node...');

      // Re-check that a stale forming cluster still exists before sending tx
      const [selectedNodes2, lastSelection2, completed2] = await this.registry.getFormingCluster();
      if (!completed2 || selectedNodes2.length !== 11 || String(lastSelection2) !== String(lastSelection)) {
        console.log('Cleanup aborted: forming cluster changed while waiting.');
        this._staleClusterStart = null;
        return false;
      }

      // Compute the real clusterId using the same encoding as the registry
      let clusterIdForCleanup = null;
      try {
        const clusterNodes2 = selectedNodes2.map(a => a.toLowerCase());
        if (clusterNodes2.length === 11) {
          clusterIdForCleanup = ethers.keccak256(
            ethers.solidityPacked(['address[11]'], [clusterNodes2])
          );
        }
      } catch {}

      try {
        // First, try clearing the forming cluster based on stale time
        try {
          const tx1 = await this.registry.clearStaleCluster();
          await tx1.wait();
          console.log('✓ clearStaleCluster() called to clear stale forming cluster');
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          console.log('clearStaleCluster() call failed or had no effect:', msg);
        }

        // If multisig setup is stuck (not enough address submissions), trigger setup timeout logic
        if (clusterIdForCleanup) {
          try {
            const tx2 = await this.registry.checkMultisigTimeout(clusterIdForCleanup);
            await tx2.wait();
            console.log('✓ checkMultisigTimeout() called for clusterId', clusterIdForCleanup);
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            console.log('checkMultisigTimeout() call failed or had no effect:', msg);
          }
        }

        // Clean up cluster-specific wallet if it exists
        if (this.clusterWalletName) {
          try {
            const { execSync } = require('child_process');
            const walletPattern = `~/.monero-wallets/${this.clusterWalletName}*`;
            console.log(`🗑️  Removing stale cluster wallet: ${this.clusterWalletName}`);
            execSync(`rm -f ${walletPattern}`, { stdio: 'ignore' });
          } catch (e) {
            // Ignore cleanup errors
          }
          this.clusterWalletName = null;
        }

        this._staleClusterStart = null;
        return true;
      } catch (e) {
        console.log('Cleanup transaction sequence failed:', e.message || String(e));
        return false;
      }
    } catch (e) {
      console.log("Cleanup check error:", e.message);
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
        const [selectedNodes, lastSelection, completed] = await this.registry.getFormingCluster();
        const clusterCount = await this.registry.getActiveClusterCount();
        const selectedCount = selectedNodes.length;
        const isSelected = selectedNodes.map(a => a.toLowerCase()).includes(this.wallet.address.toLowerCase());
        const lastSelMs = Number(lastSelection) * 1000;
        const ageMs = Date.now() - lastSelMs;
        const noClusterYet = (Number(lastSelection) === 0) && selectedCount === 0 && !completed;
        const stale = !noClusterYet && (completed || Number(lastSelection) === 0 || ageMs > 10 * 60 * 1000); // stale only if there was a prior cluster or it's completed
        
        const shownSelected = stale ? 0 : selectedCount;
        console.log(`Queue: ${queueLen} | Selected: ${shownSelected}/11 | Clusters: ${clusterCount} | CanRegister: ${canRegister} | Completed: ${completed}`);
        // DISABLED:         await this.requeueIfStale({ queueLen, selectedNodes, lastSelection, completed, canRegister });
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

}

if (require.main === module) {
  const node = new ZNode();
  node.start().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = ZNode;
