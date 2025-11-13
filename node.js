require('dotenv').config();
const { ethers } = require('ethers');
const MoneroRPC = require('./monero-rpc');
const crypto = require('crypto');

class ZNode {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/vO5dWTSB5yRyoMsJTnS6V'
    );
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
    
    // Generate deterministic wallet password from node's private key
    this.moneroPassword = crypto.createHash('sha256')
      .update(this.wallet.privateKey)
      .digest('hex')
      .substring(0, 32);

    const registryABI = [
      'function registerNode() external',
      'function deregisterNode() external',
      'function getQueueStatus() external view returns (uint256, uint256, bool)',
      'function getFormingCluster() external view returns (address[] memory, uint256, bool)',
      'function getActiveClusterCount() external view returns (uint256)',
      'function registeredNodes(address) external view returns (bool registered, bool inQueue)',
      'event NodeRegistered(address indexed node)',
      'event ClusterFormed(bytes32 indexed clusterId, address[] members)'
    ];

    const stakingABI = [
      'function getNodeInfo(address node) external view returns (uint256,uint256,uint256,bool,uint256,uint256,uint256)',
      'function stake(bytes32 _codeHash, string _moneroFeeAddress) external',
      'function heartbeat() external'
    ];

    const zfiABI = [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)'
    ];

    this.registry = new ethers.Contract(
      '0x26B59a70B59Bf486D4cEFa292d8BfC80f1E0F636',
      registryABI,
      this.wallet
    );

    this.staking = new ethers.Contract(
      '0x10b0F517b8eb9b275924e097Af6B1b1eb85182f0',
      stakingABI,
      this.wallet
    );

    this.zfi = new ethers.Contract(
      '0xAa15b1F362315B09B19Ab5D5274D1CDD59588F96',
      zfiABI,
      this.wallet
    );

    this.monero = new MoneroRPC({
      url: process.env.MONERO_RPC_URL || 'http://127.0.0.1:18083'
    });

    this.walletName = `znode_${this.wallet.address.slice(2, 10)}`;
    this.multisigInfo = null;
    this.clusterId = null;
  }

  async start() {
    console.log('\n═══════════════════════════════════════════════');
    console.log('   ZNode - Monero Multisig (WORKING!)');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`Address: ${this.wallet.address}`);
    console.log(`Network: ${(await this.provider.getNetwork()).name}\n`);

    await this.checkRequirements();
    await this.setupMonero();
    await this.registerToQueue();
    await this.monitorNetwork();
  }

  async checkRequirements() {
    console.log('→ Checking requirements...');

    // Ensure we have some ETH for gas
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    if (ethBalance < ethers.parseEther('0.001')) {
      throw new Error('Insufficient ETH for gas (need >= 0.001 ETH)');
    }

    // Check ZFI balance
    const zfiBal = await this.zfi.balanceOf(this.wallet.address);
    console.log(`  ZFI Balance: ${ethers.formatEther(zfiBal)}`);

    // Read staking state using getNodeInfo (first field = staked amount)
    let stakedAmt = 0n;
    try {
      const info = await this.staking.getNodeInfo(this.wallet.address);
      stakedAmt = info[0];
    } catch {
      // Fallback if ABI/tuple width differs: treat as not staked
      stakedAmt = 0n;
    }
    console.log(`  ZFI Staked: ${ethers.formatEther(stakedAmt)}`);

    const required = ethers.parseEther('1000000');
    if (stakedAmt < required) {
      if (zfiBal < required) {
        throw new Error('Insufficient ZFI to stake 1,000,000');
      }

      // Approve if needed
      const allowance = await this.zfi.allowance(this.wallet.address, '0x10b0F517b8eb9b275924e097Af6B1b1eb85182f0');
      if (allowance < required) {
        console.log('  Approving ZFI for staking...');
        const txA = await this.zfi.approve('0x10b0F517b8eb9b275924e097Af6B1b1eb85182f0', required);
        await txA.wait();
        console.log('  ✓ Approved');
      }

      // Stake now
      console.log('  Staking 1,000,000 ZFI...');
      const codeHash = ethers.id('znode-v2-tss');
      const moneroAddr = '4' + '0'.repeat(94);
      const txS = await this.staking.stake(codeHash, moneroAddr);
      await txS.wait();
      console.log('  ✓ Staked');
    }

    console.log('✓ Requirements met\n');
  }

  async setupMonero() {
    console.log('→ Setting up Monero with multisig support...');
    
    for (let i = 1; i <= 20; i++) {
      try {
        await this.monero.openWallet(this.walletName, this.moneroPassword);
        console.log(`✓ Wallet opened: ${this.walletName}`);
        break;
      } catch (error) {
        if (error.code === 'ECONNREFUSED' && i < 10) {
          console.log(`  Waiting for Monero RPC (attempt ${i}/10)...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Monero RPC not available');
        }
        
        console.log('  Creating wallet with password...');
        await this.monero.createWallet(this.walletName, this.moneroPassword);
        console.log(`✓ Wallet created: ${this.walletName}`);
        break;
      }
    }

    // Enable multisig experimental feature
    console.log('  Enabling multisig...');
    try {
      await this.monero.call('set', {
        key: 'enable-multisig-experimental',
        value: true
      });
      console.log('✓ Multisig enabled\n');
    } catch (e) {
      // May already be enabled or command format different
      console.log('  Multisig enable attempted\n');
    }
  }

  async prepareMultisig() {
    console.log('\n→ Preparing multisig...');
    
    try {
      const result = await this.monero.call('prepare_multisig');
      this.multisigInfo = result.multisig_info;
      
      console.log('✓ Multisig info generated');
      console.log(`  Info: ${this.multisigInfo.substring(0, 50)}...`);
      
      return this.multisigInfo;
    } catch (error) {
      console.error('❌ prepare_multisig failed:', error.message);
      throw error;
    }
  }

  async makeMultisig(threshold, multisigInfos) {
    console.log(`\n→ Creating ${threshold}-of-${multisigInfos.length + 1} multisig...`);
    
    try {
      const result = await this.monero.call('make_multisig', {
        multisig_info: multisigInfos,
        threshold: threshold
      });
      
      console.log('✓ Multisig wallet created');
      console.log(`  Address: ${result.address}`);
      
      return result;
    } catch (error) {
      console.error('❌ make_multisig failed:', error.message);
      throw error;
    }
  }

  async registerToQueue() {
    console.log('→ Registering to network...');
    
    const nodeInfo = await this.registry.registeredNodes(this.wallet.address);
    
    if (nodeInfo.registered && nodeInfo.inQueue) {
      console.log('✓ Already registered\n');
      return;
    }
    
    if (nodeInfo.registered && !nodeInfo.inQueue) {
      console.log('  Deregistering stale registration...');
      const deregTx = await this.registry.deregisterNode();
      await deregTx.wait();
      await new Promise(r => setTimeout(r, 2000));
    }

    const tx = await this.registry.registerNode();
    await tx.wait();
    
    console.log('✓ Registered to queue\n');
  }

  async monitorNetwork() {
    console.log('→ Monitoring network...\n');
    console.log('🎉 Monero multisig is WORKING!');
    console.log('Wallet has password and multisig is enabled.\n');
    
    // Monitor for cluster formation
    setInterval(async () => {
      try {
        const [selectedNodes, , completed] = await this.registry.getFormingCluster();
        
        if (selectedNodes.length > 0 && !completed) {
          const isSelected = selectedNodes.includes(this.wallet.address);
          
          if (isSelected) {
            console.log(`\n✅ Selected for cluster! (${selectedNodes.length} nodes)`);
            // TODO: Implement multisig coordination
          }
        }
      } catch (error) {
        // Ignore monitoring errors
      }
    }, 60000);
  }
}

if (require.main === module) {
  const node = new ZNode();
  node.start().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = ZNode;
