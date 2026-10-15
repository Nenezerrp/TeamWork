#!/usr/bin/env node
/**
 * build-package.mjs — 生成离线分发包（.tgz + .zip）
 *
 * 用法:
 *   node scripts/build-package.mjs              → 生成 dist/ 下的 .tgz 和 .zip
 *   node scripts/build-package.mjs --zip-only  → 只生成 .zip
 *   node scripts/build-package.mjs --tgz-only  → 只生成 .tgz
 *
 * 分发方式:
 *   .tgz: npm install -g ./teamwork-cli-1.0.0.tgz（需 Node.js，标准 npm 包）
 *   .zip: 解压 → bin/teamwork.js 直接运行（仅需 Node.js，零 npm 依赖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = pkg.name.replace('@', '').replace('/', '-');
const version = pkg.version;
const tgzName = `${name}-${version}.tgz`;
const zipName = `${name}-${version}.zip`;

const args = process.argv.slice(2);
const noTgz = args.includes('--zip-only');
const noZip = args.includes('--tgz-only');
const includeDeps = args.includes('--full'); // ★ --full: 包含 node_modules（真正离线零安装）

// 发布文件清单（与 package.json files 一致）
const INCLUDE = ['bin', 'server', 'mcp', 'scripts', 'public', 'docs', 'README.md', 'LICENSE', 'package.json'];
if (includeDeps) INCLUDE.push('node_modules'); // --full 时包含依赖
const EXCLUDE_EXTENSIONS = ['.env', '.tgz', '.zip'];
const EXCLUDE_NAMES = ['state-v4.json', 'dist', 'test', '.npmignore', '.git'];
if (!includeDeps) EXCLUDE_NAMES.push('node_modules'); // 默认不含；--full 含（真正离线零安装）

function shouldInclude(relPath) {
  const name = path.basename(relPath);
  if (EXCLUDE_NAMES.includes(name)) return false;
  if (EXCLUDE_EXTENSIONS.some(ext => name.endsWith(ext))) return false;
  return INCLUDE.some(item => relPath === item || relPath.startsWith(item + '/'));
}

function copyDir(src, dest, base) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relPath = path.relative(base, srcPath).replace(/\\/g, '/');
    if (!shouldInclude(relPath)) continue;
    if (entry.isDirectory()) copyDir(srcPath, destPath, base);
    else fs.copyFileSync(srcPath, destPath);
  }
}

console.log(`\n  TeamWork Package Builder v${version}\n  ${'─'.repeat(40)}\n`);

// 清理 dist
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ---- Method 1: .tgz (npm 标准包) ----
if (!noTgz) {
  console.log('  [1/2] 生成 .tgz (npm 离线安装包)...');
  execSync('npm pack --pack-destination dist', { cwd: ROOT, stdio: 'pipe' });
  const tgz = path.join(DIST, tgzName);
  const size = fs.statSync(tgz).size;
  console.log(`  ✅ ${tgzName} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`     用户安装: npm install -g ./${tgzName}`);
}

// ---- Method 2: .zip (零 npm 依赖，解压直接运行) ----
if (!noZip) {
  console.log('  [2/2] 生成 .zip (解压直接运行)...');
  const zipDir = path.join(DIST, `${name}-${version}`);
  copyDir(ROOT, zipDir, ROOT);
  // 清理 zip 目录中的 dist 自身
  fs.rmSync(path.join(zipDir, 'dist'), { recursive: true, force: true });

  // 生成安装说明
  const installPath = path.join(zipDir, 'INSTALL.txt');
  fs.writeFileSync(installPath, `
TeamWork ${version} — ${includeDeps ? '完整离线包（含依赖，零安装）' : '源码包（需 npm install 获取依赖）'}
${'='.repeat(60)}

前置条件: 已安装 Node.js >= 18 (https://nodejs.org)

${includeDeps ? 
`✅ 本包已包含全部依赖（node_modules）——解压后直接运行，无需联网。

  启动:
    node bin/teamwork.js start

  或安装为全局命令:
    npm install -g ./
    teamwork start
` :
`⚠ 本包不包含依赖（node_modules），需要联网安装依赖:

  cd ${zipDir.replace(/\\/g, '/')}
  npm install --registry https://registry.npmmirror.com
  node bin/teamwork.js start
`}

验证:
  node bin/teamwork.js version
  → TeamWork v${version}

5 步开始:
  1. 接入飞书（必需——创建工作组的前置）:
     a. 飞书开放平台创建「企业自建应用」→ 权限管理开通 drive:drive + docx:document（应用身份列）→ 创建版本并发布
     b. 安全设置 → 重定向 URL 添加 http://localhost:9916/callback
     c. 安装目录创建 .env（参照 .env.example）填入 FEISHU_APP_ID / FEISHU_APP_SECRET
        （FEISHU_ROOT_FOLDER 不配置时，应用身份自动在其云空间创建 TeamWork-Demo/ 根目录）
     完整步骤见包内 README.md 与 docs/getting-started.md「飞书接入」
  2. teamwork start          → 浏览器自动打开登录页
  3. 输入登录 ID → 点「进入」→ 工作组大厅
     → 「+ 创建工作组」（Leader，填名称+密码）或「加入工作组」（成员，填组名+密码）
     （工作组飞书目录自动创建/云端自动恢复，无需手动建目录）
  4. teamwork setup          → 自动检测本机 AI 工具并写入 MCP 配置，完成
  5. 可选增强——绑定个人飞书身份（云文档归属你本人）:
     teamwork feishu-auth --app-id <你的AppID> --app-secret <你的飞书AppSecret> [--root-folder <根目录token>]
     → 浏览器自动打开 → 用你自己的飞书账号登录授权 → 完成（根目录自动共享给你，无需手动操作）
     （前置：管理员需先在飞书开放平台把你加入应用「可用范围」）

数据落位: 全部存 ~/.teamwork/（state/token/凭据/日志）——升级安装包不丢数据
详见包内 README.md
`);
  console.log(`  ✅ ${zipName} 目录 (${fs.readdirSync(zipDir).length} 个文件/目录)`);

  // Windows: 生成 zip
  try {
    execSync(`powershell Compress-Archive -Path "${zipDir}" -DestinationPath "${path.join(DIST, zipName)}" -Force`, { stdio: 'pipe' });
    const zipSize = fs.statSync(path.join(DIST, zipName)).size;
    console.log(`  ✅ ${zipName} (${(zipSize / 1024).toFixed(0)} KB)`);
    fs.rmSync(zipDir, { recursive: true, force: true }); // 清理解压目录
  } catch { console.log(`  ⚠ .zip 压缩失败（目录版仍可用: ${zipDir}）`); }
}

console.log(`\n  分发方式:`);
console.log(`  ─────────────────────`);
console.log(`  ① 微信/钉钉/内网共享 .tgz 文件 → 用户: npm install -g ./文件.tgz`);
console.log(`  ② 解压 .zip → 用户: npm install -g ./解压目录/`);
console.log(`  ③ 内网 registry (npmmirror) → npm publish --registry http://registry.npmmirror.com`);
console.log(`\n  产物位置: ${DIST}\n`);
