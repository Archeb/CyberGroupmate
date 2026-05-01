# Phase 5: Triage 降级 + 旧路径清理 + Dashboard 适配

## 目标

1. RecordingPipeline Triage 从二元裁决降级为信号源
2. 清理所有旧路径残留
3. Dashboard 适配新数据结构

---

## 5A: Triage 降级

### [MODIFY] RecordingPipeline（`src/pipeline/recording-pipeline.ts`）

当前行为：
```
flush → 聚类 → triage LLM → shouldEngage?
  YES → emit('triage-engage') → Q3
  NO  → 丢弃
```

新行为：
```
flush → 聚类 → triage LLM（仅提取元数据）
  → 所有聚类完成的 topic → accumulator.ingest(2, topicDigest)
```

具体改动：
- Triage LLM 调用**保留**：仍需要提取 topic 的 label、summary、keywords、participants
- **删除** `shouldEngage` 输出字段和判断逻辑
- **删除** `triage-engage` 事件 emit
- 新增：triage 完成后，对每个 topic 调用 `accumulator.ingest(2, { chatId, source: 'TOPIC_SIGNAL', payload: topicDigest })`
- Accumulator 引用需要通过构造函数或事件传递注入

### [MODIFY] `src/subagent/group-subagent.ts`

- 删除 `hasTriageEngaged` 属性及其 setter/getter
- 删除 `triage-engage` 事件监听器注册

### [MODIFY] `src/main.ts`

- 删除所有 `sub.on('triage-engage', ...)` 回调
- 将 accumulator 实例注入到 RecordingPipeline（通过 SubagentManager 或直接注入）

### [MODIFY] Triage prompt（`system-prompts/` 相关模板）

- 删除 `shouldEngage` / `should_intervene` 指令
- 仅保留：提取 label、summary、keywords、participants

---

## 5B: 旧路径残留清理

### 已在前序 Phase 删除的文件（确认清单）

| 文件 | 删除于 |
|:-----|:-------|
| `src/main-agent/attend-handler.ts` | Phase 3 |
| `src/main-agent/dispatch-handler.ts` | Phase 3 |
| `src/main-agent/context-builder.ts` | Phase 3 |
| `src/main-agent/cosine-decay.ts` | Phase 3 |
| `src/subagent/attention-queue.ts` | Phase 2 |
| `src/sandbox/skills/task-list.ts` | Phase 1 |
| `src/context-engine/providers/attend-providers.ts` | Phase 4 |

### 残留引用扫描

运行 `npx tsc --noEmit`，修复所有因删除文件导致的 import 错误。重点检查：

| 文件 | 可能的残留引用 |
|:-----|:---------------|
| `src/main.ts` | `createAttendHandler`, `createDispatchHandler`, `DynamicAttentionQueue`, `q3`, `q5` 相关 |
| `src/main-agent/main-agent-loop.ts` | `DynamicAttentionQueue` import, `attendHandler`, `dispatchHandler`, `lastStoredMsgId` |
| `src/sandbox/host-call-handler.ts` | `task-list.ts` import（L21）、`taskListCalls`（L422-426） |
| `src/subagent/types.ts` | `AgentTask`, `AgentNote` 类型定义 |
| `src/dashboard/api-routes.ts` | 可能引用旧 GlobalState 字段 |
| `src/metrics/index.ts` | 可能引用 Q3 / attend 相关 |

### `src/main-agent/main-agent-loop.ts` 清理

删除以下（如果前序 Phase 未完成）：
- `setAttendHandler()` / `setDispatchHandler()` 方法
- `conversationHistory` 及所有相关方法
- `lastStoredMsgId` 及相关方法
- `manageHistory()` 及 import 的 `shouldCompact` / `compact`
- `_attendEngine` ContextEngine
- `formatCallbackMessage()` 辅助函数
- `callbackProvider` import

### `src/main.ts` 清理

- 删除 `q3`（DynamicAttentionQueue）创建
- 删除 `mainLoop.setAttendHandler(...)` 和 `mainLoop.setDispatchHandler(...)`
- 删除 `createAttendHandler` 和 `createDispatchHandler` import
- Q5 callback 的处理：从 `mainLoop.tick()` 内部 drain → 改为 accumulator.ingest

---

## 5C: Dashboard 适配

### 当前 Dashboard 展示的旧数据

| 数据 | 当前来源 | 状态 |
|:-----|:---------|:-----|
| 最近决策 | `globalState.recentDecisions` | **已删除** |
| 注意力概要 | `globalState.attentionSummary` | **已删除** |
| Q3 队列快照 | `q3.getAll()` | **已删除** |
| Scheduler 事件 | `globalState.getSchedulerEvents()` | 保留 |

### 需要新增的 Dashboard 展示

| 数据 | 来源 | API 路由 |
|:-----|:-----|:---------|
| Session Digests | `globalState.getSessionDigests()` | `GET /api/session-digests` |
| 信号池 | `globalState.signalPool` | `GET /api/signal-pool` |
| Memos | `globalState.memoList()` | `GET /api/memos` |
| Accumulator 状态 | `accumulator.getSignalPoolSize()` | `GET /api/accumulator/status` |
| Wake Conditions | `globalState.getWakeConditions()` | `GET /api/wake-conditions` |

### [MODIFY] `src/dashboard/api-routes.ts`

- 删除引用 `recentDecisions`、`attentionSummary`、Q3 的路由
- 新增上述 5 个 GET 路由
- 更新 `/api/global-state` 返回新结构

### [MODIFY] Dashboard 前端（`src/dashboard/` 静态文件）

- 替换"最近决策"面板 → "Session Digests" 面板
- 替换"Q3 队列"面板 → "信号池" 面板
- 新增 "Memos" 面板
- 保留 "Scheduler" 面板

---

## 验证

### 编译
- `npx tsc --noEmit` 零错误

### 功能
- 发送消息到群组 → RecordingPipeline 聚类 → topic 出现在信号池
- Dashboard 展示 Session Digests、信号池、Memos
- Scheduler 功能（cron/remind）正常

### 无回归
- GroupSubagent 沙盒跨群拦截正常
- CodeActExecutor 执行不受影响
- 所有 host-call API（memory/vision/shell/cron/remind/mcp 等）正常
