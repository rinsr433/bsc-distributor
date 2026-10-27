import { checkStop } from './transactions.js';
import { getAddress, isAddress, parseUnits, ZeroAddress } from 'ethers';

export function validateConfig(c, { requireToken = true } = {}) {
  c = { batchSize: 5, collectConcurrency: 3, confirmationTimeoutMs: 120000, confirmationPollMs: 2000, ...c };
  if (!Number.isSafeInteger(c.collectConcurrency) || c.collectConcurrency < 1 || c.collectConcurrency > 5) throw new Error('collectConcurrency 必须为 1 至 5 的整数');
  for (const key of ['confirmationTimeoutMs', 'confirmationPollMs']) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 100) throw new Error(`${key} 必须为不小于 100 的整数`);
  }
  if (!Number.isSafeInteger(c.batchSize) || c.batchSize < 1 || c.batchSize > 5) throw new Error('batchSize 必须为 1 至 5 的整数');
  if (![56, 97].includes(c.chainId)) throw new Error('chainId 仅支持 BSC 56 / 测试网 97');
  if (requireToken && (!isAddress(c.tokenAddress) || c.tokenAddress === ZeroAddress)) throw new Error('请配置有效 tokenAddress');
  for (const k of ['countPerRun', 'lookbackBlocks', 'confirmations']) {
    if (!Number.isSafeInteger(c[k]) || c[k] < 1) throw new Error(`${k} 必须为正整数`);
  }
  if (!Number.isSafeInteger(c.rpcDelayMs) || c.rpcDelayMs < 0) throw new Error('rpcDelayMs 无效');
  for (const k of ['amountPerAddress', 'maxGasPriceGwei', 'maxGasPerRunBnb']) {
    if (typeof c[k] !== 'string' || !/^\d+(\.\d+)?$/.test(c[k]) || Number(c[k]) <= 0) throw new Error(`${k} 必须为正数字符串`);
  }
  parseUnits(c.maxGasPriceGwei, 9);
  parseUnits(c.maxGasPerRunBnb, 18);
  new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format();
  if (!Array.isArray(c.excludeAddresses) || c.excludeAddresses.some(a => !isAddress(a))) throw new Error('excludeAddresses 无效');
  return { ...c, tokenAddress: requireToken ? getAddress(c.tokenAddress) : c.tokenAddress };
}

export function dayKey(timezone, now = new Date()) {
  const p = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = k => p.find(x => x.type === k).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const addressKey = a => a.toLowerCase();
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Count new and recovered transactions toward this run’s limits.
export function quota(runEntries, config) {
  return {
    remaining: Math.max(0, config.countPerRun - runEntries.length),
    gasRemaining: parseUnits(config.maxGasPerRunBnb, 18) - runEntries.reduce((n, e) => n + BigInt(e.reservedGasWei), 0n)
  };
}

export async function collect({ provider, token, config, entries, count, sender, onProgress = () => {}, wait = pause, stopped = () => false }) {
  const seen = new Set([ZeroAddress, '0x000000000000000000000000000000000000dead', config.tokenAddress, ...config.excludeAddresses,
    ...entries.map(e => e.address), ...(sender ? [sender] : [])].map(addressKey));
  const selected = [];
  const stats = { duplicateOrExcluded: 0, contract: 0, alreadyHolding: 0, checked: 0 };
  checkStop(stopped);
  const end = await provider.getBlockNumber() - config.confirmations;
  const start = Math.max(0, end - config.lookbackBlocks + 1);
  for (let height = end; height >= start && selected.length < count; height--) {
    checkStop(stopped);
    onProgress(height, selected.length);
    const block = await provider.send('eth_getBlockByNumber', ['0x' + height.toString(16), true]);
    if (!block || !Array.isArray(block.transactions)) throw new Error('RPC 未返回完整区块');
    const candidates = [];
    for (const tx of block.transactions) {
      if (!isAddress(tx.from)) continue;
      const address = getAddress(tx.from);
      if (seen.has(addressKey(address))) { stats.duplicateOrExcluded++; continue; }
      seen.add(addressKey(address));
      candidates.push({ address, sourceBlock: height, sourceTx: tx.hash });
    }
    for (let offset = 0; offset < candidates.length && selected.length < count; offset += config.collectConcurrency) {
      checkStop(stopped);
      const rows = candidates.slice(offset, offset + config.collectConcurrency);
      // Drain concurrent requests before reporting errors.
      const results = await Promise.allSettled(rows.map(async row => {
        checkStop(stopped);
        await wait(config.rpcDelayMs);
        checkStop(stopped);
        stats.checked++;
        if (await provider.getCode(row.address) !== '0x') { stats.contract++; return null; }
        await wait(config.rpcDelayMs);
        checkStop(stopped);
        if (await token.balanceOf(row.address) !== 0n) { stats.alreadyHolding++; return null; }
        return row;
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      for (const result of results) if (result.value && selected.length < count) selected.push(result.value);
      onProgress(height, selected.length);
    }
  }
  return { selected, stats, startBlock: start, endBlock: end };
}
