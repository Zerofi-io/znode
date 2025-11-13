const MoneroRPC = require('./monero-rpc.js');

async function main() {
  const monero = new MoneroRPC();
  
  try {
    const address = await monero.getAddress();
    console.log('\n→ Multisig Wallet Address:\n');
    console.log(address);
    console.log();
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
