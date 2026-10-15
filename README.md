# TeamWork — 多用户 AI 协作系统

## 安装

前置：Node.js >= 18（https://nodejs.org）

```bash
npm install -g <安装包路径>\teamwork-cli-1.0.14.tgz
teamwork version        # → TeamWork v1.0.14
```

升级旧版本（顺序不能变，运行中直装会 EBUSY）：

```bash
teamwork stop
npm install -g <新包路径>
teamwork start
```

## 使用（按顺序执行）

### 1. 启动

```bash
teamwork start
```

浏览器自动打开 `http://localhost:8787`

### 2. 注册

浏览器自动打开登录页 → 输入登录 ID → 点「进入」（自动跳转工作组大厅，登录态自动写入本机）

### 3. 创建或加入工作组

**创建（Leader）**：大厅 → 点「+ 创建工作组」→ 填 Workspace Name + Wpassword → 确认（自动创建飞书目录）

**加入（成员）**：大厅 → 点「加入工作组」→ 填工作组名称 + Wpassword（Leader 提供）→ 确认（自动从飞书云端恢复全部任务/记忆）

### 4. 配置 AI 工具 MCP（创建/加入后弹窗引导，最后一步）

```bash
teamwork setup          # 自动检测本机 AI 工具（TRAE / Claude Code / Cursor）并写入 MCP 配置
```

完成后打开 AI 工具即可开始协作。

### 5. 绑定个人飞书身份（可选）

前置：管理员已在飞书开放平台把你加入应用「可用范围」，否则无需本步。

```bash
teamwork feishu-auth --app-id cli_aa46d13079b99bc2 --app-secret <你的飞书AppSecret> --root-folder GpLsfKxo4lYcludu39UcB2GTnrf
```

浏览器自动打开 → 飞书账号登录 → 同意授权

## CLI 命令

| 命令 | 说明 |
|---|---|
| `teamwork start` | 启动 server（后台）+ 打开仪表盘 |
| `teamwork start --port 9000` | 指定端口启动 |
| `teamwork stop` | 停止 server（优雅落盘） |
| `teamwork stop --force` | 强制清理残留进程 |
| `teamwork status` | 查看运行状态 |
| `teamwork version` | 版本 |
| `teamwork doctor` | 环境自检（Node/凭据链/飞书连通性）——建组报「飞书目录创建失败」时先跑它 |
| `teamwork link <token> <wsId> [user] --server <url>` | 远程访问场景：写入登录态 + 自动配置 AI 工具 MCP（本机使用自动写入，无需此命令） |
| `teamwork feishu-auth --app-id .. --app-secret .. --root-folder ..` | 绑定个人飞书身份 |
| `teamwork setup` | 检测 AI 工具 + 自动配置 MCP |
| `teamwork setup --trae / --claude / --cursor` | 只配置指定工具 |

## 静默拾取（v1.0.8）——继承任务后 AI 零输入开工

Server 每 3 秒把「身份 + 共识 + 收件箱 + **进行中任务（含链上前人记忆摘要：谁做了什么/怎么做的/卡在哪 + 验收标准 + 📄 文件锚点）**」写入 `~/.teamwork/inject-{wsId}.md`，也可 HTTP 拉取（`GET /api/ws/<wsId>/inject.md`，带登录 token）。在仪表盘继承/拾取任务后，你的 AI 对话框只要被注入这份文件，即拥有全部背景——不再需要手动粘贴提示词；摘要之外的完整叙事按需调 `teamwork_timeline` / `teamwork_get_observations`（渐进披露，防上下文膨胀）。

三种接入方式（按宿主能力任选）：

| 宿主 | 接法 |
|---|---|
| MCP 宿主（TRAE / Claude Code / Cursor） | AI 会话自然触发 `teamwork_inbox_status` / `teamwork_search` 即可——协议指引已内置在工具描述与注入源 |
| 采集钩子 | `node scripts/observe-hook.mjs --ws <wsId> --file <对话日志> --inject-file zz-teamwork-inject.md`——边采集对话边把注入源原子落盘到项目文件（Grok 式注入媒介，含 2s 超时 fail-open） |
| 任意 hook / rules（SessionStart 等） | hook 脚本读 `~/.teamwork/inject-{wsId}.md` 附加进会话上下文——`<teamwork-inject>` 标签外手写内容永不覆盖 |


## 功能说明

TeamWork 让多人在各自的 AI 工具（TRAE / Claude Code / Cursor / 任意 MCP 宿主）中协作：

- **任务协作**：Leader 发布任务 → 按成员画像定向分发 → 抢锁拾取 → 完成上报自动解锁后继
- **共享记忆**：工作产出自动沉淀为团队记忆，三层检索（关键词 / 拓扑 / 域）、时间线回溯
- **共识约束**：团队长线共识（命名 / 架构 / 流程约定）自动注入全员上下文
- **链路继承**：未完成开发链可被新成员继承（溯源 + 崩溃回退防护）
- **飞书云同步**：全部数据实时同步飞书云文档——换机、新成员加入即自动恢复
- **仪表盘**：节点地图可视化、成员状态、共识管理、任务看板

数据全部落在本机 `~/.teamwork/`——升级安装包不丢数据。

## 协作演示

一图胜千言：**[docs/demo-collaboration.md](docs/demo-collaboration.md)** 是一份完整的双人协作剧本（Leader × 成员），按时间轴展示两人在各自 AI 端的对话内容，逐事件注释——什么提示词触发了哪个 hook / MCP 工具、server 在幕后做了什么（画像拆分 / CAS 抢锁 / 隐私管线 / 飞书同步）、双端如何**并行**工作、记忆如何**跨人流动**（gotcha 置顶 / RNN 注入边 / 共识 Δ 注入）。

其中三个「零输入」时刻是静默链路的核心：**① SessionStart 注入发现任务（Leader 无需喊话）② observe 自动入图（队友无需问进度，看节点地图）③ ContextBundle 继承前人记忆（后继者无需粘贴背景提示词）**——详见演示文档。

## License

MIT

