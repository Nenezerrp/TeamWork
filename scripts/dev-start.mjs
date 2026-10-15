#!/usr/bin/env node
/**
 * dev-start.mjs — 开发模式启动（npm start）
 *
 * ★ v4.7.3：server 默认 state 已迁至 ~/.teamwork/state.json（生产路径，防全局安装时数据进 node_modules）。
 * 开发模式下显式钉回仓库 state-v4.json，避免开发测试数据与生产 home state 互串/污染。
 * （E2E 多实例仍用 TEAMWORK_STATE_FILE env 自行隔离，不受影响）
 */
process.env.TEAMWORK_STATE_FILE = process.env.TEAMWORK_STATE_FILE ||
  new URL('../state-v4.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); // Windows 盘符修正
await import('../server/index.js');
