# Main Agent 架构演进 —— Meta-CodeAct 全局编排引擎

## 1. 执行摘要 (Executive Summary)

本文档提出对当前 V3 架构中 Main Agent（7 Phase 串行循环）的重大重构。旨在将 Main Agent 从一个**“被动、单群轮询的单步决策者”**升级为**“主动、具备全局视野的多步编排者 (Meta-CodeAct)”**。

通过引入 **批处理注意力累加器 (Accumulator)** 替代传统的 Q3 队列，并赋予主 Agent 一个异步的 CodeAct 沙盒，我们将彻底打破当前“信息孤岛”和“无法表达复杂逻辑”的瓶颈，使 Agent 具备跨群记忆检索、多任务并行委派、自主巡视调度等“真·数字员工”能力。

## 2. 动机与痛点 (Motivation)

在当前的 V3 架构中，Main Agent Loop 运作良好但已触及认知天花板：

1. **信息孤岛 (Per-group Isolation)**：Phase 4 的上下文构建仅限当前被 attend 的单个群组。如果 A 群有人问“昨天 B 群那个项目怎么说？”，Main Agent 无法跨群查阅 `message_log`。
2. **缺乏复杂工作流表达**：Phase 5 输出的 JSON 决策（`REPLY/DEFER/OBSERVE`）太单薄。无法表达“先去记忆库查一下，如果确认了就通知 A，否则发任务让 B 去调研”这种 if-else 或多步操作。
3. **小模型 Triage 的决策越权与误报**：`RecordingPipeline` 中的小模型 Triage 目前负责输出 `shouldEngage` 并将群推入 Q3。让小模型做“是否介入”的战略决策导致要么漏报，要么因为误报让主模型注意力被闲聊淹没。

## 3. 核心设计哲学

> **"俯瞰全局，只做调度，绝不亲自动手。" (Observe Globally, Orchestrate Locally)**

重构后的 Main Agent 将转变为系统中的“CEO”：
* **读权限无界限**：它可以查阅 `Memory V2` 中所有群的聊天记录、所有人的跨群画像。
* **写权限被严格隔离**：它**不能**调用平台 API 直接发消息。它的所有“行动”，必须通过向下属（各群的 `GroupSubagent` / `CodeActExecutor`）派发 `CodeActReplyTask`（注入 Q4）来完成。

## 4. Meta-CodeAct 的全局 API 能力版图

当 Meta-CodeAct 会话被唤醒时，它将在一个特殊的“Meta 沙盒”中运行。该沙盒不提供 `sendText` 等群组操作，而是提供一套**架构级的高级管理 API**。这些 API 直接映射到底层的 V3 组件：

### 4.1 全局感知域 (Global Perception APIs)
打破群组隔离，允许 Agent 主动“拉取”信息：
* **`conversations.query(filters)`**: 跨群检索引擎。底层直接查询 `message_log` 表和 `topics_fts`。支持按群组、时间段、特定人员、全文关键词检索。例如：“帮我调出昨天至今所有包含'团建'的聊天片段”。
* **`memory.searchEntities(query)`**: 跨群身份与事实网络。底层打通 `person_identities` (跨群同一个人) 和 `core_facts_fts` (长期事实)。Agent 可以问：“UserX 之前在其他群表现出的技术栈是什么？”
* **`agents.listStatus()`**: 监控下属状态。查看所有 `GroupSubagent` 的当前状况，包括它们 Q4 队列的拥堵程度、当前处理的话题摘要、上一次活跃的时间。用于评估“我现在派活给他，他忙得过来吗？”

### 4.2 编排与委派域 (Orchestration APIs)
替代原有的 JSON 单步决策，实现复杂的任务分发：
* **`dispatch.taskToGroup(chatId, taskSpec)`**: 向指定群的 Q4 队列下发 `CodeActReplyTask`。**关键创新**：可以附带 `context` 参数。Meta Agent 查到的跨群信息，可以直接打包作为上下文塞给子 Agent，子 Agent 无需自己再去查。
* **`memo.setGlobalState(key, value)`**: 取代原有的静态 `GlobalState`，提供一个支持 TTL 的跨会话备忘录。用于记录“我正在等 A 群回复，再去回复 B 群”这种多步流转状态。

### 4.3 主动调度域 (Proactive Scheduling APIs)
彻底改变 Agent 的被动性，允许它设定程序化的唤醒规则（取代原有的单纯 DEFER）：
* **`schedule.wakeOnCondition(condition)`**: 设定纯代码可判定的唤醒条件。条件挂载在系统的事件流上，例如：
  * 等待回调：`{ type: 'callback_received', taskId: 'xxx' }` (监听 Q5)
  * 热度告警：`{ type: 'engagement_above', chatId: 'yyy', threshold: 0.8 }` (监听 Observer)
  * 定时巡视：`{ type: 'delay', ms: 1800000 }` (半小时后唤醒)

## 5. 从队列到累加器：注意力模型的升级

我们废除 Q3 逐个消费的模式，引入 **注意力累加器 (Accumulator)** 和 **滴灌释放 (Drip-Feed)** 机制。

### 5.1 注意力集 (Attention Set) 的批处理
NC 事件不再直接触发排队，而是汇入累加器。当满足窗口期（如 5 秒）或抢占条件时，累加器将所有待办打包成一个 `AttentionSet` 注入给 Meta-CodeAct：
* 🔴 **紧急 (Layer 0)**：被 @ mention、私信、`FeedbackLoop` 检测到的追问。
* 🟡 **到期 (Layer 1)**：Agent 通过 `schedule.wakeOnCondition` 注册的条件满足了，或者 Q5 callback 回来了。
* 🟢 **信号 (Layer 2)**：框架通过“滴灌机制”主动推送的低优先级话题。

### 5.2 “滴灌信号释放”与压力计算模型 (The Pressure Formula)
`RecordingPipeline` 产出的话题（Topic Digests）将不再通过 Triage 小模型做“介入/丢弃”的二元裁决，而是全部进入累加器的 ** Layer 2 信号池**。

为了不让主 Agent 被海量信号淹没，框架会在每次 Agent 因处理红/黄事件醒来时，从信号池中计算**“释放压力 (Pressure)”**，挑选 Top-N（如 3 条）作为 🟢 信号“顺便”推给 Agent 看。

**压力的聚合计算来源（全面结合 V3 架构）**：
1. **基础热度 (Base Intensity)**：来自 `RecordingPipeline` 产出的话题属性（参与人数、消息速率）以及 `Observer` 的实时 Engagement Score。热度越高，压力越大。
2. **关系权重倍率 (Relationship Multiplier)**：
   * **群组亲密度**：读取 `Stickiness` 模块配置。`CORE` 群的热度得分乘以 2.0，`STRANGER` 群乘以 0.5。核心群的窃窃私语，响于陌生群的喧哗。
   * **人员权重**：读取 `Memory V2` 中的 `person_group_profiles`。如果参与话题的是 `dunbar_tier` 为核心圈层的高优用户，产生极大的压力倍增。
3. **饥饿与衰减因子 (Age & Penalty)**：
   * **饥饿度 (Age)**：信号在池子里等待的时间越长，压力随时间线性上升，确保冷门但亲密的信号最终一定会被释放。
   * **冷漠惩罚 (Ignored Penalty)**：如果一个信号之前被释放给 Agent 看过（显示在了 Attention Set 里），但 Agent 没采取任何行动（没派发任务也没安排备忘），下次它的压力值会大幅衰减，避免同一信号反复骚扰。

**结果**：Agent 看到的永远是当前整个系统中，综合了“社交关系”、“话题热度”和“时效性”后，最值得它“瞥一眼”的 2-3 个动态。

## 6. 上下文组装：Context Engine 的分层护航

Meta-CodeAct 一次会话可能执行几十秒，产生大量观测代码和 API 返回结果。为了防止对话历史 Token 爆炸和“幻觉（把昨天的事情当今天）”，必须配合 **Context Engine**。

每次 Meta-CodeAct 启动前，框架为其组装两组截然不同的上下文：

1. **背景历史记忆 (Persistent History)**：
   * Agent 在前几次会话结束时自我生成的 **Session Digest**（“上一轮我决定派发任务给 A，并在等 B 的回复”）。
   * 属于系统提示词的一部分，提供时间上的连续性。
2. **瞬态环境触发器 (Ephemeral Context)**：
   * 刚刚从 Accumulator 取出的 **Attention Set**。
   * 当前存活的 **活跃备忘录 (Active Memos)**。
   * **关键特性**：这部分内容组装为 `User Message`。会话结束后立即从历史记录中**物理抹除**。下次启动时由框架重新拉取最新状态渲染，彻底杜绝记忆污染。

## 7. 预期收益与系统影响

1. **破除并发瓶颈**：由于主循环退化为极轻量的事件泵和状态查询机，主线程不会再被复杂的上下文构建阻塞。真正的重脑力劳动被异步化和批处理化了。
2. **极其自然的人设表现**：通过滴灌信号和主动调度，Agent 真正拥有了“有空顺便看看群”、“等你们聊完我再总结”的高级社交直觉，而不仅仅是一个高级的 QA 机器人。
3. **架构的优雅收敛**：Triage 的负担减轻，`ContextManager` 的压力缩小，不再需要为了跨群强行拼凑上下文，一切都在 Meta 沙盒中通过 API 显式调用。

## 8. 讨论

- 除了现在提出的API，meta codeact 应该具备的api还有哪些，或者应该删除什么？
- 除了现在提出的方式，压力还有更合适的计算方法吗？我们有很多可以参考的东西，特别是我们的记忆系统里面，如何聚合计算出一个合理的信号来确保应该得到注意的东西得到注意。