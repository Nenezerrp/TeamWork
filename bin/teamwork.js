#!/usr/bin/env node
/**
 * teamwork - CLI entry point
 *
 * Usage:
 *   teamwork start [--port 8787]     Start server + open dashboard
 *   teamwork stop                    Stop server
 *   teamwork status                  Show status
 *   teamwork setup [--trae|--claude|--cursor]  Detect AI tools + auto-configure MCP
 *   teamwork doctor                Diagnose environment (Node/credentials/Feishu connectivity)
 *   teamwork version                 Show version
 */
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(os.homedir(), '.teamwork', 'server.pid');
const TOKEN_FILE = path.join(os.homedir(), '.teamwork', 'token.json');
const SECRET_FILE = path.join(os.homedir(), '.teamwork', 'server.secret'); // ★ v4.6.5 优雅停机握手密钥（server 启动写入/退出清理）
const LOG_DIR = path.join(os.homedir(), '.teamwork', 'logs'); // ★ v4.6.5 后台 server 日志目录（崩溃可查）

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

const FEISHU_ENV_FILE = path.join(os.homedir(), '.teamwork', 'feishu.json'); // ★ v4.7 Leader 分发的应用凭据（app_id/app_secret——用户个人 OAuth 换 token 用）
const FEISHU_USER_TOKEN_FILE = path.join(os.homedir(), '.teamwork', 'user-token.json'); // ★ v4.7 用户个人飞书 token（本地备份；权威存储在中心 server）
function loadJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function readPid() { try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch { return null; } }
function writePid(pid) { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, String(pid)); }
function removePid() { try { fs.unlinkSync(PID_FILE); } catch {} }
function isRunning(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function detectPort() {
  const pid = readPid();
  if (!pid) return null;
  try {
    const out = execSync(`netstat -ano | findstr "${pid}" | findstr LISTENING`, { encoding: 'utf8' });
    const m = out.match(/:(\d+)\s/);
    return m ? parseInt(m[1], 10) : 8787;
  } catch { return 8787; }
}
// ★ v4.6.5 读取 shutdown 握手密钥（server 启动时写入；CLI stop 携带防误停）
function readSecret() { try { return (fs.readFileSync(SECRET_FILE, 'utf8') || '').trim(); } catch { return null; } }
// ★ v4.6.5 端口占用检测：返回 LISTENING 该端口的进程 PID（null=空闲）——start 前预检残留 server
function portOccupiedBy(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8' });
    const m = out.match(/\s(\d+)\s*$/m);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}
// ★ v4.6.5 扫描本机所有 teamwork server 进程（node + 命令行指向 server/index.js）
//   用途：status 孤儿检测 / stop --force 残留清理（PID 文件丢失或与实际进程脱节时的兜底）
function findServerProcesses() {
  if (process.platform !== 'win32') return [];
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match 'server[\\\\/]+index\\.js' } | Select-Object ProcessId,CommandLine | ConvertTo-Json`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return [];
  try {
    const j = JSON.parse(r.stdout);
    const list = Array.isArray(j) ? j : [j];
    return list
      .map(p => ({ pid: p.ProcessId, cmd: String(p.CommandLine || '').slice(0, 100) }))
      .filter(p => p.pid && (/teamwork/i.test(p.cmd) || /(?:^|[\s"'])node(?:\.exe)?\s+server[\\\\/]+index\.js\s*$/i.test(p.cmd)));
  } catch { return []; }
}
// ★ v4.6.5 杀进程树（taskkill /T 杀整棵子树——server 派生的任何残留子进程一并清理）
function killTree(pid) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); return true; } catch { return false; }
  }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

async function waitReady(port, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`);
    else if (process.platform === 'darwin') execSync(`open "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}

async function cmdStart() {
  const idx = args.indexOf('--port') !== -1 ? args.indexOf('--port') : args.indexOf('-p');
  const port = idx > 0 ? parseInt(args[idx + 1], 10) || 8787 : 8787;
  const existing = readPid();
  if (existing && isRunning(existing)) {
    const p = detectPort() || port;
    console.log(`  TeamWork already running (PID ${existing}) -> http://localhost:${p}`);
    openBrowser(`http://localhost:${p}`);
    return;
  }
  removePid();
  // ★ v4.6.5 端口预检：已被其他进程占用（残留 server / 别的服务）时提前报告
  const occ = portOccupiedBy(port);
  if (occ) {
    console.warn(`  ⚠ 端口 ${port} 已被进程 PID ${occ} 占用（可能是残留的 teamwork server）`);
    console.warn(`    清理残留: teamwork stop --force   |   换端口启动: teamwork start --port ${port + 1}`);
  }
  console.log(`  Starting TeamWork server :${port} ...`);
  // ★ v4.6.5 后台进程日志落盘（崩溃可查：~/.teamwork/logs/server.log / server-error.log）
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outFd = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
  const errFd = fs.openSync(path.join(LOG_DIR, 'server-error.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    detached: true, stdio: ['ignore', outFd, errFd],
    cwd: ROOT,
  });
  fs.closeSync(outFd); fs.closeSync(errFd); // 子进程已继承 fd，父进程立即关闭防泄漏
  child.unref();
  writePid(child.pid);
  const ready = await waitReady(port);
  if (ready) {
    console.log(`  TeamWork server ready -> http://localhost:${port}`);
    if (!process.env.TEAMWORK_NO_BROWSER) openBrowser(`http://localhost:${port}`); // env 开关：CI/脚本场景不弹浏览器
  } else {
    console.warn(`  Port ${port} wait timeout - server may need more time`);
    console.warn(`  查看日志: ${path.join(LOG_DIR, 'server-error.log')}`);
  }
}

async function cmdStop() {
  const force = args.includes('--force');
  const pid = readPid();
  if (pid && isRunning(pid)) {
    const port = detectPort() || 8787;
    console.log(`  正在停止 TeamWork server (PID ${pid}, :${port}) ...`);
    // ① 优雅停止：HTTP /api/shutdown 握手（server 同步 flush state + 终止飞书同步 + 清理运行时文件）
    let graceful = false;
    try {
      const headers = {};
      const sec = readSecret();
      if (sec) headers['x-tw-shutdown'] = sec;
      const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers, signal: AbortSignal.timeout(3000) });
      graceful = r.ok;
    } catch { graceful = false; }
    // ② 轮询等待进程自行退出（最多 5s）
    if (graceful) {
      for (let i = 0; i < 25 && isRunning(pid); i++) await new Promise(r => setTimeout(r, 200));
    }
    // ③ 兜底强杀进程树（taskkill /T /F）——优雅停止失败/超时/旧版 server 无 shutdown 端点时，连残留子进程一并清理
    if (isRunning(pid)) {
      console.log(`  ${graceful ? '优雅停止超时' : '优雅停止不可用（旧版 server？）'}，强制杀进程树 ...`);
      killTree(pid);
      for (let i = 0; i < 10 && isRunning(pid); i++) await new Promise(r => setTimeout(r, 200));
    }
    console.log(isRunning(pid) ? `  ⚠ 进程 ${pid} 可能未退出，请检查任务管理器` : '  TeamWork server stopped');
    removePid();
  } else if (!force) {
    console.log('  TeamWork server not running');
    removePid();
  }
  // ★ v4.6.5 --force：扫描并清理所有残留的 teamwork server 进程（PID 文件丢失/脱节时的孤儿——含其他端口实例）
  if (force) {
    const procs = findServerProcesses();
    if (procs.length) {
      console.log(`  --force: 发现 ${procs.length} 个 teamwork server 进程，强制清理：`);
      for (const p of procs) {
        console.log(`    PID ${p.pid}  ${p.cmd}`);
        killTree(p.pid);
      }
      console.log('  残留进程已清理');
    } else {
      console.log('  --force: 未发现残留的 teamwork server 进程');
    }
    removePid();
  }
}

async function cmdStatus() {
  const pid = readPid();
  const running = pid && isRunning(pid);
  const port = detectPort() || 8787;
  if (running) {
    console.log(`  TeamWork server running (PID ${pid}, :${port})`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/sync/stats`);
      const j = await r.json();
      console.log(`     Uploaded: ${j.uploaded || 0} | Last sync: ${j.lastSync ? new Date(j.lastSync).toLocaleString() : 'N/A'}`);
    } catch {}
    if (fs.existsSync(TOKEN_FILE)) {
      const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      console.log(`     MCP token: ${t.user || '?'} @ ${t.wsId || 'no workspace'}`);
    } else {
      console.log('     MCP token: not configured');
    }
  } else {
    console.log('  TeamWork server not running');
    console.log('     Run: teamwork start');
  }
  // ★ v4.6.5 孤儿检测：登记实例之外是否还有散落的 teamwork server 进程（残留 → teamwork stop --force 清理）
  const procs = findServerProcesses().filter(p => p.pid !== pid);
  if (procs.length) {
    console.log(`  ⚠ 检测到 ${procs.length} 个其他 teamwork server 进程（可能为孤儿）:`);
    for (const p of procs) console.log(`     PID ${p.pid}  ${p.cmd}`);
    if (!running) console.log('     清理: teamwork stop --force');
  }
}

async function cmdSetup() {
  const setupPath = path.join(ROOT, 'scripts', 'setup.js');
  const setupUrl = process.platform === 'win32'
    ? 'file:///' + setupPath.replace(/\\/g, '/')
    : setupPath;
  const { setupAll } = await import(setupUrl);
  const filter = args.includes('--trae') ? 'trae' : args.includes('--claude') ? 'claude' : args.includes('--cursor') ? 'cursor' : null;
  await setupAll(filter);
}

function cmdHelp() {
  console.log(`
  TeamWork - Multi-user AI Collaboration

  Usage:
    teamwork start [--port 8787]              Start server + open login page
    teamwork link <token> <wsId> [user]        Remote-access MCP setup (local use: token auto-written)
    teamwork feishu-auth [--app-id --app-secret]  Bind your Feishu identity (OAuth, once per ~30 days)
    teamwork stop [--force]                    Stop server (graceful flush; --force kills all leftovers)
    teamwork status                            Show status (+ orphan server detection)
    teamwork setup [--trae|--claude|--cursor]  Detect AI tools + configure MCP
    teamwork doctor                            Diagnose env: Node/fetch, credential chain, Feishu connectivity
    teamwork version                           Show version

  Quick Start:
    1. teamwork start          -> browser opens login page
    2. enter login ID          -> workspace lobby (token auto-written)
    3. create/join workspace   -> 「+ 创建工作组」or「加入工作组」(Feishu folder auto-created)
    4. teamwork setup          -> auto-configure MCP for your AI tools
    5. open AI tool & work     -> fully silent collaboration
  `);
}

/**
 * ★ v1.0.6 teamwork doctor —— 一键环境自检（新成员机「飞书目录创建失败」排查利器）
 * 检测：Node 版本（全局 fetch）→ 凭据链生效来源 → tenant_token 直连 → 结论 + 针对性建议
 */
async function cmdDoctor() {
  console.log('  🔍 TeamWork 环境自检（doctor）');
  const { diagnose } = await import(pathToFileURL(path.join(ROOT, 'server', 'feishu-sync.js')).href);
  const d = await diagnose();
  console.log(`  Node: ${d.node} ${d.fetchOk ? '✓' : '✗（需 >= 18，飞书请求全部失败）'}`);
  console.log(`  凭据来源: ${d.source}`);
  console.log(`  appId: ${d.appId} | secret: ${d.secretMasked} | rootFolder: ${d.rootFolder}`);
  if (d.feishuJsonBad) console.log(`  ⚠ ${d.feishuJsonBad}`);
  if (d.tenant) console.log(`  tenant_token: ${d.tenant} ✓`);
  if (d.err) console.log(`  ✗ ${d.err}`);
  for (const a of d.advice) console.log(`  → 建议: ${a}`);
  console.log(d.ok ? '  结论: ✓ 飞书通道就绪——可以创建/加入工作组' : '  结论: ✗ 飞书通道不可用——按上述建议修复后重试');
}

switch (cmd) {
  case 'start': await cmdStart(); break;
  case 'stop': await cmdStop(); break;
  case 'status': await cmdStatus(); break;
  case 'setup': await cmdSetup(); break;
  case 'link': await cmdLink(); break;
  case 'feishu-auth': await cmdFeishuAuth(); break;
  case 'doctor': await cmdDoctor(); break;
  case 'version': case '-v': case '--version':
    console.log('  TeamWork v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version); break; // ★ v1.0.1 版本号随 package.json（不再硬编码，发版只改 package.json 一处）
  default: cmdHelp(); break;
}

async function cmdLink() {
  // teamwork link <token> <wsId> [user] [--server <url>]  ← 从仪表盘弹窗复制的一条命令
  // ★ 中心化架构：远程用户从弹窗复制时自带 --server <中心server地址>（lobby.html 用 location.origin 生成）
  const serverIdx = args.indexOf('--server');
  const serverUrl = serverIdx > 0 ? args[serverIdx + 1] : null;
  const [, token, wsId, user] = args;
  if (!token || !wsId) {
    console.log('  用法: teamwork link <token> <wsId> [user] [--server <url>]');
    console.log('  从仪表盘 MCP 配置弹窗中复制完整命令后粘贴运行');
    return;
  }
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, wsId, user: user || '', ...(serverUrl ? { server: serverUrl } : {}) }, null, 1));
  console.log(`  MCP token 已写入: ${TOKEN_FILE}`);
  console.log(`  用户: ${user || '(未指定)'} | 工作组: ${wsId}`);
  if (serverUrl) {
    console.log(`  Server: ${serverUrl}（中心化模式——飞书/状态全在中心 server，本机无需任何凭据）`);
    process.env.TEAMWORK_SERVER_URL = serverUrl; // ★ 注入给随后的 setup：MCP 配置写入远程 URL 而非 localhost
  }
  // 自动执行 setup（配置 AI 工具 MCP）
  console.log('\n  正在自动配置 AI 工具...');
  await cmdSetup();
}

/**
 * ★ v4.7 用户身份：teamwork feishu-auth —— 绑定自己的飞书账号（OAuth 授权码；活跃使用免重登，闲置 >7 天需重授权）
 * 流程：本地 9916 回调 → 浏览器授权（用户自己已登录的飞书账号）→ authen/v2 换 token（app 凭据来自 Leader 分发物）
 *       → 本地备份 ~/.teamwork/user-token.json → 上报中心 server（按用户持久化 + 自动共享根目录）
 * 此后创建/加入/搜索/删除工作组、记忆上传，全部以该用户的飞书身份执行（access ~2h + refresh 7 天滚动续期）
 */
async function cmdFeishuAuth() {
  // ① 应用凭据：--app-id/--app-secret 参数 > ~/.teamwork/feishu.json（Leader 分发物；参数首次给出时顺手持久化）
  //    --root-folder（可选）：共享根目录 token——一并持久化（全局安装无 .env，server 从本文件兜底读）
  const cred = loadJsonSafe(FEISHU_ENV_FILE) || {};
  let appId = cred.appId, appSecret = cred.appSecret;
  const ai = args.indexOf('--app-id'); if (ai > 0 && args[ai + 1]) appId = args[ai + 1];
  const si = args.indexOf('--app-secret'); if (si > 0 && args[si + 1]) appSecret = args[si + 1];
  const ri = args.indexOf('--root-folder'); const rootFolder = ri > 0 && args[ri + 1] ? args[ri + 1] : (cred.rootFolder || '');
  if ((appId && appSecret) && (cred.appId !== appId || cred.appSecret !== appSecret || (rootFolder && cred.rootFolder !== rootFolder))) {
    fs.mkdirSync(path.dirname(FEISHU_ENV_FILE), { recursive: true });
    fs.writeFileSync(FEISHU_ENV_FILE, JSON.stringify({ ...cred, appId, appSecret, ...(rootFolder ? { rootFolder } : {}) }, null, 1));
    console.log(`  应用凭据已保存: ${FEISHU_ENV_FILE}`);
  }
  if (!appId || !appSecret) {
    console.log('  缺少飞书应用凭据（Leader 分发的 app_id / app_secret）。两种提供方式：');
    console.log('    1) teamwork feishu-auth --app-id <cli_xxx> --app-secret <xxx>');
    console.log(`    2) 手动写入 ${FEISHU_ENV_FILE} → {"appId":"cli_xxx","appSecret":"xxx"}`);
    process.exit(1);
  }
  // ② 中心 server 登录态（token.json：浏览器注册/加入时写入）
  const tok = loadJsonSafe(TOKEN_FILE);
  const sIdx = args.indexOf('--server');
  const serverUrl = (sIdx > 0 ? args[sIdx + 1] : null) || (tok && tok.server) || 'http://127.0.0.1:8787';
  if (!tok || !tok.token) {
    console.log('  未找到中心 server 登录态（~/.teamwork/token.json）——');
    console.log('  请先浏览器打开中心 dashboard 注册/登录，创建或加入工作组后复制 link 命令运行，再执行 feishu-auth');
    process.exit(1);
  }
  const PORT = 9916;
  const REDIRECT_URI = `http://localhost:${PORT}/callback`;
  const STATE = 'tw-feishu-' + Date.now().toString(36);
  // ★ v4.7.3 修复：authorize 必须显式申请业务 scope（云文档读写）——不传 scope 时飞书只发最小登录 token
  //   （scope=auth:user.id:read）且不返回 refresh_token（2026-10-14 真实 OAuth 实测；demo v4.1「v2 无 refresh_token」同因）
  // ★ offline_access（OIDC 标准离线访问 scope）：不申请则 v2 oauth/token 恒不返回 refresh_token（第二轮实测：
  //   scope=drive:drive docx:document 时响应仍只有 5 字段，无 refresh_token）——「~30 天自动续期」的硬依赖
  const SCOPES = 'offline_access drive:drive docx:document';
  const authUrl = 'https://open.feishu.cn/open-apis/authen/v1/authorize?' +
    new URLSearchParams({ app_id: appId, redirect_uri: REDIRECT_URI, state: STATE, scope: SCOPES }).toString().replace(/\+/g, '%20');
  console.log('  == teamwork feishu-auth —— 绑定你的飞书身份 ==');
  console.log(`  [前置] 应用后台 安全设置 → 重定向 URL 需已添加: ${REDIRECT_URI}`);
  console.log(`  [申请权限 scope] ${SCOPES}（授权页将显示云文档读写授权项——refresh_token 依赖它）`);
  console.log(`  即将打开浏览器授权页（用你自己已登录的飞书账号同意授权）:\n    ${authUrl}\n`);

  let done = false;
  const { default: http } = await import('node:http');
  const server = http.createServer((req2, res2) => {
    const u = new URL(req2.url, `http://localhost:${PORT}`);
    if (u.pathname !== '/callback') { res2.statusCode = 404; return res2.end('not found'); }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    res2.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!code || state !== STATE) {
      res2.end('<h3>授权回调参数异常（state 不匹配或缺少 code），请重试 teamwork feishu-auth</h3>');
      return finish(1);
    }
    res2.end('<h3>✓ 授权成功！请回到终端查看绑定结果</h3>');
    exchange(code);
  });
  server.listen(PORT, () => {
    openBrowser(authUrl);
    console.log(`  本地回调服务已监听 :${PORT}，等待浏览器授权完成…`);
  });

  async function exchange(code) {
    try {
      // 换 token（authen v2；scope 必须含 offline_access 才返回 refresh_token——2026-10-14 三轮真实 OAuth 实测定案）
      const r = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.access_token) throw new Error(`换 token 失败: ${JSON.stringify(j).slice(0, 200)}`);
      const t = { accessToken: j.access_token, refreshToken: j.refresh_token || '', expiresAt: Date.now() + (j.expires_in || 6000) * 1000 - 60000 };
      if (!j.refresh_token) console.warn('  [警告] 飞书未返回 refresh_token——token 过期（~2h）后需重新授权（正常不应发生：scope 已申请 offline_access）');
      fs.mkdirSync(path.dirname(FEISHU_USER_TOKEN_FILE), { recursive: true });
      fs.writeFileSync(FEISHU_USER_TOKEN_FILE, JSON.stringify(t, null, 1));
      console.log(`\n  ✓ 已获取你的飞书身份 token（本地备份: ${FEISHU_USER_TOKEN_FILE}）`);
      // 上报中心 server：按用户持久化 + tenant 自动把共享根目录授权给你（可编辑——个人身份才能建组目录）
      const r2 = await fetch(`${String(serverUrl).replace(/\/+$/, '')}/api/feishu/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${tok.token}` },
        body: JSON.stringify(t),
      });
      const j2 = await r2.json().catch(() => ({}));
      if (j2.ok) {
        console.log(`  ✓ 已绑定到中心 server（${serverUrl}）：飞书身份「${j2.feishuName || j2.openId}」，共享根目录授权 ${j2.shared ? 'OK' : '已有'}`);
        console.log('  此后创建/加入/搜索/删除工作组与记忆上传，全部以你的飞书身份执行（token 自动续期：活跃使用免重登；超过 7 天未使用需重新授权）');
        finish(0);
      } else {
        console.error(`  ✗ 上报中心 server 失败: ${j2.error || ('HTTP ' + r2.status)}`);
        console.error('  （本地 token 已保存；server 恢复后重跑本命令即可，无需重新授权则直接复用）');
        finish(1);
      }
    } catch (e) {
      console.error(`\n  ✗ 授权失败: ${e.message}`);
      console.error('  常见原因：redirect_uri 未在应用后台配置 / 应用未发布 / 用户身份权限未开通');
      finish(1);
    }
  }
  function finish(exitCode) {
    if (done) return; done = true;
    try { server.close(); } catch {}
    setTimeout(() => process.exit(exitCode), 400);
  }
  // 兜底：3 分钟无回调自动退出
  setTimeout(() => { if (!done) { console.error('\n  ✗ 等待授权超时（3 分钟），请重试'); finish(1); } }, 3 * 60 * 1000);
}

