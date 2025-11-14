# Monero 8-of-11 Multisig Solution

## Problem
The original implementation produced invalid Monero multisig addresses containing placeholder "111" characters because it didn't properly execute all required multisig setup rounds.

## Root Causes
1. **Wrong API calls**: Used `export_multisig_info` / `import_multisig_info` which are for SIGNING transactions, not for wallet setup
2. **Missing rounds**: Only performed 2 exchange rounds, but 8-of-11 requires 4 exchange rounds
3. **Centralized setup**: Only coordinator called `make_multisig`, but ALL 11 nodes must call it independently
4. **Wrong info source**: Tried to export info after setup, instead of using the `multisig_info` returned by each RPC call

## Solution

### Correct Monero Multisig Flow for M-of-N
Number of exchange rounds needed: `N - M + 1`

For 8-of-11: `11 - 8 + 1 = 4` exchange rounds after `make_multisig`

### Complete Flow (6 Rounds Total)

**Round 1: prepare_multisig**
- Each node: `prepare_multisig()` → returns `multisig_info`  
- All nodes submit their R1 info to smart contract
- Info stored on-chain for cluster formation

**Round 2: make_multisig**
- Each node independently calls: `make_multisig(peer_r1_infos, threshold=8)` → returns `{address, multisig_info}`
- This creates incomplete multisig wallet (address has "111" placeholders)
- Each node submits R2 `multisig_info` to exchange coordinator

**Rounds 3-6: exchange_multisig_keys (4 rounds)**
- Each round:
  1. Wait for all 11 nodes to submit previous round's info
  2. Fetch peer infos from exchange coordinator
  3. Call: `exchange_multisig_keys(peer_infos)` → returns `{address, multisig_info}`
  4. Submit returned `multisig_info` for next round

**Final Step: Get Address**
- After Round 6, call `get_address()` to retrieve final valid address
- Verify `is_multisig()` returns `{ready: true, threshold: 8, total: 11}`
- Address should NOT contain "111" placeholders

## Key Implementation Details

### Use Return Values, Not Export
```javascript
// ❌ WRONG - This is for signing, not setup
const info = await monero.call('export_multisig_info');
await monero.call('import_multisig_info', { info: peerInfos });

// ✅ CORRECT - Use return values from setup calls
const r = await monero.call('exchange_multisig_keys', { 
  multisig_info: peerInfos,
  password: '' 
});
const nextRoundInfo = r.multisig_info; // Use this for next round
```

### All Nodes Must Call make_multisig
```javascript
// ❌ WRONG - Only coordinator calls make_multisig
if (isCoordinator) {
  await monero.call('make_multisig', ...);
}

// ✅ CORRECT - ALL nodes call make_multisig independently
const makeResult = await monero.call('make_multisig', {
  multisig_info: peerR1Infos,
  threshold: 8,
  password: ''
});
// Submit makeResult.multisig_info to coordinator for Round 3
```

### Retrieve Final Address
```javascript
// ❌ WRONG - exchange_multisig_keys returns empty address field in v0.18
const r = await monero.call('exchange_multisig_keys', ...);
const address = r.address; // Empty string

// ✅ CORRECT - Call get_address after final exchange
await monero.call('exchange_multisig_keys', ...); // Final round
const addrResult = await monero.call('get_address');
const finalAddress = addrResult.address; // Valid multisig address
```

## Verification
Tested locally with 11 Monero RPC instances (ports 28081-28091):
- ✅ All 11 nodes complete all 6 rounds
- ✅ All nodes have identical final address
- ✅ Address is valid (no "111" placeholders)
- ✅ `is_multisig()` returns `ready: true` for all nodes
- ✅ Threshold correctly set to 8-of-11

## Files Modified
- `node.js`: Fixed `finalizeClusterWithMultisigCoordination()` with correct flow
- Added helper methods: `submitExchangeInfo()`, `performExchangeRound()`
- Removed broken methods: `coordinateExchangeRound()`, `participateInExchangeRounds()`

## Testing Command
See `test-8of11-full.js` in `/root/znode-11-test/` for complete working example.
