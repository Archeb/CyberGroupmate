# Agent Loop / Subagent Loop 架构审计报告

> 审计范围：[Implementation_Plan.md](file:///Users/moss/Projects/CyberGroupmate/Implementation_Plan.md) × [subagent.md](file:///Users/moss/Projects/CyberGroupmate/subagent.md) × 实际代码 ([src/main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts), [main-agent-loop.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts), [code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts), [session-runner.ts](file:///Users/moss/Projects/CyberGroupmate/src/sandbox/session-runner.ts), [observer.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts), [types.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts))

---

## 🔴 关键问题（架构层面）

### 1. CodeActExecutor 共享全局 Sandbox — 违反 subagent.md §3.2 独立 Sandbox 要求

**设计**: subagent.md §3.2 明确要求每个 CodeActExecutor 持有 **独立 Sandbox**（独立 worker 进程），保证群组间执行隔离。  
**实际**: [main.ts L638](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L638) — `executor.setDependencies(sandbox, ...)` 将 **同一个全局 `sandbox`** 注入所有群组的 CodeActExecutor。  

**后果**:
- 群组 A 的 CodeAct 代码可以读写群组 B 留在 `ctx` 中的变量（跨群污染）
- 一个群组的 sandbox 崩溃会导致所有群组的执行中断
- [code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts) L97 声明了 `private sandbox: Sandbox | null = null`，暗示设计意图是独立实例，但实际被注入了共享实例

> [!CAUTION]
> 这是最严重的隔离性问题。`SandboxPool`（在 [types.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts) 中被引用但从未实现）是缺失的关键组件。

---

### 2. 新 Subagent 架构与旧 Phase 6A Pipeline 并行运行 — 双重处理

**设计**: subagent.md 描述的架构应该 **替代** 旧的 Phase 6A Pipeline（FastRouter → RecordingPipeline → ReplyPipeline → NC → Session Runner）。  
**实际**: [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) 同时运行了 **两套完全独立的处理流水线**：

```
路径 A（旧 Phase 6A，仍在运行）：
  NC.onPush Hook 2 → fastRouter.routeEvents([event]) (L279)
  → RecordingPipeline → topic:triage-passed → replyPipeline.buildTopicTask()
  → NC.push(system.reply_task) → ??? (没有消费者)

路径 B（新 Subagent 架构）：
  NC.onPush Hook 2 → sub.observer.onMessage()
  → q3.enqueueOrUpdate() → MainAgentLoop → attendHandler → dispatchHandler
  → CodeActExecutor.enqueue()
```

**后果**:
- 每条消息被 **同时处理两次**：一次走 Observer → Q3，一次走 FastRouter → RecordingPipeline
- `RecordingPipeline` 产生 `system.reply_task` 事件推入 NC，但新架构中 **没有任何消费者** 会 drain 这些事件（旧的 main loop `nc.drain()` 已被移除）
- 旧的 `ReplyPipeline`、`ContextAssembler`、`EngagedTopicHandler` 仍在消耗 LLM token 做 triage/摘要/模型路由，但产出不会被使用
- `ModelRouter`、`FeedbackLoop` 被初始化但在新 Subagent 架构中没有集成点

---

### 3. Session Runner 的通知中断会意外 drain 掉 Observer 需要的消息

**设计**: subagent.md 要求消息通过 NC → Observer.onMessage() 路径分发给各群组 Observer。  
**实际**: [session-runner.ts L264-298](file:///Users/moss/Projects/CyberGroupmate/src/sandbox/session-runner.ts#L264-L298) — CodeAct 执行中期会 `nc.drain(0, 5)` 直接从 NC 中取出消息。这些消息可能是其他群组的新消息，会被 drain 走后推回 NC（或直接作为上下文注入 session），但 **Observer 已经在 `nc.onPush` hook 中处理过它们了**（L252-280）。  

**后果**: 消息被 push 回 NC 后会被 `onPush` hook 再次触发 Observer.onMessage()，导致同一条消息被 Observer **重复计数**，engagement score 虚高。

---

## 🟡 中等问题

### 4. 主 Agent "LLM 决策" 与架构设计不一致

**设计**: subagent.md §12.2 定义了 7 个 Prompt 注入点。主 Agent 应该有 **持久化 session**（➋ 系统 prompt 一次初始化，➌ Attend 上下文作为 user message 注入到 session，➐ Callback 作为 user message 注入）。  
**实际**: [main.ts L515-521](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L515-L521) — 每次 attend 都创建一个全新的 `callLLM([ system, user ])` 调用，没有保持任何 session 历史。主 Agent 是 **无状态的**。  

**后果**:
- 主 Agent 无法学习或记忆之前的决策结果（subagent.md §12.2 ➐ Callback 回注 prompt 根本无法实现）
- 跨群交互（场景 5 的传话功能）依赖的 `globalState.pendingFollowups` 只在 JSON 中标记，LLM 无法看到之前的决策上下文
- 每次调用 LLM 都是从零开始，无法实现 "看完一段对话后批量回复" 的模拟效果

### 5. Callback 注入到主 Agent Session 的路径缺失

**设计**: subagent.md §12.2 ➐ — Callback 结果应注入到主 Agent 的 session 中，作为 user message。  
**实际**: [main-agent-loop.ts L152-168](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts#L152-L168) — Phase 1 drain callbacks 只做了：`recordDecision()` + `markTaskComplete()` + `unblock()`。没有任何 callback 内容被注入到 LLM session。

### 6. Observer 不做 Recording Pipeline flush — 与 subagent.md §3.1 不符

**设计**: subagent.md §3.1 — Observer 应包含 `flushBuffer(): Promise<void>` 方法触发 Recording Pipeline 话题聚类。  
**实际**: [observer.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts) — Observer 没有 `flushBuffer()` 方法。话题聚类依赖旧的全局 RecordingPipeline（通过 `fastRouter.routeEvents()` 在 L279 触发），而非 per-group Observer 内部。  

**后果**: TopicDigest 只从外部 [setTopicDigests()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#145-151) 注入（L148），Observer 自身无法独立产出话题摘要。

### 7. CodeActReplyTask.contextSnapshot 类型不匹配

**设计**: subagent.md §13.2 B1 要求 `contextSnapshot` 包含 `{ topicSummary, recentMessages, personContext, toneGuidance, contentDirection }`。  
**实际**: [types.ts L111-112](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#L111-L112) — `contextSnapshot` 的类型是 [GroupContextPackage](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts#201-221)，其字段为 `{ depth, chatId, topicDigests, engagementScore, ... }`，与 spec 完全不同。  
[main.ts L610-614](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L610-L614) 用 `as any` 强行注入 `topicSummary`/`recentMessages`/`personContext`/`toneGuidance`/`contentDirection`。

### 8. Implementation Plan §2.7 描述的 Main Event Loop 已过时

**设计 (Implementation Plan §2.7)**: drain → 组装 context → runCodeActSession → compaction → 检查 sandbox 存活。  
**实际**: main.ts 已改为 Subagent 架构（NC.onPush hooks → SubagentManager → Q3 → MainAgentLoop），但 Implementation Plan §2.7 的描述仍是旧的 drain-loop 模式。文档未标记 `[REVISED]`。

---

## 🟢 次要问题

### 9. Implementation Plan 中的 Phase 6A 组件描述与新架构冲突

Implementation Plan §1.1 的 mermaid 架构图仍描绘 Phase 6A 的 FastRouter → RecordingPipeline → ReplyPipeline 流程，与 subagent.md 的 Q1-Q5 队列架构无衔接。两份文档讲述的是两种不同的系统。

### 10. Graceful Shutdown 缺乏清理逻辑

[main.ts L775-783](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L775-L783) — `process.on("SIGINT")` 直接 `process.exit(0)`，不清理 `mainLoop.stop()`、`nc.dispose()`、`sandbox.kill()`、`globalState.save()`。  
可能导致 GlobalState 丢失、sandbox worker 变成孤儿进程。

### 11. 旧的 Session Compaction 集成缺失

- `runCompaction` 被 import（L20）但整个文件中 **从未被调用**
- `shouldCompact`/[compact](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts#374-388)/`mergeContextBudget` 被 import（L23）但也 **从未被使用**

### 12. [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#99-116) 和 [loadAgentState()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#117-133) 未被使用

这两个函数在 L102-132 定义但在新架构中 **从未被调用**。它们对应旧的 drain-loop 模式。

---

## 总结：问题优先级

| # | 问题 | 严重度 | 修复建议 |
|---|------|--------|----------|
| 1 | 共享 Sandbox 跨群污染 | 🔴 Critical | 实现 SandboxPool，per-group 独立 worker |
| 2 | 新旧 Pipeline 双重运行 | 🔴 Critical | 移除旧 Phase 6A Pipeline 或重构为 Observer 内部调用 |
| 3 | Session Runner drain 与 Observer 重复处理 | 🔴 Critical | CodeActExecutor 的 session runner 不应直接 drain NC |
| 4 | 主 Agent 无持久 session | 🟡 High | 为 MainAgentLoop 维护跨-tick LLM session |
| 5 | Callback 未注入主 Agent session | 🟡 High | 在 Phase 1 将 callback 格式化并注入 session |
| 6 | Observer 缺少 flushBuffer | 🟡 Medium | 将 RecordingPipeline 话题聚类内嵌到 Observer |
| 7 | contextSnapshot 类型混用 | 🟡 Medium | 定义独立的 CodeActContextSnapshot 类型 |
| 8 | Implementation Plan §2.7 过时 | 🟢 Low | 标注 `[REVISED]` 更新 |
| 9 | 架构图不一致 | 🟢 Low | 统一为 Q1-Q5 架构图 |
| 10 | Graceful Shutdown 不完整 | 🟢 Low | 添加清理逻辑 |
| 11 | 死 import | 🟢 Low | 删除未使用的 import |
| 12 | 死函数 | 🟢 Low | 删除或迁移到 Subagent 架构 |
