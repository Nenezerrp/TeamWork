#!/usr/bin/env node
/**
 * feishu-setup.template.mjs —— 新用户飞书凭据一键配置脚本（模板）
 *
 * 由 scripts/feishu-export.mjs 渲染（注入 CFG）→ dist/feishu-setup.mjs 分发给测试用户。
 * 新用户运行: node feishu-setup.mjs [--dir <TeamWork 安装目录>]
 *
 * 做什么: 定位安装目录 → 写 .env 飞书凭据（保留已有配置）→ 写共享 user-token（含自动续期链）
 *         → 真连飞书 API 自检 → 提示重启服务。零依赖，仅需 Node.js >= 18。
 * 注意: 渲染产物内嵌共享凭据，仅限团队内网测试分发，勿上传公网。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const CFG = /*__CFG__*/; // ★ feishu-export.mjs 注入，勿手改
const API = 'https://open.feishu.cn';
const TOKEN_NAME = '.teamwork-user-token.json';
const args = process.argv.slice(2);

// Windows 老控制台（GBK 代码页）下中文输出会乱码 → 切 UTF-8 代码页（失败不影响功能）
if (process.platform === 'win32') { try { execSync('chcp 65001 >nul', { stdio: 'ignore' }); } catch {} }


function fail(msg) { console.log('[失败] ' + msg); process.exit(1); }
function isPkgDir(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8').replace(/^﻿/, '')).name === '@teamwork/cli'; }
  catch { return false; }
}
function locateDir() {
  const i = args.indexOf('--dir');
  if (i !== -1 && args[i + 1]) {
    const p = path.resolve(args[i + 1]);
    if (!isPkgDir(p)) fail('--dir 指定的目录不是 TeamWork 安装目录（缺 @teamwork/cli 的 package.json）: ' + p);
    return p;
  }
  if (isPkgDir(process.cwd())) return process.cwd();
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, '@teamwork', 'cli');
    if (isPkgDir(p)) return p;
  } catch {}
  fail('未找到 TeamWork 安装目录。\n  npm 全局安装: 不带参数重跑本脚本（自动定位）\n  zip 解压运行: node feishu-setup.mjs --dir <解压目录>');
}
// .env 合并写入：逐行更新/追加指定键，保留其它已有配置
function upsertEnv(file, updates) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  if (lines.length && lines[0].startsWith('﻿')) lines[0] = lines[0].slice(1); // 去 BOM
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex(l => new RegExp('^\\s*(export\\s+)?' + k + '\\s*=').test(l));
    if (i >= 0) lines[i] = k + '=' + v; else lines.push(k + '=' + v);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
async function apiPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

const dir = locateDir();
const tokenFile = path.join(dir, TOKEN_NAME);
console.log('');
console.log('== TeamWork 飞书凭据配置 ==');
console.log('  安装目录: ' + dir);


// 1) 共享用户令牌（tenant 云文档权限审批前的建目录通道；v2 授权无 refresh_token → access_token 仅 ~2h 窗口）
let wroteToken = false;
if (CFG.userToken && CFG.userToken.accessToken && Date.now() < (CFG.userToken.expiresAt || 0)) {
  fs.writeFileSync(tokenFile, JSON.stringify(CFG.userToken));
  wroteToken = true;
  const left = Math.max(0, Math.round((CFG.userToken.expiresAt - Date.now()) / 60000));
  console.log('[OK] 共享飞书令牌已写入 ' + TOKEN_NAME + '（有效期约剩 ' + left + ' 分钟' +
    (CFG.userToken.refreshToken ? '，含 refreshToken 可自动续期' : '；v2 授权无 refresh_token，过期后请联系导出者重新生成本文件') + '）');
} else {
  console.log('[警告] 本文件未携带有效用户令牌（缺失或已过期）——走应用凭据（tenant）通道，');
  console.log('       需飞书应用已开通云文档权限（drive:drive 等）并发布过版本；否则创建工作组会报凭据错误');
}

// 2) 写 .env（保留已有配置，只更新飞书相关键）
const envUpdates = {
  TEAMWORK_FEISHU_ENABLED: CFG.enabled || 'true',
  FEISHU_APP_ID: CFG.appId,
  FEISHU_APP_SECRET: CFG.appSecret,
};
if (wroteToken) envUpdates.TEAMWORK_USER_TOKEN_PATH = tokenFile;
upsertEnv(path.join(dir, '.env'), envUpdates);
console.log('[OK] .env 已写入飞书凭据（APP_ID / APP_SECRET' + (wroteToken ? ' / 令牌路径' : '') + '，其它配置原样保留）');

// 3) 真连飞书 API 自检
console.log('');
console.log('== 连通性自检（真实请求飞书 API，约数秒）==');
let pass = true;
try {
  const j = await apiPost(API + '/open-apis/auth/v3/tenant_access_token/internal', { app_id: CFG.appId, app_secret: CFG.appSecret });
  if (j.code === 0) console.log('[OK] 应用凭据（tenant_token）获取成功');
  else { pass = false; console.log('[失败] 应用凭据获取失败 code=' + j.code + ' ' + (j.msg || '')); }
} catch (e) { pass = false; console.log('[失败] 网络异常（连不上 open.feishu.cn）: ' + e.message); }

try {
  if (!wroteToken) {
    console.log('[提示] 未分发用户令牌，跳过令牌自检（凭据通道 = tenant）');
  } else {
    let ut = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (Date.now() >= (ut.expiresAt || 0)) {
      if (!ut.refreshToken) throw new Error('令牌已过期且无 refreshToken（v2 授权限制）——请联系导出者重新生成本文件');
      console.log('  共享令牌 access_token 已过期，自动续期中 ...');
      const nt = await apiPost(API + '/open-apis/authen/v2/oauth/token', { client_id: CFG.appId, client_secret: CFG.appSecret, grant_type: 'refresh_token', refresh_token: ut.refreshToken });
      if (!nt.access_token) throw new Error('续期失败: ' + JSON.stringify(nt).slice(0, 120));
      ut = { accessToken: nt.access_token, refreshToken: nt.refresh_token || ut.refreshToken, expiresAt: Date.now() + (nt.expires_in || 6000) * 1000 - 60000 };
      fs.writeFileSync(tokenFile, JSON.stringify(ut)); // 回写续期结果（续期链不断）
      console.log('[OK] 共享令牌续期成功，有效期至 ' + new Date(ut.expiresAt).toLocaleString());
    } else {
      console.log('[OK] 共享令牌有效（至 ' + new Date(ut.expiresAt).toLocaleString() + '）');
    }
    const r = await fetch(API + '/open-apis/drive/v1/files?folder_token=&page_size=5', { headers: { Authorization: 'Bearer ' + ut.accessToken } });
    const j2 = await r.json().catch(() => ({}));
    if (j2.code === 0) console.log('[OK] 云空间访问验证通过（创建工作组的建目录能力就绪）');
    else console.log('[警告] 云空间探测 code=' + j2.code + '（部分账号根目录不可列举；若创建工作组仍报错，请反馈本行信息）');
  }
} catch (e) { pass = false; console.log('[失败] 共享令牌不可用: ' + e.message + '（请把本文件退回导出者重新生成）'); }

// 4) 重启提示（server 启动时读 .env，运行中不生效）
const running = (() => { try { const pid = parseInt(fs.readFileSync(path.join(os.homedir(), '.teamwork', 'server.pid'), 'utf8').trim(), 10); process.kill(pid, 0); return true; } catch { return false; } })();
console.log('');
if (pass) {
  console.log('== 配置完成 ==');
  console.log('  下一步: ' + (running ? '服务正在运行，需重启生效:  teamwork stop  然后  teamwork start' : '启动服务:  teamwork start'));
  console.log('  然后浏览器打开 http://localhost:8787 登录并创建工作组');
} else {
  console.log('== 配置已写入，但自检未全部通过 ==');
  console.log('  请把上面 [失败] 行的信息反馈给导出者');
}
