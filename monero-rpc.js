/**
 * Monero RPC Client for Wallet Operations
 */

const axios = require('axios');

class MoneroRPC {
  constructor(config = {}) {
    this.url = config.url || process.env.MONERO_WALLET_RPC_URL || 'http://127.0.0.1:18083';
    this.user = config.user || process.env.MONERO_WALLET_RPC_USER;
    this.password = config.password || process.env.MONERO_WALLET_RPC_PASSWORD;
  }

  async call(method, params = {}, timeout = 30000) {
    try {
      const response = await axios.post(`${this.url}/json_rpc`, {
        jsonrpc: '2.0',
        id: '0',
        method,
        params
      }, {
        auth: this.user && this.password ? {
          username: this.user,
          password: this.password
        } : undefined,
        timeout
      });

      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      return response.data.result;
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      }
      throw error;
    }
  }

  // Create new wallet
  async createWallet(filename, password = '') {
    return this.call('create_wallet', {
      filename,
      password,
      language: 'English'
    });
  }

  // Open existing wallet
  async openWallet(filename, password = '') {
    return this.call('open_wallet', {
      filename,
      password
    });
  }

  // Close current wallet
  async closeWallet() {
    return this.call('close_wallet');
  }

  // Get wallet address
  async getAddress() {
    const result = await this.call('get_address');
    return result.address;
  }

  // Get balance
  async getBalance() {
    const result = await this.call('get_balance');
    return {
      balance: result.balance,
      unlockedBalance: result.unlocked_balance
    };
  }

  // Prepare multisig with extended timeout and retry
  async prepareMultisig() {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use 90s timeout for multisig operations (wallet may be syncing)
        const result = await this.call('prepare_multisig', {}, 90000);
        return result.multisig_info;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to prepare multisig after ${maxRetries} attempts: ${error.message}`);
        }
        console.log(`  Retry ${attempt}/${maxRetries} - waiting for wallet sync...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  // Make multisig (8-of-11)
  async isMultisig() {
    const result = await this.call('is_multisig');
    return result;
  }

  async makeMultisig(multisigInfo, threshold = 8) {
    const result = await this.call('make_multisig', {
      multisig_info: multisigInfo,
      threshold
    }, 90000);
    return {
      address: result.address,
      multisigInfo: result.multisig_info
    };
  }

  // Exchange multisig keys
  async exchangeMultisigKeys(multisigInfo) {
    const result = await this.call('exchange_multisig_keys', {
      multisig_info: multisigInfo
    }, 90000);
    return result.multisig_info;
  }

  // Export multisig info
  async exportMultisigInfo() {
    const result = await this.call('export_multisig_info');
    return result.info;
  }

  // Import multisig info
  async importMultisigInfo(info) {
    const result = await this.call('import_multisig_info', {
      info
    });
    return result.n_outputs;
  }

  // Sign multisig transaction
  async signMultisig(txDataHex) {
    const result = await this.call('sign_multisig', {
      tx_data_hex: txDataHex
    });
    return {
      txDataHex: result.tx_data_hex,
      txHashList: result.tx_hash_list
    };
  }

  // Submit multisig transaction
  async submitMultisig(txDataHex) {
    const result = await this.call('submit_multisig', {
      tx_data_hex: txDataHex
    });
    return result.tx_hash_list;
  }

  // Transfer (create unsigned transaction)
  async transfer(destinations, mixin = 10) {
    const result = await this.call('transfer', {
      destinations,
      mixin,
      get_tx_key: true,
      do_not_relay: true
    });
    return {
      txDataHex: result.multisig_txset,
      txHash: result.tx_hash
    };
  }

  // Refresh wallet
  async refresh() {
    return this.call('refresh');
  }

  // Query key (spend_key or view_key)
  async queryKey(keyType) {
    const result = await this.call('query_key', {
      key_type: keyType
    });
    return result.key;
  }

  // Get height
  // Finalize multisig
  async finalizeMultisig(exchangedKeys) {
    const result = await this.call('finalize_multisig', {
      multisig_info: exchangedKeys
    }, 90000);
    return result;
  }

  async getHeight() {
    const result = await this.call('get_height');
    return result.height;
  }
}

module.exports = MoneroRPC;
