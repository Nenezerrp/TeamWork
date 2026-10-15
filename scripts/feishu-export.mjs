#!/usr/bin/env node
/**
 * feishu-export.mjs —— 导出飞书凭据为单文件配置脚本（分发给新装 TeamWork 的测试用户）
 *
 * 用法: node scripts/feishu-export.mjs
 * 产物: dist/feishu-setup.mjs（内嵌 .env 飞书凭据 + 共享 user-token）
 * 分发: 把产物发给新用户 → 对方: node feishu-setup.mjs（自动定位安装目录，写入并自检）
 *
 * 凭据来源:
 *   teamwork/.env                  → FEISHU_APP_ID / FEISHU_APP_SECRET / TEAMWORK_FEISHU_ENABLED
 *   ../demo/.local/user-token.json → 共享用户令牌（tenant 云文档权限审批通过前的建目录通道）
 *
 * 前置: 共享令牌必须含 refreshToken（续期链）。若缺失/损坏 → 先重新授权:
 *   cd demo && npm run user-auth   （浏览器登录授权一次，产物含 refreshToken ~30 天）
 *
 * 注意: 产物含明文凭据，仅限内网测试分发；重跑 build-package.mjs 会清空 dist/，之后需重跑本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 简易 .env 解析（KEY=VALUE，容忍注释/空行/引号值）
function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// 1. 本机 .env 飞书凭据（发版只改一处：包根 .env 即源码 .env）
const env = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
const appId = env.FEISHU_APP_ID, appSecret = env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error('[失败] teamwork/.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET，无可导出的飞书凭据');
  process.exit(1);
}

// 2. 共享用户令牌（tenant 云文档权限审批前的建目录通道）
//    实测限制（ARCHITECTURE v4.1）：飞书 authen v2 授权码不返回 refresh_token → access_token 仅 ~2h 窗口
//    → 令牌可用就分发（应急），不可用则降级为纯凭据模式（依赖 tenant 云文档权限已审批）
const utPath = path.resolve(ROOT, '..', 'demo', '.local', 'user-token.json');
let userToken = null;
let tokenNote = '';
try {
  userToken = JSON.parse(fs.readFileSync(utPath, 'utf8'));
} catch {
  tokenNote = '未找到共享令牌（' + utPath + '）——本次仅分发应用凭据';
}
if (userToken) {
  const expired = Date.now() >= (userToken.expiresAt || 0);
  if (expired) {
    const why = userToken.refreshToken ? '已过期（setup 会尝试自动续期）' : '已过期且无 refreshToken（v2 授权限制，~2h 一次性）';
    console.log('  [提示] 共享令牌 ' + why);
    if (!userToken.refreshToken) {
      console.log('  [提示] → 需要应急令牌时请重新授权: cd demo && npm run user-auth （授权后 2h 内重跑本脚本并尽快分发）');
      userToken = null;
    }
  } else {
    const left = Math.max(0, Math.round((userToken.expiresAt - Date.now()) / 60000));
    console.log('  [提示] 共享令牌可用，剩余约 ' + left + ' 分钟——分发的 setup 文件需在此窗口内被新用户运行');
  }
} else if (!tokenNote) {
  tokenNote = '共享令牌不可用——本次仅分发应用凭据';
}

// 3. 渲染模板
const tpl = fs.readFileSync(path.join(__dirname, 'feishu-setup.template.mjs'), 'utf8');
const cfg = { appId, appSecret, enabled: env.TEAMWORK_FEISHU_ENABLED || 'true', userToken, exportedAt: new Date().toISOString() };
const script = tpl.replace('/*__CFG__*/', JSON.stringify(cfg, null, 2));

// 4. 写产物
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, 'feishu-setup.mjs');
fs.writeFileSync(out, script);

console.log('');
console.log('  [OK] 已生成 ' + out);
if (tokenNote) console.log('  [注意] ' + tokenNote);
console.log('');
console.log('  分发: 把 feishu-setup.mjs 发给测试用户（微信/钉钉/内网共享均可）');
console.log('  新用户运行: node feishu-setup.mjs             （npm 全局安装 → 自动定位）');
console.log('              node feishu-setup.mjs --dir <目录>  （zip 解压安装 → 指定目录）');
console.log('  脚本会自动: 写 .env 凭据（+可用时附共享令牌）→ 真连飞书自检 → 提示重启服务');
console.log('');
console.log('  治本提醒: 飞书应用后台开通云文档权限（drive:drive / docx:document）并「创建版本+发布」');
console.log('            后，tenant 通道直接可用，新用户仅凭本脚本的凭据即可建目录（不再依赖 2h 令牌窗口）。');
console.log('');
console.log('  注意: 产物含明文凭据，仅限内网测试圈；重跑 build-package.mjs 清空 dist 后需重跑本脚本。');
