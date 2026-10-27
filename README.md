# BSC 代币分发脚本

自动采集 BSC 近期交易发送地址，过滤重复地址和已有该代币余额的地址，再按配置分发代币。默认每次最多 50 个地址，每个发送 `0.0001` 个代币，每批广播最多 5 笔，再等待整批确认。

**只有执行发送命令才会转账。脚本运行结束后退出，目前没有管理页面，也没有设置每天自动运行。**

## 1. Windows 获取代码

安装 Git 和 Node.js 22 的最新维护版本或更新的 LTS 版本。私有仓库需要登录有访问权限的 GitHub 账号。

在 PowerShell 中执行（克隆到新文件夹，不覆盖旧目录）：

```powershell
git clone https://github.com/rinsr433/bsc-distributor.git bsc-distributor-new
cd bsc-distributor-new
npm.cmd ci
```

如果 GitHub 连接失败，并且代理软件的 HTTP／Mixed 端口为 `15236`，将上面的克隆命令换成：

```powershell
git -c http.proxy=http://127.0.0.1:15236 clone https://github.com/rinsr433/bsc-distributor.git bsc-distributor-new
```

端口变化时需替换实际端口。后续所有命令都在项目文件夹内执行。

### 已经在旧目录转过账

先停止旧脚本并备份旧目录，然后将旧目录的以下内容复制到新目录：

- `.env`：本机节点和分发钱包配置。
- `config.json`：本机代币及数量配置。
- **整个 `data` 文件夹，尤其是 `data/state.json`：历史发送和去重记录。**

不要用其他电脑的旧记录覆盖 Windows 上最新的发送历史。确认旧脚本已经退出后，如果复制过来的 `data` 中有残留 `run.lock`，再删除它。迁移后只运行新目录中的脚本。

### 首次使用、没有旧配置

仅在缺少文件时复制示例，保留已有配置：

```powershell
if (!(Test-Path config.json)) { Copy-Item config.example.json config.json }
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

## 2. 修改配置

用文本编辑器打开 `config.json`。主要字段如下，保存后下次启动生效：

| 字段 | 当前使用值 | 含义 |
| --- | --- | --- |
| `chainId` | `56` | BSC 主网 |
| `tokenAddress` | `REPLACE_WITH_TOKEN_CONTRACT` | 要发送的代币合约；首次使用需替换示例占位符 |
| `countPerRun` | `50` | 每次运行最多处理的地址数，可自行增加或减少 |
| `amountPerAddress` | `"0.0001"` | 每个地址发送的名义代币数量 |
| `batchSize` | `5` | 每批广播数量，支持 1～5；设为 1 则逐笔确认 |
| `maxGasPerRunBnb` | `"0.002"` | 本次所有交易的手续费预留总预算，单位 BNB |
| `maxGasPriceGwei` | `"1"` | 单位 Gas 价格上限，单位 Gwei |
| `confirmations` | `15` | 发送后等待的确认数，也用于采集时避开最新区块 |
| `lookbackBlocks` | `500` | 最多回看多少个区块 |
| `rpcDelayMs` | `150` | 采集查询之间的等待毫秒数 |
| `timezone` | `"Asia/Shanghai"` | 记录日期的时区，不影响按次配额 |
| `excludeAddresses` | `[]` | 自行指定要排除的地址 |

JSON 不允许注释或末尾多余逗号；金额保留双引号。旧版配置需要将 `dailyCount` 改为 `countPerRun`，将 `maxDailyGasBnb` 改为 `maxGasPerRunBnb`，并增加 `batchSize`。

**50 不是固定上限。** 每次重新启动都有独立配额；数量、候选地址、余额或预算不足时可能提前停止。恢复的旧待确认交易也计入本次数量和预算，例如恢复 1 笔后，本次最多再新发 49 笔。

`maxGasPerRunBnb` 是预算，不是固定扣款。脚本按每笔 `gasLimit × gasPrice` 累计预留，实际扣费取决于链上消耗；整批预算或余额不足时会停止。每个地址仍是一笔独立交易，分批广播不会直接降低手续费。

### 节点和私钥

`.env` 中 `BSC_RPC_URLS` 留空会使用内置主网公共节点。也可以填写逗号分隔的列表：

```dotenv
BSC_RPC_URLS=https://bsc-dataseed.bnbchain.org,https://bsc-dataseed-public.bnbchain.org,https://bsc-rpc.publicnode.com
PRIVATE_KEY=
```

节点超时或限流时会尝试备用节点。预览不需要私钥；真实发送时，在本机填写专用分发钱包的 `PRIVATE_KEY`。不要把文件保存为 `.env.txt`，不要上传或分享私钥。

钱包需要持有目标代币和原生 BNB。**BNB 用于支付手续费，不需要填写 BNB 合约地址；WBNB 不能替代原生 BNB 支付 Gas。**

## 3. 采集并预览（不转账）

```powershell
npm.cmd run preview
```

每 5 秒显示进度，完成后写入 `data/preview.json`。查看文件：

```powershell
Get-Content .\data\preview.json
```

`selected` 中包含地址、来源区块和来源交易。一份清单内不会重复；每次成功采集会覆盖旧预览文件。多次预览之间可能出现相同地址，因为预览不登记为已发送。

## 4. 实际发送

填写私钥、准备好代币和 BNB 后执行：

```powershell
npm.cmd run send -- --execute
```

脚本会重新采集地址，不固定使用上次预览清单。每批先检查并保存签名交易，按连续 nonce 广播最多 5 笔，再等待这批确认，最后处理下一批。终端显示交易哈希，可在 BscScan 查询实际手续费及结果。

采集和准备发送时都会查询该代币余额：余额非零就跳过，查询失败不会当作零余额放行。合约地址、配置排除地址和历史发送记录中的地址也会跳过。已记录的地址即使后来把币转走，仍然会被排除。

采集地址不代表独立用户或接收意愿，也不能保证 TP／AVE 的统计结果。特殊代币的手续费、黑名单、限频等机制可能影响实际到账或导致回滚。

## 5. 记录保存、备份和恢复

| 文件 | 作用 |
| --- | --- |
| `data/preview.json` | 最近一次候选清单，不是发送历史 |
| `data/state.json` | 历史发送记录、交易哈希和状态，用于去重及恢复 |
| `data/run.lock` | 运行期间的进程锁，正常退出时移除 |

**不要删除、清空或回退 `state.json`。** 历史去重按“链 + 代币合约”保留，不随日期或每次配额重置。待确认、成功、回滚记录都不会作为新地址重新发送；旧版历史记录继续兼容。

### state.json 会不会变大？

它会随发送记录增长。按每天约 50 条记录粗估：

| 使用时间 | 记录数量 | 文件大小估算 |
| --- | --- | --- |
| 30 天 | 约 1,500 条 | 约 1 MB |
| 1 年 | 约 18,250 条 | 约 10～20 MB |

以上只是数量级估算，不是实测保证；实际大小取决于字段、格式和待确认记录数量。待确认记录暂存已签名交易，确认后会移除这部分数据。签名交易不是私钥，但状态文件仍应作为私有运行数据保管。

当前脚本会读取整个状态文件，并在保存时重写整个 JSON。当前规模可以继续使用；长期积累后如果读取、保存明显变慢，再迁移到 SQLite 等数据库。**目前没有自动清理或数据库迁移功能，不要为了减小体积删除历史记录，否则会失去历史去重能力。**

### 备份与迁移

停止脚本后，定期备份 `.env`、`config.json` 和整个 `data` 文件夹，尤其在更新代码、换电脑、迁移服务器前。备份存放在私有位置；这些文件不会上传 GitHub，因此 GitHub 上的代码副本不等于发送记录备份。

迁移时使用最近一次运行后的完整记录，停止原机器的发送任务，只在新机器继续运行。不同机器的记录不会自动同步。

### 中断后继续运行

按 Ctrl+C 可以停止脚本，但已经广播的交易不能撤回。若提示运行锁已存在，先在任务管理器确认原脚本进程已退出，再删除残留的 `data/run.lock`，**不要删除 `state.json`**。

然后使用相同合约和分发钱包，再次执行发送命令。脚本先恢复保存的原签名交易，再处理新的地址。如果批内广播中断，保存的记录可能包括尚未广播的交易；恢复时会继续发送这些原交易。若提示 nonce 被占用，需要核对链上记录，避免同时通过 TP 或另一个脚本使用该钱包发送。

## 6. 拉取新版代码

仓库已重建为单个初始提交，旧克隆不能直接按普通更新处理。已有旧副本请按第 1 节重新克隆到新目录，并迁移原来的 `.env`、`config.json` 和 `data/`；保留最新发送历史。完成此次迁移后，后续正常更新使用下面的命令。

先退出正在运行的脚本，在 Git 克隆目录执行：

```powershell
git pull --ff-only
npm.cmd ci
```

需要走代理时将拉取命令替换为：

```powershell
git -c http.proxy=http://127.0.0.1:15236 pull --ff-only
```

正常拉取不会覆盖被忽略的 `.env`、`config.json` 和 `data/`。不要执行 `git clean -fdx`，它会删除这些本地文件。若修改过源码导致拉取失败，先保留修改，不要直接强制重置。

## 7. 手动运行与定时运行

目前必须手动启动，脚本不运行就不会发起新转账；已经广播的交易仍可能继续完成。

如果以后需要每天自动执行，可以在保持开机、联网的 Windows 电脑上配置任务计划程序，也可以迁移到服务器。调度任务应使用正确的项目工作目录、Node/npm 路径和日志位置，并保留同一份 `state.json`。**本项目目前没有配置任何定时任务。**

## macOS / Linux 命令

进入项目目录后，安装依赖使用 `npm ci`，预览使用 `npm run preview`，发送使用 `npm run send -- --execute`。首次使用且没有旧配置时：

```sh
test -f config.json || cp config.example.json config.json
test -f .env || cp .env.example .env
chmod 600 .env
```

然后按上面的配置说明填写合约与本机钱包信息。记录保存、历史去重及迁移规则与 Windows 相同。
