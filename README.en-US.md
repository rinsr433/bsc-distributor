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
| `rpcDelayMs` | `150` | Delay between queries within each collection task, in milliseconds |
| `collectConcurrency` | `3` | Number of candidate addresses checked concurrently, from 1 to 5 |
| `confirmationTimeoutMs` | `120000` | Maximum confirmation wait per transaction, in milliseconds |
| `confirmationPollMs` | `2000` | Interval between confirmation checks, in milliseconds |
| `timezone` | `"Asia/Shanghai"` | Time zone for recorded dates; does not affect per-run limits |
| `excludeAddresses` | `[]` | Additional addresses to exclude |

JSON does not allow comments or trailing commas. Keep amount values in double quotes. The new collection concurrency and confirmation timing settings are optional; omitted settings use the defaults shown above.

**50 is not a hard limit.** Each new run has its own allowance. The script may stop early if it reaches a limit, runs out of eligible addresses, or has insufficient funds or budget. Pending transactions recovered from a previous run also count toward the current run's address limit and budget. For example, with a limit of 50, recovering one transaction leaves room for up to 49 new transfers.

`maxGasPerRunBnb` is a budget, not a fixed charge. The script reserves `gasLimit × gasPrice` for each transaction. Actual fees depend on on-chain gas usage. If the budget or wallet balance cannot cover a full batch, the script sends the smaller batch it can afford, then stops. Each address still receives a separate transaction; broadcasting in batches does not directly reduce fees.

### RPC Endpoints and Private Key

Leave `BSC_RPC_URLS` blank in `.env` to use the built-in public mainnet endpoints, or provide a comma-separated list:

```dotenv
BSC_RPC_URLS=https://bsc-dataseed.bnbchain.org,https://bsc-dataseed-public.bnbchain.org,https://bsc-rpc.publicnode.com
PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY
```

The script tries a backup endpoint if a node times out or rate-limits requests, with a short backoff for failed endpoints. Chain ID checks are cached for 30 seconds for reads and refreshed before broadcasting. Preview mode does not require a private key. For actual transfers, enter the dedicated distribution wallet's `PRIVATE_KEY` locally. Do not save the file as `.env.txt`, and do not upload or share your private key.

The wallet must hold the token you want to distribute and native BNB. **BNB pays the transaction fees.**

## 3. Collect and Preview Addresses (No Transfers)

```powershell
npm.cmd run preview
```

Progress is displayed every five seconds. When collection finishes, the terminal lists candidate addresses, source blocks, and source transactions. The list stays in memory for the current run and is not saved to JSON. Addresses are unique within a list; separate previews may include the same addresses.

## 4. Send Tokens

After entering the private key and funding the wallet with tokens and BNB, run:

```powershell
npm.cmd run send -- --execute
```

The script collects addresses again rather than using the previous preview list as a fixed recipient list. For each batch, it validates and saves the signed transactions, broadcasts up to five transactions with consecutive nonces, and waits for the batch to be confirmed before processing the next batch. Transaction hashes appear in the terminal so you can check actual fees and results on BscScan. On exit, a summary shows the current run's transaction counts by status, recipients skipped before sending, and actual BNB fees from confirmed receipts. Completed records without actual fee data are counted in `unknownFees`, not assumed to have zero fees.

Token balances are checked during collection and again when preparing transfers. Addresses with a nonzero balance are skipped. Failed balance queries are not treated as zero balances. Contract addresses, explicitly excluded addresses, recipients of unfinished transactions, and addresses already processed in the current run are also skipped. There is no permanent recipient history. If an address later transfers away its entire token balance, a future run may send to it again.

Collected addresses do not necessarily represent unique users or indicate consent to receive tokens. Token-specific fees, blacklists, transfer rate limits, and other rules may affect the amount received or cause transactions to revert.

### View Status Only

```powershell
npm.cmd run status
```

Checks unfinished transactions on the configured chain. No private key is required. It does not sign, broadcast, or modify `state.json`. Existing records can be checked even if `tokenAddress` is still a placeholder. A transaction that cannot be found is reported as `unknown`; this does not prove it was never broadcast.

### Recover Existing Transactions Only

```powershell
npm.cmd run recover -- --execute
```

Checks or rebroadcasts the original signed transactions already saved for the configured token. It does not collect new addresses or create new payments. Recovery does not require a private key because signatures are already stored, but it may broadcast transactions and incur fees. It uses the original recorded amount and sender, subject to the current run's count and fee budget.

`send -- --execute` still recovers existing transactions before collecting and sending to new addresses. Use `recover` when you only want to resolve an interrupted run.

## 5. Temporary Records and Recovery

The sequence is: **check balance → sign and save → broadcast → wait for confirmation → remove completed records**. Saving before broadcasting prevents duplicate payments if the node response is lost or the process stops.

| File | Purpose |
| --- | --- |
| `data/state.json` | Signatures, hashes, and statuses of unfinished transactions for recovery |
| `data/run.lock` | Process lock created during a run and removed on normal exit |

| Status | Meaning |
| --- | --- |
| `prepared` | Signed and saved; no broadcast attempt yet |
| `broadcasting` | Broadcast attempted; outcome still needs verification |
| `submitted` | Transaction accepted or found; required confirmations not yet reached |
| `confirmed` | Required confirmations reached and execution succeeded; removed from the journal and included in the terminal summary |
| `reverted` | Required confirmations reached but execution reverted; removed from the journal, reported as an error, and included in the terminal summary |

Timeouts, interruptions, and uncertain broadcast outcomes leave records in place. Use `send` or `recover` to reconcile the original transaction; the script does not sign a replacement payment. Read-only `status` does not remove records.

**Do not delete, empty, or roll back `state.json` while transactions remain unfinished.** Once all transactions are resolved, only a small empty state remains. The file does not grow with the total number of completed transfers. There are no automatic backups or permanent recipient lists. `confirmed` indicates successful on-chain execution, not a guarantee of the amount received for nonstandard tokens.

## macOS / Linux Commands

From the project folder, use `npm ci` to install dependencies, `npm run preview` to preview addresses, `npm run send -- --execute` to send tokens, `npm run status` to check status only, and `npm run recover -- --execute` to recover existing transactions only.

## License and Private Key Security

**Keep your private keys and seed phrases secure. Do not send them to other people or third-party services, and do not include them in repositories, logs, or screenshots.** The `.env` file stores local configuration in plain text. Restrict access and store it securely. Use a dedicated distribution wallet containing only the assets and transaction fees you need.
