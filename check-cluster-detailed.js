const { ethers } = require('ethers');
require('dotenv').config();

const registryABI = [
  'function getActiveClusterCount() external view returns (uint256)',
  'function getClusterInfo(bytes32) external view returns (address[11], address[11], uint256, bool, string)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const registry = new ethers.Contract(
    "0x0d61108F118595629aDcfB12448B7b0626D753B7",
    registryABI,
    provider
  );

  console.log('\n→ Checking Cluster 0...\n');
  
  // Calculate cluster ID the same way nodes do
  const addresses = [
    '0x611e4Ee10F8dD6cd8f12adf8694E680A203259aa',
    '0x64bf60B4899108A696213c67D16cA18cB34465f9',
    '0xfdb22e02E44449bf2ED61E47f84D501bDEc88625',
    '0xE684ff569365F484d99449a669eebe2597fc4909',
    '0x21d93d88B7FD47caaEfD15bbdF504397b30abDad',
    '0xAc2cf454e48629B78d21D447d719eEEe9dC70273',
    '0x5e1777631706c0b742D878be2cB5af923Bbb743F',
    '0xeb473520aF0bb59ccF6400Fc24F701E5e76391C5',
    '0xae351BE136C0064a32Fd31C9Bb2928bB90452C18',
    '0x2F7702B9a66757AAFAB49b2348a06a60765a15BF',
    '0x54F48f7Ac0da3B8956458030577c38278D36D56d'
  ];
  
  const clusterId = ethers.keccak256(
    ethers.solidityPacked(['address[11]'], [addresses])
  );
  
  console.log('Cluster ID:', clusterId);
  
  try {
    const info = await registry.getClusterInfo(clusterId);
    console.log('\nNodes:', info[0].slice(0, 3).map(a => a.slice(0, 10) + '...'));
    console.log('Current Members:', info[1].slice(0, 3).map(a => a.slice(0, 10) + '...'));
    console.log('Creation Time:', new Date(Number(info[2]) * 1000).toISOString());
    console.log('Active:', info[3]);
    console.log('Multisig Address:', info[4]);
  } catch (e) {
    console.log('Error fetching cluster:', e.message);
  }
}

main().catch(console.error);
