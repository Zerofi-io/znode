// Calculate number of multisig rounds needed
// For M-of-N multisig: rounds = N - M

const threshold = 8;  // M
const totalNodes = 11; // N

const rounds = totalNodes - threshold;
console.log(`For ${threshold}-of-${totalNodes} multisig:`);
console.log(`  Rounds needed: ${rounds}`);
console.log(`  Round 1: prepare_multisig`);
console.log(`  Round 2: make_multisig`);
for (let i = 3; i <= rounds + 1; i++) {
  console.log(`  Round ${i}: exchange_multisig_keys`);
}
