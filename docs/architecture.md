# TeamWork v4.0 架构设计：多工作区 + 独立用户注册（腾讯会议模式）

> 核心变革：从"单工作区+密码进入"升级为"用户先注册→配置 AI→创建/加入多个工作组"。
> 每个用户可以在自己创建的工作组中是 Leader，同时是其他工作组的 member——如同腾讯会议：每个人都可以是自己会议的主持人，也可以加入其他会议。
> Leader 退出 → 该工作组暂存（DORMANT），成员全部退出；重开时恢复。
>
> **v4.1 增量更新（已实现并验证）**：
> - AI Provider 配置热同步：`PUT /api/me/ai-config` 即时生效；已加入活跃工作组（OPEN）则 409 拒绝，需先退出/挂起
> - 成员操作权：member 卡片新增 🚪 退出 / ⏸ 挂起 / ▶ 启动（挂起/启动权限从 Leader 放开至所有成员；删除仍 Leader 独占）
> - 创建重名校验三层防线：输入实时提示（`GET /api/workspace-names`）→ 提交本地预检 → 后端 409（名称全局唯一）
> - 已解散墓碑（tombstone）机制：Leader 删除组 → 成员条目标记 `dissolved`（保留组名）→ 成员下次访问见 🔴 红灯卡片 → 点击 `dismiss` 清理（惰性通知，非实时推送——有意的设计决策）
> - 挂起的工作组可点击进入（查看模式）；唤醒需成员「▶ 启动」
> - 飞书凭据链修复：user_token 优先 + `_preferUserToken` 降级逻辑反转 bug 修复 + 续期 refreshToken 保底
>
> **v4.3 批次四（拓扑检索与域订阅，已落地验证）——四批全部完成**：
> - `POST /api/ws/:wsId/search` 三层检索：**mode:'topo'** 拓扑前缀（确定性轮询前序；无效路径自动降级关键词 + `degraded:true`，R4 fail-open）/ **mode:'domain'** 域订阅（身份域过滤；空结果自动扩全组 + `expanded:true`，R14 fail-open）/ 默认 kw（关键词 + **同域优先排序**）；结果带 topoPath/role 徽标 + who 显示名修正（dn）
> - 前端：报告弹窗 📍 拓扑徽标**可点击导航**（navTopo → 定位任务/子任务节点图位置）；🔍 检索面板（结果卡片点击定位 + role/拓扑徽标）；userMarkedRelated 可点击跳转
>
> **v4.3 批次三（共识子系统，已落地验证）**：
> - `GET/POST /api/ws/:wsId/consensus`：提议（key 枚举 9 类 + ≤60 字 + 提议者自带一票）→ **全员确认 or Leader 一票** → confirmed（ver++）；同 key 结构冲突 / proposed 挂起超时 → **arbitration 待 Leader 裁决**；Leader 归档/裁决
> - **三道闸（R2）**：confirmed ≤20（env TEAMWORK_CONSENSUS_MAX）；单条 ≤60 字；proposed 48h 超时转裁决（env 可配）
> - **Δ 注入（LSTM 门）**：成员级 lastConsensusVer，Bundle 组装时注入「v0→v1 新增: [naming] …」具体增量；ack/inherit 后刷新感知版本
> - **L-1 共识层**：confirmed 条目一行式置顶注入 ContextBundle（E2E 实证 `[共识 v1] 命名统一小驼峰`）
> - **飞书版本化快照（R9）**：ver 变更防抖 30s（env 可配）→ `consensus-snapshot-v{ver}.md` 新文档（幂等锚点防重放；本地真源，快照仅持久层备份）；E2E 实证 `/Memory/<组名>/consensus-snapshot-v3.md`
> - 前端：侧栏 ⚖️ 共识区（confirmed 预览 + 待确认/待裁决计数）+ 管理弹窗（分组卡片 / 提议表单 key 下拉 / 确认 / Leader 裁决与归档按钮）
>
> **v4.3 批次二（自主继承闭环，已落地验证）**：
> - `GET /api/ws/:wsId/open-ends`：末端未完成链路卡片（依赖全解锁 + 无占用；domain/拓扑/前序摘要/域内记忆数/前任；同域优先排序，≤10 条）
> - `POST /api/ws/:wsId/inherit`：CAS 抢末端（双继承 409）→ **继承节点入图**（WhenWhoWhat + injectedFrom=链上末端节点）→ **身份赋予**（identity=domain，identityHistory 审计）→ 链路归属 + 租约 → InheritBundle（链上信息 + 域内 Memory + 共识全文 + gotcha 置顶 + 拓扑）
> - `POST /api/ws/:wsId/revert`（回退记忆）：归属校验（只回退自己的链）+ **reorg 防护**（被下游 injectedFrom 引用 → 409 + 影响清单）→ 崩溃链 abandoned 软删 + 回退节点入图（reason 沉淀 gotcha + revertedIds tombstone）→ 任务回 ready 归属保留（从初始继承节点重新开发）
> - `POST /api/ws/:wsId/release`（Leader 解除占用，R13 手动通道）
> - 租约（R13）：`t.lease = {owner, since, lastActivity}`——ack/observe/share/report_done 四类**产出保活**（心跳不算）；扫描双通道：心跳超时（不入图）vs 租约超时（审计节点入图）；env 参数 TEAMWORK_LEASE_TIMEOUT_MS（默认 30min）
> - 修复：ws 路由正则 action 支持连字符（`[\w-]+`，open-ends 类命名路由恢复）；全局 `dn()`（status 局部声明导致新 action 崩溃的隐患根除）
> - 前端：🔗 可继承末端按钮 + 末端选择界面（链路卡片/身份赋予提示/InheritBundle 预览）+ 首次进入无身份自动弹出 + 子任务报告"↩ 回退我的开发链"（reason 输入）+ 继承(🔗)/回退(↩️)节点图上渲染
>
> **v4.3 批次一（ShareMemory 地基，已落地验证）**：
> - `wrapInjected()` 单点包裹（R6）：所有注入通道统一 `<teamwork-memory trust="reference-only">`
> - `buildContextBundle()` 唯一注入组装入口（R1 白名单）：L-1 共识层 + Δ 提示（R2）+ RNN 注入边层 + 拓扑行（R4）+ 2K 预算硬裁剪（R7）+ abandoned 过滤（R18）
> - 四维快照全事件落库：create/publish/ack/report/share/observe/join/leave 节点带 role/topoPath/consensusVer；**ack 节点持久化 injectedFrom（RNN 注入边，E2E 实证）**；observe 的 relatedTo 落独立字段 userMarkedRelated（R1 分离）
> - 任务 domain 标注（publish 时），resolveDomain 子任务→任务→general
> - 心跳扫描（R12/R13 基础）：lastSeen（任意 API 刷新）+ 定时扫描超时解除 assignee 回末端（env 参数化：TEAMWORK_HEARTBEAT_TIMEOUT_MS / TEAMWORK_SCAN_INTERVAL_MS）
> - 飞书 toBlockText 四维行（role/topo/injectedFrom/consensus/relatedMarked/abandoned）
> - 前端节点地图：真实注入边（青色实线，区别推断虚线）、已回退开关（abandoned 过滤+红色斜杠样式）、报告弹窗四维徽标（📍拓扑/共识版本/身份/注入边可点击跳转）
>
> **v4.2 核心功能落地（节点地图 + 记忆采集）**：
> - **observe 采集端点** `POST /api/ws/:wsId/observe`（Design 4.4 写路径）：本地 IDE/对话/网页对话原始内容 → 隐私管线 → **该用户的 AI Provider** 总结为 FlowNode 六字段（fail-open 降级）→ 自动上传飞书
> - **节点地图**（workspace.html）：SVG 缩放/平移，**爆炸图渐进披露**（点击逐层扇形展开），节点详情报告弹窗（WhenWhoWhat + narrative/facts/concepts/同步状态），任务依赖箭头 + 上下文注入影响虚线，SSE 节点增量实时刷新
> - **全事件节点化**：创建组（milestone 起始）/ 加入/退出 / 发布/拆解 / 拾取 / 完成 / 观察 / 分享全部入图 + 自动上传飞书（toBlockText 含 when/who/source）
> - **采集钩子** `scripts/observe-hook.mjs`（`npm run observe`）：监听本地对话日志文件（纯文本/JSONL）自动上报，fail-open

---

## 一、用户体验流程（三视图）

### 视图 1：注册/登录（首次使用）
```
┌─────────────────────────────────────────────┐
│  ✦ TEAMWORK                                 │
│  多 AI 协作平台                              │
│                                             │
│  ┌─ AI Provider 配置 ─────────────────┐     │
│  │ Provider: [claude ▼]              │     │
│  │ Base URL: [___________________]   │     │
│  │ API Key: [••••••••••••••••]     │     │
│  │ Model ID: [claude-haiku-4-5 ▼]   │     │
│  │                                   │     │
│  │ ☐ 高级：多密钥池（限流自动轮换）   │     │
│  │ ☐ 高级：配额回退（耗尽切备用）     │     │
│  └───────────────────────────────────┘     │
│                                             │
│  [ 用户名 ]  [ 注册 / 登录 ]               │
└─────────────────────────────────────────────┘
```

### 视图 2：工作组大厅（登录后，v4.1）
```
┌─ 侧栏 ────────┬──────────────────────────────────────────────┐
│ 👤 我的身份    │  ✦ TEAMWORK | 用户名 | [退出]                │
│ 🤖 AI Provider │  [+ 创建新工作组]  [加入已有工作组]           │
│   Provider/模型│  创建弹窗：输入名称时实时重名提示              │
│   ⚙️ [编辑AI配置]│   「⚠ 该名称已被占用，请换一个名称」        │
│               │ ┌─ ✦ 我创建的 ────────────────────────────┐  │
│  （编辑保存后  │ │ 🏠 Alpha（🟢 工作中） [⏸ 关闭][🗑 删除] │  │
│   热同步生效； │ │ 🏠 Gamma（💤 已挂起） [▶ 启动][🗑 删除] │  │
│   有活跃工作组 │ ├─ 🤝 我加入的 ──────────────────────────┤  │
│   时被 409 拦截）│ │ 🤝 Beta（OPEN） [🚪 退出][⏸ 挂起]      │  │
│               │ │ 🤝 Delta（DORMANT）[🚪 退出][▶ 启动]   │  │
│               │ │   （member 无删除按钮：非创建者）         │  │
│               │ ├─ 🔴 已解散 ────────────────────────────┤  │
│               │ │ ⛔ Epsilon（已解散）→ 点击卡片从列表移除   │  │
│               │ └───────────────────────────────────────┘  │
└───────────────┴──────────────────────────────────────────────┘
```

> 挂起（DORMANT）的工作组卡片也可点击进入（查看模式，页面顶部显示 phase=DORMANT）；恢复协作需成员「▶ 启动」唤醒。

### 视图 3：工作组详情（当前 dashboard 增强版）
```
┌── header: ✦ TEAMWORK | 工作组名 | 角色 | [返回大厅] ──┐
├── 左侧栏 ──┬── 中间工作流 ──┬── 右侧记忆流 ──────────┤
│ Leader卡   │ DAG 动态图    │ FlowNode 实时流        │
│ 成员三态   │               │                        │
│ 共享Memory │               │                        │
│ 共享Skill  │               │                        │
├── footer ──────────────────────────────────────────┤
```

---

## 二、数据模型重构

```jsonc
// 全局注册表（替代原来的单 workspace state）
{
  "users": {
    "alice": {
      "name": "alice",
      "aiConfig": {
        "provider": "claude",          // claude|gemini|openrouter|openai-compatible
        "baseUrl": "",
        "apiKey": "sk-...",             // 仅存本地
        "modelId": "claude-haiku-4-5",
        "apiKeyPool": [],               // 高级：多密钥池
        "quotaFallback": null           // 高级：备用 provider
      },
      "registeredAt": 1760000000000,
      "activeWs": "ws-abc123"            // 当前活跃工作组指针（enter/reopen/create 设置；close/delete/leave/dismiss 清理）
    }
  },
  "workspaces": {
    "ws-abc123": {
      "id": "ws-abc123",
      "name": "Alpha 项目",
      "leader": "alice",
      "password": "hashed",
      "memoryLimit": 1000,
      "phase": "OPEN",                  // OPEN | DORMANT
      "members": {                      // user -> { joinedAt, role, settings }
        "alice": { "role": "leader", "settings": { "autoPush": true, "autoPull": true } },
        "bob":   { "role": "member",  "settings": { "autoPush": false, "autoPull": true } }
      },
      "tasks": {}, "nodes": [], "inbox": {}, "locks": {},
      "checkpoints": []                 // 生命周期快照历史
    }
  },
  "userWs": {                           // 用户 → 工作组列表索引（实际字段名 userWs）
    "alice": [
      { "wsId": "ws-abc123", "role": "leader" },
      { "wsId": "ws-def", "role": "member" },
      { "wsId": "ws-ghost", "role": "member", "dissolved": true, "name": "Epsilon" }
                                        // 墓碑条目：组已被 Leader 删除（保留组名供红灯卡片显示；成员 dismiss 后清除）
    ]
  }
}
```

## 三、API 端点重构

### 用户与会话（实际实现）
- `POST /api/session` — { name, _clientId, aiConfig? } → token（clientId UUID 为真实身份键，同名可共存；token 不持久化，重启失效）
- `GET /api/me` — 当前用户信息 + AI 配置
- `PUT /api/me/ai-config` — 更新 AI Provider 配置（热同步：写内存即生效，`splitTaskWithAI` 每次实时读取，无需重启）
  ⚠ 拦截：已加入活跃工作组（OPEN）→ 409「请先退出/挂起当前活跃工作组才能修改」

### 工作组管理
- `GET /api/workspaces` — { mine, joined, **dissolved** }（状态摘要；dissolved = 已解散墓碑卡片数据，惰性通知）
- `GET /api/workspace-names` — 全局名称列表（创建弹窗实时重名校验的数据源）
- `POST /api/workspaces/create` — { name, password, memoryLimit } → wsId（自动成为 Leader）
  ⚠ 同名拦截：名称全局唯一 → 409「已被占用，请换一个名称」（重名会导致 join 按名查找混乱、飞书目录配置被覆盖）
  ⚠ 单活跃约束：已加入活跃工作组 → 拒绝创建
- `POST /api/workspaces/join` — { wsName, password, settings } → 加入为 member（飞书目录读取密码 hash 验证）
- `POST /api/workspaces/dismiss` — { wsId } 清理自己的已解散墓碑条目（独立路由：组已不存在，避开 /api/ws/:id 的 404 兜底）

### 工作组生命周期（/api/ws/:wsId/...）
- `POST /api/ws/:wsId/close` — 挂起 → DORMANT（**所有成员**可触发）
- `POST /api/ws/:wsId/reopen` — 启动 → OPEN（**所有成员**可触发；单活跃：先暂存其他活跃组）
- `POST /api/ws/:wsId/enter` — 进入（设 activeWs；member 进 DORMANT 组不改 phase = 查看模式）
- `POST /api/ws/:wsId/leave` — member 退出（清成员关系/inbox/activeWs + 释放其任务锁回 ready；Leader 禁止退出 → 400 提示用删除）
- `POST /api/ws/:wsId/delete` — Leader 删除（其他成员条目打墓碑 `{dissolved, name}`；飞书目录异步删除，fail-open）
- `POST /api/ws/:wsId/checkpoint` / `resume` — Leader 暂存/重开（语义与 close/reopen 重叠，保留兼容）
- `GET /api/ws/:wsId/status` — 详情快照（不检查 phase：成员可查看挂起组）
- `GET /api/ws/:wsId/events` — SSE 实时流（2s 心跳广播成员/任务状态）

### 工作区内协作
- `POST /api/ws/:wsId/publish_task` — Leader 发布（无 subtasks 时用 Leader 的 AI 配置热拆分）
- `POST /api/ws/:wsId/observe` — **钩子采集端点**（v4.2）：{ content, source, taskId? } → 隐私管线 → 该用户 AI 总结为 FlowNode → 自动上传飞书（AI 不可用降级为截断标题）
- `POST /api/ws/:wsId/inbox_status` / `ack` / `report_done` / `share_memory` / `search` / `skill_register`

## 四、鉴权重构（v4.1 实际）

```
用户 token（全局，内存态）→ 识别用户身份（clientId）
  ↓
路由到具体 workspace → 检查成员资格 + 角色（非成员 403；组不存在 404）
  ↓
Leader 独占：publish_task / delete
全员可用：close（挂起）/ reopen（启动）/ enter / status / SSE / 协作工具
member 独占：leave（退出）；Leader 调 leave → 400（请用删除）
本人操作：PUT ai-config（需无活跃组，409 拦截）/ dismiss（清理自己的墓碑）
```

## 五、生命周期（腾讯会议模式，v4.1 状态机）

```
[注册/登录] → [创建工作组] → OPEN（Leader = 创建者；同名 409 拦截）
  → 成员加入（名称+密码） → 协作...
  → 挂起：任何成员 ⏸ close → DORMANT（可再进入查看；协作冻结）
  → 启动：任何成员 ▶ reopen → OPEN（单活跃：其他活跃组自动暂存）
  → 成员退出：🚪 leave →（其任务锁释放，任务回 ready 待拾取）
  → Leader 删除：🗑 delete → 组移除 + 飞书目录异步删
      → 其他成员条目打墓碑 {dissolved:true, name}（惰性通知：不推送）
      → 成员下次访问见 🔴 红灯卡片 → 点击 dismiss 清除墓碑
[服务器重启] → loadState → 全部工作组 DORMANT（等待成员 ▶ 启动；token 会话失效需重新登录）
```

## 六、前端路由（实际实现：多页架构，非 hash SPA）

```
/ 或 /auth   → auth.html      注册/登录（clientId 存 localStorage 自持，AI 配置可选填）
/lobby       → lobby.html     工作组大厅（侧栏 AI Provider + 编辑按钮；分区：✦ 我创建的 / 🤝 我加入的 / 🔴 已解散）
/ws/:wsId    → workspace.html 工作组详情（SSE 优先，断线降级轮询）
静态文件每次请求从磁盘现读 → 前端改动即时生效，无需重启服务器
```

## 七、飞书凭据链（v4.1 修复）

```
user_token（demo/.local/user-token.json，每次调用磁盘现读）优先
  ├─ 未过期 → 直接用（accessToken ~2h）
  └─ 过期 → refreshUserToken 续期（refresh_token ~30 天；响应缺失 refresh_token 时保底沿用旧值）
       └─ 失败 ↓
tenant_token 兜底（app_id / app_secret）
  └─ 调 API 遇 99991672 权限不足 → _preferUserToken 降级：改用 user_token 重试
```

- **已修复**：`getToken` 原版 `if (!_preferUserToken)` 判断写反——降级一次后 user_token 通道被永久关闭，此后所有飞书操作必然失败（502）
- **已知限制**：当前应用的 v2 授权响应不返回 refresh_token → access_token 过期（~2h）后需重跑 `cd demo && npm run user-auth` 重新授权
- 工作组飞书目录：`/TeamWork-Demo/Memory/<组名>/`（创建时写入 `_workspace.json` 密码 hash；join 时从飞书读取验证；删除组时异步删目录，fail-open）

## 八、变更记录

### v1.0.9（2026-10-15，分布式死锁修复：join 挂起副本误报「工作组已挂起，等 Leader 重开」——成员永远进不去 Leader 明明开着的组）

- **动因（真实踩坑）**：Leader 端工作组 OPEN 未挂起，成员点「加入工作组」却报「工作组已挂起，等 Leader 重开」——双向白等死锁。
- **根因**：`phase` 是**本机视图**而非工作组全局状态——`close`（⏸ 挂起）/`reopen`（▶ 启动）/`enter` 三个 handler 全是纯本机内存操作、**从不 triggerSync 上飞书**。成员机曾加入该组、后因切换组被自动暂存（v4.6.4 auto-close）或手动挂起 → 本机副本 phase=DORMANT 留存；Leader 端重开只改 Leader 机内存。成员再 join 时：①/⑤ 命中本机既有 DORMANT 副本（不走 ⑥ 飞书恢复路径）→ join 的 DORMANT 分支只信本机 phase：非 leader 角色直接 400「等 Leader 重开」——而 Leader 感知不到成员本机副本，永远等不到，双向死锁。
- **修复（join handler DORMANT 分支）**：删除「仅 leader 自动重开、member 报错等待」逻辑，join 命中挂起副本时**全员自动重开本机视图**（`ws.phase = 'OPEN'`）。安全性：单活跃约束已由 join 上游 ⑧ 检查兜底（存在其他 OPEN 活跃组会先被拒绝，能走到此处即无其他活跃组）；且 reopen 权限 v4.1 起本就全员可用——挂起是本机暂存语义（腾讯会议模式的单人切换），不是组级停工指令，组级停工由 delete（解散）承担。
- **不改动**：`enter` handler 保持原语义（leader 进入自动重开 / member 查看模式进入——要干活点「▶ 启动」即可）；`close`/`reopen` 不加飞书同步（phase 本就是本机概念，上云反而引入跨机状态冲突）。
- **运维 SOP**：`npm install -g teamwork-cli-1.0.9.tgz` → `teamwork version`（须 1.0.9）→ `teamwork stop --force; teamwork start` → 大厅重试「加入工作组」即自动重开进入。

### v1.0.8（2026-10-15，静默拾取增强：inject 注入源内嵌任务链上下文——继承者零输入即拥有全量背景）

- **动因**：成员在仪表盘 web 继承任务后，inject 注入源里只有「当前任务: T-x「…」(进行中)」一行摘要——AI 对话框被注入后仍不知道「前人做了什么/怎么做的/卡在哪」，需要人工粘贴 5 步提示词（search → timeline → get_observations → 开发 → report_done）才能开工。用户需求：底层 hook 更静默地拾取任务。
- **改动（server/index.js 三处）**：① 新增 `taskContextNodeIds(ws, task)`（dependsOn 闭包 BFS 防环）+ `renderTaskChain(ws, task, maxN=10)`——依赖闭包内全部节点（含前序任务）按时间序取最近 10 条：`N-x [MM-dd HH:mm] 谁 type「title」——narrative(90字截断) 📄文件数` + facts 前 2 条（120 字截断）；② `writeInjectFile`（~/.teamwork/inject-{wsId}.md 每 3s）myTask 段嵌入验收标准 + 链上记忆 + 完整协议（share_memory / report_done / revert）；③ HTTP `GET /api/ws/:id/inject.md`（无钩子宿主统一注入源，observe-hook `--inject-file` 的内容源）补「## 你的进行中任务」段——web 继承与 MCP ack/inherit 均生效。
- **渐进披露纪律**（对齐 claude-mem 五哲学）：注入源只给 L0/L1 摘要（防上下文膨胀），超 10 条时提示 `teamwork_timeline("锚点", depth=10)` 翻更早、完整叙事/文件锚点按需 `teamwork_get_observations`——AI 拿到摘要即可开工，详情按需拉取。
- **消费通道全兼容**：任何读 inject 的 hook 自动受益——observe-hook `--inject-file zz-teamwork-inject.md`（Grok 式文件注入）/ TRAE rules+MCP / Claude Code SessionStart 读文件，同一内容源。
- **运维 SOP**：与 1.0.7 相同——`npm install -g teamwork-cli-1.0.8.tgz` → `teamwork version`（须 1.0.8）→ `teamwork stop --force; teamwork start`（无需重新登录）。
- **交付后追加（同日，UI 双 bug 根因修复 + 2 功能暂停入口拦截；重打包 1.0.8，页面角标 v4.6.10）**：
  - **根因（一个 CSS 两个症状）**：`components.css` 的 `.ws-badge{position:absolute;top:.8rem;right:.8rem;...}` 是 lobby 大厅**卡片右上角角标**样式；workspace.html 将 `.ws-badge` 复用为行内徽章（详情报告 meta 行 / 底部信息栏 / 共识条目 / 检索结果 / open-ends）却**未覆盖定位**——徽章全部脱离文档流叠到最近定位祖先的右上角同一点：① 节点详情报告里「共识 v0」「📍 拓扑」等徽章飞到弹窗（#nm-detail, fixed）右上角同坐标 → 多徽章字符重叠（用户报障「右上角的共识 v0 底部有重叠字符」）；② 单击节点后底部信息栏（#nm-info-bar, absolute）里「待同步/☁ 已上传」徽章飞到 bar 右上角 → 叠在行尾「✕ 取消」按钮上（用户报障「取消按钮跟未上传/已上传显示有重叠」）。
  - **修复**：workspace.html 页内 `<style>` 覆盖 `.ws-badge{position:static;display:inline-block;white-space:nowrap;background:rgba(255,255,255,.07);color:var(--mut)}`——徽章回归文档流（flex-wrap 正常换行、不再叠角）；中性底色可被使用点 inline 样式覆盖；**components.css 不动**（lobby 大厅卡片角标用法零影响）。
  - **2 功能暂停开放（仅拦入口，底层功能原样不动）**：工具栏「🔍 检索」「☁ 云恢复」按钮 onclick 改为 `uiShow('🔒 …','当前功能权限不足（功能暂停开放）')` 页面内弹窗提示（title 同步标注）；`doSearch()`/`restoreFromCloud()` 函数体、`/api/ws/:id/search`、`/api/ws/:id/restore` API 及页面加载时自动恢复 + 20s 云跟随轮询（startCloudWatch）全部保留——恢复开放时仅需还原两处按钮 onclick。

### v1.0.9 交付后追加（2026-10-15，UI 伪节点同步徽章误导修复——「未同步/已上传双节点」根因；页面角标 v4.6.11）

- **报障（用户原话）**：「每个节点，从未同步到已上传，为什么 2 个一模一样的节点还存在，一个是未同步一个是已上传，按逻辑应该只有一个节点从未同步状态变更到已上传」。
- **排查（数据层无罪，前端误导）**：三层验证服务端状态机正确——① 磁盘 state.json 4 组 DUP-ID/DUP-EXACT 全 0；② 运行中 server status API 内存节点全 synced 无重复；③ `doSync` 上传后就地改 `n.sync='synced'`（同一条记录状态变更），`cloudSyncOnce` 恢复合并按节点 ID 去重。**根因在 `buildTree` 伪节点**：每个任务/子任务都生成结构占位伪节点（`t:T-x`/`s:ST-x`，node 为前端临时拼装，**无 sync 字段**），真实发布节点 `n:N-x`（同标题「发布：xxx」）挂到伪节点 `t:T-x` 之下——**父子两代一模一样**；而 `renderInfoBar`（底部信息栏）与 `openDetail`（详情弹窗）渲染 sync 徽章时对伪节点无豁免（`n.sync==='synced'?'已上传':'待同步'`）→ 伪节点 sync=undefined **恒显「待同步」且永不变**（它不是 FlowNode，永不上传）→ 用户视角：真实节点 local→synced 正常翻绿，旁边永远站着一个同名「待同步」节点，误以为同一节点出现了两条记录。
- **修复（workspace.html 两处，key 前缀守卫）**：sync 徽章仅对真实节点（key 以 `n:` 开头）渲染「待同步/☁ 已上传」（状态机 local→synced 原样保留）；伪节点（`t:`/`s:`）改显中性徽章「🧩 结构节点」/详情行「结构节点（任务/子任务拓扑占位，非记忆节点，不参与同步）」——用户一眼区分「结构骨架」与「记忆节点」，不再冒充未同步节点。
- **生效方式**：静态文件每请求从磁盘现读——已同步修复到全局安装副本 `@teamwork/cli/server/public/workspace.html`（备份 .bak-syncfix），**刷新浏览器即生效，无需重启/重发包**；源码目录同步修复，下次 build-package 自然带入。
- **重打包 1.0.10（同日）**：版本三处同步（package.json 1.0.10 / README 安装命令 / 页面角标 v4.6.11）→ `npm run build` 双产物：`teamwork-cli-1.0.10.tgz`（108KB，21 文件）+ `.zip`（122KB）；`tar -xOf` 金工具直读验证包内 workspace.html（key-guard/结构节点徽章/v4.6.11 角标全在）。**升级坑（EBUSY）**：运行中 server 锁全局目录，`npm install -g` 报 `EBUSY rename @teamwork\cli`——**必须先 `teamwork stop --force` 再装**，装完 `teamwork version`（须 1.0.10）→ `teamwork start`。重启副作用照旧：内存 session token 全失效（浏览器重登录即恢复，localStorage clientId 仍在；MCP fail-open 引导重新 join）；磁盘 state.json 数据无损（4 工作组 / ws-01f2bfda 12 节点全 synced，实测确认）。

### v1.0.13（2026-10-15，跨机删除传播——僵尸副本墓碑化 + 云目录防复活 + 同名重建纯净性/代际校验）

- **报障（用户原话）**：「之前已经删除掉的工作组guyuntao，我在共享目录下也确认了已经被删除了，再次创建工作组guyuntao，出现了上次遗留的信息内容」。
- **排查实证（本机 state.json + 飞书实测）**：本机（成员机）state 里旧组 `ws-8b286172 | guyuntao` **phase:OPEN、7 节点、userWs 绑定全部存活**；云上同名目录存在且 folderToken 已换代（被重建过）——删除动作发生在 Leader 机（本机用户是 member，无删除权），成员机对删除**零感知**。
- **根因（三层叠加）**：① **删除通知不跨机**——delete handler 只清 Leader 机本地（workspaces/userWs/inject）+ 云目录；墓碑只打给 Leader 机 userWs 表（跨机成员条目不在 → `continue` 跳过），成员机副本成**僵尸**（phase:OPEN 永续）；② **僵尸副本复活云目录**——成员机周期 `cloudSyncOnce`（pullAllNodes）与 doSync 都走 `ensureFolder` 幂等——目录被 Leader 删了就**重建** → 旧节点/[task] 行重新上云污染（实测：删除后 doSync「上传成功」复活目录）；③ **join 按名字复用本地副本不校验代际**——join⑤ `w.name === feishuName` 即命中旧副本 → 用户「加入新组」拿到旧数据，且旧副本挂上新目录 token 双向污染（新 config 的 createdAt 从未比对）。
- **修复（五处，`server/index.js` + `feishu-sync.js`）**：
  1. **目录存活守卫 + 所有权校验（pullAllNodes / doSync 同款）**：按名找不到目录且副本曾有关联（feishuFolder 有值）→ **不重建不推送**（dirMissing 信号）；目录「存在」再读 `_workspace.json`——**无 config=已删组残留（飞书删除有最终一致性缓存窗口，实测 Leader 删除成功后成员机 findChildByName 仍短暂命中旧 token 并「上传成功」复活目录）/ config 代际不符（wsId ≠ 本副本；旧 config 回退 createdAt 比对）= 同名新组已重建** → 一律按 dirMissing 处理。feishuFolder 为空（从未同步）保持原幂等 ensure。
  2. **僵尸副本墓碑化（dissolveLocalCopy）**：`cloudSyncOnce` 检测 dirMissing **连续 2 次**（防 API 抖动误杀；周期 15s → ~30s 收敛）→ 删本机 workspaces 副本 + 本机成员 userWs 条目打 `{dissolved, name}` 墓碑（lobby 🔴 红灯卡片，dismiss 清理）+ **终态 inject 文件**（AI 可读「工作组已被删除，MCP 调用会失败，请提示用户重新 join」）。
  3. **join 代际校验**：config 新增 `wsId` 字段（create 时写入）→ join 优先按 `config.wsId` 精确命中（旧 config 回退 名字+createdAt 同代）；名字命中但代际不同 = 旧代僵尸 → 顺手 dissolveLocalCopy → 从云恢复新副本；⑥ 恢复副本 ID 用 `config.wsId`（**多机副本 ID 统一**，修复「每机恢复随机新 ID」的分裂）。
  4. **create 纯净防线**：ensureFolder 幂等复用同名目录后读 `_workspace.json`——已有 config（其他机器活跃组/已删组残留）→ **回滚 + 明确指引**（「让所有成员机升级到 v1.0.13+ 后由 Leader 删除该组再重建，或手动删除飞书目录」），不再静默挂上旧数据。
  5. **dismiss 清理 inject 残留**（防终态文件残留注入）。
- **E2E（双实例真实飞书链路）**：20 项断言覆盖——A 创建/B join（副本 ID 统一）/B observe 上云传播回归/A delete/**B 僵尸 local 节点不得复活目录（所有权校验+存活守卫）/B 副本墓碑化（workspaces 移除 + userWs dissolved + inject 终态 + [dissolve] 日志）**/A 同名重建成功（目录干净）/B join 同名新组拿新 wsId 且新副本无旧代节点（代际校验）+ 旧代墓碑保留/create 防线拦截预置残留目录且回滚干净/清理后云目录删除（轮询断言自愈）。
- **E2E 排坑（新增）**：① **飞书删除最终一致性**——DELETE 返回成功后根目录 list（findChildByName）仍**短暂命中旧 token（~10-40s 不稳定）**，对已删 token 的写操作「软成功」——目录/所有权校验（读 config）是唯一可靠判定，仅靠 findChildExists 会复活目录；E2E 收尾断言目录删除须**轮询**（15×3s）而非固定 sleep；② 断言读 state.json 前须等 `scheduleSave` 2s 防抖落盘（join 副本/回滚结果都是防抖持久化）；③ create 防线用例须**新用户 session**（避开单活跃约束先于飞书防线拦截）。
- **升级要求与用户 SOP（删除→重建同名组的标准流程）**：**所有机器（Leader + 全部成员）必须升级 1.0.13+**——旧包成员机的僵尸副本会持续复活已删目录/污染新组；受污染存量组（如 guyuntao）需：Leader 删除该组 → 成员机升级 1.0.13 并重启（周期检测 ~30s 自动墓碑化本机副本，或成员直接 join 新组触发）→ Leader 重建同名（目录干净）→ 成员重新 join。升级后首次 MCP 调用 401 → 重新 teamwork_join（预期行为）。


### v1.0.14（2026-10-15，同名组创建风险矩阵——僵尸预检防死锁 + 半死目录防线 + 竞态读回 + 删除鲁棒化）

- **触发（用户风险预判）**：「可能会出现用户名为 guyuntao 的临时ID创建一个 guyuntao 的同名工作组，检查规避可能的风险」——对 v1.0.13 的 create 链路做同名场景攻击面推演。
- **风险矩阵（五项推演，四项实修）**：
  - **R1 本机同名僵尸副本阻断创建且无权删除（死锁，高）**：create 的 409 预检按 `w.name` 命中本机 DORMANT 僵尸副本 → 拒绝创建；而 delete 仅 Leader 可用（member 连手动清理都做不到）→ 「建不了删不掉」死锁。
  - **R2 半死目录污染新组（高）**：云目录存在但**无 config**（删除缓存窗口/删除中途失败的残留）却有旧节点文档 → v1.0.13 防线只查 config → 复用目录 → 新组周期 pull **拉回全部旧节点**（数据污染通道）。
  - **R3 双机竞态抢注（中）**：两机同时 create 同名 → 都探到「目录无 config」→ 都写 config → 后写覆盖先写（`writeWorkspaceConfig` 是新建文档非 CAS）→ 两组共用目录，先建者副本被所有权校验**误杀**。
  - **R4 删除竞态中止（中，E2E 实测撞上）**：delete 的云目录删除是 fire-and-forget，且旧 `deleteWorkspaceFolder` **单项 DELETE 报错即整体中止**——B 机 close 后仍在飞的迟到 doSync 撞上删除中途 → Skill/ 删掉但 config/NodeMap/Memory 残留 → 同名 create 预检误判「组还活着」永久 409。
  - **R5 临时身份固有语义（低，不修）**：换浏览器/清 localStorage → Leader 身份永久丢失 → leader-only 操作死锁——临时身份的已知产品语义，UI/文档提示级；**用户名==组名本身无技术冲突**（身份键 clientId，E2E T8e 验证协作/跨机同步全正常）。
- **修复（六处，`server/index.js` + `feishu-sync.js`）**：
  1. **create 同名副本预检（防死锁）**：dup 命中先做云所有权校验（searchWorkspaceFolder + readWorkspaceConfig）——云目录已删/config 代际不符 = 已死僵尸 → **dissolveLocalCopy 自动墓碑化后放行创建**（用户无感清理）；云同代存活 = 真组 → 409（合法重名保护，提示区分「本机副本」并指引进组）。校验异常保守拦截（宁可 409 不误杀活组）。
  2. **create 先探后建 + 半死目录防线**：不再盲走 ensureFolder 幂等（ensure 只认名字，区分不了全新/残留）——目录已存在时三重防线：a) 有 config → 502 拒绝（v1.0.13 防线回归）；b) **无 config 但有数据残留**（排除 Memory/Skill 结构目录）→ 502 拒绝（防新组 pull 拉回旧节点），文案指引手动清理；c) 空壳目录 → 复用 + 补结构。
  3. **create 竞态读回验证**：writeWorkspaceConfig 后读回——`wsId` 不是本组 = 抢注失败 → 回滚 + 明确报错（替代「双组共用目录」混乱）。**幽灵 token 重试**：读回失败且重探目录已不存在（删除缓存窗口内 config 写进了幽灵 token）→ 真重建一轮再验（「删除后立刻重建同名」不再误报冲突）。
  4. **doSync 挂起冻结守卫**：DORMANT 组不上传——close 后仍在飞的迟到 triggerSync 会与 Leader 端目录删除并发竞态（R4 的竞态源头）；local 节点等 reopen 后随下次触发上行（挂起=协作冻结语义）。
  5. **deleteWorkspaceFolder 鲁棒化**：① **先删 `_workspace.json`（tombstone）**——config 一删，并发中的成员机同步立即被所有权校验判死停推，竞态窗口从「整个删除过程」缩到 config 删除瞬间；② **循环扫荡 ≤3 轮**——单项删除失败不中止（旧代码一个 DELETE 报错即整体中止）；删除中途被并发新建的文件由下一轮扫掉；③ 目录删除失败重试 1 次，返回真实结果。
  6. **delete handler 同步等待 + 失败告警**：await 云删除，失败时返回 `error` 警告（「本地已删除，但飞书目录清理未完成，请手动删除——否则同名重建/新成员加入会被拦截」）——fail-open 静默会让 Leader 以为删干净了。
- **E2E（e2e-v1014.cjs，双实例真实飞书，20/20 PASS）**：T8a 僵尸预检（B join→close→A 删→B create 同名：自动墓碑化+全新创建+云 config 新代+墓碑保留）；T8b 半死目录拒绝；T8c 云 stale 防线回归 + 本机副本 409 双路径；T8d 同名活组 409 不误杀（副本仍可访问）；T8e 临时ID 用户名==组名：创建/他机 join/observe 跨机同步（nodes≥2 + title 命中）+ 身份键正常。
- **E2E 排坑**：① R4 竞态 E2E 首跑即撞上（云残留 Skill 被删/config 完整 = 删除中止铁证）——正是 v1.0.13 E2T 侥幸通过的「删除后重建」在 v1.0.14 更严防线下的暴露；② **15s pull 节流边界**——B 机周期云对齐拉 A 的节点需等到第三轮 pull（~32s），断言等待须 35s；③ join 云对齐若早于 Leader milestone 上云 → join 节点 N-1 与 milestone N-1 撞 ID 合并（**既有 fail-open 已知缺陷**，v1.0.13 注释明示，非本轮范畴——恢复 0 时 seq=0 且 fail-open 不阻塞）。
- **升级提示**：与 1.0.13 同日连续发布；分发 1.0.14 取代 1.0.13（僵尸治理 + create 风险矩阵一并到手）。受污染存量组的清理 SOP 不变（Leader 删除 → 全员升级 → 重建 → 成员 join）；1.0.14 起删除失败会有**明确告警**（不再静默残留）。

### v1.0.14.1（2026-10-15，hotfix：session 自动写 token.json 不再抹掉 wsId——hook 宿主误报「未加入工作组」根因）

- **现象（两轮复现）**：MCP 工具间歇性报「未加入工作组：请先调用 teamwork_join」——token.json 内容变成 `{user:'lxf123', wsId:null}`，但本机 Leader 从未以此名登录过。
- **根因（非 E2E，是 hook 宿主）**：本机另有 AI 宿主（TRAE）配置了 `observe-hook.mjs`（SessionStart 以 `lxf123` + 自有 clientId 调 `POST /api/session`）→ server 的 `writeLocalTokenFile(token, user, wsId)`（v4.5.2 引入，isLocal 自动写）**无条件整文件覆盖**——session 路由传 `wsId=null`（548 行）→ MCP 的组指向被抹 → `wsPath()` 抛「未加入工作组」。上轮误判为「E2E 备份/恢复损坏 token.json」，实际是 hook 覆盖（时序耦合）。
- **修复（合并保留语义）**：`writeLocalTokenFile` 写前读旧文件，`wsId: wsId ?? prev?.wsId ?? null`——session（null）保留既有 wsId；join/create 显式传值正常更新。全局包同款热修（`@teamwork/cli/server/index.js`），workspace 源码树同步——1.0.15 打包正式分发。
- **验证**：写入正确 `{lxf, ws-f51ecbf5}` → 模拟 hook session（`lxf123` 新 clientId）→ token.json token/user 更新但 **wsId 保留**（PASS）。
- **关联排障记录（T-4 分配变更实操）**：同轮完成 ST-10「交付文档与部署指引」designee guyuntao→xjb123（停服 patch state → 重启 → observe N-28 触发 [task] dsg 上行 → 共识 C-2 归档/C-3 生效「ST-6~ST-9 算法主线 guyuntao；ST-10 交付文档 xjb123」）。踩坑：① `teamwork start` 跑全局包非源码树（源码改动不生效，须同步热修 node_modules）；② consensus text 服务端 `slice(0,60)` 截断（超长静默）；③ server 每次重启 tokens 内存表清空——Leader 需 `POST /api/session {_clientId}` 恢复身份（join 不可用：members 已存在返回 400「你已是成员」，恰好免重加入副作用）。遗留待办：MCP `teamwork_join` 补 `_clientId` 透传；tokens 持久化/重启恢复评估。



### v1.0.11（2026-10-15，成员栏全量显示 + 流程树统一身份格式 `临时名(身份码)`；页面角标 v4.6.12）



- **报障（用户原话）**：「主流程页面左上角成员栏只显示自己，没有其他加入成员，我希望整个流程树的名字都是每个人自己登陆时的临时取名，只不过在临时取名后加括号(真实唯一身份表示码)」。
- **根因（分布式数据分布，非渲染 BUG）**：身份模型 = clientId（如 `u-e9ea998d`，登录时 UUID，真实唯一身份码）为键、name（临时取名，可改）仅显示；各机器独立维护本机 `ws.members`（其他机器成员/Leader 不在本机表）——但**节点经飞书全量同步，`nodes[].who` 才是"谁干过活"的跨机真源**。旧 status API `members` 只取 `Object.keys(ws.members)` → 永远只见自己；且 pull 恢复时 `parseMapNode` 丢弃了云行 `id(name)` 双存身份中的 name → 跨机成员在本机 users 表缺失 → 流程树显示原始码 `u-xxxx`。
- **修复①（feishu-sync.js 身份映射恢复）**：`parseMapNode`/`parseOpLine` 返回 `_whoName`（正则组本就捕获，旧代码丢弃）；`parseNodeBlock` 顺修**休眠 BUG**——旧实现把 `[WWW]` 行当 type/title 行解析（full 模式恢复出 `type='WWW'`、title 整行污染；因「☁ 云恢复」按钮暂停开放而未爆发），现 `[WWW]` 行只提取 `Who: id(name)` 映射。`cloudSyncOnce` 合并时回填 `users[id] = { name, remote: true }`（本机已有不覆盖——本机临时名优先；`_whoName` 剥离防混入节点对象；ops 行同源兜底）→ 落盘 state.json 重启不丢。
- **修复②（index.js status API 成员聚合 + 统一身份格式）**：`dnx = name(id)` 格式贯通全流程树（nodes.who / memory.latest.who / subtasks.assignee / leader）；members = 本机 members ∪ 节点参与者 ∪ Leader（`lastActive` 从节点 when 聚合），三态 `collab-busy`（本机持锁）/ `collab-idle`（本机在线）/ `away`（云端参与者，无本机心跳），Leader 恒排首位、其余按最近活跃排序；新增 `leaderId` 字段（前端 👑 改按 id 判断，替代旧名字比对——名字可撞可改不可作键）。`open-ends` 的 `lastNode` 加 `whoId`、`prevAssignee` 全格式。**MCP 文本视图（show_status/search/timeline）保持纯名**——AI 消费 token 敏感，不加码。
- **修复③（workspace.html 渲染）**：成员栏 `display` 格式 + 三态徽标（away→CLOUD，灰显 `av away`/`st-away` 样式本就预留）+ 云端成员显示「☁ 最近活跃时间」；SVG 节点 who 标签截断 14→22（放得下 `name(u-xxxxxx)` 基本场景）；👑 按 `leaderId`。
- **E2E 实测（ws-01f2bfda）**：模拟登录 u-e9ea998d → restore（远端 10 骨架，回填 `guyuntao(u-64d3e54e)`）→ status API：members=2（`guyuntao(u-64d3e54e)` away + `t123(u-e9ea998d)` idle）、12 节点 who 全格式、leader/leaderId 正确、磁盘 state.json `u-64d3e54e name=guyuntao remote=true` 已落盘；页面 `/ws/ws-01f2bfda` 返回 v4.6.12 新代码。
- **重打包 1.0.11**：版本三处同步（package.json / README / 角标 v4.6.12）→ 双产物 `teamwork-cli-1.0.11.tgz`（109KB）+ `.zip`（124KB）；包内 11 项内容检查全 PASS；SOP 升级（stop --force → install → version 1.0.11 → start）全程无恙，重启副作用照旧（token 失效）。注意：**server 代码改动需重启生效**（不同于纯静态 html 热刷），旧 Node fetch+process.exit 有 libuv 退出断言竞态（验证脚本自身的噪音，与 server 无关）。


### v1.0.12（2026-10-15，Leader 指定人发布 → 跨机收件箱重建 → 指定人 AI 自动唤起——designee 全链路）



- **报障（用户原话）**：「当Leader指定人发布任务时，该指定人名用的是临时登陆名字，但实际测试过程中，没在指定人的AI侧对话窗口自动唤起MCP hook提示新任务」。
- **根因（三层断点，分布式 v4.7.1 形态叠加）**：① **指定人无处安放**——MCP `publish_task` schema 无 assignee 参数（subtasks items 亦无字段描述），server 端创建子任务 `assignee: null` 硬编码，「指定人」只存在于描述文本里系统无法识别，更无法把临时名跨机解析成身份码；② **收件箱是纯本机内存且跨机不重建**——`injectTask` 只遍历**本机** `ws.members`（跨机成员不在表），v4.7.2 `[task]` 行虽让 B 机恢复了 tasks 表但**恢复端不重建 `ws.inbox`**——B 机 AI 调 `inbox_status` 永远空；③ **B 机无周期云拉取**——inject 文件（每 3s 渲染）源=本机收件箱（空则成员段跳过），`cloudSyncOnce` 只在 join/restore/open-ends 触发——B 机不开浏览器时收件箱永远陈旧。
- **修复①（指定人结构化：designee 三处）**：MCP publish_task schema 加 `assignee`（临时登录名 / 身份码 u-xxx / `名字(u-xxx)`）；server 新增 `resolveDesignee(ws, expr)`（身份码直用 / 括号格式提取 / 纯名反查 users 表含 v1.0.11 remote 回填）；publish_task 消费 `subtasks[].assignee` → `t.designee`（assignee 保持拾取语义），返回 `designated`（解析成功 `名字(身份码)`）+ `unresolved`（失败回退画像注入并提示 Leader AI 转告）；拆分器 `splitTaskWithAI` roster 补成员名 + prompt 输出格式加 `assignee`（描述点名某人时必填——Leader AI 对话「让阿哲做 X」自动落到子任务）。
- **修复②（跨机传播：`[task]` dsg 字段）**：`toTaskLine`/`parseTaskLine`/`taskSig` 纳入 designee（`dsg:` 字段，asg 后 what 前——旧版行无 dsg 解析为 undefined 保留 local，向后兼容；1.0.11- 旧包读新行忽略未知段不炸）。
- **修复③（恢复端收件箱重建——核心）**：`cloudSyncOnce` ②段新建/更新分支应用云行后调 `injectTask(ws, tk.id)`（内部守卫 `status==='ready'` + inbox 去重 + designee 定向：designee=本机用户→投 / 他人→不投 / 无指定→本机画像匹配或全员兜底多投）；③段依赖解锁 sweep 同补（跨机对端 done 解锁 → 本机收件箱出现后继任务）。
- **修复④（B 机感知通道两处）**：`inbox_status` handler 加云对齐兜底（同 open-ends 模式 15s 节流——AI 每次查询收件箱先拉云）；**inject 引擎每 3s 周期触发 `cloudSyncOnce`（fire-and-forget，15s 节流内置于 ws._lastCloudSync）**——B 机 server 常驻即周期拉云，收件箱更新 → inject 文件 3s 内刷新 → AI 按 rules 强制协议「每次回复前读 inject 文件」看到「待拾取任务」自主 ack（TRAE 无钩子宿主形态下"自动唤起"的最大可达闭环）。
- **修复⑤（指定是强约束）**：`ack` 非指定人 → 409「该任务由 Leader 指定给 名字(身份码)，如需接手请联系 Leader」；`open-ends` 过滤 `(!t.designee || t.designee === user)`（指定任务不出现在他人继承菜单）+ 返回 `designee` 纯名标记。
- **验证（三层）**：冒烟 16/16（dsg 往返/旧格式兼容/taskSig 变化/清洗）；**双实例 E2E 15/15**（A 发布 `assignee:'memB'` 纯名 → designated=`memB(u-memb1012)` → [task] dsg 上行 → B join(wsName) 云对齐 → **B 机收件箱出现指定任务（日志 `[inject] ST-4 指定注入 u-memb1012（designee）`）** → B inbox_status 命中 designated → inject 文件 memB 段含待拾取 → memC ack 409 → memB ack/report_done 200 → A 拉云 ST=done+asg 传播 → memC open-ends 守卫）；包内 11 项内容检查全 PASS。SOP 升级（stop --force → install 1.0.12 → start）无恙。
- **E2E 排坑（v4.7.2 方法论再确认+新增两条）**：① 跨机 join 必须用 `wsName`（B 机 state 空——`wsId` join 只查本机表必 404「请输入工作组名称」；MCP `teamwork_join(wsName)` 是跨机正路）；② **E2E finally 的 delete 是 async**——kill server 前必须等 ~8s 让飞书目录删除完成，否则残留目录撞名（ensureFolder 幂等复用旧目录 → B 读到旧 config 的组 ID → 「工作组不存在」连环假 FAIL）；③ 单机双实例共享 `~/.teamwork/inject-{wsId}.md` 同一路径（A/B 实例每 3s 轮写）——inject 文件断言需采样多次；④ 观测时序竞速再现：done 传播断言改轮询 5×5s（doSync 节点段在前 [task] 段在后）。
- **设计语义**：designee 是「意向」（Leader 指定谁做），assignee 是「事实」（谁 ack 了）；指定任务被他人 ack 拒绝但 Leader 可换指定（新 [task] dsg 行传播）；指定人长期不拾取由既有租约/心跳回收兜底。**成员必须装 1.0.12+**（旧包：无 dsg 解析/无收件箱重建/无周期对齐——指定人永远收不到）；飞书 API 压力：每机每 OPEN 组 ~15s 一次 pull（与浏览器开时 20s restore 轮询同量级）。
- **MCP 文本视图（open-ends 的 designee）保持纯名**——AI 消费 token 敏感（同 v1.0.11 裁定）。


### v1.0.7（2026-10-15，崩溃根因修复：join 恢复副本缺 consensus → 一个请求杀掉整个 server）

- **动因（真实踩坑：成员机 Leader 发布任务后，用户仪表盘不更新，刷新页面「localhost 拒绝连接」）**：`server-error.log` 铁证 `[crash] 未处理 Promise Rejection: TypeError: Cannot read properties of undefined (reading 'items') at index.js:1122`（GET consensus）。三层叠加——① join 从飞书恢复的工作组副本对象**缺 `consensus` 字段**（loadState 只补磁盘恢复的组，运行时 join 新建的副本绕过）→ ② GET consensus handler 裸读 `c.items` 抛 TypeError，且 `createServer(async ...)` **无顶层 catch** → ③ `unhandledRejection` 处理器选择 `gracefulShutdown` **杀进程**。任一 handler 异常 = 整个 server 死亡 = 浏览器「拒绝连接」。
- **改动 1（根因）**：join 恢复副本补 `consensus: { ver: 0, items: [] }`（与本机建组结构对齐）。
- **改动 2（结构守卫 `ensureWsShape(ws)`）**：统一补全 consensus/tasks/nodes/members/inbox/locks/skills/checkpoints/seq 缺省值，挂三处——`/api/ws/:id/*` **公共路由入口**（所有请求必经）、join 副本构造、loadState（原 v4.3 仅补 consensus 的逻辑升级为全字段）。
- **改动 3（handler 薄壳兜底）**：createServer 回调体提取为 `async function handleApi`，外层 `.catch` 统一转 **500 JSON + `[handler]` 日志留痕**——任何 handler 异常不再升级为进程死亡。
- **改动 4（进程级 fail-open）**：`unhandledRejection` 从「gracefulShutdown 杀进程」降级为 `[rejection]` 日志（含完整 stack）；`uncaughtException` 保持退出（真正不可恢复场景）。与 doSync 已有 `.catch` fail-open 设计意图一致。
- **验证（前后对照，同探针）**：探针 = `POST publish_task` 缺 description（天然炸点 `description.slice`）。**1.0.6**：请求连接被重置，2s 后 `:8787` 无监听（进程死亡，复现用户症状）；**1.0.7**：返回 500「服务器内部错误（已记录，server 存活）」+ `[handler]` 日志留痕，server 持续存活。
- **附带发现**：stderr 与 stdout 分文件落盘（server-error.log / server.log）——排障时**两个都要看**，`[crash]`/`[rejection]`/`[handler]` 堆栈在 error 侧。
- **运维 SOP**：成员机升级 `npm install -g teamwork-cli-1.0.7.tgz` → `teamwork version`（须 1.0.7）→ `teamwork stop --force; teamwork start` → 刷新页面即可（不需要重新登录，token.json 仍在）。


### v1.0.6（2026-10-14，排障利器：错误透传 + teamwork doctor 一键自检 + 版本号消歧）

- **动因（新机器新成员装 1.0.5 建组仍报「飞书目录创建失败」）**：两个结构性排障障碍——① `ensureWorkspaceFolder` 内部 catch 吞错 return null → index.js 落入笼统文案「凭据不可用或权限不足」，真实根因（Node<18 无 fetch / 网络断连 / 凭据 code 错 / 坏 feishu.json 压内置）全被掩盖，只能翻 server.log；② 1.0.5 同版本号打包多次（17:08/17:17 内容不同）——成员机 `teamwork version` 无法分辨装的是新旧包。
- **改动 1（错误透传）**：`feishu-sync.js ensureWorkspaceFolder` catch 不再 return null 改 `throw e.message` → 502 响应直接携带真实根因；笼统分支文案追加「请运行 teamwork doctor 诊断」。
- **改动 2（`teamwork doctor` 一键自检）**：`bin/teamwork.js` 新增 case + `feishu-sync.js` 新增 `export async function diagnose()`：① Node 版本/全局 fetch（<18 飞书请求全失败）② 凭据链生效来源探测（env / feishu.json（含坏文件检测）/ 内置；feishu.json appId≠内置时提示删除回退）③ tenant_token 真实直连 + code 码翻译建议（10003/10014=secret 错、99991663=appId 错、fetch 异常=网络/代理/白名单）。
- **改动 3（版本消歧）**：升 1.0.6——新成员机 `teamwork version` 一眼确认新包；README CLI 表 / cmdHelp / INSTALL 模板同步（含 v1.0.6 修正的 help 旧链路「copy & paste teamwork link」→ 真实链路「登录页 → 大厅 → 创建/加入 → setup」）。
- **验证**：doctor 双场景（好凭据全绿 tenant ok；坏凭据精确报 `code=10003 invalid param` + 来源 + 建议）；`:8787` 旧 1.0.5 进程 `stop --force` 释放 → 全局装 1.0.6 → 全链路 PASS（注册 doctor-test → 建组 DoctorTest0617 `ws-86be058d` 飞书目录真实创建（log：`操作者身份: doc-test-1`——未绑定个人身份走 tenant 通道，即新成员零授权场景）→ 删除清理）。
- **新成员机排障 SOP**：`teamwork version`（须 1.0.6）→ `teamwork doctor` → 按建议修复（Node 升级 / 删坏 feishu.json / 网络放行 open.feishu.cn:443）→ 建组报错文案已含真实根因。

### v1.0.5（2026-10-14，企业可用范围「仅个人级」策略适配——凭据内嵌包内，成员「装完即用」，个人身份降级为可选增强）

- **动因（真实踩坑：新成员徐景波 feishu-auth 被拒「你没有 Workspace 的使用权限」）**：飞书自建应用每个版本需配置**可用范围**，企业策略锁死「只能个人级」（不能全员/部门）→ 每来一个成员需管理员后台逐人加白名单；且成员在 feishu-auth 之前机器无任何凭据（凭据是 feishu-auth 落盘的）→ 「先建组报没飞书权限」的死锁时序
- **凭据三件套内嵌默认值（feishu-sync.js）**：兜底链升级 `env > ~/.teamwork/feishu.json > 内置常量`（appId/appSecret/rootFolder）——README/INSTALL 本就明文分发同值，内嵌无额外暴露；新成员装包 start 后 **tenant 通道零配置可用**（建组/加组/同步/NodeMap 全通）
- **README/INSTALL 流程重排**：第 3 步「创建或加入工作组（装完即用，无需飞书授权）」；第 4 步降级为「可选增强：绑定个人飞书身份」（云文档归属个人）+ 前置标注「管理员需先把你加入应用可用范围」
- **验证（全新装机模拟）**：临时 USERPROFILE 指向空目录（无 .env 无 feishu.json 无 state）→ server 起 → `tenant_token 获取成功` + `凭据就绪（根目录显式配置 <folder-token>）`——开箱即用 PASS；附带 legacy user_token 跳过逻辑实测生效
- **运维教训（持久 shell 环境污染）**：测试时 `$env:USERPROFILE = 'D:\temp-newuser'` 设在**持久 PowerShell 会话**中未清 → 之后 spawn 的所有 server（secret/pid/log/state）全写进临时目录（已删则静默重建）——表现为「服务正常但文件全消失」假象；修法：环境变量用后即清 `Remove-Item Env:XXX`，spawn 类运维命令后必须验证 secret/pid/log 落位


### v4.7.3（2026-10-14，feishu-auth 真实 OAuth 三轮实测排障 + 全局安装凭据/数据落位闭环）
- **refresh_token 之谜定案（三轮真实 OAuth 实验）**：飞书 v2 `oauth/token` 授权码模式**必须显式申请 `offline_access` scope**（OIDC 标准）才返回 refresh_token——① 不传 scope → 只发 `auth:user.id:read` 最小登录 token、无 refresh（v4.1 demo「v2 无 refresh_token」+ 今日首次实测同因）；② 传 `drive:drive docx:document`（业务 scope）→ scope 到手但**仍无 refresh**；③ 加 `offline_access` → **refresh_token + refresh_token_expires_in(604800=7天) 到手**。修 CLI：`SCOPES='offline_access drive:drive docx:document'`；access ~2h + refresh 7 天滚动续期（每次续期轮换新 refresh_token，活跃用户永续；>7 天闲置需重授权）——文案同步修正（原「~30 天」是 demo README 抄来的错误期望值，从未实测过）
- **全局安装凭据断链修复**（用户真实踩坑：server 从 `node_modules\@teamwork\cli` 启动无 .env → 凭据全空 → tenant 通道 + refresh 续期（需 client_id/secret）双断）：`feishu-sync.js` 凭据兜底链 `env > ~/.teamwork/feishu.json`（feishu-auth CLI 首次运行自动持久化 appId/appSecret——成员机跑过一次授权即凭据闭环，**.env 分发形态彻底终结**）；`rootFolder` 一并兜底（无它则个人身份建组/搜组必失败）；读文件容错**剥 BOM**（PowerShell 5.1 `-Encoding UTF8` 写 BOM 版，JSON.parse 直接炸——实测踩坑）；legacy demo 通道无 refreshToken 时跳过续期尝试（不再每次启动必报错）
- **state 落位修复**：默认 `TEAMWORK_STATE_FILE` → `~/.teamwork/state.json`（旧默认=包根 state-v4.json 在全局安装时位于 node_modules 内，**npm 升级即丢全部用户/工作组/绑定**）；一次性自动迁移（新路径不存在且旧路径有 state → 拷贝，原文件保留）；开发模式 `npm start` → `scripts/dev-start.mjs` 钉回仓库 state（防开发数据与生产 home state 互串）
- **CLI feishu-auth 增强**：`--root-folder <token>` 参数（随凭据一并持久化 feishu.json）——Leader 分发命令变为 `teamwork feishu-auth --app-id .. --app-secret .. --root-folder ..`；换 token 响应缺 refresh_token 时显式警告
- **验证（模拟全局安装环境：cwd=TEMP 无 .env + 临时 state + 8899 端口）**：`[feishu] env 未配置，凭据兜底自: ~/.teamwork/feishu.json` → `tenant_token 获取成功`（真连飞书）→ `凭据就绪，同步引擎已激活（根目录显式配置 <folder-token>）`——全链路 PASS
- **发包（1.0.4）**：v4.7.3 全量；1.0.3 有缺陷（feishu-auth 无 scope——成员绑定 2h 即废）不作分发，已归档 dist-archive/
- **首次真实用户绑定（Leader 本人）**：OAuth 全链路 + server 落库（feishuName「励晓烽」openId ou_207f...）+ 根目录共享（「已有」——v4.6.9 统一管理时代 batch_create 共享过同一 openId）

### v4.7.2（2026-10-14，跨机任务协作上云——`[task]` 状态流持久化 NodeMap.md，B 机重放恢复 tasks 表；join 撞车 + 继承链产出闭环修复）
- **缺口确认**：v4.7.1 分布式形态下 `pullAllNodes` 只恢复 nodes+ops，**tasks 表从不上云**——B 机 join 后看得到 A 机的「发布」节点却无法 open-ends/继承（任务状态机是纯本机实时态）
- **`[task]` 行设计（feishu-sync.js）**：任务快照序列化为单行 `[task] <id> | st: | asg: | par: | dom: | pri: | deps: | when: | by: | acc: | what:` 追加进 NodeMap.md——**Append-Only 状态流，行序即时间序，恢复端后行胜**；`taskSig(t)`（状态|归属|依赖|标题）对比驱动增量上行，`markTaskSynced` 仅对**实际应用了云行的任务**标记（无条件标记会让被本机保护跳过的任务新状态永不上行）
- **恢复端重放（cloudSyncOnce，从 restore handler 重构为模块级）**：`pullAllNodes` 解析 `[task]` 行返回 tasks → 三重本机保护（持锁不覆盖 / 本机 done 不被旧行回退 / `_tsq` 行序去重）+ 依赖解锁 sweep（对端 done 经云传播 → 本机 blocked→ready）+ seq 对齐（B 机新发 id 不撞车）；**open-ends 加云对齐兜底**（B 机 AI 不开浏览器也能见云任务）；15s 节流（force 绕过——restore 前端 20s 轮询保真拉）
- **join ID 撞车修复（index.js）**：B 机 join 在云 seq 对齐**之前** push 自己的 N-1 → 与 A 机 milestone N-1 撞车（A restore 后本地节点被云骨架覆盖错乱）——修法：join「⑥ 本地不存在从飞书恢复」分支建完 ws 副本后**立刻 `cloudSyncOnce(force)` 云对齐**（拉回节点/[task]/seq）再 push 加入节点（join 节点从 `N-seq+1` 起）
- **继承链产出闭环（既有语义缺陷，本机同型）**：`inherit` 只设 `assignee/lease` 不设 `locks`，而 `report_done` 严格要求 `locks[taskId]===user` → 继承者报完成恒 403（v4.3 起继承链闭环断裂）——锁判定放宽为「持锁 **或** 是当前 assignee」
- **scan 云任务守卫**：`assignee` 非本机成员 → 不裁决活性不回收（防 A 机 15s scan 误回收 B 机正在跑的任务）；同修 v4.4.1 同型缺陷：心跳/租约回收补 change 节点 + `triggerSync`（原回收只改状态无审计无上云）；建组 milestone 即时上云
- **本轮续修（E2E 深挖）**：① doSync 节点上传段 `uploaded++` 重复行（双计数，日志「上传 2」实际 1 节点）② **`setPersistHook` 落盘钩子**——doSync 改 `n.sync='synced'`/`taskSyncSigs` 后从不落盘，重启后签名丢失 → 同状态 `[task]` 行重复上行；现 index.js 注入 `scheduleSave`（`setUserLookup` 同款注入模式）③ `tasksApplied` 计数补上「已有任务状态更新」分支（原只计新建+解锁，E2E 曾因返回值 0 误判"未传播"）
- **双实例 E2E（全 PASS）**：A(8787) 建组 e2e-v472b + 发布（中文 UTF-8）→ B(8788/TEAMWORK_STATE_FILE 隔离) join **即云对齐**（tasks 全恢复、依赖链 deps 完整、中文完美、join 节点 N-6 起不撞车）→ B open-ends 见 ST-4 → inherit（身份 general/N-7）→ report_done（解锁 ST-5）→ **A restore 拉回重放：ST-4=done+asg、ST-5=ready、节点 N-6/N-7/N-8 全传播** → 负向：A 重启再 restore 状态不回退（`_tsq` 行序）+ taskSyncSigs 落盘防回声
- **排查方法论沉淀**：① 「A restore tasks=0」初判 bug 实为**观测时序竞速**——A 的 restore 恰落在 B doSync「节点已上云、[task] 未上云」的中间窗口（doSync 节点段在前 [task] 段在后）+ 计数低估，云数据无损，20s 轮询自愈；② **PowerShell 5.1 `Invoke-RestMethod` 无 charset 时按 Latin1 编码 body**——中文变问号是测试客户端问题（server 无辜），`[System.Text.Encoding]::UTF8::GetBytes` + `charset=utf-8` 修复；③ **run_commands 的 PowerShell 会话跨命令持久**——`$env:PORT='8788'` 污染后续所有子进程（「A 机起不来」真凶：起的全是 8788），cmd 内 `set "PORT=8787" && set "TEAMWORK_STATE_FILE="` 显式覆盖；④ cmd `set X=Y && ...` 尾空格入值（文件路径带尾空格读不到）——`set "X=Y"` 引号形式必用
- **发包（1.0.3，2026-10-14）**：v4.7.2 全量——产物 `dist/teamwork-cli-1.0.3.tgz`（97KB）+ `.zip`（110KB），1.0.2 旧包已备份至 `dist-archive/`；本机全局已装并抽查安装副本（setPersistHook 注入 / join 云对齐 / 继承者锁 / toTaskLine / parseTaskLine 全在位，`teamwork version` → v1.0.3）；成员必须装 1.0.3+ 才有跨机任务协作（1.0.2 及以下 join 后看不到云端任务表）
- **遗留**：① 飞书后台 Leader 配置（回调 URL `http://localhost:9916/callback` + 用户权限点）与 Leader 亲跑 `feishu-auth`（v4.7 遗留）② ~~1.0.2 tgz 不含 v4.7.2，需评估重打 1.0.3~~（已发 1.0.3）③ `[task]` 行不携带 doneSummary（完成叙事在 N-8 完成节点，full 恢复可取——设计取舍）④ 跨机延迟语义：B 完成后 A 最长 ~25s 可见（B triggerSync 1.5s+doSync 多次飞书 API + A 20s 轮询），分布式最终一致可接受

### v4.7.1（2026-10-14，部署形态裁定：分布式——每人本机跑 server，飞书云文档是唯一共享层；收回 v4.6.9 中心化默认）
- **用户裁定**："不应该有成员来访问我本机的 ip+端口"——否决 v4.6.9 的中心化默认（全员连 Leader 机的 0.0.0.0:8787）。目标形态：**每个安装者本机跑自己的 server（localhost:8787），跨机共享全部走飞书云文档**（工作组目录 / 记忆 / 共识 / 云恢复）；任务协作（发布→收件箱注入→ack 抢锁→解锁）是**本机多 AI 实例间**的事，天然不跨机
- **改动（server/index.js 一处）**：`HOST` 默认值 `0.0.0.0` → **`127.0.0.1`**——server 仅本机可连，成员从网络层就不可达（防火墙放行与否都不再暴露）；`HOST=0.0.0.0` env 显式指定可恢复中心化（v4.6.9 模式转 opt-in 逃生门）；启动横幅标注当前监听模式
- **踩坑（dotenv 覆盖代码默认值）**：改完代码默认值后实测仍监听 0.0.0.0——根因 `.env` 里残留 v4.6.9 时代写入的 `HOST=0.0.0.0`，`import 'dotenv/config'` 注入 process.env 优先于 `|| '127.0.0.1'` 兜底 → **已删除 .env 该行**（要开中心化时显式写回即可）；另 npm i -g 装 tgz 必须给**绝对路径**（相对路径被 npm 解析成 git 仓库地址 `ssh://git@github.com/...` 报 code 128）
- **天然正确无需改的点**（逐项核实）：① `feishu-auth` 上报地址回退链 `--server > token.json.server > 127.0.0.1:8787`——成员 token.json 无 server 字段 → 默认 localhost ✅ ② `mcp/index.js` SERVER_URL 三级回退同上 ✅ ③ `lobby.html` linkCmd 的 `--server '+location.origin` 只在**远程浏览器访问**时出现的分支——本机模式下远程连页面都打不开，永远走 `localWrite` 本机分支 ✅ ④ v4.6.9 打通的 `--server` 参数链路全部保留（中心化 opt-in 时即用）⑤ 本机 isLocal 判定恒真 → token.json 自动写入恒生效
- **跨机语义（既有能力，代码零改动）**：成员 B 在自己 server 上「加入工作组」→ 以 B 的飞书身份从云搜目录 + 读 `_workspace.json` 验证密码（v4.7）→ 云恢复 `pullAllNodes` 拉全部节点/共识到本地 → 前端 `startCloudWatch` 每 20s 骨架增量对齐云端变更——**A 的 observe/share_memory 上云 → B 自动可见**，反向亦然；记忆上传以各节点作者身份（v4.7 per-node actor）
- **已知边界（语义如此，非缺陷）**：① 跨机无任务协作——B 本机 server 上的同名工作组是云镜像，B 的 AI 在 B 本机抢锁/解锁不影响 A 本机的任务链 ② 共识的"Leader 一票生效"——组 Leader clientId 不在 B 本机 server 上时，B 侧共识走"全员确认"路径 ③ 租约/心跳/收件箱均为本机实时态
- **成员接入流程（v4.7.1 定稿）**：① `npm i -g teamwork-cli-1.0.2.tgz` 装包 → `teamwork start` 本机起 server ② 浏览器 `http://localhost:8787` 注册/登录（本机自动写 token.json）③ `teamwork feishu-auth --app-id <id> --app-secret <secret>`（一次 ~30 天，绑个人飞书身份）④ 创建或加入工作组（跨机共享即时成立）——**全程零 .env、零外部 IP**
- **发包（1.0.2）**：v4.7 + v4.7.1 全量（feishu-auth / per-user 身份引擎 / HOST 默认本机）——成员必须装 1.0.2+（1.0.1 是中心化时代代码，无用户身份链路）；产物 `dist/teamwork-cli-1.0.2.tgz`（95KB）+ `.zip`（109KB），本机全局已装（`teamwork version` → v1.0.2）
- **验证（2026-10-14 实测）**：netstat `TCP 127.0.0.1:8787 LISTENING`（仅回环——外部网络层不可达）+ 横幅「▸ 监听 127.0.0.1（本机模式 v4.7.1——跨机共享走飞书云文档）」+ 本机 API 401（活着）+ state 19 用户/8 组完好恢复

### v4.7（2026-10-14，用户身份飞书操作——每个成员用自己的飞书账号操作共享目录，tenant 降为兜底）
- **需求（用户裁定，否决 tenant 统一身份方案）**：Workspace 应用（Leader 创建的飞书应用）的凭据（env：app_id/app_secret）分发给每个安装 teamwork 的人；所有使用者**用自己已登录的飞书账号**作为凭证，通过应用对共享飞书云文档目录（`TeamWork-Demo`，用户裁定沿用应用空间根目录 `<folder-token>`）下的工作组做**创建/加入/搜索/删除**与记忆上传——操作归属操作者本人，目录统一在 Leader 指定根目录下
- **架构（per-user token + 渐进兜底）**：
  - `feishu-sync.js` 凭据链改为 `getToken(actor)`：**操作者绑定过飞书 → 其个人 user_access_token（过期自动 refresh_token 续期 ~30 天）→ 未绑定 → tenant 兜底（渐进可用，绑定后自动切换）**；旧 demo 单一 user-token 文件通道降级 legacy
  - 根目录显式化：`.env` 新增 `FEISHU_ROOT_FOLDER=<folder-token>`——成员个人身份从"我的空间"**发现不了**共享根目录（不在其个人空间），必须显式 token（`rootFolderToken(actor)`：env 优先，缺失时按老方式发现兜底）
  - **操作身份矩阵**：建组=创建者身份（`ensureWorkspaceFolder(name, user)` + `_workspace.json` 同）；join=加入者身份读（`searchWorkspaceFolder`/`readWorkspaceConfig` 传 user）；删组=操作者身份；**记忆上传=每节点以其作者（`n.who`）身份**（`doSync` per-node actor）；共识快照/云恢复=组 Leader 或发起成员身份；全部未绑定 → tenant 兜底并在日志标注操作者
- **per-user token 存储**：`state.users[clientId].feishuToken = {accessToken, refreshToken, expiresAt, openId, feishuName, boundAt}`——**持久化在 state（server 重启不丢，与 2h session token 解耦）**；feishu-sync 经 `setUserTokenAccess(provider, saver)` 注入读写（续期自动回写）
- **新端点**（server/index.js）：`POST /api/feishu/token`（feishu-auth 上报）→ ① `user_info` 验证 token（实测假 token 报 `code=20005 invalid access token`）→ ② **tenant 自动把根目录共享给该用户 open_id（`perm:'edit'`，幂等）**——绑定即授权，个人身份才能在根目录下建组目录 → ③ 按用户落盘；`GET /api/feishu/status`（绑定状态查询，未绑定返回引导 hint）
- **新 CLI 命令 `teamwork feishu-auth`**（bin/teamwork.js，全局副本已同步）：
  - 应用凭据来源：`--app-id/--app-secret` 参数（首次自动持久化到 `~/.teamwork/feishu.json`）或该文件（Leader 分发物）
  - 流程：本地 9916 回调 → `authen/v1/authorize` 浏览器授权（用户自己的飞书账号）→ `authen/v2/oauth/token` 换 token（demo 实测链路：access ~2h + **refresh ~30 天**）→ 本地备份 `~/.teamwork/user-token.json` → 上报中心 server（Bearer 本机 token.json 的 session token）
  - **env 分发形态简化**：旧 feishu-setup.mjs（tenant .env 分发）正式作废——现在只需给用户一条命令：`teamwork feishu-auth --app-id cli_xxxx... --app-secret <secret>`（server 地址默认 localhost，见 v4.7.1）
- **E2E 回归（本轮实测）**：① v4.7 启动消息正确（根目录显式配置 + 用户身份模式提示）② 未绑定用户建组 `V47-FallbackTest` → tenant 兜底 + 显式根目录 → `feishuFolder=NBiGfy...` 建组成功（日志「操作者身份: cli_v47_verify_1」）③ `POST /api/ws/:id/delete` 删组+飞书目录删除成功 ④ `/api/feishu/status` 未绑定→引导 hint；假 token 上报→400 `user_info code=20005`——**全部通过，测试痕迹已清理**
- **用户侧前提（Leader 一次性配置，尚未做）**：① 飞书后台「安全设置 → 重定向 URL」添加 `http://localhost:9916/callback`（每用户本地 OAuth 回调用，demo 时代旧应用配过同款）② 确认新应用权限点**「用户身份」列**已开通（demo 旧应用开通过；新应用 `cli_xxxx` 开通云文档权限时若只勾了应用身份需补勾）③ 把 app_id/app_secret 分发给用户（feishu-auth 命令形式）
- **遗留**：① 浏览器 UI 的「绑定飞书」引导按钮未做（`/api/feishu/status` 端点已就绪，下版加）② 真实用户 OAuth 全链路（浏览器登录授权）需 Leader 本人在自己账号上跑一次 `teamwork feishu-auth` 验证（CLI 已就绪：无凭据提示/命令注册/全局副本均已验）③ 现有 8 组目录无需迁移——用户绑定（根目录共享 edit）后即可访问其下全部子目录

### v4.6.8（2026-10-14，根因修复：地图 SVG 被全局 CSS 误伤——`pointer-events:none` 导致一切鼠标交互从未生效）
- **根因（铁证）**：全局 `style.css` 的 `#svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}`（为 lobby 背景装饰 SVG 设计的规则）与 workspace.html 节点地图 `<svg id="svg">` **ID 撞车**——地图 SVG 整体不参与命中测试：`pointerdown/mousedown/dragstart/wheel` 监听器**从未收到过任何事件**（事件全部落在父级 `<section>` 上），preventDefault 无从谈起→浏览器默认行为（文字划选/菜单）照常出现、拖动/平移/缩放自 v4.6.6 起从未生效；全程零报错（JS 本身无任何错误），v4.6.7 两轮修复因此"看似无效"
- **修复**（`workspace.html` 页面级 CSS 覆盖，不动全局规则避免影响 lobby）：`#svg{position:static;inset:auto;width:auto;height:auto;pointer-events:auto;...}`——恢复 flex 流布局（absolute 铺满会盖住工具栏按钮）+ 开启鼠标交互；另加 `mousedown` 左键 preventDefault 保险（Chromium 下 pointerdown 的 preventDefault 不总能阻止文本选择）
- **验证方法（本轮新增，后续交互 bug 复用）**：无头 Edge（`--headless=new` + CDP 9223-9234）+ `Input.dispatchMouseEvent` 真实输入管线全链路实测：`elementFromPoint` 命中链诊断（节点中心命中 `circle` 而非 SECTION）+ CDP 拖动节点（transform 位移 = 屏幕位移/缩放比，数学正确）+ PINS localStorage 持久化 + 空白拖平移 + 滚轮缩放（节点上/空白均触发）+ 工具栏按钮可点性（不被 svg 遮挡）——**全部 WORKS，零运行时错误**；E2E：响应含 v4.6.8 徽标与 CSS 修复、lobby 全局规则原样保留
- **踩坑记录**：① CDP `Runtime.evaluate` 表达式必须单行（多行字符串字面量语法错）；② 测试坐标必须加 svg `getBoundingClientRect()` 偏移（视口坐标≠svg 内坐标，首测"平移/缩放 FAILED"实为点到工具栏）；③ 服务端 fetch 秒回≠浏览器环境正常，`elementFromPoint` 才是命中测试金标准；④ `fs.writeSync(1,...)` 强制同步输出防 node 管道缓冲吞日志
- **版本角标**：`v4.6.8`（强刷后工具栏可见，继续作为缓存判别铁证）
- **同步范围**：仅源码 `server/public/workspace.html`（全局 CLI 副本随下次 npm 发版整体带入）
- **发包（2026-10-14）**：npm 包 **1.0.1**（对应 v4.6.5~v4.6.8 全部修复）——`node scripts/build-package.mjs` 产出 `dist/teamwork-cli-1.0.1.tgz`（84KB）+ `.zip`（94KB）；本机全局副本已同步升级（`teamwork version` → **v1.0.1**，全局 workspace.html 与源码哈希一致）；顺带修复 `bin/teamwork.js` version 命令硬编码 `v1.0.0` 的问题——改为动态读 package.json（发版只改 package.json 一处）
- **打包踩坑**：① build 脚本每次运行先清空 dist——`--tgz-only`/`--zip-only` 单跑会**删掉另一半产物**，重打必须完整跑（默认双产物）；② PowerShell 管道过滤脚本输出中的 emoji（`Select-String '✅|⚠'`）会编码崩溃 exit 1——用 `| Out-Null` 丢弃输出；③ npm pack 会做换行规范化，全局安装文件与源码**哈希不同但内容一致**（去行尾比较 True）——验证用行为（`teamwork version`）或内容比对，别信裸哈希；④ `tar -tzf`/`tar -xOf` 是验证 tgz 内容的金工具（17 文件清单+单文件抽取无需解压）
- **飞书凭据分发脚本（新用户一键配置，2026-10-14）**：新装 1.0.1 用户创建工作组报"飞书目录创建失败（凭据不可用或权限不足）"——根因链：打包白名单**排除 .env**（防凭据入包）+ `server/index.js` 的 `import 'dotenv/config'` 读 `cwd/.env`（cmdStart `cwd:ROOT`=包根）→ 新用户包无凭据 → `feishu-sync.js` `getToken()` 返回 null。方案（两文件随 `scripts/` 白名单自动进下版包）：**`scripts/feishu-export.mjs`**（Leader 侧：读本机 `.env` 飞书凭据 + `demo/.local/user-token.json`，渲染单文件 `dist/feishu-setup.mjs` 分发）+ **`scripts/feishu-setup.template.mjs`**（新用户侧零依赖 Node≥18：`node feishu-setup.mjs [--dir <目录>]`——自动定位安装目录（--dir / cwd / `npm root -g`，package.json name 校验+BOM 容错）→ **upsert 合并 .env**（已有配置原样保留、同键替换、幂等）→ 令牌可用时写 `.teamwork-user-token.json` + `TEAMWORK_USER_TOKEN_PATH` → **真连飞书自检**（tenant_token 获取 / 令牌续期 / files.list 探测，三态 [OK]/[警告]/[失败]）→ 按 server 运行态提示 stop+start）。沙盒 E2E 全通：定位/合并保留/幂等/纯凭据降级/dotenv 模拟 server 读取 3 键全部 parsed=true
- **飞书凭据现状与治本路径**：① tenant 云文档权限（drive:drive）**尚未审批**（files.list 实测 code=99991672"Access denied"）→ 纯凭据模式下新用户建组**仍会失败**（本机靠 user_token 通道跑通）；② 飞书 authen **v2 授权码不返回 refresh_token**（v4.1 已记）→ user_token 仅 ~2h 窗口、无自动续期——应急分发 = "`cd demo && npm run user-auth` 授权 → 2h 内 export → 分发 → 新用户立刻跑"；**治本** = 飞书应用后台开通 `drive:drive` + `docx:document` → **创建版本并发布**（开通权限≠生效，必须发版）→ tenant 直通、凭据永续、不再依赖令牌窗口；③ 顺带 `.gitignore` 补 `dist/`（防含密钥的导出产物入 git）与 `state-v4.json`

### v4.6.9（2026-10-14，中心化部署模式——全员连 Leader 的中心 server，飞书云文档统一归属 Leader）
- **需求（用户裁定）**：任何新使用者创建的飞书目录都要建在 **Leader 的飞书云空间**（统一管理云文档区），而非各自本机各自凭据
- **架构落地**：全员（含新用户）的 MCP/浏览器都连 **同一个中心 server**（Leader 机，已监听 `0.0.0.0:8787`）——飞书操作全部发生在中心 server 进程内，身份 = Leader 的凭据（user_token 优先/tenant 通道）→ 所有工作组目录均建立于 Leader 的「我的空间/TeamWork/」下；新用户**零飞书凭据、零本地 server**（与 TaskDispatch-Design 4.6 裁定完全一致）
- **打通的 4 处代码**（此前 `teamwork link` 链路不携带 server 地址——远程用户 link 后 MCP 仍连 localhost 的断链）：
  1. `lobby.html` linkCmd 追加 `--server '+location.origin`（远程用户浏览器访问 `http://<中心IP>:8787` → 弹窗命令自带正确地址）
  2. `bin/teamwork.js` `cmdLink()` 解析 `--server <url>` → token.json 新增 `server` 字段 + 注入 `process.env.TEAMWORK_SERVER_URL` 给随后的 setup
  3. `mcp/index.js` `SERVER_URL` 三级回退：`env.TEAMWORK_SERVER_URL` > `token.json.server` > `127.0.0.1:8787`
  4. `scripts/setup.js` serverUrl 同样加 `tokenData.server` 回退（手动 setup 的远程用户也正确）
- **E2E 验证**：沙盒 HOME 隔离跑 `teamwork link <token> <wsId> <user> --server http://10.198.17.151:8787` → token.json 含 server 字段 + setup 输出/手动 MCP JSON 均带远程 URL 且零污染本机配置；MCP 回退单测（无 env→token.server / 有 env→env 优先）双通；LAN IP 模拟远程：`/api/workspaces` 401（未带 token 预期）+ `/lobby` serve 新版 linkCmd（静态文件每请求磁盘现读 → 改动即时生效）
- **新用户接入三步**：① 浏览器开 `http://10.198.17.151:8787` 注册登录 → 创建/加入工作组（弹窗出现）② 复制弹窗 `teamwork link ... --server http://10.198.17.151:8787` 命令在本地终端运行（写 token.json + 自动配 AI 工具 MCP 指向中心）③ 打开 AI 工具直接工作
- **遗留**：① Windows 防火墙 8787 入站规则需管理员手动添加（`netsh advfirewall firewall add rule name="TeamWork Server 8787" dir=in action=allow protocol=TCP localport=8787`）——本机→本机 IP 已验证可达，跨机需此规则；② 飞书身份现状：user_token 已过期（v2 无 refresh_token）→ **新用户 join 已有工作组不受影响**（join 不建目录），仅「创建新工作组」需 Leader 先 `cd demo && npm run user-auth`（2h 窗口）或等 tenant 权限审批发布；③ 上一节 feishu-setup 凭据分发脚本转为备用方案（中心化模式下不再需要给新用户发凭据）
- **终验（权限开通后，2026-10-14 下午）**：Leader 在飞书后台为**新应用**（`cli_xxxx...`，写入 teamwork/.env）开通全部云文档权限 → tenant 通道实测**全通**：tenant_token / files.list（**99991672 已消除**）/ create_folder / delete。端到端：临时身份真实创建工作组 `ws-f4a298d4` → server 返回 `feishuFolder=<folder-token>` → 飞书侧对账 `TeamWork-Demo/FeishuVerifyTest` 目录真实存在 → `POST /api/ws/:wsId/delete` 解散（`feishuDelete:"async"` 异步删飞书目录也通）→ 全部清理干净。**user_token 2h 窗口依赖就此终结**
- **统一管理达成**：tenant 建的目录归**应用空间**（非个人空间）→ 用 `permissionMember.batchCreate` 把根目录 `TeamWork-Demo`（`<folder-token>`）共享给 Leader（`full_access`）——Leader 飞书客户端「共享与我」可见全部工作组目录并完全管理；后续新建子目录自动继承可见性。**API 坑记录**：① 端点是 `/drive/v1/permissions/{token}/members/batch_create` + body `{members:[{member_type:'openid'|'email', member_id, perm}]}`（member_type 枚举**无 'user'**——传错报 99992402）；② 邮箱换 open_id 用 `POST /contact/v3/users/batch_get_id` + body `{emails:[...]}`（响应字段 `user_list` 非 users_list；GET find_by_email 是废弃路径）
- **重启副作用与新坑**：① session token 内存态——server 重启全员 token 失效（浏览器重登录即恢复，localStorage clientId 仍在；MCP 端 fail-open 引导重新 join）；② **`teamwork start`（全局 CLI）spawn 的是全局包副本**（cwd=全局目录）→ 状态/凭据与源码目录**分歧**（曾出现 0 用户/0 工作组的全新状态）——**从源码目录跑才是正解**（`cd teamwork && npm start` 或 `node server/index.js`，cwd=源码读 .env+state）——遗留待办：统一运行入口（长期方案=状态迁到全局副本 or CLI 加 --dir）
- **分发物状态**：`dist/feishu-setup.mjs`（凭据分发版）**作废**——中心化 + tenant 全通后新用户零凭据（上上节方案转为备用）
- **同步范围**：源码 4 文件 + 全局 CLI 副本 3 文件（bin/mcp/scripts 已 copy，`teamwork version` v1.0.1 验证过）；npm 发版后随包固化


### v4.6.7（2026-10-14，修复 v4.6.6 左键拖动失效——浏览器默认行为劫持；二轮：Pointer 事件统一 + 自诊断）
- **根因（一轮）**：`mousedown` 未 `preventDefault()` 且 SVG 未禁文本选择——节点标签 `<text>` 可被划选；产生选区后再按下拖动触发浏览器原生 HTML5 drag（拖拽鬼影），mousemove 被劫持，自定义拖动/平移完全失效（症状：左键拖动只"点出浏览器自带的选项"）
- **一轮修复**：`mousedown` 左键 `e.preventDefault()` + `dragstart` 兜底拦截 + `#svg` `user-select:none`（三前缀）+ 光标反馈（节点 hover `grab` / 拖动中全域 `grabbing`）
- **二轮修复**（用户反馈仍失效，服务端已 fetch 实测返回新版后）：
  - **Pointer 事件统一**：`mousedown/mousemove/mouseup` → `pointerdown/pointermove/pointerup`（鼠标/触摸/笔统一；触摸屏长按拖动不再被浏览器手势/上下文菜单劫持）+ `pointercancel` 清理 + `#svg` `touch-action:none`（触摸手势归页面接管）
  - **版本角标**：工具栏 `v4.6.7` pill——强刷（Ctrl+F5）后一眼确认浏览器加载版本（排查缓存的铁证）
  - **自诊断**：`window.onerror`/`unhandledrejection` → 页面底部红条 + console——运行时错误显式暴露，事件绑定失败立即可见
- **诊断记录**：netstat + Win32_Process 确认 8787=PID 20760=`node teamwork/server/index.js`（源码入口，每次请求磁盘现读）；fetch 实测返回 v4.6.7；磁盘旧版位于 `node_modules/@teamwork/cli/`（未被 serve）
- **同步范围**：仅源码（全局 CLI 副本随下次 npm 发版整体带入）

### v4.6.6（2026-10-14，节点地图交互优雅化——平移修复 + 滚轮缩放顺滑 + 左键拖动节点微调位置）
- **需求背景**：主流程节点地图只能整体平移/缩放，无法移动单个节点的显示位置；且旧实现 `mousemove` 平移分支漏调 `draw()`——左键拖画布时画面不刷新，平移实际不可感知
- **修复 + 增强**（`server/public/workspace.html`）：
  - **修复平移不重绘**：平移/拖节点均重绘，经 `drawSoft()` rAF 合帧（每帧最多一次全量重绘，大图拖动顺滑）
  - **节点拖拽**：`mousedown` 左键分流——命中节点本体 → 拖动该节点（世界坐标位移 = 屏幕位移 / 缩放比，与缩放状态正确联动）；展开钮/空白 → 平移画布；`e.button===0` 仅左键；拖动 >3px 位移吞掉后续 click/dblclick——单击选中/双击报告不受影响
  - **位置持久化 PINS**：松手即存本机 `localStorage`（按 wsId 分键）——视图层个人偏好，不进服务器 state、不影响其他成员；`layoutAll()` 自动布局 + 碰撞消除完成后 `applyPins()` 覆盖应用（不可见节点的 PINS 保留，展开后仍生效）；「🧹 重置布局」按钮清除全部手动位置恢复自动排布
  - **动画防闪烁**：`draw(anim)` 新增 `draw(false)` 抑制 `nm-pop` 入场动画——纯视图变换（滚轮缩放/平移/拖节点/适配/聚焦）不再全图重放 pop 动画；结构变化（展开/收起/刷新）保留动画
- **同步范围**：仅源码 `server/public/workspace.html`（全局 CLI 副本随下次 npm 发版整体带入）

### v4.6.5（2026-10-14，服务生命周期管理——优雅停机 + 残留进程清理）
- **需求背景**：`teamwork start` 后台挂起（detached daemon）的服务被停止时（CLI `stop` / 前台 Ctrl+C / 崩溃），旧实现是硬杀——state 防抖窗口（2s）内的变更丢失、飞书同步 pending 任务无人终止、PID/端口/进程残留（用户曾遇到 8211/8787 双实例 + 孤儿进程散落）
- **Server 侧**（`server/index.js`）：
  - `saveNow()` 从防抖回调抽出为同步落盘函数——`gracefulShutdown()` 停机时立即 flush（防抖窗口内变更不丢）；`scheduleSave()` 行为不变
  - `gracefulShutdown(reason, code)`：flush state → `stopSync()` 终止飞书同步 → SSE 广播 shutdown → `server.close()` → 清理 PID/secret 运行时文件 → `process.exit`
  - 四进程钩子：SIGINT/SIGTERM（前台 Ctrl+C / Linux 主路径）+ uncaughtException/unhandledRejection（**崩溃也走善后**，日志留痕 + 非零退出）+ `exit` 兜底（任何退出路径保证 flush + 清运行时文件）
  - `POST /api/shutdown` 端点：仅 127.0.0.1 + secret 握手（server 启动写 `~/.teamwork/server.secret`，防 HOST=0.0.0.0 下远程误停）；响应 flush 后 150ms 退出；**响应后必须 return**（穿透后续路由会 ERR_HTTP_HEADERS_SENT 误触崩溃钩子——实测踩坑）
  - listen 回调写 `~/.teamwork/server.pid`（CLI spawn 已写同值，幂等；手动 `npm start` 实例也获得登记）
  - `STATE_FILE` 支持 `TEAMWORK_STATE_FILE` env 覆盖（多实例/测试隔离）
- **feishu-sync.js**：新增 `stopSync()` 导出（置停机标志 + 清 `_timer`/`_consensusTimer` pending 防抖任务）；`triggerSync`/`triggerConsensusSync`/`doSync`（含忙时重排）全部检查 `_stopped`——停机后不再上传
- **CLI 侧**（`bin/teamwork.js`）：
  - `stop`：① HTTP `/api/shutdown` 优雅握手 → ② 轮询进程退出（5s）→ ③ 兜底 `taskkill /T /F` **杀进程树**（优雅失败/旧版 server 时连残留子进程一并清理）
  - `stop --force`：PowerShell CIM 按命令行特征（`server[/\]index.js`）全机扫描 teamwork server 进程（含其他端口孤儿）逐个树杀——PID 文件丢失/脱节时的终极清理
  - `start`：后台进程日志落盘 `~/.teamwork/logs/server.log|server-error.log`（**崩溃可查**）+ 端口占用预检（提示占用者 PID 与清理建议）+ `TEAMWORK_NO_BROWSER=1` 开关（CI/脚本不弹浏览器）
  - `status`：孤儿检测（登记实例之外的散落 server 进程列出 + 提示 `stop --force`）
- **实测**（24 项 E2E PASS，隔离环境：临时 USERPROFILE + 临时 state + 端口 8790/8791）：挂起启动/PID 登记 → 造数据立即 stop（**防抖窗口内 flush 落盘✓ + 优雅路径日志✓**）→ 进程退出/PID 清理/端口释放 → 幂等（重复 start 不重启/二次 stop 无害）→ 失效 PID 自愈 → 孤儿进程 `--force` 全机树杀+端口释放；崩溃链路（unhandledRejection → flush + 清理 + 退出）在修 return bug 时被真实触发并验证 ✓
- **补丁（同日）：停机时长不计入心跳/租约计时**——`loadState()` 重启恢复时把成员 `lastSeen`（>0）与运行中任务的 `lease.lastActivity` 重置为当前时刻（`lease.since` 继承审计时间不动）。修复「服务器停机 → 重启 → Leader 启动工作区 → 第一轮扫描即以 `now - lastActivity` 判超时，把**停机前活跃的成员/租约冤枉回收**」（回收审计节点「租约超时回收」反复刷屏、成员被要求反复重新继承的直接根因）；覆盖所有重启路径（优雅停机/崩溃/硬杀/断电）。设计语义澄清：服务停止 = 全组 DORMANT（便携模式，成员失联≠退出——identity/token/任务归属/节点/共识全持久化，Leader 重开后原 token 无缝恢复）；租约超时回收入图是**审计节点**（区别于不入图的心跳回收），历史记录常驻流程页属设计行为
- **范围说明**：源码 `server/index.js` + `server/feishu-sync.js` + `bin/teamwork.js`（全局 CLI 副本为旧版分叉，下次 npm 发版以源码整体带入）；多实例共享 `~/.teamwork/server.pid|server.secret` 为已知局限（后启动者覆盖，exit 仅删自己的登记）

### v4.6.4（2026-10-14，工作组切换通知——页面切换工作组触发 MCP 侧提示）
- **需求背景**：Web 页面切换工作组（挂起旧的/创建/进入/启动新的）后，AI 对话端（MCP）的 token.json 仍指向旧组且**调用会静默成功**——AI 和用户都无从察觉切换，存在"以为在新组干活、实际操作挂起旧组"的错觉
- **机制**（复用 v4.6 静默注入通道，零 rules 迁移）：五个切换点（`create`/`join`/`close`/`reopen`/`enter`）记录 `wsEvents` 事件流（`{type: switch|close, wsId, wsName, by, at, prevName, auto}`，环形上限 50 条 + state-v4.json 持久化，**服务重启通知不丢**）→ `writeInjectFile()` 在 inject 头部渲染「🔔 工作组切换通知」（switch 通知保留 30 分钟，`TEAMWORK_WS_EVENT_TTL_MS` 可配）
- **渲染文案**（AI 读到即端侧提示）：switch →「已从「X」切换到本工作组「Y」…token.json 可能仍指旧组！请主动提示用户；如需操作本组：teamwork_join(wsId)」；close →「本组已被/因切换被自动挂起——任务快照冻结，MCP 调用会静默成功但操作的是挂起组」
- **关键细节**：① close（含 reopen/enter 暂存循环的**自动挂起**）同步补写终态 inject 文件——DORMANT 后引擎不再刷新，通知+任务快照常驻可读；② reopen/enter 暂存路径与 close 端点行为对齐（checkpoints + 事件 + 补写）；③ switch/close 同组多事件按最新一条渲染；④ `delete` 工作组顺带清理 inject 文件（防残留注入）
- **实测**（12 项端到端 PASS）：登录 → 创建（通知✓）→ 主动挂起（终态通知✓）→ 重启（switch 覆盖挂起通知✓）→ 双组切换（A 得「从 B 切到 A」✓ + B 得自动挂起终态通知✓）→ delete（inject 文件清理✓）
- **范围说明**：仅源码 `server/index.js`（全局 CLI 安装副本的 server 为旧版 ESM 分叉、无 v4.6 注入引擎，不移植——下次 npm 发版以源码为准整体带入）

### v4.6.3（2026-10-14，修复节点地图节点重叠——径向布局防重叠三管齐下）
- **根因**：径向布局固定半径 `RADII=[150…95]` + 子节点角度均分，与节点实际占位（圆 r26 + 展开钮 + 下方两行标签，标签最长 20 字符 ≈120px）不匹配：① 根下多任务时同层相邻弦距 62px << 标签宽 → 压盖；② 子孙节点挤在父节点分到的小扇区（半径仅 95）→ 圆叠圆；③ 深度 >5 半径全固定 95，跨子树后代互相侵入
- **修复（三管齐下，保留爆炸图风格）**：① 扇区按**子树叶子数加权**（`lw` 递归——子树大分更多角度）；② 基础半径自适应 `GROW=max(1,√(可见节点数/24))`——节点多时整体放大从源头稀释密度；③ **碰撞消除兜底** `relaxOverlap()`：按节点真实包围盒（宽度按标题字符类型估算：全角 11px/半角 6.2px，上顶 36 下底 70）跑 MPV 最小推离迭代（上限 1200 轮，前 80 轮 1.5x 超调加速膨胀，root 锚定不动）——**数学保证所有节点盒互不相交**
- **实测**（模拟 5 场景 × 多随机种子）：根下 15 子 / 3子×8孙 / 混合深树 / **随机 200 节点大树（6~14 轮收敛，0 重叠）** / 单链 12 层——全 PASS；修复前 200 节点 400 轮仍剩 40 对重叠
- **同步范围**：源码 + 全局 CLI 安装副本 `workspace.html`

### v4.6.2（2026-10-14，修复 lobby.html MCP 配置弹窗「完成」按钮无法关闭）
- **根因**：创建/加入工作组成功后 `showMcpSync()` 设 `MODAL='mcpSync'` 并把主按钮文本改为「完成」，但 `m-ok` 绑定的是 `doModal()`——其只有 `create`/`join`/`editConfig` 三个分支，`mcpSync` 无匹配 → 点击「完成」静默返回，弹窗无法关闭（仅「取消」/遮罩点击可关）
- **修复**：① `doModal()` 新增 `else if(MODAL==='mcpSync'){closeModal();}`；② `showMcpSync()` 隐藏「取消」按钮（信息引导弹窗仅保留「完成」），`showModal()` 统一恢复显示——其他表单弹窗不受影响
- **同步范围**：源码 `server/public/lobby.html` + 全局 CLI 安装副本（`@teamwork/cli`）；npm 包重装会覆盖副本，需随下次发版固化

### v4.6.1（2026-10-13，修复 lobby.html uiToast 缺失——MCP 配置复制按钮静默失败）
- **根因**：`copyMcpConfig()` 和 `copyLinkCmd()` 调用 `uiToast()`，但 `uiToast` 只定义在 `workspace.html`——`lobby.html` 中不存在 → JS 报错 → 按钮点击无反应
- **修复**：在 `lobby.html` 中新增 `uiToast()` 函数（inline toast 样式，与 workspace.html 同款）
- 飞书 user_token 过期提示：需重跑 `cd demo && npm run user-auth`（浏览器授权一次，~2h 有效）

### v4.6（2026-10-13，静默注入引擎——MCP 从被动调用改为自动触发）
- **核心变更**：MCP 工具不再依赖 AI "决定调用"——Server 后台自动写 inject 文件 + CLAUDE.md 强制协议 → AI 自动看到任务并执行
- **`startInjectWriter()`**：Server 每 3 秒写 `~/.teamwork/inject-{wsId}.md`（对齐 claude-mem Grok Bot live INDEX 模式）：
  - 每个 OPEN 工作组的每个有任务的成员：独立段（收件箱任务 + 进行中任务 + 共识 + 身份）
  - 无任务时不生成成员段（避免噪声）
  - Leader 兜底：无其他成员时 Leader 也接收任务（`injectTask` 修改）
- **CLAUDE.md 强制协议**：从"建议调用"升级为 **Mandatory**——"每次回复前必须读取 inject 文件 + 有任务时自主拾取 + 有产出时静默 observe"
- **setup.js RULES_CONTENT 更新**：同步强制协议（TRAE rules / .cursorrules 共用）
- **实测**：发布任务 → 3 秒内 inject 文件含「待拾取任务 ST-8」→ AI 读取 → 自动拾取 → 静默上报

### v4.5.3（2026-10-13，修复 MCP 配置 npx 引用——改用本地路径）
- **根因**：仪表盘弹窗 MCP 配置引用 `npx -y @teamwork/mcp`（npm 包未发布 → E404）
- **修复**：Server `POST /api/session` 返回 `mcpPath`（`mcp/index.js` 绝对路径）→ auth.html 存入 `localStorage('tw-mcp-path')` → lobby.html 用本地路径生成 MCP 配置（`command: "node", args: ["<实际路径>"]`）
- **仪表盘弹窗**：显示的 MCP JSON 现在包含正确的本地文件路径——粘贴到 TRAE/Claude Code/Cursor 直接可用
- **E2E**：4/4 PASS（npx 引用已移除 / node+本地路径 / localStorage 保存 / auth.html 传递）
- **`teamwork setup`**：已写入正确本地路径（不变）

### v4.5.2（2026-10-13，token.json 自动写入——登录/创建/加入时零手动）
- **Server `writeLocalTokenFile`**：登录(`POST /api/session`)/创建(`POST /api/workspaces/create`)/加入(`POST /api/workspaces/join`)成功后，检测请求来源为本机（127.0.0.1/::1）→ **自动写入 `~/.teamwork/token.json`**（含 token + user + wsId）
- **本机用户体验**：打开仪表盘 → 登录 → 创建/加入工作组 → **token.json 已自动写入，MCP 直接可用**——零手动文件操作
- **远程用户体验**：`isLocal=false` → 仪表盘弹窗显示 `teamwork link` 命令（复制到本地终端运行）
- **仪表盘弹窗重构**：
  - 本机用户：绿色框 "✅ token.json 已自动写入——MCP 无需手动配置 token"，只需配置 AI 工具 MCP（唯一手动步骤）
  - 远程用户：显示 `teamwork link` 命令 + MCP 配置
  - MCP 配置指引明确到每个 AI 工具：**TRAE**（设置→MCP→添加）、**Claude Code**（`claude mcp add`）、**Cursor**（设置→MCP→添加）、**任意宿主**（`teamwork setup` 自动检测）
- E2E：**5/5 PASS**——登录自动写入 token → 创建后 token.json 含 wsId → MCP 直接可用

### v4.5.1（2026-10-13，离线分发包——`npm run build` 一键生成 .tgz + .zip）
- **`scripts/build-package.mjs`**：一键构建离线分发包
  - `npm run build` → `dist/teamwork-cli-1.0.0.tgz` (72KB) + `dist/teamwork-cli-1.0.0.zip`
  - .tgz = npm 标准离线包：用户 `npm install -g ./teamwork-cli-1.0.0.tgz`（只需 Node.js，不需要外网）
  - .zip = 纯解压运行：`node teamwork-cli-1.0.0/bin/teamwork.js start`（零 npm 依赖）
  - 自动清理开发文件（.env / state-v4.json / node_modules / .git / dist）
  - 生成 INSTALL.txt 安装指南
- **实测通过**：`npm install -g .tgz` → `teamwork version` / `--help` / `start` 全部正常
- **README.md**：新增 3 种安装方式（npm 在线 / .tgz 离线 / .zip 零依赖）
- **package.json**：新增 `npm run build` script

### v4.5（2026-10-13，3 层渐进披露检索完整落地——对齐 AutoMemory 水准）
- **Step 1 `teamwork_search`**（已有，本次增强）：
  - `~tokens` 估算字段（知情检索决策——AI 看每条 token 成本决定是否深入）
  - `files` 分组（空间局部性——同文件的工作大概率需要同文件的上下文）
  - `hint` 引导（`timeline → get_observations` 3 层工作流）
- **Step 2 `teamwork_timeline(anchorId, depth)`**（新增）：
  - Server action + MCP 工具
  - 锚点 ID ± depth 的时间线上下文（按 when 排序的因果链）
  - 含叙事片段（~200 字截断——timeline 是上下文，不是全文）
  - 锚点标记 `isAnchor: true`；不存在 → 404
- **Step 3 `teamwork_get_observations(ids)`**（新增）：
  - Server action + MCP 工具
  - 按 ID 批量取完整详情（narrative/facts/concepts/files/injectedFrom/domain/source）
  - ≤20 ID 限制；不存在/已归档 → `missing` 数组
- **MCP 15 工具**（新增 2 个）：timeline + get_observations；search 描述更新为 3 层工作流引导
- **3 层渐进披露效果**（对齐 AutoMemory v4 实测数据）：
  ```
  Step 1: search        → 索引 ~50t/条（含 ~tokens）+ files 分组
  Step 2: timeline      → 锚点上下文 ~100t/条（叙事片段 + 因果链）
  Step 3: get_observations → 完整详情 ~200t/条（narrative/facts/concepts/files）
  总计: ~3,000t 全相关（vs 传统 RAG 25,000t 8% 相关）
  ```
- E2E：**16/16 PASS**（~tokens 估算/files 分组/timeline 窗口/锚点标记/时间序/叙事片段/详情完整/missing 处理/边界 404/MCP 15 工具）

### v4.4.4（2026-10-13，`teamwork link` 一键配置——消灭手动下载/移动 token.json）
- **新增 `teamwork link <token> <wsId> [user]` CLI 命令**：
  - 写入 `~/.teamwork/token.json`（自动创建目录）
  - 自动调用 `teamwork setup`（检测 AI 工具 + 写 MCP 配置 + 协作协议）
  - 一条命令完成全部配置
- **仪表盘弹窗重构**：从"下载 token.json + 手动移动 + 手动配置 MCP"改为 **"复制一条命令，在终端粘贴运行"**
  ```
  弹窗显示：
  ┌──────────────────────────────────────────┐
  │  🔧 配置你的 AI 工具                      │
  │  加入「my-project」成功！                  │
  │                                          │
  │  在终端运行（自动写入 token + 配置 AI 工具）│
  │  ┌─────────────────────────────┐ [📋 复制]│
  │  │ teamwork link eyJ... ws-x alice │       │
  │  └─────────────────────────────┘          │
  │                                          │
  │  ▸ 查看 MCP 配置详情（手动配置可选）        │
  └──────────────────────────────────────────┘
  ```
- **修复**：Windows ESM 动态导入路径（`file:///` URL scheme）；多余闭合括号语法错误
- **README.md 更新**：快速开始改为 teamwork link 流程

### v4.4.3（2026-10-13，npm 包完整化——CLI 入口 + 通用 Setup + README + LICENSE）
- **`bin/teamwork.js`**（CLI 入口）：`start`（spawn server + 等待 ready + 打开浏览器 + PID 文件管理）、`stop`（读 PID kill）、`status`（运行状态 + 同步统计 + MCP token）、`setup`（调 scripts/setup.js）、`help`、`version`——纯 Node 零额外依赖
- **`scripts/setup.js`**（通用 AI 工具 Setup）：
  - 多工具检测：TRAE（AppData/TRA/User/mcp.json）、Claude Code（~/.claude.json）、Cursor（~/.cursor/mcp.json）
  - 自动写入 MCP 配置（command=node + args=mcp/index.js + env=SERVER_URL）——实测 Claude Code 配置写入成功
  - 自动写入协作协议（teamwork-protocol.md → TRAE rules / CLAUDE.md → Claude Code / .cursorrules → Cursor）
  - 支持 `--trae / --claude / --cursor` 过滤单工具
  - 未检测到任何工具时输出 JSON 片段供手动配置
- **`package.json`**：名称 `@teamwork/cli`、bin 入口、files 发布清单、keywords、MIT License、engines >= 18
- **`README.md`**：快速开始 3 步 / 工作原理架构图 / CLI 命令表 / MCP 13 工具表 / 飞书云同步目录结构 / 部署指南 / 环境变量表
- **`LICENSE`**：MIT

### v4.4.2（2026-10-13，仪表盘加入/创建后直接触发 MCP 侧配置——免对话指令）
- **产品流程变更**：用户在仪表盘加入/创建工作组后 → 弹窗自动显示「🔌 MCP 同步」配置（不再需要在 AI 对话框中手动说"加入工作组 xxx 密码 xxx"）
- **弹窗内容**：
  - Step 1: `⬇ 下载 token.json`（一键下载，含 token+user+wsId）→ 保存到 `~/.teamwork/`
  - Step 2: `📋 复制 MCP 配置`（JSON 片段含 `npx -y @teamwork/mcp` + `TEAMWORK_SERVER_URL`）→ 粘贴到 AI 工具 MCP 设置
  - 完成后 AI 每次打开即自动在工作组协作——查收件箱、拾取任务、上报进度全静默
- **侧栏新增**：`🔌 MCP` 按钮（`showMcpSyncCurrent()`——已有工作组的用户也可随时调出配置）
- **lobby.html 新增函数**：`showMcpSync(wsId, wsName)`（弹窗渲染）/ `downloadTokenJson()`（Blob 下载）/ `copyText()`（剪贴板兼容）/ `showMcpSyncCurrent()`（侧栏入口）
- **创建/加入 handler**：成功后自动调 `showMcpSync(r.wsId, n)` 弹窗

### v4.4.1（2026-10-13，归档全链路修复——飞书同步 + 云恢复传播 + 事件节点入图）
- **根因**（三个并发缺陷）：
  ① 归档 handler 未调 `triggerSync(ws)` → 飞书 NodeMap.md 从未收到归档信息
  ② 未推送归档事件节点 → 主流程无归档痕迹
  ③ 每 20s `startCloudWatch` 骨架增量对齐拉回未归档状态 → 本地刚隐藏的节点被云端"恢复"回来
- **修复**：归档/驳回时推送事件节点（type=change，title=`⚖️ 共识归档/驳回：…`）携带 `revertedIds: [原共识节点id]`——复用 revert 墓碑机制：
  - 归档事件节点作为新节点上传飞书（独立 memory.md + NodeMap.md [map] 行 + [op] 行）
  - 云恢复时 `revertedIds` → 原共识节点标 `abandoned`（隐藏）
  - 主流程可见归档事件（WhenWhoWhat）
- **同修**：裁决驳回路径（accept=false）同步推送驳回事件节点 + `triggerSync`
- E2E（归档→飞书→模拟丢失→云恢复→节点仍隐藏）：**全 PASS**
  - `{archived:1, revertedIds:["N-2"]}` 归档事件节点入图 ✓
  - 原共识节点 `archived:true` 前端恒隐藏 ✓
  - 云恢复后 `{ab:true, arch:true}` 飞书 revertedIds 传播 ✓

### v4.4（2026-10-13，飞书云文档存储结构重构 + WWW 明确化）
- **新目录结构**（用户裁定）：
  ```
  /TeamWork-Demo/
    └── <工作组名>/                    ← 一级子目录（原 Memory/<工作组名>/ 提升）
        ├── Memory/                    ← 每节点独立 memory.md + consensus-snapshot
        ├── Skill/                     ← 技能文件
        ├── NodeMap.md                 ← 主拓扑地图（Append-Only 账本：[map]骨架 + [op]操作流 + rev:回退影响）
        └── _workspace.json            ← hash 密码/工作组配置
  ```
- **路径重构涉及**：ensureWorkspaceFolder（创建组时建 Memory/ + Skill/ 子目录）、searchWorkspaceFolder、deleteWorkspaceFolder、doSync、doConsensusSnapshot、pullAllNodes（骨架从 NodeMap.md 读 + full 从 Memory/ 逐文件读）
- **map.md 重命名为 NodeMap.md**（放工作组根目录，兼容旧名 map.md）
- **WWW 明确化**：toBlockText 第一行改为 `[WWW] When: <ISO> | Who: <clientId>(<显示名>) | What: [type] title`——每个 memory.md 文件开头一行即可读出 WhenWhoWhat
- **一致性**：所有 5 个路径引用点统一为新结构；注释同步更新；无残留旧路径硬编码

### v4.3.9（2026-10-13，map.md 追加型账本 + 前端跟随云文档变更刷新）
- **[op] 操作流行**：map.md 现在是一个 **Append-Only 追加型云文档账本**——每次节点新增/继承/回退都追加 `[op] 时间 | who | action | detail` 行作为**共享记忆**（"你只能新增，对新增部分修改/回退自己的"——历史行永不改写）；[map] 行同步增加 `rev:` 字段（回退影响的节点列表）
- **回退影响传播恢复**：pullAllNodes 骨架模式中 `[map] rev:N-x,N-y` → 对应节点标 `abandoned`（从账本恢复回退影响——不需要读每个 memory.md 的 tombstone）
- **前端跟随云文档变更**：`startCloudWatch()` 每 20s **骨架增量对齐**（一次 map.md 请求成本极低）——他人经飞书协作修改 map.md / 新增节点 → 自动同步到本地拓扑地图 + toast 告知"☁ 云端变更：恢复 N 个节点"；进入时也先骨架对齐再渲染；☁ 按钮 full 模式不变
- **restore 响应带 ops**：最近 10 条操作流（who/action/detail）——云端操作历史作为共享记忆可见
- `pullAllNodes` 返回 `{nodes, ops}`；节点骨架从 `[map]` 行恢复、操作流从 `[op]` 行恢复、回退影响从 `rev:` 字段恢复
- 飞书原生多人协作（成员只读浏览 map.md，程序写经 server 代理——每人可同步操作已由飞书底座实现）

### v4.3.8（2026-10-13，shareMemory 基础规则落地——每节点独立 memory.md + map.md 主拓扑地图）
- **基础规则**（用户裁定）：① 每次单个节点阶段性完成输出 → triggerSync 自动上传 ② 每节点一个独立 `memory.md` 文件（命名=`<上传时间>_<上传者>_<上传标题>.md`，sanitize+幂等 map 索引检查）③ 组 memory 目录下有主拓扑地图 `map.md`——**只记录节点添加信息（WhenWhoWhat 骨架）+ 上下文注入影响（injectedFrom）**，不涉及节点 memory.md 内容本身
- **map 行格式**：`[map] id | 时间 | who(显示名) | type | title | topo: | dom: | inj: | src: | cons: | file:`（src/cons 可选——向后兼容旧格式）
- **restore 骨架优先**：`pullAllNodes(state, {full})`——默认读 map.md **一次请求恢复全部骨架**（快）；`?full=1` 逐个 memory.md 补全 narrative/facts/concepts/files（慢）；兼容旧日期文档；**前端进入自动骨架、☁ 按钮手动 full**
- **setUserLookup**：feishu-sync 的 _userLookup 注入（index.js initFeishu 后）——文件名/显示名统一
- E2E（真实丢失场景：上传→清空→重启→骨架→full）：**9/9 PASS**——骨架 6 节点恢复（map 行 title/topo/who）、narrative 为空（骨架不含内容）、full 补全 narrative+files、共识生效节点在、幂等

### v4.3.7（2026-10-13，共识全员通过 → shareMemory/记忆视图更新 + 同步丢失修复）
- **共识生效节点归「记忆」视图**：decision 类型（含 ⚖️ 共识生效）从 evt 改归 **mem**——共识是 LSTM 长线记忆（L-1 层注入全员上下文），用户心智"在记忆中更新"
- **★ 同步丢失修复（doSync 忙锁）**：`if (_syncing) return` 忙时丢弃且不重排 → pending 节点永远留 local（E2E 实证：修复前 remote=2，修复后 **remote=4**——忙时触发的批次不再丢失）；对齐 claude-mem "失败留 NULL 下次再试"
- **restore 共识归档对齐**：从飞书恢复 consensusId 节点时按本地 consensus.items 状态标记——已归档共识的生效节点不复活
- E2E（全员三票路径首测）：**8/8 PASS**——M1 提议 → M2 确认 2/3 仍 proposed → Leader 第 3 票全员达成 → confirmed(v1)；节点入图 + 侧栏 Memory 含共识节点 + 记忆视图归属 + 飞书真实上传（remote=4）+ 归档移除 + restore 幂等

### v4.3.6（2026-10-13，区块链祖先链不可变 + 工具条/选项卡布局去重叠）
- **祖先链保护显性化**：revert 计算 `protected`（继承点前节点数）随响应返回 + 服务端日志（`祖先链 N 节点受保护，继承前拓扑不变`）+ 前端回退确认弹框标注区块链语义 + 成功 toast 显示保护数
- **不变性语义**（审计确认）：crash 集合严格限定 `who===自己 && when>继承点 && id≠继承点`——继承点、前任产出、发布节点、组级节点永不被回退触碰；一次回退 = 放弃最近一次 fork
- **布局重构**：选项卡（全部/任务流/继承链/记忆/事件）与工具条（适配/±/展开/收起/已回退/可继承末端/检索/云恢复）**合并同一行**（flex：tabs 左 + tools 右，窄屏 wrap）；地图区改 flex column、svg flex:1 自适应高度——彻底消除 absolute 覆盖重叠
- E2E（多用户多段链）：**13/13 PASS**——U1 继承产出 → U2 继承产出 → U2 回退：`{reverted:2, protected:3}`，U1 继承点/产出/发布节点全部完好（abandoned=false），崩溃链仅自己的 2 节点软删（before=10 → 存活祖先=8，0 误伤）

### v4.3.5（2026-10-13，shareMemory 真源恢复——Cloud Sync 读路径 + 重大 bug 修复）
- **★ 重大 bug 修复（`POST_block` 假成功）**：`api()` 把令牌桶标识 `POST_block` 原样当 HTTP method 发送（demo 是桶名与 method 分开传）——飞书网关拒绝但错误 body 无 code 字段 → 不抛错 → **此前所有"同步完成: 上传 N"日志均为假成功（飞书未真正收到数据）**。修复后 append 真实写入（E2E 实证：上传 5 块 → 拉回 5 节点）
- **读路径（pull）**：`parseNodeBlock`（toBlockText 的逆解析）+ `pullAllNodes`（组目录全量：listChildren → listDocTexts → **按 [mem: 锚点重新聚合**——飞书把上传块按行拆成单行块）；tombstone（[reverted:]）恢复软删
- **`GET /api/ws/:wsId/restore`**：真源合并——本地缺失从飞书恢复、本地已有保留本地状态（abandoned/archived 补缺不覆盖）、seq 重算、时间序排序；fail-open（飞书失败照常显示本地）
- **前端**：进入工作组页**先 restore 再渲染地图**（checkAuth 串联，恢复 N 节点时 toast 告知）+ 工具条「☁ 云恢复」手动对齐按钮
- E2E（真实丢失场景：产出→上传→清空本地 nodes+seq→重启→恢复）：**12 项全过**——恢复 5/5 节点、milestone(title/who/when)、observe(files+taskId+topo)、inherit(domain)、时间序、WWW 齐备、重复 restore 幂等（restored=0）
- 附带：`api()` 错误信息带 URL 定位；debug 日志 env 门控（TEAMWORK_RESTORE_DBG）

### v4.3.4（2026-10-13，共识 UI 缺陷修复 + select 下拉对比度）
- **下拉菜单白底白字修复**：`select option{background:#12152a;color:#e8ebf7}`——原生 option 列表不受父级背景控制的浏览器行为修正（全站 .fg/共享 CSS 一处生效）
- **共识操作自动关窗**：提议/确认/归档/裁决成功后 `closeDetail()` 关闭弹窗（原 `showConsensus()` 重开刷新）+ 200ms 后 `refresh()` 重绘地图
- **归档共识节点从主流程移除**：共识生效节点带 `consensusId` 关联；Leader 归档/裁决驳回时关联节点标 `archived:true`（恒隐藏——区别于回退软删的"已回退"开关可恢复）；status 透出 archived 字段；前端 visible() 恒过滤
- E2E：**5/5 PASS**（consensusId 关联 / 归档 archived / 关窗代码 / 恒隐藏过滤）

### v4.3.3（2026-10-13，hook 设计对齐 claude-mem-core-notes.md 精读基准）
> **基准声明**：`claude-mem-core-notes.md`（官方文档 29 页精读笔记）自此为**所有 hook 设计的参考基准**——五大哲学（非侵入/渐进披露/AI 是压缩器/上下文货币/异步优雅降级）、六大铁律（SessionID 唯一真源/幂等/隐私边缘剥离/fire-and-forget/事件驱动/Everything saves）、5 阶段钩子生命周期、观察分层结构、降噪策略、Grok/Kimi/Folder-Context 三种注入适配、Memory Ingest。
- **observe-hook.mjs 对齐五项**：① 全部 HTTP **2s 超时 AbortController**（铁律4——修复原版无超时阻塞风险）② JSONL **files/files_read/files_modified 提取**（观察分层文件锚点）③ **Memory Ingest 模式**（`--ingest-memory` 零模型花费直导入 + md5 幂等键）④ **live INDEX 注入模式**（`--inject-file`：Grok 式文件注入媒介 + tmp+rename 原子写）⑤ **降噪**（短行/纯符号/`--skip` 正则）
- **`GET /api/ws/:wsId/inject.md`**：无钩子宿主统一注入源——`<teamwork-inject>` 标签隔离（Folder Context 思想：标签外手写内容不覆盖）+ 共识 L-1 + 收件箱 L0 索引（⭐定向标记/拾取状态）+ 身份提示与协议指引（Kimi 每会话一次注入的等价物）
- **observe API files 字段**：节点落库 + status 透出 + 飞书 files 行 + 前端报告 📄 徽标（悬停全量）
- **MCP 工具描述**：observe + files 参数；report_done 引导 Stop 式结构化摘要（completed/learned/next_steps）
- E2E：**13/13 PASS**

### v4.3.2（2026-10-13，节点地图选项卡 + 底部信息栏 + 共识事件入图）
- **五个选项卡**：🌐全部 / ⚡任务流（发布·拆解·子任务·认领·完成）/ 🔗继承链（继承·回退·占用管理）/ 💡记忆（观察·分享）/ 📌事件（创建·进出·回收·共识生效）——tab 过滤在渲染层（EXP 状态跨 tab 保留），切换自动 fit
- **底部信息栏**：单击节点 → 页面底部显示 **When·Who·What**（emoji+标题+who·时间·类型·所属 tab + 📍拓扑/身份/已回退/云同步徽标）+ 操作钮（📄详情报告 / ⊕展开子级 / ✕取消）；**双击节点 = 完整报告弹窗**；选中节点青色虚线高亮环
- **共识生效入图**：全员/Leader 确认与裁决通过时 push `⚖️ 共识生效` 节点（type=decision，WhenWhoWhat + triggerSync 飞书）
- 交互重构：单击=信息栏（原"未展开则展开"逻辑移交 ⊕ 小圆钮与底栏展开按钮）
- E2E：**8/8 PASS**（全事件类型覆盖 / WWW 齐备 / 五 tab / 归属函数 / 底栏 / 高亮 / fit 补偿）

### v4.3.1（2026-10-13，Leader 静默发布链路——设计正解回归）
- **画像感知拆分器**：`splitTaskWithAI(leader, ws, …)`——prompt 注入成员画像（身份域/空闲状态/shareSkill），拆分子任务带 domain 建议
- **`injectTask()` 默式注入（skill/身份域匹配）**：shareSkill 关键词 ∩ 任务描述 / identity == domain 的成员**定向注入**（matched 标记）；无匹配回退全员多投（任务不饿死）；发布与解锁共用
- **MCP 13 工具**（stdio JSON-RPC 实测）：新增 teamwork_observe（对话静默上报）/ open-ends / inherit / revert / consensus / search 三模式增强；publish_task 更新为静默链路入口描述
- **Web 发布表单移除**：Leader 是 AI 参与者——发布走 AI 对话框（MCP），不做人工表单
- E2E：**16/16 PASS**（vue/node skill 定向注入互不串扰、matched 标记、回退全员、MCP 工具全注册）

### v4.3 批次四（2026-10-13，拓扑检索与域订阅——四批收官）
- **search 三层检索**：topo 前缀（R4 降级链 degraded:true）/ domain 订阅（R14 扩全组 expanded:true）/ kw 同域优先排序；结果带 topoPath/role 徽标
- **前端导航**：📍 拓扑徽标点击定位（navTopo）+ 🔍 检索面板（结果点击定位）+ userMarkedRelated 跳转
- E2E：**11/11 PASS**（含拓扑两级检索/降级/域订阅/扩组/同域优先/显示名修正）
- **四批总结**：ShareMemory 六维思想（边界/RNN 注入边/四维元信息/自主继承/回退记忆/共识长线）全部落地——批次一地基（15/15）、批次二继承闭环（19/19）、批次三共识（14/14+快照）、批次四检索（11/11），共 **59 项 E2E 全 PASS**

### v4.3 批次三（2026-10-13，共识子系统）
- **consensus API + 门控**：提议/确认/归档/裁决四模式；全员确认 or Leader 一票；同 key 结构冲突自动转裁决；三道闸（≤20 条 / ≤60 字 / 48h 超时）
- **Δ 注入**：成员级 lastConsensusVer + Bundle 具体增量明示（E2E: `共识更新 v0→v1 新增: [naming] 命名统一小驼峰`）
- **飞书版本化快照**（R9）：`consensus-snapshot-v{ver}.md` 新文档 + 幂等锚点 + 防抖合并（E2E: v3 快照实传）
- E2E：**14/14 PASS** + 快照日志实证

### v4.3 批次二（2026-10-13，自主继承闭环）
- **open-ends / inherit / revert / release** 四 API 落地（详见头部 v4.3 批次二块）——自主继承协议 + 回退记忆全链路可用
- **租约双通道回收**（心跳超时 R12 不入图 / 租约超时 R13 审计入图，产出保活：ack/observe/share/report_done 四类刷新 lease.lastActivity）
- **InheritBundle**：R1 白名单第二组装入口（gotcha 置顶 R8 + 链上信息 + 域内 Memory + 共识全文 + 拓扑，2.4K 预算）
- **修复**：ws 路由正则 `action` 支持连字符；全局 `dn()`（E2E 发现 409 分支 ReferenceError 崩溃）
- E2E：**19/19 PASS**（含身份赋予/CAS/产出保活/双超时回收/reorg 防护/软删/二次回退/tombstone）

### v4.3 批次一（2026-10-13，ShareMemory 地基）
- **wrapInjected / buildContextBundle**：注入组装唯一入口（R1 白名单）——L-1 共识层 + Δ（R2）+ RNN 注入边 + 拓扑行（R4）+ 2K 硬预算（R7）+ abandoned 过滤（R18）+ reference-only 包裹（R6）
- **四维快照全事件落库**：八类节点带 role/topoPath/consensusVer；ack 持久化 injectedFrom（**E2E 实证：后继拾取者注入前人完成节点 N-8**）；observe relatedTo → userMarkedRelated（R1 分离）
- **domain 标注**：publish 时任务级 domain，子任务解析继承
- **心跳扫描**：lastSeen + 超时解除 assignee 回末端（R12；env 参数化 TEAMWORK_HEARTBEAT_TIMEOUT_MS/TEAMWORK_SCAN_INTERVAL_MS，E2E 以 3s 超时实测回收）
- **飞书四维行 + 前端**：toBlockText role/topo/injectedFrom/consensus/relatedMarked/abandoned；真实注入边青色实线、已回退开关、报告弹窗四维徽标
- E2E：**15/15 PASS**（含心跳回收、RNN 注入边、双字段分离、wrapInjected 包裹、拓扑行格式）

### v4.2（2026-10-13 核心功能：节点地图 + 记忆采集）
- **chatWithUserAI 公共函数**：从 splitTaskWithAI 抽取通用 AI 调用（热同步读取用户 aiConfig）——供拆分器与 observe 总结共用
- **observe 采集端点**：本地任意 IDE/对话/网页对话 → content 上报 → `<private>` 剥离 + 正则脱敏 → 用户 AI 总结 FlowNode（title/type/narrative/facts/concepts/source）→ 节点入图 + 自动上传飞书（fail-open：AI 不可用降级截断标题，密钥/隐私实测拦截 PASS）
- **全事件节点化 + 飞书自动同步**：创建（milestone 起始节点）/加入/发布/拆解/拾取均补 triggerSync（此前仅完成/分享/退出有）；toBlockText 增加 when（上传时间）与 source 行
- **节点地图**（workspace.html 重写中栏）：径向爆炸图布局、wheel 缩放 + 拖拽平移、点击节点 = 未展开则爆炸披露子级 / 已展开则打开**节点报告弹窗**（When·Who·What + 叙事/facts/concepts/同步状态/子节点跳转）、任务依赖虚线箭头（dependsOn）、上下文注入影响虚线（concepts ∩ 子任务标题）、SSE nodeCount 增量感知实时刷新（轮询降级）、侧栏记忆流点击可定位图中节点
- **observe-hook.mjs**：`npm run observe --ws <id> --file <对话日志> [--source trae] [--name x --clientId y]`——监听文件增量逐行上报（JSONL 或纯文本），fail-open
- **status API**：新增 `nodes` 全量（含 narrative/concepts/source/sync）；subtasks 补 `dependsOn`；SSE 快照补 `nodeCount` + 成员名 dn() 修正

### v4.1（2026-10-13）
- **AI 配置热同步**：编辑弹窗保存 → `PUT /api/me/ai-config` → 内存即时生效（`splitTaskWithAI` 每次实时读取）；修复 PUT 请求体不读取的 bug（原仅 POST 读 body，PUT 恒收到 `{}` 会把配置重置为默认值）
- **活跃组拦截**：已加入 OPEN 工作组时修改 AI 配置 → 409（打开弹窗前 alert + 服务端兜底双保险）
- **成员操作**：🚪 退出（新增 leave API，含任务锁回收）/ ⏸ 挂起 / ▶ 启动（close/reopen 权限放开至全员）；member 卡片无删除按钮
- **卡片可进**：挂起工作组可点击进入（查看模式），解除 member 点击无反应的死锁
- **创建重名校验**：三层防线（实时提示 `GET /api/workspace-names` → 提交本地预检 → 后端 409 全局唯一）
- **已解散墓碑**：delete 给其他成员条目打 `{dissolved, name}`；`/api/workspaces` 返回 dissolved 数组；前端 🔴 分区渲染红灯卡片 + `POST /api/workspaces/dismiss` 点击清理（惰性通知——经产品确认保持非实时设计，SSE 实时推送暂不做）
- **飞书凭据链**：`_preferUserToken` 反转 bug 修复（降级一次后通道永久关闭的致命问题）+ 续期 refreshToken 保底；记录环境限制（v2 授权无 refresh_token，~2h 需重新授权）
- **杂项**：请求体读取支持 PUT/PATCH；清除 lobby.html 全局变量污染（`window._myAiConfig=c` 误置两处）
