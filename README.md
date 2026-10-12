# znode

znode is the node of the ZeroFi testnet, a bridge between Monero and Ethereum's Sepolia testnet: the nodes keep one shared ledger and hold deposited Monero in wallets they control together, and the token zXMR on Sepolia is minted for deposits and burned for withdrawals.
Every node runs this one binary beside its own Monero daemon and bonds 1,000,000 ZFI at the network's staking contract.

## Requirements

- A server running Ubuntu 22.04 or 24.04, or Debian 12, on x86-64, with root access (the commands below use `sudo`) and `curl`.
- A public IPv4 address on the server itself: the join refuses a server whose default route leaves from a private address, as behind NAT.
- TCP port 9000 open to the internet (the node listens there for its peers), the clock kept in sync (the join does not set this up), and disk room under /data for the pruned Monero chain.
- Your own Sepolia RPC URL (http or https). The build already holds two public endpoints, ethereum-sepolia-rpc.publicnode.com and sepolia.gateway.tenderly.co, and refuses either one as yours.
- A new Ethereum key made for this node: it becomes the node's own key and is stored on the server. Its address needs 1,000,000 ZFI for the bond and some Sepolia ETH for the node's own transactions: the approve and the stake at the join, the exit and the release when it leaves. The running node sends no transactions.

## Node specs

Per host, one node plus one monerod:

| Part | Spec |
|---|---|
| CPU | 4 vCPU |
| RAM | 8 GB |
| Disk | 250 GB SSD or NVMe |
| Network | public IPv4, 1 Gbit port, 2 TB a month or unmetered |
| OS | Ubuntu 24.04, x86_64, systemd |

## Download and check

```
curl -fLO https://github.com/Zerofi-io/znode/releases/latest/download/znode
curl -fLO https://github.com/Zerofi-io/znode/releases/latest/download/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
chmod +x znode
```

The check must print `znode: OK`; do not run a binary that fails it.

## Join

```
sudo ./znode join
```

It asks two things:

- `Sepolia RPC URL:` your endpoint.
- `Node key (the funded address's private key, 64 hex digits):` the key, with or without 0x; it is not shown while you type.

It prints the node's address and the server's public address, then installs and starts everything:

1. It checks the binary's sha256 and the node's config and genesis before it changes anything.
2. It creates the system users `znode` and `monero`.
3. It installs the node binary at /usr/local/bin/znode.
4. It downloads monerod v0.18.5.1 from getmonero.org, checks its sha256 and runs it under systemd (`monerod`): pruned, its RPC on 127.0.0.1:18081 only. The daemon syncs the Monero main chain from scratch, which takes days.
5. It writes /etc/znode/config.json and /etc/znode/genesis.json.
6. It stores the node key, encrypted under a fresh secret: /var/lib/znode/secret and /var/lib/znode/data/keys.redb.
7. It stakes once: approve and stake at the staking contract, skipped when the node is bonded already.
8. It installs and starts the `znode` systemd unit, which starts the node at boot and restarts it whenever it exits.

It ends with `joined`. If it stops on an error, fix what its last lines name and run it again: every step whose state already holds is skipped.

## Health

```
curl -s http://127.0.0.1:9001/v1/health
```

- `head`: the height of the last block the node committed. It rises while the node catches up with the network; `head_age_blocks`, that block's age in blocks, stays near 0 once it has.
- `peers`: how many peers the node is connected to.
- `monerod`: the Monero daemon's top block as the node last read it, its `height` and `age_secs` (the age of that block). While the daemon syncs, `age_secs` is large and falls as it catches up. It is `null` until the node first scans a wallet, which it does only once it is a member of a cluster (listed under `clusters`).

The logs: `journalctl -u znode -f`; the daemon writes /data/monero/log/monerod.log.

## Upgrade

Download the new release and check it as above, then run `sudo ./znode join` again. It asks the same two things, installs the new binary and restarts the node; every step whose state already holds does nothing, so the key and the stake stay as they are.

A release that starts a new chain (a re-genesis; its notes say so) needs nothing more: the join stops the node when the genesis changes, and its init step leaves the old chain (the old key shares forgotten, the wallet and chain store removed, the old chain recorded as left) before the node starts on the new chain from its block 0; the join prints a line saying so. The node key and the secret stay. A re-genesis release also names new contracts, so the join stakes the node again: its address needs the bond in the new ZFI and some Sepolia ETH before the join, as at the first join; the old bond stays in the old contract. A node never returns to a chain it left with the same key, and never empties anything at a plain restart: a node started over a store of another chain stops and says so.

## Stop

```
sudo systemctl stop znode
sudo systemctl start znode
```

A node stopped this way stays stopped until it is started again or the server boots.

## Exit and release

To leave, request the exit, wait, then release the bond. Both commands send a transaction from the node key and need the node stopped, since the running node holds its key store open. Stop it and keep it from starting at boot, show the staking contract's address, and request the exit with it:

```
sudo systemctl disable --now znode
sudo grep staking_contract /etc/znode/genesis.json
sudo -u znode znode exit /etc/znode/config.json <staking-address>
```

It prints `exit requested at block N` (`exiting already` when it was requested before). The node leaves the bonded list at once; its bond stays held, and slashable, until the release:

```
sudo -u znode znode release /etc/znode/config.json <staking-address>
```

The staking contract returns the bond only once:

- the stake is at least `lockBlocks()` Sepolia blocks old and the exit request at least `drainBlocks()` blocks old (both fixed in the staking contract), and
- the node is not in the custody registry's current roster, and `lagBlocks()` blocks have passed since a roster without it reached the registry.

Until then the release is refused (`TooEarly` from the staking contract, or a revert of `releaseExit()` from the registry) and sends nothing: run it again later. It prints `released at block N`, or `no bond held` when no bond is left.

## Back up

Once the join is done, copy /var/lib/znode/secret and /var/lib/znode/data/keys.redb off the server: the network cannot give them back. To restore a node, put both back at their paths and run the join again with the same key.

## License

znode is under the MIT license (LICENSE); THIRD-PARTY-LICENSES.md lists the licenses of the packages it is built from.
