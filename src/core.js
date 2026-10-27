import { getAddress, isAddress, parseUnits, ZeroAddress } from 'ethers';

export function validateConfig(c) {
  c = { batchSize: 5, ...c };
  if (!Number.isSafeInteger(c.batchSize) || c.batchSize < 1 || c.batchSize > 5) throw new Error('batchSize 必须为 1 至 5 的整数');
  if (![56, 97].includes(c.chainId)) throw new Error('chainId 仅支持 BSC 56 / 测试网 97');
  if (!isAddress(c.tokenAddress) || c.tokenAddress === ZeroAddress) throw new Error('请配置有效 tokenAddress');
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
  return { ...c, tokenAddress: getAddress(c.tokenAddress) };
}

export function dayKey(timezone, now = new Date()) {
  const p = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = k => p.find(x => x.type === k).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const addressKey = a => a.toLowerCase();
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// 只传入本次运行的新交易和本次恢复的旧交易，历史记录仍用于地址去重。
export function quota(runEntries, config) {
  return {
    remaining: Math.max(0, config.countPerRun - runEntries.length),
    gasRemaining: parseUnits(config.maxGasPerRunBnb, 18) - runEntries.reduce((n, e) => n + BigInt(e.reservedGasWei), 0n)
  };
}

export async function collect({ provider, token, config, entries, count, sender, onProgress = () => {}, wait = pause }) {
  const seen = new Set([ZeroAddress, '0x000000000000000000000000000000000000dead', config.tokenAddress, ...config.excludeAddresses,
    ...entries.map(e => e.address), ...(sender ? [sender] : [])].map(addressKey));
  const selected = [];
  const end = await provider.getBlockNumber() - config.confirmations;
  const start = Math.max(0, end - config.lookbackBlocks + 1);
  for (let height = end; height >= start && selected.length < count; height--) {
    onProgress(height, selected.length);
    const block = await provider.send('eth_getBlockByNumber', ['0x' + height.toString(16), true]);
    if (!block || !Array.isArray(block.transactions)) throw new Error('RPC 未返回完整区块');
    for (const tx of block.transactions) {
      if (selected.length >= count) break;
      onProgress(height, selected.length);
      if (!isAddress(tx.from)) continue;
      const address = getAddress(tx.from);
      if (seen.has(addressKey(address))) continue;
      seen.add(addressKey(address));
      await wait(config.rpcDelayMs);
      if (await provider.getCode(address) !== '0x') continue;
      await wait(config.rpcDelayMs);
      if (await token.balanceOf(address) !== 0n) continue;
      selected.push({ address, sourceBlock: height, sourceTx: tx.hash });
      onProgress(height, selected.length);
    }
    onProgress(height, selected.length);
    await wait(config.rpcDelayMs);
  }
  return { selected, startBlock: start, endBlock: end };
}

// 广播前先写入已签名交易。恢复时只重播同一笔交易，不生成新 nonce。
export async function settle(entry, provider, config, save) {
  let receipt = await provider.getTransactionReceipt(entry.hash);
  if (!receipt) {
    const tx = await provider.getTransaction(entry.hash);
    if (!tx) {
      if (await provider.getTransactionCount(entry.sender, 'latest') > entry.nonce) {
        throw new Error(`nonce 已被其他交易使用，请人工核对 ${entry.hash}`);
      }
      await provider.broadcastTransaction(entry.raw);
    }
  }
  receipt = await provider.waitForTransaction(entry.hash, config.confirmations, 120000);
  if (!receipt) throw new Error(`等待确认超时，保留待核对记录：${entry.hash}`);
  entry.status = receipt.status === 1 ? 'confirmed' : 'reverted';
  entry.blockNumber = receipt.blockNumber;
  // 保留最初预留的费用用于保守限额，不在失败后释放配额。
  delete entry.raw;
  save();
  if (entry.status === 'reverted') throw new Error(`交易回滚，已停止：${entry.hash}`);
}

// 广播顺序固定；任何广播异常都停止，持久化的整批交易留待恢复。
export async function broadcastBatch(entries, provider, config, save, log = console.log) {
  for (const entry of entries) {
    await provider.broadcastTransaction(entry.raw);
    log(`已广播 ${entry.address}，交易 ${entry.hash}`);
  }
  log(`本批 ${entries.length} 笔已广播，等待 ${config.confirmations} 次确认`);
  // 等所有确认任务结束后再释放进程锁，避免失败后仍有后台任务写状态。
  const results = await Promise.allSettled(entries.map(entry => settle(entry, provider, config, save)));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  log(`本批 ${entries.length} 笔交易均已确认`);
}
