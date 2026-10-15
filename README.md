<div align="center">

<img src="docs/banner.svg" alt="TeamWork —— 多用户 AI 协作系统：把「N 个人 × N 个 AI 会话」变成一条有共享记忆的流水线" width="100%">

[![GitHub release](https://img.shields.io/badge/release-v1.0.14-blue)](https://github.com/Nenezerrp/TeamWork/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)
[![AI Hosts](https://img.shields.io/badge/AI%20Hosts-TRAE%20%7C%20Claude%20Code%20%7C%20Cursor%20%7C%20Any%20MCP-ff6f61)](#)

**npm 安装 → 仪表盘加入工作组 → AI 工具全自动默式协作**

[🚀 快速开始](#-快速开始) · [🎬 协作演示](docs/demo-collaboration.md) · [🏗️ 架构文档](docs/architecture.md) · [💎 价值报告](docs/value-report.md) · [📖 使用手册](docs/getting-started.md)

**如果 TeamWork 对你的团队有帮助，欢迎 Star ⭐ 支持！**

</div>

---

## 为什么需要 TeamWork

AI 会话是天然孤岛——每个人的 AI 不知道别人做了什么。TeamWork **不替换任何人的 AI 工具**，而是给现有 AI 开发补上**协作层**，让多人在各自的 TRAE / Claude Code / Cursor / 任意 MCP 宿主里像同一条流水线一样协作，系统性消除三类隐性成本：

| 隐性成本 | 无 TeamWork 的现状 | TeamWork 的解法 |
|---|---|---|
| **上下文税** | 给队友的 AI 交代背景，需要人工粘贴提示词 | ContextBundle 自动注入（2K 预算），后继者零输入开工 |
| **试错税** | 一个人踩过的坑，另一个人的 AI 原样再踩一遍 | gotcha 置顶 + 共识 Δ 注入 + RNN 注入边，经验变组级免疫 |
| **协调税** | 任务分配、进度同步、背景交接全靠喊话 | 画像感知拆分定向分发 + observe 静默入图 + 依赖自动解锁 |

**三个「零输入」时刻**（[完整剧本](docs/demo-collaboration.md)）：

1. **发现任务零输入** —— SessionStart hook 静默注入收件箱候选，Leader 无需喊话分配
2. **同步进度零输入** —— observe 钩子自动上报入图，看节点地图即知进度，零会议零汇报
3. **继承背景零输入** —— 后继任务拾取者自动获得前人全部记忆，无需粘贴任何提示词

> 🎬 一次 3 任务双端协作实测：**70 分钟全链闭合，全程零会议、零进度汇报**——[docs/demo-collaboration.md](docs/demo-collaboration.md)

## ✨ 核心特性

| | 特性 | 说明 |
|---|---|---|
| 🧵 | **任务协作** | Leader 一句话发布 → 服务器画像感知拆分（成员技能 / 身份域 / 空闲状态）→ 定向默式注入收件箱 → CAS 原子抢锁 → 完成上报自动解锁后继 |
| 🧠 | **共享记忆** | 工作产出自动沉淀为团队记忆：三层检索（关键词 / 拓扑 / 域）+ 时间线回溯 + 渐进披露（L0 索引 ~50 tokens/条，防上下文膨胀） |
| ⚖️ | **共识约束** | 团队长线共识版本化治理（命名 / 架构 / 流程）：提议 → 全员确认或 Leader 一票生效 → Δ 增量注入全员上下文 |
| 🔗 | **链路继承** | 未完成开发链可被新成员自主继承（open-ends → inherit → InheritBundle）——溯源 + 崩溃回退防护，失败记忆沉淀为 gotcha 防重蹈覆辙 |
| ☁️ | **飞书云同步** | 全部数据实时同步飞书云文档：换机、新成员加入即自动恢复；隐私管线（`<private>` 剥离 + 正则脱敏）先过审再上云 |
| 🗺️ | **可视化仪表盘** | 节点地图（真实注入边 / 拓扑徽标 / 回退过滤）、成员状态、任务看板、共识管理、Metering（token 用量 + 预算告警） |
| 🚧 | **正在开发中** | **共享 Skill**（注册 / 分发链路，`teamwork_skills` 当前仅列出）、仪表盘 **「🔍 检索」「☁ 云恢复」手动入口**（底层 API 与自动云同步已就绪，开放后零迁移；AI 侧三层检索 `teamwork_search` 已可用） |

---

## 🏗️ 架构总览

```
┌───────────┐   ┌───────────┐   ┌───────────┐
│   TRAE    │   │Claude Code│   │  Cursor   │   …… 任意 MCP 宿主（每人自己的 AI）
│ (Leader)  │   │  (成员)   │   │  (成员)   │
└─────┬─────┘   └─────┬─────┘   └─────┬─────┘
      │  MCP 工具面（15 个协作工具）+ SessionStart 注入 + observe 静默上报
      ▼               ▼               ▼
┌─────────────────────────────────────────────┐
│            本机 Server + 仪表盘               │
│   任务拓扑 · CAS 抢锁 · ContextBundle 注入    │
│   节点地图 · 租约保活 · 隐私管线 · SSE 推送   │
└───────────────────────┬─────────────────────┘
                        │  防抖批量 + 幂等锚点，实时同步
                        ▼
          ☁️ 飞书云文档 NodeMap.md（唯一共享层）
             换机 / 新成员加入 → 全量自动恢复
```

**关键机制速览**：

| 机制 | 一句话 |
|---|---|
| ContextBundle | 唯一注入组装入口：共识层 + gotcha 置顶 + 拓扑行 + 2K 预算硬裁剪 |
| CAS 抢锁 | 原子拾取任务，根除「两人做到同一个任务」的重复劳动 |
| 租约保活 | 心跳不算——ack / observe / share / report_done 四类产出刷新，超时自动回收任务 |
| 隐私管线 | `<private>` 剥离 + 正则脱敏（密钥实测拦截）之后才入图 / 上云 |
| 渐进披露 | search（索引）→ timeline（上下文）→ get_observations（详情），按需加载不爆上下文 |

> 完整设计决策与 E2E 实证记录见 [docs/architecture.md](docs/architecture.md)（760 行，v4.0 → v1.0.14 全程演进）

## 🚀 快速开始

前置：[Node.js >= 18](https://nodejs.org) + 一个自备的飞书企业自建应用（见下方第 0 步）。从 [Releases](https://github.com/Nenezerrp/TeamWork/releases) 下载 `TeamWork.zip` 解压后：

```bash
# 0. 接入飞书（必需，约 5 分钟）——飞书云文档是跨机共享层，创建工作组的前置
#    开放平台自建应用 → 开通云文档权限（drive:drive / docx:document）→ 创建版本发布
#    → 安装目录 .env 填 FEISHU_APP_ID / FEISHU_APP_SECRET（根目录可不配，自动创建）
#    完整步骤：docs/getting-started.md「飞书接入」

# 1. 安装 CLI
npm install -g ./teamwork-cli-1.0.14.tgz
teamwork version        # → TeamWork v1.0.14

# 2. 启动（浏览器自动打开 http://localhost:8787）
teamwork start

# 3. 仪表盘创建 / 加入工作组（Leader 填名称+密码；成员凭组名+密码加入）
#    → 工作组的飞书目录（/TeamWork-Demo/<组名>/）由系统自动创建，无需手动建目录
#    → 加入已有工作组则自动从飞书云端恢复全部任务/记忆

# 4. 一键配置本机 AI 工具 MCP（自动检测 TRAE / Claude Code / Cursor）
teamwork setup
```

**📸 界面一览**（四步走完的样子）：

<p align="center">
<table>
  <tr>
    <td width="50%" align="center"><b>① 登录</b>——输入登录 ID 即进入（临时身份，本机持久）<br><img src="docs/images/login.jpg" alt="登录页"></td>
    <td width="50%" align="center"><b>② 创建 / 加入工作组</b>——Leader 建组，成员凭组名 + 密码加入<br><img src="docs/images/create-workspace.jpg" alt="创建工作组"></td>
  </tr>
  <tr>
    <td width="50%" align="center"><b>③ 一键配置 AI 工具 MCP</b>——自动检测 TRAE / Claude Code / Cursor<br><img src="docs/images/mcp-setup.jpg" alt="MCP 配置"></td>
    <td width="50%" align="center"><b>④ 主流程页（节点地图）</b>——协作全流程一目了然<br><img src="docs/images/workspace-dashboard.jpg" alt="主流程页"></td>
  </tr>
</table>
</p>

完成后打开 AI 工具即可协作。升级 / 远程访问 / 个人身份绑定等见 [docs/getting-started.md](docs/getting-started.md)。

## 💬 使用提示词建议

配好 MCP 后**用自然语言对话即可驱动协作**——无需记工具名，AI 会自动调用对应的 MCP 协作工具。三个高频场景：

**① Leader 发布任务**（AI 自动调用 `teamwork_publish_task`，画像感知拆分 + 定向分发）

> 帮我发布一个协作任务：为登录模块实现 JWT 中间件。
> 要求：token 签发 / 校验 / 刷新三个端点；验收标准是无 token 访问受保护路由返回 401。
> 可以让服务器按成员技能和空闲状态自动拆分子任务并分配。

**② 成员查看可拾取任务**（AI 自动调用 `teamwork_inbox_status`）

> 查看我的任务收件箱，现在有哪些可拾取的任务？把任务名、验收标准和前置摘要列出来。

**③ 成员完成任务节点**（AI 自动调用 `teamwork_report_done`，自动解锁后继任务）

> 任务「JWT 中间件」已完成，上报结果——
> 做了什么：新增 `auth/middleware.js`，签发 / 校验 / 刷新三个端点全部通过自测；
> 关键发现：refresh token 需要独立的过期黑名单表；
> 下一步：后继任务可直接调用 `verifyToken()`，注意先安装 `jsonwebtoken` 依赖。

更多场景（任务拾取 / 共享记忆 / 共识提议 / 链路继承）与完整模板见 [使用手册 · 使用提示词建议](docs/getting-started.md#使用提示词建议)。

## 🎬 70 分钟实战演示（双端剧本）

[docs/demo-collaboration.md](docs/demo-collaboration.md) 按时间轴还原了一次真实协作——Leader 阿哲 × 前端成员小雨在各自 AI 工具里完成「JWT 中间件 + 登录页 UI + API 联调」三个任务，逐事件标注什么提示词触发了哪个 hook / MCP 工具、server 幕后做了什么：

```
阿哲 ██████ T-1 开发 ██████┤ done ─┄┄┄┄┄┄┄（等 T-2）┄┄┐
                                                ├─→ T-3 联调（小雨）████ done
小雨 ──┤ T-2 开发 ██████████████████┤ done ──────┘
       ▲                        ▲
  ack 抢锁(T+0:03)     gotcha 分享(T+0:25)——对端节点地图实时可见
       ├────── 双方 observe 静默上报持续整个开发期，互不阻塞 ──────┤
```

六幕剧：**① 一句话发布（画像感知拆分）→ ② 零提示词抢锁开工（ContextBundle）→ ③ 双端并行开发（observe 入图）→ ④ 踩坑跨人流动（gotcha 置顶）→ ⑤ 共识 Δ 注入 → ⑥ 完成解锁 + 跨人继承联调**。

## 🧩 MCP 工具面（15 个协作工具）

| 类别 | 工具 |
|---|---|
| 任务闭环 | `teamwork_publish_task`（画像感知拆分）· `teamwork_inbox_status` · `teamwork_ack`（CAS 抢锁）· `teamwork_report_done`（自动解锁后继） |
| 共享记忆 | `teamwork_share_memory` · `teamwork_observe`（静默采集）· `teamwork_search` · `teamwork_timeline` · `teamwork_get_observations` |
| 共识治理 | `teamwork_consensus`（提议 / 确认 / 裁决 / 归档四模式） |
| 链路继承 | `teamwork_open_ends` · `teamwork_inherit` · `teamwork_revert`（崩溃回退 + 失败记忆沉淀） |
| 身份与技能 | `teamwork_join` · `teamwork_skills`（🚧 注册 / 分发链路开发中，当前仅支持列出） |

协议指引已内置在工具描述与注入源中——**AI 会话自然触发即可，无需记工具**。

## 📊 实施成熟度

- **协作域 19/19 冒烟通过** + HTTP 全链路实测（ack CAS 抢锁、依赖门控与解锁、评分排序）
- MCP 工具面收敛，每次调用 < 1s 返回
- 三种分发形态适配内网：**npm 在线 / .tgz 离线 / .zip 零依赖**
- 数据全落本机 `~/.teamwork/`，升级安装包不丢数据

## 📖 文档中心

| 文档 | 内容 |
|---|---|
| [使用手册](docs/getting-started.md) | 安装 / 升级 / CLI 全参考 / 三种接入方式 / 飞书绑定 |
| [协作演示](docs/demo-collaboration.md) | 70 分钟双人剧本：六幕时间轴 + 机制速查表 + 三个零输入时刻 |
| [架构文档](docs/architecture.md) | v4.0 → v1.0.14 全程设计决策与 E2E 实证（760 行） |
| [价值报告](docs/value-report.md) | 三类隐性成本 / 试错四道防线 / ROI 总览 / 成本构成 / 边界假设 |

## 📁 项目结构

```
teamwork/
├── bin/teamwork.js      # CLI 入口（start / stop / status / setup / doctor / feishu-auth …）
├── server/              # 协作 server + 仪表盘（index.js / feishu-sync.js / public/）
├── mcp/index.js         # MCP 工具面（15 个协作工具）
├── scripts/             # setup / observe-hook / build-package 等
├── docs/                # 文档中心（手册 / 演示 / 架构 / 价值报告）
├── .env.example         # 环境变量模板
├── LICENSE              # MIT
└── package.json         # @teamwork/cli v1.0.14
```

## 🤝 贡献

- 发现问题：[Issues](https://github.com/Nenezerrp/TeamWork/issues)
- 想要的功能 / 适配更多 AI 宿主：提 Feature Request，附上你的宿主类型
- 协作机制的设计细节与演进史见 [docs/architecture.md](docs/architecture.md)——欢迎讨论

## 📄 License

[MIT](./LICENSE) © TeamWork Contributors

---

<div align="center">

**TeamWork —— 给现有 AI 开发补上协作层**

[🚀 快速开始](#-快速开始) · [🎬 看演示](docs/demo-collaboration.md) · [⭐ Star 支持](https://github.com/Nenezerrp/TeamWork)

</div>

