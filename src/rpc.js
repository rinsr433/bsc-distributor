import { JsonRpcProvider } from 'ethers';

export const PUBLIC_RPC_URLS = {
  56: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org', 'https://bsc-rpc.publicnode.com']
};

export function rpcUrls(chainId, env = process.env) {
  const custom = env.BSC_RPC_URLS?.trim() || env.BSC_RPC_URL?.trim();
  const urls = custom ? custom.split(',').map(s => s.trim()).filter(Boolean) : PUBLIC_RPC_URLS[chainId];
  if (!urls?.length) throw new Error('该网络没有内置 RPC，请配置 BSC_RPC_URLS');
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('RPC URL 格式不正确'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 仅支持 HTTP/HTTPS');
  }
  return [...new Set(urls)];
}

// 在传输层切换节点，重试始终使用原始 payload（含相同的签名交易）。
export class RotatingRpcProvider extends JsonRpcProvider {
  constructor(urls, chainId, { fetchFn = fetch, timeoutMs = 10000, log = console.log } = {}) {
    super(urls[0], chainId, { batchMaxCount: 1, cacheTimeout: -1 });
    this.urls = urls;
    this.expectedChainId = chainId;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.activeIndex = 0;
  }

  async request(url, payload) {
    const response = await this.fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error('RPC HTTP failure');
    const body = await response.json();
    const rows = Array.isArray(body) ? body : [body];
    const requests = Array.isArray(payload) ? payload : [payload];
    if (rows.length !== requests.length || requests.some(p => !rows.some(r => r.id === p.id && r.jsonrpc === '2.0' && ('result' in r || 'error' in r)))) {
      throw new Error('RPC malformed response');
    }
    return rows;
  }

  async _send(payload) {
    const start = this.activeIndex;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const index = (start + attempt) % this.urls.length;
      try {
        // 每次请求先验证实际链 ID，不只验证列表中第一个节点。
        const [chain] = await this.request(this.urls[index], { jsonrpc: '2.0', id: 'chain-check', method: 'eth_chainId', params: [] });
        if (chain.error || BigInt(chain.result) !== BigInt(this.expectedChainId)) throw new Error('RPC wrong chain');
        const result = await this.request(this.urls[index], payload);
        if (result.some(r => r.error && ([-32005, -32002, -32603, -32601].includes(r.error.code) || /rate limit|too many requests|temporarily unavailable|timeout/i.test(r.error.message ?? '')))) {
          throw new Error('RPC unavailable');
        }
        // 合约回滚、余额不足、nonce 错误等交给上层处理，不因换节点绕过。
        if (index !== this.activeIndex) this.log(`RPC 已切换至备用节点 #${index + 1}`);
        this.activeIndex = index;
        return result;
      } catch {
        this.log(`RPC 节点 #${index + 1} 不可用或链不匹配，${attempt + 1 < this.urls.length ? '尝试下一个节点' : '本轮节点已用尽'}`);
      }
    }
    throw new Error('全部 RPC 节点不可用，请稍后重试或更换 BSC_RPC_URLS；交易状态已保留');
  }
}
