const { ethers } = require('ethers');
require('dotenv').config();

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const registry = new ethers.Contract(
    '0x26B59a70B59Bf486D4cEFa292d8BfC80f1E0F636',
    [
      'function registeredNodes(address) view returns (bool registered, bytes32 codeHash, string multisigInfo, uint256 registeredAt, bool inQueue, uint256 multisigSubmittedBlock)',
      'function getQueueStatus() view returns (uint256,uint256,bool)',
      'function deregisterNode() external',
      'function registerNode() external'
    ],
    wallet
  );

  const me = wallet.address;
  const info = await registry.registeredNodes(me);
  const [ql] = await registry.getQueueStatus();
  console.log('Before: registered=', info.registered, 'inQueue=', info.inQueue, 'queueLen=', ql.toString());

  if (info.registered && info.inQueue && Number(ql) === 0) {
    console.log('Re-queuing now...');
    try { const tx1 = await registry.deregisterNode(); await tx1.wait(); } catch (e) { console.log('deregister error:', e.reason || e.message); }
    const tx2 = await registry.registerNode();
    await tx2.wait();
  } else if (!info.registered) {
    console.log('Registering now...');
    const tx = await registry.registerNode();
    await tx.wait();
  } else {
    console.log('No requeue needed based on current state.');
  }

  const info2 = await registry.registeredNodes(me);
  const [ql2] = await registry.getQueueStatus();
  console.log('After:  registered=', info2.registered, 'inQueue=', info2.inQueue, 'queueLen=', ql2.toString());
})();
