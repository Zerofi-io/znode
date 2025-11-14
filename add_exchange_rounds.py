#!/usr/bin/env python3
"""
Carefully add exchange rounds implementation to node.js
"""
from pathlib import Path
import re

def main():
    p = Path('node.js')
    content = p.read_text()
    
    # Step 1: Add exchangeCoordinatorABI after zfiABI
    print("Step 1: Adding exchangeCoordinatorABI...")
    zfi_abi_pattern = r"(    const zfiABI = \[[\s\S]*?\];)\n"
    match = re.search(zfi_abi_pattern, content)
    if not match:
        print("ERROR: Could not find zfiABI")
        return False
    
    exchange_abi = """
    const exchangeCoordinatorABI = [
      'function submitExchangeInfo(bytes32 clusterId, uint8 round, string exchangeInfo, address[] clusterNodes) external',
      'function getExchangeRoundInfo(bytes32 clusterId, uint8 round, address[] clusterNodes) external view returns (address[] addresses, string[] exchangeInfos)',
      'function getExchangeRoundStatus(bytes32 clusterId, uint8 round) external view returns (bool complete, uint8 submitted)'
    ];
"""
    
    content = content.replace(match.group(0), match.group(0) + exchange_abi)
    print("  ✓ Added exchangeCoordinatorABI")
    
    # Step 2: Add exchangeCoordinator contract initialization after this.zfi
    print("Step 2: Adding exchangeCoordinator contract...")
    zfi_contract_pattern = r"(    this\.zfi = new ethers\.Contract\([\s\S]*?\);)\n"
    match = re.search(zfi_contract_pattern, content)
    if not match:
        print("ERROR: Could not find this.zfi initialization")
        return False
    
    exchange_contract = """
    this.exchangeCoordinator = new ethers.Contract(
      '0x9D6DDb5A20F1Abd6CAb63c7545BE69Ac2615E5C4',
      exchangeCoordinatorABI,
      this.wallet
    );
"""
    
    content = content.replace(match.group(0), match.group(0) + exchange_contract)
    print("  ✓ Added exchangeCoordinator contract")
    
    # Step 3: Add exchangeMultisigKeys method after makeMultisig
    print("Step 3: Adding exchangeMultisigKeys method...")
    make_multisig_pattern = r"(  async makeMultisig\([\s\S]*?\n  \})\n"
    match = re.search(make_multisig_pattern, content)
    if not match:
        print("ERROR: Could not find makeMultisig method")
        return False
    
    exchange_method = """

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
"""
    
    content = content.replace(match.group(0), match.group(0) + exchange_method)
    print("  ✓ Added exchangeMultisigKeys method")
    
    # Step 4: Replace finalizeClusterWithMultisigCoordination with new version
    print("Step 4: Replacing finalizeClusterWithMultisigCoordination...")
    
    # Find the entire function
    finalize_pattern = r"  async finalizeClusterWithMultisigCoordination\(clusterId\) \{[\s\S]*?\n  \}\n(?=\n  async registerToQueue)"
    match = re.search(finalize_pattern, content)
    if not match:
        print("ERROR: Could not find finalizeClusterWithMultisigCoordination")
        return False
    
    new_finalize = '''  async finalizeClusterWithMultisigCoordination(clusterId) {
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
      // Open cluster wallet
      this.clusterWalletName = `${this.baseWalletName}_cluster_${clusterId.slice(2, 10)}`;
      
      try {
        await this.monero.openWallet(this.clusterWalletName, this.moneroPassword);
      } catch (e) {
        console.log('  ⚠️  Cluster wallet not found, cannot participate in exchange');
        return false;
      }
      
      // Check if multisig is already ready
      const msInfo = await this.monero.call('is_multisig');
      if (msInfo.ready) {
        console.log('  ✓ Multisig already ready');
        return true;
      }
      
      // Participate in round 3
      console.log('\\n→ Participating in Round 3');
      const round3Success = await this.participateInRound(clusterId, 3);
      if (!round3Success) {
        console.log('  ❌ Round 3 participation failed');
        return false;
      }
      
      // Participate in round 4
      console.log('\\n→ Participating in Round 4');
      const round4Success = await this.participateInRound(clusterId, 4);
      if (!round4Success) {
        console.log('  ❌ Round 4 participation failed');
        return false;
      }
      
      // Verify multisig is ready
      const finalInfo = await this.monero.call('is_multisig');
      if (finalInfo.ready) {
        console.log('\\n✅ Multisig exchange complete and ready');
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
'''
    
    content = content.replace(match.group(0), new_finalize)
    print("  ✓ Replaced finalizeClusterWithMultisigCoordination with full exchange implementation")
    
    # Step 5: Add participateInExchangeRounds call for non-coordinators
    print("Step 5: Adding non-coordinator participation...")
    waiting_pattern = r"(                } else \{\n                  console\.log\('⏳ Waiting for coordinator to finalize cluster\.\.\.'\);)\n"
    match = re.search(waiting_pattern, content)
    if not match:
        print("ERROR: Could not find waiting for coordinator message")
        return False
    
    participate_call = "                  await this.participateInExchangeRounds(clusterId);\n"
    content = content.replace(match.group(0), match.group(0) + participate_call)
    print("  ✓ Added non-coordinator participation")
    
    # Write the updated content
    p.write_text(content)
    print("\n✅ Successfully added complete exchange rounds implementation")
    return True

if __name__ == '__main__':
    success = main()
    exit(0 if success else 1)
