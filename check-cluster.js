const { ethers } = require('ethers');
require('dotenv').config();

const registryABI = [
  'function getActiveClusterCount() external view returns (uint256)',
  'function clusters(bytes32) external view returns (address, uint256, bool, uint256, uint256)',
  'function getClusterInfo(bytes32) external view returns (uint8, address[11], address[11], uint256, bool, string)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(
    "0x4A85418A95F178675F6E43C2023dc371a5EdFdc8",
    registryABI,
    provider
  );

  const count = await registry.getActiveClusterCount();
  console.log(`\n→ Active Clusters: ${count}\n`);
  
  if (count > 0) {
    // Try to get info for cluster 0
    const clusterId = ethers.keccak256(ethers.toUtf8Bytes("cluster_0")); // placeholder
    console.log(`Checking cluster ID: ${clusterId}`);
    
    try {
      const info = await registry.getClusterInfo(clusterId);
      console.log('Cluster Info:', info);
    } catch (e) {
      console.log('Could not fetch cluster details (may need actual cluster ID)');
    }
  }
}

main().catch(console.error);
