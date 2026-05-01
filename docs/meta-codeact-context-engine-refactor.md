# Meta-CodeAct ContextEngine 升级及历史精简实施蓝图

> **致 Coding Agent**：
> 本文是为解决 Meta Agent (meta-session-handler) 上下文组装退化问题而制定的详细实施规范。目前的实现回退到了暴力的全量字符串拼接，丢失了增量 Diff（Delta）能力，并且丢失了部分关键的跨群上下文（Group Model, Profiles, Associated Memories）。
> 你的任务是严格按照本规范，通过重构重新引入 `ContextEngine`，并参考旧有的实现恢复完整的注意力和上下文机制。

## 核心参考资料
在开始之前，请务必仔细阅读以下两个旧有实现，它们是本次重构的“正确答案”来源：
- `g:\Projects\CyberGroupmate\.tmp\attend-providers.ts` (定义了各个 Section 的缓存策略、Diff 签名算法和数据来源)
- `g:\Projects\CyberGroupmate\.tmp\attend-handler.ts` (定义了如何查询 Memory 获取画像数据，以及如何组装 `ResolveContext`)

---

## Phase 1: 建立 `meta-providers.ts`

**目标文件**: 创建 `src/context-engine/providers/meta-providers.ts`
**目标**: 完全复刻 `.tmp/attend-providers.ts` 中的 Provider 逻辑，并适配当前 `AttentionQueueEntry` 提供的数据源。

你需要实现并导出一个 `getMetaProviders()` 函数，返回以下 Provider 列表（按渲染顺序）：

1. **`metaHistoricalProvider`** (新)
   - 作用：渲染全局 Session Digests 和 Memos。
   - 配置：`cache: "snapshot", history: "persistent"`。
2. **`metaCallbacksProvider`** (新)
   - 作用：渲染新到达的 Subagent Callbacks。
   - 配置：`cache: "snapshot", history: "ephemeral"`。
3. **针对每个群的 Provider (复刻自 `attend-providers.ts`)**：
   - 所有针对群的 Provider 都必须配置 `scopeKey(ctx) { return ctx.chatId }`，确保引擎能分群进行 Delta 计算。
   - **`metaAttendHeaderProvider`**: `chatId, chatTitle, chatType` (`volatile` / `persistent`)
   - **`metaAttendMetaProvider`**: 本次触发元数据，包含 `source, priority, engagementScore, stickinessLevel` (`volatile` / `persistent`)
   - **`metaTopicDigestsProvider`**: 话题注册表（上限为10个），使用原版的 `getTopicDigestSignature` 进行 diff，只输出发生变化的 Topics (`delta` / `delta-only`)。记得加上 Associated Memories。
   - **`metaMessagesProvider`**: 聊天消息（上限为30条），按 `message.id` 进行 diff，只输出新消息 (`delta` / `delta-only`)。
   - **`metaGroupModelProvider`**: 聊天群画像 (`static` / `ephemeral`)。
   - **`metaProfilesProvider`**: 活跃参与者画像，使用原版的 `getProfileSignature` 进行 diff (`delta` / `delta-only`)。

---

## Phase 2: 重构 `meta-session-handler.ts`

**目标文件**: `src/main-agent/meta-session-handler.ts`
**目标**: 废弃旧的 `renderCurrentTurn` 和全量模板拼接，改用全局单例的 `ContextEngine` 依次渲染。

### 1. 引入引擎实例
在模块顶层（或 Handler 闭包内）初始化一个持久的 ContextEngine 实例：
```ts
const engine = new ContextEngine("meta-agent");
engine.registerAll(getMetaProviders());
```

### 2. 补齐缺失数据查询
当 `createMetaSessionHandler` 收到 `entries: AttentionQueueEntry[]` 时，目前的 entry 缺少了画像数据。你需要遍历 `entries`，向 `MemoryV2` 请求：
- `groupModel = memory.getGroupModel(entry.chatId)`
- `activeUserProfiles = memory.getProfilesForChat(entry.chatId)` (仅取活跃成员)
- 遍历 `entry.topicDigests`，如果原 entry 没带 `associatedMemories`，请通过 `memory.getAssociatedMemories(topicId)` 补齐。

### 3. 逐群渲染 Context
- 声明两个数组收集渲染结果：`historicalContents: string[]` 和 `ephemeralContents: string[]`。
- 首先渲染全局部分（Digests, Memos, Callbacks），塞入 context。
- 然后 **遍历 `entries`**，对每一个 `entry`：
  - 构建 `ResolveContext`（如 `ctx.chatId = entry.chatId`, `ctx.topicDigests = ...`, `ctx.activeUserProfiles = ...`）。
  - 调用 `const renderResult = engine.render(ctx)`。
  - 将该群的 `renderResult.historicalContent` 和 `ephemeralContent` 分别推入数组。
- 循环结束后，调用 `engine.commit()` 提交所有群的变更。
- 最终，将所有的 `historicalContents` 拼接为一个历史消息 (`role: "user"`)，将所有的 `ephemeralContents` 拼接为当前轮瞬时消息 (`role: "user"`) 提交给 LLM。

---

## Phase 3: 精简历史记录中的代码 (Code Stripping)

**目标文件**: `src/meta-sandbox/meta-session-runner.ts`
**目标**: Meta Agent 执行输出的代码不需要进入历史上下文中，只保留它的"思考"。

在 `runMetaSession` 的 `while (turns < config.maxTurns)` 循环中，当接收到 `assistantMessage.content` 时，当前逻辑是直接 `messages.push({ role: "assistant", content: assistantMessage.content })`。

**修改方案**：
在追加到 `messages` 之前，处理 `assistantMessage.content`：
```ts
const historyContent = assistantMessage.content.replace(
    /```(?:ts|typescript)\n[\s\S]*?\n```/g, 
    "[执行代码已剥离]"
);
messages.push({ role: "assistant", content: historyContent, cacheBreakpoint: true }); // 如果有 breakpoint 逻辑
```
这样确保下一轮循环时，LLM 只看到自己上一轮的自然语言思考和 `[SESSION_DIGEST]`，而不会看到大段的代码，彻底杜绝 Token 无意义膨胀。

---

## 预期 Prompt 效果概览

经过上述改造后，Meta Agent 每轮收到的 Prompt 结构应该类似于：

```markdown
# 历史 Session Digests
- [2026-05-01...] 处理了 A 群团建话题...

# 当前全局备忘录
- pending_crossgroup_reply: {"taskId":"xxx"} (expiresAt=...)

# 注意力切换: Telegram群 (-100123456)
## 新消息 (自上次关注以来, 共 1 条)
[17:47:35] Menci 💖: @Miu_Official 你好

## 话题注册表增量
(增量: 1 个话题更新)
- [活跃] 团建讨论 | 大家在聊去哪里

## 活跃参与者 (更新)
- Mozzie (核心圈, 好感80) | 特征: 喜欢千岛湖

## 聊天画像
- 标题: 快乐摸鱼群
- 描述: 日常闲聊打水
- 语气预设: 轻松活泼

# 新到达的 Subagent Callbacks
- -100123456: status=COMPLETED, summary=已回复...
```
（各 Section 的排列由 Provider 的声明顺序决定，群之间的信息被严格隔离且只发送 Delta 增量）
