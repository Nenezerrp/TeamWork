import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { triggerSync, triggerConsensusSync, initFeishu, getSyncStats, ensureWorkspaceFolder, deleteWorkspaceFolder, searchWorkspaceFolder, writeWorkspaceConfig, readWorkspaceConfig, listWorkspaceDir, pullAllNodes, setUserLookup, setUserTokenAccess, feishuUserInfo, shareRootToOpenId, stopSync, markTaskSynced, setPersistHook } from './feishu-sync.js';

import os from 'node:os';

// ===== 密码哈希（SHA-256 + salt，参照飞书文档加密思路）=====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1'; // ★ v4.7.1 分布式部署：默认仅本机可访问（成员不连他人机器）；HOST=0.0.0.0 显式开启中心化（v4.6.9 模式 opt-in）
const TOKEN_FILE = path.join(os.homedir(), '.teamwork', 'token.json'); // ★ MCP 读取此文件——server 自动写入（本机 Leader 零手动）

// ★ 自动写入 ~/.teamwork/token.json（登录/创建/加入时自动触发——本机用户的 MCP 零配置）
function writeLocalTokenFile(token, user, wsId) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    // ★ v1.0.14+ 修复：session（wsId=null）不再抹掉已有 wsId——本机 hook（observe-hook.mjs 等）反复 session 换 token
    //   会把 MCP 的组指向抹掉（「未加入工作组」误报）；join/create 显式传 wsId 时正常更新
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, user, wsId: wsId ?? prev?.wsId ?? null }, null, 1));
    return true;
  } catch (e) {
    console.warn(`  [token] 本地 token.json 写入失败: ${e.message}`);
    return false;
  }
}
// ShareMemory v4.3：心跳扫描参数（R12/R13，env 可配用于测试）
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.TEAMWORK_HEARTBEAT_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const SCAN_INTERVAL_MS = parseInt(process.env.TEAMWORK_SCAN_INTERVAL_MS || String(60 * 1000), 10);
const LEASE_TIMEOUT_MS = parseInt(process.env.TEAMWORK_LEASE_TIMEOUT_MS || String(30 * 60 * 1000), 10); // R13 租约超时（产出保活）
// R2 共识门控参数：confirmed 上限 / proposed 挂起超时转裁决
const CONSENSUS_MAX = parseInt(process.env.TEAMWORK_CONSENSUS_MAX || '20', 10);
const CONSENSUS_ARBITRATE_AFTER_MS = parseInt(process.env.TEAMWORK_CONSENSUS_ARBITRATE_AFTER_MS || String(48 * 60 * 60 * 1000), 10);
const CONSENSUS_KEYS = ['naming', 'error-code', 'api-style', 'git-workflow', 'architecture', 'testing', 'docs', 'security', 'other'];
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + password + salt).digest('hex');
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }

// ===== 通用 AI 调用：用指定用户的 AI Provider（热同步读取 aiConfig，改配置即时生效）=====
async function chatWithUserAI(userName, prompt, maxTokens = 800) {
  const aiConfig = users[userName]?.aiConfig;
  if (!aiConfig?.apiKey || !aiConfig?.modelId) return null;
  const baseUrl = aiConfig.baseUrl || 'https://api.anthropic.com/v1';
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiConfig.apiKey}` },
      body: JSON.stringify({ model: aiConfig.modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await res.json();
    return j.choices?.[0]?.message?.content || null;
  } catch (e) { console.warn(`  [ai] 调用失败 ${userName}: ${e.message}`); return null; }
}

// ===== TaskSplitter：用 Leader 的 AI 拆分（v4.3 画像感知：成员 shareSkill/身份域/空闲状态参与拆解与分发建议）=====
async function splitTaskWithAI(leaderName, ws, description, acceptance) {
  const roster = Object.entries(ws.members).filter(([, m]) => m.role !== 'leader')
    .map(([id, m]) => {
      const skills = (ws.skills || []).filter(s => s.provider === id)
        .map(s => String(s.name) + (s.description ? '（' + String(s.description).slice(0, 24) + '）' : ''));
      const busy = Object.values(ws.locks).includes(id);
      return `- ${id}|名字=${users[id]?.name || id}|身份=${m.identity || '未定'}|状态=${busy ? 'busy' : 'idle'}|技能=[${skills.join('; ')}]`; // ★ v1.0.12 roster 带名字（Leader AI 拆分时可输出 assignee 指定成员）
    }).join('\n');
  const prompt = `你是任务拆分调度专家。结合下方成员画像（名字/身份域/空闲状态/shareSkill），把任务拆分为 2-5 个子任务，尽量让每个子任务的 domain 对齐技能最匹配成员的身份域（无人匹配时用 general）。
成员画像：
${roster || '-（暂无成员）'}

输出纯 JSON 数组（不要 markdown），格式：
[{"what":"子任务描述","acceptance":"验收标准","dependsOn":[0],"priority":"P2","domain":"建议身份域","assignee":"成员名（任务描述中点名某人负责时必填该成员名字，未点名则省略）"}]
dependsOn 用数组下标，无依赖则 []。可并行的任务优先。assignee 必须是成员画像中的名字，不要虚构。
任务：${description}
验收：${acceptance || '无'}`;
  const text = await chatWithUserAI(leaderName, prompt, 800);
  if (!text) return null;
  try {
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const subtasks = JSON.parse(jsonStr);
    if (Array.isArray(subtasks) && subtasks.length > 0 && subtasks[0].what) return subtasks;
    return null;
  } catch { console.warn('  [splitter] AI 拆分输出解析失败'); return null; }
}

// ===== ShareMemory v4.3 地基：单点包裹 / 四维快照 / ContextBundle 组装 / 心跳 =====

// R6/R5：所有注入通道统一包裹（唯一实现点——reference-only，只进上下文不落本地记忆文件）
function wrapInjected(source, content) {
  return `<teamwork-memory source="${source}" trust="reference-only">\n${content}\n</teamwork-memory>`;
}
// 身份域（链路的属性）：子任务 domain → 父任务 domain → general
function resolveDomain(ws, taskId) {
  const t = taskId && ws.tasks[taskId];
  if (!t) return 'general';
  return t.domain || (t.parent && ws.tasks[t.parent]?.domain) || 'general';
}
// 拓扑坐标（快照式：仅节点创建时调用，全代码库无更新路径——R4）
function resolveTopo(ws, taskId) {
  const t = taskId && ws.tasks[taskId];
  if (!t) return '/ws';
  return t.parent ? `/${t.parent}/${t.id}` : `/${t.id}`;
}
// 四维快照（role/consensusVer 由继承与共识子系统赋予；P0 阶段可为 null/0——R10 可选字段降级）
function snapMeta(ws, user, taskId) {
  return { role: ws.members[user]?.identity || null,
    topoPath: resolveTopo(ws, taskId), consensusVer: ws.consensus?.ver || 0 };
}

// ★ v1.0.7 结构完整性守卫：join 从飞书恢复的副本 / 旧版 state 恢复的组可能缺字段——统一补默认值。
//    根因案例：join 副本缺 consensus → GET consensus 裸读 c.items → TypeError → unhandledRejection → 整个 server 被杀（浏览器「localhost 拒绝连接」）
function ensureWsShape(ws) {
  if (!ws) return ws;
  if (!ws.consensus) ws.consensus = { ver: 0, items: [] };
  if (!ws.tasks) ws.tasks = {};
  if (!ws.nodes) ws.nodes = [];
  if (!ws.members) ws.members = {};
  if (!ws.inbox) ws.inbox = {};
  if (!ws.locks) ws.locks = {};
  if (!ws.skills) ws.skills = [];
  if (!ws.checkpoints) ws.checkpoints = [];
  if (!ws.seq) ws.seq = 0;
  return ws;
}
// ★ v4.7.2 云对齐公共函数（restore handler 与 open-ends 共用）：拉取 NodeMap.md（节点骨架 + [task] 任务状态流）→ 本地合并
//    ——B 机 AI 未开浏览器时 MCP open-ends 也能看到云端任务（A 机发布 → [task] 行 → B 机 open-ends 可继承）；15s 节流（force 绕过）

// ★ v1.0.13 僵尸副本墓碑化：组云目录已被删除（跨机 Leader 删除——delete 只清 Leader 机本地+云目录，成员机副本此前永远不知道）
//   → 成员机副本删本地 workspaces + 本机成员 userWs 条目打 dissolved 墓碑（lobby 红灯卡片，dismiss 清理）+ 终态 inject 文件（AI 可读「组已删」）
function dissolveLocalCopy(ws, reason) {
  const wsId = ws.id, wsName = ws.name;
  for (const uid of Object.keys(ws.members || {})) {
    if (Array.isArray(userWs[uid])) userWs[uid] = userWs[uid].map(w => w.wsId === wsId ? { ...w, dissolved: true, name: wsName } : w);
    if (users[uid]?.activeWs === wsId) users[uid].activeWs = null;
  }
  delete workspaces[wsId];
  scheduleSave();
  try {
    fs.writeFileSync(path.join(os.homedir(), '.teamwork', `inject-${wsId}.md`),
      `<teamwork-inject>\n# TeamWork · ${wsName} · 已解散\n\n## 🔴 工作组已被删除（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）\n- 工作组「${wsName}」(${wsId}) 的云目录已不存在（${reason}）——本机副本已自动清理\n- ⚠ 本机 AI 对话端的 MCP 若仍指向该组，调用会失败——请提示用户重新加入工作组（teamwork_join）或忽略本通知\n</teamwork-inject>\n`, 'utf8');
  } catch { }
  console.log(`  [dissolve] 工作组云目录已不存在（跨机删除）→ 本机副本墓碑化: ${wsName} (${wsId})`);
}

async function cloudSyncOnce(ws, actorUser, { full = false, force = false } = {}) {
  if (!force && ws._lastCloudSync && Date.now() - ws._lastCloudSync < 15000) return null;
  ws._lastCloudSync = Date.now();
  const pull = await pullAllNodes(ws, { full, actor: actorUser });
  // ★ v1.0.13 跨机删除检测：目录按名找不到且本副本曾关联目录 → 组可能已被 Leader 删除——连续 2 次确认（防飞书 API 抖动误杀）后墓碑化
  if (pull.dirMissing) {
    ws._dirMiss = (ws._dirMiss || 0) + 1;
    if (ws._dirMiss >= 2) dissolveLocalCopy(ws, '云目录已被 Leader 删除');
    return null;
  }
  ws._dirMiss = 0;
  const { nodes: remote, ops, tasks: remoteTasks } = pull;
  let added = 0;
  const byId = new Map(ws.nodes.map(n => [n.id, n]));
  const revertedIds = new Set();
  // ① NodeMap.md 骨架中的 revertedIds → abandoned（Append-Only 账本回退影响传播——[op] revert 的 rev: 列表）
  for (const rn of remote) {
    for (const rid of (rn.revertedIds || [])) revertedIds.add(rid);
    // ★ v1.0.11 跨机身份映射恢复：云行 `id(name)` 双存身份——其他机器成员不在本机 users 表（分布式各机独立维护），
    //   不回填则成员栏/流程树显示原始码 u-xxxx。回填守卫：本机已有该用户不覆盖（本机临时名优先）；_whoName 剥离防混入节点对象
    if (rn.who && rn._whoName && rn._whoName !== rn.who && !users[rn.who]) {
      users[rn.who] = { id: rn.who, name: rn._whoName, aiConfig: {}, registeredAt: rn.when || Date.now(), remote: true };
    }
    delete rn._whoName;
    // ★ 共识节点恢复完整性：按本地 consensus.items 状态对齐——已归档共识的生效节点不复活
    if (rn.consensusId) {
      const item = (ws.consensus?.items || []).find(i => i.id === rn.consensusId);
      if (item && item.status === 'archived') rn.archived = true;
    }
    const local = byId.get(rn.id);
    if (local) {
      for (const k of ['narrative', 'facts', 'concepts', 'files', 'role', 'topoPath', 'domain', 'source', 'taskId', 'injectedFrom', 'consensusVer', 'type', 'title'])
        if ((local[k] === undefined || local[k] === null) && rn[k] !== undefined) local[k] = rn[k]; // 补缺不覆盖
    } else { ws.nodes.push(rn); byId.set(rn.id, rn); added++; }
  }
  for (const n of ws.nodes) if (revertedIds.has(n.id)) n.abandoned = true;
  // ② ★ v4.7.2 任务状态流重放（跨机任务协作核心）：[task] 行序即时间序——后行胜；三重本机保护：持锁不覆盖 / 本机已完成不回退 / _tsq 行序去重
  //    ★ v1.0.12 恢复端收件箱重建：云来 ready 任务（含 designee 指定）→ injectTask 投进本机收件箱——
  //      B 机 AI 的 inbox_status / inject-{wsId}.md 才能看到 A 机发布的任务（此前只恢复 tasks 表不重建收件箱 → 指定人永远收不到）
  let tasksApplied = 0;
  (remoteTasks || []).forEach((tk, idx) => {
    const local = ws.tasks[tk.id];
    if (!local) {
      ws.tasks[tk.id] = { id: tk.id, parent: tk.par || null, what: tk.what, acceptance: tk.acc || '',
        status: tk.st, assignee: tk.asg || null, designee: tk.dsg || null, prevAssignee: null, dependsOn: tk.deps || [],
        priority: tk.pri || 'P2', domain: tk.dom || 'general', when: Date.now(),
        subtasks: [], _tsq: idx };
      if (tk.par && ws.tasks[tk.par]) ws.tasks[tk.par].subtasks = [...new Set([...(ws.tasks[tk.par].subtasks || []), tk.id])];
      tasksApplied++;
      markTaskSynced(ws, ws.tasks[tk.id]); // 防回声：云来副本标记已同步（本机后续变化才上行）
      injectTask(ws, tk.id); // ★ v1.0.12 收件箱重建（内部守卫 status==='ready' + inbox 去重；designee=B 机用户→定向投，他人→不投，无指定→本机画像/兜底多投）
    } else {
      const localDone = local.status === 'done' && local.doneSummary;
      if (idx > (local._tsq ?? -1) && !ws.locks[tk.id] && !(localDone && tk.st !== 'done')) {
        local.status = tk.st; local.assignee = tk.asg || null;
        if (tk.dsg !== undefined) local.designee = tk.dsg || null; // ★ v1.0.12 指定人回填（旧版云行无 dsg → undefined 保留 local）
        if (tk.deps && tk.deps.length) local.dependsOn = tk.deps;
        if (!local.what && tk.what) local.what = tk.what;
        local._tsq = idx;
        markTaskSynced(ws, local); // 仅实际应用了云行才标记——被本机保护跳过（持锁/已完成）的任务不标记，其新状态照常上行
        tasksApplied++; // ★ v4.7.2：状态更新也计数（否则返回值低估实际应用量——E2E 曾误判"未传播"）
        injectTask(ws, local.id); // ★ v1.0.12 状态变化（如对端解除占用/换指定人）→ 本机收件箱同步重建
      }
    }
  });
  // ③ 依赖解锁 sweep：blocked 任务的所有 deps 已 done（对端完成经云传播）→ 本机 ready 化
  for (const t of Object.values(ws.tasks)) {
    if (t.status === 'blocked' && (t.dependsOn || []).length && t.dependsOn.every(d => ws.tasks[d]?.status === 'done')) { t.status = 'ready'; tasksApplied++; injectTask(ws, t.id); } // ★ v1.0.12 解锁即注入（本机发布链 914 行同款——跨机解锁补齐）
  }
  // ④ seq 对齐（节点/任务/成员 id 数字拉齐——B 机新发 id 不撞车）
  let mx = 0;
  for (const key of [...ws.nodes.map(n => n.id), ...Object.keys(ws.tasks), ...Object.keys(ws.members || {})])
    for (const m2 of String(key).matchAll(/-(\d+)$/g)) mx = Math.max(mx, parseInt(m2[1], 10));
  ws.seq = Math.max(ws.seq || 0, mx);
  ws.nodes.sort((a, b) => (a.when || 0) - (b.when || 0)); // 时间序（status memory.latest 与爆炸图依赖）
  // ★ v1.0.11 [op] 操作流同源回填（骨架模式节点已覆盖大多数，op 行兜底无节点产出的成员）
  for (const op of ops) {
    if (op.who && op._whoName && op._whoName !== op.who && !users[op.who]) {
      users[op.who] = { id: op.who, name: op._whoName, aiConfig: {}, registeredAt: op.when || Date.now(), remote: true };
    }
    delete op._whoName;
  }
  scheduleSave();
  console.log(`  [restore] ${ws.name}: 远端 ${remote.length} 节点 + ${ops.length} 操作 + ${remoteTasks?.length || 0} 任务行（${full ? 'full 内容' : 'map 骨架'}），恢复 ${added} 节点 / ${tasksApplied} 任务，本地共 ${ws.nodes.length}`);
  return { remote: remote.length, restored: added, tasks: tasksApplied,
    ops: ops.slice(-10).map(o => ({ who: dn(o.who), action: o.action, detail: String(o.detail).slice(0, 60) })) };
}
// RNN 注入边源（确定性）：done 前置任务的完成节点 + 同链已有产出（过滤 abandoned——R18）
function relatedPriorNodes(ws, task, limit = 5) {
  const out = [];
  for (const d of (task.dependsOn || [])) {
    const done = ws.nodes.filter(n => !n.abandoned && n.taskId === d && n.type === 'summary' && String(n.title).startsWith('完成'));
    if (done.length) out.push(done[done.length - 1]);
  }
  out.push(...ws.nodes.filter(n => !n.abandoned && n.taskId === task.id).slice(-limit));
  return out.slice(0, limit);
}
// ★ 唯一注入组装入口（R1 写入点白名单；R7 预算硬裁剪 ≤2K；R2 L-1 共识层 + Δ；R4 拓扑行）
function buildContextBundle(ws, task, user) {
  const parts = [];
  const conf = (ws.consensus?.items || []).filter(i => i.status === 'confirmed');
  if (conf.length) parts.push(`[共识 v${ws.consensus.ver}] ` + conf.map(i => i.text).join(' · '));
  const lastVer = ws.members[user]?.lastConsensusVer ?? 0;
  if ((ws.consensus?.ver || 0) > lastVer) {
    const delta = conf.filter(i => (i.sinceVer || 0) > lastVer);
    parts.push(delta.length
      ? `（共识更新 v${lastVer}→v${ws.consensus.ver} 新增: ${delta.map(i => `[${i.key}] ${i.text}`).join(' · ')}——LSTM 长线记忆）`
      : `（共识已更新至 v${ws.consensus.ver}，请留意上述约束——LSTM 长线记忆）`);
  }
  const prior = relatedPriorNodes(ws, task);
  if (prior.length) parts.push('前序相关节点：' + prior.map(n => `${n.id}「${String(n.title).slice(0, 30)}」`).join(' · '));
  parts.push(`你的位置：${resolveTopo(ws, task.id)}（域：${resolveDomain(ws, task.id)}${task.parent ? '；祖先：' + String(ws.tasks[task.parent]?.what || '').slice(0, 20) : ''}）`);
  let text = parts.join('\n');
  if (text.length > 2000) text = text.slice(0, 2000) + '\n…（预算裁剪）'; // R7 硬预算
  return { meta: wrapInjected('teamwork-server', text), injectedFromIds: prior.map(n => n.id) };
}
// ★ v1.0.12 指定人解析：临时登录名 / 身份码 u-xxx / 名字(u-xxx) → clientId（跨机身份键）
//    分布式无注册中心——纯名反查依赖 users 表（本机登录 + v1.0.11 节点/[op] 云回填的 remote 成员）；解析失败返回 null（回退画像注入）
function resolveDesignee(ws, expr) {
  const s = String(expr || '').trim();
  if (!s) return null;
  if (/^u-[0-9a-f]+$/i.test(s)) return s; // 身份码直接用（唯一键）
  const m = s.match(/^(.+?)\((u-[0-9a-f]+)\)$/i); // 名字(u-xxx) 格式（status API 的 display 格式）
  if (m) return m[2].toLowerCase();
  const hit = Object.entries(users).find(([, u]) => u && u.name === s); // 纯名反查（本机 + remote 回填）
  return hit ? hit[0] : null;
}
// 默式注入（L0 一行摘要，v4.3 画像感知分发）：shareSkill/身份域匹配的成员优先定向注入；无匹配回退全员多投（任务不饿死）
function injectTask(ws, taskId) {
  const t = ws.tasks[taskId];
  if (!t || t.status !== 'ready') return;
  // ★ v1.0.12 Leader 指定人：designee 优先于一切画像逻辑——只投指定人收件箱（inbox 键独立于本机 members 表，跨机由 [task] dsg 流 + 恢复端重建传播）
  if (t.designee) {
    const box = ws.inbox[t.designee] || (ws.inbox[t.designee] = []);
    if (!box.some(b => b.taskId === taskId))
      box.push({ taskId, digest: `📋 ${t.what.slice(0, 60)}`, priority: t.priority || 'P2',
        readySince: Date.now(), matched: true, designated: true });
    console.log(`  [inject] ${t.id}「${String(t.what).slice(0, 24)}」指定注入 ${t.designee}（designee）`);
    return;
  }
  const dom = resolveDomain(ws, taskId);
  const words = String(t.what).toLowerCase();
  const members2 = Object.entries(ws.members).filter(([, m]) => m.role !== 'leader');
  const matchSkill = (id) => (ws.skills || []).some(s => s.provider === id &&
    String(s.name).toLowerCase().split(/[\s/，,]+/).filter(Boolean).some(w => w.length >= 2 && words.includes(w)));
  let targets = members2.filter(([id, m]) => (m.identity && m.identity === dom) || matchSkill(id));
  const matched = targets.length > 0;
  if (!matched) targets = members2;
  if (!targets.length) targets = Object.entries(ws.members).filter(([, m]) => m.role === 'leader'); // ★ 无其他成员时 Leader 兜底（小团队 Leader 也干活）
  for (const [id] of targets) {
    const box = ws.inbox[id] || (ws.inbox[id] = []);
    if (!box.some(b => b.taskId === taskId))
      box.push({ taskId, digest: `📋 ${t.what.slice(0, 60)}`, priority: t.priority || 'P2',
        readySince: Date.now(), matched: matched || undefined });
  }
  if (matched) console.log(`  [inject] ${t.id}「${String(t.what).slice(0, 24)}」定向注入 ${targets.length} 位匹配成员（domain=${dom}）`);
}
function touchLastSeen(ws, user) { if (ws.members[user]) ws.members[user].lastSeen = Date.now(); }
function bumpConsensus(ws) { // R2/R9：confirmed 集合变更 → ver++ + 版本化快照（防抖）
  ws.consensus.ver++;
  triggerConsensusSync(ws);
}
// R13：产出保活（只有该链路上的实际产出刷新租约——心跳不算）
function touchLease(ws, taskId, user) {
  const t = taskId && ws.tasks[taskId];
  if (t?.lease && t.lease.owner === user) t.lease.lastActivity = Date.now();
}
// R12：末端未完成节点（自主继承的选择菜单；同域优先 + 域内记忆数排序，≤10 条）
function openEndsList(ws, user) {
  const myDomain = ws.members[user]?.identity || null;
  return Object.values(ws.tasks)
    .filter(t => t.parent && t.status !== 'done' && !t.assignee && !t.lease &&
      (!t.designee || t.designee === user) && // ★ v1.0.12：指定任务只对指定人可见（他人不可继承——Leader 指定是强约束）
      (t.dependsOn || []).every(d => ws.tasks[d]?.status === 'done'))
    .map(t => {
      const domain = resolveDomain(ws, t.id);
      const ns = ws.nodes.filter(n => n.taskId === t.id && !n.abandoned);
      const ln = ns[ns.length - 1];
      return { taskId: t.id, what: t.what, topoPath: resolveTopo(ws, t.id), domain,
        designee: t.designee ? dn(t.designee) : null, // ★ v1.0.12 指定标记（纯名——MCP 文本 token 敏感）
        lastNode: ln ? { id: ln.id, title: ln.title, when: ln.when, who: dn(ln.who), whoId: ln.who } : null,
        domainMemCount: ws.nodes.filter(n => !n.abandoned && n.role === domain).length,
        prevAssignee: t.prevAssignee ? `${dn(t.prevAssignee)}(${t.prevAssignee})` : null };
    })
    .sort((a, b) => ((b.domain === myDomain) - (a.domain === myDomain)) || (b.domainMemCount - a.domainMemCount))
    .slice(0, 10);
}
// ★ R1 白名单第二入口：InheritBundle 组装（R8 结构化摘要 + gotcha 置顶 + 域内 Memory + 共识全文 + 拓扑）
function buildInheritBundle(ws, task, user) {
  const parts = [];
  const domain = resolveDomain(ws, task.id);
  const chain = ws.nodes.filter(n => !n.abandoned && n.taskId === task.id).slice(-8);
  const gotchas = chain.filter(n => n.type === 'revert');
  if (gotchas.length) parts.push('⚠ 前序失败教训（先看什么不行）：' + gotchas.map(g =>
    `${g.id}「${String(g.title).slice(0, 24)}」${g.narrative ? '—' + String(g.narrative).slice(0, 60) : ''}`).join(' · '));
  const prev = chain.filter(n => n.type !== 'revert' && n.type !== 'inherit');
  if (prev.length) parts.push('链上节点信息：' + prev.map(n => `${n.id}「${String(n.title).slice(0, 28)}」`).join(' · '));
  const pd = prev.filter(n => n.narrative).slice(-3).map(n => `${n.id} 摘要：${String(n.narrative).slice(0, 80)}`);
  if (pd.length) parts.push(pd.join('\n'));
  const dm = ws.nodes.filter(n => !n.abandoned && n.taskId !== task.id &&
    (n.role === domain || (n.concepts || []).some(c => String(task.what).toLowerCase().includes(String(c).toLowerCase())))).slice(-5);
  if (dm.length) parts.push(`域内 Memory（${domain}）：` + dm.map(n => `${n.id}「${String(n.title).slice(0, 24)}」${dn(n.who)}`).join(' · '));
  const conf = (ws.consensus?.items || []).filter(i => i.status === 'confirmed');
  if (conf.length) parts.push(`[共识 v${ws.consensus.ver} 全文] ` + conf.map(i => i.text).join(' · '));
  parts.push(`你的位置：${resolveTopo(ws, task.id)}（域：${domain}；祖先：${task.parent ? String(ws.tasks[task.parent]?.what || '').slice(0, 20) : '-'}）`);
  let text = parts.join('\n');
  if (text.length > 2400) text = text.slice(0, 2400) + '\n…（预算裁剪）'; // R7
  return wrapInjected('teamwork-server', text);
}

// ===== 状态持久化（防抖 JSON 落盘，重启自动恢复）=====
// ★ v4.7.3：默认 state 迁至 ~/.teamwork/state.json（用户主目录）——旧默认（包根 state-v4.json）在全局安装时位于
//   node_modules 内，npm 升级包即丢全部用户/工作组/绑定数据；env 可覆盖（多实例/测试隔离不变）。
//   兼容迁移：新路径不存在而旧路径有 state → 一次性拷贝（原文件保留），老用户无痛升级。
const STATE_FILE = process.env.TEAMWORK_STATE_FILE || path.join(os.homedir(), '.teamwork', 'state.json');
(function migrateLegacyState() {
  if (process.env.TEAMWORK_STATE_FILE) return; // 显式指定时不迁移
  const legacy = path.join(__dirname, '..', 'state-v4.json');
  try {
    if (fs.existsSync(STATE_FILE) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.copyFileSync(legacy, STATE_FILE);
    console.log(`  [state] 旧状态已迁移: ${legacy} → ${STATE_FILE}（原文件保留）`);
  } catch (e) { console.warn(`  [state] 旧状态迁移失败（以新路径为准）: ${e.message}`); }
})();
let wsEvents = []; // ★ v4.6.4 工作组切换事件流（close/switch）——inject 渲染 + AI 端侧「已切换」提示的信源
let _saveTimer = null;
function saveNow() { // ★ v4.6.5 同步落盘（从防抖回调抽出）：停机/崩溃时立即 flush，防抖窗口内的变更不丢
  try {
    const data = { users, workspaces, userWs, wsEvents, savedAt: Date.now() };
    // 脱敏：密码只存哈希（内存中已如此），tokens 不持久化（会话重启失效）
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 1), 'utf8');
    console.log(`  [state] 已持久化: ${Object.keys(users).length} 用户 / ${Object.keys(workspaces).length} 工作组`);
    return true;
  } catch (e) { console.warn(`  [state] 保存失败: ${e.message}`); return false; }
}
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNow, 2000);
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(users, raw.users || {});
    Object.assign(workspaces, raw.workspaces || {});
    Object.assign(userWs, raw.userWs || {});
    wsEvents = Array.isArray(raw.wsEvents) ? raw.wsEvents : []; // ★ v4.6.4 恢复切换事件（服务重启后通知不丢）
    // 恢复后：全部工作组转为 DORMANT（重启即暂存，等待用户手动启动）
    const now = Date.now();
    for (const ws of Object.values(workspaces)) { ws.phase = 'DORMANT';
      ensureWsShape(ws); // ★ v1.0.7：旧组/缺字段组统一补结构默认值（原 v4.3 仅补 consensus，现全字段防裸访问）
      // ★ v4.6.5 修复：停机时长不计入心跳/租约计时——重启时把计时基准重置为当前时刻，
      //   防止「重启后第一轮扫描即回收停机前活跃的成员/租约」（成员没产出是因为服务器停了，不该被回收）。
      //   覆盖所有重启路径（优雅停机/崩溃/硬杀/断电）；lease.since 为继承审计时间（WhenWhoWhat）保持不动。
      for (const m of Object.values(ws.members)) if (m.lastSeen > 0) m.lastSeen = now;
      for (const t of Object.values(ws.tasks)) if (t.lease && t.lease.lastActivity) t.lease.lastActivity = now;
    }
    console.log(`  [state] 已恢复: ${Object.keys(users).length} 用户 / ${Object.keys(workspaces).length} 工作组（全部 DORMANT，心跳/租约计时基准已重置——停机时长不计入超时）`);
  } catch { console.log('  [state] 全新状态'); }
}

// ===== ★ v4.6.5 服务生命周期：优雅停机 + 残留清理（teamwork start 挂起服务 ↔ teamwork stop 同步善后）=====
//   服务停止（teamwork stop 主动停止 / Ctrl+C / 崩溃）时：同步 flush state（防抖窗口内变更不丢）+
//   终止飞书同步（停机后不再上传）+ 清理 PID/secret 运行时文件（防残留）——"同步应该结束、杀死残留"
const PID_FILE = path.join(os.homedir(), '.teamwork', 'server.pid');
const SECRET_FILE = path.join(os.homedir(), '.teamwork', 'server.secret');
let _shuttingDown = false;
function cleanupRuntimeFiles() {
  // 仅当 PID 文件指向自己才删（多实例并行时不误删对方的登记）
  try { if ((fs.readFileSync(PID_FILE, 'utf8') || '').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(SECRET_FILE); } catch {}
}
function gracefulShutdown(reason, code = 0) {
  if (_shuttingDown) return; _shuttingDown = true;
  try { console.log(`\n  [shutdown] ${reason} —— 同步 flush 状态 + 终止飞书同步 + 清理运行时文件`); } catch {}
  try { clearTimeout(_saveTimer); saveNow(); } catch {} // 防抖窗口内的变更立即落盘
  try { stopSync(); } catch {} // 停止飞书同步引擎（清除 pending 防抖任务，停机后不再上传）
  try { for (const ws of Object.values(workspaces)) sseBroadcast(ws.id, { type: 'shutdown', reason }); } catch {} // 在线页面实时感知
  try { server.close(() => {}); } catch {} // 停止接受新连接
  cleanupRuntimeFiles();
  console.log('  [shutdown] 善后完成，进程退出');
  process.exit(code);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT（Ctrl+C）')); // 前台运行（npm start）时 Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Linux 优雅停止主路径
process.on('uncaughtException', (e) => { // 崩溃：日志留痕（CLI 日志文件可查）+ 善后 + 非零退出
  console.error('  [crash] 未捕获异常:', (e && e.stack) || e);
  gracefulShutdown('未捕获异常（崩溃）', 1);
});
process.on('unhandledRejection', (r) => { // ★ v1.0.7：降级为日志 fail-open——HTTP 层已有薄壳 500 兜底，此处只兜后台任务漏网 rejection；杀进程曾致用户「刷新页面 localhost 拒绝连接」
  console.error('  [rejection] 未处理 Promise Rejection（fail-open，server 存活）:', (r && r.stack) || r);
});
process.on('exit', () => { // 兜底：任何退出路径（EADDRINUSE 等）都保证 flush + 清运行时文件
  if (!_shuttingDown) { try { clearTimeout(_saveTimer); saveNow(); } catch {} }
  cleanupRuntimeFiles();
});

// ★ v4.6.4 工作组切换事件（MCP hook 信源）：页面切换工作组（挂起/创建/进入/启动）时记录 →
//   inject 文件渲染「🔔 工作组切换通知」→ AI 对话端侧自动提示"已切换到新工作组，token 仍指旧组需 teamwork_join"
const WS_EVENT_TTL_MS = parseInt(process.env.TEAMWORK_WS_EVENT_TTL_MS || String(30 * 60 * 1000), 10); // switch 通知保留 30 分钟（可配）
function pushWsEvent(type, wsId, wsName, by, prevName, auto) {
  wsEvents.push({ type, wsId, wsName, by, at: Date.now(), prevName: prevName || null, auto: !!auto });
  if (wsEvents.length > 50) wsEvents = wsEvents.slice(-50); // 环形上限：只留最近 50 条
  scheduleSave();
  console.log(`  [ws-event] ${dn(by)} ${type === 'close' ? '挂起' : '切换到'}工作组「${wsName}」(${wsId})${prevName ? `，原「${prevName}」自动挂起` : ''}`);
}

// ===== 隐私管线（4.8 简化版：<private> 剥离 + 正则脱敏）=====
const REDACT_PATTERNS = [
  { re: /sk-[a-zA-Z0-9]{20,}/g, repl: '<redacted type="key"/>' },
  { re: /sk-ant-[a-zA-Z0-9-]{20,}/g, repl: '<redacted type="key"/>' },
  { re: /ghp_[a-zA-Z0-9]{36}/g, repl: '<redacted type="gh_pat"/>' },
  { re: /AKIA[0-9A-Z]{16}/g, repl: '<redacted type="aws"/>' },
];
function sanitizeNode(node) {
  let t = String(node.title || '');
  let n = String(node.narrative || '');
  // 剥离 <private> 块
  t = t.replace(/<private>[\s\S]*?<\/private>/g, '');
  n = n.replace(/<private>[\s\S]*?<\/private>/g, '');
  // 正则脱敏
  for (const p of REDACT_PATTERNS) { t = t.replace(p.re, p.repl); n = n.replace(p.re, p.repl); }
  return { title: t, narrative: n };
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const raw = await new Promise(r => { let d=''; req.on('data', c=>d+=c); req.on('end',()=>r(d)); }).catch(()=>'');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const users = {}, tokens = {}, workspaces = {}, userWs = {};
const dn = id => users[id]?.name || id; // clientId → 显示名（全局：ws 路由块共用；status 内局部声明保留 shadow 无害）
function issueToken(name) { const t = 'tw-'+crypto.randomBytes(16).toString('hex'); tokens[t] = { user: name }; return t; }
function auth(req) { const t = (req.headers.authorization||'').replace(/^Bearer\s+/i,''); return tokens[t]?.user || null; }

const BANNER = String.raw`
  ████████╗██╗    ██╗███████╗██████╗ ███╗   ██╗██╗  ██╗    ██████╗
  ╚══██╔══╝██║    ██║██╔════╝██╔══██╗████╗  ██║╚██╗██╔╝   ██╔═████╗
     ██║  ██║ █╗ ██║█████╗  ██████╔╝██╔██╗ ██║ ╚███╔╝    ██║██╔██║
     ██║  ██║███╗██║██╔══╝  ██╔══██╗██║╚██╗██║ ██╔██╗    ████╔╝██║
     ██║  ╚███╔███╔╝███████╗██║  ██║██║ ╚████║██╔╝ ██╗██╗╚██████╔╝
     ╚═╝   ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝ ╚═════╝
                     ✦  多 AI 协作工作台 v4  ✦`;
console.log('\x1b[35m' + BANNER + '\x1b[0m');
console.log('\x1b[2m  ───────────────────────────────────────────\x1b[0m');
console.log('  \x1b[36m▸ v4.0\x1b[0m    多工作区');
console.log('  \x1b[36m▸ 监听\x1b[0m    http://localhost:' + PORT);
// ===== HTTP Server =====
// ★ v1.0.7 防「一个 handler 异常杀掉整个 server」（曾致浏览器「localhost 拒绝连接」）：
//    回调体提取为 handleApi，外层薄壳统一 catch → 500 响应 + 日志留痕，进程存活
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  // 静态页面路由（v4.0 多页架构）
  if (req.method === 'GET') {
    let file = null;
    if (url.pathname === '/' || url.pathname === '/auth') file = 'auth.html';
    else if (url.pathname === '/lobby') file = 'lobby.html';
    else if (url.pathname.startsWith('/ws/')) file = 'workspace.html';
    else if (url.pathname === '/style.css') file = 'style.css';
    else if (url.pathname === '/components.css') file = 'components.css';
    else if (url.pathname === '/common.js') file = 'common.js';
    if (file) {
      try {
        const content = fs.readFileSync(path.join(__dirname, 'public', file));
        const ct = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
        res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8' });
        return res.end(content);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
  }

  // ★ v4.6.5 优雅停机端点（teamwork stop 调用）：仅限本机 + secret 握手（HOST=0.0.0.0 下防远程误停）
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') return json(res, 403, { error: 'forbidden' });
    let secretOk = true;
    try { const expect = (fs.readFileSync(SECRET_FILE, 'utf8') || '').trim(); if (expect) secretOk = (req.headers['x-tw-shutdown'] || '') === expect; } catch {}
    if (!secretOk) return json(res, 403, { error: 'forbidden' });
    json(res, 200, { ok: true, pid: process.pid });
    setTimeout(() => gracefulShutdown('teamwork stop（HTTP /api/shutdown）'), 150); // 先让响应 flush 回环再退出
    return; // ★ 响应已发必须终止路由——否则穿透后续 handler 二次写头（ERR_HTTP_HEADERS_SENT）误触崩溃钩子
  }

  // 临时身份：clientId（UUID）为真实身份键，name 仅用于显示（同名可共存）
  if (url.pathname === '/api/session' && req.method === 'POST') {
    const { name, _clientId, aiConfig } = body;
    if (!name) return json(res, 400, { error: '请输入登录 ID' });
    if (!_clientId) return json(res, 400, { error: '客户端身份缺失' });
    // clientId 是唯一键，同一 clientId 重复登录 = 同一人（恢复会话）
    if (!users[_clientId]) {
      users[_clientId] = { id: _clientId, name, aiConfig: aiConfig || {}, registeredAt: Date.now() };
    } else {
      users[_clientId].name = name; // 同一人可改显示名
      if (aiConfig) users[_clientId].aiConfig = aiConfig;
    }
    const token = issueToken(_clientId);
    // ★ 自动写入本地 token.json（MCP 直接可用——本机 Leader 登录即完成）
    const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    const localWrite = isLocal ? writeLocalTokenFile(token, name, null) : false;
    if (localWrite) console.log(`  [token] 本地 token.json 已自动写入 (${name})`);
    // ★ 返回 MCP 本地路径（前端用于生成正确的 MCP 配置——不用 npx 引用未发布包）
    const mcpPath = path.join(__dirname, '..', 'mcp', 'index.js');
    return json(res, 200, { token, user: { id: _clientId, name }, localWrite, isLocal, mcpPath });
  }
  if (url.pathname === '/api/register' && req.method === 'POST') {
    return json(res, 400, { error: '请使用 /api/session' });
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    return json(res, 400, { error: '请使用 /api/session' });
  }

  const user = auth(req);
  if (!user) return json(res, 401, { error: '未授权' });

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const u = users[user];
    return json(res, 200, { id: user, name: u?.name || user, aiConfig: u?.aiConfig || {}, workspaces: userWs[user] || [] });
  }

  // 更新 AI Provider 配置（热同步，无需重启）
  if (url.pathname === '/api/me/ai-config' && req.method === 'PUT') {
    const { provider, baseUrl, apiKey, modelId, apiKeyPool, quotaFallback } = body;
    if (!users[user]) return json(res, 404, { error: '用户不存在' });
    // 每次更新前判断：已加入活跃工作组（OPEN）则拒绝修改，需先退出/挂起
    const activeWs = Object.values(workspaces).find(w => w.members[user] && w.phase === 'OPEN');
    if (activeWs) return json(res, 409, { error: `你已加入活跃工作组「${activeWs.name}」，请先退出/挂起当前活跃工作组才能修改 AI 配置` });
    users[user].aiConfig = {
      provider: provider || 'claude',
      baseUrl: baseUrl || '',
      apiKey: apiKey || '',
      modelId: modelId || '',
      apiKeyPool: apiKeyPool || [],
      quotaFallback: quotaFallback || null,
    };
    scheduleSave();
    console.log(`  [ai-config] ${users[user].name} 更新 AI 配置: ${provider}/${modelId}`);
    return json(res, 200, { ok: true, aiConfig: users[user].aiConfig });
  }

  // 工作组名称列表（创建弹窗的实时重名校验用）
  if (url.pathname === '/api/workspace-names' && req.method === 'GET') {
    return json(res, 200, { names: Object.values(workspaces).map(w => w.name) });
  }

  // 成员清理「已解散」工作组的残留条目（组已被 Leader 删除；独立路由避免 /api/ws/:id 的 404 兜底拦截）
  if (url.pathname === '/api/workspaces/dismiss' && req.method === 'POST') {
    const wid = body.wsId;
    if (!wid) return json(res, 400, { error: 'wsId 必填' });
    if (workspaces[wid]) return json(res, 400, { error: '该工作组仍存在，无需清理' });
    if (!Array.isArray(userWs[user]) || !userWs[user].length) return json(res, 200, { ok: true });
    userWs[user] = userWs[user].filter(w => w.wsId !== wid);
    if (users[user]?.activeWs === wid) users[user].activeWs = null;
    try { fs.unlinkSync(path.join(os.homedir(), '.teamwork', `inject-${wid}.md`)); } catch { } // ★ v1.0.13 顺手清终态 inject 文件（防残留注入）
    scheduleSave();
    console.log(`  [dismiss] ${users[user]?.name || user} 清理已解散工作组条目: ${wid}`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const mine = [], joined = [], dissolved = [];
    for (const [wsId, ws] of Object.entries(workspaces)) {
      const m = ws.members[user]; if (!m) continue;
      const s = { wsId, name: ws.name, phase: ws.phase, role: m.role,
        memberCount: Object.keys(ws.members).length, nodeCount: ws.nodes.length, leader: ws.leader,
        active: (users[user]?.activeWs === wsId) };
      const dn = users[ws.leader]?.name || ws.leader;
      const s2 = { ...s, leader: dn };
      if (m.role === 'leader') mine.push(s2); else joined.push(s2);
    }
    // 已解散的残留条目：组已被 Leader 删除，成员的 userWs 条目仍在 → 红灯卡片，成员点击后自行清理
    for (const w of (userWs[user] || [])) {
      if (workspaces[w.wsId]) continue;
      dissolved.push({ wsId: w.wsId, name: w.name || '已解散的工作组', phase: 'DISSOLVED',
        role: w.role, memberCount: 0, nodeCount: 0, leader: '—', active: false, dissolved: true });
    }
    return json(res, 200, { mine, joined, dissolved });
  }

  if (url.pathname === '/api/feishu/token' && req.method === 'POST') {
    // ★ v4.7 用户身份：feishu-auth CLI 上报个人飞书 token（OAuth 绑定）
    // 流程：验证 token 有效性（user_info）→ tenant 自动把共享根目录授权给该用户（可编辑）→ 按用户持久化
    const { accessToken, refreshToken, expiresAt } = body || {};
    if (!accessToken) return json(res, 400, { error: 'accessToken 必填' });
    let info;
    try { info = await feishuUserInfo(accessToken); }
    catch (e) { return json(res, 400, { error: `飞书 token 无效（${e.message}）——请重新运行 teamwork feishu-auth` }); }
    let shared = false;
    try { shared = await shareRootToOpenId(info.open_id, 'edit'); }
    catch (e) { console.warn(`  [feishu] 根目录自动共享失败: ${e.message}`); }
    if (!users[user]) users[user] = { name: user, aiConfig: {} };
    users[user].feishuToken = { accessToken, refreshToken, expiresAt: expiresAt || (Date.now() + 6600000),
      openId: info.open_id, feishuName: info.name || info.en_name || '', boundAt: Date.now() };
    scheduleSave();
    console.log(`  [feishu] ${dn(user)} 绑定飞书身份 → ${info.name || info.en_name || info.open_id}（open_id=${info.open_id}），根目录共享 ${shared ? 'OK' : '跳过/已有'}`);
    return json(res, 200, { ok: true, feishuName: info.name || info.en_name || '', openId: info.open_id, shared });
  }

  if (url.pathname === '/api/feishu/status' && req.method === 'GET') {
    // ★ v4.7：当前用户飞书绑定状态（未绑定提示引导）
    const ft = users[user]?.feishuToken;
    return json(res, 200, ft
      ? { bound: true, feishuName: ft.feishuName, openId: ft.openId, expiresAt: ft.expiresAt }
      : { bound: false, hint: '运行 teamwork feishu-auth 绑定你的飞书身份（此后所有飞书操作以你的身份执行）' });
  }

  if (url.pathname === '/api/workspaces/create' && req.method === 'POST') {
    const { name, password, memoryLimit } = body;
    if (!name) return json(res, 400, { error: '名称必填' });
    if (!password) return json(res, 400, { error: '密码必填' });
    // ★ v1.0.14 同名副本预检（防死锁）：本地同名副本先做云所有权校验——
    //   云目录已删 / config 代际不符 = 已死僵尸副本 → 自动墓碑化后放行创建（用户无感清理，云上确保干净后走全新目录）；
    //   云目录同代存活 = 真组 → 409 拦截（合法重名保护）。
    //   背景：member 机的同名僵尸副本（跨机删除残留）会永久阻断创建，而 delete 仅 Leader 可用——不预检即死锁。
    const dup = Object.values(workspaces).find(w => w.name === name);
    if (dup) {
      let cloudAlive = false;
      try {
        const dir = await searchWorkspaceFolder(name, user);
        if (dir) {
          const cfg = await readWorkspaceConfig(dir.folderToken, user);
          cloudAlive = !!cfg && (cfg.wsId ? cfg.wsId === dup.id : (cfg.name === name && cfg.createdAt === dup.createdAt));
        }
      } catch { cloudAlive = true; } // 云校验异常 → 保守拦截（宁可 409 不可误杀活组）
      if (cloudAlive) {
        return json(res, 409, { error: `工作组名称「${name}」已被占用（本机存在该工作组副本，且云端目录同代存活）——请直接进入该组，或由 Leader 删除后再重建` });
      }
      dissolveLocalCopy(dup, 'create 同名预检：云目录已删除/代际不符（僵尸副本自动清理）');
      console.log(`  [create] 本地同名僵尸副本 ${dup.id} 已自动墓碑化，放行创建「${name}」`);
    }
    const wsId = 'ws-' + crypto.randomBytes(4).toString('hex');
    // 单活跃约束：已有活跃工作组则拒绝创建
    for (const [id, w] of Object.entries(workspaces)) {
      if (w.members[user] && w.phase === 'OPEN') {
        return json(res, 200, { ok: false, error: `你已加入活跃工作组「${w.name}」，请先关闭/挂起后再创建新工作组` });
      }
    }
    // 密码哈希存储
    const salt = generateSalt();
    const passHash = hashPassword(password, salt);
    workspaces[wsId] = { id: wsId, name, leader: user, passHash, salt,
      memoryLimit: memoryLimit || 1000,
      phase: 'OPEN', createdAt: Date.now(),
      members: { [user]: { role: 'leader', joinedAt: Date.now(), settings: { autoPush: true, autoPull: true } } },
      tasks: {}, nodes: [], inbox: {}, locks: {}, seq: 0, checkpoints: [], skills: [],
      consensus: { ver: 0, items: [] }, members: { [user]: { role: 'leader', joinedAt: Date.now(), settings: { autoPush: true, autoPull: true }, lastSeen: Date.now() } } };
    // 节点地图起始：Leader 创建工作组 = 根节点（milestone，四维快照）
    const m0 = snapMeta(workspaces[wsId], user, null);
    workspaces[wsId].nodes.push({ id: `N-${++workspaces[wsId].seq}`, when: Date.now(), who: user,
      type: 'milestone', title: '创建工作组', narrative: `Leader 创建工作组「${name}」`,
      role: m0.role, topoPath: m0.topoPath, consensusVer: m0.consensusVer, sync: 'local' });
    if (!userWs[user]) userWs[user] = [];
    userWs[user].push({ wsId, role: 'leader' });
    if (!users[user]) users[user] = { name: user, aiConfig: {} };
    users[user].activeWs = wsId;
    scheduleSave();
    // 同步等待飞书目录创建成功——成功才返回，失败返回错误
    let feishuFolder = null, feishuError = null;
    try {
      // ★ v1.0.14 先探后建：目录已存在时走三重防线（config 占用 / 内容残留 / 竞态读回），
      //   不再盲走 ensureFolder 幂等——ensure 只认名字，无法区分「全新目录」与「半死残留目录」
      const pre = await searchWorkspaceFolder(name, user);
      if (pre) {
        // a) ★ v1.0.13 同名残留目录防线：目录内已有 _workspace.json = 该名称实际被占
        //   （其他机器的活跃组，或已删除组被旧版成员机僵尸副本复活的残留目录）——拒绝创建（回滚），防「新建组静默挂上旧数据」。
        //   指引：全员升级 v1.0.13+（僵尸不再复活目录）后 Leader 删除该组再重建，或手动删飞书目录。
        const stale = await readWorkspaceConfig(pre.folderToken, user);
        if (stale) {
          feishuError = `飞书已存在同名工作组「${name}」的目录及配置（可能是其他机器上的活跃工作组，或已删除组被未升级成员机复活的残留）。` +
            `如确认该组已删除：请让所有成员机升级到 v1.0.13+ 后，由 Leader 删除该组再重新创建；或手动删除飞书目录 /TeamWork-Demo/${name}/ 后重试`;
        } else {
          // b) ★ v1.0.14 半死目录防线：无 config 但有数据残留（节点文档/[task] 行/NodeMap 等，
          //    排除 Memory/ Skill/ 结构目录）= 已删组的删除缓存窗口残留——复用会让新组周期 pull 拉回旧节点（数据污染），拒绝
          const items = await listWorkspaceDir(pre.folderToken, user);
          const residue = (items || []).filter(f => !['Memory', 'Skill'].includes(f.name));
          if (residue.length) {
            feishuError = `飞书已存在同名目录 /TeamWork-Demo/${name}/（含 ${residue.length} 个数据残留、无工作组配置——疑似已删除组的残留）。` +
              `为避免旧数据混入新组已拒绝创建：请手动删除该飞书目录后重试，或换一个名称创建`;
          } else {
            // c) 空壳目录（仅 Memory/Skill 结构或全空）→ 复用（ensure 幂等补齐结构 + 写自己的 config）
            feishuFolder = await ensureWorkspaceFolder(name, user); // ★ v4.7：以创建者飞书身份建目录（未绑定则 tenant 兜底）
          }
        }
      } else {
        // 全新名称：直接创建目录（含 Memory/ Skill/ 结构）
        feishuFolder = await ensureWorkspaceFolder(name, user); // ★ v4.7：以创建者飞书身份建目录（未绑定则 tenant 兜底）
      }
      if (!feishuFolder && !feishuError) {
        feishuError = '飞书目录创建失败（凭据不可用或权限不足）——请运行 teamwork doctor 诊断';
      }
      if (feishuFolder && !feishuError) {
        workspaces[wsId].feishuFolder = feishuFolder;
        scheduleSave();
        // 写工作组配置到飞书（密码hash存入目录，加入时从飞书读取验证）；★ v1.0.13 config 增加 wsId——join 代际校验/副本 ID 统一的数据源
        const cfgOk = await writeWorkspaceConfig(feishuFolder, {
          name, leader: user, wsId, passHash, salt,
          createdAt: workspaces[wsId].createdAt, memoryLimit: memoryLimit || 1000 }, user); // ★ v4.7：创建者身份写入
        if (!cfgOk) feishuError = '飞书配置文件(_workspace.json)写入失败';
        else {
          // ★ v1.0.14 竞态读回验证：双机同时创建同名组（探目录后、写 config 前被对方抢先）→ 配置被覆盖/同名共存。
          //   读回 config 的 wsId 必须是本组——不是 = 抢注失败 → 回滚（把「双组共用目录、先建者副本被所有权校验误杀」的混乱变成明确报错）
          let back = await readWorkspaceConfig(feishuFolder, user);
          if (!back || back.wsId !== wsId) {
            // 幽灵 token 重试：「删除后立刻重建同名」场景——飞书删除最终一致性缓存窗口内探到幽灵目录、config 写进了
            // 已删 token → 读回失败。重探目录：已不存在 = 上一轮写入无效 → 真重建目录 + 重写 config 再验一次
            const reProbe = await searchWorkspaceFolder(name, user);
            if (!reProbe) {
              console.log('  [create] 读回失败且目录已不存在（config 写进了删除缓存窗口的幽灵 token）→ 真重建一轮');
              feishuFolder = await ensureWorkspaceFolder(name, user);
              if (feishuFolder) {
                workspaces[wsId].feishuFolder = feishuFolder;
                scheduleSave();
                if (await writeWorkspaceConfig(feishuFolder, {
                  name, leader: user, wsId, passHash, salt,
                  createdAt: workspaces[wsId].createdAt, memoryLimit: memoryLimit || 1000 }, user)) {
                  back = await readWorkspaceConfig(feishuFolder, user);
                }
              }
            }
          }
          if (!back || back.wsId !== wsId) {
            feishuError = `创建冲突：另一台机器刚刚创建了同名工作组「${name}」（配置已被抢先写入）。请换一个名称重试，或用名称+密码加入该组`;
          }
        }
      }
    } catch (e) {
      feishuError = '飞书目录创建异常: ' + e.message;
    }
    if (feishuError) {
      // 回滚：删除刚创建的工作组，前端显示失败
      delete workspaces[wsId];
      userWs[user] = userWs[user].filter(w => w.wsId !== wsId);
      if (users[user]?.activeWs === wsId) users[user].activeWs = null;
      scheduleSave();
      return json(res, 502, { error: feishuError, wsId: null });
    }
    // ★ 自动写入本地 token.json（含 wsId——本机 Leader 创建即完成 MCP 配置）
    const reqToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    const localWrite = isLocal && reqToken ? writeLocalTokenFile(reqToken, dn(user), wsId) : false;
    scheduleSave(); triggerSync(workspaces[wsId]); // ★ v4.7.2：milestone 起始节点即时上云（原缺陷：留 local 等下一次操作才被带上云）
    pushWsEvent('switch', wsId, name, user); // ★ v4.6.4 创建工作组 = 切换事件 → inject 通知 → AI 端侧提示
    return json(res, 200, { wsId, name, role: 'leader', feishuFolder, localWrite });
  }

  if (url.pathname === '/api/workspaces/join' && req.method === 'POST') {
    const { wsId, wsName, password, settings } = body;
    let ws = null, targetWsId = wsId;

    // ① 通过 wsId 本地查找
    if (wsId) { ws = workspaces[wsId]; }

    // ② 本地没有 → 通过飞书目录查找（以飞书为真源）
    if (!ws) {
      const feishuName = wsName;
      if (!feishuName) return json(res, 400, { error: '请输入工作组名称' });

      const feishuResult = await searchWorkspaceFolder(feishuName, user); // ★ v4.7：以加入者身份查找（未绑定 tenant 兜底）
      if (!feishuResult) {
        return json(res, 404, { error: `飞书中未找到 /TeamWork-Demo/Memory/${feishuName}/ 目录` });
      }

      // ③ 从飞书目录读取配置（密码hash等）
      const config = await readWorkspaceConfig(feishuResult.folderToken, user); // ★ v4.7：加入者身份读取
      if (!config) {
        return json(res, 500, { error: '飞书目录中未找到 _workspace.json 配置文件' });
      }

      // ④ 用飞书存储的 hash 验证密码
      if (!config.passHash || !config.salt) {
        return json(res, 500, { error: '配置文件缺少密码信息' });
      }
      const inputHash = hashPassword(password, config.salt);
      if (inputHash !== config.passHash) {
        return json(res, 200, { ok: false, error: '工作组密码错误' });
      }

      // ⑤ 密码验证通过 → 检查本地是否有该工作组
      // ★ v1.0.13 代际校验：同名 ≠ 同组（删除后重建同名组是新一代）——
      //   config.wsId 精确命中（新 config）；旧 config（无 wsId）回退 名字+createdAt 同代才复用。
      //   名字命中但代际不同 = 已删除组的僵尸副本 → 顺手墓碑化，走 ⑥ 从云恢复新副本（旧数据不再回魂/挂上新目录污染）
      for (const [id, w] of Object.entries(workspaces)) {
        const sameWs = config.wsId ? id === config.wsId : (w.name === feishuName && w.createdAt === config.createdAt);
        if (sameWs) { ws = w; targetWsId = id; break; }
      }
      if (!ws) {
        const stale = Object.values(workspaces).find(w => w.name === feishuName);
        if (stale) dissolveLocalCopy(stale, '同名重建（检测到新代际组）');
      }

      // ⑥ 本地不存在 → 从飞书配置恢复（服务器重启场景）
      if (!ws) {
        // ★ v1.0.13：新 config 带 wsId → 副本 ID 与 Leader 机统一（多机一致，杜绝「每机恢复随机新 ID」的分裂）；旧 config 回退随机
        targetWsId = (config.wsId && !workspaces[config.wsId]) ? config.wsId : 'ws-' + crypto.randomBytes(4).toString('hex');
        workspaces[targetWsId] = {
          id: targetWsId, name: config.name, leader: config.leader,
          passHash: config.passHash, salt: config.salt,
          memoryLimit: config.memoryLimit || 1000,
          phase: 'OPEN', createdAt: config.createdAt || Date.now(),
          members: {}, tasks: {}, nodes: [], inbox: {}, locks: {},
          seq: 0, checkpoints: [], skills: [],
          consensus: { ver: 0, items: [] }, // ★ v1.0.7：join 恢复副本曾缺此字段 → GET consensus 崩进程（真因）
          feishuFolder: feishuResult.folderToken,
        };
        ws = workspaces[targetWsId];
        console.log(`  [join] 从飞书恢复工作组: ${config.name} (${targetWsId})`);
        // ★ v4.7.2：副本建立后立刻云对齐（拉回节点/[task] 任务流/seq 拉齐）再 push 加入节点——防 ID 撞车（B 机 N-1 会撞 A 机已有 N-1）；fail-open
        try { const r = await cloudSyncOnce(ws, user, { force: true }); if (r) console.log(`  [join] 云对齐: 恢复 ${r.restored} 节点 / ${r.tasks} 任务（seq=${ws.seq}，join 节点从 N-${ws.seq + 1} 起）`); }
        catch (e) { console.warn(`  [join] 云对齐失败（fail-open，首节点可能 ID 撞车）: ${e.message}`); }
      }
      // 确保飞书 folderToken 已关联
      if (!ws.feishuFolder) ws.feishuFolder = feishuResult.folderToken;
    }

    // ⑦ 本地存在时也验证密码
    if (ws.passHash) {
      const inputHash = hashPassword(password, ws.salt);
      if (inputHash !== ws.passHash) return json(res, 200, { ok: false, error: '工作组密码错误' });
    }
    // ⑧ 单活跃约束：已有活跃工作组则拒绝加入
    for (const [id, w] of Object.entries(workspaces)) {
      if (w.members[user] && w.phase === 'OPEN' && id !== targetWsId) {
        return json(res, 200, { ok: false, error: `你已加入活跃工作组「${w.name}」，请先关闭/挂起后再加入新工作组` });
      }
    }
    if (ws.phase === 'DORMANT') {
      // ★ v1.0.9：phase 是本机视图（close/reopen/enter 均为纯本机操作、不上飞书）——成员机副本 DORMANT ≠ Leader 端组状态
      //（Leader 端组很可能 OPEN）。原「member 等待 Leader 重开」在分布式模式下死锁：Leader 感知不到成员本机副本，
      // 报错「工作组已挂起，等 Leader 重开」而 Leader 端组明明开着，双向白等。单活跃已由上方 ⑧ 兜底
      //（存在其他活跃组会先被拒绝），故 join 挂起副本时全员自动重开本机视图（reopen 权限 v4.1 起本就全员可用）。
      ws.phase = 'OPEN';
    }
    if (ws.members[user]) return json(res, 400, { error: '你已是成员' });
    ws.members[user] = { role: 'member', joinedAt: Date.now(), lastSeen: Date.now(),
      identity: null, identityHistory: [], lastConsensusVer: ws.consensus?.ver || 0,
      settings: { autoPush: settings?.autoPush ?? true, autoPull: settings?.autoPull ?? true } };
    if (!userWs[user]) userWs[user] = [];
    userWs[user].push({ wsId: targetWsId, role: 'member' });
    const jm = snapMeta(ws, user, null);
    ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, type: 'change', title: '加入工作组', sync: 'local',
      role: jm.role, topoPath: jm.topoPath, consensusVer: jm.consensusVer });
    scheduleSave();
    triggerSync(ws); // autoPush: 节点自动上传飞书
    // ★ 自动写入本地 token.json（含 wsId——本机用户加入即完成 MCP 配置）
    const joinToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const joinLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    const localWrite = joinLocal && joinToken ? writeLocalTokenFile(joinToken, dn(user), targetWsId) : false;
    pushWsEvent('switch', targetWsId, ws.name, user); // ★ v4.6.4 加入工作组 = 切换事件 → inject 通知 → AI 端侧提示
    return json(res, 200, { wsId: targetWsId, name: ws.name, role: 'member', localWrite });
  }

  // ===== SSE 实时流（/api/ws/:wsId/events）=====
  const sseMatch = url.pathname.match(/^\/api\/ws\/([\w-]+)\/events$/);
  if (sseMatch && req.method === 'GET') {
    const user2 = auth(req); if (!user2) return json(res, 401, { error: '未授权' });
    const ws2 = workspaces[sseMatch[1]];
    if (!ws2 || !ws2.members[user2]) return json(res, 403, { error: '你未加入该工作组' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!sseClients.has(sseMatch[1])) sseClients.set(sseMatch[1], new Set());
    sseClients.get(sseMatch[1]).add(res);
    req.on('close', () => { sseClients.get(sseMatch[1])?.delete(res); });
    return;
  }

  const m = url.pathname.match(/^\/api\/ws\/([\w-]+)\/([\w.-]+)$/);
  if (m) {
    const [, wsId, action] = m;
    const ws = ensureWsShape(workspaces[wsId]); // ★ v1.0.7 公共入口补结构（所有 /api/ws/* 请求必经）
    if (!ws) return json(res, 404, { error: '工作组不存在' });
    const member = ws.members[user];
    if (!member) return json(res, 403, { error: '你未加入该工作组' });
    touchLastSeen(ws, user); // v4.3：心跳（R12/R13 扫描依据）

    if (action === 'status' && req.method === 'GET') {
      const dn = id => users[id]?.name || id; // clientId → 显示名（临时取名）
      // ★ v1.0.11 流程树统一身份格式：临时名(真实唯一身份码)——名字可撞可改，身份码唯一可溯源
      const dnx = id => `${dn(id)}(${id})`;
      // ★ v1.0.11 成员聚合：本机 members ∪ 节点参与者 ∪ Leader——分布式各机独立维护 ws.members（其他机器成员不在本机表），
      //   但节点经飞书全量同步（who=真实参与者 clientId）——节点聚合是"谁在流程里干过活"的跨机真源；云端参与者无本机心跳 → away（灰显）
      const lastActive = new Map();
      for (const n of ws.nodes) if (n.who) lastActive.set(n.who, Math.max(lastActive.get(n.who) || 0, n.when || 0));
      const memberIds = [...new Set([...Object.keys(ws.members), ...lastActive.keys()])];
      if (ws.leader && !memberIds.includes(ws.leader)) memberIds.push(ws.leader);
      const members = memberIds.map(id => {
        const busyTask = Object.entries(ws.locks).find(([, v]) => v === id)?.[0] || null;
        const isLocal = !!ws.members[id];
        return { id, name: dn(id), display: dnx(id),
          status: busyTask ? 'collab-busy' : (isLocal ? 'collab-idle' : 'away'),
          currentTask: busyTask, identity: ws.members[id]?.identity || null,
          lastActive: lastActive.get(id) || ws.members[id]?.lastSeen || null };
      }).sort((a, b) => (a.id === ws.leader ? -1 : b.id === ws.leader ? 1 : ((b.lastActive || 0) - (a.lastActive || 0))));
      return json(res, 200, { wsId, name: ws.name, phase: ws.phase, leader: dnx(ws.leader), leaderId: ws.leader, role: member.role,
        members,
        tasks: Object.values(ws.tasks).filter(t => !t.parent).map(t => ({ id: t.id, what: t.what,
          acceptance: t.acceptance || '', status: t.status,
          subtasks: (t.subtasks || []).map(s => ws.tasks[s] ? { id: s, what: ws.tasks[s].what,
            status: ws.tasks[s].status, assignee: ws.tasks[s].assignee ? dnx(ws.tasks[s].assignee) : null,
            dependsOn: ws.tasks[s].dependsOn || [], domain: resolveDomain(ws, s) } : null).filter(Boolean) })),
        nodes: ws.nodes.map(n => ({ id: n.id, when: n.when, who: dnx(n.who), taskId: n.taskId || null,
          type: n.type, title: n.title, narrative: n.narrative || '', facts: n.facts || [],
          concepts: n.concepts || [], source: n.source || null, sync: n.sync || 'local',
          role: n.role || null, topoPath: n.topoPath || null, consensusVer: n.consensusVer ?? null,
          injectedFrom: n.injectedFrom || [], userMarkedRelated: n.userMarkedRelated || [],
          files: n.files || [],
          revertedIds: n.revertedIds || [], domain: n.domain || null,
          consensusId: n.consensusId || null,
          abandoned: !!n.abandoned, archived: !!n.archived })),
        memory: { total: ws.nodes.length, latest: ws.nodes.slice(-12).reverse().map(n =>
          ({ id: n.id, who: dnx(n.who), type: n.type, title: n.title, when: n.when, sync: n.sync || 'local' })) },
      });
    }
    if (action === 'publish_task' && req.method === 'POST') {
      if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可发布' });
      const { description, acceptance, subtasks, domain } = body;
      const taskId = `T-${++ws.seq}`;
      ws.tasks[taskId] = { id: taskId, parent: null, what: description, acceptance: acceptance || '',
        status: 'running', subtasks: [], publisher: user, when: Date.now(), domain: domain || 'general' };
      const pm = snapMeta(ws, user, taskId);
      ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'summary',
        title: `发布：${description.slice(0, 40)}`, sync: 'local',
        role: pm.role, topoPath: pm.topoPath, consensusVer: pm.consensusVer });
      // TaskSplitter：无 subtasks 时用 Leader 的 AI 拆分
      let subs = subtasks;
      if (!subs || !subs.length) {
        const aiSplit = await splitTaskWithAI(user, ws, description, acceptance);
        if (aiSplit) { subs = aiSplit; console.log(`  [splitter] 拆分为 ${subs.length} 子任务`); }
        else { subs = [{ what: description, dependsOn: [] }]; }
      }
      const created = [];
      const designated = []; const unresolved = []; // ★ v1.0.12 指定人消费：subtasks[].assignee（临时名/身份码/名字(身份码)）→ designee

      for (const s of subs) { const sid = `ST-${++ws.seq}`;
        let dg = null; // ★ v1.0.12 解析指定人（失败回退画像注入，unresolved 提示 Leader AI 转告）
        if (s.assignee) {
          dg = resolveDesignee(ws, s.assignee);
          if (dg) designated.push({ taskId: sid, designee: `${users[dg]?.name || dg}(${dg})`, what: String(s.what).slice(0, 30) });
          else unresolved.push({ taskId: sid, assignee: String(s.assignee), what: String(s.what).slice(0, 30) });
        }
        ws.tasks[sid] = { id: sid, parent: taskId, what: s.what, acceptance: s.acceptance || acceptance || '',
          status: 'ready', assignee: null, designee: dg, dependsOn: [], priority: s.priority || 'P2',
          domain: s.domain || domain || 'general' }; // 拆分器建议的域（画像感知注入依据）；designee 经 [task] dsg 流跨机传播
        ws.tasks[taskId].subtasks.push(sid); created.push({ def: s, id: sid }); }
      for (const { def, id } of created) {
        ws.tasks[id].dependsOn = (def.dependsOn || []).map(d => typeof d === 'number' ? (created[d]?.id ?? d) : d);
        if (!ws.tasks[id].dependsOn.every(d => ws.tasks[d]?.status === 'done')) ws.tasks[id].status = 'blocked'; }
      for (const { id } of created) injectTask(ws, id); // ★ v4.3 画像感知默式注入（skill/身份域匹配定向，无匹配回退全员）
      scheduleSave();
      triggerSync(ws); // autoPush: 发布/拆解节点自动上传飞书
      return json(res, 200, { taskId, subtasks: ws.tasks[taskId].subtasks, aiSplit: !subtasks?.length,
        designated, // ★ v1.0.12 已解析的指定人（designee 格式 名字(身份码)——跨机经 [task] dsg 流传播到其本机收件箱，AI 自动唤起）
        unresolved }); // ★ v1.0.12 解析失败的指定名（回退画像注入——Leader AI 应向用户说明该名字未找到）
    }
    if (action === 'inbox_status' && req.method === 'POST') {
      // ★ v1.0.12 云对齐兜底（同 open-ends 模式，15s 节流）：跨机任务经 [task] 流到达 → 先拉云恢复 tasks + 重建本机收件箱，再返回——
      //   B 机 AI 每次查询收件箱即触发对齐（A 机发布 → [task] 上行 → B 机查询 → 收件箱重建 → AI 看到指定任务）
      try { await cloudSyncOnce(ws, user, {}); } catch {}
      const box = ws.inbox[user] || [];
      return json(res, 200, { count: box.length, items: box.map(x => ({ taskId: x.taskId,
        digest: x.digest, priority: x.priority, lockedBy: ws.locks[x.taskId] || null,
        designated: x.designated || undefined, // ★ v1.0.12 Leader 指定任务标记
        matched: x.matched || undefined })) }); // v4.3：matched = 按 skill/身份域定向注入标记
    }
    if (action === 'ack' && req.method === 'POST') {
      const { taskId } = body; const t = ws.tasks[taskId];
      if (!t) return json(res, 404, { error: '任务不存在' });
      if (t.status === 'done') return json(res, 400, { error: '已完成' });
      if (t.designee && t.designee !== user && !ws.locks[taskId]) // ★ v1.0.12 Leader 指定人守卫：非指定人拾取 → 409（持锁者/指定人本人放行）
        return json(res, 409, { error: `该任务由 Leader 指定给 ${users[t.designee]?.name || t.designee}(${t.designee})，如需接手请联系 Leader`, designee: t.designee });
      const owner = ws.locks[taskId];
      if (owner && owner !== user) return json(res, 409, { error: `已被 ${owner} 拾取`, lockedBy: owner });
      // 注入组装（R1 白名单唯一入口；注入边基于拾取前状态——先组装再入节点）
      const bundle = buildContextBundle(ws, t, user);
      if (!owner) { ws.locks[taskId] = user; t.assignee = user; t.status = 'running';
        ws.inbox[user] = (ws.inbox[user] || []).filter(x => x.taskId !== taskId);
        const meta = snapMeta(ws, user, taskId);
        ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'change',
          title: `拾取：${t.what.slice(0, 40)}`, sync: 'local',
          role: meta.role, topoPath: meta.topoPath, consensusVer: meta.consensusVer,
          injectedFrom: bundle.injectedFromIds }); // ★ RNN 注入边持久化
        scheduleSave(); triggerSync(ws); }
      ws.members[user].lastConsensusVer = ws.consensus?.ver || 0; // R2：Δ 共识感知刷新
      touchLease(ws, taskId, user); // R13：拾取是产出，刷新租约
      // TaskResumeBundle：返回前人进度（如果有）
      const prevNodes = ws.nodes.filter(n => n.taskId === taskId && n.who !== user && n.type === 'summary' && !n.abandoned);
      const resumeBundle = prevNodes.length > 0 ? {
        hasPrevious: true,
        previousAssignee: t.prevAssignee || null,
        completedSummaries: prevNodes.map(n => ({ who: n.who, title: n.title, narrative: n.narrative })),
        relatedMemory: ws.nodes.filter(n => !n.abandoned && n.concepts?.some(c => t.what.toLowerCase().includes(c)) && n.taskId !== taskId).slice(-3)
          .map(n => ({ who: n.who, title: n.title })),
      } : { hasPrevious: false };
      return json(res, 200, { taskId,
        L1: { what: t.what, acceptance: t.acceptance },
        L2: { parent: t.parent ? ws.tasks[t.parent]?.what : '-' },
        L3: { parallel: Object.values(ws.tasks).filter(s => s.parent === t.parent && s.status === 'running' && s.id !== taskId)
          .map(p => `⚙️ ${p.assignee}: ${p.what.slice(0, 30)}`) },
        resume: resumeBundle,
        meta: bundle.meta, // ★ 四维注入（共识层/注入边/拓扑行，wrapInjected 包裹）
      });
    }
    if (action === 'report_done' && req.method === 'POST') {
      const { taskId, summary } = body; const t = ws.tasks[taskId];
      if (!t) return json(res, 404, { error: '任务不存在' });
      if (ws.locks[taskId] !== user && t.assignee !== user) return json(res, 403, { error: '你未持有锁' }); // ★ v4.7.2：继承者（assignee/lease，无锁）同样可报完成——继承链产出闭环
      delete ws.locks[taskId]; t.status = 'done'; t.doneSummary = summary || '';
      for (const u of Object.keys(ws.inbox)) ws.inbox[u] = ws.inbox[u].filter(x => x.taskId !== taskId);
      const rm = snapMeta(ws, user, taskId);
      ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'summary',
        title: `完成：${t.what.slice(0, 36)}`, narrative: summary || '', sync: 'local',
        role: rm.role, topoPath: rm.topoPath, consensusVer: rm.consensusVer });
      touchLease(ws, taskId, user); // R13：完成是产出，刷新租约
      triggerSync(ws); // autoPush
      const unlocked = [];
      for (const s of Object.values(ws.tasks)) { if (s.status === 'blocked' && s.dependsOn?.includes(taskId)) {
        if (s.dependsOn.every(d => ws.tasks[d]?.status === 'done')) { s.status = 'ready';
          injectTask(ws, s.id); // ★ v4.3 画像感知默式注入（skill/身份域匹配定向）
          unlocked.push(s.id); } } }
      return json(res, 200, { ok: true, unlocked });
    }
    if (action === 'share_memory' && req.method === 'POST') {
      // 隐私管线：<private> 剥离 + 正则脱敏
      const clean = sanitizeNode({ title: body.title, narrative: body.narrative });
      const sm = snapMeta(ws, user, body.taskId || null);
      const n = { id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: body.taskId || null,
        type: body.type || 'discovery', title: clean.title, narrative: clean.narrative,
        concepts: body.concepts || [], facts: body.facts || [], sync: 'local',
        files: (Array.isArray(body.files) ? body.files.map(f => String(f).slice(0, 120)).filter(Boolean).slice(0, 10) : []), // ★ v1.0.8：对齐 observe 端文件锚点（观察分层 files_read/files_modified）
        role: sm.role, topoPath: sm.topoPath, consensusVer: sm.consensusVer };
      ws.nodes.push(n);
      touchLease(ws, body.taskId, user); // R13：分享是产出
      scheduleSave();
      triggerSync(ws); // autoPush: 触发飞书同步
      return json(res, 200, { nodeId: n.id, sync: n.sync });
    }
    if (action === 'observe' && req.method === 'POST') {
      // 钩子采集端点（Design 4.4 写路径 / PostToolUse 等价物）：
      // 本地 IDE / 对话框 / 网页对话的原始内容 → 隐私管线 → 用该用户的 AI Provider 总结为 FlowNode（六字段）
      // → 自动上传飞书（注明 上传时间/上传者/概要名）。AI 不可用时 fail-open 降级为截断标题。
      const raw = String(body.content || '').slice(0, 8000);
      if (!raw.trim()) return json(res, 400, { error: 'content 必填' });
      const source = String(body.source || 'chat').slice(0, 40);
      const clean = sanitizeNode({ narrative: raw });
      let title = clean.narrative.trim().replace(/\s+/g, ' ').slice(0, 40);
      let type = 'observation', narrative = clean.narrative, facts = [], concepts = [];
      const aiText = await chatWithUserAI(user, `你是记忆压缩器（chill 哲学：只提炼「painful to rediscover」的内容）。把下面的对话/操作内容总结为一条团队记忆，输出纯 JSON（不要 markdown）：
{"title":"一行标题(≤30字)","type":"summary|decision|bugfix|feature|discovery|change|gotcha","narrative":"2-4句叙事：做了什么、为什么、结论","facts":["关键事实(≤2条)"],"concepts":["小写英文检索标签(≤3个)"]}
内容：${clean.narrative.slice(0, 4000)}`, 600);
      if (aiText) {
        try {
          const j2 = JSON.parse(aiText.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
          if (j2 && j2.title) {
            title = String(j2.title).slice(0, 60);
            type = j2.type || type;
            narrative = sanitizeNode({ narrative: j2.narrative || narrative }).narrative;
            facts = (Array.isArray(j2.facts) ? j2.facts : []).map(f => String(f).slice(0, 200));
            concepts = (Array.isArray(j2.concepts) ? j2.concepts : []).map(c => String(c).toLowerCase().slice(0, 40));
          }
        } catch { console.warn('  [observe] AI 总结输出解析失败，降级为截断标题'); }
      }
      const obm = snapMeta(ws, user, body.taskId || null);
      const n2 = { id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: body.taskId || null,
        type, title, narrative, facts, concepts, source, sync: 'local',
        role: obm.role, topoPath: obm.topoPath, consensusVer: obm.consensusVer,
        userMarkedRelated: (Array.isArray(body.relatedTo) ? body.relatedTo.map(x => String(x).slice(0, 20)).slice(0, 5) : []), // R1：用户标注与注入边分离
        files: (Array.isArray(body.files) ? body.files.map(f => String(f).slice(0, 120)).filter(Boolean).slice(0, 10) : []) }; // ★ claude-mem 观察分层：文件锚点（files_read/files_modified 统一入口）
      ws.nodes.push(n2); scheduleSave();
      touchLease(ws, body.taskId, user); // R13：观察是产出
      triggerSync(ws); // autoPush: 自动上传飞书（含 上传时间/上传者/概要名）
      return json(res, 200, { nodeId: n2.id, type, title, summarized: !!aiText });
    }
    if (action === 'search' && req.method === 'POST') {
      // v4.3 批次四：三层检索——拓扑前缀（确定性轮询）→ 域订阅（身份过滤）→ 关键词（同域优先）
      const mode = body.mode || 'kw';
      const limit = body.limit || 10;
      const myDomain = ws.members[user]?.identity || null;
      const alive = n => !n.abandoned;
      // ★ P1 AutoMemory 对齐：~tokens 估算（知情检索决策——AI 看 token 成本决定是否取详情）
      const estTokens = n => Math.ceil((String(n.title || '').length + String(n.narrative || '').length) / 4) + 30;
      const toR = n => ({ id: n.id, who: dn(n.who), type: n.type, title: n.title, when: n.when,
        topoPath: n.topoPath || null, role: n.role || null, '~tokens': estTokens(n) });
      if (mode === 'topo') { // 拓扑前缀检索（"按拓扑关系轮询前序节点记忆"）
        const prefix = String(body.query || '').replace(/\/+$/, '');
        if (!prefix.startsWith('/')) return json(res, 400, { error: 'topo 查询需以 / 开头（如 /T-3 或 /T-3/ST-6）' });
        let hits = ws.nodes.filter(n => alive(n) && n.topoPath && n.topoPath.startsWith(prefix));
        if (hits.length) return json(res, 200, { results: hits.slice(-limit).reverse().map(toR) });
        // R4 降级链：路径过期/不存在 → 去斜杠当关键词降级检索（fail-open）
        const kw = prefix.replace(/\//g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
        hits = ws.nodes.filter(n => alive(n) && kw.some(k => (String(n.title) + ' ' + String(n.narrative)).toLowerCase().includes(k)));
        return json(res, 200, { results: hits.slice(-limit).reverse().map(toR), degraded: true });
      }
      if (mode === 'domain') { // 域订阅检索（R14：域内优先；0 结果自动扩全组）
        const dom = body.domain || myDomain || 'general';
        const kw = String(body.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const match = n => !kw.length || kw.some(k => (String(n.title) + ' ' + String(n.narrative)).toLowerCase().includes(k));
        const inDom = n => n.role === dom || (n.taskId && resolveDomain(ws, n.taskId) === dom);
        let hits = ws.nodes.filter(n => alive(n) && inDom(n) && match(n));
        if (hits.length) return json(res, 200, { results: hits.slice(-limit).reverse().map(toR), domain: dom });
        const all = ws.nodes.filter(n => alive(n) && match(n));
        return json(res, 200, { results: all.slice(-limit).reverse().map(toR), domain: dom, expanded: true });
      }
      // 默认 kw：关键词 + 同域优先排序（R14）+ 按文件分组（P1 AutoMemory 空间局部性）
      const kw = String(body.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const pool = ws.nodes.filter(n => alive(n) && (!kw.length || kw.some(k => (String(n.title) + ' ' + String(n.narrative)).toLowerCase().includes(k))));
      const sorted = myDomain
        ? [...pool].sort((a, b) => ((b.role === myDomain) - (a.role === myDomain)) || (b.when - a.when))
        : [...pool].sort((a, b) => b.when - a.when);
      const results = sorted.slice(0, limit).map(toR);
      // P1 files 分组：同文件的工作大概率需要同文件的上下文
      const byFiles = {};
      for (const r of results) {
        const n = sorted.find(x => x.id === r.id);
        for (const f of (n?.files || [])) {
          if (!byFiles[f]) byFiles[f] = [];
          byFiles[f].push(r.id);
        }
      }
      return json(res, 200, { results, files: Object.keys(byFiles).length ? byFiles : undefined, hint: '用 teamwork_timeline(id) 看上下文 → teamwork_get_observations(ids) 取详情' });
    }
    if (action === 'timeline' && req.method === 'POST') {
      // ★ 3 层渐进披露 Step 2（AutoMemory timeline）：锚点 ID ± depth 的时间线上下文（含叙事）
      const anchorId = String(body.anchorId || '').trim();
      const depth = Math.min(parseInt(body.depth, 10) || 3, 10);
      if (!anchorId) return json(res, 400, { error: 'anchorId 必填' });
      const sorted = ws.nodes.filter(n => !n.abandoned && !n.archived).sort((a, b) => (a.when || 0) - (b.when || 0));
      const idx = sorted.findIndex(n => n.id === anchorId);
      if (idx === -1) return json(res, 404, { error: `锚点 ${anchorId} 不存在` });
      const from = Math.max(0, idx - depth);
      const to = Math.min(sorted.length, idx + depth + 1);
      const items = sorted.slice(from, to).map(n => ({
        id: n.id, who: dn(n.who), type: n.type, title: n.title, when: n.when,
        narrative: (n.narrative || '').slice(0, 200), // 叙事截断（timeline 是上下文，不是全文）
        topoPath: n.topoPath || null, role: n.role || null,
        isAnchor: n.id === anchorId,
      }));
      return json(res, 200, { anchor: anchorId, depth, total: sorted.length, window: { from, to }, items });
    }
    if (action === 'get_observations' && req.method === 'POST') {
      // ★ 3 层渐进披露 Step 3（AutoMemory get_observations）：按 ID 批量取完整详情（仅确认相关的才取）
      const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x).trim()).filter(Boolean).slice(0, 20) : [];
      if (!ids.length) return json(res, 400, { error: 'ids 必填（节点 ID 数组，≤20）' });
      const items = [];
      const missing = [];
      for (const id of ids) {
        const n = ws.nodes.find(x => x.id === id);
        if (!n || n.abandoned || n.archived) { missing.push(id); continue; }
        items.push({ id: n.id, who: dn(n.who), type: n.type, title: n.title, when: n.when,
          narrative: n.narrative || '', facts: n.facts || [], concepts: n.concepts || [],
          files: n.files || [], topoPath: n.topoPath || null, role: n.role || null,
          domain: n.domain || null, injectedFrom: n.injectedFrom || [], source: n.source || null });
      }
      return json(res, 200, { items, missing, count: items.length });
    }
    if (action === 'close' && req.method === 'POST') {
      // 挂起：所有成员均可触发（成员卡片也有「⏸ 挂起」按钮）
      ws.phase = 'DORMANT';
      ws.checkpoints.push({ at: Date.now(), nodeCount: ws.nodes.length });
      if (users[user]?.activeWs === wsId) users[user].activeWs = null;
      pushWsEvent('close', wsId, ws.name, user); // ★ v4.6.4 挂起事件入册
      writeInjectFile(ws, user); // ★ v4.6.4 同步补写终态 inject 文件（DORMANT 后引擎不再刷新——挂起时刻的任务快照 + 「已挂起」通知常驻，AI 端侧可读）
      return json(res, 200, { ok: true, phase: 'DORMANT' });
    }
    if (action === 'reopen' && req.method === 'POST') {
      // 启动：所有成员均可触发（成员卡片也有「▶ 启动」按钮）
      // 单活跃：先暂存其他活跃工作组
      let prevName = null; // ★ v4.6.4 记录被自动暂存的原工作组名（切换通知展示「从 X 切到 Y」）
      for (const [id, w] of Object.entries(workspaces)) {
        if (w.members[user] && w.phase === 'OPEN' && users[user]?.activeWs === id) {
          w.phase = 'DORMANT';
          w.checkpoints.push({ at: Date.now(), nodeCount: w.nodes.length });
          pushWsEvent('close', id, w.name, user, null, true); // ★ 被暂存组也发挂起事件（auto=true）
          writeInjectFile(w); // ★ 终态补写（不传 dormantBy——靠 auto 事件渲染「因切换自动挂起」文案）
          prevName = w.name;
        }
      }
      ws.phase = 'OPEN';
      if (!users[user]) users[user] = { name: user, aiConfig: {} };
      users[user].activeWs = wsId;
      pushWsEvent('switch', wsId, ws.name, user, prevName); // ★ v4.6.4 启动工作组 = 切换事件
      return json(res, 200, { ok: true, phase: 'OPEN' });
    }
    if (action === 'enter' && req.method === 'POST') {
      // 进入工作组 = 设为该用户的活跃工作组（其他自动暂存）
      let prevName = null; // ★ v4.6.4 记录被自动暂存的原工作组名
      for (const [id, w] of Object.entries(workspaces)) {
        if (w.members[user] && w.phase === 'OPEN' && users[user]?.activeWs === id) {
          w.phase = 'DORMANT';
          w.checkpoints.push({ at: Date.now(), nodeCount: w.nodes.length });
          pushWsEvent('close', id, w.name, user, null, true); // ★ 被暂存组也发挂起事件（auto=true）
          writeInjectFile(w); // ★ 终态补写（不传 dormantBy——靠 auto 事件渲染「因切换自动挂起」文案）
          prevName = w.name;
        }
      }
      if (ws.phase === 'DORMANT' && member.role === 'leader') ws.phase = 'OPEN';
      if (!users[user]) users[user] = { name: user, aiConfig: {} };
      users[user].activeWs = wsId;
      pushWsEvent('switch', wsId, ws.name, user, prevName); // ★ v4.6.4 进入工作组 = 切换事件 → AI 端侧提示「已切换」
      return json(res, 200, { ok: true, phase: ws.phase });
    }
    if (action === 'delete' && req.method === 'POST') {
      if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可删除' });
      const wsName = ws.name;
      const otherMembers = Object.keys(ws.members).filter(id => id !== user); // 其他成员
      delete workspaces[wsId];
      userWs[user] = (userWs[user] || []).filter(w => w.wsId !== wsId);
      // 其他成员的条目标记「已解散」（保留名称供红灯卡片显示），成员确认后 dismiss 清理
      for (const id of otherMembers) {
        if (!Array.isArray(userWs[id])) continue;
        userWs[id] = userWs[id].map(w => w.wsId === wsId ? { ...w, dissolved: true, name: wsName } : w);
      }
      if (users[user]?.activeWs === wsId) users[user].activeWs = null;
      try { fs.unlinkSync(path.join(os.homedir(), '.teamwork', `inject-${wsId}.md`)); } catch {} // ★ v4.6.4 清理 inject 文件（防残留注入）
      scheduleSave();
      // ★ v1.0.14 改同步等待 + 失败告警：云残留（删除中途失败的半死目录+config）会让同名 create 被误判「组还活着」、
      //   新成员 join 撞旧数据——失败必须让 Leader 当场知道（指引手动清理），不能 fail-open 静默
      let cloudDeleted = false;
      try { cloudDeleted = await deleteWorkspaceFolder(wsName, user); } catch (e) { console.warn(`  [delete] 飞书目录删除异常: ${e.message}`); }
      if (!cloudDeleted) {
        return json(res, 200, { ok: true, error: `本地工作组已删除，但飞书目录 /TeamWork-Demo/${wsName}/ 清理未完成（并发冲突或权限问题）。请手动删除该飞书目录——否则新成员加入/同名重建会被拦截` });
      }
      return json(res, 200, { ok: true, feishuDelete: 'ok' });
    }
    if (action === 'leave' && req.method === 'POST') {
      // 成员退出工作组（Leader 不可退出，只能删除整个工作组）
      if (member.role === 'leader') return json(res, 400, { error: 'Leader 不可退出自己创建的工作组，请使用删除' });
      delete ws.members[user];
      delete ws.inbox[user];
      // 释放该成员持有的任务锁，任务回到待拾取
      for (const [tid, owner] of Object.entries(ws.locks)) {
        if (owner === user) { delete ws.locks[tid];
          if (ws.tasks[tid]) { ws.tasks[tid].status = 'ready'; ws.tasks[tid].assignee = null; } } }
      userWs[user] = (userWs[user] || []).filter(w => w.wsId !== wsId);
      if (users[user]?.activeWs === wsId) users[user].activeWs = null;
      const lm = { role: ws.members[user]?.identity || null, topoPath: '/ws', consensusVer: ws.consensus?.ver || 0 };
      ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, type: 'change', title: '退出工作组', sync: 'local',
        role: lm.role, topoPath: lm.topoPath, consensusVer: lm.consensusVer });
      scheduleSave();
      triggerSync(ws); // autoPush: 触发飞书同步
      return json(res, 200, { ok: true });
    }
    if (action === 'inject.md' && req.method === 'GET') {
      // ★ claude-mem live INDEX（Grok 文件注入媒介）/ Kimi 标签隔离 / Folder Context 标签包裹三合一：
      // 无钩子宿主的统一注入源——任何客户端/脚本拉取此 markdown 附加到会话上下文（observe-hook --inject-file 自动落盘原子写）
      const box = ws.inbox[user] || [];
      const conf = (ws.consensus?.items || []).filter(i => i.status === 'confirmed');
      const myIdentity = ws.members[user]?.identity;
      const L = ['<teamwork-inject>'];
      L.push(`# TeamWork · 工作组「${ws.name}」 · 你的身份: ${myIdentity || '未定（可调 open-ends 继承链路获得身份）'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
      if (conf.length) L.push('## 共识（长线约束——LSTM cell state，全程遵守）\n' + conf.map(i => `- [${i.key}] ${i.text}`).join('\n'));
      L.push(box.length
        ? '## 收件箱（可拾取任务 L0 索引——不打断当前工作，自然边界自主拾取）\n' + box.map(x => `- ${x.taskId}: ${x.digest}${x.matched ? ' ⭐（按你的技能/身份定向）' : ''}${ws.locks[x.taskId] ? ` [已被 ${dn(ws.locks[x.taskId])} 拾取]` : ''}`).join('\n')
        : '## 收件箱：当前无待拾取任务（完成后会自动注入新任务）');
      // ★ v1.0.8 静默拾取增强：进行中任务（web 继承 / MCP ack-inherit 均生效）——链上记忆摘要直接内嵌，
      //   继承者零输入即拥有「前人做了什么/怎么做的/卡在哪」（摘要即止，详情留给 timeline/get_observations——渐进披露）
      //   filter 全量渲染（非 find）——一人多任务并行时每个任务的链上下文都注入，不互相遮蔽
      const myTasks = Object.values(ws.tasks).filter(t => t.assignee === user && t.status === 'running');
      for (const t of myTasks) {
        L.push(`## 你的进行中任务 ${t.id}「${t.what.slice(0, 40)}」（${t.domain ? '域: ' + t.domain + '，' : ''}上下文已自动拉齐，直接开发）`);
        if (t.acceptance) L.push(`验收: ${String(t.acceptance).slice(0, 90)}`);
        L.push(...renderTaskChain(ws, t, 10));
      }
      L.push('## 协议提示');
      L.push('- 拾取: MCP teamwork_ack(taskId)（原子抢锁）→ 返回 ContextBundle（共识/注入边/拓扑）');
      L.push('- 完成: teamwork_report_done(taskId, summary)——summary 建议结构：做了什么/关键发现/下一步');
      L.push('- 走不通: teamwork_revert(taskId, reason)——回退到继承点，失败原因沉淀为失败记忆（后人自动注入避免重蹈覆辙）');
      L.push('- 有价值产出/决策/坑: teamwork_observe 静默上报；检索: teamwork_search（你的身份域优先）');
      L.push('</teamwork-inject>');
      L.push('（本段为自动注入内容，标签外的手写内容永不覆盖——云注入恢复会话时以本文件为准）');
      return json(res, 200, { markdown: L.join('\n'), ver: Date.now() });
    }
    if (action === 'restore' && req.method === 'GET') {
      // ★ v4.3.8 基础规则：shareMemory 真源恢复——骨架模式（map.md 一次读取）优先；?full=1 逐个 memory.md 补全内容
      // ★ v4.7.2：合并逻辑抽为 cloudSyncOnce（open-ends 共用）；restore 走 force（前端 20s 轮询保持每次真拉）
      const full = url.searchParams.get('full') === '1';
      try {
        const r = await cloudSyncOnce(ws, user, { full, force: true });
        return json(res, 200, { ok: true, ...(r || { remote: 0, restored: 0, tasks: 0, ops: [] }), total: ws.nodes.length, full });
      } catch (e) {
        console.warn(`  [restore] ${ws.name} 恢复失败（fail-open，显示本地）: ${e.message}`);
        return json(res, 200, { ok: false, error: '飞书恢复失败（fail-open，显示本地状态）: ' + e.message });
      }
    }
    // ===== 共识子系统（ShareMemory v4.3 批次三：LSTM cell state，本地真源 + 版本化快照）=====
    if (action === 'consensus' && req.method === 'GET') {
      const c = ws.consensus;
      const items = c.items.map(i => ({ id: i.id, key: i.key, text: i.text, status: i.status,
        provider: dn(i.provider), when: i.when, sinceVer: i.sinceVer || null,
        confirmations: (i.confirmations || []).map(dn) }));
      return json(res, 200, { ver: c.ver, items, keys: CONSENSUS_KEYS,
        counts: { confirmed: items.filter(i => i.status === 'confirmed').length,
          proposed: items.filter(i => i.status === 'proposed').length,
          arbitration: items.filter(i => i.status === 'arbitration').length,
          archived: items.filter(i => i.status === 'archived').length },
        max: CONSENSUS_MAX });
    }
    if (action === 'consensus' && req.method === 'POST') {
      const c = ws.consensus;
      // 模式一：提议 { text, key }（R2：同 key 已 confirmed → 结构冲突直接转裁决）
      if (body.text) {
        const text = String(body.text).trim().slice(0, 60);
        if (!text) return json(res, 400, { error: '共识内容必填（≤60 字）' });
        if (text.length < 4) return json(res, 400, { error: '共识内容过短（≥4 字）' });
        const key = CONSENSUS_KEYS.includes(body.key) ? body.key : 'other';
        if (c.items.filter(i => i.status === 'confirmed').length >= CONSENSUS_MAX)
          return json(res, 400, { error: `confirmed 已达上限 ${CONSENSUS_MAX}，请先归档旧条目` });
        const clash = c.items.some(i => i.status === 'confirmed' && i.key === key);
        c.seq = (c.seq || 0) + 1;
        const item = { id: `C-${c.seq}`, key, text, provider: user,
          status: clash ? 'arbitration' : 'proposed', when: Date.now(),
          sinceVer: null, confirmations: [user] }; // 提议者自带一票
        c.items.push(item); scheduleSave();
        console.log(`  [consensus] ${ws.name}: ${dn(user)} 提议 [${key}] ${text}${clash ? '（结构冲突→待裁决）' : ''}`);
        return json(res, 200, { ok: true, item: { id: item.id, status: item.status }, conflict: clash });
      }
      // 模式二：确认 { confirmId }（全员确认 or Leader 一票 → confirmed，ver++）
      if (body.confirmId) {
        const it = c.items.find(i => i.id === body.confirmId);
        if (!it) return json(res, 404, { error: '共识条目不存在' });
        if (it.status === 'confirmed') return json(res, 200, { ok: true, already: true });
        if (it.status !== 'proposed') return json(res, 400, { error: '该条目处于裁决/归档状态，不可确认' });
        if (!it.confirmations.includes(user)) it.confirmations.push(user);
        const total = Object.keys(ws.members).length;
        if (member.role === 'leader' || it.confirmations.length >= total) {
          it.status = 'confirmed'; it.sinceVer = c.ver + 1;
          bumpConsensus(ws);
          // 共识生效入图（v4.3.2：协作事件全景——WhenWhoWhat 可见）
          const cm2 = snapMeta(ws, user, null);
          ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: null, type: 'decision',
            title: `⚖️ 共识生效：${String(it.text).slice(0, 30)}`, narrative: `[${it.key}] ${it.text}（确认 ${it.confirmations.length}/${total}）`,
            role: cm2.role, topoPath: '/ws', consensusVer: c.ver, consensusId: it.id, sync: 'local' });
          triggerSync(ws);
          console.log(`  [consensus] ${ws.name}: ${it.id} [${it.key}] ${it.text} → confirmed（v${c.ver}）`);
        }
        scheduleSave();
        return json(res, 200, { ok: true, status: it.status, confirmations: it.confirmations.length, total });
      }
      // 模式三：Leader 归档 { archiveId }
      if (body.archiveId) {
        if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可归档' });
        const it = c.items.find(i => i.id === body.archiveId);
        if (!it) return json(res, 404, { error: '共识条目不存在' });
        it.status = 'archived';
        // ★ 收集被归档的共识节点 id（用于归档事件节点的 revertedIds 墓碑——云恢复时隐藏）
        const archivedNodeIds = [];
        for (const n of ws.nodes) { if (n.consensusId === it.id && !n.archived) { n.archived = true; n.archivedAt = Date.now(); archivedNodeIds.push(n.id); } }
        // ★ v4.4.1 修复：推送归档事件节点（复用 revert 墓碑机制——Feishu 同步 + 主流程可见 + 云恢复时 revertedIds 隐藏原节点）
        if (archivedNodeIds.length) {
          const am = snapMeta(ws, user, null);
          ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: null, type: 'change',
            title: `⚖️ 共识归档：${String(it.text).slice(0, 26)}`,
            narrative: `[${it.key}] ${it.text}（归档，不再注入上下文）`,
            revertedIds: archivedNodeIds, // ★ 墓碑：云恢复时这些节点标 abandoned（隐藏）
            role: am.role, topoPath: '/ws', consensusVer: c.ver, sync: 'local' });
        }
        bumpConsensus(ws); scheduleSave(); triggerSync(ws); // ★ 修复：推送飞书（NodeMap.md + 归档事件 memory.md）
        return json(res, 200, { ok: true, archived: archivedNodeIds.length });
      }
      // 模式四：Leader 裁决 { arbitrateId, accept }（结构冲突/超时条目的终审）
      if (body.arbitrateId) {
        if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可裁决' });
        const it = c.items.find(i => i.id === body.arbitrateId);
        if (!it) return json(res, 404, { error: '共识条目不存在' });
        it.status = body.accept === false ? 'archived' : 'confirmed';
        if (body.accept === false) { // 驳回：同样推送归档事件 + revertedIds 墓碑
          const rejectedIds = [];
          for (const n of ws.nodes) { if (n.consensusId === it.id && !n.archived) { n.archived = true; n.archivedAt = Date.now(); rejectedIds.push(n.id); } }
          if (rejectedIds.length) {
            const rm2 = snapMeta(ws, user, null);
            ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: null, type: 'change',
              title: `⚖️ 共识驳回：${String(it.text).slice(0, 26)}`, narrative: `[${it.key}] ${it.text}（Leader 驳回）`,
              revertedIds: rejectedIds, role: rm2.role, topoPath: '/ws', consensusVer: c.ver, sync: 'local' });
          }
          triggerSync(ws); // ★ 推送飞书
        }
        if (it.status === 'confirmed') {
          it.sinceVer = c.ver + 1; bumpConsensus(ws);
          const cm3 = snapMeta(ws, user, null);
          ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId: null, type: 'decision',
            title: `⚖️ 共识裁决生效：${String(it.text).slice(0, 28)}`, narrative: `[${it.key}] ${it.text}（Leader 裁决）`,
            role: cm3.role, topoPath: '/ws', consensusVer: c.ver, consensusId: it.id, sync: 'local' });
          triggerSync(ws);
        }
        else scheduleSave();
        return json(res, 200, { ok: true, status: it.status });
      }
      return json(res, 400, { error: '参数：{text,key} 提议 | {confirmId} 确认 | {archiveId} 归档(Leader) | {arbitrateId,accept} 裁决(Leader)' });
    }
    // ===== 自主继承协议（ShareMemory v4.3 批次二）=====
    if (action === 'open-ends' && req.method === 'GET') {
      // ★ v4.7.2 云对齐兜底（fail-open，15s 节流）：B 机 AI 未开浏览器时，MCP open-ends 也能看到云端任务（A 机发布 → [task] 行 → B 机可继承）
      try { await cloudSyncOnce(ws, user, {}); } catch {}
      return json(res, 200, { ends: openEndsList(ws, user), identity: ws.members[user]?.identity || null });
    }
    if (action === 'inherit' && req.method === 'POST') {
      const { taskId } = body; const t = ws.tasks[taskId];
      if (!t) return json(res, 404, { error: '任务不存在' });
      if (t.status === 'done') return json(res, 400, { error: '任务已完成，无可继承链路' });
      if (t.assignee || t.lease) return json(res, 409, { error: `该末端已被 ${dn(t.assignee || t.lease?.owner)} 占用（CAS 先到先得）` });
      if (!(t.dependsOn || []).every(d => ws.tasks[d]?.status === 'done'))
        return json(res, 400, { error: '前置依赖未完成，暂不可继承' });
      // 链上末端节点（继承节点 injectedFrom 的来源）
      const chain = ws.nodes.filter(n => n.taskId === taskId && !n.abandoned);
      const lastNode = chain[chain.length - 1] || null;
      const domain = resolveDomain(ws, taskId);
      // ★ 身份赋予（继承的产物——v2 核心翻转）+ 链路归属 + 租约（R13 产出保活）
      ws.members[user].identity = domain;
      const ivMeta = snapMeta(ws, user, taskId); // role 此时已是 domain
      const inhNode = { id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'inherit',
        title: `继承：${t.what.slice(0, 36)}`, narrative: `从末端继承链路并开辟新开发区域（域：${domain}）`,
        role: ivMeta.role, topoPath: ivMeta.topoPath, consensusVer: ivMeta.consensusVer,
        domain, injectedFrom: lastNode ? [lastNode.id] : [], sync: 'local' }; // ★ 继承链上个节点信息（区块链：新块携带链历史）
      if (!Array.isArray(ws.members[user].identityHistory)) ws.members[user].identityHistory = [];
      ws.members[user].identityHistory.push({ domain, since: inhNode.when, via: inhNode.id });
      t.assignee = user; t.status = 'running';
      t.lease = { owner: user, since: inhNode.when, lastActivity: inhNode.when };
      ws.nodes.push(inhNode);
      ws.members[user].lastConsensusVer = ws.consensus?.ver || 0;
      scheduleSave(); triggerSync(ws);
      return json(res, 200, { taskId, identity: domain, inheritNode: inhNode.id, bundle: buildInheritBundle(ws, t, user) });
    }
    if (action === 'revert' && req.method === 'POST') {
      // 回退记忆（R16 reorg 防护 + R17 失败记忆沉淀 + R18 软删）
      const { taskId, reason } = body; const t = ws.tasks[taskId];
      if (!t) return json(res, 404, { error: '任务不存在' });
      const myInh = [...ws.nodes].reverse().find(n => n.type === 'inherit' && n.taskId === taskId && n.who === user && !n.abandoned);
      if (!myInh) return json(res, 400, { error: '未找到你在该链路的继承节点' });
      const crash = ws.nodes.filter(n => !n.abandoned && n.taskId === taskId && n.who === user && n.when > myInh.when && n.id !== myInh.id);
      if (!crash.length) return json(res, 400, { error: '继承点之后没有你的开发节点，无需回退' });
      // ★ 区块链祖先链保护：继承点之前（含继承点、前任产出、发布节点）的拓扑永不被回退触碰
      const protectedCount = ws.nodes.filter(n => n.taskId === taskId && n.when <= myInh.when).length;
      const ids = new Set(crash.map(n => n.id));
      const impact = ws.nodes.filter(n => !ids.has(n.id) && n.who !== user && !n.abandoned && (n.injectedFrom || []).some(i => ids.has(i)))
        .map(n => ({ nodeId: n.id, who: dn(n.who), title: n.title }));
      if (impact.length) return json(res, 409, { error: '崩溃链已被下游消费（reorg 防护），需 Leader 裁决', impact });
      const wasDone = t.status === 'done';
      for (const n of crash) { n.abandoned = true; n.revertedAt = Date.now(); } // R18 软删
      if (wasDone) { t.doneSummary = ''; } // done 状态回滚（R16：依赖重锁由注入条件天然重算）
      t.status = 'ready'; t.assignee = user; // 保留链路归属——从初始继承节点重新开发
      if (ws.locks[taskId] === user) delete ws.locks[taskId];
      if (t.lease) t.lease.lastActivity = Date.now(); // 重新计租
      const rvMeta = snapMeta(ws, user, taskId);
      const rvNode = { id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'revert',
        title: `回退至继承点：${t.what.slice(0, 30)}` + (reason ? '' : '（未说明原因）'),
        narrative: reason ? String(reason).slice(0, 500) : '',
        revertedIds: crash.map(n => n.id), // R18：tombstone 传播（飞书行 [reverted:...])
        role: rvMeta.role, topoPath: rvMeta.topoPath, consensusVer: rvMeta.consensusVer,
        injectedFrom: [myInh.id], sync: 'local' };
      ws.nodes.push(rvNode);
      scheduleSave(); triggerSync(ws);
      console.log(`  [revert] ${ws.name}/${taskId}: ${dn(user)} 回退 ${crash.length} 节点至继承点 ${myInh.id}（祖先链 ${protectedCount} 节点受保护，继承前拓扑不变）`);
      return json(res, 200, { ok: true, reverted: crash.length, revertNode: rvNode.id, taskStatus: 'ready', wasDone, protected: protectedCount });
    }
    if (action === 'release' && req.method === 'POST') {
      if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可解除占用' });
      const { taskId } = body; const t = ws.tasks[taskId];
      if (!t) return json(res, 404, { error: '任务不存在' });
      const who = t.assignee || t.lease?.owner;
      delete ws.locks[taskId]; t.prevAssignee = who || t.prevAssignee; t.assignee = null; t.status = 'ready'; t.lease = null;
      if (who) { const rlm = snapMeta(ws, user, taskId);
        ws.nodes.push({ id: `N-${++ws.seq}`, when: Date.now(), who: user, taskId, type: 'change',
          title: `解除占用：${t.what.slice(0, 30)}（原 ${dn(who)}）`, sync: 'local',
          role: rlm.role, topoPath: rlm.topoPath, consensusVer: rlm.consensusVer }); }
      scheduleSave(); triggerSync(ws);
      return json(res, 200, { ok: true });
    }
    if (action === 'skills' && req.method === 'GET') {
      return json(res, 200, { skills: ws.skills || [] });
    }
    if (action === 'skill_register' && req.method === 'POST') {
      const { name, description, content } = body;
      if (!name || !content) return json(res, 400, { error: '名称和内容必填' });
      if (!ws.skills) ws.skills = [];
      const skill = { id: `SK-${ws.skills.length + 1}`, name, description: description || '',
        content, provider: user, registeredAt: Date.now() };
      ws.skills.push(skill); scheduleSave();
      return json(res, 200, { skillId: skill.id });
    }
    if (action === 'checkpoint' && req.method === 'POST') {
      if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可暂存' });
      ws.phase = 'DORMANT'; return json(res, 200, { ok: true, phase: 'DORMANT' });
    }
    if (action === 'resume' && req.method === 'POST') {
      if (member.role !== 'leader') return json(res, 403, { error: '只有 Leader 可重开' });
      ws.phase = 'OPEN'; return json(res, 200, { ok: true, phase: 'OPEN' });
    }
  }
  return json(res, 404, { error: 'not found' });
}
// ★ v1.0.7 薄壳：任何 handler 内未捕获异常（如字段缺失 TypeError）→ 500 JSON + 崩溃日志，不再变 unhandledRejection 杀进程
const server = http.createServer((req, res) => {
  handleApi(req, res).catch(e => {
    console.error('  [handler] 请求异常（返回 500，server 存活）:', (e && e.stack) || e);
    try { if (!res.headersSent) json(res, 500, { error: '服务器内部错误（已记录，server 存活）: ' + ((e && e.message) || String(e)) }); } catch {}
  });
});

loadState(); // 启动时恢复持久化状态（全部 DORMANT）

// ===== SSE 实时推送（替代 3s 轮询）=====
const sseClients = new Map(); // wsId -> Set<res>
function sseBroadcast(wsId, data) {
  const clients = sseClients.get(wsId);
  if (!clients) return;
  const msg = `event: status\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}
setInterval(() => { // 心跳广播（2s/拍，同时充当增量推送）
  for (const [wsId, clients] of sseClients) {
    if (!clients.size) continue;
    const ws = workspaces[wsId];
    if (!ws) continue;
    // 轻量快照
    const snap = { wsId, phase: ws.phase, nodeCount: ws.nodes.length, members: Object.keys(ws.members).map(n => ({
      name: dn(n), status: Object.values(ws.locks).includes(n) ? 'collab-busy' : 'collab-idle' })) };
    sseBroadcast(wsId, snap);
  }
}, 2000);

// ★ v1.0.8 静默拾取增强：任务链上下文渲染（HTTP inject.md 与 writeInjectFile 本地版共用）
// 依赖闭包内全部节点（含前序任务——继承场景「前人做了什么/怎么做的/卡在哪」）按时间序取最近 maxN 条；
// 渐进披露：此处只给 L0/L1 摘要，完整叙事留给 teamwork_timeline / teamwork_get_observations（L2）——继承者零输入即拥有上下文
function taskContextNodeIds(ws, task) {
  const ids = new Set([task.id]);
  const q = [...(task.dependsOn || [])];
  while (q.length) { const id = q.shift(); if (!id || ids.has(id)) continue; ids.add(id); const t = ws.tasks[id]; if (t) q.push(...(t.dependsOn || [])); }
  return ids;
}
function renderTaskChain(ws, task, maxN = 10) {
  const ids = taskContextNodeIds(ws, task);
  const ns = ws.nodes.filter(n => n.taskId && ids.has(n.taskId) && !n.abandoned);
  if (!ns.length) return ['链上暂无节点记录（新任务——你就是第一个，产出记得 teamwork_share_memory 沉淀）'];
  const L = [`链上前人记忆（共 ${ns.length} 节点，最近 ${Math.min(maxN, ns.length)} 条——谁在何时做了什么/卡在哪）:`];
  for (const n of ns.slice(-maxN)) {
    const ts = new Date(n.when).toISOString().slice(5, 16).replace('T', ' ');
    const nar = String(n.narrative || '').replace(/\s+/g, ' ').trim();
    L.push(`  - ${n.id} [${ts}] ${dn(n.who)} ${n.type}${n.title ? `「${String(n.title).slice(0, 30)}」` : ''}${nar ? '——' + nar.slice(0, 90) : ''}${Array.isArray(n.files) && n.files.length ? ` 📄${n.files.length}` : ''}`);
    if (Array.isArray(n.facts) && n.facts.length) L.push(`    facts: ${n.facts.slice(0, 2).map(String).join('；').slice(0, 120)}`);
  }
  if (ns.length > maxN) L.push(`  （更早 ${ns.length - maxN} 条 → teamwork_timeline("${ns[ns.length - maxN].id}", depth=10) 拉前后上下文）`);
  L.push('  需要完整叙事/文件锚点 → teamwork_get_observations([节点ID])（摘要防上下文膨胀，详情按需拉取）');
  return L;
}

// ★ v4.6.4 写单个工作组的 inject 文件：引擎每 3s 调（OPEN 组）/ close 终态补写复用——头部渲染「🔔 工作组切换通知」
function writeInjectFile(ws, dormantBy) {
  const injectDir = path.join(os.homedir(), '.teamwork');
  try { fs.mkdirSync(injectDir, { recursive: true }); } catch { return; }
  const lines = ['<teamwork-inject>'];
  lines.push(`# TeamWork · ${ws.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  // ★ v4.6.4 切换通知（TTL 内最新一条事件）：switch → 「已切换到本组，token 可能仍指旧组」；close → 「本组已挂起」
  const ev = (wsEvents || []).filter(e => e.wsId === ws.id && Date.now() - e.at < WS_EVENT_TTL_MS).slice(-1)[0];
  if (dormantBy || (ev && ev.type === 'close')) {
    const who = dormantBy || (ev ? ev.by : '');
    const auto = !dormantBy && ev ? ev.auto : false;
    lines.push('## 🔔 工作组状态通知（本组已挂起）');
    lines.push(`- 工作组「${ws.name}」(${ws.id}) ${auto ? `因「${dn(who)}」切换到其他工作组而被自动挂起` : `已被「${dn(who)}」挂起`}——以下任务快照冻结暂停`);
    lines.push(`- ⚠ 本机 AI 对话端的 MCP 若仍指向本组：调用会静默成功但操作的是挂起组！如需继续本组工作，请提示用户在 Web 页面「▶ 启动」；如需切换到其他活跃工作组，调用 teamwork_join(user, password, wsId="目标组ID")`);
  } else if (ev && ev.type === 'switch') {
    const tstr = new Date(ev.at).toISOString().slice(5, 16).replace('T', ' ');
    lines.push(`## 🔔 工作组切换通知（${tstr} 由「${dn(ev.by)}」操作）`);
    lines.push(`- 已${ev.prevName ? `从「${ev.prevName}」切换到` : '进入'}本工作组「${ws.name}」(${ws.id})${ev.prevName ? '，原工作组已自动挂起' : ''}`);
    lines.push(`- ⚠ 本机 AI 对话端的 MCP token.json 可能仍指向旧组！请**主动在对话中提示用户「已切换到工作组「${ws.name}」」**；如需操作本组：调用 teamwork_join(user, password, wsId="${ws.id}")`);
  }
  const conf = (ws.consensus?.items || []).filter(i => i.status === 'confirmed');
  if (conf.length) lines.push('## 共识（全程约束，必须遵守）\n' + conf.map(i => `- [${i.key}] ${i.text}`).join('\n'));
  // 全员收件箱（有任务的成员才生成——AI 看到自己的任务自动拾取）
  for (const [userId, member] of Object.entries(ws.members)) {
    const box = ws.inbox[userId] || [];
    const identity = member.identity || '未定';
    const dnName = dn(userId);
    // ★ v1.0.8：filter 全量渲染（非 find）——一人多任务并行时每个任务的链上下文都注入，不互相遮蔽
    const myTasks = Object.values(ws.tasks).filter(t => t.assignee === userId && t.status === 'running');
    // ★ 不跳过任何人——Leader/成员只要有任务（收件箱或有进行中任务）就写入 inject 文件
    if (!box.length && !myTasks.length) continue;
    lines.push(`## ${dnName}（身份: ${identity}）`);
    if (myTasks.length) {
      for (const t of myTasks) {
        lines.push(`当前任务: ${t.id}「${t.what.slice(0, 40)}」(进行中${t.domain ? `，域: ${t.domain}` : ''})`);
        if (t.acceptance) lines.push(`验收: ${String(t.acceptance).slice(0, 90)}`);
        lines.push(...renderTaskChain(ws, t, 10));
        lines.push(`产出/踩坑 → teamwork_share_memory；完成 → teamwork_report_done("${t.id}", summary: 做了什么/关键发现/下一步)；走不通 → teamwork_revert("${t.id}", reason)`);
      }
    } else if (box.length) {
      lines.push(`待拾取任务:`);
      for (const x of box.slice(0, 5)) lines.push(`  - ${x.taskId}: ${x.digest}`);
      lines.push(`拾取 → 调用 teamwork_ack("${box[0].taskId}")`);
    }
  }
  lines.push('</teamwork-inject>');
  try { fs.writeFileSync(path.join(injectDir, `inject-${ws.id}.md`), lines.join('\n'), 'utf8'); } catch {}
}

// ★ 静默注入引擎（v4.6）：Server 后台定时写 ~/.teamwork/inject.md——AI 工具自动读取（Grok live INDEX 模式）
// 每个 OPEN 工作组的每个成员：独立 inject 文件（inject-{wsId}.md）——含收件箱任务 + 共识 + 身份 + 切换通知
let _injectTimer = null;
function startInjectWriter() {
  if (_injectTimer) return;
  _injectTimer = setInterval(() => {
    for (const [, ws] of Object.entries(workspaces)) {
      if (ws.phase !== 'OPEN') continue;
      // ★ v1.0.12 周期云对齐（fire-and-forget，fail-open）：15s 节流内置于 cloudSyncOnce——
      //   B 机 server 常驻即周期拉云（A 机发布 → [task] 流 → B 机收件箱重建 → inject 文件刷新 → AI 下次回复读到新任务自主拾取）
      cloudSyncOnce(ws, null, {}).catch(() => {});
      writeInjectFile(ws);
    }
  }, 3000); // 每 3 秒刷新（云对齐实际 ~15s 一次——_lastCloudSync 节流）
  console.log('  ✦ 静默注入引擎已启动（~/.teamwork/inject-{wsId}.md 每 3s 刷新 + v4.6.4 切换通知 + v1.0.12 周期云对齐）');
}
setInterval(() => {
  const now = Date.now();
  for (const ws of Object.values(workspaces)) {
    if (ws.phase !== 'OPEN') continue;
    let changed = false;
    for (const t of Object.values(ws.tasks)) {
      if (t.status === 'running' && t.assignee) {
        const mem = ws.members[t.assignee];
        // ★ v4.7.2 云恢复任务守卫：assignee 非本机成员（在别的 server 上活着——B 机心跳只刷新 B 机 lastSeen）→ 本机不裁决其活性，跳过回收
        if (!mem) continue;
        const seen = mem?.lastSeen || 0;
        const expired = mem ? (seen > 0 && now - seen > HEARTBEAT_TIMEOUT_MS) : true;
        if (expired) {
          delete ws.locks[t.id];
          t.prevAssignee = t.assignee; t.assignee = null; t.status = 'ready'; t.lease = null;
          const hm = snapMeta(ws, t.prevAssignee, t.id); // ★ v4.7.2 补节点（原缺陷：心跳回收无审计痕迹）+ triggerSync（v4.4.1 归档同型缺陷：节点生成了但没上云）
          ws.nodes.push({ id: `N-${++ws.seq}`, when: now, who: t.prevAssignee, taskId: t.id, type: 'change',
            title: `心跳超时回收：${t.what.slice(0, 26)}`, narrative: `成员 ${dn(t.prevAssignee)} 心跳超时（${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)}s 无活动），任务重回末端`,
            sync: 'local', role: hm.role, topoPath: hm.topoPath, consensusVer: hm.consensusVer });
          changed = true;
          triggerSync(ws);
          console.log(`  [scan] ${ws.name}/${t.id} 心跳超时回收（${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)}s 无活动），重回末端`);
        }
      }
      // R13：租约超时（人在但不产出）→ 回收 + 审计入图（区别于心跳回收）
      if (t.status === 'running' && t.lease && now - (t.lease.lastActivity || 0) > LEASE_TIMEOUT_MS) {
        const who = t.lease.owner;
        delete ws.locks[t.id];
        t.prevAssignee = who; t.assignee = null; t.status = 'ready'; t.lease = null;
        const meta = snapMeta(ws, who, t.id);
        ws.nodes.push({ id: `N-${++ws.seq}`, when: now, who, taskId: t.id, type: 'change',
          title: `租约超时回收：${t.what.slice(0, 26)}`, sync: 'local',
          role: meta.role, topoPath: meta.topoPath, consensusVer: meta.consensusVer });
        changed = true;
        triggerSync(ws); // ★ v4.7.2 补上云（原缺陷：节点生成但未 triggerSync——云侧看不到回收事件）
        console.log(`  [scan] ${ws.name}/${t.id} 租约超时回收（${Math.round(LEASE_TIMEOUT_MS / 1000)}s 无产出），链路重回末端`);
      }
    }
    // R2：proposed 挂起超时 → 转 arbitration（Leader 裁决；confirmed 集合未变故不 ver++）
    for (const it of (ws.consensus?.items || [])) {
      if (it.status === 'proposed' && now - (it.when || 0) > CONSENSUS_ARBITRATE_AFTER_MS) {
        it.status = 'arbitration'; changed = true;
        console.log(`  [scan] ${ws.name}: 共识 ${it.id}「${String(it.text).slice(0, 20)}」挂起超时转裁决`);
      }
    }
    if (changed) { scheduleSave(); sseBroadcast(ws.id, { wsId: ws.id, phase: ws.phase, nodeCount: ws.nodes.length }); }
  }
}, SCAN_INTERVAL_MS);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ 端口 ${PORT} 被占用（上一个 server 的 TCP 连接还在 TIME_WAIT）`);
    console.error('  解决：等 1-2 分钟自动释放，或换端口启动：');
    console.error('    PowerShell: $env:PORT=8788; npm start');
    process.exit(1);
  }
  console.error('Server error:', e);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ✦ v4.6.5 Server ready (silent injection + state persistence + SSE + graceful shutdown)`);
  console.log(`  ▸ 监听 ${HOST === '0.0.0.0' ? '0.0.0.0（中心化模式——外部可访问）' : `${HOST}（本机模式 v4.7.1——跨机共享走飞书云文档）`}`);
  // ★ v4.6.5 运行时文件：PID（teamwork stop 优雅停止用）+ shutdown secret（CLI 停止握手防误停）——exit 时自动清理
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  try { fs.writeFileSync(SECRET_FILE, crypto.randomBytes(16).toString('hex')); } catch {}
  initFeishu().then(ok => { if (ok) { console.log('  ✦ Feishu auto-sync activated'); setUserLookup(id => users[id]?.name || id); setPersistHook(() => scheduleSave()); } }); // ★ v4.7.2：doSync 落盘钩子（synced 标记/任务签名）
  // ★ v4.7 用户身份：per-user 飞书 token 存取桥（feishuToken 持久化在 state.users——server 重启不丢，续期自动回写）
  setUserTokenAccess(
    id => users[id]?.feishuToken || null,
    (id, t) => { if (users[id]) { users[id].feishuToken = { ...users[id].feishuToken, ...t }; scheduleSave(); } }
  );
  startInjectWriter(); // ★ v4.6 静默注入引擎：写 ~/.teamwork/inject-{wsId}.md（AI 工具自动读取）
});
