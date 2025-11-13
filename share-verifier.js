const crypto = require('crypto');

/**
 * Share Verifier for Shamir Secret Sharing
 * Simplified to work with actual secrets.js-grempe format
 */
class ShareVerifier {
  /**
   * Verify share format
   */
  static verifyShareFormat(share) {
    if (typeof share !== 'string') {
      return { valid: false, reason: 'Share must be a string' };
    }
    
    if (!/^[0-9a-fA-F]+$/.test(share)) {
      return { valid: false, reason: 'Share must be hex' };
    }
    
    if (share.length < 10) {
      return { valid: false, reason: 'Share too short' };
    }
    
    return { valid: true };
  }

  /**
   * Verify consistency across multiple shares
   */
  static verifySharesConsistency(shares) {
    if (shares.length < 2) {
      return { valid: true };
    }
    
    // Check all shares have same length
    const firstLength = shares[0].length;
    for (const share of shares) {
      if (share.length !== firstLength) {
        return { valid: false, reason: 'Inconsistent share lengths' };
      }
    }
    
    // Check share IDs are unique (position 2 = share ID in hex)
    const shareIds = new Set();
    for (const share of shares) {
      const id = share.slice(2, 3); // Single hex char = share ID (1-b for 11 shares)
      if (shareIds.has(id)) {
        return { valid: false, reason: 'Duplicate share IDs' };
      }
      shareIds.add(id);
    }
    
    // Check bits are consistent (first 2 chars)
    const firstBits = shares[0].slice(0, 2);
    for (const share of shares) {
      if (share.slice(0, 2) !== firstBits) {
        return { valid: false, reason: 'Inconsistent bit sizes' };
      }
    }
    
    return { valid: true };
  }

  /**
   * Test reconstruction capability
   */
  static testReconstruction(shares, threshold) {
    try {
      const secrets = require('secrets.js-grempe');
      
      if (shares.length < threshold) {
        return { 
          valid: false, 
          canReconstruct: false,
          reason: `Insufficient shares: ${shares.length} < ${threshold}` 
        };
      }
      
      const reconstructed = secrets.combine(shares);
      
      return {
        valid: true,
        canReconstruct: true,
        reconstructedLength: reconstructed.length
      };
    } catch (error) {
      return {
        valid: false,
        canReconstruct: false,
        reason: error.message
      };
    }
  }

  /**
   * Create commitment for a share
   */
  static createCommitment(share) {
    return crypto.createHash('sha256').update(share).digest('hex');
  }

  /**
   * Verify share matches commitment
   */
  static verifyCommitment(share, commitment) {
    const computed = this.createCommitment(share);
    return computed === commitment;
  }

  /**
   * Validate single share with all checks
   */
  static validateShare(share, options = {}) {
    const { expectedCommitment, peerShares, threshold } = options;
    
    const result = {
      format: this.verifyShareFormat(share),
      commitment: null,
      reconstruction: null
    };
    
    if (expectedCommitment) {
      result.commitment = {
        valid: this.verifyCommitment(share, expectedCommitment)
      };
    }
    
    if (peerShares && threshold) {
      const allShares = [share, ...peerShares];
      result.reconstruction = this.testReconstruction(allShares, threshold);
    }
    
    return result;
  }

  /**
   * Batch validate multiple shares
   */
  static batchValidate(shares, threshold) {
    const results = shares.map(share => ({
      share: share.slice(0, 10) + '...',
      format: this.verifyShareFormat(share)
    }));
    
    const consistency = this.verifySharesConsistency(shares);
    const reconstruction = this.testReconstruction(shares, threshold);
    
    return {
      individual: results,
      consistency,
      reconstruction,
      allValid: results.every(r => r.format.valid) && 
                consistency.valid && 
                reconstruction.canReconstruct
    };
  }
}

module.exports = ShareVerifier;
