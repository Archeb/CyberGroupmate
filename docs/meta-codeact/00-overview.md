# Meta-CodeAct 实施总览

## 目标

将 Main Agent 从"逐群轮询 JSON 单步决策"升级为"全局视野 CodeAct 多步编排"。

## 核心变更

1. **Q3 队列 → Accumulator**：批量收集 + 三层优先级 + 滴灌释放
2. **attend-handler JSON 决策 → Meta-CodeAct session**：主 Agent 在 vm 沙盒中写代码编排
3. **新增 Meta API**：`conversations` / `memory` / `agents` / `dispatch` / `memo` / `schedule`

## 设计决策摘要

| 项 | 决策 |
|:---|:-----|
| 执行模型 | 进程内 `vm.runInNewContext`，try-catch 错误处理 |
| LLM 路由 | `llmRouting.attend` → 重命名为 `llmRouting.meta` |
| 过渡策略 | 完全切换，删除旧 JSON 决策路径 |
| dispatch 上下文 | Meta Agent 只传方向 + 查好的对象（JSON 直传），Subagent 自行构建群内上下文 |
| Grounding | 每次 dispatch 自动触发（与现有行为一致） |
| 压力公式 | 参与者 `条数 × min(字数, 200)` × `tierWeight`，加权求和 |
| Session Digest | Prompt 要求 Agent 在 thinking 中总结，框架正则提取 |
| Accumulator 窗口 | 5s（Layer 0 抢占立即 flush） |
| 信号池持久化 | 存入 GlobalState JSON |
| 上下文深度 | 固定值，用户可配置 `subagent.contextDepth`（默认 50） |

## 数据流

```
消息 → NC → RecordingPipeline
  → 聚类完成 → Accumulator.ingest(Layer2, topicDigest)
DM/@mention → Accumulator.ingest(Layer0, urgentItem)
Q5 callback → Accumulator.ingest(Layer1, callbackItem)
scheduler → Accumulator.ingest(Layer1, schedulerItem)

MainAgentLoop tick (4 Phase):
  1. drain Q5 → accumulator.ingest(1, ...)
  2. accumulator.flush() → AttentionSet | null
  3. if (set) → Meta-CodeAct session (vm):
       LLM 生成代码 → 调 Meta API → observation → 循环
       dispatch.taskToGroup(chatId, { contentDirection, context })
         → 自动触发 Grounding
         → CodeActReplyTask 入队 Q4
       框架从 thinking 提取 Session Digest
  4. 持久化 GlobalState
```

## 删除清单

| 文件 | 理由 |
|:-----|:-----|
| `src/main-agent/attend-handler.ts` | 被 Meta-CodeAct session 替代 |
| `src/main-agent/dispatch-handler.ts` | 被 `dispatch.taskToGroup` Meta API 替代 |
| `src/main-agent/context-builder.ts` | 被 Subagent 自行构建替代 |
| `src/main-agent/cosine-decay.ts` | 深度固定，不再需要衰减 |
| `src/subagent/attention-queue.ts` | 被 Accumulator 替代 |
| `src/sandbox/skills/task-list.ts` | 死代码（无外部调用、不在 module docs 中） |
| `src/context-engine/providers/attend-providers.ts` | 被 meta-providers 替代 |

## 保留清单

| 文件 | 理由 |
|:-----|:-----|
| `src/main-agent/grounding-util.ts` | 保留，被 `dispatch.taskToGroup` 调用 |
| `src/sandbox/host-call-handler.ts` | 保留，GroupSubagent 沙盒不变 |
| `src/sandbox/sandbox.ts` | 保留，GroupSubagent 沙盒不变 |
| `src/subagent/code-act-executor.ts` | 保留，GroupSubagent 执行器不变 |

## 实施顺序

| 步骤 | Phase | 文档 | 依赖 |
|:-----|:------|:-----|:-----|
| 1 | GlobalState 重构 | [01-global-state.md](01-global-state.md) | 无 |
| 2 | Accumulator | [02-accumulator.md](02-accumulator.md) | Step 1 |
| 3 | Meta Sandbox + API | [03-meta-sandbox.md](03-meta-sandbox.md) | Step 1+2 |
| 4 | ContextEngine + Digest | [04-context-engine.md](04-context-engine.md) | Step 3 |
| 5 | Triage 降级 + 清理 + Dashboard | [05-cleanup.md](05-cleanup.md) | Step 1+2 |
