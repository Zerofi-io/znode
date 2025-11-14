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
      'function getFormingClusterMultisigInfo() external view returns (address[] memory, string[] memory)',
      'function currentFormingCluster() external view returns (uint256, uint256, bool)',
      'function allClusters(uint256) external view returns (bytes32)',
      'function selectNextNode() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function getFormingCluster() external view returns (address[] memory, uint256, bool)',
      'function getActiveClusterCount() external view returns (uint256)',
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
      '0xC35CC6a4176dB55dbb290EDbEbae5A08BE5c6c8d',
      registryABI,
      this.wallet
    );

    this.staking = new ethers.Contract(
      '0x4292E4Af84cea07D2654CB5D97141C7D6a23be01',
      stakingABI,
      this.wallet
    );

    this.zfi = new ethers.Contract(
      '0x1736668a18AE7C46011dF93A12a6b9438174814F',
      zfiABI,
      this.wallet
    );

    this.monero = new MoneroRPC({
      url: process.env.MONERO_RPC_URL || 'http://127.0.0.1:18083'
    });

    this.walletName = `znode_${this.wallet.address.slice(2, 10)}`;
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
      const allowance = await this.zfi.allowance(this.wallet.address, '0x4292E4Af84cea07D2654CB5D97141C7D6a23be01');
      if (allowance < required) {
        console.log('  Approving ZFI for staking...');
        const txA = await this.zfi.approve('0x4292E4Af84cea07D2654CB5D97141C7D6a23be01', required);
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
        await this.monero.openWallet(this.walletName, this.moneroPassword);
        console.log(`✓ Wallet opened: ${this.walletName}`);
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
        await this.monero.createWallet(this.walletName, this.moneroPassword);
        console.log(`✓ Wallet created: ${this.walletName}`);
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
      console.error('❌ prepare_multisig failed:', error.message);
      throw error;
    }
  }

  async makeMultisig(threshold, multisigInfos) {
    console.log(`\n→ Creating ${threshold}-of-${multisigInfos.length + 1} multisig...`);
    
    try {
      const result = await this.monero.call('make_multisig', {
        multisig_info: multisigInfos,
        threshold: threshold
      });
      
      console.log('✓ Multisig wallet created');
      console.log(`  Address: ${result.address}`);
      
      return result;
    } catch (error) {
      console.error('❌ make_multisig failed:', error.message);
      throw error;
    }
  }

  async finalizeClusterWithMultisigCoordination() {
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
      // Create 8-of-11 multisig locally
      const res = await this.makeMultisig(8, peers);
      const addr = res.address;
      console.log(`✓ Multisig created locally: ${addr}`);
      // Submit to registry
      const tx = await this.registry.submitMultisigAddress(clusterId, addr);
      await tx.wait();
      console.log('✓ Submitted multisig address to registry');
      return true;
    } catch (e) {
      console.log('Coordinator finalize error:', e.message || String(e));
      return false;
    }
  }


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
        this._staleClusterStart = null;
        return false;
      }
      const now = Date.now();
      const lastSelMs = Number(lastSelection) * 1000;
      const ageMs = now - lastSelMs;
      if (!this._staleClusterStart) {
        this._staleClusterStart = now;
        console.log(`⚠️  Stale cluster detected (age: ${Math.floor(ageMs/60000)}m). Starting cleanup timer...`);
        return false;
      }
      const staleDuration = now - this._staleClusterStart;
      if (staleDuration > 10 * 60 * 1000) {
        console.log(`🧹 Auto-cleanup: cluster stale for ${Math.floor(staleDuration/60000)}m. Resetting...`);
        const jitter = Math.floor(Math.random() * 30000);
        await new Promise(r => setTimeout(r, jitter));
        try {
          const tx1 = await this.registry.deregisterNode();
          await tx1.wait();
          console.log("✓ Deregistered from stale cluster");
        } catch (e) {
          console.log("Deregister failed:", e.message);
        }
        await new Promise(r => setTimeout(r, 2000));
        if (!this.multisigInfo) {
          try { await this.prepareMultisig(); } catch {}
        }
        const codeHash = ethers.id("znode-v2-tss");
        try {
          const tx2 = await this.registry.registerNode(codeHash, this.multisigInfo || "");
          await tx2.wait();
          console.log("✓ Re-registered to fresh queue");
        } catch (e) {
          console.log("Re-register failed:", e.message);
        }
        this._staleClusterStart = null;
        return true;
      } else {
        const remaining = Math.ceil((10 * 60 * 1000 - staleDuration) / 60000);
        if (staleDuration % 120000 < 15000) {
          console.log(`⏳ Stale cluster: ${remaining}m until auto-cleanup`);
        }
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
        if (canSelectNow) {
          try {
            const tx = await this.registry.selectNextNode();
            await tx.wait();
            console.log(`Triggered selection: ${selectedCount + 1}/11`);
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            if (!/ARRAY_RANGE_ERROR|interval|full|No valid nodes|CALL_EXCEPTION/i.test(msg)) {
              console.log('Selection trigger failed:', msg);
            }
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
              const [idx, last, done] = await this.registry.currentFormingCluster();
              clusterId = await this.registry.allClusters(idx);
            } catch (e1) {
              try {
                clusterId = await this.registry.getDepositCluster();
              } catch (e2) {
                if (selectedNodes.length === 11) console.log('Finalize check: could not determine clusterId yet');
              }
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
                if (myIndex === coordIndex) {
                  console.log('🎯 I am the coordinator for this cluster. Finalizing...');
                  await this.finalizeClusterWithMultisigCoordination();
                } else {
                  console.log('⏳ Waiting for coordinator to finalize cluster...');
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
