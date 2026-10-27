import { formatEther } from 'ethers';
import { unfinished } from './storage.js';

export class StopRequested extends Error {
  constructor() { super('已停止新增广播，未完成交易已保留；可用 status 查询或 recover 恢复'); }
}
export const checkStop = stopped => { if (stopped()) throw new StopRequested(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function inspectTransaction(entry, provider, config) {
  const receipt = await provider.getTransactionReceipt(entry.hash);
  if (receipt) {
    const height = await provider.getBlockNumber();
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (!canonical || canonical.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) return { status: 'unknown', confirmations: 0 };
    const confirmations = Math.max(0, height - receipt.blockNumber + 1);
    const final = confirmations >= config.confirmations;
    return { status: final ? (receipt.status === 1 ? 'confirmed' : 'reverted') : 'submitted', confirmations, receipt };
  }
  const tx = await provider.getTransaction(entry.hash);
  return { status: tx ? 'submitted' : 'unknown', confirmations: 0 };
}

function applyObservation(entry, observation, save) {
  if (observation.status === 'unknown') return;
  if (['confirmed', 'reverted'].includes(observation.status)) {
    const receipt = observation.receipt;
    entry.status = observation.status;
    entry.blockNumber = receipt.blockNumber;
    entry.blockHash = receipt.blockHash;
    if (receipt.gasUsed != null && receipt.gasPrice != null) {
      entry.gasUsed = receipt.gasUsed.toString();
      entry.effectiveGasPriceWei = receipt.gasPrice.toString();
      entry.actualGasWei = (receipt.gasUsed * receipt.gasPrice).toString();
    }
    delete entry.raw;
    save();
  } else if (entry.status !== 'submitted') {
    entry.status = 'submitted'; save();
  }
}

export async function ensureBroadcast(entry, provider, config, save, { stopped = () => false, wait = sleep } = {}) {
  checkStop(stopped);
  const observed = await inspectTransaction(entry, provider, config);
  applyObservation(entry, observed, save);
  if (observed.status !== 'unknown') return;
  if (await provider.getTransactionCount(entry.sender, 'latest') > entry.nonce) {
    // Recheck in case the transaction was just mined.
    const raced = await inspectTransaction(entry, provider, config);
    applyObservation(entry, raced, save);
    if (raced.status !== 'unknown') return;
    throw new Error(`nonce 已被使用但未找到原交易，请人工核对 ${entry.hash}`);
  }
  checkStop(stopped);
  entry.status = 'broadcasting';
  save(); // Persist before broadcasting to prevent duplicate payments.
  try {
    const tx = await provider.broadcastTransaction(entry.raw);
    if (tx.hash?.toLowerCase() !== entry.hash.toLowerCase()) throw new Error('广播返回哈希不匹配');
  } catch {
    // Reconcile by hash before retrying the original transaction.
    for (let attempt = 0; attempt < 3; attempt++) {
      let recovered;
      try { recovered = await inspectTransaction(entry, provider, config); }
      catch { /* Keep broadcasting status if lookup fails. */ }
      if (recovered) {
        applyObservation(entry, recovered, save);
        if (recovered.status !== 'unknown') return;
      }
      if (stopped()) break;
      await wait(250 * (attempt + 1));
    }
    throw new Error(`广播结果不明，已保留原签名交易；请用 status 核对或 recover 恢复：${entry.hash}`);
  }
  entry.status = 'submitted';
  save();
}

export async function settle(entry, provider, config, save, { stopped = () => false, wait = sleep, now = Date.now } = {}) {
  const deadline = now() + config.confirmationTimeoutMs;
  while (unfinished(entry)) {
    checkStop(stopped);
    const observation = await inspectTransaction(entry, provider, config);
    applyObservation(entry, observation, save);
    if (!unfinished(entry)) break;
    if (now() >= deadline) throw new Error(`等待确认超时，保留待核对记录：${entry.hash}`);
    await wait(config.confirmationPollMs);
  }
  if (entry.status === 'reverted') throw new Error(`交易回滚，已停止：${entry.hash}`);
}

export async function broadcastBatch(entries, provider, config, save, { stopped = () => false, log = console.log, wait = sleep } = {}) {
  for (const entry of entries) {
    checkStop(stopped);
    await ensureBroadcast(entry, provider, config, save, { stopped, wait });
    log(`交易状态 ${entry.status}：${entry.address}，${entry.hash}`);
    if (entry.status === 'reverted') throw new Error(`交易回滚，已停止：${entry.hash}`);
  }
  log(`本批 ${entries.length} 笔已广播，等待 ${config.confirmations} 次确认`);
  const results = await Promise.allSettled(entries.map(entry => settle(entry, provider, config, save, { stopped, wait })));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  log(`本批 ${entries.length} 笔均已确认`);
}

export function summarize(entries) {
  const counts = { prepared: 0, broadcasting: 0, submitted: 0, confirmed: 0, reverted: 0 };
  let actual = 0n; let unknownFees = 0;
  for (const entry of entries) {
    counts[entry.status]++;
    if (entry.actualGasWei !== undefined) actual += BigInt(entry.actualGasWei);
    else if (['confirmed', 'reverted'].includes(entry.status)) unknownFees++;
  }
  return { ...counts, total: entries.length, actualGasBnb: formatEther(actual), unknownFees };
}
