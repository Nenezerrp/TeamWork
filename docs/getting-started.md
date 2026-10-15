# TeamWork 使用手册

> **安装 → 启动 → 建组 → 配置 AI → 协作**。数据全部落在本机 `~/.teamwork/`——升级安装包不丢数据。

## 安装

前置：Node.js >= 18（https://nodejs.org）

```bash
npm install -g <安装包路径>/teamwork-cli-1.0.14.tgz
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
teamwork feishu-auth --app-id <你的AppID> --app-secret <你的飞书AppSecret> --root-folder <你的目录ID>
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
| 采集钩子 | `node scripts/observe-hook.mjs --ws <wsId> --file <对话日志> --inject-file zz-teamwork-inject.md`——边采集对话边把注入源原子落盘到项目文件（含 2s 超时 fail-open） |
| 任意 hook / rules（SessionStart 等） | hook 脚本读 `~/.teamwork/inject-{wsId}.md` 附加进会话上下文——`<teamwork-inject>` 标签外手写内容永不覆盖 |

## 环境变量（可选）

复制 `.env.example` 为 `.env` 并填写。飞书凭据也可通过 `teamwork feishu-auth` 命令或 `~/.teamwork/feishu.json` 配置，优先级：`.env` > `feishu.json`。
