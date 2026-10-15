/**
 * mcp/index.js —— teamwork-mcp v4：TRAE/任意 MCP 宿主的零安装接入面
 * 
 * v4 变更：所有工作区操作需要 wsId（从 token.json 读取）
 * 工具列表：join / inbox_status / ack / report_done / share_memory / search / publish_task / skills
 * fail-open：server 不可达时返回明确提示，绝不阻塞宿主会话
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(os.homedir(), '.teamwork', 'token.json');
// ★ 中心化架构：server 地址三级回退——env（MCP 配置注入）> token.json.server（teamwork link --server 写入）> 本机默认
function detectServerUrl() {
  if (process.env.TEAMWORK_SERVER_URL) return process.env.TEAMWORK_SERVER_URL;
  try { const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); if (t.server) return t.server; } catch {}
  return 'http://127.0.0.1:8787';
}
const SERVER_URL = detectServerUrl();

function loadToken() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } }
function saveToken(t) { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 1)); }

async function callServer(method, path, body = {}) {
  const t = loadToken();
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(t?.token ? { Authorization: `Bearer ${t.token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) return { ok: false, error: '未授权：请先调用 teamwork_join' };
  return j;
}
function wsPath(action) {
  const t = loadToken();
  if (!t?.wsId) throw new Error('未加入工作组：请先调用 teamwork_join');
  return `/api/ws/${t.wsId}/${action}`;
}

const TOOLS = [
  {
    name: 'teamwork_join',
    description: '加入工作组：输入名字 + Workspace ID + Wpassword，获得会话 token（保存到 ~/.teamwork/token.json）',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string', description: '你的名字（临时身份）' },
      wsId: { type: 'string', description: '工作组 ID（ws-xxxx）' },
      password: { type: 'string', description: '工作组密码 Wpassword' },
      wsName: { type: 'string', description: '工作组名称（可选，通过飞书索引查找）' },
    }, required: ['user', 'password'] },
  },
  {
    name: 'teamwork_inbox_status',
    description: '查询任务收件箱：返回当前可拾取任务的 L0 索引。建议会话开始时和完成工作后调用',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'teamwork_ack',
    description: '拾取收件箱中的子任务（原子抢锁）。返回 ContextBundle：任务描述/验收标准 + 前置摘要',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'teamwork_report_done',
    description: '上报子任务完成（自动解锁后继并从全员收件箱清除）。summary 建议结构化（claude-mem Stop 摘要式）：做了什么(completed) / 关键发现(learned) / 下一步(next_steps)——它是后继拾取者的注入上下文',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, summary: { type: 'string' } }, required: ['taskId', 'summary'] },
  },
  {
    name: 'teamwork_share_memory',
    description: '分享记忆到工作组（type: summary|decision|bugfix|feature|discovery|change|gotcha；concepts 小写英文标签）',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' }, type: { type: 'string' }, narrative: { type: 'string' },
      concepts: { type: 'array', items: { type: 'string' } }, facts: { type: 'array', items: { type: 'string' } },
      files: { type: 'array', items: { type: 'string' }, description: '涉及文件路径（files_read/files_modified 锚点，可选 ≤10）' },
      taskId: { type: 'string' },
    }, required: ['title', 'type', 'narrative'] },
  },
  {
    name: 'teamwork_publish_task',
    description: '[仅 Leader] 发布协作任务——静默链路入口。在 Leader AI 对话框中调用：缺省 subtasks 时服务器用 Leader 的 AI 做画像感知拆分（结合成员 shareSkill/身份域/空闲状态），拆解后按画像定向默式注入候选成员收件箱。subtasks 可选（{what, acceptance, dependsOn[], priority, domain, assignee}）——assignee 指定执行成员（临时登录名 / 身份码 u-xxx / 名字(u-xxx)），指定任务经飞书 [task] 流传播到该成员本机收件箱并由其 AI 自动唤起；任务描述中点名某人时务必在其子任务 assignee 填该成员名',
    inputSchema: { type: 'object', properties: {
      description: { type: 'string' }, acceptance: { type: 'string' },
      domain: { type: 'string', description: '任务身份域（如 login/pay/general——成员继承时按域赋予身份）' },
      subtasks: { type: 'array', items: { type: 'object' }, description: '子任务定义数组：{what: 子任务描述, acceptance: 验收标准, dependsOn: [下标数组], priority: P0-P3, domain: 身份域, assignee: 指定成员（临时登录名/身份码/名字(身份码)）}' },
    }, required: ['description'] },
  },
  {
    name: 'teamwork_observe',
    description: '钩子采集（静默上报）：把本地 IDE/对话中产生的工作内容上报为 FlowNode 记忆——服务器自动过隐私管线（<private> 剥离+脱敏）→ 用你的 AI Provider 总结 → 自动上传飞书并实时入节点地图。建议在有工作产出/关键决策/踩坑时调用',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string', description: '原始对话片段/操作记录（服务器将总结为一条团队记忆）' },
      source: { type: 'string', description: '来源标识（如 trae/vscode/web/chat）' },
      taskId: { type: 'string', description: '关联的子任务 ID（可选）' },
      relatedTo: { type: 'array', items: { type: 'string' }, description: '相关节点 ID 列表（可选，用户标注）' },
      files: { type: 'array', items: { type: 'string' }, description: '涉及文件路径（files_read/files_modified 锚点，可选 ≤10）' },
    }, required: ['content'] },
  },
  {
    name: 'teamwork_open_ends',
    description: '列出可继承的末端未完成链路（含 domain/拓扑/前序摘要/域内记忆数）——新成员自主选择继承目标；已有身份者同域优先排序',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'teamwork_inherit',
    description: '自主继承：选择一条末端链路继承——继承节点入图（WhenWhoWhat）、你的身份由本次继承赋予（identity=该链路 domain）、租约开始（产出保活）。返回 InheritBundle：链上节点信息+域内Memory+共识+拓扑',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'teamwork_revert',
    description: '回退记忆：自己的开发链崩溃时软删回继承点——崩溃原因沉淀为失败记忆（重新开发时自动注入避免重蹈覆辙）；被下游引用时拒绝（reorg 防护）',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string', description: '崩溃原因（强烈建议填写：哪个方向走不通/卡在哪/为什么）' } }, required: ['taskId'] },
  },
  {
    name: 'teamwork_consensus',
    description: '工作组共识（LSTM 长线记忆）四模式：{text,key} 提议新共识（全员确认或 Leader 一票生效，注入全员上下文）| {confirmId} 确认提议 | [Leader] {archiveId} 归档 / {arbitrateId,accept} 裁决冲突条目',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string' }, key: { type: 'string', description: 'naming/error-code/api-style/git-workflow/architecture/testing/docs/security/other' },
      confirmId: { type: 'string' }, archiveId: { type: 'string' }, arbitrateId: { type: 'string' }, accept: { type: 'boolean' },
    } },
  },
  {
    name: 'teamwork_search',
    description: '3 层渐进披露 Step 1——紧凑索引（每条 ~50 tokens，含 ~tokens 估算）：默认关键词（身份域优先）| mode:"topo" 拓扑前缀 | mode:"domain" 域订阅。返回带 files 分组（空间局部性）。Step 2: teamwork_timeline(id) → Step 3: teamwork_get_observations(ids)',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, mode: { type: 'string' }, domain: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'teamwork_timeline',
    description: '3 层渐进披露 Step 2——围绕锚点 ID 的 ±depth 时间线上下文（含叙事片段 ~200 字）。用法：先 search 拿到相关节点 ID，再对关键节点调此工具看前后上下文（谁做了什么、因果链）',
    inputSchema: { type: 'object', properties: {
      anchorId: { type: 'string', description: '锚点节点 ID（如 N-7，从 search 结果中选取）' },
      depth: { type: 'number', description: '前后各取几条（默认 3，最大 10）' },
    }, required: ['anchorId'] },
  },
  {
    name: 'teamwork_get_observations',
    description: '3 层渐进披露 Step 3——按 ID 批量取完整详情（narrative/facts/concepts/files/injectedFrom）。仅对确认相关的 2-5 个节点调用（~200 tokens/条）。完整 3 层工作流：search（索引 1,000t）→ timeline（上下文 500t）→ get_observations（详情 1,500t）= 100% 相关',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'string' }, description: '节点 ID 数组（≤20，从 timeline 或 search 结果中选取确认相关的）' },
    }, required: ['ids'] },
  },
  {
    name: 'teamwork_skills',
    description: '列出工作组已注册的共享技能',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'teamwork-mcp', version: '4.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    if (name === 'teamwork_join') {
      // 先获取 session token
      const session = await callServer('POST', '/api/session', { name: args.user });
      if (session.error) throw new Error(session.error);
      saveToken({ token: session.token, user: args.user, wsId: args.wsId || null });
      // 再加入工作组
      if (args.wsId || args.wsName) {
        const joinBody = { password: args.password };
        if (args.wsId) joinBody.wsId = args.wsId;
        if (args.wsName) joinBody.wsName = args.wsName;
        const join = await callServer('POST', '/api/workspaces/join', joinBody);
        if (join.error) throw new Error(join.error);
        saveToken({ token: session.token, user: args.user, wsId: join.wsId });
        result = join;
      } else {
        result = session;
      }
    } else {
      const act = name.replace('teamwork_', '');
      const p = wsPath(act);
      // GET 类（open-ends / skills）；其余 POST 透传（observe/inherit/revert/consensus/search/ack/...）
      result = (act === 'skills' || act === 'open-ends') ? await callServer('GET', p) : await callServer('POST', p, args);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message, hint: '本地工作不受影响；稍后重试或联系 Leader' }) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[teamwork-mcp v4] ready → ${SERVER_URL} (token: ${TOKEN_FILE})`);
