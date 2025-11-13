const { ethers } = require('ethers');
const fs = require('fs');

// Load contract ABIs
const zfiJson = JSON.parse(fs.readFileSync('/root/xmrbridge/artifacts/contracts/ZFI.sol/ZFI.json'));
const stakingJson = JSON.parse(fs.readFileSync('/root/xmrbridge/artifacts/contracts/ZFIStaking.sol/ZFIStaking.json'));
const registryJson = JSON.parse(fs.readFileSync('/root/xmrbridge/artifacts/contracts/ClusterRegistry.sol/ClusterRegistry.json'));

async function main() {
  require('dotenv').config();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  console.log('\n═══════════════════════════════════════');
  console.log('   CONTRACT DEPLOYMENT');
  console.log('═══════════════════════════════════════\n');
  console.log('Deployer:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH\n');
  
  // Deploy ZFI
  console.log('→ Deploying ZFI...');
  const ZFI = new ethers.ContractFactory(zfiJson.abi, zfiJson.bytecode, wallet);
  const zfi = await ZFI.deploy();
  await zfi.waitForDeployment();
  const zfiAddr = await zfi.getAddress();
  console.log('  ✓ ZFI:', zfiAddr);
  
  // Deploy Staking
  console.log('\n→ Deploying ZFIStaking...');
  const Staking = new ethers.ContractFactory(stakingJson.abi, stakingJson.bytecode, wallet);
  const staking = await Staking.deploy(zfiAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log('  ✓ ZFIStaking:', stakingAddr);
  
  // Deploy Registry
  console.log('\n→ Deploying ClusterRegistry...');
  const Registry = new ethers.ContractFactory(registryJson.abi, registryJson.bytecode, wallet);
  const registry = await Registry.deploy(stakingAddr);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log('  ✓ ClusterRegistry:', registryAddr);
  
  console.log('\n═══════════════════════════════════════');
  console.log('   ✅ DEPLOYMENT COMPLETE');
  console.log('═══════════════════════════════════════\n');
  console.log('ZFI:', zfiAddr);
  console.log('ZFIStaking:', stakingAddr);
  console.log('ClusterRegistry:', registryAddr);
  console.log();
  
  return { zfiAddr, stakingAddr, registryAddr };
}

main().then(addresses => {
  fs.writeFileSync('/tmp/new_addresses.json', JSON.stringify(addresses, null, 2));
  process.exit(0);
}).catch(e => {
  console.error('\n❌ Deployment failed:', e.message);
  process.exit(1);
});
