const { ethers } = require('ethers');
const fs = require('fs');

const addresses = JSON.parse(fs.readFileSync('/tmp/new_addresses.json'));
const zfiAddr = addresses.zfiAddr;

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

async function main() {
  require('dotenv').config();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  const zfi = new ethers.Contract(zfiAddr, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ], wallet);
  
  console.log('\n→ Distributing 1M ZFI to', recipients.length, 'nodes...\n');
  
  const amount = ethers.parseUnits('1000000', 18);
  
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i];
    const num = i + 1;
    console.log('  ' + num + '/' + recipients.length + ': ' + addr.slice(0,10) + '...');
    const tx = await zfi.transfer(addr, amount);
    await tx.wait();
  }
  
  console.log('\n✅ Distribution complete!\n');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
