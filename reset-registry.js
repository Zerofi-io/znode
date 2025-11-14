const { ethers } = require('ethers');

async function main() {
  require('dotenv').config();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const registry = new ethers.Contract(
    '0xA1271179BD29557f64Ee80d6627a7e64Be683Acb',
    [
      'function clearStaleCluster() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function registeredNodes(address) view returns (bytes32 codeHash, uint256 registrationTime)'
    ],
    wallet
  );
  
  console.log('→ Clearing stale cluster...');
  try {
    const tx1 = await registry.clearStaleCluster();
    await tx1.wait();
    console.log('✓ Cluster cleared');
  } catch(e) {
    console.log('  (cluster already clear or not stale yet)');
  }
  
  console.log('\n→ Deregistering this node...');
  const myInfo = await registry.registeredNodes(wallet.address);
  if (myInfo.registrationTime > 0) {
    const tx2 = await registry.deregisterNode();
    await tx2.wait();
    console.log(`✓ Deregistered ${wallet.address}`);
  } else {
    console.log('  (not registered)');
  }
  
  console.log('\n→ Final queue status:');
  const [queue, selected, canReg] = await registry.getQueueStatus();
  console.log(`  Queue: ${queue}`);
  console.log(`  Selected: ${selected}`);
  console.log(`  CanRegister: ${canReg}`);
}

main().catch(console.error);
