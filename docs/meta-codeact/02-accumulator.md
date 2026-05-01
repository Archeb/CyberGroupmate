# Phase 2: Accumulator（替换 Q3 注意力队列）

## 目标

用 `AttentionAccumulator` 替换 `DynamicAttentionQueue`。实现三层优先级 + 窗口期批量收集 + 滴灌释放。

## 核心类型

```typescript
// src/accumulator/types.ts

interface AttentionItem {
  layer: 0 | 1 | 2;
  chatId: string;
  source: 'DIRECT_ADDRESS' | 'CALLBACK' | 'SCHEDULER' | 'WAKE_CONDITION' | 'TOPIC_SIGNAL';
  payload: unknown;        // TopicDigest / SubagentCallback / SchedulerTrigger 等
  enqueuedAt: number;      // Date.now()
  pressure?: number;       // Layer 2 专用
  ignoredCount?: number;   // 被释放但 Agent 未行动的次数
}

interface AttentionSet {
  timestamp: number;
  items: AttentionItem[];  // 排序: layer ASC → pressure DESC
  triggerReason: 'window' | 'preempt';
}
```

## 三层模型

| Layer | 触发来源 | 行为 |
|:------|:---------|:-----|
| 0（紧急） | DM / @mention / 文本提及 / FeedbackLoop 追问 | 立即标记抢占，当前窗口立即 flush |
| 1（到期） | Q5 callback 回来 / `schedule.wakeOnCondition` 满足 / scheduler watchdog | 进入待处理区，下次窗口 flush 时包含 |
| 2（信号） | RecordingPipeline 聚类完成的 topic | 进入信号池，按 pressure 排序，每次 flush 取 Top-N |

## 新建文件

### `src/accumulator/attention-accumulator.ts`

```typescript
class AttentionAccumulator {
  private pending: AttentionItem[] = [];       // Layer 0+1 待处理区
  private signalPool: AttentionItem[] = [];    // Layer 2 信号池
  private preempted = false;                   // 是否有 Layer 0 抢占
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private windowMs = 5000;                     // 窗口期，可配置
  private topN = 3;                            // 每次从信号池取几个

  constructor(
    globalState: GlobalState,  // 用于持久化 signalPool
    config?: { windowMs?: number; topN?: number }
  )

  // 恢复信号池（启动时从 GlobalState 加载）
  restoreSignalPool(): void

  // 注入事件
  ingest(layer: 0 | 1 | 2, item: Omit<AttentionItem, 'layer'>): void
    // Layer 0: push to pending + set preempted=true
    // Layer 1: push to pending
    // Layer 2: push to signalPool + 计算 pressure

  // 主循环调用：flush 当前窗口
  // 返回 null 表示无事可做
  flush(): AttentionSet | null
    // 1. 如果 pending 为空且信号池为空 → return null
    // 2. 从信号池按 pressure DESC 取 Top-N → 合并到 pending
    // 3. 对取出的信号池 item 标记 ignoredCount（如果 Agent 上次未行动）
    // 4. 排序: layer ASC → pressure DESC
    // 5. 清空 pending, 重置 preempted
    // 6. 持久化 signalPool 到 GlobalState
    // 7. 返回 AttentionSet

  // 标记某个 chatId 的信号已被 Agent 处理（重置 ignoredCount）
  markActioned(chatId: string): void

  // 获取信号池大小（监控用）
  getSignalPoolSize(): number

  dispose(): void  // 清理 timer
}
```

### `src/accumulator/pressure.ts`

```typescript
interface PressureInput {
  // topic 中每个参与者的数据
  participants: Array<{
    messageCount: number;
    totalChars: number;      // 总字数
    dunbarTier: 1 | 2 | 3 | 4;
  }>;
  stickinessLevel: 'CORE' | 'FAMILIAR' | 'ACQUAINTANCE' | 'STRANGER';
  ageMinutes: number;        // 在信号池中等待的分钟数
  ignoredCount: number;      // 被释放但未行动的次数
}

function calculatePressure(input: PressureInput): number

// 公式:
// charCap = 200
// tierWeight: tier1=2.0, tier2=1.5, tier3=1.0, tier4=0.7
// stickinessMultiplier: CORE=2.0, FAMILIAR=1.2, ACQUAINTANCE=0.8, STRANGER=0.5
//
// participantVolume = Σ(条数 × min(每条平均字数, charCap) × tierWeight[tier])
//   注意：totalChars/messageCount 得到平均字数，乘以条数得到 capped volume
// ageFactor = 1 + ageMinutes × 0.02
// ignoredPenalty = ignoredCount > 0 ? 0.3 : 1.0
//
// pressure = participantVolume × stickinessMultiplier × ageFactor × ignoredPenalty
```

**数据来源**：
- `participants`：从 `TopicDigest.participants` + `memory.getProfilesForChat()` 获取 dunbarTier；从 topic 的消息列表统计 messageCount/totalChars
- `stickinessLevel`：从 `GroupSubagent.stickiness.level`
- `ageMinutes`：`(Date.now() - item.enqueuedAt) / 60000`

## 修改文件

### `src/main.ts`

替换所有 `q3.enqueueOrUpdate()` 为 `accumulator.ingest()`：

| 当前代码位置 | 当前行为 | 替换为 |
|:------------|:---------|:-------|
| NC.onPush DM/mention/name 分支 | `q3.enqueueOrUpdate(entry); q3.boost(chatId, ...)` | `accumulator.ingest(0, { chatId, source: 'DIRECT_ADDRESS', payload: { ... } })` |
| triage-engage 事件回调 | `q3.enqueueOrUpdate(entry)` | `accumulator.ingest(2, { chatId, source: 'TOPIC_SIGNAL', payload: topicDigest })` |
| scheduler watchdog | `q3.enqueueOrUpdate(entry); q3.boost(chatId, 80)` | `accumulator.ingest(1, { chatId, source: 'SCHEDULER', payload: trigger })` |
| FeedbackLoop | `q3.enqueueOrUpdate(...); q3.boost(...)` | `accumulator.ingest(0, { chatId, source: 'DIRECT_ADDRESS', payload: ... })` |

同时：
- 删除 `q3` 实例创建（`new DynamicAttentionQueue()`）
- 创建 `accumulator` 实例，传入 `globalState`
- 启动时调用 `accumulator.restoreSignalPool()`
- shutdown 时调用 `accumulator.dispose()`

### `src/main-agent/main-agent-loop.ts`

构造函数参数：删除 `attentionQueue: DynamicAttentionQueue`，新增 `accumulator: AttentionAccumulator`

tick() 重构：
```typescript
// 旧 Phase 2: Q3 evaluate → 删除
// 旧 Phase 3: dequeue → 删除
// 旧 Phase 3-6 循环 → 删除

// 新逻辑：
const set = this.accumulator.flush();
if (set) {
  // Phase 3: Meta-CodeAct session (Phase 3 的具体实现见 03-meta-sandbox.md)
}
```

删除：`lastStoredMsgId`、`_attendEngine`、`conversationHistory`、`manageHistory()`、`appendToHistory()`、`getConversationHistory()`、`getConversationHistorySize()`、`getAttendEngine()`、`getLastStoredMsgId()`、`setLastStoredMsgId()`

### `src/subagent/group-subagent.ts`

删除 `hasTriageEngaged` 标志相关逻辑（triage-engage 事件改为直接调 accumulator.ingest）。

## 删除文件

- `src/subagent/attention-queue.ts`

## 验证

- 单元测试：窗口期 flush、Layer 0 抢占、压力排序、ignoredPenalty 衰减、信号池持久化/恢复
- `npx tsc --noEmit`
- 启动后 DM 能触发 Layer 0（此时 Meta-CodeAct 未实现，可先 log 输出 AttentionSet 验证）
