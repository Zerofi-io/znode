const { ethers } = require('ethers');
require('dotenv').config();

async function test() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const stakingABI = [
    'function getStake(address node) external view returns (uint256)'
  ];
  
  console.log('Testing staking contract at: 0xc4D4dB2f5Ea4D2AE57C07D95E71Dee71D660E85c');
  const staking = new ethers.Contract(
    '0xc4D4dB2f5Ea4D2AE57C07D95E71Dee71D660E85c',
    stakingABI,
    wallet
  );
  
  try {
    const stake = await staking.getStake(wallet.address);
    console.log('Stake:', ethers.formatEther(stake));
  } catch (e) {
    console.error('Error calling getStake:', e.message);
    console.error('Code:', e.code);
    
    // Try with static call
    console.log('\nTrying with staticCall...');
    try {
      const stake = await staking.getStake.staticCall(wallet.address);
      console.log('Stake:', ethers.formatEther(stake));
    } catch (e2) {
      console.error('Static call also failed:', e2.message);
    }
  }
}

test();
