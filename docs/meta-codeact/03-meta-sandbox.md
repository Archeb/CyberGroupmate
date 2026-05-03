# Phase 3: Meta Sandbox + Meta API + Meta Session Runner

## 目标

构建 Meta-CodeAct 的核心执行引擎：进程内 vm 沙盒、6 个 Meta API 模块、LLM 多轮交互 runner。

## 新建文件结构

```
src/meta-sandbox/
  meta-sandbox.ts          # vm.runInNewContext 执行环境
  meta-session-runner.ts   # LLM 多轮交互循环
  meta-api/
    conversations.ts       # 跨群消息/话题检索
    memory.ts              # 跨群身份/事实检索
    agents.ts              # 下属 Subagent 状态
    dispatch.ts            # 编排委派（含自动 Grounding）
    memo.ts                # 跨会话备忘录
    schedule.ts            # 主动调度
    index.ts               # 汇总导出，构建 vm context 对象
```

---

## `meta-sandbox.ts` — 进程内执行环境

```typescript
import { createContext, runInNewContext, Script } from 'node:vm';

class MetaSandbox {
  private context: vm.Context;

  constructor(apiContext: Record<string, unknown>) {
    // apiContext 包含 conversations, memory, agents, dispatch, memo, schedule
    // 加上 console（重定向到 logger）和 JSON/Math 等安全全局对象
    this.context = createContext({
      ...apiContext,
      console: { log: ..., warn: ..., error: ... },  // 重定向到 createLogger("meta-sandbox")
      JSON, Math, Date, Array, Object, Map, Set, Promise,
      setTimeout: undefined,  // 禁用
      setInterval: undefined, // 禁用
    });
  }

  // 执行一段代码，返回输出或错误
  async execute(code: string, timeoutMs = 30000): Promise<{ output: string; error: boolean }> {
    try {
      const script = new Script(code, { filename: 'meta-agent.js' });
      // 注意：vm.runInNewContext 不支持 await，需要包装
      // 方案：将代码包装为 async IIFE，获取返回的 Promise
      const wrappedCode = `(async () => { ${code} })()`;
      const wrappedScript = new Script(wrappedCode, { filename: 'meta-agent.js' });
      const result = await Promise.race([
        wrappedScript.runInContext(this.context, { timeout: timeoutMs }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Meta sandbox timeout (${timeoutMs}ms)`)), timeoutMs)
        ),
      ]);
      // 收集 console.log 输出
      return { output: String(result ?? '(no output)'), error: false };
    } catch (err) {
      return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, error: true };
    }
  }
}
```

**关键设计**：
- 所有 Meta API 方法都是 `async`，代码包装为 async IIFE 执行
- `setTimeout`/`setInterval` 禁用（Agent 不应自行调度，用 `schedule.wakeOnCondition`）
- 30s 超时保护

---

## `meta-session-runner.ts` — LLM 多轮交互

```typescript
interface MetaSessionConfig {
  maxTurns: number;          // 默认 10
  codeTimeout: number;       // 单次代码执行超时，默认 30000ms
}

interface MetaSessionResult {
  turns: Array<{
    thinking?: string;       // LLM thinking block
    code?: string;           // LLM 生成的代码
    observation?: string;    // 代码执行结果
  }>;
  endReason: 'end_turn' | 'max_turns' | 'error' | 'no_code';
  sessionDigest?: string;    // 从最后一轮 thinking 提取
}

async function runMetaSession(
  messages: ChatMessage[],         // system + user(AttentionSet context)
  sandbox: MetaSandbox,
  llmConfigs: LLMConfig[],         // resolveComponentProfiles("meta")
  config: MetaSessionConfig,
): Promise<MetaSessionResult>
```

**循环逻辑**（类似现有 `session-runner.ts`）：
1. 调 LLM 获取 response（含 thinking + code block）
2. 从 response 中提取代码块（```js ... ```）
3. 如无代码块 → `endReason: 'no_code'`，session 结束
4. 如有 `<end_turn>` 标记 → `endReason: 'end_turn'`，session 结束
5. 在 MetaSandbox 中执行代码 → 获取 observation
6. 将 observation 作为 user message 追加到 messages
7. 重复直到 maxTurns

**Session Digest 提取**（session 结束后）：
```typescript
const lastThinking = result.turns.at(-1)?.thinking ?? '';
const match = lastThinking.match(/\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/);
result.sessionDigest = match?.[1]?.trim() ?? compactThinking(lastThinking, 500);
```
`compactThinking`：fallback，取 thinking 最后 500 字符作为摘要。

---

## Meta API 模块

### `conversations.ts`

```typescript
// 依赖：MemoryStoreV2
export function createConversationsApi(memory: MemoryStoreV2) {
  return {
    query: async (filters: {
      chatIds?: string[];
      keywords?: string[];
      userId?: string;
      after?: string;
      before?: string;
      limit?: number;
    }) => {
      const limit = filters.limit ?? 20;
      // 跨群检索：不传 chatId 限制
      const messages = memory.searchMessages(
        filters.keywords?.join(' ') ?? '',
        { chatId: filters.chatIds?.[0], userId: filters.userId,
          after: filters.after, before: filters.before, limit }
      );
      const topics = memory.searchTopics(
        filters.keywords?.join(' ') ?? '',
        { chatId: filters.chatIds?.[0], after: filters.after,
          before: filters.before, limit }
      );
      return { messages, topics };
    }
  };
}
```

### `memory.ts`

```typescript
export function createMemoryApi(memory: MemoryStoreV2) {
  return {
    searchEntities: async (query: string, options?: {
      scope?: 'facts' | 'identities' | 'all';
      limit?: number;
    }) => {
      const limit = options?.limit ?? 10;
      const scope = options?.scope ?? 'all';
      const facts = scope !== 'identities'
        ? memory.searchFacts(query, { limit })
        : [];
      // identities: 搜索所有 person_identities
      const identities = scope !== 'facts'
        ? memory.searchPersonIdentities(query, limit)  // 需确认此方法是否存在，若无则用 searchFacts subject 过滤
        : [];
      return { facts, identities };
    }
  };
}
```

### `agents.ts`

```typescript
export function createAgentsApi(subagentManager: SubagentManager) {
  return {
    listStatus: async () => {
      return subagentManager.getAllSubagents().map(sub => ({
        chatId: sub.chatId,
        chatTitle: sub.chatTitle,
        queueSize: sub.codeActExecutor?.getQueueSize() ?? 0,
        isProcessing: sub.codeActExecutor?.isProcessing() ?? false,
        lastActiveAt: sub.lastActiveAt,
        stickinessLevel: sub.stickiness?.level ?? 'STRANGER',
      }));
    }
  };
}
```

### `dispatch.ts` — 最核心的编排 API

```typescript
export function createDispatchApi(deps: {
  subagentManager: SubagentManager;
  memory: MemoryStoreV2;
  accumulator: AttentionAccumulator;
  groundingConfig?: GroundingConfig;
}) {
  return {
    taskToGroup: async (chatId: string, taskSpec: {
      contentDirection: string;
      toneGuidance?: string;
      context?: unknown;          // Meta Agent 查好的对象，JSON 序列化后注入
      useSkills?: string[];
    }) => {
      const taskId = randomUUID();
      const sub = deps.subagentManager.getOrCreate(chatId);

      // 自动 Grounding（每次 dispatch 都触发）
      let groundingContext: string | undefined;
      if (deps.groundingConfig?.apiKey) {
        try {
          // 用 contentDirection 作为 Grounding 输入
          groundingContext = await runParallelGrounding(
            deps.groundingConfig,
            taskSpec.contentDirection,
          );
        } catch { /* 非关键路径 */ }
      }

      // 构建 CodeActReplyTask
      // 注意：不构建完整的 GroupContextPackage，Subagent 的
      // CodeActExecutor.refreshTaskMessages() 会自行从 memory 构建最新消息
      const task: CodeActReplyTask = {
        type: 'CODEACT_REPLY',
        chatId,
        taskId,
        decisions: [{
          action: 'REPLY',
          contentDirection: taskSpec.contentDirection,
          toneGuidance: taskSpec.toneGuidance,
          confidence: 1.0,
          reason: 'Meta-CodeAct dispatch',
        }],
        contextSnapshot: {
          depth: 2,
          chatId,
          snapshotTimestamp: new Date().toISOString(),
          topicDigests: [],
          engagementScore: 0,
          groundingContext,
          // Meta Agent 查好的跨群上下文，序列化为字符串注入
          // CodeActExecutor 会将此注入 task prompt
          personContext: taskSpec.context
            ? JSON.stringify(taskSpec.context)
            : undefined,
        },
        replyMode: 'SINGLE',
        useSkills: taskSpec.useSkills,
        createdAt: new Date().toISOString(),
      };

      // 入队 Q4 + block accumulator
      sub.codeActExecutor.enqueue(task);
      deps.accumulator.markActioned(chatId);

      return { taskId };
    }
  };
}
```

**关键**：`contextSnapshot` 是骨架，`recentMessages`/`activeUserProfiles` 等由 `CodeActExecutor.refreshTaskMessages()` 和 `executeWithSandbox()` 在执行时实时构建。Meta Agent 通过 `context` 字段传递跨群信息。

### `memo.ts`

```typescript
export function createMemoApi(globalState: GlobalState) {
  return {
    set: async (key: string, value: unknown, ttlMinutes?: number) => {
      globalState.memoSet(key, value, ttlMinutes);
    },
    get: async (key: string) => globalState.memoGet(key),
    delete: async (key: string) => globalState.memoDelete(key),
    list: async () => globalState.memoList(),
  };
}
```

### `schedule.ts`

```typescript
export function createScheduleApi(globalState: GlobalState) {
  return {
    wakeOnCondition: async (condition: WakeCondition) => {
      const id = globalState.addWakeCondition(condition);
      // delay 类型：内部注册为 reminder
      if (condition.type === 'delay') {
        const triggerAt = new Date(Date.now() + condition.ms).toISOString();
        globalState.addReminder('__meta__', `wake:${id}`, triggerAt);
      }
      return { conditionId: id };
    },
    cancel: async (conditionId: string) => {
      globalState.removeWakeCondition(conditionId);
    },
  };
}
```

### `index.ts` — 汇总

```typescript
export function buildMetaApiContext(deps: {
  memory: MemoryStoreV2;
  subagentManager: SubagentManager;
  globalState: GlobalState;
  accumulator: AttentionAccumulator;
  groundingConfig?: GroundingConfig;
}) {
  return {
    conversations: createConversationsApi(deps.memory),
    memory: createMemoryApi(deps.memory),
    agents: createAgentsApi(deps.subagentManager),
    dispatch: createDispatchApi(deps),
    memo: createMemoApi(deps.globalState),
    schedule: createScheduleApi(deps.globalState),
  };
}
```

---

## 修改文件

### `src/main-agent/main-agent-loop.ts`

tick() Phase 3 实现：

```typescript
if (set) {
  const metaCtx = this.contextEngine.render(resolveCtx);  // 见 04-context-engine.md
  const messages: ChatMessage[] = [
    { role: 'system', content: metaSystemPrompt },
    // 历史 session digests (persistent)
    ...(metaCtx.historicalContent ? [{ role: 'user' as const, content: metaCtx.historicalContent }] : []),
    // 当前 AttentionSet + memos (ephemeral)
    { role: 'user', content: metaCtx.ephemeralContent },
  ];

  const result = await runMetaSession(messages, this.sandbox, metaLlmConfigs, { maxTurns: 10 });

  // 持久化 Session Digest
  if (result.sessionDigest) {
    this.globalState.addSessionDigest(result.sessionDigest);
  }
}
```

### `src/core/config.ts`

- `llmRouting` 类型中 `attend` → `meta`
- `resolveComponentProfiles("attend")` 的所有调用点 → `resolveComponentProfiles("meta")`
- 配置文件示例更新

### `src/main-agent/attend-handler.ts` — **删除**

### `src/main-agent/dispatch-handler.ts` — **删除**

### `src/main-agent/context-builder.ts` — **删除**

### `src/main-agent/cosine-decay.ts` — **删除**

### `src/main.ts`

- 删除 `createAttendHandler`、`createDispatchHandler` 及 `mainLoop.setAttendHandler`/`setDispatchHandler`
- 创建 Meta API context：`buildMetaApiContext({ memory, subagentManager, globalState, accumulator, groundingConfig })`
- 创建 MetaSandbox 实例
- 传入 main-agent-loop

### `src/subagent/code-act-executor.ts`

- 上下文深度改为固定值：从 `loadConfig().subagent?.contextDepth ?? 50` 读取
- 删除 cosine-decay 导入

## 验证

- Meta API 各方法单元测试
- MetaSandbox 执行测试：正常代码、超时、异常、async
- 集成测试：模拟 AttentionSet → LLM 生成 dispatch 代码 → CodeActReplyTask 入队
- `npx tsc --noEmit`
