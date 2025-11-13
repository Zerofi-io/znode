const crypto = require('crypto');
const { ec: EC } = require('elliptic');
const ec = new EC('secp256k1');

/**
 * ECIES Encryption using ECDH + AES-256-GCM
 * Properly implements Elliptic Curve Integrated Encryption Scheme
 */
class ECIESEncryption {
  constructor(wallet) {
    this.wallet = wallet;
    // Get EC keypair from wallet private key
    this.keyPair = ec.keyFromPrivate(wallet.privateKey.slice(2), 'hex');
  }

  /**
   * Derive shared secret using proper ECDH
   * @param {string} otherPublicKey - Hex public key (04... format)
   */
  deriveSharedSecretECDH(otherPublicKey) {
    // otherPublicKey should be uncompressed format (04 + x + y)
    const otherKeyPair = ec.keyFromPublic(otherPublicKey, 'hex');
    
    // Perform ECDH: our_private * their_public
    const shared = this.keyPair.derive(otherKeyPair.getPublic());
    
    // Convert to 32-byte key
    const sharedSecret = Buffer.from(shared.toArray('be', 32));
    
    // Use HKDF (simple version with SHA256)
    return crypto.createHash('sha256').update(sharedSecret).digest();
  }

  /**
   * Get public key from Ethereum address
   * NOTE: This is a limitation - Ethereum addresses only contain the last 20 bytes
   * of the Keccak256 hash of the public key, so we can't recover the full public key!
   * 
   * SOLUTION: Nodes must include their public key in messages or register on-chain
   */
  getPublicKeyFromAddress(address) {
    // This is a placeholder - in real implementation, 
    // public keys must be exchanged separately or registered on-chain
    throw new Error('Cannot derive public key from address - must be provided separately');
  }

  /**
   * Encrypt data for a recipient using their public key
   * @param {string} data - Plaintext data
   * @param {string} recipientPublicKey - Recipient's public key (hex, uncompressed)
   */
  async encryptWithECDH(data, recipientPublicKey) {
    try {
      const dataBuffer = Buffer.from(data, 'utf8');
      
      // Derive shared secret using ECDH
      const sharedSecret = this.deriveSharedSecretECDH(recipientPublicKey);
      
      // Use AES-256-GCM for symmetric encryption
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
      
      let encrypted = cipher.update(dataBuffer);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      const authTag = cipher.getAuthTag();
      
      // Include our public key in the message so recipient can derive shared secret
      const ourPublicKey = Buffer.from(this.keyPair.getPublic().encode('hex', false), 'hex');
      
      // Format: [1 byte: pubkey length][public key][16 bytes: IV][16 bytes: authTag][encrypted data]
      const result = Buffer.concat([
        Buffer.from([ourPublicKey.length]),
        ourPublicKey,
        iv,
        authTag,
        encrypted
      ]);
      
      return '0x' + result.toString('hex');
    } catch (error) {
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt data from a sender
   * @param {string} encryptedHex - Encrypted data (hex string with 0x prefix)
   */
  async decryptWithECDH(encryptedHex) {
    try {
      const encryptedBuffer = Buffer.from(encryptedHex.slice(2), 'hex');
      
      // Parse: [1 byte: pubkey length][public key][16 bytes: IV][16 bytes: authTag][encrypted data]
      const pubKeyLength = encryptedBuffer[0];
      const senderPublicKey = encryptedBuffer.slice(1, 1 + pubKeyLength).toString('hex');
      const iv = encryptedBuffer.slice(1 + pubKeyLength, 1 + pubKeyLength + 16);
      const authTag = encryptedBuffer.slice(1 + pubKeyLength + 16, 1 + pubKeyLength + 32);
      const encrypted = encryptedBuffer.slice(1 + pubKeyLength + 32);
      
      // Derive shared secret using sender's public key
      const sharedSecret = this.deriveSharedSecretECDH(senderPublicKey);
      
      // Decrypt
      const decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      return decrypted.toString('utf8');
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * Create authenticated package (encrypted + signed)
   */
  async createAuthenticatedPackage(data, recipientPublicKey) {
    const encrypted = await this.encryptWithECDH(data, recipientPublicKey);
    
    // Sign the encrypted data
    const messageHash = crypto.createHash('sha256').update(encrypted).digest();
    const signature = this.wallet.signMessage(messageHash);
    
    return {
      encrypted,
      signature,
      senderAddress: this.wallet.address
    };
  }

  /**
   * Verify and decrypt authenticated package
   */
  async verifyAndDecrypt(pkg) {
    const { encrypted, signature, senderAddress } = pkg;
    
    // Verify signature
    const messageHash = crypto.createHash('sha256').update(encrypted).digest();
    const ethers = require('ethers');
    const recoveredAddress = ethers.utils.verifyMessage(messageHash, signature);
    
    if (recoveredAddress.toLowerCase() !== senderAddress.toLowerCase()) {
      throw new Error('Signature verification failed');
    }
    
    // Decrypt
    return await this.decryptWithECDH(encrypted);
  }

  /**
   * Get our public key (for sharing with others)
   */
  getPublicKey() {
    return this.keyPair.getPublic().encode('hex', false);
  }
}

module.exports = ECIESEncryption;
