import { JsonRpcProvider } from 'ethers';

export const PUBLIC_RPC_URLS = {
  56: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org', 'https://bsc-rpc.publicnode.com']
};

export function rpcUrls(chainId, env = process.env) {
  const custom = env.BSC_RPC_URLS?.trim();
  const urls = custom ? custom.split(',').map(s => s.trim()).filter(Boolean) : PUBLIC_RPC_URLS[chainId];
  if (!urls?.length) throw new Error('该网络没有内置 RPC，请配置 BSC_RPC_URLS');
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('RPC URL 格式不正确'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 仅支持 HTTP/HTTPS');
  }
  return [...new Set(urls)];
}

// Retry the same payload across RPC endpoints.
export class RotatingRpcProvider extends JsonRpcProvider {
  constructor(urls, chainId, { fetchFn = fetch, timeoutMs = 10000, log = console.log, chainTtlMs = 30000, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    super(urls[0], chainId, { batchMaxCount: 1, cacheTimeout: -1 });
    this.urls = urls;
    this.expectedChainId = chainId;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.activeIndex = 0;
    this.chainTtlMs = chainTtlMs;
    this.now = now;
    this.wait = wait;
    this.nodes = urls.map(() => ({ verifiedAt: -Infinity, probe: null, failures: 0, retryAt: 0 }));
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
    if (rows.length !== requests.length || requests.some(p => !rows.some(r => r && r.id === p.id && r.jsonrpc === '2.0' && ('result' in r || 'error' in r)))) {
      throw new Error('RPC malformed response');
    }
    return rows;
  }

  async verifyChain(index, force) {
    const node = this.nodes[index];
    if (!force && this.now() - node.verifiedAt < this.chainTtlMs) return;
    if (node.probe) return node.probe;
    node.probe = (async () => {
      const [chain] = await this.request(this.urls[index], { jsonrpc: '2.0', id: 'chain-check', method: 'eth_chainId', params: [] });
      if (chain.error || BigInt(chain.result) !== BigInt(this.expectedChainId)) throw new Error('RPC wrong chain');
      node.verifiedAt = this.now();
    })();
    try { await node.probe; } finally { node.probe = null; }
  }

  async _send(payload) {
    const start = this.activeIndex;
    const requests = Array.isArray(payload) ? payload : [payload];
    const broadcasting = requests.some(p => p.method === 'eth_sendRawTransaction');
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const index = (start + attempt) % this.urls.length;
      const node = this.nodes[index];
      try {
        const delay = node.retryAt - this.now();
        if (delay > 0) await this.wait(Math.min(delay, 2000));
        // Refresh chain validation before every broadcast.
        await this.verifyChain(index, broadcasting);
        const result = await this.request(this.urls[index], payload);
        for (const request of requests) {
          if (request.method === 'eth_chainId') {
            const response = result.find(r => r.id === request.id);
            if (response.error || BigInt(response.result) !== BigInt(this.expectedChainId)) throw new Error('RPC wrong chain');
          }
        }
        if (result.some(r => {
          if (!r.error) return false;
          const message = r.error.message ?? '';
          if (/revert|insufficient funds|nonce|already known/i.test(message)) return false;
          return [-32005, -32002, -32603, -32601].includes(r.error.code) || /rate limit|too many requests|temporarily unavailable|timeout/i.test(message);
        })) throw new Error('RPC unavailable');
        if (index !== this.activeIndex) this.log(`RPC 已切换至备用节点 #${index + 1}`);
        this.activeIndex = index;
        node.failures = 0; node.retryAt = 0;
        return result;
      } catch {
        node.verifiedAt = -Infinity;
        node.failures++;
        node.retryAt = this.now() + Math.min(250 * 2 ** Math.min(node.failures - 1, 3), 2000);
        this.log(`RPC 节点 #${index + 1} 不可用或链不匹配，${attempt + 1 < this.urls.length ? '尝试下一个节点' : '本轮节点已用尽'}`);
      }
    }
    throw new Error('全部 RPC 节点不可用，请稍后重试或更换 BSC_RPC_URLS；交易状态已保留');
  }
}
