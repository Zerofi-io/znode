# The Multisig Problem and Solution

## Problem
After `make_multisig`, we were calling `export_multisig_info` which is WRONG.
- `export_multisig_info` is for exporting info to SIGN transactions (only works on finalized multisig)
- We need the `multisig_info` that `make_multisig` RETURNS

## Solution
1. **ALL nodes must call make_multisig** (not just coordinator)
2. Each node's `make_multisig` returns `{address, multisig_info}`
3. That `multisig_info` is submitted for Round 3
4. For rounds 3 and 4, use `exchange_multisig_keys` 
5. Each `exchange_multisig_keys` returns new `multisig_info` for next round

## New Flow
- Coordinator: make_multisig → submit info → coord round 3 → coord round 4 → finalize
- Non-coord: make_multisig → submit info → participate round 3 → participate round 4

Everyone calls make_multisig with the SAME peer info, so everyone gets valid wallets.
