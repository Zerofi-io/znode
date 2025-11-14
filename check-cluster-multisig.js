const { ethers } = require('ethers');
require('dotenv').config();

const registryABI = [
  'function clusters(bytes32) external view returns (address, uint256, bool, uint256, uint256)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(
    "0x4A85418A95F178675F6E43C2023dc371a5EdFdc8",
    registryABI,
    provider
  );

  const clusterId = "0xc3878ebf3606cee55bfe608df5159811636b01c6cb7a2618fc6abc61c09463b2";
  
  console.log('\n→ Checking on-chain cluster data...\n');
  
  try {
    const cluster = await registry.clusters(clusterId);
    console.log('Multisig Address:', cluster[0]);
    console.log('Creation Time:', new Date(Number(cluster[1]) * 1000).toISOString());
    console.log('Active:', cluster[2]);
  } catch (e) {
    console.log('Error:', e.message);
  }
}

main();
