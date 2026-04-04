═══ 注意力切换: {{chatTitle}} ({{chatId}}) [{{chatType}}] ═══

## 全局状态快照
{{attentionSummary}}

## 最近决策记录
{{recentDecisions}}

## 当前任务列表
{{activeTasks}}

## 本次决策上下文
当前粘性级别: {{stickinessLevel}}
当前时间: {{snapshotTimestamp}}
上次关注: {{lastAttendedAt}} ({{timeSinceLastAttend}} 前)
上下文深度: L{{depth}}
优先级乘数: {{priorityMultiplier}}
{{#recentFeedback}}
最近观察：{{recentFeedback}}
{{/recentFeedback}}

## 话题注册表
{{topicDigests}}

## 新消息 (自上次关注以来, 共 {{newMessageCount}} 条)
{{messages}}

{{#hasCallbacks}}
## 上次 Subagent 执行结果
{{callbacks}}
{{/hasCallbacks}}

{{#hasFastPathHistory}}
## FastPath 回复历史
{{fastPathHistory}}
{{/hasFastPathHistory}}

{{#groupModel}}
## 聊天画像
- 标题: {{chatTitle}}
- 描述: {{description}}
- 日均消息: {{avgMessagesPerDay}}
- 参与度: {{engagementLevel}}
- 语气预设: {{tonePreset}}
{{/groupModel}}

{{#activePersons}}
## 活跃参与者
{{activePersons}}
{{/activePersons}}

{{#hasNotes}}
## 工作笔记
{{notes}}
{{/hasNotes}}

{{#hasDispatchedTopics}}
## ⚠️ 已分派回复任务的话题
以下话题已有进行中或已完成的回复任务，请勿重复分派: {{dispatchedTopicIds}}
{{/hasDispatchedTopics}}

## 请决策
基于以上信息，输出你的决策（JSON 格式的 AttendResult）。
