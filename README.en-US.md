# BSC Token Distribution Script

Automatically collects addresses that have recently sent transactions on BSC, filters out duplicates and addresses that already hold the token, and distributes tokens according to your configuration.

**Tokens are transferred only when you run the send command. The script exits when the run is complete.**

## 1. Installation and Setup

Install Git and the latest maintenance release of Node.js 22 or a newer LTS release. Use an account with access to the repository. Run the following commands in PowerShell, replacing `<repository-url>` with the actual Git URL:

```powershell
git clone "<repository-url>" bsc-distributor
cd bsc-distributor
npm.cmd ci
```

If you have already downloaded and extracted the code, open a terminal in the project folder and run `npm.cmd ci`. Run all subsequent commands from the project folder.

For initial setup, create two configuration files in the project folder:

- Copy `config.example.json` and rename the copy to `config.json`. This file contains the token contract address and distribution settings.
- Copy `.env.example` and rename the copy to `.env`. This file contains the RPC endpoints and private key.

If these files already exist, edit them directly instead of creating new copies. On Windows, make sure the filenames do not end up as `config.json.txt` or `.env.txt`.

## 2. Configuration

Open `config.json`. The main settings are listed below. Saved changes take effect the next time you start the script.

| Setting | Example value | Description |
| --- | --- | --- |
| `chainId` | `56` | BSC mainnet |
| `tokenAddress` | `REPLACE_WITH_TOKEN_CONTRACT` | The token contract to distribute; replace this placeholder before use |
| `countPerRun` | `50` | Maximum number of addresses to process per run; adjust as needed |
| `amountPerAddress` | `"0.0001"` | Nominal token amount to send to each address |
| `batchSize` | `5` | Number of transactions to broadcast per batch, from 1 to 5; set to 1 to wait for each transaction individually |
| `maxGasPerRunBnb` | `"0.002"` | Total reserved transaction fee budget per run, in BNB |
| `maxGasPriceGwei` | `"1"` | Maximum gas price, in Gwei |
| `confirmations` | `15` | Confirmations to wait for after sending; also determines how far behind the latest block address collection begins |
| `lookbackBlocks` | `500` | Maximum number of blocks to scan |
| `rpcDelayMs` | `150` | Delay between collection queries, in milliseconds |
| `timezone` | `"Asia/Shanghai"` | Time zone for recorded dates; does not affect per-run limits |
| `excludeAddresses` | `[]` | Additional addresses to exclude |

JSON does not allow comments or trailing commas. Keep amount values in double quotes.

**50 is not a hard limit.** Each new run has its own allowance. The script may stop early if it reaches a limit, runs out of eligible addresses, or has insufficient funds or budget. Pending transactions recovered from a previous run also count toward the current run's address limit and budget. For example, with a limit of 50, recovering one transaction leaves room for up to 49 new transfers.

`maxGasPerRunBnb` is a budget, not a fixed charge. The script reserves `gasLimit × gasPrice` for each transaction. Actual fees depend on on-chain gas usage. Processing stops if the budget or wallet balance cannot cover the entire batch. Each address still receives a separate transaction; broadcasting in batches does not directly reduce fees.

### RPC Endpoints and Private Key

Leave `BSC_RPC_URLS` blank in `.env` to use the built-in public mainnet endpoints, or provide a comma-separated list:

```dotenv
BSC_RPC_URLS=https://bsc-dataseed.bnbchain.org,https://bsc-dataseed-public.bnbchain.org,https://bsc-rpc.publicnode.com
PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY
```

The script tries a backup endpoint if a node times out or rate-limits requests. Preview mode does not require a private key. For actual transfers, enter the dedicated distribution wallet's `PRIVATE_KEY` locally. Do not save the file as `.env.txt`, and do not upload or share your private key.

The wallet must hold the token you want to distribute and native BNB. **BNB pays the transaction fees.**

## 3. Collect and Preview Addresses (No Transfers)

```powershell
npm.cmd run preview
```

Progress is displayed every five seconds. When collection finishes, the results are saved to `data/preview.json`. To view the file:

```powershell
Get-Content .\data\preview.json
```

The `selected` list contains each address, its source block, and its source transaction. Addresses are unique within a single list. Each successful collection overwrites the previous preview file. Separate preview runs may include the same addresses because previewing does not mark them as sent.

## 4. Send Tokens

After entering the private key and funding the wallet with tokens and BNB, run:

```powershell
npm.cmd run send -- --execute
```

The script collects addresses again rather than using the previous preview list as a fixed recipient list. For each batch, it validates and saves the signed transactions, broadcasts up to five transactions with consecutive nonces, and waits for the batch to be confirmed before processing the next batch. Transaction hashes appear in the terminal so you can check actual fees and results on BscScan.

Token balances are checked during collection and again when preparing transfers. Addresses with a nonzero balance are skipped. Failed balance queries are not treated as zero balances. Contract addresses, explicitly excluded addresses, and addresses in the distribution history are also skipped. An address already in the history remains excluded even if it later transfers its tokens elsewhere.

Collected addresses do not necessarily represent unique users or indicate consent to receive tokens. Token-specific fees, blacklists, transfer rate limits, and other rules may affect the amount received or cause transactions to revert.

## 5. Records, Backups, and Recovery

| File | Purpose |
| --- | --- |
| `data/preview.json` | Most recent candidate list, not the distribution history |
| `data/state.json` | Distribution history, transaction hashes, and statuses used for deduplication and recovery |
| `data/run.lock` | Process lock created while the script runs and removed on normal exit |

**Do not delete, empty, or roll back `state.json`.** Historical deduplication is maintained per chain and token contract. It does not reset when the date changes or a new run begins. Addresses with pending, confirmed, or reverted records are not selected again as new recipients.

### File Size and Long-Term Use

The state file grows as transaction records accumulate. At approximately 50 records per day, rough estimates are:

| Time period | Number of records | Estimated file size |
| --- | --- | --- |
| 30 days | About 1,500 | About 1 MB |
| 1 year | About 18,250 | About 10–20 MB |

### Backups

Stop the script before periodically backing up `.env`, `config.json`, and the entire `data` folder to a private location. These files are excluded from GitHub, so a copy of the repository is not a backup of your distribution history. Records do not automatically sync across machines. Do not run multiple copies to send tokens at the same time.

### Resuming After an Interruption

Press Ctrl+C to stop the script. Transactions that have already been broadcast cannot be withdrawn. If the script reports that a run lock already exists, first use Task Manager to confirm that the previous script process has exited, then delete the leftover `data/run.lock`. **Do not delete `state.json`.**

Run the send command again with the same token contract and distribution wallet. The script recovers the original saved signed transactions before processing new addresses. If broadcasting was interrupted partway through a batch, saved records may include transactions that have not yet been broadcast; recovery will send those original transactions. If a nonce is reported as already used, check the on-chain records and avoid sending from the same wallet through other wallet tools or scripts at the same time.

## macOS / Linux Commands

From the project folder, use `npm ci` to install dependencies, `npm run preview` to preview addresses, and `npm run send -- --execute` to send tokens.

## License and Private Key Security

**Keep your private keys and seed phrases secure. Do not send them to other people or third-party services, and do not include them in repositories, logs, or screenshots.** The `.env` file stores local configuration in plain text. Restrict access and store it securely. Use a dedicated distribution wallet containing only the assets and transaction fees you need.
