# Phase 1: GlobalState 重构

## 目标

清理死代码字段，新增 Meta-CodeAct 所需的持久化字段。

## 当前字段审计

### 删除（死代码或被替代）

| 字段 | 删除理由 |
|:-----|:---------|
| `lastActiveAt` | 仅在 `recordDecision` 中顺带写入，**无任何读取方** |
| `recentDecisions` | 被 `sessionDigests` 替代（Meta Agent 自我摘要比逐条决策记录更有价值） |
| `pendingFollowups` | `addFollowup()` **从未被外部调用**，零数据；跨群编排由 Meta API 替代 |
| `attentionSummary` | 被 `sessionDigests` 替代 |
| `notes` | 所有 CRUD 方法**无外部调用者**；由 `memos` 替代 |

同时删除这些字段对应的所有方法：
- `recordDecision()`, `getRecentDecisions()`
- `addFollowup()`, `completeFollowup()`, `getPendingFollowups()`
- `updateAttentionSummary()`, `getAttentionSummary()`
- `addNote()`, `removeNote()`, `getNotes()`, `cleanExpiredNotes()`

### 保留

| 字段 | 保留理由 |
|:-----|:---------|
| `taskList` | **删除**。经审计为死代码：`skills.taskList.*` host call 存在但不在 module docs 中，agent 不知道该 API。同时删除 `src/sandbox/skills/task-list.ts` 和 `host-call-handler.ts` 中的 import/调用 |
| `schedulerEvents` | **保留**。`host-call-handler.ts`（cron/remind）、`main.ts` watchdog、`dashboard` 活跃使用 |

### 新增

```typescript
interface MainAgentGlobalState {
  // 保留
  schedulerEvents: SchedulerEvent[];

  // 新增
  memos: Array<{
    key: string;
    value: unknown;
    expiresAt?: string;   // ISO 8601, null = 永不过期
    createdAt: string;
  }>;
  sessionDigests: Array<{
    content: string;
    createdAt: string;
  }>;  // 保留最近 10 条
  signalPool: Array<{
    chatId: string;
    source: string;
    payload: unknown;       // TopicDigest 等
    enqueuedAt: number;
    pressure: number;
    ignoredCount: number;   // 被释放但未行动的次数
  }>;
  wakeConditions: Array<{
    id: string;
    condition: { type: 'delay'; ms: number }
             | { type: 'callback_received'; taskId: string };
    registeredAt: string;
  }>;
}
```

## 需要新增的方法

```typescript
// memo
memoSet(key: string, value: unknown, ttlMinutes?: number): void
memoGet(key: string): unknown | null
memoDelete(key: string): void
memoList(): Array<{ key: string; value: unknown; expiresAt?: string }>
cleanExpiredMemos(): number  // 自动清理过期 memo

// sessionDigests
addSessionDigest(content: string): void  // push + 保留最近 10 条
getSessionDigests(): Array<{ content: string; createdAt: string }>

// signalPool
getSignalPool(): SignalPoolItem[]
setSignalPool(items: SignalPoolItem[]): void

// wakeConditions
addWakeCondition(condition: WakeCondition): string  // 返回 conditionId
removeWakeCondition(id: string): boolean
getWakeConditions(): WakeCondition[]
```

## 修改文件清单

| 文件 | 操作 |
|:-----|:-----|
| `src/main-agent/global-state.ts` | 删除旧字段+方法，新增上述字段+方法 |
| `src/subagent/types.ts` | 更新 `MainAgentGlobalState` 接口，删除 `AgentTask`、`AgentNote` 类型 |
| `src/sandbox/skills/task-list.ts` | **删除文件** |
| `src/sandbox/host-call-handler.ts` | 删除 `task-list.ts` import 和 `taskListCalls` 相关代码（约 L421-L426） |
| `src/main-agent/main-agent-loop.ts` | 删除 `recordDecision` 调用、`getPendingFollowups` 调用、`updateAttentionSummary` 调用 |
| `src/main-agent/attend-handler.ts` | 暂不删除（Phase 3 删），但删除其中对 `getTaskList`/`getAttentionSummary`/`getRecentDecisions` 的引用 |
| `src/context-engine/providers/attend-providers.ts` | 删除引用 `recentDecisions`/`attentionSummary` 的 provider |

## 验证

- `npx tsc --noEmit` 通过
- 启动应用，scheduler watchdog 正常运行
- dashboard 的 scheduler 页面正常（`/api/scheduler` 仍可用）
