const { ethers } = require('ethers');
require('dotenv').config();

async function test() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  // Try checking balance first
  const zfiABI = ['function balanceOf(address) view returns (uint256)'];
  const zfi = new ethers.Contract('0xAa15b1F362315B09B19Ab5D5274D1CDD59588F96', zfiABI, wallet);
  
  const balance = await zfi.balanceOf(wallet.address);
  console.log('ZFI Balance:', ethers.formatEther(balance));
  
  // Try checking if staking check is needed at all
  const stakingABI = [
    'function getStake(address node) external view returns (uint256)',
    'function stakes(address) external view returns (uint256)'
  ];
  
  const staking = new ethers.Contract('0x10b0F517b8eb9b275924e097Af6B1b1eb85182f0', stakingABI, wallet);
  
  // Try alternative method
  console.log('\nTrying stakes mapping directly...');
  try {
    const stake = await staking.stakes(wallet.address);
    console.log('Stake (via mapping):', ethers.formatEther(stake));
  } catch (e) {
    console.error('stakes() failed:', e.message);
  }
}

test();
