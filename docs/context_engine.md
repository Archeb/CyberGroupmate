# Context Engine：结构化 Prompt 组装系统

## 核心哲学

**结构化数据 = source of truth，自然语言 = 视图层。**

```
数据提供者(typed objects) → 虚拟上下文树(SectionNode[]) → diff(结构化层) → render(一次性) → ChatMessage[]
```

不在文本层做任何 diff/split/regex。Delta 由数据源模块自己计算。渲染只发生一次，在最末端。

---

## 数据模型

```typescript
// ═══ Section 定义（模板声明） ═══

type CacheStrategy = "static" | "delta" | "snapshot" | "volatile";
type HistoryStrategy = "persistent" | "delta-only" | "ephemeral" | "omit";

interface SectionSchema {
    name: string;
    label: string;           // Dashboard 显示名
    source: string;          // 数据来源描述（文档用途）
    cache: CacheStrategy;
    history: HistoryStrategy;
}

// ═══ 数据提供者（每个 section 一个） ═══

interface SectionProvider<T = unknown> {
    schema: SectionSchema;
    /** 从上下文中提取结构化数据 */
    resolve(ctx: ResolveContext): T | null;
    /** 在结构化层计算增量（仅 cache="delta" 需要实现） */
    diff?(current: T, committed: T | null): { full: T; delta: T; stats: DeltaStats };
    /** 渲染完整数据为自然语言 */
    render(data: T): string;
    /** 渲染增量数据为自然语言（history="delta-only" 时用） */
    renderDelta?(delta: T): string;
    /** 计算数据的 identity hash（用于 static cache 比较） */
    hash?(data: T): string;
}

interface DeltaStats { total: number; added: number; unchanged: number }

// ═══ 虚拟上下文树（一次 attend/task 的完整快照） ═══

interface SectionNode {
    schema: SectionSchema;
    data: unknown;              // 结构化数据（source of truth）
    fullRendered: string;       // 完整渲染文本（发给 LLM）
    historicalRendered: string | null; // 存入历史的文本（可能是 delta/omit/null）
    changed: boolean;
    deltaStats?: DeltaStats;
    skipped: boolean;           // condition 不满足时跳过
}

type ContextTree = SectionNode[];

// ═══ 已提交状态（Ledger） ═══

interface CommittedSection {
    data: unknown;      // 上次提交的结构化数据
    hash: string;
    committedAt: number;
}

// Ledger = Map<sectionName, CommittedSection>

// ═══ 渲染产物 ═══

interface RenderResult {
    /** 进入历史的内容 */
    historicalContent: string;
    /** 仅当前请求的内容（拼在同一条 user message 末尾） */
    ephemeralContent: string;
    /** Dashboard 可视化数据 */
    manifest: ContextManifest;
    /** 虚拟树快照（供 commit 用） */
    tree: ContextTree;
}

interface ContextManifest {
    timestamp: string;
    chatId?: string;
    sections: Array<{
        name: string; label: string; source: string;
        cache: string; history: string;
        renderedChars: number; estimatedTokens: number;
        changed: boolean; skipped: boolean;
        deltaStats?: DeltaStats;
        contentPreview: string;
    }>;
    summary: {
        totalTokens: number;
        historicalTokens: number;
        ephemeralTokens: number;
    };
}
```

---

## ContextEngine 核心流程

```typescript
class ContextEngine {
    private ledger = new Map<string, CommittedSection>();
    private providers: SectionProvider[] = [];

    /** 注册数据提供者（有序，决定渲染顺序） */
    register(provider: SectionProvider): void;

    /** 渲染一次完整的上下文 */
    render(ctx: ResolveContext): RenderResult {
        const tree: ContextTree = [];

        for (const provider of this.providers) {
            // 1. resolve: 获取结构化数据
            const data = provider.resolve(ctx);
            if (data == null) { tree.push(skippedNode(provider)); continue; }

            // 2. diff: 在结构化层比较（非文本层）
            const committed = this.ledger.get(provider.schema.name);
            let sendData = data;
            let deltaData = data;
            let changed = true;
            let deltaStats: DeltaStats | undefined;

            switch (provider.schema.cache) {
                case "static": {
                    const h = provider.hash?.(data) ?? JSON.stringify(data);
                    changed = h !== committed?.hash;
                    break;
                }
                case "delta": {
                    const result = provider.diff!(data, committed?.data ?? null);
                    deltaData = result.delta;
                    deltaStats = result.stats;
                    changed = result.stats.added > 0;
                    break;
                }
                // snapshot/volatile: always changed, send full
            }

            // 3. render: 结构化数据 → 自然语言（一次性，视图层）
            const fullRendered = provider.render(data);
            let historicalRendered: string | null = null;

            switch (provider.schema.history) {
                case "persistent": historicalRendered = fullRendered; break;
                case "delta-only": historicalRendered = changed ? provider.renderDelta!(deltaData) : null; break;
                case "omit":       historicalRendered = `[${provider.schema.label}: 见最新版本]`; break;
                case "ephemeral":  historicalRendered = null; break;
            }

            tree.push({ schema: provider.schema, data, fullRendered, historicalRendered, changed, deltaStats, skipped: false });
        }

        // 4. 组装最终文本
        return this.assemble(tree);
    }

    /** LLM 调用成功后，提交当前树到 ledger */
    commit(tree: ContextTree): void {
        for (const node of tree) {
            if (node.skipped) continue;
            this.ledger.set(node.schema.name, {
                data: node.data,
                hash: JSON.stringify(node.data), // 或 provider.hash
                committedAt: Date.now(),
            });
        }
    }

    /** Compaction 后重置 */
    reset(): void { this.ledger.clear(); }

    /** 组装：persistent 拼在一起，ephemeral 拼在一起 */
    private assemble(tree: ContextTree): RenderResult {
        const historicalParts: string[] = [];
        const ephemeralParts: string[] = [];

        for (const node of tree) {
            if (node.skipped || !node.fullRendered) continue;
            if (node.schema.history === "ephemeral") {
                ephemeralParts.push(node.fullRendered);
            } else {
                // 发给 LLM 用 fullRendered，存历史用 historicalRendered
            }
        }

        // 发给 LLM 的当前轮内容 = 所有 section 的 fullRendered（有序拼接）
        // 存历史的内容 = persistent/delta-only/omit 的 historicalRendered
        // ephemeral 的 fullRendered 拼在同一条 user message 末尾

        return {
            historicalContent: historicalParts.join("\n\n"),
            ephemeralContent: ephemeralParts.join("\n\n"),
            manifest: this.buildManifest(tree),
            tree,
        };
    }
}
```

---

## 数据提供者示例

### 聊天消息（delta provider，数据源模块自己处理增量）

```typescript
// 数据源模块知道自己的数据结构，自己处理 diff
const messagesProvider: SectionProvider<RawMessage[]> = {
    schema: { name: "messages", label: "聊天消息", source: "memory.recentMessages", cache: "delta", history: "delta-only" },

    resolve(ctx) { return ctx.rawMessages; },

    diff(current, committed) {
        // committed 是上次的 RawMessage[]，在结构化层按 message ID 做 diff
        const committedIds = new Set((committed ?? []).map(m => m.id));
        const delta = current.filter(m => !committedIds.has(m.id));
        return {
            full: current,
            delta,
            stats: { total: current.length, added: delta.length, unchanged: current.length - delta.length },
        };
    },

    render(messages) {
        return messages.map(m => formatMessageLine(m, { includeMediaTags: true })).join("\n");
    },

    renderDelta(delta) {
        if (delta.length === 0) return "(无新消息)";
        return `(增量: ${delta.length} 条新消息)\n` + this.render(delta);
    },
};
```

### 人物画像（delta provider）

```typescript
const profilesProvider: SectionProvider<ActiveUserProfile[]> = {
    schema: { name: "active_persons", label: "活跃参与者", source: "memory.profiles", cache: "delta", history: "delta-only" },

    resolve(ctx) { return ctx.activeUserProfiles; },

    diff(current, committed) {
        // 按 userId diff，画像内容变化也算 delta
        const committedMap = new Map((committed ?? []).map(p => [p.userId, JSON.stringify(p)]));
        const delta = current.filter(p => committedMap.get(p.userId) !== JSON.stringify(p));
        return {
            full: current, delta,
            stats: { total: current.length, added: delta.length, unchanged: current.length - delta.length },
        };
    },

    render(profiles) { return profiles.map(formatProfile).join("\n"); },
    renderDelta(delta) { return delta.map(formatProfile).join("\n"); },
};
```

### 群组画像（static provider）

```typescript
const groupModelProvider: SectionProvider<GroupModel> = {
    schema: { name: "group_model", label: "聊天画像", source: "memory.groupModel", cache: "static", history: "omit" },
    resolve(ctx) { return ctx.groupModel ?? null; },
    render(model) { return `- 标题: ${model.chatTitle}\n- 描述: ${model.description}\n...`; },
    hash(model) { return `${model.chatTitle}:${model.description}:${model.updatedAt}`; },
};
```

### 全局状态（snapshot, ephemeral）

```typescript
const globalStateProvider: SectionProvider<{ summary: string; decisions: string; tasks: string }> = {
    schema: { name: "global_state", label: "全局状态", source: "globalState", cache: "snapshot", history: "ephemeral" },
    resolve(ctx) { return { summary: ctx.attentionSummary, decisions: ctx.recentDecisions, tasks: ctx.activeTasks }; },
    render(data) { return `## 全局状态快照\n${data.summary}\n\n## 最近决策记录\n${data.decisions}\n\n## 当前任务列表\n${data.tasks}`; },
};
```

---

## 模板的新角色

`.md` 模板文件不再包含 `{{variable}}` 占位符。它们变成**纯静态文本 section**（指令、规则、示例）。所有动态内容由 providers 提供。

模板仍然存在，用于：
1. system prompt 中的**静态指令**（规则、示例、输出格式）
2. 作为一种**可热重载的静态文本 provider**

```typescript
// 静态模板变成一种特殊 provider
function staticTemplateProvider(name: string, label: string, templatePath: string, vars?: Record<string, string>): SectionProvider<string> {
    return {
        schema: { name, label, source: `template:${templatePath}`, cache: "static", history: "ephemeral" },
        resolve() {
            let content = loadPromptFile(templatePath) ?? "";
            // 仅支持简单的固定变量替换（persona name 等）
            if (vars) for (const [k, v] of Object.entries(vars)) content = content.replaceAll(`{{${k}}}`, v);
            return content;
        },
        render(text) { return text; },
        hash(text) { return String(text.length); },
    };
}
```

---

## 调用点改造清单

### 1. attend-handler.ts（主 Agent 决策）

**当前**：手动 `buildAttentionVariables` → `renderPrompt("ATTENTION")` → 手动 `buildHistoricalAttendEntry` → 手动分离

**改为**：

```typescript
// MainAgentLoop 持有一个 attendEngine
const engine = mainLoop.attendEngine; // ContextEngine 实例

// 注册 providers（初始化时一次）
engine.register(headerProvider);        // volatile, persistent
engine.register(globalStateProvider);   // snapshot, ephemeral
engine.register(attendMetaProvider);    // volatile, persistent
engine.register(topicDigestsProvider);  // snapshot, ephemeral
engine.register(messagesProvider);      // delta, delta-only
engine.register(callbacksProvider);     // snapshot, ephemeral
engine.register(groupModelProvider);    // static, omit
engine.register(profilesProvider);      // delta, delta-only
engine.register(schedulerProvider);     // volatile, persistent
engine.register(dispatchGuardProvider); // volatile, ephemeral
engine.register(decisionPromptProvider); // static, ephemeral

// 每次 attend
const result = engine.render(resolveContext);
const currentTurnContent = result.historicalContent
    + (result.ephemeralContent ? "\n\n---\n\n" + result.ephemeralContent : "");

const messages = [
    { role: "system", content: mainSystemPrompt },
    ...history,
    { role: "user", content: currentTurnContent },
];

// LLM 调用...

// 成功后
engine.commit(result.tree);
await mainLoop.appendToHistory({ role: "user", content: result.historicalContent });
await mainLoop.appendToHistory({ role: "assistant", content: llmResponse });

// 广播 manifest
eventBridge.broadcast({ type: "context:manifest", data: result.manifest });
```

### 2. code-act-executor.ts（Executor 任务）

**当前**：手动 `renderPrompt("EXECUTION")` + `renderPrompt("EXECUTION_TASK")` + `stripVerboseSections`

**改为**：每个 CodeActExecutor 持有自己的 `ContextEngine`。task prompt 的动态数据通过 providers 提供。`stripVerboseSections` 不再需要——`executor.topicSummary` 和 `executor.memoryContext` 改为 `history="ephemeral"`，只在当前任务可见；`executor.personContext` 和 `executor.targetMessages` 改为 `cache="delta" + history="delta-only"`，只把新增或变化部分写入 session 历史，而不是每轮重复塞整块或显示 `见最新版本` 占位符。

### 3. main-agent-loop.ts（Callback 渲染）

**当前**：`renderPrompt("CALLBACK", buildCallbackVariables(cb))`

**改为**：`callbackProvider.resolve(cb)` → `callbackProvider.render(data)`。简单场景不需要 diff，直接 render。

### 4. recording-pipeline.ts（聚类/Triage）

**当前**：`renderPrompt("TOPIC_CLUSTERING"/"TOPIC_TRIAGE", vars)`

**改为**：同样改为 provider 模式。这些是一次性调用（无历史积累），provider 全部 `cache="volatile"` + `history="ephemeral"`。

### 5. grounding-util.ts

**当前**：`renderPrompt("GROUNDING", { sanitizedText })`

**改为**：简单 provider，volatile/ephemeral。

### 6. mainagent-main-system.md (system prompt)

主要是静态指令 + persona + skills roster。改为：
- 静态指令部分 → `staticTemplateProvider`
- persona → volatile provider（支持热重载）
- skills roster → snapshot provider

---

## 新文件

| 文件 | 说明 |
|:-----|:-----|
| `src/context-engine/types.ts` | 所有类型定义 |
| `src/context-engine/context-engine.ts` | ContextEngine 核心逻辑 |
| `src/context-engine/context-ledger.ts` | CommittedSection 状态管理 |
| `src/context-engine/providers/attend-providers.ts` | Main Agent attend 层所有 providers |
| `src/context-engine/providers/executor-providers.ts` | Executor 层所有 providers |
| `src/context-engine/providers/pipeline-providers.ts` | Recording pipeline providers |
| `src/context-engine/providers/common.ts` | 通用 providers（static template, persona 等） |

## 修改文件

| 文件 | 变更 |
|:-----|:-----|
| `src/main-agent/attend-handler.ts` | 用 ContextEngine 替代全部手动拼装 |
| `src/main-agent/main-agent-loop.ts` | 持有 attendEngine，compaction 后 reset |
| `src/main-agent/prompt-renderer.ts` | 精简为仅保留 `loadTemplate`，移除 `buildAttentionVariables` 等 |
| `src/subagent/code-act-executor.ts` | 用 ContextEngine 替代手动渲染 |
| `src/pipeline/recording-pipeline.ts` | 用 provider 替代 renderPrompt |
| `src/main-agent/grounding-util.ts` | 用 provider 替代 renderPrompt |
| `src/core/llm/types.ts` | scope 类型无需改，现有 `scope?: string` 够用 |
| `src/dashboard/event-bridge.ts` | 广播 `context:manifest` |

---

## Open Questions

> [!IMPORTANT]
> **Provider 注册的位置**：providers 需要访问 `memory`、`globalState`、`subagentManager` 等依赖。
> 方案 A：providers 在 `main.ts` 初始化时注册，通过闭包捕获依赖
> 方案 B：`ResolveContext` 携带所有依赖，providers 是纯函数
> 倾向 B（更可测试），你的看法？

> [!IMPORTANT]
> **实施顺序**：
> Phase 1: types + engine + ledger（纯新代码）
> Phase 2: attend providers + attend-handler 改造
> Phase 3: executor providers + code-act-executor 改造
> Phase 4: pipeline/grounding providers
> Phase 5: Dashboard manifest 可视化

## Verification Plan

- 单元测试：engine render/commit/reset，delta diff 逻辑
- 集成：对比改造前后 LLM 调用的 token 用量
- Dashboard：验证 manifest 事件正确广播
- Anthropic cache：验证 cachedTokens 提升
