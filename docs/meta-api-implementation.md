# Meta API 实现说明

本文档描述 Phase 3 中 6 个 Meta API 的当前实现、依赖来源和运行时行为。这里记录的是代码当前真实行为，不是理想化接口草图。

## 文件布局

- `src/meta-sandbox/meta-api/conversations.ts`
- `src/meta-sandbox/meta-api/memory.ts`
- `src/meta-sandbox/meta-api/agents.ts`
- `src/meta-sandbox/meta-api/dispatch.ts`
- `src/meta-sandbox/meta-api/memo.ts`
- `src/meta-sandbox/meta-api/schedule.ts`
- `src/meta-sandbox/meta-api/index.ts`

`buildMetaApiContext()` 在 `src/meta-sandbox/meta-api/index.ts` 中汇总六个模块，供 MetaSandbox 注入 vm context 使用。

## 1. conversations.query(filters)

实现文件：`src/meta-sandbox/meta-api/conversations.ts`

底层依赖：`MemoryStoreV2`

使用的方法：

- `searchMessages()`
- `searchTopics()`
- `getRecentMessages()`
- `getRecentTopics()`

具体行为：

- 支持 `chatIds`、`keywords`、`userId`、`after`、`before`、`limit`。
- 当提供 `keywords` 时：
  - 对每个关键词分别调用 `searchMessages()`。
  - 对关键词集合拼接后的查询调用 `searchTopics()`。
  - 按 `messageId/chatId` 与 `topicId` 去重。
  - 消息按 `timestamp` 倒序返回，话题按 `startedAt` 倒序返回。
- 当不提供 `keywords` 时：
  - 不做全文搜索。
  - 仅当提供 `chatIds` 时，回退为 `getRecentMessages()` 与 `getRecentTopics()`。
  - 之后再按 `userId`、时间范围做本地过滤。
- 返回结构固定为：
  - `messages`: `MessageSearchResult[]`
  - `topics`: `TopicSearchResult[]`

当前边界：

- 不会在“无关键词且无 chatIds”时扫描全库最近消息，避免隐式全局拉取过大。
- 话题查询的 `userId` 过滤依赖 topic participants，不会再额外深读消息原文。

## 2. memory.searchEntities(query, options?)

实现文件：`src/meta-sandbox/meta-api/memory.ts`

底层依赖：`MemoryStoreV2`

使用的方法：

- `searchByAlias()`
- `searchFacts()`
- `searchTopics()`
- `getPersonIdentity()`
- `getUserProfile()`

具体行为：

- 目标不是单点搜索，而是把“身份、事实、最近会话、话题关键词”聚合成一个结果。
- 输入 `query` 会同时走四条路径：
  - alias 命中：`searchByAlias(query)`
  - core facts 命中：`searchFacts(query)`
  - recent sessions 命中：`searchTopics(query)`
  - topic participants 反查身份：从命中的话题参与者里取 `getPersonIdentity()`
- 返回结构：
  - `identities`: 身份与 `getUserProfile()` 聚合后的结果
  - `recentSessions`: 命中的最近话题列表
  - `coreFacts`: 直接 facts 命中 + 命中身份的 recentFacts 去重后汇总
  - `topicKeywords`: 命中话题中抽出的关键词去重列表

当前边界：

- `options.chatId` 只作用在 topic/session 查询与 profile 读取，不会限制 alias 全局搜索。
- `coreFacts` 只聚合“直接事实命中”与“直接身份命中的 recentFacts”；不会为了 topic participant 扩大成全量事实召回。
- 这个 API 明确覆盖：alias、recent sessions、topic keywords、core facts 四类信息。

## 3. agents.listStatus()

实现文件：`src/meta-sandbox/meta-api/agents.ts`

底层依赖：`SubagentManager`

使用的方法与字段：

- `SubagentManager.getAllSubagents()`
- `GroupSubagent.chatId`
- `GroupSubagent.lastActivityAt`
- `GroupSubagent.stickiness.level`
- `CodeActExecutor.getQueueSize()`
- `CodeActExecutor.isProcessing()`

具体行为：

- 遍历当前已存在的全部 `GroupSubagent`。
- 每项输出：
  - `chatId`
  - `queueSize`
  - `isProcessing`
  - `lastActiveAt`
  - `stickinessLevel`
- 结果按 `lastActiveAt` 倒序排序。

当前边界：

- 当前实现没有伪造 `chatTitle`、当前话题摘要或拥堵解释，因为这些字段没有稳定的公开读取面。
- `lastActiveAt` 来自 `GroupSubagent.lastActivityAt`，不是文档草图里的 `lastActiveAt` 字段名。

## 4. dispatch.taskToGroup(chatId, taskSpec)

实现文件：`src/meta-sandbox/meta-api/dispatch.ts`

底层依赖：

- `SubagentManager`
- `AttentionAccumulator`
- `CodeActExecutor`
- 可选 `GroundingConfig`
- 可选 `runParallelGrounding()`

具体行为：

- `taskSpec` 当前支持：
  - `contentDirection`
  - `toneGuidance`
  - `context`
  - `useSkills`
- 调用流程：
  1. 通过 `subagentManager.getOrCreate(chatId)` 获取群组 subagent。
  2. 如果 subagent 上没有 `codeActExecutor`，则创建一个新的 executor。
  3. 为 executor 设置 session file path；如果之前没有路径，调用 `loadSession()` 尝试恢复。
  4. 如果提供了 `initializeExecutor()` 注入钩子，则在入队前执行它。
  5. 如果配置了 grounding，并且提供了 API key，则对 `contentDirection` 做一次可选 grounding。
  6. 构造最小合法 `CodeActReplyTask`：
     - 单条 `REPLY` decision
     - `contextSnapshot.depth = 2`
     - `topicDigests = []`
     - `engagementScore = 0`
     - `personContext = JSON.stringify(taskSpec.context)`
     - `contentDirection` / `toneGuidance` / `groundingContext`
  7. `executor.enqueue(task)`
  8. `accumulator.markActioned(chatId)`
- 返回 `{ taskId }`

为什么需要 `initializeExecutor()`：

- 旧 `dispatch-handler` 在入队前负责给 `CodeActExecutor` 注入 callback handler、sandboxPool、notification center、memory 等运行时依赖。
- Meta API 层不能假定这些依赖天然存在，所以这里保留了一个显式注入缝。
- 后续主入口接线时，应在 `buildMetaApiContext()` 的 deps 中提供该钩子。

当前边界：

- `dispatch` 当前不负责构建完整的 `GroupContextPackage`，而是只写执行最小骨架；更多上下文依赖 `CodeActExecutor.refreshTaskMessages()` 和执行时实时补全。
- `memory` 依赖现在保留在 deps 中，但当前版本 `dispatch.ts` 本身没有直接消费它。

## 5. memo

实现文件：`src/meta-sandbox/meta-api/memo.ts`

底层依赖：`GlobalState`

方法映射：

- `memo.set(key, value, ttlMinutes?)` -> `globalState.memoSet()`
- `memo.get(key)` -> `globalState.memoGet()`
- `memo.delete(key)` -> `globalState.memoDelete()`
- `memo.list()` -> `globalState.memoList()`

具体行为：

- 完全透传 `GlobalState` 的 TTL memo 存储。
- `set()` 不返回值。
- `get()` 返回 `unknown | null`。
- `list()` 返回当前未过期 memo 列表。

当前边界：

- 没有增加额外命名空间或 schema 校验；Meta Agent 需要自行约束 key/value 结构。

## 6. schedule

实现文件：`src/meta-sandbox/meta-api/schedule.ts`

底层依赖：`GlobalState`

当前支持的 `WakeCondition`：

- `{ type: "delay", ms: number }`
- `{ type: "callback_received", taskId: string }`

具体行为：

- `schedule.wakeOnCondition(condition)`：
  - 始终先调用 `globalState.addWakeCondition(condition)` 注册条件。
  - 如果是 `delay`：
    - 额外创建一个 `chatId="__meta__"` 的 reminder。
    - reminder 的 `description` 固定写成 `wake:${conditionId}`。
    - 返回 `{ conditionId, reminderId }`。
  - 如果是 `callback_received`：
    - 只注册 wake condition，不创建 reminder。
    - 返回 `{ conditionId }`。
- `schedule.cancel(conditionId)`：
  - 调用 `removeWakeCondition(conditionId)`。
  - 扫描 `getSchedulerEvents("__meta__")`，删除所有 `description === wake:${conditionId}` 的 reminder。
  - 返回 `{ removedWakeCondition, removedReminderIds }`。

当前边界：

- 目前没有 cron 风格的 Meta API；调度能力仅覆盖 delay 和 callback received。
- `delay` 通过 reminder 落地是为了复用现有主循环里的 reminder 检查路径。

## buildMetaApiContext(deps)

实现文件：`src/meta-sandbox/meta-api/index.ts`

职责：

- 汇总六个模块，形成注入 MetaSandbox 的 context 对象。
- 透传 `dispatch` 需要的可选钩子：
  - `groundingRunner`
  - `executorFactory`
  - `initializeExecutor`
  - `taskIdFactory`

当前结构：

- `conversations`
- `memory`
- `agents`
- `dispatch`
- `memo`
- `schedule`

## 测试覆盖

当前 focused tests：

- `tests/meta-api-conversations.test.ts`
- `tests/meta-api-memory.test.ts`
- `tests/meta-api-agents.test.ts`
- `tests/meta-api-dispatch.test.ts`
- `tests/meta-api-state.test.ts`

覆盖范围：

- conversations: 关键词跨群检索 + recent fallback
- memory: alias / recent sessions / topic keywords / core facts 聚合
- agents: runtime 状态聚合
- dispatch: task 构建、grounding 注入、executor bootstrap
- memo: 透传全局状态
- schedule: delay / callback wake condition + cancel
- index: 六个模块汇总

## 后续接线要求

要让这些 API 真正进入主运行时，还需要主入口完成两件事：

1. 创建 `buildMetaApiContext()` 所需的完整 deps，尤其是 `dispatch.initializeExecutor()`。
2. 将 `MetaSandbox + MetaSessionRunner + Meta API context` 接入新的 main-agent loop，替代旧 attend/dispatch handler 路径。