# TeamWork 多人协作演示剧本（Leader × 成员）

> 一图胜千言：本剧本按时间轴展示**两个真实协作端**——Leader 阿哲与成员小雨——分别在各自 AI 工具（TRAE / Claude Code / Cursor / 任意 MCP 宿主）里的对话内容，并逐事件注释：
> **什么提示词触发了什么 hook / MCP 工具，server 在幕后做了什么操作**。
> 全部机制均为系统真实实现（画像感知拆分 / CAS 抢锁 / 隐私管线 / 飞书同步 / 静默注入引擎），可直接作为新成员入门教材。

## 场景设定

- 工作组：`ws-login`「登录重构组」（小雨此前已 `teamwork_join` 加入，token.json 已落盘）
- 部署形态：每人本机跑一个 server + 仪表盘，飞书云文档 `NodeMap.md` 是唯一共享层
- 任务树（服务器自动拆分）：

```
T-1  JWT 鉴权中间件   （无依赖，Leader 自留）
T-2  登录页 UI        （无依赖，定向注入小雨）
T-3  登录 API 联调    （dependsOn = [T-1, T-2]，后继任务）
```

**图例**：👤 = 用户提示词（显式）｜🤖 = AI 调用 MCP 工具｜🪝 = hook 自动触发（**零提示词，静默**）｜⚙️ = server 操作｜☁️ = 飞书云文档同步

---

## 幕 1 ｜ T+0:00 　Leader 端：发布任务

```
👤 阿哲: "把登录模块重构拆一下发下去，我负责 JWT 中间件，
        小雨擅长前端，页面给她做，最后留一个联调任务"

🤖 AI 调用: teamwork_publish_task(
      description="登录模块重构：JWT 中间件 + 登录页 UI + API 联调",
      domain="login")          ← 不给 subtasks，交给服务器智能拆分

⚙️ server:
  ① splitTaskWithAI 画像感知拆分——读取成员档案：
     小雨 shareSkill=[前端/CSS] + 空闲状态 ✓ → T-2 定向注入她的收件箱；
     阿哲(Leader, 后端域) → T-1 默认自留 → 拆出 T-3 挂 dependsOn=[T-1,T-2]
  ② 拆解节点入图（When·Who·What 四维快照：role/topoPath/consensusVer）
  ③ triggerSync ☁️ 飞书 NodeMap.md 新增任务链，任务状态流 [task] 落盘
  ④ 默式注入：T-2 进小雨收件箱（不打扰，等她下次会话自然发现）
```

---

## 幕 2 ｜ T+0:03 　成员端：静默感知 → 抢锁开工

```
（小雨刚在 IDE 里开了一个新 AI 会话——她什么都没说）

🪝 SessionStart hook（零提示词，静默）:
  读取 ~/.teamwork/inject-ws-login.md（server 每 3s 刷新）
  → AI 上下文自动出现：
  "## 你的进行中任务/收件箱候选
   ⭐ T-2「登录页 UI」(可拾取, 前端域)——含验收标准 + 协作协议"

👤 小雨: "看到收件箱有登录页任务，我来做这个"

🤖 AI 调用: teamwork_inbox_status()   → L0 索引确认（~50 tokens/条）
🤖 AI 调用: teamwork_ack(taskId="T-2")

⚙️ server:
  ① CAS 原子抢锁（若 Leader 同时抢 T-2，只有一人成功）
  ② 拾取节点入图，身份赋值 identity=前端域，租约开始（产出保活）
  ③ 返回 ContextBundle 注入 AI 上下文（R1 白名单 + 2K 预算）：
     ├─ 任务描述 + 验收标准
     ├─ gotcha 置顶区（R8）：暂无
     ├─ 共识层 v0 + Δ 增量明示
     └─ 拓扑行（R4）：T-1(T-3 的依赖, Leader 认领中)
  ④ lease.lastActivity 刷新（ack 计入保活）

小雨的 AI 从此刻已"知道要做什么、做到什么程度、有什么规范"
——她无需人工粘贴任何背景提示词
```
---

## 幕 3 ｜ T+0:10 ~ T+0:40 　双端并行开发（并行关系核心）

```
┌─────────── Leader 阿哲（同时！）───────────┐
👤 "写 JWT 鉴权中间件，RS256，token 里带 uid/role"
🤖 编写 server/middleware/auth.js
🪝 observe-hook（静默）: 监听到对话产出增量
   → teamwork_observe(content="…RS256 中间件实现…",
        files=["middleware/auth.js"], source="trae")
⚙️ server:
  ① 隐私管线：<private> 剥离 + 正则脱敏（密钥实测拦截）
  ② chatWithUserAI 总结成 FlowNode（type=feature）入图
  ③ ☁️ 自动上传飞书 + SSE 推 nodeCount +1
     → 小雨的仪表盘节点地图实时长出新节点
└──────────────────────────────────────────┘
┌─────────── 成员 小雨（同时！）────────────┐
👤 "登录页做成两栏，左边品牌区右边表单"
🤖 编写 views/login.vue
🪝 observe-hook（静默）: 同样上报她的对话产出
⚙️ server: 同管线 → 她的节点入图 ☁️ 上传飞书
     → 阿哲的仪表盘节点地图同时 +1
└──────────────────────────────────────────┘

节点地图呈现：T-1、T-2 两条链并行生长（径向爆炸图），
谁都没有等谁——这正是分布式协作（每人本机 server + 飞书共享层）的意义。
期间双方任何 ack/observe/share/report_done 都在刷新各自租约（产出保活）。
```

---

## 幕 4 ｜ T+0:25 　成员踩坑 → 记忆跨端流动

```
👤 小雨: "表单徽章怎么全飞到弹窗右上角叠一起了？！"
🤖 定位：全局 CSS 的 absolute 角标样式泄漏 → 修复
🤖 AI 调用: teamwork_share_memory(
      title="徽章绝对定位泄漏：复用角标类必须覆盖 position",
      type="gotcha",
      narrative="components.css 的 .ws-badge 是 absolute 角标，复用为
                 行内徽章必须页内覆盖 position:static，否则叠到定位
                 祖先右上角同点字符重叠",
      concepts=["css","position","badge"])

⚙️ server:
  ① gotcha 节点入图 + R8 置顶标记
  ② ☁️ 飞书 NodeMap.md 同步
  ③ 下次任何人 ack 后继任务时，此 gotcha 自动置顶注入
     （跨人记忆：T-3 联调者将直接避开这个坑）
```

---

## 幕 5 ｜ T+0:35 　共识流动（长线记忆 Δ 注入）

```
👤 阿哲: "命名得统一，不然后面联调要打架"
🤖 AI 调用: teamwork_consensus(
      key="naming", text="组件名 PascalCase，函数用 camelCase")
⚙️ server: 记为共识提议 v1（待确认），☁️ consensus-snapshot-v1.md 上传

（小雨端，下一次任意 MCP 调用的返回 Bundle 尾部自动出现：）
  「共识更新 v0→v1 新增: [naming] 组件名 PascalCase...」
🤖 AI 调用: teamwork_consensus(confirmId="...")  → 确认生效
⚙️ server: 全员确认 → 注入全员上下文（LSTM 长线记忆），
  防抖合并快照 ☁️ 上传
```
---

## 幕 6 ｜ T+0:40 ~ T+1:10 　完成 → 解锁链 → 跨人继承

```
👤 阿哲: "中间件好了，上报完成"
🤖 AI 调用: teamwork_report_done(taskId="T-1",
      summary="completed: RS256 中间件+单测 / learned: 飞书 token 2h 过期需
      续期 / next_steps: 联调时注意 role 字段")   ← Stop 摘要式三段结构
⚙️ server:
  ① T-1 完成节点入图 ☁️ 上传
  ② 解锁检查：T-3 依赖 = T-1✅ T-2❌ → 尚不解锁
  ③ summary 已存——它将成为 T-3 拾取者的注入上下文

（5 分钟后，小雨端——同样静默完成，无需人工转述 Leader 干了什么）
👤 小雨: "页面完工，提交"
🤖 AI 调用: teamwork_report_done(taskId="T-2", summary="...")
⚙️ server:
  ① T-2 完成 ☁️ 上传，从全员收件箱清除
  ② 解锁检查：T-3 依赖全满足 ✓ → T-3 进收件箱 + 默式注入

🪝 小雨下个会话 SessionStart → inject 文件已含 T-3
👤 小雨: "联调任务出了，我来"
🤖 AI 调用: teamwork_ack(taskId="T-3")
⚙️ server 返回 ContextBundle——此刻「跨人继承」发生：
  ├─ 📌 阿哲 T-1 完成摘要（RNN 注入边：前人记忆自动可见）
  │     「N-8 [10-15 14:02] 阿哲 feature「JWT 中间件」…next_steps: 注意 role 字段」
  ├─ 小雨自己 T-2 链上记忆（renderTaskChain 依赖闭包最近 10 条）
  ├─ ⚠️ gotcha 置顶（幕 4 的 CSS 坑——R8 置顶注入）
  └─ 共识 v1 全文（命名规范）

👤 小雨: "联调完成，全部通过"
🤖 teamwork_report_done(taskId="T-3") → ⚙️ 整链闭合 ☁️ 飞书快照终版
```

---

## 并行关系总览（时间轴）

```
阿哲 ██████ T-1 开发 ██████┤ done ─┄┄┄┄┄┄┄（等 T-2）┄┄┐
                                                ├─→ T-3 联调（小雨）████ done
小雨 ──┤ T-2 开发 ██████████████████┤ done ──────┘
       ▲                        ▲
  ack 抢锁(T+0:03)     gotcha 分享(T+0:25)——阿哲端节点地图实时可见
       ├────── 双方 observe 静默上报持续整个开发期，互不阻塞 ──────┤
```

---

## 机制速查表（提示词 / hook → server 操作）

| 时刻 | 触发（谁说了什么 / 什么 hook） | server 幕后操作 |
|---|---|---|
| T+0:00 | 👤 Leader 提示词 → `publish_task`（无 subtasks） | 画像感知拆分（shareSkill/身份域/空闲状态）→ 定向默式注入收件箱 → 节点入图 → ☁️ 飞书 |
| T+0:03 | 🪝 SessionStart hook 读 inject 文件（零提示词） | 每 3s 刷新注入源（身份+共识+收件箱+链上记忆） |
| T+0:03 | 👤 成员「我来做」→ `ack` | CAS 原子抢锁 → 身份赋值 → ContextBundle 注入（gotcha 置顶/共识/拓扑，2K 预算）→ 租约保活 |
| 开发期 | 🪝 observe-hook 静默上报（零提示词） | 隐私管线（`<private>` 剥离+脱敏）→ 用户 AI 总结 FlowNode → 入图 → ☁️ 飞书 → SSE 对端实时可见 |
| T+0:25 | 👤 踩坑提示词 → `share_memory(type=gotcha)` | gotcha 节点入图 + R8 置顶 → 后继拾取者自动避坑 |
| T+0:35 | 👤 Leader 提示词 → `consensus` 提议；成员 `confirmId` 确认 | 共识版本化 v0→v1 → Δ 增量注入全员 → ☁️ consensus-snapshot 上传 |
| T+0:40+ | 👤 `report_done`（Stop 摘要式 summary） | 完成入图 → 解锁后继 → 收件箱清除/注入 → summary 成为后继注入上下文 |
| T+0:48 | 🪝 SessionStart + 👤 `ack` 后继任务 | renderTaskChain 依赖闭包 → RNN 注入边（前人记忆自动可见）→ 零输入开工 |

---

## 结语：三个「零输入」时刻（静默链路核心）

1. **发现任务**：小雨靠 SessionStart 注入看到收件箱候选——Leader 无需喊话分配；
2. **同步进度**：双方 observe 自动入图——队友无需问「你做到哪了」，看节点地图即可；
3. **继承背景**：T-3 拾取者拿到 T-1/T-2 全部记忆注入——无需人工粘贴 5 步提示词（search → timeline → get_observations → 开发 → report_done）。

> 本剧本对应实现细节见 [architecture.md](./architecture.md)（变更记录 v4.2~v1.0.8）；安装与配置见 [getting-started.md](./getting-started.md)。

