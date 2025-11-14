require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  const registryABI = [
    'function getClusterInfo(bytes32 clusterId) external view returns (address[11] nodes, string moneroAddress, address[] currentMembers, uint256 refreshEpoch, uint256 lastRefreshTime, bool active)',
    'function getActiveClusterCount() external view returns (uint256)'
  ];
  
  const registry = new ethers.Contract(
    '0xbCBCAA233c05b2Fc02cf9A9aa2Ce500F645895E2',
    registryABI,
    provider
  );
  
  console.log('\n→ Checking registered clusters...\n');
  
  const activeCount = await registry.getActiveClusterCount();
  console.log('Active Clusters:', activeCount.toString());
  
  // Check cluster by ID from logs
  const clusterId = '0xec72e0082f3151402c5dd9f58c739317772079b1f80ce713bdd5e03b6e3686db';
  
  try {
    const info = await registry.getClusterInfo(clusterId);
    console.log('\nCluster ID:', clusterId);
    console.log('Monero Address:', info.moneroAddress);
    console.log('Nodes:', info.nodes.filter(n => n !== ethers.ZeroAddress).length);
    console.log('Current Members:', info.currentMembers.length);
    console.log('Active:', info.active);
    console.log('Last Refresh:', new Date(Number(info.lastRefreshTime) * 1000).toISOString());
  } catch (e) {
    console.log('Error reading cluster:', e.message);
  }
}

main();
