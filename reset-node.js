require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const registryABI = [
    'function deregisterNode() external',
    'function registerNode(bytes32 codeHash, string multisigInfo) external',
    'function registeredNodes(address) view returns (bool registered, bytes32 codeHash, string multisigInfo, uint256 registeredAt, bool inQueue, uint256 multisigSubmittedBlock)'
  ];
  
  const registry = new ethers.Contract('0xbCBCAA233c05b2Fc02cf9A9aa2Ce500F645895E2', registryABI, wallet);
  
  console.log('Node:', wallet.address);
  
  // Deregister
  console.log('Deregistering...');
  try {
    const tx1 = await registry.deregisterNode();
    await tx1.wait();
    console.log('✓ Deregistered');
  } catch (e) {
    console.log('Deregister error (may not be registered):', e.message);
  }
  
  // Wait 2 seconds
  await new Promise(r => setTimeout(r, 2000));
  
  // Re-register
  console.log('Re-registering...');
  const codeHash = ethers.id('znode-v2-tss');
  const tx2 = await registry.registerNode(codeHash, '');
  await tx2.wait();
  console.log('✓ Re-registered');
  
  // Check status
  const info = await registry.registeredNodes(wallet.address);
  console.log('InQueue:', info.inQueue || info[4]);
}

main().catch(console.error);
