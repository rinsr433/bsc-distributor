import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, Wallet, keccak256, parseUnits } from 'ethers';
import { broadcastBatch, collect, dayKey, quota, settle, validateConfig } from './core.js';
import { RotatingRpcProvider, rpcUrls } from './rpc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const lockFile = path.join(dataDir, 'run.lock');
const ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

function atomicWrite(file, value) {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // Windows 不支持以这种方式打开目录并 fsync；文件本身已在 rename 前同步。
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

async function main() {
  const [command = 'preview', ...flags] = process.argv.slice(2);
  if (!['preview', 'send'].includes(command) || flags.some(f => f !== '--execute')) throw new Error('用法：npm run preview 或 npm run send -- --execute');
  if (command === 'send' && !flags.includes('--execute')) throw new Error('真实发送需要显式添加 --execute');
  const config = validateConfig(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')));
  const provider = new RotatingRpcProvider(rpcUrls(config.chainId), config.chainId);
  let locked = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = fs.openSync(lockFile, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('已有运行锁。确认旧进程已退出后再删除 data/run.lock'); throw e; }
    locked = true;
    fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock);
    if (Number((await provider.getNetwork()).chainId) !== config.chainId) throw new Error('RPC 链 ID 与配置不一致');
    if (await provider.getCode(config.tokenAddress) === '0x') throw new Error('该地址不是代币合约');
    const token = new Contract(config.tokenAddress, ABI, provider);
    const amount = parseUnits(config.amountPerAddress, Number(await token.decimals()));
    if (amount <= 0n) throw new Error('发送金额必须大于零');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, campaigns: {} };
    if (state.version !== 1 || !state.campaigns) throw new Error('状态文件格式异常');
    const campaignKey = `${config.chainId}:${config.tokenAddress.toLowerCase()}`;
    const campaign = state.campaigns[campaignKey] ??= { entries: [] };
    const save = () => atomicWrite(stateFile, state);
    const runId = randomUUID();
    const runEntries = [];
    let wallet;
    if (command === 'send') {
      if (!process.env.PRIVATE_KEY) throw new Error('真实发送需要本机配置 PRIVATE_KEY');
      wallet = new Wallet(process.env.PRIVATE_KEY, provider);
      // 任一合约有未完成交易，先恢复，避免跨合约重用 nonce。
      for (const [key, previous] of Object.entries(state.campaigns)) {
        for (const entry of previous.entries.filter(e => e.status === 'pending')) {
          if (key !== campaignKey || entry.sender !== wallet.address) throw new Error('其他合约或钱包有待核对交易，请用原配置恢复');
          const recoveryLimits = quota(runEntries, config);
          if (recoveryLimits.remaining < 1 || BigInt(entry.reservedGasWei) > recoveryLimits.gasRemaining) {
            throw new Error('恢复旧交易将超过本次数量或 Gas 预算，请调整配置后重试');
          }
          runEntries.push(entry);
          console.log(`恢复待确认交易（占本次配额）：${entry.hash}`);
          await settle(entry, provider, config, save);
        }
      }
    }
    const day = dayKey(config.timezone);
    const allowance = quota(runEntries, config);
    if (allowance.remaining === 0) { console.log('本次配额已用完（包含恢复的旧交易）。'); return; }
    console.log(`采集地址，本次剩余配额 ${allowance.remaining}；${command === 'preview' ? '仅预览，不发送' : '真实发送模式'}`);
    const started = Date.now();
    let progress = '正在获取区块高度';
    const progressTimer = setInterval(() => {
      console.log(`${progress}；已用时 ${Math.floor((Date.now() - started) / 1000)} 秒，正在等待或查询公共节点`);
    }, 5000);
    let result;
    try {
      result = await collect({ provider, token, config, entries: campaign.entries, count: allowance.remaining, sender: wallet?.address,
        onProgress: (height, n) => { progress = `正在扫描区块 ${height}，已找到 ${n}/${allowance.remaining} 个候选地址`; } });
    } finally {
      clearInterval(progressTimer);
    }
    atomicWrite(path.join(dataDir, 'preview.json'), { day, runId, chainId: config.chainId, tokenAddress: config.tokenAddress, amountPerAddress: config.amountPerAddress, ...result });
    console.log(`找到 ${result.selected.length} 个候选地址，清单已写入 data/preview.json`);
    if (command === 'preview') return;
    for (let offset = 0; offset < result.selected.length; offset += config.batchSize) {
      const batch = [];
      const latestNonce = await provider.getTransactionCount(wallet.address, 'latest');
      const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
      if (latestNonce !== pendingNonce) throw new Error('分发钱包存在外部待处理交易，停止发送');
      const tokenBalance = await token.balanceOf(wallet.address);
      const bnbBalance = await provider.getBalance(wallet.address);
      let batchGas = 0n;
      const connected = token.connect(wallet);
      for (const row of result.selected.slice(offset, offset + config.batchSize)) {
        if (await provider.getCode(row.address) !== '0x' || await token.balanceOf(row.address) !== 0n) continue;
        if (tokenBalance < amount * BigInt(batch.length + 1)) throw new Error('分发钱包代币不足以支付整批，停止发送');
        const gasPrice = (await provider.getFeeData()).gasPrice;
        if (gasPrice == null || gasPrice > parseUnits(config.maxGasPriceGwei, 9)) throw new Error('Gas 价格超过配置上限或不可用');
        if (await connected.transfer.staticCall(row.address, amount) !== true) throw new Error('代币 transfer 模拟未返回 true，停止发送');
        const gasLimit = (await connected.transfer.estimateGas(row.address, amount)) * 120n / 100n;
        const reservedGas = gasLimit * gasPrice;
        const limits = quota([...runEntries, ...batch], config);
        if (limits.remaining < 1 || reservedGas > limits.gasRemaining) throw new Error('达到本次数量或 Gas 预算上限');
        if (bnbBalance < batchGas + reservedGas) throw new Error('分发钱包 BNB 不足以支付整批，停止发送');
        const nonce = latestNonce + batch.length;
        const tx = { to: config.tokenAddress, data: token.interface.encodeFunctionData('transfer', [row.address, amount]), value: 0n,
          chainId: config.chainId, nonce, type: 0, gasPrice, gasLimit };
        const raw = await wallet.signTransaction(tx);
        batch.push({ ...row, day: dayKey(config.timezone), runId, amount: amount.toString(), sender: wallet.address, nonce,
          hash: keccak256(raw), raw, reservedGasWei: reservedGas.toString(), status: 'pending' });
        batchGas += reservedGas;
      }
      if (!batch.length) continue;
      // 整批签名交易先落盘，再按连续 nonce 广播；不会等每笔确认才发下一笔。
      campaign.entries.push(...batch);
      runEntries.push(...batch);
      save();
      await broadcastBatch(batch, provider, config, save);
    }
  } finally {
    provider.destroy();
    if (locked) fs.unlinkSync(lockFile);
  }
}

main().catch(error => {
  // 不输出 RPC 错误原文，其中可能包含带凭据的 URL、请求体或私钥参数。
  const safe = !error.code && !error.argument;
  console.error(safe ? error.message : `运行失败（${error.code ?? 'INVALID_INPUT'}）。请检查配置、RPC、余额及 data/state.json；敏感请求详情未输出。`);
  process.exitCode = 1;
});
