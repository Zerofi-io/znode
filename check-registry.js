const { ethers } = require('ethers');
require('dotenv').config();

const registryABI = [
  'function getQueueStatus() external view returns (uint256, uint256, bool)',
  'function getFormingCluster() external view returns (address[], uint256, bool)',
  'function getActiveClusterCount() external view returns (uint256)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(
    "0x0d61108F118595629aDcfB12448B7b0626D753B7",
    registryABI,
    provider
  );

  console.log('\n→ Registry Status\n');
  
  const [queueLength, , canRegister] = await registry.getQueueStatus();
  console.log(`Queue Length: ${queueLength}`);
  console.log(`Can Register: ${canRegister}\n`);
  
  const [selectedNodes, lastSelectionTime, completed] = await registry.getFormingCluster();
  console.log(`Selected Nodes: ${selectedNodes.length}/11`);
  console.log(`Last Selection: ${new Date(Number(lastSelectionTime) * 1000).toISOString()}`);
  console.log(`Completed: ${completed}\n`);
  
  if (selectedNodes.length > 0) {
    console.log('Selected Addresses:');
    selectedNodes.forEach((addr, i) => {
      console.log(`  ${i+1}. ${addr}`);
    });
  }
  
  const clusterCount = await registry.getActiveClusterCount();
  console.log(`\nActive Clusters: ${clusterCount}`);
  console.log(`\nTotal Registered: ${Number(queueLength) + selectedNodes.length}`);
}

main().catch(console.error);
