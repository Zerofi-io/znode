const { ethers } = require('ethers');
require('dotenv').config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const registry = new ethers.Contract(
    '0xA1271179BD29557f64Ee80d6627a7e64Be683Acb',
    [
      'function clearStaleCluster() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function getFormingCluster() external view returns (address[] memory, uint256, bool)',
      'function registeredNodes(address) view returns (bytes32 codeHash, uint256 registrationTime)'
    ],
    wallet
  );
  
  console.log(`Node: ${wallet.address}\n`);
  
  // Step 1: Check current state
  const [queue, selected, canReg] = await registry.getQueueStatus();
  const [members, timestamp, isForming] = await registry.getFormingCluster();
  console.log(`Current state: queue=${queue}, selected=${selected}, forming=${members.length}`);
  
  // Step 2: Clear stale cluster if exists
  if (members.length > 0) {
    const age = Math.floor((Date.now() - Number(timestamp) * 1000) / 60000);
    console.log(`Forming cluster age: ${age}m`);
    
    if (age > 5) {
      console.log('Clearing stale cluster...');
      try {
        const tx = await registry.clearStaleCluster();
        await tx.wait();
        console.log('✓ Cleared');
      } catch (e) {
        console.log('Clear failed:', e.message);
      }
    }
  }
  
  // Step 3: Deregister if registered
  const myInfo = await registry.registeredNodes(wallet.address);
  if (myInfo.registrationTime > 0) {
    console.log('Deregistering...');
    const tx = await registry.deregisterNode();
    await tx.wait();
    console.log('✓ Deregistered');
  } else {
    console.log('Not registered');
  }
  
  // Step 4: Show final state
  const [queue2, selected2] = await registry.getQueueStatus();
  console.log(`\nFinal state: queue=${queue2}, selected=${selected2}`);
  console.log('\nRun ./clean-restart.sh to start fresh');
}

main().catch(console.error);
