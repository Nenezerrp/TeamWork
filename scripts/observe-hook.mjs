#!/usr/bin/env node
/**
 * observe-hook.mjs —— 本地对话采集钩子（TaskDispatch-Design 4.4 写路径 / PostToolUse 等价物）
 *
 * ★ v4.3.3 按 claude-mem-core-notes.md 精读对齐（hook 设计基准参考）：
 *   - 铁律4 fire-and-forget：全部 HTTP 2s 超时（AbortController），server 卡住绝不阻塞本地
 *   - 观察分层结构：提取 JSONL 的 files/files_read/files_modified 字段（文件检索锚点）
 *   - Memory Ingest 模式：宿主已蒸馏记忆（MEMORY.md）零模型花费直导入（content-hash 幂等键）
 *   - live INDEX 注入模式：无钩子宿主用"文件作为注入媒介"（拉取 inject.md → 原子写 zz-teamwork-inject.md）
 *   - 降噪：--skip 正则 + 默认短行/纯符号过滤（对齐 CLAUDE_MEM_SKIP_TOOLS 思想）
 *
 * 用法:
 *   采集: node scripts/observe-hook.mjs --ws ws-x --file .teamwork-chat.log [--source trae] [--skip 正则] [--inject-file zz-teamwork-inject.md]
 *         身份: --token tw-x | --name 名 --clientId u-x
 *   导入: node scripts/observe-hook.mjs --ws ws-x --ingest-memory MEMORY.md --source memory-ingest [...身份参数]
 * 铁律: fail-open——服务器不可达只 warn 不退出，绝不阻塞本地工作
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const SERVER = arg('server') || 'http://127.0.0.1:8787';
const WS = arg('ws');
const FILE = arg('file');
const SOURCE = arg('source') || 'chat';
const SKIP_RE = arg('skip') ? new RegExp(arg('skip'), 'i') : null;
const INJECT_FILE = arg('inject-file');
const INGEST_MEMORY = arg('ingest-memory');
if (!WS || (!FILE && !INGEST_MEMORY)) { console.error('用法: --ws <wsId> --file <日志> | --ingest-memory <md> [--source] [--skip 正则] [--inject-file]'); process.exit(1); }

// ★ 铁律4：fire-and-forget 2s 超时（短超时防宿主卡死）
async function call(method, path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(SERVER + path, { method, signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: method === 'POST' ? JSON.stringify(body) : undefined });
    return await r.json().catch(() => ({}));
  } catch (e) {
    console.warn('  ✗ ' + (e.name === 'AbortError' ? '超时(2s)放弃' : 'server 不可达') + '（fail-open，继续）');
    return { error: 'unreachable' };
  } finally { clearTimeout(timer); }
}
async function getToken() {
  const t = arg('token'); if (t) return t;
  const name = arg('name'), cid = arg('clientId');
  if (!name || !cid) { console.error('需要 --token 或 --name+--clientId'); process.exit(1); }
  return (await call('POST', '/api/session', { name, _clientId: cid })).token || null;
}
const TOKEN = await getToken();
if (!TOKEN) { console.error('登录失败（fail-fast：无身份无法上报）'); process.exit(1); }
let offset = 0;
function extract(line) {
  const t = line.trim(); if (!t) return null;
  if (t.startsWith('{')) { try {
    const o = JSON.parse(t);
    const c = o.content || o.text || o.message; if (!c) return null;
    const files = [...new Set([...(o.files || []), ...(o.files_read || []), ...(o.files_modified || [])])].slice(0, 10); // ★ 观察分层 files 锚点
    return { content: String(c), files: files.length ? files : undefined };
  } catch { return null; } }
  return { content: t };
}
function isNoise(c) { // 降噪：超短行/纯符号/跳过正则（对齐 CLAUDE_MEM_SKIP_TOOLS 思想）
  const t = String(c).trim();
  if (t.length < 6) return true;
  if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(t)) return true;
  if (SKIP_RE && SKIP_RE.test(t)) return true;
  return false;
}
async function observe(content, files) {
  const j = await call('POST', `/api/ws/${WS}/observe`, { content, source: SOURCE, ...(files ? { files } : {}) });
  if (j.nodeId) console.log(`  ✓ 节点 ${j.nodeId}: [${j.type}] ${j.title}${j.summarized ? '（AI 已总结）' : '（降级截断）'}`);
}
// ★ live INDEX 注入（Grok 模式：无钩子宿主用文件作为注入媒介——实时重写+原子写）
async function pullInject() {
  const j = await call('GET', `/api/ws/${WS}/inject.md`);
  if (j && j.markdown) {
    const tmp = INJECT_FILE + '.tmp';
    fs.writeFileSync(tmp, j.markdown, 'utf8');
    fs.renameSync(tmp, INJECT_FILE); // 原子写（临时文件+rename，Folder Context Files 同款）
  }
}
// ★ Memory Ingest：宿主已蒸馏记忆零模型花费直导入（content-hash 幂等键）
async function ingestMemory(path) {
  const md = fs.readFileSync(path, 'utf8');
  const chunks = md.split(/\n(?=#{1,3} |\*\*|- \*\*)/).map(s => s.trim()).filter(s => s.length > 20);
  for (const chunk of chunks.slice(0, 50)) {
    const title = (chunk.match(/^#{1,3} (.+)$/) || chunk.match(/^\*\*(.+?)\*\*/) || [null, chunk.slice(0, 30)])[1];
    const concepts = [...new Set((chunk.match(/[a-z]{4,}/g) || []).slice(0, 3))];
    const hash = crypto.createHash('md5').update(chunk).digest('hex').slice(0, 12);
    const j = await call('POST', `/api/ws/${WS}/share_memory`, {
      title: `[ingest] ${String(title).slice(0, 40)} #${hash}`, // 幂等键进标题（重复导入可识别去重）
      type: chunk.match(/bug|fix/i) ? 'bugfix' : chunk.match(/decide|决策/i) ? 'decision' : 'discovery',
      narrative: chunk.slice(0, 600), concepts });
    console.log(j.nodeId ? `  ✓ 导入 ${j.nodeId}: ${String(title).slice(0, 30)}` : `  ✗ ${j.error || '失败'}`);
  }
  console.log(`Ingest 完成：${chunks.length} 条候选（零模型花费）`);
}
if (INGEST_MEMORY) { await ingestMemory(INGEST_MEMORY); process.exit(0); }
function tick() {
  try {
    const st = fs.statSync(FILE);
    if (st.size < offset) offset = 0; // 文件被截断/重写，从头追
    if (st.size > offset) {
      const fd = fs.openSync(FILE, 'r'); const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd);
      offset = st.size;
      for (const line of buf.toString('utf8').split('\n')) {
        const e = extract(line);
        if (e && !isNoise(e.content)) observe(e.content, e.files);
      }
    }
  } catch { offset = 0; }
  if (INJECT_FILE) pullInject();
}
console.log(`observe-hook 已启动: ${FILE || '-'} → ${SERVER}/api/ws/${WS}/observe (source=${SOURCE}${INJECT_FILE ? ', inject→' + INJECT_FILE : ''})`);
setInterval(tick, 1500);

