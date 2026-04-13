# Sandbox 能力升级：自主 Agent 运行环境

> Branch: `feature/sandbox-upgrade`  
> 基准提交: `cee59485` → 当前 HEAD  
> 目标：让 Agent 拥有真正自主的运行环境——MCP 生态接入、持久化后台任务、cron 定时任务、事件监听、KV 存储、Webhook、增强 Shell，真正成为能自我进化的自主 Agent。

---

## 已完成任务总览

| Task | 标题 | 状态 |
|:-----|:-----|:----:|
| MCP Bridge | MCP Server 桥接（stdio + Streamable HTTP） | ✅ |
| SKILL.md | agentskills.io 标准生态原生支持 | ✅ |
| P0-4 | LLM 上下文同步（Two-pass 动态化 + 模块文档重生成） | ✅ |
| P1-6 | Cron API — Sandbox 内自建持久化定时任务 | ✅ |
| P1-7 | Events API — Sandbox 事件监听器注册 | ✅ |
| P2-8 | 后台任务持久化（spawnPersistent）| ✅ |
| P2-9 | KV Store — SQLite 键值存储 | ✅ |
| P2-10 | Shell 增强（--rcfile / PATH / aliases） | ✅ |
| P2-12 | HTTP Webhook 模块 | ✅ |

---

## 一、MCP Bridge — 接入外部 MCP Server

### 核心实现

**`src/sandbox/modules/mcp-bridge.ts`**（新建，740 行）

Worker 进程内运行的 MCP 客户端，通过 JSON-RPC over stdio 与外部 MCP Server 子进程通信：

- 连接管理：`connect(name, config)` 启动子进程，`disconnect(name)` 清理，`list()` 列举已连接 servers
- 自动工具发现：连接后立即发送 `tools/list`，将所有 tool schemas 解析为 `MethodDoc[]` 并注入 `_moduleRegistryCache`
- 自动重连：子进程异常退出后，最多重试 3 次（指数退避）
- 连接持久化：连接信息写入 `workspace/<chatId>/mcp-connections.json`，Worker 重建时自动恢复

**`src/sandbox/modules/shared/mcp-bridge.d.ts`**（新建）

```typescript
declare const mcp: {
    connect(serverConfig: { name: string; command: string; args?: string[]; env?: Record<string,string> }): Promise<McpServerProxy>;
    disconnect(name: string): Promise<void>;
    list(): Array<{ name: string; tools: string[]; connected: boolean }>;
};
interface McpServerProxy {
    call(toolName: string, args: Record<string,unknown>): Promise<unknown>;
    tools: Array<{ name: string; description: string; schema: object }>;
}
```

### Streamable HTTP Transport

除标准 stdio 外，新增支持 **Streamable HTTP** 传输模式：

- `mcp-bridge.ts` 内的 `StreamableHttpTransport`：POST JSON-RPC 请求到远端 URL，支持 SSE 响应流
- `config.ts` 中 `McpServerConfig` 新增 `transport: "stdio" | "streamable-http"` + `url` + `headers` 字段
- `config.example.yaml` 新增 `mcpServers` 配置段示例

### 配置层 & 自动连接

**`src/core/config.ts`** 新增 `mcpServers` 配置（`SandboxConfig`）：

```yaml
mcpServers:
  - name: github
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_xxxx"
    autoConnect: true
  - name: remote-api
    transport: streamable-http
    url: "https://api.example.com/mcp"
    autoConnect: false
```

`autoConnect: true` 的 Server 在 Sandbox（Worker）启动时自动连接，工具 brief 立即出现在下一个 turn 的 `{{apiTypeDefs}}` 中。

### Dashboard MCP 管理面板

**`src/dashboard/ui/src/panels/McpPanel.svelte`**（新建，354 行）

| 功能 | 说明 |
|:-----|:-----|
| Transport 选择器 | stdio / streamable-http，条件渲染对应字段 |
| stdio 表单 | Command（必填）、Args（空格分隔）、Env（KEY=VALUE 换行） |
| HTTP 表单 | URL（必填，格式校验）、Headers（KEY=VALUE 换行，可选） |
| 连接/断开 | 一键操作，实时状态刷新 |
| Tool 列表 | 展示已发现的所有工具名称 |

- `src/dashboard/ui/src/App.svelte` + `TabNav.svelte`：新增「MCP」标签页
- `src/dashboard/api-routes.ts`：新增 `/sandbox/:chatId/mcp/connect`、`/disconnect`、`/list` 端点

### Dashboard API

```
POST /sandbox/:chatId/mcp/connect    { transport, command?, args?, env?, url?, headers? }
POST /sandbox/:chatId/mcp/disconnect { name }
GET  /sandbox/:chatId/mcp/list
```

---

## 二、SKILL.md 生态原生支持

### 问题根因

Standard SKILL.md 格式的 Agent Skills（`workspace/skills/<name>/SKILL.md`）虽能在 `{{agentSkillsBrief}}` 中显示，但 **不出现在 `{{apiTypeDefs}}`** 中，而 LLM 主要通过 API Overview 感知可用工具，导致这类 skills 事实上不可见。

### 修复内容

**`src/sandbox/modules/docs.ts`**

- 导出 `AgentSkillEntry` 接口和 `loadAgentSkillDocs()` 函数
- 新增 `getAgentSkillsApiBriefs()` — 生成结构化 `## agent-skills` 代码块，供注入 `{{apiTypeDefs}}`：

```
## agent-skills
Standard Agent Skills from workspace/skills/*/SKILL.md.
- x-search: Search X (Twitter) posts via xAI API. docs.read("x-search") scripts=...
```

**`src/subagent/code-act-executor.ts`**

`loadApiTypeDefs()` 末尾追加 `getAgentSkillsApiBriefs()` 输出，SKILL.md skills 现在对 LLM 完全可见。

**`src/sandbox/skill-loader.ts`**

`discoverSkills()` 对含 `SKILL.md` 的目录不再打印误导性 WARN。

**测试**: `tests/agent-skills-support.test.ts`（3 tests，全通过）

---

## 三、P0-4：LLM 上下文同步

### Two-pass prefixMap 动态化

**`src/sandbox/session-runner.ts`** + **`src/subagent/code-act-executor.ts`**

原 `twoPassConfig.prefixMap` 在 session 开始前静态构建，MCP 运行时连接的工具无法被识别。

改为 **每个 turn 重新获取**：

```typescript
// session-runner.ts
twoPassConfig: {
    getPrefixMap: () => buildPrefixMap(getLatestRegistry()),  // getter，每 turn 调用
    lookupDocs: (called) => lookupFullDocs(getLatestRegistry(), called),
}
```

- `code-act-executor.ts` 新增 `refreshModuleRegistryCache()` 和 `getModuleRegistryCache()`
- MCP 连接后 `_moduleRegistryCache`/`_apiBriefCache` 立即失效，下一个 turn 自动重建

### 模块文档重生成

- `src/sandbox/modules/modules-docs.json` 重新生成，包含所有新模块：`mcp`、`cron`、`events`、`kv`、`http`、`runtime`（新增方法）
- `src/sandbox/modules/brief-overview.md` 同步更新

### TRIVIAL_CALLS 更新

**`src/sandbox/api-intent-extractor.ts`** 新增无需 Pass 2 的轻量调用白名单：

```
cron.list, events.list, kv.get, kv.del, mcp.list, http.listWebhooks, ...
```

### System Prompt 更新

**`system-prompts/executor/subagent-execution.md`** 新增「自主能力」说明段，简要描述 cron、events、kv、webhook、MCP、fetch 能力（每条 1-2 行，保持前缀缓存友好）。

### Agent Docs

**`workspace/agent-docs/mcp-guide.md`**（新建）：MCP Server 连接指南，含常用 Server 示例和 Tool 调用方式，供 LLM 调用 `docs.read("mcp-guide")` 查阅。

---

## 四、P1-6：Cron API

### API

**`src/sandbox/modules/cron.ts`** + **`src/sandbox/modules/shared/cron.d.ts`**（新建）

```typescript
declare const cron: {
    add(name: string, cronExpr: string, code: string): Promise<{ id: string }>;
    remove(id: string): Promise<void>;
    list(): Promise<Array<{ id: string; name: string; cronExpr: string; nextRun?: string }>>;
};
```

Cron 任务以代码字符串形式持久化，触发时在对应 chat 的 sandbox 中执行。

### 实现层

**`src/core/cron-matcher.ts`**（新建）

- `matchesCron(expr, now)` — 轻量级 cron 表达式匹配器（分 时 日 月 周，支持 `*`/`,`/`-`/`/`）
- 不依赖外部库

**`src/main-agent/global-state.ts`**

- `addSandboxCron(chatId, name, cronExpr, code)` — 添加 sandbox-cron 类型的任务
- `markCronTriggered(id)` — 记录上次触发时间
- `SchedulerEvent` 类型扩展：新增 `type: "sandbox-cron"` + `code` 字段

**`src/main.ts`**

- hostCallHandler 新增 `cron.add`、`cron.remove`、`cron.list` 路由
- 每 60s 的 Cron 轮询循环：遍历所有 sandbox-cron 条目，匹配则在对应 sandbox 中 `executeCode(code)`

---

## 五、P1-7：Events API

### API

**`src/sandbox/modules/events.ts`** + **`src/sandbox/modules/shared/events.d.ts`**（新建）

```typescript
declare const events: {
    on(typePrefix: string, handlerCode: string): string;   // returns listenerId
    off(listenerId: string): void;
    list(): Array<{ id: string; typePrefix: string }>;
};
```

### 实现层

**`src/sandbox/sandbox.ts`**

- 新增 `eventListeners: Map<string, { typePrefix: string; handlerCode: string }>` 成员
- `registerEventListener(typePrefix, handlerCode)` — 注册，持久化到 `workspace/<chatId>/event-listeners.json`
- `removeEventListener(id)` — 注销
- `pushEvent(event)` — Host 调用，前缀匹配后通过 IPC 发送到 Worker 执行 handlerCode
- `loadEventListeners()` / `saveEventListeners()` — 持久化控制

**`src/main.ts`**

- NC.onPush 新增 hook：遍历所有活跃 sandbox 的 eventListeners，前缀匹配后调用 `sandbox.pushEvent()`
- hostCallHandler 新增 `events.on`、`events.off`、`events.list` 路由

**`src/sandbox/sandbox-pool.ts`**

新增 `SandboxPool.entries()` 方法，供 NC 事件转发循环迭代所有活跃实例。

---

## 六、P2-8：后台任务持久化

### 新增 API

**`src/sandbox/modules/runtime.ts`** + **`src/sandbox/modules/runtime.d.ts`** 新增方法：

```typescript
runtime.spawnPersistent(name: string, code: string): void
// 启动持久化后台任务，代码保存到磁盘，Worker 重启后自动恢复

runtime.home(): string   // 返回当前 chat 的 sandbox home 目录
runtime.workspace(): string  // 返回 workspace 根目录
```

`runtime.kill(name)` 同时删除持久化记录。

### BackgroundManager 重构

**`src/sandbox/background-manager.ts`**（大幅扩展）

- 持久化任务记录写入 `workspace/<chatId>/persistent-tasks.json`（`handlerCode` 字符串形式）
- Worker 启动时调用 `restorePersistentTasks()` 重新 spawn 所有持久化任务
- 将原本散落在 `sandbox-worker.ts` 的持久化逻辑集中归一（消除意大利面条代码）

---

## 七、P2-9：KV Store

### API

**`src/sandbox/modules/kv.ts`** + **`src/sandbox/modules/shared/kv.d.ts`**（新建）

```typescript
declare const kv: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
    keys(prefix?: string): Promise<string[]>;
};
```

### 实现层

**`src/memory-v2/memory-v2.ts`** 新增 SQLite `kv_store` 表：

```sql
CREATE TABLE kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER  -- NULL = no expiry
);
```

- `kvGet(chatId, key)` — 查询，自动过期检查
- `kvSet(chatId, key, value, ttlSeconds?)` — 写入，可选 TTL（Unix timestamp）
- `kvDel(chatId, key)` — 删除
- `kvKeys(chatId, prefix?)` — 列出键（可按前缀过滤）

KV 数据隔离：按 `chat_id` 前缀隔离，不同 chat 互不可见。

---

## 八、P2-10：Shell 增强

### 变更

**`src/sandbox/sandbox.ts`** — PTY shell 启动参数修改：

- `bash --norc --noprofile` → `bash --rcfile <generated-bashrc>`
- 自动生成 `.bashrc` 内容：
  - `PATH` 追加 `workspace/skills/node_modules/.bin`（若目录存在）
  - 有用的 aliases：`ll`, `la`, `..`, `...`，以及 `node`, `npm`, `npx`, `git`, `python3`, `pip3`, `tsx` 路径确认

**`src/subagent/fast-path-handler.ts`** — 修复 shell 初始化相关的小问题。

---

## 九、P2-12：HTTP Webhook 模块

### API

**`src/sandbox/modules/http.ts`** + **`src/sandbox/modules/shared/http.d.ts`**（新建）

```typescript
declare const http: {
    onWebhook(path: string, handlerCode: string): string;  // returns webhookId
    removeWebhook(path: string): void;
    listWebhooks(): Array<{ path: string; id: string }>;
};
```

注册的路径映射到 Host 的 `POST /webhook/<chatId>/<path>`。

### 实现层

**`src/sandbox/sandbox.ts`**

- `registerWebhook(path, handlerCode)` — 注册 webhook，持久化到 `workspace/<chatId>/webhooks.json`
- `removeWebhook(path)` + `listWebhooks()`
- `handleWebhookRequest(path, body, headers)` — Host 收到请求后调用，在 sandbox 中执行 handlerCode，payload 通过 `__webhookPayload` 注入

**`src/dashboard/api-routes.ts`**（新增端点）

```
POST /webhook/:chatId/:path   → 路由到对应 sandbox.handleWebhookRequest()
```

**`src/dashboard/dashboard-server.ts`** — 注册 webhook 路由，支持任意 `Content-Type`（JSON/form/raw）。

---

## 变更文件总览

| 文件 | 类型 | 涉及功能 |
|:-----|:-----|:---------|
| `src/sandbox/modules/mcp-bridge.ts` | 新建 | MCP Bridge |
| `src/sandbox/modules/shared/mcp-bridge.d.ts` | 新建 | MCP Bridge |
| `src/sandbox/modules/cron.ts` | 新建 | Cron API |
| `src/sandbox/modules/shared/cron.d.ts` | 新建 | Cron API |
| `src/sandbox/modules/events.ts` | 新建 | Events API |
| `src/sandbox/modules/shared/events.d.ts` | 新建 | Events API |
| `src/sandbox/modules/kv.ts` | 新建 | KV Store |
| `src/sandbox/modules/shared/kv.d.ts` | 新建 | KV Store |
| `src/sandbox/modules/http.ts` | 新建 | HTTP Webhook |
| `src/sandbox/modules/shared/http.d.ts` | 新建 | HTTP Webhook |
| `src/core/cron-matcher.ts` | 新建 | Cron API |
| `src/dashboard/ui/src/panels/McpPanel.svelte` | 新建 | MCP Dashboard |
| `workspace/agent-docs/mcp-guide.md` | 新建 | MCP 文档 |
| `tests/mcp-bridge.test.ts` | 新建 | MCP 测试 |
| `tests/agent-skills-support.test.ts` | 新建 | SKILL.md 测试 |
| `src/sandbox/modules/mcp-bridge.ts` | 修改 | Streamable HTTP |
| `src/sandbox/modules/runtime.ts` | 修改 | P2-8 持久化 |
| `src/sandbox/modules/runtime.d.ts` | 修改 | P2-8 新 API |
| `src/sandbox/background-manager.ts` | 修改 | P2-8 重构 |
| `src/sandbox/sandbox.ts` | 修改 | Events/Webhook/Shell/MCP |
| `src/sandbox/sandbox-worker.ts` | 修改 | 注入新模块 |
| `src/sandbox/sandbox-pool.ts` | 修改 | `entries()` |
| `src/sandbox/session-runner.ts` | 修改 | 动态 prefixMap |
| `src/sandbox/skill-loader.ts` | 修改 | SKILL.md WARN 修复 |
| `src/sandbox/api-intent-extractor.ts` | 修改 | TRIVIAL_CALLS |
| `src/sandbox/modules/docs.ts` | 修改 | SKILL.md API briefs |
| `src/sandbox/modules/modules-docs.json` | 修改 | 重生成 |
| `src/sandbox/modules/brief-overview.md` | 修改 | 重生成 |
| `src/subagent/code-act-executor.ts` | 修改 | 动态 registry + SKILL.md |
| `src/subagent/types.ts` | 修改 | twoPassConfig getPrefixMap |
| `src/main-agent/global-state.ts` | 修改 | sandbox-cron 类型 |
| `src/main.ts` | 修改 | hostCallHandler 路由 + Cron 轮询 |
| `src/core/config.ts` | 修改 | McpServerConfig / mcpServers |
| `src/memory-v2/memory-v2.ts` | 修改 | kv_store 表 |
| `src/dashboard/api-routes.ts` | 修改 | MCP + Webhook 端点 |
| `src/dashboard/dashboard-server.ts` | 修改 | Webhook 路由 |
| `src/dashboard/ui/src/App.svelte` | 修改 | MCP 标签页 |
| `src/dashboard/ui/src/components/TabNav.svelte` | 修改 | MCP 导航项 |
| `src/subagent/fast-path-handler.ts` | 修改 | Shell 初始化 |
| `system-prompts/executor/subagent-execution.md` | 修改 | 自主能力段落 |
| `config.example.yaml` | 修改 | mcpServers 示例 |
