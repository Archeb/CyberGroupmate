# Background Agent 实施计划

> 基于 RFC `docs/background-agent.md`，结合现有代码基础设施制定。

---

## 现有基础设施

实施前先摸清楚我们已经有什么，避免重复造轮子：

| 组件 | 现状 | 位置 |
|---|---|---|
| Meta API（dispatch/todo/memory/agents/cron） | ✅ 已有完整实现 | `src/meta-sandbox/meta-api/` |
| BackgroundManager（进程生命周期） | ✅ 已有，支持 spawn/kill/persist | `src/sandbox/background-manager.ts` |
| Proactive Idle 触发逻辑 | ✅ 已有，可 hook | `src/main-agent/main-agent-loop.ts:249-264` |
| Reflection 执行 + 输出 | ✅ 已有，可在输出阶段追加逻辑 | `src/memory-v2/reflection.ts:586-614` |
| GlobalState 持久化 | ✅ 已有 | `src/main-agent/global-state.ts` |
| MCP Client（连接外部 MCP server） | ✅ 已有 | `src/sandbox/modules/mcp-bridge/` |
| **MCP Server（暴露内部 API）** | ✅ M1 已完成，23 tools（含 notify/skills/scheduler/todo/conversation/memory/agents/digest） | `src/mcp-server/` |
| **notify 工具** | ✅ 已实现，支持 to: "meta"（注入 attention item）和 bindingId（dispatch） | `src/mcp-server/tools/notify.ts` |
| **sandbox_call（sandbox 代码执行）** | ❌ 需要新建，传入 JS 代码在 sandbox 中执行平台 API 和 skill | `src/mcp-server/tools/platform.ts` |
| **HarnessManager（外部 harness 管理）** | ❌ 不存在，需要新建 | `src/harness/` |

---

## Phase 0: notify 工具 ✅ 已完成

已在 MCP server 中实现。`notify(to: "meta")` 注入 BACKGROUND_AGENT attention item 唤醒 Meta Agent；`notify(to: bindingId)` 通过 `dispatch.taskToGroup` 派发任务给 subagent。

---

## Phase 1: MCP Server ✅ M1 已完成

23 个 tools 已注册并验证：conversation（3）、memory（3）、agents（1）、notify（1）、skills（4）、todo（4）、scheduler（6）、digest（1）。

Streamable HTTP transport，token 认证，端口冲突优雅降级，连接信息写入 `workspace/mcp-server-info.json`。

---

## Phase 1.5: sandbox_call（sandbox 代码执行）

**目标**：让 Background Agent 能通过 MCP 在 sandbox 中执行 JS 代码，访问平台 API 和 skill。

**这是 M1 到 M2 之间的关键路径。** 没有 sandbox_call，Background Agent 无法完成 RFC §7.2 自操作类任务。

### 设计

平台 API 庞大，不为每个操作维护 MCP tool 映射。一个 `sandbox_call` 工具传入 JS 代码在 sandbox 中执行，支持多步链式调用。

```typescript
// src/mcp-server/tools/platform.ts
mcp.tool("sandbox_call", {
  code: z.string().describe("JS code to execute in sandbox with platform modules"),
}, async ({ code }) => {
  const sandbox = await deps.sandboxPool.acquire("__background__");
  try {
    const result = await sandbox.eval(code);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } finally {
    deps.sandboxPool.release("__background__");
  }
});
```

API 发现不走 MCP，走文件系统——Background Agent 在 Claude Code 中直接读 `src/sandbox/modules/brief-overview.md` 获取全部模块概览，需要详细签名时读 `.d.ts` 和 guide markdown。固定层 prompt 中指引这一路径。

### 关键设计点

- **专用 sandbox**：`__background__` chatId，与群聊 sandbox 隔离
- **复用现有机制**：sandbox 通过 `onAcquire` 挂载 adapter host call handler，mtcute passthrough、guide 体系全部天然可用
- **写限制 allowlist**（`__background__` 没有绑定聊天）：
  - ✅ 平台级自操作（accountProfile 组：改头像/bio/签名/emoji status 等）
  - ✅ Stories 操作（发/删/编辑 story）
  - ⛔ 发消息方法（`sendText`/`sendMedia`/`sendMediaGroup` 等，走 notify）
  - ⛔ 管理操作（kickUser/banUser/deleteMessages/改群设置）
- **常用流程沉淀为 skill**：高频操作写成 skill，Background Agent 直接调用

### 改动点

1. **新建 `src/mcp-server/tools/platform.ts`**：注册 `sandbox_call` tool
2. **修改 `src/mcp-server/index.ts`**：注册 platform tools
3. **写限制 allowlist**：在 adapter 层为 `__background__` chatId 实现方法白名单

### 预计工作量

1-2 天（sandbox 基础设施已有，主要是 allowlist 和测试）

### 验证

用 Claude Code 连上 MCP server，执行 `sandbox_call({ code: "return await telegram.getMe()" })` 确认 sandbox 能正常调用平台 API。

---

## Phase 2: HarnessManager

**目标**：管理 Background Agent 外部进程的生命周期。

### 新建 `src/harness/`

```
src/harness/
├─ manager.ts         — HarnessManager 类
├─ launchers/
│   ├─ claude-code.ts — Claude Code 启动逻辑
│   ├─ codex-cli.ts — Codex CLI 启动逻辑
│   └─ copilot-cli.ts — Copilot CLI 启动逻辑（Phase 4）
├─ types.ts           — 接口定义
└─ prompt.ts          — 固定层 prompt 生成
```

### HarnessManager 核心

```typescript
class HarnessManager {
  private state: { running: boolean; pid?: number; pendingQueue: Notify[] };

  enqueue(notify: Notify): void {
    if (!this.state.running) this.launch();
    else this.state.pendingQueue.push(notify);
  }

  private async launch(): Promise<void> {
    const systemPrompt = buildSystemPrompt(this.config);
    const prompt = buildTaskPrompt(this.config);
    const pending = this.drainQueue();
    const process = await this.launcher.start({ prompt, systemPrompt, pending, mcpUrl, authToken });
    this.state = { running: true, pid: process.pid, pendingQueue: [] };
    process.on('exit', () => this.onComplete());
  }

  private onComplete(): void {
    this.state.running = false;
    if (this.state.pendingQueue.length > 0) this.launch();
  }
}
```

### Claude Code Launcher

```typescript
// src/harness/launchers/claude-code.ts
async function start({ prompt, pending, mcpUrl, authToken }): Promise<ChildProcess> {
  const pendingJson = JSON.stringify(pending);
  const fullPrompt = `${prompt}\n\n## 待处理任务\n${pendingJson}`;
  return spawn('claude', [
    '-p', fullPrompt,
    '--mcp-config', generateMcpConfig(mcpUrl, authToken)
  ]);
}
```

### 定时触发（做梦模式）

在 `src/main.ts` 的 scheduler 里注册一个内置 cron：

```typescript
// 凌晨 3 点触发做梦
scheduler.registerBuiltinCron('background-dreaming', config.backgroundAgent?.schedule ?? '0 3 * * *', () => {
  harnessManager.enqueue({ to: 'background', content: 'scheduled-dreaming', type: 'scheduled' });
});
```

**预计工作量**：2-3 天

**验证**：手动调用 `harnessManager.enqueue()`，观察 Claude Code 进程启动、连接 MCP、执行任务、退出。

---

## Phase 3: 系统集成 ✅ 已完成

**目标**：把 HarnessManager 接入 Proactive Idle 和 Reflection。

### 3.1 Proactive Idle 集成 ✅

不需要改 idle 触发逻辑本身——Meta Agent 在 idle turn 中如果发现重活，会调 notify，notify 的实现通过 attention queue 触发 HarnessManager。notify tool 已在 Meta Agent 的 tool list 里。

### 3.2 Proactive Idle Prompt 缩限 ✅

**文件**：`system-prompts/meta-agent/proactive-idle.md`

"自主进化"部分已改为"自主进化（移交 Background Agent）"：
- 发现新技巧 → notify 给 Background Agent
- 不自己让 subagent 写 skill，交给 Background
- 重活（写 skill、研究新技术、深入查资料）→ notify 描述任务

### 3.3 Reflection 集成 ✅

**文件**：`src/memory-v2/reflection.ts`

在 Step 6（agent-state 更新）之后追加 Step 7：从 reflection 的 `insights`、`followupCandidates`、`agentFeedback` 提取方向感，追加写入 `workspace/background-dreaming.md`。文件自动截断到 4000 字符以内，最新内容在最前面。

### 3.4 Dream Journal 目录 ✅

`workspace/dream-journal/` 在 `ensureDataDirs()` 中创建。固定层 prompt 已指引 Background Agent 写日记到此目录。

---

## Phase 4: 额外 Harness + 打磨 ✅ 已完成

### 4.1 Copilot CLI Launcher ✅

新建 `src/harness/launchers/copilot-cli.ts`，实现 `HarnessLauncher` 接口。
- 使用 `copilot -p` 非交互模式
- `--yolo` 全权限（等价于 Claude Code 的 `--dangerously-skip-permissions`）
- `--additional-mcp-config @<path>` 注入 MCP 配置
- `--output-format json` 输出 JSONL
- 支持 `--model` 和自定义 `extraArgs`

### 4.2 配置扩展 ✅

`backgroundAgent` 配置增加：
- `harness`: `"claude-code" | "codex" | "copilot"` 三种 harness 支持
- `codexPath`: Codex CLI 路径
- `copilotPath`: Copilot CLI 路径
- `harnessModel`: 通用模型名称（兼容旧 `claudeModel`）
- `extraArgs`: 自定义启动参数（字符串数组）

### 4.3 Dashboard ✅

- 状态面板：显示当前 harness 类型
- 设置面板：harness 选择（Claude Code / Codex CLI / Copilot CLI）、模型输入、路径配置、自定义启动参数

**预计工作量**：2-3 天

---

## 总览

```
Phase 0: notify 工具                    ✅ 已完成
Phase 1: MCP Server                     ✅ M1 已完成
Phase 1.5: sandbox_call（sandbox 执行）  ✅ 已完成
Phase 2: HarnessManager                 ✅ 已完成
Phase 3: 系统集成（idle/reflection）     ✅ 已完成
Phase 4: 额外 Harness + 打磨            ✅ 已完成
```

---

## 里程碑

| 里程碑 | 标志 | 状态 |
|---|---|---|
| M0: notify 可用 | Meta Agent 能通过 notify 通信 | ✅ |
| M1: MCP 连通 | Claude Code 能连上 MCP server 并读到 digest | ✅ |
| M1.5: sandbox 执行 | Background Agent 能通过 sandbox_call 执行平台 API | ✅ |
| M2: 首次做梦 | Background Agent 被手动拉起，执行一个完整任务并通过 notify 回传结果 | ✅ |
| M3: 自动做梦 | 凌晨 3 点自动拉起，第二天早上有成果 | ✅ |
| M4: 多 Harness | Claude Code、Codex CLI 和 Copilot CLI 都能跑 | ✅ |
