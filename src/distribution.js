import { keccak256, parseUnits } from 'ethers';
import { dayKey, quota } from './core.js';
import { broadcastBatch, checkStop } from './transactions.js';

export async function prepareBatch({ rows, config, provider, token, wallet, amount, runEntries, runId, stopped = () => false }) {
  checkStop(stopped);
  const latestNonce = await provider.getTransactionCount(wallet.address, 'latest');
  const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
  if (latestNonce !== pendingNonce) throw new Error('分发钱包存在未处理的外部交易，请先核对');
  const tokenBalance = await token.balanceOf(wallet.address);
  const bnbBalance = await provider.getBalance(wallet.address);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null || gasPrice > parseUnits(config.maxGasPriceGwei, 9)) throw new Error('Gas 价格超过配置上限或不可用');
  const connected = token.connect(wallet);
  const batch = []; let batchGas = 0n; let consumed = 0; let skipped = 0; let stopReason;
  for (const row of rows) {
    checkStop(stopped);
    if (batch.length >= config.batchSize) break;
    consumed++;
    if (await provider.getCode(row.address) !== '0x' || await token.balanceOf(row.address) !== 0n) { skipped++; continue; }
    const limits = quota([...runEntries, ...batch], config);
    if (limits.remaining < 1) { stopReason = '本次数量已达到上限'; break; }
    if (tokenBalance < amount * BigInt(batch.length + 1)) { stopReason = '代币余额不足'; break; }
    if (await connected.transfer.staticCall(row.address, amount) !== true) throw new Error('代币 transfer 模拟未返回 true');
    const gasLimit = (await connected.transfer.estimateGas(row.address, amount)) * 120n / 100n;
    const reservedGas = gasLimit * gasPrice;
    if (reservedGas > limits.gasRemaining) { stopReason = '剩余手续费预算不足'; break; }
    if (bnbBalance < batchGas + reservedGas) { stopReason = 'BNB 余额不足'; break; }
    checkStop(stopped);
    const nonce = latestNonce + batch.length;
    const raw = await wallet.signTransaction({ to: config.tokenAddress, data: token.interface.encodeFunctionData('transfer', [row.address, amount]),
      value: 0n, chainId: config.chainId, nonce, type: 0, gasPrice, gasLimit });
    batch.push({ ...row, day: dayKey(config.timezone), runId, amount: amount.toString(), sender: wallet.address, nonce,
      hash: keccak256(raw), raw, reservedGasWei: reservedGas.toString(), status: 'prepared' });
    batchGas += reservedGas;
  }
  return { batch, consumed, skipped, stopReason };
}

export async function distribute({ rows, config, provider, token, wallet, amount, runEntries, runId, campaign, save,
  stopped = () => false, log = console.log, stats = { skippedBeforeSend: 0 } }) {
  let offset = 0;
  while (offset < rows.length) {
    checkStop(stopped);
    const result = await prepareBatch({ rows: rows.slice(offset), config, provider, token, wallet, amount, runEntries, runId, stopped });
    offset += result.consumed;
    stats.skippedBeforeSend += result.skipped;
    if (result.batch.length) {
      checkStop(stopped);
      campaign.entries.push(...result.batch);
      runEntries.push(...result.batch);
      save();
      await broadcastBatch(result.batch, provider, config, save, { stopped, log });
    }
    if (result.stopReason) { log(`本次停止：${result.stopReason}；可发送的小批次已处理`); break; }
    if (!result.consumed) break;
  }
}
