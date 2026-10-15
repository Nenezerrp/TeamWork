/**
 * feishu-sync.js —— 飞书 MemoryShare 自动同步引擎（M1 落地）
 * 
 * 对应设计：Design 4.6 + Risk-Review 3.4/3.7 L2
 * 数据流：FlowNode(sync: local) → 防抖批量(1.5s) → 飞书 docx 每日文档（幂等=UUID 锚点）
 * 
 * 凭据通道（自动选择）：
 *   1. tenant_token（FEISHU_APP_ID + FEISHU_APP_SECRET，SDK 管理）——审批通过后自动生效
 *   2. user_access_token（OAuth，复用 demo/.local/user-token.json）——审批等待期通道
 * 
 * 幂等：条目 = 块内容 [mem:<uuid>] 开头（同 demo 已验证格式）；重复运行全跳过
 * 隐私（v3.8 4.8）：写入前过 `<private>` 标签剥离 + 正则脱敏（Auto-Redaction 内置模式）
 */

'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://open.feishu.cn';

// ---------- 配置 ----------
const FEISHU_ENABLED = (process.env.TEAMWORK_FEISHU_ENABLED || 'true') === 'true';
// ★ v4.7.3 凭据兜底：env 缺失时读 ~/.teamwork/feishu.json（feishu-auth CLI 首次运行自动持久化）
//   背景：全局安装的 server 无 .env（打包白名单排除）→ 凭据全空 → tenant 通道与 refresh_token 续期（需 client_id/secret）全部失败
//   成员/Leader 机跑过一次 feishu-auth 后凭据闭环，无需分发 .env
function _credFallback() {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) return null; // env 优先（显式配置时不读文件）
  try {
    const p = path.join(os.homedir(), '.teamwork', 'feishu.json');
    // 容错剥 BOM（Windows PowerShell 5.1 -Encoding UTF8 写的是 BOM 版，JSON.parse 会炸）
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (j.appId && j.appSecret) { console.log(`  [feishu] env 未配置，凭据兜底自: ${p}`); return j; }
  } catch {}
  return null;
}
const _cred = _credFallback();
// ★ v1.0.5：内置默认凭据（企业内部工具——README/INSTALL 已明文分发同值，内嵌使新成员「装完即用」：
//   tenant 通道零配置可用；个人身份模式（feishu-auth）仍需飞书后台可用范围白名单 + 用户主动授权）
const BUILTIN_APP_ID = 'cli_aa46d13079b99bc2';
const BUILTIN_APP_SECRET = ''; // 公开发布版已移除内置凭据——请通过 .env / feishu-auth / ~/.teamwork/feishu.json 配置自己的飞书应用凭据
const APP_ID = process.env.FEISHU_APP_ID || (_cred && _cred.appId) || BUILTIN_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET || (_cred && _cred.appSecret) || BUILTIN_APP_SECRET;
const USER_TOKEN_PATH = process.env.TEAMWORK_USER_TOKEN_PATH ||
  path.resolve(__dirname, '..', '..', 'demo', '.local', 'user-token.json');
// ★ v4.7 用户身份：共享根目录显式 token（Leader 指定目录，如应用空间的 TeamWork-Demo）
// 成员的个人身份（user_access_token）从"我的空间"发现不了它 → 必须显式配置，全员在其下建/搜/删工作组目录
// ★ v4.7.3：rootFolder 一并兜底自 feishu.json（feishu-auth --root-folder 分发）——全局安装无 .env 时缺它则建组/搜组必失败
const ROOT_FOLDER = process.env.FEISHU_ROOT_FOLDER || (_cred && _cred.rootFolder) || 'GpLsfKxo4lYcludu39UcB2GTnrf'; // 尾端内置默认（v1.0.5，同凭据）

// ---------- 令牌桶（对齐 L0 F5）----------
function makeBucket(qps) { return { qps, tokens: qps, last: Date.now() }; }
async function acquire(b) {
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(b.qps, b.tokens + ((now - b.last) / 1000) * b.qps);
    b.last = now;
    if (b.tokens >= 1) { b.tokens -= 1; return; }
    await new Promise(r => setTimeout(r, Math.ceil((1 - b.tokens) / b.qps * 1000)));
  }
}
const _bucket = makeBucket(4);
const _blockBucket = makeBucket(2);

// ---------- 隐私管线（v3.8 4.8 简化版）----------
const SECRET_PATTERNS = [
  { name: 'openai_key', re: /sk-[a-zA-Z0-9]{20,}/g, repl: '<redacted type="openai_key"/>' },
  { name: 'anthropic_key', re: /sk-ant-[a-zA-Z0-9-]{20,}/g, repl: '<redacted type="anthropic_key"/>' },
  { name: 'github_pat', re: /gh[pso]_[a-zA-Z0-9]{36,}/g, repl: '<redacted type="github_pat"/>' },
  { name: 'aws_key', re: /AKIA[0-9A-Z]{16}/g, repl: '<redacted type="aws_key"/>' },
];
function sanitize(text) {
  let out = String(text || '');
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.repl);
  return out;
}
function stripPrivate(text) {
  return String(text || '').replace(/<private>[\s\S]*?<\/private>/g, '');
}

// ---------- 凭据管理 ----------
let _tenantToken = null;
let _tenantExpiry = 0;
async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantExpiry) return _tenantToken;
  const res = await fetch(`${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`tenant_token 获取失败: code=${j.code} ${j.msg}`);
  _tenantToken = j.tenant_access_token;
  _tenantExpiry = Date.now() + (j.expire || 7000) * 1000 - 300000; // 提前5分钟过期
  console.log('  [feishu] tenant_token 获取成功');
  return _tenantToken;
}

function loadUserToken() {
  try { return JSON.parse(fs.readFileSync(USER_TOKEN_PATH, 'utf8')); } catch { return null; }
}
async function refreshUserToken(t) {
  const res = await fetch(`${API_BASE}/open-apis/authen/v2/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: 'refresh_token', refresh_token: t.refreshToken }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`refresh 失败: ${JSON.stringify(j).slice(0, 150)}`);
  // 续期响应可能不带 refresh_token（未轮换场景）→ 保底沿用旧值，避免续期链断裂
  return { accessToken: j.access_token, refreshToken: j.refresh_token || t.refreshToken, expiresAt: Date.now() + (j.expires_in || 6000) * 1000 - 60000 };
}

// ★ v4.7 用户身份：per-user 飞书 token（每个成员 OAuth 绑定自己已登录的飞书账号，由 index.js 注入存取）
// token 持久化在 state 的 users[clientId].feishuToken（server 重启不丢，refresh ~30 天自动续期）
let _userTokenProvider = null; // (actor) => {accessToken, refreshToken, expiresAt} | null
let _userTokenSaver = null;    // (actor, tokenObj) => void（续期后持久化回 state）
export function setUserTokenAccess(provider, saver) { _userTokenProvider = provider; _userTokenSaver = saver; }

/** 操作者的个人飞书身份 token（过期自动用 refresh_token 续期） */
async function getActorToken(actor) {
  if (!actor || !_userTokenProvider) return null;
  const t = _userTokenProvider(actor);
  if (!t || !t.accessToken) return null;
  if (Date.now() < (t.expiresAt || 0)) return t.accessToken; // 未过期，直接用
  try {
    const nt = await refreshUserToken(t);
    if (_userTokenSaver) _userTokenSaver(actor, nt);
    console.log(`  [feishu] user_token 续期成功（${actor}）`);
    return nt.accessToken;
  } catch (e) {
    console.warn(`  [feishu] user_token 续期失败（${actor}）: ${e.message}`);
    return null;
  }
}

async function getToken(actor) {
  // ★ v4.7 用户身份优先：操作者绑定过飞书（feishu-auth）→ 一切飞书操作以其个人身份执行
  if (actor) {
    const ut = await getActorToken(actor);
    if (ut) return ut;
    // 未绑定 → 落到 tenant 兜底（渐进可用：绑定后自动切用户身份）
  }
  // legacy：demo 单一 user_token 文件通道（Leader 本机历史链路，向后兼容）
  // 注意：_preferUserToken=true 表示已降级偏好 user_token → 更要走这条路
  //（原 if(!...) 判断写反：降级一次后 user_token 通道被永久关闭，导致后续全部 502）
  const ut = loadUserToken();
  if (ut) {
    if (Date.now() < (ut.expiresAt || 0)) {
      return ut.accessToken; // 未过期，直接用
    }
    if (!ut.refreshToken) {
      // ★ v4.7.3：无 refreshToken 的旧 token（demo 时代 v2 授权产物）不再反复尝试续期——每次启动必报错且必失败
      console.log('  [feishu] legacy user_token 已过期且无 refreshToken，跳过（tenant 通道兜底）');
    } else {
      try {
        const nt = await refreshUserToken(ut);
        fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify(nt, null, 1));
        console.log('  [feishu] legacy user_token 自动续期成功');
        return nt.accessToken;
      } catch (e) {
        console.warn(`  [feishu] legacy user_token 续期失败: ${e.message}`);
      }
    }
  }
  // fallback: tenant_token（应用身份——未绑定用户兜底 + 根目录共享等管理操作）
  if (APP_ID && APP_SECRET) {
    try { return await getTenantToken(); } catch (e) { console.warn(`  [feishu] tenant 不可用: ${e.message}`); }
  }
  return null;
}

// ---------- 飞书 API（原生 fetch，URL 与 demo 实测一致）----------
let _preferUserToken = false; // tenant 99991672 时自动切换

async function api(method, url, { params, data, actor } = {}) {
  let token = await getToken(actor);
  if (!token) throw new Error('飞书凭据不可用（无 tenant_token / user_token）');
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  await acquire(method.includes('block') ? _blockBucket : _bucket);
  const httpMethod = method === 'POST_block' ? 'POST' : method; // ★ 修复：POST_block 是令牌桶标识非 HTTP 方法——此前原样发送导致全部 append 静默假成功

  let res = await fetch(`${API_BASE}${url}${qs}`, {
    method: httpMethod,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  let j = await res.json().catch(() => ({}));

  // tenant 权限不足（99991672）→ 自动降级 user_token 重试一次
  if (j.code === 99991672 && !_preferUserToken) {
    _preferUserToken = true;
    console.log('  [feishu] tenant 权限不足，降级 user_token 通道');
    const ut = loadUserToken();
    if (ut) {
      if (Date.now() >= (ut.expiresAt || 0)) {
        const nt = await refreshUserToken(ut);
        fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify(nt, null, 1));
        token = nt.accessToken;
      } else {
        token = ut.accessToken;
      }
      res = await fetch(`${API_BASE}${url}${qs}`, {
        method: httpMethod,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
        body: data !== undefined ? JSON.stringify(data) : undefined,
      });
      j = await res.json().catch(() => ({}));
    }
  }

  if (j.code !== undefined && j.code !== 0) {
    const err = new Error(`飞书业务错误 code=${j.code} msg=${j.msg || j.message} [${url}]`);
    err.code = j.code;
    throw err;
  }
  return j.data !== undefined ? j.data : j;
}

// ---------- 高层操作（与 demo 实测一致的 URL）----------
/** ★ v4.7：共享根目录 token（显式配置优先；未配置时按老方式发现——tenant/owner 视角兼容） */
async function rootFolderToken(actor) {
  if (ROOT_FOLDER) return ROOT_FOLDER;
  return ensureFolder('', process.env.TEAMWORK_DEMO_WORKSPACE || 'TeamWork-Demo', actor);
}

async function findChildByName(folderToken, name, actor) {
  let pageToken;
  do {
    const d = await api('GET', '/open-apis/drive/v1/files', { params: { page_size: 200, folder_token: folderToken, ...(pageToken ? { page_token: pageToken } : {}) }, actor });
    for (const f of d.files || []) if (f.name === name) return f;
    pageToken = d.page_token;
  } while (pageToken);
  return null;
}

async function ensureFolder(parentToken, name, actor) {
  const existed = await findChildByName(parentToken, name, actor);
  if (existed && existed.type === 'folder') return existed.token;
  const d = await api('POST', '/open-apis/drive/v1/files/create_folder', { data: { name, folder_token: parentToken }, actor });
  return d.token;
}

export async function ensureDailyDoc(folderToken, title, actor) {
  const existed = await findChildByName(folderToken, title, actor);
  if (existed && existed.type === 'docx') return existed.token;
  const d = await api('POST', '/open-apis/docx/v1/documents', { data: { folder_token: folderToken, title }, actor });
  return d.document.document_id;
}

async function appendBlocks(documentId, texts, actor) {
  const children = texts.map(t => ({ block_type: 2, text: { elements: [{ text_run: { content: t } }] } }));
  return api('POST_block', `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, { data: { children }, actor });
}

async function listDocTexts(documentId, actor) {
  const texts = [];
  let pageToken;
  do {
    const d = await api('GET', `/open-apis/docx/v1/documents/${documentId}/blocks`, { params: { page_size: 500, document_revision_id: -1, ...(pageToken ? { page_token: pageToken } : {}) }, actor });
    if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [blocks-dbg] doc=${String(documentId).slice(0, 8)} items=${(d.items || []).length} types=${JSON.stringify([...new Set((d.items || []).map(i => i.block_type))])}`);
    for (const item of d.items || []) {
      if (item.block_type === 2 && item.text && Array.isArray(item.text.elements)) {
        texts.push(item.text.elements.map(el => (el.text_run && el.text_run.content) || '').join(''));
      }
    }
    pageToken = d.page_token;
  } while (pageToken);
  return texts;
}

// ---------- 共识快照（R9：本地真源 + 版本化快照文档，ver 变更防抖上传）----------
const _lastSnapVer = new Map(); // wsId -> 已快照 ver（同 ver 幂等）
let _consensusTimer = null;
export function triggerConsensusSync(state, delayMs = parseInt(process.env.TEAMWORK_CONSENSUS_SNAPSHOT_DELAY_MS || '30000', 10)) {
  if (!FEISHU_ENABLED || _stopped || !state || !state.consensus) return;
  clearTimeout(_consensusTimer);
  _consensusTimer = setTimeout(() => doConsensusSnapshot(state).catch(e =>
    console.warn(`  [feishu] 共识快照失败（fail-open）: ${e.message}`)), delayMs);
}
async function doConsensusSnapshot(state) {
  const c = state.consensus; const ver = c.ver;
  if (_lastSnapVer.get(state.id) === ver) return; // 同 ver 幂等跳过
  const actor = state.leader; // ★ v4.7：共识快照以组 Leader 飞书身份上传（未绑定则 tenant 兜底）
  const root = await rootFolderToken(actor);
  const wsToken = await ensureFolder(root, state.name, actor);   // /TeamWork-Demo/<工作组名>/
  const prov = await ensureFolder(wsToken, 'Memory', actor);      // /工作组名/Memory/
  const title = `consensus-snapshot-v${ver}.md`;
  const docId = await ensureDailyDoc(prov, title, actor);
  const existing = await listDocTexts(docId, actor);
  if (existing.some(t => t.includes(`[共识快照 v${ver}]`))) { // 重启后重放幂等锚点
    _lastSnapVer.set(state.id, ver); return; }
  const g = s => c.items.filter(i => i.status === s);
  const lines = [`[共识快照 v${ver}] 组: ${state.name} · 更新: ${new Date().toISOString()} · confirmed ${g('confirmed').length} / proposed ${g('proposed').length} / arbitration ${g('arbitration').length} / archived ${g('archived').length}`];
  lines.push('## confirmed（全员/Leader 确认，注入 ContextBundle L-1 层）');
  for (const i of g('confirmed')) lines.push(`- [${i.key}] ${i.text}（by ${i.provider}，since v${i.sinceVer}，确认 ${i.confirmations.length} 人）`);
  lines.push('## proposed（待全员确认）');
  for (const i of g('proposed')) lines.push(`- [${i.key}] ${i.text}（by ${i.provider}，已确认 ${i.confirmations.length} 人）`);
  lines.push('## arbitration（结构冲突/超时，待 Leader 裁决）');
  for (const i of g('arbitration')) lines.push(`- [${i.key}] ${i.text}（by ${i.provider}）`);
  lines.push('## archived（已归档，不注入）');
  for (const i of g('archived')) lines.push(`- [${i.key}] ${i.text}`);
  await appendBlocks(docId, lines, actor);
  _lastSnapVer.set(state.id, ver);
  console.log(`  [feishu] 共识快照已上传: /${process.env.TEAMWORK_DEMO_WORKSPACE || 'TeamWork-Demo'}/${state.name}/Memory/${title}`);
}

// ---------- map.md 主拓扑地图（v4.3.8 基础规则：只记录节点添加信息 + 上下文注入影响，不含节点内容）----------
let _userLookup = null; // clientId → 显示名（index.js initFeishu 后注入）
export function setUserLookup(fn) { _userLookup = fn; }
function sanitizeName(s, max) {
  return String(s || '').replace(/[/\\<>:"|?*\s]+/g, '_').replace(/[^\w\u4e00-\u9fa5._-]/g, '').slice(0, max) || 'unnamed';
}
function compactTime(when) {
  const d = new Date(when || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
export function nodeFileName(n) { // 基础规则：<上传时间>_<上传者>_<上传标题>.md
  const who = _userLookup ? _userLookup(n.who) : n.who;
  return `${compactTime(n.when)}_${sanitizeName(who, 16)}_${sanitizeName(n.title, 24)}.md`;
}
export function toMapLine(n, fname) { // map.md 单行：节点添加信息（WhenWhoWhat 骨架）+ 上下文注入影响（injectedFrom）+ 回退影响（rev:）——不涉及 memory.md 内容本身
  const who = _userLookup ? _userLookup(n.who) : n.who;
  return `[map] ${n.id} | ${compactTime(n.when)} | ${n.who}(${who}) | ${n.type} | ${String(n.title).replace(/\|/g, '/')} | topo:${n.topoPath || '-'} | dom:${n.domain || '-'} | inj:${(n.injectedFrom || []).join(',') || '-'} | src:${n.source || '-'} | cons:${n.consensusId || '-'} | rev:${(n.revertedIds || []).join(',') || '-'} | file:${fname}`;
}
export function toOpLine(n, action, detail) { // [op] 操作流行——追加型账本（Append-Only）：每次新增/回退操作都记录在 map.md 中作为共享记忆
  const who = _userLookup ? _userLookup(n.who) : n.who;
  return `[op] ${compactTime(Date.now()) | 0} | ${n.who}(${who}) | ${action} | ${detail}`;
}
export function parseMapId(mapLine) { return (String(mapLine).match(/^\[map\] ([A-Za-z0-9-]+)/) || [])[1] || null; }
export function parseMapNode(mapLine) { // map 行 → 骨架节点（narrative 等内容在独立 memory.md；src/cons/rev 可选兼容旧格式）
  const m = String(mapLine).match(/^\[map\] ([\w-]+) \| (\d{8}T\d{6}) \| (\S+?)(?:\(([^)]*)\))? \| (\w+) \| (.*?) \| topo:(\S*) \| dom:(\S*) \| inj:(\S*)(?: \| src:(\S*))?(?: \| cons:(\S*))?(?: \| rev:(\S*))? \| file:(\S+)/);
  if (!m) return null;
  const d = m[2]; const when = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`) || Date.now();
  return { id: m[1], when, who: m[3], _whoName: m[4] || null, type: m[5], title: m[6].trim(), topoPath: m[7] === '-' ? null : m[7],
    domain: m[8] === '-' ? null : m[8], injectedFrom: m[9] === '-' ? [] : m[9].split(',').filter(Boolean),
    source: !m[10] || m[10] === '-' ? null : m[10], consensusId: !m[11] || m[11] === '-' ? null : m[11],
    revertedIds: (!m[12] || m[12] === '-') ? [] : m[12].split(',').filter(Boolean),
    sync: 'synced', skeleton: true };
}
export function parseOpLine(opLine) { // [op] 操作流 → 共享记忆操作记录（追加型账本审计）
  const m = String(opLine).match(/^\[op\] (\d{8}T\d{6}) \| (\S+?)(?:\(([^)]*)\))? \| (\w+) \| (.+)$/);
  if (!m) return null;
  const d = m[1]; const when = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`) || Date.now();
  return { when, who: m[2], _whoName: m[3] || null, action: m[4], detail: m[5].trim() };
}

// ---------- ★ v4.7.2 任务状态流（[task] 快照行——跨机任务协作：B 机重放即可 open_ends/inherit）----------
// 任务签名字段：状态/归属/依赖/标题——任一变化即产生新快照行（Append-Only 状态流，恢复端行序即时间序后行胜）
export function taskSig(t) {
  return `${t.status}|${t.assignee || '-'}|${t.designee || '-'}|${(t.dependsOn || []).join(',')}|${String(t.what || '').slice(0, 80)}`; // ★ v1.0.12 designee 纳入签名（指定人变化 → 新快照行上行）
}
// 云恢复应用后标记该任务已同步（防回声：B 机不再把云来的快照反向上传）
export function markTaskSynced(state, t) {
  if (!t) return;
  state.taskSyncSigs = state.taskSyncSigs || {};
  state.taskSyncSigs[t.id] = taskSig(t);
}
function taskLineSan(s) { return String(s || '').replace(/[|\r\n]/g, ' ').trim(); }
export function toTaskLine(t, actor) { // [task] 单行快照：id | st | asg | dsg | par | dom | pri | deps | when | by | acc | what（| 与换行清洗）
  const who = actor || t.lastBy || '';
  return `[task] ${t.id} | st:${t.status || 'ready'} | asg:${t.assignee || '-'} | dsg:${t.designee || '-'} | par:${t.parent || '-'} | dom:${t.domain || 'general'} | pri:${t.priority || 'P2'} | deps:${(t.dependsOn || []).join(',') || '-'} | when:${compactTime(t.when || Date.now())} | by:${taskLineSan(who).slice(0, 40)} | acc:${taskLineSan(t.acceptance).slice(0, 80)} | what:${taskLineSan(t.what).slice(0, 120)}`;
}
export function parseTaskLine(line) { // [task] 行 → 任务快照对象（字段 split(' | ') + key:value 前缀解析，what 兜底截尾）
  const raw = String(line);
  if (!raw.startsWith('[task] ')) return null;
  const parts = raw.split(' | ');
  if (parts.length < 3) return null;
  const out = { id: parts[0].slice(7).trim(), deps: [], acc: '', what: '' };
  const pick = (p, key) => p.startsWith(key + ':') ? p.slice(key.length + 1) : null;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    let v = pick(p, 'st'); if (v !== null) out.st = v.trim();
    v = pick(p, 'asg'); if (v !== null) out.asg = (v.trim() === '-' ? null : v.trim());
    v = pick(p, 'dsg'); if (v !== null) out.dsg = (v.trim() === '-' ? null : v.trim()); // ★ v1.0.12 designee（指定人身份码）——旧版行无此字段 → undefined（恢复端保留 local）
    v = pick(p, 'par'); if (v !== null) out.par = (v.trim() === '-' ? null : v.trim());
    v = pick(p, 'dom'); if (v !== null) out.dom = v.trim() || 'general';
    v = pick(p, 'pri'); if (v !== null) out.pri = v.trim() || 'P2';
    v = pick(p, 'deps'); if (v !== null) out.deps = (v.trim() && v.trim() !== '-') ? v.trim().split(',').filter(Boolean) : [];
    v = pick(p, 'when'); if (v !== null) out.when = v.trim();
    v = pick(p, 'by'); if (v !== null) out.by = v.trim();
    v = pick(p, 'acc'); if (v !== null) out.acc = v.trim();
    v = pick(p, 'what'); if (v !== null) { out.what = v.trim(); if (i < parts.length - 1) out.what += ' | ' + parts.slice(i + 1).join(' | '); break; } // what 兜底：吞掉其后所有段（清洗过的 | 已还原）
  }
  if (!out.id || !out.st || !out.what) return null;
  out.what = out.what.slice(0, 200);
  return out;
}


// ---------- 拉取与解析（v4.3.5：shareMemory 真源恢复——Cloud Sync 读路径，"双车道一真源"）----------
async function listChildren(folderToken, actor) {
  let pageToken; const out = [];
  do {
    const d = await api('GET', '/open-apis/drive/v1/files', { params: { page_size: 200, folder_token: folderToken, ...(pageToken ? { page_token: pageToken } : {}) }, actor });
    out.push(...(d.files || []));
    pageToken = d.page_token;
  } while (pageToken);
  return out;
}
// toBlockText 的逆解析：飞书块文本 → FlowNode（非节点块返回 null）
export function parseNodeBlock(text) {
  const lines = String(text).split('\n');
  if (!lines[0] || !lines[0].startsWith('[mem:')) return null;
  const node = { id: lines[0].slice(5, -1), sync: 'synced' };
  // ★ v1.0.11：① [WWW] 行只提取身份映射（Who: id(name)）不当 type 行——旧实现把 lines[1] 的 [WWW] 行当 type/title 解析，
  //   full 模式恢复出 type='WWW'、title=整行污染（UI 暂停开放所以休眠未爆发）；② 顺次找第一个非 [WWW]/[mem:] 的 [type] 行
  let idx = 1;
  if (lines[1] && lines[1].startsWith('[WWW]')) {
    const wm = lines[1].match(/Who:\s*(\S+?)\(([^)]*)\)/);
    if (wm) { node.who = wm[1]; if (wm[2]) node._whoName = wm[2]; }
    idx = 2;
  }
  const m1 = lines[idx] && lines[idx].match(/^\[(\w+)\]\s?(.*)$/);
  if (!m1) return null;
  node.type = m1[1]; node.title = m1[2];
  let i = idx + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l === '') break;
    const rev = l.match(/^\[reverted:([^\]]+)\]\s*by\s*(\S+)/);
    if (rev) { node.revertedIds = rev[1].split(',').map(s => s.trim()).filter(Boolean); continue; }
    const kv = l.match(/^([\w.]+):\s?(.*)$/);
    if (!kv) continue;
    const k = kv[1], v = kv[2];
    if (k === 'who') node.who = v;
    else if (k === 'when') { const t = Date.parse(v); if (!isNaN(t)) node.when = t; }
    else if (k === 'role') node.role = v || null;
    else if (k === 'topo') node.topoPath = v;
    else if (k === 'injectedFrom') node.injectedFrom = v.split(',').map(s => s.trim()).filter(Boolean);
    else if (k === 'consensus') node.consensusVer = parseInt(v.replace('v', ''), 10) || 0;
    else if (k === 'domain') node.domain = v;
    else if (k === 'files') node.files = v.split(',').map(s => s.trim()).filter(Boolean);
    else if (k === 'source') node.source = v;
    else if (k === 'task') node.taskId = v;
    else if (k === 'concepts') node.concepts = v.split(',').map(s => s.trim()).filter(Boolean);
  }
  i++;
  const nar = [], facts = []; let inFacts = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'facts:') { inFacts = true; continue; }
    if (l.startsWith('- ') && inFacts) { facts.push(l.slice(2)); continue; }
    if (l === '') continue;
    if (!inFacts) nar.push(l); else facts.push(l.replace(/^- /, ''));
  }
  node.narrative = nar.join('\n');
  if (facts.length) node.facts = facts;
  return node;
}
// 拉取组目录全部节点：map.md 骨架优先（1 次读取，快）+ full 模式逐个 memory.md 补全内容（兼容旧日期文档）
export async function pullAllNodes(state, { full = false, actor } = {}) {
  const who = actor || state.leader; // ★ v4.7：以触发恢复的成员（或组 Leader）飞书身份读取（未绑定则 tenant 兜底）
  const root = await rootFolderToken(who);
  // ★ v1.0.13 目录存活守卫 + ★★ 所有权校验：本副本曾关联目录（feishuFolder 有值）但根目录下按名已找不到 → 组已被 Leader 删除（跨机）——
  //   绝不 ensureFolder 重建（原行为：删除后成员机副本周期 pull 即复活目录 → 旧数据重新上云 → 同名重建组被污染）。
  //   所有权校验（防飞书删除缓存窗口）：目录"存在" ≠ 组还活着——读目录 _workspace.json：
  //     ① 无 config → 组已被删除（目录是删除缓存窗口/旧包成员机复活的残留）→ 按 dirMissing 处理
  //     ② config 代际不符（wsId ≠ 本副本 / 旧 config createdAt 不一致）→ 同名新组已重建 → 本副本是旧代僵尸 → 按 dirMissing 处理
  //   由调用方（cloudSyncOnce）做僵尸副本墓碑化；feishuFolder 为空 = 从未同步过的副本 → 保持原幂等 ensure（兼容旧数据）
  let wsToken;
  const existingDir = await findChildByName(root, state.name, who);
  if (existingDir && existingDir.type === 'folder') {
    const cfg = await readWorkspaceConfig(existingDir.token, who);
    const mine = cfg && (cfg.wsId ? cfg.wsId === state.id : String(cfg.createdAt) === String(state.createdAt));
    if (!mine) return { nodes: [], ops: [], tasks: [], dirMissing: true };
    wsToken = existingDir.token;
    if (wsToken !== state.feishuFolder) state.feishuFolder = wsToken; // 目录换代（删除后重建）→ 副本挂靠新 token
  } else if (state.feishuFolder) {
    return { nodes: [], ops: [], tasks: [], dirMissing: true };
  } else {
    wsToken = await ensureFolder(root, state.name, who);   // /TeamWork-Demo/<工作组名>/（首次/旧副本无关联）
  }
  const prov = await ensureFolder(wsToken, 'Memory', who);      // /工作组名/Memory/
  if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [restore-dbg] ws=${wsToken ? wsToken.slice(0, 8) : 'EMPTY'} mem=${prov ? prov.slice(0, 8) : 'EMPTY'} name=${state.name} full=${full}`);
  const mapChildren = await listChildren(wsToken, who);  // NodeMap.md 在工作组根目录
  const memChildren = await listChildren(prov, who);     // 节点 memory.md 在 Memory/ 子目录
  if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [restore-dbg] wsChildren=${mapChildren.length}: ${mapChildren.map(f => f.type + ':' + f.name).join(' | ')}`);
  if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [restore-dbg] memChildren=${memChildren.length}`);

  // ① NodeMap.md 骨架（节点添加信息 + 注入影响——v4.3.8 基础规则：不涉及节点内容本身）+ [op] 操作流（Append-Only 审计）+ [task] 任务状态流（v4.7.2）
  const nodes = [];
  const ops = [];
  const tasks = []; // ★ v4.7.2：[task] 快照行按行序（时间序）收集——恢复端重放（后行胜）
  const mapFile = mapChildren.find(f => f.type === 'docx' && (f.name === 'NodeMap.md' || f.name === 'map.md')); // v4.4 名称 NodeMap.md（兼容旧 map.md）
  if (mapFile) {
    const mapLines = await listDocTexts(mapFile.token, who);
    for (const line of mapLines) {
      if (/^\[op\] /.test(line)) { const op = parseOpLine(line); if (op) ops.push(op); continue; }
      const tk = parseTaskLine(line); // ★ v4.7.2 [task] 状态行（在 [map] 之前判断——两者前缀不同互不干扰）
      if (tk) { tasks.push(tk); continue; }
      const sk = parseMapNode(line);
      if (sk) {
        // ★ [op] revert 操作恢复软删（revertedIds 标记——账本回退影响传播）
        if (sk.revertedIds && sk.revertedIds.length) {
          for (const rid of sk.revertedIds) { const target = nodes.find(x => x.id === rid); if (target) target.abandoned = true; }
        }
        nodes.push(sk);
      }
    }
    if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [restore-dbg] NodeMap.md 骨架=${nodes.length} ops=${ops.length}`);
  }
  // ② full 模式：逐个 Memory/ 下的 memory.md 补全 narrative/facts/concepts/files（慢——每文件一次 API；含旧格式日期文档兼容）
  if (full || !mapFile) {
    for (const f of memChildren) {
      if (f.type !== 'docx' || !/\.md$/.test(f.name) || f.name === 'NodeMap.md' || f.name === 'map.md' || f.name.startsWith('consensus-snapshot')) continue;
      const texts = await listDocTexts(f.token, who);
      if (process.env.TEAMWORK_RESTORE_DBG) console.log(`  [restore-dbg] doc=${f.name} blocks=${texts.length}`);
      const merged = [];
      for (const t of texts) {
        if (/^\[mem:/.test(t)) merged.push(t);
        else if (merged.length) merged[merged.length - 1] += '\n' + t;
      }
      for (const t of merged) {
        const n = parseNodeBlock(t);
        if (n) {
          const idx = nodes.findIndex(x => x.id === n.id);
          if (idx >= 0) nodes[idx] = n; // 完整节点覆盖骨架
          else nodes.push(n);
        }
      }
    }
  }
  return { nodes, ops, tasks }; // ops = Append-Only 操作流（追加型账本审计——每次新增/回退都是共享记忆）；tasks = 任务状态流（v4.7.2 跨机任务协作）
}

// ---------- 序列化（与 demo serializer 一致：UUID 锚点幂等格式）----------
function toBlockText(node) {
  const lines = [];
  lines.push(`[mem:${node.id}]`);
  // ★ v4.4 基础规则：Memory 下的记忆节点必须明确 WWW（When/Who/What）
  const whoName = _userLookup ? _userLookup(node.who) : node.who;
  lines.push(`[WWW] When: ${new Date(node.when || Date.now()).toISOString()} | Who: ${node.who}(${whoName}) | What: [${node.type}] ${node.title}`);
  lines.push(`[${node.type}] ${node.title}`);
  lines.push(`who: ${node.who}`);
  lines.push(`when: ${new Date(node.when || Date.now()).toISOString()}`);
  if (node.role) lines.push(`role: ${node.role}`);
  if (node.topoPath) lines.push(`topo: ${node.topoPath}`);
  if (node.injectedFrom && node.injectedFrom.length) lines.push(`injectedFrom: ${node.injectedFrom.join(', ')}`);
  if (node.consensusVer != null) lines.push(`consensus: v${node.consensusVer}`);
  if (node.userMarkedRelated && node.userMarkedRelated.length) lines.push(`relatedMarked: ${node.userMarkedRelated.join(', ')}`);
  if (node.files && node.files.length) lines.push(`files: ${node.files.join(', ')}`); // claude-mem 观察分层文件锚点
  if (node.abandoned) lines.push('abandoned: true');
  if (node.domain) lines.push(`domain: ${node.domain}`);
  if (node.revertedIds && node.revertedIds.length) lines.push(`[reverted:${node.revertedIds.join(',')}] by ${node.who}`); // R18 tombstone 行（拉取侧解析过滤）
  if (node.source) lines.push(`source: ${node.source}`);
  if (node.taskId) lines.push(`task: ${node.taskId}`);
  if (node.concepts && node.concepts.length) lines.push(`concepts: ${node.concepts.join(', ')}`);
  lines.push('');
  lines.push(sanitize(stripPrivate(node.narrative || '')));
  if (node.facts && node.facts.length) {
    lines.push('');
    lines.push('facts:');
    for (const f of node.facts) lines.push(`- ${sanitize(stripPrivate(f))}`);
  }
  return lines.join('\n');
}

function parseUuid(text) {
  const m = text.match(/^\[mem:([0-9a-zA-Z][0-9a-zA-Z-]{7,63})\]/);
  return m ? m[1] : null;
}

// ---------- 同步引擎（防抖批量 + 幂等跳过）----------
let _timer = null;
let _stopped = false; // ★ v4.6.5 停机标志：服务停止后不再执行/排程任何同步任务
export function stopSync() { // ★ v4.6.5 优雅停机调用：清除 pending 防抖任务，飞书同步随之终止（停机后不再上传）
  _stopped = true;
  clearTimeout(_timer);
  clearTimeout(_consensusTimer);
}
let _syncing = false;
let _workspaceToken = null;
let _docId = null;
let _docTitle = '';
let _stats = { uploaded: 0, skipped: 0, errors: 0, lastSync: null };
let _persistHook = null; // ★ v4.7.2：落盘钩子（index.js 注入 scheduleSave）——doSync 改 n.sync/taskSyncSigs 后持久化，防重启后签名丢失导致 [task] 行重复上行
export function setPersistHook(fn) { _persistHook = fn; }

export function getSyncStats() {
  return { ..._stats, enabled: FEISHU_ENABLED, docTitle: _docTitle, pending: _syncing ? 'syncing' : 'idle' };
}

export function triggerSync(state, delayMs = 1500) {
  if (!FEISHU_ENABLED || _stopped) return;
  clearTimeout(_timer);
  _timer = setTimeout(() => doSync(state).catch(e => {
    _stats.errors++;
    console.warn(`  [feishu] 同步失败: ${e.message}`);
  }), delayMs);
}

async function doSync(state) {
  if (_stopped) return; // ★ v4.6.5 已停机：不再执行/重排同步
  // ★ v1.0.14 挂起冻结：DORMANT 组不上传——close 后仍在飞的迟到 triggerSync 会与 Leader 端目录删除并发竞态
  //   （实测：迟到上传撞上删除中途 → 删除报错中止 → 云残留半死目录 + config → 同名 create 误判「组还活着」/新成员 join 撞旧数据）。
  //   local 节点等 reopen 后随下次触发上行（挂起 = 协作冻结语义）
  if (state.phase === 'DORMANT') {
    console.log(`  [feishu] 工作组已挂起，跳过同步（挂起=冻结；local 节点等重开后上行）: ${state.name}`);
    return;
  }
  if (_syncing) { // ★ 修复同步丢失：忙时丢弃且不重排 → pending 节点永远留 local；改为重排（对齐 claude-mem "失败留 NULL 下次再试"）
    setTimeout(() => doSync(state).catch(e => console.warn(`  [feishu] 同步失败: ${e.message}`)), 1500);
    return;
  }
  _syncing = true;
  try {
    // 1. 过滤待同步节点 + ★ v4.7.2 任务状态变化（签名对比 state.taskSyncSigs——云恢复的任务已标记，不回声；本机变化才上行）
    const pending = state.nodes.filter(n => n.sync === 'local');
    state.taskSyncSigs = state.taskSyncSigs || {};
    const taskDelta = [];
    for (const t of Object.values(state.tasks || {})) {
      const sig = taskSig(t);
      if (state.taskSyncSigs[t.id] !== sig) taskDelta.push(t);
    }
    if (!pending.length && !taskDelta.length) { _syncing = false; return; }

    // 2. schema：/TeamWork-Demo/<工作组名>/Memory/（每节点一文件）+ NodeMap.md（主拓扑地图，放工作组根目录）
    const wsName = process.env.TEAMWORK_DEMO_WORKSPACE || 'TeamWork-Demo';
    const schemaActor = state.leader; // ★ v4.7：目录 schema 以组 Leader 飞书身份就绪（未绑定则 tenant 兜底）
    const wsToken = await rootFolderToken(schemaActor);
    // ★ v1.0.13 目录存活守卫 + 所有权校验（与 pullAllNodes 同款）：目录不存在时绝不 ensureFolder 重建；
    //   目录"存在"还需 _workspace.json 所有权校验（无 config=已删组残留缓存 / 代际不符=同名新组）——
    //   飞书删除有最终一致性缓存窗口（实测：Leader 删除成功后成员机 findChildByName 仍短暂命中旧 token 并"上传成功"复活目录）
    let provToken;
    const existingDir = await findChildByName(wsToken, state.name, schemaActor);
    if (existingDir && existingDir.type === 'folder') {
      const cfg = await readWorkspaceConfig(existingDir.token, schemaActor);
      const mine = cfg && (cfg.wsId ? cfg.wsId === state.id : String(cfg.createdAt) === String(state.createdAt));
      if (!mine) {
        console.warn(`  [feishu] 目录所有权校验失败（无 config 或代际不符）: /${wsName}/${state.name}/ → 跳过同步（不复活/不推送，待墓碑化）`);
        return; // finally 释放 _syncing + persistHook 照常
      }
      provToken = existingDir.token;
      if (provToken !== state.feishuFolder) state.feishuFolder = provToken; // 目录换代 → 挂靠新 token
    } else if (state.feishuFolder) {
      console.warn(`  [feishu] 工作组目录已不存在（可能已被删除）: /${wsName}/${state.name}/ → 跳过本次同步（不重建）`);
      return; // finally 释放 _syncing + persistHook 照常
    } else {
      provToken = await ensureFolder(wsToken, state.name, schemaActor); // 首次同步：正常创建目录
    }
    const memToken = await ensureFolder(provToken, 'Memory', schemaActor);          // /工作组名/Memory/
    const mapId = await ensureDailyDoc(provToken, 'NodeMap.md', schemaActor);       // /工作组名/NodeMap.md（主拓扑地图）
    console.log(`  [feishu] schema 就绪: /${wsName}/${state.name}/ (NodeMap.md + Memory/×N 节点文件)`);

    // 3. 幂等：map.md 已有节点 id → 跳过（每节点一文件，map 为权威索引）
    const mapTexts = await listDocTexts(mapId, schemaActor);
    const existingIds = new Set(mapTexts.map(t => parseMapId(t)).filter(Boolean));

    // 4. 上传：每节点独立 memory.md（时间_上传者_标题） + map.md 追加索引行（骨架+注入边）
    // ★ v4.7 用户身份：每个节点以其作者（n.who）的个人飞书身份上传——共享目录下的文件归属与操作者一致
    let uploaded = 0, skipped = 0;
    for (const n of pending) {
      if (existingIds.has(n.id)) { n.sync = 'synced'; skipped++; continue; }
      const actor = n.who; // 节点作者（绑定过 feishu-auth 则以其身份执行；未绑定 tenant 兜底）
      const fname = nodeFileName(n); // <上传时间>_<上传者>_<上传标题>.md
      const docId = await ensureDailyDoc(memToken, fname, actor);
      await appendBlocks(docId, [toBlockText(n)], actor);   // ① 节点完整内容 → 独立 memory.md
      const mapLine = toMapLine(n, fname);                   // ② map.md：节点添加 + 注入影响 + 回退影响（仅骨架，不含内容）
      const opAction = n.type === 'revert' ? 'revert' : (n.type === 'inherit' ? 'inherit' : 'add');
      const opDetail = n.type === 'revert'
        ? `回退 ${n.taskId} 至继承点${n.injectedFrom ? n.injectedFrom.join(',') : ''}（rev:${(n.revertedIds || []).join(',')}）${n.narrative ? ' 原因:' + String(n.narrative).slice(0, 60) : ''}`
        : (n.type === 'inherit' ? `继承 ${n.taskId}（域:${n.domain || '-'}）` : `新增 ${n.id}「${String(n.title).slice(0, 30)}」`);
      const opLine = toOpLine(n, opAction, opDetail);        // ③ [op] 操作流行——Append-Only 共享记忆
      await appendBlocks(mapId, [mapLine, opLine], actor);
      existingIds.add(n.id);
      n.sync = 'synced'; uploaded++;
    }

    // ⑤ ★ v4.7.2 任务状态流上行：变化任务 → [task] 快照行追加 NodeMap.md（Append-Only 状态流）
    //    actor = 该任务最近节点的作者（拾取/完成/继承节点 who——跨机可见"谁在做什么"）；无节点则组 Leader
    let tasksUploaded = 0;
    for (const t of taskDelta) {
      const lastNode = state.nodes.filter(n => n.taskId === t.id).slice(-1)[0];
      const actor = lastNode?.who || state.leader;
      await appendBlocks(mapId, [toTaskLine(t, actor)], actor);
      state.taskSyncSigs[t.id] = taskSig(t); // 上行成功才更新签名（失败 → 下次 doSync 重试）
      tasksUploaded++;
    }
    if (tasksUploaded) console.log(`  [feishu] 任务状态流上行: ${tasksUploaded} 条 [task] 快照 → NodeMap.md（跨机 open_ends/inherit 可见）`);

    _stats.uploaded += uploaded;
    _stats.skipped += skipped;
    _stats.lastSync = new Date().toISOString();
    console.log(`  [feishu] 同步完成: 上传 ${uploaded} / 跳过 ${skipped} → /${wsName}/${state.name}/Memory/ (独立 memory.md × ${uploaded} + NodeMap.md 索引${tasksUploaded ? ` + [task] × ${tasksUploaded}` : ''})`);
  } catch (e) {
    _stats.errors++;
    console.warn(`  [feishu] 同步失败: ${e.message}`);
    console.warn('  [feishu] fail-open：本地工作不受影响，下次触发时重试');
  } finally {
    _syncing = false;
    try { _persistHook?.(state); } catch { } // ★ v4.7.2：synced 标记/任务签名落盘（防重启重传/重复 [task] 行）
  }
}

// ---------- 工作组飞书目录 ----------
/** 工作组飞书目录（v4.4）：在 /TeamWork-Demo/<工作组名>/ 下创建（Memory/ Skill/ 子目录 + NodeMap.md + _workspace.json）
 *  ★ v4.7 用户身份：actor=创建者 clientId——绑定过 feishu-auth 则以其个人飞书身份建目录（目录内文件归属创建者） */
export async function ensureWorkspaceFolder(wsName, actor) {
  try {
    const token = await getToken(actor);
    if (!token) { console.warn('  [feishu] 无凭据，跳过目录创建'); return null; }
    // v4.4 新结构：/TeamWork-Demo/<工作组名>/（Memory、Skill 为其子目录；NodeMap.md、_workspace.json 为其文件）
    const rootToken = await rootFolderToken(actor);
    const wsToken = await ensureFolder(rootToken, wsName, actor);
    await ensureFolder(wsToken, 'Memory', actor);   // /工作组名/Memory/
    await ensureFolder(wsToken, 'Skill', actor);    // /工作组名/Skill/
    console.log(`  [feishu] 工作组目录已创建: /TeamWork-Demo/${wsName}/（含 Memory/ Skill/，操作者身份: ${actor || 'tenant'}）`);
    return wsToken;
  } catch (e) {
    console.warn(`  [feishu] 目录创建失败: ${e.message}`);
    // ★ v1.0.6：不再吞错——真实原因（网络断连/Node无fetch/凭据code错）透传到 502 响应，
    //   新成员机「飞书目录创建失败」一报错即见根因，无需翻 server.log
    throw new Error(e.message);
  }
}

/** 删除工作组飞书目录（v4.4）：删 /TeamWork-Demo/<工作组名>/ 整个目录
 *  ★ v4.7 用户身份：actor=操作者（Leader 解散时以其身份删——根目录 full_access/目录创建者可删）
 *  ★ v1.0.14 鲁棒化（竞态实测）：①先删 _workspace.json（tombstone——config 一删，并发中的成员机同步立即被
 *    所有权校验判死停推，竞态窗口从「整个删除过程」缩到 config 删除瞬间）；②循环扫荡 ≤3 轮——单项删除失败不
 *    中止（旧代码一个 DELETE 报错即整体中止 → 实测残留半死目录 + config，同名重建被误判活组）；③目录删除失败重试 1 次 */
export async function deleteWorkspaceFolder(wsName, actor) {
  try {
    const token = await getToken(actor);
    if (!token) { console.warn('  [feishu] 无凭据，跳过删除'); return false; }
    const root = await rootFolderToken(actor);
    const child = await findChildByName(root, wsName, actor); // v4.4: /TeamWork-Demo/<工作组名>/
    if (!child) { console.warn(`  [feishu] /TeamWork-Demo/${wsName}/ 不存在`); return false; }
    // ① tombstone 优先：删 _workspace.json（失败不中止——其余照清，下一轮扫荡会重试）
    try {
      const cfgDoc = await findChildByName(child.token, '_workspace.json', actor);
      if (cfgDoc) await api('DELETE', `/open-apis/drive/v1/files/${cfgDoc.token}`, { params: { type: cfgDoc.type }, actor });
    } catch (e) { console.warn(`  [feishu] config 删除异常（继续清理其余）: ${e.message}`); }
    // ② 循环扫荡：单项失败不中止（warn 继续）；删除中途被并发新建的文件由下一轮扫掉
    for (let round = 0; round < 3; round++) {
      let pageToken, remaining = 0, failed = 0;
      do {
        const d = await api('GET', '/open-apis/drive/v1/files', { params: { page_size: 200, folder_token: child.token, ...(pageToken ? { page_token: pageToken } : {}) }, actor });
        for (const f of d.files || []) {
          remaining++;
          try { await api('DELETE', `/open-apis/drive/v1/files/${f.token}`, { params: { type: f.type }, actor }); }
          catch (e) { failed++; console.warn(`  [feishu] 子项删除失败（${f.name}）: ${e.message}`); }
        }
        pageToken = d.page_token;
      } while (pageToken);
      if (!remaining) break;                      // 已空
      if (failed && round < 2) { await new Promise(r => setTimeout(r, 1500)); continue; } // 有失败 → 稍候重扫
      break;                                      // 3 轮仍有残留（持续并发写入）→ 放弃扫荡，目录删除仍会尝试
    }
    // ③ 删目录（失败重试一次）
    let dirOk = false;
    for (let i = 0; i < 2 && !dirOk; i++) {
      try { await api('DELETE', `/open-apis/drive/v1/files/${child.token}`, { params: { type: 'folder' }, actor }); dirOk = true; }
      catch (e) { if (i === 0) { console.warn(`  [feishu] 目录删除失败，重试: ${e.message}`); await new Promise(r => setTimeout(r, 1500)); } else console.warn(`  [feishu] 目录删除失败: ${e.message}`); }
    }
    if (dirOk) {
      console.log(`  [feishu] 工作组目录已删除: /TeamWork-Demo/${wsName}/（操作者身份: ${actor || 'tenant'}）`);
      return true;
    }
    console.warn(`  [feishu] 工作组目录删除失败（子项可能已清）: /TeamWork-Demo/${wsName}/`);
    return false;
  } catch (e) {
    console.warn(`  [feishu] 目录删除失败: ${e.message}`);
    return false;
  }
}

/** 写工作组配置到飞书目录（_workspace.json 文档）——★ v4.7：以创建者身份写入 */
export async function writeWorkspaceConfig(folderToken, config, actor) {
  try {
    const doc = await api('POST', '/open-apis/docx/v1/documents', {
      data: { folder_token: folderToken, title: '_workspace.json' }, actor
    });
    const docId = doc.document.document_id;
    await api('POST', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, {
      data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: JSON.stringify(config) } }] } }] }, actor
    });
    console.log(`  [feishu] 工作组配置已写入: _workspace.json（操作者身份: ${actor || 'tenant'}）`);
    return docId;
  } catch (e) { console.warn(`  [feishu] 配置写入失败: ${e.message}`); return null; }
}

/** 列工作组目录直接子项（v1.0.14 半死目录防线用）：返回 [{name,type,token}]，异常/无凭据返回 null
 *  ★ 用途：create 复用已存在目录前检查内容残留——无 config 但有节点文档 = 已删组的半死目录，复用会让新组 pull 拉回旧节点 */
export async function listWorkspaceDir(folderToken, actor) {
  try {
    const d = await api('GET', '/open-apis/drive/v1/files', { params: { page_size: 200, folder_token: folderToken }, actor });
    return (d.files || []).map(f => ({ name: f.name, type: f.type, token: f.token }));
  } catch { return null; }
}

/** 从飞书目录读工作组配置——★ v4.7：actor=加入者（以其身份读；未绑定 tenant 兜底） */
export async function readWorkspaceConfig(folderToken, actor) {
  try {
    const doc = await findChildByName(folderToken, '_workspace.json', actor);
    if (!doc) return null;
    const docId = doc.obj_token || doc.token;
    const d = await api('GET', `/open-apis/docx/v1/documents/${docId}/blocks`, { params: { page_size: 50, document_revision_id: -1 }, actor });
    for (const item of d.items || []) {
      if (item.block_type === 2 && item.text && Array.isArray(item.text.elements)) {
        const text = item.text.elements.map(el => (el.text_run && el.text_run.content) || '').join('');
        try { return JSON.parse(text); } catch { return null; }
      }
    }
    return null;
  } catch { return null; }
}

/** 通过飞书目录名搜索工作组（v4.4）：在 /TeamWork-Demo/<工作组名>/ 下查找——★ v4.7：actor=加入者 */
export async function searchWorkspaceFolder(wsName, actor) {
  try {
    const token = await getToken(actor);
    if (!token) return null;
    const root = await rootFolderToken(actor);
    const child = await findChildByName(root, wsName, actor); // v4.4: /TeamWork-Demo/<工作组名>/
    if (!child || child.type !== 'folder') return null;
    console.log(`  [feishu] 找到工作组目录: /TeamWork-Demo/${wsName}/（操作者身份: ${actor || 'tenant'}）`);
    return { folderToken: child.token, wsName };
  } catch { return null; }
}

// ---------- v4.7 用户身份：绑定辅助 ----------
/** 用 user_access_token 查飞书用户信息（feishu-auth 上报后 server 解析 open_id / 飞书名） */
export async function feishuUserInfo(accessToken) {
  const res = await fetch(`${API_BASE}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0 || !j.data) throw new Error(`user_info 失败 code=${j.code} ${j.msg || j.message || ''}`);
  return j.data; // { open_id, name, en_name, avatar_url, ... }
}

/** tenant 把共享根目录授权给用户 open_id（绑定即自动共享——成员个人身份才能在根目录下建工作组目录）
 *  权限格式与实测一致：POST /drive/v1/permissions/{token}/members/batch_create + members[{member_type:'openid', member_id, perm}] */
export async function shareRootToOpenId(openId, perm = 'edit') {
  const root = ROOT_FOLDER;
  if (!root) throw new Error('FEISHU_ROOT_FOLDER 未配置（.env）——无法自动共享根目录');
  const token = await getTenantToken();
  const res = await fetch(`${API_BASE}/open-apis/drive/v1/permissions/${root}/members/batch_create?type=folder&need_notification=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ members: [{ member_type: 'openid', member_id: openId, perm }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.code === 0) return true;
  if (/exist|已存在|duplicate/i.test(String(j.msg || j.message || ''))) return true; // 幂等：已共享视为成功
  throw new Error(`根目录共享失败 code=${j.code} ${j.msg || j.message}`);
}


// ---------- 初始化探测 ----------
export async function initFeishu() {
  if (!FEISHU_ENABLED) {
    console.log('  [feishu] 已禁用（TEAMWORK_FEISHU_ENABLED=false）');
    return false;
  }
  try {
    const token = await getToken();
    if (token) {
      const rootDesc = ROOT_FOLDER
        ? `根目录显式配置 ${ROOT_FOLDER.slice(0, 8)}...；`
        : '根目录按名称发现（建议 .env 配 FEISHU_ROOT_FOLDER）；';
      console.log(`  [feishu] 凭据就绪，同步引擎已激活（${rootDesc}用户身份模式 v4.7：成员 teamwork feishu-auth 绑定后以其身份操作）`);
      return true;
    }
    console.warn('  [feishu] 无可用凭据（tenant 审批中 / user token 未授权），同步引擎待命');
    return false;
  } catch (e) {
    console.warn(`  [feishu] 初始化异常: ${e.message}（fail-open，不影响本地协作）`);
    return false;
  }
}

// ★ v1.0.6 一键自检（teamwork doctor）：新成员机「飞书目录创建失败」排查利器
//   依次检测：Node 版本（全局 fetch 依赖）→ 凭据链生效来源 → tenant_token 真实直连 → 给出针对性建议
export async function diagnose() {
  const r = { node: process.version, fetchOk: typeof fetch === 'function', source: null, appId: APP_ID, secretMasked: APP_SECRET ? APP_SECRET.slice(0, 4) + '***' : '(空)', rootFolder: ROOT_FOLDER, tenant: null, err: null, advice: [] };
  // ① 凭据生效来源（复刻模块顶部三段链判定，独立探测以报告真实状态）
  const envSet = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
  let fileUsed = false;
  try {
    const p = path.join(os.homedir(), '.teamwork', 'feishu.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (j.appId && j.appSecret) { fileUsed = true; r.feishuJson = p; r.fileAppId = j.appId; }
    else r.feishuJsonBad = p + '（字段缺失——会被忽略，自动回退内置）';
  } catch { r.feishuJson = null; }
  r.source = envSet ? '环境变量 FEISHU_APP_ID/SECRET' : (fileUsed ? `feishu.json（${r.feishuJson}）` : '内置凭据（v1.0.5+ 兜底）');
  if (fileUsed && r.fileAppId !== BUILTIN_APP_ID)
    r.advice.push('feishu.json 的 appId 与内置不同——若为 feishu-auth 误写坏值会压过内置兜底；删除该文件后 teamwork stop --force && teamwork start 即回退内置');
  // ② Node 全局 fetch（getTenantToken 等全部依赖——Node < 18 直接 ReferenceError，落入笼统 502）
  if (!r.fetchOk) {
    r.err = `Node ${process.version} 无全局 fetch（需 >= 18）——飞书请求全部失败`;
    r.advice.push('升级 Node.js 到 18+（https://nodejs.org）后重新 teamwork start');
    return r;
  }
  // ③ tenant_token 直连（真实打一次飞书 API——凭据对错/网络通断/白名单一测便知）
  try {
    const res = await fetch(`${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
    const j = await res.json();
    if (j.code !== 0) {
      r.err = `tenant_token 获取失败 code=${j.code}: ${j.msg}`;
      r.advice.push('10003/10014=app_secret 错误，99991663=app_id 无效——若来源是 feishu.json 请删它回退内置；内置值也报错则联系 Leader 核对');
    } else r.tenant = `ok（有效期 ${j.expire}s）`;
  } catch (e) {
    r.err = `网络无法访问 open.feishu.cn: ${e.message}`;
    r.advice.push('检查本机网络/代理/企业防火墙是否放行 open.feishu.cn:443（浏览器打开 https://open.feishu.cn 可快速验证）');
  }
  if (!r.err) r.ok = true;
  return r;
}

