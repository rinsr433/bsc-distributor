import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Interface, Transaction, isAddress } from 'ethers';

const transfer = new Interface(['function transfer(address,uint256) returns (bool)']);
export const unfinished = entry => ['prepared', 'broadcasting', 'submitted'].includes(entry.status);
const statuses = new Set(['prepared', 'broadcasting', 'submitted', 'confirmed', 'reverted']);
const uint = value => typeof value === 'string' && /^\d+$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const checksum = state => {
  const { checksum: ignored, ...body } = state;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
};

export function validateState(state, checkChecksum = true) {
  const fail = () => { throw new Error('状态文件校验失败，请保留原文件并核对，禁止清空未完成记录后继续发送'); };
  if (!state || state.version !== 1 || !state.campaigns || Array.isArray(state.campaigns) || typeof state.campaigns !== 'object') fail();
  if (checkChecksum && state.checksum !== undefined && state.checksum !== checksum(state)) fail();
  const usedNonces = new Set();
  for (const [key, campaign] of Object.entries(state.campaigns)) {
    const [chain, token, extra] = key.split(':');
    if (extra || !['56', '97'].includes(chain) || !isAddress(token) || !campaign || !Array.isArray(campaign.entries)) fail();
    const addresses = new Set();
    for (const entry of campaign.entries) {
      if (!entry || !isAddress(entry.address) || !isAddress(entry.sender) || !hash(entry.hash) ||
        !Number.isSafeInteger(entry.nonce) || entry.nonce < 0 || !statuses.has(entry.status) ||
        !uint(entry.amount) || BigInt(entry.amount) <= 0n || !uint(entry.reservedGasWei) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.day ?? '')) fail();
      if (entry.actualGasWei !== undefined && !uint(entry.actualGasWei)) fail();
      if (entry.blockNumber !== undefined && (!Number.isSafeInteger(entry.blockNumber) || entry.blockNumber < 0)) fail();
      const nonceKey = `${chain}:${entry.sender.toLowerCase()}:${entry.nonce}`;
      if (addresses.has(entry.address.toLowerCase()) || usedNonces.has(nonceKey)) fail();
      addresses.add(entry.address.toLowerCase()); usedNonces.add(nonceKey);
      if (unfinished(entry) || entry.raw !== undefined) {
        try {
          const tx = Transaction.from(entry.raw);
          const [recipient, amount] = transfer.decodeFunctionData('transfer', tx.data);
          if (!tx.isSigned() || tx.chainId !== BigInt(chain) || tx.nonce !== entry.nonce ||
            !same(tx.hash, entry.hash) || !same(tx.from, entry.sender) || !same(tx.to, token) ||
            !same(recipient, entry.address) || amount !== BigInt(entry.amount) || tx.value !== 0n ||
            tx.gasPrice == null || tx.gasPrice * tx.gasLimit !== BigInt(entry.reservedGasWei)) fail();
        } catch { fail(); }
      }
    }
  }
  return state;
}

export function readState(file) {
  if (!fs.existsSync(file)) {
    if (fs.existsSync(`${file}.tmp`)) {
      throw new Error('状态主文件缺失但存在临时文件，请先核对恢复；不会自动创建空记录');
    }
    return { version: 1, campaigns: {} };
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('状态文件无法读取，请保留原文件，核对后再恢复'); }
  return validateState(state);
}

export function atomicWrite(file, value) {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

// Keep completed entries in memory for the run summary.
export function pruneCompleted(state) {
  let removed = 0;
  for (const campaign of Object.values(state.campaigns)) {
    const active = campaign.entries.filter(unfinished);
    removed += campaign.entries.length - active.length;
    campaign.entries = active;
  }
  return removed;
}

export function saveState(file, state) {
  validateState(state, false);
  // Validate the existing journal before overwriting it.
  readState(file);
  const removed = pruneCompleted(state);
  const snapshot = { ...state, retention: 'unfinished-only', campaigns: Object.fromEntries(
    Object.entries(state.campaigns).filter(([, campaign]) => campaign.entries.length > 0)
  ) };
  snapshot.checksum = checksum(snapshot);
  atomicWrite(file, snapshot);
  return removed;
}
