const secrets = require('secrets.js-grempe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Monero Shamir Secret Sharing "Multisig" System
 * 
 * This implements a dynamic threshold signature scheme using Shamir's Secret Sharing
 * We call it "multisig" for consistency, but it's technically threshold cryptography
 */

class MoneroShamirMultisig {
  constructor() {
    this.shareBackupDir = path.join(process.env.HOME, '.monero-shares');
    this.ensureBackupDir();
  }

  ensureBackupDir() {
    if (!fs.existsSync(this.shareBackupDir)) {
      fs.mkdirSync(this.shareBackupDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Generate a new Monero private key and split into Shamir shares
   * @param {number} totalShares - Total number of shares to create (N)
   * @param {number} threshold - Minimum shares needed to reconstruct (K)
   * @param {number} epoch - Current epoch/version number
   * @returns {Object} { privateKey, shares, publicAddress }
   */
  generateAndSplit(totalShares, threshold, epoch = 0) {
    console.log(`\n🔐 Generating Monero "Multisig" Wallet`);
    console.log(`   Total shares: ${totalShares}`);
    console.log(`   Threshold: ${threshold}`);
    console.log(`   Epoch: ${epoch}`);
    
    // Generate a 256-bit Monero private spend key
    const privateKey = crypto.randomBytes(32);
    const privateKeyHex = privateKey.toString('hex');
    
    console.log(`   Private key generated: ${privateKeyHex.substring(0, 16)}...`);
    
    // Split using Shamir's Secret Sharing
    // Convert to base64 for secrets.js
    const secret = privateKey.toString('hex');
    const shares = secrets.share(secret, totalShares, threshold);
    
    console.log(`✓  ${totalShares} shares created (${threshold}-of-${totalShares} threshold)`);
    
    // For now, we'll derive a simple address (in production, use proper Monero key derivation)
    // This is a placeholder - real implementation would use Monero's address generation
    const publicAddress = this.deriveMoneroAddress(privateKey);
    
    return {
      privateKey: privateKeyHex,
      shares: shares.map((share, index) => ({
        index: index + 1,
        share: share,
        epoch: epoch,
        threshold: threshold,
        totalShares: totalShares
      })),
      publicAddress: publicAddress,
      epoch: epoch
    };
  }

  /**
   * Reconstruct private key from shares
   * @param {Array} shares - Array of share objects
   * @returns {string} Reconstructed private key in hex
   */
  reconstruct(shares) {
    if (shares.length < shares[0].threshold) {
      throw new Error(`Need at least ${shares[0].threshold} shares, got ${shares.length}`);
    }
    
    console.log(`\n🔓 Reconstructing private key from ${shares.length} shares...`);
    
    // Extract just the share strings
    const shareStrings = shares.map(s => s.share);
    
    // Reconstruct using Shamir
    const reconstructed = secrets.combine(shareStrings);
    
    console.log(`✓  Private key reconstructed: ${reconstructed.substring(0, 16)}...`);
    
    // Note: In production, immediately use this key and destroy it from memory
    return reconstructed;
  }

  /**
   * Encrypt a share for a specific node
   * @param {Object} share - Share object
   * @param {string} nodePublicKey - Node's public key (hex)
   * @returns {string} Encrypted share
   */
  encryptShare(share, nodePublicKey) {
    // Use ECIES or similar in production
    // For now, simple AES encryption with derived key
    const cipher = crypto.createCipher('aes-256-gcm', nodePublicKey);
    let encrypted = cipher.update(JSON.stringify(share), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  /**
   * Decrypt a share
   * @param {string} encryptedShare - Encrypted share
   * @param {string} nodePrivateKey - Node's private key (hex)
   * @returns {Object} Decrypted share object
   */
  decryptShare(encryptedShare, nodePrivateKey) {
    const decipher = crypto.createDecipher('aes-256-gcm', nodePrivateKey);
    let decrypted = decipher.update(encryptedShare, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }

  /**
   * Save encrypted share to disk with 48h expiry
   * @param {string} nodeAddress - Ethereum address of node
   * @param {Object} share - Share object
   * @param {string} encryptedShare - Encrypted share data
   */
  backupShare(nodeAddress, share, encryptedShare) {
    const filename = `share_${nodeAddress}_epoch${share.epoch}.json`;
    const filepath = path.join(this.shareBackupDir, filename);
    
    const backup = {
      nodeAddress,
      epoch: share.epoch,
      threshold: share.threshold,
      totalShares: share.totalShares,
      encryptedShare,
      createdAt: Date.now(),
      expiresAt: Date.now() + (48 * 60 * 60 * 1000) // 48 hours
    };
    
    fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), { mode: 0o600 });
    console.log(`💾 Share backup saved: ${filename}`);
  }

  /**
   * Load share from backup
   * @param {string} nodeAddress - Ethereum address of node
   * @param {number} epoch - Epoch number
   * @returns {Object|null} Share backup or null if not found/expired
   */
  loadShareBackup(nodeAddress, epoch) {
    const filename = `share_${nodeAddress}_epoch${epoch}.json`;
    const filepath = path.join(this.shareBackupDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return null;
    }
    
    const backup = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    
    // Check if expired
    if (Date.now() > backup.expiresAt) {
      console.log(`⚠️  Share backup expired: ${filename}`);
      fs.unlinkSync(filepath);
      return null;
    }
    
    console.log(`✓  Share backup loaded: ${filename}`);
    return backup;
  }

  /**
   * Clean up expired backups
   */
  cleanExpiredBackups() {
    if (!fs.existsSync(this.shareBackupDir)) return;
    
    const files = fs.readdirSync(this.shareBackupDir);
    let cleaned = 0;
    
    for (const file of files) {
      const filepath = path.join(this.shareBackupDir, file);
      try {
        const backup = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        if (Date.now() > backup.expiresAt) {
          fs.unlinkSync(filepath);
          cleaned++;
        }
      } catch (e) {
        // Invalid file, remove it
        fs.unlinkSync(filepath);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} expired share backups`);
    }
  }

  /**
   * Derive Monero address from private key
   * THIS IS A PLACEHOLDER - Use proper Monero library in production
   */
  deriveMoneroAddress(privateKey) {
    // In production, use monero-javascript or similar
    // For now, create a fake address that looks like Monero
    const hash = crypto.createHash('sha256').update(privateKey).digest();
    return '4' + hash.toString('hex').substring(0, 94); // Monero addresses start with 4
  }

  /**
   * Calculate optimal threshold based on total nodes
   * Keeps threshold at 15-20% of total, minimum 8
   */
  calculateOptimalThreshold(totalNodes) {
    return Math.max(8, Math.floor(totalNodes * 0.15));
  }
}

module.exports = MoneroShamirMultisig;
