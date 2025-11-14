#!/usr/bin/env python3
import re

with open('node.js', 'r') as f:
    content = f.read()

# Find and replace the finalizeClusterWithMultisigCoordination method
# Remove all the broken exchange coordinator logic and replace with correct implementation

# Find the start of the function
start_marker = "async finalizeClusterWithMultisigCoordination(clusterId) {"
end_marker = "\n  async confirmClusterOnChain(clusterId, address) {"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("Could not find function boundaries")
    exit(1)

# New implementation
new_impl = '''async finalizeClusterWithMultisigCoordination(clusterId) {
    try {
      // Fetch forming cluster info (addresses and multisig_info from Round 1)
      const [addrList, infoList] = await this.registry.getFormingClusterMultisigInfo();
      const my = this.wallet.address.toLowerCase();
      
      // Collect peer multisig infos (Round 1 data from prepare_multisig)
      const peers = [];
      for (let i = 0; i < addrList.length; i++) {
        if (addrList[i].toLowerCase() === my) continue;
        if (infoList[i] && infoList[i].length > 0) {
          peers.push(infoList[i]);
        }
      }
      
      if (peers.length < 7) {
        console.log(`Not enough multisig infos yet (${peers.length}+1). Waiting...`);
        return false;
      }
      
      console.log(`\\n→ Have ${peers.length + 1} multisig infos, creating cluster wallet...`);
      
      // Create or open cluster wallet
      this.clusterWalletName = `${this.baseWalletName}_cluster_${clusterId.slice(2, 10)}`;
      
      try {
        await this.monero.openWallet(this.clusterWalletName, this.moneroPassword);
        const msInfo = await this.monero.call('is_multisig');
        if (msInfo.multisig && msInfo.ready) {
          const addr = await this.monero.call('get_address');
          console.log(`Wallet is already multisig and ready: ${addr.address}`);
          return false;
        }
      } catch {
        await this.monero.createWallet(this.clusterWalletName, this.moneroPassword);
      }
      
      // ROUND 2: make_multisig (each node does this independently)
      console.log('→ Performing make_multisig (8-of-11)...');
      const makeResult = await this.monero.call('make_multisig', {
        multisig_info: peers,
        threshold: 8,
        password: this.moneroPassword
      });
      
      if (!makeResult.multisig_info) {
        console.log('❌ make_multisig did not return multisig_info');
        return false;
      }
      
      const r2Info = makeResult.multisig_info;
      console.log(`✓ make_multisig complete, info length: ${r2Info.length}`);
      
      // Submit R2 info to coordinator for Round 3
      await this.submitExchangeInfo(clusterId, 3, r2Info);
      
      // Wait and perform Round 3
      const r3Info = await this.performExchangeRound(clusterId, 3);
      if (!r3Info) return false;
      
      // Submit R3 info for Round 4
      await this.submitExchangeInfo(clusterId, 4, r3Info);
      
      // Wait and perform Round 4
      const r4Info = await this.performExchangeRound(clusterId, 4);
      if (!r4Info) return false;
      
      // Submit R4 info for Round 5
      await this.submitExchangeInfo(clusterId, 5, r4Info);
      
      // Wait and perform Round 5
      const r5Info = await this.performExchangeRound(clusterId, 5);
      if (!r5Info) return false;
      
      // Submit R5 info for Round 6 (final)
      await this.submitExchangeInfo(clusterId, 6, r5Info);
      
      // Wait and perform Round 6 (final)
      await this.performExchangeRound(clusterId, 6);
      
      // Get final address
      const addrResult = await this.monero.call('get_address');
      const finalAddr = addrResult.address;
      const msStatus = await this.monero.call('is_multisig');
      
      if (!msStatus.ready) {
        console.log('❌ Multisig still not ready after all rounds');
        return false;
      }
      
      console.log(`\\n✅ Final multisig address: ${finalAddr}`);
      console.log(`✅ Multisig ready: ${msStatus.ready}, M/N: ${msStatus.threshold}/${msStatus.total}`);
      
      // Submit final address to registry
      const tx = await this.registry.submitMultisigAddress(clusterId, finalAddr);
      await tx.wait();
      console.log('✓ Submitted multisig address to registry');
      
      // Confirm cluster on-chain
      await this.confirmClusterOnChain(clusterId, finalAddr);
      
      return true;
    } catch (e) {
      console.log('Finalize error:', e.message || String(e));
      return false;
    }
  }

  async submitExchangeInfo(clusterId, roundNumber, multisigInfo) {
    const [clusterNodes] = await this.registry.getFormingCluster();
    const tx = await this.exchangeCoordinator.submitExchangeInfo(
      clusterId,
      roundNumber,
      multisigInfo,
      clusterNodes
    );
    await tx.wait();
    console.log(`  ✓ Submitted info for round ${roundNumber}`);
  }

  async performExchangeRound(clusterId, roundNumber) {
    console.log(`\\n→ Performing exchange round ${roundNumber}...`);
    
    // Wait for all 11 nodes to submit
    const maxWait = 300; // 5 minutes
    let waited = 0;
    while (waited < maxWait) {
      const [complete, submitted] = await this.exchangeCoordinator.getExchangeRoundStatus(
        clusterId,
        roundNumber
      );
      if (complete) {
        console.log(`  ✓ All 11 nodes submitted round ${roundNumber}`);
        break;
      }
      if (waited % 15 === 0) {
        console.log(`  Waiting: ${submitted}/11 nodes submitted...`);
      }
      await new Promise(r => setTimeout(r, 5000));
      waited += 5;
    }
    
    // Get all peer infos
    const [clusterNodes] = await this.registry.getFormingCluster();
    const [addresses, infos] = await this.exchangeCoordinator.getExchangeRoundInfo(
      clusterId,
      roundNumber,
      clusterNodes
    );
    
    const my = this.wallet.address.toLowerCase();
    const peerInfos = [];
    for (let i = 0; i < addresses.length; i++) {
      if (addresses[i].toLowerCase() === my) continue;
      if (infos[i] && infos[i].length > 0) {
        peerInfos.push(infos[i]);
      }
    }
    
    console.log(`  Got ${peerInfos.length} peer infos, performing exchange...`);
    
    // Perform exchange
    const result = await this.monero.call('exchange_multisig_keys', {
      multisig_info: peerInfos,
      password: this.moneroPassword
    });
    
    console.log(`  ✓ Round ${roundNumber} exchange complete`);
    
    // Return multisig_info for next round (empty string on final round)
    return result.multisig_info || null;
  }

'''

# Replace the function
new_content = content[:start_idx] + new_impl + content[end_idx:]

# Now remove the old coordinateExchangeRound and participateInExchangeRounds methods
# Find and remove coordinateExchangeRound
pattern1 = r'\n  async coordinateExchangeRound\(.*?\n  \}\n'
new_content = re.sub(pattern1, '\n', new_content, flags=re.DOTALL)

# Find and remove participateInExchangeRounds  
pattern2 = r'\n  async participateInExchangeRounds\(.*?\n  \}\n'
new_content = re.sub(pattern2, '\n', new_content, flags=re.DOTALL)

# Find and remove participateInRound
pattern3 = r'\n  async participateInRound\(.*?\n  \}\n'
new_content = re.sub(pattern3, '\n', new_content, flags=re.DOTALL)

with open('node.js', 'w') as f:
    f.write(new_content)

print("✅ Fixed multisig implementation in node.js")
