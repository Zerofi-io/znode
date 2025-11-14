const { ethers } = require('ethers');
const fs = require('fs');

// All 11 node private keys (from clean-restart.sh or wherever they're stored)
const privateKeys = [
  process.env.PRIVATE_KEY, // This will handle whichever node we run from
];

async function main() {
  require('dotenv').config();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  const registry = new ethers.Contract(
    '0xA1271179BD29557f64Ee80d6627a7e64Be683Acb',
    [
      'function deregisterNode() external',
      'function registeredNodes(address) view returns (bytes32 codeHash, uint256 registrationTime)'
    ],
    provider
  );
  
  // Get all addresses from distribute.js
  const recipients = [
    '0x64bf60B4899108A696213c67D16cA18cB34465f9',
    '0x54F48f7Ac0da3B8956458030577c38278D36D56d',
    '0x2F7702B9a66757AAFAB49b2348a06a60765a15BF',
    '0x21d93d88B7FD47caaEfD15bbdF504397b30abDad',
    '0xae351BE136C0064a32Fd31C9Bb2928bB90452C18',
    '0xeb473520aF0bb59ccF6400Fc24F701E5e76391C5',
    '0x5e1777631706c0b742D878be2cB5af923Bbb743F',
    '0xAc2cf454e48629B78d21D447d719eEEe9dC70273',
    '0xfdb22e02E44449bf2ED61E47f84D501bDEc88625',
    '0xE684ff569365F484d99449a669eebe2597fc4909',
    '0x611e4Ee10F8dD6cd8f12adf8694E680A203259aa'
  ];
  
  console.log('Checking registration status...\n');
  
  for (const addr of recipients) {
    const nodeInfo = await registry.registeredNodes(addr);
    if (nodeInfo.registrationTime > 0) {
      console.log(`${addr}: REGISTERED (time: ${nodeInfo.registrationTime})`);
    } else {
      console.log(`${addr}: not registered`);
    }
  }
  
  // Only deregister the current node
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const registryWithSigner = registry.connect(wallet);
  const myInfo = await registry.registeredNodes(wallet.address);
  
  if (myInfo.registrationTime > 0) {
    console.log(`\nDeregistering ${wallet.address}...`);
    const tx = await registryWithSigner.deregisterNode();
    await tx.wait();
    console.log('✓ Deregistered');
  }
}

main().catch(console.error);
