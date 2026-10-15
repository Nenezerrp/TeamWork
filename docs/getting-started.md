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

### 5. 飞书接入（必需——创建工作组的前置）

飞书云文档是 TeamWork 的跨机共享层：每台机器各跑一个本机 server，任务/记忆实时同步到飞书，新成员加入、换机恢复都从云端自动拉取。因此**创建工作组前**需要接入飞书（加入已有工作组不受影响，但创建者必须有可用凭据）。

#### 5.1 准备飞书应用（管理员 / Leader，一次性）

1. **创建应用**：[飞书开放平台](https://open.feishu.cn) → 开发者后台 → **创建企业自建应用**
2. **开通权限**：应用后台 → 权限管理 → 开通以下权限点（注意勾选**「应用身份」**列——只开「用户身份」列会报 `99991672`）：

   | 权限点 | 权限标识 | 用途 |
   |---|---|---|
   | 查看、评论、编辑和管理云空间中所有文件 | `drive:drive` | 列目录 / 建目录 / 建文档 / 成员授权 |
   | 查看、管理文档 | `docx:document` | 建文档 / 文档块读写 |

   > ⚠️ **开通权限 ≠ 生效**：权限变更必须**创建版本并发布**后才对 API 生效（最容易漏的一步）
3. **发布版本**：版本管理与发布 → 创建版本 → 申请发布
4. **配置可用范围**：应用后台 → 把 Leader 和所有成员加入「可用范围」（部分企业管理策略仅允许「个人级」可用范围 → 每来一个新成员需管理员逐人添加）
5. **配置重定向 URL**（绑定个人身份用）：安全设置 → 重定向 URL 添加 `http://localhost:9916/callback`

#### 5.2 配置凭据（每台机器，二选一）

**方式 A —— `.env` 文件**（安装/解压目录下，参照 `.env.example`）：

```env
TEAMWORK_FEISHU_ENABLED=true
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=<你的AppSecret>
# 可选：共享根目录 token（见 5.3）
FEISHU_ROOT_FOLDER=
```

**方式 B —— CLI 授权**（自动持久化到 `~/.teamwork/feishu.json`，同时绑定个人身份）：

```bash
teamwork feishu-auth --app-id <你的AppID> --app-secret <你的AppSecret> [--root-folder <根目录token>]
```

浏览器自动打开 → 飞书账号登录 → 同意授权。凭据优先级：`.env` > `feishu.json`。

配置后运行 `teamwork doctor` 自检（Node / 凭据链 / 飞书连通性）——建组报「飞书目录创建失败」时先跑它。

#### 5.3 目录是谁创建的？（无需手动建目录）

| 目录 | 谁创建 | 说明 |
|---|---|---|
| 工作组目录 `/TeamWork-Demo/<组名>/`（含 `Memory/` `Skill/` `NodeMap.md`） | **系统自动** | Leader 在仪表盘点「创建工作组」时自动创建（幂等：同名空壳目录复用，含旧数据则拒绝以防污染）；成员加入不建目录 |
| 根目录 `TeamWork-Demo/` | **两种方式** | ① **快速起步**：不配置 `FEISHU_ROOT_FOLDER` → 应用身份自动在其云空间创建/发现同名根目录（同一应用的多台机器天然共享）；② **多人团队推荐**：Leader 在飞书云文档预建一个共享目录，把 folder token 填入 `FEISHU_ROOT_FOLDER` 或随 `feishu-auth --root-folder` 分发——成员绑定时系统自动把该目录共享给他（可编辑），**成员无需自己创建** |

> **folder token 怎么拿**：飞书网页版打开该目录，浏览器地址栏 URL 最后一段（如 `.../folder/<token>` 中的 `<token>`）。
>
> **为什么绑定个人身份必须显式配根目录 token**：个人身份从「我的空间」发现不了应用空间/他人空间的目录——`feishu-auth --root-folder` 已一并处理（持久化 + 自动共享授权）。

#### 5.4 身份模式

- **应用身份（tenant）**：默认。所有飞书操作以应用身份执行，目录建在应用云空间——同一应用的多台机器天然共享，零授权即可用
- **个人身份（feishu-auth 绑定）**：可选增强。云文档归属操作者本人（飞书「共享与我」可见、可编辑）；活跃使用免重登，闲置 > 7 天需重新授权

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

## 使用提示词建议

配置好 MCP 后无需记工具名——**对 AI 说人话即可**，AI 会自动调用对应的 MCP 协作工具。三个核心场景的推荐提示词模板（`<>` 为填空位）：

### ① Leader：发布任务（AI → `teamwork_publish_task`）

> 帮我发布一个协作任务：`<一句话任务描述，如：为登录模块实现 JWT 中间件>`。
> - 目标：`<要达成什么，1~3 条>`
> - 验收标准：`<怎样算完成，尽量可量化>`
> - 分配：`<可选：交给服务器按成员画像自动拆分分配；或直接指定成员名和各自子任务>`

说明：不写「分配」时，服务器用 Leader 的 AI 结合成员 shareSkill / 身份域 / 空闲状态自动拆分，并按画像定向注入候选成员收件箱；点名指定成员的任务会经飞书任务流传播到该成员本机收件箱，由其 AI 自动唤起。

### ② 成员：查看可拾取任务（AI → `teamwork_inbox_status`）

> 查看我的任务收件箱：现在有哪些可拾取的任务？列出任务名、验收标准和前置摘要。

说明：建议每个会话开始时和完成一项工作后各查一次；其他机器发布的任务会在查询时自动从飞书云端对齐到本机收件箱，无需等待。

### ③ 成员：完成任务节点（AI → `teamwork_report_done`）

> 任务「`<任务名>`」已完成，上报结果：
> - 做了什么：`<completed：改动文件 / 通过的测试 / 交付物>`
> - 关键发现：`<learned：踩过的坑 / 关键决策 / 坑的绕法>`
> - 下一步：`<next_steps：给后继拾取者的建议与注意事项>`

说明：summary 会作为后继拾取者的注入上下文，按「做了什么 / 关键发现 / 下一步」三段结构化写最有效；上报后，依赖该任务的后继子任务自动解锁并从全员收件箱清除。

> 💡 其余场景（拾取抢锁 `teamwork_ack`、共享记忆 `teamwork_share_memory`、共识提议 `teamwork_consensus`、链路继承 `teamwork_inherit` 等）同样**自然语言触发即可**——协议指引已内置在工具描述与注入源中，AI 会话中想到什么直接说。

## 静默拾取（v1.0.8）——继承任务后 AI 零输入开工

Server 每 3 秒把「身份 + 共识 + 收件箱 + **进行中任务（含链上前人记忆摘要：谁做了什么/怎么做的/卡在哪 + 验收标准 + 📄 文件锚点）**」写入 `~/.teamwork/inject-{wsId}.md`，也可 HTTP 拉取（`GET /api/ws/<wsId>/inject.md`，带登录 token）。在仪表盘继承/拾取任务后，你的 AI 对话框只要被注入这份文件，即拥有全部背景——不再需要手动粘贴提示词；摘要之外的完整叙事按需调 `teamwork_timeline` / `teamwork_get_observations`（渐进披露，防上下文膨胀）。

三种接入方式（按宿主能力任选）：

| 宿主 | 接法 |
|---|---|
| MCP 宿主（TRAE / Claude Code / Cursor） | AI 会话自然触发 `teamwork_inbox_status` / `teamwork_search` 即可——协议指引已内置在工具描述与注入源 |
| 采集钩子 | `node scripts/observe-hook.mjs --ws <wsId> --file <对话日志> --inject-file zz-teamwork-inject.md`——边采集对话边把注入源原子落盘到项目文件（含 2s 超时 fail-open） |
| 任意 hook / rules（SessionStart 等） | hook 脚本读 `~/.teamwork/inject-{wsId}.md` 附加进会话上下文——`<teamwork-inject>` 标签外手写内容永不覆盖 |

## 功能状态（🚧 正在开发中）

以下三个功能当前未开放，底层链路已就绪、后续开放零迁移：

| 功能 | 当前状态 |
|---|---|
| **共享 Skill** | 🚧 正在开发中——MCP `teamwork_skills` 目前仅支持列出工作组已注册的技能；技能注册 / 分发 / 仪表盘技能库的完整链路正在开发 |
| **仪表盘「🔍 检索」** | 🚧 正在开发中——手动检索入口暂停开放（按钮提示「功能暂停开放」）；**AI 侧三层检索已可用**：`teamwork_search`（索引）→ `teamwork_timeline`（上下文）→ `teamwork_get_observations`（详情） |
| **仪表盘「☁ 云恢复」** | 🚧 正在开发中——手动全量恢复入口暂停开放；**自动云同步不受影响**：任务 / 记忆实时上云，新成员加入、换机时自动从云端恢复 |

## 环境变量（可选）

复制 `.env.example` 为 `.env` 并填写。飞书凭据也可通过 `teamwork feishu-auth` 命令或 `~/.teamwork/feishu.json` 配置，优先级：`.env` > `feishu.json`。
