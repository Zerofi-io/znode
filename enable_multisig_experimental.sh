#!/usr/bin/expect -f
# Enable experimental multisig on a wallet using monero-wallet-cli
# Usage: ./enable_multisig_experimental.sh <wallet_name>

set wallet_name [lindex $argv 0]
if {$wallet_name == ""} {
    puts "Usage: $argv0 <wallet_name>"
    exit 1
}

set wallet_path "$env(HOME)/.monero-wallets/$wallet_name"

if {![file exists $wallet_path]} {
    puts "Error: Wallet $wallet_path not found"
    exit 1
}

set timeout 10
spawn monero-wallet-cli --wallet-file $wallet_path --password "" --offline --log-level 0

# Handle background mining prompt
expect {
    "Do you want to do it now?" {
        send "N\r"
        exp_continue
    }
    "wallet *]:*" {
        # We're at the prompt
    }
    timeout {
        puts "Timeout waiting for wallet prompt"
        exit 1
    }
}

# Send the set command
send "set enable_multisig_experimental 1\r"

expect {
    "wallet *]:*" {
        # Command executed
    }
    timeout {
        puts "Timeout after set command"
        exit 1
    }
}

# Exit
send "exit\r"
expect eof

puts "✓ Enabled experimental multisig on $wallet_name"
