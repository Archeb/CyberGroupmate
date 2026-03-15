# CyberGroupmate 实现 vs 文档审计报告

> **审计时间**: 2026-03-15
> **入口点**: [src/main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts)
> **对照文档（优先级从高到低）**: 当前代码 → [subagent.md](file:///Users/moss/Projects/CyberGroupmate/docs/subagent.md) → [memory.md](file:///Users/moss/Projects/CyberGroupmate/docs/memory.md) → [Implementation_Plan.md](file:///Users/moss/Projects/CyberGroupmate/docs/Implementation_Plan.md)

---

## 审计方法论

以 [src/main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 为入口，追踪所有 import 和运行时组件初始化流程，与三份文档逐项对照。标注每项差异的类别：

- 🔴 **缺失** — 文档描述但未实现
- 🟡 **差异** — 已实现但与文档描述不一致
- 🟢 **冗余/残留** — 代码中存在但文档未覆盖或已过时的组件
- ✅ **一致** — 实现与文档匹配

---

## 1. 系统架构（主 Agent ↔ Subagent 架构）

### ✅ 已实现且一致

| 组件 | 文档来源 | 实现位置 | 状态 |
|------|---------|---------|------|
| 主 Agent 串行注意力循环 | subagent.md §4.5 | [src/main-agent/main-agent-loop.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts) | ✅ 7 阶段循环匹配 |
| Q1: NotificationCenter | subagent.md §2.1 | [src/event/notification-center.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/notification-center.ts) | ✅ |
| Q3: DynamicAttentionQueue | subagent.md §4.3 | [src/subagent/attention-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/attention-queue.ts) | ✅ |
| Q5: CallbackQueue | subagent.md §2.2 | [src/subagent/callback-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/callback-queue.ts) | ✅ |
| SubagentManager | subagent.md §3.0 | [src/subagent/subagent-manager.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/subagent-manager.ts) | ✅ |
| Observer (per-group) | subagent.md §3.1 | [src/subagent/observer.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts) | ✅ 基本匹配 |
| CodeActExecutor (per-group) | subagent.md §3.2 | [src/subagent/code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts) | ✅ |
| FastPathHandler | subagent.md §3.3 | [src/subagent/fast-path-handler.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/fast-path-handler.ts) | ✅ |
| GroupStickiness 四级亲密度 | subagent.md §8 | [src/subagent/stickiness.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/stickiness.ts) | ✅ |
| Cosine Decay 上下文深度 | subagent.md §7 | [src/main-agent/cosine-decay.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/cosine-decay.ts) | ✅ |
| GlobalState | subagent.md §4.4 | [src/main-agent/global-state.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/global-state.ts) | ✅ |
| MessageLogWriter 实时落盘 | subagent.md §1.1 | [src/event/message-log-writer.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/message-log-writer.ts) | ✅ |
| SandboxPool 多实例 | subagent.md §3.2 | [src/sandbox/sandbox-pool.ts](file:///Users/moss/Projects/CyberGroupmate/src/sandbox/sandbox-pool.ts) | ✅ |
| Prompt 模板系统 (➊-➐) | subagent.md §12 | `system-prompts/subagent-*.md` | ✅ 7 个注入点均有模板 |

---

## 2. 缺失功能 🔴

### 2.1 Observer 内嵌 Recording Pipeline（subagent.md §3.1）

> **文档**: Observer 应内嵌 Recording Pipeline 流程 —— "Q2 Buffer → Recording Pipeline → TopicRegistry 更新 → Engagement 评分"
>
> **现状**: Observer 没有内嵌 Recording Pipeline。在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) L313 有 `TODO [AUDIT]: 将 RecordingPipeline 话题聚类内嵌到 Observer`。当前 Recording Pipeline 作为全局组件通过 `topic:triage-passed` 事件间接与 Observer 通信（L333-357），Observer 的 [TopicDigest](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#16-38) 是由外部 bridge 注入 ([setTopicDigests](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#145-151)) 而非自己产出。

**影响**: Observer 不能独立产出 [TopicDigest](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#16-38) 到 Q3（DIGEST_UPDATE），与 subagent.md 设计不符。当前需要全局 RecordingPipeline 作为中间人。

---

### 2.2 Observer 内部的 `flushBuffer()` / `getMessageSnapshot()` 方法（subagent.md §3.1）

> **文档**: Observer 接口定义了 `flushBuffer(): Promise<void>` 和 `getMessageSnapshot(upTo: number): MessageSnapshot`
>
> **现状**: [observer.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts) 没有实现 `flushBuffer()` 和 `getMessageSnapshot()`。Observer 仅实现了 [onMessage()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#91-124)、[getDigest()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#138-144)、[getEngagementScore()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#125-137)、[checkAlert()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#152-180)、[checkFastPathRequest()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#181-188)。

---

### 2.3 Q2 Inbound Buffer 消费 → Recording Pipeline 链路（subagent.md §2.1）

> **文档**: "Q2 来源: Q1 分发的该群消息 → 消费: Observer 消费 → Recording Pipeline → TopicDigest → 产出到 Q3"
>
> **现状**: Q2 buffer 存在于 Observer 中（`this.buffer`），但仅用于 engagement 计算。没有被 Recording Pipeline 消费。Recording Pipeline 独立监听 NC 事件（通过全局 `topic:triage-passed` bridge）。

---

### 2.4 Q4 Execution Queue 正式化（subagent.md §2.1）

> **文档**: "Q4: 群组 Execution Queue (每个 Subagent 内部)" 作为显式队列存在
>
> **现状**: [src/subagent/execution-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/execution-queue.ts) 文件存在但在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 和 [code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts) 中**未使用**。CodeActExecutor 内部有自己的 `taskQueue: CodeActReplyTask[]`（L138），是内联实现而非使用正式的 ExecutionQueue。

---

### 2.5 GroupContextPackage 完整字段（subagent.md §4.1）

> **文档**: GroupContextPackage 应包含 `chatTitle`、`rawMessages`、`newMessagesSinceLastAttend`、`messageSummary`、`groupModel`、`activePersons`、`playbook`、`lastCallbacks`、`pendingCodeActTasks`、`fastPathEnabled`、`fastPathHistory`、`stickiness`
>
> **现状**: [context-builder.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/context-builder.ts) 和 [types.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts) 中的 [GroupContextPackage](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#201-221) 类型简化了，缺少：
> - `chatTitle` 🔴
> - `rawMessages` / `newMessagesSinceLastAttend` 🔴（L2+ 消息通过 `memory.getRecentMessages()` 在 main.ts 中获取并注入为字符串，而非结构化字段）
> - `messageSummary` 🔴
> - `activePersons: PersonGroupProfile[]` 🔴
> - `playbook: GroupPlaybook | null` 🔴
> - `pendingCodeActTasks` 🔴
> - `fastPathEnabled` / `fastPathHistory` 🔴（FastPath 历史通过 `fpHandler.getSentMessages()` 在 main.ts 中获取并注入为字符串）
> - `stickiness: GroupStickiness` 🔴

---

### 2.6 AttentionQueueEntry 完整字段（subagent.md §2.2）

> **文档**: 应包含 `topicDigest`、`engagementScore`、`urgentSignals`、`fastPathRequested`、`pendingMessageCount`、`snapshotTimestamp`、`lastAttendedAt`、`attendCycle`、`stickiness`
>
> **现状**: 实现的 [AttentionQueueEntry](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#57-87)（types.ts L57-86）缺少：
> - `engagementScore` — 使用 `priority` 替代 🟡
> - `urgentSignals: string[]` 🔴
> - `pendingMessageCount` — 有 `newMessageCount` 🟡 名称不同
> - `snapshotTimestamp` 🔴
> - `attendCycle` — 有 `attendCount` 🟡 名称不同

---

### 2.7 CodeActReplyTask 完整字段（subagent.md §2.2 B1）

> **文档**: 应包含 `targetMessageIds`、`topicId`、`contextSnapshot: { topicSummary, recentMessages, personContext, toneGuidance, contentDirection }`、`replyStrategy`、`maxResponseTime`
>
> **现状**: [types.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts) 中的 [CodeActReplyTask](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#103-118) 缺少：
> - `targetMessageIds: string[]` 🔴
> - `topicId: string`（在 Decision 中有，但 task 层级没有）🟡
> - `replyStrategy: ReplyStrategy` 🔴
> - `maxResponseTime: number` 🔴
>
> 实际的 `contextSnapshot` 是通过 `as any` 在 main.ts dispatch handler 中动态注入额外字段（L662-666），类型不安全。

---

### 2.8 SubagentCallback 字段差异（subagent.md §2.2 C1/C2）

> **文档**: `source: 'CODE_ACT' | 'FAST_PATH'`、`type: 'COMPLETED' | 'FAILED' | 'TIMEOUT'`、`result: { sentMessageIds, replyContent, sessionSummary, tokensUsed, duration }`
>
> **现状**: 实现中 [SubagentCallback](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#130-158) 差异：
> - `source` → 重命名为 `executionType` 🟡
> - `type` → 重命名为 `status`，增加了 `SKIPPED` 值 🟡
> - `result` 被拍平（`sentMessageIds` → `sentMessages`，`duration` → `durationMs`，新增 `error`）🟡
> - 无 `sessionSummary` 字段（在 `summary` 中混合）🟡

---

### 2.9 智能上下文 Compaction（memory.md §2）

> **文档**: 短期记忆管理方案，包含 token 预算、分段式上下文管理（System Prompt → Context Briefing → Recent History → Active Turn）、话题连贯性保护、`js-tiktoken` BPE 精确 token 计算
>
> **现状**: [src/memory-v2/context-manager.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/context-manager.ts) 文件存在（16KB），但**在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 中未被导入或使用**。CodeActExecutor 的 session compaction 使用的是自己的简化逻辑（L565-619），基于消息数量而非 token 预算。没有话题连贯性保护。

---

### 2.10 Embedding + 向量检索（memory.md §4.1）

> **文档**: 使用 `text-embedding-3-small` + `sqlite-vec` 进行向量检索，`recall()` 以向量搜索为核心路径
>
> **现状**: [src/memory-v2/embedding.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/embedding.ts) 存在，实现了纯 JS FNV-1a fallback + OpenAI API 双模式。但实际 `recall()` 是否真正使用向量检索取决于 sqlite-vec 是否已被加载（需要原生扩展）。当前 [memory-v2.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/memory-v2.ts)（74KB）规模庞大，向量检索功能**理论上已实现**，但需要外部依赖 `sqlite-vec` 是否可用。

---

### 2.11 TaskList Skill — Agent 可通过代码管理任务（subagent.md §4.4）

> **文档**: Agent 应能在 CodeAct session 中通过 `skills.taskList.add()` / `update()` / `list()` 等操作 TaskList
>
> **现状**: [GlobalState](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts#332-338) 类有 `addTask()` / `updateTask()` / `listTasks()` 等方法，但这些方法的 **host_call 桥接在 main.ts 中缺失**。sandbox worker 中没有注册 `skills.taskList.*` 的 host call handler。只有 `memory.*`、`actions.*` 和 telegram adapter 的 host call 被注册（main.ts L174-205）。

---

### 2.12 Playbook System（Implementation_Plan.md Phase 7.1）

> **文档**: SOTA 定期分析生成 GroupPlaybook，注入弱模型上下文
>
> **现状**: 完全未实现，仅在文档中标记为 📝 规划中。GroupContextPackage 中也无 playbook 字段。

---

### 2.13 主 Agent 系统 Prompt 中注入 GlobalState + TaskList（subagent.md §12.2 ➋）

> **文档**: 主 Agent 系统 prompt 应包含 `{{globalState}}` 和 `{{taskList}}` 变量注入
>
> **现状**: main.ts L540-553 中的 `mainSystemPrompt` 是硬编码字符串，**没有注入 globalState 和 taskList**。缺少 `## 当前全局状态` 和 `## 当前任务列表` 部分。

---

### 2.14 Decision 输出格式中 `type` 字段（subagent.md §12.2 ➍）

> **文档**: Decision 使用 `type: "CODEACT_REPLY" | "IGNORE" | "FAST_PATH_AUTH"`
>
> **现状**: 实现中使用 `action: "REPLY" | "IGNORE" | "DEFER" | "FAST_PATH_AUTH" | "OBSERVE"`
> - `type` → `action` 🟡
> - `"CODEACT_REPLY"` → `"REPLY"` 🟡
> - 新增 `"DEFER"` 和 `"OBSERVE"` 🟢 （代码超越文档）

---

### 2.15 主 Agent 对话历史 Compact（subagent.md 隐含）

> **文档**: 主 Agent 维护跨轮次对话历史，应有 compact 机制
>
> **现状**: [MainAgentLoop](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts#68-437) 的对话历史仅有简单的数量截断（`maxHistoryMessages: 30`，L348-352），没有使用 LLM compact 或摘要。

---

## 3. 实现与描述差异 🟡

### 3.1 消息分发：NC.onPush 直调 vs GroupDispatcher

> **文档** (subagent.md §2.1): "GroupDispatcher 按 chatId 分发到各 Subagent"
>
> **现状**: [src/event/group-dispatcher.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/group-dispatcher.ts) 存在但**未在 main.ts 中使用**。消息分发通过 `nc.onPush()` 直接 inline 实现（main.ts L287-314），手动调用 `subagentManager.getOrCreate(chatId)` + `sub.observer.onMessage(event)`。

**影响**: 功能等效，但 GroupDispatcher 组件被旁路。

---

### 3.2 FastPath 触发时机

> **文档** (subagent.md §3.3): Observer 检测到触发消息后调用 FastPath `onTriggerMessage()`
>
> **现状**: FastPath 触发在 NC.onPush hook (main.ts L298-311) 中实现，不在 Observer 内部。当新消息到达且 FastPath `isAuthorized()` 时直接调用 `fp.handle(fpEvent)`。

**影响**: 功能等效，但触发点不在文档描述的 Observer 组件内。

---

### 3.3 Recording Pipeline 触发消息到 Q3

> **文档** (subagent.md §2.1): "Observer → Recording Pipeline → TopicDigest → 上报到 Q3"
>
> **现状**: RecordingPipeline 的 `topic:triage-passed` 事件触发后通过 bridge（main.ts L333-357）设置 Observer 的 topicDigests，然后 Observer 构建 queue entry 入 Q3。路径多了一个 bridge 层。

---

### 3.4 Cosine Decay 深度计算输入

> **文档** (subagent.md §7): `getContextDepth()` 接收 [AttentionQueueEntry](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#57-87)，并检查 `urgentSignals` 和 `source` 来决定强制深度
>
> **现状**: [cosine-decay.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/cosine-decay.ts) 的 `calculateDepth()` 只接收 [(attendCount, cyclePeriod)](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts#136-147)，**不会根据 urgentSignals 或 OBSERVER_ALERT 强制提升深度**。这些逻辑缺失。alert 场景下的深度提升在 attend handler 中没有体现。

---

### 3.5 stickiness 字段命名差异

> **文档** (subagent.md §8): `GroupStickiness.familiarity: 'CORE' | 'FAMILIAR' | 'ACQUAINTANCE' | 'STRANGER'`
>
> **现状**: 实现中使用 `GroupStickiness.level` 而非 `familiarity`。其他字段如 `replyFrequency`、`initiativeLevel`、`maxInterventionsPerHour`、`cooldownAfterIntervention`、`feedbackHistory` 等在实现中**完全缺失**。

---

### 3.6 主 Agent 不应直接发消息（subagent.md 核心规则 5）

> **文档** (subagent.md §0): "所有关于'是否回复'和'回复什么内容'的决策，只在主 Agent 中发生" + "不亲自回复消息"
>
> **现状**: ✅ 一致。main.ts 中主 Agent 只做决策和分派，不直接调用 `sendText()`。

---

### 3.7 LLM 配置层级使用

> **文档** (subagent.md 各注入点): 不同场景使用不同模型层级（cheap/mid/SOTA）
>
> **现状**:
> - 主 Agent 决策使用 `sotaConfig` ✅
> - FastPath 使用 `cheapConfig` ✅
> - CodeActExecutor 使用 `llmConfig`（= `midConfig`）✅
> - 但 Recording Pipeline triage 使用 `cheapConfig` ✅

---

## 4. 冗余/残留组件 🟢

### 4.1 旧 Pipeline 组件仍在使用

以下 Phase 6/6A 组件在 subagent 架构中的定位不明确，但仍在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 中初始化：

| 组件 | 文件 | main.ts 使用情况 | 分析 |
|------|------|-----------------|------|
| `FastRouter` | [src/pipeline/fast-router.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/fast-router.ts) | ❌ **未导入/未使用** | 🟢 残留 |
| `ReplyPipeline` | [src/pipeline/reply-pipeline.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/reply-pipeline.ts) | ❌ **未导入/未使用** | 🟢 残留 |
| `ContextAssembler` | [src/pipeline/context-assembler.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/context-assembler.ts) | ❌ **未导入/未使用** | 🟢 残留 |
| `ModelRouter` | [src/pipeline/model-router.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/model-router.ts) | ❌ **未导入/未使用** | 🟢 残留 |
| `EngagedTopicHandler` | [src/pipeline/engaged-topic-handler.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/engaged-topic-handler.ts) | ❌ **未导入/未使用** | 🟢 残留 |
| `RecordingPipeline` | [src/pipeline/recording-pipeline.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/recording-pipeline.ts) | ✅ 初始化并使用 | 仍需保留 |
| `TopicRegistry` | [src/pipeline/topic-registry.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/topic-registry.ts) | ✅ 初始化并使用 | 仍需保留 |
| `FeedbackLoop` | [src/pipeline/feedback-loop.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/feedback-loop.ts) | ✅ 初始化并使用 | 仍需保留 |

**结论**: [fast-router.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/fast-router.ts)、[reply-pipeline.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/reply-pipeline.ts)、[context-assembler.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/context-assembler.ts)、[model-router.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/model-router.ts)、[engaged-topic-handler.ts](file:///Users/moss/Projects/CyberGroupmate/src/pipeline/engaged-topic-handler.ts) 是 Phase 6/6A 架构的残留组件，在 subagent 架构中已被新的 Observer + MainAgentLoop 流程替代，但代码仍在项目中。

---

### 4.2 GroupDispatcher 存在但未使用

[src/event/group-dispatcher.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/group-dispatcher.ts)（6.3KB）存在但在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 中**未导入**。消息分发逻辑已内联到 `nc.onPush` hook 中。

---

### 4.3 ExecutionQueue 存在但未使用

[src/subagent/execution-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/execution-queue.ts)（2.5KB）存在但在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 和 [code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts) 中**未导入**。CodeActExecutor 自行管理内部 taskQueue。

---

### 4.4 Session Compaction ([src/event/compaction.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/compaction.ts)) 定位模糊

> **文档** (memory.md §3.5): Compaction 的新职责是"提炼 Agent session 中产生的事实和画像更新"，不再创建话题节点
>
> **现状**: [src/event/compaction.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/compaction.ts) 仍然存在（8KB），但在 subagent 架构中：
> - CodeActExecutor 有自己的 session compact 逻辑（code-act-executor.ts L565-619）
> - [compaction.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/compaction.ts) 是否仍被调用取决于 session-runner.ts 的调用链，需确认

---

### 4.5 [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#85-102) 和 [loadAgentState()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#103-119) 残留函数

main.ts L88-118 中定义了 [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#85-102) 和 [loadAgentState()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#103-119)，但：
- [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#85-102) 加载 [workspace/agent-docs/system-prompt.md](file:///Users/moss/Projects/CyberGroupmate/workspace/agent-docs/system-prompt.md)，这是 Phase 2-3 的旧系统 prompt。在 subagent 架构中，主 Agent 的系统 prompt 已硬编码在 main.ts L540-553。这个函数的返回值 `systemPrompt` 在 L164 赋值后**未被使用**。 🟢
- [loadAgentState()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#103-119) 读取 [workspace/agent-state.md](file:///Users/moss/Projects/CyberGroupmate/workspace/agent-state.md)，同样**未被使用**（之前被注入到旧 session runner 的 context 中，现在由 GlobalState 替代）。 🟢

---

### 4.6 [serializeTopic()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#120-135) 函数

main.ts L120-134 中的 [serializeTopic()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#120-135) 仍被 `actions.getTopicContext` 和 `actions.listActiveTopics` host call handler 使用 ✅（非残留）。

---

### 4.7 `hostRL` / [promptUser](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#228-234) — 交互式输入

main.ts L225-233 保留了 `readline` 交互式输入能力，通过 sandbox `input_request` 事件使用。这属于 Phase 1-2 的基础能力，**仍然需要**（非残留）。

---

## 5. Memory V2 对照（memory.md）

### ✅ 已实现

| 模块 | memory.md 章节 | 实现 |
|------|---------------|------|
| 三层记忆模型 | §1 | [src/memory-v2/memory-v2.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/memory-v2.ts) (74KB) |
| `recall()` 统一检索 | §4 | ✅ 已实现 |
| `browseHistory()` 消息档案 | §5 | ✅ 已实现 |
| `reflect()` Reflection | §3.3 | [src/memory-v2/reflection.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/reflection.ts) (42KB) |
| message_log 表 | §5.2 | ✅ 已实现 + MessageLogWriter |
| topics / core_facts / person_* / group_models / interactions 表 | §3.4 | ✅ 已建表 |
| 情感记忆渐进合并 | §3.2 | [reflection.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/reflection.ts) 中已实现 |
| Reflection 定时触发 | §3.3 | main.ts L372-446 |

### 🔴 缺失 / 不确定

| 项目 | memory.md 章节 | 状态 |
|------|---------------|------|
| 短期 Compaction 集成到 CodeAct session | §2 | 🔴 context-manager.ts 存在但未集成 |
| Token 预算 `ContextBudget` | §2.3 | 🔴 未使用 |
| `js-tiktoken` 精确 token 计算 | §2.3 | 🔴 / 🟡 需确认 context-manager.ts 是否引入 |
| `sqlite-vec` 原生向量扩展加载 | §4.1 | 🟡 embedding.ts 有 FNV-1a fallback |
| message_log 写入时机: RecordingPipeline flush vs 实时 | §5.2 | 🟡 **文档说 Recording Pipeline flush 时批量写入，但实际由 MessageLogWriter 实时写入（main.ts L284）** |

> [!IMPORTANT]
> **message_log 写入时机的差异**：memory.md §5.2 明确说"消息写入时机：Recording Pipeline 在每次 flush 时批量写入"。但实际实现中，`MessageLogWriter` 是通过 `nc.onPush` hook (main.ts L284) 实时写入每条消息的。这实际上是一个**实现优于文档描述**的改进——实时落盘更可靠，且 subagent.md §1.1 也要求"同步落盘到 message_log"。memory.md 文档需要更新以反映这个改进。

---

## 6. Implementation_Plan.md 对照

### 文档中标记完成但与代码有出入的项

| Task | 标记状态 | 实际情况 |
|------|---------|---------|
| 6.1 Air-Reading Engine (FastRouter 三路路由) | ✅ 完成 | 🟢 FastRouter 在 subagent 架构中已被旁路，不再被 main.ts 使用 |
| 6.1.1 Engaged Topic Handler | ✅ 完成 | 🟢 同上，不再被 main.ts 使用 |
| 6.3 Reply Pipeline Framework | ✅ 完成 | 🟢 同上，ReplyPipeline 不再被使用 |
| 6.8 Model Router | ✅ 完成 | 🟢 同上，ModelRouter 不再被使用 |

### 架构图需更新

Implementation_Plan.md §1.1 的 mermaid 架构图仍然展示的是 Phase 6 的 FastRouter → ReplyPipeline 流程，**与当前 subagent 架构不匹配**。需要更新为 NC → Observer → Q3 → MainAgentLoop → CodeActExecutor/FastPath 流程。

---

## 7. 优先级建议

按影响程度和紧迫性排序：

### 高优先级

1. **🔴 2.11 TaskList Skill host call 未桥接** — GlobalState 有完整 API 但 sandbox 中无法访问
2. **🔴 2.13 主 Agent 系统 prompt 缺少 GlobalState/TaskList 注入** — 主 Agent 决策时没有全局状态视角
3. **🟡 3.4 Cosine Decay 缺少 urgentSignals/alert 强制提升** — alert 场景下可能使用过浅的上下文深度
4. **🟡 3.5 GroupStickiness 缺少大量字段** — replyFrequency、initiativeLevel 等调控参数缺失

### 中优先级

5. **🔴 2.1-2.3 Observer 未内嵌 Recording Pipeline** — 架构耦合度高于设计
6. **🔴 2.9 智能 Compaction 未集成** — CodeActExecutor session 缺少话题连贯性保护
7. **🟢 4.1 清理残留 Pipeline 组件** — FastRouter/ReplyPipeline/EngagedTopicHandler/ModelRouter/ContextAssembler 不再使用
8. **🟢 4.5 清理残留函数** — [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#85-102) 和 [loadAgentState()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#103-119) 不再使用

### 低优先级

9. **🟡 2.5-2.8 类型字段差异** — GroupContextPackage、AttentionQueueEntry、CodeActReplyTask 的字段与文档不完全一致
10. **🟢 4.2-4.3 清理未使用的 GroupDispatcher 和 ExecutionQueue** — 功能已被内联
11. **🔴 2.12 Playbook System** — Phase 7 规划中，非当前阻塞项

---

## 8. 总结

| 类别 | 数量 |
|------|------|
| ✅ 一致 | ~20 项核心功能 |
| 🔴 缺失 | 15 项 |
| 🟡 差异 | 10+ 项 |
| 🟢 冗余/残留 | 7 项 |

**总体评估**: Subagent 架构的核心骨架（Q1/Q3/Q5 队列、MainAgentLoop 7 阶段循环、Observer/CodeActExecutor/FastPath 三组件、GlobalState、SandboxPool）已经完整实现并工作。主要 gap 在于：

1. **Observer 与 Recording Pipeline 的耦合方式**与文档描述不同（通过 bridge 而非内嵌）
2. **类型系统与文档 spec 的字段差异**较多（但功能等效）
3. **Phase 6 的残留组件**需要清理
4. **一些重要的集成点缺失**（TaskList host call、GlobalState 注入主 Agent prompt、Cosine Decay alert 提升）
