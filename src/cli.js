import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, Wallet, parseUnits } from 'ethers';
import { collect, quota, validateConfig } from './core.js';
import { RotatingRpcProvider, rpcUrls } from './rpc.js';
import { readState, saveState, unfinished } from './storage.js';
import { StopRequested, checkStop, ensureBroadcast, inspectTransaction, settle, summarize } from './transactions.js';
import { distribute } from './distribution.js';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

export async function run({ args = process.argv.slice(2), root = defaultRoot, env = process.env, log = console.log,
  providerFactory = (config) => new RotatingRpcProvider(rpcUrls(config.chainId, env), config.chainId), signalHost = process } = {}) {
  const [command = 'preview', ...flags] = args;
  const writes = ['send', 'recover'].includes(command);
  if (!['preview', 'send', 'status', 'recover'].includes(command) || flags.some(f => f !== '--execute') || (!writes && flags.length)) {
    throw new Error('用法：preview / status / send --execute / recover --execute');
  }
  if (writes && !flags.includes('--execute')) throw new Error('真实发送或恢复需要显式添加 --execute');
  const config = validateConfig(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), { requireToken: command !== 'status' });
  const dataDir = path.join(root, 'data');
  const stateFile = path.join(dataDir, 'state.json');
  const lockFile = path.join(dataDir, 'run.lock');
  let locked = false; let provider; let stopping = false;
  const runEntries = []; const stats = { skippedBeforeSend: 0 };
  const stopped = () => stopping;
  const requestStop = () => {
    if (!stopping) log('收到停止请求，将停止新增广播，等待当前请求结束并保留状态。已广播交易不会撤回。');
    stopping = true;
  };
  signalHost.on('SIGINT', requestStop); signalHost.on('SIGTERM', requestStop);
  try {
    if (command !== 'status') {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      let fd;
      try { fd = fs.openSync(lockFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('已有运行锁，确认原进程已退出后再删除 data/run.lock'); throw error; }
      locked = true;
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    }
    const state = readState(stateFile);
    const save = () => saveState(stateFile, state);
    provider = providerFactory(config);
    if (Number((await provider.getNetwork()).chainId) !== config.chainId) throw new Error('RPC 链 ID 与配置不一致');
    checkStop(stopped);
    if (command === 'status') {
      const displayed = [];
      for (const [key, campaign] of Object.entries(state.campaigns)) {
        if (!key.startsWith(`${config.chainId}:`)) continue;
        for (const entry of campaign.entries.filter(unfinished)) {
          checkStop(stopped);
          const copy = { ...entry };
          if (unfinished(entry)) {
            const observation = await inspectTransaction(entry, provider, config);
            log(`${entry.hash} 本地=${entry.status} 链上=${observation.status} 确认数=${observation.confirmations}`);
            if (observation.status !== 'unknown') copy.status = observation.status;
            if (['confirmed', 'reverted'].includes(observation.status) && observation.receipt.gasPrice != null) {
              copy.actualGasWei = (observation.receipt.gasUsed * observation.receipt.gasPrice).toString();
            }
          }
          displayed.push(copy);
        }
      }
      log(`只读状态（仅查询未完成记录，未写文件、未广播）：${JSON.stringify(summarize(displayed))}`);
      return;
    }
    const campaignKey = `${config.chainId}:${config.tokenAddress.toLowerCase()}`;
    const campaign = state.campaigns[campaignKey] ??= { entries: [] };
    const runId = randomUUID();
    let wallet;
    if (command === 'send') {
      if (!env.PRIVATE_KEY) throw new Error('真实发送需要本机配置 PRIVATE_KEY');
      wallet = new Wallet(env.PRIVATE_KEY, provider);
      for (const [key, previous] of Object.entries(state.campaigns)) {
        for (const entry of previous.entries.filter(unfinished)) {
          if (key.startsWith(`${config.chainId}:`) && (key !== campaignKey || entry.sender.toLowerCase() !== wallet.address.toLowerCase())) {
            throw new Error('同链其他合约或钱包存在未完成记录，请先用对应配置执行 recover');
          }
        }
      }
    }
    if (writes) {
      const pending = campaign.entries.filter(unfinished).sort((a, b) => a.sender.toLowerCase().localeCompare(b.sender.toLowerCase()) || a.nonce - b.nonce);
      for (const entry of pending) {
        checkStop(stopped);
        const limits = quota(runEntries, config);
        if (limits.remaining < 1 || BigInt(entry.reservedGasWei) > limits.gasRemaining) throw new Error('恢复交易将超过本次配额或预算，请调整配置；原记录已保留');
        runEntries.push(entry);
        log(`恢复原交易（占本次配额）：${entry.hash}`);
        await ensureBroadcast(entry, provider, config, save, { stopped });
        await settle(entry, provider, config, save, { stopped });
      }
      if (command === 'recover') { log('恢复完成，本命令不会采集地址或创建新交易。'); return; }
    }
    const allowance = quota(runEntries, config);
    if (allowance.remaining === 0) { log('本次配额已用完（包含恢复的交易）。'); return; }
    checkStop(stopped);
    if (await provider.getCode(config.tokenAddress) === '0x') throw new Error('该地址不是代币合约');
    const token = new Contract(config.tokenAddress, ABI, provider);
    const amount = parseUnits(config.amountPerAddress, Number(await token.decimals()));
    if (amount <= 0n) throw new Error('发送金额必须大于零');
    log(`采集地址，本次剩余配额 ${allowance.remaining}；${command === 'preview' ? '仅预览，不发送' : '真实发送模式'}`);
    const started = Date.now();
    let progress = '正在获取区块高度';
    const timer = setInterval(() => log(`${progress}；已用时 ${Math.floor((Date.now() - started) / 1000)} 秒`), 5000);
    let result;
    try {
      result = await collect({ provider, token, config, entries: [...campaign.entries.filter(unfinished), ...runEntries], count: allowance.remaining, sender: wallet?.address, stopped,
        onProgress: (height, n) => { progress = `扫描区块 ${height}，已找到 ${n}/${allowance.remaining} 个候选地址`; } });
    } finally { clearInterval(timer); }
    checkStop(stopped);
    log(`找到 ${result.selected.length} 个候选地址（仅保存在本次内存中）；采集统计：${JSON.stringify(result.stats)}`);
    if (command === 'preview') {
      log(`候选清单：${JSON.stringify(result.selected, null, 2)}`);
      return;
    }
    await distribute({ rows: result.selected, config, provider, token, wallet, amount, runEntries, runId, campaign, save, stopped, log, stats });
  } finally {
    signalHost.removeListener('SIGINT', requestStop); signalHost.removeListener('SIGTERM', requestStop);
    if (writes) log(`本次汇总：${JSON.stringify({ ...summarize(runEntries), ...stats })}；actualGasBnb 为已确认回执的实际费用，unknownFees 为本次完成记录中费用未知的笔数。`);
    try { provider?.destroy(); }
    finally { if (locked) fs.unlinkSync(lockFile); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    const safe = !error.code && !error.argument;
    console.error(safe ? error.message : `运行失败（${error.code ?? 'INVALID_INPUT'}）。请检查配置、RPC、余额及状态文件；敏感请求详情未输出。`);
    process.exitCode = error instanceof StopRequested ? 130 : 1;
  });
}
